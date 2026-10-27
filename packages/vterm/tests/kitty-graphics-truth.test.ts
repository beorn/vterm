/**
 * Regression tests for #31020 — a headless vterm screen must not tell a guest it
 * can show kitty graphics it will never paint.
 *
 * Ruling: @cto 5e61a05d (Option A). Before this change `handleAPC` answered
 * every `a=q` query with `\x1b_Gi=<id>;OK\x1b\` while the screen stored no
 * image at all, and `hasKittyGraphics` flipped true for ANY graphics APC, so
 * `getMode("kittyGraphics")`, `modesNow()` and the parser-state snapshot all
 * reported a capability the screen did not have. Silvery's runtime probe reads
 * exactly `OK` as support, so a deck pane was told the wrong thing.
 *
 * Option A: unless the embedder passes `ScreenOptions.kittyGraphicsImages`,
 * a query is answered with an explicit ENOTSUP refusal — a conventional
 * errno-style name the response format permits, not protocol text (the protocol
 * page names no unsupported code; @cto bba689b8) — and the capability mode
 * stays false; opting in restores the `OK` reply and a true
 * mode. The capability flag means "this screen can show graphics" and is set
 * from the declared option only.
 *
 * Test-first half: these fail on 1280244 and pass once the option lands.
 * vterm source is untouched by this file.
 *
 * @failure  A headless screen claims kitty graphics support it cannot render:
 *           a query answers OK or the mode/snapshot reports a crossed payload
 *           as capability, so guests send images into a pane that drops them.
 * @level    l0
 * @consumer #31020 — createVtermScreen kittyGraphicsImages option and the
 *           kittyGraphics mode readouts hosts negotiate capability from
 * @testonly none
 */
import { describe, test, expect } from "vitest"
import { createVtermScreen } from "../src/index.ts"

const enc = new TextEncoder()

type VtermOptions = Parameters<typeof createVtermScreen>[0]

/** A screen whose host responses are captured; `extra` bypasses the option
 *  type that does not exist yet, so the red run is an assertion failure and
 *  never a compile trick. */
function makeScreen(extra: Record<string, unknown> = {}) {
  const out = { response: "" }
  const screen = createVtermScreen({
    cols: 80,
    rows: 24,
    onResponse: (data: string) => {
      out.response += data
    },
    ...extra,
  } as VtermOptions)
  return { screen, out }
}

const QUERY = "\x1b_Gi=42,a=q;\x1b\\"
const QUERY_QUIET_ALL = "\x1b_Gi=42,a=q,q=2;\x1b\\"
const QUERY_QUIET_OK = "\x1b_Gi=42,a=q,q=1;\x1b\\"
const TRANSFER = "\x1b_Gf=32,s=1,v=1;AAAA\x1b\\"

describe("#31020 kitty graphics capability truth (CTO 5e61a05d, Option A)", () => {
  test("default: a graphics query is refused with an explicit ENOTSUP, never OK", () => {
    const { screen, out } = makeScreen()
    screen.process(enc.encode(QUERY))
    expect(out.response).toBe("\x1b_Gi=42;ENOTSUP\x1b\\")
  })

  test("default: the capability mode stays false through query and transfer", () => {
    const { screen } = makeScreen()
    screen.process(enc.encode(QUERY))
    expect(screen.getMode("kittyGraphics")).toBe(false)
    screen.process(enc.encode(TRANSFER + "Hello"))
    expect(screen.getMode("kittyGraphics")).toBe(false)
    expect(screen.getCell(0, 0).char).toBe("H")
  })

  test("default: q=2 asks for total silence and gets it, even for the refusal", () => {
    const { screen, out } = makeScreen()
    screen.process(enc.encode(QUERY_QUIET_ALL))
    expect(out.response).toBe("")
  })

  test("opt-in: the capability mode is true from construction", () => {
    const { screen } = makeScreen({ kittyGraphicsImages: true })
    expect(screen.getMode("kittyGraphics")).toBe(true)
  })

  test("opt-in: the query is acknowledged and payloads still parse", () => {
    const { screen, out } = makeScreen({ kittyGraphicsImages: true })
    screen.process(enc.encode(QUERY))
    expect(out.response).toBe("\x1b_Gi=42;OK\x1b\\")
    screen.process(enc.encode(TRANSFER + "Hello"))
    expect(screen.getCell(0, 0).char).toBe("H")
  })

  test("opt-in: q=1 suppresses the OK acknowledgement", () => {
    const { screen, out } = makeScreen({ kittyGraphicsImages: true })
    screen.process(enc.encode(QUERY_QUIET_OK))
    expect(out.response).toBe("")
  })

  test("snapshot reports the declared capability, not a crossed payload", () => {
    const { screen } = makeScreen()
    screen.process(enc.encode(TRANSFER))
    expect(screen.snapshot().modes.kittyGraphics).toBe(false)
  })

  test("default: q=1 suppresses only OK, so the refusal still answers", () => {
    const { screen, out } = makeScreen()
    screen.process(enc.encode(QUERY_QUIET_OK))
    expect(out.response).toBe("\x1b_Gi=42;ENOTSUP\x1b\\")
  })

  test("restoring a snapshot that claims the capability cannot enable a default screen", () => {
    const { screen: source } = makeScreen({ kittyGraphicsImages: true })
    const legacy = JSON.parse(JSON.stringify(source.snapshot())) as ReturnType<typeof source.snapshot>
    legacy.modes.kittyGraphics = true
    const { screen } = makeScreen()
    screen.restore(legacy)
    expect(screen.getMode("kittyGraphics")).toBe(false)
    expect(screen.snapshot().modes.kittyGraphics).toBe(false)
  })
})
