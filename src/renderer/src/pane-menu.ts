/**
 * The pane's right-click menu: when the button opens it, what it offers, and
 * where the menu is drawn.
 *
 * Right-click belongs to the terminal *application* whenever that application
 * has asked for the mouse. A program that enables tracking (X10/VT200/drag/any)
 * is drawing its own UI and reads the right button as one of its inputs -- the
 * way htop, lazygit and `vim` with `set mouse=a` open their own menus. Only an
 * application that never asked for the mouse leaves the button to the muxer,
 * and that is where a pane menu is worth showing.
 *
 * The one override is Shift, borrowed from Windows Terminal: it is the gesture
 * xterm already treats as "this click is the local UI's, not the application's"
 * (`shouldForceSelection`), so a pane menu stays reachable from inside a
 * mouse-aware TUI.
 *
 * Pure -- no DOM, no xterm, no Electron -- so scripts/test-mux.ts can bundle it
 * and run it under plain node.
 */

export type PaneMenuAction = 'toggle-zoom' | 'close-pane' | 'split-row' | 'split-col'

export interface PaneMenuItem {
  action: PaneMenuAction
  label: string
}

/**
 * The menu's entries, in display order. The labels are the ones the Keybindings
 * dialog uses for the same actions: `split-row` lays panes out left/right and
 * `split-col` stacks them top/bottom (see the note in keymap.ts).
 */
export function paneMenuItems(zoomed: boolean): PaneMenuItem[] {
  return [
    { action: 'toggle-zoom', label: zoomed ? 'Unzoom pane' : 'Zoom pane' },
    { action: 'close-pane', label: 'Close pane' },
    { action: 'split-row', label: 'Split left/right' },
    { action: 'split-col', label: 'Split top/bottom' }
  ]
}

export interface MenuTrigger {
  /** `Terminal.modes.mouseTrackingMode`; 'none' when the app never asked for the mouse. */
  mouseTracking: string
  /** Shift held: keep this click for the local UI, as xterm's force-selection does. */
  shiftKey: boolean
}

/** Whether a right-click should open the pane menu rather than be reported to the app. */
export function paneMenuRequested(trigger: MenuTrigger): boolean {
  return trigger.mouseTracking === 'none' || trigger.shiftKey
}

export interface MenuPoint {
  x: number
  y: number
}

/** Gap kept between the menu and the window edge. */
export const MENU_MARGIN = 4

/**
 * Keep a menu opened at (x, y) inside the window. A right-click near the right
 * or bottom edge -- the common case, since that is where a prompt's last line
 * ends up -- would otherwise draw it partly off-screen.
 */
export function clampMenuPosition(
  x: number,
  y: number,
  menu: { width: number; height: number },
  viewport: { width: number; height: number },
  margin = MENU_MARGIN
): MenuPoint {
  // A menu taller than the window cannot satisfy both margins; pinning the top
  // at the margin keeps the first entry readable, which beats clamping to a
  // negative offset the user cannot scroll back from.
  const maxX = Math.max(margin, viewport.width - menu.width - margin)
  const maxY = Math.max(margin, viewport.height - menu.height - margin)
  return {
    x: Math.min(Math.max(x, margin), maxX),
    y: Math.min(Math.max(y, margin), maxY)
  }
}
