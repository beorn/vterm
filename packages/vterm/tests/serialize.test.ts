/**
 * serialize.test.ts — restore-equivalence oracle + goldens for `serializeSnapshot`.
 *
 * @failure  Serialized ANSI drops or corrupts state the snapshot carries — underline
 *           styles collapse to single, hyperlinks vanish, the pending pen is lost, or
 *           styles bleed across rows — so a reattached/replayed terminal shows wrong
 *           colors/styles (the SGR-loss-on-attach class).
 * @level    l0
 * @consumer serializeSnapshot / screen.serialize() — the state→minimal-ANSI projection
 *           consumed by checkpoint/attach text projections. Run: `bun vitest run
 *           tests/serialize.test.ts` from the monorepo root (hh: --project vendor).
 *
 * Oracle contract (restore-equivalence): feed bytes into a source vterm; serialize its
 * snapshot; feed the result into a FRESH same-size sink; the sink's visible grid,
 * cursor (position + visibility), and pending pen must equal the source's. Output
 * assumes a fresh/reset sink — it does not clear modes it never set.
 *
 * Intended divergences (this slice emits no modes — the mode/margin/alt/DECSCUSR half
 * is the serializer-modes slice): sources here never mutate modes, margins, or the alt
 * screen, and parser/pending-wrap/mid-parse state is unserializable-to-VT by design.
 */
import { describe, expect, test } from "vitest"
import {
  createVtermScreen,
  serializeSnapshot,
  type ScreenCell,
  type VtermScreen,
} from "../src/index.ts"

const ESC = "\x1b"
const encoder = new TextEncoder()

function mkScreen(cols = 40, rows = 8): VtermScreen {
  return createVtermScreen({ cols, rows })
}

function feed(screen: VtermScreen, data: string): void {
  screen.process(encoder.encode(data))
}

const CELL_FIELDS = [
  "char",
  "fg",
  "bg",
  "bold",
  "faint",
  "italic",
  "underline",
  "underlineColor",
  "overline",
  "strikethrough",
  "inverse",
  "hidden",
  "blink",
  "wide",
  "url",
] as const satisfies readonly (keyof ScreenCell)[]

function cellView(cell: ScreenCell): Record<string, unknown> {
  const view: Record<string, unknown> = {}
  for (const field of CELL_FIELDS) view[field] = cell[field]
  return view
}

/** Serialize source → feed a fresh same-size sink → assert restore-equivalence. */
function roundTripState(source: VtermScreen, cols: number, rows: number): VtermScreen {
  const snapshot = source.snapshot()
  const ansi = serializeSnapshot(snapshot)
  const sink = mkScreen(cols, rows)
  feed(sink, ansi)

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      expect(cellView(sink.getCell(row, col)), `cell (${row},${col})`).toEqual(
        cellView(source.getCell(row, col)),
      )
    }
  }
  expect(sink.getCursorPosition(), "cursor position").toEqual(source.getCursorPosition())
  expect(sink.getCursorVisible(), "cursor visibility").toBe(source.getCursorVisible())
  expect(sink.snapshot().attrs, "pending pen").toEqual(snapshot.attrs)
  return sink
}

// ── Deterministic PRNG (fixed seeds — reproducible property tests) ─────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Random attributed-screen source. Ops deliberately exclude mode mutations
 * (DECSET/alt/margins) — out of this slice's carried scope (see header).
 */
function randomSource(rand: () => number, cols: number, rows: number): VtermScreen {
  const screen = mkScreen(cols, rows)
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!
  const int = (max: number): number => Math.floor(rand() * max)
  const sgrPool = [
    "0", "1", "2", "3", "4", "4:2", "4:3", "4:4", "4:5", "5", "7", "8", "9", "53",
    "22", "23", "24", "25", "27", "29", "55",
    "31", "42", "93", "104", "39", "49",
    "38;2;200;40;120", "48;2;10;90;230", "38;5;178", "48;5;24", "58;2;250;250;60", "59",
  ] as const
  const words = ["hei", "verden", "汉字", "🎈", "ab c", "x", "…tail"] as const
  const opCount = 24 + int(24)
  for (let i = 0; i < opCount; i++) {
    switch (int(6)) {
      case 0:
        feed(screen, `${ESC}[${pick(sgrPool)}m`)
        break
      case 1:
        feed(screen, pick(words))
        break
      case 2:
        feed(screen, `${ESC}[${String(1 + int(rows))};${String(1 + int(cols))}H`)
        break
      case 3:
        feed(screen, "\r\n")
        break
      case 4:
        feed(screen, `${ESC}[${String(int(2))}K`)
        break
      default:
        feed(screen, `${ESC}]8;;${rand() < 0.5 ? "https://x.test/a" : ""}${ESC}\\`)
        break
    }
  }
  return screen
}

// ── Oracle + properties ────────────────────────────────────────────────

describe("serializeSnapshot — restore-equivalence oracle", () => {
  test("property (a): random attributed screens round-trip (25 fixed seeds)", () => {
    for (let seed = 1; seed <= 25; seed++) {
      const cols = 24 + (seed % 3) * 8
      const rows = 5 + (seed % 2) * 3
      const source = randomSource(mulberry32(seed * 7919), cols, rows)
      roundTripState(source, cols, rows)
    }
  })

  test("property (b): idempotence — serialize(feed(serialize(s))) === serialize(s)", () => {
    for (const seed of [3, 11, 19]) {
      const cols = 32
      const rows = 6
      const source = randomSource(mulberry32(seed * 104729), cols, rows)
      const first = serializeSnapshot(source.snapshot())
      const sink = mkScreen(cols, rows)
      feed(sink, first)
      const second = serializeSnapshot(sink.snapshot())
      expect(second).toBe(first)
    }
  })

  test("property (c): no style bleed across rows", () => {
    const source = mkScreen(20, 4)
    feed(source, `${ESC}[1;4:3;38;2;255;0;0;48;2;0;0;90mstyled row zero`)
    feed(source, `${ESC}[0m${ESC}[2;1Hplain`)
    const sink = roundTripState(source, 20, 4)
    for (let col = 0; col < 20; col++) {
      const cell = sink.getCell(1, col)
      expect(cell.bold, `row 1 col ${col} bold`).toBe(false)
      expect(cell.underline, `row 1 col ${col} underline`).toBe("none")
      expect(cell.fg, `row 1 col ${col} fg`).toBeNull()
      expect(cell.bg, `row 1 col ${col} bg`).toBeNull()
    }
  })

  test("property (d): trailing default cells trimmed, trailing bg preserved", () => {
    const source = mkScreen(30, 3)
    feed(source, "AB")
    feed(source, `${ESC}[2;1H${ESC}[48;2;20;20;120mCD  `) // trailing spaces WITH bg
    const ansi = serializeSnapshot(source.snapshot())
    // Row 1: nothing painted past "AB" — no run of trailing default spaces.
    expect(ansi).not.toMatch(/AB {3,}/)
    // Row 2's bg-bearing trailing spaces survive the round trip.
    const sink = roundTripState(source, 30, 3)
    expect(sink.getCell(1, 2).bg).toEqual({ r: 20, g: 20, b: 120 })
    expect(sink.getCell(1, 3).bg).toEqual({ r: 20, g: 20, b: 120 })
  })

  test("scrollback: history rows replay above the screen (two-phase)", () => {
    const source = mkScreen(20, 3)
    for (let i = 1; i <= 6; i++) feed(source, `line-${String(i)}\r\n`)
    feed(source, "END")
    expect(source.getScrollbackLength()).toBeGreaterThan(0)
    const snapshot = source.snapshot()
    const sink = mkScreen(20, 3)
    feed(sink, serializeSnapshot(snapshot))
    expect(sink.getScrollbackLength()).toBe(source.getScrollbackLength())
    expect(sink.getScrollbackText()).toBe(source.getScrollbackText())
    expect(sink.getText()).toBe(source.getText())
    const noHistory = mkScreen(20, 3)
    feed(noHistory, serializeSnapshot(snapshot, { includeScrollback: false }))
    expect(noHistory.getScrollbackLength()).toBe(0)
    expect(noHistory.getText()).toBe(source.getText())
  })
})

// ── Regression goldens (the classes this serializer fixes) ─────────────

describe("serializeSnapshot — pen goldens", () => {
  test("golden 1: curly/dotted/dashed underline round-trip via colon subparams", () => {
    const source = mkScreen(24, 3)
    feed(source, `${ESC}[4:3mcurly ${ESC}[4:4mdotted ${ESC}[4:5mdashed`)
    const ansi = serializeSnapshot(source.snapshot())
    expect(ansi).toContain("4:3")
    expect(ansi).toContain("4:4")
    expect(ansi).toContain("4:5")
    const sink = roundTripState(source, 24, 3)
    expect(sink.getCell(0, 0).underline).toBe("curly")
    expect(sink.getCell(0, 6).underline).toBe("dotted")
    expect(sink.getCell(0, 13).underline).toBe("dashed")
  })

  test("golden 2: double underline + underline color (4:2 + 58;2)", () => {
    const source = mkScreen(20, 2)
    feed(source, `${ESC}[4:2;58;2;250;100;5mdup`)
    const ansi = serializeSnapshot(source.snapshot())
    expect(ansi).toContain("4:2")
    expect(ansi).toContain("58;2;250;100;5")
    expect(ansi).not.toMatch(/\x1b\[[^m]*(^|;)21(;|m)/) // never the ambiguous bare 21
    const sink = roundTripState(source, 20, 2)
    expect(sink.getCell(0, 0).underline).toBe("double")
    expect(sink.getCell(0, 0).underlineColor).toEqual({ r: 250, g: 100, b: 5 })
  })

  test("golden 3: bold→off while faint stays (the SGR 22 coupling)", () => {
    const source = mkScreen(20, 2)
    feed(source, `${ESC}[1;2mBF`) // bold+faint
    feed(source, `${ESC}[0;2mF`) // faint only — adjacent run drops bold, keeps faint
    const sink = roundTripState(source, 20, 2)
    expect(sink.getCell(0, 0).bold).toBe(true)
    expect(sink.getCell(0, 0).faint).toBe(true)
    expect(sink.getCell(0, 2).bold).toBe(false)
    expect(sink.getCell(0, 2).faint).toBe(true)
  })

  test("golden 4: 16/256/truecolor fg+bg all round-trip as resolved truecolor", () => {
    const source = mkScreen(30, 2)
    feed(source, `${ESC}[31;44m16 ${ESC}[38;5;178;48;5;24m256 ${ESC}[38;2;1;2;3;48;2;9;8;7mtru`)
    roundTripState(source, 30, 2)
  })

  test("golden 5: hyperlink (OSC 8) run mid-row survives", () => {
    const source = mkScreen(30, 2)
    feed(source, `pre ${ESC}]8;;https://x.test/doc${ESC}\\link${ESC}]8;;${ESC}\\ post`)
    const ansi = serializeSnapshot(source.snapshot())
    expect(ansi).toContain(`${ESC}]8;;https://x.test/doc`)
    const sink = roundTripState(source, 30, 2)
    expect(sink.getCell(0, 0).url).toBeNull()
    expect(sink.getCell(0, 4).url).toBe("https://x.test/doc")
    expect(sink.getCell(0, 8).url).toBeNull()
    const bare = mkScreen(30, 2)
    feed(bare, serializeSnapshot(source.snapshot(), { hyperlinks: false }))
    expect(bare.getCell(0, 4).url).toBeNull()
    expect(bare.getCell(0, 4).char).toBe("l")
  })

  test("golden 6: wide/CJK + emoji cells keep wide+spacer shape", () => {
    const source = mkScreen(12, 2)
    feed(source, `汉x🎈`)
    const sink = roundTripState(source, 12, 2)
    expect(sink.getCell(0, 0).wide).toBe(true)
    expect(sink.getCell(0, 0).char).toBe("汉")
    expect(sink.getCell(0, 1).char).toBe("")
    expect(sink.getCell(0, 2).char).toBe("x")
    expect(sink.getCell(0, 3).wide).toBe(true)
  })

  test("golden 10: pending pen — post-restore keystrokes inherit the live pen", () => {
    const source = mkScreen(20, 2)
    feed(source, `out`)
    feed(source, `${ESC}[1;38;2;10;200;50;4:3m`) // pen armed, nothing typed yet
    const snapshot = source.snapshot()
    const sink = mkScreen(20, 2)
    feed(sink, serializeSnapshot(snapshot))
    expect(sink.snapshot().attrs).toEqual(snapshot.attrs)
    feed(sink, "X")
    const typed = sink.getCell(0, 3)
    expect(typed.char).toBe("X")
    expect(typed.bold).toBe(true)
    expect(typed.fg).toEqual({ r: 10, g: 200, b: 50 })
    expect(typed.underline).toBe("curly")
  })

  test("golden 10b: pending pen URL — an open hyperlink at snapshot time reopens", () => {
    const source = mkScreen(20, 2)
    feed(source, `${ESC}]8;;https://pen.test/${ESC}\\`)
    const snapshot = source.snapshot()
    expect(snapshot.attrs.url).toBe("https://pen.test/")
    const sink = mkScreen(20, 2)
    feed(sink, serializeSnapshot(snapshot))
    expect(sink.snapshot().attrs.url).toBe("https://pen.test/")
  })

  test("autowrap discipline: full-width last row paints without wrap artifacts", () => {
    const cols = 10
    const rows = 3
    const source = mkScreen(cols, rows)
    feed(source, `${ESC}[3;1H${"Z".repeat(cols)}`) // fill the LAST row completely
    const ansi = serializeSnapshot(source.snapshot())
    expect(ansi).toContain(`${ESC}[?7l`)
    const sink = mkScreen(cols, rows)
    feed(sink, ansi)
    expect(sink.getScrollbackLength()).toBe(0) // no scroll = no wrap happened
    for (let col = 0; col < cols; col++) expect(sink.getCell(2, col).char).toBe("Z")
    expect(sink.getMode("autoWrap")).toBe(true) // restored to the snapshot's value
  })

  test("title: emitted only when includeTitle is set", () => {
    const source = mkScreen(20, 2)
    feed(source, `${ESC}]0;my-title${ESC}\\`)
    const withTitle = mkScreen(20, 2)
    feed(withTitle, serializeSnapshot(source.snapshot(), { includeTitle: true }))
    expect(withTitle.getTitle()).toBe("my-title")
    const without = mkScreen(20, 2)
    feed(without, serializeSnapshot(source.snapshot()))
    expect(without.getTitle()).toBe("")
  })

  test("screen.serialize() delegates to serializeSnapshot of the live snapshot", () => {
    const source = mkScreen(16, 2)
    feed(source, `${ESC}[1mhey`)
    expect(source.serialize()).toBe(serializeSnapshot(source.snapshot()))
  })
})
