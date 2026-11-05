const encoder = new TextEncoder()

/** Private native input encoding; newlines are preserved independently of LNM. */
export function encodePaste(text: string, bracketed: boolean): Uint8Array {
  const input = encoder.encode(text)
  if (!bracketed) return input

  const output = new Uint8Array(input.length + 12)
  output.set([0x1b, 0x5b, 0x32, 0x30, 0x30, 0x7e])
  let length = 6
  // Treat the payload as a stack: each byte is appended once, and a complete
  // marker is popped from its suffix. Joined fragments are handled without
  // rescanning; the opening frame is outside the payload's pop boundary.
  for (const byte of input) {
    output[length++] = byte
    if (
      byte === 0x7e &&
      length >= 12 &&
      output[length - 6] === 0x1b &&
      output[length - 5] === 0x5b &&
      output[length - 4] === 0x32 &&
      output[length - 3] === 0x30 &&
      (output[length - 2] === 0x30 || output[length - 2] === 0x31)
    ) {
      length -= 6
    }
  }
  output.set([0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e], length)
  return output.subarray(0, length + 6)
}
