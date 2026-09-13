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

export type LeaderAction = 'split-row' | 'split-col' | 'new-tab' | 'close-pane'

export type LeaderKeyResult =
  /** A bare modifier keydown ("Shift" before "_"): stay in leader mode. */
  | { kind: 'ignore' }
  /** A recognised leader command. */
  | { kind: 'action'; action: LeaderAction }
  /** Anything else: leave leader mode and swallow the key. */
  | { kind: 'cancel' }

/**
 * Decode the key pressed right after the leader prefix (Alt+N), mirroring
 * tmux: `-` splits top/bottom, `Shift+-` (`_`) splits left/right, `c` opens a tab,
 * `x` closes the focused pane.
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
  return { kind: 'cancel' }
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
