# vterm — VT Terminal Emulator Monorepo

Pure TypeScript VT terminal emulators. Zero dependencies. Three packages at different abstraction levels.

## Packages

### vt100.js (`packages/vt100/`)

Strict DEC VT100 (1978) emulator. Monochrome — no colors, no insert mode, no insert/delete chars/lines. The baseline.

- **Exports**: `createVt100Screen`, `Vt100Screen`, `Vt100ScreenOptions`, `ScreenCell`, `CellColor`
- **Capabilities**: SGR (bold, underline, blink, reverse — monochrome only), cursor movement (CUP/CUU/CUD/CUF/CUB/CHA/CNL/CPL/HVP/VPA), erase (ED/EL), scroll regions (DECSTBM), scroll up/down (SU/SD), DECSC/DECRC, DECAWM, DECOM, DECCKM, DECKPAM/DECKPNM, DA1/DSR/CPR, RIS, NEL/IND/RI, OSC title, scrollback buffer
- **Not in VT100**: colors (use vt220.js), hidden/conceal, IRM, ICH/DCH/IL/DL, ECH, DECSTR, DECSED/DECSEL
- **DA1 response**: `ESC [ ? 1 ; 2 c` (VT100 with AVO)
- **Source**: Single file — `src/screen.ts`

### vt220.js (`packages/vt220/`)

VT220 emulator. Extends VT100 with 8 standard colors, insert/delete operations, selective erase, and soft reset.

- **Exports**: `createVt220Screen`, `Vt220Screen`, `Vt220ScreenOptions`, `ScreenCell`, `CellColor`
- **Capabilities**: Everything in vt100.js plus: 8 standard colors (SGR 30-37/40-47/39/49), hidden/conceal (SGR 8/28), insert mode (IRM), insert/delete characters (ICH/DCH), insert/delete lines (IL/DL), erase characters (ECH), selective erase (DECSED/DECSEL), soft reset (DECSTR), DA2
- **Not in VT220** (use vterm.js): truecolor, 256 colors, bright colors, italic, faint, strikethrough, wide chars, alt screen, mouse tracking
- **DA1 response**: `ESC [ ? 62 ; 1 ; 2 ; 6 ; 7 ; 8 ; 9 c` (VT220)
- **DA2 response**: `ESC [ > 1 ; 10 ; 0 c`
- **Source**: Single file — `src/screen.ts`

### vterm.js (`packages/vterm/`)

Full-featured modern emulator targeting 100% of the [terminfo.dev](https://terminfo.dev) feature matrix.

- **Exports**: `createVtermScreen`, `VtermScreen`, `VtermScreenOptions`, `Snapshot`, `Color`, `Cursor`, `VtermScreenAttrsSnapshot`, `VtermScreenColorStateSnapshot`, `VtermScreenParserState`, `VtermScreenBufferSnapshot`, `ScreenCell`, `UnderlineStyle`, `SemanticZone`, `SixelImage`, `TerminalOp`, `ParserEvent`, `DirtyRegion` — the pre-§9 aliases (`ScreenSnapshot`/`VtermScreenSnapshot`, `CellColor`, `getLine`, `getCursorPosition`) rode a deprecation window and have been deleted
- **Capabilities**: Everything in vt220.js plus: underline styles (curly/dotted/dashed), overline, blink, underline color, cursor shape (DECSCUSR), mouse tracking, focus tracking, synchronized output, Kitty keyboard protocol, scrollback buffer, wide characters (CJK, emoji ZWJ), OSC hyperlinks/clipboard/colors, DCS/APC sequences, DA1/DA2/DA3, DECRPM, character sets, soft reset
- **Source**: Single file — `src/screen.ts`

## Key Files

```
packages/vt100/src/screen.ts    # Strict VT100 emulator (monochrome)
packages/vt220/src/screen.ts    # VT220 emulator (8 colors, insert/delete)
packages/vterm/src/screen.ts    # Modern emulator (full standards)
packages/*/src/index.ts         # Re-exports from screen.ts
packages/*/tests/screen.test.ts # Tests for each package
vitest.config.ts                # Test config — includes packages/*/tests/**/*.test.ts
```

## Commands

```bash
# From monorepo root (vendor/vt100/ when inside km)
bun vitest run                           # Run all tests
bun vitest run packages/vt100/tests/     # vt100.js tests only
bun vitest run packages/vt220/tests/     # vt220.js tests only
bun vitest run packages/vterm/tests/     # vterm.js tests only
bun run typecheck                        # TypeScript check (per package)
```

**`tsc --noEmit` at the repo root checks NOTHING.** The root `tsconfig.json` is
`"include": []` with project references, so a bare run compiles zero files and
passes unconditionally — it once hid a missing snapshot-type member and a
syntax error, both shipped green. Always go through `bun run typecheck` (which
runs each package with `-p`), or `tsc -p packages/<name> --noEmit` for one.
`tests/typecheck-gate.test.ts` guards this by asserting the configured check
actually compiles each package's own sources.

## Code Style

- Factory functions (`createVt100Screen`, `createVt220Screen`, `createVtermScreen`), no classes
- Each emulator is a single self-contained file (`screen.ts`) with no internal module dependencies
- Zero external dependencies — pure TypeScript
- ESM only, `.ts` extensions in imports, published as raw TypeScript source
- `engines.node >= 23.6.0` (native type stripping)

## Ecosystem

- [Termless](https://termless.dev) has backends for all three: `@termless/vt100`, `@termless/vt220`, `@termless/vterm`
- [Terminfo.dev](https://terminfo.dev) tests packages against the feature matrix
- [Silvery](https://silvery.dev) React TUI framework (same author)

## API Pattern

All three packages share the same API shape:

```typescript
const screen = createVt100Screen({ cols: 80, rows: 24 }) // or createVt220Screen or createVtermScreen
screen.process(new TextEncoder().encode("\x1b[1mHello\x1b[0m"))
screen.getText() // Plain text content
screen.getCell(row, col) // Per-cell attributes (fg, bg, bold, etc.)
```
