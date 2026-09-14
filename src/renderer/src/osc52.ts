/**
 * OSC 52 (`ESC ] 52 ; <selection> ; <base64> ST`) is how a program inside the
 * terminal asks us to put text on the *local* system clipboard. tmux's
 * `set-clipboard on`, neovim's `clipboard=osc52`, and anything reached over SSH
 * rely on it -- without a handler the sequence is silently dropped. xterm.js
 * ships no OSC 52 handler, so `terminal-pane.tsx` wires this one up.
 *
 * Only the write direction is implemented: a `?` payload is a *read* request,
 * which would let the far end of an SSH session exfiltrate the local clipboard,
 * so it is refused (most terminals refuse it too).
 *
 * Pure and DOM-free so it can be unit-tested without a terminal.
 */

/**
 * Base64-length cap, ~75 KiB decoded. Keeps one bogus sequence from having us
 * buffer and decode unbounded text.
 */
const MAX_PAYLOAD_CHARS = 100 * 1024

/**
 * Selection targets we honour. `c` is the clipboard; the empty target is what
 * several programs emit and is treated the same way. The other buffers (`p`,
 * `s`, `0`-`7`) name X11 selections we have no equivalent for.
 */
function isClipboardSelection(selection: string): boolean {
  return selection === '' || selection === 'c'
}

/**
 * Decode an OSC 52 payload of the form `<selection>;<base64>` (the `52;` prefix
 * and the terminator are already stripped by xterm's parser), returning the text
 * to copy, or null when the sequence should be ignored. An empty base64 payload
 * decodes to `''`, which clears the clipboard -- that is how tmux signals
 * "copied nothing".
 */
export function decodeOsc52(data: string): string | null {
  const sep = data.indexOf(';')
  if (sep < 0) return null
  if (!isClipboardSelection(data.slice(0, sep))) return null
  const payload = data.slice(sep + 1)
  if (payload === '?') return null // read request, see the module comment
  if (payload.length > MAX_PAYLOAD_CHARS) return null

  let bytes: Uint8Array
  try {
    const binary = atob(payload)
    bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0))
  } catch {
    return null
  }
  // Terminals send UTF-8. Decode leniently so a truncated sequence still copies
  // the part that arrived rather than nothing at all.
  return new TextDecoder().decode(bytes)
}
