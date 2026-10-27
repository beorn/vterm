# Changelog

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
