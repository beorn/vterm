const encoder = new TextEncoder()

/** Private native input encoding; newlines are preserved independently of LNM. */
export function encodePaste(text: string, bracketed: boolean): Uint8Array {
  if (!bracketed) return encoder.encode(text)

  // Removing one marker can join fragments into another marker. Strip until
  // none remain so pasted text cannot terminate the frame early.
  let payload = text
  for (;;) {
    const stripped = payload.replace(/\x1b\[20[01]~/g, "")
    if (stripped === payload) break
    payload = stripped
  }
  return encoder.encode(`\x1b[200~${payload}\x1b[201~`)
}
