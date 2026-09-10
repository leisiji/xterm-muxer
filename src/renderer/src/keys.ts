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
 */

export type Mod = 'Ctrl' | 'Shift' | 'Alt' | 'Meta'

export interface Combo {
  key: string
  mods: Mod[]
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
