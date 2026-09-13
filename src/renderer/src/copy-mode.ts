/**
 * Copy mode: a vim/wezterm-style keyboard navigation mode over the terminal
 * scrollback buffer. The logic here is pure (a {@link CopyView} abstracts the
 * xterm buffer) so it can be unit-tested without a DOM; `terminal-pane.tsx`
 * maps the commands onto xterm's selection/scroll APIs.
 *
 * Key bindings mirror the user's `~/.config/wezterm/wezterm.lua` copy_mode table,
 * entered with Alt+X.
 */

export type CopySelectionMode = 'cell' | 'line' | 'block'

export interface CopyCursor {
  x: number
  y: number
}

export interface CopyModeState {
  active: boolean
  cursor: CopyCursor
  /** Selection start; `null` means "just moving the cursor". */
  anchor: CopyCursor | null
  mode: CopySelectionMode
}

/** Read-only view over the terminal buffer needed for copy-mode movement. */
export interface CopyView {
  /** Total lines in the buffer (scrollback + viewport). */
  lineCount: number
  cols: number
  rows: number
  /** Full-width text of buffer line `y` (no trailing-space trimming). */
  lineText: (y: number) => string
}

export type CopyAction =
  | 'moveLeft'
  | 'moveRight'
  | 'moveUp'
  | 'moveDown'
  | 'forwardWord'
  | 'backwardWord'
  | 'forwardWordEnd'
  | 'lineStart'
  | 'lineEnd'
  | 'lineStartContent'
  | 'bufferTop'
  | 'bufferBottom'
  | 'pageUp'
  | 'pageDown'

export type CopyCommand =
  | { type: 'move'; action: CopyAction; repeat?: number }
  | { type: 'mode'; mode: CopySelectionMode }
  | { type: 'copy' }
  | { type: 'close' }
  | { type: 'search' }
  | { type: 'nextMatch' }
  | { type: 'priorMatch' }

export interface CopyKeyEvent {
  key: string
  ctrlKey: boolean
  altKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

export const emptyCopyState: CopyModeState = {
  active: false,
  cursor: { x: 0, y: 0 },
  anchor: null,
  mode: 'cell'
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t'
}

function isWordChar(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch)
}

/** Index just past the last non-space character (0 for an all-blank line). */
function contentEnd(text: string): number {
  let end = text.length
  while (end > 0 && isSpace(text[end - 1])) end--
  return end
}

export function clampCursor(view: CopyView, c: CopyCursor): CopyCursor {
  return {
    x: clamp(c.x, 0, Math.max(0, view.cols - 1)),
    y: clamp(c.y, 0, Math.max(0, view.lineCount - 1))
  }
}

// ---------- word motions ----------

function forwardWord(view: CopyView, c: CopyCursor): CopyCursor {
  let y = c.y
  let x = c.x
  for (;;) {
    const text = view.lineText(y)
    // Skip the rest of the current token, then any whitespace.
    while (x < text.length && !isSpace(text[x])) x++
    while (x < text.length && isSpace(text[x])) x++
    if (x < text.length) return { x, y }
    if (y >= view.lineCount - 1) return { x: Math.max(0, contentEnd(text) - 1), y }
    y++
    x = 0
  }
}

function backwardWord(view: CopyView, c: CopyCursor): CopyCursor {
  let y = c.y
  let x = c.x - 1
  for (;;) {
    if (x < 0) {
      if (y === 0) return { x: 0, y: 0 }
      y--
      x = Math.max(0, view.lineText(y).length - 1)
      continue
    }
    const text = view.lineText(y)
    while (x >= 0 && (x >= text.length || isSpace(text[x]))) x--
    if (x < 0) {
      if (y === 0) return { x: 0, y: 0 }
      y--
      x = Math.max(0, view.lineText(y).length - 1)
      continue
    }
    const wc = isWordChar(text[x])
    while (x > 0 && !isSpace(text[x - 1]) && isWordChar(text[x - 1]) === wc) x--
    return { x, y }
  }
}

function forwardWordEnd(view: CopyView, c: CopyCursor): CopyCursor {
  let y = c.y
  let x = c.x
  for (;;) {
    const text = view.lineText(y)
    x++
    while (x < text.length && isSpace(text[x])) x++
    if (x < text.length) {
      const wc = isWordChar(text[x])
      while (x + 1 < text.length && !isSpace(text[x + 1]) && isWordChar(text[x + 1]) === wc) x++
      return { x, y }
    }
    if (y >= view.lineCount - 1) return { x: Math.max(0, contentEnd(text) - 1), y }
    y++
    x = -1
  }
}

// ---------- movement ----------

/** Apply one movement action, returning the next state (anchor preserved). */
export function moveCopy(state: CopyModeState, action: CopyAction, view: CopyView): CopyModeState {
  const c = state.cursor
  let cursor: CopyCursor
  switch (action) {
    case 'moveLeft':
      cursor = { x: Math.max(0, c.x - 1), y: c.y }
      break
    case 'moveRight':
      cursor = { x: Math.min(view.cols - 1, c.x + 1), y: c.y }
      break
    case 'moveUp':
      cursor = { x: c.x, y: Math.max(0, c.y - 1) }
      break
    case 'moveDown':
      cursor = { x: c.x, y: Math.min(view.lineCount - 1, c.y + 1) }
      break
    case 'pageUp':
      cursor = { x: c.x, y: Math.max(0, c.y - view.rows) }
      break
    case 'pageDown':
      cursor = { x: c.x, y: Math.min(view.lineCount - 1, c.y + view.rows) }
      break
    case 'forwardWord':
      cursor = forwardWord(view, c)
      break
    case 'backwardWord':
      cursor = backwardWord(view, c)
      break
    case 'forwardWordEnd':
      cursor = forwardWordEnd(view, c)
      break
    case 'lineStart':
      cursor = { x: 0, y: c.y }
      break
    case 'lineEnd':
      cursor = { x: Math.max(0, contentEnd(view.lineText(c.y)) - 1), y: c.y }
      break
    case 'lineStartContent': {
      const text = view.lineText(c.y)
      let x = 0
      while (x < text.length && isSpace(text[x])) x++
      cursor = { x: x >= text.length ? 0 : x, y: c.y }
      break
    }
    case 'bufferTop':
      cursor = { x: 0, y: 0 }
      break
    case 'bufferBottom':
      cursor = { x: Math.max(0, contentEnd(view.lineText(view.lineCount - 1)) - 1), y: view.lineCount - 1 }
      break
  }
  return { ...state, cursor: clampCursor(view, cursor) }
}

/** Repeat a movement `n` times (Alt+w/b/e in the wezterm config = 5×). */
export function repeatMove(state: CopyModeState, action: CopyAction, n: number, view: CopyView): CopyModeState {
  let next = state
  for (let i = 0; i < n; i++) next = moveCopy(next, action, view)
  return next
}

// ---------- selection ----------

export interface CopyRange {
  start: CopyCursor
  end: CopyCursor
}

/** Ordered selection rectangle/corner pair, or null when nothing is selected. */
export function selectionRange(state: CopyModeState): CopyRange | null {
  if (!state.anchor) return null
  const a = state.anchor
  const b = state.cursor
  if (state.mode === 'line') {
    const y1 = Math.min(a.y, b.y)
    const y2 = Math.max(a.y, b.y)
    return { start: { x: 0, y: y1 }, end: { x: 0, y: y2 } }
  }
  const aFirst = a.y < b.y || (a.y === b.y && a.x <= b.x)
  return aFirst ? { start: { ...a }, end: { ...b } } : { start: { ...b }, end: { ...a } }
}

/** Number of cells in a linear (reading-order) selection, inclusive. */
export function linearSelectionLength(range: CopyRange, cols: number): number {
  return (range.end.y - range.start.y) * cols + (range.end.x - range.start.x) + 1
}

// ---------- search ----------

/**
 * Find `query` on/after (or on/before) the cursor, wrapping through the buffer.
 * Returns the match's start position or null. Case-insensitive, single line.
 */
export function searchFrom(view: CopyView, from: CopyCursor, query: string, forward: boolean): CopyCursor | null {
  if (!query) return null
  const total = view.lineCount
  const q = query.toLowerCase()
  const step = forward ? 1 : -1
  // `d === total` revisits the starting line so a lone match wraps onto itself.
  for (let d = 0; d <= total; d++) {
    const y = (((from.y + step * d) % total) + total) % total
    const text = view.lineText(y).toLowerCase()
    if (forward) {
      const startX = d === 0 ? from.x + 1 : 0
      const idx = text.indexOf(q, startX)
      if (idx >= 0) return { x: idx, y }
    } else {
      const startX = d === 0 ? from.x - 1 : text.length - 1
      const idx = text.lastIndexOf(q, Math.max(0, startX))
      if (idx >= 0) return { x: idx, y }
    }
  }
  return null
}

// ---------- key decoding ----------

/**
 * Decode the key pressed while copy mode is active, matching the wezterm
 * `copy_mode` key table (Alt+w/b/e repeat 5×, Ctrl+u/d page, v/V/Ctrl+v select).
 */
export function decodeCopyKey(e: CopyKeyEvent): CopyCommand | null {
  if (e.altKey && !e.ctrlKey && !e.metaKey) {
    const k = e.key.toLowerCase()
    if (k === 'w') return { type: 'move', action: 'forwardWord', repeat: 5 }
    if (k === 'b') return { type: 'move', action: 'backwardWord', repeat: 5 }
    if (k === 'e') return { type: 'move', action: 'forwardWordEnd', repeat: 5 }
    return null
  }
  if (e.ctrlKey && !e.altKey && !e.metaKey) {
    if (e.key === 'u') return { type: 'move', action: 'pageUp' }
    if (e.key === 'd') return { type: 'move', action: 'pageDown' }
    if (e.key === 'v') return { type: 'mode', mode: 'block' }
    return null
  }
  switch (e.key) {
    case 'h':
    case 'ArrowLeft':
      return { type: 'move', action: 'moveLeft' }
    case 'j':
    case 'ArrowDown':
      return { type: 'move', action: 'moveDown' }
    case 'k':
    case 'ArrowUp':
      return { type: 'move', action: 'moveUp' }
    case 'l':
    case 'ArrowRight':
      return { type: 'move', action: 'moveRight' }
    case 'w':
      return { type: 'move', action: 'forwardWord' }
    case 'b':
      return { type: 'move', action: 'backwardWord' }
    case 'e':
      return { type: 'move', action: 'forwardWordEnd' }
    case 'H':
      return { type: 'move', action: 'lineStart' }
    case 'L':
      return { type: 'move', action: 'lineEnd' }
    case '^':
      return { type: 'move', action: 'lineStartContent' }
    case 'g':
      return { type: 'move', action: 'bufferTop' }
    case 'G':
      return { type: 'move', action: 'bufferBottom' }
    case 'v':
      return { type: 'mode', mode: 'cell' }
    case 'V':
      return { type: 'mode', mode: 'line' }
    case 'y':
      return { type: 'copy' }
    case 'q':
    case 'Escape':
      return { type: 'close' }
    case '/':
      return { type: 'search' }
    case 'n':
      return { type: 'nextMatch' }
    case 'N':
      return { type: 'priorMatch' }
    default:
      return null
  }
}
