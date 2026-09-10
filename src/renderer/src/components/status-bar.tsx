import type { ReactElement } from 'react'
import type { PaneRecord } from '../mux-model'

export interface StatusBarProps {
  pane: PaneRecord | undefined
  searchOpen: boolean
  searchQuery: string
  onSearchQuery: (q: string) => void
  onSearchNext: () => void
  onSearchPrev: () => void
  onSearchClose: () => void
}

export function StatusBar(props: StatusBarProps): ReactElement {
  const { pane } = props
  let statusText = ''
  let statusClass = ''
  if (pane) {
    if (pane.status === 'connecting') {
      statusText = `Connecting to ${pane.label}…`
      statusClass = 'busy'
    } else if (pane.status === 'authenticating') {
      statusText = `Authenticating ${pane.label}…`
      statusClass = 'busy'
    } else if (pane.status === 'error') {
      statusText = `Connection failed: ${pane.label}`
      statusClass = 'error'
    } else if (pane.dead) {
      statusText = 'Session ended'
      statusClass = ''
    }
  }

  return (
    <div className="status-bar">
      {props.searchOpen ? (
        <div className="search-box">
          <input
            autoFocus
            value={props.searchQuery}
            placeholder="Search terminal…"
            onChange={(e) => props.onSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                e.shiftKey ? props.onSearchPrev() : props.onSearchNext()
              } else if (e.key === 'Escape') {
                props.onSearchClose()
              }
            }}
          />
          <button className="search-btn" onClick={() => props.onSearchPrev()} title="Previous (Shift+Enter)">
            ↑
          </button>
          <button className="search-btn" onClick={() => props.onSearchNext()} title="Next (Enter)">
            ↓
          </button>
          <button className="search-btn" onClick={props.onSearchClose} title="Close (Esc)">
            ×
          </button>
        </div>
      ) : (
        <span className="status-right">
          <kbd>Ctrl+Shift+F</kbd> search
        </span>
      )}
      <span className={`status-left ${statusClass}`}>{pane ? statusText || pane.label : ''}</span>
    </div>
  )
}
