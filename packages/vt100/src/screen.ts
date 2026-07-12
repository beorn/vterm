/**
 * Pure TypeScript VT100 terminal emulator.
 *
 * Strict DEC VT100 (1978) implementation: monochrome display, cursor movement,
 * scroll regions, auto-wrap, origin mode, DEC special graphics charset.
 * SGR supports bold, underline, blink, and reverse — NO colors (VT100 is
 * monochrome). No insert mode, no insert/delete chars/lines — those are
 * VT102/VT220 features.
 *
 * Zero dependencies. For colors and VT220 features, use vt220.js.
 * For truecolor, 256 colors, and wide chars, use vterm.js.
 */

// ═══════════════════════════════════════════════════════
// Internal cell representation
// ═══════════════════════════════════════════════════════

export interface CellColor {
  r: number
  g: number
  b: number
}

export interface ScreenCell {
  char: string
  fg: CellColor | null
  bg: CellColor | null
  bold: boolean
  underline: boolean
  blink: boolean
  inverse: boolean
  hidden: boolean
}

/** Frozen sentinel for unwritten cells — never mutate, copy-on-write in writeChar(). */
const EMPTY_CELL: ScreenCell = Object.freeze({
  char: "",
  fg: null,
  bg: null,
  bold: false,
  underline: false,
  blink: false,
  inverse: false,
  hidden: false,
})

function emptyCell(): ScreenCell {
  return { ...EMPTY_CELL }
}

// ═══════════════════════════════════════════════════════
// Screen
// ═══════════════════════════════════════════════════════

export interface ScreenOptions {
  cols: number
  rows: number
  scrollbackLimit?: number
  /** Callback for DA1/DSR responses — write these back to the PTY */
  onResponse?: (data: string) => void
}

interface Attrs {
  fg: CellColor | null
  bg: CellColor | null
  bold: boolean
  underline: boolean
  blink: boolean
  inverse: boolean
  hidden: boolean
}

export interface Screen {
  readonly cols: number
  readonly rows: number
  process(data: Uint8Array): void
  resize(cols: number, rows: number): void
  reset(): void
  getCell(row: number, col: number): ScreenCell
  getLine(row: number): ScreenCell[]
  getScrollbackLine(row: number): ScreenCell[]
  getText(): string
  getTextRange(startRow: number, startCol: number, endRow: number, endCol: number): string
  getCursorPosition(): { x: number; y: number }
  getCursorVisible(): boolean
  getTitle(): string
  getMode(mode: string): boolean
  getScrollbackLength(): number
  getViewportOffset(): number
  scrollViewport(delta: number): void
}

export function createScreen(opts: ScreenOptions): Screen {
  let cols = opts.cols
  let rows = opts.rows
  const scrollbackLimit = opts.scrollbackLimit ?? 1000
  const onResponse = opts.onResponse

  // Main screen buffer (no alternate screen in VT100)
  let grid: ScreenCell[][] = makeGrid(cols, rows)
  let scrollback: ScreenCell[][] = []

  // Cursor
  let curX = 0
  let curY = 0
  let curVisible = true
  let savedCurX = 0
  let savedCurY = 0

  // DECSC/DECRC saved state (cursor + attrs + modes)
  interface SavedState {
    curX: number
    curY: number
    attrs: Attrs
    originMode: boolean
    autoWrap: boolean
  }
  let savedState: SavedState = {
    curX: 0,
    curY: 0,
    attrs: resetAttrs(),
    originMode: false,
    autoWrap: true,
  }

  // Current drawing attributes
  let attrs: Attrs = resetAttrs()

  // Terminal state
  let title = ""
  let applicationCursor = false
  let applicationKeypad = false
  let autoWrap = true
  let originMode = false
  let reverseVideo = false

  // Scroll region (inclusive, 0-based)
  let scrollTop = 0
  let scrollBottom = rows - 1

  // Viewport scroll offset for scrollViewport()
  let viewportOffset = 0

  // Parser state
  let parserState: "ground" | "escape" | "csi" | "osc" | "dcs" | "oscString" = "ground"
  let escBuf = ""
  let oscBuf = ""

  // Decoder for incoming bytes
  const decoder = new TextDecoder()

  function makeGrid(c: number, r: number): ScreenCell[][] {
    const g: ScreenCell[][] = []
    for (let row = 0; row < r; row++) {
      g.push(makeRow(c))
    }
    return g
  }

  function makeRow(c: number): ScreenCell[] {
    const row: ScreenCell[] = []
    for (let col = 0; col < c; col++) {
      row.push(EMPTY_CELL)
    }
    return row
  }

  function resetAttrs(): Attrs {
    return {
      fg: null,
      bg: null,
      bold: false,
      underline: false,
      blink: false,
      inverse: false,
      hidden: false,
    }
  }

  function clampCursor(): void {
    if (curX < 0) curX = 0
    if (curX >= cols) curX = cols - 1
    if (curY < 0) curY = 0
    if (curY >= rows) curY = rows - 1
  }

  // ── Scrolling ──

  function scrollUp(top: number, bottom: number): void {
    // Move top row to scrollback (only if top of screen)
    if (top === 0) {
      scrollback.push(grid[0]!)
      // Bulk trim when exceeding 2x limit to avoid O(n) shift() on every scroll
      if (scrollback.length > scrollbackLimit * 2) {
        scrollback.splice(0, scrollback.length - scrollbackLimit)
      }
    }
    // Shift rows up within the region
    for (let i = top; i < bottom; i++) {
      grid[i] = grid[i + 1]!
    }
    grid[bottom] = makeRow(cols)
  }

  function scrollDown(top: number, bottom: number): void {
    for (let i = bottom; i > top; i--) {
      grid[i] = grid[i - 1]!
    }
    grid[top] = makeRow(cols)
  }

  // ── Character writing ──

  function writeChar(ch: string): void {
    // Handle autowrap at end of line
    if (curX >= cols) {
      if (autoWrap) {
        curX = 0
        curY++
        if (curY > scrollBottom) {
          curY = scrollBottom
          scrollUp(scrollTop, scrollBottom)
        }
      } else {
        curX = cols - 1
      }
    }

    // Copy-on-write: if cell is the shared EMPTY_CELL sentinel, create a fresh object
    const row = grid[curY]!
    let cell = row[curX]!
    if (cell === EMPTY_CELL) {
      cell = { ...EMPTY_CELL }
      row[curX] = cell
    }
    cell.char = ch
    cell.fg = attrs.fg ? { ...attrs.fg } : null
    cell.bg = attrs.bg ? { ...attrs.bg } : null
    cell.bold = attrs.bold
    cell.underline = attrs.underline
    cell.blink = attrs.blink
    cell.inverse = attrs.inverse
    cell.hidden = attrs.hidden

    curX++
  }

  // ── CSI handler ──

  function handleCSI(params: string, finalByte: string): void {
    const parts = params.split(";").map((s) => (s === "" ? 0 : parseInt(s, 10)))

    switch (finalByte) {
      case "A": // CUU - Cursor Up
        curY -= Math.max(parts[0] ?? 1, 1)
        clampCursor()
        break
      case "B": // CUD - Cursor Down
        curY += Math.max(parts[0] ?? 1, 1)
        clampCursor()
        break
      case "C": // CUF - Cursor Forward
        curX += Math.max(parts[0] ?? 1, 1)
        clampCursor()
        break
      case "D": // CUB - Cursor Back
        curX -= Math.max(parts[0] ?? 1, 1)
        clampCursor()
        break
      case "E": // CNL - Cursor Next Line
        curY += Math.max(parts[0] ?? 1, 1)
        curX = 0
        clampCursor()
        break
      case "F": // CPL - Cursor Previous Line
        curY -= Math.max(parts[0] ?? 1, 1)
        curX = 0
        clampCursor()
        break
      case "G": // CHA - Cursor Horizontal Absolute
        curX = (parts[0] ?? 1) - 1
        clampCursor()
        break
      case "H": // CUP - Cursor Position
      case "f": // HVP - same as CUP
        curY = (parts[0] ?? 1) - 1
        curX = (parts[1] ?? 1) - 1
        clampCursor()
        break
      case "J": // ED - Erase in Display
        handleEraseDisplay(parts[0] ?? 0)
        break
      case "K": // EL - Erase in Line
        handleEraseLine(parts[0] ?? 0)
        break
      case "S": // SU - Scroll Up
        for (let i = 0; i < Math.max(parts[0] ?? 1, 1); i++) {
          scrollUp(scrollTop, scrollBottom)
        }
        break
      case "T": // SD - Scroll Down
        for (let i = 0; i < Math.max(parts[0] ?? 1, 1); i++) {
          scrollDown(scrollTop, scrollBottom)
        }
        break
      case "d": // VPA - Line Position Absolute
        curY = (parts[0] ?? 1) - 1
        clampCursor()
        break
      case "m": // SGR - Select Graphic Rendition
        handleSGR(params)
        break
      case "r": // DECSTBM - Set Scrolling Region
        scrollTop = (parts[0] ?? 1) - 1
        scrollBottom = (parts[1] ?? rows) - 1
        if (scrollTop < 0) scrollTop = 0
        if (scrollBottom >= rows) scrollBottom = rows - 1
        if (scrollTop > scrollBottom) {
          scrollTop = 0
          scrollBottom = rows - 1
        }
        curX = 0
        curY = originMode ? scrollTop : 0
        break
      case "n": // DSR - Device Status Report
        if (onResponse) {
          if (parts[0] === 5) {
            // Status report - OK
            onResponse("\x1b[0n")
          } else if (parts[0] === 6) {
            // CPR - Cursor position report (1-based)
            onResponse(`\x1b[${curY + 1};${curX + 1}R`)
          }
        }
        break
      case "c": // DA1 - Primary Device Attributes
        if (onResponse) {
          if (params === "" || params === "0") {
            // VT100 with Advanced Video Option (AVO)
            onResponse("\x1b[?1;2c")
          }
        }
        break
      case "s": // SCP - Save Cursor Position
        savedCurX = curX
        savedCurY = curY
        break
      case "u": // RCP - Restore Cursor Position
        curX = savedCurX
        curY = savedCurY
        clampCursor()
        break
      default:
        // Unknown CSI sequence — ignore
        break
    }
  }

  function handleCSIPrivate(params: string, finalByte: string): void {
    const parts = params.split(";").map((s) => (s === "" ? 0 : parseInt(s, 10)))
    const set = finalByte === "h"

    for (const code of parts) {
      switch (code) {
        case 1: // DECCKM - Application Cursor
          applicationCursor = set
          break
        case 5: // DECSCNM - Reverse Video
          reverseVideo = set
          break
        case 6: // DECOM - Origin Mode
          originMode = set
          break
        case 7: // DECAWM - Autowrap Mode
          autoWrap = set
          break
        case 25: // DECTCEM - Cursor Visible
          curVisible = set
          break
        case 66: // DECNKM - Application Keypad
          applicationKeypad = set
          break
      }
    }
  }

  function handleEraseDisplay(mode: number): void {
    switch (mode) {
      case 0: // Erase from cursor to end
        eraseCells(curY, curX, curY, cols - 1)
        for (let row = curY + 1; row < rows; row++) {
          eraseCells(row, 0, row, cols - 1)
        }
        break
      case 1: // Erase from start to cursor
        for (let row = 0; row < curY; row++) {
          eraseCells(row, 0, row, cols - 1)
        }
        eraseCells(curY, 0, curY, curX)
        break
      case 2: // Erase entire display
      case 3: // Erase entire display + scrollback
        for (let row = 0; row < rows; row++) {
          eraseCells(row, 0, row, cols - 1)
        }
        if (mode === 3) {
          scrollback.length = 0
        }
        break
    }
  }

  function handleEraseLine(mode: number): void {
    switch (mode) {
      case 0: // Erase from cursor to end of line
        eraseCells(curY, curX, curY, cols - 1)
        break
      case 1: // Erase from start to cursor
        eraseCells(curY, 0, curY, curX)
        break
      case 2: // Erase entire line
        eraseCells(curY, 0, curY, cols - 1)
        break
    }
  }

  function eraseCells(row: number, startCol: number, _endRow: number, endCol: number): void {
    const r = grid[row]
    if (!r) return
    for (let col = startCol; col <= endCol && col < cols; col++) {
      r[col] = emptyCell()
    }
  }

  // ── SGR (Select Graphic Rendition) ──
  // VT100 is monochrome: only bold (1), underline (4), blink (5), reverse (7).
  // Color codes are silently ignored for forward compatibility.

  function handleSGR(rawParams: string): void {
    const params = rawParams.split(";").map((s) => (s === "" ? 0 : parseInt(s, 10)))

    if (params.length === 0 || (params.length === 1 && params[0] === 0)) {
      attrs = resetAttrs()
      return
    }

    let i = 0
    while (i < params.length) {
      const code = params[i]!
      switch (code) {
        case 0:
          attrs = resetAttrs()
          break
        case 1:
          attrs.bold = true
          break
        case 4:
          attrs.underline = true
          break
        case 5: // Blink
          attrs.blink = true
          break
        case 7:
          attrs.inverse = true
          break
        case 22: // Normal intensity (turn off bold)
          attrs.bold = false
          break
        case 24:
          attrs.underline = false
          break
        case 25: // Blink off
          attrs.blink = false
          break
        case 27:
          attrs.inverse = false
          break
        // Color codes silently ignored — VT100 is monochrome
        // Skip extended color sequences to consume params correctly
        case 38:
        case 48:
          if (i + 1 < params.length && params[i + 1] === 2) {
            i += 4 // skip 38;2;R;G;B or 48;2;R;G;B
          } else if (i + 1 < params.length && params[i + 1] === 5) {
            i += 2 // skip 38;5;N or 48;5;N
          }
          break
        // All other SGR codes (colors 30-37, 40-47, 39, 49, 8, 28, etc.)
        // are silently ignored for forward compatibility
      }
      i++
    }
  }

  // ── OSC handler ──

  function handleOSC(oscString: string): void {
    const semicolonIdx = oscString.indexOf(";")
    if (semicolonIdx === -1) return

    const code = parseInt(oscString.substring(0, semicolonIdx), 10)
    const value = oscString.substring(semicolonIdx + 1)

    switch (code) {
      case 0: // Set icon name and window title
      case 2: // Set window title
        title = value
        break
      case 1: // Set icon name (ignore)
        break
    }
  }

  // ── Main parser ──

  function process(data: Uint8Array): void {
    const text = decoder.decode(data, { stream: true })

    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!
      const code = text.charCodeAt(i)

      switch (parserState) {
        case "ground":
          if (code === 0x1b) {
            parserState = "escape"
            escBuf = ""
          } else if (code === 0x07) {
            // BEL — ignore
          } else if (code === 0x08) {
            // BS - Backspace
            if (curX > 0) curX--
          } else if (code === 0x09) {
            // TAB
            curX = Math.min((Math.floor(curX / 8) + 1) * 8, cols - 1)
          } else if (code === 0x0a || code === 0x0b || code === 0x0c) {
            // LF, VT, FF — linefeed
            curY++
            if (curY > scrollBottom) {
              curY = scrollBottom
              scrollUp(scrollTop, scrollBottom)
            }
          } else if (code === 0x0d) {
            // CR - Carriage Return
            curX = 0
          } else if (code >= 0x20) {
            writeChar(ch)
          }
          break

        case "escape":
          if (ch === "[") {
            parserState = "csi"
            escBuf = ""
          } else if (ch === "]") {
            parserState = "osc"
            oscBuf = ""
          } else if (ch === "P") {
            parserState = "dcs"
            escBuf = ""
          } else if (ch === "c") {
            // RIS - Reset to Initial State
            fullReset()
          } else if (ch === "D") {
            // IND - Index (move cursor down, scroll if needed)
            curY++
            if (curY > scrollBottom) {
              curY = scrollBottom
              scrollUp(scrollTop, scrollBottom)
            }
            parserState = "ground"
          } else if (ch === "M") {
            // RI - Reverse Index (move cursor up, scroll if needed)
            curY--
            if (curY < scrollTop) {
              curY = scrollTop
              scrollDown(scrollTop, scrollBottom)
            }
            parserState = "ground"
          } else if (ch === "7") {
            // DECSC - Save Cursor + attributes + modes
            savedState = {
              curX,
              curY,
              attrs: { ...attrs, fg: attrs.fg ? { ...attrs.fg } : null, bg: attrs.bg ? { ...attrs.bg } : null },
              originMode,
              autoWrap,
            }
            parserState = "ground"
          } else if (ch === "8") {
            // DECRC - Restore Cursor + attributes + modes
            curX = savedState.curX
            curY = savedState.curY
            attrs = {
              ...savedState.attrs,
              fg: savedState.attrs.fg ? { ...savedState.attrs.fg } : null,
              bg: savedState.attrs.bg ? { ...savedState.attrs.bg } : null,
            }
            originMode = savedState.originMode
            autoWrap = savedState.autoWrap
            clampCursor()
            parserState = "ground"
          } else if (ch === "E") {
            // NEL - Next Line
            curX = 0
            curY++
            if (curY > scrollBottom) {
              curY = scrollBottom
              scrollUp(scrollTop, scrollBottom)
            }
            parserState = "ground"
          } else if (ch === "=") {
            // DECKPAM - Application Keypad Mode
            applicationKeypad = true
            parserState = "ground"
          } else if (ch === ">") {
            // DECKPNM - Normal Keypad Mode
            applicationKeypad = false
            parserState = "ground"
          } else {
            // Unknown escape — return to ground
            parserState = "ground"
          }
          break

        case "csi":
          if (code >= 0x40 && code <= 0x7e) {
            // Final byte — dispatch CSI
            if (escBuf.startsWith("?")) {
              handleCSIPrivate(escBuf.substring(1), ch)
            } else {
              handleCSI(escBuf, ch)
            }
            parserState = "ground"
          } else if (escBuf.length >= 256) {
            // Buffer overflow — drop to ground to avoid unbounded accumulation
            parserState = "ground"
          } else {
            // Parameter or intermediate byte
            escBuf += ch
          }
          break

        case "osc":
          if (code === 0x07) {
            // BEL terminates OSC
            handleOSC(oscBuf)
            parserState = "ground"
          } else if (code === 0x1b) {
            // ESC might be start of ST (\x1b\\)
            parserState = "oscString"
          } else if (oscBuf.length >= 4096) {
            // Buffer overflow — drop to ground to avoid unbounded accumulation
            parserState = "ground"
          } else {
            oscBuf += ch
          }
          break

        case "oscString":
          if (ch === "\\") {
            // ST (String Terminator) — end of OSC
            handleOSC(oscBuf)
          }
          // Either way, back to ground
          parserState = "ground"
          break

        case "dcs":
          // Consume until ST
          if (code === 0x1b) {
            parserState = "oscString" // Reuse ST detection
          }
          break
      }
    }
  }

  function fullReset(): void {
    grid = makeGrid(cols, rows)
    scrollback = []
    curX = 0
    curY = 0
    curVisible = true
    savedCurX = 0
    savedCurY = 0
    savedState = { curX: 0, curY: 0, attrs: resetAttrs(), originMode: false, autoWrap: true }
    attrs = resetAttrs()
    title = ""
    applicationCursor = false
    applicationKeypad = false
    autoWrap = true
    originMode = false
    reverseVideo = false
    scrollTop = 0
    scrollBottom = rows - 1
    viewportOffset = 0
    parserState = "ground"
    escBuf = ""
    oscBuf = ""
  }

  function resize(newCols: number, newRows: number): void {
    const newGrid = makeGrid(newCols, newRows)

    // Copy content from old grid
    copyGrid(grid, newGrid, Math.min(cols, newCols), Math.min(rows, newRows))

    grid = newGrid
    cols = newCols
    rows = newRows
    scrollTop = 0
    scrollBottom = rows - 1
    clampCursor()
  }

  function copyGrid(src: ScreenCell[][], dst: ScreenCell[][], copyCols: number, copyRows: number): void {
    for (let row = 0; row < copyRows; row++) {
      for (let col = 0; col < copyCols; col++) {
        const srcCell = src[row]?.[col]
        if (srcCell) {
          dst[row]![col] = { ...srcCell }
        }
      }
    }
  }

  function getCell(row: number, col: number): ScreenCell {
    const r = grid[row]
    if (!r || col >= cols) return emptyCell()
    return { ...r[col]! }
  }

  function getLine(row: number): ScreenCell[] {
    const r = grid[row]
    if (!r) return makeRow(cols)
    return r.map((cell) => ({ ...cell }))
  }

  function getScrollbackLine(row: number): ScreenCell[] {
    const r = scrollback[row]
    if (!r) return makeRow(cols)
    return r.map((cell) => ({ ...cell }))
  }

  function getText(): string {
    const lines: string[] = []

    // Scrollback
    for (const row of scrollback) {
      lines.push(rowToString(row))
    }

    // Screen
    for (let r = 0; r < rows; r++) {
      lines.push(rowToString(grid[r]!))
    }

    return lines.join("\n")
  }

  function rowToString(row: ScreenCell[]): string {
    let line = ""
    for (let i = 0; i < row.length; i++) {
      const cell = row[i]!
      if (cell.char === "") {
        line += " "
      } else {
        line += cell.char
      }
    }
    return line.replace(/\s+$/, "") // Trim trailing whitespace
  }

  function getTextRange(startRow: number, startCol: number, endRow: number, endCol: number): string {
    const parts: string[] = []

    for (let row = startRow; row <= endRow; row++) {
      const r = grid[row]
      if (!r) continue

      const colStart = row === startRow ? startCol : 0
      const colEnd = row === endRow ? endCol : cols

      let line = ""
      for (let col = colStart; col < colEnd; col++) {
        const cell = r[col]
        if (!cell) continue
        line += cell.char || " "
      }
      parts.push(line.replace(/\s+$/, ""))
    }

    return parts.join("\n")
  }

  function getMode(mode: string): boolean {
    switch (mode) {
      case "cursorVisible":
        return curVisible
      case "applicationCursor":
        return applicationCursor
      case "applicationKeypad":
        return applicationKeypad
      case "autoWrap":
        return autoWrap
      case "originMode":
        return originMode
      case "reverseVideo":
        return reverseVideo
      default:
        return false
    }
  }

  return {
    get cols() {
      return cols
    },
    get rows() {
      return rows
    },
    process,
    resize,
    reset: fullReset,
    getCell,
    getLine,
    getScrollbackLine,
    getText,
    getTextRange,
    getCursorPosition: () => ({ x: curX, y: curY }),
    getCursorVisible: () => curVisible,
    getTitle: () => title,
    getMode,
    getScrollbackLength: () => scrollback.length,
    getViewportOffset: () => viewportOffset,
    scrollViewport: (delta: number) => {
      viewportOffset = Math.max(0, Math.min(scrollback.length, viewportOffset + delta))
    },
  }
}
