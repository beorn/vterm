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
- **OSC sequences** — window title (OSC 0/2), hyperlinks (OSC 8), clipboard (OSC 52), colors
- **DCS sequences** — consumed and ignored, XTVERSION response
- **Device attributes** — DA1/DA2/DA3 responses
- **Device status reports** — DSR responses
- **Mode reporting** — DECRPM
- **Character sets** — DEC Special Graphics (box drawing), UTF-8
- **Soft terminal reset** — DECSTR
- **Scrollback buffer** with configurable limit
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

## API

### `createVtermScreen(options)`

| Option            | Type                     | Default | Description                        |
| ----------------- | ------------------------ | ------- | ---------------------------------- |
| `cols`            | `number`                 | `80`    | Terminal width                     |
| `rows`            | `number`                 | `24`    | Terminal height                    |
| `scrollbackLimit` | `number`                 | `1000`  | Max scrollback lines               |
| `onResponse`      | `(data: string) => void` | —       | Callback for DA1/DA2/DSR responses |

### Screen methods

| Method                         | Description                                            |
| ------------------------------ | ------------------------------------------------------ |
| `process(data: Uint8Array)`    | Feed raw terminal data                                 |
| `getText()`                    | Get all text (scrollback + screen)                     |
| `getTextRange(sr, sc, er, ec)` | Get text in a range                                    |
| `getLine(row)`                 | Get cells for a row                                    |
| `getCell(row, col)`            | Get a single cell                                      |
| `getCursorPosition()`          | Get cursor `{ x, y }`                                  |
| `getCursorVisible()`           | Check cursor visibility                                |
| `getCursorShape()`             | Get cursor shape: `"block"`, `"underline"`, or `"bar"` |
| `getCursorBlinking()`          | Check if cursor is blinking                            |
| `getMode(mode)`                | Check terminal mode                                    |
| `getTitle()`                   | Get window title                                       |
| `getScrollbackLength()`        | Number of scrollback lines                             |
| `getViewportOffset()`          | Current viewport scroll offset                         |
| `scrollViewport(delta)`        | Scroll viewport                                        |
| `resize(cols, rows)`           | Resize terminal                                        |
| `reset()`                      | Reset to initial state                                 |

### Cell properties

```typescript
interface ScreenCell {
  char: string
  fg: CellColor | null // { r, g, b }
  bg: CellColor | null
  bold: boolean
  faint: boolean
  italic: boolean
  underline: "none" | "single" | "double" | "curly" | "dotted" | "dashed"
  underlineColor: CellColor | null
  overline: boolean
  strikethrough: boolean
  inverse: boolean
  hidden: boolean
  blink: boolean
  wide: boolean
  url: string | null // OSC 8 hyperlink
}
```

## vs vt100.js

| Feature                                      | vt100.js | vterm.js |
| -------------------------------------------- | -------- | -------- |
| SGR basics (bold, italic, underline, colors) | Yes      | Yes      |
| Underline styles (curly, dotted, dashed)     | Yes      | Yes      |
| Underline color                              | No       | Yes      |
| Blink, overline                              | No       | Yes      |
| Cursor shapes (DECSCUSR)                     | No       | Yes      |
| OSC 8 hyperlinks                             | No       | Yes      |
| DA1/DA2/DA3 responses                        | No       | Yes      |
| DSR/DECRPM responses                         | No       | Yes      |
| Mouse tracking                               | No       | Yes      |
| Focus tracking                               | No       | Yes      |
| Synchronized output                          | No       | Yes      |
| DEC Special Graphics                         | No       | Yes      |
| REP (repeat character)                       | No       | Yes      |
| DECSTR (soft reset)                          | No       | Yes      |
| DCS sequences                                | No       | Yes      |
| Package size                                 | Smaller  | Larger   |

**Use vt100.js** when you want fast and simple — it covers ~90% of real-world terminal usage.

**Use vterm.js** when you need everything — 100% coverage of the [terminfo.dev](https://terminfo.dev) feature matrix.

## See also

- [vt100.js](../vt100/) — VT100-era emulator (smaller, focused)
- [Termless](https://termless.dev) — headless terminal testing
- [Terminfo.dev](https://terminfo.dev) — terminal feature support tables

## License

MIT
