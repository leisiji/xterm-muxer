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
 * tmux-style leader (prefix) key: Alt+N arms leader mode, then
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

/** The subset of a KeyboardEvent the leader decoder needs (easy to unit test). */
export interface LeaderKeyEvent {
  key: string
  ctrlKey: boolean
  altKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

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
 * Decode the key pressed right after the leader prefix (Alt+N), mirroring
 * tmux: `-` splits top/bottom, `Shift+-` (`_`) splits left/right, `c` opens a tab,
 * `x` closes the focused pane, `z` toggles pane zoom, `,` renames the tab,
 * `n`/`p` cycle tabs and `1`..`9` activate a tab by index.
 *
 * A chord like Shift+- emits the bare modifier's keydown first ("Shift", then
 * "_"), so bare modifiers must not cancel leader mode.
 */
export function resolveLeaderKey(e: LeaderKeyEvent): LeaderKeyResult {
  if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') {
    return { kind: 'ignore' }
  }
  const plain = !e.ctrlKey && !e.altKey && !e.metaKey
  if (plain && (e.key === '_' || (e.key === '-' && e.shiftKey))) return { kind: 'action', action: 'split-row' }
  if (plain && e.key === '-') return { kind: 'action', action: 'split-col' }
  if (plain && e.key.toLowerCase() === 'c') return { kind: 'action', action: 'new-tab' }
  if (plain && e.key.toLowerCase() === 'x') return { kind: 'action', action: 'close-pane' }
  if (plain && e.key.toLowerCase() === 'z') return { kind: 'action', action: 'toggle-zoom' }
  if (plain && e.key === ',') return { kind: 'action', action: 'rename-tab' }
  if (plain && e.key.toLowerCase() === 'n') return { kind: 'action', action: 'next-tab' }
  if (plain && e.key.toLowerCase() === 'p') return { kind: 'action', action: 'prev-tab' }
  if (plain && e.key.toLowerCase() === 'h') return { kind: 'action', action: 'focus-left' }
  if (plain && e.key.toLowerCase() === 'j') return { kind: 'action', action: 'focus-down' }
  if (plain && e.key.toLowerCase() === 'k') return { kind: 'action', action: 'focus-up' }
  if (plain && e.key.toLowerCase() === 'l') return { kind: 'action', action: 'focus-right' }
  if (plain && e.key.toLowerCase() === 'r') return { kind: 'action', action: 'resize-mode' }
  if (plain && /^[1-9]$/.test(e.key)) return { kind: 'tab-index', index: Number(e.key) }
  return { kind: 'cancel' }
}

export type ResizeAction = 'left' | 'right' | 'up' | 'down'

export type ResizeKeyResult =
  /** A bare modifier keydown: stay in resize mode. */
  | { kind: 'ignore' }
  /** Adjust the divider. */
  | { kind: 'resize'; action: ResizeAction }
  /** Any other key: leave resize mode and swallow it. */
  | { kind: 'exit' }

/** Decode a key while the resize key table (leader+r) is active. */
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

/** Match a KeyboardEvent against a combo. `Ctrl` also matches Meta on macOS. */
export function isCombo(e: KeyboardEvent, c: Combo): boolean {
  const mods = c.mods
  const wantCtrl = mods.includes('Ctrl')
  const wantShift = mods.includes('Shift')
  const wantAlt = mods.includes('Alt')
  const wantMeta = mods.includes('Meta')
  const ctrlHeld = e.ctrlKey || e.metaKey
  return (
    e.key.toLowerCase() === c.key.toLowerCase() &&
    ctrlHeld === (wantCtrl || wantMeta) &&
    e.shiftKey === wantShift &&
    e.altKey === wantAlt &&
    (wantMeta ? e.metaKey : true)
  )
}

/** Helper: true when the event matches exactly the given modifier set and key. */
export function isKey(e: KeyboardEvent, key: string, mods: Mod[] = []): boolean {
  return isCombo(e, combo(key, mods))
}
