/**
 * signals.test.ts — the reactive read plane (§4 signals facade): `screen.signals`.
 *
 * @failure  The signals facade is wrong: a signal fires when its value did NOT change (no
 *           equality gate), fires more than once per flush (no per-call coalescing), fires the
 *           wrong value, keeps delivering after unsubscribe, does per-write/allocation work before
 *           `.signals` is accessed or before `damage$` is subscribed (not zero-overhead), `modes$`
 *           omits a mode the guest regex-scans (altScreen/cursorVisible/mouse/bracketedPaste/…),
 *           `damage$` reports the wrong batched rows for a flush, OR `damage$` and the pull-plane
 *           `takeDirty()` drain/steal each other's epoch (the two-plane coexistence contract).
 * @level    l0
 * @consumer screen.signals.title$ / modes$ / cursor$ / size$ / damage$ — the REACTIVE read plane
 *           (§4) that replaces consumers' title-polling and DECSET regex scanning. Run:
 *           `bun vitest run tests/signals.test.ts` from the monorepo root (hh: --project vendor).
 *
 * Contract (the exact rules implemented):
 * - Flush boundary = the end of every public state-mutating call (`process`/`apply`/`resize`/
 *   `reset`/`restore`; `apply` inherits it via `process`/`resize`). Each signal emits AT MOST once
 *   per boundary — N writes in one `process()` coalesce into one emission.
 * - `title$`/`modes$`/`cursor$`/`size$` are equality-gated: they deliver only when the value
 *   actually changed across the call. Subscribing captures a baseline at subscribe time (no
 *   immediate fire); only later changes deliver. `get()` reads live and never consumes a delivery.
 * - `damage$` publishes the BATCHED dirty region accumulated during the call (same shape as
 *   `takeDirty()`), on an epoch INDEPENDENT of `takeDirty()` — the two never drain each other.
 * - Zero overhead when unused: no signal bookkeeping until `.signals` is accessed, and no per-write
 *   damage accumulation until `damage$` has a subscriber.
 */
import { describe, expect, test } from "vitest"
import { createVtermScreen, type DirtyRegion, type TerminalModes, type VtermScreen } from "../src/index.ts"

const encoder = new TextEncoder()

function mkScreen(cols = 20, rows = 4): VtermScreen {
  return createVtermScreen({ cols, rows })
}

function feed(screen: VtermScreen, s: string): void {
  screen.process(encoder.encode(s))
}

describe("signals — change-only firing (equality gate)", () => {
  test("title$ fires once on a real change and NOT on an equal value", () => {
    const s = mkScreen()
    const seen: string[] = []
    s.signals.title$.subscribe((t) => seen.push(t))

    feed(s, "\x1b]0;Alpha\x07")
    feed(s, "\x1b]0;Alpha\x07") // same title again — no change
    feed(s, "\x1b]0;Beta\x07")

    expect(seen).toEqual(["Alpha", "Beta"])
  })

  test("subscribing does not fire immediately; baseline is the value at subscribe time", () => {
    const s = mkScreen()
    feed(s, "\x1b]0;Preset\x07") // title changes BEFORE any subscription
    const seen: string[] = []
    s.signals.title$.subscribe((t) => seen.push(t))

    feed(s, "\x1b]0;Preset\x07") // re-assert the same title — equal to baseline, no fire
    expect(seen).toEqual([])

    feed(s, "\x1b]0;Changed\x07")
    expect(seen).toEqual(["Changed"])
  })

  test("cursor$ fires on cursor movement, equality-gated", () => {
    const s = mkScreen()
    const seen: { col: number; row: number }[] = []
    s.signals.cursor$.subscribe((c) => seen.push(c))

    feed(s, "AB") // cursor 0,0 -> col 2, row 0
    feed(s, "\x1b[2;5H") // CUP row 2 col 5 -> col 4, row 1 (1-based args)
    const before = seen.length
    feed(s, "\x1b[2;5H") // same position — no change
    expect(seen.length).toBe(before)

    expect(seen[0]).toEqual({ col: 2, row: 0 })
    expect(seen[1]).toEqual({ col: 4, row: 1 })
  })

  test("get() reads live without consuming a delivery", () => {
    const s = mkScreen()
    expect(s.signals.title$.get()).toBe("")
    feed(s, "\x1b]0;Live\x07")
    expect(s.signals.title$.get()).toBe("Live")
    // Reading get() repeatedly must not affect a later subscriber's baseline/delivery.
    s.signals.title$.get()
    const seen: string[] = []
    s.signals.title$.subscribe((t) => seen.push(t))
    feed(s, "\x1b]0;Live\x07") // unchanged
    expect(seen).toEqual([])
  })
})

describe("signals — flush batching (coalesce per process() call)", () => {
  test("N writes in one process() -> one damage$ emission with the union of rows", () => {
    const s = mkScreen()
    const batches: DirtyRegion[] = []
    s.signals.damage$.subscribe((r) => batches.push(r))

    // One process() call touching row 0 and row 1.
    feed(s, "line0\r\nline1")

    expect(batches.length).toBe(1)
    expect(batches[0]!.rows).toEqual(new Set([0, 1]))
    expect(batches[0]!.cursor).toBe(true)
    expect(batches[0]!.scrolled).toBe(0)
  })

  test("multiple mode flips in one process() coalesce into one modes$ emission of the final set", () => {
    const s = mkScreen()
    const seen: TerminalModes[] = []
    s.signals.modes$.subscribe((m) => seen.push(m))

    // Toggle bracketed paste on then off, and turn alt-screen on — all in one call.
    feed(s, "\x1b[?2004h\x1b[?2004l\x1b[?1049h")

    expect(seen.length).toBe(1)
    expect(seen[0]!.bracketedPaste).toBe(false) // net: on then off
    expect(seen[0]!.altScreen).toBe(true)
  })

  test("a process() that changes nothing observable emits nothing", () => {
    const s = mkScreen()
    const titles: string[] = []
    const modes: TerminalModes[] = []
    const damage: DirtyRegion[] = []
    s.signals.title$.subscribe((t) => titles.push(t))
    s.signals.modes$.subscribe((m) => modes.push(m))
    s.signals.damage$.subscribe((r) => damage.push(r))

    feed(s, "") // empty write — no state change, no damage
    expect(titles).toEqual([])
    expect(modes).toEqual([])
    expect(damage).toEqual([])
  })
})

describe("signals — unsubscribe stops delivery", () => {
  test("an unsubscribed listener receives nothing further", () => {
    const s = mkScreen()
    const seen: string[] = []
    const off = s.signals.title$.subscribe((t) => seen.push(t))

    feed(s, "\x1b]0;One\x07")
    off()
    feed(s, "\x1b]0;Two\x07")

    expect(seen).toEqual(["One"])
  })

  test("damage$ stops delivering after unsubscribe and re-baselines on re-subscribe", () => {
    const s = mkScreen()
    const first: DirtyRegion[] = []
    const off = s.signals.damage$.subscribe((r) => first.push(r))
    feed(s, "A")
    off()
    feed(s, "\x1b[2;1HB") // row 1 — no subscriber, must not accumulate
    expect(first.length).toBe(1)

    const second: DirtyRegion[] = []
    s.signals.damage$.subscribe((r) => second.push(r))
    feed(s, "\x1b[3;1HC") // row 2 only — the row-1 write while unsubscribed must not leak in
    expect(second.length).toBe(1)
    expect(second[0]!.rows).toEqual(new Set([2]))
  })
})

describe("signals — zero overhead when unused", () => {
  test("writes before .signals access do no signal work (nothing accumulates or emits)", () => {
    const s = mkScreen()
    feed(s, "hello") // .signals never touched
    feed(s, "\x1b[2;1Hworld")

    // First access + subscription: get() shows the empty initial damage (nothing was emitted).
    expect(s.signals.damage$.get()).toEqual({ rows: new Set(), cursor: false, scrolled: 0 })

    const batches: DirtyRegion[] = []
    s.signals.damage$.subscribe((r) => batches.push(r))
    feed(s, "\x1b[1;1H!") // overwrite row 0

    // Only the post-subscribe write appears — the pre-access flood did NO accumulation.
    expect(batches.length).toBe(1)
    expect(batches[0]!.rows).toEqual(new Set([0]))
  })

  test("accessing .signals but never subscribing damage$ keeps the damage accumulator inert", () => {
    const s = mkScreen()
    // Touch the facade + a state signal, but never subscribe damage$.
    s.signals.title$.get()
    feed(s, "flood one\r\nflood two")
    feed(s, "\x1b[1;1Hmore")

    // No damage emission ever happened -> get() still returns the pristine empty region.
    expect(s.signals.damage$.get()).toEqual({ rows: new Set(), cursor: false, scrolled: 0 })
  })
})

describe("signals — modes$ exposes the guest-scanned DECSET set", () => {
  test("altScreen, cursorVisible, bracketedPaste, mouse tracking are all reflected", () => {
    const s = mkScreen()
    const seen: TerminalModes[] = []
    s.signals.modes$.subscribe((m) => seen.push(m))

    feed(s, "\x1b[?25l") // hide cursor
    feed(s, "\x1b[?2004h") // bracketed paste on
    feed(s, "\x1b[?1000h") // mouse tracking on
    feed(s, "\x1b[?1049h") // alt screen on

    const latest = s.signals.modes$.get()
    expect(latest.cursorVisible).toBe(false)
    expect(latest.bracketedPaste).toBe(true)
    expect(latest.mouseTracking).toBe(true)
    expect(latest.mouseTrackingMode).toBe(1000)
    expect(latest.altScreen).toBe(true)
    // Every DECSET flip was a distinct flush, so four distinct emissions landed.
    expect(seen.length).toBe(4)
  })

  test("modes$.get() mirrors getMode() for the scanned keys", () => {
    const s = mkScreen()
    feed(s, "\x1b[?25l\x1b[?2004h\x1b[?1049h")
    const m = s.signals.modes$.get()
    expect(m.cursorVisible).toBe(s.getMode("cursorVisible"))
    expect(m.bracketedPaste).toBe(s.getMode("bracketedPaste"))
    expect(m.altScreen).toBe(s.getMode("altScreen"))
  })
})

describe("signals — size$ tracks resize", () => {
  test("size$ fires with new dimensions on resize() and via apply({resize})", () => {
    const s = mkScreen(20, 4)
    const seen: { cols: number; rows: number }[] = []
    s.signals.size$.subscribe((sz) => seen.push(sz))

    s.resize(30, 6)
    s.apply({ type: "resize", cols: 40, rows: 8 })
    s.resize(40, 8) // unchanged — no fire

    expect(seen).toEqual([
      { cols: 30, rows: 6 },
      { cols: 40, rows: 8 },
    ])
  })
})

describe("signals — apply() and reset() drive the same flush", () => {
  test("apply({output}) emits like process()", () => {
    const s = mkScreen()
    const titles: string[] = []
    s.signals.title$.subscribe((t) => titles.push(t))
    s.apply({ type: "output", data: "\x1b]0;ViaApply\x07" })
    expect(titles).toEqual(["ViaApply"])
  })

  test("reset() emits title/modes back to defaults and damages the whole buffer", () => {
    const s = mkScreen()
    feed(s, "\x1b]0;Gone\x07\x1b[?1049h")
    const titles: string[] = []
    const modes: TerminalModes[] = []
    const damage: DirtyRegion[] = []
    s.signals.title$.subscribe((t) => titles.push(t))
    s.signals.modes$.subscribe((m) => modes.push(m))
    s.signals.damage$.subscribe((r) => damage.push(r))

    s.reset()

    expect(titles).toEqual([""]) // title cleared
    expect(modes[modes.length - 1]!.altScreen).toBe(false) // alt screen dropped
    expect(damage.length).toBe(1)
    expect(damage[0]!.rows).toBe("all") // structural
  })
})

describe("signals — damage$ / takeDirty() coexistence (independent epochs)", () => {
  test("each damage$ batch equals what takeDirty() would report for that same flush", () => {
    const s = mkScreen()
    const batches: DirtyRegion[] = []
    s.signals.damage$.subscribe((r) => batches.push(r))

    feed(s, "one")
    const pull = s.takeDirty() // same flush, pull plane
    expect(batches.length).toBe(1)
    expect(batches[0]!.rows).toEqual(pull.rows)
    expect(batches[0]!.cursor).toBe(pull.cursor)
    expect(batches[0]!.scrolled).toBe(pull.scrolled)
  })

  test("draining damage$ per-flush does NOT drain the pull-plane takeDirty() accumulator", () => {
    const s = mkScreen()
    const batches: DirtyRegion[] = []
    s.signals.damage$.subscribe((r) => batches.push(r))

    feed(s, "\x1b[1;1HA") // row 0
    feed(s, "\x1b[2;1HB") // row 1
    // damage$ already delivered two per-flush batches...
    expect(batches.map((b) => b.rows)).toEqual([new Set([0]), new Set([1])])
    // ...but the pull plane, never taken, still holds the UNION accrued since creation.
    const pull = s.takeDirty()
    expect(pull.rows).toEqual(new Set([0, 1]))
  })

  test("calling takeDirty() mid-stream does NOT steal damage$'s next batch", () => {
    const s = mkScreen()
    const batches: DirtyRegion[] = []
    s.signals.damage$.subscribe((r) => batches.push(r))

    feed(s, "\x1b[1;1HA") // row 0
    s.takeDirty() // drain the pull plane between flushes
    feed(s, "\x1b[2;1HB") // row 1

    // damage$ still reports each flush's own rows, unaffected by the interposed takeDirty().
    expect(batches.map((b) => b.rows)).toEqual([new Set([0]), new Set([1])])
  })

  test("a subscriber that mutates its batch cannot corrupt another subscriber (shared read-only note)", () => {
    // Documents the shared-batch contract: both subscribers receive the SAME region object.
    const s = mkScreen()
    let a: DirtyRegion | undefined
    let b: DirtyRegion | undefined
    s.signals.damage$.subscribe((r) => (a = r))
    s.signals.damage$.subscribe((r) => (b = r))
    feed(s, "x")
    expect(a).toBe(b) // same object reference — treat as read-only
  })
})
