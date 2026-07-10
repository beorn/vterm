import { describe, test, expect } from "vitest"
import {
  createVtermScreen,
  type VtermScreenSnapshot,
  type Snapshot,
  type Color,
  type Cursor,
  type CellColor,
  type ScreenSnapshot,
} from "../src/index.ts"

const enc = new TextEncoder()

/** Helper: create a screen and process a string */
function screenWith(input: string, opts?: Parameters<typeof createVtermScreen>[0]) {
  const screen = createVtermScreen(opts)
  screen.process(enc.encode(input))
  return screen
}

// ═══════════════════════════════════════════════════════
// §9 naming ruling — canonical names + deprecated aliases
// ═══════════════════════════════════════════════════════

describe("§9 naming ruling", () => {
  test("getRow returns cells and matches deprecated getLine", () => {
    const screen = screenWith("\x1b[1mHi\x1b[0m")
    const row = screen.getRow(0)
    expect(row[0]?.char).toBe("H")
    expect(row[0]?.bold).toBe(true)
    expect(screen.getRow(0)).toEqual(screen.getLine(0))
  })

  test("getCursor returns {col,row}; getCursorPosition still returns {x,y}", () => {
    const screen = screenWith("hello")
    expect(screen.getCursor()).toEqual({ col: 5, row: 0 })
    const legacy = screen.getCursorPosition()
    expect({ col: legacy.x, row: legacy.y }).toEqual(screen.getCursor())
  })

  test("Color is the canonical shape; CellColor alias resolves to it", () => {
    const screen = screenWith("\x1b[38;2;255;100;0mX\x1b[0m")
    const c: Color | null = screen.getRow(0)[0]?.fg ?? null
    expect(c).toEqual({ r: 255, g: 100, b: 0 })
    // CellColor is a structural alias of Color — assignable both directions.
    const asCell: CellColor | null = c
    const asColor: Color | null = asCell
    expect(asColor).toEqual(c)
  })

  test("Snapshot is canonical; ScreenSnapshot / VtermScreenSnapshot aliases interchange", () => {
    const screen = screenWith("world")
    const snap: Snapshot = screen.snapshot()
    const asLegacy: ScreenSnapshot = snap
    const asVterm: VtermScreenSnapshot = asLegacy
    const restored = createVtermScreen({ cols: snap.cols, rows: snap.rows })
    restored.restore(asVterm)
    expect(restored.getText()).toBe(screen.getText())
  })
})

// ═══════════════════════════════════════════════════════
// Basic / existing tests
// ═══════════════════════════════════════════════════════

describe("vterm screen", () => {
  test("creates with default dimensions", () => {
    const screen = createVtermScreen()
    expect(screen.cols).toBe(80)
    expect(screen.rows).toBe(24)
  })

  test("creates with custom dimensions", () => {
    const screen = createVtermScreen({ cols: 120, rows: 40 })
    expect(screen.cols).toBe(120)
    expect(screen.rows).toBe(40)
  })

  test("cursor starts at origin", () => {
    const screen = createVtermScreen()
    expect(screen.getCursorPosition()).toEqual({ x: 0, y: 0 })
  })

  test("cursor is visible by default", () => {
    const screen = createVtermScreen()
    expect(screen.getCursorVisible()).toBe(true)
  })

  test("cursor shape defaults to block", () => {
    const screen = createVtermScreen()
    expect(screen.getCursorShape()).toBe("block")
  })

  test("reset returns to initial state", () => {
    const screen = createVtermScreen()
    screen.process(enc.encode("hello"))
    screen.reset()
    expect(screen.getCursorPosition()).toEqual({ x: 0, y: 0 })
    expect(screen.getTitle()).toBe("")
  })

  test("autoWrap is on by default", () => {
    const screen = createVtermScreen()
    expect(screen.getMode("autoWrap")).toBe(true)
  })

  test("resize updates dimensions", () => {
    const screen = createVtermScreen({ cols: 80, rows: 24 })
    screen.resize(120, 40)
    expect(screen.cols).toBe(120)
    expect(screen.rows).toBe(40)
  })
})

// ═══════════════════════════════════════════════════════
// Text writing and cursor movement
// ═══════════════════════════════════════════════════════

describe("text writing", () => {
  test("writes text and advances cursor", () => {
    const screen = screenWith("hello")
    expect(screen.getCursorPosition()).toEqual({ x: 5, y: 0 })
    expect(screen.getCell(0, 0).char).toBe("h")
    expect(screen.getCell(0, 4).char).toBe("o")
  })

  test("newline moves cursor down", () => {
    const screen = screenWith("hello\r\nworld")
    expect(screen.getCursorPosition()).toEqual({ x: 5, y: 1 })
    expect(screen.getCell(1, 0).char).toBe("w")
  })

  test("carriage return moves cursor to start", () => {
    const screen = screenWith("hello\rworld")
    expect(screen.getCursorPosition()).toEqual({ x: 5, y: 0 })
    expect(screen.getCell(0, 0).char).toBe("w")
  })

  test("backspace moves cursor back", () => {
    const screen = screenWith("ab\x08")
    expect(screen.getCursorPosition()).toEqual({ x: 1, y: 0 })
  })

  test("tab advances to next tab stop", () => {
    const screen = screenWith("a\t")
    expect(screen.getCursorPosition().x).toBe(8)
  })

  test("autowrap wraps at end of line", () => {
    const screen = createVtermScreen({ cols: 5, rows: 3 })
    screen.process(enc.encode("123456"))
    expect(screen.getCursorPosition()).toEqual({ x: 1, y: 1 })
    expect(screen.getCell(1, 0).char).toBe("6")
  })
})

// ═══════════════════════════════════════════════════════
// Cursor movement sequences
// ═══════════════════════════════════════════════════════

describe("cursor movement", () => {
  test("CUP moves cursor to position", () => {
    const screen = screenWith("\x1b[5;10H")
    expect(screen.getCursorPosition()).toEqual({ x: 9, y: 4 })
  })

  test("CUU moves cursor up", () => {
    const screen = screenWith("\x1b[5;1H\x1b[2A")
    expect(screen.getCursorPosition()).toEqual({ x: 0, y: 2 })
  })

  test("CUD moves cursor down", () => {
    const screen = screenWith("\x1b[2B")
    expect(screen.getCursorPosition()).toEqual({ x: 0, y: 2 })
  })

  test("CUF moves cursor forward", () => {
    const screen = screenWith("\x1b[5C")
    expect(screen.getCursorPosition()).toEqual({ x: 5, y: 0 })
  })

  test("CUB moves cursor back", () => {
    const screen = screenWith("\x1b[10;1H\x1b[3D")
    expect(screen.getCursorPosition()).toEqual({ x: 0, y: 9 }) // clamped at 0
  })

  test("CHA sets column", () => {
    const screen = screenWith("\x1b[15G")
    expect(screen.getCursorPosition().x).toBe(14)
  })

  test("VPA sets row", () => {
    const screen = screenWith("\x1b[10d")
    expect(screen.getCursorPosition().y).toBe(9)
  })

  test("CNL moves to next line start", () => {
    const screen = screenWith("hello\x1b[E")
    expect(screen.getCursorPosition()).toEqual({ x: 0, y: 1 })
  })

  test("CPL moves to previous line start", () => {
    const screen = screenWith("\x1b[5;10H\x1b[2F")
    expect(screen.getCursorPosition()).toEqual({ x: 0, y: 2 })
  })

  test("HVP moves cursor (same as CUP)", () => {
    const screen = screenWith("\x1b[3;7f")
    expect(screen.getCursorPosition()).toEqual({ x: 6, y: 2 })
  })
})

// ═══════════════════════════════════════════════════════
// Erase operations
// ═══════════════════════════════════════════════════════

describe("erase operations", () => {
  test("ED 0 erases from cursor to end", () => {
    const screen = createVtermScreen({ cols: 10, rows: 3 })
    screen.process(enc.encode("aaaaaaaaaa"))
    screen.process(enc.encode("\x1b[1;5H")) // row 0, col 4
    screen.process(enc.encode("\x1b[0J"))
    expect(screen.getCell(0, 3).char).toBe("a")
    expect(screen.getCell(0, 4).char).toBe("")
  })

  test("ED 2 erases entire display", () => {
    const screen = createVtermScreen({ cols: 10, rows: 3 })
    screen.process(enc.encode("hello"))
    screen.process(enc.encode("\x1b[2J"))
    expect(screen.getCell(0, 0).char).toBe("")
  })

  test("EL 0 erases to end of line", () => {
    const screen = createVtermScreen({ cols: 10, rows: 3 })
    screen.process(enc.encode("1234567890"))
    screen.process(enc.encode("\x1b[1;5H\x1b[0K"))
    expect(screen.getCell(0, 3).char).toBe("4")
    expect(screen.getCell(0, 4).char).toBe("")
  })

  test("ECH erases characters at cursor", () => {
    const screen = createVtermScreen({ cols: 10, rows: 3 })
    screen.process(enc.encode("1234567890"))
    screen.process(enc.encode("\x1b[1;3H\x1b[3X"))
    expect(screen.getCell(0, 1).char).toBe("2")
    expect(screen.getCell(0, 2).char).toBe("")
    expect(screen.getCell(0, 4).char).toBe("")
    expect(screen.getCell(0, 5).char).toBe("6")
  })
})

// ═══════════════════════════════════════════════════════
// SGR attributes (existing from vt100)
// ═══════════════════════════════════════════════════════

describe("SGR attributes", () => {
  test("bold", () => {
    const screen = screenWith("\x1b[1mX")
    expect(screen.getCell(0, 0).bold).toBe(true)
  })

  test("faint", () => {
    const screen = screenWith("\x1b[2mX")
    expect(screen.getCell(0, 0).faint).toBe(true)
  })

  test("italic", () => {
    const screen = screenWith("\x1b[3mX")
    expect(screen.getCell(0, 0).italic).toBe(true)
  })

  test("underline single", () => {
    const screen = screenWith("\x1b[4mX")
    expect(screen.getCell(0, 0).underline).toBe("single")
  })

  test("underline curly (4:3)", () => {
    const screen = screenWith("\x1b[4:3mX")
    expect(screen.getCell(0, 0).underline).toBe("curly")
  })

  test("underline double (4:2)", () => {
    const screen = screenWith("\x1b[4:2mX")
    expect(screen.getCell(0, 0).underline).toBe("double")
  })

  test("underline dotted (4:4)", () => {
    const screen = screenWith("\x1b[4:4mX")
    expect(screen.getCell(0, 0).underline).toBe("dotted")
  })

  test("underline dashed (4:5)", () => {
    const screen = screenWith("\x1b[4:5mX")
    expect(screen.getCell(0, 0).underline).toBe("dashed")
  })

  test("strikethrough", () => {
    const screen = screenWith("\x1b[9mX")
    expect(screen.getCell(0, 0).strikethrough).toBe(true)
  })

  test("inverse", () => {
    const screen = screenWith("\x1b[7mX")
    expect(screen.getCell(0, 0).inverse).toBe(true)
  })

  test("hidden", () => {
    const screen = screenWith("\x1b[8mX")
    expect(screen.getCell(0, 0).hidden).toBe(true)
  })

  test("reset clears all attributes", () => {
    const screen = screenWith("\x1b[1;3;4;9mX\x1b[0mY")
    const x = screen.getCell(0, 0)
    expect(x.bold).toBe(true)
    expect(x.italic).toBe(true)
    expect(x.underline).toBe("single")
    expect(x.strikethrough).toBe(true)
    const y = screen.getCell(0, 1)
    expect(y.bold).toBe(false)
    expect(y.italic).toBe(false)
    expect(y.underline).toBe("none")
    expect(y.strikethrough).toBe(false)
  })

  test("16-color foreground", () => {
    const screen = screenWith("\x1b[31mX")
    expect(screen.getCell(0, 0).fg).toEqual({ r: 0x80, g: 0, b: 0 }) // Red
  })

  test("16-color background", () => {
    const screen = screenWith("\x1b[42mX")
    expect(screen.getCell(0, 0).bg).toEqual({ r: 0, g: 0x80, b: 0 }) // Green
  })

  test("256-color foreground", () => {
    const screen = screenWith("\x1b[38;5;196mX")
    expect(screen.getCell(0, 0).fg).toBeDefined()
    expect(screen.getCell(0, 0).fg!.r).toBe(0xff)
  })

  test("24-bit truecolor foreground", () => {
    const screen = screenWith("\x1b[38;2;100;150;200mX")
    expect(screen.getCell(0, 0).fg).toEqual({ r: 100, g: 150, b: 200 })
  })

  test("24-bit truecolor background", () => {
    const screen = screenWith("\x1b[48;2;50;75;100mX")
    expect(screen.getCell(0, 0).bg).toEqual({ r: 50, g: 75, b: 100 })
  })

  test("bright foreground 90-97", () => {
    const screen = screenWith("\x1b[91mX")
    expect(screen.getCell(0, 0).fg).toEqual({ r: 0xff, g: 0, b: 0 }) // Bright red
  })

  test("bright background 100-107", () => {
    const screen = screenWith("\x1b[102mX")
    expect(screen.getCell(0, 0).bg).toEqual({ r: 0, g: 0xff, b: 0 }) // Bright green
  })

  test("SGR 22 resets bold and faint", () => {
    const screen = screenWith("\x1b[1;2mX\x1b[22mY")
    expect(screen.getCell(0, 1).bold).toBe(false)
    expect(screen.getCell(0, 1).faint).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════
// NEW: SGR blink (5, 6, 25)
// ═══════════════════════════════════════════════════════

describe("SGR blink", () => {
  test("slow blink (SGR 5)", () => {
    const screen = screenWith("\x1b[5mX")
    expect(screen.getCell(0, 0).blink).toBe(true)
  })

  test("rapid blink (SGR 6)", () => {
    const screen = screenWith("\x1b[6mX")
    expect(screen.getCell(0, 0).blink).toBe(true)
  })

  test("blink off (SGR 25)", () => {
    const screen = screenWith("\x1b[5mX\x1b[25mY")
    expect(screen.getCell(0, 0).blink).toBe(true)
    expect(screen.getCell(0, 1).blink).toBe(false)
  })

  test("reset clears blink", () => {
    const screen = screenWith("\x1b[5mX\x1b[0mY")
    expect(screen.getCell(0, 0).blink).toBe(true)
    expect(screen.getCell(0, 1).blink).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════
// NEW: SGR overline (53, 55)
// ═══════════════════════════════════════════════════════

describe("SGR overline", () => {
  test("overline on (SGR 53)", () => {
    const screen = screenWith("\x1b[53mX")
    expect(screen.getCell(0, 0).overline).toBe(true)
  })

  test("overline off (SGR 55)", () => {
    const screen = screenWith("\x1b[53mX\x1b[55mY")
    expect(screen.getCell(0, 0).overline).toBe(true)
    expect(screen.getCell(0, 1).overline).toBe(false)
  })

  test("reset clears overline", () => {
    const screen = screenWith("\x1b[53mX\x1b[0mY")
    expect(screen.getCell(0, 1).overline).toBe(false)
  })

  test("overline combined with other attributes", () => {
    const screen = screenWith("\x1b[1;53mX")
    const cell = screen.getCell(0, 0)
    expect(cell.bold).toBe(true)
    expect(cell.overline).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════
// NEW: SGR underline color (58, 59)
// ═══════════════════════════════════════════════════════

describe("SGR underline color", () => {
  test("underline color with 256-color (58;5;N)", () => {
    const screen = screenWith("\x1b[4m\x1b[58;5;196mX")
    const cell = screen.getCell(0, 0)
    expect(cell.underline).toBe("single")
    expect(cell.underlineColor).toBeDefined()
    expect(cell.underlineColor!.r).toBe(0xff)
  })

  test("underline color with truecolor (58;2;R;G;B)", () => {
    const screen = screenWith("\x1b[4m\x1b[58;2;100;200;50mX")
    const cell = screen.getCell(0, 0)
    expect(cell.underlineColor).toEqual({ r: 100, g: 200, b: 50 })
  })

  test("underline color reset (SGR 59)", () => {
    const screen = screenWith("\x1b[4;58;2;100;200;50mX\x1b[59mY")
    expect(screen.getCell(0, 0).underlineColor).toEqual({ r: 100, g: 200, b: 50 })
    expect(screen.getCell(0, 1).underlineColor).toBeNull()
  })

  test("full reset clears underline color", () => {
    const screen = screenWith("\x1b[58;2;100;200;50mX\x1b[0mY")
    expect(screen.getCell(0, 1).underlineColor).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════
// NEW: Cursor shape (DECSCUSR)
// ═══════════════════════════════════════════════════════

describe("cursor shape (DECSCUSR)", () => {
  test("default is blinking block", () => {
    const screen = createVtermScreen()
    expect(screen.getCursorShape()).toBe("block")
    expect(screen.getCursorBlinking()).toBe(true)
  })

  test("CSI 0 SP q = blinking block", () => {
    const screen = screenWith("\x1b[0 q")
    expect(screen.getCursorShape()).toBe("block")
    expect(screen.getCursorBlinking()).toBe(true)
  })

  test("CSI 1 SP q = blinking block", () => {
    const screen = screenWith("\x1b[1 q")
    expect(screen.getCursorShape()).toBe("block")
    expect(screen.getCursorBlinking()).toBe(true)
  })

  test("CSI 2 SP q = steady block", () => {
    const screen = screenWith("\x1b[2 q")
    expect(screen.getCursorShape()).toBe("block")
    expect(screen.getCursorBlinking()).toBe(false)
  })

  test("CSI 3 SP q = blinking underline", () => {
    const screen = screenWith("\x1b[3 q")
    expect(screen.getCursorShape()).toBe("underline")
    expect(screen.getCursorBlinking()).toBe(true)
  })

  test("CSI 4 SP q = steady underline", () => {
    const screen = screenWith("\x1b[4 q")
    expect(screen.getCursorShape()).toBe("underline")
    expect(screen.getCursorBlinking()).toBe(false)
  })

  test("CSI 5 SP q = blinking bar", () => {
    const screen = screenWith("\x1b[5 q")
    expect(screen.getCursorShape()).toBe("bar")
    expect(screen.getCursorBlinking()).toBe(true)
  })

  test("CSI 6 SP q = steady bar", () => {
    const screen = screenWith("\x1b[6 q")
    expect(screen.getCursorShape()).toBe("bar")
    expect(screen.getCursorBlinking()).toBe(false)
  })

  test("reset restores default cursor shape", () => {
    const screen = screenWith("\x1b[6 q")
    screen.reset()
    expect(screen.getCursorShape()).toBe("block")
    expect(screen.getCursorBlinking()).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════
// NEW: REP (repeat previous character)
// ═══════════════════════════════════════════════════════

describe("REP (CSI Ps b)", () => {
  test("repeats last character", () => {
    const screen = screenWith("X\x1b[3b")
    expect(screen.getCell(0, 0).char).toBe("X")
    expect(screen.getCell(0, 1).char).toBe("X")
    expect(screen.getCell(0, 2).char).toBe("X")
    expect(screen.getCell(0, 3).char).toBe("X")
    expect(screen.getCursorPosition().x).toBe(4)
  })

  test("repeats with default count of 1", () => {
    const screen = screenWith("A\x1b[b")
    expect(screen.getCell(0, 0).char).toBe("A")
    expect(screen.getCell(0, 1).char).toBe("A")
    expect(screen.getCursorPosition().x).toBe(2)
  })

  test("does nothing if no previous character", () => {
    const screen = screenWith("\x1b[3b")
    expect(screen.getCursorPosition().x).toBe(0)
  })

  test("preserves attributes of repeated character", () => {
    const screen = screenWith("\x1b[1mA\x1b[2b")
    expect(screen.getCell(0, 1).char).toBe("A")
    expect(screen.getCell(0, 1).bold).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════
// NEW: DA1 / DA2 responses
// ═══════════════════════════════════════════════════════

describe("DA1 / DA2 responses", () => {
  test("DA1 responds with device attributes", () => {
    const responses: string[] = []
    const screen = createVtermScreen({ onResponse: (d) => responses.push(d) })
    screen.process(enc.encode("\x1b[c"))
    expect(responses).toEqual(["\x1b[?62;4c"])
  })

  test("DA1 with explicit 0 param", () => {
    const responses: string[] = []
    const screen = createVtermScreen({ onResponse: (d) => responses.push(d) })
    screen.process(enc.encode("\x1b[0c"))
    expect(responses).toEqual(["\x1b[?62;4c"])
  })

  test("DA2 responds with secondary attributes", () => {
    const responses: string[] = []
    const screen = createVtermScreen({ onResponse: (d) => responses.push(d) })
    screen.process(enc.encode("\x1b[>c"))
    expect(responses).toEqual(["\x1b[>1;100;0c"])
  })

  test("no response without callback", () => {
    // Should not throw
    const screen = createVtermScreen()
    screen.process(enc.encode("\x1b[c"))
    screen.process(enc.encode("\x1b[>c"))
  })
})

// ═══════════════════════════════════════════════════════
// NEW: DSR (device status report)
// ═══════════════════════════════════════════════════════

describe("DSR (device status report)", () => {
  test("DSR 5 reports OK status", () => {
    const responses: string[] = []
    const screen = createVtermScreen({ onResponse: (d) => responses.push(d) })
    screen.process(enc.encode("\x1b[5n"))
    expect(responses).toEqual(["\x1b[0n"])
  })

  test("DSR 6 reports cursor position", () => {
    const responses: string[] = []
    const screen = createVtermScreen({ onResponse: (d) => responses.push(d) })
    screen.process(enc.encode("\x1b[5;10H")) // Move cursor to row 5, col 10
    screen.process(enc.encode("\x1b[6n"))
    expect(responses).toEqual(["\x1b[5;10R"])
  })

  test("DSR 6 at origin reports 1;1", () => {
    const responses: string[] = []
    const screen = createVtermScreen({ onResponse: (d) => responses.push(d) })
    screen.process(enc.encode("\x1b[6n"))
    expect(responses).toEqual(["\x1b[1;1R"])
  })
})

// ═══════════════════════════════════════════════════════
// NEW: DECRPM (mode reporting)
// ═══════════════════════════════════════════════════════

describe("DECRPM (mode reporting)", () => {
  test("reports autoWrap mode as set", () => {
    const responses: string[] = []
    const screen = createVtermScreen({ onResponse: (d) => responses.push(d) })
    screen.process(enc.encode("\x1b[?7$p"))
    expect(responses).toEqual(["\x1b[?7;1$y"]) // 1 = set
  })

  test("reports origin mode as reset", () => {
    const responses: string[] = []
    const screen = createVtermScreen({ onResponse: (d) => responses.push(d) })
    screen.process(enc.encode("\x1b[?6$p"))
    expect(responses).toEqual(["\x1b[?6;2$y"]) // 2 = reset
  })

  test("reports cursor visible as set", () => {
    const responses: string[] = []
    const screen = createVtermScreen({ onResponse: (d) => responses.push(d) })
    screen.process(enc.encode("\x1b[?25$p"))
    expect(responses).toEqual(["\x1b[?25;1$y"])
  })

  test("reports cursor visible after hide as reset", () => {
    const responses: string[] = []
    const screen = createVtermScreen({ onResponse: (d) => responses.push(d) })
    screen.process(enc.encode("\x1b[?25l")) // Hide cursor
    screen.process(enc.encode("\x1b[?25$p"))
    expect(responses).toEqual(["\x1b[?25;2$y"])
  })

  test("reports bracketed paste mode", () => {
    const responses: string[] = []
    const screen = createVtermScreen({ onResponse: (d) => responses.push(d) })
    screen.process(enc.encode("\x1b[?2004h")) // Enable bracketed paste
    screen.process(enc.encode("\x1b[?2004$p"))
    expect(responses).toEqual(["\x1b[?2004;1$y"])
  })

  test("reports synchronized output mode", () => {
    const responses: string[] = []
    const screen = createVtermScreen({ onResponse: (d) => responses.push(d) })
    screen.process(enc.encode("\x1b[?2026$p"))
    expect(responses).toEqual(["\x1b[?2026;2$y"]) // Not set by default
  })

  test("reports unknown mode as 0", () => {
    const responses: string[] = []
    const screen = createVtermScreen({ onResponse: (d) => responses.push(d) })
    screen.process(enc.encode("\x1b[?9999$p"))
    expect(responses).toEqual(["\x1b[?9999;0$y"])
  })
})

// ═══════════════════════════════════════════════════════
// NEW: OSC 8 (hyperlinks)
// ═══════════════════════════════════════════════════════

describe("OSC 8 hyperlinks", () => {
  test("sets hyperlink on cells (BEL terminated)", () => {
    const screen = screenWith("\x1b]8;;https://example.com\x07link\x1b]8;;\x07")
    expect(screen.getCell(0, 0).char).toBe("l")
    expect(screen.getCell(0, 0).url).toBe("https://example.com")
    expect(screen.getCell(0, 1).url).toBe("https://example.com")
    expect(screen.getCell(0, 3).url).toBe("https://example.com")
  })

  test("closing hyperlink sets url to null", () => {
    const screen = screenWith("\x1b]8;;https://example.com\x07AB\x1b]8;;\x07CD")
    expect(screen.getCell(0, 0).url).toBe("https://example.com")
    expect(screen.getCell(0, 1).url).toBe("https://example.com")
    expect(screen.getCell(0, 2).url).toBeNull()
    expect(screen.getCell(0, 3).url).toBeNull()
  })

  test("hyperlink with ST terminator", () => {
    const screen = screenWith("\x1b]8;;https://test.org\x1b\\text\x1b]8;;\x1b\\")
    expect(screen.getCell(0, 0).url).toBe("https://test.org")
    expect(screen.getCell(0, 3).url).toBe("https://test.org")
  })

  test("hyperlink with params", () => {
    const screen = screenWith("\x1b]8;id=foo;https://example.com\x07X\x1b]8;;\x07")
    expect(screen.getCell(0, 0).url).toBe("https://example.com")
  })

  test("reset clears hyperlink", () => {
    const screen = screenWith("\x1b]8;;https://example.com\x07X")
    screen.reset()
    screen.process(enc.encode("Y"))
    expect(screen.getCell(0, 0).url).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════
// NEW: DEC Special Graphics character set
// ═══════════════════════════════════════════════════════

describe("DEC Special Graphics character set", () => {
  test("ESC ( 0 activates line drawing", () => {
    const screen = screenWith("\x1b(0lqqk")
    expect(screen.getCell(0, 0).char).toBe("\u250c") // ┌
    expect(screen.getCell(0, 1).char).toBe("\u2500") // ─
    expect(screen.getCell(0, 2).char).toBe("\u2500") // ─
    expect(screen.getCell(0, 3).char).toBe("\u2510") // ┐
  })

  test("ESC ( B deactivates line drawing", () => {
    const screen = screenWith("\x1b(0q\x1b(Bq")
    expect(screen.getCell(0, 0).char).toBe("\u2500") // ─ (line drawing)
    expect(screen.getCell(0, 1).char).toBe("q") // Normal q
  })

  test("full box drawing", () => {
    const screen = screenWith("\x1b(0lqkxxx")
    expect(screen.getCell(0, 0).char).toBe("\u250c") // ┌
    expect(screen.getCell(0, 1).char).toBe("\u2500") // ─
    expect(screen.getCell(0, 2).char).toBe("\u2510") // ┐
    expect(screen.getCell(0, 3).char).toBe("\u2502") // │
  })

  test("vertical line character", () => {
    const screen = screenWith("\x1b(0x")
    expect(screen.getCell(0, 0).char).toBe("\u2502") // │
  })

  test("intersection character", () => {
    const screen = screenWith("\x1b(0n")
    expect(screen.getCell(0, 0).char).toBe("\u253c") // ┼
  })

  test("tee characters", () => {
    const screen = screenWith("\x1b(0tuvw")
    expect(screen.getCell(0, 0).char).toBe("\u251c") // ├
    expect(screen.getCell(0, 1).char).toBe("\u2524") // ┤
    expect(screen.getCell(0, 2).char).toBe("\u2534") // ┴
    expect(screen.getCell(0, 3).char).toBe("\u252c") // ┬
  })

  test("corner characters", () => {
    const screen = screenWith("\x1b(0jklm")
    expect(screen.getCell(0, 0).char).toBe("\u2518") // ┘
    expect(screen.getCell(0, 1).char).toBe("\u2510") // ┐
    expect(screen.getCell(0, 2).char).toBe("\u250c") // ┌
    expect(screen.getCell(0, 3).char).toBe("\u2514") // └
  })

  test("special symbols", () => {
    const screen = screenWith("\x1b(0afg")
    expect(screen.getCell(0, 0).char).toBe("\u2592") // ▒
    expect(screen.getCell(0, 1).char).toBe("\u00b0") // °
    expect(screen.getCell(0, 2).char).toBe("\u00b1") // ±
  })

  test("unmapped characters pass through", () => {
    const screen = screenWith("\x1b(0ABC")
    expect(screen.getCell(0, 0).char).toBe("A")
    expect(screen.getCell(0, 1).char).toBe("B")
    expect(screen.getCell(0, 2).char).toBe("C")
  })

  test("reset clears charset", () => {
    const screen = screenWith("\x1b(0")
    screen.reset()
    screen.process(enc.encode("q"))
    expect(screen.getCell(0, 0).char).toBe("q") // Normal q
  })
})

// ═══════════════════════════════════════════════════════
// NEW: DECSTR (soft terminal reset)
// ═══════════════════════════════════════════════════════

describe("DECSTR (soft terminal reset)", () => {
  test("resets insert mode", () => {
    const screen = screenWith("\x1b[4h") // Set insert mode (via non-DEC)
    // Actually, insert mode via DEC private:
    const screen2 = screenWith("\x1b[?4h")
    expect(screen2.getMode("insertMode")).toBe(true)
    screen2.process(enc.encode("\x1b[!p"))
    expect(screen2.getMode("insertMode")).toBe(false)
    void screen
  })

  test("resets origin mode", () => {
    const screen = screenWith("\x1b[?6h")
    expect(screen.getMode("originMode")).toBe(true)
    screen.process(enc.encode("\x1b[!p"))
    expect(screen.getMode("originMode")).toBe(false)
  })

  test("restores autowrap", () => {
    const screen = screenWith("\x1b[?7l") // Disable autowrap
    expect(screen.getMode("autoWrap")).toBe(false)
    screen.process(enc.encode("\x1b[!p"))
    expect(screen.getMode("autoWrap")).toBe(true)
  })

  test("restores cursor visibility", () => {
    const screen = screenWith("\x1b[?25l") // Hide cursor
    expect(screen.getCursorVisible()).toBe(false)
    screen.process(enc.encode("\x1b[!p"))
    expect(screen.getCursorVisible()).toBe(true)
  })

  test("resets cursor shape to blinking block", () => {
    const screen = screenWith("\x1b[6 q") // Steady bar
    expect(screen.getCursorShape()).toBe("bar")
    screen.process(enc.encode("\x1b[!p"))
    expect(screen.getCursorShape()).toBe("block")
    expect(screen.getCursorBlinking()).toBe(true)
  })

  test("resets attributes", () => {
    const screen = screenWith("\x1b[1;3;31mX\x1b[!p")
    screen.process(enc.encode("Y"))
    const cell = screen.getCell(0, 1)
    expect(cell.bold).toBe(false)
    expect(cell.italic).toBe(false)
    expect(cell.fg).toBeNull()
  })

  test("resets character set", () => {
    const screen = screenWith("\x1b(0\x1b[!p")
    screen.process(enc.encode("q"))
    expect(screen.getCell(0, 0).char).toBe("q") // Not line drawing
  })

  test("moves cursor to home", () => {
    const screen = screenWith("\x1b[10;20H\x1b[!p")
    expect(screen.getCursorPosition()).toEqual({ x: 0, y: 0 })
  })
})

// ═══════════════════════════════════════════════════════
// NEW: XTVERSION
// ═══════════════════════════════════════════════════════

describe("XTVERSION", () => {
  test("responds with version string", () => {
    const responses: string[] = []
    const screen = createVtermScreen({ onResponse: (d) => responses.push(d) })
    screen.process(enc.encode("\x1b[>0q"))
    expect(responses).toEqual(["\x1bP>|vterm.js 0.1.0\x1b\\"])
  })

  test("responds to bare >q", () => {
    const responses: string[] = []
    const screen = createVtermScreen({ onResponse: (d) => responses.push(d) })
    screen.process(enc.encode("\x1b[>q"))
    expect(responses).toEqual(["\x1bP>|vterm.js 0.1.0\x1b\\"])
  })
})

// ═══════════════════════════════════════════════════════
// NEW: Synchronized output (mode 2026)
// ═══════════════════════════════════════════════════════

describe("synchronized output (mode 2026)", () => {
  test("off by default", () => {
    const screen = createVtermScreen()
    expect(screen.getMode("syncOutput")).toBe(false)
  })

  test("can be enabled", () => {
    const screen = screenWith("\x1b[?2026h")
    expect(screen.getMode("syncOutput")).toBe(true)
  })

  test("can be disabled", () => {
    const screen = screenWith("\x1b[?2026h\x1b[?2026l")
    expect(screen.getMode("syncOutput")).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════
// NEW: SGR mouse (mode 1006)
// ═══════════════════════════════════════════════════════

describe("SGR mouse mode (1006)", () => {
  test("off by default", () => {
    const screen = createVtermScreen()
    expect(screen.getMode("sgrMouse")).toBe(false)
  })

  test("can be enabled", () => {
    const screen = screenWith("\x1b[?1006h")
    expect(screen.getMode("sgrMouse")).toBe(true)
  })

  test("can be disabled", () => {
    const screen = screenWith("\x1b[?1006h\x1b[?1006l")
    expect(screen.getMode("sgrMouse")).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════
// NEW: Mouse tracking modes
// ═══════════════════════════════════════════════════════

describe("mouse tracking modes", () => {
  test("1000 basic tracking", () => {
    const screen = screenWith("\x1b[?1000h")
    expect(screen.getMode("mouseTracking")).toBe(true)
  })

  test("1002 button tracking", () => {
    const screen = screenWith("\x1b[?1002h")
    expect(screen.getMode("mouseTracking")).toBe(true)
  })

  test("1003 all-motion tracking", () => {
    const screen = screenWith("\x1b[?1003h")
    expect(screen.getMode("mouseTracking")).toBe(true)
  })

  test("disabling mouse tracking", () => {
    const screen = screenWith("\x1b[?1000h\x1b[?1000l")
    expect(screen.getMode("mouseTracking")).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════
// OSC title
// ═══════════════════════════════════════════════════════

describe("OSC title", () => {
  test("OSC 0 sets title (BEL)", () => {
    const screen = screenWith("\x1b]0;My Title\x07")
    expect(screen.getTitle()).toBe("My Title")
  })

  test("OSC 2 sets title (BEL)", () => {
    const screen = screenWith("\x1b]2;Window Title\x07")
    expect(screen.getTitle()).toBe("Window Title")
  })

  test("OSC 0 sets title (ST)", () => {
    const screen = screenWith("\x1b]0;My Title\x1b\\")
    expect(screen.getTitle()).toBe("My Title")
  })
})

// ═══════════════════════════════════════════════════════
// NEW: OSC 10/11 (color queries)
// ═══════════════════════════════════════════════════════

describe("OSC 10/11 color queries", () => {
  test("OSC 10 responds with foreground color", () => {
    const responses: string[] = []
    const screen = createVtermScreen({ onResponse: (d) => responses.push(d) })
    screen.process(enc.encode("\x1b]10;?\x07"))
    expect(responses).toEqual(["\x1b]10;rgb:ffff/ffff/ffff\x1b\\"])
  })

  test("OSC 11 responds with background color", () => {
    const responses: string[] = []
    const screen = createVtermScreen({ onResponse: (d) => responses.push(d) })
    screen.process(enc.encode("\x1b]11;?\x07"))
    expect(responses).toEqual(["\x1b]11;rgb:0000/0000/0000\x1b\\"])
  })
})

// ═══════════════════════════════════════════════════════
// NEW: OSC 52 (clipboard)
// ═══════════════════════════════════════════════════════

describe("OSC 52 clipboard", () => {
  test("stores clipboard content", () => {
    const responses: string[] = []
    const screen = createVtermScreen({ onResponse: (d) => responses.push(d) })
    const base64 = btoa("hello world")
    screen.process(enc.encode(`\x1b]52;c;${base64}\x07`))
    expect(responses.length).toBe(1)
    expect(responses[0]).toContain(base64)
  })

  test("queries clipboard content", () => {
    const responses: string[] = []
    const screen = createVtermScreen({ onResponse: (d) => responses.push(d) })
    const base64 = btoa("test data")
    screen.process(enc.encode(`\x1b]52;c;${base64}\x07`))
    responses.length = 0 // Clear the set response
    screen.process(enc.encode("\x1b]52;c;?\x07"))
    expect(responses.length).toBe(1)
    expect(responses[0]).toContain(base64)
  })
})

// ═══════════════════════════════════════════════════════
// Scroll operations
// ═══════════════════════════════════════════════════════

describe("scroll operations", () => {
  test("SU scrolls up", () => {
    const screen = createVtermScreen({ cols: 10, rows: 3 })
    screen.process(enc.encode("line1\r\nline2\r\nline3"))
    screen.process(enc.encode("\x1b[S")) // Scroll up 1
    expect(screen.getCell(0, 0).char).toBe("l") // line2
    expect(screen.getCell(0, 4).char).toBe("2")
  })

  test("SD scrolls down", () => {
    const screen = createVtermScreen({ cols: 10, rows: 3 })
    screen.process(enc.encode("line1\r\nline2\r\nline3"))
    screen.process(enc.encode("\x1b[T")) // Scroll down 1
    expect(screen.getCell(0, 0).char).toBe("") // New empty row
    expect(screen.getCell(1, 0).char).toBe("l") // line1
  })

  test("IND scrolls at bottom", () => {
    const screen = createVtermScreen({ cols: 10, rows: 3 })
    screen.process(enc.encode("line1\r\nline2\r\nline3"))
    screen.process(enc.encode("\x1bD")) // IND
    expect(screen.getCell(0, 4).char).toBe("2") // line2 moved up
  })

  test("RI scrolls at top", () => {
    const screen = createVtermScreen({ cols: 10, rows: 3 })
    screen.process(enc.encode("line1\r\nline2\r\nline3"))
    screen.process(enc.encode("\x1b[H")) // Move to top
    screen.process(enc.encode("\x1bM")) // RI - Reverse Index
    expect(screen.getCell(0, 0).char).toBe("") // New empty row
    expect(screen.getCell(1, 0).char).toBe("l") // line1
  })

  test("DECSTBM sets scroll region", () => {
    const screen = createVtermScreen({ cols: 10, rows: 5 })
    screen.process(enc.encode("\x1b[2;4r")) // Scroll region rows 2-4
    // Cursor should be at home after DECSTBM
    expect(screen.getCursorPosition()).toEqual({ x: 0, y: 0 })
  })
})

// ═══════════════════════════════════════════════════════
// Editing operations
// ═══════════════════════════════════════════════════════

describe("editing operations", () => {
  test("ICH inserts blank characters", () => {
    const screen = createVtermScreen({ cols: 10, rows: 3 })
    screen.process(enc.encode("1234567890"))
    screen.process(enc.encode("\x1b[1;3H")) // col 3
    screen.process(enc.encode("\x1b[2@")) // Insert 2 blanks
    expect(screen.getCell(0, 0).char).toBe("1")
    expect(screen.getCell(0, 1).char).toBe("2")
    expect(screen.getCell(0, 2).char).toBe("") // inserted blank
    expect(screen.getCell(0, 3).char).toBe("") // inserted blank
    expect(screen.getCell(0, 4).char).toBe("3")
  })

  test("DCH deletes characters", () => {
    const screen = createVtermScreen({ cols: 10, rows: 3 })
    screen.process(enc.encode("1234567890"))
    screen.process(enc.encode("\x1b[1;3H")) // col 3
    screen.process(enc.encode("\x1b[2P")) // Delete 2
    expect(screen.getCell(0, 2).char).toBe("5")
    expect(screen.getCell(0, 3).char).toBe("6")
  })

  test("IL inserts lines", () => {
    const screen = createVtermScreen({ cols: 10, rows: 3 })
    screen.process(enc.encode("AAA\r\nBBB\r\nCCC"))
    screen.process(enc.encode("\x1b[2;1H")) // Row 2
    screen.process(enc.encode("\x1b[1L")) // Insert 1 line
    expect(screen.getCell(0, 0).char).toBe("A")
    expect(screen.getCell(1, 0).char).toBe("") // Inserted line
    expect(screen.getCell(2, 0).char).toBe("B")
  })

  test("DL deletes lines", () => {
    const screen = createVtermScreen({ cols: 10, rows: 3 })
    screen.process(enc.encode("AAA\r\nBBB\r\nCCC"))
    screen.process(enc.encode("\x1b[2;1H")) // Row 2
    screen.process(enc.encode("\x1b[1M")) // Delete 1 line
    expect(screen.getCell(0, 0).char).toBe("A")
    expect(screen.getCell(1, 0).char).toBe("C") // CCC moved up
    expect(screen.getCell(2, 0).char).toBe("") // New empty row
  })
})

// ═══════════════════════════════════════════════════════
// Mode management
// ═══════════════════════════════════════════════════════

describe("mode management", () => {
  test("alternate screen", () => {
    const screen = screenWith("hello\x1b[?1049h")
    expect(screen.getMode("altScreen")).toBe(true)
    expect(screen.getCell(0, 0).char).toBe("") // Alt screen is blank
    screen.process(enc.encode("\x1b[?1049l"))
    expect(screen.getMode("altScreen")).toBe(false)
    expect(screen.getCell(0, 0).char).toBe("h") // Original content restored
  })

  test("cursor visible toggle", () => {
    const screen = screenWith("\x1b[?25l")
    expect(screen.getCursorVisible()).toBe(false)
    screen.process(enc.encode("\x1b[?25h"))
    expect(screen.getCursorVisible()).toBe(true)
  })

  test("bracketed paste", () => {
    const screen = screenWith("\x1b[?2004h")
    expect(screen.getMode("bracketedPaste")).toBe(true)
  })

  test("application cursor", () => {
    const screen = screenWith("\x1b[?1h")
    expect(screen.getMode("applicationCursor")).toBe(true)
  })

  test("reverse video", () => {
    const screen = screenWith("\x1b[?5h")
    expect(screen.getMode("reverseVideo")).toBe(true)
  })

  test("focus tracking", () => {
    const screen = screenWith("\x1b[?1004h")
    expect(screen.getMode("focusTracking")).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════
// DECSC / DECRC (save/restore cursor)
// ═══════════════════════════════════════════════════════

describe("DECSC / DECRC", () => {
  test("saves and restores cursor position", () => {
    const screen = screenWith("\x1b[5;10H\x1b7\x1b[1;1H\x1b8")
    expect(screen.getCursorPosition()).toEqual({ x: 9, y: 4 })
  })

  test("saves and restores attributes", () => {
    const screen = createVtermScreen()
    screen.process(enc.encode("\x1b[1;31m\x1b7")) // Bold red, save
    screen.process(enc.encode("\x1b[0m")) // Reset
    screen.process(enc.encode("\x1b8X")) // Restore + write
    const cell = screen.getCell(4, 9) // Restored to position from save
    // Actually the restore puts cursor at saved pos (0,0 initially)
    // Let's test differently
    const screen2 = createVtermScreen()
    screen2.process(enc.encode("\x1b[1;31m\x1b7")) // Bold red at (0,0), save
    screen2.process(enc.encode("\x1b[0m")) // Reset attrs
    screen2.process(enc.encode("Y")) // Write with no attrs
    screen2.process(enc.encode("\x1b8X")) // Restore, now at (0,0) with bold red
    const cell2 = screen2.getCell(0, 0)
    expect(cell2.char).toBe("X")
    expect(cell2.bold).toBe(true)
    expect(cell2.fg).toEqual({ r: 0x80, g: 0, b: 0 })
  })
})

// ═══════════════════════════════════════════════════════
// NEL
// ═══════════════════════════════════════════════════════

describe("NEL (Next Line)", () => {
  test("moves to start of next line", () => {
    const screen = screenWith("hello\x1bE")
    expect(screen.getCursorPosition()).toEqual({ x: 0, y: 1 })
  })
})

// ═══════════════════════════════════════════════════════
// Wide characters
// ═══════════════════════════════════════════════════════

describe("wide characters", () => {
  test("CJK character takes 2 columns", () => {
    const screen = screenWith("\u4e16") // 世
    expect(screen.getCell(0, 0).char).toBe("\u4e16")
    expect(screen.getCell(0, 0).wide).toBe(true)
    expect(screen.getCursorPosition().x).toBe(2)
  })
})

// ═══════════════════════════════════════════════════════
// Scrollback
// ═══════════════════════════════════════════════════════

describe("scrollback", () => {
  test("lines scroll into scrollback", () => {
    const screen = createVtermScreen({ cols: 10, rows: 3, scrollbackLimit: 100 })
    screen.process(enc.encode("line1\r\nline2\r\nline3\r\nline4"))
    expect(screen.getScrollbackLength()).toBe(1) // line1 scrolled off
  })

  test("viewport scrolling", () => {
    const screen = createVtermScreen({ cols: 10, rows: 3, scrollbackLimit: 100 })
    screen.process(enc.encode("line1\r\nline2\r\nline3\r\nline4"))
    screen.scrollViewport(1)
    expect(screen.getViewportOffset()).toBe(1)
    screen.scrollViewport(-1)
    expect(screen.getViewportOffset()).toBe(0)
  })

  test("OSC 720 scrolls viewport up into scrollback", () => {
    const screen = createVtermScreen({ cols: 10, rows: 3, scrollbackLimit: 100 })
    screen.process(enc.encode("line1\r\nline2\r\nline3\r\nline4"))

    screen.process(enc.encode("\x1b]720\x07"))

    expect(screen.getViewportOffset()).toBe(1)
  })
})

// ═══════════════════════════════════════════════════════
// getText / getTextRange
// ═══════════════════════════════════════════════════════

describe("getText", () => {
  test("returns screen content", () => {
    const screen = createVtermScreen({ cols: 10, rows: 3 })
    screen.process(enc.encode("hello"))
    const text = screen.getText()
    const firstLine = text.split("\n")[0]
    expect(firstLine).toBe("hello")
  })

  test("getTextRange extracts range", () => {
    const screen = createVtermScreen({ cols: 10, rows: 3 })
    screen.process(enc.encode("hello world"))
    const range = screen.getTextRange(0, 0, 0, 5)
    expect(range).toBe("hello")
  })
})

// ═══════════════════════════════════════════════════════
// DCS handling
// ═══════════════════════════════════════════════════════

describe("DCS handling", () => {
  test("consumes DCS sequences without crashing", () => {
    const screen = createVtermScreen()
    screen.process(enc.encode("\x1bPsome data\x1b\\"))
    // Should not crash and return to ground state
    screen.process(enc.encode("X"))
    expect(screen.getCell(0, 0).char).toBe("X")
  })
})

// ═══════════════════════════════════════════════════════
// RIS (full reset)
// ═══════════════════════════════════════════════════════

describe("RIS (ESC c)", () => {
  test("resets everything", () => {
    const screen = createVtermScreen()
    screen.process(enc.encode("hello\x1b[?1049h\x1b[1;31m"))
    screen.process(enc.encode("\x1bc")) // Full reset
    expect(screen.getCursorPosition()).toEqual({ x: 0, y: 0 })
    expect(screen.getMode("altScreen")).toBe(false)
    expect(screen.getTitle()).toBe("")
  })
})

// ═══════════════════════════════════════════════════════
// Insert mode
// ═══════════════════════════════════════════════════════

describe("insert mode", () => {
  test("insert mode shifts characters right", () => {
    const screen = createVtermScreen({ cols: 10, rows: 3 })
    screen.process(enc.encode("1234"))
    screen.process(enc.encode("\x1b[?4h")) // Enable insert mode
    screen.process(enc.encode("\x1b[1;1H")) // Go to start
    screen.process(enc.encode("AB"))
    expect(screen.getCell(0, 0).char).toBe("A")
    expect(screen.getCell(0, 1).char).toBe("B")
    expect(screen.getCell(0, 2).char).toBe("1")
    expect(screen.getCell(0, 3).char).toBe("2")
  })
})

// ═══════════════════════════════════════════════════════
// Combined attributes test
// ═══════════════════════════════════════════════════════

describe("combined SGR attributes", () => {
  test("all new attributes together", () => {
    // Bold + Blink + Overline + Underline with color
    const screen = screenWith("\x1b[1;5;53;4m\x1b[58;2;255;0;128mX")
    const cell = screen.getCell(0, 0)
    expect(cell.bold).toBe(true)
    expect(cell.blink).toBe(true)
    expect(cell.overline).toBe(true)
    expect(cell.underline).toBe("single")
    expect(cell.underlineColor).toEqual({ r: 255, g: 0, b: 128 })
  })

  test("all attributes clear on reset", () => {
    const screen = screenWith("\x1b[1;2;3;4;5;7;8;9;53m\x1b[58;2;1;2;3mX\x1b[0mY")
    const y = screen.getCell(0, 1)
    expect(y.bold).toBe(false)
    expect(y.faint).toBe(false)
    expect(y.italic).toBe(false)
    expect(y.underline).toBe("none")
    expect(y.blink).toBe(false)
    expect(y.inverse).toBe(false)
    expect(y.hidden).toBe(false)
    expect(y.strikethrough).toBe(false)
    expect(y.overline).toBe(false)
    expect(y.underlineColor).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════
// SCP / RCP (save/restore cursor position via CSI s/u)
// ═══════════════════════════════════════════════════════

describe("SCP/RCP", () => {
  test("saves and restores cursor position", () => {
    const screen = screenWith("\x1b[5;10H\x1b[s\x1b[1;1H\x1b[u")
    expect(screen.getCursorPosition()).toEqual({ x: 9, y: 4 })
  })
})

// ═══════════════════════════════════════════════════════
// Resize
// ═══════════════════════════════════════════════════════

describe("resize", () => {
  test("preserves content on resize", () => {
    const screen = createVtermScreen({ cols: 10, rows: 3 })
    screen.process(enc.encode("hello"))
    screen.resize(20, 5)
    expect(screen.getCell(0, 0).char).toBe("h")
    expect(screen.getCell(0, 4).char).toBe("o")
  })

  test("clamps cursor on shrink", () => {
    const screen = createVtermScreen({ cols: 20, rows: 10 })
    screen.process(enc.encode("\x1b[8;15H")) // Row 8, Col 15
    screen.resize(10, 5)
    expect(screen.getCursorPosition().x).toBeLessThan(10)
    expect(screen.getCursorPosition().y).toBeLessThan(5)
  })
})

// ═══════════════════════════════════════════════════════
// Semantic Prompts (OSC 133)
// ═══════════════════════════════════════════════════════

describe("semantic prompts (OSC 133)", () => {
  test("OSC 133 semantic prompt markers", () => {
    const screen = createVtermScreen({ cols: 80, rows: 24 })
    screen.process(enc.encode("\x1b]133;A\x07$ \x1b]133;B\x07ls\n\x1b]133;C\x07file1 file2\n\x1b]133;D;0\x07"))
    const zones = screen.getSemanticZones()
    expect(zones.length).toBeGreaterThan(0)
    expect(zones[0]!.type).toBe("prompt")
  })

  test("records all zone types", () => {
    const screen = createVtermScreen({ cols: 80, rows: 24 })
    screen.process(enc.encode("\x1b]133;A\x07$ \x1b]133;B\x07ls\n\x1b]133;C\x07output\n\x1b]133;D;0\x07"))
    const zones = screen.getSemanticZones()
    expect(zones).toHaveLength(3) // A=prompt, B=command, C=output (D is end, not stored)
    expect(zones[0]!.type).toBe("prompt")
    expect(zones[1]!.type).toBe("command")
    expect(zones[2]!.type).toBe("output")
  })

  test("records cursor position at marker", () => {
    const screen = createVtermScreen({ cols: 80, rows: 24 })
    screen.process(enc.encode("hello\r\n"))
    screen.process(enc.encode("\x1b]133;A\x07"))
    const zones = screen.getSemanticZones()
    expect(zones).toHaveLength(1)
    expect(zones[0]!.startRow).toBe(1)
    expect(zones[0]!.startCol).toBe(0)
  })

  test("zones cleared on reset", () => {
    const screen = createVtermScreen({ cols: 80, rows: 24 })
    screen.process(enc.encode("\x1b]133;A\x07$ \x1b]133;B\x07"))
    expect(screen.getSemanticZones().length).toBeGreaterThan(0)
    screen.reset()
    expect(screen.getSemanticZones()).toHaveLength(0)
  })

  test("OSC 133 with ST terminator", () => {
    const screen = createVtermScreen({ cols: 80, rows: 24 })
    screen.process(enc.encode("\x1b]133;A\x1b\\prompt\x1b]133;B\x1b\\"))
    const zones = screen.getSemanticZones()
    expect(zones).toHaveLength(2)
    expect(zones[0]!.type).toBe("prompt")
    expect(zones[1]!.type).toBe("command")
  })
})

// ═══════════════════════════════════════════════════════
// Text Reflow on Resize
// ═══════════════════════════════════════════════════════

describe("text reflow", () => {
  test("same-size resize is a no-op: deferred autowrap survives", () => {
    // zsh's PROMPT_SP writes exactly `cols` cells and relies on the deferred
    // wrap keeping the cursor on the row; an attach hello often re-sends the
    // unchanged geometry. Reflowing here clamps the past-the-end cursor back
    // into the row, so the next byte OVERWRITES the last cell instead of
    // wrapping (xterm treats a same-size resize as a no-op and preserves it).
    const screen = createVtermScreen({ cols: 10, rows: 4 })
    screen.process(enc.encode("AAAAAAAAAA")) // fills row 0 exactly; wrap pending
    screen.resize(10, 4)
    screen.process(enc.encode("B"))
    expect(screen.getCell(0, 9).char).toBe("A")
    expect(screen.getCell(1, 0).char).toBe("B")
    expect(screen.getCursor()).toEqual({ col: 1, row: 1 })
  })

  test("text reflows when terminal widens", () => {
    const screen = createVtermScreen({ cols: 10, rows: 5 })
    screen.process(enc.encode("abcdefghij")) // fills row 0 exactly, soft-wraps
    screen.process(enc.encode("klmno"))
    screen.resize(20, 5)
    // "abcdefghijklmno" should be on one line now
    expect(screen.getCell(0, 14).char).toBe("o")
  })

  test("text reflows when terminal narrows", () => {
    const screen = createVtermScreen({ cols: 20, rows: 5 })
    screen.process(enc.encode("abcdefghijklmno"))
    screen.resize(10, 5)
    // Should wrap to two lines
    expect(screen.getCell(1, 0).char).toBe("k")
  })

  test("hard line breaks preserved during reflow", () => {
    const screen = createVtermScreen({ cols: 10, rows: 5 })
    screen.process(enc.encode("hello\r\nworld"))
    screen.resize(20, 5)
    // "hello" and "world" should still be on separate lines
    expect(screen.getCell(0, 0).char).toBe("h")
    expect(screen.getCell(1, 0).char).toBe("w")
  })

  test("multiple soft-wrapped lines unwrap correctly", () => {
    const screen = createVtermScreen({ cols: 5, rows: 10 })
    // Write 15 chars — should fill 3 rows via soft-wrap
    screen.process(enc.encode("abcdefghijklmno"))
    expect(screen.getCell(0, 0).char).toBe("a")
    expect(screen.getCell(1, 0).char).toBe("f")
    expect(screen.getCell(2, 0).char).toBe("k")
    // Widen to 15 — all should fit on one line
    screen.resize(15, 10)
    expect(screen.getCell(0, 0).char).toBe("a")
    expect(screen.getCell(0, 14).char).toBe("o")
    expect(screen.getCell(1, 0).char).toBe("")
  })

  test("mixed hard and soft breaks reflow correctly", () => {
    const screen = createVtermScreen({ cols: 5, rows: 10 })
    // "abcde" fills row 0, soft-wraps, "fg" on row 1, then hard break (CR+LF), "hi" on row 2
    screen.process(enc.encode("abcdefg\r\nhi"))
    expect(screen.getCell(0, 0).char).toBe("a")
    expect(screen.getCell(1, 0).char).toBe("f")
    expect(screen.getCell(2, 0).char).toBe("h")
    // Widen — soft-wrap should unwrap, hard break stays
    screen.resize(10, 10)
    expect(screen.getCell(0, 0).char).toBe("a")
    expect(screen.getCell(0, 5).char).toBe("f")
    expect(screen.getCell(0, 6).char).toBe("g")
    expect(screen.getCell(1, 0).char).toBe("h")
    expect(screen.getCell(1, 1).char).toBe("i")
  })

  test("narrowing then widening round-trips", () => {
    const screen = createVtermScreen({ cols: 20, rows: 5 })
    screen.process(enc.encode("abcdefghijklmno"))
    screen.resize(5, 5)
    // Should be on 3 rows
    expect(screen.getCell(0, 0).char).toBe("a")
    expect(screen.getCell(1, 0).char).toBe("f")
    expect(screen.getCell(2, 0).char).toBe("k")
    // Widen back
    screen.resize(20, 5)
    expect(screen.getCell(0, 0).char).toBe("a")
    expect(screen.getCell(0, 14).char).toBe("o")
  })

  test("cursor follows its logical line through widening reflow", () => {
    const screen = createVtermScreen({ cols: 10, rows: 6 })
    screen.process(enc.encode("abcdefghijklmno")) // soft-wraps rows 0-1
    screen.process(enc.encode("\r\n> ")) // prompt on its own hard line
    expect(screen.getCursor()).toEqual({ col: 2, row: 2 })
    screen.resize(20, 6) // packs the wrapped line into row 0; prompt moves to row 1
    expect(screen.getCell(1, 0).char).toBe(">")
    // The cursor must move WITH its logical line, not stay at its old row.
    expect(screen.getCursor()).toEqual({ col: 2, row: 1 })
  })

  test("output after widening reflow continues adjacent to content (no blank band)", () => {
    // The recorded-session shape behind the journal differential divergence:
    // wrapped output, in-stream widen, more output. The post-resize output
    // must land directly under the packed content — not at the cursor's old
    // absolute row, which leaves a blank band where the wraps used to be.
    const screen = createVtermScreen({ cols: 10, rows: 8 })
    screen.process(enc.encode("abcdefghijklmno\r\n")) // rows 0-1 + cursor on row 2
    screen.resize(20, 8)
    screen.process(enc.encode("next"))
    expect(screen.getCell(1, 0).char).toBe("n")
    expect(screen.getCell(2, 0).char).toBe("")
  })

  test("cursor follows its logical line when narrowing splits it", () => {
    const screen = createVtermScreen({ cols: 20, rows: 8 })
    screen.process(enc.encode("abcdefghijklmno")) // one row, cursor at col 15
    screen.resize(10, 8) // splits into rows 0-1
    expect(screen.getCell(1, 0).char).toBe("k")
    expect(screen.getCursor()).toEqual({ col: 5, row: 1 })
  })

  test("cursor on a blank line below content survives widening reflow", () => {
    const screen = createVtermScreen({ cols: 10, rows: 6 })
    screen.process(enc.encode("abcdefghijkl\r\n")) // rows 0-1 wrapped, cursor row 2 col 0
    screen.resize(20, 6) // content packs to row 0
    expect(screen.getCursor()).toEqual({ col: 0, row: 1 })
  })
})

// ═══════════════════════════════════════════════════════
// Kitty keyboard protocol
// ═══════════════════════════════════════════════════════

describe("kitty keyboard protocol", () => {
  test("CSI > 1 u enables kitty keyboard", () => {
    const screen = createVtermScreen({ cols: 80, rows: 24 })
    screen.process(enc.encode("\x1b[>1u"))
    expect(screen.getMode("kittyKeyboard")).toBe(true)
  })

  test("CSI < u disables kitty keyboard", () => {
    const screen = createVtermScreen({ cols: 80, rows: 24 })
    screen.process(enc.encode("\x1b[>1u"))
    screen.process(enc.encode("\x1b[<u"))
    expect(screen.getMode("kittyKeyboard")).toBe(false)
  })

  test("push/pop stack works", () => {
    const screen = createVtermScreen({ cols: 80, rows: 24 })
    screen.process(enc.encode("\x1b[>1u")) // push 1
    screen.process(enc.encode("\x1b[>3u")) // push 3
    screen.process(enc.encode("\x1b[<u")) // pop → back to 1
    expect(screen.getMode("kittyKeyboard")).toBe(true)
    screen.process(enc.encode("\x1b[<u")) // pop → back to 0
    expect(screen.getMode("kittyKeyboard")).toBe(false)
  })

  test("CSI = flags ; mode u sets flags without touching the stack", () => {
    const screen = createVtermScreen({ cols: 80, rows: 24 })
    screen.process(enc.encode("\x1b[=5u")) // mode defaults to 1 (assign)
    expect(screen.snapshot().modes.kittyKeyboardFlags).toBe(5)
    expect(screen.snapshot().modes.kittyKeyboardStack).toEqual([])
    screen.process(enc.encode("\x1b[=3;2u")) // mode 2: OR the given flags in
    expect(screen.snapshot().modes.kittyKeyboardFlags).toBe(7)
    screen.process(enc.encode("\x1b[=1;3u")) // mode 3: clear the given flags
    expect(screen.snapshot().modes.kittyKeyboardFlags).toBe(6)
    expect(screen.snapshot().modes.kittyKeyboardStack).toEqual([])
  })

  test("CSI ? u queries keyboard mode", () => {
    let response = ""
    const screen = createVtermScreen({
      cols: 80,
      rows: 24,
      onResponse: (d) => {
        response += d
      },
    })
    screen.process(enc.encode("\x1b[>5u"))
    screen.process(enc.encode("\x1b[?u"))
    expect(response).toContain("?5u")
  })

  test("reset clears kitty keyboard", () => {
    const screen = createVtermScreen({ cols: 80, rows: 24 })
    screen.process(enc.encode("\x1b[>1u"))
    screen.reset()
    expect(screen.getMode("kittyKeyboard")).toBe(false)
  })
})

describe("kitty graphics protocol", () => {
  test("accepts kitty graphics APC sequence", () => {
    const screen = createVtermScreen({ cols: 80, rows: 24 })
    // Minimal kitty graphics: transmit a 1x1 red pixel
    screen.process(enc.encode("\x1b_Gf=32,s=1,v=1,a=T;/w==\x1b\\"))
    expect(screen.getMode("kittyGraphics")).toBe(true)
  })

  test("responds to kitty graphics query", () => {
    let response = ""
    const screen = createVtermScreen({
      cols: 80,
      rows: 24,
      onResponse: (d) => {
        response += d
      },
    })
    screen.process(enc.encode("\x1b_Gi=1,a=q;\x1b\\"))
    expect(response).toContain("OK")
  })

  test("kitty graphics doesn't break parser", () => {
    const screen = createVtermScreen({ cols: 80, rows: 24 })
    screen.process(enc.encode("\x1b_Gf=32,s=1,v=1;AAAA\x1b\\Hello"))
    expect(screen.getCell(0, 0).char).toBe("H")
  })

  test("BEL-terminated kitty graphics", () => {
    const screen = createVtermScreen({ cols: 80, rows: 24 })
    screen.process(enc.encode("\x1b_Gf=32,a=T;data\x07"))
    expect(screen.getMode("kittyGraphics")).toBe(true)
  })

  test("query response includes image id", () => {
    let response = ""
    const screen = createVtermScreen({
      cols: 80,
      rows: 24,
      onResponse: (d) => {
        response += d
      },
    })
    screen.process(enc.encode("\x1b_Gi=42,a=q;\x1b\\"))
    expect(response).toBe("\x1b_Gi=42;OK\x1b\\")
  })

  test("reset clears kitty graphics flag", () => {
    const screen = createVtermScreen({ cols: 80, rows: 24 })
    screen.process(enc.encode("\x1b_Gf=32,a=T;data\x1b\\"))
    expect(screen.getMode("kittyGraphics")).toBe(true)
    screen.reset()
    expect(screen.getMode("kittyGraphics")).toBe(false)
  })

  test("non-graphics APC is ignored", () => {
    const screen = createVtermScreen({ cols: 80, rows: 24 })
    screen.process(enc.encode("\x1b_Xsome-data\x1b\\"))
    expect(screen.getMode("kittyGraphics")).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════
// Unicode width handling
// ═══════════════════════════════════════════════════════

describe("unicode width", () => {
  test("emoji with VS-16 is wide", () => {
    const screen = createVtermScreen({ cols: 20, rows: 5 })
    screen.process(enc.encode("A\u2764\ufe0fB")) // A❤️B — heart with VS-16
    expect(screen.getCell(0, 1).wide).toBe(true)
    expect(screen.getCell(0, 3).char).toBe("B") // B at col 3 (A=1, ❤️=2)
  })

  test("regional indicator flags are wide", () => {
    const screen = createVtermScreen({ cols: 20, rows: 5 })
    screen.process(enc.encode("\ud83c\uddfa\ud83c\uddf8X")) // 🇺🇸X
    expect(screen.getCell(0, 0).wide).toBe(true)
    expect(screen.getCell(0, 0).char).toBe("\ud83c\uddfa\ud83c\uddf8") // Combined flag
    expect(screen.getCell(0, 2).char).toBe("X")
  })

  test("ZWJ emoji sequence occupies 2 cells", () => {
    const screen = createVtermScreen({ cols: 20, rows: 5 })
    // 👨‍👩‍👧 = U+1F468 U+200D U+1F469 U+200D U+1F467
    screen.process(enc.encode("\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67X"))
    // The ZWJ sequence should be in cell 0 (wide), X at col 2
    expect(screen.getCell(0, 0).wide).toBe(true)
    expect(screen.getCell(0, 2).char).toBe("X")
  })

  test("combining characters are zero-width", () => {
    const screen = createVtermScreen({ cols: 20, rows: 5 })
    screen.process(enc.encode("e\u0301X")) // é (e + combining acute) + X
    expect(screen.getCell(0, 0).char).toBe("e\u0301") // Combined in one cell
    expect(screen.getCell(0, 1).char).toBe("X") // X at col 1, not 2
  })

  test("emoji modifier (skin tone) appends to previous cell", () => {
    const screen = createVtermScreen({ cols: 20, rows: 5 })
    // 👋🏽 = U+1F44B U+1F3FD (wave + medium skin tone)
    screen.process(enc.encode("\ud83d\udc4b\ud83c\udffcX"))
    expect(screen.getCell(0, 0).wide).toBe(true)
    expect(screen.getCell(0, 0).char).toContain("\ud83d\udc4b") // wave emoji
    expect(screen.getCell(0, 2).char).toBe("X")
  })

  test("basic emoji without VS-16 are already wide", () => {
    const screen = createVtermScreen({ cols: 20, rows: 5 })
    // 😀 = U+1F600 — in the Misc Symbols/Emoticons range
    screen.process(enc.encode("\ud83d\ude00X"))
    expect(screen.getCell(0, 0).wide).toBe(true)
    expect(screen.getCell(0, 2).char).toBe("X")
  })

  test("multiple flags in sequence", () => {
    const screen = createVtermScreen({ cols: 20, rows: 5 })
    // 🇺🇸🇬🇧 = two flags, each width 2
    screen.process(enc.encode("\ud83c\uddfa\ud83c\uddf8\ud83c\uddec\ud83c\udde7X"))
    expect(screen.getCell(0, 0).wide).toBe(true) // US flag
    expect(screen.getCell(0, 2).wide).toBe(true) // GB flag
    expect(screen.getCell(0, 4).char).toBe("X")
  })

  test("CJK characters remain wide", () => {
    const screen = createVtermScreen({ cols: 20, rows: 5 })
    screen.process(enc.encode("A\u4e16X")) // A + 世 + X
    expect(screen.getCell(0, 1).wide).toBe(true)
    expect(screen.getCell(0, 3).char).toBe("X")
  })

  test("ZWJ sequence: man + ZWJ + woman + ZWJ + girl", () => {
    const screen = createVtermScreen({ cols: 20, rows: 5 })
    // Full family emoji ZWJ sequence
    const family = "\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67"
    screen.process(enc.encode(family + "A"))
    // The entire ZWJ sequence should be in one cell at col 0
    const cell = screen.getCell(0, 0)
    expect(cell.wide).toBe(true)
    // Next printable character should be at col 2
    expect(screen.getCell(0, 2).char).toBe("A")
  })

  test("heart with VS-16 between text", () => {
    const screen = createVtermScreen({ cols: 20, rows: 5 })
    screen.process(enc.encode("I\u2764\ufe0fU")) // I❤️U
    expect(screen.getCell(0, 0).char).toBe("I")
    expect(screen.getCell(0, 1).wide).toBe(true) // heart widened by VS-16
    expect(screen.getCell(0, 3).char).toBe("U")
  })

  test("combining diacritical marks on multiple characters", () => {
    const screen = createVtermScreen({ cols: 20, rows: 5 })
    screen.process(enc.encode("n\u0303a\u0301l")) // ñál
    expect(screen.getCell(0, 0).char).toBe("n\u0303") // n with tilde
    expect(screen.getCell(0, 1).char).toBe("a\u0301") // a with acute
    expect(screen.getCell(0, 2).char).toBe("l")
  })

  test("unpaired regional indicator renders as wide", () => {
    const screen = createVtermScreen({ cols: 20, rows: 5 })
    // Single RI followed by non-RI should flush the pending RI
    screen.process(enc.encode("\ud83c\uddfaX"))
    // The RI should have been flushed and rendered
    expect(screen.getCell(0, 0).wide).toBe(true)
    expect(screen.getCell(0, 2).char).toBe("X")
  })
})

// ═══════════════════════════════════════════════════════
// Sixel graphics
// ═══════════════════════════════════════════════════════

describe("sixel graphics", () => {
  test("accepts sixel DCS sequence terminated with ST", () => {
    const screen = createVtermScreen({ cols: 80, rows: 24 })
    // Simple sixel: DCS q data ST
    screen.process(enc.encode("\x1bPq#0;2;0;0;0!10~-!10~\x1b\\"))
    expect(screen.getMode("sixel")).toBe(true)
  })

  test("accepts sixel DCS sequence terminated with BEL", () => {
    const screen = createVtermScreen({ cols: 80, rows: 24 })
    screen.process(enc.encode("\x1bPq#0;2;0;0;0!10~\x07"))
    expect(screen.getMode("sixel")).toBe(true)
  })

  test("sixel with params", () => {
    const screen = createVtermScreen({ cols: 80, rows: 24 })
    // DCS 0;1;0 q data ST
    screen.process(enc.encode("\x1bP0;1;0q#0;2;100;0;0!10~\x1b\\"))
    expect(screen.getMode("sixel")).toBe(true)
  })

  test("sixel doesn't break parser state", () => {
    const screen = createVtermScreen({ cols: 80, rows: 24 })
    screen.process(enc.encode("\x1bPq!10~\x1b\\Hello"))
    expect(screen.getCell(0, 0).char).toBe("H")
    expect(screen.getCell(0, 1).char).toBe("e")
    expect(screen.getCell(0, 4).char).toBe("o")
  })

  test("sixel mode is false when no sixel received", () => {
    const screen = createVtermScreen({ cols: 80, rows: 24 })
    screen.process(enc.encode("Hello"))
    expect(screen.getMode("sixel")).toBe(false)
  })

  test("getSixelImages returns stored sixel data", () => {
    const screen = createVtermScreen({ cols: 80, rows: 24 })
    screen.process(enc.encode("\x1bPq#0;2;0;0;0!10~\x1b\\"))
    const images = screen.getSixelImages()
    expect(images).toHaveLength(1)
    expect(images[0]!.data).toBe("#0;2;0;0;0!10~")
    expect(images[0]!.row).toBe(0)
    expect(images[0]!.col).toBe(0)
  })

  test("getSixelImages records cursor position at DCS start", () => {
    const screen = createVtermScreen({ cols: 80, rows: 24 })
    // Move cursor to row 5, col 10, then send sixel
    screen.process(enc.encode("\x1b[6;11H\x1bPq!10~\x1b\\"))
    const images = screen.getSixelImages()
    expect(images).toHaveLength(1)
    expect(images[0]!.row).toBe(5)
    expect(images[0]!.col).toBe(10)
  })

  test("multiple sixel images are tracked", () => {
    const screen = createVtermScreen({ cols: 80, rows: 24 })
    screen.process(enc.encode("\x1bPqAAA\x1b\\\x1bPqBBB\x1b\\"))
    const images = screen.getSixelImages()
    expect(images).toHaveLength(2)
    expect(images[0]!.data).toBe("AAA")
    expect(images[1]!.data).toBe("BBB")
  })

  test("sixel state resets on full reset", () => {
    const screen = createVtermScreen({ cols: 80, rows: 24 })
    screen.process(enc.encode("\x1bPq!10~\x1b\\"))
    expect(screen.getMode("sixel")).toBe(true)
    expect(screen.getSixelImages()).toHaveLength(1)
    screen.reset()
    expect(screen.getMode("sixel")).toBe(false)
    expect(screen.getSixelImages()).toHaveLength(0)
  })

  test("non-sixel DCS doesn't set sixel mode", () => {
    const screen = createVtermScreen({ cols: 80, rows: 24 })
    // Some other DCS sequence (not ending with q introducer)
    screen.process(enc.encode("\x1bP+p544F505F434F4C4F5253\x1b\\"))
    expect(screen.getMode("sixel")).toBe(false)
    expect(screen.getSixelImages()).toHaveLength(0)
  })

  test("sixel with empty data", () => {
    const screen = createVtermScreen({ cols: 80, rows: 24 })
    // DCS q ST (no sixel data)
    screen.process(enc.encode("\x1bPq\x1b\\"))
    expect(screen.getMode("sixel")).toBe(true)
    const images = screen.getSixelImages()
    expect(images).toHaveLength(1)
    expect(images[0]!.data).toBe("")
  })
})

// ═══════════════════════════════════════════════════════
// DECLRMM — Left/Right Margin Mode (DECSET ?69)
// ═══════════════════════════════════════════════════════

describe("DECLRMM — left/right margins", () => {
  test("mode flag is off by default", () => {
    const screen = createVtermScreen()
    expect(screen.getMode("leftRightMargin")).toBe(false)
  })

  test("DECSET ?69 enables left/right margin mode", () => {
    const screen = createVtermScreen()
    screen.process(enc.encode("\x1b[?69h"))
    expect(screen.getMode("leftRightMargin")).toBe(true)
  })

  test("DECRST ?69 disables left/right margin mode", () => {
    const screen = createVtermScreen()
    screen.process(enc.encode("\x1b[?69h"))
    screen.process(enc.encode("\x1b[?69l"))
    expect(screen.getMode("leftRightMargin")).toBe(false)
  })

  test("DECRPM reports mode 69", () => {
    const responses: string[] = []
    const screen = createVtermScreen({ onResponse: (r) => responses.push(r) })
    // Query mode 69 (should be off = 2)
    screen.process(enc.encode("\x1b[?69$p"))
    expect(responses[0]).toBe("\x1b[?69;2$y")
    // Enable and query again
    screen.process(enc.encode("\x1b[?69h"))
    screen.process(enc.encode("\x1b[?69$p"))
    expect(responses[1]).toBe("\x1b[?69;1$y")
  })

  test("DECSLRM sets left and right margins when mode enabled", () => {
    // 20-col screen, set margins to columns 5-15 (1-based)
    const screen = createVtermScreen({ cols: 20, rows: 5 })
    screen.process(enc.encode("\x1b[?69h")) // Enable DECLRMM
    screen.process(enc.encode("\x1b[5;15s")) // DECSLRM: left=5, right=15

    // Write text that should wrap at the right margin (col 14, 0-based)
    // Cursor starts at 0,0 after DECSLRM
    screen.process(enc.encode("\x1b[1;5H")) // Move cursor to row 1, col 5 (1-based)
    screen.process(enc.encode("ABCDEFGHIJKLMNO")) // 15 chars, should wrap at col 14

    // First 11 chars fit in cols 4..14 (0-based), then wrap
    const line0 = screen.getLine(0)
    expect(line0[4]!.char).toBe("A")
    expect(line0[14]!.char).toBe("K")
    // After wrapping, cursor goes to leftMargin (col 4) on next row
    const line1 = screen.getLine(1)
    expect(line1[4]!.char).toBe("L")
  })

  test("CSI s is save-cursor when DECLRMM is off", () => {
    const screen = createVtermScreen({ cols: 20, rows: 5 })
    screen.process(enc.encode("ABC"))
    // CSI s should save cursor (not DECSLRM)
    screen.process(enc.encode("\x1b[s"))
    screen.process(enc.encode("DEF"))
    // CSI u should restore cursor
    screen.process(enc.encode("\x1b[u"))
    expect(screen.getCursorPosition()).toEqual({ x: 3, y: 0 })
  })

  test("erase in line respects left/right margins", () => {
    const screen = createVtermScreen({ cols: 20, rows: 5 })
    // Write text across the full line
    screen.process(enc.encode("01234567890123456789"))
    // Enable margins
    screen.process(enc.encode("\x1b[?69h"))
    screen.process(enc.encode("\x1b[5;15s")) // margins at cols 5-15 (1-based)
    // Move cursor to col 10 (1-based) and erase to end of line
    screen.process(enc.encode("\x1b[1;10H"))
    screen.process(enc.encode("\x1b[0K")) // EL 0 — erase cursor to end (within right margin)

    const line = screen.getLine(0)
    // Cols 0-3 should still have original text
    expect(line[0]!.char).toBe("0")
    expect(line[3]!.char).toBe("3")
    // Col 9 (cursor was at 1-based 10) should be cleared
    expect(line[9]!.char).toBe("")
    // Cols within margins should be cleared
    expect(line[14]!.char).toBe("")
    // Cols outside right margin should retain original content
    expect(line[15]!.char).toBe("5")
    expect(line[19]!.char).toBe("9")
  })

  test("scroll up within margins only moves margin columns", () => {
    const screen = createVtermScreen({ cols: 10, rows: 5 })
    // Set up content
    screen.process(enc.encode("0123456789"))
    screen.process(enc.encode("ABCDEFGHIJ"))
    screen.process(enc.encode("KLMNOPQRST"))
    // Enable margins cols 3-7 (1-based)
    screen.process(enc.encode("\x1b[?69h"))
    screen.process(enc.encode("\x1b[3;7s"))
    // Set scroll region rows 1-3 (1-based)
    screen.process(enc.encode("\x1b[1;3r"))
    // Scroll up
    screen.process(enc.encode("\x1b[S"))

    // Row 0: cols outside margins should keep original content
    const line0 = screen.getLine(0)
    expect(line0[0]!.char).toBe("0")
    expect(line0[1]!.char).toBe("1")
    // Cols 2-6 (0-based) should have shifted up from row 1
    expect(line0[2]!.char).toBe("C")
    expect(line0[6]!.char).toBe("G")
    // Cols outside right margin keep original
    expect(line0[7]!.char).toBe("7")
  })

  test("scroll down within margins only moves margin columns", () => {
    const screen = createVtermScreen({ cols: 10, rows: 5 })
    // Set up content
    screen.process(enc.encode("0123456789"))
    screen.process(enc.encode("ABCDEFGHIJ"))
    screen.process(enc.encode("KLMNOPQRST"))
    // Enable margins cols 3-7 (1-based)
    screen.process(enc.encode("\x1b[?69h"))
    screen.process(enc.encode("\x1b[3;7s"))
    // Set scroll region rows 1-3 (1-based)
    screen.process(enc.encode("\x1b[1;3r"))
    // Scroll down
    screen.process(enc.encode("\x1b[T"))

    // Row 0: within margins should be blank (scrolled in)
    const line0 = screen.getLine(0)
    expect(line0[0]!.char).toBe("0")
    expect(line0[1]!.char).toBe("1")
    expect(line0[2]!.char).toBe("") // Blank from scroll
    expect(line0[6]!.char).toBe("") // Blank from scroll
    expect(line0[7]!.char).toBe("7")
  })

  test("insert chars works within margins", () => {
    const screen = createVtermScreen({ cols: 10, rows: 3 })
    screen.process(enc.encode("ABCDEFGHIJ"))
    // Enable margins
    screen.process(enc.encode("\x1b[?69h"))
    screen.process(enc.encode("\x1b[3;8s")) // margins at cols 3-8 (1-based)
    // Move cursor to col 5 (1-based) row 1 and insert a char
    screen.process(enc.encode("\x1b[1;5H"))
    screen.process(enc.encode("\x1b[@")) // ICH — insert 1 character

    const line = screen.getLine(0)
    // Col 0-1 unchanged
    expect(line[0]!.char).toBe("A")
    expect(line[1]!.char).toBe("B")
    // Col 4 (where cursor was) should be blank (inserted)
    expect(line[4]!.char).toBe("")
    // Col 5 should be what was at col 4 (shifted right)
    expect(line[5]!.char).toBe("E")
    // Cols outside right margin should be unchanged
    expect(line[8]!.char).toBe("I")
    expect(line[9]!.char).toBe("J")
  })

  test("delete chars works within margins", () => {
    const screen = createVtermScreen({ cols: 10, rows: 3 })
    screen.process(enc.encode("ABCDEFGHIJ"))
    // Enable margins
    screen.process(enc.encode("\x1b[?69h"))
    screen.process(enc.encode("\x1b[3;8s")) // margins at cols 3-8 (1-based)
    // Move cursor to col 4 (1-based) row 1 and delete a char
    screen.process(enc.encode("\x1b[1;4H"))
    screen.process(enc.encode("\x1b[P")) // DCH — delete 1 character

    const line = screen.getLine(0)
    // Col 0-1 unchanged
    expect(line[0]!.char).toBe("A")
    expect(line[1]!.char).toBe("B")
    // Col 3 (where cursor was) should now have what was at col 4
    expect(line[3]!.char).toBe("E")
    // Right margin position should be blank (shifted in)
    expect(line[7]!.char).toBe("")
    // Outside right margin should be unchanged
    expect(line[8]!.char).toBe("I")
    expect(line[9]!.char).toBe("J")
  })

  test("reset clears left/right margin state", () => {
    const screen = createVtermScreen()
    screen.process(enc.encode("\x1b[?69h"))
    expect(screen.getMode("leftRightMargin")).toBe(true)
    screen.reset()
    expect(screen.getMode("leftRightMargin")).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════
// Color Scheme Reporting (Mode 2031)
// ═══════════════════════════════════════════════════════

describe("color scheme reporting (mode 2031)", () => {
  test("mode flag is off by default", () => {
    const screen = createVtermScreen()
    expect(screen.getMode("colorSchemeReporting")).toBe(false)
  })

  test("DECSET ?2031 enables color scheme reporting", () => {
    const screen = createVtermScreen()
    screen.process(enc.encode("\x1b[?2031h"))
    expect(screen.getMode("colorSchemeReporting")).toBe(true)
  })

  test("DECRST ?2031 disables color scheme reporting", () => {
    const screen = createVtermScreen()
    screen.process(enc.encode("\x1b[?2031h"))
    screen.process(enc.encode("\x1b[?2031l"))
    expect(screen.getMode("colorSchemeReporting")).toBe(false)
  })

  test("DECRPM reports mode 2031", () => {
    const responses: string[] = []
    const screen = createVtermScreen({ onResponse: (r) => responses.push(r) })
    // Query when off
    screen.process(enc.encode("\x1b[?2031$p"))
    expect(responses[0]).toBe("\x1b[?2031;2$y")
    // Enable and query
    screen.process(enc.encode("\x1b[?2031h"))
    screen.process(enc.encode("\x1b[?2031$p"))
    expect(responses[1]).toBe("\x1b[?2031;1$y")
  })

  test("DSR 997 responds with dark color scheme", () => {
    const responses: string[] = []
    const screen = createVtermScreen({ onResponse: (r) => responses.push(r) })
    // CSI ? 997 n — query color scheme
    screen.process(enc.encode("\x1b[?997n"))
    expect(responses[0]).toBe("\x1b[?997;1n") // 1 = dark
  })

  test("reset clears color scheme reporting", () => {
    const screen = createVtermScreen()
    screen.process(enc.encode("\x1b[?2031h"))
    expect(screen.getMode("colorSchemeReporting")).toBe(true)
    screen.reset()
    expect(screen.getMode("colorSchemeReporting")).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════
// OSC 66 — Text Sizing
// ═══════════════════════════════════════════════════════

describe("OSC 66 — text sizing", () => {
  test("query responds with default scale", () => {
    const responses: string[] = []
    const screen = createVtermScreen({ onResponse: (r) => responses.push(r) })
    screen.process(enc.encode("\x1b]66;?\x1b\\"))
    expect(responses[0]).toBe("\x1b]66;s=1\x1b\\")
  })

  test("set scale and query it back", () => {
    const responses: string[] = []
    const screen = createVtermScreen({ onResponse: (r) => responses.push(r) })
    // Set scale to 2
    screen.process(enc.encode("\x1b]66;s=2\x1b\\"))
    // Query
    screen.process(enc.encode("\x1b]66;?\x1b\\"))
    expect(responses[0]).toBe("\x1b]66;s=2\x1b\\")
  })

  test("set scale with BEL terminator", () => {
    const responses: string[] = []
    const screen = createVtermScreen({ onResponse: (r) => responses.push(r) })
    screen.process(enc.encode("\x1b]66;s=3\x07"))
    screen.process(enc.encode("\x1b]66;?\x07"))
    expect(responses[0]).toBe("\x1b]66;s=3\x1b\\")
  })

  test("reset restores default scale", () => {
    const responses: string[] = []
    const screen = createVtermScreen({ onResponse: (r) => responses.push(r) })
    screen.process(enc.encode("\x1b]66;s=5\x1b\\"))
    screen.reset()
    screen.process(enc.encode("\x1b]66;?\x1b\\"))
    expect(responses[0]).toBe("\x1b]66;s=1\x1b\\")
  })
})

// ═══════════════════════════════════════════════════════
// Mintty/rxvt-unicode query OSCs
// ═══════════════════════════════════════════════════════

describe("OSC 7770/7777 — mintty font size queries", () => {
  test("OSC 7770 query responds with restorable font size", () => {
    const responses: string[] = []
    const screen = createVtermScreen({ onResponse: (r) => responses.push(r) })
    screen.process(enc.encode("\x1b]7770;?\x07"))
    expect(responses[0]).toBe("\x1b]7770;12\x1b\\")
  })

  test("OSC 7777 query responds with restorable font/window zoom size", () => {
    const responses: string[] = []
    const screen = createVtermScreen({ onResponse: (r) => responses.push(r) })
    screen.process(enc.encode("\x1b]7777;?\x07"))
    expect(responses[0]).toBe("\x1b]7777;12\x1b\\")
  })
})

describe("OSC 701/702/776 — rxvt-unicode queries", () => {
  test("OSC 701 locale set/query round-trips", () => {
    const responses: string[] = []
    const screen = createVtermScreen({ onResponse: (r) => responses.push(r) })
    screen.process(enc.encode("\x1b]701;en_GB.UTF-8\x07\x1b]701;?\x07"))
    expect(responses[0]).toBe("\x1b]701;en_GB.UTF-8\x1b\\")
  })

  test("OSC 702 reports a version tuple", () => {
    const responses: string[] = []
    const screen = createVtermScreen({ onResponse: (r) => responses.push(r) })
    screen.process(enc.encode("\x1b]702\x07"))
    expect(responses[0]).toBe("\x1b]702;vterm.js;vterm;0;2\x1b\\")
  })

  test("OSC 776 reports cell metrics", () => {
    const responses: string[] = []
    const screen = createVtermScreen({ onResponse: (r) => responses.push(r) })
    screen.process(enc.encode("\x1b]776\x07"))
    expect(responses[0]).toBe("\x1b]776;8;17;14\x1b\\")
  })
})

// ═══════════════════════════════════════════════════════
// OSC 5522 — Advanced Clipboard (Kitty protocol)
// ═══════════════════════════════════════════════════════

describe("OSC 5522 — advanced clipboard", () => {
  test("store and query clipboard data", () => {
    const responses: string[] = []
    const screen = createVtermScreen({ onResponse: (r) => responses.push(r) })
    // Store "hello" (base64: aGVsbG8=)
    screen.process(enc.encode("\x1b]5522;aGVsbG8=\x1b\\"))
    // Query
    screen.process(enc.encode("\x1b]5522;?\x1b\\"))
    expect(responses[0]).toBe("\x1b]5522;aGVsbG8=\x1b\\")
  })

  test("query empty clipboard", () => {
    const responses: string[] = []
    const screen = createVtermScreen({ onResponse: (r) => responses.push(r) })
    screen.process(enc.encode("\x1b]5522;?\x1b\\"))
    // btoa("") === ""
    expect(responses[0]).toBe("\x1b]5522;\x1b\\")
  })

  test("store with BEL terminator", () => {
    const responses: string[] = []
    const screen = createVtermScreen({ onResponse: (r) => responses.push(r) })
    // Store "test" (base64: dGVzdA==)
    screen.process(enc.encode("\x1b]5522;dGVzdA==\x07"))
    // Query
    screen.process(enc.encode("\x1b]5522;?\x07"))
    expect(responses[0]).toBe("\x1b]5522;dGVzdA==\x1b\\")
  })

  test("reset clears advanced clipboard", () => {
    const responses: string[] = []
    const screen = createVtermScreen({ onResponse: (r) => responses.push(r) })
    screen.process(enc.encode("\x1b]5522;aGVsbG8=\x1b\\"))
    screen.reset()
    screen.process(enc.encode("\x1b]5522;?\x1b\\"))
    expect(responses[0]).toBe("\x1b]5522;\x1b\\")
  })
})

// ═══════════════════════════════════════════════════════
// Snapshot / restore
// ═══════════════════════════════════════════════════════

function expectRestoredSnapshot(snapshot: VtermScreenSnapshot): void {
  const restored = createVtermScreen()
  restored.restore(snapshot)
  expect(restored.snapshot()).toEqual(snapshot)
}

describe("snapshot / restore", () => {
  test("round-trips the deferred-autowrap cursor (past-the-end position)", () => {
    // The checkpoint/resume shape of the PROMPT_SP class: a full-width write
    // leaves the cursor past the last column with the wrap pending. restore()
    // must not clamp that to the last column, or the first byte written by
    // the resumed session overwrites the final cell instead of wrapping.
    const source = createVtermScreen({ cols: 10, rows: 4 })
    source.process(enc.encode("AAAAAAAAAA")) // fills row 0 exactly; wrap pending
    const restored = createVtermScreen({ cols: 10, rows: 4 })
    restored.restore(source.snapshot())
    expect(restored.getCursor()).toEqual({ col: 10, row: 0 })
    restored.process(enc.encode("B"))
    expect(restored.getCell(0, 9).char).toBe("A")
    expect(restored.getCell(1, 0).char).toBe("B")
  })

  test("round-trips T0-T3 screen state", () => {
    const screen = createVtermScreen({ cols: 8, rows: 3, scrollbackLimit: 20 })
    screen.process(enc.encode("\x1b]0;session-title\x07"))
    screen.process(enc.encode("\x1b]7;file://localhost/tmp/project\x07"))
    screen.process(enc.encode("\x1b[38;2;1;2;3mone\r\ntwo\r\nthree\r\nfour\r\nfive\r\nsix"))
    screen.process(enc.encode("\x1b[?25l\x1b[6 q\x1b[?6h\x1b[?7l\x1b[4h\x1b[?69h\x1b[2;6s"))
    screen.process(enc.encode("\x1b[?1049hALT\x1b[2;3H"))

    const snapshot = screen.snapshot()

    expect(snapshot.version).toBe(1)
    expect(snapshot.title).toBe("session-title")
    expect(snapshot.cwd).toBe("file://localhost/tmp/project")
    expect(snapshot.cursor.shape).toBe("bar")
    expect(snapshot.cursor.visible).toBe(false)
    expect(snapshot.modes.origin).toBe(true)
    expect(snapshot.modes.autoWrap).toBe(false)
    expect(snapshot.modes.insert).toBe(true)
    expect(snapshot.margins.leftRight).toBe(true)
    expect(snapshot.activeBuffer).toBe("alt")
    expect(snapshot.scrollback.length).toBeGreaterThan(0)

    expectRestoredSnapshot(snapshot)

    screen.process(enc.encode("mutate-source-after-snapshot"))
    expectRestoredSnapshot(snapshot)
  })

  test("has a stable top-level schema", () => {
    const snapshot = createVtermScreen({ cols: 2, rows: 1 }).snapshot()
    expect(Object.keys(snapshot).sort()).toEqual([
      "activeBuffer",
      "alt",
      "attrs",
      "clipboard",
      "colors",
      "cols",
      "cursor",
      "cwd",
      "main",
      "margins",
      "modes",
      "notifications",
      "parser",
      "rows",
      "savedState",
      "scrollback",
      "scrollbackLimit",
      "scrollbackSoftWrapped",
      "tabStops",
      "title",
      "unicode",
      "version",
      "viewportOffset",
    ])
    expect(snapshot.parser).toEqual({
      state: "ground",
      esc: "",
      osc: "",
      dcs: "",
      dcsStart: { row: 0, col: 0 },
      apc: "",
      utf8PendingBytes: [],
    })
  })

  test("rejects unsupported snapshot versions", () => {
    const screen = createVtermScreen()
    const snapshot = screen.snapshot()

    expect(() => {
      screen.restore({ ...snapshot, version: 999 } as unknown as VtermScreenSnapshot)
    }).toThrow(/Unsupported vterm snapshot version/)
  })

  test("rejects malformed snapshots without mutating the current screen", () => {
    const target = screenWith("target", { cols: 6, rows: 2 })
    const before = target.snapshot()
    const donor = screenWith("donor", { cols: 8, rows: 3 }).snapshot()
    const malformed = { ...donor, colors: undefined } as unknown as VtermScreenSnapshot

    expect(() => {
      target.restore(malformed)
    }).toThrow(/Invalid vterm snapshot colors/)
    expect(target.snapshot()).toEqual(before)
  })

  test("resumes CSI, OSC, DCS, and UTF-8 parser cut points", () => {
    const csi = createVtermScreen({ cols: 4, rows: 1 })
    csi.process(enc.encode("\x1b[31"))
    const csiRestored = createVtermScreen({ cols: 4, rows: 1 })
    csiRestored.restore(csi.snapshot())
    csiRestored.process(enc.encode("mR"))
    const csiFresh = screenWith("\x1b[31mR", { cols: 4, rows: 1 })
    expect(csiRestored.snapshot()).toEqual(csiFresh.snapshot())

    const osc = createVtermScreen()
    osc.process(enc.encode("\x1b]0;half"))
    const oscRestored = createVtermScreen()
    oscRestored.restore(osc.snapshot())
    oscRestored.process(enc.encode(" title\x07"))
    expect(oscRestored.getTitle()).toBe("half title")

    const responses: string[] = []
    const dcs = createVtermScreen()
    dcs.process(enc.encode("\x1bP+q54"))
    const dcsRestored = createVtermScreen({ onResponse: (r) => responses.push(r) })
    dcsRestored.restore(dcs.snapshot())
    dcsRestored.process(enc.encode("4e\x1b\\"))
    expect(responses).toEqual(["\x1bP1+r544e=767465726d\x1b\\"])

    const utf8 = createVtermScreen({ cols: 2, rows: 1 })
    utf8.process(new Uint8Array([0xe2]))
    const utf8Restored = createVtermScreen({ cols: 2, rows: 1 })
    utf8Restored.restore(utf8.snapshot())
    utf8Restored.process(new Uint8Array([0x82, 0xac]))
    expect(utf8Restored.getCell(0, 0).char).toBe("€")
  })

  test("restored snapshots resize deterministically", () => {
    const source = createVtermScreen({ cols: 5, rows: 5 })
    source.process(enc.encode("abcdefghijklmno"))
    source.resize(10, 5)

    const restored = createVtermScreen()
    restored.restore(source.snapshot())
    restored.resize(5, 5)

    const fresh = createVtermScreen({ cols: 5, rows: 5 })
    fresh.process(enc.encode("abcdefghijklmno"))
    fresh.resize(10, 5)
    fresh.resize(5, 5)

    expect(restored.snapshot()).toEqual(fresh.snapshot())
  })

  test("split feed through snapshot matches uninterrupted feed", () => {
    const chunks = [
      enc.encode("alpha\r\n"),
      enc.encode("\x1b[?25l\x1b[38;5;196m"),
      new Uint8Array([0xf0, 0x9f]),
      new Uint8Array([0x8c, 0x8a]),
      enc.encode("\x1b[?1049hALT\x1b[?1049lomega"),
    ]
    const split = createVtermScreen({ cols: 10, rows: 4, scrollbackLimit: 20 })
    const uninterrupted = createVtermScreen({ cols: 10, rows: 4, scrollbackLimit: 20 })

    for (const chunk of chunks) uninterrupted.process(chunk)
    split.process(chunks[0]!)
    split.process(chunks[1]!)
    split.process(chunks[2]!)

    const restored = createVtermScreen()
    restored.restore(split.snapshot())
    for (const chunk of chunks.slice(3)) restored.process(chunk)

    expect(restored.snapshot()).toEqual(uninterrupted.snapshot())
  })
})

describe("getScrollbackText", () => {
  test("returns scrolled-off rows oldest-first, rendered like getText", () => {
    const screen = screenWith("a\r\nb\r\nc\r\nd\r\ne", { cols: 10, rows: 3 })
    expect(screen.getScrollbackText()).toBe("a\nb")
    expect(screen.getText()).toBe("c\nd\ne")
  })

  test("is empty with no scrollback and survives snapshot round-trip", () => {
    const fresh = screenWith("only", { cols: 10, rows: 3 })
    expect(fresh.getScrollbackText()).toBe("")

    const scrolled = screenWith("1\r\n2\r\n3\r\n4\r\n5", { cols: 10, rows: 3 })
    const restored = createVtermScreen({ cols: 10, rows: 3 })
    restored.restore(scrolled.snapshot())
    expect(restored.getScrollbackText()).toBe(scrolled.getScrollbackText())
  })
})

describe("ECH background color erase", () => {
  test("ECH erases with the current background (BCE), matching EL/ED", () => {
    const screen = createVtermScreen({ cols: 10, rows: 2 })
    const feed = (s: string) => screen.process(new TextEncoder().encode(s))
    feed("abcdef")
    feed("\x1b[1;2H") // cursor over "b"
    feed("\x1b[48;2;10;20;30m\x1b[3X") // erase b,c,d with blue-ish bg
    for (const col of [1, 2, 3]) {
      const cell = screen.getCell(0, col)
      expect(cell.char).toBe("")
      expect(cell.bg).toEqual({ r: 10, g: 20, b: 30 })
    }
    expect(screen.getCell(0, 0).char).toBe("a")
    expect(screen.getCell(0, 4).char).toBe("e")
    expect(screen.getCell(0, 4).bg).toBeNull()
  })
})
