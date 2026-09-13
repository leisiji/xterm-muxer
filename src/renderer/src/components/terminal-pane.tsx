
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactElement } from 'react'
import { Terminal } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import { WebglAddon } from 'xterm-addon-webgl'
import { SearchAddon } from 'xterm-addon-search'
import { Unicode11Addon } from 'xterm-addon-unicode11'
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
import { DEFAULT_QUICK_SELECT_PATTERN, assignLabels, findMatches, resolveLabel } from '../quick-select'
import type { QuickLine } from '../quick-select'

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
  const viewportRef = useRef<HTMLElement | null>(null)
  const scrollbarRef = useRef<HTMLDivElement | null>(null)
  // Custom overlay scrollbar thumb geometry (percentages of the track).
  const [scrollThumb, setScrollThumb] = useState<{ top: number; height: number } | null>(null)

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
      const abs = buf.viewportY + r
      const line = buf.getLine(abs)
      if (!line) continue
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
      lines.push({ row: abs, text, columns })
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

  // Drag the overlay scrollbar thumb / click the track to scroll.
  const onScrollbarMouseDown = useCallback((e: ReactMouseEvent): void => {
    const vp = viewportRef.current
    if (!vp) return
    e.preventDefault()
    e.stopPropagation()
    const track = e.currentTarget as HTMLElement
    const rect = track.getBoundingClientRect()
    const maxScroll = vp.scrollHeight - vp.clientHeight
    const apply = (clientY: number): void => {
      const ratio = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height))
      vp.scrollTop = ratio * maxScroll
    }
    apply(e.clientY)
    const onMove = (ev: MouseEvent): void => apply(ev.clientY)
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

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
    let webgl: WebglAddon | null = null
    try {
      if (webglAvailable()) {
        webgl = new WebglAddon()
        webgl.onContextLoss(() => webgl?.dispose())
        term.loadAddon(webgl)
      }
    } catch {
      /* WebGL unavailable -> DOM renderer fallback */
    }

    term.open(container)
    // xterm reserves scrollbar width and the fit addon subtracts it, leaving a
    // right-edge gutter. We draw our own overlay scrollbar instead, so tell the
    // core not to reserve anything and let the grid use the full width.
    const coreViewport = (term as unknown as { _core?: { viewport?: { scrollBarWidth?: number } } })._core?.viewport
    if (coreViewport) coreViewport.scrollBarWidth = 0
    try {
      fit.fit()
    } catch {
      /* layout not ready yet */
    }
    termRef.current = term
    fitRef.current = fit

    // Overlay scrollbar: xterm's native bar is hidden (see styles.css); we render
    // a thumb that is revealed while scrolling and sized from the viewport.
    const viewport = container.querySelector<HTMLElement>('.xterm-viewport')
    viewportRef.current = viewport
    let scrollTimer: number | undefined
    let thumbFrame: number | undefined

    const updateThumb = (): void => {
      const el = viewportRef.current
      if (!el) return
      const sh = el.scrollHeight
      const ch = el.clientHeight
      if (sh <= ch + 1) {
        setScrollThumb((prev) => (prev === null ? prev : null))
        return
      }
      const height = (ch / sh) * 100
      const top = (el.scrollTop / sh) * 100
      setScrollThumb((prev) =>
        prev && Math.abs(prev.height - height) < 0.05 && Math.abs(prev.top - top) < 0.05 ? prev : { height, top }
      )
    }
    const scheduleThumb = (): void => {
      if (thumbFrame !== undefined) return
      thumbFrame = window.requestAnimationFrame(() => {
        thumbFrame = undefined
        updateThumb()
      })
    }
    const revealScrollbar = (): void => {
      const el = scrollbarRef.current
      if (el) el.classList.add('is-scrolling')
      if (scrollTimer !== undefined) window.clearTimeout(scrollTimer)
      scrollTimer = window.setTimeout(() => {
        scrollTimer = undefined
        scrollbarRef.current?.classList.remove('is-scrolling')
      }, 800)
    }
    const onViewportScroll = (): void => {
      revealScrollbar()
      scheduleThumb()
    }
    viewport?.addEventListener('scroll', onViewportScroll, { passive: true })

    term.onWriteParsed(() => scheduleThumb())

    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        /* ignore */
      }
      const sid = sessionIdRef.current
      if (sid) void window.api.sessions.resize(sid, term.cols, term.rows)
      scheduleThumb()
    })
    ro.observe(container)

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
      if (scrollTimer !== undefined) window.clearTimeout(scrollTimer)
      if (thumbFrame !== undefined) window.cancelAnimationFrame(thumbFrame)
      viewport?.removeEventListener('scroll', onViewportScroll)
      viewportRef.current = null
      ro.disconnect()
      const sid = sessionIdRef.current
      if (sid) {
        props.unregisterTerminal(sid)
        void window.api.sessions.destroy(sid)
      }
      // Dispose the WebGL addon while the terminal core is still alive: its
      // teardown recreates a DOM renderer, which fails if it runs during
      // Terminal.dispose() (xterm-addon-webgl 0.16) and throws inside React's
      // effect cleanup, unmounting the whole tree. Guard both calls so a
      // renderer teardown race can never blank the app.
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
    try {
      fitRef.current?.fit()
    } catch {
      /* ignore */
    }
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
          // middle-click paste, right-click paste (wezterm/Windows Terminal style)
          if (e.button === 1 || e.button === 2) {
            e.preventDefault()
            void window.navigator.clipboard.readText().then((t) => {
              const sid = sessionIdRef.current
              if (sid && t) void window.api.sessions.write(sid, t)
            })
          }
        }}
        onMouseEnter={() => {
          // wezterm pane_focus_follows_mouse
          if (config.focusFollowsMouse !== false) onFocus(pane.id)
        }}
      />
      <div
        ref={scrollbarRef}
        className={'term-scrollbar' + (scrollThumb ? ' has-thumb' : '')}
        onMouseDown={onScrollbarMouseDown}
      >
        {scrollThumb && (
          <div
            className="term-scrollbar-thumb"
            style={{ top: `${scrollThumb.top}%`, height: `${scrollThumb.height}%` }}
          />
        )}
      </div>
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
