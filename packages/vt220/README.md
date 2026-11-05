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

Rendition is monochrome. SGR accepts exactly 0, 1, 4, 5, 7, 22, 24, 25 and 27. Other semicolon parameters are ignored independently: `CSI 1;31m` sets
bold without color; `CSI 38;2;1;4;5m` sets bold, underline and blink. A colon
parameter such as `38:2::1:2:3` is ignored as a whole.

CHA, VPA, CNL, CPL, CSI s/u, SU/SD and ED 3 are ignored. XTWINOPS 18 sends
no reply. OSC strings retain their existing consumption behavior but do not
set a title. DEC cursor save/restore (ESC 7/8), IND/NEL/RI, DECAWM, DECTCEM,
insert/delete operations and selective erase remain available.

Snapshots retain the historical mode set; paste encoding adds no stored state.

`getUnhandledSequences()` returns copied, ordered reports from the engine's
existing ignore paths: `{ kind: "osc", code: "777" }` for a completed OSC command,
or `{ kind: "csi", code: "3m" }` for each ignored numeric SGR operand. It records
only non-negative safe integers, normalized without leading zeros, never payloads
or reconstructed input. Colon groups have already lost their numeric identity
and produce no report. Incomplete, malformed or overflowing OSC input also
produces none. An empty report makes no support decision.

History retains at least the most recent 1000 reports, dropping the oldest in
bulk after it grows past 2000. Public reset and RIS clear it; DECSTR, SGR 0 and
resize preserve it. History belongs to this instance and is not serialized in
snapshots: restore preserves the destination's existing history. Completing a
restored pending OSC records a new observation when its terminator arrives.
