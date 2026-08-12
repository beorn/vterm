import { describe, test, expect } from "vitest"
import { createVtermScreen } from "../src/index.ts"

const enc = new TextEncoder()

function makeScreen(opts?: { cols?: number; rows?: number }) {
  const responses: string[] = []
  const screen = createVtermScreen({
    cols: opts?.cols ?? 80,
    rows: opts?.rows ?? 24,
    onResponse: (d) => responses.push(d),
  })
  const feed = (s: string) => screen.process(enc.encode(s))
  return { screen, responses, feed }
}

// ── Dynamic colors (OSC 4/5/10/11/12/17/19/21/104/105/110-119) ──

describe("OSC 4 — palette", () => {
  test("query returns stored rgb", () => {
    const { responses, feed } = makeScreen()
    feed("\x1b]4;0;?\x07")
    expect(responses).toHaveLength(1)
    expect(responses[0]).toMatch(/^\x1b\]4;0;rgb:[0-9a-f]{4}\/[0-9a-f]{4}\/[0-9a-f]{4}\x1b\\$/)
  })

  test("set updates palette, query returns new value", () => {
    const { responses, feed } = makeScreen()
    feed("\x1b]4;5;rgb:ff/00/80\x07\x1b]4;5;?\x07")
    expect(responses[0]).toBe("\x1b]4;5;rgb:ffff/0000/8080\x1b\\")
  })

  test("set affects SGR 38;5 rendering", () => {
    const { screen, feed } = makeScreen()
    feed("\x1b]4;9;rgb:12/34/56\x07") // override bright red
    feed("\x1b[38;5;9mX")
    const cell = screen.getCell(0, 0)
    expect(cell.fg).toEqual({ r: 0x12, g: 0x34, b: 0x56 })
  })
})

describe("OSC 104 — reset palette", () => {
  test("bare OSC 104 resets all entries", () => {
    const { screen, feed } = makeScreen()
    feed("\x1b]4;1;rgb:ff/ff/ff\x07") // mutate red → white
    feed("\x1b]104\x07") // reset all
    feed("\x1b[38;5;1mX") // palette 1 (default dark red 0x80)
    const cell = screen.getCell(0, 0)
    expect(cell.fg).toEqual({ r: 0x80, g: 0, b: 0 })
  })

  test("indexed reset resets only specified entries", () => {
    const { screen, feed } = makeScreen()
    feed("\x1b]4;1;rgb:ff/ff/ff\x07\x1b]4;2;rgb:ff/ff/ff\x07")
    feed("\x1b]104;1\x07") // reset only index 1
    feed("\x1b[38;5;1m1\x1b[38;5;2m2")
    expect(screen.getCell(0, 0).fg).toEqual({ r: 0x80, g: 0, b: 0 }) // reset
    expect(screen.getCell(0, 1).fg).toEqual({ r: 0xff, g: 0xff, b: 0xff }) // kept
  })
})

describe("OSC 5 — special colors", () => {
  test("set+query round-trip", () => {
    const { responses, feed } = makeScreen()
    feed("\x1b]5;0;rgb:10/20/30\x07\x1b]5;0;?\x07")
    expect(responses[0]).toBe("\x1b]5;0;rgb:1010/2020/3030\x1b\\")
  })
})

describe("OSC 10/11/12 — default fg/bg/cursor", () => {
  test.each([
    [10, "\x1b]10;?\x07", /^\x1b\]10;rgb:ffff\/ffff\/ffff\x1b\\$/],
    [11, "\x1b]11;?\x07", /^\x1b\]11;rgb:0000\/0000\/0000\x1b\\$/],
    [12, "\x1b]12;?\x07", /^\x1b\]12;rgb:ffff\/ffff\/ffff\x1b\\$/],
  ])("OSC %d query", (_code, query, pattern) => {
    const { responses, feed } = makeScreen()
    feed(query)
    expect(responses[0]).toMatch(pattern)
  })

  test("OSC 10 set persists and query reflects it", () => {
    const { responses, feed } = makeScreen()
    feed("\x1b]10;rgb:12/34/56\x07\x1b]10;?\x07")
    expect(responses[0]).toBe("\x1b]10;rgb:1212/3434/5656\x1b\\")
  })

  test("OSC 110 resets fg back to default", () => {
    const { responses, feed } = makeScreen()
    feed("\x1b]10;rgb:12/34/56\x07\x1b]110\x07\x1b]10;?\x07")
    expect(responses[0]).toBe("\x1b]10;rgb:ffff/ffff/ffff\x1b\\")
  })
})

describe("OSC 13/14 — pointer colors", () => {
  test("pointer fg/bg query returns default colors", () => {
    const { responses, feed } = makeScreen()
    feed("\x1b]13;?\x07\x1b]14;?\x07")
    expect(responses[0]).toBe("\x1b]13;rgb:ffff/ffff/ffff\x1b\\")
    expect(responses[1]).toBe("\x1b]14;rgb:0000/0000/0000\x1b\\")
  })

  test("OSC 113/114 reset pointer colors", () => {
    const { responses, feed } = makeScreen()
    feed("\x1b]13;rgb:12/34/56\x07\x1b]14;rgb:65/43/21\x07")
    feed("\x1b]113\x07\x1b]114\x07\x1b]13;?\x07\x1b]14;?\x07")
    expect(responses[0]).toBe("\x1b]13;rgb:ffff/ffff/ffff\x1b\\")
    expect(responses[1]).toBe("\x1b]14;rgb:0000/0000/0000\x1b\\")
  })
})

describe("OSC 17/19 — highlight colors", () => {
  test("set/query highlight bg", () => {
    const { responses, feed } = makeScreen()
    feed("\x1b]17;rgb:a0/b0/c0\x07\x1b]17;?\x07")
    expect(responses[0]).toBe("\x1b]17;rgb:a0a0/b0b0/c0c0\x1b\\")
  })

  test("OSC 117 resets highlight bg", () => {
    const { responses, feed } = makeScreen()
    feed("\x1b]17;rgb:a0/b0/c0\x07\x1b]117\x07\x1b]17;?\x07")
    expect(responses[0]).toBe("\x1b]17;rgb:ffff/ffff/ffff\x1b\\")
  })
})

describe("OSC 30001/30101 — Kitty color stack", () => {
  test("push/pop restores dynamic colors and palette entries", () => {
    const { responses, feed } = makeScreen()
    feed("\x1b]10;rgb:10/20/30\x07\x1b]4;1;rgb:40/50/60\x07")
    feed("\x1b]30001\x07")
    feed("\x1b]10;rgb:aa/bb/cc\x07\x1b]4;1;rgb:dd/ee/ff\x07")
    feed("\x1b]30101\x07")
    feed("\x1b]10;?\x07\x1b]4;1;?\x07")
    expect(responses[0]).toBe("\x1b]10;rgb:1010/2020/3030\x1b\\")
    expect(responses[1]).toBe("\x1b]4;1;rgb:4040/5050/6060\x1b\\")
  })

  test("pop with an empty stack is a no-op", () => {
    const { responses, feed } = makeScreen()
    feed("\x1b]10;rgb:10/20/30\x07\x1b]30101\x07\x1b]10;?\x07")
    expect(responses[0]).toBe("\x1b]10;rgb:1010/2020/3030\x1b\\")
  })
})

describe("OSC 21 — Kitty key=value colors", () => {
  test("multiple queries yield joined response", () => {
    const { responses, feed } = makeScreen()
    feed("\x1b]21;foreground=?;color5=?\x07")
    expect(responses[0]).toMatch(
      /^\x1b\]21;foreground=rgb:[0-9a-f]{4}\/[0-9a-f]{4}\/[0-9a-f]{4};color5=rgb:[0-9a-f]{4}\/[0-9a-f]{4}\/[0-9a-f]{4}\x1b\\$/,
    )
  })

  test("set with value updates state", () => {
    const { responses, feed } = makeScreen()
    feed("\x1b]21;foreground=rgb:de/ad/be\x07\x1b]10;?\x07")
    expect(responses[0]).toBe("\x1b]10;rgb:dede/adad/bebe\x1b\\")
  })
})

// ── Tab stops (HTS / TBC / CHT / CBT) ──

describe("tab stops", () => {
  test("default tab stops every 8 cols", () => {
    const { screen, feed } = makeScreen()
    feed("\t")
    expect(screen.getCursor().col).toBe(8)
  })

  test("HTS sets a custom stop, TAB lands on it", () => {
    const { screen, feed } = makeScreen()
    feed("\x1b[3g") // clear all
    feed("\x1b[6GX") // write at col 6 (cursor now at col 6 (1-based) = 5)
    feed("\x1bH") // HTS at col 6 (but cursor advanced past X to col 6); actually move cursor explicitly
    feed("\x1b[1G") // col 1
    feed("\x1b[6G") // col 6
    feed("\x1bH") // HTS at col 5 (0-based)
    feed("\x1b[1G\t") // from col 0, tab
    expect(screen.getCursor().col).toBe(5)
  })

  test("TBC 3 clears all stops → TAB does not move", () => {
    const { screen, feed } = makeScreen()
    feed("\x1b[3g") // clear all
    feed("\t")
    expect(screen.getCursor().col).toBe(0)
  })

  test("CHT advances by N stops", () => {
    const { screen, feed } = makeScreen()
    feed("\x1b[2I") // forward 2 stops from col 0
    expect(screen.getCursor().col).toBe(16)
  })

  test("CBT goes back by N stops", () => {
    const { screen, feed } = makeScreen()
    feed("\x1b[21G") // col 21 (0-based: 20)
    feed("\x1b[Z") // back 1 stop → col 16
    expect(screen.getCursor().col).toBe(16)
  })
})

// ── HPA ──

describe("HPA (CSI `)", () => {
  test("moves cursor to absolute column", () => {
    const { screen, feed } = makeScreen()
    feed("ABCDEF\x1b[3`") // HPA 3 → col 2 (0-based)
    expect(screen.getCursor().col).toBe(2)
  })
})

// ── DECALN ──

describe("DECALN (ESC # 8)", () => {
  test("fills screen with 'E' and homes cursor", () => {
    const { screen, feed } = makeScreen({ cols: 10, rows: 5 })
    feed("\x1b[5;7H") // move cursor away from home
    feed("\x1b#8")
    expect(screen.getCell(0, 0).char).toBe("E")
    expect(screen.getCell(4, 9).char).toBe("E")
    expect(screen.getCursor()).toEqual({ col: 0, row: 0 })
  })
})

// ── Rectangular area ops ──

describe("rectangular area operations", () => {
  test("DECFRA fills rectangle with specified character", () => {
    const { screen, feed } = makeScreen({ cols: 20, rows: 5 })
    feed("\x1b[88;1;1;3;5$x") // fill rows 1-3, cols 1-5 with 'X' (88)
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 5; c++) {
        expect(screen.getCell(r, c).char).toBe("X")
      }
    }
  })

  test("DECERA erases rectangle", () => {
    const { screen, feed } = makeScreen({ cols: 20, rows: 5 })
    feed("HELLO\r\nWORLD\x1b[1;1;2;5$z") // erase rows 1-2 cols 1-5
    expect(screen.getCell(0, 0).char).not.toBe("H")
    expect(screen.getCell(1, 0).char).not.toBe("W")
  })

  test("DECSERA (selective erase) behaves like DECERA in absence of DECSCA", () => {
    const { screen, feed } = makeScreen({ cols: 20, rows: 5 })
    feed("HELLO\x1b[1;1;1;5${")
    for (let c = 0; c < 5; c++) {
      expect(screen.getCell(0, c).char).not.toBe("HELLO"[c])
    }
  })

  test("DECCRA copies rectangle preserving source", () => {
    const { screen, feed } = makeScreen({ cols: 20, rows: 5 })
    feed("HELLO\x1b[1;1;1;5;1;3;1$v") // copy row 1 cols 1-5 → row 3 col 1
    expect(screen.getCell(0, 0).char).toBe("H") // source still there
    expect(screen.getCell(2, 0).char).toBe("H")
    expect(screen.getCell(2, 4).char).toBe("O")
  })

  test("DECCARA applies inverse to rectangle", () => {
    const { screen, feed } = makeScreen({ cols: 20, rows: 5 })
    feed("AAAAA\r\nBBBBB\x1b[1;1;2;5;7$r") // inverse on rows 1-2, cols 1-5
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 5; c++) {
        expect(screen.getCell(r, c).inverse).toBe(true)
      }
    }
  })

  test("DECRARA toggles inverse in rectangle", () => {
    const { screen, feed } = makeScreen({ cols: 20, rows: 5 })
    feed("\x1b[7mAAAAA\x1b[0m\x1b[1;1;1;5;7$t") // toggle inverse
    for (let c = 0; c < 5; c++) {
      expect(screen.getCell(0, c).inverse).toBe(false)
    }
  })

  test("DECRQCRA responds with checksum DCS", () => {
    const { responses, feed } = makeScreen()
    feed("ABCDE\x1b[1;1;1;1;1;5*y") // checksum of row 1 cols 1-5, pid=1
    expect(responses.length).toBeGreaterThan(0)
    expect(responses[0]).toMatch(/^\x1bP1!~[0-9A-F]+\x1b\\$/)
  })
})

// ── Column editing (SL / SR / DECIC / DECDC) ──

describe("column editing", () => {
  test("SL shifts columns left", () => {
    const { screen, feed } = makeScreen({ cols: 10, rows: 2 })
    feed("1234567\x1b[2 @") // SL 2
    expect(screen.getCell(0, 0).char).toBe("3")
    expect(screen.getCell(0, 4).char).toBe("7")
  })

  test("SR shifts columns right", () => {
    const { screen, feed } = makeScreen({ cols: 10, rows: 2 })
    feed("1234567\x1b[2 A") // SR 2
    // cols 0-1 should be blank, col 2 = '1'
    expect(screen.getCell(0, 0).char).not.toBe("1")
    expect(screen.getCell(0, 2).char).toBe("1")
  })

  test("DECIC inserts blank column at cursor", () => {
    const { screen, feed } = makeScreen({ cols: 10, rows: 3 })
    feed("ABCDE\r\nFGHIJ\x1b[1;3H\x1b[2'}") // at row 1 col 3, insert 2 cols
    expect(screen.getCell(0, 0).char).toBe("A")
    expect(screen.getCell(0, 1).char).toBe("B")
    expect(screen.getCell(0, 4).char).toBe("C")
    // DECIC is a column operation — affects ALL rows
    expect(screen.getCell(1, 0).char).toBe("F")
    expect(screen.getCell(1, 4).char).toBe("H")
  })

  test("DECDC deletes columns at cursor", () => {
    const { screen, feed } = makeScreen({ cols: 10, rows: 3 })
    feed("ABCDE\r\nFGHIJ\x1b[1;2H\x1b[2'~") // at row 1 col 2, delete 2 cols
    expect(screen.getCell(0, 0).char).toBe("A")
    expect(screen.getCell(0, 1).char).toBe("D")
    expect(screen.getCell(0, 2).char).toBe("E")
    // DECDC affects ALL rows
    expect(screen.getCell(1, 0).char).toBe("F")
    expect(screen.getCell(1, 1).char).toBe("I")
  })
})

// ── Modes (DECCOLM, altscreen-1048, alt-scroll-1007, utf8-mouse-1005) ──

describe("new mode tracking", () => {
  test("?3 DECCOLM — DECRPM reports set/reset", () => {
    const { responses, feed } = makeScreen()
    feed("\x1b[?3h\x1b[?3$p")
    expect(responses[0]).toMatch(/\x1b\[\?3;1\$y/)
    responses.length = 0
    feed("\x1b[?3l\x1b[?3$p")
    expect(responses[0]).toMatch(/\x1b\[\?3;2\$y/)
  })

  test("?3 DECCOLM clears screen when toggled", () => {
    const { screen, feed } = makeScreen({ cols: 80, rows: 5 })
    feed("HELLO\x1b[?3h")
    expect(screen.getCell(0, 0).char).not.toBe("H")
  })

  test("?1005 utf8 mouse — trackable via DECRPM", () => {
    const { responses, feed } = makeScreen()
    feed("\x1b[?1005h\x1b[?1005$p")
    expect(responses[0]).toMatch(/\x1b\[\?1005;1\$y/)
  })

  test("?1007 alt-scroll — trackable via DECRPM", () => {
    const { responses, feed } = makeScreen()
    feed("\x1b[?1007h\x1b[?1007$p")
    expect(responses[0]).toMatch(/\x1b\[\?1007;1\$y/)
  })

  test("?1048 save/restore cursor", () => {
    const { screen, feed } = makeScreen()
    feed("\x1b[5;10H\x1b[?1048h\x1b[15;20H\x1b[?1048l")
    expect(screen.getCursor()).toEqual({ col: 9, row: 4 })
  })
})

// ── XTWINOPS window reports ──

describe("XTWINOPS window reports", () => {
  test("CSI 14 t → window pixel size", () => {
    const { responses, feed } = makeScreen({ cols: 80, rows: 24 })
    feed("\x1b[14t")
    expect(responses[0]).toMatch(/^\x1b\[4;\d+;\d+t$/)
  })

  test("CSI 16 t → cell pixel size", () => {
    const { responses, feed } = makeScreen()
    feed("\x1b[16t")
    expect(responses[0]).toBe("\x1b[6;16;8t")
  })

  test("CSI 18 t → text area in chars", () => {
    const { responses, feed } = makeScreen({ cols: 120, rows: 40 })
    feed("\x1b[18t")
    expect(responses[0]).toBe("\x1b[8;40;120t")
  })

  test("CSI 21 t → window title as OSC l", () => {
    const { responses, feed } = makeScreen()
    feed("\x1b]2;hello\x07\x1b[21t")
    expect(responses[0]).toMatch(/^\x1b\]lhello\x1b\\$/)
  })

  test("CSI 20 t → icon label as OSC L", () => {
    const { responses, feed } = makeScreen()
    feed("\x1b]2;hello\x07\x1b[20t")
    expect(responses[0]).toMatch(/^\x1b\]Lhello\x1b\\$/)
  })
})
