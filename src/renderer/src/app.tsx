
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { TabBar } from './components/tab-bar'
import { SshDialog } from './components/ssh-dialog'
import { SettingsDialog } from './components/settings-dialog'
import { KeysDialog } from './components/keys-dialog'
import type { SettingsValues } from './components/settings-dialog'
import { SearchOverlay, LeaderOverlay, RenameTabOverlay, ResizeOverlay } from './components/overlays'
import { SplitView } from './components/split-view'
import type { TerminalHandle } from './components/terminal-pane'
import { muxReducer, findTabByPaneId } from './mux-reducer'
import { nextPaneId, nextTabId, neighborLeaf, paneOrder, findResizeSplit, resizeRatio } from './mux-model'
import type { MuxState, PaneRecord, PendingCreate, PromptState, SplitOrientation } from './mux-model'
import type { RendererConfig, SavedSshHost, SavedSshHostInput } from './types'
import { resolveTheme } from './theme'
import { decideKey, formatCombo, resolveKeymap } from './keymap'
import type { DirectActionId, ResolvedKeymap } from './keymap'
import type { LeaderKeyResult } from './keys'

const initialMux: MuxState = { tabs: [], activeTabId: null }

const fallbackConfig: RendererConfig = {
  font: { family: 'Maple Mono NF CN', size: 14, lineHeight: 1.15, ligatures: true },
  theme: { mode: 'system' },
  scrollback: 10000,
  window: { width: 1100, height: 700, title: 'XtermMuxer' },
  tabBar: { position: 'top' },
  copyOnSelect: true,
  focusFollowsMouse: true,
  webgl: true,
  ssh: {},
  exitBehavior: 'closeOnCleanExit',
  keys: {}
}

export function App(): ReactElement {
  const [state, dispatch] = useReducer(muxReducer, initialMux)
  const [config, setConfig] = useState<RendererConfig | null>(null)
  const [sshDialogOpen, setSshDialogOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [keybindingsOpen, setKeybindingsOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [sshHosts, setSshHosts] = useState<string[]>([])
  const [savedHosts, setSavedHosts] = useState<SavedSshHost[]>([])
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [leaderActive, setLeaderActive] = useState(false)

  // tmux-style leader (prefix) key: Alt+N arms it, the next key fires a command.
  // A ref mirrors the state so the keydown handler never sees a stale value.
  const leaderRef = useRef(false)
  const leaderTimerRef = useRef<number | undefined>(undefined)
  // Resize key table (leader+r): one-shot=false with a 1000ms idle timeout.
  const [resizeActive, setResizeActive] = useState(false)
  const resizeRef = useRef(false)
  const resizeTimerRef = useRef<number | undefined>(undefined)
  // ActivateLastTab (Alt+m): remember the tab we came from.
  const lastTabRef = useRef<number | null>(null)
  const prevActiveTabRef = useRef<number | null>(null)

  const terminalsRef = useRef(new Map<string, TerminalHandle>())
  // Latest config, readable synchronously when creating a session (state updates
  // are async, and the initial tab is created right after config loads).
  const configRef = useRef<RendererConfig>(fallbackConfig)
  // The resolved keymap. Recomputed only when the config changes, and mirrored into a
  // ref so the keydown handler never reads a stale table.
  const keymap = useMemo(() => resolveKeymap(config?.keys), [config])
  const keymapRef = useRef<ResolvedKeymap>(keymap)
  keymapRef.current = keymap
  // Mirrors `keybindingsOpen` for the window listener, which must stop claiming keys
  // while the Keybindings dialog is recording one.
  const keybindingsRef = useRef(false)
  keybindingsRef.current = keybindingsOpen
  // Passwords provided via the SSH dialog, kept in memory for this app run only
  // so inherited panes/tabs don't re-prompt. Never written to disk.
  const sshSecretsRef = useRef(new Map<string, string>())
  // Output/prompts that arrive before the pane has attached its session are
  // buffered here and flushed on register/attach. Without this, a fast SSH
  // handshake can deliver the banner + first shell prompt before
  // `session:create` has resolved and the data is dropped, leaving a blank pane.
  const pendingOutputRef = useRef(new Map<string, string[]>())
  const pendingPromptsRef = useRef(new Map<string, PromptState[]>())
  const attachedRef = useRef(new Set<string>())
  // Sessions that exited before their pane finished attaching: sessionId -> exit code.
  const exitedRef = useRef(new Map<string, number | null>())
  // Sessions that reached the 'connected' state at least once (an established
  // session that later drops should close; a failed connect should stay visible).
  const connectedRef = useRef(new Set<string>())
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
    // UI font metrics: the tab bar tracks the terminal font so its height matches
    // a terminal text line (font size x line height).
    const family = c.font.family?.trim()
    if (family) root.style.setProperty('--font-family', family)
    else root.style.removeProperty('--font-family')
    root.style.setProperty('--font-size', `${c.font.size}px`)
    root.style.setProperty('--tab-height', `${Math.round(c.font.size * c.font.lineHeight)}px`)
  }, [])

  /** Persist a settings patch and apply it live (panes pick up font/scrollback changes). */
  const applySettings = useCallback(
    (values: SettingsValues): void => {
      void window.api.config
        .set(values)
        .then((c) => {
          configRef.current = c
          setConfig(c)
          applyTheme(c)
        })
        .catch(() => undefined)
    },
    [applyTheme]
  )

  /**
   * Persist keybinding overrides. `keys` carries only the bindings the dialog touched,
   * so untouched ids keep whatever is already stored (deepMerge merges the map
   * key-by-key) and a future default change still reaches this user.
   */
  const applyKeys = useCallback((keys: Record<string, string[]>): void => {
    void window.api.config
      .set({ keys })
      .then((c) => {
        configRef.current = c
        setConfig(c)
      })
      .catch(() => undefined)
  }, [])

  /**
   * Apply `exitBehavior` to a finished session: close its pane (and the window
   * when it was the last one) or hold it open showing "Session ended".
   * `knownPaneId` is passed when the pane exists but its session was not yet
   * attached (an exit can race the create/attach handshake).
   */
  const applySessionExit = useCallback((sessionId: string, code: number | null, knownPaneId?: number): void => {
    const s = stateRef.current
    let paneId: number | null = knownPaneId ?? null
    let isLastPaneOfLastTab = false
    if (paneId === null) {
      for (const t of s.tabs) {
        for (const [pid, p] of t.panes) {
          if (p.sessionId === sessionId) {
            paneId = pid
            isLastPaneOfLastTab = s.tabs.length === 1 && t.panes.size === 1
          }
        }
      }
    } else {
      for (const t of s.tabs) {
        if (t.panes.has(paneId)) {
          isLastPaneOfLastTab = s.tabs.length === 1 && t.panes.size === 1
          break
        }
      }
    }
    if (paneId === null) return

    // 'close': always close. 'closeOnCleanExit' (default): close on a clean exit
    // or once the session had connected (i.e. a real disconnect); hold a session
    // that never established so connection/auth errors stay readable.
    // 'hold': never close.
    const behavior = configRef.current.exitBehavior ?? 'closeOnCleanExit'
    const established = connectedRef.current.has(sessionId)
    connectedRef.current.delete(sessionId)
    const shouldClose = behavior === 'close' || (behavior === 'closeOnCleanExit' && (code === 0 || established))
    if (shouldClose) {
      dispatch({ type: 'close-pane', paneId })
      // Last pane of the last tab -> close the window, like a terminal does.
      if (isLastPaneOfLastTab) window.api.window.close()
    } else {
      dispatch({ type: 'exit', sessionId })
    }
  }, [])

  // Load config and SSH hosts. No pane/tab is opened on startup — the user picks
  // a local shell (Ctrl+Shift+T / +) or SSH (Ctrl+Shift+S); `ssh.defaultTarget`
  // still applies when they do.
  useEffect(() => {
    let cancelled = false
    const boot = (c: RendererConfig): void => {
      if (cancelled) return
      configRef.current = c
      setConfig(c)
      applyTheme(c)
    }
    void window.api.config
      .get()
      .then((c) => {
        boot(c)
        if (smoke) console.log('[smoke] config loaded')
      })
      .catch(() => {
        boot(fallbackConfig)
        if (smoke) console.log('[smoke] config fallback')
      })
    void window.api.sessions.listSshHosts().then(setSshHosts).catch(() => undefined)
    void window.api.sessions.listSavedHosts().then(setSavedHosts).catch(() => undefined)
    return () => {
      cancelled = true
    }
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
            if (attachedRef.current.has(ev.id)) {
              attachedRef.current.delete(ev.id)
              applySessionExit(ev.id, ev.code ?? null)
            } else {
              // Exit raced the attach handshake; remember it for onAttach.
              exitedRef.current.set(ev.id, ev.code ?? null)
            }
          }
          break
        case 'session:status':
          if (ev.id) {
            if (ev.status === 'connected') connectedRef.current.add(ev.id)
            dispatch({ type: 'status', sessionId: ev.id, status: ev.status ?? null })
          }
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

  useEffect(
    () => () => {
      if (leaderTimerRef.current !== undefined) window.clearTimeout(leaderTimerRef.current)
      if (resizeTimerRef.current !== undefined) window.clearTimeout(resizeTimerRef.current)
    },
    []
  )

  // Track the previously active tab so Alt+m can jump back to it.
  useEffect(() => {
    const current = state.activeTabId
    if (prevActiveTabRef.current !== null && prevActiveTabRef.current !== current) {
      lastTabRef.current = prevActiveTabRef.current
    }
    prevActiveTabRef.current = current
  }, [state.activeTabId])

  // -------- actions --------

  function clearLeader(): void {
    if (leaderTimerRef.current !== undefined) {
      window.clearTimeout(leaderTimerRef.current)
      leaderTimerRef.current = undefined
    }
    leaderRef.current = false
    setLeaderActive(false)
  }

  function armLeader(): void {
    if (leaderTimerRef.current !== undefined) window.clearTimeout(leaderTimerRef.current)
    leaderRef.current = true
    setLeaderActive(true)
    // Mirror tmux's prefix: if no follow-up key arrives, drop out of leader mode.
    leaderTimerRef.current = window.setTimeout(() => clearLeader(), 2000)
  }

  /**
   * Decide what a new pane/tab should run:
   *   1. inherit the active pane's SSH connection (same host/identity),
   *   2. else use `ssh.defaultTarget` from config (SSH by default),
   *   3. else a local shell.
   * The dialog-provided password (if any) is reused from memory for this run.
   */
  function sessionFor(pane: PaneRecord | undefined, fallbackCwd?: string): PendingCreate {
    if (pane?.kind === 'ssh' && pane.sshOpts) {
      const { target, user, port, identity } = pane.sshOpts
      // The inherited target is this very pane's host, so its cwd is a remote
      // path that means something on the other side. Omitted until the remote
      // has reported one (OSC 7).
      return {
        kind: 'ssh',
        target,
        user,
        port,
        identity,
        password: sshSecretsRef.current.get(target),
        cwd: pane.cwd ?? undefined
      }
    }
    const target = configRef.current.ssh?.defaultTarget?.trim()
    if (target) {
      return { kind: 'ssh', target, password: sshSecretsRef.current.get(target) }
    }
    return { kind: 'local', cwd: pane?.cwd ?? fallbackCwd }
  }

  function newTab(): void {
    const s = stateRef.current
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    const pane = tab && tab.activePaneId !== null ? tab.panes.get(tab.activePaneId) : undefined
    dispatch({ type: 'open-tab', tabId: nextTabId(), paneId: nextPaneId(), pendingCreate: sessionFor(pane) })
  }

  function newSshTab(target: string, identity?: string, password?: string): void {
    if (password) sshSecretsRef.current.set(target, password)
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
    dispatch({
      type: 'add-pane',
      tabId: tab.id,
      targetPaneId: paneId,
      orientation,
      paneId: nextPaneId(),
      pendingCreate: sessionFor(pane)
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

  /** ActivatePaneDirection("Next"): cycle panes in tree order. */
  function focusNextPane(): void {
    const s = stateRef.current
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    if (!tab || tab.activePaneId === null || tab.panes.size < 2) return
    const order = paneOrder(tab.root)
    const idx = order.indexOf(tab.activePaneId)
    if (idx < 0) return
    dispatch({ type: 'focus-pane', paneId: order[(idx + 1) % order.length] })
  }

  /** ActivateLastTab (Alt+m): switch back to the previously focused tab. */
  function activateLastTab(): void {
    const last = lastTabRef.current
    if (last !== null && stateRef.current.tabs.some((t) => t.id === last)) {
      dispatch({ type: 'activate-tab', tabId: last })
    }
  }

  // -------- resize key table (leader+r) --------

  function exitResizeMode(): void {
    if (resizeTimerRef.current !== undefined) {
      window.clearTimeout(resizeTimerRef.current)
      resizeTimerRef.current = undefined
    }
    resizeRef.current = false
    setResizeActive(false)
  }

  function resetResizeTimer(): void {
    if (resizeTimerRef.current !== undefined) window.clearTimeout(resizeTimerRef.current)
    resizeTimerRef.current = window.setTimeout(() => exitResizeMode(), 1000)
  }

  function enterResizeMode(): void {
    resizeRef.current = true
    setResizeActive(true)
    resetResizeTimer()
  }

  /** AdjustPaneSize: move the nearest aligned divider on the active pane. */
  function adjustPaneSize(dir: 'left' | 'right' | 'up' | 'down'): void {
    const s = stateRef.current
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    if (!tab || tab.activePaneId === null) return
    const split = findResizeSplit(tab.root, tab.activePaneId, dir)
    if (!split) return
    dispatch({ type: 'resize-split', tabId: tab.id, path: split.path, ratio: resizeRatio(split.ratio, dir) })
  }

  async function pasteClipboard(): Promise<void> {
    const sid = activeSessionId()
    const handle = sid ? terminalsRef.current.get(sid) : undefined
    if (!handle) return
    try {
      const text = await navigator.clipboard.readText()
      // Route through xterm rather than writing the clipboard straight to the
      // session. `Terminal.paste` normalizes line endings (CRLF/LF -> a lone CR)
      // and wraps the text in bracketed-paste markers when the application asked
      // for them. Writing the raw clipboard instead sends CRLF to the pty, and a
      // Unix tty's ICRNL maps that CR to another NL -- turning every line break
      // into a blank line -- while the missing brackets make shells run each
      // pasted line immediately and editors re-indent them.
      if (text) handle.term.paste(text)
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

  /** Run a direct-table action. The handlers themselves are unchanged. */
  function runAction(id: DirectActionId, paneId: number | null): void {
    switch (id) {
      case 'new-tab':
        newTab()
        break
      case 'new-ssh':
        setSshDialogOpen(true)
        break
      case 'open-settings':
        setSettingsOpen(true)
        break
      case 'open-keybindings':
        setKeybindingsOpen(true)
        break
      case 'close-pane':
        if (paneId !== null) dispatch({ type: 'close-pane', paneId })
        break
      case 'toggle-zoom':
        if (paneId !== null) dispatch({ type: 'zoom', paneId })
        break
      case 'toggle-search':
        setSearchOpen((o) => !o)
        break
      case 'copy':
        copySelection()
        break
      case 'paste':
        void pasteClipboard()
        break
      case 'split-col':
        if (paneId !== null) splitPane(paneId, 'col')
        break
      case 'split-row':
        if (paneId !== null) splitPane(paneId, 'row')
        break
      case 'next-tab':
        cycleTab(1)
        break
      case 'prev-tab':
        cycleTab(-1)
        break
      case 'focus-up':
        moveFocus('up')
        break
      case 'focus-down':
        moveFocus('down')
        break
      case 'focus-left':
        moveFocus('left')
        break
      case 'focus-right':
        moveFocus('right')
        break
      case 'toggle-fullscreen':
        window.api.window.toggleFullscreen()
        break
      case 'last-tab':
        activateLastTab()
        break
      case 'focus-next-pane':
        focusNextPane()
        break
      // copy-mode, quick-select and leader-prefix have their own outcomes.
      default:
        break
    }
  }

  /** Run a command from the leader key table. */
  function runLeader(result: LeaderKeyResult, paneId: number | null): void {
    if (result.kind === 'tab-index') {
      const target = stateRef.current.tabs[result.index - 1]
      if (target) dispatch({ type: 'activate-tab', tabId: target.id })
      return
    }
    if (result.kind !== 'action') return
    switch (result.action) {
      case 'split-row':
        if (paneId !== null) splitPane(paneId, 'row')
        break
      case 'split-col':
        if (paneId !== null) splitPane(paneId, 'col')
        break
      case 'new-tab':
        newTab()
        break
      case 'close-pane':
        if (paneId !== null) dispatch({ type: 'close-pane', paneId })
        break
      case 'toggle-zoom':
        if (paneId !== null) dispatch({ type: 'zoom', paneId })
        break
      case 'rename-tab':
        setRenameOpen(true)
        break
      case 'next-tab':
        cycleTab(1)
        break
      case 'prev-tab':
        cycleTab(-1)
        break
      case 'focus-left':
        moveFocus('left')
        break
      case 'focus-down':
        moveFocus('down')
        break
      case 'focus-up':
        moveFocus('up')
        break
      case 'focus-right':
        moveFocus('right')
        break
      case 'resize-mode':
        enterResizeMode()
        break
    }
  }

  /**
   * Route a keydown. `decideKey` owns the precedence (which modal table gets the key
   * and in what order); this only performs the resulting outcome. Everything the
   * bindings resolve to comes from the user-configurable keymap.
   */
  function handleShortcut(e: KeyboardEvent): boolean {
    const s = stateRef.current
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    const paneId = tab?.activePaneId ?? null

    const activeSid = activeSessionId()
    const handle = activeSid ? terminalsRef.current.get(activeSid) : undefined

    const outcome = decideKey(
      e,
      {
        hasTerminal: !!handle,
        copyMode: !!handle?.copyMode.active(),
        quickSelect: !!handle?.quickSelect.active(),
        resizeMode: resizeRef.current,
        leaderArmed: leaderRef.current
      },
      keymapRef.current
    )

    switch (outcome.kind) {
      case 'pass':
        // Let the key reach the terminal (or whatever else wants it).
        return false
      case 'copy-mode-toggle':
        if (handle) {
          if (handle.copyMode.active()) handle.copyMode.exit()
          else handle.copyMode.enter()
        }
        return true
      case 'copy-mode-key':
        handle?.copyMode.handleKey(e)
        return true
      case 'quick-select-toggle':
        if (handle) {
          if (handle.quickSelect.active()) handle.quickSelect.exit()
          else handle.quickSelect.enter()
        }
        return true
      case 'quick-select-key':
        handle?.quickSelect.handleKey(e)
        return true
      case 'resize':
        adjustPaneSize(outcome.action)
        resetResizeTimer()
        return true
      case 'resize-exit':
        exitResizeMode()
        return true
      case 'arm-leader':
        armLeader()
        return true
      case 'leader-result':
        // Swallow the key either way so it never reaches the shell.
        clearLeader()
        runLeader(outcome.result, paneId)
        return true
      case 'action':
        runAction(outcome.id, paneId)
        return true
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // While the Keybindings dialog is recording, it owns every keystroke. This has
      // to happen here and not via stopPropagation in the dialog: this listener runs
      // in the capture phase on `window`, so it sees the event before React's root
      // handler does, and the recorder's cell is a <button> that the form-field guard
      // below does not cover.
      if (keybindingsRef.current) return
      // Skip mux shortcuts while the user is typing in a real form field (search
      // box / SSH dialog). The xterm helper <textarea> is excluded: it is the
      // terminal's focus sink, and treating it as a form field would swallow
      // every shortcut whenever a pane has focus.
      const target = e.target as HTMLElement | null
      const inFormField =
        !!target &&
        (target.tagName === 'INPUT' ||
          target.isContentEditable ||
          (target.tagName === 'TEXTAREA' && !target.classList.contains('xterm-helper-textarea')))
      if (inFormField) return
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
    const title = tab?.title || pane?.title || pane?.label || ''
    const idx = state.tabs.findIndex((t) => t.id === state.activeTabId)
    document.title = state.tabs.length > 0 ? `[${idx + 1}/${state.tabs.length}] ${title}` : 'XtermMuxer'
  }, [state])

  // Keep DOM focus on the active pane's terminal. Keyed on the active session id
  // so it also fires when the active *tab* is closed/replaced (per-pane `active`
  // flags don't change then), and it runs after child cleanup so an unmount can
  // no longer drop focus to <body>.
  const focusTab = state.tabs.find((t) => t.id === state.activeTabId)
  const focusedSession =
    focusTab && focusTab.activePaneId !== null ? focusTab.panes.get(focusTab.activePaneId)?.sessionId ?? null : null
  const renameInitial = (() => {
    if (!focusTab) return ''
    if (focusTab.title) return focusTab.title
    const p = focusTab.activePaneId !== null ? focusTab.panes.get(focusTab.activePaneId) : undefined
    return p?.title || p?.label || ''
  })()
  useEffect(() => {
    if (!focusedSession) return
    terminalsRef.current.get(focusedSession)?.term.focus()
  }, [focusedSession])

  // Return focus to the active terminal once any overlay/dialog closes (rename /
  // settings / keybindings / SSH), otherwise it is left on <body> and typing goes
  // nowhere.
  useEffect(() => {
    if (renameOpen || settingsOpen || keybindingsOpen || sshDialogOpen) return
    if (!focusedSession) return
    terminalsRef.current.get(focusedSession)?.term.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renameOpen, settingsOpen, keybindingsOpen, sshDialogOpen])

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
    exitedRef.current.delete(sessionId)
    connectedRef.current.delete(sessionId)
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
      // A queued exit means the session ended before the pane attached.
      if (exitedRef.current.has(sessionId)) {
        const code = exitedRef.current.get(sessionId) ?? null
        exitedRef.current.delete(sessionId)
        applySessionExit(sessionId, code, paneId)
      }
    },
    [applySessionExit]
  )
  const onTitle = useCallback((paneId: number, title: string): void => {
    dispatch({ type: 'title', paneId, title })
  }, [])
  const onCwd = useCallback((paneId: number, cwd: string): void => {
    dispatch({ type: 'cwd', paneId, cwd })
  }, [])
  const onFocus = useCallback((paneId: number): void => {
    dispatch({ type: 'focus-pane', paneId })
    // Copy mode is exclusive to the focused pane: leave it on the others.
    const s = stateRef.current
    let focusedSid: string | null = null
    for (const t of s.tabs) {
      const p = t.panes.get(paneId)
      if (p) {
        focusedSid = p.sessionId
        break
      }
    }
    for (const [sid, h] of terminalsRef.current) {
      if (sid !== focusedSid && h.copyMode?.active()) h.copyMode.exit()
      if (sid !== focusedSid && h.quickSelect?.active()) h.quickSelect.exit()
    }
  }, [])
  const resolvePrompt = useCallback((promptId: string, value: string): void => {
    void window.api.sessions.answerPrompt(promptId, value)
    dispatch({ type: 'prompt-done', promptId })
  }, [])
  const onResizeSplit = useCallback((tabId: number, path: Array<'a' | 'b'>, ratio: number): void => {
    dispatch({ type: 'resize-split', tabId, path, ratio })
  }, [])

  /** The first chord bound to an action, formatted for a tooltip; '' when unbound. */
  const chordHint = (id: DirectActionId): string => {
    const chords = keymap.direct.get(id) ?? []
    return chords.length > 0 ? ` (${formatCombo(chords[0])})` : ''
  }

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

  return (
    <div className={'app' + (config.tabBar?.position === 'bottom' ? ' tab-bar-bottom' : '')}>
      <TabBar
        tabs={state.tabs}
        activeTabId={state.activeTabId}
        onActivate={(tid) => dispatch({ type: 'activate-tab', tabId: tid })}
        onClose={(tid) => dispatch({ type: 'close-tab', tabId: tid })}
        onNewTab={newTab}
        onNewSsh={() => setSshDialogOpen(true)}
        onSettings={() => setSettingsOpen(true)}
        onKeybindings={() => setKeybindingsOpen(true)}
        shortcutHints={{
          newTab: chordHint('new-tab'),
          newSsh: chordHint('new-ssh'),
          settings: chordHint('open-settings'),
          keybindings: chordHint('open-keybindings')
        }}
      />
      <div className="workspace">
        {state.tabs.length === 0 && (
          <div className="empty-state">
            <div className="empty-title">No sessions open</div>
            <div className="empty-hint">Start a local shell or connect over SSH.</div>
            <div className="empty-actions">
              <button onClick={newTab}>
                New terminal
                {keymap.direct.get('new-tab')?.length ? <kbd>{formatCombo(keymap.direct.get('new-tab')![0])}</kbd> : null}
              </button>
              <button onClick={() => setSshDialogOpen(true)}>
                New SSH connection
                {keymap.direct.get('new-ssh')?.length ? <kbd>{formatCombo(keymap.direct.get('new-ssh')![0])}</kbd> : null}
              </button>
            </div>
          </div>
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
      <SearchOverlay
        open={searchOpen}
        query={searchQuery}
        onQuery={setSearchQuery}
        onNext={searchNext}
        onPrev={searchPrev}
        onClose={() => setSearchOpen(false)}
      />
      <LeaderOverlay active={leaderActive} />
      <ResizeOverlay active={resizeActive} />
      <RenameTabOverlay
        open={renameOpen && state.activeTabId !== null}
        initial={renameInitial}
        onCancel={() => setRenameOpen(false)}
        onSubmit={(name) => {
          setRenameOpen(false)
          if (state.activeTabId !== null) {
            dispatch({ type: 'rename-tab', tabId: state.activeTabId, title: name || null })
          }
        }}
      />
      <SettingsDialog
        open={settingsOpen}
        config={config}
        onCancel={() => setSettingsOpen(false)}
        onApply={(values) => {
          setSettingsOpen(false)
          applySettings(values)
        }}
      />
      <KeysDialog
        open={keybindingsOpen}
        keys={config.keys ?? {}}
        onCancel={() => setKeybindingsOpen(false)}
        onApply={(patch) => {
          setKeybindingsOpen(false)
          applyKeys(patch)
        }}
      />
      <SshDialog
        open={sshDialogOpen}
        hosts={sshHosts}
        savedHosts={savedHosts}
        onCancel={() => setSshDialogOpen(false)}
        onSave={(h: SavedSshHostInput) => {
          void window.api.sessions.saveSshHost(h).then(setSavedHosts).catch(() => undefined)
        }}
        onDelete={(id: string) => {
          void window.api.sessions.deleteSshHost(id).then(setSavedHosts).catch(() => undefined)
        }}
        onConnect={(target, identity, password) => {
          setSshDialogOpen(false)
          newSshTab(target, identity, password)
        }}
      />
    </div>
  )
}
