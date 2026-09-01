# vterm

VT terminal emulator monorepo. Pure TypeScript, zero dependencies.

## Packages

| Package                     | npm                                                  | Description                                                                      |
| --------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| [vt100.js](packages/vt100/) | [`vt100.js`](https://www.npmjs.com/package/vt100.js) | Strict VT100 — monochrome, cursor, scroll regions, DA1/DSR                       |
| [vt220.js](packages/vt220/) | [`vt220.js`](https://www.npmjs.com/package/vt220.js) | VT220 — 8 colors, insert/delete, selective erase, soft reset                     |
| [vterm.js](packages/vterm/) | [`vterm.js`](https://www.npmjs.com/package/vterm.js) | Modern terminal emulator — 100% of [terminfo.dev](https://terminfo.dev) features |

## Why three packages?

**vt100.js** is the strict baseline — a monochrome DEC VT100 (1978) emulator with bold, underline, blink, and inverse. No colors, no insert/delete operations. Fast and minimal.

**vt220.js** adds what VT220 brought — 8 standard colors, insert/delete characters and lines, selective erase, hidden/conceal attribute, and soft reset. Covers ~90% of real-world terminal usage.

**vterm.js** is comprehensive — it targets 100% coverage of the [terminfo.dev feature matrix](https://terminfo.dev): every SGR attribute, every cursor mode, every DEC private mode, every OSC/DCS sequence, device attribute responses, mouse tracking, synchronized output, text reflow, and Unicode rendering (emoji ZWJ, regional indicators, variation selectors).

Use vt100.js for strict VT100 conformance. Use vt220.js for most terminal testing. Use vterm.js when you need everything.

## Install

```bash
npm install vt100.js    # Strict VT100 emulator (monochrome)
npm install vt220.js    # VT220 emulator (8 colors, insert/delete)
npm install vterm.js    # Modern full-featured emulator
```

## Quick Start

```typescript
import { createVt100Screen } from "vt100.js"

const screen = createVt100Screen({ cols: 80, rows: 24 })
screen.process(new TextEncoder().encode("Hello, \x1b[1mBold\x1b[0m World!"))
console.log(screen.getText()) // "Hello, Bold World!"
```

```typescript
import { createVtermScreen } from "vterm.js"

const screen = createVtermScreen({ cols: 80, rows: 24 })
screen.process(new TextEncoder().encode("\x1b[1;4:3;38;2;255;100;0mStyled\x1b[0m"))
const cell = screen.getCell(0, 0)
// cell.bold === true, cell.underline === "curly", cell.fg === { r: 255, g: 100, b: 0 }
```

## Development

```bash
npm install
npm test          # Run all tests
npm run typecheck # TypeScript check
```

## How it connects

These are libraries, not applications: bytes in, a queryable screen out. Nothing here opens a PTY, keeps a clock, or writes a file. Everything downstream is a different **read** of the same screen.

```text
bytes            a live PTY, a test fixture, or a stored session
  ↓
vterm.js         the screen model — parse, cells, cursor, modes
  ↓
snapshot()       a serializable value: the whole screen at one instant
  ↓
consumers        assert on it · render it · store it as a restore keyframe
```

Read each arrow as *hands a value to*, not as *depends on*. The emulator never learns which of the three byte sources it is being fed, and that is the property the layers above are built on.

**A test harness wraps a screen as a backend.** [Termless](https://termless.dev) implements its `TerminalBackend` interface over `createVtermScreen`, which is what lets its region selectors and matchers query a vterm.js screen the same way they query xterm.js, Ghostty, or Alacritty. See the [backend guide](https://termless.dev/guide/backends).

**A session recorder wraps a snapshot as a checkpoint.** `screen.snapshot()` returns a plain serializable value, so a recorder can persist one periodically and replay only the bytes appended since — reconstructing any earlier instant without keeping every byte of the session. `screen.restore(snapshot)` is the way back in, `encodeScreenSnapshotBinary` / `decodeScreenSnapshotBinary` the compact on-disk form, and `serializeSnapshot` (state → minimal ANSI) the same seam for consumers that want text rather than cells.

That makes the snapshot shape a **durable format, not just an in-memory type**. Snapshots are written to disk by callers this repo never sees. A field whose meaning changes silently invalidates every checkpoint already on disk, so a snapshot change is a compatibility decision — introduce a new field, never redefine an existing one.

**Scrubbing to a past instant asks this library for nothing new.** "What did that screen look like at 14:02" decomposes into exactly two calls a caller already has: `restore()` the nearest checkpoint, then `process()` the bytes recorded between then and 14:02. There is no history mode, no seek, and no clock here — the timeline belongs to the caller. That is deliberate: a live read and a historical read are the same call sequence, so they cannot drift apart, and a bug in one is a bug in both.

**One engine, many oracles.** vt100.js and vt220.js are conformance tiers of one lineage, not alternatives to run in production — they exist so a strict-VT100 or VT220 claim can be tested against an emulator that genuinely refuses everything newer. Downstream, only vterm.js is meant to be the screen model an application actually runs. Other emulators stay reachable through Termless as **differential oracles** — a second opinion when a case disagrees — never as a second engine to maintain. Two screen models mean two sets of bugs and two places to fix each one.

**How the engine is graded.** The differential conformance corpus lives in Termless: cases mined from other emulators' own MIT-licensed test suites — [Ghostty](https://github.com/ghostty-org/ghostty)'s inline Zig unit tests, [neovim's libvterm](https://github.com/neovim/libvterm) reference suite — run against every registered backend, and the resulting terminal states are diffed. A divergence is either a bug here or an entry in a `known-gaps.json` ledger that ratchets both ways: an un-ledgered failure fails the build, and a ledgered gap that starts passing fails too, until someone removes the entry. Grading goes through the ordinary `TerminalBackend` seam, so there is no test-only door into this emulator — a passing grade is evidence about the code that ships. Details: [conformance corpus](https://termless.dev/advanced/conformance-corpus).

## Ecosystem

- [Termless](https://termless.dev) — headless terminal testing (uses vt100.js as default backend)
- [Terminfo.dev](https://terminfo.dev) — terminal feature support tables (tests both packages)
- [Silvery](https://silvery.dev) — React TUI framework

## License

MIT
