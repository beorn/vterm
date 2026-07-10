/**
 * snapshot-codec.ts — compact binary codec for {@link ScreenSnapshot}.
 *
 * Why: a keyed-JSON ScreenSnapshot spends 220-280 bytes per cell — every cell is a
 * 15-key object with two-or-three nested `{r,g,b}` color records. A 200x50 screen with
 * a 10k-row scrollback is ~2M cells → ~450 MB once `JSON.stringify`'d, which is exactly
 * what a hab checkpoint pays when it stringifies the whole terminal at shutdown /
 * compaction. This codec stores the same data — byte-exact, no normalization — in a few
 * MB by exploiting the two things the JSON encoding throws away: cells repeat (rows are
 * dominated by identical runs) and their text/style/color vocabularies are tiny.
 *
 * Format (v1). Every integer is an unsigned LEB128 varint unless noted "byte":
 *
 *   version          1 byte, value 1. An unknown value throws on decode (no fallback).
 *   header           varint length + that many UTF-8 bytes of JSON. Carries the small
 *                    scalar state — cols/rows/scrollbackLimit/activeBuffer, cursor,
 *                    savedState, attrs, modes, margins, colors, tabStops, title,
 *                    clipboard, cwd, notifications, viewportOffset, parser, unicode.
 *                    Everything that is neither a cell grid nor a soft-wrap array rides
 *                    here verbatim (it is small, and JSON round-trips it exactly).
 *   string table     varint count, then per entry: varint byte-length + UTF-8 bytes.
 *                    Entry 0 is always "". Holds every distinct cell `char` AND every
 *                    distinct `url` string.
 *   color table      varint count, then 3 bytes (r,g,b) per entry.
 *   style table      varint count, then per entry: varint flags (9 attribute bits +
 *                    3 underline-style bits) then four nullable refs as varints —
 *                    fg/bg/underlineColor into the color table, url into the string
 *                    table — where 0 means null and any other value is index+1.
 *   grids            three sections in the fixed order main, alt, scrollback. Each:
 *                      varint rowCount
 *                      soft-wrap bits: rowCount bits, LSB-first, byte-packed. The
 *                        scrollback section is preceded by a presence byte (0 = the
 *                        field was `undefined`, so it decodes back to `undefined`).
 *                      RLE(row lengths)  — splits the flat cell stream into rows.
 *                      RLE(char column)  — one string-table index per cell.
 *                      RLE(style column) — one style-table index per cell.
 *
 *   RLE(seq) = varint runCount, then per run: varint count + varint value.
 *
 * The cell columns are stored *columnar*: `char` (which changes almost every cell) is
 * kept separate from the style tuple (which is constant across long runs). An unstyled
 * screen therefore collapses its entire style column to a single run and every row's
 * trailing blanks to a single char run — while a styled run stays one style entry no
 * matter how many distinct characters it spans.
 *
 * Guarantees:
 *   - `decodeScreenSnapshotBinary(encodeScreenSnapshotBinary(s))` deep-equals `s`
 *     exactly, field for field, with no normalization.
 *   - Encoding is deterministic: the string/color/style tables are interned in a fixed
 *     main → alt → scrollback, row-major scan order, so identical input yields
 *     byte-identical output.
 *   - No silent errors: truncated input, an out-of-range table reference, a run-length
 *     that disagrees with the grid geometry, or an unknown version all throw.
 */

import type { CellColor, ScreenCell, ScreenSnapshot, UnderlineStyle } from "./screen.ts"

const VERSION = 1

const encoder = new TextEncoder()
const decoder = new TextDecoder()

// ── Style flag bit layout (packed into `flags`) ────────────────────────
// Bits 0-8 are the nine boolean attributes; bits 9-11 hold the underline style
// (0-5). The remaining bits are always zero. Max value is (5 << 9) | 0x1ff = 3071.
const F_BOLD = 1 << 0
const F_FAINT = 1 << 1
const F_ITALIC = 1 << 2
const F_OVERLINE = 1 << 3
const F_STRIKE = 1 << 4
const F_INVERSE = 1 << 5
const F_HIDDEN = 1 << 6
const F_BLINK = 1 << 7
const F_WIDE = 1 << 8
const UL_SHIFT = 9
const UL_MASK = 0x7

const UNDERLINE_STYLES: readonly UnderlineStyle[] = ["none", "single", "double", "curly", "dotted", "dashed"]
const UNDERLINE_INDEX: Record<UnderlineStyle, number> = {
  none: 0,
  single: 1,
  double: 2,
  curly: 3,
  dotted: 4,
  dashed: 5,
}

interface StyleTuple {
  flags: number
  fgRef: number
  bgRef: number
  ulRef: number
  urlRef: number
}

/** The small scalar state carried verbatim in the JSON header. */
interface SnapshotHeader {
  cols: number
  rows: number
  scrollbackLimit: number
  activeBuffer: ScreenSnapshot["activeBuffer"]
  cursor: ScreenSnapshot["cursor"]
  savedState: ScreenSnapshot["savedState"]
  attrs: ScreenSnapshot["attrs"]
  modes: ScreenSnapshot["modes"]
  margins: ScreenSnapshot["margins"]
  colors: ScreenSnapshot["colors"]
  tabStops: number[]
  title: string
  clipboard: string
  cwd: string
  notifications: string[]
  viewportOffset: number
  parser: ScreenSnapshot["parser"]
  unicode: ScreenSnapshot["unicode"]
}

// ── Byte writer (growable) ─────────────────────────────────────────────

interface Writer {
  u8(byte: number): void
  varint(value: number): void
  bytes(src: Uint8Array): void
  finish(): Uint8Array
}

function createWriter(): Writer {
  let buf = new Uint8Array(1024)
  let len = 0

  function ensure(extra: number): void {
    if (len + extra <= buf.length) return
    let cap = buf.length
    while (cap < len + extra) cap *= 2
    const next = new Uint8Array(cap)
    next.set(buf.subarray(0, len))
    buf = next
  }

  return {
    u8(byte) {
      ensure(1)
      buf[len++] = byte & 0xff
    },
    varint(value) {
      // Arithmetic (not bitwise) so values above 2^31 encode correctly.
      ensure(10)
      let v = value
      while (v >= 0x80) {
        buf[len++] = (v % 128) + 128
        v = Math.floor(v / 128)
      }
      buf[len++] = v
    },
    bytes(src) {
      ensure(src.length)
      buf.set(src, len)
      len += src.length
    },
    finish() {
      return buf.slice(0, len)
    },
  }
}

// ── Byte reader ────────────────────────────────────────────────────────

interface Reader {
  u8(): number
  varint(): number
  take(n: number): Uint8Array
}

function createReader(bytes: Uint8Array): Reader {
  let pos = 0

  function u8(): number {
    if (pos >= bytes.length) throw new Error("vterm snapshot codec: unexpected end of input")
    return bytes[pos++]!
  }

  return {
    u8,
    varint() {
      let result = 0
      let shift = 1
      for (;;) {
        const byte = u8()
        result += (byte & 0x7f) * shift
        if ((byte & 0x80) === 0) break
        shift *= 128
        if (shift > 2 ** 53) throw new Error("vterm snapshot codec: varint too large")
      }
      return result
    },
    take(n) {
      if (pos + n > bytes.length) throw new Error("vterm snapshot codec: unexpected end of input")
      const slice = bytes.subarray(pos, pos + n)
      pos += n
      return slice
    },
  }
}

// ── Run-length helpers ─────────────────────────────────────────────────

/** Accumulates a value stream into flat `[count, value, count, value, ...]` runs. */
interface RunAccumulator {
  runs: number[]
  push(value: number): void
}

function createRunAccumulator(): RunAccumulator {
  const runs: number[] = []
  let hasLast = false
  let lastValue = 0
  return {
    runs,
    push(value) {
      if (hasLast && value === lastValue) {
        runs[runs.length - 2]! += 1
      } else {
        runs.push(1, value)
        lastValue = value
        hasLast = true
      }
    },
  }
}

function writeRuns(w: Writer, runs: number[]): void {
  w.varint(runs.length / 2)
  for (let i = 0; i < runs.length; i += 2) {
    w.varint(runs[i]!)
    w.varint(runs[i + 1]!)
  }
}

function readRuns(r: Reader): number[] {
  const runCount = r.varint()
  const runs: number[] = []
  for (let i = 0; i < runCount; i++) {
    const count = r.varint()
    const value = r.varint()
    runs.push(count, value)
  }
  return runs
}

/** Walks a flat run array one value at a time; throws if drained past its total. */
interface RunCursor {
  total: number
  next(): number
}

function createRunCursor(runs: number[]): RunCursor {
  let total = 0
  for (let i = 0; i < runs.length; i += 2) total += runs[i]!
  let idx = 0
  let remaining = runs.length > 0 ? runs[0]! : 0
  let value = runs.length > 1 ? runs[1]! : 0
  return {
    total,
    next() {
      while (remaining === 0) {
        idx += 2
        if (idx >= runs.length) throw new Error("vterm snapshot codec: run-length underflow")
        remaining = runs[idx]!
        value = runs[idx + 1]!
      }
      remaining -= 1
      return value
    },
  }
}

function expandLengths(runs: number[]): number[] {
  const out: number[] = []
  for (let i = 0; i < runs.length; i += 2) {
    const count = runs[i]!
    const value = runs[i + 1]!
    for (let k = 0; k < count; k++) out.push(value)
  }
  return out
}

// ── Bit packing (soft-wrap arrays) ─────────────────────────────────────

function writeBits(w: Writer, bits: boolean[]): void {
  let acc = 0
  let n = 0
  for (const bit of bits) {
    if (bit) acc |= 1 << n
    n++
    if (n === 8) {
      w.u8(acc)
      acc = 0
      n = 0
    }
  }
  if (n > 0) w.u8(acc)
}

function readBits(r: Reader, count: number): boolean[] {
  const out = new Array<boolean>(count)
  let acc = 0
  let have = 0
  for (let i = 0; i < count; i++) {
    if (have === 0) {
      acc = r.u8()
      have = 8
    }
    out[i] = (acc & 1) === 1
    acc >>= 1
    have--
  }
  return out
}

// ── String / color / style interning (encode side) ─────────────────────

interface Interner {
  stringList: string[]
  colorList: CellColor[]
  styleList: StyleTuple[]
  internString(s: string): number
  internStyle(cell: ScreenCell): number
}

function checkByte(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new Error(`vterm snapshot codec: ${name} out of 0-255 range: ${String(value)}`)
  }
}

function createInterner(): Interner {
  const stringList: string[] = [""]
  const stringMap = new Map<string, number>([["", 0]])
  const colorList: CellColor[] = []
  const colorMap = new Map<string, number>()
  const styleList: StyleTuple[] = []
  const styleMap = new Map<string, number>()

  function internString(s: string): number {
    let idx = stringMap.get(s)
    if (idx === undefined) {
      idx = stringList.length
      stringList.push(s)
      stringMap.set(s, idx)
    }
    return idx
  }

  /** null → 0; otherwise color-table index + 1. */
  function colorRef(c: CellColor | null): number {
    if (c === null) return 0
    checkByte("color.r", c.r)
    checkByte("color.g", c.g)
    checkByte("color.b", c.b)
    const key = `${c.r},${c.g},${c.b}`
    let idx = colorMap.get(key)
    if (idx === undefined) {
      idx = colorList.length
      colorList.push({ r: c.r, g: c.g, b: c.b })
      colorMap.set(key, idx)
    }
    return idx + 1
  }

  function internStyle(cell: ScreenCell): number {
    const fgRef = colorRef(cell.fg)
    const bgRef = colorRef(cell.bg)
    const ulRef = colorRef(cell.underlineColor)
    const urlRef = cell.url === null ? 0 : internString(cell.url) + 1
    const ulIdx = UNDERLINE_INDEX[cell.underline]
    if (ulIdx === undefined) {
      throw new Error(`vterm snapshot codec: unknown underline style ${String(cell.underline)}`)
    }
    let flags = 0
    if (cell.bold) flags |= F_BOLD
    if (cell.faint) flags |= F_FAINT
    if (cell.italic) flags |= F_ITALIC
    if (cell.overline) flags |= F_OVERLINE
    if (cell.strikethrough) flags |= F_STRIKE
    if (cell.inverse) flags |= F_INVERSE
    if (cell.hidden) flags |= F_HIDDEN
    if (cell.blink) flags |= F_BLINK
    if (cell.wide) flags |= F_WIDE
    flags |= ulIdx << UL_SHIFT

    const key = `${flags}|${fgRef}|${bgRef}|${ulRef}|${urlRef}`
    let idx = styleMap.get(key)
    if (idx === undefined) {
      idx = styleList.length
      styleList.push({ flags, fgRef, bgRef, ulRef, urlRef })
      styleMap.set(key, idx)
    }
    return idx
  }

  return { stringList, colorList, styleList, internString, internStyle }
}

// ── Grid encoding ──────────────────────────────────────────────────────

interface GridColumns {
  rowCount: number
  lenRuns: number[]
  charRuns: number[]
  styleRuns: number[]
}

function buildGridColumns(grid: ScreenCell[][], interner: Interner): GridColumns {
  const charAcc = createRunAccumulator()
  const styleAcc = createRunAccumulator()
  const lenAcc = createRunAccumulator()
  for (const row of grid) {
    lenAcc.push(row.length)
    for (const cell of row) {
      charAcc.push(interner.internString(cell.char))
      styleAcc.push(interner.internStyle(cell))
    }
  }
  return {
    rowCount: grid.length,
    lenRuns: lenAcc.runs,
    charRuns: charAcc.runs,
    styleRuns: styleAcc.runs,
  }
}

function writeGridSection(
  w: Writer,
  columns: GridColumns,
  softWrapped: boolean[] | undefined,
  softWrapNullable: boolean,
): void {
  w.varint(columns.rowCount)
  if (softWrapNullable && softWrapped === undefined) {
    w.u8(0)
  } else {
    if (softWrapNullable) w.u8(1)
    if (softWrapped === undefined) {
      throw new Error("vterm snapshot codec: missing soft-wrap array for a required grid")
    }
    if (softWrapped.length !== columns.rowCount) {
      throw new Error(`vterm snapshot codec: soft-wrap length ${softWrapped.length} != rowCount ${columns.rowCount}`)
    }
    writeBits(w, softWrapped)
  }
  writeRuns(w, columns.lenRuns)
  writeRuns(w, columns.charRuns)
  writeRuns(w, columns.styleRuns)
}

// ── Table encoding ─────────────────────────────────────────────────────

function writeStringTable(w: Writer, list: string[]): void {
  w.varint(list.length)
  for (const s of list) {
    const b = encoder.encode(s)
    w.varint(b.length)
    w.bytes(b)
  }
}

function writeColorTable(w: Writer, list: CellColor[]): void {
  w.varint(list.length)
  for (const c of list) {
    w.u8(c.r)
    w.u8(c.g)
    w.u8(c.b)
  }
}

function writeStyleTable(w: Writer, list: StyleTuple[]): void {
  w.varint(list.length)
  for (const st of list) {
    w.varint(st.flags)
    w.varint(st.fgRef)
    w.varint(st.bgRef)
    w.varint(st.ulRef)
    w.varint(st.urlRef)
  }
}

function readStringTable(r: Reader): string[] {
  const count = r.varint()
  const list = new Array<string>(count)
  for (let i = 0; i < count; i++) {
    const len = r.varint()
    list[i] = decoder.decode(r.take(len))
  }
  return list
}

function readColorTable(r: Reader): CellColor[] {
  const count = r.varint()
  const list = new Array<CellColor>(count)
  for (let i = 0; i < count; i++) {
    list[i] = { r: r.u8(), g: r.u8(), b: r.u8() }
  }
  return list
}

function readStyleTable(r: Reader): StyleTuple[] {
  const count = r.varint()
  const list = new Array<StyleTuple>(count)
  for (let i = 0; i < count; i++) {
    list[i] = {
      flags: r.varint(),
      fgRef: r.varint(),
      bgRef: r.varint(),
      ulRef: r.varint(),
      urlRef: r.varint(),
    }
  }
  return list
}

// ── Cell decoding ──────────────────────────────────────────────────────

function colorFromRef(ref: number, table: CellColor[]): CellColor | null {
  if (ref === 0) return null
  const c = table[ref - 1]
  if (c === undefined) {
    throw new Error(`vterm snapshot codec: color ref ${ref} out of range (table size ${table.length})`)
  }
  return { r: c.r, g: c.g, b: c.b }
}

function makeCell(
  charIdx: number,
  styleIdx: number,
  strings: string[],
  colors: CellColor[],
  styles: StyleTuple[],
): ScreenCell {
  const char = strings[charIdx]
  if (char === undefined) {
    throw new Error(`vterm snapshot codec: char ref ${charIdx} out of range (table size ${strings.length})`)
  }
  const style = styles[styleIdx]
  if (style === undefined) {
    throw new Error(`vterm snapshot codec: style ref ${styleIdx} out of range (table size ${styles.length})`)
  }
  const underline = UNDERLINE_STYLES[(style.flags >> UL_SHIFT) & UL_MASK]
  if (underline === undefined) {
    throw new Error(`vterm snapshot codec: invalid underline bits in style flags ${style.flags}`)
  }
  let url: string | null
  if (style.urlRef === 0) {
    url = null
  } else {
    const u = strings[style.urlRef - 1]
    if (u === undefined) {
      throw new Error(`vterm snapshot codec: url ref ${style.urlRef} out of range (table size ${strings.length})`)
    }
    url = u
  }
  return {
    char,
    fg: colorFromRef(style.fgRef, colors),
    bg: colorFromRef(style.bgRef, colors),
    bold: (style.flags & F_BOLD) !== 0,
    faint: (style.flags & F_FAINT) !== 0,
    italic: (style.flags & F_ITALIC) !== 0,
    underline,
    underlineColor: colorFromRef(style.ulRef, colors),
    overline: (style.flags & F_OVERLINE) !== 0,
    strikethrough: (style.flags & F_STRIKE) !== 0,
    inverse: (style.flags & F_INVERSE) !== 0,
    hidden: (style.flags & F_HIDDEN) !== 0,
    blink: (style.flags & F_BLINK) !== 0,
    wide: (style.flags & F_WIDE) !== 0,
    url,
  }
}

// ── Grid decoding ──────────────────────────────────────────────────────

interface DecodedGrid {
  grid: ScreenCell[][]
  softWrapped: boolean[] | undefined
}

function readGridSection(
  r: Reader,
  softWrapNullable: boolean,
  expected: { rows: number; cols: number } | null,
  strings: string[],
  colors: CellColor[],
  styles: StyleTuple[],
): DecodedGrid {
  const rowCount = r.varint()

  let softWrapped: boolean[] | undefined
  if (softWrapNullable) {
    const present = r.u8()
    if (present === 0) softWrapped = undefined
    else if (present === 1) softWrapped = readBits(r, rowCount)
    else throw new Error(`vterm snapshot codec: invalid soft-wrap presence byte ${present}`)
  } else {
    softWrapped = readBits(r, rowCount)
  }

  const rowLengths = expandLengths(readRuns(r))
  if (rowLengths.length !== rowCount) {
    throw new Error(`vterm snapshot codec: decoded ${rowLengths.length} row lengths but rowCount is ${rowCount}`)
  }
  if (expected) {
    if (rowCount !== expected.rows) {
      throw new Error(`vterm snapshot codec: grid rowCount ${rowCount} != expected ${expected.rows}`)
    }
    for (const len of rowLengths) {
      if (len !== expected.cols) {
        throw new Error(`vterm snapshot codec: grid row length ${len} != expected ${expected.cols}`)
      }
    }
  }

  let totalCells = 0
  for (const len of rowLengths) totalCells += len

  const charCursor = createRunCursor(readRuns(r))
  const styleCursor = createRunCursor(readRuns(r))
  if (charCursor.total !== totalCells) {
    throw new Error(`vterm snapshot codec: char column has ${charCursor.total} cells, grid needs ${totalCells}`)
  }
  if (styleCursor.total !== totalCells) {
    throw new Error(`vterm snapshot codec: style column has ${styleCursor.total} cells, grid needs ${totalCells}`)
  }

  const grid: ScreenCell[][] = new Array<ScreenCell[]>(rowCount)
  for (let row = 0; row < rowCount; row++) {
    const len = rowLengths[row]!
    const cells = new Array<ScreenCell>(len)
    for (let col = 0; col < len; col++) {
      cells[col] = makeCell(charCursor.next(), styleCursor.next(), strings, colors, styles)
    }
    grid[row] = cells
  }

  return { grid, softWrapped }
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Encode a {@link ScreenSnapshot} to a compact binary buffer. Output is
 * deterministic for identical input and decodes back to a deep-equal snapshot.
 */
export function encodeScreenSnapshotBinary(snapshot: ScreenSnapshot): Uint8Array {
  const w = createWriter()
  w.u8(VERSION)

  const header: SnapshotHeader = {
    cols: snapshot.cols,
    rows: snapshot.rows,
    scrollbackLimit: snapshot.scrollbackLimit,
    activeBuffer: snapshot.activeBuffer,
    cursor: snapshot.cursor,
    savedState: snapshot.savedState,
    attrs: snapshot.attrs,
    modes: snapshot.modes,
    margins: snapshot.margins,
    colors: snapshot.colors,
    tabStops: snapshot.tabStops,
    title: snapshot.title,
    clipboard: snapshot.clipboard,
    cwd: snapshot.cwd,
    notifications: snapshot.notifications,
    viewportOffset: snapshot.viewportOffset,
    parser: snapshot.parser,
    unicode: snapshot.unicode,
  }
  const headerBytes = encoder.encode(JSON.stringify(header))
  w.varint(headerBytes.length)
  w.bytes(headerBytes)

  // One interning pass over all three grids, in a fixed order, builds the shared
  // tables and the per-grid columns together (so table indices are deterministic).
  const interner = createInterner()
  const mainColumns = buildGridColumns(snapshot.main.grid, interner)
  const altColumns = buildGridColumns(snapshot.alt.grid, interner)
  const scrollbackColumns = buildGridColumns(snapshot.scrollback, interner)

  writeStringTable(w, interner.stringList)
  writeColorTable(w, interner.colorList)
  writeStyleTable(w, interner.styleList)

  writeGridSection(w, mainColumns, snapshot.main.softWrapped, false)
  writeGridSection(w, altColumns, snapshot.alt.softWrapped, false)
  writeGridSection(w, scrollbackColumns, snapshot.scrollbackSoftWrapped, true)

  return w.finish()
}

/**
 * Decode a buffer produced by {@link encodeScreenSnapshotBinary} back into a
 * {@link ScreenSnapshot}. Throws loudly on an unknown version byte, truncated
 * input, or any internal inconsistency — never returns a partial/normalized result.
 */
export function decodeScreenSnapshotBinary(bytes: Uint8Array): ScreenSnapshot {
  const r = createReader(bytes)

  const version = r.u8()
  if (version !== VERSION) {
    throw new Error(`vterm snapshot codec: unsupported version byte ${version} (expected ${VERSION})`)
  }

  const headerLen = r.varint()
  const header = JSON.parse(decoder.decode(r.take(headerLen))) as SnapshotHeader

  const strings = readStringTable(r)
  const colors = readColorTable(r)
  const styles = readStyleTable(r)

  const geom = { rows: header.rows, cols: header.cols }
  const main = readGridSection(r, false, geom, strings, colors, styles)
  const alt = readGridSection(r, false, geom, strings, colors, styles)
  const scrollback = readGridSection(r, true, null, strings, colors, styles)

  const result: ScreenSnapshot = {
    version: 1,
    cols: header.cols,
    rows: header.rows,
    scrollbackLimit: header.scrollbackLimit,
    activeBuffer: header.activeBuffer,
    main: { grid: main.grid, softWrapped: main.softWrapped! },
    alt: { grid: alt.grid, softWrapped: alt.softWrapped! },
    scrollback: scrollback.grid,
    // Round-trips `undefined` faithfully (the legacy "field absent" case); the
    // declared type is boolean[], which every current snapshot satisfies.
    scrollbackSoftWrapped: scrollback.softWrapped as boolean[],
    cursor: header.cursor,
    savedState: header.savedState,
    attrs: header.attrs,
    modes: header.modes,
    margins: header.margins,
    colors: header.colors,
    tabStops: header.tabStops,
    title: header.title,
    clipboard: header.clipboard,
    cwd: header.cwd,
    notifications: header.notifications,
    viewportOffset: header.viewportOffset,
    parser: header.parser,
    unicode: header.unicode,
  }
  return result
}
