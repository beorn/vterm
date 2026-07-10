/**
 * dirty-absrows.test.ts — absolute-row read addressing + per-row damage (dirty) tracking.
 *
 * @failure  The engine's absolute-row addressing or its pull-plane damage tracking is wrong:
 *           `getRowAbsolute(0)` does not return the oldest RETAINED scrollback line, `totalRows`/
 *           `screenRows`/`viewportTop` miscount the buffer, retention trimming shifts indices
 *           without `firstRetainedRow()` reporting it, `takeDirty()` reports the wrong changed
 *           rows (misses a targeted write, or over/under-reports "all" on resize/clear/alt-switch),
 *           the `scrolled` counter miscounts lines entering scrollback, a take fails to reset the
 *           epoch, damage accumulates with no writes, or `apply(op)` diverges from `process`/
 *           `resize` for damage.
 * @level    l0
 * @consumer screen.getRowAbsolute() / screen.totalRows() / screen.screenRows() /
 *           screen.viewportTop() / screen.firstRetainedRow() / screen.takeDirty() — the
 *           absolute-row read plane and the pull-plane damage surface (dirty rows feed the
 *           push/reactive renderers) behind the terminal-flow vertical slice §4/§8.3. Run:
 *           `bun vitest run tests/dirty-absrows.test.ts` from the monorepo root (hh: --project
 *           vendor).
 *
 * Contract (the exact rules implemented):
 * - Absolute rows are retained-relative: row 0 = oldest RETAINED scrollback line; the screen
 *   occupies the last `screenRows()` rows, i.e. absolute `totalRows()-screenRows()` ..
 *   `totalRows()-1`. `viewportTop()` is the absolute row where the viewport's top line sits
 *   (at the bottom: `totalRows()-screenRows()`; scrolled fully up: `0`).
 * - As lines scroll IN, existing scrollback rows keep their absolute index; a retention trim
 *   shifts every index down by the trimmed count and bumps `firstRetainedRow()` by the same
 *   amount (the global origin of retained row 0), so consumers detect the shift.
 * - `takeDirty()` returns `{ rows: Set<number> | "all"; cursor: boolean; scrolled: number }`
 *   accumulated since the previous take: `rows` are retained-relative absolute indices,
 *   `"all"` on resize/clear/alt-screen switch/reset/restore, `cursor` true when the cursor
 *   moved/changed, `scrolled` = lines that entered scrollback. The take resets the epoch.
 */
import { describe, expect, test } from "vitest"
import { createVtermScreen, type DirtyRegion, type ScreenCell, type VtermScreen } from "../src/index.ts"

const ESC = "\x1b"
const encoder = new TextEncoder()

function mkScreen(cols = 40, rows = 4): VtermScreen {
  return createVtermScreen({ cols, rows })
}

function feed(screen: VtermScreen, s: string): void {
  screen.process(encoder.encode(s))
}

/** Render a row of cells to text the way getText() does (skip wide-char spacers, trim trailing). */
function rowText(cells: ScreenCell[]): string {
  let line = ""
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]!
    if (cell.char === "" && i > 0 && cells[i - 1]?.wide) continue
    line += cell.char || " "
  }
  return line.replace(/\s+$/, "")
}

/** Assert `rows` is a plain Set (not "all") and return it. */
function asSet(region: DirtyRegion): Set<number> {
  expect(region.rows).toBeInstanceOf(Set)
  return region.rows as Set<number>
}

describe("absolute-row read API", () => {
  test("row 0 is the oldest scrollback line; the screen occupies the last screenRows rows", () => {
    const s = mkScreen(40, 4)
    for (let i = 0; i < 10; i++) feed(s, `line${i}\r\n`)

    // 10 lines on a 4-row screen: 7 lines scrolled into history, screen shows line7..line9 + blank.
    expect(s.screenRows()).toBe(4)
    expect(s.totalRows()).toBe(11) // 7 scrollback + 4 screen
    expect(s.firstRetainedRow()).toBe(0) // no trimming yet

    // Absolute row 0 = oldest scrollback line; NOT the top of the screen.
    expect(rowText(s.getRowAbsolute(0))).toBe("line0")
    // Top-of-screen (screen-relative row 0) is a DIFFERENT line.
    expect(rowText(s.getLine(0))).toBe("line7")
    // The absolute index of the top-of-screen row equals totalRows - screenRows.
    const top = s.totalRows() - s.screenRows()
    expect(top).toBe(7)
    expect(rowText(s.getRowAbsolute(top))).toBe(rowText(s.getLine(0)))
    // Last screen row.
    expect(rowText(s.getRowAbsolute(s.totalRows() - 1))).toBe(rowText(s.getLine(3)))

    // At the bottom (no viewport scroll) viewportTop sits at the top of the screen.
    expect(s.viewportTop()).toBe(top)
  })

  test("viewportTop tracks the scroll offset; 0 when scrolled fully up", () => {
    const s = mkScreen(40, 4)
    for (let i = 0; i < 10; i++) feed(s, `line${i}\r\n`)
    // scrollback length is 7; scroll the viewport fully up.
    s.scrollViewport(7)
    expect(s.viewportTop()).toBe(0)
    // Half way.
    s.scrollViewport(-3)
    expect(s.viewportTop()).toBe(3)
  })

  test("retention trimming shifts absolute indices and bumps firstRetainedRow", () => {
    const s = createVtermScreen({ cols: 40, rows: 2, scrollbackLimit: 2 })
    for (let i = 0; i < 6; i++) feed(s, `l${i}\r\n`)
    // With scrollbackLimit=2, the push that makes scrollback length 5 (>limit*2=4) trims
    // (5-2)=3 rows. Sequence l0..l5: l0..l2 evicted, l3,l4 retained, screen shows l5 + blank.
    expect(s.firstRetainedRow()).toBe(3)
    expect(rowText(s.getRowAbsolute(0))).toBe("l3") // oldest RETAINED line
    expect(s.totalRows()).toBe(4) // 2 retained scrollback + 2 screen
    expect(rowText(s.getRowAbsolute(s.totalRows() - 2))).toBe("l5") // top of screen
  })
})

describe("dirty tracking", () => {
  test("a fresh screen with no writes reports empty damage", () => {
    const s = mkScreen()
    const d = s.takeDirty()
    expect(asSet(d).size).toBe(0)
    expect(d.cursor).toBe(false)
    expect(d.scrolled).toBe(0)
  })

  test("a targeted write dirties exactly that row", () => {
    const s = mkScreen(40, 4)
    s.takeDirty() // clear the epoch
    feed(s, `${ESC}[3;1Hhi`) // CUP to row 2 (0-based), print "hi"
    const d = s.takeDirty()
    expect([...asSet(d)]).toEqual([2])
    expect(d.cursor).toBe(true) // cursor moved
    expect(d.scrolled).toBe(0)
  })

  test("a second take with no intervening writes resets to empty", () => {
    const s = mkScreen()
    feed(s, "hello")
    s.takeDirty() // consume
    const d = s.takeDirty()
    expect(asSet(d).size).toBe(0)
    expect(d.cursor).toBe(false)
    expect(d.scrolled).toBe(0)
  })

  test("resize forces full damage", () => {
    const s = mkScreen()
    feed(s, "x")
    s.takeDirty()
    s.resize(50, 6)
    expect(s.takeDirty().rows).toBe("all")
  })

  test("clear (ED2) forces full damage", () => {
    const s = mkScreen()
    feed(s, "x")
    s.takeDirty()
    feed(s, `${ESC}[2J`)
    expect(s.takeDirty().rows).toBe("all")
  })

  test("alt-screen switch forces full damage", () => {
    const s = mkScreen()
    feed(s, "x")
    s.takeDirty()
    feed(s, `${ESC}[?1049h`)
    expect(s.takeDirty().rows).toBe("all")
  })

  test("scrolled counts lines entering scrollback", () => {
    const s = mkScreen(40, 2)
    s.takeDirty()
    feed(s, "a\r\nb\r\nc\r\n") // rows=2: two scroll-outs (after b and after c)
    const d = s.takeDirty()
    expect(d.scrolled).toBe(2)
  })

  test("dirty rows carry absolute indices that survive a scroll", () => {
    const s = mkScreen(40, 4)
    s.takeDirty()
    // Fill so lines scroll into history; the newly-blanked bottom row and scrolled count report.
    for (let i = 0; i < 6; i++) feed(s, `row${i}\r\n`)
    const d = s.takeDirty()
    expect(d.scrolled).toBe(3) // 6 lines on 4 rows → 3 scroll-outs
    // Every reported dirty row is a valid absolute index into the current buffer.
    for (const r of asSet(d)) {
      expect(r).toBeGreaterThanOrEqual(0)
      expect(r).toBeLessThan(s.totalRows())
    }
  })

  test("interplay with apply(op): output dirties a row, resize forces all", () => {
    const s = mkScreen(40, 4)
    s.takeDirty()
    s.apply({ type: "output", data: `${ESC}[2;1HZ` }) // CUP row 1, print
    const d1 = s.takeDirty()
    expect([...asSet(d1)]).toEqual([1])

    s.apply({ type: "resize", cols: 30, rows: 5 })
    expect(s.takeDirty().rows).toBe("all")
  })

  test("the returned dirty Set is owned by the caller (mutation does not leak)", () => {
    const s = mkScreen()
    feed(s, `${ESC}[1;1Ha`)
    const d = asSet(s.takeDirty())
    d.add(999) // caller mutates
    feed(s, `${ESC}[2;1Hb`)
    expect([...asSet(s.takeDirty())]).toEqual([1]) // not polluted by 999
  })
})
