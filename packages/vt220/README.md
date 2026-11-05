# vt220.js

Pure TypeScript VT220 terminal emulator with zero runtime dependencies.

Part of the [vterm](https://github.com/beorn/vterm) monorepo.

```typescript
import { createVt220Screen } from "vt220.js"

const screen = createVt220Screen({ cols: 80, rows: 24 })
screen.process(new TextEncoder().encode("Hello"))
const pasteBytes = screen.encodePaste("pasted text\n")
```

`process(data)` feeds terminal output to the screen. `encodePaste(text)`
returns a `Uint8Array` for the caller to deliver to the application. Encoding
does not process text, change screen state, or call `onResponse`.

Mode 2004 is not implemented: paste is never framed, including after
`CSI ? 2004 h`. `getMode("bracketedPaste")` returns `false`. All text is
preserved as UTF-8, including embedded escape sequences and framing markers.
LF, CR and CRLF pass through unchanged; LNM never changes paste bytes.

Existing VT220 parser and device-reply behavior is unchanged. Snapshots retain
the historical mode set; paste encoding adds no stored state.
