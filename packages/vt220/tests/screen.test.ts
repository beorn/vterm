import { describe, test, expect, vi } from "vitest"
import { createVt220Screen, type Vt220Screen } from "../src/index.ts"

/** Helper: create a screen and return it with convenience methods. */
function createScreen(opts: {
  cols: number
  rows: number
  scrollbackLimit?: number
  onResponse?: (data: string) => void
}): {
  screen: Vt220Screen
  feed: (data: Uint8Array) => void
  getText: () => string
  getCell: (row: number, col: number) => ReturnType<Vt220Screen["getCell"]>
  getLine: (row: number) => ReturnType<Vt220Screen["getLine"]>
  getLines: () => ReturnType<Vt220Screen["getLine"]>[]
  getCursor: () => { x: number; y: number; visible: boolean; style: string }
  getMode: (mode: string) => boolean
  getTitle: () => string
  getTextRange: (sr: number, sc: number, er: number, ec: number) => string
  getScrollback: () => { viewportOffset: number; totalLines: number; screenLines: number }
  scrollViewport: (delta: number) => void
  resize: (cols: number, rows: number) => void
  reset: () => void
} {
  const screen = createVt220Screen(opts)
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

describe("Vt220Screen", () => {
  // ── Lifecycle ──

  test("creates screen with specified dimensions", () => {
    const s = createScreen({ cols: 80, rows: 24 })
    const cursor = s.getCursor()
    expect(cursor.x).toBe(0)
    expect(cursor.y).toBe(0)
    const text = s.getText()
    expect(text).toBeDefined()
  })

  // ── 8 standard colors (VT220 feature) ──

  test("feed ANSI color codes, getCell() has correct fg color", () => {
    const s = createScreen({ cols: 80, rows: 24 })
    // SGR 31 = red foreground (ANSI color 1)
    s.feed(new TextEncoder().encode("\x1b[31mR\x1b[0m"))
    const cell = s.getCell(0, 0)
    expect(cell.char).toBe("R")
    expect(cell.fg).not.toBeNull()
    expect(cell.fg!.r).toBe(0x80)
    expect(cell.fg!.g).toBe(0)
    expect(cell.fg!.b).toBe(0)
  })

  test("feed text with background color, getCell() has correct bg", () => {
    const s = createScreen({ cols: 80, rows: 24 })
    // SGR 42 = green background (ANSI color 2)
    s.feed(new TextEncoder().encode("\x1b[42mG\x1b[0m"))
    const cell = s.getCell(0, 0)
    expect(cell.char).toBe("G")
    expect(cell.bg).not.toBeNull()
    expect(cell.bg!.r).toBe(0)
    expect(cell.bg!.g).toBe(0x80)
    expect(cell.bg!.b).toBe(0)
  })

  test("all 8 standard foreground colors", () => {
    const s = createScreen({ cols: 80, rows: 24 })
    for (let i = 0; i < 8; i++) {
      s.feed(new TextEncoder().encode(`\x1b[${30 + i}mX`))
    }
    const black = s.getCell(0, 0)
    expect(black.fg).not.toBeNull()
    expect(black.fg!.r).toBe(0)
    expect(black.fg!.g).toBe(0)
    expect(black.fg!.b).toBe(0)

    const white = s.getCell(0, 7)
    expect(white.fg).not.toBeNull()
    expect(white.fg!.r).toBe(0xc0)
    expect(white.fg!.g).toBe(0xc0)
    expect(white.fg!.b).toBe(0xc0)
  })

  test("all 8 standard background colors", () => {
    const s = createScreen({ cols: 80, rows: 24 })
    for (let i = 0; i < 8; i++) {
      s.feed(new TextEncoder().encode(`\x1b[${40 + i}mX`))
    }
    const black = s.getCell(0, 0)
    expect(black.bg).not.toBeNull()
    expect(black.bg!.r).toBe(0)

    const white = s.getCell(0, 7)
    expect(white.bg).not.toBeNull()
    expect(white.bg!.r).toBe(0xc0)
  })

  test("SGR 39 resets foreground to default", () => {
    const s = createScreen({ cols: 80, rows: 24 })
    s.feed(new TextEncoder().encode("\x1b[31mR\x1b[39mN"))
    const red = s.getCell(0, 0)
    expect(red.fg).not.toBeNull()
    const normal = s.getCell(0, 1)
    expect(normal.fg).toBeNull()
  })

  test("SGR 49 resets background to default", () => {
    const s = createScreen({ cols: 80, rows: 24 })
    s.feed(new TextEncoder().encode("\x1b[41mR\x1b[49mN"))
    const red = s.getCell(0, 0)
    expect(red.bg).not.toBeNull()
    const normal = s.getCell(0, 1)
    expect(normal.bg).toBeNull()
  })

  // ── Text attributes ──

  test("bold attribute", () => {
    const s = createScreen({ cols: 80, rows: 24 })
    s.feed(new TextEncoder().encode("\x1b[1mB\x1b[0m"))
    expect(s.getCell(0, 0).bold).toBe(true)
  })

  test("underline attribute", () => {
    const s = createScreen({ cols: 80, rows: 24 })
    s.feed(new TextEncoder().encode("\x1b[4mU\x1b[0m"))
    expect(s.getCell(0, 0).underline).toBe(true)
  })

  test("blink attribute", () => {
    const s = createScreen({ cols: 80, rows: 24 })
    s.feed(new TextEncoder().encode("\x1b[5mB\x1b[0m"))
    expect(s.getCell(0, 0).blink).toBe(true)
  })

  test("inverse attribute", () => {
    const s = createScreen({ cols: 80, rows: 24 })
    s.feed(new TextEncoder().encode("\x1b[7mI\x1b[0m"))
    expect(s.getCell(0, 0).inverse).toBe(true)
  })

  test("hidden/conceal attribute (SGR 8/28)", () => {
    const s = createScreen({ cols: 80, rows: 24 })
    s.feed(new TextEncoder().encode("\x1b[8mH\x1b[28mV"))
    expect(s.getCell(0, 0).hidden).toBe(true)
    expect(s.getCell(0, 1).hidden).toBe(false)
  })

  test("combined bold + color attributes", () => {
    const s = createScreen({ cols: 80, rows: 24 })
    s.feed(new TextEncoder().encode("\x1b[1;31mX\x1b[0m"))
    const cell = s.getCell(0, 0)
    expect(cell.bold).toBe(true)
    expect(cell.fg).not.toBeNull()
    expect(cell.fg!.r).toBe(0x80)
  })

  // ── Insert mode (IRM) — VT220 feature ──

  test("insert mode (IRM) via standard CSI 4h/4l", () => {
    const s = createScreen({ cols: 80, rows: 24 })
    expect(s.getMode("insertMode")).toBe(false)
    s.feed(new TextEncoder().encode("\x1b[4h"))
    expect(s.getMode("insertMode")).toBe(true)
    s.feed(new TextEncoder().encode("\x1b[4l"))
    expect(s.getMode("insertMode")).toBe(false)
  })

  // ── Insert/delete characters — VT220 features ──

  describe("insert/delete characters", () => {
    test("DCH deletes characters at cursor position", () => {
      const s = createScreen({ cols: 10, rows: 3 })
      s.feed(new TextEncoder().encode("ABCDE"))

      // Move cursor to col 1 (B)
      s.feed(new TextEncoder().encode("\x1b[1;2H"))
      // Delete 2 characters (CSI 2 P)
      s.feed(new TextEncoder().encode("\x1b[2P"))

      const line = s.getLine(0)
      expect(line[0]!.char).toBe("A")
      expect(line[1]!.char).toBe("D")
      expect(line[2]!.char).toBe("E")
      expect(line[3]!.char).toBe("")
      expect(line[4]!.char).toBe("")
    })

    test("ICH inserts blank characters at cursor position", () => {
      const s = createScreen({ cols: 10, rows: 3 })
      s.feed(new TextEncoder().encode("ABCDE"))

      // Move cursor to col 2 (C)
      s.feed(new TextEncoder().encode("\x1b[1;3H"))
      // Insert 2 blank characters (CSI 2 @)
      s.feed(new TextEncoder().encode("\x1b[2@"))

      const line = s.getLine(0)
      expect(line[0]!.char).toBe("A")
      expect(line[1]!.char).toBe("B")
      expect(line[2]!.char).toBe("") // inserted blank
      expect(line[3]!.char).toBe("") // inserted blank
      expect(line[4]!.char).toBe("C")
      expect(line[5]!.char).toBe("D")
      expect(line[6]!.char).toBe("E")
    })

    test("ECH erases characters without moving cursor", () => {
      const s = createScreen({ cols: 10, rows: 3 })
      s.feed(new TextEncoder().encode("ABCDE"))

      // Move cursor to col 1 (B)
      s.feed(new TextEncoder().encode("\x1b[1;2H"))
      // Erase 2 characters (CSI 2 X)
      s.feed(new TextEncoder().encode("\x1b[2X"))

      const line = s.getLine(0)
      expect(line[0]!.char).toBe("A")
      expect(line[1]!.char).toBe("") // erased
      expect(line[2]!.char).toBe("") // erased
      expect(line[3]!.char).toBe("D")
      expect(line[4]!.char).toBe("E")
      // Cursor should not have moved
      expect(s.getCursor().x).toBe(1)
    })
  })

  // ── Insert/delete lines — VT220 features ──

  describe("insert/delete lines", () => {
    test("IL inserts a blank line at cursor", () => {
      const s = createScreen({ cols: 10, rows: 5 })
      const enc = (str: string) => new TextEncoder().encode(str)

      s.feed(enc("LINE0\r\n"))
      s.feed(enc("LINE1\r\n"))
      s.feed(enc("LINE2\r\n"))
      s.feed(enc("LINE3\r\n"))
      s.feed(enc("LINE4"))

      // Move cursor to row 1
      s.feed(enc("\x1b[2;1H"))
      // Insert 1 line (CSI L)
      s.feed(enc("\x1b[L"))

      // Row 0 should still be LINE0
      expect(s.getLine(0)[4]!.char).toBe("0")
      // Row 1 should be blank (inserted)
      expect(s.getLine(1)[0]!.char).toBe("")
      // Row 2 should now have LINE1 (pushed down)
      expect(s.getLine(2)[4]!.char).toBe("1")
    })

    test("DL deletes line at cursor", () => {
      const s = createScreen({ cols: 10, rows: 5 })
      const enc = (str: string) => new TextEncoder().encode(str)

      s.feed(enc("LINE0\r\n"))
      s.feed(enc("LINE1\r\n"))
      s.feed(enc("LINE2\r\n"))
      s.feed(enc("LINE3\r\n"))
      s.feed(enc("LINE4"))

      // Move cursor to row 1
      s.feed(enc("\x1b[2;1H"))
      // Delete 1 line (CSI M)
      s.feed(enc("\x1b[M"))

      // Row 0 should still be LINE0
      expect(s.getLine(0)[4]!.char).toBe("0")
      // Row 1 should now have LINE2 (pulled up)
      expect(s.getLine(1)[4]!.char).toBe("2")
      // Last row should be blank
      expect(s.getLine(4)[0]!.char).toBe("")
    })
  })

  // ── DECSTR soft reset — VT220 feature ──

  test("DECSTR (CSI ! p) resets modes but not screen", () => {
    const s = createScreen({ cols: 80, rows: 24 })
    s.feed(new TextEncoder().encode("hello"))
    s.feed(new TextEncoder().encode("\x1b[?1h")) // application cursor on
    s.feed(new TextEncoder().encode("\x1b[?25l")) // cursor invisible
    s.feed(new TextEncoder().encode("\x1b=")) // application keypad on
    expect(s.getMode("applicationCursor")).toBe(true)
    expect(s.getCursor().visible).toBe(false)
    expect(s.getMode("applicationKeypad")).toBe(true)

    // Soft reset
    s.feed(new TextEncoder().encode("\x1b[!p"))

    // Modes should be reset
    expect(s.getMode("applicationCursor")).toBe(false)
    expect(s.getCursor().visible).toBe(true)
    expect(s.getMode("applicationKeypad")).toBe(false)

    // But content should still be there
    expect(s.getText()).toContain("hello")
  })

  // ── Device responses — VT220 ──

  test("DA1 response (CSI c) — VT220", () => {
    const onResponse = vi.fn()
    const s = createScreen({ cols: 80, rows: 24, onResponse })
    s.feed(new TextEncoder().encode("\x1b[c"))
    expect(onResponse).toHaveBeenCalledWith("\x1b[?62;1;2;6;7;8;9c")
  })

  test("DA2 response (CSI > c) — VT220", () => {
    const onResponse = vi.fn()
    const s = createScreen({ cols: 80, rows: 24, onResponse })
    s.feed(new TextEncoder().encode("\x1b[>c"))
    expect(onResponse).toHaveBeenCalledWith("\x1b[>1;10;0c")
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
    s.feed(new TextEncoder().encode("\x1b[5;10H"))
    s.feed(new TextEncoder().encode("\x1b[6n"))
    expect(onResponse).toHaveBeenCalledWith("\x1b[5;10R")
  })

  // ── DECSED/DECSEL — VT220 selective erase ──

  describe("selective erase", () => {
    test("DECSED (CSI ? J) erases display", () => {
      const s = createScreen({ cols: 80, rows: 24 })
      s.feed(new TextEncoder().encode("hello"))
      // DECSED mode 2 — erase entire display
      s.feed(new TextEncoder().encode("\x1b[?2J"))
      expect(s.getText().trim()).toBe("")
    })

    test("DECSEL (CSI ? K) erases line", () => {
      const s = createScreen({ cols: 80, rows: 24 })
      s.feed(new TextEncoder().encode("hello world"))
      // Move cursor to col 5, DECSEL mode 0 — erase from cursor to end
      s.feed(new TextEncoder().encode("\x1b[1;6H\x1b[?K"))
      const text = s.getText()
      expect(text).toContain("hello")
      expect(text).not.toContain("world")
    })
  })

  // ── Cursor movement (inherited from VT100) ──

  test("cursor positioning via CSI H", () => {
    const s = createScreen({ cols: 80, rows: 24 })
    s.feed(new TextEncoder().encode("\x1b[5;10H"))
    expect(s.getCursor().x).toBe(9)
    expect(s.getCursor().y).toBe(4)
  })

  test("DECSC/DECRC saves and restores cursor", () => {
    const s = createScreen({ cols: 80, rows: 24 })
    s.feed(new TextEncoder().encode("\x1b[10;20H"))
    s.feed(new TextEncoder().encode("\x1b7"))
    s.feed(new TextEncoder().encode("\x1b[1;1H"))
    s.feed(new TextEncoder().encode("\x1b8"))
    expect(s.getCursor().x).toBe(19)
    expect(s.getCursor().y).toBe(9)
  })

  // ── Scroll regions (inherited from VT100) ──

  test("scroll region respects DECSTBM", () => {
    const s = createScreen({ cols: 80, rows: 10 })
    s.feed(new TextEncoder().encode("\x1b[3;7r"))
    expect(s.getCursor().x).toBe(0)
    expect(s.getCursor().y).toBe(0)
  })

  // ── Modes (inherited from VT100) ──

  test("autowrap mode", () => {
    const s = createScreen({ cols: 80, rows: 24 })
    expect(s.getMode("autoWrap")).toBe(true)
    s.feed(new TextEncoder().encode("\x1b[?7l"))
    expect(s.getMode("autoWrap")).toBe(false)
  })

  test("application cursor mode (DECCKM)", () => {
    const s = createScreen({ cols: 80, rows: 24 })
    expect(s.getMode("applicationCursor")).toBe(false)
    s.feed(new TextEncoder().encode("\x1b[?1h"))
    expect(s.getMode("applicationCursor")).toBe(true)
  })

  test("application keypad mode via DECKPAM/DECKPNM", () => {
    const s = createScreen({ cols: 80, rows: 24 })
    expect(s.getMode("applicationKeypad")).toBe(false)
    s.feed(new TextEncoder().encode("\x1b="))
    expect(s.getMode("applicationKeypad")).toBe(true)
    s.feed(new TextEncoder().encode("\x1b>"))
    expect(s.getMode("applicationKeypad")).toBe(false)
  })

  // ── ESC sequences (inherited from VT100) ──

  test("IND (ESC D) moves cursor down", () => {
    const s = createScreen({ cols: 10, rows: 3 })
    s.feed(new TextEncoder().encode("LINE0\r\nLINE1\r\nLINE2"))
    s.feed(new TextEncoder().encode("\x1bD"))
    expect(s.getCursor().y).toBe(2)
  })

  test("RI (ESC M) moves cursor up", () => {
    const s = createScreen({ cols: 10, rows: 3 })
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
    s.feed(new TextEncoder().encode("\x1bc"))
    expect(s.getText().trim()).toBe("")
  })

  // ── Forward compatibility ──

  test("256-color and truecolor SGR sequences are silently ignored", () => {
    const s = createScreen({ cols: 80, rows: 24 })
    s.feed(new TextEncoder().encode("\x1b[38;5;208mX\x1b[0m"))
    s.feed(new TextEncoder().encode("\x1b[38;2;100;200;50mY\x1b[0m"))
    const cellX = s.getCell(0, 0)
    expect(cellX.char).toBe("X")
    expect(cellX.fg).toBeNull()
  })

  test("unknown private modes are silently ignored", () => {
    const s = createScreen({ cols: 80, rows: 24 })
    s.feed(new TextEncoder().encode("\x1b[?1000h"))
    s.feed(new TextEncoder().encode("\x1b[?2004h"))
    s.feed(new TextEncoder().encode("\x1b[?1049h"))
    s.feed(new TextEncoder().encode("ABC"))
    expect(s.getText()).toContain("ABC")
  })
})

describe("snapshot / restore (vt220 subset)", () => {
  const enc2 = new TextEncoder()
  const feedStr = (screen: Vt220Screen, s: string) => screen.process(enc2.encode(s))

  function scenarioScreen(): Vt220Screen {
    const screen = createVt220Screen({ cols: 20, rows: 4 })
    feedStr(screen, "\x1b]0;my-title\x07")
    feedStr(screen, "\x1b[?6h") // origin mode
    feedStr(screen, "\x1b[4h") // insert mode
    feedStr(screen, "\x1b[2;3r") // scroll region
    feedStr(screen, "\x1b[1;31mred\x1b[0m plain\r\n")
    feedStr(screen, "a\r\nb\r\nc\r\nd\r\ne\r\nf") // pushes rows into scrollback
    return screen
  }

  test("round-trips grid, scrollback, cursor, title, modes, and scroll region", () => {
    const original = scenarioScreen()
    const restored = createVt220Screen({ cols: 20, rows: 4 })
    restored.restore(original.snapshot())

    expect(restored.getText()).toBe(original.getText())
    expect(restored.getCursorPosition()).toEqual(original.getCursorPosition())
    expect(restored.getTitle()).toBe("my-title")
    expect(restored.getScrollbackLength()).toBe(original.getScrollbackLength())
    for (const mode of ["originMode", "insertMode", "autoWrap", "reverseVideo"]) {
      expect(restored.getMode(mode)).toBe(original.getMode(mode))
    }
    expect(restored.getCell(0, 0)).toEqual(original.getCell(0, 0))
  })

  test("restored screens continue identically (parser + resize state survive)", () => {
    const original = scenarioScreen()
    feedStr(original, "\x1b[") // park the parser mid-CSI at a cut point
    const restored = createVt220Screen({ cols: 20, rows: 4 })
    restored.restore(original.snapshot())

    for (const screen of [original, restored]) {
      feedStr(screen, "2Jafter") // completes the parked CSI, then text
      screen.resize(30, 6)
      feedStr(screen, " wide")
    }
    expect(restored.getText()).toBe(original.getText())
    expect(restored.getCursorPosition()).toEqual(original.getCursorPosition())
  })

  test("snapshot schema stays locked to the VT220 subset", () => {
    const snapshot = scenarioScreen().snapshot()
    expect(Object.keys(snapshot).sort()).toEqual(
      [
        "attrs",
        "cols",
        "cursor",
        "grid",
        "modes",
        "parser",
        "rows",
        "savedState",
        "scrollRegion",
        "scrollback",
        "scrollbackLimit",
        "title",
        "version",
        "viewportOffset",
      ].sort(),
    )
    // vterm-only capabilities must not leak into the vt220 schema.
    const flat = JSON.stringify(snapshot)
    for (const forbidden of ["altScreen", "sixel", "hyperlink", "kitty", "semanticZone", "clipboard", "mouse"]) {
      expect(flat).not.toContain(forbidden)
    }
  })

  test("restore refuses unknown versions and malformed shapes loudly", () => {
    const screen = createVt220Screen({ cols: 10, rows: 3 })
    const good = screen.snapshot()
    expect(() => screen.restore({ ...good, version: 2 as never })).toThrow(/version/)
    expect(() => screen.restore({ ...good, grid: "nope" as never })).toThrow(/grid/)
    expect(() => screen.restore(null as never)).toThrow(/Invalid/)
  })

  test("snapshot is a deep copy — later output does not mutate it", () => {
    const screen = createVt220Screen({ cols: 10, rows: 3 })
    feedStr(screen, "before")
    const snapshot = screen.snapshot()
    feedStr(screen, "\x1b[2Jafter")
    const restored = createVt220Screen({ cols: 10, rows: 3 })
    restored.restore(snapshot)
    expect(restored.getText()).toContain("before")
    expect(restored.getText()).not.toContain("after")
  })
})
