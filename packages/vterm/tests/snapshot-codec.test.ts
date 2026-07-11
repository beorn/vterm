/**
 * snapshot-codec.test.ts — round-trip + size oracle for the binary ScreenSnapshot codec.
 *
 * @failure  A checkpoint that persists a terminal through encodeScreenSnapshotBinary reloads
 *           corrupted — a cell's color / underline style / hyperlink / wide bit flips, an
 *           alt-screen or scrollback soft-wrap linkage is lost, a mid-escape parser transient
 *           is dropped, or the encoding silently bloats back toward the ~450 MB keyed-JSON
 *           size it exists to replace.
 * @level    l0
 * @consumer encodeScreenSnapshotBinary / decodeScreenSnapshotBinary — the compact terminal
 *           persistence format behind @si/vterm/21016-terminal-runtime and the hab
 *           shell-persistence chain @hab/19797-hab-master/20642-inhab-pty-full-history-resume/
 *           20665-shell-deck-resume/20860-shell-persistence/20992-pty-ansi-plateau/
 *           21018-vterm-integration. Run: `bun vitest run tests/snapshot-codec.test.ts`
 *           from the monorepo root (hh: --project vendor).
 *
 * Contract: decode(encode(s)) deep-equals s EXACTLY — every field, no normalization — for
 * empty, styled, wide/CJK/ZWJ, alt-screen, scrollback-with-soft-wrap, mid-escape, and
 * resized snapshots, plus a seeded random property loop. Encoding is deterministic and the
 * columnar RLE keeps a 200x50 + 10k-row-scrollback snapshot in single-digit MB.
 */
import { describe, expect, test } from "vitest"
import {
  createVtermScreen,
  decodeScreenSnapshotBinary,
  encodeScreenSnapshotBinary,
  type VtermScreen,
  type VtermScreenSnapshot,
} from "../src/index.ts"

const ESC = "\x1b"
const encoder = new TextEncoder()

function mkScreen(cols = 40, rows = 8, scrollbackLimit = 1000): VtermScreen {
  return createVtermScreen({ cols, rows, scrollbackLimit })
}

function feed(screen: VtermScreen, data: string): void {
  screen.process(encoder.encode(data))
}

/** Encode → decode → assert byte-exact structural equality; return the decoded snapshot. */
function roundTrip(snapshot: VtermScreenSnapshot): VtermScreenSnapshot {
  const encoded = encodeScreenSnapshotBinary(snapshot)
  const decoded = decodeScreenSnapshotBinary(encoded)
  expect(decoded).toEqual(snapshot)
  return decoded
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
 * Random source exercising every path the codec must survive: truecolor / 256 / underline
 * variants / overline / strike / blink / inverse / hidden, OSC-8 hyperlinks, wide + CJK +
 * ZWJ + combining + VS-16 graphemes, alt-screen toggles, forced wraps into scrollback (with
 * soft-wrap bits), margins, palette mutations, and — for ~40% of runs — a trailing partial
 * escape so a mid-parse parser transient must round-trip.
 */
function randomSource(rand: () => number, cols: number, rows: number): VtermScreen {
  const screen = createVtermScreen({ cols, rows, scrollbackLimit: 500 })
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
  const words = ["hei", "verden", "汉字", "🎈", "👨‍👩‍👧", "é", "ab c", "x", "…tail", "❤️"] as const
  const modePool = [
    `${ESC}[?1049h`,
    `${ESC}[?1049l`,
    `${ESC}[?6h`,
    `${ESC}[4h`,
    `${ESC}[?5h`,
    `${ESC}[2;4r`,
    `${ESC}[r`,
    `${ESC}[3 q`,
    `${ESC}(0`,
    `${ESC}(B`,
    `${ESC}=`,
    `${ESC}>`,
    `${ESC}[?2004h`,
    `${ESC}]10;rgb:aa/bb/cc${ESC}\\`,
    `${ESC}]4;100;rgb:11/22/33${ESC}\\`,
    `${ESC}[?2026h`,
    `${ESC}[?3h`,
    `${ESC}[=5u`,
    `${ESC}[>13u`,
  ] as const
  const opCount = 24 + int(24)
  for (let i = 0; i < opCount; i++) {
    switch (int(8)) {
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
      case 6:
        feed(screen, "X".repeat(1 + int(cols * 2))) // force wraps → scrollback + soft-wrap bits
        break
      default:
        feed(screen, pick(modePool))
        break
    }
  }
  // Leave the parser mid-sequence so parser/unicode transients must survive the codec.
  if (rand() < 0.4) {
    feed(screen, pick([`${ESC}[38;2;1`, `${ESC}]8;;https://x`, `${ESC}P1;2`, `${ESC}`, `${ESC}_Gf=1`, `${ESC}[?100`]))
  }
  return screen
}

// ── Round-trip goldens ──────────────────────────────────────────────────

describe("snapshot-codec — round-trip deep equality", () => {
  test("empty screen", () => {
    roundTrip(mkScreen(10, 4).snapshot())
  })

  test("styled screen: truecolor, 256, underline variants, overline/strike, OSC-8 urls", () => {
    const screen = mkScreen(40, 4)
    feed(screen, `${ESC}[38;2;10;200;50;48;2;9;8;7;1;3mtruecolor `)
    feed(screen, `${ESC}[0;38;5;178;48;5;24m256 `)
    feed(screen, `${ESC}[0;4:3mcurly${ESC}[4:4mdotted${ESC}[4:5mdashed${ESC}[4:2;58;2;250;100;5mdbl `)
    feed(screen, `${ESC}[0;53;9;5;7;8mover `)
    feed(screen, `${ESC}[0m${ESC}]8;;https://x.test/doc${ESC}\\link${ESC}]8;;${ESC}\\ end`)
    const decoded = roundTrip(screen.snapshot())
    // Spot-check the reconstructed pen state a checkpoint most cares about.
    expect(decoded.main.grid[0]![0]!.fg).toEqual({ r: 10, g: 200, b: 50 })
    expect(decoded.main.grid[0]![0]!.bg).toEqual({ r: 9, g: 8, b: 7 })
    // The link text wraps past the first row, so search the whole grid.
    const linkCell = decoded.main.grid.flat().find((c) => c.url !== null)
    expect(linkCell?.url).toBe("https://x.test/doc")
  })

  test("indexed colors keep their palette-origin index through the codec (drift-fix)", () => {
    // The interned color table must carry `index` DISTINCTLY from true RGB, else
    // a checkpoint reload bakes indexed cells to truecolor and the serializer can
    // no longer re-emit their themeable form. `roundTrip` already asserts full
    // deep-equality (index included); these spot-check the exact provenance.
    const screen = mkScreen(40, 2)
    feed(screen, `${ESC}[31mR${ESC}[91mB${ESC}[38;5;196mC${ESC}[38;2;10;20;30mT`)
    const decoded = roundTrip(screen.snapshot())
    expect(decoded.main.grid[0]![0]!.fg).toStrictEqual({ r: 0x80, g: 0, b: 0, index: 1 }) // 31 → basic red idx 1
    expect(decoded.main.grid[0]![1]!.fg).toStrictEqual({ r: 0xff, g: 0, b: 0, index: 9 }) // 91 → bright red idx 9
    expect(decoded.main.grid[0]![2]!.fg).toStrictEqual({ r: 0xff, g: 0, b: 0, index: 196 }) // 38;5;196 → idx 196
    expect(decoded.main.grid[0]![3]!.fg).toStrictEqual({ r: 10, g: 20, b: 30 }) // truecolor — NO index key
  })

  test("wide / CJK + combining + ZWJ + VS-16 graphemes keep wide+spacer shape", () => {
    const screen = mkScreen(16, 3)
    feed(screen, `汉x🎈 `)
    feed(screen, `${ESC}[2;1H👨‍👩‍👧 é ❤️`)
    const decoded = roundTrip(screen.snapshot())
    expect(decoded.main.grid[0]![0]!.char).toBe("汉")
    expect(decoded.main.grid[0]![0]!.wide).toBe(true)
    expect(decoded.main.grid[0]![1]!.char).toBe("") // wide-char spacer
    expect(decoded.main.grid[1]![0]!.char).toBe("👨‍👩‍👧")
  })

  test("alt screen active with distinct main + alt content", () => {
    const screen = mkScreen(20, 5)
    feed(screen, `main content here${ESC}[3;1Hmore main`)
    feed(screen, `${ESC}[?1049h`) // enter alt
    feed(screen, `${ESC}[1;1HALT ROW ONE${ESC}[2;1Halt row two`)
    const snap = screen.snapshot()
    expect(snap.activeBuffer).toBe("alt")
    const decoded = roundTrip(snap)
    // Both buffers survive independently.
    expect(decoded.activeBuffer).toBe("alt")
    expect(decoded.alt.grid[0]!.map((c) => c.char).join("")).toContain("ALT")
  })

  test("restored primary content still re-enters scrollback after the primary screen scrolls again", () => {
    const screen = mkScreen(12, 3)
    feed(screen, "restored-row\r\n")
    feed(screen, `${ESC}[?1049hALT${ESC}[?1049l`)
    feed(screen, "diagnostic-wrap-diagnostic-wrap-diagnostic-wrap\r\n")

    const decoded = roundTrip(screen.snapshot())
    const scrollbackText = decoded.scrollback.map((row) => row.map((cell) => cell.char || " ").join("")).join("\n")
    expect(scrollbackText).toContain("restored-row")
    expect(scrollbackText).toContain("diagnostic")
  })

  test("scrollback with soft-wrap bits round-trips (parallel arrays intact)", () => {
    const screen = mkScreen(10, 3, 2000)
    feed(screen, "A".repeat(25)) // wraps across rows → soft-wrap bits set
    for (let i = 0; i < 40; i++) {
      feed(screen, `\r\nhistory row ${String(i)} that is long enough to wrap around ${String(i)}`)
    }
    const snap = screen.snapshot()
    expect(snap.scrollback.length).toBeGreaterThan(10)
    expect(snap.scrollbackSoftWrapped.length).toBe(snap.scrollback.length)
    expect(snap.scrollbackSoftWrapped.some(Boolean)).toBe(true)
    roundTrip(snap)
  })

  test("snapshot taken MID-ESCAPE preserves parser transients", () => {
    const screen = mkScreen(20, 3)
    feed(screen, `visible text${ESC}[38;2;1`) // partial CSI — parser is left in "csi"
    const snap = screen.snapshot()
    expect(snap.parser.state).toBe("csi")
    expect(snap.parser.esc).toBe("38;2;1")
    const decoded = roundTrip(snap)
    expect(decoded.parser.state).toBe("csi")
    expect(decoded.parser.esc).toBe("38;2;1")
  })

  test("resized-then-written screen (ragged scrollback vs current cols)", () => {
    const screen = mkScreen(80, 6, 4000)
    for (let i = 0; i < 30; i++) feed(screen, `line ${String(i)} at width eighty\r\n`)
    screen.resize(120, 10) // scrollback rows stay 80-wide; main becomes 120-wide
    feed(screen, `${ESC}[1mafter resize at width one-twenty`)
    const snap = screen.snapshot()
    expect(snap.cols).toBe(120)
    expect(snap.main.grid[0]!.length).toBe(120)
    // Scrollback rows retain their pre-resize width (raggedness the codec must preserve).
    if (snap.scrollback.length > 0) expect(snap.scrollback[0]!.length).toBe(80)
    roundTrip(snap)
  })

  test("legacy scrollbackSoftWrapped=undefined round-trips as undefined (presence byte)", () => {
    const screen = mkScreen(10, 3)
    feed(screen, `${"B".repeat(15)}\r\nx\r\ny\r\nz`)
    const snap = screen.snapshot()
    const legacy = { ...snap, scrollbackSoftWrapped: undefined } as unknown as VtermScreenSnapshot
    const decoded = decodeScreenSnapshotBinary(encodeScreenSnapshotBinary(legacy))
    expect(decoded.scrollbackSoftWrapped).toBeUndefined()
    expect(decoded).toEqual(legacy)
  })
})

// ── Property loop ─────────────────────────────────────────────────────

describe("snapshot-codec — property", () => {
  test("50 seeded random snapshots round-trip byte-exact", () => {
    for (let seed = 1; seed <= 50; seed++) {
      const cols = 16 + (seed % 5) * 8
      const rows = 4 + (seed % 3) * 2
      const source = randomSource(mulberry32(seed * 7919), cols, rows)
      const snap = source.snapshot()
      const decoded = decodeScreenSnapshotBinary(encodeScreenSnapshotBinary(snap))
      expect(decoded, `seed ${String(seed)}`).toEqual(snap)
    }
  })

  test("deterministic: identical input yields byte-identical output", () => {
    const screen = mkScreen(30, 4)
    feed(screen, `${ESC}[38;2;1;2;3mhi ${ESC}]8;;https://x.test/${ESC}\\link${ESC}]8;;${ESC}\\`)
    const snap = screen.snapshot()
    expect(encodeScreenSnapshotBinary(snap)).toEqual(encodeScreenSnapshotBinary(snap))
  })

  test("decoded snapshot is accepted by restore() and reproduces the screen", () => {
    const source = mkScreen(24, 4)
    feed(source, `${ESC}[1;38;2;9;9;9mhello${ESC}[0m world`)
    feed(source, "\r\nsecond line\r\nthird")
    const decoded = decodeScreenSnapshotBinary(encodeScreenSnapshotBinary(source.snapshot()))
    const sink = mkScreen(2, 2) // different size — restore() rebuilds to the decoded geometry
    sink.restore(decoded)
    expect(sink.getText()).toBe(source.getText())
    expect(sink.getScrollbackText()).toBe(source.getScrollbackText())
  })
})

// ── Version guard ─────────────────────────────────────────────────────

describe("snapshot-codec — version guard + loud failures", () => {
  test("an unknown version byte throws (no silent fallback)", () => {
    const encoded = encodeScreenSnapshotBinary(mkScreen(8, 2).snapshot())
    const tampered = encoded.slice()
    tampered[0] = 2
    expect(() => decodeScreenSnapshotBinary(tampered)).toThrow(/unsupported version/i)
  })

  test("truncated input throws instead of returning a partial snapshot", () => {
    const encoded = encodeScreenSnapshotBinary(mkScreen(8, 2).snapshot())
    expect(() => decodeScreenSnapshotBinary(encoded.slice(0, 3))).toThrow()
  })
})

// ── Size ──────────────────────────────────────────────────────────────

describe("snapshot-codec — size", () => {
  test("200x50 screen + 10k scrollback rows encodes to a few MB, not the JSON ~450 MB", () => {
    const cols = 200
    const rows = 50
    const screen = createVtermScreen({ cols, rows, scrollbackLimit: 20000 })
    const pool = [
      "$ git status",
      "On branch main",
      "Your branch is up to date with 'origin/main'.",
      "Changes not staged for commit:",
      '  (use "git add <file>..." to update what will be committed)',
      "\tmodified:   packages/vterm/src/screen.ts",
      "\tmodified:   packages/vterm/src/snapshot-codec.ts",
      "drwxr-xr-x   5 beorn  staff    160 Jul  9 12:34 src",
      "-rw-r--r--   1 beorn  staff  18240 Jul  9 12:34 index.ts",
      "total 480",
      "npm warn deprecated foo@1.2.3: use bar instead",
      "  ✓ packages/vterm/tests/serialize.test.ts (42 tests) 128ms",
      "export function encodeScreenSnapshotBinary(snapshot: ScreenSnapshot): Uint8Array {",
      "  const writer = createWriter()   // grow-on-demand byte buffer",
      "Compiled 1284 modules in 3.2s",
    ]
    const green = `${ESC}[32m`
    const reset = `${ESC}[0m`
    const parts: string[] = []
    for (let i = 0; i < 10050; i++) {
      const line = pool[i % pool.length]!
      parts.push(i % 8 === 0 ? `${green}${line}${reset}\r\n` : `${line}\r\n`)
    }
    feed(screen, parts.join(""))

    const snapshot = screen.snapshot()
    expect(screen.getScrollbackLength()).toBeGreaterThan(9000)

    const encoded = encodeScreenSnapshotBinary(snapshot)
    const jsonBytes = JSON.stringify(snapshot).length

    // Observed on ~2.02M cells: JSON.stringify ≈ 431 MiB, encoded ≈ 0.82 MiB (~528x
    // smaller). The km vitest harness rejects console output from tests, so the live
    // figures are asserted here rather than printed. Both bounds must hold:
    //   - comfortably under JSON/50 (the bead's target), and
    //   - under 8 MiB absolute (a hab checkpoint stays cheap).
    expect(encoded.byteLength).toBeLessThan(jsonBytes / 50)
    expect(encoded.byteLength).toBeLessThan(8 * 1024 * 1024)
  })
})
