import { describe, test, expect } from "vitest"
import { createVtermScreen, serializeSnapshot } from "../src/index.ts"

const enc = new TextEncoder()

function screenWith(input: string, cols = 80, rows = 24) {
  const screen = createVtermScreen({ cols, rows })
  screen.process(enc.encode(input))
  return screen
}

/**
 * Invariants specific to the packed-cell grid: the engine stores cells as packed typed
 * arrays internally, but the public read boundary (`getCell`/`getRow`) and the Snapshot
 * persist boundary must be indistinguishable from the old heap-object grid. These pin the
 * subtle parts of the pack/unpack round trip — color identity, wide-char spacers,
 * combining marks, and BCE erase — that the representation swap could quietly break.
 */
describe("packed grid — read/persist boundary is representation-agnostic", () => {
  test("truecolor round-trips exactly through the packed store", () => {
    const s = screenWith("\x1b[38;2;10;20;30;48;2;200;100;50mX")
    const cell = s.getCell(0, 0)
    expect(cell.char).toBe("X")
    expect(cell.fg).toEqual({ r: 10, g: 20, b: 30 })
    expect(cell.bg).toEqual({ r: 200, g: 100, b: 50 })
    // Truecolor has no palette-origin index at the read boundary.
    expect(cell.fg?.index).toBeUndefined()
  })

  test("indexed SGR keeps its palette-origin index for the serializer (stripped at getCell)", () => {
    const s = screenWith("\x1b[38;5;196mR")
    // Read boundary returns resolved RGB with no index.
    expect(s.getCell(0, 0).fg?.index).toBeUndefined()
    // But the packed store preserved the origin index, so serialize re-emits the
    // faithful INDEXED form (`38;5;196`) rather than baking `38;2;r;g;b`, keeping the
    // outer terminal's theme in play on reattach.
    const ansi = serializeSnapshot(s.snapshot())
    expect(ansi).toContain("38;5;196")
    expect(ansi).not.toContain("38;2;")
  })

  test("256-color and underline color survive the round trip", () => {
    const s = screenWith("\x1b[38;5;196;58;5;21;4:3mU")
    const cell = s.getCell(0, 0)
    expect(cell.underline).toBe("curly")
    expect(cell.fg).toEqual({ r: 255, g: 0, b: 0 })
    expect(cell.underlineColor).toEqual({ r: 0, g: 0, b: 255 })
  })

  test("all boolean SGR attributes pack and unpack independently", () => {
    const s = screenWith("\x1b[1;2;3;5;7;8;9;53mA")
    const cell = s.getCell(0, 0)
    expect(cell.bold).toBe(true)
    expect(cell.faint).toBe(true)
    expect(cell.italic).toBe(true)
    expect(cell.blink).toBe(true)
    expect(cell.inverse).toBe(true)
    expect(cell.hidden).toBe(true)
    expect(cell.strikethrough).toBe(true)
    expect(cell.overline).toBe(true)
  })

  test("wide character occupies its cell with a blank continuation spacer", () => {
    const s = screenWith("世X")
    expect(s.getCell(0, 0).char).toBe("世")
    expect(s.getCell(0, 0).wide).toBe(true)
    // The trailing column is a blank spacer (empty char, not wide).
    expect(s.getCell(0, 1).char).toBe("")
    expect(s.getCell(0, 1).wide).toBe(false)
    // The next glyph lands past the spacer.
    expect(s.getCell(0, 2).char).toBe("X")
  })

  test("combining mark appends to the previous cell's grapheme", () => {
    const s = screenWith("é") // e + combining acute
    expect(s.getCell(0, 0).char).toBe("é")
    expect(s.getCell(0, 1).char).toBe("")
  })

  test("OSC-8 hyperlink rides the packed cell", () => {
    const s = screenWith("\x1b]8;;https://example.com\x07L\x1b]8;;\x07")
    expect(s.getCell(0, 0).url).toBe("https://example.com")
    expect(s.getCell(0, 0).char).toBe("L")
  })

  test("BCE erase fills with the current background, clearing other attrs", () => {
    // Bold + bg active, print, home, erase-to-end-of-line while both are still current:
    // erased cells keep the bg (BCE) but carry no other attrs (bold is dropped).
    const s = screenWith("\x1b[1;48;2;5;6;7mAB\x1b[H\x1b[K", 10, 2)
    const cell = s.getCell(0, 0)
    expect(cell.char).toBe("")
    expect(cell.bg).toEqual({ r: 5, g: 6, b: 7 })
    expect(cell.bold).toBe(false)
    expect(cell.fg).toBeNull()
  })

  test("snapshot → restore reproduces the packed grid exactly", () => {
    const s = screenWith("\x1b[1;38;2;9;8;7mhello\x1b[0m\nworld 世界")
    const snap = s.snapshot()
    const restored = createVtermScreen({ cols: 80, rows: 24 })
    restored.restore(snap)
    expect(restored.getText()).toBe(s.getText())
    expect(restored.getCell(0, 0)).toEqual(s.getCell(0, 0))
    expect(restored.snapshot()).toEqual(snap)
  })

  test("a large styled flood folds to correct final text", () => {
    const s = createVtermScreen({ cols: 40, rows: 10, scrollbackLimit: 100 })
    const parts: string[] = []
    for (let i = 0; i < 5000; i++) parts.push(`\x1b[3${i % 8}mline ${i}\r\n`)
    s.process(enc.encode(parts.join("")))
    // Last on-screen row is the final printed line (cursor wrapped through scrollback).
    expect(s.getText()).toContain("line 4999")
  })
})
