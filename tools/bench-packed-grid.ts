/**
 * Flood-write throughput bench for the packed-cell grid.
 *
 * Measures how fast the engine folds a large byte flood into grid state — the path
 * the packed representation was built to speed up (no per-cell heap object on write).
 * The engine factory is imported from a path argument so the SAME bench can run against
 * the current (packed) source and a baseline copy of the pre-packing screen.ts:
 *
 *   bun tools/bench-packed-grid.ts                       # current (packed)
 *   bun tools/bench-packed-grid.ts /tmp/screen-base.ts   # a baseline copy
 *
 * Reports wall-clock, MB/s, and peak RSS. Deterministic content (styled printable runs
 * with periodic newlines + SGR changes) so packed vs baseline are comparable.
 */

const factoryPath = process.argv[2] ?? "../packages/vterm/src/screen.ts"
const mod = (await import(factoryPath)) as { createScreen: (o?: unknown) => { process(d: Uint8Array): void } }
const createScreen = mod.createScreen

const enc = new TextEncoder()

// Build a deterministic flood: 200k lines of 80-col styled content with SGR churn.
function buildFlood(lines: number, cols: number): Uint8Array {
  const parts: string[] = []
  const words = ["hello", "world", "packed", "cells", "vterm", "flood", "bench", "grid"]
  for (let l = 0; l < lines; l++) {
    // Rotate an SGR every line so the color maps churn (not just plain chars).
    const fg = 31 + (l % 7)
    parts.push(`\x1b[1;${fg}m`)
    let col = 0
    let w = 0
    while (col < cols) {
      const word = words[(l + w) % words.length]!
      parts.push(word, " ")
      col += word.length + 1
      w++
    }
    parts.push("\x1b[0m\r\n")
  }
  return enc.encode(parts.join(""))
}

function measure(label: string, bytes: number, run: () => void): void {
  // Warm up (JIT), then measure a clean timed run.
  run()
  run()
  const t0 = performance.now()
  run()
  const ms = performance.now() - t0
  const mb = bytes / (1024 * 1024)
  console.log(
    `  ${label.padEnd(10)} ${ms.toFixed(0).padStart(5)} ms   ${(mb / (ms / 1000)).toFixed(1).padStart(6)} MB/s`,
  )
}

// Scenario A — scroll-heavy flood (200k lines through a 24-row screen + scrollback).
// Dominated by scroll shuffling + retention trimming as much as per-cell writes.
const SCROLL_COLS = 80
const flood = buildFlood(200_000, SCROLL_COLS)

// Scenario B — in-place repaint of a large alt screen (no scrollback). Isolates the
// per-cell WRITE path: every cell is overwritten each repaint, nothing scrolls out, so
// the cost is exactly cell packing vs per-cell heap-object churn (the 3-5x flood claim).
const REPAINT_COLS = 200
const REPAINT_ROWS = 50
const REPAINTS = 400
const oneRepaint = buildFlood(REPAINT_ROWS, REPAINT_COLS)
const repaintFrame = enc.encode("\x1b[H") // home cursor, overwrite in place
const repaintBytes = (oneRepaint.length + repaintFrame.length) * REPAINTS

console.log(`source: ${factoryPath}`)
console.log(`  scenario     time    throughput`)

measure("scroll", flood.length, () => {
  const s = createScreen({ cols: SCROLL_COLS, rows: 24, scrollbackLimit: 1000 })
  s.process(flood)
})

measure("repaint", repaintBytes, () => {
  const s = createScreen({ cols: REPAINT_COLS, rows: REPAINT_ROWS, scrollbackLimit: 0 })
  s.process(enc.encode("\x1b[?1049h")) // alt screen — no scrollback churn
  for (let i = 0; i < REPAINTS; i++) {
    s.process(repaintFrame)
    s.process(oneRepaint)
  }
})

console.log(`  peak RSS:  ${(process.memoryUsage().rss / (1024 * 1024)).toFixed(0)} MB`)
