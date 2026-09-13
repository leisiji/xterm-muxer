import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { RendererConfig } from '../types'

export interface SettingsValues {
  font: { family: string; size: number; lineHeight: number }
  scrollback: number
  focusFollowsMouse: boolean
}

export interface SettingsDialogProps {
  open: boolean
  config: RendererConfig
  onCancel: () => void
  onApply: (values: SettingsValues) => void
}

/** A few widely-available monospace fonts offered as suggestions. */
const FONT_SUGGESTIONS = [
  'Maple Mono NF CN',
  'Maple Mono NF',
  'Maple Mono',
  'Cascadia Mono',
  'Cascadia Code',
  'JetBrains Mono',
  'Fira Code',
  'Consolas',
  'Menlo',
  'monospace'
]

const availabilityCache = new Map<string, boolean>()

/**
 * Best-effort detection of an installed font by comparing the measured width of
 * a sample string against the generic fallbacks. Chromium silently falls back
 * when a family is missing, so a differing width means the family resolved.
 */
function isFontAvailable(family: string): boolean {
  const key = family.trim()
  if (!key) return false
  const cached = availabilityCache.get(key)
  if (cached !== undefined) return cached
  let available = false
  try {
    const ctx = document.createElement('canvas').getContext('2d')
    if (ctx) {
      const text = 'mmmmmmmmmmlli0O'
      const probe = (font: string): number => {
        ctx.font = font
        return ctx.measureText(text).width
      }
      const generic = ['monospace', 'sans-serif', 'serif'].map((f) => probe(`72px ${f}`))
      const width = probe(`72px "${key}", monospace`)
      available = !generic.some((w) => Math.abs(w - width) < 0.5)
    }
  } catch {
    available = false
  }
  availabilityCache.set(key, available)
  return available
}

export function SettingsDialog(props: SettingsDialogProps): ReactElement | null {
  const { config } = props
  const [family, setFamily] = useState(config.font.family ?? '')
  const [size, setSize] = useState(String(config.font.size))
  const [lineHeight, setLineHeight] = useState(String(config.font.lineHeight))
  const [history, setHistory] = useState(String(config.scrollback))
  const [focusFollowsMouse, setFocusFollowsMouse] = useState(config.focusFollowsMouse !== false)
  const familyRef = useRef<HTMLInputElement>(null)

  // Re-sync the form from the live config each time the dialog opens.
  useEffect(() => {
    if (props.open) {
      setFamily(config.font.family ?? '')
      setSize(String(config.font.size))
      setLineHeight(String(config.font.lineHeight))
      setHistory(String(config.scrollback))
      setFocusFollowsMouse(config.focusFollowsMouse !== false)
      familyRef.current?.focus()
      familyRef.current?.select()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open])

  if (!props.open) return null

  const parsedSize = Number(size)
  const parsedLineHeight = Number(lineHeight)
  const parsedHistory = Math.trunc(Number(history))
  const validSize = Number.isFinite(parsedSize) && parsedSize >= 6 && parsedSize <= 72
  const validLineHeight = Number.isFinite(parsedLineHeight) && parsedLineHeight >= 0.8 && parsedLineHeight <= 3
  const validHistory = Number.isFinite(parsedHistory) && parsedHistory >= 100 && parsedHistory <= 1_000_000
  const trimmedFamily = family.trim()
  const available = trimmedFamily ? isFontAvailable(trimmedFamily) : false

  const apply = (): void => {
    if (!validSize || !validLineHeight || !validHistory) return
    props.onApply({
      font: { family: trimmedFamily, size: parsedSize, lineHeight: parsedLineHeight },
      scrollback: parsedHistory,
      focusFollowsMouse
    })
  }

  const reset = (): void => {
    setFamily('Maple Mono NF CN')
    setSize('14')
    setLineHeight('1.15')
    setHistory('10000')
    setFocusFollowsMouse(true)
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && props.onCancel()}>
      <div className="modal settings-modal" onKeyDown={(e) => e.key === 'Enter' && apply()}>
        <h2>Terminal Settings</h2>

        <label className="field">
          <span>Font family</span>
          <input
            ref={familyRef}
            value={family}
            list="font-family-list"
            placeholder="Maple Mono NF CN"
            onChange={(e) => setFamily(e.target.value)}
          />
          <datalist id="font-family-list">
            {FONT_SUGGESTIONS.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
        </label>
        <p className={`font-hint ${trimmedFamily && !available ? 'warn' : ''}`}>
          {!trimmedFamily
            ? 'Leave blank to use the built-in monospace fallback.'
            : available
              ? '✓ Font detected on this system.'
              : '⚠ Not detected — the terminal will fall back to the next available monospace font.'}
        </p>

        <div className="field-row">
          <label className="field">
            <span>Font size (px)</span>
            <input
              value={size}
              inputMode="numeric"
              className={validSize ? '' : 'invalid'}
              onChange={(e) => setSize(e.target.value.replace(/[^\d.]/g, ''))}
            />
          </label>
          <label className="field">
            <span>Line height</span>
            <input
              value={lineHeight}
              inputMode="decimal"
              className={validLineHeight ? '' : 'invalid'}
              onChange={(e) => setLineHeight(e.target.value.replace(/[^\d.]/g, ''))}
            />
          </label>
        </div>

        <label className="field">
          <span>History limit (lines of scrollback)</span>
          <input
            value={history}
            inputMode="numeric"
            placeholder="10000"
            className={validHistory ? '' : 'invalid'}
            onChange={(e) => setHistory(e.target.value.replace(/[^\d]/g, ''))}
          />
        </label>

        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={focusFollowsMouse}
            onChange={(e) => setFocusFollowsMouse(e.target.checked)}
          />
          <span>Focus follows mouse (wezterm pane_focus_follows_mouse)</span>
        </label>

        <div
          className="font-preview"
          style={{ fontFamily: trimmedFamily || undefined, fontSize: validSize ? `${parsedSize}px` : undefined, lineHeight: validLineHeight ? parsedLineHeight : undefined }}
        >
          <div>The quick brown fox jumps over the lazy dog 0123456789</div>
          <div>const pane = mux.split(『left』, 50%) // 中文字形预览</div>
        </div>

        <div className="modal-actions">
          <button className="ghost" onClick={reset}>
            Reset
          </button>
          <div className="spacer" />
          <button onClick={props.onCancel}>Cancel</button>
          <button className="primary" onClick={apply} disabled={!validSize || !validLineHeight || !validHistory}>
            Apply
          </button>
        </div>
      </div>
    </div>
  )
}
