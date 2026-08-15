/**
 * apply-tap.test.ts — the serializable op seam (`apply`/`tapOps`) + opt-in parser tap (`tapParser`).
 *
 * @failure  The write seam diverges from the legacy path or the taps corrupt/mis-order
 *           observation: `apply({output})` lands a different state than `process()`,
 *           `apply({resize})` differs from `resize()`, an op tap fires the wrong count /
 *           payload / order (breaking journal symmetry), the parser tap drops or mis-parses
 *           a CSI/OSC/print-run/execute or fails to coalesce a grapheme run, an unsubscribe
 *           leaks, a second listener is skipped, a throwing listener wedges the parser, or —
 *           worst — registering a tap changes engine behavior (the zero-overhead contract).
 * @level    l0
 * @consumer screen.apply() / screen.tapOps() / screen.tapParser() — the write vocabulary
 *           (symmetric with the Hab journal + termless Recording) and the opt-in parsed-action
 *           observation plane behind the terminal-flow vertical slice. Run: `bun vitest run
 *           tests/apply-tap.test.ts` from the monorepo root (hh: --project vendor).
 *
 * Contract: `apply(op)` is byte-for-byte equivalent to the legacy `process`/`resize` methods;
 * `tapOps` fires exactly once per applied op with the canonical payload, in call order;
 * `tapParser` emits parsed actions AFTER the engine applies them, in order, coalescing
 * consecutive printable graphemes into ONE `print` event flushed before any control event and
 * at end-of-flood; taps are fail-loud (a throwing listener propagates but leaves the engine
 * consistent) and side-effect-free (an active listener never alters final state).
 */
import { describe, expect, test } from "vitest"
import { createVtermScreen, type ParserEvent, type TerminalOp, type VtermScreen } from "../src/index.ts"

const ESC = "\x1b"
const encoder = new TextEncoder()
const decoder = new TextDecoder()

function mkScreen(
  cols = 40,
  rows = 8,
  options: { maxStringSequenceLength?: number; onResponse?: (data: string) => void } = {},
): VtermScreen {
  return createVtermScreen({ cols, rows, ...options })
}

function bytes(s: string): Uint8Array {
  return encoder.encode(s)
}

/** Collect every parser event delivered to a fresh tap on `screen`. */
function tapEvents(screen: VtermScreen): ParserEvent[] {
  const events: ParserEvent[] = []
  screen.tapParser((ev) => events.push(ev))
  return events
}

/** Collect every op delivered to a fresh op tap on `screen`. */
function tapOpLog(screen: VtermScreen): TerminalOp[] {
  const ops: TerminalOp[] = []
  screen.tapOps((op) => ops.push(op))
  return ops
}

// A mixed flood that exercises every parser-event kind in one pass:
//   "Hello"  → a print run (coalesced)
//   ESC[31m  → CSI (SGR red)
//   "X"      → a second print run
//   ESC]0;.. → OSC (window title), ST-terminated
//   CR       → C0 execute
//   "Y"      → a trailing print run
const MIXED_FLOOD = `Hello${ESC}[31mX${ESC}]0;MyTitle${ESC}\\\rY`

describe("apply(op) — the write seam", () => {
  test("apply({output}) with bytes is byte-for-byte equivalent to process()", () => {
    const flood = bytes(MIXED_FLOOD)

    const viaProcess = mkScreen()
    viaProcess.process(flood)

    const viaApply = mkScreen()
    viaApply.apply({ type: "output", data: flood })

    expect(viaApply.snapshot()).toEqual(viaProcess.snapshot())
    expect(viaApply.serialize()).toBe(viaProcess.serialize())
    expect(viaApply.getText()).toBe(viaProcess.getText())
  })

  test("apply({output}) with a string encodes to the same bytes as process()", () => {
    const text = `line one\r\n${ESC}[1;32mgreen bold${ESC}[0m and 世界 emoji 👍`

    const viaProcess = mkScreen()
    viaProcess.process(bytes(text))

    const viaApplyString = mkScreen()
    viaApplyString.apply({ type: "output", data: text })

    expect(viaApplyString.snapshot()).toEqual(viaProcess.snapshot())
  })

  test("apply({resize}) is equivalent to resize()", () => {
    const seed = bytes(`top line${ESC}[2;5Hmid${ESC}[41mBG${ESC}[0m more text that will wrap at forty cols wide here`)

    const viaResize = mkScreen()
    viaResize.process(seed)
    viaResize.resize(24, 6)

    const viaApply = mkScreen()
    viaApply.apply({ type: "output", data: seed })
    viaApply.apply({ type: "resize", cols: 24, rows: 6 })

    expect(viaApply.snapshot()).toEqual(viaResize.snapshot())
    expect(viaApply.cols).toBe(24)
    expect(viaApply.rows).toBe(6)
  })

  test("apply() throws loudly on an unknown op type (no silent no-op)", () => {
    const screen = mkScreen()
    // Deliberately malformed op — the exhaustive default must fail loud.
    expect(() => screen.apply({ type: "nonsense" } as unknown as TerminalOp)).toThrow()
  })
})

describe("tapOps — the op observation plane", () => {
  test("fires exactly once per applied op, in call order, with canonical payloads", () => {
    const screen = mkScreen()
    const ops = tapOpLog(screen)

    screen.process(bytes("first"))
    screen.apply({ type: "output", data: "second" })
    screen.resize(20, 4)
    screen.apply({ type: "resize", cols: 30, rows: 5 })

    expect(ops).toHaveLength(4)

    expect(ops[0]!.type).toBe("output")
    expect(ops[1]!.type).toBe("output")
    // Canonical encoding is bytes: a string passed to apply() is encoded before the tap sees it.
    const op0 = ops[0]!
    const op1 = ops[1]!
    if (op0.type !== "output" || op1.type !== "output") throw new Error("expected output ops")
    expect(op0.data).toBeInstanceOf(Uint8Array)
    expect(op1.data).toBeInstanceOf(Uint8Array)
    expect(decoder.decode(op0.data as Uint8Array)).toBe("first")
    expect(decoder.decode(op1.data as Uint8Array)).toBe("second")

    expect(ops[2]).toEqual({ type: "resize", cols: 20, rows: 4 })
    expect(ops[3]).toEqual({ type: "resize", cols: 30, rows: 5 })
  })

  test("a passed-through Uint8Array is delivered verbatim to the op tap", () => {
    const screen = mkScreen()
    const ops = tapOpLog(screen)
    const buf = bytes("verbatim")

    screen.apply({ type: "output", data: buf })

    const op = ops[0]!
    if (op.type !== "output") throw new Error("expected output op")
    expect(op.data).toBe(buf)
  })
})

describe("tapParser — the parsed-action observation plane", () => {
  test("emits csi, osc, execute, and coalesced print runs for a mixed flood", () => {
    const screen = mkScreen()
    const events = tapEvents(screen)

    screen.process(bytes(MIXED_FLOOD))

    // Print runs are coalesced: "Hello", "X", "Y" — never split into per-grapheme events.
    const prints = events.filter((e) => e.kind === "print").map((e) => (e.kind === "print" ? e.text : ""))
    expect(prints).toEqual(["Hello", "X", "Y"])

    const csi = events.find((e) => e.kind === "csi")
    expect(csi).toMatchObject({ kind: "csi", final: "m", params: [31] })

    const osc = events.find((e) => e.kind === "osc")
    expect(osc).toEqual({ kind: "osc", code: 0, data: "MyTitle" })

    const execute = events.find((e) => e.kind === "execute")
    expect(execute).toEqual({ kind: "execute", code: 0x0d })

    // Order is application order: Hello, SGR, X, title, CR, Y.
    expect(events.map((e) => e.kind)).toEqual(["print", "csi", "print", "osc", "execute", "print"])
  })

  test("coalesces print runs but flushes them before an interleaved control", () => {
    const screen = mkScreen()
    const events = tapEvents(screen)

    screen.process(bytes("AB\rCD"))

    expect(events).toEqual([
      { kind: "print", text: "AB" },
      { kind: "execute", code: 0x0d },
      { kind: "print", text: "CD" },
    ])
  })

  test("reports a private CSI with its prefix marker preserved", () => {
    const screen = mkScreen()
    const events = tapEvents(screen)

    // DECRST hide-cursor: ESC [ ? 2 5 l — the '?' prefix distinguishes it from CSI 25 l.
    screen.process(bytes(`${ESC}[?25l`))

    const csi = events.find((e) => e.kind === "csi")
    expect(csi).toEqual({ kind: "csi", final: "l", params: [25], prefix: "?" })
  })

  test("reports an OSC 8 hyperlink with its code and payload", () => {
    const screen = mkScreen()
    const events = tapEvents(screen)

    screen.process(bytes(`${ESC}]8;;https://example.com${ESC}\\`))

    const osc = events.find((e) => e.kind === "osc")
    expect(osc).toEqual({ kind: "osc", code: 8, data: ";https://example.com" })
  })

  test("reports ESC finals and charset designators (with intermediate)", () => {
    const screen = mkScreen()
    const events = tapEvents(screen)

    // IND (ESC D) then designate G0 = DEC Special Graphics (ESC ( 0).
    screen.process(bytes(`${ESC}D${ESC}(0`))

    const escEvents = events.filter((e) => e.kind === "esc")
    expect(escEvents).toEqual([
      { kind: "esc", final: "D" },
      { kind: "esc", final: "0", intermediates: "(" },
    ])
  })

  test("reports completed APC and DCS payloads at their guest-local cursor anchor", () => {
    const screen = mkScreen()
    const events = tapEvents(screen)

    screen.process(bytes(`${ESC}[3;5H${ESC}_Gf=100,a=T;AAAA${ESC}\\${ESC}Pq~${ESC}\\`))

    expect(events.filter((event) => event.kind === "apc" || event.kind === "dcs")).toEqual([
      { kind: "apc", data: "Gf=100,a=T;AAAA", row: 2, col: 4 },
      { kind: "dcs", data: "q~", row: 2, col: 4 },
    ])
  })

  test("bounds APC and DCS payloads and emits a typed loud drop after completion", () => {
    const responses: string[] = []
    const screen = mkScreen(40, 8, {
      maxStringSequenceLength: 4,
      onResponse: (data) => responses.push(data),
    })
    const events = tapEvents(screen)

    screen.process(bytes(`${ESC}_Ga=q,i=1;AAAA${ESC}\\${ESC}Pq12345${ESC}\\Z`))

    expect(events.filter((event) => event.kind === "apc" || event.kind === "dcs")).toEqual([])
    expect(events.filter((event) => event.kind === "string-overflow")).toEqual([
      {
        kind: "string-overflow",
        sequence: "apc",
        maxLength: 4,
        receivedLength: 13,
        row: 0,
        col: 0,
      },
      {
        kind: "string-overflow",
        sequence: "dcs",
        maxLength: 4,
        receivedLength: 6,
        row: 0,
        col: 0,
      },
    ])
    expect(responses).toEqual([])
    expect(screen.getSixelImages()).toEqual([])
    expect(events.at(-1)).toEqual({ kind: "print", text: "Z" })
  })

  test("emits parsed actions AFTER they are applied (state already reflects the event)", () => {
    const screen = mkScreen()
    const titles: (string | null)[] = []
    screen.tapParser((ev) => {
      if (ev.kind === "osc" && ev.code === 0) titles.push(screen.getTitle())
    })

    screen.process(bytes(`${ESC}]0;Applied${ESC}\\`))

    // The title is already set when the OSC event fires → emission is post-apply.
    expect(titles).toEqual(["Applied"])
  })
})

describe("tap lifecycle — subscribe, unsubscribe, multiplex", () => {
  test("unsubscribe stops delivery for both tap kinds", () => {
    const screen = mkScreen()

    const parserEvents: ParserEvent[] = []
    const stopParser = screen.tapParser((ev) => parserEvents.push(ev))
    const ops: TerminalOp[] = []
    const stopOps = screen.tapOps((op) => ops.push(op))

    screen.process(bytes("before"))
    const parserCountBefore = parserEvents.length
    const opCountBefore = ops.length
    expect(parserCountBefore).toBeGreaterThan(0)
    expect(opCountBefore).toBe(1)

    stopParser()
    stopOps()

    screen.process(bytes("after"))
    expect(parserEvents.length).toBe(parserCountBefore)
    expect(ops.length).toBe(opCountBefore)
  })

  test("two listeners on the same tap both fire", () => {
    const screen = mkScreen()

    const a: ParserEvent[] = []
    const b: ParserEvent[] = []
    screen.tapParser((ev) => a.push(ev))
    screen.tapParser((ev) => b.push(ev))

    const opsA: TerminalOp[] = []
    const opsB: TerminalOp[] = []
    screen.tapOps((op) => opsA.push(op))
    screen.tapOps((op) => opsB.push(op))

    screen.process(bytes("Hi"))

    expect(a).toEqual(b)
    expect(a.length).toBeGreaterThan(0)
    expect(opsA).toEqual(opsB)
    expect(opsA).toHaveLength(1)
  })

  test("unsubscribing one of two listeners leaves the other intact", () => {
    const screen = mkScreen()
    const a: ParserEvent[] = []
    const b: ParserEvent[] = []
    const stopA = screen.tapParser((ev) => a.push(ev))
    screen.tapParser((ev) => b.push(ev))

    screen.process(bytes("one"))
    stopA()
    screen.process(bytes("two"))

    // b saw both floods; a only the first.
    expect(b.length).toBeGreaterThan(a.length)
  })
})

describe("fail-loud + zero-overhead guarantees", () => {
  test("a throwing parser listener propagates but leaves the engine consistent", () => {
    const screen = mkScreen()
    let threw = false
    const stop = screen.tapParser(() => {
      throw new Error("tap must not throw — but if it does, propagate")
    })

    // The first emitted event throws; the flood aborts mid-way.
    expect(() => screen.process(bytes(`AB${ESC}[31mCD`))).toThrow("tap must not throw")
    threw = true

    stop() // remove the saboteur

    // Everything applied before the throw is intact; the parser is not wedged mid-sequence.
    expect(threw).toBe(true)
    expect(screen.getText().trimEnd()).toBe("AB")

    // Further input processes cleanly (cursor is at col 2, ground state) → proves no corruption.
    screen.process(bytes("Z"))
    expect(screen.getText().trimEnd()).toBe("ABZ")
  })

  test("a throwing op listener propagates after the op is fully applied", () => {
    const screen = mkScreen()
    const stop = screen.tapOps(() => {
      throw new Error("op tap boom")
    })

    expect(() => screen.process(bytes("payload"))).toThrow("op tap boom")
    stop()

    // The bytes were applied before the op fired at end-of-process.
    expect(screen.getText().trimEnd()).toBe("payload")
  })

  test("an active observing tap does not change engine behavior (zero-overhead contract)", () => {
    const flood = bytes(MIXED_FLOOD)

    const observed = mkScreen()
    // Register active listeners that only read — they must not mutate any state.
    observed.tapParser(() => void 0)
    observed.tapOps(() => void 0)
    observed.process(flood)

    const control = mkScreen()
    control.process(flood)

    expect(observed.snapshot()).toEqual(control.snapshot())
    expect(observed.serialize()).toBe(control.serialize())
  })

  test("subscribe-then-unsubscribe leaves no residue vs a never-tapped control", () => {
    const flood = bytes(MIXED_FLOOD)

    const cycled = mkScreen()
    const stopP = cycled.tapParser(() => void 0)
    const stopO = cycled.tapOps(() => void 0)
    stopP()
    stopO()
    cycled.process(flood)

    const control = mkScreen()
    control.process(flood)

    expect(cycled.snapshot()).toEqual(control.snapshot())
  })
})
