# vterm.js

Modern terminal emulator — full VT/ECMA-48/xterm standards coverage. Pure TypeScript, zero dependencies.

Part of the [vterm](https://github.com/beorn/vterm) monorepo.

## Features

- **All SGR attributes** — bold, faint, italic, blink, overline, strikethrough, inverse, hidden
- **Underline styles** — single, double, curly, dotted, dashed (SGR 4:0–4:5)
- **Full color support** — 16-color, 256-color, 24-bit truecolor for foreground, background, and underline
- **Cursor shapes** — block, underline, bar with blinking variants (DECSCUSR)
- **Cursor control** — CUP, CUU/CUD/CUF/CUB, CHA, CNL, CPL, HVP, save/restore (DECSC/DECRC)
- **Erase operations** — ED 0/1/2/3, EL 0/1/2, ECH
- **Editing operations** — ICH, DCH, IL, DL, REP (repeat last character)
- **Scroll regions** — DECSTBM, SU, SD with content preservation
- **DEC private modes** — alternate screen, auto-wrap, origin, insert, reverse video, bracketed paste
- **Mouse tracking** — X10, normal, button, any-event, SGR format
- **Focus tracking** — mode 1004
- **Synchronized output** — mode 2026
- **Application cursor keys & keypad**
- **Kitty keyboard protocol** — progressive-enhancement flags with a push/pop/set stack (`CSI u`)
- **OSC sequences** — window title (OSC 0/2), hyperlinks (OSC 8), clipboard (OSC 52), colors
- **DCS sequences** — consumed and ignored, XTVERSION response
- **Device attributes** — DA1/DA2/DA3 responses
- **Device status reports** — DSR responses
- **Mode reporting** — DECRPM
- **Character sets** — DEC Special Graphics (box drawing), UTF-8
- **Soft terminal reset** — DECSTR
- **Scrollback buffer** with configurable limit
- **State serialization** — binary `snapshot()`/`restore()` for exact state, `serialize()`/`serializeSnapshot()` for a minimal-ANSI projection any VT-compatible terminal can replay
- **Wide character support** — CJK, emoji ZWJ sequences, regional indicators, VS-16
- **Full C0/C1 control code handling**
- **Zero dependencies** — works in Bun, Node.js, and browsers

## Install

```bash
npm install vterm.js
```

## Usage

### Basic

```typescript
import { createVtermScreen } from "vterm.js"

const screen = createVtermScreen({ cols: 80, rows: 24 })
screen.process(new TextEncoder().encode("Hello, \x1b[1mBold\x1b[0m World!"))

console.log(screen.getText()) // "Hello, Bold World!"
console.log(screen.getCell(0, 7).bold) // true
```

### Cursor shapes

```typescript
// Set cursor to blinking bar
screen.process(new TextEncoder().encode("\x1b[5 q"))
console.log(screen.getCursorShape()) // "bar"
console.log(screen.getCursorBlinking()) // true
```

### Hyperlinks (OSC 8)

```typescript
screen.process(new TextEncoder().encode("\x1b]8;;https://example.com\x1b\\Click here\x1b]8;;\x1b\\"))
console.log(screen.getCell(0, 0).url) // "https://example.com"
```

### Device attribute responses

```typescript
const screen = createVtermScreen({
  cols: 80,
  rows: 24,
  onResponse: (data) => {
    // Write response back to PTY
    pty.write(data)
  },
})

// When the screen receives DA1 (\x1b[c), it calls onResponse
// with the appropriate response string
```

### Extended SGR

```typescript
// Bold + curly underline + truecolor orange foreground + underline color
screen.process(new TextEncoder().encode("\x1b[1;4:3;38;2;255;100;0;58;2;0;150;255mStyled\x1b[0m"))

const cell = screen.getCell(0, 0)
console.log(cell.bold) // true
console.log(cell.underline) // "curly"
console.log(cell.fg) // { r: 255, g: 100, b: 0 }
console.log(cell.underlineColor) // { r: 0, g: 150, b: 255 }
```

### Kitty keyboard

Progressive keyboard enhancement (the Kitty protocol) is negotiated through a flags stack:

```typescript
screen.process(new TextEncoder().encode("\x1b[>1u")) // push: save current flags, install flags=1
screen.process(new TextEncoder().encode("\x1b[<u")) //  pop: restore the previously pushed flags
screen.process(new TextEncoder().encode("\x1b[=5;2u")) // set: OR flags=5 into the live flags
```

- **push** — `CSI > flags u` saves the current flags on the stack, then installs `flags`
- **pop** — `CSI < u` restores the flags at the top of the stack (empty stack → `0`)
- **set** — `CSI = flags ; mode u` writes directly without touching the stack: mode `1` (or omitted) assigns, `2` ORs the given bits in, `3` clears them

The flags and their stack survive `snapshot()`/`restore()`, and `serialize()` reconstructs any `(flags, stack)` pair by seeding the stack bottom with one set (`CSI = u`), replaying the remaining stack entries as pushes (`CSI > u`), and landing on the live flags with a final push.

### Serialize (state → ANSI)

```typescript
import { createVtermScreen, serializeSnapshot } from "vterm.js"

const screen = createVtermScreen({ cols: 80, rows: 24 })
screen.process(new TextEncoder().encode("Hello, \x1b[1;32mBold Green\x1b[0m World!"))

// Re-encode current state as minimal ANSI a fresh same-size terminal can replay
const ansi = screen.serialize()
// Equivalent when you already hold a snapshot object:
// const ansi = serializeSnapshot(screen.snapshot())

const restored = createVtermScreen({ cols: 80, rows: 24 })
restored.process(new TextEncoder().encode(ansi))
console.log(restored.getText()) // "Hello, Bold Green World!" — text and styles both survived
```

`serialize(options?)` walks scrollback and the visible screen and emits a minimal SGR/mode/cursor stream that a fresh same-size terminal can replay: the pending pen at the cursor, DECAWM/insert/origin/reverse/app-cursor/app-keypad/bracketed/mouse/focus modes, margins, alt-screen, and cursor shape all survive the round trip. `SerializeOptions` toggles `includeScrollback` (default `true`), `includeTitle` (default `false`), `hyperlinks` (default `true`), and `excludeModes` (an array of mode keys to skip, leaving the receiver's fresh default for those). Two exclusions are always enforced and cannot be toggled off: synchronized-output mode (`?2026`) and DECCOLM (`?3`) are never emitted, since replaying either would wedge or wipe a real receiver. The inactive screen buffer, DECSC saved-cursor state, the color stack, and mid-parse parser state aren't representable in a VT byte stream and stay unserialized by design — use the binary `snapshot()`/`restore()` pair, or raw byte replay, when those need to cross too.

**Phase order.** The emit stream is five ordered phases: **history** (scrollback flushed via CRLF, since CUP cannot address it) → **geometry** (`?1049h` alt-enter and the DECSTBM scroll region — both home the cursor) → **paint-safe modes** (DECSET set-forms only, mouse, kitty keyboard, palette/default colors, optional title) → **paint** (DECAWM off, `CSI H` home + `CSI 2J` clear, then positioned pen-diff rows) → **finalize** (autowrap, cursor shape, charset, insert, tab stops, DECSLRM, pending pen, visibility, cursor). Two constraints are load-bearing: **no geometry op may follow the cursor** (all homing must precede the paint), and the **cursor is restored last** — emitted region-relative (`?6h` origin then a margin-relative `CSI H`) when origin mode is set and the target lies inside the scroll region, absolute otherwise. `?2026` (synchronized output) and `?3` (DECCOLM) are never emitted — replaying either would wedge or wipe a live receiver.

**Soft-wrap history.** `Snapshot` carries `scrollbackSoftWrapped: boolean[]` alongside `scrollback` — bit `i` true means scrollback row `i` wraps into row `i+1` (one logical line split across rows); an absent array (older stored v1 snapshots) is treated as all-false. Phase-1 history re-links a wrapped row by emitting it at full width with no line break, so the receiver's own autowrap re-records the bit as the row scrolls back.

### Ops and taps

`apply(op)` is the single public write entry — the same seam a session journal records and replays. An op is coarse, serializable data; **bytes stay the canonical encoding** (an `output` op is just bytes, deterministically re-parsed on replay — vterm never reifies a per-VT-action op):

```typescript
type TerminalOp =
  | { type: "output"; data: Uint8Array | string } // routes to process() — a string is UTF-8-encoded first
  | { type: "resize"; cols: number; rows: number } // routes to resize()
```

`apply()` is additive over `process()`/`resize()`, which remain public. Two opt-in taps observe the write stream without changing it:

- **`tapOps(listener): () => void`** — the listener fires **once per applied op** (one per `process`/`apply`/`resize` call), with the canonical payload (an `output` op always carries a `Uint8Array`, even when a string was passed to `apply()`). This is the journaling seam.
- **`tapParser(listener): () => void`** — the listener fires **once per parsed VT action, AFTER the engine applies it, in stream order**. Consecutive printable graphemes coalesce into one `print` event (flushed before any control event and at end-of-flood):

```typescript
type ParserEvent =
  | { kind: "print"; text: string }
  | { kind: "execute"; code: number } // a C0 control byte (BEL/BS/HT/LF/VT/FF/CR)
  | { kind: "csi"; final: string; params: number[]; prefix?: string; intermediates?: string }
  | { kind: "osc"; code: number; data: string }
  | { kind: "esc"; final: string; intermediates?: string }
```

Both taps return an **unsubscribe** function, and both are **zero-overhead when unused** — no event object is allocated on the byte-flood path unless a listener is registered. Taps are **fail-loud**: a listener MUST NOT throw; if it does, the exception propagates out of the write call and the engine is left in a consistent state (never wedged mid-sequence). For CSI, `params` uses the engine's own top-level parse (`;`-split, empty → `0`; colon sub-parameters collapse to their leading integer); `prefix` is the private marker (`?`/`>`/`<`/`=`) when present. DCS and APC string sequences are not surfaced as parser events.

```typescript
import { createVtermScreen, type TerminalOp, type ParserEvent } from "vterm.js"

const screen = createVtermScreen({ cols: 80, rows: 24 })

// Journal every write; re-applying the log onto a fresh screen reproduces the state exactly.
const journal: TerminalOp[] = []
const stopJournal = screen.tapOps((op) => journal.push(op))

// Mirror the window title without polling for it.
let title = ""
const stopTitle = screen.tapParser((ev: ParserEvent) => {
  if (ev.kind === "osc" && (ev.code === 0 || ev.code === 2)) title = ev.data
})

screen.apply({ type: "output", data: "\x1b]0;build passing\x07\x1b[1mhi\x1b[0m" })
console.log(title) // "build passing" — set the moment the OSC was applied

stopJournal()
stopTitle()

const replay = createVtermScreen({ cols: 80, rows: 24 })
for (const op of journal) replay.apply(op)
console.log(replay.serialize() === screen.serialize()) // true
```

### Signals — the reactive read plane

`screen.signals` is the third read plane (alongside the pull plane — `getRowAbsolute`/`takeDirty` — and the push plane — `tapOps`/`tapParser`). Five equality-gated **read-signals** turn "poll the engine every frame" into "subscribe and get told when it changes" — they exist to replace a guest's title-diff polling and its DECSET regex scanning:

| Signal    | Value           | Fires when                                                                                                                           |
| --------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `title$`  | `string`        | the window title (OSC 0/2) changes                                                                                                   |
| `modes$`  | `TerminalModes` | any DEC/xterm mode flips (alt screen, cursor visibility, bracketed paste, mouse tracking + protocol level, focus, origin, insert, …) |
| `cursor$` | `Cursor`        | the cursor `{ col, row }` moves                                                                                                      |
| `size$`   | `Size`          | the screen is resized                                                                                                                |
| `damage$` | `DirtyRegion`   | every flush, with that flush's BATCHED dirty rows                                                                                    |

Each signal is a minimal, dependency-free shape — vterm.js imports no reactive library, so the interface is exactly:

```typescript
interface ReadSignal<T> {
  get(): T // the CURRENT value, read live — never consumes or resets a delivery
  subscribe(listener: (value: T) => void): () => void // returns an unsubscribe function
}
```

A consumer wraps it in `alien-signals`, a zustand store, or React's `useSyncExternalStore` trivially, precisely because the shape is just `{ get, subscribe }`.

**Flush boundary.** Every signal coalesces to **at most one emission per public state-mutating call** (`process` / `apply` / `resize` / `reset` / `restore`; `apply` inherits it via `process`/`resize`). Ten mode flips in one `process()` call deliver **one** `modes$` emission carrying the final set; a paint touching twenty rows delivers **one** `damage$` batch with the union of rows.

**Change-only.** `title$`/`modes$`/`cursor$`/`size$` deliver only when their value actually changed across the call (equality-gated). Subscribing captures the current value as its baseline and does **not** fire immediately — only later changes deliver.

**`damage$` vs `takeDirty()` — two independent epochs.** `damage$` publishes the same `DirtyRegion` shape as `takeDirty()`, but runs on its **own** accumulator. Subscribing to `damage$` never steals or resets the pull-plane `takeDirty()` epoch, so a `damage$` renderer and a `takeDirty()` differ observe the same damage without draining each other. The emitted region (including its `rows` `Set`) is **shared** across all `damage$` subscribers for that flush — treat it as read-only.

**Zero overhead when unused.** Nothing is allocated until `.signals` is first read, each signal is created lazily on first access, and the write core does **no** per-write damage accumulation until `damage$` actually has a subscriber. Listeners are **fail-loud** (a throwing listener propagates out of the write call).

```typescript
import { createVtermScreen, type DirtyRegion, type TerminalModes } from "vterm.js"

const screen = createVtermScreen({ cols: 80, rows: 24 })

// Replace title polling: told the moment it changes, never on an equal value.
screen.signals.title$.subscribe((title) => setWindowTitle(title))

// Replace the DECSET regex scanner: the closed mode set, structured.
screen.signals.modes$.subscribe((m: TerminalModes) => {
  if (m.altScreen) enterAltScreen()
  useMouse(m.mouseTracking, m.mouseTrackingMode, m.sgrMouse)
})

// Frame-batched repaint: one dirty-set per flush, coexisting with any takeDirty() differ.
screen.signals.damage$.subscribe((d: DirtyRegion) => {
  if (d.rows === "all") repaintEverything()
  else for (const row of d.rows) repaintRow(row)
  if (d.cursor) repaintCursor()
})
```

## Naming

The public vocabulary follows the terminal domain model (name the thing, not the mechanism; **row = cells, line = text**; flat progressive shapes over discriminated unions): `Color`, `Snapshot`, `getRow(row)`, `getCursor(): Cursor` (`Cursor` is `{ col, row }`). The pre-§9 names — `CellColor`, `ScreenSnapshot`/`VtermScreenSnapshot`, `getLine(row)`, `getCursorPosition(): {x,y}` — rode a deprecation window as `@deprecated` aliases and have since been deleted; they no longer compile.

**Deferred (not renamed):** the `Snapshot.cursor` / `Snapshot.savedState` fields keep `x`/`y` rather than `col`/`row`, because those field names are the wire shape read by `encodeScreenSnapshotBinary` — renaming them would silently change the persisted binary format. The `col`/`row` vocabulary is available at the read boundary via `getCursor()` / the `Cursor` type. The snapshot field rename is a codec-format concern for a coordinated schema bump.

## API

### `createVtermScreen(options)`

| Option            | Type                     | Default | Description                        |
| ----------------- | ------------------------ | ------- | ---------------------------------- |
| `cols`            | `number`                 | `80`    | Terminal width                     |
| `rows`            | `number`                 | `24`    | Terminal height                    |
| `scrollbackLimit` | `number`                 | `1000`  | Max scrollback lines               |
| `onResponse`      | `(data: string) => void` | —       | Callback for DA1/DA2/DSR responses |

### Screen methods

| Method                         | Description                                                                              |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| `process(data: Uint8Array)`    | Feed raw terminal data                                                                   |
| `apply(op: TerminalOp)`        | Apply one serializable write op (`output` / `resize`)                                    |
| `tapOps(listener)`             | Observe applied ops; returns unsubscribe                                                 |
| `tapParser(listener)`          | Observe parsed VT actions post-apply; returns unsubscribe                                |
| `signals`                      | Reactive read plane: `title$`/`modes$`/`cursor$`/`size$`/`damage$` (lazy, zero-overhead) |
| `getText()`                    | Get all text (scrollback + screen)                                                       |
| `getTextRange(sr, sc, er, ec)` | Get text in a range                                                                      |
| `getRow(row)`                  | Get cells for a screen row (row = cells, line = text)                                    |
| `getCell(row, col)`            | Get a single cell                                                                        |
| `getCursor()`                  | Get cursor `{ col, row }`                                                                |
| `getCursorVisible()`           | Check cursor visibility                                                                  |
| `getCursorShape()`             | Get cursor shape: `"block"`, `"underline"`, or `"bar"`                                   |
| `getCursorBlinking()`          | Check if cursor is blinking                                                              |
| `getMode(mode)`                | Check terminal mode                                                                      |
| `getTitle()`                   | Get window title                                                                         |
| `getScrollbackLength()`        | Number of scrollback lines                                                               |
| `getViewportOffset()`          | Current viewport scroll offset                                                           |
| `scrollViewport(delta)`        | Scroll viewport                                                                          |
| `totalRows()`                  | Buffer height: retained scrollback + screen                                              |
| `screenRows()`                 | Visible screen row count                                                                 |
| `viewportTop()`                | Absolute row where the viewport's top line sits                                          |
| `getRowAbsolute(row)`          | Cells at an ABSOLUTE row (0 = oldest retained line)                                      |
| `firstRetainedRow()`           | Global index of retained row 0 (lines trimmed so far)                                    |
| `takeDirty()`                  | Take + reset accumulated per-row damage (pull plane)                                     |
| `resize(cols, rows)`           | Resize terminal                                                                          |
| `reset()`                      | Reset to initial state                                                                   |
| `snapshot()`                   | Capture serializable T0-T3 terminal state                                                |
| `restore(snapshot)`            | Restore a snapshot captured from `snapshot()`                                            |
| `serialize(options?)`          | Re-encode current state as minimal ANSI a fresh same-size terminal can replay            |

### Cell properties

```typescript
interface ScreenCell {
  char: string
  fg: Color | null // { r, g, b, index? }
  bg: Color | null
  bold: boolean
  faint: boolean
  italic: boolean
  underline: "none" | "single" | "double" | "curly" | "dotted" | "dashed"
  underlineColor: Color | null
  overline: boolean
  strikethrough: boolean
  inverse: boolean
  hidden: boolean
  blink: boolean
  wide: boolean
  url: string | null // OSC 8 hyperlink
}
```

`ScreenCell` is a **read-boundary value** — it is materialized on demand, not how the grid
is stored. See below.

### Internal representation — packed cell grid

The engine stores the grid as **packed typed arrays**, not one heap object per cell. Each
row keeps a `Uint32Array` of metadata (boolean attributes + a 3-bit underline-style enum +
color/URL presence bits), a parallel `string[]` grapheme sidecar, and lazily-allocated
color planes: 24-bit packed RGB in a `Uint32Array` alongside the palette-origin index in an
`Int16Array`. Colors are therefore stored as primitives, so the byte-flood write path
allocates **nothing per cell** — no cell object and no color object. `ScreenCell` objects
materialize only at the read boundary (`getCell`, `getRow`, `getRowAbsolute`, `snapshot`,
`serialize`), and `Color` identity (`{ r, g, b, index? }`) is preserved end to end: an
indexed SGR keeps its origin `index` so `serialize()` re-emits the faithful indexed form
rather than baking truecolor.

The color planes are allocated on a row's first colored cell, so all-plain-text rows stay
lean (`meta` + `chars` only). OSC-8 URLs (rare) live in a sparse per-row `Map`. The public
contract is unchanged — reads, snapshots, ops/taps, and damage tracking behave identically
to the previous heap-object grid (the full existing test suite passes unchanged).

The encoding mirrors the shape of silvery's `ag-term` render buffer (packed `Uint32Array`
metadata + separate grapheme array) without importing it — vterm stays dependency-free.

**Throughput** (`bun tools/bench-packed-grid.ts`, vs the pre-packing heap-object grid):
`~1.3×` faster on both a 200k-line scroll flood and a large in-place repaint, at `~22%`
lower peak RSS (the write path no longer churns per-cell objects through the GC).

## Absolute rows and damage tracking

Two engine-native read planes over the buffer, for renderers that address the whole
history and repaint only what changed.

### Absolute rows

The buffer is the retained scrollback followed by the screen. **Absolute row 0 is the
oldest retained scrollback line**; the screen occupies the last `screenRows()` rows
(absolute `totalRows() - screenRows()` through `totalRows() - 1`). The existing
screen-relative reads (`getRow`, `getCell`) are unchanged — absolute addressing is
additive.

```typescript
screen.totalRows() // scrollback.length + screenRows()
screen.screenRows() // the terminal's row dimension
screen.getRowAbsolute(0) // Cell[] of the oldest retained line
screen.viewportTop() // absolute row of the viewport's top line
//   at the bottom → totalRows() - screenRows(); scrolled fully up → 0
```

Naming follows the ecosystem rule **row = cells, line = text**: `getRowAbsolute`
returns cells; colors are stripped of palette-origin index at the read boundary (same
contract as `getRow`). Out-of-range indices return a blank row.

**Stability contract.** As lines scroll IN, an existing scrollback row keeps its
absolute index (the screen shifts up in absolute terms, but its content keeps the same
absolute index because scrollback grows by exactly the shift). When retention trimming
evicts the oldest lines, every absolute index shifts down by the trimmed count and
`firstRetainedRow()` bumps by the same amount. `firstRetainedRow()` is the **global**
index of retained row 0 (the count of lines ever trimmed, `0` initially; reset by
`reset()` / `restore()`). A stable global id is `firstRetainedRow() + <absolute row>`;
an increase since a prior read signals a trim.

### Damage tracking (`takeDirty`)

`takeDirty()` returns the per-row damage accumulated since the previous call and resets
the epoch. It is the **pull-plane** surface — a renderer reads it on its own schedule,
independent of the push-plane `tapOps` / `tapParser`. Accumulation is always on; the
write path costs at most one `Set` membership update per row-run (no per-cell
allocation), and structural changes drop the set for the `"all"` sentinel.

```typescript
const { rows, cursor, scrolled } = screen.takeDirty()
```

| Field      | Type                   | Meaning                                                              |
| ---------- | ---------------------- | -------------------------------------------------------------------- |
| `rows`     | `Set<number> \| "all"` | Changed rows as ABSOLUTE indices, or `"all"` on structural change    |
| `cursor`   | `boolean`              | Cursor position / visibility / shape / blink changed since last take |
| `scrolled` | `number`               | Lines that entered scrollback since last take                        |

`rows` is `"all"` on resize, full clear (ED 2/3), alt-screen switch, `reset()`, and
`restore()`. The returned `Set` is **owned by the caller** — the engine keeps a fresh
empty accumulator after the take. On a normal scroll only the newly-blanked bottom row
is reported as changed (the other rows kept their absolute index) and `scrolled`
increments, so a scrollback-preserving renderer shifts its viewport by `scrolled` and
repaints just `rows`. `rows` indices are valid against the buffer at take time; if a
take spanned a trim (`firstRetainedRow()` increased), rebase any cached indices by the
delta.

The **reactive** counterpart is `signals.damage$` (see [Signals](#signals--the-reactive-read-plane)) — the same `DirtyRegion` shape delivered per-flush to subscribers. It runs on an accumulator **independent** of `takeDirty()`, so a push-style `damage$` renderer and a pull-style `takeDirty()` differ coexist without draining each other's epoch.

## vs vt100.js

| Feature                                   | vt100.js | vterm.js |
| ----------------------------------------- | -------- | -------- |
| Bold, underline (boolean), blink, inverse | Yes      | Yes      |
| Colors (8/256/truecolor)                  | No       | Yes      |
| Italic, faint, strikethrough, overline    | No       | Yes      |
| Underline styles (curly, dotted, dashed)  | No       | Yes      |
| Underline color                           | No       | Yes      |
| Wide characters (CJK, emoji)              | No       | Yes      |
| Cursor shapes (DECSCUSR)                  | No       | Yes      |
| Insert/delete characters and lines        | No       | Yes      |
| OSC 8 hyperlinks                          | No       | Yes      |
| DA1/DA2/DA3 responses                     | DA1 only | Yes      |
| DSR/DECRPM responses                      | No       | Yes      |
| Mouse tracking                            | No       | Yes      |
| Focus tracking                            | No       | Yes      |
| Synchronized output                       | No       | Yes      |
| DEC Special Graphics                      | Yes      | Yes      |
| REP (repeat character)                    | No       | Yes      |
| DECSTR (soft reset)                       | No       | Yes      |
| DCS sequences                             | No       | Yes      |
| Package size                              | Smaller  | Larger   |

**Use vt100.js** for strict VT100 conformance — monochrome, no colors, no insert/delete. Fast and minimal.

**Use vterm.js** when you need everything — 100% coverage of the [terminfo.dev](https://terminfo.dev) feature matrix.

## vterm.js and xterm.js

[xterm.js](https://www.npmjs.com/package/@xterm/xterm) is the standard for putting a terminal on a web page — DOM, canvas, and WebGL renderers, a large addon ecosystem, and the terminal inside VS Code. When the job is rendering a terminal to a human, reach for xterm.js. We do: [Termless](https://termless.dev)'s own `@termless/web-player`, which plays back recorded terminal sessions in the browser, is built directly on `@xterm/xterm`.

vterm.js is for the opposite case: nothing ever gets painted. It's headless-first — the terminal as a **readable data structure**, not a rendered surface. Zero dependencies, pure TypeScript, full VT/ECMA-48/xterm standards coverage, a binary snapshot codec for exact state capture, a reactive read plane (`screen.signals`), absolute-row scrollback addressing, and semantic-zone detection (OSC 133 / OSC 633 prompt/command/output). That combination is aimed at testing, session recording, audit trails, and AI-agent infrastructure — consumers that need to know exactly what a terminal contains without ever drawing it.

Because vterm.js makes no display claims, it's held to a stricter standard instead: engine conformance, graded publicly and continuously in [Termless](https://termless.dev)'s differential conformance corpus against xterm.js, Ghostty, and neovim's libvterm. Current per-engine results and every known gap live in the ratchet ledger (`known-gaps.json`) — it's two-way: an unlisted failure fails the build, and a listed gap that starts passing fails too. Full results are public at [termless.dev/advanced/conformance-corpus](https://termless.dev/advanced/conformance-corpus).

## Deliberate divergences

A handful of behaviours where vterm.js knowingly differs from neovim's
libvterm, the reference implementation the conformance corpus is mined from.
Each was ruled deliberately rather than left as a gap, so **100% conformance
for vterm.js means 126/128 plus these documented divergences** — not 128.

Each entry names the _override word_ that would reverse the ruling. If you need
the other behaviour, open an issue with that word and the reason; it is the
argument, not the preference, that would move it.

### Cursor follows reflow when a resize shrinks below it

Shrinking the terminal past the cursor's column carries the cursor with its
line through the rewrap. libvterm, xterm.js and vt100.js instead clamp it to
the last column of the row it was on.

Following the line is what a reflowing terminal does — the cursor stays with
the text a user was typing, rather than jumping to wherever that text used to
end. Clamping is the pre-reflow behaviour the other three inherit from a
shared ancestry, and three engines agreeing about their own history is not an
argument about which is correct. Both ends of our own record/replay path read
vterm.js, so there is no internal disagreement to resolve.

**Override word: `clamp`.**

### RIS clears the scrollback

A full reset (`ESC c`) discards scrollback along with the screen. libvterm
preserves it, so history banked before a reset can still be scrolled back to —
and can even be popped back onto the screen by a later resize.

Every other engine in the corpus — xterm.js, Ghostty and vt100.js — clears on
RIS, as does xterm itself. A reset that leaves history behind surprises the
common case, where `reset` is reached for precisely to get a clean terminal.

**Override word: `match-ris`.**

### Related: the deferred-wrap cursor

Not an excluded case, but the same family and worth knowing if you read the
cursor. When a glyph fills the last column with autowrap on, the terminal owes
a wrap it has not performed. vterm.js represents that as the cursor sitting at
`col == cols` — one past the last column — as xterm.js and vt100.js do.
libvterm and Ghostty instead keep the cursor _on_ the last column and carry a
separate pending-wrap flag. The corpus normalizes this rather than excluding
it, so those cases pass; consumers reading `cursor.col` should simply expect
the `col == cols` form.

These entries mirror the corpus-side table in the suite's own README and the
machine-readable reasons in `known-gaps.json`. A new ruling lands in all three
at once.

## See also

- [vt100.js](../vt100/) — VT100-era emulator (smaller, focused)
- [Termless](https://termless.dev) — headless terminal testing
- [Terminfo.dev](https://terminfo.dev) — terminal feature support tables

## License

MIT
