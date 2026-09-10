
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { TabBar } from './components/tab-bar'
import { StatusBar } from './components/status-bar'
import { SshDialog } from './components/ssh-dialog'
import { SplitView } from './components/split-view'
import type { TerminalHandle } from './components/terminal-pane'
import { muxReducer, findTabByPaneId } from './mux-reducer'
import { nextPaneId, nextTabId, neighborLeaf } from './mux-model'
import type { MuxState, PaneRecord, PendingCreate, PromptState, SplitOrientation } from './mux-model'
import type { RendererConfig } from './types'
import { resolveTheme } from './theme'
import { isKey } from './keys'

const initialMux: MuxState = { tabs: [], activeTabId: null }

const fallbackConfig: RendererConfig = {
  font: { size: 14, lineHeight: 1.15 },
  theme: { mode: 'system' },
  scrollback: 10000,
  window: { width: 1100, height: 700, title: 'XtermMuxer' },
  keys: {}
}

export function App(): ReactElement {
  const [state, dispatch] = useReducer(muxReducer, initialMux)
  const [config, setConfig] = useState<RendererConfig | null>(null)
  const [sshDialogOpen, setSshDialogOpen] = useState(false)
  const [sshHosts, setSshHosts] = useState<string[]>([])
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  const terminalsRef = useRef(new Map<string, TerminalHandle>())
  // Output/prompts that arrive before the pane has attached its session are
  // buffered here and flushed on register/attach. Without this, a fast SSH
  // handshake can deliver the banner + first shell prompt before
  // `session:create` has resolved and the data is dropped, leaving a blank pane.
  const pendingOutputRef = useRef(new Map<string, string[]>())
  const pendingPromptsRef = useRef(new Map<string, PromptState[]>())
  const attachedRef = useRef(new Set<string>())
  const stateRef = useRef(state)
  stateRef.current = state
  const smoke = window.api.smokeTest

  const activeSessionId = useCallback((): string | null => {
    const s = stateRef.current
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    if (!tab || tab.activePaneId === null) return null
    return tab.panes.get(tab.activePaneId)?.sessionId ?? null
  }, [])

  const applyTheme = useCallback((c: RendererConfig): void => {
    const colors = resolveTheme(c)
    const root = document.documentElement
    root.style.setProperty('--app-bg', colors.background)
    root.style.setProperty('--app-fg', colors.foreground)
    root.style.setProperty('--app-accent', colors.blue)
  }, [])

  // Load config, hosts and open the initial tab.
  useEffect(() => {
    void window.api.config
      .get()
      .then((c) => {
        setConfig(c)
        applyTheme(c)
        if (smoke) console.log('[smoke] config loaded')
      })
      .catch(() => {
        setConfig(fallbackConfig)
        applyTheme(fallbackConfig)
        if (smoke) console.log('[smoke] config fallback')
      })
    void window.api.sessions.listSshHosts().then(setSshHosts).catch(() => undefined)
    newTab()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Subscribe to main-process mux events.
  useEffect(() => {
    return window.api.onEvent((ev) => {
      const s = stateRef.current
      switch (ev.type) {
        case 'session:output': {
          if (ev.id && ev.data) {
            const handle = terminalsRef.current.get(ev.id)
            if (handle) {
              handle.term.write(ev.data)
            } else {
              const queue = pendingOutputRef.current.get(ev.id) ?? []
              queue.push(ev.data)
              pendingOutputRef.current.set(ev.id, queue)
            }
          }
          if (smoke && ev.data) console.log(`[smoke] output ${ev.id} ${ev.data.length} bytes`)
          const tab = s.tabs.find((t) => [...t.panes.values()].some((p) => p.sessionId === ev.id))
          if (tab && tab.id !== s.activeTabId) dispatch({ type: 'unseen', tabId: tab.id })
          break
        }
        case 'session:exit':
          if (ev.id) {
            pendingOutputRef.current.delete(ev.id)
            pendingPromptsRef.current.delete(ev.id)
            attachedRef.current.delete(ev.id)
            dispatch({ type: 'exit', sessionId: ev.id })
          }
          break
        case 'session:status':
          if (ev.id) dispatch({ type: 'status', sessionId: ev.id, status: ev.status ?? null })
          break
        case 'session:prompt':
          if (ev.id && ev.promptId && ev.text !== undefined) {
            const prompt: PromptState = { promptId: ev.promptId, text: ev.text, echo: !!ev.echo }
            if (attachedRef.current.has(ev.id)) {
              dispatch({ type: 'prompt', sessionId: ev.id, prompt })
            } else {
              const queue = pendingPromptsRef.current.get(ev.id) ?? []
              queue.push(prompt)
              pendingPromptsRef.current.set(ev.id, queue)
            }
          }
          break
      }
    })
  }, [])

  // -------- actions --------

  function newTab(): void {
    const s = stateRef.current
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    const pane = tab && tab.activePaneId !== null ? tab.panes.get(tab.activePaneId) : undefined
    const pendingCreate: PendingCreate = { kind: 'local', cwd: pane?.cwd ?? undefined }
    dispatch({ type: 'open-tab', tabId: nextTabId(), paneId: nextPaneId(), pendingCreate })
  }

  function newSshTab(target: string, identity?: string, password?: string): void {
    dispatch({
      type: 'open-tab',
      tabId: nextTabId(),
      paneId: nextPaneId(),
      pendingCreate: { kind: 'ssh', target, identity, password }
    })
  }

  function splitPane(paneId: number, orientation: SplitOrientation): void {
    const s = stateRef.current
    const tab = findTabByPaneId(s, paneId)
    if (!tab) return
    const pane = tab.panes.get(paneId)
    let pendingCreate: PendingCreate
    if (pane?.kind === 'ssh' && pane.sshOpts) {
      pendingCreate = { kind: 'ssh', ...pane.sshOpts }
    } else {
      pendingCreate = { kind: 'local', cwd: pane?.cwd ?? undefined }
    }
    dispatch({
      type: 'add-pane',
      tabId: tab.id,
      targetPaneId: paneId,
      orientation,
      paneId: nextPaneId(),
      pendingCreate
    })
  }

  function cycleTab(delta: number): void {
    const s = stateRef.current
    if (s.tabs.length === 0) return
    const idx = s.tabs.findIndex((t) => t.id === s.activeTabId)
    const next = (idx + delta + s.tabs.length) % s.tabs.length
    dispatch({ type: 'activate-tab', tabId: s.tabs[next].id })
  }

  function moveFocus(dir: 'up' | 'down' | 'left' | 'right'): void {
    const s = stateRef.current
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    if (!tab || tab.activePaneId === null) return
    const next = neighborLeaf(tab.root, tab.activePaneId, dir)
    if (next !== null) dispatch({ type: 'focus-pane', paneId: next })
  }

  async function pasteClipboard(): Promise<void> {
    const sid = activeSessionId()
    if (!sid) return
    try {
      const text = await navigator.clipboard.readText()
      if (text) void window.api.sessions.write(sid, text)
    } catch {
      /* clipboard unavailable */
    }
  }

  function copySelection(): void {
    const sid = activeSessionId()
    const handle = sid ? terminalsRef.current.get(sid) : undefined
    if (!handle) return
    const sel = handle.term.getSelection()
    if (sel) void navigator.clipboard.writeText(sel)
  }

  function searchNext(): void {
    const sid = activeSessionId()
    const handle = sid ? terminalsRef.current.get(sid) : undefined
    if (!handle || !searchQuery) return
    handle.term.focus()
    handle.search.findNext(searchQuery)
  }

  function searchPrev(): void {
    const sid = activeSessionId()
    const handle = sid ? terminalsRef.current.get(sid) : undefined
    if (!handle || !searchQuery) return
    handle.term.focus()
    handle.search.findPrevious(searchQuery)
  }

  function handleShortcut(e: KeyboardEvent): boolean {
    const s = stateRef.current
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    const paneId = tab?.activePaneId ?? null

    if (isKey(e, 'T', ['Ctrl', 'Shift'])) {
      newTab()
      return true
    }
    if (isKey(e, 'S', ['Ctrl', 'Shift'])) {
      setSshDialogOpen(true)
      return true
    }
    if (isKey(e, 'W', ['Ctrl', 'Shift'])) {
      if (paneId !== null) dispatch({ type: 'close-pane', paneId })
      return true
    }
    if (isKey(e, 'Z', ['Ctrl', 'Shift'])) {
      if (paneId !== null) dispatch({ type: 'zoom', paneId })
      return true
    }
    if (isKey(e, 'F', ['Ctrl', 'Shift'])) {
      setSearchOpen((o) => !o)
      return true
    }
    if (isKey(e, 'C', ['Ctrl', 'Shift'])) {
      copySelection()
      return true
    }
    if (isKey(e, 'V', ['Ctrl', 'Shift'])) {
      void pasteClipboard()
      return true
    }
    if (isKey(e, '"', ['Ctrl', 'Shift', 'Alt']) || isKey(e, "'", ['Ctrl', 'Shift', 'Alt'])) {
      if (paneId !== null) splitPane(paneId, 'col')
      return true
    }
    if (isKey(e, '%', ['Ctrl', 'Shift', 'Alt']) || isKey(e, '5', ['Ctrl', 'Shift', 'Alt'])) {
      if (paneId !== null) splitPane(paneId, 'row')
      return true
    }
    if (isKey(e, 'Tab', ['Ctrl'])) {
      cycleTab(1)
      return true
    }
    if (isKey(e, 'Tab', ['Ctrl', 'Shift'])) {
      cycleTab(-1)
      return true
    }
    if (isKey(e, 'PageDown', ['Ctrl'])) {
      cycleTab(1)
      return true
    }
    if (isKey(e, 'PageUp', ['Ctrl'])) {
      cycleTab(-1)
      return true
    }
    if (isKey(e, 'ArrowUp', ['Alt'])) {
      moveFocus('up')
      return true
    }
    if (isKey(e, 'ArrowDown', ['Alt'])) {
      moveFocus('down')
      return true
    }
    if (isKey(e, 'ArrowLeft', ['Alt'])) {
      moveFocus('left')
      return true
    }
    if (isKey(e, 'ArrowRight', ['Alt'])) {
      moveFocus('right')
      return true
    }
    return false
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      if (handleShortcut(e)) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  })

  // Window title mirrors wezterm: [idx/count] active pane title.
  useEffect(() => {
    const tab = state.tabs.find((t) => t.id === state.activeTabId)
    const pane = tab && tab.activePaneId !== null ? tab.panes.get(tab.activePaneId) : undefined
    const title = pane?.title || pane?.label || ''
    const idx = state.tabs.findIndex((t) => t.id === state.activeTabId)
    document.title = state.tabs.length > 0 ? `[${idx + 1}/${state.tabs.length}] ${title}` : 'XtermMuxer'
  }, [state])

  const registerTerminal = useCallback((sessionId: string, handle: TerminalHandle): void => {
    terminalsRef.current.set(sessionId, handle)
    const queue = pendingOutputRef.current.get(sessionId)
    if (queue) {
      for (const chunk of queue) handle.term.write(chunk)
      pendingOutputRef.current.delete(sessionId)
    }
  }, [])

  const unregisterTerminal = useCallback((sessionId: string): void => {
    terminalsRef.current.delete(sessionId)
    pendingOutputRef.current.delete(sessionId)
    pendingPromptsRef.current.delete(sessionId)
    attachedRef.current.delete(sessionId)
  }, [])

  const onAttach = useCallback(
    (paneId: number, sessionId: string, label: string): void => {
      if (window.api.smokeTest) console.log(`[smoke] attached pane=${paneId} session=${sessionId} label=${label}`)
      attachedRef.current.add(sessionId)
      dispatch({ type: 'attach', paneId, sessionId, label })
      const queue = pendingPromptsRef.current.get(sessionId)
      if (queue) {
        for (const prompt of queue) dispatch({ type: 'prompt', sessionId, prompt })
        pendingPromptsRef.current.delete(sessionId)
      }
    },
    []
  )
  const onTitle = useCallback((paneId: number, title: string): void => {
    dispatch({ type: 'title', paneId, title })
  }, [])
  const onCwd = useCallback((paneId: number, cwd: string): void => {
    dispatch({ type: 'cwd', paneId, cwd })
  }, [])
  const onFocus = useCallback((paneId: number): void => {
    dispatch({ type: 'focus-pane', paneId })
  }, [])
  const resolvePrompt = useCallback((promptId: string, value: string): void => {
    void window.api.sessions.answerPrompt(promptId, value)
    dispatch({ type: 'prompt-done', promptId })
  }, [])
  const onResizeSplit = useCallback((tabId: number, path: Array<'a' | 'b'>, ratio: number): void => {
    dispatch({ type: 'resize-split', tabId, path, ratio })
  }, [])

  const paneProps = {
    registerTerminal,
    unregisterTerminal,
    onAttach,
    onTitle,
    onCwd,
    onFocus,
    resolvePrompt
  }

  if (!config) {
    return <div className="boot">Loading XtermMuxer…</div>
  }

  const tab = state.tabs.find((t) => t.id === state.activeTabId)
  const activePane: PaneRecord | undefined = tab && tab.activePaneId !== null ? tab.panes.get(tab.activePaneId) : undefined

  return (
    <div className="app">
      <TabBar
        tabs={state.tabs}
        activeTabId={state.activeTabId}
        onActivate={(tid) => dispatch({ type: 'activate-tab', tabId: tid })}
        onClose={(tid) => dispatch({ type: 'close-tab', tabId: tid })}
        onNewTab={newTab}
        onNewSsh={() => setSshDialogOpen(true)}
      />
      <div className="workspace">
        {state.tabs.length === 0 && (
          <div className="empty-state">Open a terminal: Ctrl+Shift+T · SSH: Ctrl+Shift+S</div>
        )}
        {/* Every tab stays mounted (hidden when inactive) so its sessions are
            not destroyed by tab switches; zoom is handled inside SplitView. */}
        {state.tabs.map((t) => (
          <div
            key={t.id}
            className={'tab-view' + (t.id === state.activeTabId ? '' : ' tab-view-hidden')}
          >
            <SplitView node={t.root} tab={t} config={config} paneProps={paneProps} onResizeSplit={onResizeSplit} />
          </div>
        ))}
      </div>
      <StatusBar
        pane={activePane}
        searchOpen={searchOpen}
        searchQuery={searchQuery}
        onSearchQuery={setSearchQuery}
        onSearchNext={searchNext}
        onSearchPrev={searchPrev}
        onSearchClose={() => setSearchOpen(false)}
      />
      <SshDialog
        open={sshDialogOpen}
        hosts={sshHosts}
        onCancel={() => setSshDialogOpen(false)}
        onConnect={(target, identity, password) => {
          setSshDialogOpen(false)
          newSshTab(target, identity, password)
        }}
      />
    </div>
  )
}
