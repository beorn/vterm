import { describe, test, expect } from "vitest"
import { createVtermScreen } from "../src/index.ts"

const enc = new TextEncoder()

/** Helper: create a screen and process a string */
function screenWith(input: string, opts?: Parameters<typeof createVtermScreen>[0]) {
  const screen = createVtermScreen(opts)
  screen.process(enc.encode(input))
  return screen
}

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
