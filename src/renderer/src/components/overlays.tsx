import type { ReactElement } from 'react'

export interface SearchOverlayProps {
  open: boolean
  query: string
  onQuery: (q: string) => void
  onNext: () => void
  onPrev: () => void
  onClose: () => void
}

/**
 * Floating search box, shown only while searching (Ctrl+Shift+F). It replaces
 * the old always-visible bottom status bar.
 */
export function SearchOverlay(props: SearchOverlayProps): ReactElement | null {
  if (!props.open) return null
  return (
    <div className="search-overlay">
      <input
        autoFocus
        value={props.query}
        placeholder="Search terminal…"
        onChange={(e) => props.onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            e.shiftKey ? props.onPrev() : props.onNext()
          } else if (e.key === 'Escape') {
            props.onClose()
          }
        }}
      />
      <button className="search-btn" onClick={props.onPrev} title="Previous (Shift+Enter)">
        ↑
      </button>
      <button className="search-btn" onClick={props.onNext} title="Next (Enter)">
        ↓
      </button>
      <button className="search-btn" onClick={props.onClose} title="Close (Esc)">
        ×
      </button>
    </div>
  )
}

/** Transient hint shown while the tmux-style leader (Alt+N) is armed. */
export function LeaderOverlay(props: { active: boolean }): ReactElement | null {
  if (!props.active) return null
  return (
    <div className="leader-overlay">
      <kbd>-</kbd> split vertical · <kbd>Shift+-</kbd> split horizontal · <kbd>c</kbd> new tab · <kbd>x</kbd> close
      pane
    </div>
  )
}
