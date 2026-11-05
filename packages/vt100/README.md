# vt100.js

Pure TypeScript VT100 terminal emulator. Zero dependencies, headless, fast.

Part of the [vterm](https://github.com/beorn/vterm) monorepo.

## Features

- Strict DEC VT100 (1978) emulation — monochrome display
- SGR operands: reset (0), bold (1), underline (4), blink (5), inverse (7)
- Cursor movement (CUP, CUU, CUD, CUF, CUB, HVP)
- Cursor save/restore (DECSC/DECRC)
- Erase display/line (ED/EL)
- Scroll regions (DECSTBM) with content preservation
- Index/reverse index/next line (IND/RI/NEL)
- Scrollback buffer with configurable limit
- Screen modes (auto-wrap, origin mode)
- DEC special graphics charset
- DA1/DSR/CPR device responses
- Zero dependencies — works in Bun, Node.js, and browsers

Unsupported controls are ignored, including CHA/VPA/CNL/CPL, CSI s/u,
SU/SD, ED 3, DECTCEM and XTWINOPS. OSC strings are consumed without setting
a title. SGR 22/24/25/27 do not reset attributes; use SGR 0.

## Install

> Install from npm; a git install resolves the TypeScript source and runs only under Bun.

```bash
npm install vt100.js
```

## Usage

```typescript
import { createVt100Screen } from "vt100.js"

const screen = createVt100Screen({ cols: 80, rows: 24 })
screen.process(new TextEncoder().encode("Hello, \x1b[1mBold\x1b[0m World!"))

console.log(screen.getText()) // "Hello, Bold World!"
console.log(screen.getCell(0, 7).bold) // true
console.log(screen.getCursorPosition()) // { x: 18, y: 0 }
```

## API

### `createVt100Screen(options)`

| Option            | Type     | Default  | Description          |
| ----------------- | -------- | -------- | -------------------- |
| `cols`            | `number` | required | Terminal width       |
| `rows`            | `number` | required | Terminal height      |
| `scrollbackLimit` | `number` | `1000`   | Max scrollback lines |

### Screen methods

| Method                         | Description                           |
| ------------------------------ | ------------------------------------- |
| `process(data: Uint8Array)`    | Feed raw terminal data                |
| `encodePaste(text: string)`    | Return native paste as UTF-8 bytes    |
| `getText()`                    | Get all text (scrollback + screen)    |
| `getTextRange(sr, sc, er, ec)` | Get text in a range                   |
| `getLine(row)`                 | Get cells for a row                   |
| `getCell(row, col)`            | Get a single cell                     |
| `getCursorPosition()`          | Get cursor `{ x, y }`                 |
| `getCursorVisible()`           | Check cursor visibility               |
| `getMode(mode)`                | Check terminal mode                   |
| `getTitle()`                   | Always empty (no VT100 title surface) |
| `getScrollbackLength()`        | Number of scrollback lines            |
| `getViewportOffset()`          | Current viewport scroll offset        |
| `scrollViewport(delta)`        | Scroll viewport                       |
| `resize(cols, rows)`           | Resize terminal                       |
| `reset()`                      | Reset to initial state                |
| `getUnhandledSequences()`      | Copy ignored OSC identifiers and SGR operands |

### Ignored-sequence reports

`getUnhandledSequences()` returns copied, ordered `{ kind: "osc" | "csi", code: string }`
entries. OSC reports contain only the decimal command number after a complete BEL
or ST terminator, never its payload. Ignored SGR operands contain their native
decimal value and `m`, such as `3m`. Codes must be non-negative safe integers.
Colon groups, invalid or oversized numbers, incomplete/overflowed OSC strings and
malformed terminators produce no entry. Missing entries prove no support outcome.

This is an operand report, not a copy of input syntax. The existing SGR parser also
receives prefixed input: `CSI > 4 ; 2 m` reports `2m`; partial numeric parsing such
as `CSI 3 $ m` reports `3m`. Reporting does not change how that input is handled.

History keeps at least the most recent 1000 entries. When it grows past 2000, it
drops the oldest entries back to 1000. Each getter result copies its entries;
`reset()` and RIS clear history, while SGR 0 does not. A new screen starts empty.

### Paste input

`screen.encodePaste(text)` returns a `Uint8Array` without processing text,
changing screen state, or calling `onResponse`. The caller delivers these
bytes to the application.

Mode 2004 is not implemented: paste is never framed, including after
`CSI ? 2004 h`. `getMode("bracketedPaste")` returns `false`. All text is
preserved as UTF-8, including embedded escape sequences and framing markers.
LF, CR and CRLF pass through unchanged; LNM never changes paste bytes.

### Cell properties

```typescript
interface ScreenCell {
  char: string
  fg: CellColor | null // always null (VT100 is monochrome)
  bg: CellColor | null // always null (VT100 is monochrome)
  bold: boolean
  underline: boolean
  blink: boolean
  inverse: boolean
  hidden: boolean
}
```

## See also

- [vterm.js](../vterm/) — full-featured modern emulator (100% terminfo.dev coverage)
- [Termless](https://termless.dev) — headless terminal testing
- [Terminfo.dev](https://terminfo.dev) — terminal feature support tables

## License

MIT
