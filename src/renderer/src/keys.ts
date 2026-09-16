/**
 * Default keybindings, mirroring wezterm's Windows defaults (commands.rs):
 *   New Tab                  Ctrl+Shift+T
 *   Split left/right         Ctrl+Shift+Alt+5  (Shift+5 = %)
 *   Split top/bottom         Ctrl+Shift+Alt+'  (Shift+' = ")
 *   Close pane/tab           Ctrl+Shift+W
 *   Next/Prev tab            Ctrl+Tab / Ctrl+Shift+Tab, Ctrl+PageDown / Ctrl+PageUp
 *   Focus direction          Alt+Arrows
 *   Zoom pane                Ctrl+Shift+Z
 *   Copy / Paste             Ctrl+Shift+C / Ctrl+Shift+V
 *   Search                   Ctrl+Shift+F
 *   New SSH connection       Ctrl+Shift+S
 *
 * tmux-style leader (prefix) key: Alt+N arms leader mode by default, then
 * (both the prefix and this table are user-configurable — see keymap.ts)
 *   Alt+N -            split vertical   (tmux split-window -v, top/bottom)
 *   Alt+N Shift+-      split horizontal (tmux split-window -h, left/right)
 *   Alt+N c            new tab
 *   Alt+N x            close the focused pane
 *   Alt+N z            toggle pane zoom  (wezterm TogglePaneZoomState)
 *   Alt+N ,            rename the current tab (wezterm PromptInputLine)
 *   Alt+N n / p        next / previous tab
 *   Alt+N 1..9         activate tab N    (wezterm LEADER+1..9 ActivateTab)
 *   Alt+N h/j/k/l      focus pane Left/Down/Up/Right (wezterm ActivatePaneDirection)
 *   Alt+N r            enter resize mode; then h/j/k/l adjust pane size
 */

export type Mod = 'Ctrl' | 'Shift' | 'Alt' | 'Meta'

export interface Combo {
  key: string
  mods: Mod[]
}

/**
 * The subset of a KeyboardEvent the binding layer needs. A plain object literal
 * satisfies it, which is what makes the keymap and the leader decoder unit-testable
 * without a DOM; a real KeyboardEvent is structurally assignable.
 */
export interface KeyEventLike {
  key: string
  ctrlKey: boolean
  altKey: boolean
  metaKey: boolean
  shiftKey: boolean
  /** Physical key (e.g. 'KeyN'), used as a layout fallback for alphanumeric bindings. */
  code?: string
  /** True while an IME composition is in flight; such an event is never a binding. */
  isComposing?: boolean
}

/** Alias kept for the leader decoder's existing callers. */
export type LeaderKeyEvent = KeyEventLike

export type LeaderAction =
  | 'split-row'
  | 'split-col'
  | 'new-tab'
  | 'close-pane'
  | 'toggle-zoom'
  | 'rename-tab'
  | 'next-tab'
  | 'prev-tab'
  | 'focus-left'
  | 'focus-down'
  | 'focus-up'
  | 'focus-right'
  | 'resize-mode'

export type LeaderKeyResult =
  /** A bare modifier keydown ("Shift" before "_"): stay in leader mode. */
  | { kind: 'ignore' }
  /** A recognised leader command. */
  | { kind: 'action'; action: LeaderAction }
  /** 1-based tab number (leader + 1..9). */
  | { kind: 'tab-index'; index: number }
  /** Anything else: leave leader mode and swallow the key. */
  | { kind: 'cancel' }

/**
 * Keydowns that carry no binding of their own. A chord like Shift+- emits the bare
 * modifier's keydown first ("Shift", then "_"), so these must be ignored rather than
 * treated as a cancel — in the dispatcher (so leader stays armed) and in the recorder
 * (so it waits for the real key).
 */
export const BARE_MODIFIERS = new Set([
  'Shift',
  'Control',
  'Alt',
  'Meta',
  'AltGraph',
  'CapsLock',
  'NumLock',
  'ScrollLock',
  'OS',
  'ContextMenu'
])

/** US-layout unshifted key -> the character Shift produces for it. */
const UNSHIFTED_TO_SHIFTED: Record<string, string> = {
  '-': '_',
  '=': '+',
  '`': '~',
  '[': '{',
  ']': '}',
  '\\': '|',
  ';': ':',
  "'": '"',
  ',': '<',
  '.': '>',
  '/': '?',
  '1': '!',
  '2': '@',
  '3': '#',
  '4': '$',
  '5': '%',
  '6': '^',
  '7': '&',
  '8': '*',
  '9': '(',
  '0': ')'
}

const SHIFTED_TO_UNSHIFTED: Record<string, string> = {}
for (const [plain, shifted] of Object.entries(UNSHIFTED_TO_SHIFTED)) SHIFTED_TO_UNSHIFTED[shifted] = plain

/**
 * The unshifted form of a shifted character (`_` -> `-`, `%` -> `5`), or the key
 * itself when it is not a shifted US-layout character. Two bindings that name the
 * same physical key this way (Ctrl+Shift+5 and Ctrl+Shift+%) are the same chord and
 * conflict detection must treat them as such.
 */
export function unshiftedKey(key: string): string {
  return SHIFTED_TO_UNSHIFTED[key] ?? key
}

/**
 * Default leader key table, mirroring tmux's prefix table: `-` splits top/bottom
 * (`split-col` in the pane tree), `_` (Shift+-) splits left/right (`split-row`),
 * `c` opens a tab, `x` closes the focused pane, `z` toggles pane zoom, `,` renames
 * the tab, `n`/`p` cycle tabs, `h`/`j`/`k`/`l` move focus and `r` enters resize mode.
 * `1`..`9` activate a tab by index and are handled by the decoder, not the table.
 *
 * Entries are *bare keys*: a leader key is pressed without Ctrl/Alt (the decoder
 * enforces that), and Shift is deliberately not significant here, so `Shift+c` opens a
 * tab just like `c`. `_` and `-` are distinct entries because they are distinct keys.
 */
export const DEFAULT_LEADER_KEYS: Record<LeaderAction, string[]> = {
  'split-col': ['-'],
  'split-row': ['_'],
  'new-tab': ['c'],
  'close-pane': ['x'],
  'toggle-zoom': ['z'],
  'rename-tab': [','],
  'next-tab': ['n'],
  'prev-tab': ['p'],
  'focus-left': ['h'],
  'focus-down': ['j'],
  'focus-up': ['k'],
  'focus-right': ['l'],
  'resize-mode': ['r']
}

/** Look a bare key up in a leader table (case-insensitive). */
function findLeaderAction(table: Record<string, string[]>, key: string): LeaderAction | null {
  const needle = key.toLowerCase()
  for (const [action, keys] of Object.entries(table)) {
    if (keys.some((k) => k.toLowerCase() === needle)) return action as LeaderAction
  }
  return null
}

/**
 * Decode the key pressed right after the leader prefix. Ctrl/Alt/Meta must be up —
 * a leader key is a bare key — while Shift is deliberately insignificant: `Shift+-`
 * and `-` are told apart by the character they produce (`_` vs `-`), not by the
 * modifier. When Shift *is* held the shifted form of the key is tried first, so a
 * layout that reports `-` for Shift+- still matches the `_` entry.
 */
export function matchLeaderKey(e: LeaderKeyEvent, table: Record<string, string[]>): LeaderKeyResult {
  if (BARE_MODIFIERS.has(e.key)) return { kind: 'ignore' }
  if (e.ctrlKey || e.altKey || e.metaKey) return { kind: 'cancel' }
  if (e.shiftKey) {
    const shifted = UNSHIFTED_TO_SHIFTED[e.key]
    if (shifted) {
      const action = findLeaderAction(table, shifted)
      if (action) return { kind: 'action', action }
    }
  }
  const action = findLeaderAction(table, e.key)
  if (action) return { kind: 'action', action }
  if (/^[1-9]$/.test(e.key)) return { kind: 'tab-index', index: Number(e.key) }
  return { kind: 'cancel' }
}

/** The default-table form the dispatcher uses (and the existing tests call). */
export function resolveLeaderKey(
  e: LeaderKeyEvent,
  table: Record<string, string[]> = DEFAULT_LEADER_KEYS
): LeaderKeyResult {
  return matchLeaderKey(e, table)
}

export type ResizeAction = 'left' | 'right' | 'up' | 'down'

export type ResizeKeyResult =
  /** A bare modifier keydown: stay in resize mode. */
  | { kind: 'ignore' }
  /** Adjust the divider. */
  | { kind: 'resize'; action: ResizeAction }
  /** Any other key: leave resize mode and swallow it. */
  | { kind: 'exit' }

/**
 * Decode a key while the resize key table (leader+r) is active.
 *
 * Unlike the leader table, these keys are deliberately NOT configurable: `h`/`j`/`k`/`l`
 * are a momentary navigation idiom, and only the chord that *enters* the mode
 * (`leader.resize-mode`) can be rebound.
 */
export function resolveResizeKey(e: LeaderKeyEvent): ResizeKeyResult {
  if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') {
    return { kind: 'ignore' }
  }
  const plain = !e.ctrlKey && !e.altKey && !e.metaKey
  if (plain && e.key.toLowerCase() === 'h') return { kind: 'resize', action: 'left' }
  if (plain && e.key.toLowerCase() === 'l') return { kind: 'resize', action: 'right' }
  if (plain && e.key.toLowerCase() === 'k') return { kind: 'resize', action: 'up' }
  if (plain && e.key.toLowerCase() === 'j') return { kind: 'resize', action: 'down' }
  return { kind: 'exit' }
}

export function combo(key: string, mods: Mod[]): Combo {
  return { key, mods }
}

/**
 * True when the event's modifiers match the combo exactly: every modifier the combo
 * does not name must be up. `Ctrl` also matches Meta on macOS — the two are folded
 * into one axis, since a binding that meant "Ctrl but not Cmd" is not expressible
 * across platforms.
 */
export function modsMatch(e: KeyEventLike, c: Combo): boolean {
  const mods = c.mods
  const wantCtrl = mods.includes('Ctrl')
  const wantShift = mods.includes('Shift')
  const wantAlt = mods.includes('Alt')
  const wantMeta = mods.includes('Meta')
  const ctrlHeld = e.ctrlKey || e.metaKey
  return (
    ctrlHeld === (wantCtrl || wantMeta) &&
    e.shiftKey === wantShift &&
    e.altKey === wantAlt &&
    (wantMeta ? e.metaKey : true)
  )
}

/** Match an event against a combo: key (case-insensitive) plus exact modifiers. */
export function isCombo(e: KeyEventLike, c: Combo): boolean {
  return e.key.toLowerCase() === c.key.toLowerCase() && modsMatch(e, c)
}

/** Helper: true when the event matches exactly the given modifier set and key. */
export function isKey(e: KeyEventLike, key: string, mods: Mod[] = []): boolean {
  return isCombo(e, combo(key, mods))
}
