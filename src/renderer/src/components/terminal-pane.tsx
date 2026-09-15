
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { ImageAddon } from '@xterm/addon-image'
import type { PaneRecord } from '../mux-model'
import type { RendererConfig, SessionCreateOpts } from '../types'
import { resolveTheme } from '../theme'
import {
  clampCursor,
  decodeCopyKey,
  emptyCopyState,
  linearSelectionLength,
  repeatMove,
  searchFrom,
  selectionRange
} from '../copy-mode'
import type { CopyAction, CopyCursor, CopyModeState, CopySelectionMode, CopyView } from '../copy-mode'
import { DEFAULT_QUICK_SELECT_PATTERN, assignLabels, findMatches, matchAtColumn, resolveLabel } from '../quick-select'
import { pointerMoved } from '../pointer-move'
import type { PointerPosition } from '../pointer-move'
import { decodeOsc52 } from '../osc52'
import type { QuickLine, QuickMatch } from '../quick-select'

/**
 * The pointer position any pane last saw. Focus follows the mouse, so "did the
 * mouse move?" has to be asked of the pointer rather than of one pane: a pane
 * the pointer entered before leaving the layout still has to recognise a
 * re-delivered position as "no movement". See pointer-move.ts.
 */
let lastPointer: PointerPosition | null = null

/** Record the pointer at (x, y); true when getting there was an actual move. */
function pointerMovedNow(x: number, y: number): boolean {
  const moved = pointerMoved(lastPointer, { x, y })
  lastPointer = { x, y }
  return moved
}

export interface CopyModeHandle {
  active: () => boolean
  enter: () => void
  exit: () => void
  /** Handle a keydown while copy mode is active; returns true if consumed. */
  handleKey: (e: KeyboardEvent) => boolean
}

export interface QuickSelectHandle {
  active: () => boolean
  enter: () => void
  exit: () => void
  /** Handle a keydown while quick-select is active; returns true if consumed. */
  handleKey: (e: KeyboardEvent) => boolean
}

export interface TerminalHandle {
  term: Terminal
  search: SearchAddon
  copyMode: CopyModeHandle
  quickSelect: QuickSelectHandle
}

export interface TerminalPaneProps {
  pane: PaneRecord
  config: RendererConfig
  /** True when this pane is the focused pane of the active tab. */
  active?: boolean
  registerTerminal: (sessionId: string, handle: TerminalHandle) => void
  unregisterTerminal: (sessionId: string) => void
  onAttach: (paneId: number, sessionId: string, label: string) => void
  onTitle: (paneId: number, title: string) => void
  onCwd: (paneId: number, cwd: string) => void
  onFocus: (paneId: number) => void
  resolvePrompt: (promptId: string, value: string) => void
}

interface ActivePrompt {
  promptId: string
  echo: boolean
  buffer: string
}

/** A quick-select match rendered as a labelled overlay over the terminal. */
interface QuickLabelItem {
  label: string
  text: string
  x: number
  y: number
  w: number
  h: number
}

/**
 * Image addon cache size in MB, *per pane*. The addon defaults to 128 MB, which
 * is fine for a single terminal but multiplies across the panes and tabs a muxer
 * keeps alive. Previews are a few hundred KB decoded, and eviction is FIFO with a
 * placeholder left in the scrollback, so 32 MB holds plenty before degrading.
 */
const IMAGE_STORAGE_LIMIT_MB = 32

/**
 * Fit the terminal to the box it actually lives in, correcting two things xterm 6's
 * FitAddon gets wrong for a tiled pane layout.
 *
 * 1. It always subtracts a scrollbar width from the available width
 *    (`options.overviewRuler?.width || 14`), modelling a scrollbar that takes layout
 *    space. The scrollbar xterm 6 renders -- VS Code's, via SmoothScrollableElement --
 *    is `position: absolute` and overlays the content, and stays hidden until you
 *    scroll. The subtraction buys nothing and costs columns: a 700px pane with 7px
 *    cells fits 100 columns, but `fit()` reports 98 and leaves a dead 14px strip.
 *
 * 2. It measures the available space as `getComputedStyle(parent)` minus the
 *    *element's* padding. This app sets `* { box-sizing: border-box }`, so the
 *    parent's computed size is its border box: the pane's own 2px padding is counted
 *    as usable space. Both axes then come out 2px too large whenever the pane's
 *    border-box extent divides evenly by the cell size, and the grid overruns the
 *    pane -- the last column/row sliding under the split divider.
 *
 * Measuring the terminal element itself sidesteps the box-sizing question entirely:
 * the element is a block filling its container's content box, so its own box is
 * exactly the space available. Any failure keeps the addon's result, so a renderer
 * change can at worst cost a column, not break fitting.
 */
function fitToContainer(term: Terminal, fit: FitAddon): void {
  try {
    fit.fit()
  } catch {
    return // layout not ready yet
  }
  const cell = (
    term as unknown as {
      _core?: {
        _renderService?: { dimensions?: { css?: { cell?: { width?: number; height?: number } } } }
      }
    }
  )._core?._renderService?.dimensions?.css?.cell
  const element = term.element
  if (!cell?.width || !cell.height || !element) return
  try {
    const style = window.getComputedStyle(element)
    const padH = (parseInt(style.paddingLeft) || 0) + (parseInt(style.paddingRight) || 0)
    const padV = (parseInt(style.paddingTop) || 0) + (parseInt(style.paddingBottom) || 0)
    const box = element.getBoundingClientRect()
    // Every tab stays mounted, the inactive ones via `display: none`, and this
    // also runs for the seconds a pane spends unmounted-but-sized. A hidden
    // element measures 0x0, and fitting that would shrink the terminal to the
    // 2x1 minimum -- xterm then reflows its whole buffer at two columns wide,
    // which loses text, and switching back reflows again from the damaged state.
    // (The FitAddon misses this only by accident: `getComputedStyle` on a
    // display:none parent yields 'auto', so its width parses to NaN and it bails.
    // A rect gives a clean 0 instead, which divides happily.) Leave the size as
    // it is; the ResizeObserver fires again once the pane has a box.
    if (box.width <= 0 || box.height <= 0) return
    // Floor the space before dividing so a fractional layout can never round into
    // an extra column/row that does not fit.
    const cols = Math.max(2, Math.floor(Math.floor(box.width - padH) / cell.width))
    const rows = Math.max(1, Math.floor(Math.floor(box.height - padV) / cell.height))
    if (cols !== term.cols || rows !== term.rows) term.resize(cols, rows)
  } catch {
    /* keep the addon's result */
  }
}

/**
 * Re-render the whole viewport from the buffer.
 *
 * The WebGL renderer can keep showing what it last put on the canvas for cells
 * whose content it believes has not changed, and it does not always notice that
 * it has fallen behind -- upstream has had a run of "stale cells until the next
 * full repaint" bugs around the texture atlas (xtermjs/xterm.js#6042 and the
 * atlas-reset reports around it), including renderers that go stale without ever
 * firing `onContextLoss`, which leaves no event to react to. The visible symptom
 * is a full-screen program that clears the screen and redraws: the cells it
 * paints are right, while every cell it leaves to the background still shows
 * whatever was on screen before it started (for an SSH pane, the login banner's
 * watermark). The buffer is correct in that state -- only the canvas is behind --
 * so re-rendering every row fixes the display without touching the session.
 *
 * Cheap and idempotent, so it is called at the few moments a terminal can
 * plausibly have picked that up: once a pane is laid out, the point past which no
 * later layout change is going to repaint it for us, and whenever a pane that was
 * hidden -- an inactive tab, a zoomed-over pane, a minimized window -- comes back
 * on screen.
 */
function repaint(term: Terminal): void {
  try {
    term.refresh(0, term.rows - 1)
  } catch {
    /* renderer not attached yet */
  }
}

/** Guard against loading the WebGL renderer where no GL context exists (it
 * throws asynchronously and breaks rendering). Cached: probing allocates a
 * throwaway context, so only do it once. */
let webglChecked: boolean | null = null
function webglAvailable(): boolean {
  if (webglChecked !== null) return webglChecked
  try {
    const canvas = document.createElement('canvas')
    webglChecked = !!(canvas.getContext('webgl2') || canvas.getContext('webgl'))
  } catch {
    webglChecked = false
  }
  return webglChecked
}

function parseOsc7(data: string): string {
  const s = data.trim()
  if (s.startsWith('file://')) {
    try {
      const u = new URL(s)
      let p = u.pathname
      if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1) // Windows drive path
      return decodeURIComponent(p)
    } catch {
      return s
    }
  }
  return s
}

/** Resolve the configured font family, falling back to a platform monospace stack. */
function fontFamilyOf(config: RendererConfig): string {
  if (config.font.family) return config.font.family
  return navigator.platform.includes('Win')
    ? 'Cascadia Mono, Consolas, monospace'
    : '"Cascadia Mono", "JetBrains Mono", "Fira Code", Menlo, monospace'
}

// ---------- copy mode (xterm glue) ----------

function copyViewOf(term: Terminal): CopyView {
  const buf = term.buffer.active
  return {
    lineCount: buf.length,
    cols: term.cols,
    rows: term.rows,
    lineText: (y) => buf.getLine(y)?.translateToString(false) ?? ''
  }
}

/** Scroll so buffer line `y` sits inside the viewport. */
function ensureVisible(term: Terminal, y: number): void {
  const buf = term.buffer.active
  const top = buf.viewportY
  const bottom = top + term.rows - 1
  if (y < top) term.scrollToLine(y)
  else if (y > bottom) term.scrollToLine(Math.max(0, y - term.rows + 1))
}

/**
 * One buffer line in the shape QuickSelect matches against: the text plus, for
 * each character, the cell column it starts at (a wide character occupies two
 * cells and contributes one entry), so a match's column range can be mapped back
 * from a cell the pointer was over.
 *
 * `null` when the line does not exist (an absolute row past the end of the
 * scrollback).
 */
function bufferLine(term: Terminal, absRow: number): QuickLine | null {
  const line = term.buffer.active.getLine(absRow)
  if (!line) return null
  let text = ''
  const columns: number[] = []
  for (let x = 0; x < term.cols; x++) {
    const cell = line.getCell(x)
    if (!cell || cell.getWidth() === 0) {
      if (!cell) {
        text += ' '
        columns.push(x)
      }
      continue
    }
    const chars = cell.getChars()
    if (!chars) {
      text += ' '
      columns.push(x)
      continue
    }
    for (let i = 0; i < chars.length; i++) {
      text += chars[i]
      columns.push(x)
    }
  }
  return { row: absRow, text, columns }
}

/**
 * The QuickSelect token under a mouse event, in buffer coordinates.
 *
 * xterm's own mouse-coordinate mapping is used rather than deriving the cell from
 * the element's rect: it is the same one xterm uses to place its own selection,
 * so a click cannot land on a different cell here than it does there.
 */
function quickMatchAtEvent(term: Terminal, event: MouseEvent): QuickMatch | null {
  const mouse = (
    term as unknown as {
      _core?: {
        _mouseService?: {
          getCoords: (
            ev: MouseEvent,
            element: HTMLElement,
            cols: number,
            rows: number,
            scrollOffset?: boolean
          ) => [number, number] | undefined
        }
      }
    }
  )._core?._mouseService
  const screen = term.element?.querySelector<HTMLElement>('.xterm-screen')
  if (!mouse || !screen) return null
  try {
    // 1-based [column, viewport row]; `scrollOffset` maps the row into the buffer.
    const coords = mouse.getCoords(event, screen, term.cols, term.rows, true)
    if (!coords) return null
    const line = bufferLine(term, term.buffer.active.viewportY + coords[1] - 1)
    return line ? matchAtColumn(line, coords[0] - 1) : null
  } catch {
    return null
  }
}

/**
 * Show a QuickSelect match as an ordinary selection, and fire the change event
 * the app's copy-on-select listens to. Same internal poke as the block selection
 * above -- xterm has no public API for "select exactly these cells" -- but with
 * the linear selection mode, which is what a word selection is.
 */
function selectQuickMatch(term: Terminal, match: QuickMatch): boolean {
  try {
    const svc = (
      term as unknown as {
        _core?: {
          _selectionService?: {
            _model?: {
              isSelectAllActive: boolean
              selectionStartLength: number
              selectionStart?: number[]
              selectionEnd?: number[]
            }
            refresh?: () => void
            _onSelectionChange?: { fire: () => void }
          }
        }
      }
    )._core?._selectionService
    const model = svc?._model
    if (!svc || !model) return false
    setSelectionKind(term, 0)
    model.isSelectAllActive = false
    model.selectionStartLength = 0
    model.selectionStart = [match.col, match.row]
    // End is exclusive, so a match of `width` cells ends at col + width.
    model.selectionEnd = [match.col + match.width, match.row]
    svc.refresh?.()
    svc._onSelectionChange?.fire()
    return true
  } catch {
    return false
  }
}

/**
 * xterm's selection mode: 0 = linear (char/line), 3 = column (block). Block
 * selection has no public API, so this pokes the internal service (guarded).
 */
function setSelectionKind(term: Terminal, kind: number): boolean {
  try {
    const svc = (term as unknown as { _core?: { _selectionService?: { _activeSelectionMode?: number } } })._core
      ?._selectionService
    if (svc && typeof svc._activeSelectionMode === 'number') {
      svc._activeSelectionMode = kind
      return true
    }
  } catch {
    /* internal API changed */
  }
  return false
}

/** Rectangular (block) selection via xterm's internal selection model. */
function applyBlockSelection(term: Terminal, a: CopyCursor, b: CopyCursor): boolean {
  try {
    const svc = (term as unknown as {
      _core?: {
        _selectionService?: {
          _model?: {
            isSelectAllActive: boolean
            selectionStartLength: number
            selectionStart?: number[]
            selectionEnd?: number[]
          }
          refresh?: () => void
          _onSelectionChange?: { fire: () => void }
        }
      }
    })._core?._selectionService
    const model = svc?._model
    if (!svc || !model) return false
    model.isSelectAllActive = false
    model.selectionStartLength = 0
    model.selectionStart = [a.x, a.y]
    model.selectionEnd = [b.x, b.y]
    svc.refresh?.()
    svc._onSelectionChange?.fire()
    return true
  } catch {
    return false
  }
}

/** Mirror the copy-mode state onto xterm's selection (1 cell = cursor only). */
function renderCopySelection(term: Terminal, state: CopyModeState): void {
  if (!state.active) {
    term.clearSelection()
    return
  }
  const range = selectionRange(state)
  if (!range) {
    setSelectionKind(term, 0)
    term.select(state.cursor.x, state.cursor.y, 1)
    return
  }
  if (state.mode === 'line') {
    setSelectionKind(term, 0)
    term.selectLines(range.start.y, range.end.y)
    return
  }
  if (state.mode === 'block') {
    setSelectionKind(term, 3)
    if (applyBlockSelection(term, range.start, range.end)) return
  }
  setSelectionKind(term, 0)
  term.select(range.start.x, range.start.y, linearSelectionLength(range, term.cols))
}

export function TerminalPane(props: TerminalPaneProps): ReactElement {
  const { pane, config, onFocus } = props
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const promptRef = useRef<ActivePrompt | null>(null)

  // ----- copy mode -----
  const copyStateRef = useRef<CopyModeState>({ ...emptyCopyState })
  const [copyHud, setCopyHud] = useState<{ mode: CopySelectionMode; searching: boolean } | null>(null)
  const [copyQuery, setCopyQuery] = useState('')
  const lastSearchRef = useRef('')

  // ----- quick select (Alt+I) -----
  const [quick, setQuick] = useState<{ items: QuickLabelItem[]; prefix: string } | null>(null)
  const quickRef = useRef<{ items: QuickLabelItem[]; prefix: string } | null>(null)

  const enterCopyMode = useCallback((): void => {
    const term = termRef.current
    if (!term) return
    const buf = term.buffer.active
    const view = copyViewOf(term)
    const cursor = clampCursor(view, { x: buf.cursorX, y: buf.baseY + buf.cursorY })
    copyStateRef.current = { active: true, cursor, anchor: null, mode: 'cell' }
    lastSearchRef.current = ''
    setCopyQuery('')
    setCopyHud({ mode: 'cell', searching: false })
    renderCopySelection(term, copyStateRef.current)
    ensureVisible(term, cursor.y)
  }, [])

  const exitCopyMode = useCallback((): void => {
    const term = termRef.current
    copyStateRef.current = { ...emptyCopyState }
    if (term) {
      term.clearSelection()
      term.focus()
    }
    setCopyHud(null)
  }, [])

  const applyCopyAction = useCallback((action: CopyAction, repeat = 1): void => {
    const term = termRef.current
    if (!term || !copyStateRef.current.active) return
    copyStateRef.current = repeatMove(copyStateRef.current, action, repeat, copyViewOf(term))
    renderCopySelection(term, copyStateRef.current)
    ensureVisible(term, copyStateRef.current.cursor.y)
  }, [])

  const setCopySelectionMode = useCallback((mode: CopySelectionMode): void => {
    const term = termRef.current
    if (!term || !copyStateRef.current.active) return
    const st = copyStateRef.current
    copyStateRef.current = { ...st, mode, anchor: st.anchor ?? { ...st.cursor } }
    renderCopySelection(term, copyStateRef.current)
    setCopyHud((h) => (h ? { ...h, mode } : h))
  }, [])

  const runCopySearch = useCallback((query: string, forward: boolean): void => {
    const term = termRef.current
    if (!term || !query) return
    const view = copyViewOf(term)
    const hit = searchFrom(view, copyStateRef.current.cursor, query, forward)
    if (!hit) return
    lastSearchRef.current = query
    copyStateRef.current = {
      ...copyStateRef.current,
      cursor: clampCursor(view, { x: hit.x + query.length - 1, y: hit.y }),
      anchor: { ...hit },
      mode: 'cell'
    }
    renderCopySelection(term, copyStateRef.current)
    ensureVisible(term, hit.y)
  }, [])

  const copyAndExit = useCallback((): void => {
    const term = termRef.current
    if (term && copyStateRef.current.anchor) {
      const text = term.getSelection()
      if (text) void navigator.clipboard.writeText(text).catch(() => undefined)
    }
    exitCopyMode()
  }, [exitCopyMode])

  const handleCopyKey = useCallback(
    (e: KeyboardEvent): boolean => {
      if (!copyStateRef.current.active) return false
      const cmd = decodeCopyKey(e)
      if (!cmd) return false
      switch (cmd.type) {
        case 'move':
          applyCopyAction(cmd.action, cmd.repeat ?? 1)
          break
        case 'mode':
          setCopySelectionMode(cmd.mode)
          break
        case 'copy':
          copyAndExit()
          break
        case 'close':
          exitCopyMode()
          break
        case 'search':
          setCopyQuery('')
          setCopyHud((h) => (h ? { ...h, searching: true } : h))
          break
        case 'nextMatch':
          if (lastSearchRef.current) runCopySearch(lastSearchRef.current, true)
          break
        case 'priorMatch':
          if (lastSearchRef.current) runCopySearch(lastSearchRef.current, false)
          break
      }
      return true
    },
    [applyCopyAction, setCopySelectionMode, copyAndExit, exitCopyMode, runCopySearch]
  )

  // ---- quick select (Alt+I): wezterm QuickSelectArgs ----

  /** Scan the visible screen, label every match and compute overlay geometry. */
  const buildQuickItems = useCallback((): QuickLabelItem[] => {
    const term = termRef.current
    const container = containerRef.current
    const paneEl = container?.parentElement
    const screenEl = container?.querySelector<HTMLElement>('.xterm-screen')
    if (!term || !container || !paneEl || !screenEl) return []
    const buf = term.buffer.active
    const lines: QuickLine[] = []
    for (let r = 0; r < term.rows; r++) {
      const line = bufferLine(term, buf.viewportY + r)
      if (line) lines.push(line)
    }
    const matches = findMatches(lines, DEFAULT_QUICK_SELECT_PATTERN)
    const labels = assignLabels(matches.length)
    const paneRect = paneEl.getBoundingClientRect()
    const screenRect = screenEl.getBoundingClientRect()
    const cellW = term.cols > 0 ? screenRect.width / term.cols : 0
    const cellH = term.rows > 0 ? screenRect.height / term.rows : 0
    const originX = screenRect.left - paneRect.left
    const originY = screenRect.top - paneRect.top
    return matches.map((m, i) => ({
      label: labels[i],
      text: m.text,
      x: originX + m.col * cellW,
      y: originY + (m.row - buf.viewportY) * cellH,
      w: Math.max(cellW, m.width * cellW),
      h: cellH
    }))
  }, [])

  const enterQuickSelect = useCallback((): void => {
    const items = buildQuickItems()
    if (items.length === 0) return
    const next = { items, prefix: '' }
    quickRef.current = next
    setQuick(next)
  }, [buildQuickItems])

  const exitQuickSelect = useCallback((): void => {
    quickRef.current = null
    setQuick(null)
    termRef.current?.focus()
  }, [])

  const handleQuickKey = useCallback(
    (e: KeyboardEvent): boolean => {
      const state = quickRef.current
      if (!state) return false
      if (e.key === 'Escape' || (e.ctrlKey && (e.key.toLowerCase() === 'c' || e.key.toLowerCase() === 'g'))) {
        exitQuickSelect()
        return true
      }
      if (e.key === 'Backspace') {
        const next = { ...state, prefix: state.prefix.slice(0, -1) }
        quickRef.current = next
        setQuick(next)
        return true
      }
      if (e.ctrlKey || e.altKey || e.metaKey || e.key.length !== 1) {
        exitQuickSelect()
        return true
      }
      const prefix = state.prefix + e.key.toLowerCase()
      const res = resolveLabel(
        state.items.map((it) => it.label),
        prefix
      )
      if (res.kind === 'commit') {
        const text = state.items[res.index]?.text
        if (text) void navigator.clipboard.writeText(text).catch(() => undefined)
        exitQuickSelect()
      } else if (res.kind === 'pending') {
        const next = { ...state, prefix }
        quickRef.current = next
        setQuick(next)
      } else {
        exitQuickSelect()
      }
      return true
    },
    [exitQuickSelect]
  )

  // Create the xterm instance and (lazily) the backing session, once per pane.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const colors = resolveTheme(config)

    const term = new Terminal({
      allowProposedApi: true,
      fontFamily: fontFamilyOf(config),
      fontSize: config.font.size,
      lineHeight: config.font.lineHeight,
      scrollback: config.scrollback,
      cursorBlink: true,
      cursorStyle: 'bar',
      theme: colors,
      macOptionIsMeta: true,
      allowTransparency: true,
      fontWeight: '400'
    })
    const fit = new FitAddon()
    const search = new SearchAddon()
    const unicode = new Unicode11Addon()
    term.loadAddon(fit)
    term.loadAddon(search)
    term.loadAddon(unicode)
    term.unicode.activeVersion = '11'
    try {
      // Inline images (iTerm IIP + SIXEL) so yazi and friends can preview
      // pictures. Guards its own `_core._inputHandler._parser` pokes, but keep
      // the load defensive: a missing private API must not kill the whole pane.
      term.loadAddon(new ImageAddon({ storageLimit: IMAGE_STORAGE_LIMIT_MB }))
    } catch {
      /* image addon incompatible with this xterm build */
    }
    let webgl: WebglAddon | null = null
    try {
      // `webgl: false` in the config skips the addon entirely and leaves the DOM
      // renderer in place (see repaint() for why one might).
      if (config.webgl !== false && webglAvailable()) {
        webgl = new WebglAddon()
        webgl.onContextLoss(() => webgl?.dispose())
        term.loadAddon(webgl)
      }
    } catch {
      /* WebGL unavailable -> DOM renderer fallback */
    }

    term.open(container)
    fitToContainer(term, fit)
    termRef.current = term
    fitRef.current = fit

    // A pane that was hidden -- an inactive tab, or another pane zoomed over it --
    // measures 0x0 while it is away, and comes back with a canvas the compositor
    // may have dropped. The transition back to a real box is the moment to
    // repaint it (see repaint()).
    let wasHidden = false
    const ro = new ResizeObserver(() => {
      fitToContainer(term, fit)
      const box = container.getBoundingClientRect()
      const hidden = box.width <= 0 || box.height <= 0
      if (wasHidden && !hidden) repaint(term)
      wasHidden = hidden
      const sid = sessionIdRef.current
      if (sid) void window.api.sessions.resize(sid, term.cols, term.rows)
    })
    ro.observe(container)

    // Same story one level up: the window being minimized/occluded stops the
    // renderer's animation frames, so coming back to the foreground repaints.
    const onVisibilityChange = (): void => {
      if (!document.hidden) repaint(term)
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    // Double-click picks the token under the pointer with QuickSelect's rules
    // (see matchAtColumn) instead of xterm's own `wordSeparator` rule, so that
    // "select the word here" and "pick this match from the overlay" agree: a
    // path, a URL or a qualified name comes out whole either way.
    //
    // xterm runs its word selection from `mousedown` when `detail === 2`, so the
    // rule is replaced by intercepting that event in the capture phase before it
    // reaches the terminal -- a `dblclick` listener would be too late, and the
    // native selection would flash first. Clicking where no token matches falls
    // through to xterm's behaviour (which selects a whitespace run, if anything).
    const onMouseDownCapture = (e: MouseEvent): void => {
      if (e.button !== 0 || e.detail !== 2) return
      const match = quickMatchAtEvent(term, e)
      if (!match) return
      e.preventDefault()
      e.stopPropagation()
      // The terminal's own mousedown handler is not going to run, so take over
      // what it would have done for this click.
      term.focus()
      props.onFocus(pane.id)
      selectQuickMatch(term, match)
    }
    container.addEventListener('mousedown', onMouseDownCapture, true)

    // The case repaint() exists for, caught where it happens: a program that
    // clears the screen and draws its own frame over it. That is where a WebGL
    // renderer which has lost track of its damage gives itself away -- the cells
    // the program *paints* come out right (their rows changed) while the cells it
    // only *erased* keep whatever was on screen before, which for an SSH pane is
    // the login banner's watermark showing through the UI. `J` (erase in display)
    // and `K` (erase in line) are what a full-screen TUI drives its frames with;
    // the handlers let xterm apply them as usual (returning `false`) and only ask
    // for the repaint, coalesced to one per tick so a frame's burst of erases
    // costs a single repaint, and run on a timer so the erase has been applied by
    // the time it happens.
    let eraseRepaint: number | undefined
    const repaintAfterErase = (): void => {
      if (eraseRepaint !== undefined) return
      eraseRepaint = window.setTimeout(() => {
        eraseRepaint = undefined
        repaint(term)
      }, 0)
    }
    try {
      term.parser.registerCsiHandler({ final: 'J' }, () => {
        repaintAfterErase()
        return false
      })
      term.parser.registerCsiHandler({ final: 'K' }, () => {
        repaintAfterErase()
        return false
      })
    } catch {
      /* older xterm */
    }

    term.onData((data: string) => {
      const prompt = promptRef.current
      if (prompt) {
        // Clear the prompt immediately once answered so the next keystrokes go
        // to the session (the effect below also clears it defensively).
        if (handlePromptKey(term, prompt, data, (pid, value) => props.resolvePrompt(pid, value))) {
          promptRef.current = null
        }
      } else {
        const sid = sessionIdRef.current
        if (sid) void window.api.sessions.write(sid, data)
      }
    })

    term.onTitleChange((title: string) => {
      props.onTitle(pane.id, title)
    })

    // Copy-on-select (wezterm/X11-style primary selection): once a selection
    // settles, put it on the clipboard without needing Ctrl+Shift+C. A short
    // debounce avoids a clipboard write on every drag update.
    let selectionTimer: number | undefined
    const copyOnSelect = config.copyOnSelect !== false
    term.onSelectionChange(() => {
      // Copy-on-select must not fire for the synthetic copy-mode cursor/selection.
      if (copyStateRef.current.active) return
      if (!copyOnSelect) return
      if (selectionTimer !== undefined) window.clearTimeout(selectionTimer)
      if (!term.hasSelection()) return
      selectionTimer = window.setTimeout(() => {
        selectionTimer = undefined
        const sel = term.getSelection()
        if (sel) void navigator.clipboard.writeText(sel).catch(() => undefined)
      }, 120)
    })

    try {
      term.parser.registerOscHandler(7, (d: string) => {
        props.onCwd(pane.id, parseOsc7(d))
        return true
      })
      // OSC 52: let programs (tmux `set-clipboard on`, neovim `clipboard=osc52`,
      // anything over SSH) copy to the local clipboard. Always on.
      term.parser.registerOscHandler(52, (d: string) => {
        const text = decodeOsc52(d)
        if (text !== null) void navigator.clipboard.writeText(text).catch(() => undefined)
        return true
      })
    } catch {
      /* older xterm */
    }

    let cancelled = false
    if (!pane.sessionId && pane.pendingCreate) {
      const pc = pane.pendingCreate
      const createOpts: SessionCreateOpts =
        pc.kind === 'local'
          ? { kind: 'local', cwd: pc.cwd, cols: term.cols, rows: term.rows }
          : {
              kind: 'ssh',
              target: pc.target ?? '',
              user: pc.user,
              port: pc.port,
              identity: pc.identity,
              password: pc.password,
              cwd: pc.cwd,
              cols: term.cols,
              rows: term.rows
            }
      void window.api.sessions
        .create(createOpts)
        .then((res) => {
          if (cancelled) {
            void window.api.sessions.destroy(res.id)
            return
          }
          sessionIdRef.current = res.id
          // Anything the ResizeObserver reported before the id existed had
          // nowhere to go and was dropped, so the session was asked to create
          // its pty at whatever size the terminal had back then. Now that the
          // id is known, hand over the settled size: a remote pty must never
          // start narrower or shorter than the pane it is displayed in.
          void window.api.sessions.resize(res.id, term.cols, term.rows)
          // The pane is fully laid out at this point; drop any stale cells the
          // renderer picked up while it was being created.
          repaint(term)
          props.registerTerminal(res.id, {
            term,
            search,
            copyMode: {
              active: () => copyStateRef.current.active,
              enter: enterCopyMode,
              exit: exitCopyMode,
              handleKey: handleCopyKey
            },
            quickSelect: {
              active: () => quickRef.current !== null,
              enter: enterQuickSelect,
              exit: exitQuickSelect,
              handleKey: handleQuickKey
            }
          })
          props.onAttach(pane.id, res.id, res.label)
        })
        .catch((err: unknown) => {
          term.write(`\r\nFailed to create session: ${String(err)}\r\n`)
        })
    }

    return () => {
      cancelled = true
      if (selectionTimer !== undefined) window.clearTimeout(selectionTimer)
      if (eraseRepaint !== undefined) window.clearTimeout(eraseRepaint)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      container.removeEventListener('mousedown', onMouseDownCapture, true)
      ro.disconnect()
      const sid = sessionIdRef.current
      if (sid) {
        props.unregisterTerminal(sid)
        void window.api.sessions.destroy(sid)
      }
      // Dispose the WebGL addon while the terminal core is still alive: its
      // teardown recreates a DOM renderer, which fails if it runs during
      // Terminal.dispose() and throws inside React's effect cleanup, unmounting
      // the whole tree. Guard both calls so a renderer teardown race can never
      // blank the app.
      try {
        webgl?.dispose()
      } catch {
        /* renderer already gone */
      }
      try {
        term.dispose()
      } catch {
        /* addon teardown race */
      }
      termRef.current = null
      fitRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.id])

  // Apply display changes live (settings dialog) without recreating the terminal.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.fontFamily = fontFamilyOf(config)
    term.options.fontSize = config.font.size
    term.options.lineHeight = config.font.lineHeight
    term.options.scrollback = config.scrollback
    if (fitRef.current) fitToContainer(term, fitRef.current)
    const sid = sessionIdRef.current
    if (sid) void window.api.sessions.resize(sid, term.cols, term.rows)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.font.family, config.font.size, config.font.lineHeight, config.scrollback])

  // Enter prompt mode when the session asks a question (wezterm LineEditor analog).
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    if (!pane.prompt) {
      promptRef.current = null
      return
    }
    term.write(pane.prompt.text)
    promptRef.current = { promptId: pane.prompt.promptId, echo: pane.prompt.echo, buffer: '' }
  }, [pane.prompt])

  useEffect(() => {
    if (props.active) termRef.current?.focus()
  }, [pane.sessionId, props.active])

  return (
    <>
      <div
        className={'terminal-pane' + (props.active ? '' : ' terminal-pane-inactive')}
        ref={containerRef}
        onMouseDown={(e) => {
          onFocus(pane.id)
          // middle-click paste, right-click paste (wezterm/Windows Terminal style).
          // Goes through `Terminal.paste` so line endings are normalized to CR
          // and bracketed paste is applied -- see pasteClipboard in app.tsx.
          if (e.button === 1 || e.button === 2) {
            e.preventDefault()
            void window.navigator.clipboard.readText().then((t) => {
              if (t) termRef.current?.paste(t)
            })
          }
        }}
        onMouseEnter={(e) => {
          // wezterm pane_focus_follows_mouse -- but only when the mouse is what
          // moved. Bringing the window back to the foreground (Alt+Tab) re-fires
          // `mouseenter` under a resting cursor, and that must not pull focus out
          // of the pane being typed in. See pointer-move.ts.
          if (!pointerMovedNow(e.clientX, e.clientY)) return
          if (config.focusFollowsMouse !== false) onFocus(pane.id)
        }}
        onMouseMove={(e) => {
          // Record first, and unconditionally: the baseline has to stay current
          // while this pane *is* the focused one, otherwise the next re-delivered
          // position would look like a move. Crossing a boundary happens to
          // deliver the `mouseenter` above as well, but moving inside a pane
          // after the window was reactivated only delivers this -- and that is a
          // real move, so it should re-establish focus following the mouse.
          const moved = pointerMovedNow(e.clientX, e.clientY)
          if (!moved || props.active) return
          if (config.focusFollowsMouse !== false) onFocus(pane.id)
        }}
      />
      {quick && (
        <div className="qs-layer">
          {quick.items.map((it) => (
            <div
              key={it.label}
              className={'qs-label' + (quick.prefix && !it.label.startsWith(quick.prefix) ? ' qs-dim' : '')}
              style={{ left: it.x, top: it.y, width: it.w, height: it.h }}
            >
              <span className="qs-key">{it.label}</span>
            </div>
          ))}
        </div>
      )}
      {copyHud && (
        <div className="copy-hud">
          <span className="copy-hud-badge">COPY · {copyHud.mode}</span>
          {copyHud.searching ? (
            <input
              autoFocus
              className="copy-hud-search"
              value={copyQuery}
              placeholder="search…"
              onChange={(e) => setCopyQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  setCopyHud((h) => (h ? { ...h, searching: false } : h))
                  if (copyQuery) runCopySearch(copyQuery, true)
                  termRef.current?.focus()
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  setCopyHud((h) => (h ? { ...h, searching: false } : h))
                  termRef.current?.focus()
                }
              }}
            />
          ) : (
            <span className="copy-hud-hint">
              hjkl · w/b/e · H/L · ^ · g/G · Ctrl+u/d · v/V/Ctrl+v · y copy · / search · q quit
            </span>
          )}
        </div>
      )}
    </>
  )
}

function handlePromptKey(
  term: Terminal,
  prompt: ActivePrompt,
  data: string,
  resolve: (promptId: string, value: string) => void
): boolean {
  for (const ch of data) {
    if (ch === '\r' || ch === '\n') {
      term.write('\r\n')
      const value = prompt.buffer
      const pid = prompt.promptId
      prompt.buffer = ''
      resolve(pid, value)
      return true
    }
    if (ch === '\x7f' || ch === '\b') {
      if (prompt.buffer.length > 0) {
        prompt.buffer = prompt.buffer.slice(0, -1)
        if (prompt.echo) term.write('\b \b')
      }
      continue
    }
    if (ch === '\x03') {
      // Ctrl+C cancels the prompt
      term.write('^C\r\n')
      const pid = prompt.promptId
      prompt.buffer = ''
      resolve(pid, '')
      return true
    }
    if (ch === '\x15') {
      // Ctrl+U clears the line
      if (prompt.echo && prompt.buffer.length > 0) term.write('\b \b'.repeat(prompt.buffer.length))
      prompt.buffer = ''
      continue
    }
    const code = ch.charCodeAt(0)
    if (code < 0x20 || code === 0x7f) continue // ignore other control characters
    prompt.buffer += ch
    if (prompt.echo) term.write(ch)
  }
  return false
}
