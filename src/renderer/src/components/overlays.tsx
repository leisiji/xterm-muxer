import { useEffect, useRef, useState } from 'react'
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

export interface RenameTabOverlayProps {
  open: boolean
  /** Initial text (the tab's current display name). */
  initial: string
  onCancel: () => void
  onSubmit: (name: string) => void
}

/**
 * Inline prompt for renaming the current tab (leader+,), mirroring wezterm's
 * `PromptInputLine`. Enter applies, Esc cancels; an empty name reverts to the
 * automatic pane-derived title.
 */
export function RenameTabOverlay(props: RenameTabOverlayProps): ReactElement | null {
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (props.open) {
      // Start empty: the current name is only shown as a placeholder hint.
      setValue('')
      inputRef.current?.focus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open])

  if (!props.open) return null
  return (
    <div className="rename-overlay">
      <span className="rename-label">Rename tab</span>
      <input
        ref={inputRef}
        autoFocus
        value={value}
        placeholder={props.initial || 'tab name (empty = automatic)'}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            props.onSubmit(value.trim())
          } else if (e.key === 'Escape') {
            e.preventDefault()
            props.onCancel()
          }
        }}
      />
    </div>
  )
}

/** Transient hint shown while the tmux-style leader (Alt+N) is armed. */
export function LeaderOverlay(props: { active: boolean }): ReactElement | null {
  if (!props.active) return null
  return (
    <div className="leader-overlay">
      <kbd>-</kbd>/<kbd>Shift+-</kbd> split · <kbd>c</kbd> new tab · <kbd>x</kbd> close · <kbd>z</kbd> zoom · <kbd>,</kbd>
      rename · <kbd>n</kbd>/<kbd>p</kbd> tab · <kbd>1</kbd>-<kbd>9</kbd> tab · <kbd>h</kbd>/<kbd>j</kbd>/<kbd>k</kbd>/<kbd>l</kbd>
      pane · <kbd>r</kbd> resize
    </div>
  )
}

/** Transient hint shown while the resize key table (leader+r) is active. */
export function ResizeOverlay(props: { active: boolean }): ReactElement | null {
  if (!props.active) return null
  return (
    <div className="leader-overlay resize-overlay">
      RESIZE · <kbd>h</kbd>/<kbd>j</kbd>/<kbd>k</kbd>/<kbd>l</kbd> adjust pane · <kbd>Esc</kbd> done
    </div>
  )
}
