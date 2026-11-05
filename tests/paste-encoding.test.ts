/**
 * @failure Native paste bytes diverge from the same Screen's modes or mutate parser state.
 * @level l0
 * @consumer Native Screen.encodePaste callers and terminal backend adapters
 * @testonly none
 */
import { describe, expect, test, vi } from "vitest"
import { createVt100Screen } from "../packages/vt100/src/index.ts"
import { createVt220Screen } from "../packages/vt220/src/index.ts"
import { createVtermScreen } from "../packages/vterm/src/index.ts"

const encoder = new TextEncoder()
const engines = [
  { name: "vt100", create: createVt100Screen, modern: false },
  { name: "vt220", create: createVt220Screen, modern: false },
  { name: "vterm", create: createVtermScreen, modern: true },
] as const

describe.each(engines)("$name native paste", ({ create, modern }) => {
  test("raw UTF-8 preserves empty, Unicode, controls, markers and all newline forms", () => {
    const screen = create({ cols: 12, rows: 3 })
    for (const text of ["", "hello", "é中😀", "a\nb\rc\r\nd", "\t\x1b[31mred\x1b[0m", "\x1b[200~x\x1b[201~"]) {
      expect(screen.encodePaste(text)).toEqual(encoder.encode(text))
    }
  })

  test("paste reads its own mode and stays independent across instances and reset", () => {
    const first = create({ cols: 12, rows: 3 })
    const second = create({ cols: 12, rows: 3 })
    first.process(encoder.encode("\x1b[?2004h"))
    expect(first.getMode("bracketedPaste")).toBe(modern)
    expect(second.getMode("bracketedPaste")).toBe(false)
    expect(first.encodePaste("x")).toEqual(encoder.encode(modern ? "\x1b[200~x\x1b[201~" : "x"))
    expect(second.encodePaste("x")).toEqual(encoder.encode("x"))
    first.reset()
    expect(first.getMode("bracketedPaste")).toBe(false)
    expect(first.encodePaste("x")).toEqual(encoder.encode("x"))
  })

  test("encoding preserves cells, cursor, history, modes, snapshots and reply callbacks", () => {
    const onResponse = vi.fn()
    const screen = create({ cols: 12, rows: 2, onResponse })
    screen.process(encoder.encode("one\r\ntwo\r\nthree\r\nfour\x1b[?2004h\x1b[5n"))
    expect(onResponse.mock.calls).toEqual([["\x1b[0n"]])
    onResponse.mockClear()
    const state = () => ({
      cells: Array.from({ length: screen.rows }, (_, row) =>
        Array.from({ length: screen.cols }, (_, col) => screen.getCell(row, col)),
      ),
      text: screen.getText(),
      cursor: "getCursor" in screen ? screen.getCursor() : screen.getCursorPosition(),
      historyLength: screen.getScrollbackLength(),
      viewport: screen.getViewportOffset(),
      visible: screen.getCursorVisible(),
      modes: ["bracketedPaste", "applicationCursor", "autoWrap", "newLineMode"].map((mode) => screen.getMode(mode)),
      snapshot:
        "snapshot" in screen
          ? screen.snapshot()
          : Array.from({ length: screen.getScrollbackLength() }, (_, row) => screen.getScrollbackLine(row)),
    })
    const before = structuredClone(state())
    expect(before.historyLength).toBeGreaterThan(0)
    const process = vi.spyOn(screen, "process")

    screen.encodePaste("\x1b[5n\x1b[?25lmutate\r\n\x1b[201~")

    expect(state()).toEqual(before)
    expect(process).not.toHaveBeenCalled()
    expect(onResponse).not.toHaveBeenCalled()
  })
})

describe.each(engines.filter(({ modern }) => !modern))("$name historical mode policy", ({ create }) => {
  test("2004 is fixed off and its unsupported query still produces no reply", () => {
    const onResponse = vi.fn()
    const screen = create({ cols: 12, rows: 3, onResponse })
    for (const mode of ["", "\x1b[?2004h", "\x1b[?2004l"]) {
      screen.process(encoder.encode(mode + "\x1b[?2004$p"))
      expect(screen.getMode("bracketedPaste")).toBe(false)
      expect(screen.encodePaste("\x1b[201~x\n")).toEqual(encoder.encode("\x1b[201~x\n"))
    }
    expect(onResponse).not.toHaveBeenCalled()
    screen.process(encoder.encode("\x1b[5n"))
    expect(onResponse.mock.calls).toEqual([["\x1b[0n"]])
  })
})

test("vt220 snapshot restoration retains its fixed-off native paste policy", () => {
  const screen = createVt220Screen({ cols: 12, rows: 3 })
  screen.process(encoder.encode("saved\x1b[?2004h"))
  const snapshot = screen.snapshot()
  screen.reset()
  screen.restore(snapshot)
  expect(screen.getMode("bracketedPaste")).toBe(false)
  expect(screen.encodePaste("x\n")).toEqual(encoder.encode("x\n"))
  expect(screen.snapshot()).toEqual(snapshot)
})

describe("vterm native framing", () => {
  test("off/on/off uses current 2004 state and removes every payload framing marker only when bracketed", () => {
    const screen = createVtermScreen({ cols: 12, rows: 3 })
    const cases = [
      { text: "", safe: "" },
      { text: "é中😀\t\n\r\r\n", safe: "é中😀\t\n\r\r\n" },
      { text: "\x1b[200~a\x1b[201~b\x1b[200~c\x1b[201~\x1b[31m", safe: "abc\x1b[31m" },
      { text: "\x1b[20\x1b[201~1~", safe: "" },
    ]
    for (const bracketed of [false, true, false]) {
      screen.process(encoder.encode(`\x1b[?2004${bracketed ? "h" : "l"}`))
      for (const { text, safe } of cases) {
        expect(screen.encodePaste(text)).toEqual(encoder.encode(bracketed ? `\x1b[200~${safe}\x1b[201~` : text))
      }
    }
  })

  test("LNM never converts LF, CR or CRLF in raw or bracketed paste", () => {
    const screen = createVtermScreen({ cols: 12, rows: 3 })
    for (const lnm of [false, true]) {
      screen.process(encoder.encode(`\x1b[20${lnm ? "h" : "l"}`))
      expect(screen.getMode("newLineMode")).toBe(lnm)
      for (const bracketed of [false, true]) {
        screen.process(encoder.encode(`\x1b[?2004${bracketed ? "h" : "l"}`))
        expect(screen.encodePaste("a\nb\rc\r\nd")).toEqual(
          encoder.encode(bracketed ? "\x1b[200~a\nb\rc\r\nd\x1b[201~" : "a\nb\rc\r\nd"),
        )
      }
    }
  })

  test("restored snapshots supply the current paste mode without encoder state", () => {
    const screen = createVtermScreen({ cols: 12, rows: 3 })
    const off = screen.snapshot()
    screen.process(encoder.encode("\x1b[?2004h"))
    const on = screen.snapshot()
    screen.reset()
    screen.restore(on)
    expect(screen.encodePaste("x")).toEqual(encoder.encode("\x1b[200~x\x1b[201~"))
    expect(screen.snapshot()).toEqual(on)
    screen.restore(off)
    expect(screen.encodePaste("x")).toEqual(encoder.encode("x"))
    expect(screen.snapshot()).toEqual(off)
  })
})
