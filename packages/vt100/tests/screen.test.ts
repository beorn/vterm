import { describe, test, expect, vi } from "vitest"
import { createVt100Screen, type Vt100Screen } from "../src/index.ts"

/** Helper: create a screen and return it with convenience methods matching test patterns. */
function createScreen(opts: {
  cols: number
  rows: number
  scrollbackLimit?: number
  onResponse?: (data: string) => void
}): {
  screen: Vt100Screen
  feed: (data: Uint8Array) => void
  getText: () => string
  getCell: (row: number, col: number) => ReturnType<Vt100Screen["getCell"]>
  getLine: (row: number) => ReturnType<Vt100Screen["getLine"]>
  getLines: () => ReturnType<Vt100Screen["getLine"]>[]
  getCursor: () => { x: number; y: number; visible: boolean; style: string }
  getMode: (mode: string) => boolean
  getTitle: () => string
  getTextRange: (sr: number, sc: number, er: number, ec: number) => string
  getScrollback: () => { viewportOffset: number; totalLines: number; screenLines: number }
  scrollViewport: (delta: number) => void
  resize: (cols: number, rows: number) => void
  reset: () => void
} {
  const screen = createVt100Screen(opts)
  return {
    screen,
    feed: (data: Uint8Array) => screen.process(data),
    getText: () => screen.getText(),
    getCell: (row: number, col: number) => screen.getCell(row, col),
    getLine: (row: number) => screen.getLine(row),
    getLines: () => {
      const result = []
      for (let row = 0; row < screen.rows; row++) {
        result.push(screen.getLine(row))
      }
      return result
    },
    getCursor: () => ({
      ...screen.getCursorPosition(),
      visible: screen.getCursorVisible(),
      style: "block",
    }),
    getMode: (mode: string) => screen.getMode(mode),
    getTitle: () => screen.getTitle(),
    getTextRange: (sr: number, sc: number, er: number, ec: number) => screen.getTextRange(sr, sc, er, ec),
    getScrollback: () => {
      const scrollbackLength = screen.getScrollbackLength()
      const relativeOffset = screen.getViewportOffset()
      return {
        viewportOffset: scrollbackLength - relativeOffset,
        totalLines: scrollbackLength + screen.rows,
        screenLines: screen.rows,
      }
    },
    scrollViewport: (delta: number) => screen.scrollViewport(delta),
    resize: (cols: number, rows: number) => screen.resize(cols, rows),
    reset: () => screen.reset(),
  }
}

describe("Vt100Screen", () => {
  // ── Lifecycle ──

  test("creates screen with specified dimensions", () => {
    const s = createScreen({ cols: 80, rows: 24 })
    const cursor = s.getCursor()
    expect(cursor.x).toBe(0)
    expect(cursor.y).toBe(0)
    const text = s.getText()
    expect(text).toBeDefined()
  })

  test("creates screen with custom cols/rows", () => {
    const s = createScreen({ cols: 120, rows: 40 })
    const scrollback = s.getScrollback()
    expect(scrollback.screenLines).toBe(40)
  })

  // ── Text I/O ──

  // Designation bytes are parser input even when charset translation is unavailable.
  test.each(["(", ")"])("consumes ESC %s charset designations across chunks", (bank) => {
    for (const designation of ["0", "B"]) {
      const s = createScreen({ cols: 8, rows: 2 })
      const encoder = new TextEncoder()
      s.feed(encoder.encode("A"))
      s.feed(encoder.encode(`\x1b${bank}`))
      expect(s.getCursor().x).toBe(1)
      s.feed(encoder.encode(designation))
      expect(s.getCursor().x).toBe(1)
      s.feed(encoder.encode("Z"))
      expect([s.getCell(0, 0).char, s.getCell(0, 1).char]).toEqual(["A", "Z"])
      expect(s.getCursor().x).toBe(2)
      s.feed(encoder.encode(`\x1b${bank}\x1b[1mQ`))
      expect(s.getCell(0, 2)).toMatchObject({ char: "Q", bold: true })
      expect(s.getCursor().x).toBe(3)
    }
  })

  // A decoded supplementary scalar must not become two surrogate-half cells.
  test.each([0, 1, 2, 3])("preserves a supplementary scalar with UTF-8 split at byte %i", (split) => {
    const s = createScreen({ cols: 8, rows: 2 })
    const bytes = new TextEncoder().encode("🌍")
    if (split > 0) {
      s.feed(bytes.subarray(0, split))
      expect(s.getCursor().x).toBe(0)
    }
    s.feed(bytes.subarray(split))
    s.feed(new TextEncoder().encode("X"))
    expect(s.getCell(0, 0).char).toBe("🌍")
    expect(s.getCell(0, 1).char).toBe("X")
    expect(s.getCursor().x).toBe(2)
  })

  test("feed plain text, getText() returns it", () => {
    const s = createScreen({ cols: 80, rows: 24 })
    s.feed(new TextEncoder().encode("hello world"))
    const text = s.getText()
    expect(text).toContain("hello world")
  })

  test("feed multiline text", () => {
    const s = createScreen({ cols: 80, rows: 24 })
    s.feed(new TextEncoder().encode("line1\r\nline2\r\nline3"))
    const text = s.getText()
    expect(text).toContain("line1")
    expect(text).toContain("line2")
    expect(text).toContain("line3")
  })

  // ── Monochrome — colors ignored ──

  test("color codes are silently ignored (VT100 is monochrome)", () => {
    const s = createScreen({ cols: 80, rows: 24 })
    // SGR 31 = red foreground — VT100 ignores this
    s.feed(new TextEncoder().encode("\x1b[31mR\x1b[0m"))
    const cell = s.getCell(0, 0)
    expect(cell.char).toBe("R")
    // fg should be null since VT100 is monochrome
    expect(cell.fg).toBeNull()
    expect(cell.bg).toBeNull()
  })

  test("background color codes are silently ignored", () => {
    const s = createScreen({ cols: 80, rows: 24 })
    // SGR 42 = green background — VT100 ignores this
    s.feed(new TextEncoder().encode("\x1b[42mG\x1b[0m"))
    const cell = s.getCell(0, 0)
    expect(cell.char).toBe("G")
    expect(cell.bg).toBeNull()
  })

  test("SGR 39/49 (default fg/bg) are silently ignored too", () => {
    const s = createScreen({ cols: 80, rows: 24 })
    s.feed(new TextEncoder().encode("\x1b[31mR\x1b[39mN"))
    // Both cells should have null fg
    expect(s.getCell(0, 0).fg).toBeNull()
    expect(s.getCell(0, 1).fg).toBeNull()
  })

  // ── Text attributes (VT100 subset) ──

  test("feed bold text, getCell() has bold=true", () => {
    const s = createScreen({ cols: 80, rows: 24 })
    s.feed(new TextEncoder().encode("\x1b[1mhello\x1b[0m"))
    const cell = s.getCell(0, 0)
    expect(cell.char).toBe("h")
    expect(cell.bold).toBe(true)
    // After reset, next cells should not be bold
    s.feed(new TextEncoder().encode("x"))
    const after = s.getCell(0, 5)
    expect(after.bold).toBe(false)
  })

  test("underline attribute detection", () => {
    const s = createScreen({ cols: 80, rows: 24 })
    s.feed(new TextEncoder().encode("\x1b[4munderlined\x1b[0m"))
    const cell = s.getCell(0, 0)
    expect(cell.underline).toBe(true)

    // Classic tiers ignore compound SGR groups, preserving state and valid siblings.
    for (const initialUnderline of [false, true]) {
      for (const params of ["4:0", "4:1", "4:2", "4:3", "4:4", "4:5", "38:2::1:2:3"]) {
        s.reset()
        s.feed(new TextEncoder().encode(`${initialUnderline ? "\x1b[4m" : ""}\x1b[${params}mX`))
        expect(s.getCell(0, 0).underline, `${params}, initial=${initialUnderline}`).toBe(initialUnderline)
      }
    }
    for (const [params, underline, bold] of [
      ["1;4:3;31", false, true],
      ["4:3;1", false, true],
      ["4;4:3", true, false],
      ["4;4:3;24", false, false],
      ["4;0", false, false],
      ["4;", false, false],
      ["1;38:2::1:2:3;4", true, true],
      ["38;2;1;2;3;4", true, false],
    ] as const) {
      s.reset()
      s.feed(new TextEncoder().encode(`\x1b[${params}mX`))
      expect(s.getCell(0, 0)).toMatchObject({ char: "X", underline, bold, fg: null })
    }
  })

  test("SGR 24 turns off underline", () => {
    const s = createScreen({ cols: 80, rows: 24 })
    s.feed(new TextEncoder().encode("\x1b[4mU\x1b[24mN"))
    expect(s.getCell(0, 0).underline).toBe(true)
    expect(s.getCell(0, 1).underline).toBe(false)
  })

  test("blink attribute detection (SGR 5)", () => {
    const s = createScreen({ cols: 80, rows: 24 })
    s.feed(new TextEncoder().encode("\x1b[5mblink\x1b[0m"))
    const cell = s.getCell(0, 0)
    expect(cell.blink).toBe(true)
  })

  test("SGR 25 turns off blink", () => {
    const s = createScreen({ cols: 80, rows: 24 })
    s.feed(new TextEncoder().encode("\x1b[5mB\x1b[25mN"))
    expect(s.getCell(0, 0).blink).toBe(true)
    expect(s.getCell(0, 1).blink).toBe(false)
  })

  test("inverse attribute detection", () => {
    const s = createScreen({ cols: 80, rows: 24 })
    s.feed(new TextEncoder().encode("\x1b[7minverse\x1b[0m"))
    const cell = s.getCell(0, 0)
    expect(cell.inverse).toBe(true)
  })

  test("hidden attribute is NOT supported (VT100 has no conceal)", () => {
    const s = createScreen({ cols: 80, rows: 24 })
    // SGR 8 (hidden) is a VT220 feature — VT100 ignores it
    s.feed(new TextEncoder().encode("\x1b[8mhidden\x1b[0m"))
    const cell = s.getCell(0, 0)
    expect(cell.hidden).toBe(false)
  })

  test("SGR 22 turns off bold", () => {
    const s = createScreen({ cols: 80, rows: 24 })
    s.feed(new TextEncoder().encode("\x1b[1mB\x1b[22mN"))
    expect(s.getCell(0, 0).bold).toBe(true)
    expect(s.getCell(0, 1).bold).toBe(false)
  })

  // ── Cursor ──

  test("cursor position updates after text feed", () => {
    const s = createScreen({ cols: 80, rows: 24 })
    s.feed(new TextEncoder().encode("abc"))
    const cursor = s.getCursor()
    expect(cursor.x).toBe(3)
    expect(cursor.y).toBe(0)
    expect(cursor.visible).toBe(true)
    expect(cursor.style).toBe("block")
  })

  test("cursor moves to next line on newline", () => {
    const s = createScreen({ cols: 80, rows: 24 })
    s.feed(new TextEncoder().encode("line1\r\n"))
    const cursor = s.getCursor()
    expect(cursor.x).toBe(0)
    expect(cursor.y).toBe(1)
  })

  test("cursor positioning via CSI H", () => {
    const s = createScreen({ cols: 80, rows: 24 })
    // Move cursor to row 5, col 10 (1-based)
    s.feed(new TextEncoder().encode("\x1b[5;10H"))
    const cursor = s.getCursor()
    expect(cursor.x).toBe(9)
    expect(cursor.y).toBe(4)
  })

  test("cursor visibility via DECTCEM", () => {
    const s = createScreen({ cols: 80, rows: 24 })
    expect(s.getCursor().visible).toBe(true)
    // Hide cursor
    s.feed(new TextEncoder().encode("\x1b[?25l"))
    expect(s.getCursor().visible).toBe(false)
    // Show cursor
    s.feed(new TextEncoder().encode("\x1b[?25h"))
    expect(s.getCursor().visible).toBe(true)
  })

  // ── Modes ──

  test("autowrap mode detection", () => {
    const s = createScreen({ cols: 80, rows: 24 })
    expect(s.getMode("autoWrap")).toBe(true) // Default on
    s.feed(new TextEncoder().encode("\x1b[?7l"))
    expect(s.getMode("autoWrap")).toBe(false)
    s.feed(new TextEncoder().encode("\x1b[?7h"))
    expect(s.getMode("autoWrap")).toBe(true)
  })

  test("application cursor mode (DECCKM)", () => {
    const s = createScreen({ cols: 80, rows: 24 })
    expect(s.getMode("applicationCursor")).toBe(false)
    s.feed(new TextEncoder().encode("\x1b[?1h"))
    expect(s.getMode("applicationCursor")).toBe(true)
    s.feed(new TextEncoder().encode("\x1b[?1l"))
    expect(s.getMode("applicationCursor")).toBe(false)
  })

  test("application keypad mode via DECKPAM/DECKPNM", () => {
    const s = createScreen({ cols: 80, rows: 24 })
    expect(s.getMode("applicationKeypad")).toBe(false)
    // ESC = (DECKPAM)
    s.feed(new TextEncoder().encode("\x1b="))
    expect(s.getMode("applicationKeypad")).toBe(true)
    // ESC > (DECKPNM)
    s.feed(new TextEncoder().encode("\x1b>"))
    expect(s.getMode("applicationKeypad")).toBe(false)
  })

  test("insertMode is NOT available (VT100 has no IRM)", () => {
    const s = createScreen({ cols: 80, rows: 24 })
    expect(s.getMode("insertMode")).toBe(false)
    // CSI 4h is VT102/VT220 — VT100 ignores it
    s.feed(new TextEncoder().encode("\x1b[4h"))
    expect(s.getMode("insertMode")).toBe(false)
  })

  test("reverse video mode (DECSCNM)", () => {
    const s = createScreen({ cols: 80, rows: 24 })
    expect(s.getMode("reverseVideo")).toBe(false)
    s.feed(new TextEncoder().encode("\x1b[?5h"))
    expect(s.getMode("reverseVideo")).toBe(true)
    s.feed(new TextEncoder().encode("\x1b[?5l"))
    expect(s.getMode("reverseVideo")).toBe(false)
  })

  // ── Device responses ──

  test("DA1 response (CSI c) — VT100 with AVO", () => {
    const onResponse = vi.fn()
    const s = createScreen({ cols: 80, rows: 24, onResponse })
    s.feed(new TextEncoder().encode("\x1b[c"))
    expect(onResponse).toHaveBeenCalledWith("\x1b[?1;2c")
  })

  test("DA1 response with explicit param 0 (CSI 0c)", () => {
    const onResponse = vi.fn()
    const s = createScreen({ cols: 80, rows: 24, onResponse })
    s.feed(new TextEncoder().encode("\x1b[0c"))
    expect(onResponse).toHaveBeenCalledWith("\x1b[?1;2c")
  })

  test("DSR device status (CSI 5n)", () => {
    const onResponse = vi.fn()
    const s = createScreen({ cols: 80, rows: 24, onResponse })
    s.feed(new TextEncoder().encode("\x1b[5n"))
    expect(onResponse).toHaveBeenCalledWith("\x1b[0n")
  })

  test("DSR cursor position report (CSI 6n)", () => {
    const onResponse = vi.fn()
    const s = createScreen({ cols: 80, rows: 24, onResponse })
    // Move cursor to row 5, col 10 (1-based)
    s.feed(new TextEncoder().encode("\x1b[5;10H"))
    s.feed(new TextEncoder().encode("\x1b[6n"))
    // Response should be 1-based: row 5, col 10
    expect(onResponse).toHaveBeenCalledWith("\x1b[5;10R")
  })

  test("DSR/DA1 without onResponse does not crash", () => {
    const s = createScreen({ cols: 80, rows: 24 })
    // Should silently ignore
    s.feed(new TextEncoder().encode("\x1b[c"))
    s.feed(new TextEncoder().encode("\x1b[5n"))
    s.feed(new TextEncoder().encode("\x1b[6n"))
  })

  // ── No DECSTR (VT220 feature) ──

  test("DECSTR (CSI ! p) is silently ignored", () => {
    const s = createScreen({ cols: 80, rows: 24 })
    s.feed(new TextEncoder().encode("hello"))
    s.feed(new TextEncoder().encode("\x1b[?1h")) // application cursor on
    // DECSTR — VT100 ignores this
    s.feed(new TextEncoder().encode("\x1b[!p"))
    // Mode should NOT be reset (DECSTR not supported)
    expect(s.getMode("applicationCursor")).toBe(true)
    // Content should still be there
    expect(s.getText()).toContain("hello")
  })

  // ── Resize ──

  test("resize() changes dimensions", () => {
    const s = createScreen({ cols: 80, rows: 24 })
    s.resize(120, 40)
    const scrollback = s.getScrollback()
    expect(scrollback.screenLines).toBe(40)
  })

  // ── Title ──

  test("title changes via OSC 2", () => {
    const s = createScreen({ cols: 80, rows: 24 })
    expect(s.getTitle()).toBe("")
    // OSC 2 ; title ST (using BEL as terminator)
    s.feed(new TextEncoder().encode("\x1b]2;my terminal title\x07"))
    expect(s.getTitle()).toBe("my terminal title")
  })

  test("title changes via OSC 0", () => {
    const s = createScreen({ cols: 80, rows: 24 })
    s.feed(new TextEncoder().encode("\x1b]0;window title\x07"))
    expect(s.getTitle()).toBe("window title")
  })

  test("title changes via OSC with ST terminator", () => {
    const s = createScreen({ cols: 80, rows: 24 })
    s.feed(new TextEncoder().encode("\x1b]2;st title\x1b\\"))
    expect(s.getTitle()).toBe("st title")
  })

  // ── Reset ──

  test("reset() clears all content", () => {
    const s = createScreen({ cols: 80, rows: 24 })
    s.feed(new TextEncoder().encode("some content here"))
    expect(s.getText()).toContain("some content here")
    s.reset()
    // After reset, content should be cleared
    const text = s.getText()
    expect(text.trim()).toBe("")
  })

  // ── getLine / getLines ──

  test("getLine returns cells for the row", () => {
    const s = createScreen({ cols: 10, rows: 5 })
    s.feed(new TextEncoder().encode("abc"))
    const line = s.getLine(0)
    expect(line).toHaveLength(10)
    expect(line[0]!.char).toBe("a")
    expect(line[1]!.char).toBe("b")
    expect(line[2]!.char).toBe("c")
  })

  test("getLines returns all visible rows", () => {
    const s = createScreen({ cols: 10, rows: 5 })
    const lines = s.getLines()
    expect(lines).toHaveLength(5)
  })

  // ── getTextRange ──

  test("getTextRange returns text in range", () => {
    const s = createScreen({ cols: 80, rows: 24 })
    s.feed(new TextEncoder().encode("hello world\r\nsecond line"))
    const range = s.getTextRange(0, 6, 0, 11)
    expect(range).toBe("world")
  })

  // ── Scrollback ──

  test("getScrollback returns viewport state", () => {
    const s = createScreen({ cols: 80, rows: 5 })
    const state = s.getScrollback()
    expect(state.screenLines).toBe(5)
    expect(state.viewportOffset).toBe(0)
    expect(state.totalLines).toBeGreaterThanOrEqual(5)
  })

  // ── Default cell ──

  test("getCell on empty position returns default cell", () => {
    const s = createScreen({ cols: 80, rows: 24 })
    const cell = s.getCell(0, 0)
    expect(cell.fg).toBeNull()
    expect(cell.bg).toBeNull()
    expect(cell.bold).toBe(false)
    expect(cell.underline).toBe(false)
    expect(cell.blink).toBe(false)
    expect(cell.inverse).toBe(false)
    expect(cell.hidden).toBe(false)
  })

  // ── Combined attributes (bold only — no colors in VT100) ──

  test("combined bold + underline attributes", () => {
    const s = createScreen({ cols: 80, rows: 24 })
    s.feed(new TextEncoder().encode("\x1b[1;4mX\x1b[0m"))
    const cell = s.getCell(0, 0)
    expect(cell.char).toBe("X")
    expect(cell.bold).toBe(true)
    expect(cell.underline).toBe(true)
    // Color is ignored in VT100
    expect(cell.fg).toBeNull()
  })

  // ── Erase commands ──

  test("erase in display (ED mode 2)", () => {
    const s = createScreen({ cols: 80, rows: 24 })
    s.feed(new TextEncoder().encode("hello"))
    // Erase entire display
    s.feed(new TextEncoder().encode("\x1b[2J"))
    const text = s.getText()
    expect(text.trim()).toBe("")
  })

  test("erase in line (EL mode 0)", () => {
    const s = createScreen({ cols: 80, rows: 24 })
    s.feed(new TextEncoder().encode("hello world"))
    // Move cursor to col 5, erase from cursor to end of line
    s.feed(new TextEncoder().encode("\x1b[1;6H\x1b[K"))
    const text = s.getText()
    expect(text).toContain("hello")
    expect(text).not.toContain("world")
  })

  // ── No ICH/DCH/IL/DL (VT102/VT220 features) ──

  test("ICH/DCH/IL/DL are silently ignored", () => {
    const s = createScreen({ cols: 10, rows: 3 })
    s.feed(new TextEncoder().encode("ABCDE"))

    // Move cursor to col 1
    s.feed(new TextEncoder().encode("\x1b[1;2H"))

    // DCH (CSI P) — should be ignored
    s.feed(new TextEncoder().encode("\x1b[2P"))
    // Text should be unchanged
    const line = s.getLine(0)
    expect(line[0]!.char).toBe("A")
    expect(line[1]!.char).toBe("B")
    expect(line[2]!.char).toBe("C")
    expect(line[3]!.char).toBe("D")
    expect(line[4]!.char).toBe("E")
  })

  // ── Scroll region ──

  test("scroll region respects DECSTBM", () => {
    const s = createScreen({ cols: 80, rows: 10 })
    // Set scroll region to rows 3-7 (1-based)
    s.feed(new TextEncoder().encode("\x1b[3;7r"))
    // Cursor should be at 0,0 after DECSTBM
    const cursor = s.getCursor()
    expect(cursor.x).toBe(0)
    expect(cursor.y).toBe(0)
  })

  // ── Scroll regions with content ──

  describe("scroll regions with content", () => {
    test("scrolling within a region preserves content above and below", () => {
      const s = createScreen({ cols: 20, rows: 6 })
      const enc = (str: string) => new TextEncoder().encode(str)

      // Fill all 6 rows with distinct content
      s.feed(enc("ROW0-above\r\n")) // row 0
      s.feed(enc("ROW1-top\r\n")) // row 1
      s.feed(enc("ROW2-mid\r\n")) // row 2
      s.feed(enc("ROW3-bot\r\n")) // row 3
      s.feed(enc("ROW4-below\r\n")) // row 4
      s.feed(enc("ROW5-last")) // row 5

      // Set scroll region to rows 2-4 (1-based), i.e., 0-based rows 1..3
      s.feed(enc("\x1b[2;4r"))

      // Move cursor to the bottom of scroll region (row 3, 0-based)
      s.feed(enc("\x1b[4;1H"))

      // Write multiple lines to trigger scrolling within the region
      s.feed(enc("NEW-LINE-A\r\n"))
      s.feed(enc("NEW-LINE-B\r\n"))
      s.feed(enc("NEW-LINE-C"))

      const text = s.getText()

      // Row 0 (above the scroll region) should be preserved
      expect(text).toContain("ROW0-above")
      // Row 4 and Row 5 (below the scroll region) should be preserved
      expect(text).toContain("ROW4-below")
      expect(text).toContain("ROW5-last")
    })

    test("DECSTBM sets scroll region and resets cursor to 0,0", () => {
      const s = createScreen({ cols: 80, rows: 10 })
      const enc = (str: string) => new TextEncoder().encode(str)

      // Move cursor somewhere
      s.feed(enc("\x1b[5;10H"))
      expect(s.getCursor().x).toBe(9)
      expect(s.getCursor().y).toBe(4)

      // Set scroll region -- cursor should reset to 0,0
      s.feed(enc("\x1b[2;8r"))
      expect(s.getCursor().x).toBe(0)
      expect(s.getCursor().y).toBe(0)
    })

    test("scroll up (SU) within region", () => {
      const s = createScreen({ cols: 20, rows: 5 })
      const enc = (str: string) => new TextEncoder().encode(str)

      s.feed(enc("LINE-0\r\n"))
      s.feed(enc("LINE-1\r\n"))
      s.feed(enc("LINE-2\r\n"))
      s.feed(enc("LINE-3\r\n"))
      s.feed(enc("LINE-4"))

      // Set scroll region rows 2-4 (1-based), 0-based 1..3
      s.feed(enc("\x1b[2;4r"))
      // Position cursor inside region
      s.feed(enc("\x1b[2;1H"))
      // Scroll up once (CSI S)
      s.feed(enc("\x1b[1S"))

      const text = s.getText()
      // Row 0 (above region) should be preserved
      expect(text).toContain("LINE-0")
      // Row 4 (below region) should be preserved
      expect(text).toContain("LINE-4")
    })
  })

  // ── Line wrapping ──

  describe("line wrapping", () => {
    test("text longer than cols wraps to next line", () => {
      const s = createScreen({ cols: 5, rows: 3 })
      // Write 8 characters into a 5-col terminal
      s.feed(new TextEncoder().encode("ABCDEFGH"))

      // First line should have ABCDE
      const line0 = s.getLine(0)
      expect(line0[0]!.char).toBe("A")
      expect(line0[1]!.char).toBe("B")
      expect(line0[2]!.char).toBe("C")
      expect(line0[3]!.char).toBe("D")
      expect(line0[4]!.char).toBe("E")

      // Second line should have FGH
      const line1 = s.getLine(1)
      expect(line1[0]!.char).toBe("F")
      expect(line1[1]!.char).toBe("G")
      expect(line1[2]!.char).toBe("H")

      // Cursor should be on row 1, col 3
      expect(s.getCursor().x).toBe(3)
      expect(s.getCursor().y).toBe(1)
    })

    test("autowrap disabled prevents wrapping", () => {
      const s = createScreen({ cols: 5, rows: 3 })
      // Disable autowrap
      s.feed(new TextEncoder().encode("\x1b[?7l"))
      expect(s.getMode("autoWrap")).toBe(false)

      // Write 8 characters -- should NOT wrap
      s.feed(new TextEncoder().encode("ABCDEFGH"))

      // Second line should be empty (no wrapping)
      const line1 = s.getLine(1)
      expect(line1[0]!.char).toBe("")

      // Cursor stays on row 0
      expect(s.getCursor().y).toBe(0)
    })

    test("re-enabling autowrap allows wrapping again", () => {
      const s = createScreen({ cols: 5, rows: 3 })
      // Disable then re-enable
      s.feed(new TextEncoder().encode("\x1b[?7l"))
      s.feed(new TextEncoder().encode("\x1b[?7h"))
      expect(s.getMode("autoWrap")).toBe(true)

      // Should wrap normally
      s.feed(new TextEncoder().encode("ABCDEFGH"))
      const line1 = s.getLine(1)
      expect(line1[0]!.char).toBe("F")
    })
  })

  // ── Scrollback accumulation ──

  describe("scrollback accumulation", () => {
    test("writing more lines than rows pushes old lines to scrollback", () => {
      const s = createScreen({ cols: 10, rows: 3 })

      // Write 10 lines into a 3-row terminal
      for (let i = 0; i < 10; i++) {
        s.feed(new TextEncoder().encode(`line${i}\r\n`))
      }

      const scrollback = s.getScrollback()
      // totalLines = scrollback.length + screenLines
      // We wrote 10 newlines into 3 rows, so at least 7 lines should be in scrollback
      expect(scrollback.totalLines).toBeGreaterThan(scrollback.screenLines)
      expect(scrollback.totalLines).toBeGreaterThanOrEqual(10)

      // getText() includes scrollback -- should contain early lines
      const text = s.getText()
      expect(text).toContain("line0")
      expect(text).toContain("line1")
      expect(text).toContain("line9")
    })

    test("scrollback respects scrollbackLimit", () => {
      const s = createScreen({ cols: 10, rows: 3, scrollbackLimit: 5 })

      // Write 20 lines to overflow the scrollback limit
      for (let i = 0; i < 20; i++) {
        s.feed(new TextEncoder().encode(`L${i.toString().padStart(2, "0")}\r\n`))
      }

      const scrollback = s.getScrollback()
      // scrollbackLimit=5: scrollback stores at most ~5 lines
      // totalLines = scrollbackLength + screenLines
      // The scrollback length should be capped around the limit
      const scrollbackLength = scrollback.totalLines - scrollback.screenLines
      expect(scrollbackLength).toBeLessThanOrEqual(7) // generous upper bound
      expect(scrollbackLength).toBeGreaterThan(0) // some scrollback exists

      // Very early lines should have been evicted from scrollback
      const text = s.getText()
      expect(text).not.toContain("L00")
      expect(text).not.toContain("L01")
    })
  })

  // ── Cursor movement commands ──

  describe("cursor movement commands", () => {
    test("CUU (cursor up) moves cursor up", () => {
      const s = createScreen({ cols: 80, rows: 24 })
      s.feed(new TextEncoder().encode("\x1b[10;10H")) // row 9, col 9
      s.feed(new TextEncoder().encode("\x1b[3A")) // up 3
      expect(s.getCursor().y).toBe(6)
      expect(s.getCursor().x).toBe(9) // x unchanged
    })

    test("CUD (cursor down) moves cursor down", () => {
      const s = createScreen({ cols: 80, rows: 24 })
      s.feed(new TextEncoder().encode("\x1b[5;5H")) // row 4, col 4
      s.feed(new TextEncoder().encode("\x1b[4B")) // down 4
      expect(s.getCursor().y).toBe(8)
      expect(s.getCursor().x).toBe(4) // x unchanged
    })

    test("CUF (cursor forward) moves cursor right", () => {
      const s = createScreen({ cols: 80, rows: 24 })
      s.feed(new TextEncoder().encode("\x1b[1;1H")) // row 0, col 0
      s.feed(new TextEncoder().encode("\x1b[10C")) // right 10
      expect(s.getCursor().x).toBe(10)
      expect(s.getCursor().y).toBe(0) // y unchanged
    })

    test("CUB (cursor back) moves cursor left", () => {
      const s = createScreen({ cols: 80, rows: 24 })
      s.feed(new TextEncoder().encode("\x1b[1;20H")) // row 0, col 19
      s.feed(new TextEncoder().encode("\x1b[5D")) // left 5
      expect(s.getCursor().x).toBe(14)
      expect(s.getCursor().y).toBe(0) // y unchanged
    })

    test("CHA (cursor horizontal absolute) sets column", () => {
      const s = createScreen({ cols: 80, rows: 24 })
      s.feed(new TextEncoder().encode("\x1b[3;10H")) // row 2, col 9
      s.feed(new TextEncoder().encode("\x1b[5G")) // col 5 (1-based) = col 4 (0-based)
      expect(s.getCursor().x).toBe(4)
      expect(s.getCursor().y).toBe(2) // y unchanged
    })

    test("VPA (line position absolute) sets row", () => {
      const s = createScreen({ cols: 80, rows: 24 })
      s.feed(new TextEncoder().encode("\x1b[1;10H")) // row 0, col 9
      s.feed(new TextEncoder().encode("\x1b[3d")) // row 3 (1-based) = row 2 (0-based)
      expect(s.getCursor().y).toBe(2)
      expect(s.getCursor().x).toBe(9) // x unchanged
    })

    test("CUU clamps at top of screen", () => {
      const s = createScreen({ cols: 80, rows: 24 })
      s.feed(new TextEncoder().encode("\x1b[3;1H")) // row 2
      s.feed(new TextEncoder().encode("\x1b[100A")) // up 100
      expect(s.getCursor().y).toBe(0) // clamped at 0
    })

    test("CUD clamps at bottom of screen", () => {
      const s = createScreen({ cols: 80, rows: 10 })
      s.feed(new TextEncoder().encode("\x1b[5;1H")) // row 4
      s.feed(new TextEncoder().encode("\x1b[100B")) // down 100
      expect(s.getCursor().y).toBe(9) // clamped at rows-1
    })

    test("CUF clamps at right edge", () => {
      const s = createScreen({ cols: 20, rows: 5 })
      s.feed(new TextEncoder().encode("\x1b[1;1H"))
      s.feed(new TextEncoder().encode("\x1b[100C")) // right 100
      expect(s.getCursor().x).toBe(19) // clamped at cols-1
    })

    test("CUB clamps at left edge", () => {
      const s = createScreen({ cols: 80, rows: 24 })
      s.feed(new TextEncoder().encode("\x1b[1;5H")) // col 4
      s.feed(new TextEncoder().encode("\x1b[100D")) // left 100
      expect(s.getCursor().x).toBe(0) // clamped at 0
    })

    test("CUU/CUD default to 1 when no parameter given", () => {
      const s = createScreen({ cols: 80, rows: 24 })
      s.feed(new TextEncoder().encode("\x1b[5;5H")) // row 4, col 4
      s.feed(new TextEncoder().encode("\x1b[A")) // up 1
      expect(s.getCursor().y).toBe(3)
      s.feed(new TextEncoder().encode("\x1b[B")) // down 1
      expect(s.getCursor().y).toBe(4)
      s.feed(new TextEncoder().encode("\x1b[C")) // right 1
      expect(s.getCursor().x).toBe(5)
      s.feed(new TextEncoder().encode("\x1b[D")) // left 1
      expect(s.getCursor().x).toBe(4)
    })
  })

  // ── Save/restore cursor ──

  describe("save/restore cursor", () => {
    test("DECSC/DECRC saves and restores cursor position", () => {
      const s = createScreen({ cols: 80, rows: 24 })
      // Move cursor to a specific position
      s.feed(new TextEncoder().encode("\x1b[10;20H")) // row 9, col 19
      expect(s.getCursor().x).toBe(19)
      expect(s.getCursor().y).toBe(9)

      // Save cursor (ESC 7)
      s.feed(new TextEncoder().encode("\x1b7"))

      // Move cursor elsewhere
      s.feed(new TextEncoder().encode("\x1b[1;1H")) // row 0, col 0
      expect(s.getCursor().x).toBe(0)
      expect(s.getCursor().y).toBe(0)

      // Restore cursor (ESC 8)
      s.feed(new TextEncoder().encode("\x1b8"))
      expect(s.getCursor().x).toBe(19)
      expect(s.getCursor().y).toBe(9)
    })

    test("CSI s / CSI u saves and restores cursor position", () => {
      const s = createScreen({ cols: 80, rows: 24 })
      s.feed(new TextEncoder().encode("\x1b[5;15H")) // row 4, col 14
      expect(s.getCursor().x).toBe(14)
      expect(s.getCursor().y).toBe(4)

      // Save cursor (CSI s)
      s.feed(new TextEncoder().encode("\x1b[s"))

      // Move cursor elsewhere
      s.feed(new TextEncoder().encode("\x1b[20;60H"))
      expect(s.getCursor().x).toBe(59)
      expect(s.getCursor().y).toBe(19)

      // Restore cursor (CSI u)
      s.feed(new TextEncoder().encode("\x1b[u"))
      expect(s.getCursor().x).toBe(14)
      expect(s.getCursor().y).toBe(4)
    })

    test("restore cursor clamps to screen bounds after resize", () => {
      const s = createScreen({ cols: 80, rows: 24 })
      // Save cursor at a far position
      s.feed(new TextEncoder().encode("\x1b[20;70H"))
      s.feed(new TextEncoder().encode("\x1b7"))

      // Resize to smaller
      s.resize(40, 10)

      // Restore -- should clamp
      s.feed(new TextEncoder().encode("\x1b8"))
      expect(s.getCursor().x).toBeLessThan(40)
      expect(s.getCursor().y).toBeLessThan(10)
    })
  })

  // ── scrollViewport() ──

  describe("scrollViewport", () => {
    test("scrollViewport changes viewportOffset after scrollback exists", () => {
      const s = createScreen({ cols: 10, rows: 3 })

      // Generate scrollback
      for (let i = 0; i < 10; i++) {
        s.feed(new TextEncoder().encode(`line${i}\r\n`))
      }

      // At bottom: viewportOffset = totalLines - screenLines (absolute top row of viewport)
      const initial = s.getScrollback()
      const bottomOffset = initial.totalLines - initial.screenLines
      expect(initial.viewportOffset).toBe(bottomOffset)

      // Scroll up by 3: viewport moves 3 rows earlier in the buffer
      s.scrollViewport(3)
      expect(s.getScrollback().viewportOffset).toBe(bottomOffset - 3)

      // Scroll down by 1: viewport moves 1 row later
      s.scrollViewport(-1)
      expect(s.getScrollback().viewportOffset).toBe(bottomOffset - 2)
    })

    test("scrollViewport clamps at bottom (totalLines - screenLines)", () => {
      const s = createScreen({ cols: 10, rows: 3 })

      // Generate some scrollback
      for (let i = 0; i < 10; i++) {
        s.feed(new TextEncoder().encode(`line${i}\r\n`))
      }

      const sb = s.getScrollback()
      const bottomOffset = sb.totalLines - sb.screenLines

      // Try to scroll past bottom
      s.scrollViewport(-100)
      expect(s.getScrollback().viewportOffset).toBe(bottomOffset)
    })

    test("scrollViewport clamps at top (row 0)", () => {
      const s = createScreen({ cols: 10, rows: 3, scrollbackLimit: 5 })

      // Generate scrollback
      for (let i = 0; i < 10; i++) {
        s.feed(new TextEncoder().encode(`line${i}\r\n`))
      }

      // Try to scroll way past top
      s.scrollViewport(1000)
      const sb = s.getScrollback()
      // viewportOffset should be clamped at 0 (absolute top of buffer)
      expect(sb.viewportOffset).toBe(0)
    })

    test("scrollViewport with no scrollback stays at bottom", () => {
      const s = createScreen({ cols: 80, rows: 24 })
      s.feed(new TextEncoder().encode("hello"))
      s.scrollViewport(5)
      // No scrollback: totalLines = screenLines, so bottom = 0
      const sb = s.getScrollback()
      expect(sb.viewportOffset).toBe(sb.totalLines - sb.screenLines)
    })
  })

  // ── resize() content preservation ──

  describe("resize content preservation", () => {
    test("resize preserves existing text", () => {
      const s = createScreen({ cols: 20, rows: 5 })
      s.feed(new TextEncoder().encode("hello world"))
      s.feed(new TextEncoder().encode("\r\nsecond line"))

      // Resize larger
      s.resize(40, 10)
      const text = s.getText()
      expect(text).toContain("hello world")
      expect(text).toContain("second line")
    })

    test("resize smaller preserves visible text within new bounds", () => {
      const s = createScreen({ cols: 20, rows: 5 })
      s.feed(new TextEncoder().encode("ABCDEFGHIJ"))
      s.feed(new TextEncoder().encode("\r\nLINE2"))

      // Resize to fewer cols
      s.resize(5, 5)
      // First 5 chars should still be there
      const line = s.getLine(0)
      expect(line[0]!.char).toBe("A")
      expect(line[1]!.char).toBe("B")
      expect(line[2]!.char).toBe("C")
      expect(line[3]!.char).toBe("D")
      expect(line[4]!.char).toBe("E")
    })

    test("resize clamps cursor position", () => {
      const s = createScreen({ cols: 80, rows: 24 })
      // Move cursor to far position
      s.feed(new TextEncoder().encode("\x1b[20;70H"))
      expect(s.getCursor().x).toBe(69)
      expect(s.getCursor().y).toBe(19)

      // Resize to smaller
      s.resize(10, 5)
      expect(s.getCursor().x).toBeLessThan(10)
      expect(s.getCursor().y).toBeLessThan(5)
    })

    test("resize resets scroll region", () => {
      const s = createScreen({ cols: 80, rows: 10 })
      // Set a scroll region
      s.feed(new TextEncoder().encode("\x1b[3;7r"))
      // Resize
      s.resize(80, 20)
      // Scroll region should be reset to full screen
      // Verify by writing enough lines to fill screen -- should scroll normally
      for (let i = 0; i < 25; i++) {
        s.feed(new TextEncoder().encode(`line${i}\r\n`))
      }
      // Should not crash, and last lines should be visible
      const text = s.getText()
      expect(text).toContain("line24")
    })
  })

  // ── Negative/edge cases ──

  describe("negative and edge cases", () => {
    test("empty input to feed() does nothing", () => {
      const s = createScreen({ cols: 80, rows: 24 })
      s.feed(new Uint8Array(0))
      expect(s.getText().trim()).toBe("")
      expect(s.getCursor().x).toBe(0)
      expect(s.getCursor().y).toBe(0)
    })

    test("malformed escape sequence is ignored gracefully", () => {
      const s = createScreen({ cols: 80, rows: 24 })
      // ESC followed by an invalid char -- should return to ground state
      s.feed(new TextEncoder().encode("\x1b!hello"))
      // The "hello" after the malformed escape should still render
      const text = s.getText()
      expect(text).toContain("hello")
    })

    test("incomplete CSI sequence followed by text", () => {
      const s = createScreen({ cols: 80, rows: 24 })
      // Feed CSI with just params, then a final byte in a separate feed
      s.feed(new TextEncoder().encode("\x1b[1"))
      // Now the parser is in CSI state waiting for final byte
      s.feed(new TextEncoder().encode("mBoldText\x1b[0m"))
      const cell = s.getCell(0, 0)
      expect(cell.char).toBe("B")
      expect(cell.bold).toBe(true)
    })

    test("getCell with out-of-bounds returns empty cell", () => {
      const s = createScreen({ cols: 10, rows: 5 })
      // Column beyond bounds
      const cell = s.getCell(0, 100)
      expect(cell.char).toBe("")
      expect(cell.fg).toBeNull()
      // Row beyond bounds
      const cell2 = s.getCell(100, 0)
      expect(cell2.char).toBe("")
    })

    test("CUP with row/col of 0 is treated as 1 (1-based minimum)", () => {
      const s = createScreen({ cols: 80, rows: 24 })
      // CSI 0;0 H -- params are 0, which should be treated as 1
      s.feed(new TextEncoder().encode("\x1b[0;0H"))
      expect(s.getCursor().x).toBe(0) // (1-1 = 0)
      expect(s.getCursor().y).toBe(0) // (1-1 = 0)
    })

    test("CHA with 0 parameter treated as column 1", () => {
      const s = createScreen({ cols: 80, rows: 24 })
      s.feed(new TextEncoder().encode("\x1b[5;20H")) // move to col 19
      s.feed(new TextEncoder().encode("\x1b[0G")) // CHA 0 -> treated as 1
      expect(s.getCursor().x).toBe(0)
    })

    test("multiple resets don't cause errors", () => {
      const s = createScreen({ cols: 80, rows: 24 })
      s.feed(new TextEncoder().encode("text"))
      s.reset()
      s.reset()
      s.reset()
      expect(s.getText().trim()).toBe("")
    })

    test("very long line with autowrap fills multiple rows", () => {
      const s = createScreen({ cols: 5, rows: 4 })
      // 20 chars = 4 full rows
      s.feed(new TextEncoder().encode("ABCDEFGHIJKLMNOPQRST"))
      // Row 0: ABCDE
      expect(s.getLine(0)[0]!.char).toBe("A")
      expect(s.getLine(0)[4]!.char).toBe("E")
      // Row 1: FGHIJ
      expect(s.getLine(1)[0]!.char).toBe("F")
      expect(s.getLine(1)[4]!.char).toBe("J")
      // Row 2: KLMNO
      expect(s.getLine(2)[0]!.char).toBe("K")
      expect(s.getLine(2)[4]!.char).toBe("O")
      // Row 3: PQRST
      expect(s.getLine(3)[0]!.char).toBe("P")
      expect(s.getLine(3)[4]!.char).toBe("T")
    })

    test("NUL characters (0x00) are ignored", () => {
      const s = createScreen({ cols: 80, rows: 24 })
      s.feed(new Uint8Array([0x00, 0x00, 0x00]))
      expect(s.getText().trim()).toBe("")
      expect(s.getCursor().x).toBe(0)
    })

    test("BEL character (0x07) is silently consumed", () => {
      const s = createScreen({ cols: 80, rows: 24 })
      s.feed(new TextEncoder().encode("A\x07B"))
      const text = s.getText()
      expect(text).toContain("AB")
    })

    test("backspace (0x08) moves cursor back", () => {
      const s = createScreen({ cols: 80, rows: 24 })
      s.feed(new TextEncoder().encode("ABC\x08"))
      expect(s.getCursor().x).toBe(2) // was at 3, back 1
    })

    test("tab (0x09) moves cursor to next tab stop", () => {
      const s = createScreen({ cols: 80, rows: 24 })
      s.feed(new TextEncoder().encode("AB\t"))
      // Tab stops are every 8 cols: from col 2, next is col 8
      expect(s.getCursor().x).toBe(8)
    })

    test("unknown CSI sequences are silently ignored", () => {
      const s = createScreen({ cols: 80, rows: 24 })
      // CSI with unknown final byte
      s.feed(new TextEncoder().encode("\x1b[99zABC"))
      // Should not crash, and ABC should render
      expect(s.getText()).toContain("ABC")
    })

    test("unknown private modes are silently ignored", () => {
      const s = createScreen({ cols: 80, rows: 24 })
      // Modes that vt100.js doesn't handle (e.g., mouse, bracketed paste)
      s.feed(new TextEncoder().encode("\x1b[?1000h")) // mouse tracking
      s.feed(new TextEncoder().encode("\x1b[?2004h")) // bracketed paste
      s.feed(new TextEncoder().encode("\x1b[?1049h")) // alt screen
      // None of these should crash
      s.feed(new TextEncoder().encode("ABC"))
      expect(s.getText()).toContain("ABC")
    })

    test("256-color and truecolor SGR sequences are silently ignored", () => {
      const s = createScreen({ cols: 80, rows: 24 })
      // These sequences should not crash, just be ignored
      s.feed(new TextEncoder().encode("\x1b[38;5;208mX\x1b[0m"))
      s.feed(new TextEncoder().encode("\x1b[38;2;100;200;50mY\x1b[0m"))
      const cellX = s.getCell(0, 0)
      expect(cellX.char).toBe("X")
      // fg should be null since VT100 is monochrome
      expect(cellX.fg).toBeNull()
    })
  })

  // ── ESC sequences ──

  describe("escape sequences", () => {
    test("IND (ESC D) moves cursor down, scrolls at bottom", () => {
      const s = createScreen({ cols: 10, rows: 3 })
      s.feed(new TextEncoder().encode("LINE0\r\n"))
      s.feed(new TextEncoder().encode("LINE1\r\n"))
      s.feed(new TextEncoder().encode("LINE2"))
      // Cursor at row 2. ESC D should scroll
      s.feed(new TextEncoder().encode("\x1bD"))
      expect(s.getCursor().y).toBe(2)
    })

    test("RI (ESC M) moves cursor up, scrolls at top", () => {
      const s = createScreen({ cols: 10, rows: 3 })
      // Cursor at row 0. ESC M should scroll down
      s.feed(new TextEncoder().encode("\x1bM"))
      expect(s.getCursor().y).toBe(0)
    })

    test("NEL (ESC E) moves to next line col 0", () => {
      const s = createScreen({ cols: 10, rows: 3 })
      s.feed(new TextEncoder().encode("ABC"))
      s.feed(new TextEncoder().encode("\x1bE"))
      expect(s.getCursor().x).toBe(0)
      expect(s.getCursor().y).toBe(1)
    })

    test("RIS (ESC c) performs full reset", () => {
      const s = createScreen({ cols: 80, rows: 24 })
      s.feed(new TextEncoder().encode("content"))
      s.feed(new TextEncoder().encode("\x1b[?1h")) // application cursor on
      s.feed(new TextEncoder().encode("\x1bc")) // RIS
      expect(s.getText().trim()).toBe("")
      expect(s.getMode("applicationCursor")).toBe(false)
      expect(s.getCursor().x).toBe(0)
      expect(s.getCursor().y).toBe(0)
    })
  })
})

// A private CSI changes a mode only as DECSET/DECRST — final byte h or l, plain numeric parameters.
// Every other private sequence is a function this engine does not have, so it is ignored, never run as a reset.
describe("private CSI other than DECSET/DECRST changes no mode", () => {
  const modes = [
    { code: 1, name: "applicationCursor" },
    { code: 5, name: "reverseVideo" },
    { code: 6, name: "originMode" },
    { code: 7, name: "autoWrap" },
    { code: 25, name: "cursorVisible" },
    { code: 66, name: "applicationKeypad" },
  ]
  const queries = [
    { query: "DECRQM", sequence: (code: number) => `\x1b[?${code}$p` },
    { query: "XTSMGRAPHICS", sequence: () => "\x1b[?2;1;0S" },
    { query: "the kitty keyboard query", sequence: (code: number) => `\x1b[?${code}u` },
    { query: "an l after an intermediate", sequence: (code: number) => `\x1b[?${code}$l` },
  ]
  const cases = modes.flatMap((mode) => queries.map((query) => ({ ...mode, ...query })))

  test.each(cases)("$query after CSI ? $code h leaves $name set and sends no reply", ({ code, name, sequence }) => {
    const onResponse = vi.fn()
    const s = createScreen({ cols: 80, rows: 24, onResponse })
    s.feed(new TextEncoder().encode(`\x1b[?${code}h`))
    expect(s.getMode(name)).toBe(true)
    s.feed(new TextEncoder().encode(sequence(code)))
    expect(s.getMode(name)).toBe(true)
    expect(onResponse).not.toHaveBeenCalled()
  })
})
