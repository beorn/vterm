# vt100.js

Pure TypeScript VT100 terminal emulator. Zero dependencies, headless, fast.

Part of the [vterm](https://github.com/beorn/vterm) monorepo.

## Features

- Full VT100/ANSI escape sequence parsing
- SGR attributes (bold, italic, underline styles, colors, strikethrough, etc.)
- 16-color, 256-color, and 24-bit truecolor support
- Cursor movement, save/restore (DECSC/DECRC)
- Screen modes (alternate screen, auto-wrap, origin mode, etc.)
- Scroll regions (DECSTBM) with content preservation
- Scrollback buffer with configurable limit
- Insert/delete characters and lines
- Wide character support (CJK, emoji)
- Zero dependencies — works in Bun, Node.js, and browsers

## Install

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

| Method                         | Description                        |
| ------------------------------ | ---------------------------------- |
| `process(data: Uint8Array)`    | Feed raw terminal data             |
| `getText()`                    | Get all text (scrollback + screen) |
| `getTextRange(sr, sc, er, ec)` | Get text in a range                |
| `getLine(row)`                 | Get cells for a row                |
| `getCell(row, col)`            | Get a single cell                  |
| `getCursorPosition()`          | Get cursor `{ x, y }`              |
| `getCursorVisible()`           | Check cursor visibility            |
| `getMode(mode)`                | Check terminal mode                |
| `getTitle()`                   | Get window title                   |
| `getScrollbackLength()`        | Number of scrollback lines         |
| `getViewportOffset()`          | Current viewport scroll offset     |
| `scrollViewport(delta)`        | Scroll viewport                    |
| `resize(cols, rows)`           | Resize terminal                    |
| `reset()`                      | Reset to initial state             |

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
  strikethrough: boolean
  inverse: boolean
  hidden: boolean
  wide: boolean
}
```

## See also

- [vterm.js](../vterm/) — full-featured modern emulator (100% terminfo.dev coverage)
- [Termless](https://termless.dev) — headless terminal testing
- [Terminfo.dev](https://terminfo.dev) — terminal feature support tables

## License

MIT
