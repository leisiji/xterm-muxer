/**
 * QuickSelect (wezterm `QuickSelectArgs`, Alt+I): scan the visible screen for
 * patterns, overlay single/double-character labels on each match and copy the
 * chosen match to the clipboard.
 *
 * The matching/labelling logic is pure so it can be unit-tested; terminal-pane
 * extracts the buffer lines and renders/handles the overlay.
 */

/** A visible buffer line: text plus the cell column of each character. */
export interface QuickLine {
  /** Absolute buffer line index (scrollback included). */
  row: number
  text: string
  /** columns[i] = cell column of text[i] (wide chars map to their start column). */
  columns: number[]
}

export interface QuickMatch {
  text: string
  /** Absolute buffer line of the match. */
  row: number
  /** Start cell column. */
  col: number
  /** Width in cells. */
  width: number
}

/**
 * wezterm combines `quick_select_patterns` (`[\w./-]+` in the user's config)
 * with its built-in patterns; we mirror the most useful built-ins (URL + path).
 */
export const DEFAULT_QUICK_SELECT_PATTERN =
  /(?:https?:\/\/|git@|git:\/\/|ssh:\/\/|ftp:\/\/|file:\/\/)\S+|(?:[.\w\-@~]+)?(?:\/+[.\w\-@]+)+|[\w./-]+/g

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz'

/** Find every pattern match across the supplied lines (left-to-right, per line). */
export function findMatches(lines: QuickLine[], pattern: RegExp = DEFAULT_QUICK_SELECT_PATTERN): QuickMatch[] {
  const flags = pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g'
  const re = new RegExp(pattern.source, flags)
  const out: QuickMatch[] = []
  for (const line of lines) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(line.text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++
        continue
      }
      const startCol = line.columns[m.index] ?? 0
      const endCol = line.columns[m.index + m[0].length - 1] ?? startCol
      out.push({ text: m[0], row: line.row, col: startCol, width: Math.max(1, endCol - startCol + 1) })
    }
  }
  return out
}

/**
 * The match covering a cell column on one line, if any.
 *
 * Double-click uses this so that picking a word by hand lands on exactly what the
 * overlay would have picked for that cell -- a path, a URL or a qualified name
 * comes out whole either way, because there is one set of rules rather than a
 * regex here and a character class (xterm's own `wordSeparator`) there.
 */
export function matchAtColumn(
  line: QuickLine,
  col: number,
  pattern: RegExp = DEFAULT_QUICK_SELECT_PATTERN
): QuickMatch | null {
  for (const match of findMatches([line], pattern)) {
    if (col >= match.col && col < match.col + match.width) return match
  }
  return null
}

/**
 * Labels for `n` matches. Up to 26 matches get a single letter; beyond that a
 * fixed two-character (then three-character) label is used, so no label is a
 * prefix of another (which keeps resolution unambiguous).
 */
export function assignLabels(n: number): string[] {
  if (n <= 0) return []
  let width = 1
  while (Math.pow(ALPHABET.length, width) < n) width++
  const labels: string[] = []
  for (let i = 0; i < n; i++) {
    let v = i
    let s = ''
    for (let d = 0; d < width; d++) {
      s = ALPHABET[v % ALPHABET.length] + s
      v = Math.floor(v / ALPHABET.length)
    }
    labels.push(s)
  }
  return labels
}

export type LabelResolution =
  | { kind: 'commit'; index: number }
  | { kind: 'pending' }
  | { kind: 'none' }

/** Resolve a typed prefix against the label set. */
export function resolveLabel(labels: string[], prefix: string): LabelResolution {
  if (!prefix) return { kind: 'pending' }
  const exact = labels.indexOf(prefix)
  if (exact >= 0) return { kind: 'commit', index: exact }
  if (labels.some((l) => l.startsWith(prefix))) return { kind: 'pending' }
  return { kind: 'none' }
}
