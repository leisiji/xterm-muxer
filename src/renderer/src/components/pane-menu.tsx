import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { clampMenuPosition, paneMenuItems } from '../pane-menu'
import type { PaneMenuAction } from '../pane-menu'

export interface PaneMenuProps {
  /** Where the right-click happened, in viewport coordinates. */
  x: number
  y: number
  /** True while this pane is zoomed, so the toggle reads "Unzoom pane". */
  zoomed: boolean
  onSelect: (action: PaneMenuAction) => void
  onClose: () => void
}

/**
 * The pane right-click menu (see pane-menu.ts for when it appears).
 *
 * Rendered at the app root rather than inside the pane: `.pane-abs` clips its
 * content, and a pane at the bottom or right of a split would have had the menu
 * cut off at its own edge. Being a sibling of the panes also keeps it out of the
 * way of xterm's own mouse handling.
 */
export function PaneMenu(props: PaneMenuProps): ReactElement {
  const { x, y, onClose } = props
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })

  // Measure before paint, so the menu is never drawn hanging off the edge and
  // then moved. The first render's position is a guess; the clamp corrects it
  // in the same frame.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const box = el.getBoundingClientRect()
    setPos(
      clampMenuPosition(
        x,
        y,
        { width: box.width, height: box.height },
        { width: window.innerWidth, height: window.innerHeight }
      )
    )
  }, [x, y])

  // Escape closes. Capture phase, like the app's own mux handler: the keydown
  // target is xterm's helper textarea, which stops propagation on the keys it
  // sends to the pty, so a listener in the bubble phase would never see it.
  // (No direct binding claims Escape, so the mux handler ahead of this one lets
  // it past.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return (
    <div
      className="pane-menu-layer"
      // Any click outside closes the menu, as it does everywhere else. The click
      // that opened it is already over, and a dismissing click should not also
      // act on what is underneath -- which is what a terminal would have done
      // with it. Right-clicks land here too, so the button that can move the
      // menu also closes this one.
      onMouseDown={onClose}
      // Nothing closes on `contextmenu`: Chromium dispatches it after the
      // matching `mouseup`, so the menu is already under the pointer by the time
      // the right-click that *opened* it gets there -- dismissing on it would
      // shut the menu on the same gesture that asked for it. (It lands on this
      // layer rather than on the menu for the same reason it must not dismiss:
      // the pointer is on the menu's corner, where hit-testing resolves to the
      // layer.) All that is left to do here is keep the OS menu away.
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        ref={ref}
        className="pane-menu"
        style={{ left: pos.x, top: pos.y }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {paneMenuItems(props.zoomed).map((item) => (
          <button
            key={item.action}
            type="button"
            className="pane-menu-item"
            onClick={() => props.onSelect(item.action)}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  )
}
