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
 * cursor (position + visibility + shape/blink), pending pen, modes (minus the
 * documented exclusion set), margins, active buffer, tab stops, charset, default/
 * palette colors, and scrollback soft-wrap bits must equal the source's. Output
 * assumes a fresh/reset sink — it does not clear modes it never set.
 *
 * Intended divergences (documented in stateView below, asserted never-silent):
 * syncOutput + decColumn are NEVER emitted (wedge/erase traps); the inactive buffer,
 * SCP saved cursor, DECSC saved state, color/kitty stacks-by-construction limits,
 * and parser/pending-wrap/mid-parse state are unserializable-to-VT by design.
 */
import { describe, expect, test } from "vitest"
import {
  createVtermScreen,
  serializeSnapshot,
  type ScreenCell,
  type VtermScreen,
  type Snapshot,
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

/**
 * Modes NEVER emitted and NEVER compared — each with the reason it is excluded:
 * - syncOutput: a static restore never sends the closing `?2026l`, so emitting
 *   `?2026h` wedges a real receiver (vterm itself ignores it in the write path,
 *   which is exactly why a round-trip oracle alone cannot police it — golden 7
 *   asserts raw absence instead).
 * - decColumn: `?3h/l` erases the whole screen and homes the cursor (DEC spec),
 *   destroying the paint it would follow.
 * - kittyGraphics: a latch with no image data behind it.
 */
const EXCLUDED_MODES = ["syncOutput", "decColumn", "kittyGraphics"] as const

/**
 * The non-cell state the serializer must round-trip. Documented exclusions
 * (unserializable-to-VT by design, deliberately absent from this view):
 * cursor.savedX/savedY (the `?1049h` alt-enter clobbers the SCP slot),
 * savedState (DECSC reconstruction deferred — bead non-goal), colors.stack +
 * arbitrary kitty stacks with a non-reconstructable shape (push-only snapshots),
 * clipboard/cwd/notifications (intrusive or append-only receiver side effects),
 * viewportOffset (receiver-owned view state), parser + unicode transients
 * (mid-parse state), grid softWrapped bits (a positioned paint is not a flow —
 * only SCROLLBACK wrap bits survive, and those ARE compared), and the inactive
 * buffer's grid (a byte stream paints one screen; the binary snapshot carries it).
 */
function stateView(snap: Snapshot): Record<string, unknown> {
  const modes: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(snap.modes)) {
    if (!(EXCLUDED_MODES as readonly string[]).includes(key)) modes[key] = value
  }
  return {
    modes,
    activeBuffer: snap.activeBuffer,
    margins: snap.margins,
    cursorShape: snap.cursor.shape,
    cursorBlinking: snap.cursor.blinking,
    tabStops: snap.tabStops,
    charsetG0: snap.unicode.charsetG0,
    // The LAST index is masked on both sides: a true bit there says the final
    // history row wraps INTO visible screen row 0 — a linkage the positioned
    // paint severs by design (a paint is not a flow), so it cannot round-trip.
    scrollbackSoftWrapped: snap.scrollbackSoftWrapped?.map((bit, i, arr) => (i === arr.length - 1 ? false : bit)),
    colors: {
      defaultFgColor: snap.colors.current.defaultFgColor,
      defaultBgColor: snap.colors.current.defaultBgColor,
      palette256: snap.colors.current.palette256,
    },
  }
}

/** Serialize source → feed a fresh same-size sink → assert restore-equivalence. */
function roundTripState(source: VtermScreen, cols: number, rows: number): VtermScreen {
  const snapshot = source.snapshot()
  const ansi = serializeSnapshot(snapshot)
  const sink = mkScreen(cols, rows)
  feed(sink, ansi)

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      expect(cellView(sink.getCell(row, col)), `cell (${row},${col})`).toEqual(cellView(source.getCell(row, col)))
    }
  }
  expect(sink.getCursor(), "cursor position").toEqual(source.getCursor())
  expect(sink.getCursorVisible(), "cursor visibility").toBe(source.getCursorVisible())
  expect(sink.snapshot().attrs, "pending pen").toEqual(snapshot.attrs)
  expect(stateView(sink.snapshot()), "non-cell state (oracle ii)").toEqual(stateView(snapshot))
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
 * Random attributed-screen source. The mode pool covers every emitted mode
 * family (DECSET flags, alt screen, margins, DECSCUSR, charset, kitty,
 * colors, tab stops) — but NOT syncOutput/decColumn, whose destructive
 * set-sequences are excluded by design and pinned by goldens 7/7b instead.
 */
function randomSource(rand: () => number, cols: number, rows: number): VtermScreen {
  const screen = mkScreen(cols, rows)
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!
  const int = (max: number): number => Math.floor(rand() * max)
  const sgrPool = [
    "0",
    "1",
    "2",
    "3",
    "4",
    "4:2",
    "4:3",
    "4:4",
    "4:5",
    "5",
    "7",
    "8",
    "9",
    "53",
    "22",
    "23",
    "24",
    "25",
    "27",
    "29",
    "55",
    "31",
    "42",
    "93",
    "104",
    "39",
    "49",
    "38;2;200;40;120",
    "48;2;10;90;230",
    "38;5;178",
    "48;5;24",
    "58;2;250;250;60",
    "59",
  ] as const
  const words = ["hei", "verden", "汉字", "🎈", "ab c", "x", "…tail"] as const
  const modePool = [
    `${ESC}[?6h`,
    `${ESC}[?6l`,
    `${ESC}[4h`,
    `${ESC}[4l`,
    `${ESC}[?5h`,
    `${ESC}[?1h`,
    `${ESC}=`,
    `${ESC}>`,
    `${ESC}[?2004h`,
    `${ESC}[?1004h`,
    `${ESC}[?1007h`,
    `${ESC}[?2031h`,
    `${ESC}[?1000h`,
    `${ESC}[?1003h`,
    `${ESC}[?1016h`,
    `${ESC}[?1000l`,
    `${ESC}[?1006h`,
    `${ESC}[?1005h`,
    `${ESC}[=5u`,
    `${ESC}[>13u`,
    `${ESC}[<u`,
    `${ESC}[2;4r`,
    `${ESC}[r`,
    `${ESC}[?69h${ESC}[2;10s`,
    `${ESC}[?69l`,
    `${ESC}[3 q`,
    `${ESC}[2 q`,
    `${ESC}[0 q`,
    `${ESC}(0`,
    `${ESC}(B`,
    `${ESC}[?1049h`,
    `${ESC}[?1049l`,
    `${ESC}]10;rgb:aa/bb/cc${ESC}\\`,
    `${ESC}]11;#204060${ESC}\\`,
    `${ESC}]110${ESC}\\`,
    `${ESC}]4;100;rgb:11/22/33${ESC}\\`,
    `${ESC}H`,
    `${ESC}[3g`,
  ] as const
  const opCount = 24 + int(24)
  for (let i = 0; i < opCount; i++) {
    switch (int(7)) {
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
      case 5:
        feed(screen, `${ESC}]8;;${rand() < 0.5 ? "https://x.test/a" : ""}${ESC}\\`)
        break
      default:
        feed(screen, pick(modePool))
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

  test("golden 4: 16/256/truecolor fg+bg all round-trip faithfully", () => {
    // Emission form changed by the indexed-identity fix: 16-color/256 inputs now
    // re-emit their indexed SGR forms (not baked `x8;2;R;G;B`), truecolor stays
    // truecolor. Equivalence still holds either way; the byte spellings are
    // pinned by golden 11/11b/11c below.
    const source = mkScreen(30, 2)
    feed(source, `${ESC}[31;44m16 ${ESC}[38;5;178;48;5;24m256 ${ESC}[38;2;1;2;3;48;2;9;8;7mtru`)
    roundTripState(source, 30, 2)
  })

  test("golden 11: fg indexed identity survives serialization; truecolor stays truecolor", () => {
    // The vterm↔vterm restore oracle is structurally BLIND to this class: both
    // sides resolve `31` → {128,0,0}, so a digest agrees even when the serialized
    // BYTES bake the index into truecolor and defeat the receiver's theme on
    // reattach. These assert on the bytes: an indexed SGR must re-emit its
    // faithful indexed form; true 24-bit color must stay truecolor.
    const source = mkScreen(40, 2)
    feed(source, `${ESC}[31mred ${ESC}[91mbright ${ESC}[38;5;196mx256 ${ESC}[38;2;10;20;30mtc`)
    const ansi = serializeSnapshot(source.snapshot())
    expect(ansi).toContain(`${ESC}[31m`) // basic red — NOT baked 38;2;128;0;0
    expect(ansi).toContain(`${ESC}[91m`) // bright red — NOT baked 38;2;255;0;0
    expect(ansi).toContain("38;5;196") // 256-cube index kept verbatim
    expect(ansi).not.toContain("38;2;128;0;0") // vterm stock red (ANSI_16[1]) would be baked here
    expect(ansi).not.toContain("38;2;255;0;0") // stock bright-red / cube-196 (#ff0000) bake
    expect(ansi).toContain("38;2;10;20;30") // true 24-bit color is NOT an index → stays truecolor
    roundTripState(source, 40, 2) // new emission forms still parse back identically (the oracle)
  })

  test("golden 11b: bg indexed identity (basic/bright/256) survives; truecolor stays", () => {
    const source = mkScreen(40, 2)
    feed(source, `${ESC}[41mR ${ESC}[101mB ${ESC}[48;5;21mC ${ESC}[48;2;1;2;3mD`)
    const ansi = serializeSnapshot(source.snapshot())
    expect(ansi).toContain(`${ESC}[41m`) // basic bg red
    expect(ansi).toContain(`${ESC}[101m`) // bright bg (100-107 literal — NOT truecolor)
    expect(ansi).toContain("48;5;21") // 256 bg index kept
    expect(ansi).not.toContain("48;2;128;0;0") // stock bg red (idx 1) bake
    expect(ansi).not.toContain("48;2;255;0;0") // stock bright bg (idx 9) bake
    expect(ansi).not.toContain("48;2;0;0;255") // stock cube-21 (#0000ff) bake
    expect(ansi).toContain("48;2;1;2;3") // truecolor bg stays truecolor
    roundTripState(source, 40, 2)
  })

  test("golden 11c: underline color 58;5;N survives as indexed; 58;2 stays truecolor", () => {
    const source = mkScreen(40, 2)
    feed(source, `${ESC}[4;58;5;226mU ${ESC}[58;2;7;8;9mV`)
    const ansi = serializeSnapshot(source.snapshot())
    expect(ansi).toContain("58;5;226") // indexed underline color kept (no 3N/9N short form exists)
    expect(ansi).not.toContain("58;2;255;255;0") // stock cube-226 (#ffff00) bake
    expect(ansi).toContain("58;2;7;8;9") // truecolor underline stays truecolor
    roundTripState(source, 40, 2)
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

  test("golden 6b: wide char ending AT the right margin + ZWJ family + VS-16 graphemes", () => {
    const source = mkScreen(10, 3)
    feed(source, `${ESC}[1;9H汉`) // wide char occupying the last two columns
    feed(source, `${ESC}[2;1H👨‍👩‍👧 x`) // ZWJ family — one grapheme cell
    feed(source, `${ESC}[3;1H❤️ done`) // heart + VS-16 (emoji presentation)
    const sink = roundTripState(source, 10, 3)
    expect(sink.getCell(0, 8).char).toBe("汉")
    expect(sink.getCell(0, 8).wide).toBe(true)
    expect(sink.getCell(0, 9).char).toBe("")
    expect(sink.getCell(1, 0).char).toBe("👨‍👩‍👧")
    expect(sink.getCell(2, 0).char).toBe("❤️")
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

// ── Serializer-modes slice: parser gaps (red-first) ────────────────────

describe("kitty keyboard set-flags (CSI = u) — the parser gap the emitter needs", () => {
  test("CSI = flags u sets flags WITHOUT pushing the stack", () => {
    const s = mkScreen(20, 4)
    feed(s, `${ESC}[=5u`)
    expect(s.snapshot().modes.kittyKeyboardFlags).toBe(5)
    expect(s.snapshot().modes.kittyKeyboardStack).toEqual([])
    feed(s, `${ESC}[=0u`)
    expect(s.snapshot().modes.kittyKeyboardFlags).toBe(0)
    expect(s.snapshot().modes.kittyKeyboardStack).toEqual([])
  })

  test("set + push composes: arbitrary (flags, stack) states become reachable", () => {
    const s = mkScreen(20, 4)
    // Without `=`, the first push always captures 0 — (flags≠0, stack=[s0≠0]) was unreachable.
    feed(s, `${ESC}[=2u${ESC}[>13u`)
    expect(s.snapshot().modes.kittyKeyboardFlags).toBe(13)
    expect(s.snapshot().modes.kittyKeyboardStack).toEqual([2])
  })
})

describe("scrollback soft-wrap bits — the model add", () => {
  test("rows scrolled into history carry their soft-wrap bit in the snapshot", () => {
    const s = mkScreen(10, 3)
    feed(s, "A".repeat(25)) // row0 full, wraps → row1 full, wraps → row2 "AAAAA"
    feed(s, "\r\ntail1\r\ntail2\r\ntail3") // scroll all three A-rows out
    const snap = s.snapshot()
    expect(s.getScrollbackLength()).toBeGreaterThanOrEqual(3)
    expect(snap.scrollbackSoftWrapped).toBeDefined()
    expect(snap.scrollbackSoftWrapped.length).toBe(snap.scrollback.length)
    // Same semantics as the grid's softWrapped: bit i true = row i wraps INTO row i+1.
    expect(snap.scrollbackSoftWrapped[0]).toBe(true) // full row, wrapped into the next
    expect(snap.scrollbackSoftWrapped[1]).toBe(true) // full row, wrapped into the next
    expect(snap.scrollbackSoftWrapped[2]).toBe(false) // "AAAAA" — the line's final row
  })

  test("restore round-trips the bits; absent field defaults to hard-wrapped", () => {
    const s = mkScreen(10, 3)
    feed(s, "B".repeat(15))
    feed(s, "\r\nx\r\ny\r\nz")
    const snap = s.snapshot()
    const twin = mkScreen(10, 3)
    twin.restore(snap)
    expect(twin.snapshot().scrollbackSoftWrapped).toEqual(snap.scrollbackSoftWrapped)
    // Forward-compat: a version-1 snapshot without the field restores as all-false.
    const legacy = { ...snap, scrollbackSoftWrapped: undefined }
    const old = mkScreen(10, 3)
    old.restore(legacy as unknown as Snapshot)
    expect(old.snapshot().scrollbackSoftWrapped).toEqual(new Array(snap.scrollback.length).fill(false))
  })

  test("serialized history preserves wrap linkage: a rewrapped logical line stays one line", () => {
    const s = mkScreen(10, 3)
    feed(s, "C".repeat(22)) // one logical line across three rows
    feed(s, "\r\nx\r\ny\r\nz") // push all three into scrollback
    const snap = s.snapshot()
    const sink = mkScreen(10, 3)
    feed(sink, serializeSnapshot(snap))
    expect(sink.getScrollbackText()).toBe(s.getScrollbackText())
    expect(sink.snapshot().scrollbackSoftWrapped).toEqual(snap.scrollbackSoftWrapped)
  })
})

// ── Serializer-modes slice: emission goldens + matrix ───────────────────

describe("serializeSnapshot — mode emission", () => {
  /** One entry per emitted mode family (bead golden 9 — the reattach matrix). */
  const MODE_MATRIX: readonly (readonly [name: string, setup: string, check: (snap: Snapshot) => void])[] = [
    ["origin ?6", `${ESC}[?6h`, (m) => expect(m.modes.origin).toBe(true)],
    ["insert IRM 4", `${ESC}[4h`, (m) => expect(m.modes.insert).toBe(true)],
    ["reverse ?5", `${ESC}[?5h`, (m) => expect(m.modes.reverseVideo).toBe(true)],
    ["app-cursor ?1", `${ESC}[?1h`, (m) => expect(m.modes.applicationCursor).toBe(true)],
    ["app-keypad ESC=", `${ESC}=`, (m) => expect(m.modes.applicationKeypad).toBe(true)],
    ["bracketed ?2004", `${ESC}[?2004h`, (m) => expect(m.modes.bracketedPaste).toBe(true)],
    ["focus ?1004", `${ESC}[?1004h`, (m) => expect(m.modes.focusTracking).toBe(true)],
    ["altScroll ?1007", `${ESC}[?1007h`, (m) => expect(m.modes.altScroll).toBe(true)],
    ["colorScheme ?2031", `${ESC}[?2031h`, (m) => expect(m.modes.colorSchemeReporting).toBe(true)],
    [
      "mouse all-events ?1003",
      `${ESC}[?1003h`,
      (m) => {
        expect(m.modes.mouseTracking).toBe(true)
        expect(m.modes.mouseTrackingMode).toBe(1003)
      },
    ],
    [
      "mouse pixel ?1016 (exact stored code, not just 1000/1002/1003)",
      `${ESC}[?1016h`,
      (m) => expect(m.modes.mouseTrackingMode).toBe(1016),
    ],
    ["sgrMouse ?1006", `${ESC}[?1006h`, (m) => expect(m.modes.sgrMouse).toBe(true)],
    ["utf8Mouse ?1005", `${ESC}[?1005h`, (m) => expect(m.modes.utf8Mouse).toBe(true)],
    [
      "kitty flags + stack",
      `${ESC}[=2u${ESC}[>13u`,
      (m) => {
        expect(m.modes.kittyKeyboardFlags).toBe(13)
        expect(m.modes.kittyKeyboardStack).toEqual([2])
      },
    ],
    [
      "DECSTBM margins",
      `${ESC}[2;5r`,
      (m) => {
        expect(m.margins.scrollTop).toBe(1)
        expect(m.margins.scrollBottom).toBe(4)
      },
    ],
    [
      "DECSLRM left/right margins",
      `${ESC}[?69h${ESC}[3;8s`,
      (m) => {
        expect(m.margins.leftRight).toBe(true)
        expect(m.margins.left).toBe(2)
        expect(m.margins.right).toBe(7)
      },
    ],
    [
      "cursor shape steady underline (DECSCUSR 4)",
      `${ESC}[4 q`,
      (m) => {
        expect(m.cursor.shape).toBe("underline")
        expect(m.cursor.blinking).toBe(false)
      },
    ],
    ["charset DEC graphics ESC(0", `${ESC}(0`, (m) => expect(m.unicode.charsetG0).toBe(true)],
    [
      "default colors OSC 10/11",
      `${ESC}]10;rgb:aa/bb/cc${ESC}\\${ESC}]11;#102030${ESC}\\`,
      (m) => {
        expect(m.colors.current.defaultFgColor).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc })
        expect(m.colors.current.defaultBgColor).toEqual({ r: 0x10, g: 0x20, b: 0x30 })
      },
    ],
    [
      "palette entry OSC 4",
      `${ESC}]4;17;rgb:01/02/03${ESC}\\`,
      (m) => expect(m.colors.current.palette256[17]).toEqual({ r: 1, g: 2, b: 3 }),
    ],
    [
      "custom tab stops (TBC + HTS)",
      `${ESC}[3g${ESC}[1;6H${ESC}H${ESC}[1;21H${ESC}H`,
      (m) => expect(m.tabStops).toEqual([5, 20]),
    ],
  ] as const

  for (const [name, setup, check] of MODE_MATRIX) {
    test(`matrix: ${name} survives reattach`, () => {
      const source = mkScreen(30, 6)
      feed(source, "content\r\nrow-two")
      feed(source, setup)
      const sink = roundTripState(source, 30, 6)
      check(sink.snapshot())
    })
  }

  test("alt screen: activeBuffer + alt content round-trip (?1049h precedes the paint)", () => {
    const source = mkScreen(20, 6)
    feed(source, "on main")
    feed(source, `${ESC}[?1049h`)
    feed(source, `${ESC}[1;1HALT ROW`)
    const ansi = serializeSnapshot(source.snapshot())
    expect(ansi.indexOf("?1049h")).toBeGreaterThanOrEqual(0)
    expect(ansi.indexOf("?1049h")).toBeLessThan(ansi.indexOf("\x1b[2J"))
    const sink = roundTripState(source, 20, 6)
    expect(sink.snapshot().activeBuffer).toBe("alt")
    expect(sink.getText()).toBe(source.getText())
  })

  test("restored primary row re-enters scrollback after alt exit and later scroll", () => {
    const source = mkScreen(12, 3)
    feed(source, "restored-row\r\n")
    feed(source, `${ESC}[?1049hALT${ESC}[?1049l`)
    feed(source, "diagnostic-wrap-diagnostic-wrap-diagnostic-wrap\r\n")

    const sink = roundTripState(source, 12, 3)
    expect(sink.getScrollbackText()).toContain("restored-row")
    expect(sink.getScrollbackText()).toContain("diagnostic")
    expect(sink.getScrollbackText()).toBe(source.getScrollbackText())
  })

  test("golden 7: syncOutput is NEVER emitted (?2026h would wedge a real receiver)", () => {
    const source = mkScreen(20, 3)
    feed(source, "x")
    feed(source, `${ESC}[?2026h`)
    const snap = source.snapshot()
    expect(snap.modes.syncOutput).toBe(true)
    // vterm itself ignores syncOutput in its write path, so the round-trip oracle
    // is structurally blind here — this raw ABSENCE assertion is the only guard.
    const ansi = serializeSnapshot(snap)
    expect(ansi).not.toContain("?2026")
    const sink = mkScreen(20, 3)
    feed(sink, ansi)
    expect(sink.snapshot().modes.syncOutput).toBe(false) // documented divergence
  })

  test("golden 7b: decColumn is NEVER emitted (?3h/l erases the whole screen)", () => {
    const source = mkScreen(20, 3)
    feed(source, `${ESC}[?3h`)
    feed(source, "after-colm")
    const snap = source.snapshot()
    expect(snap.modes.decColumn).toBe(true)
    const ansi = serializeSnapshot(snap)
    expect(ansi).not.toMatch(/\x1b\[\?3[hl]/)
    const sink = mkScreen(20, 3)
    feed(sink, ansi)
    expect(sink.snapshot().modes.decColumn).toBe(false) // documented divergence
    expect(sink.getText()).toBe(source.getText())
  })

  test("golden 8: cursor lands exactly after geometry (margins + origin)", () => {
    const source = mkScreen(20, 8)
    feed(source, `${ESC}[2;6r`) // DECSTBM rows 2..6 — homes the cursor
    feed(source, `${ESC}[?6h`) // origin ON — CUP becomes region-relative
    feed(source, `${ESC}[3;4H`) // region-relative → absolute row 4 (0-based 3), col 4 (0-based 3)
    feed(source, "MID")
    const sink = roundTripState(source, 20, 8)
    expect(sink.getCursor()).toEqual({ col: 6, row: 3 })
  })

  test("golden 8b: alt screen + margins + mid-screen cursor", () => {
    const source = mkScreen(20, 6)
    feed(source, "main content")
    feed(source, `${ESC}[?1049h`)
    feed(source, "ALT")
    feed(source, `${ESC}[3;5r${ESC}[4;7H`)
    const sink = roundTripState(source, 20, 6)
    expect(sink.snapshot().activeBuffer).toBe("alt")
  })

  test("insert mode restores AFTER the paint — painted cells are not insert-shifted", () => {
    const source = mkScreen(20, 3)
    feed(source, "abcdef")
    feed(source, `${ESC}[4h`)
    const sink = roundTripState(source, 20, 3)
    expect(sink.snapshot().modes.insert).toBe(true)
    expect(sink.getText()).toBe(source.getText())
  })

  test("charset: painted glyphs are the translated cells; ESC(0 restored in finalize", () => {
    const source = mkScreen(20, 3)
    feed(source, `${ESC}(0qqq${ESC}(B plain ${ESC}(0`)
    const snap = source.snapshot()
    expect(snap.unicode.charsetG0).toBe(true)
    const sink = roundTripState(source, 20, 3)
    // 'q' under DEC Special Graphics stored as the translated glyph; the paint
    // (which runs under ASCII) must reproduce it literally.
    expect(sink.getCell(0, 0).char).toBe(source.getCell(0, 0).char)
  })

  test("DECSCUSR emitted only when non-default (default is blinking block)", () => {
    const plain = mkScreen(20, 3)
    feed(plain, "x")
    expect(serializeSnapshot(plain.snapshot())).not.toContain(" q")
    const styled = mkScreen(20, 3)
    feed(styled, `${ESC}[4 q`)
    expect(serializeSnapshot(styled.snapshot())).toContain(" q")
  })

  test("excludeModes: listed snapshot-mode keys are skipped", () => {
    const source = mkScreen(20, 3)
    feed(source, `${ESC}[?2004h${ESC}[?1004h`)
    const ansi = serializeSnapshot(source.snapshot(), { excludeModes: ["bracketedPaste"] })
    expect(ansi).not.toContain("2004")
    expect(ansi).toContain("1004")
    const sink = mkScreen(20, 3)
    feed(sink, ansi)
    expect(sink.snapshot().modes.bracketedPaste).toBe(false)
    expect(sink.snapshot().modes.focusTracking).toBe(true)
  })
})
