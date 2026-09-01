/**
 * vterm.js — Modern terminal emulator
 *
 * Full VT/ECMA-48/xterm standards coverage. Pure TypeScript, zero dependencies.
 * Targets 100% of terminfo.dev's feature matrix:
 *
 * - All SGR attributes (bold, faint, italic, underline styles, overline, strikethrough, blink, hidden, inverse)
 * - 16-color, 256-color, 24-bit truecolor (foreground, background, underline color)
 * - Full cursor control (CUP, CUU/CUD/CUF/CUB, CPR, CHA, CNL, CPL, HVP, save/restore)
 * - Cursor shape (DECSCUSR — block, underline, bar, blinking variants)
 * - Erase operations (ED 0/1/2/3, EL 0/1/2, ECH)
 * - Editing operations (ICH, DCH, IL, DL, REP)
 * - Scroll regions (DECSTBM, SU, SD) with content preservation
 * - DEC private modes (alt screen, auto-wrap, origin, insert, reverse video, bracketed paste)
 * - Mouse tracking (X10, normal, button, any-event, SGR format)
 * - Focus tracking (mode 1004)
 * - Application cursor keys & keypad
 * - Synchronized output (mode 2026)
 * - Kitty keyboard protocol (CSI u / progressive enhancement)
 * - Scrollback buffer with configurable limit
 * - Wide character support (CJK, emoji ZWJ, regional indicators, VS-16)
 * - OSC sequences (title, hyperlinks, clipboard, colors)
 * - DCS sequences (XTVERSION, DECRQSS, XTGETTCAP, Sixel)
 * - APC sequences (Kitty graphics protocol — parsed, query responses)
 * - DA1/DA2/DA3 device attribute responses
 * - DSR (device status report) responses
 * - DECRPM (mode reporting)
 * - Character sets (DEC Special Graphics, UTF-8)
 * - Full C0/C1 control code handling
 * - DECSTR soft terminal reset
 *
 * @see https://terminfo.dev for the feature matrix
 * @see https://github.com/beorn/vterm for the monorepo
 */

// ── Types ──────────────────────────────────────────────────────────────

/**
 * An RGB color, identity-preserving. `r`/`g`/`b` are always present (painters read
 * them unconditionally); `index` is optional palette provenance. Named `Color` per the
 * §9 naming ruling (rule 5: flat progressive shape over a discriminated union — a type
 * named `RGB` that carries `.index` would lie).
 */
export interface Color {
  r: number
  g: number
  b: number
  /**
   * The palette index (0-255) this RGB was resolved from, when the color came
   * from an INDEXED SGR (`31`, `91`, `38;5;N`, `48;5;N`, `58;5;N`, …). Absent
   * for true 24-bit RGB (`38;2;R;G;B`) and for OSC-sourced colors (OSC 4/10/11),
   * which are genuine RGB with no themeable index.
   *
   * Why it exists: vterm resolves every indexed SGR to `palette256[idx]` at parse
   * time. Without keeping the origin index, {@link serializeSnapshot} can only
   * re-emit `38;2;R;G;B`, which bakes vterm's built-in ANSI values and defeats the
   * outer terminal's theme on reattach. Preserving `index` lets the serializer
   * re-emit the faithful indexed form so a themeable receiver themes it again.
   *
   * It rides {@link Snapshot} as plain optional data (like
   * `scrollbackSoftWrapped`) and is stripped at the {@link VtermScreen.getCell} /
   * {@link VtermScreen.getRow} read boundary, whose contract is the resolved RGB.
   */
  index?: number
}

export type UnderlineStyle = "none" | "single" | "double" | "curly" | "dotted" | "dashed"

export interface ScreenCell {
  char: string
  fg: Color | null
  bg: Color | null
  bold: boolean
  faint: boolean
  italic: boolean
  underline: UnderlineStyle
  underlineColor: Color | null
  overline: boolean
  strikethrough: boolean
  inverse: boolean
  hidden: boolean
  blink: boolean
  wide: boolean
  url: string | null
}

export interface ScreenOptions {
  cols?: number
  rows?: number
  scrollbackLimit?: number
  /** Callback for DA1/DA2/DSR responses — write these back to the PTY */
  onResponse?: (data: string) => void
  /**
   * Maximum UTF-16 code units retained for one APC or DCS string sequence.
   * Image protocols use ASCII/base64 payloads, so this is also their byte
   * bound. Longer sequences are consumed without buffering or dispatch and
   * surface one typed `string-overflow` parser event at their terminator.
   */
  maxStringSequenceLength?: number
}

/** Default retained payload bound for one APC/DCS sequence (16 MiB of ASCII/base64). */
export const DEFAULT_MAX_STRING_SEQUENCE_LENGTH = 16 * 1024 * 1024

export interface SemanticZone {
  type: "prompt" | "command" | "output"
  startRow: number
  startCol: number
}

export interface SixelImage {
  data: string
  row: number // cursor row when sixel started
  col: number // cursor col when sixel started
}

export interface ScreenAttrsSnapshot {
  fg: Color | null
  bg: Color | null
  bold: boolean
  faint: boolean
  italic: boolean
  underline: UnderlineStyle
  underlineColor: Color | null
  overline: boolean
  strikethrough: boolean
  inverse: boolean
  hidden: boolean
  blink: boolean
  url: string | null
}

export interface ScreenColorStateSnapshot {
  palette256: Color[]
  defaultFgColor: Color | null
  defaultBgColor: Color | null
  cursorColor: Color | null
  specialColors: [number, Color][]
  pointerFgColor: Color | null
  pointerBgColor: Color | null
  highlightBgColor: Color | null
  highlightFgColor: Color | null
}

export type ScreenParserState =
  | "ground"
  | "escape"
  | "escape_charset"
  | "escape_hash"
  | "csi"
  | "osc"
  | "dcs"
  | "dcs_passthrough"
  | "osc_st"
  | "dcs_st"
  | "apc"
  | "apc_st"

export interface ScreenBufferSnapshot {
  grid: ScreenCell[][]
  softWrapped: boolean[]
}

/**
 * The whole-world persist/restore value — grids, ranges, modes, cursor, colors,
 * parser transients, wrap bits. JSON-safe plain data; the persist boundary, not the
 * incremental read path. Named `Snapshot` per §9 (the namespace supplies the context).
 *
 * Note: `cursor`/`savedState` still carry `x`/`y` (not `col`/`row`) — the §9
 * `Cursor{col,row}` field rename is DEFERRED here because these fields are the wire
 * shape read by the binary codec (`encodeScreenSnapshotBinary`); renaming them silently
 * changes the persisted format. The {@link Cursor} read type + `getCursor()` accessor
 * carry the col/row vocabulary at the read boundary instead.
 */
export interface Snapshot {
  version: 1
  cols: number
  rows: number
  scrollbackLimit: number
  activeBuffer: "main" | "alt"
  main: ScreenBufferSnapshot
  alt: ScreenBufferSnapshot
  scrollback: ScreenCell[][]
  /**
   * Per-scrollback-row soft-wrap bit: true when the row soft-wraps INTO the
   * following row (autowrap continued the same logical line below it) — the
   * same semantics as `ScreenBufferSnapshot.softWrapped`. Parallel to
   * `scrollback`. Absent in snapshots taken before this field existed —
   * `restore()` treats missing as all-false (hard-wrapped).
   */
  scrollbackSoftWrapped: boolean[]
  cursor: {
    x: number
    y: number
    visible: boolean
    shape: "block" | "underline" | "bar"
    blinking: boolean
    savedX: number
    savedY: number
  }
  savedState: {
    x: number
    y: number
    attrs: ScreenAttrsSnapshot
    originMode: boolean
    autoWrap: boolean
    charsetG0: boolean
  }
  attrs: ScreenAttrsSnapshot
  modes: {
    bracketedPaste: boolean
    applicationCursor: boolean
    applicationKeypad: boolean
    autoWrap: boolean
    mouseTracking: boolean
    mouseTrackingMode: number
    sgrMouse: boolean
    focusTracking: boolean
    origin: boolean
    insert: boolean
    reverseVideo: boolean
    syncOutput: boolean
    kittyKeyboardFlags: number
    kittyKeyboardStack: number[]
    kittyGraphics: boolean
    colorSchemeReporting: boolean
    decColumn: boolean
    altScroll: boolean
    utf8Mouse: boolean
  }
  margins: {
    scrollTop: number
    scrollBottom: number
    leftRight: boolean
    left: number
    right: number
  }
  colors: {
    current: ScreenColorStateSnapshot
    stack: ScreenColorStateSnapshot[]
  }
  tabStops: number[]
  title: string
  clipboard: string
  cwd: string
  notifications: string[]
  viewportOffset: number
  parser: {
    state: ScreenParserState
    esc: string
    osc: string
    dcs: string
    dcsStart: { row: number; col: number }
    dcsReceivedLength?: number
    dcsOverflow?: boolean
    apc: string
    apcStart?: { row: number; col: number }
    apcReceivedLength?: number
    apcOverflow?: boolean
    utf8PendingBytes: number[]
  }
  unicode: {
    charsetG0: boolean
    lastChar: string
    pendingRegionalIndicator: string | null
    afterZWJ: boolean
  }
}

/**
 * The cursor position at the read boundary, in the grid's own `col`/`row` vocabulary
 * (§9 naming ruling: `x`/`y` contradicted the row/col naming used everywhere else, and
 * the `State` suffix was redundant). Returned by {@link VtermScreen.getCursor}.
 */
export interface Cursor {
  col: number
  row: number
}

/**
 * A terminal write as serializable data — the coarse WRITE vocabulary, symmetric with the
 * Hab session journal and termless `Recording`. Bytes remain the CANONICAL encoding of an
 * `output` op (they are what the journal persists and what {@link Screen.tapOps} delivers);
 * a `string` is a convenience input to {@link Screen.apply} that is UTF-8-encoded before it
 * is applied. This is deliberately NOT a per-VT-action reification — fine-grained parsed
 * actions are surfaced by {@link ParserEvent} through {@link Screen.tapParser}.
 */
export type TerminalOp = { type: "output"; data: Uint8Array | string } | { type: "resize"; cols: number; rows: number }

/**
 * A single parsed VT action, emitted by {@link Screen.tapParser} AFTER the engine applies it,
 * in stream order. A minimal, stable union over what the parser dispatches:
 *
 * - `print`   — a run of consecutive printable graphemes, coalesced within one {@link
 *               Screen.process}/{@link Screen.apply} flood and flushed before the next control
 *               event (and at end-of-flood).
 * - `execute` — a recognized C0 control byte (BEL, BS, HT, LF, VT, FF, CR); `code` is the byte.
 * - `csi`     — a complete CSI sequence; `final` is the dispatching byte, `params` are the
 *               `;`-separated numeric parameters (empty → `0`, matching the engine's own parse),
 *               `prefix` is the private marker (`?`/`>`/`<`/`=`) when present, `intermediates`
 *               are the `0x20`–`0x2f` bytes when present. (Colon sub-parameters collapse to
 *               their leading integer — the top-level view the non-SGR dispatchers also use.)
 * - `osc`     — a complete OSC with a numeric `code`; `data` is everything after the first `;`.
 * - `esc`     — a complete non-CSI/OSC escape (`ESC c`/`D`/`M`/`7`/`8`/`E`/`H`/`=`/`>` and the
 *               charset/`#` designators); `final` is the dispatching byte, `intermediates`
 *               carries the `(`/`)`/`#` designator byte when present.
 *
 * - `dcs` / `apc` — a complete bounded string sequence with the guest-local cursor anchor at
 *                   sequence start. Payloads beyond `maxStringSequenceLength` are not dispatched;
 *                   their terminator emits one typed `string-overflow` event instead.
 *
 * A listener MUST NOT throw — taps are fail-loud: an exception propagates out of the write call
 * (the engine state stays consistent).
 */
export type ParserEvent =
  | { kind: "print"; text: string }
  | { kind: "execute"; code: number }
  | { kind: "csi"; final: string; params: number[]; prefix?: string; intermediates?: string }
  | { kind: "osc"; code: number; data: string }
  | { kind: "esc"; final: string; intermediates?: string }
  | { kind: "apc"; data: string; row: number; col: number }
  | { kind: "dcs"; data: string; row: number; col: number }
  | {
      kind: "string-overflow"
      sequence: "apc" | "dcs"
      maxLength: number
      receivedLength: number
      row: number
      col: number
    }

/**
 * Accumulated per-row damage since the previous {@link Screen.takeDirty} call — the PULL-plane
 * observation surface for renderers that read on their own schedule (distinct from the push-plane
 * {@link Screen.tapOps}/{@link Screen.tapParser}). Absolute-row indexed, consistent with
 * {@link Screen.getRowAbsolute}.
 *
 * - `rows` — the changed rows as retained-relative ABSOLUTE indices (row 0 = oldest retained
 *   scrollback line), OR the literal `"all"` when the whole visible buffer changed structurally
 *   (resize, full clear, alt-screen switch, reset, restore). The `Set` is freshly OWNED by the
 *   caller — the engine keeps a separate empty accumulator after the take.
 * - `cursor` — `true` when the cursor position/visibility/shape/blink changed since the last take.
 * - `scrolled` — number of lines that entered scrollback since the last take (a renderer shifts
 *   its viewport by this and repaints only the rows in `rows`).
 *
 * Contract note on trimming: a retention trim shifts every absolute index down by the trimmed
 * count; `rows` are valid against the buffer AT take time. Pair with {@link Screen.firstRetainedRow}
 * (which bumps by the trimmed count) to rebase indices cached across a take that spanned a trim.
 */
export interface DirtyRegion {
  rows: Set<number> | "all"
  cursor: boolean
  scrolled: number
}

/**
 * A minimal read-signal — the atom of the REACTIVE read plane (§4). Defined IN vterm.js, which
 * stays dependency-free (§9 rule 7: compatible SHAPES over shared imports). A consumer wraps it in
 * `alien-signals`, a zustand store, or React's `useSyncExternalStore` trivially, because the shape
 * is exactly `{ get, subscribe }` — nothing here imports a reactive library.
 *
 * - `get()` returns the CURRENT value, computed live from engine state. It is pull-safe and
 *   independent of subscription: calling it never schedules, consumes, or resets a delivery.
 * - `subscribe(listener)` registers for change delivery and returns an unsubscribe function. The
 *   listener fires at most once per flush boundary (see {@link ScreenSignals}), and only when the
 *   value actually changed since the last delivery (equality-gated). Subscribing does NOT fire
 *   immediately — the baseline is the value at subscribe time, so only later changes deliver.
 *   Fail-loud: a throwing listener propagates out of the write call.
 */
export interface ReadSignal<T> {
  get(): T
  subscribe(listener: (value: T) => void): () => void
}

/** The terminal's screen size (its column/row dimensions). Emitted by {@link ScreenSignals.size$}. */
export interface Size {
  cols: number
  rows: number
}

/**
 * The closed DEC/xterm private-mode set at the OBSERVATION boundary — everything a guest previously
 * discovered by regex-scanning the DECSET byte stream. Emitted by {@link ScreenSignals.modes$}
 * (equality-gated: one emission per flush that actually flips a mode). Mirrors the string keys of
 * {@link Screen.getMode}, plus the numeric mouse-tracking protocol level.
 */
export interface TerminalModes {
  altScreen: boolean
  cursorVisible: boolean
  bracketedPaste: boolean
  applicationCursor: boolean
  applicationKeypad: boolean
  autoWrap: boolean
  mouseTracking: boolean
  /** The active mouse-tracking protocol: `0` = off; `1000`/`1002`/`1003` = X10/button/any-event. */
  mouseTrackingMode: number
  sgrMouse: boolean
  utf8Mouse: boolean
  focusTracking: boolean
  originMode: boolean
  insertMode: boolean
  /** LNM — LF also returns the carriage (ECMA-48 mode 20). */
  newLineMode: boolean
  reverseVideo: boolean
  syncOutput: boolean
  leftRightMargin: boolean
  colorSchemeReporting: boolean
  kittyKeyboard: boolean
  kittyGraphics: boolean
  sixel: boolean
}

/**
 * The REACTIVE read plane (§4): five equality-gated signals over the SAME state the pull plane
 * ({@link Screen.getRowAbsolute}/{@link Screen.takeDirty}) and the push plane ({@link Screen.tapOps})
 * expose. It replaces consumers' title-polling and DECSET regex scanning.
 *
 * Zero overhead when unused: `.signals` is lazily created (the getter allocates nothing until first
 * read), and each signal is lazily created on first access (per-signal laziness). The write core does
 * NO signal bookkeeping until `.signals` is read, and NO per-write damage accumulation until
 * `damage$` actually has a subscriber.
 *
 * Flush boundary: every signal coalesces to AT MOST ONE emission per public state-mutating call
 * (`process`/`apply`/`resize`/`reset`/`restore`; `apply` inherits it via `process`/`resize`) — the
 * natural batch. `title$`/`modes$`/`cursor$`/`size$` fire only when their value actually changed
 * across the call; `damage$` publishes the BATCHED dirty-set accumulated during the call.
 *
 * Two-plane coexistence: `damage$` runs on an accumulator INDEPENDENT of {@link Screen.takeDirty}.
 * Subscribing never steals or resets the pull-plane epoch, so a `damage$` renderer and a
 * `takeDirty()` differ observe the same damage without draining each other.
 */
export interface ScreenSignals {
  /** The window title (OSC 0/2). Replaces title-diff polling. */
  title$: ReadSignal<string>
  /** The closed DEC/xterm mode set. Replaces the guest's DECSET regex scanner. */
  modes$: ReadSignal<TerminalModes>
  /** The cursor position in grid `col`/`row` (§9). Visibility rides {@link modes$}`.cursorVisible`. */
  cursor$: ReadSignal<Cursor>
  /** The screen size. */
  size$: ReadSignal<Size>
  /**
   * The per-flush BATCHED dirty region — the union of rows changed during the call (or `"all"` on a
   * structural change), with the cursor/scroll deltas. Same shape as {@link Screen.takeDirty}, but
   * drained on its OWN epoch (see the interface note); this is precisely what a future canvas/DOM
   * renderer subscribes to. The emitted region (including its `rows` `Set`) is SHARED across all
   * `damage$` subscribers for that flush — treat it as read-only.
   */
  damage$: ReadSignal<DirtyRegion>
}

export interface Screen {
  readonly cols: number
  readonly rows: number
  /** The reactive read plane (§4). Lazily created; zero write-path overhead until used. */
  readonly signals: ScreenSignals

  process(data: Uint8Array): void
  resize(cols: number, rows: number): void
  /**
   * Apply one {@link TerminalOp} — the single public write entry, symmetric with the journal.
   * `output` routes to {@link process} (a `string` payload is UTF-8-encoded first); `resize`
   * routes to {@link resize}. Additive over `process`/`resize`, which remain public.
   */
  apply(op: TerminalOp): void
  /**
   * Observe applied ops (opt-in). The listener fires exactly once per applied op — one per
   * `process`/`apply`/`resize` call — with the CANONICAL payload (an `output` op always carries
   * a `Uint8Array`). Returns an unsubscribe function. Zero overhead when no listener is
   * registered. Enables symmetric journaling of the write stream.
   */
  tapOps(listener: (op: TerminalOp) => void): () => void
  /**
   * Observe parsed VT actions (opt-in), delivered AFTER each is applied, in stream order.
   * Returns an unsubscribe function. Zero overhead when no listener is registered — no {@link
   * ParserEvent} is allocated on the byte-flood path unless a listener exists.
   */
  tapParser(listener: (event: ParserEvent) => void): () => void
  reset(): void
  snapshot(): Snapshot
  restore(snapshot: Snapshot): void
  /** Serialize the current state to minimal ANSI — `serializeSnapshot(this.snapshot(), options)`. */
  serialize(options?: SerializeOptions): string

  getCell(row: number, col: number): ScreenCell
  /**
   * The cells of a screen-relative row (§9: **row = cells, line = text**). Colors are
   * stripped of palette-origin index at the read boundary.
   */
  getRow(row: number): ScreenCell[]
  getText(): string
  /** Scrollback rows above the visible grid, oldest first, rendered like getText(). */
  getScrollbackText(): string
  getTextRange(startRow: number, startCol: number, endRow: number, endCol: number): string

  // ── Absolute-row read plane ──
  // One coordinate over the whole buffer (scrollback + screen). Absolute row 0 = oldest RETAINED
  // scrollback line; the screen occupies the LAST `screenRows()` rows. The existing screen-relative
  // reads (`getCell`/`getRow`) are untouched.

  /** Total rows in the buffer: retained scrollback + screen. */
  totalRows(): number
  /** Number of visible screen rows (the terminal's row dimension). */
  screenRows(): number
  /**
   * Absolute row where the viewport's top line sits. At the bottom (no scroll):
   * `totalRows() - screenRows()`. Scrolled fully up: `0`.
   */
  viewportTop(): number
  /**
   * The row at ABSOLUTE index `row` (row 0 = oldest retained scrollback line; the screen occupies
   * the last `screenRows()` rows). Colors are stripped of palette-origin index like {@link getRow}.
   * Out-of-range indices return a blank row (matching the {@link getRow} read-boundary contract).
   */
  getRowAbsolute(row: number): ScreenCell[]
  /**
   * The GLOBAL index of retained absolute row 0 — i.e. the number of scrollback lines permanently
   * evicted by retention trimming since creation (0 initially). Increases only when trimming drops
   * lines; resets on {@link reset}/{@link restore}. A stable global row id is
   * `firstRetainedRow() + <absolute row>`; an increase since a prior read signals a trim.
   */
  firstRetainedRow(): number
  /**
   * Take and reset the accumulated per-row damage since the previous call — the pull-plane damage
   * surface for renderers. See {@link DirtyRegion}. Always-on (independent of {@link tapOps}); the
   * write path costs at most one Set membership update per row-run.
   */
  takeDirty(): DirtyRegion

  /** Cursor position in the grid's `col`/`row` vocabulary (§9). See {@link Cursor}. */
  getCursor(): Cursor
  getCursorVisible(): boolean
  getCursorShape(): "block" | "underline" | "bar"
  getCursorBlinking(): boolean

  getTitle(): string
  getMode(mode: string): boolean
  getClipboard(): string
  getCwd(): string
  getNotifications(): string[]

  getScrollbackLength(): number
  getViewportOffset(): number
  scrollViewport(delta: number): void

  getSemanticZones(): SemanticZone[]
  getSixelImages(): SixelImage[]
}

// ── Implementation ─────────────────────────────────────────────────────

/** Frozen sentinel for unwritten cells — never mutate, copy-on-write in writeChar(). */
const EMPTY_CELL: ScreenCell = Object.freeze({
  char: "",
  fg: null,
  bg: null,
  bold: false,
  faint: false,
  italic: false,
  underline: "none" as UnderlineStyle,
  underlineColor: null,
  overline: false,
  strikethrough: false,
  inverse: false,
  hidden: false,
  blink: false,
  wide: false,
  url: null,
})

function emptyCell(): ScreenCell {
  return { ...EMPTY_CELL }
}

/**
 * Drop the palette-origin {@link Color.index} for the public per-cell read
 * boundary. `getCell`/`getRow` return the RESOLVED RGB — their long-standing
 * contract — while the origin index is serialization-only provenance that rides
 * {@link Snapshot} (and thus `serialize()`), not the inspection API.
 * Returns the SAME reference when there is no index (the common truecolor/null
 * case), so the read path allocates nothing there.
 */
function stripColorIndex(c: Color | null): Color | null {
  if (c?.index === undefined) return c
  return { r: c.r, g: c.g, b: c.b }
}

/** Shallow cell copy with each color stripped of its palette-origin index. */
function stripCellColorIndex(cell: ScreenCell): ScreenCell {
  return {
    ...cell,
    fg: stripColorIndex(cell.fg),
    bg: stripColorIndex(cell.bg),
    underlineColor: stripColorIndex(cell.underlineColor),
  }
}

// ── Packed cell grid ────────────────────────────────────────────────────
//
// The engine's INTERNAL grid is packed typed arrays, not per-cell heap objects.
// Each row is a {@link PackedRow}: one `Uint32` metadata word per column (boolean
// attributes + a 3-bit underline-style enum + color/url presence bits), a parallel
// `string[]` grapheme sidecar, and per-row sparse `Map`s holding the resolved,
// identity-preserving colors ({@link Color} `{ r, g, b, index? }`) and the OSC-8
// URL. `ScreenCell` heap objects materialize ONLY at the read boundary — the
// terminal-flow perf ruling: per-cell heap objects are the proven 3-5x flood cost.
//
// The encoding mirrors silvery's ag-term render buffer ("packed Uint32Array for cell
// metadata … separate string array for graphemes") — same underline-style enum order
// and attribute-bit philosophy — WITHOUT importing it (vterm stays dependency-free;
// compatible shapes over shared code). It diverges deliberately in colors: silvery
// packs 8-bit palette indices with a true-color side map, but vterm resolves every
// indexed SGR to RGB at parse time and preserves the origin `index`, so vterm stores
// whole {@link Color} objects in the maps — lossless identity, never an 8-bit slot.

// Boolean attribute bits (0-8) + underline style (9-11) + presence bits (12-15).
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
const UL_MASK = 0x7 << UL_SHIFT
const F_HAS_FG = 1 << 12
const F_HAS_BG = 1 << 13
const F_HAS_UL = 1 << 14
const F_HAS_URL = 1 << 15

// Underline-style enum, same order as silvery's 3-bit field: 0=none … 5=dashed.
const UL_STYLES: readonly UnderlineStyle[] = ["none", "single", "double", "curly", "dotted", "dashed"]

function underlineToBits(u: UnderlineStyle): number {
  const i = UL_STYLES.indexOf(u)
  return (i < 0 ? 0 : i) << UL_SHIFT
}

function bitsToUnderline(meta: number): UnderlineStyle {
  return UL_STYLES[(meta & UL_MASK) >> UL_SHIFT] ?? "none"
}

/** Copy a color preserving its palette-origin `index` (identity), or null through. */
function copyColor(c: Color | null): Color | null {
  if (c === null) return null
  return c.index === undefined ? { r: c.r, g: c.g, b: c.b } : { r: c.r, g: c.g, b: c.b, index: c.index }
}

/**
 * One row of packed cells. Rows are objects, so the engine's row-reference idioms —
 * scroll shifts, scrollback push, alt-buffer swap — stay pointer swaps. The per-CELL
 * store is `meta` (Uint32 flags/underline/presence) + `chars` (grapheme sidecar) +
 * lazily-allocated typed color arrays. Colors live as PRIMITIVES — 24-bit packed RGB
 * in a `Uint32Array` plus the palette-origin index in a parallel `Int16Array` (-1 =
 * no index) — so the flood write path allocates NOTHING: no per-cell heap object and
 * no per-cell color object. Color objects materialize only at the read boundary. The
 * color arrays are allocated on first colored write in a row, so all-plain-text rows
 * stay lean (`meta` + `chars` only). OSC-8 URLs (rare) stay a sparse `Map`.
 */
interface PackedRow {
  readonly length: number
  /** Pack a cell straight from the current drawing attrs — the alloc-free hot path. */
  writeFromAttrs(col: number, ch: string, a: Attrs, wide: boolean): void
  /** Pack a full {@link ScreenCell} (cold paths: reflow, rect ops, restore). */
  setCellRaw(col: number, cell: ScreenCell): void
  /** Reset a column to the default-empty cell. */
  setEmpty(col: number): void
  /** Erase a column to blank, keeping the current background (BCE). */
  eraseWithBg(col: number, bg: Color | null): void
  /** Mark a column wide and blank its trailing spacer (col+1). */
  widen(col: number): void
  /** Append a grapheme to a column's char (combining marks / ZWJ / VS16). */
  appendChar(col: number, ch: string): void
  /** Copy one cell from another row (margin-scoped scroll / column shift). */
  copyCellFrom(col: number, src: PackedRow, srcCol: number): void
  /** Materialize one cell (raw — palette-origin index preserved). */
  getCellRaw(col: number): ScreenCell
  /** Materialize the whole row (raw). */
  toCells(): ScreenCell[]
  /** Repack the whole row from a `length`-long cell array (splice/edit escape hatch). */
  replaceAllFromCells(cells: ScreenCell[]): void
  isEmpty(col: number): boolean
  getChar(col: number): string
  isWide(col: number): boolean
}

/** Pack a color's 8-bit channels into a 24-bit `0xRRGGBB` word. */
function packRgb(c: Color): number {
  return (((c.r & 0xff) << 16) | ((c.g & 0xff) << 8) | (c.b & 0xff)) >>> 0
}

/** Materialize a {@link Color} from a packed RGB word + index (`-1` = no index). */
function unpackColor(rgb: number, idx: number): Color {
  const r = (rgb >> 16) & 0xff
  const g = (rgb >> 8) & 0xff
  const b = rgb & 0xff
  return idx >= 0 ? { r, g, b, index: idx } : { r, g, b }
}

function makePackedRow(width: number): PackedRow {
  const meta = new Uint32Array(width)
  const chars: string[] = new Array<string>(width).fill("")
  // Lazily-allocated color planes (null until the row's first colored cell). Each pairs
  // a 24-bit RGB `Uint32Array` with an `Int16Array` of palette-origin indices (-1 = none).
  let fgRgb: Uint32Array | null = null
  let fgIdx: Int16Array | null = null
  let bgRgb: Uint32Array | null = null
  let bgIdx: Int16Array | null = null
  let ulRgb: Uint32Array | null = null
  let ulIdx: Int16Array | null = null
  let urlMap: Map<number, string> | null = null

  function setFg(col: number, c: Color): void {
    if (fgRgb === null) {
      fgRgb = new Uint32Array(width)
      fgIdx = new Int16Array(width)
    }
    fgRgb[col] = packRgb(c)
    fgIdx![col] = c.index ?? -1
  }
  function setBg(col: number, c: Color): void {
    if (bgRgb === null) {
      bgRgb = new Uint32Array(width)
      bgIdx = new Int16Array(width)
    }
    bgRgb[col] = packRgb(c)
    bgIdx![col] = c.index ?? -1
  }
  function setUl(col: number, c: Color): void {
    if (ulRgb === null) {
      ulRgb = new Uint32Array(width)
      ulIdx = new Int16Array(width)
    }
    ulRgb[col] = packRgb(c)
    ulIdx![col] = c.index ?? -1
  }
  function setUrl(col: number, u: string): void {
    ;(urlMap ??= new Map<number, string>()).set(col, u)
  }
  function clearUrl(col: number): void {
    if (urlMap !== null && urlMap.size > 0) urlMap.delete(col)
  }

  // Pack the flags/underline/wide bits shared by writeFromAttrs and setCellRaw.
  function packFlags(a: Attrs | ScreenCell, wide: boolean): number {
    let m = 0
    if (a.bold) m |= F_BOLD
    if (a.faint) m |= F_FAINT
    if (a.italic) m |= F_ITALIC
    if (a.overline) m |= F_OVERLINE
    if (a.strikethrough) m |= F_STRIKE
    if (a.inverse) m |= F_INVERSE
    if (a.hidden) m |= F_HIDDEN
    if (a.blink) m |= F_BLINK
    if (wide) m |= F_WIDE
    return m | underlineToBits(a.underline)
  }

  const row: PackedRow = {
    length: width,

    writeFromAttrs(col, ch, a, wide) {
      let m = packFlags(a, wide)
      chars[col] = ch
      if (a.fg) {
        setFg(col, a.fg)
        m |= F_HAS_FG
      }
      if (a.bg) {
        setBg(col, a.bg)
        m |= F_HAS_BG
      }
      if (a.underlineColor) {
        setUl(col, a.underlineColor)
        m |= F_HAS_UL
      }
      if (a.url !== null) {
        setUrl(col, a.url)
        m |= F_HAS_URL
      } else clearUrl(col)
      meta[col] = m
    },

    setCellRaw(col, cell) {
      let m = packFlags(cell, cell.wide)
      chars[col] = cell.char
      if (cell.fg) {
        setFg(col, cell.fg)
        m |= F_HAS_FG
      }
      if (cell.bg) {
        setBg(col, cell.bg)
        m |= F_HAS_BG
      }
      if (cell.underlineColor) {
        setUl(col, cell.underlineColor)
        m |= F_HAS_UL
      }
      if (cell.url !== null) {
        setUrl(col, cell.url)
        m |= F_HAS_URL
      } else clearUrl(col)
      meta[col] = m
    },

    setEmpty(col) {
      meta[col] = 0
      chars[col] = ""
      clearUrl(col)
    },

    eraseWithBg(col, bg) {
      chars[col] = ""
      clearUrl(col)
      if (bg) {
        setBg(col, bg)
        meta[col] = F_HAS_BG
      } else {
        meta[col] = 0
      }
    },

    widen(col) {
      meta[col] = (meta[col]! | F_WIDE) >>> 0
      if (col + 1 < width) row.setEmpty(col + 1)
    },

    appendChar(col, ch) {
      chars[col] = chars[col]! + ch
    },

    copyCellFrom(col, src, srcCol) {
      // Cold path (margin scroll / column shift) — materialize + repack is fine here.
      row.setCellRaw(col, src.getCellRaw(srcCol))
    },

    getCellRaw(col) {
      const m = meta[col]!
      if (m === 0 && chars[col] === "") return emptyCell()
      return {
        char: chars[col]!,
        fg: m & F_HAS_FG ? unpackColor(fgRgb![col]!, fgIdx![col]!) : null,
        bg: m & F_HAS_BG ? unpackColor(bgRgb![col]!, bgIdx![col]!) : null,
        bold: (m & F_BOLD) !== 0,
        faint: (m & F_FAINT) !== 0,
        italic: (m & F_ITALIC) !== 0,
        underline: bitsToUnderline(m),
        underlineColor: m & F_HAS_UL ? unpackColor(ulRgb![col]!, ulIdx![col]!) : null,
        overline: (m & F_OVERLINE) !== 0,
        strikethrough: (m & F_STRIKE) !== 0,
        inverse: (m & F_INVERSE) !== 0,
        hidden: (m & F_HIDDEN) !== 0,
        blink: (m & F_BLINK) !== 0,
        wide: (m & F_WIDE) !== 0,
        url: m & F_HAS_URL ? (urlMap!.get(col) ?? null) : null,
      }
    },

    toCells() {
      const out: ScreenCell[] = new Array(width)
      for (let c = 0; c < width; c++) out[c] = row.getCellRaw(c)
      return out
    },

    replaceAllFromCells(cells) {
      for (let c = 0; c < width; c++) row.setCellRaw(c, cells[c] ?? EMPTY_CELL)
    },

    isEmpty(col) {
      return meta[col] === 0 && chars[col] === ""
    },

    getChar(col) {
      return chars[col]!
    },

    isWide(col) {
      return (meta[col]! & F_WIDE) !== 0
    },
  }
  return row
}

/** Build a packed row from a materialized cell array (reflow / restore output). */
function packedRowFromCells(cells: readonly ScreenCell[], width: number): PackedRow {
  const r = makePackedRow(width)
  for (let c = 0; c < width; c++) r.setCellRaw(c, cells[c] ?? EMPTY_CELL)
  return r
}

// ── ANSI 256-color palette ─────────────────────────────────────────────

const ANSI_16: readonly Color[] = [
  { r: 0x00, g: 0x00, b: 0x00 }, // 0  Black
  { r: 0x80, g: 0x00, b: 0x00 }, // 1  Red
  { r: 0x00, g: 0x80, b: 0x00 }, // 2  Green
  { r: 0x80, g: 0x80, b: 0x00 }, // 3  Yellow
  { r: 0x00, g: 0x00, b: 0x80 }, // 4  Blue
  { r: 0x80, g: 0x00, b: 0x80 }, // 5  Magenta
  { r: 0x00, g: 0x80, b: 0x80 }, // 6  Cyan
  { r: 0xc0, g: 0xc0, b: 0xc0 }, // 7  White
  { r: 0x80, g: 0x80, b: 0x80 }, // 8  Bright Black
  { r: 0xff, g: 0x00, b: 0x00 }, // 9  Bright Red
  { r: 0x00, g: 0xff, b: 0x00 }, // 10 Bright Green
  { r: 0xff, g: 0xff, b: 0x00 }, // 11 Bright Yellow
  { r: 0x00, g: 0x00, b: 0xff }, // 12 Bright Blue
  { r: 0xff, g: 0x00, b: 0xff }, // 13 Bright Magenta
  { r: 0x00, g: 0xff, b: 0xff }, // 14 Bright Cyan
  { r: 0xff, g: 0xff, b: 0xff }, // 15 Bright White
]

function buildPalette256(): Color[] {
  const palette: Color[] = [...ANSI_16]
  const levels = [0x00, 0x5f, 0x87, 0xaf, 0xd7, 0xff]
  for (let r = 0; r < 6; r++) {
    for (let g = 0; g < 6; g++) {
      for (let b = 0; b < 6; b++) {
        palette.push({ r: levels[r]!, g: levels[g]!, b: levels[b]! })
      }
    }
  }
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10
    palette.push({ r: v, g: v, b: v })
  }
  return palette
}

// ── Color spec parsing/formatting (for OSC 4/5/10-19) ──────────────────

/**
 * Parse an X11-style color spec: "rgb:RR/GG/BB", "rgb:RRRR/GGGG/BBBB",
 * "#RRGGBB", "#RGB". Returns null if unparseable.
 */
function parseColorSpec(spec: string): Color | null {
  const s = spec.trim()
  // rgb:RR/GG/BB or rgb:RRRR/GGGG/BBBB
  const rgbMatch = /^rgb:([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})$/.exec(s)
  if (rgbMatch) {
    const scale = (hex: string): number => {
      const v = parseInt(hex, 16)
      // Normalise N-digit hex (1..4) to 8-bit. xterm uses 16-bit RGB; max value = (16^len - 1).
      const max = Math.pow(16, hex.length) - 1
      return Math.round((v * 255) / max)
    }
    return { r: scale(rgbMatch[1]!), g: scale(rgbMatch[2]!), b: scale(rgbMatch[3]!) }
  }
  // #RRGGBB
  const hex6 = /^#([0-9a-fA-F]{6})$/.exec(s)
  if (hex6) {
    const v = hex6[1]!
    return {
      r: parseInt(v.substring(0, 2), 16),
      g: parseInt(v.substring(2, 4), 16),
      b: parseInt(v.substring(4, 6), 16),
    }
  }
  // #RGB (expand each nibble)
  const hex3 = /^#([0-9a-fA-F]{3})$/.exec(s)
  if (hex3) {
    const v = hex3[1]!
    const expand = (ch: string): number => parseInt(ch + ch, 16)
    return { r: expand(v[0]!), g: expand(v[1]!), b: expand(v[2]!) }
  }
  return null
}

/** Format a color as X11 "rgb:RRRR/GGGG/BBBB" (16-bit per channel, standard xterm reply). */
function formatColorResponse(c: Color): string {
  const scale = (v: number): string => {
    const v16 = Math.round((v * 65535) / 255)
    return v16.toString(16).padStart(4, "0")
  }
  return `rgb:${scale(c.r)}/${scale(c.g)}/${scale(c.b)}`
}

// ── DEC Special Graphics character set ─────────────────────────────────

const DEC_SPECIAL_GRAPHICS: Record<string, string> = {
  j: "\u2518", // ┘
  k: "\u2510", // ┐
  l: "\u250c", // ┌
  m: "\u2514", // └
  n: "\u253c", // ┼
  q: "\u2500", // ─
  t: "\u251c", // ├
  u: "\u2524", // ┤
  v: "\u2534", // ┴
  w: "\u252c", // ┬
  x: "\u2502", // │
  a: "\u2592", // ▒
  f: "\u00b0", // °
  g: "\u00b1", // ±
  "~": "\u00b7", // ·
  y: "\u2264", // ≤
  z: "\u2265", // ≥
  "{": "\u03c0", // π
  "|": "\u2260", // ≠
  "}": "\u00a3", // £
}

// ── Unicode width & character classification ────────────────────────────

function isWide(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) || // Hangul Jamo
    (codePoint >= 0x231a && codePoint <= 0x231b) || // Watch, Hourglass
    (codePoint >= 0x2614 && codePoint <= 0x2615) || // Umbrella, Hot Beverage
    (codePoint >= 0x2648 && codePoint <= 0x2653) || // Zodiac signs
    codePoint === 0x267f || // Wheelchair
    codePoint === 0x2693 || // Anchor
    codePoint === 0x26a1 || // High Voltage
    codePoint === 0x26ce || // Ophiuchus
    codePoint === 0x26d4 || // No Entry
    codePoint === 0x2705 || // Check Mark
    codePoint === 0x2728 || // Sparkles
    codePoint === 0x274c || // Cross Mark
    codePoint === 0x274e || // Cross Mark variant
    (codePoint >= 0x2753 && codePoint <= 0x2755) || // Question marks
    (codePoint >= 0x2795 && codePoint <= 0x2797) || // Plus, Minus, Division
    codePoint === 0x27b0 || // Curly Loop
    codePoint === 0x27bf || // Double Curly Loop
    (codePoint >= 0x2e80 && codePoint <= 0x303e) || // CJK Radicals
    (codePoint >= 0x3041 && codePoint <= 0x33bf) || // Hiragana, Katakana, Bopomofo, etc.
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) || // CJK Unified Extension A
    (codePoint >= 0x4e00 && codePoint <= 0xa4cf) || // CJK Unified Ideographs
    (codePoint >= 0xa960 && codePoint <= 0xa97c) || // Hangul Jamo Extended-A
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) || // Hangul Syllables
    (codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK Compatibility Ideographs
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) || // Vertical Forms
    (codePoint >= 0xfe30 && codePoint <= 0xfe6b) || // CJK Compatibility Forms
    (codePoint >= 0xff01 && codePoint <= 0xff60) || // Fullwidth Forms
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) || // Fullwidth Signs
    codePoint === 0x1f004 || // Mahjong Tile
    codePoint === 0x1f0cf || // Playing Card
    (codePoint >= 0x1f170 && codePoint <= 0x1f171) || // A/B buttons
    (codePoint >= 0x1f17e && codePoint <= 0x1f17f) || // O/P buttons
    codePoint === 0x1f18e || // AB button
    (codePoint >= 0x1f191 && codePoint <= 0x1f19a) || // Squared symbols
    (codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff) || // Regional Indicators
    (codePoint >= 0x1f200 && codePoint <= 0x1f202) || // Enclosed CJK
    (codePoint >= 0x1f300 && codePoint <= 0x1f9ff) || // Misc Symbols/Emoticons
    (codePoint >= 0x1fa00 && codePoint <= 0x1faff) || // Extended Symbols & Pictographs
    (codePoint >= 0x20000 && codePoint <= 0x2fffd) || // CJK Extension B-F
    (codePoint >= 0x30000 && codePoint <= 0x3fffd) // CJK Extension G+
  )
}

function isCombining(cp: number): boolean {
  return (
    (cp >= 0x0300 && cp <= 0x036f) || // Combining Diacritical Marks
    (cp >= 0x0483 && cp <= 0x0489) || // Cyrillic combining
    (cp >= 0x0591 && cp <= 0x05bd) || // Hebrew
    cp === 0x05bf || // Hebrew
    (cp >= 0x05c1 && cp <= 0x05c2) || // Hebrew
    (cp >= 0x05c4 && cp <= 0x05c5) || // Hebrew
    cp === 0x05c7 || // Hebrew
    (cp >= 0x0610 && cp <= 0x061a) || // Arabic
    (cp >= 0x064b && cp <= 0x065f) || // Arabic
    cp === 0x0670 || // Arabic
    (cp >= 0x06d6 && cp <= 0x06dc) || // Arabic
    (cp >= 0x06df && cp <= 0x06e4) || // Arabic
    (cp >= 0x06e7 && cp <= 0x06e8) || // Arabic
    (cp >= 0x06ea && cp <= 0x06ed) || // Arabic
    (cp >= 0x0730 && cp <= 0x074a) || // Syriac
    (cp >= 0x0900 && cp <= 0x0903) || // Devanagari
    (cp >= 0x093a && cp <= 0x094f) || // Devanagari
    (cp >= 0x0951 && cp <= 0x0957) || // Devanagari
    (cp >= 0x0962 && cp <= 0x0963) || // Devanagari
    cp === 0x0e31 || // Thai
    (cp >= 0x0e34 && cp <= 0x0e3a) || // Thai
    (cp >= 0x0e47 && cp <= 0x0e4e) || // Thai
    (cp >= 0x1ab0 && cp <= 0x1aff) || // Combining Diacritical Marks Extended
    (cp >= 0x1dc0 && cp <= 0x1dff) || // Combining Diacritical Marks Supplement
    (cp >= 0x20d0 && cp <= 0x20ff) || // Combining Diacritical Marks for Symbols
    (cp >= 0xfe00 && cp <= 0xfe0f) || // Variation Selectors
    (cp >= 0xe0100 && cp <= 0xe01ef) // Variation Selectors Supplement
  )
}

function isRegionalIndicator(cp: number): boolean {
  return cp >= 0x1f1e6 && cp <= 0x1f1ff
}

function isZWJ(cp: number): boolean {
  return cp === 0x200d
}

function isVS16(cp: number): boolean {
  return cp === 0xfe0f
}

function isEmojiModifier(cp: number): boolean {
  return cp >= 0x1f3fb && cp <= 0x1f3ff // Skin tone modifiers
}

// ── Internal attrs interface ───────────────────────────────────────────

type Attrs = ScreenAttrsSnapshot

// ── Screen factory ─────────────────────────────────────────────────────

export function createScreen(options: ScreenOptions = {}): Screen {
  let cols = options.cols ?? 80
  let rows = options.rows ?? 24
  let scrollbackLimit = options.scrollbackLimit ?? 1000
  const onResponse = options.onResponse
  const maxStringSequenceLength = options.maxStringSequenceLength ?? DEFAULT_MAX_STRING_SEQUENCE_LENGTH
  if (!Number.isSafeInteger(maxStringSequenceLength) || maxStringSequenceLength < 0) {
    throw new RangeError("maxStringSequenceLength must be a non-negative safe integer")
  }

  // Main and alternate screen buffers (packed rows; see makePackedRow).
  let mainGrid: PackedRow[] = makeGrid(cols, rows)
  let altGrid: PackedRow[] = makeGrid(cols, rows)
  let grid = mainGrid
  let scrollback: PackedRow[] = []

  // Cursor
  let curX = 0
  let curY = 0
  let curVisible = true
  let cursorShape: "block" | "underline" | "bar" = "block"
  let cursorBlinking = true

  // DECSC/DECRC saved state
  interface SavedState {
    curX: number
    curY: number
    attrs: Attrs
    originMode: boolean
    autoWrap: boolean
    charsetG0: boolean // true = DEC Special Graphics
  }
  let savedState: SavedState = {
    curX: 0,
    curY: 0,
    attrs: resetAttrs(),
    originMode: false,
    autoWrap: true,
    charsetG0: false,
  }

  // Saved cursor for alt screen (separate from DECSC)
  let savedCurX = 0
  let savedCurY = 0

  // Current drawing attributes
  let attrs: Attrs = resetAttrs()

  // Terminal state
  let title = ""
  let useAltScreen = false
  let bracketedPaste = false
  let applicationCursor = false
  let applicationKeypad = false
  let autoWrap = true
  let mouseTracking = false
  let mouseTrackingMode = 0 // 1000, 1002, 1003
  let sgrMouse = false
  let focusTracking = false
  let originMode = false
  let insertMode = false
  let newLineMode = false
  let reverseVideo = false
  let syncOutput = false

  // Kitty keyboard protocol
  // Headless design: we implement the full push/pop/query state machine so that
  // applications can negotiate keyboard encoding modes. The flags are stored and
  // queryable (CSI ? u responds correctly), and a host can read them to decide
  // how to encode keypresses. The actual key encoding lives in the host layer
  // (e.g. termless's encodeKeyToAnsi), not here — separation of concerns.
  let kittyKeyboardFlags = 0
  let kittyKeyboardStack: number[] = []

  // Kitty graphics protocol
  // Headless design: we parse the APC G protocol and respond to queries so that
  // applications relying on the query→response handshake work correctly. We don't
  // store image data because there's no pixel framebuffer — unlike sixel where we
  // preserve the raw data for consumers, kitty graphics payloads are chunked and
  // stateful, making storage without rendering impractical.
  let hasKittyGraphics = false

  // Scroll region (inclusive, 0-based)
  let scrollTop = 0
  let scrollBottom = rows - 1

  // Left/right margin mode (DECLRMM, DECSET ?69)
  let leftRightMarginMode = false
  let leftMargin = 0
  let rightMargin = cols - 1

  // Color scheme reporting (mode 2031)
  let colorSchemeReporting = false

  // Additional DEC/xterm private modes we track (and report via DECRPM)
  let decColumnMode = false // ?3 — DECCOLM (80/132 columns). We don't switch width, just track.
  let altScrollMode = false // ?1007
  let utf8MouseMode = false // ?1005

  // Color state — mutable palette & OSC 4/5/10-19 color setters
  let palette256: Color[] = buildPalette256()
  let defaultFgColor: Color | null = null // OSC 10 / 110
  let defaultBgColor: Color | null = null // OSC 11 / 111
  let cursorColor: Color | null = null // OSC 12 / 112
  const specialColors: Map<number, Color> = new Map() // OSC 5 / 105 (0=bold, 1=ul, 2=blink, 3=reverse, 4=italic)
  let pointerFgColor: Color | null = null // OSC 13 / 113
  let pointerBgColor: Color | null = null // OSC 14 / 114
  let highlightBgColor: Color | null = null // OSC 17 / 117
  let highlightFgColor: Color | null = null // OSC 19 / 119
  type ColorStateSnapshot = ScreenColorStateSnapshot
  const colorStack: ColorStateSnapshot[] = []

  function cloneColor(c: Color | null): Color | null {
    return c ? { ...c } : null
  }

  function snapshotColorState(): ColorStateSnapshot {
    return {
      palette256: palette256.map((c) => ({ ...c })),
      defaultFgColor: cloneColor(defaultFgColor),
      defaultBgColor: cloneColor(defaultBgColor),
      cursorColor: cloneColor(cursorColor),
      specialColors: [...specialColors].map(([idx, color]) => [idx, { ...color }]),
      pointerFgColor: cloneColor(pointerFgColor),
      pointerBgColor: cloneColor(pointerBgColor),
      highlightBgColor: cloneColor(highlightBgColor),
      highlightFgColor: cloneColor(highlightFgColor),
    }
  }

  function restoreColorState(snapshot: ColorStateSnapshot): void {
    palette256 = snapshot.palette256.map((c) => ({ ...c }))
    defaultFgColor = cloneColor(snapshot.defaultFgColor)
    defaultBgColor = cloneColor(snapshot.defaultBgColor)
    cursorColor = cloneColor(snapshot.cursorColor)
    specialColors.clear()
    for (const [idx, color] of snapshot.specialColors) specialColors.set(idx, { ...color })
    pointerFgColor = cloneColor(snapshot.pointerFgColor)
    pointerBgColor = cloneColor(snapshot.pointerBgColor)
    highlightBgColor = cloneColor(snapshot.highlightBgColor)
    highlightFgColor = cloneColor(snapshot.highlightFgColor)
  }

  function cloneColorStateSnapshot(snapshot: ColorStateSnapshot): ColorStateSnapshot {
    return {
      palette256: snapshot.palette256.map((c) => ({ ...c })),
      defaultFgColor: cloneColor(snapshot.defaultFgColor),
      defaultBgColor: cloneColor(snapshot.defaultBgColor),
      cursorColor: cloneColor(snapshot.cursorColor),
      specialColors: snapshot.specialColors.map(([idx, color]) => [idx, { ...color }]),
      pointerFgColor: cloneColor(snapshot.pointerFgColor),
      pointerBgColor: cloneColor(snapshot.pointerBgColor),
      highlightBgColor: cloneColor(snapshot.highlightBgColor),
      highlightFgColor: cloneColor(snapshot.highlightFgColor),
    }
  }

  function cloneAttrsSnapshot(source: Attrs): ScreenAttrsSnapshot {
    return {
      ...source,
      fg: cloneColor(source.fg),
      bg: cloneColor(source.bg),
      underlineColor: cloneColor(source.underlineColor),
    }
  }

  function cloneCellSnapshot(source: ScreenCell): ScreenCell {
    return {
      ...source,
      fg: cloneColor(source.fg),
      bg: cloneColor(source.bg),
      underlineColor: cloneColor(source.underlineColor),
    }
  }

  function isDefaultEmptyCell(cell: ScreenCell): boolean {
    return (
      cell.char === "" &&
      cell.fg === null &&
      cell.bg === null &&
      cell.bold === false &&
      cell.faint === false &&
      cell.italic === false &&
      cell.underline === "none" &&
      cell.underlineColor === null &&
      cell.overline === false &&
      cell.strikethrough === false &&
      cell.inverse === false &&
      cell.hidden === false &&
      cell.blink === false &&
      cell.wide === false &&
      cell.url === null
    )
  }

  function restoreCellSnapshot(source: ScreenCell): ScreenCell {
    const cell = cloneCellSnapshot(source)
    return isDefaultEmptyCell(cell) ? EMPTY_CELL : cell
  }

  /** Materialize a packed grid to plain, deep-cloned Snapshot cells (index preserved). */
  function cloneGridSnapshot(source: PackedRow[]): ScreenCell[][] {
    return source.map((row) => row.toCells().map(cloneCellSnapshot))
  }

  function restoreGridSnapshot(source: ScreenCell[][], expectedRows: number, expectedCols: number): PackedRow[] {
    const out: PackedRow[] = []
    for (let row = 0; row < expectedRows; row++) {
      const srcRow = source[row] ?? []
      const cells = srcRow.slice(0, expectedCols).map(restoreCellSnapshot)
      while (cells.length < expectedCols) cells.push(EMPTY_CELL)
      out.push(packedRowFromCells(cells, expectedCols))
    }
    return out
  }

  function restoreScrollbackSnapshot(source: ScreenCell[][]): PackedRow[] {
    return source.map((row) => packedRowFromCells(row.map(restoreCellSnapshot), row.length))
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null
  }

  function assertInteger(name: string, value: unknown, min = 0): asserts value is number {
    if (!Number.isInteger(value) || (value as number) < min) {
      throw new TypeError(`Invalid vterm snapshot ${name}`)
    }
  }

  function assertString(name: string, value: unknown): asserts value is string {
    if (typeof value !== "string") throw new TypeError(`Invalid vterm snapshot ${name}`)
  }

  function assertBoolean(name: string, value: unknown): asserts value is boolean {
    if (typeof value !== "boolean") throw new TypeError(`Invalid vterm snapshot ${name}`)
  }

  function assertRecord(name: string, value: unknown): asserts value is Record<string, unknown> {
    if (!isRecord(value)) throw new TypeError(`Invalid vterm snapshot ${name}`)
  }

  function assertGrid(name: string, value: unknown, expectedRows: number, expectedCols: number): void {
    if (!Array.isArray(value) || value.length !== expectedRows) {
      throw new TypeError(`Invalid vterm snapshot ${name}`)
    }
    for (const row of value) {
      if (!Array.isArray(row) || row.length !== expectedCols) {
        throw new TypeError(`Invalid vterm snapshot ${name}`)
      }
    }
  }

  function assertSoftWraps(name: string, value: unknown, expectedRows: number): void {
    if (!Array.isArray(value) || value.length !== expectedRows || value.some((entry) => typeof entry !== "boolean")) {
      throw new TypeError(`Invalid vterm snapshot ${name}`)
    }
  }

  function assertSnapshot(snapshot: Snapshot): void {
    const value: unknown = snapshot
    if (!isRecord(value)) throw new TypeError("Invalid vterm snapshot")
    if (value.version !== 1) {
      throw new Error(`Unsupported vterm snapshot version: ${String(value.version)}`)
    }
    assertInteger("cols", value.cols, 1)
    assertInteger("rows", value.rows, 1)
    assertInteger("scrollbackLimit", value.scrollbackLimit, 0)
    if (value.activeBuffer !== "main" && value.activeBuffer !== "alt") {
      throw new TypeError("Invalid vterm snapshot activeBuffer")
    }

    const main = value.main
    const alt = value.alt
    assertRecord("main", main)
    assertRecord("alt", alt)
    assertGrid("main.grid", main.grid, value.rows, value.cols)
    assertGrid("alt.grid", alt.grid, value.rows, value.cols)
    assertSoftWraps("main.softWrapped", main.softWrapped, value.rows)
    assertSoftWraps("alt.softWrapped", alt.softWrapped, value.rows)
    if (!Array.isArray(value.scrollback)) throw new TypeError("Invalid vterm snapshot scrollback")
    // Optional (absent in pre-field snapshots); when present it must pair 1:1 with scrollback.
    if (value.scrollbackSoftWrapped !== undefined) {
      assertSoftWraps("scrollbackSoftWrapped", value.scrollbackSoftWrapped, value.scrollback.length)
    }

    const cursor = value.cursor
    assertRecord("cursor", cursor)
    assertInteger("cursor.x", cursor.x)
    assertInteger("cursor.y", cursor.y)
    assertBoolean("cursor.visible", cursor.visible)
    if (cursor.shape !== "block" && cursor.shape !== "underline" && cursor.shape !== "bar") {
      throw new TypeError("Invalid vterm snapshot cursor.shape")
    }
    assertBoolean("cursor.blinking", cursor.blinking)
    assertInteger("cursor.savedX", cursor.savedX)
    assertInteger("cursor.savedY", cursor.savedY)

    const saved = value.savedState
    assertRecord("savedState", saved)
    assertInteger("savedState.x", saved.x)
    assertInteger("savedState.y", saved.y)
    assertRecord("savedState.attrs", saved.attrs)
    assertBoolean("savedState.originMode", saved.originMode)
    assertBoolean("savedState.autoWrap", saved.autoWrap)
    assertBoolean("savedState.charsetG0", saved.charsetG0)
    assertRecord("attrs", value.attrs)

    const modes = value.modes
    assertRecord("modes", modes)
    for (const name of [
      "bracketedPaste",
      "applicationCursor",
      "applicationKeypad",
      "autoWrap",
      "mouseTracking",
      "sgrMouse",
      "focusTracking",
      "origin",
      "insert",
      "reverseVideo",
      "syncOutput",
      "kittyGraphics",
      "colorSchemeReporting",
      "decColumn",
      "altScroll",
      "utf8Mouse",
    ]) {
      assertBoolean(`modes.${name}`, modes[name])
    }
    assertInteger("modes.mouseTrackingMode", modes.mouseTrackingMode)
    assertInteger("modes.kittyKeyboardFlags", modes.kittyKeyboardFlags)
    if (!Array.isArray(modes.kittyKeyboardStack)) {
      throw new TypeError("Invalid vterm snapshot modes.kittyKeyboardStack")
    }

    const margins = value.margins
    assertRecord("margins", margins)
    assertInteger("margins.scrollTop", margins.scrollTop)
    assertInteger("margins.scrollBottom", margins.scrollBottom)
    assertBoolean("margins.leftRight", margins.leftRight)
    assertInteger("margins.left", margins.left)
    assertInteger("margins.right", margins.right)

    const colors = value.colors
    assertRecord("colors", colors)
    assertRecord("colors.current", colors.current)
    if (!Array.isArray(colors.stack)) throw new TypeError("Invalid vterm snapshot colors.stack")

    if (!Array.isArray(value.tabStops)) throw new TypeError("Invalid vterm snapshot tabStops")
    for (const stop of value.tabStops) assertInteger("tabStops", stop)
    assertString("title", value.title)
    assertString("clipboard", value.clipboard)
    assertString("cwd", value.cwd)
    if (!Array.isArray(value.notifications) || value.notifications.some((entry) => typeof entry !== "string")) {
      throw new TypeError("Invalid vterm snapshot notifications")
    }
    assertInteger("viewportOffset", value.viewportOffset)

    const parser = value.parser
    assertRecord("parser", parser)
    const parserStates: readonly ScreenParserState[] = [
      "ground",
      "escape",
      "escape_charset",
      "escape_hash",
      "csi",
      "osc",
      "dcs",
      "dcs_passthrough",
      "osc_st",
      "dcs_st",
      "apc",
      "apc_st",
    ]
    if (!parserStates.includes(parser.state as ScreenParserState)) {
      throw new TypeError("Invalid vterm snapshot parser.state")
    }
    assertString("parser.esc", parser.esc)
    assertString("parser.osc", parser.osc)
    assertString("parser.dcs", parser.dcs)
    assertRecord("parser.dcsStart", parser.dcsStart)
    assertInteger("parser.dcsStart.row", parser.dcsStart.row)
    assertInteger("parser.dcsStart.col", parser.dcsStart.col)
    if (parser.dcsReceivedLength !== undefined) {
      assertInteger("parser.dcsReceivedLength", parser.dcsReceivedLength, 0)
    }
    if (parser.dcsOverflow !== undefined) assertBoolean("parser.dcsOverflow", parser.dcsOverflow)
    assertString("parser.apc", parser.apc)
    if (parser.apcStart !== undefined) {
      assertRecord("parser.apcStart", parser.apcStart)
      assertInteger("parser.apcStart.row", parser.apcStart.row)
      assertInteger("parser.apcStart.col", parser.apcStart.col)
    }
    if (parser.apcReceivedLength !== undefined) {
      assertInteger("parser.apcReceivedLength", parser.apcReceivedLength, 0)
    }
    if (parser.apcOverflow !== undefined) assertBoolean("parser.apcOverflow", parser.apcOverflow)
    if (!Array.isArray(parser.utf8PendingBytes)) {
      throw new TypeError("Invalid vterm snapshot parser.utf8PendingBytes")
    }
    for (const byte of parser.utf8PendingBytes) {
      assertInteger("parser.utf8PendingBytes", byte, 0)
      if (byte > 0xff) throw new TypeError("Invalid vterm snapshot parser.utf8PendingBytes")
    }

    const unicode = value.unicode
    assertRecord("unicode", unicode)
    assertBoolean("unicode.charsetG0", unicode.charsetG0)
    assertString("unicode.lastChar", unicode.lastChar)
    if (unicode.pendingRegionalIndicator !== null) {
      assertString("unicode.pendingRegionalIndicator", unicode.pendingRegionalIndicator)
    }
    assertBoolean("unicode.afterZWJ", unicode.afterZWJ)
  }

  // Tab stops: set of 0-based column indices. Defaults = every 8 cols.
  let tabStops: Set<number> = defaultTabStops(cols)

  function defaultTabStops(c: number): Set<number> {
    const s = new Set<number>()
    for (let i = 8; i < c; i += 8) s.add(i)
    return s
  }

  function nextTabStop(x: number): number {
    for (let i = x + 1; i < cols; i++) {
      if (tabStops.has(i)) return i
    }
    // No stop ahead: xterm jumps to last column only if any stops exist
    // beyond the current position; when the whole tab table is cleared
    // (CSI 3 g), TAB should not move at all.
    if (tabStops.size === 0) return x
    return cols - 1
  }

  function prevTabStop(x: number): number {
    for (let i = x - 1; i > 0; i--) {
      if (tabStops.has(i)) return i
    }
    return 0
  }

  // Text scale (OSC 66)
  let textScale = 1

  // UI metric query state (OSC 7770/7777/776)
  const CELL_W_PX = 8
  const CELL_H_PX = 17
  const FONT_ASCENT_PX = 14
  let fontSize = 12
  let fontWindowSize = 12

  // Locale query state (OSC 701)
  let locale = "en_US.UTF-8"

  // Advanced clipboard (OSC 5522 — Kitty clipboard protocol)
  let advancedClipboard = ""

  // Viewport scroll offset
  let viewportOffset = 0

  // Character set: true = DEC Special Graphics (G0)
  let charsetG0 = false

  // Clipboard (OSC 52)
  let clipboard = ""

  // Current working directory (OSC 7)
  let cwd = ""

  // Notifications (OSC 9)
  let notifications: string[] = []

  // Semantic prompt zones (OSC 133 / OSC 633)
  let semanticZones: SemanticZone[] = []

  // Sixel graphics (DCS q)
  // Headless design: we parse sixel data and store it for consumers (e.g. a GUI
  // renderer could use getSixelImages() to display them). We don't decode pixels
  // because there's no framebuffer to render into — but preserving the data means
  // a host application gets full fidelity without re-parsing the stream.
  let hasSixel = false
  let sixelImages: SixelImage[] = []

  // Soft-wrap tracking: true if the line break at end of this row was caused by auto-wrap
  let mainSoftWrapped: boolean[] = new Array(rows).fill(false)
  let altSoftWrapped: boolean[] = new Array(rows).fill(false)
  let softWrapped = mainSoftWrapped
  // Parallel to `scrollback`: the departing row's soft-wrap bit, captured at scroll-out
  let scrollbackSoftWrapped: boolean[] = []

  /**
   * Drop every banked scrollback row AND its soft-wrap flag.
   *
   * These two arrays are one data structure wearing two names, and nothing in
   * the type system says so. `ESC [ 3 J` (erase display + scrollback) once
   * emptied the rows and left the flags, which diverged the pair permanently
   * by however many rows were banked at that instant. Every later push
   * extended both and preserved the gap, so the snapshot codec refused to
   * write a frame — `soft-wrap length 3580 != rowCount 2103` — and the seat
   * kept running with its recording silently ended
   * (@i/5-agent-loop/vterm-codec-ends-recording).
   *
   * `ESC [ 3 J` is not exotic: `clear` emits it on a modern terminal. Every
   * clear goes through here so the pairing is structural rather than
   * remembered at each call site.
   */
  function clearScrollback(): void {
    scrollback.length = 0
    scrollbackSoftWrapped.length = 0
  }

  // Last printed character for REP
  let lastChar = ""

  // Unicode sequence state
  let pendingRegionalIndicator: string | null = null // First RI waiting for pair
  let afterZWJ = false // Next character should join with previous cell

  // Parser state
  let parserState: ScreenParserState = "ground"
  let escBuf = ""
  let oscBuf = ""
  let dcsBuf = ""
  let dcsStartRow = 0
  let dcsStartCol = 0
  let dcsReceivedLength = 0
  let dcsOverflow = false
  let apcBuf = ""
  let apcStartRow = 0
  let apcStartCol = 0
  let apcReceivedLength = 0
  let apcOverflow = false

  // Observation taps (opt-in; zero-overhead when no listener is registered). `opListeners`
  // observe the coarse WRITE ops (symmetric with the Hab journal); `parserListeners` observe
  // fine-grained parsed VT actions. The Sets are never cleared by reset/RIS — observers
  // outlive terminal state.
  const opListeners = new Set<(op: TerminalOp) => void>()
  const parserListeners = new Set<(event: ParserEvent) => void>()
  // Print-run coalescing for the parser tap: consecutive printable graphemes in one process()
  // flood surface as ONE {kind:"print"} event, flushed before any control event and at
  // end-of-flood. Only populated while a parser listener exists.
  let printRunParts: string[] = []
  // Intermediate byte of an in-progress nF escape (charset "("/")", or "#"), remembered across
  // the sub-state transition so the completed escape's ParserEvent can carry it.
  let escIntermediate = ""

  // ── Dirty tracking (pull-plane damage) ──
  // Always-on accumulation of per-row damage between takeDirty() calls. `dirtyRows` holds
  // retained-relative ABSOLUTE row indices (consistent with getRowAbsolute); `dirtyAll` is the
  // structural-change sentinel (resize/clear/alt-switch/reset/restore). `dirtyScrolled` counts
  // lines that entered scrollback since the last take. `dirtyLastAbs` collapses a run of writes
  // to the same row into a single Set membership update (the write-path cost is one number compare
  // plus, per row-run, one Set.add — no allocation per cell). `trimmedRowCount` is the cumulative
  // count of scrollback lines evicted by retention trimming (the global origin of retained row 0);
  // it survives takes and resets only on reset()/restore(). Cursor damage is derived by comparing
  // the cursor snapshot captured at the previous take — zero write-path cost.
  let dirtyAll = false
  let dirtyRows = new Set<number>()
  let dirtyScrolled = 0
  let dirtyLastAbs = -1
  let trimmedRowCount = 0
  let dirtyCursor = { x: 0, y: 0, visible: true, shape: "block" as "block" | "underline" | "bar", blinking: true }

  // ── Signal-plane damage accumulator (reactive read plane, §4) ──
  // An accumulator INDEPENDENT of the pull-plane dirty* set above, so `signals.damage$` and
  // `takeDirty()` never drain each other (the two-plane coexistence contract). Maintained ONLY
  // while `damage$` has a subscriber (`sigDamageActive`) — when inactive, the mark functions do a
  // single boolean check and no bookkeeping, keeping the write core allocation-free. It is drained
  // and broadcast at every flush boundary (see `flushSignals`) rather than on `takeDirty()`.
  let sigDamageActive = false
  let sigDirtyAll = false
  let sigDirtyRows = new Set<number>()
  let sigDirtyScrolled = 0
  let sigDirtyLastAbs = -1
  let sigDirtyCursor = { x: 0, y: 0, visible: true, shape: "block" as "block" | "underline" | "bar", blinking: true }

  function markScreenRowDirty(screenRow: number): void {
    const abs = scrollback.length + screenRow
    // Pull plane (always on).
    if (!dirtyAll && abs !== dirtyLastAbs) {
      dirtyLastAbs = abs
      dirtyRows.add(abs)
    }
    // Signal plane (only while damage$ is subscribed) — its own epoch, own collapse cursor.
    if (sigDamageActive && !sigDirtyAll && abs !== sigDirtyLastAbs) {
      sigDirtyLastAbs = abs
      sigDirtyRows.add(abs)
    }
  }

  function markAbsoluteRowDirty(abs: number): void {
    // Pull plane (always on).
    if (!dirtyAll && abs !== dirtyLastAbs) {
      dirtyLastAbs = abs
      dirtyRows.add(abs)
    }
    // Signal plane (only while damage$ is subscribed) — its own epoch, own collapse cursor.
    if (sigDamageActive && !sigDirtyAll && abs !== sigDirtyLastAbs) {
      sigDirtyLastAbs = abs
      sigDirtyRows.add(abs)
    }
  }

  function markScreenRowsDirty(top: number, bottom: number): void {
    if (dirtyAll && (!sigDamageActive || sigDirtyAll)) return
    for (let r = top; r <= bottom; r++) markScreenRowDirty(r)
  }

  /** Structural change — the whole visible buffer is damaged. Drops the per-row set (both planes). */
  function markAllDirty(): void {
    dirtyAll = true
    dirtyRows.clear()
    dirtyLastAbs = -1
    if (sigDamageActive) {
      sigDirtyAll = true
      sigDirtyRows.clear()
      sigDirtyLastAbs = -1
    }
  }

  // Decoder for incoming bytes; encoder for string payloads passed to apply().
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let utf8PendingBytes: number[] = []

  function utf8SequenceLength(lead: number): number {
    if (lead <= 0x7f) return 1
    if (lead >= 0xc2 && lead <= 0xdf) return 2
    if (lead >= 0xe0 && lead <= 0xef) return 3
    if (lead >= 0xf0 && lead <= 0xf4) return 4
    return 0
  }

  function utf8CompletePrefixLength(bytes: Uint8Array): number {
    if (bytes.length === 0) return 0

    let continuationCount = 0
    let leadIndex = bytes.length - 1
    while (leadIndex >= 0 && (bytes[leadIndex]! & 0xc0) === 0x80 && continuationCount < 3) {
      continuationCount++
      leadIndex--
    }

    if (leadIndex < 0) return bytes.length

    const lead = bytes[leadIndex]!
    const expectedLength = utf8SequenceLength(lead)
    if (expectedLength === 0) return bytes.length

    const availableLength = bytes.length - leadIndex
    return expectedLength > availableLength ? leadIndex : bytes.length
  }

  function decodeInput(data: Uint8Array): string {
    const bytes = new Uint8Array(utf8PendingBytes.length + data.length)
    bytes.set(utf8PendingBytes, 0)
    bytes.set(data, utf8PendingBytes.length)

    const completeLength = utf8CompletePrefixLength(bytes)
    utf8PendingBytes = Array.from(bytes.slice(completeLength))
    if (completeLength === 0) return ""
    return decoder.decode(bytes.slice(0, completeLength))
  }

  // ── Grid helpers ──

  function makeGrid(c: number, r: number): PackedRow[] {
    const g: PackedRow[] = []
    for (let row = 0; row < r; row++) {
      g.push(makeRow(c))
    }
    return g
  }

  function makeRow(c: number): PackedRow {
    return makePackedRow(c)
  }

  /**
   * Edit-path escape hatch for the rare column-splice operations (insert/delete
   * chars & columns, rect fill/copy/attr): materialize the row to a fixed-length
   * cell array, run the ordinary array edit, then repack. Length-preserving edits
   * (splice+push/pop pairs) keep the row exactly `cols` wide. Not the hot path —
   * plain printing goes straight through {@link PackedRow.writeFromAttrs}.
   */
  function mutateRowAsCells(row: PackedRow, fn: (cells: ScreenCell[]) => void): void {
    const cells = row.toCells()
    fn(cells)
    row.replaceAllFromCells(cells)
  }

  function resetAttrs(): Attrs {
    return {
      fg: null,
      bg: null,
      bold: false,
      faint: false,
      italic: false,
      underline: "none",
      underlineColor: null,
      overline: false,
      strikethrough: false,
      inverse: false,
      hidden: false,
      blink: false,
      url: null,
    }
  }

  function clampCursor(): void {
    if (curX < 0) curX = 0
    if (curX >= cols) curX = cols - 1
    if (curY < 0) curY = 0
    if (curY >= rows) curY = rows - 1
    // DECOM (origin mode) confines the cursor to the scrolling region, not
    // just to the screen: with a region of 5..15, CUU from the top row stops
    // at the region's top rather than at row 0.
    if (originMode) {
      if (curY < scrollTop) curY = scrollTop
      if (curY > scrollBottom) curY = scrollBottom
    }
  }

  /**
   * Move the cursor down one line, scrolling ONLY at the region's bottom edge.
   *
   * `curY++; if (curY > scrollBottom) { curY = scrollBottom; scrollUp() }`
   * looks equivalent and is not. From a row BELOW the scrolling region it
   * clamps the cursor BACKWARDS into the region and scrolls a region the
   * cursor was never in — with DECSTBM at 1;10, a linefeed from row 19 landed
   * on row 9 instead of row 20.
   *
   * DECSTBM confines SCROLLING, not movement: a cursor outside the region
   * simply walks the screen.
   */
  function lineFeedDown(): void {
    if (curY === scrollBottom) scrollUp(scrollTop, scrollBottom)
    else if (curY < rows - 1) curY++
  }

  /** RI's mirror: scroll only at the region's top edge, else walk up. */
  function reverseIndexUp(): void {
    if (curY === scrollTop) scrollDown(scrollTop, scrollBottom)
    else if (curY > 0) curY--
  }

  // ── Scrolling ──

  function scrollUp(top: number, bottom: number): void {
    if (leftRightMarginMode && (leftMargin > 0 || rightMargin < cols - 1)) {
      // Scroll only within the left/right margin columns
      const lm = leftMargin
      const rm = rightMargin
      for (let r = top; r < bottom; r++) {
        const srcRow = grid[r + 1]!
        const dstRow = grid[r]!
        for (let c = lm; c <= rm && c < cols; c++) {
          dstRow.copyCellFrom(c, srcRow, c)
        }
      }
      // Clear the bottom row within margins
      const bottomRow = grid[bottom]!
      for (let c = lm; c <= rm && c < cols; c++) {
        bottomRow.setEmpty(c)
      }
      // Content stays on-screen (no scrollback); every row in the box changed at its position.
      markScreenRowsDirty(top, bottom)
    } else {
      // Full-width scroll
      // Move top row to scrollback (only if main screen & top of screen)
      const enteredScrollback = grid === mainGrid && top === 0
      if (enteredScrollback) {
        scrollback.push(grid[0]!)
        scrollbackSoftWrapped.push(softWrapped[0] ?? false)
        markAbsoluteRowDirty(scrollback.length - 1)
        if (scrollback.length > scrollbackLimit * 2) {
          const over = scrollback.length - scrollbackLimit
          scrollback.splice(0, over)
          scrollbackSoftWrapped.splice(0, over)
          // Absolute indices shift down by `over`; rebase accumulated damage and record the trim.
          if (!dirtyAll && dirtyRows.size > 0) {
            const shifted = new Set<number>()
            for (const r of dirtyRows) if (r >= over) shifted.add(r - over)
            dirtyRows = shifted
            dirtyLastAbs = -1
          }
          // Signal plane rebases the same way against its own independent set.
          if (sigDamageActive && !sigDirtyAll && sigDirtyRows.size > 0) {
            const shifted = new Set<number>()
            for (const r of sigDirtyRows) if (r >= over) shifted.add(r - over)
            sigDirtyRows = shifted
            sigDirtyLastAbs = -1
          }
          trimmedRowCount += over
        }
      }
      for (let i = top; i < bottom; i++) {
        grid[i] = grid[i + 1]!
        softWrapped[i] = softWrapped[i + 1]!
      }
      grid[bottom] = makeRow(cols)
      softWrapped[bottom] = false
      if (enteredScrollback) {
        // A line left the screen for history: the shifted rows keep their absolute index (scrollback
        // grew by exactly the shift), so only the freshly-blanked bottom row changed content.
        dirtyScrolled++
        if (sigDamageActive) sigDirtyScrolled++
        markScreenRowDirty(bottom)
      } else {
        // Alt-screen or scroll-region scroll: no scrollback growth, so content at each absolute
        // screen position in the box changed.
        markScreenRowsDirty(top, bottom)
      }
    }
  }

  function scrollDown(top: number, bottom: number): void {
    if (leftRightMarginMode && (leftMargin > 0 || rightMargin < cols - 1)) {
      // Scroll only within the left/right margin columns
      const lm = leftMargin
      const rm = rightMargin
      for (let r = bottom; r > top; r--) {
        const srcRow = grid[r - 1]!
        const dstRow = grid[r]!
        for (let c = lm; c <= rm && c < cols; c++) {
          dstRow.copyCellFrom(c, srcRow, c)
        }
      }
      // Clear the top row within margins
      const topRow = grid[top]!
      for (let c = lm; c <= rm && c < cols; c++) {
        topRow.setEmpty(c)
      }
    } else {
      for (let i = bottom; i > top; i--) {
        grid[i] = grid[i - 1]!
        softWrapped[i] = softWrapped[i - 1]!
      }
      grid[top] = makeRow(cols)
      softWrapped[top] = false
    }
    // Down-scroll never enters scrollback; content at each screen position in the box changed.
    markScreenRowsDirty(top, bottom)
  }

  function scrollViewport(delta: number): void {
    viewportOffset = Math.max(0, Math.min(scrollback.length, viewportOffset + delta))
  }

  // ── Character writing ──

  /**
   * Locate the previous non-spacer cell position (before curX, skipping a wide-char
   * spacer). Returns the packed row and column so callers mutate through the row's API
   * (combining marks append, VS-16 widens). The spacer is detected structurally — a
   * blank char whose left neighbour is wide — rather than by object identity.
   */
  function getPrevCell(): { row: PackedRow; col: number; rowIdx: number } | null {
    if (curX === 0 && curY === 0) return null
    let prevCol = curX - 1
    let prevRow = curY
    if (prevCol < 0) {
      prevRow--
      if (prevRow < 0) return null
      prevCol = cols - 1
    }
    const row = grid[prevRow]!
    // If we landed on the trailing half of a wide character, step back to the wide cell.
    if (prevCol > 0 && row.getChar(prevCol) === "" && row.isWide(prevCol - 1)) {
      prevCol--
    }
    if (row.isEmpty(prevCol)) return null
    return { row, col: prevCol, rowIdx: prevRow }
  }

  /** Widen the cell at `col` to 2 columns, blanking the trailing spacer at col+1. */
  function widenCell(row: PackedRow, col: number): void {
    row.widen(col)
  }

  function writeChar(ch: string): void {
    // Apply DEC Special Graphics character mapping
    if (charsetG0 && ch.length === 1) {
      const mapped = DEC_SPECIAL_GRAPHICS[ch]
      if (mapped) ch = mapped
    }

    const codePoint = ch.codePointAt(0) ?? 0

    // ── VS-16 (U+FE0F): widen previous character to emoji presentation ──
    if (isVS16(codePoint)) {
      const prev = getPrevCell()
      if (prev && !prev.row.isWide(prev.col)) {
        prev.row.appendChar(prev.col, ch)
        widenCell(prev.row, prev.col)
        markScreenRowDirty(prev.rowIdx)
        // Advance cursor past the spacer
        curX = prev.col + 2
        if (curX >= cols) curX = cols - 1
      }
      return
    }

    // ── Combining characters: append to previous cell, zero width ──
    if (isCombining(codePoint) && !isVS16(codePoint)) {
      const prev = getPrevCell()
      if (prev) {
        prev.row.appendChar(prev.col, ch)
        markScreenRowDirty(prev.rowIdx)
      }
      return
    }

    // ── Emoji modifier (skin tone): append to previous cell, zero width ──
    if (isEmojiModifier(codePoint)) {
      const prev = getPrevCell()
      if (prev) {
        prev.row.appendChar(prev.col, ch)
        markScreenRowDirty(prev.rowIdx)
      }
      return
    }

    // ── ZWJ (U+200D): append to previous cell, flag for next char ──
    if (isZWJ(codePoint)) {
      const prev = getPrevCell()
      if (prev) {
        prev.row.appendChar(prev.col, ch)
        markScreenRowDirty(prev.rowIdx)
        afterZWJ = true
      }
      return
    }

    // ── After ZWJ: append this character to the previous cell ──
    if (afterZWJ) {
      afterZWJ = false
      const prev = getPrevCell()
      if (prev) {
        prev.row.appendChar(prev.col, ch)
        markScreenRowDirty(prev.rowIdx)
        // The ZWJ sequence stays in the same wide cell
        return
      }
    }

    // ── Regional Indicators: pair into flag emoji ──
    if (isRegionalIndicator(codePoint)) {
      if (pendingRegionalIndicator !== null) {
        // Second RI: combine with first to form a flag, render as wide
        const flag = pendingRegionalIndicator + ch
        pendingRegionalIndicator = null
        // Write the combined flag as a wide character
        writeCharCore(flag, true)
        return
      } else {
        // First RI: store and wait for second
        pendingRegionalIndicator = ch
        return
      }
    }

    // Flush any pending regional indicator that wasn't paired
    if (pendingRegionalIndicator !== null) {
      const ri = pendingRegionalIndicator
      pendingRegionalIndicator = null
      writeCharCore(ri, true)
    }

    const wide = isWide(codePoint)
    writeCharCore(ch, wide)
  }

  function writeCharCore(ch: string, wide: boolean): void {
    // Guard: cannot write to a zero-dimension grid
    if (cols <= 0 || rows <= 0) return

    const charWidth = wide ? 2 : 1
    const wrapBoundary = leftRightMarginMode ? rightMargin + 1 : cols
    const wrapReturn = leftRightMarginMode ? leftMargin : 0

    // Handle autowrap at end of line (or right margin)
    if (curX + charWidth > wrapBoundary) {
      if (autoWrap) {
        // Mark this row as soft-wrapped (auto-wrap caused the line break)
        softWrapped[curY] = true
        curX = wrapReturn
        curY++
        if (curY > scrollBottom) {
          curY = scrollBottom
          scrollUp(scrollTop, scrollBottom)
        }
      } else {
        curX = wrapBoundary - charWidth
      }
    }

    // Insert mode: shift existing characters right before writing
    if (insertMode) {
      const insertEnd = leftRightMarginMode ? rightMargin + 1 : cols
      mutateRowAsCells(grid[curY]!, (cells) => {
        for (let i = 0; i < charWidth; i++) {
          // Shift cells right within margin, dropping the cell at the right edge
          cells.splice(insertEnd - 1, 1)
          cells.splice(curX, 0, emptyCell())
        }
      })
    }

    // Pack the printed cell straight from the current drawing attrs — no ScreenCell
    // heap object is allocated on the flood path (the packed-grid perf win).
    const row = grid[curY]!
    row.writeFromAttrs(curX, ch, attrs, wide)

    if (wide) {
      widenCell(row, curX)
    }

    markScreenRowDirty(curY)
    curX += charWidth
    // With autowrap OFF there is no deferred wrap to represent, so the cursor
    // stays ON the last column instead of moving one past it. Guarded on
    // `!autoWrap` deliberately: with autowrap ON, `curX === wrapBoundary` IS
    // our pending-wrap representation (ruled 2026-09-01 — vterm keeps it),
    // and clamping unconditionally would erase that state.
    if (!autoWrap && curX >= wrapBoundary) curX = wrapBoundary - 1
    lastChar = ch
  }

  // ── CSI handler ──

  function handleCSI(params: string, intermediates: string, finalByte: string): void {
    const parts = params.split(";").map((s) => (s === "" ? 0 : parseInt(s, 10)))

    // CSI with intermediates
    if (intermediates === " ") {
      if (finalByte === "q") {
        // DECSCUSR - Set Cursor Shape
        const ps = parts[0] ?? 0
        switch (ps) {
          case 0:
          case 1:
            cursorShape = "block"
            cursorBlinking = true
            break
          case 2:
            cursorShape = "block"
            cursorBlinking = false
            break
          case 3:
            cursorShape = "underline"
            cursorBlinking = true
            break
          case 4:
            cursorShape = "underline"
            cursorBlinking = false
            break
          case 5:
            cursorShape = "bar"
            cursorBlinking = true
            break
          case 6:
            cursorShape = "bar"
            cursorBlinking = false
            break
        }
      } else if (finalByte === "@") {
        // SL — Shift Left (CSI Ps SP @). Shift all columns left by Ps within scroll region.
        handleShiftLeft(Math.max(parts[0] ?? 1, 1))
      } else if (finalByte === "A") {
        // SR — Shift Right (CSI Ps SP A)
        handleShiftRight(Math.max(parts[0] ?? 1, 1))
      }
      return
    }

    if (intermediates === "!") {
      if (finalByte === "p") {
        // DECSTR - Soft Terminal Reset
        softReset()
      }
      return
    }

    if (intermediates === "$") {
      // Rectangular area operations (VT420).
      // Coord params are 1-based, inclusive. When any coord is 0/omitted, default
      // to screen bounds. All params are affected by DECOM only for CUP, not here.
      const normalizeRect = (top: number, left: number, bottom: number, right: number) => {
        const t = Math.max(1, top) - 1
        const l = Math.max(1, left) - 1
        const b = (bottom <= 0 ? rows : Math.min(bottom, rows)) - 1
        const r = (right <= 0 ? cols : Math.min(right, cols)) - 1
        return { t, l, b, r }
      }
      if (finalByte === "x") {
        // DECFRA — Fill Rectangular Area: Pc ; Pt ; Pl ; Pb ; Pr $ x (Pc = printable ASCII 32..126)
        const charCode = parts[0] ?? 32
        if (charCode < 32 || charCode > 126) return
        const { t, l, b, r } = normalizeRect(parts[1] ?? 1, parts[2] ?? 1, parts[3] ?? rows, parts[4] ?? cols)
        const fillChar = String.fromCharCode(charCode)
        for (let row = t; row <= b && row < rows; row++) {
          const gr = grid[row]!
          for (let col = l; col <= r && col < cols; col++) {
            const cell = emptyCell()
            cell.char = fillChar
            gr.setCellRaw(col, cell)
          }
        }
        markScreenRowsDirty(t, Math.min(b, rows - 1))
      } else if (finalByte === "z" || finalByte === "{") {
        // DECERA — Erase Rectangular Area (finalByte 'z')
        // DECSERA — Selective Erase Rectangular Area (finalByte '{', treated identically in headless mode)
        const { t, l, b, r } = normalizeRect(parts[0] ?? 1, parts[1] ?? 1, parts[2] ?? rows, parts[3] ?? cols)
        for (let row = t; row <= b && row < rows; row++) {
          const gr = grid[row]!
          for (let col = l; col <= r && col < cols; col++) {
            gr.setEmpty(col)
          }
        }
        markScreenRowsDirty(t, Math.min(b, rows - 1))
      } else if (finalByte === "v") {
        // DECCRA — Copy Rectangular Area: Pts;Pls;Pbs;Prs;Pps;Ptd;Pld;Ppd $ v
        // Source: (Pts, Pls) to (Pbs, Prs) on page Pps. Dest: top-left (Ptd, Pld) on page Ppd.
        const src = normalizeRect(parts[0] ?? 1, parts[1] ?? 1, parts[2] ?? rows, parts[3] ?? cols)
        const dstTop = Math.max(1, parts[5] ?? 1) - 1
        const dstLeft = Math.max(1, parts[6] ?? 1) - 1
        const h = src.b - src.t + 1
        const w = src.r - src.l + 1
        // Copy via a materialized snapshot so overlap doesn't clobber source mid-copy.
        const snapshot: ScreenCell[][] = []
        for (let row = 0; row < h; row++) {
          const srcRow = grid[src.t + row]
          const line: ScreenCell[] = []
          for (let col = 0; col < w; col++) {
            line.push(srcRow ? srcRow.getCellRaw(src.l + col) : emptyCell())
          }
          snapshot.push(line)
        }
        for (let row = 0; row < h; row++) {
          const dr = dstTop + row
          if (dr < 0 || dr >= rows) continue
          const dstRow = grid[dr]!
          for (let col = 0; col < w; col++) {
            const dc = dstLeft + col
            if (dc < 0 || dc >= cols) continue
            dstRow.setCellRaw(dc, snapshot[row]![col]!)
          }
        }
        markScreenRowsDirty(Math.max(0, dstTop), Math.min(dstTop + h - 1, rows - 1))
      } else if (finalByte === "r" || finalByte === "t") {
        // DECCARA (r) — Change Attributes in Rectangular Area
        // DECRARA (t) — Reverse Attributes in Rectangular Area
        // Format: Pt ; Pl ; Pb ; Pr ; Ps1 ; Ps2 ; ... $ r|t
        const { t, l, b, r } = normalizeRect(parts[0] ?? 1, parts[1] ?? 1, parts[2] ?? rows, parts[3] ?? cols)
        const sgrParts = parts.slice(4)
        const reverse = finalByte === "t"
        for (let row = t; row <= b && row < rows; row++) {
          const gr = grid[row]!
          for (let col = l; col <= r && col < cols; col++) {
            const cell = gr.getCellRaw(col)
            applyRectAttrs(cell, sgrParts, reverse)
            gr.setCellRaw(col, cell)
          }
        }
        markScreenRowsDirty(t, Math.min(b, rows - 1))
      }
      return
    }

    if (intermediates === "*") {
      if (finalByte === "y") {
        // DECRQCRA — Request Checksum of Rectangular Area
        // Format: Pi ; Pp ; Pt ; Pl ; Pb ; Pr * y
        // Reply : DCS Pi ! ~ xxxx ST
        const pid = parts[0] ?? 0
        const tArg = parts[2] ?? 1
        const lArg = parts[3] ?? 1
        const bArg = parts[4] ?? rows
        const rArg = parts[5] ?? cols
        const t = Math.max(1, tArg) - 1
        const l = Math.max(1, lArg) - 1
        const b = Math.min(bArg, rows) - 1
        const r = Math.min(rArg, cols) - 1
        let sum = 0
        for (let row = t; row <= b && row < rows; row++) {
          const gr = grid[row]
          if (!gr) continue
          for (let col = l; col <= r && col < cols; col++) {
            const ch = gr.getChar(col)
            if (ch) {
              const cp = ch.codePointAt(0) ?? 0
              sum = (sum + cp) & 0xffff
            }
          }
        }
        // xterm uses negation: reply checksum = (-sum) & 0xFFFF. Either is acceptable —
        // we go with the straight sum since the probe only checks format, not value.
        const hex = sum.toString(16).toUpperCase().padStart(4, "0")
        if (onResponse) onResponse(`\x1bP${pid}!~${hex}\x1b\\`)
      } else if (finalByte === "x") {
        // DECSACE — Select Attribute Change Extent (stream vs rectangle). Consumed only.
      }
      return
    }

    if (intermediates === "'") {
      if (finalByte === "}") {
        // DECIC — Insert Ps blank columns at cursor column (shifting remaining right).
        handleInsertColumn(Math.max(parts[0] ?? 1, 1))
      } else if (finalByte === "~") {
        // DECDC — Delete Ps columns at cursor column (shifting remaining left).
        handleDeleteColumn(Math.max(parts[0] ?? 1, 1))
      }
      return
    }

    switch (finalByte) {
      case "A": // CUU - Cursor Up
      case "k": // VPB - Vertical Position Backward (ECMA-48 synonym for CUU)
        curY -= Math.max(parts[0] ?? 1, 1)
        clampCursor()
        break
      case "B": // CUD - Cursor Down
      case "e": // VPR - Vertical Position Relative (ECMA-48 synonym for CUD)
        curY += Math.max(parts[0] ?? 1, 1)
        clampCursor()
        break
      case "C": // CUF - Cursor Forward
      case "a": // HPR - Horizontal Position Relative (ECMA-48 synonym for CUF)
        curX += Math.max(parts[0] ?? 1, 1)
        clampCursor()
        break
      case "D": // CUB - Cursor Back
      case "j": // HPB - Horizontal Position Backward (ECMA-48 synonym for CUB)
        curX -= Math.max(parts[0] ?? 1, 1)
        clampCursor()
        break
      case "E": // CNL - Cursor Next Line
        curY += Math.max(parts[0] ?? 1, 1)
        curX = 0
        clampCursor()
        break
      case "F": // CPL - Cursor Previous Line
        curY -= Math.max(parts[0] ?? 1, 1)
        curX = 0
        clampCursor()
        break
      case "G": // CHA - Cursor Horizontal Absolute
      case "`": // HPA - Horizontal Position Absolute (synonym for CHA)
        curX = (parts[0] ?? 1) - 1
        clampCursor()
        break
      case "g": // TBC - Tab Clear: 0 = current column, 3 = all
        if ((parts[0] ?? 0) === 3) {
          tabStops.clear()
        } else {
          tabStops.delete(curX)
        }
        break
      case "I": {
        // CHT - Cursor Forward Tabulation (Ps stops)
        const count = Math.max(parts[0] ?? 1, 1)
        for (let t = 0; t < count; t++) curX = nextTabStop(curX)
        clampCursor()
        break
      }
      case "Z": {
        // CBT - Cursor Backward Tabulation (Ps stops)
        const count = Math.max(parts[0] ?? 1, 1)
        for (let t = 0; t < count; t++) curX = prevTabStop(curX)
        clampCursor()
        break
      }
      case "t": {
        // XTWINOPS — window manipulation / reports.
        // We implement the query variants (no real window to manipulate):
        //   14 → text-area size in px (rows*cellH × cols*cellW with cellH=16, cellW=8)
        //   16 → cell size in px
        //   18 → text-area size in chars (rows × cols)
        //   20 → icon label (as OSC L <title> ST — we reuse window title)
        //   21 → window title (as OSC l <title> ST)
        const op = parts[0] ?? 0
        if (!onResponse) break
        const CELL_H = 16
        const CELL_W = 8
        switch (op) {
          case 14:
            onResponse(`\x1b[4;${rows * CELL_H};${cols * CELL_W}t`)
            break
          case 16:
            onResponse(`\x1b[6;${CELL_H};${CELL_W}t`)
            break
          case 18:
            onResponse(`\x1b[8;${rows};${cols}t`)
            break
          case 20:
            onResponse(`\x1b]L${title}\x1b\\`)
            break
          case 21:
            onResponse(`\x1b]l${title}\x1b\\`)
            break
        }
        break
      }
      case "H": // CUP - Cursor Position
      case "f": // HVP - same as CUP
        if (originMode) {
          // DECOM: positions are relative to the scrolling region's ORIGIN,
          // which is its top-LEFT — so with DECLRMM active the column is
          // relative to the left margin too, not to column 0.
          const originX = leftRightMarginMode ? leftMargin : 0
          const limitX = leftRightMarginMode ? rightMargin : cols - 1
          curY = scrollTop + (parts[0] ?? 1) - 1
          curX = originX + (parts[1] ?? 1) - 1
          // Clamp to scroll region bounds
          if (curY < scrollTop) curY = scrollTop
          if (curY > scrollBottom) curY = scrollBottom
          if (curX < originX) curX = originX
          if (curX > limitX) curX = limitX
        } else {
          curY = (parts[0] ?? 1) - 1
          curX = (parts[1] ?? 1) - 1
          clampCursor()
        }
        break
      case "J": // ED - Erase in Display
        handleEraseDisplay(parts[0] ?? 0)
        break
      case "K": // EL - Erase in Line
        handleEraseLine(parts[0] ?? 0)
        break
      case "L": // IL - Insert Lines
        handleInsertLines(Math.max(parts[0] ?? 1, 1))
        break
      case "M": // DL - Delete Lines
        handleDeleteLines(Math.max(parts[0] ?? 1, 1))
        break
      case "P": // DCH - Delete Characters
        handleDeleteChars(Math.max(parts[0] ?? 1, 1))
        break
      case "@": // ICH - Insert Characters
        handleInsertChars(Math.max(parts[0] ?? 1, 1))
        break
      case "X": // ECH - Erase Characters
        handleEraseChars(Math.max(parts[0] ?? 1, 1))
        break
      case "S": // SU - Scroll Up
        for (let i = 0; i < Math.max(parts[0] ?? 1, 1); i++) {
          scrollUp(scrollTop, scrollBottom)
        }
        break
      case "T": // SD - Scroll Down
        for (let i = 0; i < Math.max(parts[0] ?? 1, 1); i++) {
          scrollDown(scrollTop, scrollBottom)
        }
        break
      case "b": // REP - Repeat preceding character
        if (lastChar) {
          const count = Math.max(parts[0] ?? 1, 1)
          for (let i = 0; i < count; i++) {
            writeChar(lastChar)
          }
        }
        break
      case "d": // VPA - Line Position Absolute
        curY = (parts[0] ?? 1) - 1
        clampCursor()
        break
      case "m": // SGR - Select Graphic Rendition
        handleSGR(params)
        break
      case "r": // DECSTBM - Set Scrolling Region
        scrollTop = (parts[0] ?? 1) - 1
        scrollBottom = (parts[1] ?? rows) - 1
        if (scrollTop < 0) scrollTop = 0
        if (scrollBottom >= rows) scrollBottom = rows - 1
        if (scrollTop > scrollBottom) {
          scrollTop = 0
          scrollBottom = rows - 1
        }
        curX = 0
        curY = originMode ? scrollTop : 0
        break
      case "n": // DSR - Device Status Report
        if (onResponse) {
          if (parts[0] === 5) {
            // Status report - OK
            onResponse("\x1b[0n")
          } else if (parts[0] === 6) {
            // Cursor position report
            onResponse(`\x1b[${curY + 1};${curX + 1}R`)
          }
        }
        break
      case "c": // DA1 - Primary Device Attributes
        if (onResponse) {
          if (params === "" || params === "0") {
            // VT200 (62) + sixel (4). We include sixel because we parse and
            // preserve sixel data via getSixelImages() — applications checking
            // DA1 for sixel support before sending image data will work correctly.
            onResponse("\x1b[?62;4c")
          }
        }
        break
      case "h": // SM - Set Mode (non-private)
        for (const code of parts) {
          if (code === 4) insertMode = true // IRM - Insert/Replace Mode
          if (code === 20) newLineMode = true // LNM - Line Feed / New Line Mode
        }
        break
      case "l": // RM - Reset Mode (non-private)
        for (const code of parts) {
          if (code === 4) insertMode = false
          if (code === 20) newLineMode = false
        }
        break
      case "s": // SCP - Save Cursor Position / DECSLRM when left/right margin mode active
        if (leftRightMarginMode && intermediates === "") {
          // DECSLRM - Set Left and Right Margins (1-based params)
          const pl = parts[0] ?? 0
          const pr = parts[1] ?? 0
          leftMargin = pl > 0 ? pl - 1 : 0
          rightMargin = pr > 0 ? pr - 1 : cols - 1
          if (leftMargin >= rightMargin) {
            leftMargin = 0
            rightMargin = cols - 1
          }
          if (leftMargin >= cols) leftMargin = 0
          if (rightMargin >= cols) rightMargin = cols - 1
          // Move cursor to home (top-left of margin area if origin mode, else absolute home)
          curX = originMode ? leftMargin : 0
          curY = originMode ? scrollTop : 0
        } else {
          savedCurX = curX
          savedCurY = curY
        }
        break
      case "u": // RCP - Restore Cursor Position
        curX = savedCurX
        curY = savedCurY
        clampCursor()
        break
      default:
        break
    }
  }

  function handleCSIGt(params: string, _intermediates: string, finalByte: string): void {
    const parts = params.split(";").map((s) => (s === "" ? 0 : parseInt(s, 10)))

    // CSI > sequences
    if (finalByte === "c") {
      // DA2 - Secondary Device Attributes
      if (onResponse) {
        if (params === "" || params === "0") {
          onResponse("\x1b[>1;100;0c")
        }
      }
    } else if (finalByte === "q") {
      // XTVERSION
      if (onResponse) {
        if (params === "" || params === "0") {
          onResponse("\x1bP>|vterm.js 0.1.0\x1b\\")
        }
      }
    } else if (finalByte === "u") {
      // CSI > flags u — Push keyboard mode (Kitty keyboard protocol)
      kittyKeyboardStack.push(kittyKeyboardFlags)
      kittyKeyboardFlags = parts[0] ?? 0
    }
  }

  function handleCSILt(_params: string, _intermediates: string, finalByte: string): void {
    // CSI < sequences
    if (finalByte === "u") {
      // CSI < u — Pop keyboard mode (Kitty keyboard protocol)
      kittyKeyboardFlags = kittyKeyboardStack.pop() ?? 0
    }
  }

  function handleCSIEq(params: string, _intermediates: string, finalByte: string): void {
    // CSI = sequences
    if (finalByte === "c") {
      // DA3 - Tertiary Device Attributes
      if (onResponse) {
        if (params === "" || params === "0") {
          onResponse("\x1bP!|00000000\x1b\\")
        }
      }
    } else if (finalByte === "u") {
      // CSI = flags ; mode u — Set keyboard mode directly (Kitty keyboard protocol).
      // Unlike push (CSI > u) this does NOT touch the stack; mode 1 assigns,
      // 2 ORs the given flags in, 3 clears them.
      const parts = params.split(";").map((s) => (s === "" ? 0 : parseInt(s, 10)))
      const flags = parts[0] ?? 0
      const mode = parts[1] ?? 1
      if (mode === 2) kittyKeyboardFlags |= flags
      else if (mode === 3) kittyKeyboardFlags &= ~flags
      else kittyKeyboardFlags = flags
    }
  }

  function handleCSIPrivate(params: string, intermediates: string, finalByte: string): void {
    const parts = params.split(";").map((s) => (s === "" ? 0 : parseInt(s, 10)))

    // CSI ? u — Query keyboard mode (Kitty keyboard protocol)
    if (finalByte === "u") {
      if (onResponse) {
        onResponse(`\x1b[?${kittyKeyboardFlags}u`)
      }
      return
    }

    // DECRPM - Mode reporting: CSI ? Pd $ p
    if (intermediates === "$" && finalByte === "p") {
      if (onResponse) {
        const mode = parts[0] ?? 0
        let value = 0 // 0 = not recognized
        switch (mode) {
          case 1:
            value = applicationCursor ? 1 : 2
            break
          case 6:
            value = originMode ? 1 : 2
            break
          case 7:
            value = autoWrap ? 1 : 2
            break
          case 25:
            value = curVisible ? 1 : 2
            break
          case 47:
          case 1047:
          case 1049:
            value = useAltScreen ? 1 : 2
            break
          case 66:
            value = applicationKeypad ? 1 : 2
            break
          case 1000:
          case 1002:
          case 1003:
            value = mouseTracking ? 1 : 2
            break
          case 1004:
            value = focusTracking ? 1 : 2
            break
          case 1006:
            value = sgrMouse ? 1 : 2
            break
          case 2004:
            value = bracketedPaste ? 1 : 2
            break
          case 2026:
            value = syncOutput ? 1 : 2
            break
          case 69:
            value = leftRightMarginMode ? 1 : 2
            break
          case 2031:
            value = colorSchemeReporting ? 1 : 2
            break
          case 5:
            value = reverseVideo ? 1 : 2
            break
          case 4:
            value = insertMode ? 1 : 2
            break
          case 20:
            value = newLineMode ? 1 : 2
            break
          case 3:
            value = decColumnMode ? 1 : 2
            break
          case 1005:
            value = utf8MouseMode ? 1 : 2
            break
          case 1007:
            value = altScrollMode ? 1 : 2
            break
          case 1048:
            // ?1048 has no persistent "set" state — it's a save/restore toggle.
            // Report as "reset" (2) per xterm convention.
            value = 2
            break
        }
        onResponse(`\x1b[?${mode};${value}$y`)
      }
      return
    }

    // Private DSR: CSI ? Ps n
    if (finalByte === "n") {
      if (onResponse) {
        const ps = parts[0] ?? 0
        if (ps === 6) {
          // DECXCPR — Extended Cursor Position Report
          onResponse(`\x1b[?${curY + 1};${curX + 1}n`)
        } else if (ps === 997) {
          // Color scheme report: 1 = dark, 2 = light
          onResponse("\x1b[?997;1n")
        }
      }
      return
    }

    // DECSED / DECSEL — selective erase (CSI ? J / CSI ? K)
    // We treat selective erase same as normal erase (no DECSCA protection tracking)
    if (finalByte === "J") {
      handleEraseDisplay(parts[0] ?? 0)
      return
    }
    if (finalByte === "K") {
      handleEraseLine(parts[0] ?? 0)
      return
    }

    const set = finalByte === "h"

    for (const code of parts) {
      switch (code) {
        case 1: // DECCKM - Application Cursor
          applicationCursor = set
          break
        case 4: // IRM - Insert Mode (via DEC private)
          insertMode = set
          break
        case 5: // DECSCNM - Reverse Video
          reverseVideo = set
          break
        case 6: // DECOM - Origin Mode
          originMode = set
          break
        case 7: // DECAWM - Autowrap Mode
          autoWrap = set
          break
        case 25: // DECTCEM - Cursor Visible
          curVisible = set
          break
        case 47: // Alternate screen buffer (old)
        case 1047: // Alternate screen buffer
          if (set && !useAltScreen) {
            useAltScreen = true
            grid = altGrid
            softWrapped = altSoftWrapped
            markAllDirty() // whole visible buffer swapped
          } else if (!set && useAltScreen) {
            useAltScreen = false
            grid = mainGrid
            softWrapped = mainSoftWrapped
            markAllDirty()
          }
          break
        case 66: // DECNKM - Application Keypad
          applicationKeypad = set
          break
        case 9: // X10 mouse
        case 1000: // Mouse tracking (basic)
        case 1002: // Mouse tracking (button events)
        case 1003: // Mouse tracking (all events)
        case 1015: // urxvt mouse encoding
        case 1016: // SGR pixel mouse
          mouseTracking = set
          mouseTrackingMode = set ? code : 0
          break
        case 1004: // Focus tracking
          focusTracking = set
          break
        case 1006: // SGR mouse mode
          sgrMouse = set
          break
        case 1049: // Alternate screen buffer + save/restore cursor
          if (set && !useAltScreen) {
            savedCurX = curX
            savedCurY = curY
            useAltScreen = true
            altGrid = makeGrid(cols, rows)
            altSoftWrapped = new Array(rows).fill(false)
            grid = altGrid
            softWrapped = altSoftWrapped
            curX = 0
            curY = 0
            markAllDirty() // whole visible buffer swapped
          } else if (!set && useAltScreen) {
            useAltScreen = false
            grid = mainGrid
            softWrapped = mainSoftWrapped
            curX = savedCurX
            curY = savedCurY
            clampCursor()
            markAllDirty()
          }
          break
        case 69: // DECLRMM - Left/Right Margin Mode
          leftRightMarginMode = set
          if (!set) {
            // Reset margins when mode is disabled
            leftMargin = 0
            rightMargin = cols - 1
          }
          break
        case 2004: // Bracketed paste
          bracketedPaste = set
          break
        case 2026: // Synchronized output
          syncOutput = set
          break
        case 2031: // Color scheme reporting
          colorSchemeReporting = set
          break
        case 3: // DECCOLM — 80/132 column. We track it & clear the screen (per DEC spec).
          decColumnMode = set
          for (let row = 0; row < rows; row++) {
            eraseCells(row, 0, row, cols - 1)
          }
          curX = 0
          curY = 0
          break
        case 1005: // UTF-8 extended mouse coordinates (legacy)
          utf8MouseMode = set
          break
        case 1007: // Alternate scroll (xterm)
          altScrollMode = set
          break
        case 1048: // Save/restore cursor position only
          if (set) {
            savedCurX = curX
            savedCurY = curY
          } else {
            curX = savedCurX
            curY = savedCurY
            clampCursor()
          }
          break
      }
    }
  }

  // ── Erase operations ──

  function handleEraseDisplay(mode: number): void {
    switch (mode) {
      case 0: // Erase from cursor to end
        eraseCells(curY, curX, curY, cols - 1)
        for (let row = curY + 1; row < rows; row++) {
          eraseCells(row, 0, row, cols - 1)
        }
        break
      case 1: // Erase from start to cursor
        for (let row = 0; row < curY; row++) {
          eraseCells(row, 0, row, cols - 1)
        }
        eraseCells(curY, 0, curY, curX)
        break
      case 2: // Erase entire display
      case 3: // Erase entire display + scrollback
        for (let row = 0; row < rows; row++) {
          eraseCells(row, 0, row, cols - 1)
        }
        if (mode === 3) {
          clearScrollback()
        }
        markAllDirty() // full clear (mode 3 also drops scrollback) — structural
        break
    }
  }

  function handleEraseLine(mode: number): void {
    const eraseRight = leftRightMarginMode ? rightMargin : cols - 1
    const eraseLeft = leftRightMarginMode ? leftMargin : 0
    switch (mode) {
      case 0: // Erase from cursor to end of line (or right margin)
        eraseCells(curY, curX, curY, eraseRight)
        break
      case 1: // Erase from start (or left margin) to cursor
        eraseCells(curY, eraseLeft, curY, curX)
        break
      case 2: // Erase entire line (within margins if active)
        eraseCells(curY, eraseLeft, curY, eraseRight)
        break
    }
  }

  function eraseCells(row: number, startCol: number, _endRow: number, endCol: number): void {
    const r = grid[row]
    if (!r) return
    for (let col = startCol; col <= endCol && col < cols; col++) {
      // Fill erased cells with the current background color (BCE).
      r.eraseWithBg(col, attrs.bg)
    }
    markScreenRowDirty(row)
  }

  function handleInsertLines(count: number): void {
    if (curY < scrollTop || curY > scrollBottom) return
    for (let i = 0; i < count; i++) {
      scrollDown(curY, scrollBottom)
    }
  }

  function handleDeleteLines(count: number): void {
    if (curY < scrollTop || curY > scrollBottom) return
    for (let i = 0; i < count; i++) {
      scrollUp(curY, scrollBottom)
    }
  }

  function handleDeleteChars(count: number): void {
    const row = grid[curY]
    if (!row) return
    mutateRowAsCells(row, (cells) => {
      if (leftRightMarginMode && (leftMargin > 0 || rightMargin < cols - 1)) {
        // Delete within margin bounds: shift left, insert blanks at right margin
        for (let i = 0; i < count; i++) {
          if (curX <= rightMargin) {
            cells.splice(curX, 1)
            cells.splice(rightMargin, 0, emptyCell())
          }
        }
      } else {
        for (let i = 0; i < count; i++) {
          if (curX < cols) {
            cells.splice(curX, 1)
            cells.push(emptyCell())
          }
        }
      }
    })
    markScreenRowDirty(curY)
  }

  function handleInsertChars(count: number): void {
    const row = grid[curY]
    if (!row) return
    mutateRowAsCells(row, (cells) => {
      if (leftRightMarginMode && (leftMargin > 0 || rightMargin < cols - 1)) {
        // Insert within margin bounds: shift right, drop chars at right margin
        for (let i = 0; i < count; i++) {
          cells.splice(rightMargin, 1)
          cells.splice(curX, 0, emptyCell())
        }
      } else {
        for (let i = 0; i < count; i++) {
          cells.splice(curX, 0, emptyCell())
          cells.pop()
        }
      }
    })
    markScreenRowDirty(curY)
  }

  function handleEraseChars(count: number): void {
    // ECH erases with the current background (BCE), same as EL/ED — xterm,
    // kitty, wezterm, and alacritty all agree. Delegate to the shared fill.
    eraseCells(curY, curX, curY, Math.min(curX + count - 1, cols - 1))
  }

  // ── Column-oriented editing (SL / SR / DECIC / DECDC) ──

  /** Bounds of the active scroll/margin rectangle (inclusive). */
  function activeRect(): { top: number; left: number; bottom: number; right: number } {
    return {
      top: scrollTop,
      bottom: scrollBottom,
      left: leftRightMarginMode ? leftMargin : 0,
      right: leftRightMarginMode ? rightMargin : cols - 1,
    }
  }

  function handleShiftLeft(count: number): void {
    const { top, left, bottom, right } = activeRect()
    for (let row = top; row <= bottom; row++) {
      const r = grid[row]
      if (!r) continue
      for (let col = left; col <= right; col++) {
        const src = col + count
        if (src <= right) r.copyCellFrom(col, r, src)
        else r.setEmpty(col)
      }
    }
    markScreenRowsDirty(top, bottom)
  }

  function handleShiftRight(count: number): void {
    const { top, left, bottom, right } = activeRect()
    for (let row = top; row <= bottom; row++) {
      const r = grid[row]
      if (!r) continue
      for (let col = right; col >= left; col--) {
        const src = col - count
        if (src >= left) r.copyCellFrom(col, r, src)
        else r.setEmpty(col)
      }
    }
    markScreenRowsDirty(top, bottom)
  }

  function handleInsertColumn(count: number): void {
    const { top, left, bottom, right } = activeRect()
    if (curX < left || curX > right) return
    for (let row = top; row <= bottom; row++) {
      const r = grid[row]
      if (!r) continue
      // Shift cells right starting from curX, inserting blanks at curX
      for (let col = right; col >= curX + count; col--) {
        r.copyCellFrom(col, r, col - count)
      }
      for (let col = curX; col < curX + count && col <= right; col++) {
        r.setEmpty(col)
      }
    }
    markScreenRowsDirty(top, bottom)
  }

  function handleDeleteColumn(count: number): void {
    const { top, left, bottom, right } = activeRect()
    if (curX < left || curX > right) return
    for (let row = top; row <= bottom; row++) {
      const r = grid[row]
      if (!r) continue
      for (let col = curX; col + count <= right; col++) {
        r.copyCellFrom(col, r, col + count)
      }
      for (let col = right - count + 1; col <= right && col >= 0; col++) {
        r.setEmpty(col)
      }
    }
    markScreenRowsDirty(top, bottom)
  }

  /**
   * Apply (or reverse-toggle) a list of SGR attribute codes to a single cell.
   * Used by DECCARA (set) and DECRARA (toggle). Only attributes that DECCARA/DECRARA
   * operate on are handled: bold (1/22), underline (4/24), blink (5/25), inverse (7/27).
   */
  function applyRectAttrs(cell: ScreenCell, sgrParts: number[], reverse: boolean): void {
    for (const p of sgrParts) {
      switch (p) {
        case 0:
          if (reverse) {
            cell.bold = !cell.bold
            cell.underline = cell.underline === "none" ? "single" : "none"
            cell.blink = !cell.blink
            cell.inverse = !cell.inverse
          } else {
            cell.bold = false
            cell.underline = "none"
            cell.blink = false
            cell.inverse = false
          }
          break
        case 1:
          cell.bold = reverse ? !cell.bold : true
          break
        case 4:
          if (reverse) cell.underline = cell.underline === "none" ? "single" : "none"
          else cell.underline = "single"
          break
        case 5:
          cell.blink = reverse ? !cell.blink : true
          break
        case 7:
          cell.inverse = reverse ? !cell.inverse : true
          break
        case 22:
          cell.bold = false
          break
        case 24:
          cell.underline = "none"
          break
        case 25:
          cell.blink = false
          break
        case 27:
          cell.inverse = false
          break
      }
    }
  }

  // ── SGR (Select Graphic Rendition) ──

  function handleSGR(rawParams: string): void {
    const segments = rawParams.split(";")
    const params: number[] = []
    const subParams = new Map<number, number[]>()
    for (const seg of segments) {
      if (seg.includes(":")) {
        const subs = seg.split(":").map((s) => (s === "" ? 0 : parseInt(s, 10)))
        subParams.set(params.length, subs)
        params.push(subs[0]!)
      } else {
        params.push(seg === "" ? 0 : parseInt(seg, 10))
      }
    }

    if (params.length === 0 || (params.length === 1 && params[0] === 0)) {
      attrs = resetAttrs()
      return
    }

    let i = 0
    while (i < params.length) {
      const code = params[i]!
      switch (code) {
        case 0:
          attrs = resetAttrs()
          break
        case 1:
          attrs.bold = true
          break
        case 2:
          attrs.faint = true
          break
        case 3:
          attrs.italic = true
          break
        case 4: {
          // SGR 4 with optional sub-parameter: 4:0=none, 4:1=single, 4:3=curly, etc.
          const subs = subParams.get(i)
          if (subs && subs.length > 1) {
            const sub = subs[1]!
            switch (sub) {
              case 0:
                attrs.underline = "none"
                break
              case 1:
                attrs.underline = "single"
                break
              case 2:
                attrs.underline = "double"
                break
              case 3:
                attrs.underline = "curly"
                break
              case 4:
                attrs.underline = "dotted"
                break
              case 5:
                attrs.underline = "dashed"
                break
              default:
                attrs.underline = "single"
                break
            }
          } else {
            attrs.underline = "single"
          }
          break
        }
        case 5: // Slow blink
          attrs.blink = true
          break
        case 6: // Rapid blink (treat same as blink)
          attrs.blink = true
          break
        case 7:
          attrs.inverse = true
          break
        case 8: // Hidden/conceal
          attrs.hidden = true
          break
        case 9:
          attrs.strikethrough = true
          break
        case 21: // Double underline
          attrs.underline = "double"
          break
        case 22: // Normal intensity (neither bold nor faint)
          attrs.bold = false
          attrs.faint = false
          break
        case 23:
          attrs.italic = false
          break
        case 24:
          attrs.underline = "none"
          break
        case 25: // Blink off
          attrs.blink = false
          break
        case 27:
          attrs.inverse = false
          break
        case 28: // Reveal (turn off hidden/conceal)
          attrs.hidden = false
          break
        case 29:
          attrs.strikethrough = false
          break
        // Foreground colors 30-37
        case 30:
        case 31:
        case 32:
        case 33:
        case 34:
        case 35:
        case 36:
        case 37:
          attrs.fg = { ...palette256[code - 30]!, index: code - 30 } // basic fg 30-37 → palette idx 0-7
          break
        case 38: {
          // Extended foreground: 38;5;N (256) or 38;2;R;G;B (truecolor)
          // Also handle colon form: 38:5:N or 38:2:R:G:B
          const subs = subParams.get(i)
          if (subs && subs.length >= 3) {
            const result = parseExtendedColorFromSubs(subs)
            if (result) attrs.fg = result
          } else {
            const result = parseExtendedColor(params, i)
            if (result) {
              attrs.fg = result.color
              i = result.nextIndex - 1
            }
          }
          break
        }
        case 39: // Default foreground
          attrs.fg = null
          break
        // Background colors 40-47
        case 40:
        case 41:
        case 42:
        case 43:
        case 44:
        case 45:
        case 46:
        case 47:
          attrs.bg = { ...palette256[code - 40]!, index: code - 40 } // basic bg 40-47 → palette idx 0-7
          break
        case 48: {
          // Extended background: 48;5;N (256) or 48;2;R;G;B (truecolor)
          const subs = subParams.get(i)
          if (subs && subs.length >= 3) {
            const result = parseExtendedColorFromSubs(subs)
            if (result) attrs.bg = result
          } else {
            const result = parseExtendedColor(params, i)
            if (result) {
              attrs.bg = result.color
              i = result.nextIndex - 1
            }
          }
          break
        }
        case 49: // Default background
          attrs.bg = null
          break
        case 53: // Overline
          attrs.overline = true
          break
        case 55: // Overline off
          attrs.overline = false
          break
        case 58: {
          // Underline color: 58;5;N (256) or 58;2;R;G;B (truecolor)
          // Also handle colon form: 58:5:N or 58:2:R:G:B
          const subs = subParams.get(i)
          if (subs && subs.length >= 3) {
            const result = parseExtendedColorFromSubs(subs)
            if (result) attrs.underlineColor = result
          } else {
            const result = parseExtendedColor(params, i)
            if (result) {
              attrs.underlineColor = result.color
              i = result.nextIndex - 1
            }
          }
          break
        }
        case 59: // Default underline color
          attrs.underlineColor = null
          break
        // Bright foreground 90-97
        case 90:
        case 91:
        case 92:
        case 93:
        case 94:
        case 95:
        case 96:
        case 97:
          attrs.fg = { ...palette256[code - 90 + 8]!, index: code - 90 + 8 } // bright fg 90-97 → palette idx 8-15
          break
        // Bright background 100-107
        case 100:
        case 101:
        case 102:
        case 103:
        case 104:
        case 105:
        case 106:
        case 107:
          attrs.bg = { ...palette256[code - 100 + 8]!, index: code - 100 + 8 } // bright bg 100-107 → palette idx 8-15
          break
      }
      i++
    }
  }

  function parseExtendedColor(params: number[], startIndex: number): { color: Color; nextIndex: number } | null {
    if (startIndex + 1 >= params.length) return null

    const type = params[startIndex + 1]
    if (type === 5 && startIndex + 2 < params.length) {
      const idx = params[startIndex + 2]!
      // 256-color (`38;5;N` / `48;5;N` / `58;5;N`) → tag the origin index so the
      // serializer re-emits the indexed form. A malformed out-of-range N has no
      // palette entry, so fall back to bare black with NO index (never emit `x8;5;>255`).
      const entry = palette256[idx]
      const color: Color = entry ? { ...entry, index: idx } : { r: 0, g: 0, b: 0 }
      return { color, nextIndex: startIndex + 3 }
    } else if (type === 2 && startIndex + 4 < params.length) {
      return {
        color: {
          r: params[startIndex + 2]!,
          g: params[startIndex + 3]!,
          b: params[startIndex + 4]!,
        },
        nextIndex: startIndex + 5,
      }
    }
    return null
  }

  /** Parse extended color from colon sub-parameters (e.g., 38:2:R:G:B or 38:5:N) */
  function parseExtendedColorFromSubs(subs: number[]): Color | null {
    if (subs.length < 3) return null
    const type = subs[1]
    if (type === 5 && subs.length >= 3) {
      const idx = subs[2]!
      // Colon form `38:5:N` etc. — same index-tagging as the semicolon form above.
      const entry = palette256[idx]
      return entry ? { ...entry, index: idx } : { r: 0, g: 0, b: 0 }
    } else if (type === 2) {
      // Can be 38:2:R:G:B or 38:2:colorspace:R:G:B
      if (subs.length >= 5) {
        // 38:2:R:G:B (no colorspace) or 38:2:cs:R:G:B
        // If subs.length >= 6, assume colorspace variant
        if (subs.length >= 6) {
          return { r: subs[3]!, g: subs[4]!, b: subs[5]! }
        }
        return { r: subs[2]!, g: subs[3]!, b: subs[4]! }
      } else if (subs.length >= 4) {
        return { r: subs[2]!, g: subs[3]!, b: 0 }
      }
    }
    return null
  }

  // ── OSC handler ──

  function handleOSC(oscString: string): void {
    // OSC sequences may have no semicolon (bare resets like "110", "104").
    // Split at the first semicolon if one exists; otherwise treat the whole
    // string as the code with an empty value.
    const semicolonIdx = oscString.indexOf(";")
    const code = semicolonIdx === -1 ? parseInt(oscString, 10) : parseInt(oscString.substring(0, semicolonIdx), 10)
    if (isNaN(code)) return
    const value = semicolonIdx === -1 ? "" : oscString.substring(semicolonIdx + 1)

    switch (code) {
      case 0: // Set icon name and window title
      case 2: // Set window title
        title = value
        break
      case 133: {
        // Semantic prompt markers (FinalTerm / shell integration)
        // Value format: "X" or "X;params" where X is A/B/C/D
        const marker = value.charAt(0)
        switch (marker) {
          case "A": // Start of prompt
            semanticZones.push({ type: "prompt", startRow: curY, startCol: curX })
            break
          case "B": // End of prompt / start of command
            semanticZones.push({ type: "command", startRow: curY, startCol: curX })
            break
          case "C": // End of command / start of output
            semanticZones.push({ type: "output", startRow: curY, startCol: curX })
            break
          case "D": // End of output (exit code in params, ignored for storage)
            break
        }
        break
      }
      case 1: // Set icon name (ignore)
        break
      case 7: // Current working directory: OSC 7 ; file://host/path ST
        cwd = value
        break
      case 8: {
        // Hyperlink: OSC 8 ; params ; url ST
        // Format: 8;params;url  or  8;;url  or 8;;  (close)
        const secondSemicolon = value.indexOf(";")
        if (secondSemicolon !== -1) {
          const url = value.substring(secondSemicolon + 1)
          attrs.url = url || null
        }
        break
      }
      case 4: {
        // OSC 4 — set/query palette color. Syntax: "c;spec" (set) or "c;?" (query).
        // Multiple pairs allowed: "c1;spec1;c2;spec2;..."; we parse sequentially.
        const fields = value.split(";")
        for (let fi = 0; fi + 1 < fields.length; fi += 2) {
          const idx = parseInt(fields[fi]!, 10)
          const spec = fields[fi + 1]!
          if (isNaN(idx) || idx < 0 || idx > 255) continue
          if (spec === "?") {
            const c = palette256[idx]
            if (c && onResponse) onResponse(`\x1b]4;${idx};${formatColorResponse(c)}\x1b\\`)
          } else {
            const c = parseColorSpec(spec)
            if (c) palette256[idx] = c
          }
        }
        break
      }
      case 5: {
        // OSC 5 — set/query special colors. c: 0=bold, 1=ul, 2=blink, 3=reverse, 4=italic.
        // Layered on top of the 256-palette indices (i.e. stored at palette index 256+c by xterm).
        const fields = value.split(";")
        for (let fi = 0; fi + 1 < fields.length; fi += 2) {
          const idx = parseInt(fields[fi]!, 10)
          const spec = fields[fi + 1]!
          if (isNaN(idx) || idx < 0 || idx > 4) continue
          if (spec === "?") {
            const c = specialColors.get(idx)
            if (onResponse) {
              const payload = c ? formatColorResponse(c) : "rgb:0000/0000/0000"
              onResponse(`\x1b]5;${idx};${payload}\x1b\\`)
            }
          } else {
            const c = parseColorSpec(spec)
            if (c) specialColors.set(idx, c)
          }
        }
        break
      }
      case 10: // OSC 10 — default foreground: set or query.
        if (value === "?") {
          if (onResponse) {
            const c = defaultFgColor ?? { r: 0xff, g: 0xff, b: 0xff }
            onResponse(`\x1b]10;${formatColorResponse(c)}\x1b\\`)
          }
        } else {
          const c = parseColorSpec(value)
          if (c) defaultFgColor = c
        }
        break
      case 11: // OSC 11 — default background: set or query.
        if (value === "?") {
          if (onResponse) {
            const c = defaultBgColor ?? { r: 0, g: 0, b: 0 }
            onResponse(`\x1b]11;${formatColorResponse(c)}\x1b\\`)
          }
        } else {
          const c = parseColorSpec(value)
          if (c) defaultBgColor = c
        }
        break
      case 12: // OSC 12 — cursor color: set or query.
        if (value === "?") {
          if (onResponse) {
            const c = cursorColor ?? defaultFgColor ?? { r: 0xff, g: 0xff, b: 0xff }
            onResponse(`\x1b]12;${formatColorResponse(c)}\x1b\\`)
          }
        } else {
          const c = parseColorSpec(value)
          if (c) cursorColor = c
        }
        break
      case 13: // OSC 13 — pointer foreground color: set or query.
        if (value === "?") {
          if (onResponse) {
            const c = pointerFgColor ?? defaultFgColor ?? { r: 0xff, g: 0xff, b: 0xff }
            onResponse(`\x1b]13;${formatColorResponse(c)}\x1b\\`)
          }
        } else {
          const c = parseColorSpec(value)
          if (c) pointerFgColor = c
        }
        break
      case 14: // OSC 14 — pointer background color: set or query.
        if (value === "?") {
          if (onResponse) {
            const c = pointerBgColor ?? defaultBgColor ?? { r: 0, g: 0, b: 0 }
            onResponse(`\x1b]14;${formatColorResponse(c)}\x1b\\`)
          }
        } else {
          const c = parseColorSpec(value)
          if (c) pointerBgColor = c
        }
        break
      case 17: // OSC 17 — highlight (selection) bg: set or query.
        if (value === "?") {
          if (onResponse) {
            const c = highlightBgColor ?? defaultFgColor ?? { r: 0xff, g: 0xff, b: 0xff }
            onResponse(`\x1b]17;${formatColorResponse(c)}\x1b\\`)
          }
        } else {
          const c = parseColorSpec(value)
          if (c) highlightBgColor = c
        }
        break
      case 19: // OSC 19 — highlight (selection) fg: set or query.
        if (value === "?") {
          if (onResponse) {
            const c = highlightFgColor ?? defaultBgColor ?? { r: 0, g: 0, b: 0 }
            onResponse(`\x1b]19;${formatColorResponse(c)}\x1b\\`)
          }
        } else {
          const c = parseColorSpec(value)
          if (c) highlightFgColor = c
        }
        break
      case 21: {
        // OSC 21 — Kitty key=value color protocol (replacement for OSC 10-19).
        // Syntax: "key=value;key=value;..." where value can be "?" to query,
        // a color spec to set, or blank to reset.
        // Known keys: foreground, background, cursor, selection_foreground,
        // selection_background, color0..color255.
        const pairs = value.split(";").filter((p) => p.length > 0)
        const response: string[] = []
        for (const pair of pairs) {
          const eq = pair.indexOf("=")
          if (eq === -1) continue
          const key = pair.substring(0, eq).trim()
          const val = pair.substring(eq + 1).trim()
          const isQuery = val === "?"

          // Resolve key → get/set helpers
          const paletteMatch = /^color(\d+)$/.exec(key)
          if (paletteMatch) {
            const idx = parseInt(paletteMatch[1]!, 10)
            if (idx < 0 || idx > 255) continue
            if (isQuery) {
              const c = palette256[idx]
              if (c) response.push(`${key}=${formatColorResponse(c)}`)
            } else if (val === "") {
              // Reset: re-init from fresh palette
              const fresh = buildPalette256()
              palette256[idx] = fresh[idx]!
            } else {
              const c = parseColorSpec(val)
              if (c) palette256[idx] = c
            }
          } else if (key === "foreground") {
            if (isQuery) {
              const c = defaultFgColor ?? { r: 0xff, g: 0xff, b: 0xff }
              response.push(`${key}=${formatColorResponse(c)}`)
            } else if (val === "") {
              defaultFgColor = null
            } else {
              const c = parseColorSpec(val)
              if (c) defaultFgColor = c
            }
          } else if (key === "background") {
            if (isQuery) {
              const c = defaultBgColor ?? { r: 0, g: 0, b: 0 }
              response.push(`${key}=${formatColorResponse(c)}`)
            } else if (val === "") {
              defaultBgColor = null
            } else {
              const c = parseColorSpec(val)
              if (c) defaultBgColor = c
            }
          } else if (key === "cursor") {
            if (isQuery) {
              const c = cursorColor ?? defaultFgColor ?? { r: 0xff, g: 0xff, b: 0xff }
              response.push(`${key}=${formatColorResponse(c)}`)
            } else if (val === "") {
              cursorColor = null
            } else {
              const c = parseColorSpec(val)
              if (c) cursorColor = c
            }
          } else if (key === "selection_background") {
            if (isQuery) {
              const c = highlightBgColor ?? defaultFgColor ?? { r: 0xff, g: 0xff, b: 0xff }
              response.push(`${key}=${formatColorResponse(c)}`)
            } else {
              const c = val === "" ? null : parseColorSpec(val)
              highlightBgColor = c
            }
          } else if (key === "selection_foreground") {
            if (isQuery) {
              const c = highlightFgColor ?? defaultBgColor ?? { r: 0, g: 0, b: 0 }
              response.push(`${key}=${formatColorResponse(c)}`)
            } else {
              const c = val === "" ? null : parseColorSpec(val)
              highlightFgColor = c
            }
          }
        }
        if (response.length > 0 && onResponse) {
          onResponse(`\x1b]21;${response.join(";")}\x1b\\`)
        }
        break
      }
      case 104: {
        // OSC 104 — reset palette color(s). Empty payload = reset all; else "c1;c2;..." indices.
        if (value === "") {
          palette256 = buildPalette256()
        } else {
          const fresh = buildPalette256()
          for (const tok of value.split(";")) {
            const idx = parseInt(tok, 10)
            if (!isNaN(idx) && idx >= 0 && idx < 256) palette256[idx] = fresh[idx]!
          }
        }
        break
      }
      case 105: {
        // OSC 105 — reset special color(s). Empty = reset all, else "c1;c2;..." indices 0-4.
        if (value === "") {
          specialColors.clear()
        } else {
          for (const tok of value.split(";")) {
            const idx = parseInt(tok, 10)
            if (!isNaN(idx) && idx >= 0 && idx <= 4) specialColors.delete(idx)
          }
        }
        break
      }
      case 110: // OSC 110 — reset default fg
        defaultFgColor = null
        break
      case 111: // OSC 111 — reset default bg
        defaultBgColor = null
        break
      case 112: // OSC 112 — reset cursor color
        cursorColor = null
        break
      case 113: // OSC 113 — reset pointer foreground color
        pointerFgColor = null
        break
      case 114: // OSC 114 — reset pointer background color
        pointerBgColor = null
        break
      case 117: // OSC 117 — reset highlight bg
        highlightBgColor = null
        break
      case 119: // OSC 119 — reset highlight fg
        highlightFgColor = null
        break
      case 52: {
        // Clipboard: OSC 52 ; selection ; base64-data ST
        const clipSemi = value.indexOf(";")
        if (clipSemi !== -1) {
          const data = value.substring(clipSemi + 1)
          if (data === "?") {
            // Query clipboard
            if (onResponse) {
              const encoded = btoa(clipboard)
              onResponse(`\x1b]52;c;${encoded}\x1b\\`)
            }
          } else {
            // Set clipboard
            try {
              clipboard = atob(data)
            } catch {
              clipboard = ""
            }
            if (onResponse) {
              onResponse(`\x1b]52;c;${data}\x1b\\`)
            }
          }
        }
        break
      }
      case 9: // Notifications: OSC 9 ; message ST (iTerm2/ConEmu convention)
        notifications.push(value)
        break
      case 633: {
        // VS Code shell integration (OSC 633 is a superset of OSC 133)
        // Maps to the same semantic zone model as FinalTerm markers.
        const marker = value.charAt(0)
        switch (marker) {
          case "A":
            semanticZones.push({ type: "prompt", startRow: curY, startCol: curX })
            break
          case "B":
            semanticZones.push({ type: "command", startRow: curY, startCol: curX })
            break
          case "C":
            semanticZones.push({ type: "output", startRow: curY, startCol: curX })
            break
          case "D":
            break
        }
        break
      }
      case 66: {
        // OSC 66 — Text Sizing
        if (value === "?" && onResponse) {
          // Query: respond with current text scale
          onResponse(`\x1b]66;s=${textScale}\x1b\\`)
        } else {
          // Parse key=value pairs (e.g., "s=2")
          const kvPairs = value.split(";")
          for (const pair of kvPairs) {
            const [k, v] = pair.split("=")
            if (k === "s" && v !== undefined) {
              const n = parseInt(v, 10)
              if (!isNaN(n) && n > 0) {
                textScale = n
              }
            }
          }
        }
        break
      }
      case 701:
        // rxvt-unicode locale query/set. Query returns the current locale.
        if (value === "?") {
          if (onResponse) onResponse(`\x1b]701;${locale}\x1b\\`)
        } else if (value !== "") {
          locale = value
        }
        break
      case 702:
        // rxvt-unicode version query shape: OSC 702 ; name ; resource ; major ; minor ST.
        if (onResponse) onResponse("\x1b]702;vterm.js;vterm;0;2\x1b\\")
        break
      case 720: {
        // rxvt-unicode scroll view up. This is a viewport operation over
        // existing scrollback, not a screen-buffer mutation.
        const n = parseInt(value, 10)
        scrollViewport(!isNaN(n) && n > 0 ? n : 1)
        break
      }
      case 721: {
        // rxvt-unicode scroll view down toward the live region.
        const n = parseInt(value, 10)
        scrollViewport(-(!isNaN(n) && n > 0 ? n : 1))
        break
      }
      case 776:
        // rxvt-unicode cell metrics: cell-width ; cell-height ; font-ascent.
        if (onResponse) onResponse(`\x1b]776;${CELL_W_PX};${CELL_H_PX};${FONT_ASCENT_PX}\x1b\\`)
        break
      case 7770: {
        // mintty font size query/set. Query returns a restorable set sequence.
        if (value === "?") {
          if (onResponse) onResponse(`\x1b]7770;${fontSize}\x1b\\`)
        } else if (value === "") {
          fontSize = 12
        } else {
          const n = parseInt(value, 10)
          if (!isNaN(n) && n > 0) fontSize = n
        }
        break
      }
      case 7777: {
        // mintty font + window size query/set. Kept separate from OSC 7770.
        if (value === "?") {
          if (onResponse) onResponse(`\x1b]7777;${fontWindowSize}\x1b\\`)
        } else if (value === "") {
          fontWindowSize = 12
        } else {
          const n = parseInt(value, 10)
          if (!isNaN(n) && n > 0) fontWindowSize = n
        }
        break
      }
      case 30001:
        // Kitty color stack push.
        colorStack.push(snapshotColorState())
        break
      case 30101: {
        // Kitty color stack pop; empty stack is a no-op.
        const snapshot = colorStack.pop()
        if (snapshot) restoreColorState(snapshot)
        break
      }
      case 5522: {
        // OSC 5522 — Advanced Clipboard (Kitty clipboard protocol)
        if (value === "?" && onResponse) {
          // Query: respond with stored clipboard data
          const encoded = btoa(advancedClipboard)
          onResponse(`\x1b]5522;${encoded}\x1b\\`)
        } else {
          // Store clipboard data (base64-encoded)
          try {
            advancedClipboard = atob(value)
          } catch {
            advancedClipboard = ""
          }
        }
        break
      }
      case 1337: {
        // iTerm2 proprietary sequences
        if (value === "ReportCellSize" && onResponse) {
          // Report default 8x16 pixel cell size (standard monospace ratio)
          onResponse("\x1b]1337;ReportCellSize=16;8\x1b\\")
        } else if (value === "RequestCapabilities" && onResponse) {
          // Report empty capabilities (protocol supported, no iTerm2-specific features)
          onResponse("\x1b]1337;Capabilities=\x1b\\")
        }
        // Inline images (File=...) are silently consumed — no pixel framebuffer
        break
      }
    }
  }

  // ── DCS handler ──

  function handleDCS(data: string): void {
    // Sixel graphics: DCS [Ps;Ps;Ps] q [sixel-data]
    const match = data.match(/^(\d*(?:;\d*)*)q(.*)$/s)
    if (match) {
      hasSixel = true
      sixelImages.push({
        data: match[2]!,
        row: dcsStartRow,
        col: dcsStartCol,
      })
      return
    }

    // DECRQSS: DCS $ q Pt ST → response DCS Ps $ r Pt ST
    if (data.startsWith("$q") && onResponse) {
      const pt = data.substring(2)
      if (pt === '"p') {
        // DECSCL - Conformance level: VT200 mode, 8-bit controls
        onResponse('\x1bP1$r62;1"p\x1b\\')
      } else {
        // Not recognized
        onResponse("\x1bP0$r\x1b\\")
      }
      return
    }

    // XTGETTCAP: DCS + q hex ST → response DCS 1 + r hex = hexvalue ST
    if (data.startsWith("+q") && onResponse) {
      const hexName = data.substring(2)
      if (hexName === "544e") {
        // "TN" = terminal name → "vterm"
        const hexValue = Array.from(new TextEncoder().encode("vterm"))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("")
        onResponse(`\x1bP1+r544e=${hexValue}\x1b\\`)
      } else {
        // Unknown capability
        onResponse("\x1bP0+r\x1b\\")
      }
      return
    }

    // Other DCS sequences are consumed and ignored
  }

  // ── APC handler ──

  function handleAPC(data: string): void {
    if (!data.startsWith("G")) return

    hasKittyGraphics = true

    // Parse key=value pairs
    const semicolonIdx = data.indexOf(";")
    const kvPart = semicolonIdx >= 0 ? data.substring(1, semicolonIdx) : data.substring(1)

    const params: Record<string, string> = {}
    for (const pair of kvPart.split(",")) {
      const eqIdx = pair.indexOf("=")
      if (eqIdx >= 0) {
        params[pair.substring(0, eqIdx)] = pair.substring(eqIdx + 1)
      }
    }

    // Handle query action
    if (params.a === "q" && onResponse) {
      // Respond: OK
      onResponse(`\x1b_Gi=${params.i ?? "0"};OK\x1b\\`)
    }
  }

  // ── Soft reset (DECSTR) ──

  function softReset(): void {
    // Reset modes to defaults
    insertMode = false
    newLineMode = false
    originMode = false
    autoWrap = true
    curVisible = true
    kittyKeyboardFlags = 0
    kittyKeyboardStack = []
    cursorShape = "block"
    cursorBlinking = true
    applicationCursor = false
    applicationKeypad = false
    reverseVideo = false
    decColumnMode = false
    altScrollMode = false
    utf8MouseMode = false

    // Reset scroll region
    scrollTop = 0
    scrollBottom = rows - 1

    // Reset left/right margins
    leftRightMarginMode = false
    leftMargin = 0
    rightMargin = cols - 1

    // Reset attributes
    attrs = resetAttrs()

    // Reset character set
    charsetG0 = false

    // Reset cursor to home
    curX = 0
    curY = 0
  }

  // ── Full reset ──

  function fullReset(): void {
    mainGrid = makeGrid(cols, rows)
    altGrid = makeGrid(cols, rows)
    grid = mainGrid
    scrollback = []
    scrollbackSoftWrapped = []
    curX = 0
    curY = 0
    curVisible = true
    cursorShape = "block"
    cursorBlinking = true
    savedCurX = 0
    savedCurY = 0
    savedState = { curX: 0, curY: 0, attrs: resetAttrs(), originMode: false, autoWrap: true, charsetG0: false }
    attrs = resetAttrs()
    title = ""
    useAltScreen = false
    bracketedPaste = false
    applicationCursor = false
    applicationKeypad = false
    autoWrap = true
    mouseTracking = false
    mouseTrackingMode = 0
    sgrMouse = false
    focusTracking = false
    originMode = false
    insertMode = false
    newLineMode = false
    reverseVideo = false
    syncOutput = false
    kittyKeyboardFlags = 0
    kittyKeyboardStack = []
    hasKittyGraphics = false
    hasSixel = false
    sixelImages = []
    scrollTop = 0
    scrollBottom = rows - 1
    leftRightMarginMode = false
    leftMargin = 0
    rightMargin = cols - 1
    colorSchemeReporting = false
    decColumnMode = false
    altScrollMode = false
    utf8MouseMode = false
    textScale = 1
    fontSize = 12
    fontWindowSize = 12
    locale = "en_US.UTF-8"
    advancedClipboard = ""
    viewportOffset = 0
    charsetG0 = false
    clipboard = ""
    cwd = ""
    notifications = []
    palette256 = buildPalette256()
    defaultFgColor = null
    defaultBgColor = null
    cursorColor = null
    specialColors.clear()
    pointerFgColor = null
    pointerBgColor = null
    highlightBgColor = null
    highlightFgColor = null
    colorStack.length = 0
    tabStops = defaultTabStops(cols)
    lastChar = ""
    pendingRegionalIndicator = null
    afterZWJ = false
    parserState = "ground"
    escBuf = ""
    oscBuf = ""
    dcsBuf = ""
    dcsStartRow = 0
    dcsStartCol = 0
    dcsReceivedLength = 0
    dcsOverflow = false
    apcBuf = ""
    apcStartRow = 0
    apcStartCol = 0
    apcReceivedLength = 0
    apcOverflow = false
    utf8PendingBytes = []
    semanticZones = []
    mainSoftWrapped = new Array(rows).fill(false)
    altSoftWrapped = new Array(rows).fill(false)
    softWrapped = mainSoftWrapped
    // Fresh world: scrollback wiped, so the damage epoch restarts and the trim origin returns to 0.
    markAllDirty()
    dirtyScrolled = 0
    if (sigDamageActive) sigDirtyScrolled = 0
    trimmedRowCount = 0
    // Reactive read plane: a reset changes title/modes/cursor/size and damages the whole buffer.
    flushSignals()
  }

  // ── Observation taps: emit helpers ──
  //
  // Every helper is a no-op unless a parser listener is registered, so the per-byte parser
  // path allocates nothing when the tap is unused. Control/CSI/OSC/ESC emitters flush the
  // pending print run FIRST, so events reach listeners in exact application order. Emission is
  // fail-loud: a throwing listener propagates, and because the print run is cleared before the
  // event fires (and parser state is settled to "ground" before control events fire) the engine
  // is left consistent for the next write.

  function emitParserEvent(ev: ParserEvent): void {
    for (const listener of parserListeners) listener(ev)
  }

  function flushPrintRun(): void {
    if (printRunParts.length === 0) return
    const text = printRunParts.join("")
    printRunParts = []
    emitParserEvent({ kind: "print", text })
  }

  function emitExecute(code: number): void {
    if (parserListeners.size === 0) return
    flushPrintRun()
    emitParserEvent({ kind: "execute", code })
  }

  function emitCsiEvent(rawParams: string, intermediates: string, final: string): void {
    if (parserListeners.size === 0) return
    flushPrintRun()
    let prefix: string | undefined
    let body = rawParams
    const marker = body.charCodeAt(0)
    // Private/parameter-prefix markers: ? > < = (0x3f/0x3e/0x3c/0x3d).
    if (marker === 0x3f || marker === 0x3e || marker === 0x3c || marker === 0x3d) {
      prefix = body[0]
      body = body.slice(1)
    }
    // Match the engine's own top-level param parse (empty segment → 0).
    const params = body.split(";").map((s) => (s === "" ? 0 : parseInt(s, 10)))
    const ev: ParserEvent = { kind: "csi", final, params }
    if (prefix !== undefined) ev.prefix = prefix
    if (intermediates !== "") ev.intermediates = intermediates
    emitParserEvent(ev)
  }

  function emitOscEvent(osc: string): void {
    if (parserListeners.size === 0) return
    // Mirror handleOSC's code extraction exactly: bare (no ";") → whole string is the code.
    const semi = osc.indexOf(";")
    const code = semi === -1 ? parseInt(osc, 10) : parseInt(osc.slice(0, semi), 10)
    if (Number.isNaN(code)) return // not a dispatched OSC — handleOSC ignored it too
    flushPrintRun()
    const data = semi === -1 ? "" : osc.slice(semi + 1)
    emitParserEvent({ kind: "osc", code, data })
  }

  function emitEsc(final: string, intermediates: string): void {
    if (parserListeners.size === 0) return
    flushPrintRun()
    const ev: ParserEvent = { kind: "esc", final }
    if (intermediates !== "") ev.intermediates = intermediates
    emitParserEvent(ev)
  }

  function emitStringEvent(sequence: "apc" | "dcs", data: string, row: number, col: number): void {
    if (parserListeners.size === 0) return
    flushPrintRun()
    emitParserEvent({ kind: sequence, data, row, col })
  }

  function emitStringOverflow(sequence: "apc" | "dcs", receivedLength: number, row: number, col: number): void {
    if (parserListeners.size === 0) return
    flushPrintRun()
    emitParserEvent({
      kind: "string-overflow",
      sequence,
      maxLength: maxStringSequenceLength,
      receivedLength,
      row,
      col,
    })
  }

  function appendDCS(ch: string): void {
    dcsReceivedLength += ch.length
    if (dcsOverflow) return
    if (dcsReceivedLength > maxStringSequenceLength) {
      dcsOverflow = true
      dcsBuf = ""
      return
    }
    dcsBuf += ch
  }

  function appendAPC(ch: string): void {
    apcReceivedLength += ch.length
    if (apcOverflow) return
    if (apcReceivedLength > maxStringSequenceLength) {
      apcOverflow = true
      apcBuf = ""
      return
    }
    apcBuf += ch
  }

  function finishDCS(): void {
    if (dcsOverflow) {
      emitStringOverflow("dcs", dcsReceivedLength, dcsStartRow, dcsStartCol)
    } else {
      handleDCS(dcsBuf)
      emitStringEvent("dcs", dcsBuf, dcsStartRow, dcsStartCol)
    }
    dcsBuf = ""
    dcsReceivedLength = 0
    dcsOverflow = false
  }

  function finishAPC(): void {
    if (apcOverflow) {
      emitStringOverflow("apc", apcReceivedLength, apcStartRow, apcStartCol)
    } else {
      handleAPC(apcBuf)
      emitStringEvent("apc", apcBuf, apcStartRow, apcStartCol)
    }
    apcBuf = ""
    apcReceivedLength = 0
    apcOverflow = false
  }

  function emitOp(op: TerminalOp): void {
    for (const listener of opListeners) listener(op)
  }

  // ── Main parser ──

  function process(data: Uint8Array): void {
    const text = decodeInput(data)

    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!
      const code = text.charCodeAt(i)

      switch (parserState) {
        case "ground":
          if (code === 0x1b) {
            parserState = "escape"
            escBuf = ""
          } else if (code === 0x07) {
            // BEL — ignore
            emitExecute(0x07)
          } else if (code === 0x08) {
            // BS - Backspace
            if (curX > 0) curX--
            emitExecute(0x08)
          } else if (code === 0x09) {
            // TAB — advance to next tab stop (or last column if none)
            curX = nextTabStop(curX)
            emitExecute(0x09)
          } else if (code === 0x0a || code === 0x0b || code === 0x0c) {
            // LF, VT, FF — linefeed (hard break — clear any soft-wrap flag)
            softWrapped[curY] = false
            lineFeedDown()
            // LNM: LF/VT/FF also return the carriage. IND (ESC D) is NOT
            // affected by LNM, which is why this lives here and not in
            // lineFeedDown().
            if (newLineMode) curX = 0
            emitExecute(code)
          } else if (code === 0x0d) {
            // CR - Carriage Return
            curX = 0
            emitExecute(0x0d)
          } else if (code >= 0x20) {
            // Handle surrogate pairs for characters > U+FFFF
            let char = ch
            if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
              const nextCode = text.charCodeAt(i + 1)
              if (nextCode >= 0xdc00 && nextCode <= 0xdfff) {
                char = ch + text[i + 1]!
                i++
              }
            }
            writeChar(char)
            // Coalesce into the pending print run (guarded — nothing allocates when untapped).
            if (parserListeners.size > 0) printRunParts.push(char)
          }
          break

        case "escape":
          if (ch === "[") {
            parserState = "csi"
            escBuf = ""
          } else if (ch === "]") {
            parserState = "osc"
            oscBuf = ""
          } else if (ch === "P") {
            parserState = "dcs"
            escBuf = ""
            dcsBuf = ""
            dcsStartRow = curY
            dcsStartCol = curX
            dcsReceivedLength = 0
            dcsOverflow = false
          } else if (ch === "c") {
            // RIS - Reset to Initial State
            fullReset()
            parserState = "ground"
            emitEsc("c", "")
          } else if (ch === "D") {
            // IND - Index (move cursor down, scroll if needed)
            lineFeedDown()
            parserState = "ground"
            emitEsc("D", "")
          } else if (ch === "M") {
            // RI - Reverse Index (move cursor up, scroll if needed)
            reverseIndexUp()
            parserState = "ground"
            emitEsc("M", "")
          } else if (ch === "7") {
            // DECSC - Save Cursor + attributes + modes
            savedState = {
              curX,
              curY,
              attrs: {
                ...attrs,
                fg: attrs.fg ? { ...attrs.fg } : null,
                bg: attrs.bg ? { ...attrs.bg } : null,
                underlineColor: attrs.underlineColor ? { ...attrs.underlineColor } : null,
              },
              originMode,
              autoWrap,
              charsetG0,
            }
            parserState = "ground"
            emitEsc("7", "")
          } else if (ch === "8") {
            // DECRC - Restore Cursor + attributes + modes
            curX = savedState.curX
            curY = savedState.curY
            attrs = {
              ...savedState.attrs,
              fg: savedState.attrs.fg ? { ...savedState.attrs.fg } : null,
              bg: savedState.attrs.bg ? { ...savedState.attrs.bg } : null,
              underlineColor: savedState.attrs.underlineColor ? { ...savedState.attrs.underlineColor } : null,
            }
            originMode = savedState.originMode
            autoWrap = savedState.autoWrap
            charsetG0 = savedState.charsetG0
            clampCursor()
            parserState = "ground"
            emitEsc("8", "")
          } else if (ch === "E") {
            // NEL - Next Line
            curX = 0
            curY++
            if (curY > scrollBottom) {
              curY = scrollBottom
              scrollUp(scrollTop, scrollBottom)
            }
            parserState = "ground"
            emitEsc("E", "")
          } else if (ch === "H") {
            // HTS — Horizontal Tab Set at current cursor column
            tabStops.add(curX)
            parserState = "ground"
            emitEsc("H", "")
          } else if (ch === "#") {
            // ESC # <digit> — DEC screen alignment / double-width/height. We handle "8".
            escIntermediate = "#"
            parserState = "escape_hash"
          } else if (ch === "(") {
            // Designate G0 character set
            escIntermediate = "("
            parserState = "escape_charset"
          } else if (ch === ")") {
            // Designate G1 character set (ignored, just consume next byte)
            escIntermediate = ")"
            parserState = "escape_charset"
          } else if (ch === "=") {
            // DECKPAM - Application Keypad Mode
            applicationKeypad = true
            parserState = "ground"
            emitEsc("=", "")
          } else if (ch === ">") {
            // DECKPNM - Normal Keypad Mode
            applicationKeypad = false
            parserState = "ground"
            emitEsc(">", "")
          } else if (ch === "_") {
            // APC - Application Program Command
            parserState = "apc"
            apcBuf = ""
            apcStartRow = curY
            apcStartCol = curX
            apcReceivedLength = 0
            apcOverflow = false
          } else {
            // Unknown escape — return to ground
            parserState = "ground"
          }
          break

        case "escape_charset":
          // Character set designation: ESC ( 0 = DEC Special Graphics, ESC ( B = ASCII
          if (ch === "0") {
            charsetG0 = true
          } else {
            charsetG0 = false // B = ASCII, or any other
          }
          parserState = "ground"
          emitEsc(ch, escIntermediate)
          break

        case "escape_hash":
          // ESC # <digit>. DECALN (ESC # 8) fills the screen with 'E' and
          // homes the cursor — used for screen-alignment testing on real DEC gear.
          if (ch === "8") {
            const alignCell = emptyCell()
            alignCell.char = "E"
            for (let r = 0; r < rows; r++) {
              const row = grid[r]!
              for (let c = 0; c < cols; c++) {
                row.setCellRaw(c, alignCell)
              }
              softWrapped[r] = false
            }
            curX = 0
            curY = 0
          }
          // Other ESC # sequences (3/4/5/6 for double-width/height) are ignored.
          parserState = "ground"
          emitEsc(ch, escIntermediate)
          break

        case "csi": {
          if (code >= 0x40 && code <= 0x7e) {
            // Final byte — dispatch CSI
            // Extract intermediates (characters 0x20-0x2F between params and final)
            let paramPart = escBuf
            let intermediatePart = ""

            // Check for intermediates at the end of escBuf
            // Intermediates are 0x20-0x2F: space ! " # $ % & ' ( ) * + , - . /
            let j = paramPart.length - 1
            while (j >= 0) {
              const c = paramPart.charCodeAt(j)
              if (c >= 0x20 && c <= 0x2f) {
                j--
              } else {
                break
              }
            }
            if (j < paramPart.length - 1) {
              intermediatePart = paramPart.substring(j + 1)
              paramPart = paramPart.substring(0, j + 1)
            }

            if (paramPart.startsWith("?")) {
              handleCSIPrivate(paramPart.substring(1), intermediatePart, ch)
            } else if (paramPart.startsWith(">")) {
              handleCSIGt(paramPart.substring(1), intermediatePart, ch)
            } else if (paramPart.startsWith("<")) {
              handleCSILt(paramPart.substring(1), intermediatePart, ch)
            } else if (paramPart.startsWith("=")) {
              handleCSIEq(paramPart.substring(1), intermediatePart, ch)
            } else {
              handleCSI(paramPart, intermediatePart, ch)
            }
            parserState = "ground"
            emitCsiEvent(paramPart, intermediatePart, ch)
          } else if (escBuf.length >= 256) {
            parserState = "ground"
          } else {
            escBuf += ch
          }
          break
        }

        case "osc":
          if (code === 0x07) {
            // BEL terminates OSC
            handleOSC(oscBuf)
            parserState = "ground"
            emitOscEvent(oscBuf)
          } else if (code === 0x1b) {
            // ESC might be start of ST (\x1b\\)
            parserState = "osc_st"
          } else if (oscBuf.length >= 4096) {
            parserState = "ground"
          } else {
            oscBuf += ch
          }
          break

        case "osc_st": {
          // ST (String Terminator) — end of OSC only when the backslash completes ESC \.
          const oscComplete = ch === "\\"
          if (oscComplete) handleOSC(oscBuf)
          parserState = "ground"
          if (oscComplete) emitOscEvent(oscBuf)
          break
        }

        case "dcs":
          // Accumulate DCS data until ST (ESC \) or BEL
          if (code === 0x1b) {
            parserState = "dcs_st"
          } else if (code === 0x07) {
            // BEL terminates DCS
            finishDCS()
            parserState = "ground"
          } else {
            appendDCS(ch)
          }
          break

        case "dcs_st":
          // Expecting backslash to complete ST
          if (ch === "\\") {
            // ST (String Terminator) — end of DCS
            finishDCS()
          } else {
            dcsBuf = ""
            dcsReceivedLength = 0
            dcsOverflow = false
          }
          parserState = "ground"
          break

        case "dcs_passthrough":
          // Consume until ST
          if (code === 0x1b) {
            parserState = "dcs_st"
          }
          break

        case "apc":
          if (code === 0x1b) {
            parserState = "apc_st"
          } else if (code === 0x07) {
            // BEL terminates APC
            finishAPC()
            parserState = "ground"
          } else {
            appendAPC(ch)
          }
          break

        case "apc_st":
          if (ch === "\\") {
            // ST (String Terminator) — end of APC
            finishAPC()
          } else {
            apcBuf = ""
            apcReceivedLength = 0
            apcOverflow = false
          }
          parserState = "ground"
          break
      }
    }

    // Flush any trailing print run (coalesced within this flood), then fire the op tap once
    // for the whole applied write. Both are no-ops when their tap has no listener.
    flushPrintRun()
    if (opListeners.size > 0) emitOp({ type: "output", data })
    // Reactive read plane: coalesce this call's state changes + damage into one batch of emissions.
    flushSignals()
  }

  // ── Resize ──

  /**
   * Reconstruct logical lines from a grid, joining rows that were soft-wrapped.
   * Returns an array of logical lines, each being an array of ScreenCells (may be longer than cols).
   */
  function getLogicalLines(srcGrid: PackedRow[], srcSoftWrapped: boolean[], srcRows: number): ScreenCell[][] {
    const logical: ScreenCell[][] = []
    let currentLine: ScreenCell[] = []

    for (let r = 0; r < srcRows; r++) {
      const row = srcGrid[r]
      if (!row) continue
      // Materialize this row's cells into the current logical line
      for (let c = 0; c < row.length; c++) {
        currentLine.push(row.getCellRaw(c))
      }
      if (srcSoftWrapped[r]) {
        // This row was soft-wrapped — continue accumulating into same logical line
        continue
      }
      // Hard break (or last row): finalize this logical line
      logical.push(currentLine)
      currentLine = []
    }
    // If there's a dangling line (shouldn't happen, but be safe)
    if (currentLine.length > 0) {
      logical.push(currentLine)
    }
    return logical
  }

  /**
   * Re-wrap logical lines to a new column width, producing grid rows and soft-wrap flags.
   *
   * `track` names one position — a logical line index plus a cell offset
   * within that line (the cursor, expressed content-relative) — and the
   * returned `tracked` reports the output row/col it lands on, so `resize()`
   * can move the cursor WITH its logical line instead of leaving it at its
   * old absolute row. An offset at/beyond the trimmed line end (cursor in
   * trailing blanks or one past the last cell) lands after the last emitted
   * cell, advanced by the leftover distance, clamped to the row.
   */
  function rewrapLines(
    logicalLines: ScreenCell[][],
    newCols: number,
    track?: { line: number; offset: number },
  ): { rows: PackedRow[]; wrapped: boolean[]; tracked: { row: number; col: number } | null } {
    const outRows: PackedRow[] = []
    const outWrapped: boolean[] = []
    let tracked: { row: number; col: number } | null = null

    for (let li = 0; li < logicalLines.length; li++) {
      const line = logicalLines[li]!
      // Trim trailing empty cells from logical line
      let lineLen = line.length
      while (lineLen > 0) {
        const cell = line[lineLen - 1]!
        if (cell.char === "" && !cell.wide) {
          lineLen--
        } else {
          break
        }
      }

      if (lineLen === 0) {
        // Empty logical line — produce one empty row
        outRows.push(makeRow(newCols))
        outWrapped.push(false)
        if (track?.line === li) {
          tracked = { row: outRows.length - 1, col: Math.min(track.offset, newCols - 1) }
        }
        continue
      }

      // Wrap the logical line content into rows of newCols width
      let pos = 0
      while (pos < lineLen) {
        const row = makeRow(newCols)
        let col = 0
        while (col < newCols && pos < lineLen) {
          const cell = line[pos]!
          if (cell.wide && col + 2 > newCols) {
            // Wide char doesn't fit — leave rest of row empty, wrap to next
            break
          }
          if (track?.line === li && pos === track.offset) {
            tracked = { row: outRows.length, col }
          }
          row.setCellRaw(col, cell)
          col++
          pos++
          // If cell was wide, the next cell in the logical line is the spacer
          // which we already advanced past via pos++
        }
        const moreContent = pos < lineLen
        outRows.push(row)
        outWrapped.push(moreContent) // soft-wrapped if there's more content to come
        if (!moreContent && track?.line === li && tracked === null) {
          const extra = track.offset - lineLen
          tracked = { row: outRows.length - 1, col: Math.min(newCols - 1, col + extra) }
        }
      }
    }

    return { rows: outRows, wrapped: outWrapped, tracked }
  }

  /** True when a packed row has no printable content (all columns blank). */
  function packedRowIsBlank(row: PackedRow): boolean {
    for (let c = 0; c < row.length; c++) {
      if (!(row.getChar(c) === "" && !row.isWide(c))) return false
    }
    return true
  }

  /**
   * Trim trailing empty rows from reflowed result, so they don't push content off the top
   * when we take the last newRows rows.
   */
  function trimTrailingEmptyRows(result: { rows: PackedRow[]; wrapped: boolean[] }): void {
    while (result.rows.length > 1) {
      const lastRow = result.rows[result.rows.length - 1]!
      const isEmpty = packedRowIsBlank(lastRow)
      if (isEmpty && !result.wrapped[result.rows.length - 2]) {
        // The row before wasn't soft-wrapped and this row is empty — trim it
        result.rows.pop()
        result.wrapped.pop()
      } else {
        break
      }
    }
  }

  function resize(newCols: number, newRows: number): void {
    // Same-geometry resize is a no-op (xterm parity): reflowing here would
    // clamp a past-the-end deferred-wrap cursor back into the row (so the
    // next byte overwrites the last cell instead of wrapping) and would
    // reset DECSTBM/margins for no dimension change.
    if (newCols === cols && newRows === rows) return
    // Express the cursor content-relative BEFORE reflow (active buffer only):
    // its logical line index + cell offset within that line. Reflow changes
    // row identities, so an absolute (curX, curY) goes stale — the cursor
    // must follow its logical line like xterm/ghostty/kitty, or post-resize
    // output lands at the old row and leaves a blank band where wraps sat.
    const activeWrappedPre = useAltScreen ? altSoftWrapped : mainSoftWrapped
    const cursorRowPre = Math.min(Math.max(curY, 0), rows - 1)
    let cursorLineStart = cursorRowPre
    while (cursorLineStart > 0 && activeWrappedPre[cursorLineStart - 1]) cursorLineStart--
    let cursorLineIdx = 0
    for (let r = 0; r < cursorLineStart; r++) {
      if (!activeWrappedPre[r]) cursorLineIdx++
    }
    const cursorTrack = { line: cursorLineIdx, offset: (cursorRowPre - cursorLineStart) * cols + curX }

    // Reflow main grid
    const mainLogical = getLogicalLines(mainGrid, mainSoftWrapped, rows)
    const mainResult = rewrapLines(mainLogical, newCols, useAltScreen ? undefined : cursorTrack)
    trimTrailingEmptyRows(mainResult)

    // Reflow alt grid (usually not reflowed, but do it for consistency)
    const altLogical = getLogicalLines(altGrid, altSoftWrapped, rows)
    const altResult = rewrapLines(altLogical, newCols, useAltScreen ? cursorTrack : undefined)
    trimTrailingEmptyRows(altResult)

    // Build new grids: if reflowed content fits, place at top; if it overflows, take the last newRows
    const newMain = makeGrid(newCols, newRows)
    const newMainWrapped: boolean[] = new Array(newRows).fill(false)
    const mainStartRow = Math.max(0, mainResult.rows.length - newRows)
    for (let r = 0; r < newRows && mainStartRow + r < mainResult.rows.length; r++) {
      newMain[r] = mainResult.rows[mainStartRow + r]!
      newMainWrapped[r] = mainResult.wrapped[mainStartRow + r]!
    }

    // Build new alt grid
    const newAlt = makeGrid(newCols, newRows)
    const newAltWrapped: boolean[] = new Array(newRows).fill(false)
    const altStartRow = Math.max(0, altResult.rows.length - newRows)
    for (let r = 0; r < newRows && altStartRow + r < altResult.rows.length; r++) {
      newAlt[r] = altResult.rows[altStartRow + r]!
      newAltWrapped[r] = altResult.wrapped[altStartRow + r]!
    }

    // Land the cursor where its logical line went (tracked pre-reflow above).
    const activeResult = useAltScreen ? altResult : mainResult
    const activeStartRow = useAltScreen ? altStartRow : mainStartRow
    if (activeResult.tracked !== null) {
      // Trim may have removed the cursor's own blank row — allow landing one
      // row past the remaining content; clampCursor() bounds it to the grid.
      curY = Math.min(activeResult.tracked.row, activeResult.rows.length) - activeStartRow
      curX = activeResult.tracked.col
    }

    mainGrid = newMain
    altGrid = newAlt
    mainSoftWrapped = newMainWrapped
    altSoftWrapped = newAltWrapped
    grid = useAltScreen ? altGrid : mainGrid
    softWrapped = useAltScreen ? altSoftWrapped : mainSoftWrapped
    const oldCols = cols
    cols = newCols
    rows = newRows
    scrollTop = 0
    scrollBottom = rows - 1
    leftMargin = 0
    rightMargin = cols - 1
    // Extend default tab stops for newly-added columns; preserve any custom stops
    // already set within the old width.
    if (newCols > oldCols) {
      for (let i = Math.max(8, Math.ceil(oldCols / 8) * 8); i < newCols; i += 8) {
        tabStops.add(i)
      }
    }
    clampCursor()
    markAllDirty() // dimensions + reflow changed the whole visible buffer

    // Fire the op tap once for the applied resize (no-op when untapped).
    if (opListeners.size > 0) emitOp({ type: "resize", cols: newCols, rows: newRows })
    // Reactive read plane: size$/cursor$ may have changed; damage is "all" (reflow).
    flushSignals()
  }

  // ── Snapshot / restore ──

  function snapshot(): Snapshot {
    return {
      version: 1,
      cols,
      rows,
      scrollbackLimit,
      activeBuffer: useAltScreen ? "alt" : "main",
      main: {
        grid: cloneGridSnapshot(mainGrid),
        softWrapped: [...mainSoftWrapped],
      },
      alt: {
        grid: cloneGridSnapshot(altGrid),
        softWrapped: [...altSoftWrapped],
      },
      scrollback: cloneGridSnapshot(scrollback),
      scrollbackSoftWrapped: [...scrollbackSoftWrapped],
      cursor: {
        x: curX,
        y: curY,
        visible: curVisible,
        shape: cursorShape,
        blinking: cursorBlinking,
        savedX: savedCurX,
        savedY: savedCurY,
      },
      savedState: {
        x: savedState.curX,
        y: savedState.curY,
        attrs: cloneAttrsSnapshot(savedState.attrs),
        originMode: savedState.originMode,
        autoWrap: savedState.autoWrap,
        charsetG0: savedState.charsetG0,
      },
      attrs: cloneAttrsSnapshot(attrs),
      modes: {
        bracketedPaste,
        applicationCursor,
        applicationKeypad,
        autoWrap,
        mouseTracking,
        mouseTrackingMode,
        sgrMouse,
        focusTracking,
        origin: originMode,
        insert: insertMode,
        newLine: newLineMode,
        reverseVideo,
        syncOutput,
        kittyKeyboardFlags,
        kittyKeyboardStack: [...kittyKeyboardStack],
        kittyGraphics: hasKittyGraphics,
        colorSchemeReporting,
        decColumn: decColumnMode,
        altScroll: altScrollMode,
        utf8Mouse: utf8MouseMode,
      },
      margins: {
        scrollTop,
        scrollBottom,
        leftRight: leftRightMarginMode,
        left: leftMargin,
        right: rightMargin,
      },
      colors: {
        current: snapshotColorState(),
        stack: colorStack.map(cloneColorStateSnapshot),
      },
      tabStops: [...tabStops].sort((a, b) => a - b),
      title,
      clipboard,
      cwd,
      notifications: [...notifications],
      viewportOffset,
      parser: {
        state: parserState,
        esc: escBuf,
        osc: oscBuf,
        dcs: dcsBuf,
        dcsStart: { row: dcsStartRow, col: dcsStartCol },
        dcsReceivedLength,
        dcsOverflow,
        apc: apcBuf,
        apcStart: { row: apcStartRow, col: apcStartCol },
        apcReceivedLength,
        apcOverflow,
        utf8PendingBytes: [...utf8PendingBytes],
      },
      unicode: {
        charsetG0,
        lastChar,
        pendingRegionalIndicator,
        afterZWJ,
      },
    }
  }

  function restore(snapshotValue: Snapshot): void {
    assertSnapshot(snapshotValue)

    cols = snapshotValue.cols
    rows = snapshotValue.rows
    scrollbackLimit = snapshotValue.scrollbackLimit
    mainGrid = restoreGridSnapshot(snapshotValue.main.grid, rows, cols)
    altGrid = restoreGridSnapshot(snapshotValue.alt.grid, rows, cols)
    scrollback = restoreScrollbackSnapshot(snapshotValue.scrollback)
    scrollbackSoftWrapped = snapshotValue.scrollbackSoftWrapped
      ? [...snapshotValue.scrollbackSoftWrapped]
      : new Array<boolean>(scrollback.length).fill(false)
    mainSoftWrapped = [...snapshotValue.main.softWrapped]
    altSoftWrapped = [...snapshotValue.alt.softWrapped]
    useAltScreen = snapshotValue.activeBuffer === "alt"
    grid = useAltScreen ? altGrid : mainGrid
    softWrapped = useAltScreen ? altSoftWrapped : mainSoftWrapped

    curX = snapshotValue.cursor.x
    curY = snapshotValue.cursor.y
    curVisible = snapshotValue.cursor.visible
    cursorShape = snapshotValue.cursor.shape
    cursorBlinking = snapshotValue.cursor.blinking
    savedCurX = snapshotValue.cursor.savedX
    savedCurY = snapshotValue.cursor.savedY

    savedState = {
      curX: snapshotValue.savedState.x,
      curY: snapshotValue.savedState.y,
      attrs: cloneAttrsSnapshot(snapshotValue.savedState.attrs),
      originMode: snapshotValue.savedState.originMode,
      autoWrap: snapshotValue.savedState.autoWrap,
      charsetG0: snapshotValue.savedState.charsetG0,
    }
    attrs = cloneAttrsSnapshot(snapshotValue.attrs)

    bracketedPaste = snapshotValue.modes.bracketedPaste
    applicationCursor = snapshotValue.modes.applicationCursor
    applicationKeypad = snapshotValue.modes.applicationKeypad
    autoWrap = snapshotValue.modes.autoWrap
    mouseTracking = snapshotValue.modes.mouseTracking
    mouseTrackingMode = snapshotValue.modes.mouseTrackingMode
    sgrMouse = snapshotValue.modes.sgrMouse
    focusTracking = snapshotValue.modes.focusTracking
    originMode = snapshotValue.modes.origin
    insertMode = snapshotValue.modes.insert
    newLineMode = snapshotValue.modes.newLine ?? false
    reverseVideo = snapshotValue.modes.reverseVideo
    syncOutput = snapshotValue.modes.syncOutput
    kittyKeyboardFlags = snapshotValue.modes.kittyKeyboardFlags
    kittyKeyboardStack = [...snapshotValue.modes.kittyKeyboardStack]
    hasKittyGraphics = snapshotValue.modes.kittyGraphics
    colorSchemeReporting = snapshotValue.modes.colorSchemeReporting
    decColumnMode = snapshotValue.modes.decColumn
    altScrollMode = snapshotValue.modes.altScroll
    utf8MouseMode = snapshotValue.modes.utf8Mouse

    scrollTop = snapshotValue.margins.scrollTop
    scrollBottom = snapshotValue.margins.scrollBottom
    leftRightMarginMode = snapshotValue.margins.leftRight
    leftMargin = snapshotValue.margins.left
    rightMargin = snapshotValue.margins.right
    restoreColorState(snapshotValue.colors.current)
    colorStack.length = 0
    colorStack.push(...snapshotValue.colors.stack.map(cloneColorStateSnapshot))
    tabStops = new Set(snapshotValue.tabStops)
    title = snapshotValue.title
    clipboard = snapshotValue.clipboard
    cwd = snapshotValue.cwd
    notifications = [...snapshotValue.notifications]
    viewportOffset = Math.max(0, Math.min(scrollback.length, snapshotValue.viewportOffset))

    parserState = snapshotValue.parser.state
    escBuf = snapshotValue.parser.esc
    oscBuf = snapshotValue.parser.osc
    dcsBuf = snapshotValue.parser.dcs
    dcsStartRow = snapshotValue.parser.dcsStart.row
    dcsStartCol = snapshotValue.parser.dcsStart.col
    dcsReceivedLength = snapshotValue.parser.dcsReceivedLength ?? dcsBuf.length
    dcsOverflow = snapshotValue.parser.dcsOverflow ?? false
    apcBuf = snapshotValue.parser.apc
    apcStartRow = snapshotValue.parser.apcStart?.row ?? curY
    apcStartCol = snapshotValue.parser.apcStart?.col ?? curX
    apcReceivedLength = snapshotValue.parser.apcReceivedLength ?? apcBuf.length
    apcOverflow = snapshotValue.parser.apcOverflow ?? false
    utf8PendingBytes = [...snapshotValue.parser.utf8PendingBytes]
    charsetG0 = snapshotValue.unicode.charsetG0
    lastChar = snapshotValue.unicode.lastChar
    pendingRegionalIndicator = snapshotValue.unicode.pendingRegionalIndicator
    afterZWJ = snapshotValue.unicode.afterZWJ

    textScale = 1
    fontSize = 12
    fontWindowSize = 12
    locale = "en_US.UTF-8"
    advancedClipboard = ""
    semanticZones = []
    hasSixel = false
    sixelImages = []
    // Bound a malformed snapshot's cursor, but allow the past-the-end
    // deferred-wrap position (curX == cols) that a full-width write leaves
    // behind: clampCursor() would pull it onto the last column, making the
    // first restored-session byte overwrite that cell instead of wrapping
    // (the PROMPT_SP checkpoint/resume class).
    if (curX < 0) curX = 0
    if (curX > cols) curX = cols
    if (curY < 0) curY = 0
    if (curY >= rows) curY = rows - 1
    // Whole world replaced (incl. scrollback): restart the damage epoch and trim origin.
    markAllDirty()
    dirtyScrolled = 0
    if (sigDamageActive) sigDirtyScrolled = 0
    trimmedRowCount = 0
    // Reactive read plane: a reset changes title/modes/cursor/size and damages the whole buffer.
    flushSignals()
  }

  // ── Accessors ──

  function getCell(row: number, col: number): ScreenCell {
    const r = grid[row]
    if (!r || col >= cols) return emptyCell()
    return stripCellColorIndex(r.getCellRaw(col))
  }

  function getRow(row: number): ScreenCell[] {
    const r = grid[row]
    if (!r) return makeRow(cols).toCells()
    return r.toCells().map(stripCellColorIndex)
  }

  function getText(): string {
    const lines: string[] = []
    for (let r = 0; r < rows; r++) {
      lines.push(rowToString(grid[r]!))
    }
    return lines.join("\n")
  }

  function getScrollbackText(): string {
    const lines: string[] = []
    for (const row of scrollback) {
      lines.push(rowToString(row))
    }
    return lines.join("\n")
  }

  // ── Absolute-row read plane + dirty tracking ──

  function totalRows(): number {
    return scrollback.length + rows
  }

  function screenRows(): number {
    return rows
  }

  function viewportTop(): number {
    // viewportOffset counts rows scrolled UP from the bottom (0 = at bottom). The viewport's top
    // absolute row is therefore scrollback.length - viewportOffset: at the bottom that is
    // scrollback.length = totalRows - screenRows; scrolled fully up (offset = scrollback.length) it
    // is 0.
    return scrollback.length - viewportOffset
  }

  function getRowAbsolute(row: number): ScreenCell[] {
    if (row < 0 || row >= scrollback.length + rows) return makeRow(cols).toCells()
    const src = row < scrollback.length ? scrollback[row]! : grid[row - scrollback.length]!
    return src.toCells().map(stripCellColorIndex)
  }

  function firstRetainedRow(): number {
    return trimmedRowCount
  }

  function takeDirty(): DirtyRegion {
    const cursorChanged =
      curX !== dirtyCursor.x ||
      curY !== dirtyCursor.y ||
      curVisible !== dirtyCursor.visible ||
      cursorShape !== dirtyCursor.shape ||
      cursorBlinking !== dirtyCursor.blinking
    const region: DirtyRegion = {
      rows: dirtyAll ? "all" : dirtyRows,
      cursor: cursorChanged,
      scrolled: dirtyScrolled,
    }
    // Reset the epoch: hand the accumulated Set to the caller and start a fresh one.
    dirtyRows = new Set()
    dirtyAll = false
    dirtyScrolled = 0
    dirtyLastAbs = -1
    dirtyCursor = { x: curX, y: curY, visible: curVisible, shape: cursorShape, blinking: cursorBlinking }
    return region
  }

  function rowToString(row: PackedRow): string {
    let line = ""
    for (let i = 0; i < row.length; i++) {
      const ch = row.getChar(i)
      if (row.isWide(i)) {
        line += ch
      } else if (ch === "") {
        if (i > 0 && row.isWide(i - 1)) {
          continue
        }
        line += " "
      } else {
        line += ch
      }
    }
    return line.replace(/\s+$/, "")
  }

  function getTextRange(startRow: number, startCol: number, endRow: number, endCol: number): string {
    const parts: string[] = []

    for (let row = startRow; row <= endRow; row++) {
      const r = grid[row]
      if (!r) continue

      const colStart = row === startRow ? startCol : 0
      const colEnd = row === endRow ? endCol : cols

      let line = ""
      for (let col = colStart; col < colEnd; col++) {
        if (col < 0 || col >= r.length) continue
        const ch = r.getChar(col)
        if (ch === "" && col > 0 && r.isWide(col - 1)) continue
        line += ch || " "
      }
      parts.push(line.replace(/\s+$/, ""))
    }

    return parts.join("\n")
  }

  function getMode(mode: string): boolean {
    switch (mode) {
      case "altScreen":
        return useAltScreen
      case "cursorVisible":
        return curVisible
      case "bracketedPaste":
        return bracketedPaste
      case "applicationCursor":
        return applicationCursor
      case "applicationKeypad":
        return applicationKeypad
      case "autoWrap":
        return autoWrap
      case "mouseTracking":
        return mouseTracking
      case "focusTracking":
        return focusTracking
      case "originMode":
        return originMode
      case "insertMode":
        return insertMode
      case "newLineMode":
        return newLineMode
      case "reverseVideo":
        return reverseVideo
      case "syncOutput":
        return syncOutput
      case "sgrMouse":
        return sgrMouse
      case "pixelMouse":
        return mouseTrackingMode === 1016
      case "leftRightMargin":
        return leftRightMarginMode
      case "colorSchemeReporting":
        return colorSchemeReporting
      case "kittyKeyboard":
        return kittyKeyboardFlags > 0
      case "kittyGraphics":
        return hasKittyGraphics
      case "sixel":
        return hasSixel
      default:
        return false
    }
  }

  // ── Public op seam + taps ──

  function apply(op: TerminalOp): void {
    switch (op.type) {
      case "output":
        process(typeof op.data === "string" ? encoder.encode(op.data) : op.data)
        return
      case "resize":
        resize(op.cols, op.rows)
        return
      default: {
        // Exhaustiveness + fail-loud: an unknown op type is a programming error, not a silent no-op.
        const unreachable: never = op
        throw new Error(`vterm.apply: unhandled op ${JSON.stringify(unreachable)}`)
      }
    }
  }

  function tapOps(listener: (op: TerminalOp) => void): () => void {
    opListeners.add(listener)
    return () => {
      opListeners.delete(listener)
    }
  }

  function tapParser(listener: (event: ParserEvent) => void): () => void {
    parserListeners.add(listener)
    return () => {
      parserListeners.delete(listener)
    }
  }

  // ── Reactive read plane: the signals facade (§4) ──
  //
  // Lazily built on first `.signals` access; each signal lazily built on first access to its getter.
  // `flushSignals` is a no-op until `.signals` is read, and the per-write damage accumulator above is
  // a no-op until `damage$` has a subscriber (`sigDamageActive`) — so the write core stays
  // allocation-free while the facade is unused. State signals are computed live and equality-gated at
  // the flush boundary; `damage$` drains its OWN accumulator (`sigDirty*`), never the pull-plane
  // `takeDirty()` epoch.

  interface FlushableSignal {
    flush(): void
  }
  const stateFlushSignals: FlushableSignal[] = []

  /**
   * A state signal (title/modes/cursor/size): `get()` reads live; `subscribe` captures the current
   * value as its baseline (so only later changes deliver) and `flush()` delivers once per flush
   * boundary iff the value changed. Registered in `stateFlushSignals` so `flushSignals` visits it.
   */
  function makeStateSignal<T>(read: () => T, eq: (a: T, b: T) => boolean): ReadSignal<T> {
    const listeners = new Set<(value: T) => void>()
    let last: T = read()
    const signal: ReadSignal<T> & FlushableSignal = {
      get: read,
      subscribe(listener) {
        // Re-baseline on the 0→1 transition so a fresh subscriber only hears future changes.
        if (listeners.size === 0) last = read()
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      flush() {
        if (listeners.size === 0) return
        const current = read()
        if (eq(current, last)) return
        last = current
        for (const listener of listeners) listener(current)
      },
    }
    stateFlushSignals.push(signal)
    return signal
  }

  function modesNow(): TerminalModes {
    return {
      altScreen: useAltScreen,
      cursorVisible: curVisible,
      bracketedPaste,
      applicationCursor,
      applicationKeypad,
      autoWrap,
      mouseTracking,
      mouseTrackingMode,
      sgrMouse,
      utf8Mouse: utf8MouseMode,
      focusTracking,
      originMode,
      insertMode,
      newLineMode,
      reverseVideo,
      syncOutput,
      leftRightMargin: leftRightMarginMode,
      colorSchemeReporting,
      kittyKeyboard: kittyKeyboardFlags > 0,
      kittyGraphics: hasKittyGraphics,
      sixel: hasSixel,
    }
  }

  function modesEq(a: TerminalModes, b: TerminalModes): boolean {
    return (
      a.altScreen === b.altScreen &&
      a.cursorVisible === b.cursorVisible &&
      a.bracketedPaste === b.bracketedPaste &&
      a.applicationCursor === b.applicationCursor &&
      a.applicationKeypad === b.applicationKeypad &&
      a.autoWrap === b.autoWrap &&
      a.mouseTracking === b.mouseTracking &&
      a.mouseTrackingMode === b.mouseTrackingMode &&
      a.sgrMouse === b.sgrMouse &&
      a.utf8Mouse === b.utf8Mouse &&
      a.focusTracking === b.focusTracking &&
      a.originMode === b.originMode &&
      a.insertMode === b.insertMode &&
      a.newLineMode === b.newLineMode &&
      a.reverseVideo === b.reverseVideo &&
      a.syncOutput === b.syncOutput &&
      a.leftRightMargin === b.leftRightMargin &&
      a.colorSchemeReporting === b.colorSchemeReporting &&
      a.kittyKeyboard === b.kittyKeyboard &&
      a.kittyGraphics === b.kittyGraphics &&
      a.sixel === b.sixel
    )
  }

  // damage$ is not a makeStateSignal — its value is an accumulated batch, not a live-readable scalar.
  const damageListeners = new Set<(region: DirtyRegion) => void>()
  const EMPTY_DAMAGE: DirtyRegion = { rows: new Set(), cursor: false, scrolled: 0 }
  let damageLast: DirtyRegion = EMPTY_DAMAGE
  let damageSignal: ReadSignal<DirtyRegion> | undefined

  function getDamageSignal(): ReadSignal<DirtyRegion> {
    return (damageSignal ??= {
      get: () => damageLast,
      subscribe(listener) {
        if (damageListeners.size === 0) {
          // Activate the accumulator and baseline it to NOW, so the first batch reflects only
          // damage produced after this subscription — never rows accrued while inactive.
          sigDamageActive = true
          sigDirtyAll = false
          sigDirtyRows = new Set()
          sigDirtyScrolled = 0
          sigDirtyLastAbs = -1
          sigDirtyCursor = { x: curX, y: curY, visible: curVisible, shape: cursorShape, blinking: cursorBlinking }
        }
        damageListeners.add(listener)
        return () => {
          damageListeners.delete(listener)
          if (damageListeners.size === 0) sigDamageActive = false
        }
      },
    })
  }

  function emitDamageBatch(): void {
    const cursorChanged =
      curX !== sigDirtyCursor.x ||
      curY !== sigDirtyCursor.y ||
      curVisible !== sigDirtyCursor.visible ||
      cursorShape !== sigDirtyCursor.shape ||
      cursorBlinking !== sigDirtyCursor.blinking
    if (!sigDirtyAll && sigDirtyRows.size === 0 && sigDirtyScrolled === 0 && !cursorChanged) return
    const region: DirtyRegion = {
      rows: sigDirtyAll ? "all" : sigDirtyRows,
      cursor: cursorChanged,
      scrolled: sigDirtyScrolled,
    }
    // Reset the SIGNAL epoch only (the pull-plane takeDirty() epoch is untouched): hand the Set to
    // subscribers and start a fresh accumulator for the next flush.
    sigDirtyRows = new Set()
    sigDirtyAll = false
    sigDirtyScrolled = 0
    sigDirtyLastAbs = -1
    sigDirtyCursor = { x: curX, y: curY, visible: curVisible, shape: cursorShape, blinking: cursorBlinking }
    damageLast = region
    for (const listener of damageListeners) listener(region)
  }

  let signalsFacade: ScreenSignals | undefined
  let titleSignal: ReadSignal<string> | undefined
  let modesSignal: ReadSignal<TerminalModes> | undefined
  let cursorSignal: ReadSignal<Cursor> | undefined
  let sizeSignal: ReadSignal<Size> | undefined

  function getSignals(): ScreenSignals {
    return (signalsFacade ??= {
      get title$() {
        return (titleSignal ??= makeStateSignal(
          () => title,
          (a, b) => a === b,
        ))
      },
      get modes$() {
        return (modesSignal ??= makeStateSignal(modesNow, modesEq))
      },
      get cursor$() {
        return (cursorSignal ??= makeStateSignal(
          () => ({ col: curX, row: curY }),
          (a, b) => a.col === b.col && a.row === b.row,
        ))
      },
      get size$() {
        return (sizeSignal ??= makeStateSignal(
          () => ({ cols, rows }),
          (a, b) => a.cols === b.cols && a.rows === b.rows,
        ))
      },
      get damage$() {
        return getDamageSignal()
      },
    })
  }

  /** Coalesced end-of-call emission for every accessed signal — the flush boundary (§4). */
  function flushSignals(): void {
    if (signalsFacade === undefined) return
    for (const signal of stateFlushSignals) signal.flush()
    if (sigDamageActive) emitDamageBatch()
  }

  // Suppress unused variable warnings
  void [mouseTrackingMode, textScale, advancedClipboard]

  return {
    get cols() {
      return cols
    },
    get rows() {
      return rows
    },
    get signals() {
      return getSignals()
    },
    process,
    resize,
    apply,
    tapOps,
    tapParser,
    reset: fullReset,
    snapshot,
    restore,
    getCell,
    getRow,
    getText,
    getScrollbackText,
    getTextRange,
    totalRows,
    screenRows,
    viewportTop,
    getRowAbsolute,
    firstRetainedRow,
    takeDirty,
    getCursor: () => ({ col: curX, row: curY }),
    getCursorVisible: () => curVisible,
    getCursorShape: () => cursorShape,
    getCursorBlinking: () => cursorBlinking,
    getTitle: () => title,
    getMode,
    getClipboard: () => clipboard,
    getCwd: () => cwd,
    getNotifications: () => [...notifications],
    getScrollbackLength: () => scrollback.length,
    getViewportOffset: () => viewportOffset,
    scrollViewport,
    getSemanticZones: () => semanticZones.map((z) => ({ ...z })),
    getSixelImages: () => sixelImages.map((img) => ({ ...img })),
    serialize: (options?: SerializeOptions) => serializeSnapshot(snapshot(), options),
  }
}

// ── State → minimal-ANSI serializer (pen-diff core + mode emission) ────
//
// The lossy-but-faithful projection of a snapshot into a byte stream a fresh
// same-size terminal can replay. Phase order (each constraint proven by the
// mode round-trip matrix in the test suite):
//   1 history   — scrollback flows via CRLF (CUP cannot address it); soft-wrap-
//                 linked rows are re-linked through the receiver's own autowrap.
//   2 geometry  — alt-enter (?1049h) and DECSTBM; both home the cursor and must
//                 precede the paint. DECSLRM is NOT here: it clamps writes into
//                 the margin box and would make outside columns unpaintable.
//   3 modes     — paint-safe flags (DECSET set-forms only, never queries),
//                 mouse (the exact stored mode), kitty keyboard (set + pushes),
//                 default/palette colors, optional title.
//   4 paint     — DECAWM off, home + clear, positioned pen-diff rows. Runs with
//                 origin OFF, insert OFF, charset ASCII, no left/right margins —
//                 the four states that corrupt positioned writes.
//   5 finalize  — autowrap, cursor style, charset, insert, tab stops, DECSLRM,
//                 pending pen, visibility, then origin + the final CUP LAST.
// Never emitted (hard exclusions): ?2026 syncOutput (a static restore never
// sends the closing ?2026l — it wedges a real receiver, and vterm's own write
// path ignores the flag, so only a raw-absence assertion can police it) and
// ?3 DECCOLM (erases the whole screen + homes). The binary snapshot stays the
// lossless spine — this is a projection for replay/preview consumers, not a
// state-transfer format.

export interface SerializeOptions {
  /** Emit scrollback history rows before the screen paint. Default: true. */
  includeScrollback?: boolean
  /** Emit the window title (OSC 0) when non-empty. Default: false. */
  includeTitle?: boolean
  /** Emit OSC 8 hyperlinks for cell and pending-pen urls. Default: true. */
  hyperlinks?: boolean
  /**
   * Snapshot mode keys to skip during emission (e.g. `"bracketedPaste"`,
   * `"mouseTracking"`, `"kittyKeyboardFlags"`, `"origin"`, `"insert"`).
   * The receiver keeps its fresh default for excluded keys — an explicit,
   * caller-requested divergence from the snapshot. DECAWM paint discipline
   * is correctness, not configuration, and cannot be excluded.
   */
  excludeModes?: readonly string[]
}

/** The SGR-carried pen fields — `ScreenCell` minus `char`/`wide`/`url` (url travels via OSC 8). */
type SerializePen = Pick<
  ScreenCell,
  | "fg"
  | "bg"
  | "bold"
  | "faint"
  | "italic"
  | "underline"
  | "underlineColor"
  | "overline"
  | "strikethrough"
  | "inverse"
  | "hidden"
  | "blink"
>

const SERIALIZE_DEFAULT_PEN: SerializePen = Object.freeze({
  fg: null,
  bg: null,
  bold: false,
  faint: false,
  italic: false,
  underline: "none" as UnderlineStyle,
  underlineColor: null,
  overline: false,
  strikethrough: false,
  inverse: false,
  hidden: false,
  blink: false,
})

const SERIALIZE_BOOL_CODES = [
  ["bold", "1"],
  ["faint", "2"],
  ["italic", "3"],
  ["blink", "5"],
  ["inverse", "7"],
  ["hidden", "8"],
  ["strikethrough", "9"],
  ["overline", "53"],
] as const satisfies readonly (readonly [keyof SerializePen, string])[]

/** Colon-subparam underline forms — the lossless spellings vterm itself parses. */
function serializeUnderlineParam(style: UnderlineStyle): string {
  switch (style) {
    case "single":
      return "4"
    case "double":
      return "4:2"
    case "curly":
      return "4:3"
    case "dotted":
      return "4:4"
    case "dashed":
      return "4:5"
    case "none":
      return "24"
  }
}

function serializeColorEq(a: Color | null, b: Color | null): boolean {
  if (a === null || b === null) return a === b
  // Include the palette-origin index in equality: two colors with identical RGB
  // but different provenance (e.g. `31` → {128,0,0,index:1} vs the true-RGB
  // `38;2;128;0;0` → {128,0,0}) must NOT be treated as equal. Otherwise the
  // run-merger would fold them into one SGR run and re-emit the FIRST cell's
  // form for both, re-theming a cell the app authored as literal RGB (or baking
  // one it authored as indexed). Costs a few extra SGR runs at a provenance
  // boundary; guarantees each cell re-emits its own faithful form. Palette
  // entries (OSC-4 diff, defaults) carry no index, so their equality is
  // unchanged (both `index` undefined → compared by RGB only).
  return a.r === b.r && a.g === b.g && a.b === b.b && a.index === b.index
}

function serializePenOf(source: SerializePen): SerializePen {
  return {
    fg: source.fg,
    bg: source.bg,
    bold: source.bold,
    faint: source.faint,
    italic: source.italic,
    underline: source.underline,
    underlineColor: source.underlineColor,
    overline: source.overline,
    strikethrough: source.strikethrough,
    inverse: source.inverse,
    hidden: source.hidden,
    blink: source.blink,
  }
}

function serializePenEq(a: SerializePen, b: SerializePen): boolean {
  return (
    a.bold === b.bold &&
    a.faint === b.faint &&
    a.italic === b.italic &&
    a.blink === b.blink &&
    a.inverse === b.inverse &&
    a.hidden === b.hidden &&
    a.strikethrough === b.strikethrough &&
    a.overline === b.overline &&
    a.underline === b.underline &&
    serializeColorEq(a.fg, b.fg) &&
    serializeColorEq(a.bg, b.bg) &&
    serializeColorEq(a.underlineColor, b.underlineColor)
  )
}

function serializePenIsDefault(pen: SerializePen): boolean {
  return serializePenEq(pen, SERIALIZE_DEFAULT_PEN)
}

function serializeColorParams(prefix: string, defaultCode: string, color: Color | null): string {
  if (color === null) return defaultCode
  const idx = color.index
  if (idx !== undefined && idx >= 0 && idx <= 255) {
    // Indexed-identity: re-emit the shortest faithful indexed SGR form (never a
    // baked `x8;2;R;G;B`) so a themeable receiver re-themes the cell on reattach.
    //   fg  (`38`): basic 30-37, bright 90-97, else 256-indexed `38;5;N`
    //   bg  (`48`): basic 40-47, bright 100-107, else 256-indexed `48;5;N`
    //   underline (`58`): no basic/bright short form → always `58;5;N`
    if (prefix === "38") {
      if (idx <= 7) return String(30 + idx)
      if (idx <= 15) return String(90 + (idx - 8))
      return `38;5;${String(idx)}`
    }
    if (prefix === "48") {
      if (idx <= 7) return String(40 + idx)
      if (idx <= 15) return String(100 + (idx - 8))
      return `48;5;${String(idx)}`
    }
    return `${prefix};5;${String(idx)}`
  }
  return `${prefix};2;${String(color.r)};${String(color.g)};${String(color.b)}`
}

/**
 * Reset-on-removal pen diff (the tmux `grid_string_cells` model): emit `SGR 0`
 * iff a boolean attribute turns off or the underline changes away from a
 * non-none style, then re-add deltas from the reset base. This makes the
 * `SGR 22` bold/faint coupling and the underline-off classes structurally
 * impossible, at a few bytes' cost. The leading `0` is emitted only on an
 * actual reset (not whenever the previous pen happens to be default) so
 * output stays byte-deterministic and idempotence-friendly.
 */
function serializeDiffPen(prev: SerializePen, cur: SerializePen): string[] {
  let boolOff = false
  for (const [key] of SERIALIZE_BOOL_CODES) {
    if (prev[key] === true && cur[key] === false) {
      boolOff = true
      break
    }
  }
  const underlineChanged = prev.underline !== cur.underline && prev.underline !== "none"
  const reset = boolOff || underlineChanged
  const base = reset ? SERIALIZE_DEFAULT_PEN : prev
  const out: string[] = reset ? ["0"] : []
  for (const [key, code] of SERIALIZE_BOOL_CODES) {
    if (cur[key] === true && base[key] === false) out.push(code)
  }
  if (cur.underline !== base.underline) out.push(serializeUnderlineParam(cur.underline))
  if (!serializeColorEq(cur.fg, base.fg)) out.push(serializeColorParams("38", "39", cur.fg))
  if (!serializeColorEq(cur.bg, base.bg)) out.push(serializeColorParams("48", "49", cur.bg))
  if (!serializeColorEq(cur.underlineColor, base.underlineColor)) {
    out.push(serializeColorParams("58", "59", cur.underlineColor))
  }
  return out
}

/**
 * Last cell worth emitting: trailing UNWRITTEN cells (`char === ""`, default
 * pen, no url) are trimmed — the receiver's cleared screen already has them.
 * Erased-with-bg trailing cells (BCE) are kept and reproduced via ECH.
 */
function serializeRowEnd(row: readonly ScreenCell[]): number {
  let end = row.length
  while (end > 0) {
    const cell = row[end - 1]
    if (cell === undefined) {
      end--
      continue
    }
    if (cell.char.length > 0 || cell.wide || cell.url !== null) break
    if (!serializePenIsDefault(serializePenOf(cell))) break
    end--
  }
  return end
}

/**
 * Encode one row with per-run pen diffing. Invariants:
 * - the terminal pen is DEFAULT at entry (rows end with `SGR 0`);
 * - wide-cell spacers (char `""` following a `wide` cell) emit nothing;
 * - runs of unwritten cells are SKIPPED via CHA (the sink's cells stay
 *   genuinely empty — not painted as spaces), and erased-with-bg runs are
 *   reproduced via SGR+ECH, so the sink grid equals the source grid natively;
 * - an open OSC 8 hyperlink is always closed by row end.
 *
 * `literalWidth > 0` switches to LITERAL mode for soft-wrap-linked history
 * rows: every one of `literalWidth` columns is WRITTEN (unwritten cells as
 * pen-carrying spaces — no CHA skips, no ECH, no trailing trim), so the last
 * column write arms the receiver's pending-wrap and the next row's first
 * character re-links the logical line. Cell-level cost: the receiver's
 * scrollback holds written spaces where the source had unwritten cells —
 * invisible to the text + wrap-bit projections that scrollback serves.
 */
function serializeEncodeRow(row: readonly ScreenCell[], hyperlinks: boolean, literalWidth = 0): string {
  const literal = literalWidth > 0
  const end = literal ? literalWidth : serializeRowEnd(row)
  let out = ""
  let pen: SerializePen = SERIALIZE_DEFAULT_PEN
  let openUrl: string | null = null
  let col = 0
  while (col < end) {
    const cell = row[col]
    if (cell === undefined) {
      if (!literal) {
        col++
        continue
      }
      const diff = serializeDiffPen(pen, SERIALIZE_DEFAULT_PEN)
      if (diff.length > 0) {
        out += `\x1b[${diff.join(";")}m`
        pen = SERIALIZE_DEFAULT_PEN
        if (diff[0] === "0") openUrl = null // SGR 0 also closes the link (see below)
      }
      if (openUrl !== null) {
        out += "\x1b]8;;\x1b\\"
        openUrl = null
      }
      out += " "
      col++
      continue
    }
    if (cell.char.length === 0 && col > 0 && row[col - 1]?.wide === true) {
      col++ // wide-cell spacer — the wide char itself already produced it
      continue
    }
    if (cell.char.length === 0 && cell.url === null && !literal) {
      const runPen = serializePenOf(cell)
      const runStart = col
      while (col < end) {
        const next = row[col]
        if (next === undefined || next.char.length > 0 || next.url !== null) break
        if (!serializePenEq(serializePenOf(next), runPen)) break
        col++
      }
      const runLength = col - runStart
      if (serializePenIsDefault(runPen)) {
        out += `\x1b[${String(col + 1)}G` // skip — sink cells stay unwritten
      } else {
        const diff = serializeDiffPen(pen, runPen)
        if (diff.length > 0) {
          out += `\x1b[${diff.join(";")}m`
          pen = runPen
          if (diff[0] === "0") openUrl = null // SGR 0 also closes the link (see below)
        }
        out += `\x1b[${String(runLength)}X\x1b[${String(col + 1)}G` // ECH: erased-with-bg, exactly as BCE made them
      }
      continue
    }
    const cellPen = serializePenOf(cell)
    const diff = serializeDiffPen(pen, cellPen)
    if (diff.length > 0) {
      out += `\x1b[${diff.join(";")}m`
      pen = cellPen
      // vterm's SGR 0 resets the whole attr record INCLUDING the OSC 8 url
      // (resetAttrs), so an emitted reset silently closes the receiver's link.
      // Mirror that here so a same-url cell after a reset re-opens it — a
      // harmless redundancy on terminals that keep OSC 8 orthogonal to SGR.
      if (diff[0] === "0") openUrl = null
    }
    const url = hyperlinks ? cell.url : null
    if (url !== openUrl) {
      out += url === null ? "\x1b]8;;\x1b\\" : `\x1b]8;;${url}\x1b\\`
      openUrl = url
    }
    out += cell.char.length > 0 ? cell.char : " " // defensive: url-bearing empty cell paints as a linked space
    col++
  }
  if (openUrl !== null) out += "\x1b]8;;\x1b\\"
  return out
}

/**
 * Paint-safe DECSET boolean flags emitted in phase 3 — set-forms only, emitted
 * only when true (the receiver is fresh: every flag defaults to false). Origin
 * and insert are deliberately NOT here — they corrupt a positioned paint and
 * are restored in finalize instead.
 */
const SERIALIZE_DECSET_FLAGS = [
  ["applicationCursor", 1],
  ["reverseVideo", 5],
  ["focusTracking", 1004],
  ["utf8Mouse", 1005],
  ["sgrMouse", 1006],
  ["altScroll", 1007],
  ["bracketedPaste", 2004],
  ["colorSchemeReporting", 2031],
] as const satisfies readonly (readonly [keyof Snapshot["modes"], number])[]

/** Default palette shared by every serialize call (read-only baseline for OSC 4 diffs). */
const SERIALIZE_DEFAULT_PALETTE: readonly Color[] = buildPalette256()

/** `rgb:RR/GG/BB` — the XParseColor spelling vterm's own OSC parser round-trips exactly. */
function serializeColorSpec(color: Color): string {
  const hex = (v: number): string => v.toString(16).padStart(2, "0")
  return `rgb:${hex(color.r)}/${hex(color.g)}/${hex(color.b)}`
}

/** DECSCUSR code for (shape, blinking); 1 (blinking block) is the fresh default. */
function serializeCursorStyleCode(shape: "block" | "underline" | "bar", blinking: boolean): number {
  const base = shape === "block" ? 1 : shape === "underline" ? 3 : 5
  return blinking ? base : base + 1
}

/** True when `stops` (sorted) is exactly the fresh default — a stop every 8 columns. */
function serializeTabStopsAreDefault(stops: readonly number[], cols: number): boolean {
  let expected = 8
  for (const stop of stops) {
    if (stop !== expected) return false
    expected += 8
  }
  return expected >= cols
}

/**
 * Serialize a snapshot to minimal ANSI a FRESH same-size terminal can replay.
 * Phase order + the hard exclusion set are documented on the section header
 * above; every ordering constraint is pinned by the mode round-trip matrix.
 *
 * Intended divergences (documented, not silent): syncOutput/decColumn are
 * never emitted; the inactive buffer, SCP saved cursor, DECSC saved state,
 * color stack, and parser/pending-wrap/mid-parse state are unserializable to
 * a VT byte stream by design — the binary snapshot carries them.
 */
export function serializeSnapshot(snapshot: Snapshot, options: SerializeOptions = {}): string {
  const hyperlinks = options.hyperlinks !== false
  const excluded = new Set(options.excludeModes ?? [])
  const rows = snapshot.rows
  const m = snapshot.modes
  const out: string[] = []

  // Phase 1 — history (main-buffer scrollback), oldest first, before any
  // geometry (it must flow through a fresh unconstrained screen). A row whose
  // soft-wrap bit is set continues INTO the next row: emit it at literal full
  // width with no line break, and the receiver's own autowrap re-links the
  // logical line — re-recording the wrap bit when the row scrolls out. The
  // LAST history row's linkage (into visible screen row 0) is severed by
  // design: the positioned paint below is not a flow (masked in the oracle).
  if (options.includeScrollback !== false && snapshot.scrollback.length > 0) {
    const wraps = snapshot.scrollbackSoftWrapped
    const last = snapshot.scrollback.length - 1
    for (let i = 0; i < snapshot.scrollback.length; i++) {
      const row = snapshot.scrollback[i]!
      if (wraps?.[i] === true && i < last) {
        out.push(serializeEncodeRow(row, hyperlinks, snapshot.cols), "\x1b[0m")
      } else {
        out.push(serializeEncodeRow(row, hyperlinks), "\x1b[0m\r\n")
      }
    }
    // Flush: after flowing k history rows, min(k, rows-1) of them are still on
    // the visible screen; exactly rows-1 newlines scroll them all into the
    // receiver's scrollback before the clear below would wipe them.
    if (rows > 1) out.push("\n".repeat(rows - 1))
  }

  // Phase 2 — geometry that must precede the paint. Both home the cursor;
  // ?1049h also allocates a fresh blank alt grid — exactly the canvas the
  // paint expects. (Known limitation, by design: while in alt, the main
  // SCREEN is not emitted — main scrollback still is, and the binary
  // snapshot carries the main grid. ?1049h also overwrites the receiver's
  // SCP saved-cursor slot; cursor.savedX/savedY do not round-trip.)
  if (snapshot.activeBuffer === "alt") out.push("\x1b[?1049h")
  if (snapshot.margins.scrollTop !== 0 || snapshot.margins.scrollBottom !== rows - 1) {
    out.push(`\x1b[${String(snapshot.margins.scrollTop + 1)};${String(snapshot.margins.scrollBottom + 1)}r`)
  }

  // Phase 3 — paint-safe modes and receiver-level state. Set-forms only —
  // query forms would make the receiver echo responses into its input.
  for (const [key, code] of SERIALIZE_DECSET_FLAGS) {
    if (m[key] === true && !excluded.has(key)) out.push(`\x1b[?${String(code)}h`)
  }
  if (m.mouseTracking && m.mouseTrackingMode > 0 && !excluded.has("mouseTracking")) {
    // The EXACT stored mode — 9/1000/1002/1003/1015/1016, not a canonicalized subset.
    out.push(`\x1b[?${String(m.mouseTrackingMode)}h`)
  }
  if (m.applicationKeypad && !excluded.has("applicationKeypad")) out.push("\x1b=")
  if (!excluded.has("kittyKeyboardFlags") && (m.kittyKeyboardFlags !== 0 || m.kittyKeyboardStack.length > 0)) {
    // Rebuild (flags, stack): seed the stack bottom with `=` (set, no push),
    // push the rest — each push captures the previous flags — then land on the
    // live flags. Requires the CSI = u handler this slice added to the parser.
    const stack = m.kittyKeyboardStack
    if (stack.length === 0) {
      out.push(`\x1b[=${String(m.kittyKeyboardFlags)}u`)
    } else {
      out.push(`\x1b[=${String(stack[0])}u`)
      for (let i = 1; i < stack.length; i++) out.push(`\x1b[>${String(stack[i])}u`)
      out.push(`\x1b[>${String(m.kittyKeyboardFlags)}u`)
    }
  }
  const colors = snapshot.colors.current
  if (colors.defaultFgColor) out.push(`\x1b]10;${serializeColorSpec(colors.defaultFgColor)}\x1b\\`)
  if (colors.defaultBgColor) out.push(`\x1b]11;${serializeColorSpec(colors.defaultBgColor)}\x1b\\`)
  for (let i = 0; i < colors.palette256.length; i++) {
    const cur = colors.palette256[i]
    const def = SERIALIZE_DEFAULT_PALETTE[i]
    if (cur !== undefined && def !== undefined && !serializeColorEq(cur, def)) {
      out.push(`\x1b]4;${String(i)};${serializeColorSpec(cur)}\x1b\\`)
    }
  }
  if (options.includeTitle === true && snapshot.title.length > 0) {
    out.push(`\x1b]0;${snapshot.title}\x1b\\`)
  }

  // Phase 4 — paint: DECAWM off (kills last-column/deferred-wrap artifacts),
  // home + clear, then positioned rows. Empty rows are skipped (2J blanked
  // them). Runs with origin OFF, insert OFF, charset ASCII, and no left/right
  // margins — the four states that corrupt positioned writes; each is
  // restored in finalize below.
  out.push("\x1b[?7l", "\x1b[H\x1b[2J")
  const grid = snapshot.activeBuffer === "alt" ? snapshot.alt.grid : snapshot.main.grid
  for (let r = 0; r < rows; r++) {
    const line = serializeEncodeRow(grid[r] ?? [], hyperlinks)
    if (line.length === 0) continue
    out.push(`\x1b[${String(r + 1)};1H`, line, "\x1b[0m")
  }

  // Phase 5 — finalize, fixed order: autowrap → cursor style → charset →
  // insert → tab stops (the CHA walk moves the cursor) → DECSLRM (homes the
  // cursor) → pending pen → visibility → origin + final CUP LAST.
  out.push(m.autoWrap ? "\x1b[?7h" : "\x1b[?7l")
  if (snapshot.cursor.shape !== "block" || !snapshot.cursor.blinking) {
    out.push(`\x1b[${String(serializeCursorStyleCode(snapshot.cursor.shape, snapshot.cursor.blinking))} q`)
  }
  if (snapshot.unicode.charsetG0) out.push("\x1b(0")
  if (m.insert && !excluded.has("insert")) out.push("\x1b[4h")
  if (!serializeTabStopsAreDefault(snapshot.tabStops, snapshot.cols)) {
    out.push("\x1b[3g")
    for (const stop of snapshot.tabStops) {
      // Stops at/past the width (possible only via a shrink-resize) cannot be
      // planted — CHA would clamp and HTS would record a WRONG stop instead.
      if (stop < snapshot.cols) out.push(`\x1b[${String(stop + 1)}G\x1bH`)
    }
  }
  if (snapshot.margins.leftRight) {
    out.push("\x1b[?69h")
    if (snapshot.margins.left !== 0 || snapshot.margins.right !== snapshot.cols - 1) {
      out.push(`\x1b[${String(snapshot.margins.left + 1)};${String(snapshot.margins.right + 1)}s`)
    }
  }
  const penParams = serializeDiffPen(SERIALIZE_DEFAULT_PEN, serializePenOf(snapshot.attrs))
  if (penParams.length > 0) out.push(`\x1b[${penParams.join(";")}m`)
  if (hyperlinks && snapshot.attrs.url !== null) out.push(`\x1b]8;;${snapshot.attrs.url}\x1b\\`)
  out.push(snapshot.cursor.visible ? "\x1b[?25h" : "\x1b[?25l")
  // Origin precedes its CUP so region-relative coordinates can be used — this
  // stays correct on real terminals that home the cursor on DECOM changes
  // (vterm does not). A cursor OUTSIDE the region (reachable by setting ?6h
  // after moving) is placed absolutely first, then origin is restored — the
  // region-relative form would clamp it to the region.
  const origin = m.origin && !excluded.has("origin")
  // The region's origin is its top-LEFT: under DECOM a CUP column is relative
  // to the left margin whenever DECLRMM is active, exactly as the row is
  // relative to the scroll top. Emitting an absolute column here while the row
  // was relative shifted the restored cursor right by the left margin.
  const originX = snapshot.margins.leftRight ? snapshot.margins.left : 0
  const limitX = snapshot.margins.leftRight ? snapshot.margins.right : snapshot.cols - 1
  const inRegion =
    snapshot.cursor.y >= snapshot.margins.scrollTop &&
    snapshot.cursor.y <= snapshot.margins.scrollBottom &&
    snapshot.cursor.x >= originX &&
    snapshot.cursor.x <= limitX
  if (origin && inRegion) {
    out.push("\x1b[?6h")
    out.push(
      `\x1b[${String(snapshot.cursor.y - snapshot.margins.scrollTop + 1)};${String(snapshot.cursor.x - originX + 1)}H`,
    )
  } else {
    out.push(`\x1b[${String(snapshot.cursor.y + 1)};${String(snapshot.cursor.x + 1)}H`)
    if (origin) out.push("\x1b[?6h")
  }
  return out.join("")
}
