# Changelog

## 0.12.0

- Breaking, vt100.js and vt220.js: ignore CHA, VPA, CNL, CPL, CSI s/u,
  SU/SD and ED 3. OSC 0/2 no longer set a title; existing OSC string
  consumption is unchanged. XTWINOPS 18 produces no reply.
- Breaking, vt100.js: ignore DECTCEM and SGR 22/24/25/27. The accepted
  SGR set is exactly 0, 1, 4, 5 and 7; use SGR 0 to reset attributes.
- Breaking, vt220.js: remove standard foreground/background colors
  (SGR 30–37/40–47), default-color operands (39/49), and conceal/reveal
  (8/28). The accepted SGR set is exactly 0, 1, 4, 5, 7, 22, 24, 25 and 27.
  DECTCEM and genuine VT220 insert/delete/selective-erase controls remain.
- Breaking from 0.11.0, both classic engines: semicolon SGR parameters
  apply independently rather than consuming later color groups. For example,
  CSI 38;2;1;4;5m sets bold, underline and blink. Unknown operands are
  ignored; colon operands remain ignored as a whole.
- vterm.js behavior is unchanged; its version advances with the shared release.

## 0.11.0

- Add `Screen.encodePaste(text): Uint8Array` to all three engines using one
  private native encoder. Encoding does not mutate the screen or deliver a
  protocol reply. LF, CR and CRLF are preserved unchanged regardless of LNM.
- vt100.js and vt220.js always return raw UTF-8: mode 2004 is not implemented
  and paste is never framed. `getMode("bracketedPaste")` now returns `false`
  instead of `null`; historical parser and DECRPM reply behavior is unchanged.
- vterm.js uses its existing native mode 2004. When enabled, all embedded
  start/end framing markers are removed before wrapping the payload in one
  bracketed-paste frame. Unbracketed text remains byte-for-byte UTF-8.

- vterm.js `process()` now rejects strings at its byte-only boundary. Pass a
  `Uint8Array`, encoding text with `TextEncoder` before calling it.
- Isolate unsupported classic SGR parameters and control strings so vt100.js
  and vt220.js preserve their existing attributes and parser state.
- Keep vterm.js mouse tracking and mouse encoding state independent.
- Keep DEC private mode 4 separate from ANSI insert mode in all three engines.
- Answer the official vterm.js Capabilities query.
- Advance tabs to the right margin after all tab stops have been cleared.
- Strip embedded paste markers in one linear pass.

## 0.10.1

- Expose vterm.js alternate-scroll mode through getMode("altScroll"), following the engine's existing DECSET/DECRST 1007 state.
- vt100.js and vt220.js are unchanged; their versions advance with the shared release.

## 0.10.0

- Breaking: getMode returns null for modes the engine does not track; was false. Callers must handle the nullable return in vt100.js, vt220.js and vterm.js.
- Keep viewed scrollback rows anchored while new output adds history in all three engines.
- Ignore unsupported colon SGR groups as a whole in vt100.js and vt220.js, preserving existing attributes.

## 0.9.0

- Save and restore window titles and icon labels with XTWINOPS 22/23, including the `iconLabel` exposed by snapshots. Reset clears both stacks.
- Keep the ten most recent saved titles and icon labels, discarding the oldest entry when a stack reaches its cap to match xterm.js.
- vt100.js and vt220.js are unchanged; their versions advance with the shared release.

## 0.8.0

- Refuse Kitty graphics queries with `ENOTSUP` by default. The `kittyGraphics` mode now reports the embedder's declared image-rendering capability.
- Add the `kittyGraphicsImages` screen option so embedders that render images can opt in, and add `iconLabel` to snapshots to preserve icon and window labels independently.
- `serializeSnapshot(..., { includeTitle: true })` now emits OSC 2 (window title only); the receiver's icon label is no longer overwritten.
- Report unknown physical window and cell pixel dimensions as zero instead of inventing dimensions from the cell grid.
- Preserve decoded supplementary Unicode characters in vt100.js and vt220.js.
- Ignore unsupported private CSI sequences in vt100.js and vt220.js instead of applying them as mode resets.
- Consume character-set designation bytes in vt100.js and vt220.js, including sequences split across input chunks, instead of printing them.

## 0.7.1

- Publish compiled JavaScript and TypeScript declarations for vt100.js, vt220.js and vterm.js, so Node imports use the built package.
- Preserve independent G0 and G1 character sets through vterm.js snapshots, saved state and ANSI replay.
