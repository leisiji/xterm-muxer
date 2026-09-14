import type { MuxState, TabRecord, PaneRecord, PaneNode, SplitOrientation, PendingCreate, PromptState } from './mux-model'
import { findPane, containsPane, insertSplit, removeLeaf, setRatioAt, countPanes } from './mux-model'

export type MuxAction =
  | { type: 'open-tab'; tabId: number; paneId: number; pendingCreate: PendingCreate }
  | {
      type: 'add-pane'
      tabId: number
      targetPaneId: number
      orientation: SplitOrientation
      paneId: number
      pendingCreate: PendingCreate
    }
  | { type: 'attach'; paneId: number; sessionId: string; label: string }
  | { type: 'exit'; sessionId: string }
  | { type: 'status'; sessionId: string; status: string | null }
  | { type: 'prompt'; sessionId: string; prompt: PromptState }
  | { type: 'prompt-done'; promptId: string }
  | { type: 'title'; paneId: number; title: string }
  | { type: 'cwd'; paneId: number; cwd: string }
  | { type: 'unseen'; tabId: number }
  | { type: 'rename-tab'; tabId: number; title: string | null }
  | { type: 'activate-tab'; tabId: number }
  | { type: 'focus-pane'; paneId: number }
  | { type: 'zoom'; paneId: number }
  | { type: 'close-pane'; paneId: number }
  | { type: 'close-tab'; tabId: number }
  | { type: 'resize-split'; tabId: number; path: Array<'a' | 'b'>; ratio: number }

function findTabBySession(state: MuxState, sessionId: string): TabRecord | undefined {
  return state.tabs.find((t) => [...t.panes.values()].some((p) => p.sessionId === sessionId))
}

function findTabWithPane(state: MuxState, paneId: number): TabRecord | undefined {
  return state.tabs.find((t) => t.panes.has(paneId))
}

function cloneTab(tab: TabRecord): TabRecord {
  return { ...tab, panes: new Map(tab.panes) }
}

function firstPaneId(node: PaneNode): number {
  return node.kind === 'pane' ? node.paneId : firstPaneId(node.a)
}

export function muxReducer(state: MuxState, action: MuxAction): MuxState {
  switch (action.type) {
    case 'open-tab': {
      const pane: PaneRecord = {
        id: action.paneId,
        sessionId: null,
        label: '',
        title: null,
        // Seed from the inherited directory so a pane spawned from a pane whose
        // shell never reports its cwd (a remote shell without OSC 7) still
        // chains: the next spawn inherits this value instead of nothing.
        cwd: action.pendingCreate.cwd ?? null,
        dead: false,
        status: null,
        pendingCreate: action.pendingCreate,
        prompt: null
      }
      const tab: TabRecord = {
        id: action.tabId,
        root: { kind: 'pane', paneId: pane.id },
        panes: new Map([[pane.id, pane]]),
        activePaneId: pane.id,
        zoomedPaneId: null,
        unseen: false,
        title: null
      }
      return { tabs: [...state.tabs, tab], activeTabId: action.tabId }
    }

    case 'add-pane': {
      const tab = findTabWithPane(state, action.targetPaneId)
      if (!tab) return state
      const newPane: PaneRecord = {
        id: action.paneId,
        sessionId: null,
        label: '',
        title: null,
        // See open-tab: seed the inherited directory.
        cwd: action.pendingCreate.cwd ?? null,
        dead: false,
        status: null,
        pendingCreate: action.pendingCreate,
        prompt: null
      }
      const t = cloneTab(tab)
      t.root = insertSplit(t.root, action.targetPaneId, action.orientation, action.paneId)
      t.panes.set(action.paneId, newPane)
      t.activePaneId = action.paneId
      // Splitting while zoomed unzooms so the new pane is actually visible.
      t.zoomedPaneId = null
      t.unseen = false
      return { ...state, tabs: state.tabs.map((x) => (x.id === t.id ? t : x)) }
    }

    case 'attach': {
      const tab = findTabWithPane(state, action.paneId)
      if (!tab) return state
      const t = cloneTab(tab)
      const p = t.panes.get(action.paneId)
      if (!p) return state
      const sshOpts: PaneRecord['sshOpts'] =
        p.pendingCreate?.kind === 'ssh' && p.pendingCreate.target
          ? {
              target: p.pendingCreate.target,
              user: p.pendingCreate.user,
              port: p.pendingCreate.port,
              identity: p.pendingCreate.identity
            }
          : undefined
      t.panes.set(action.paneId, {
        ...p,
        sessionId: action.sessionId,
        label: action.label,
        kind: p.pendingCreate?.kind,
        sshOpts,
        pendingCreate: null
      })
      return { ...state, tabs: state.tabs.map((x) => (x.id === t.id ? t : x)) }
    }

    case 'exit': {
      const tab = findTabBySession(state, action.sessionId)
      if (!tab) return state
      const t = cloneTab(tab)
      for (const [id, p] of t.panes) {
        if (p.sessionId === action.sessionId && !p.dead) t.panes.set(id, { ...p, dead: true })
      }
      return { ...state, tabs: state.tabs.map((x) => (x.id === t.id ? t : x)) }
    }

    case 'status': {
      const tab = findTabBySession(state, action.sessionId)
      if (!tab) return state
      const t = cloneTab(tab)
      for (const [id, p] of t.panes) {
        if (p.sessionId === action.sessionId) t.panes.set(id, { ...p, status: action.status })
      }
      return { ...state, tabs: state.tabs.map((x) => (x.id === t.id ? t : x)) }
    }

    case 'prompt': {
      const tab = findTabBySession(state, action.sessionId)
      if (!tab) return state
      const t = cloneTab(tab)
      for (const [id, p] of t.panes) {
        if (p.sessionId === action.sessionId) t.panes.set(id, { ...p, prompt: action.prompt })
      }
      return { ...state, tabs: state.tabs.map((x) => (x.id === t.id ? t : x)) }
    }

    case 'prompt-done': {
      const tab = state.tabs.find((t) => [...t.panes.values()].some((p) => p.prompt?.promptId === action.promptId))
      if (!tab) return state
      const t = cloneTab(tab)
      for (const [id, p] of t.panes) {
        if (p.prompt?.promptId === action.promptId) t.panes.set(id, { ...p, prompt: null })
      }
      return { ...state, tabs: state.tabs.map((x) => (x.id === t.id ? t : x)) }
    }

    case 'title': {
      const tab = findTabWithPane(state, action.paneId)
      if (!tab) return state
      const t = cloneTab(tab)
      const p = t.panes.get(action.paneId)
      if (!p) return state
      t.panes.set(action.paneId, { ...p, title: action.title || null })
      return { ...state, tabs: state.tabs.map((x) => (x.id === t.id ? t : x)) }
    }

    case 'cwd': {
      const tab = findTabWithPane(state, action.paneId)
      if (!tab) return state
      const t = cloneTab(tab)
      const p = t.panes.get(action.paneId)
      if (!p) return state
      t.panes.set(action.paneId, { ...p, cwd: action.cwd })
      return { ...state, tabs: state.tabs.map((x) => (x.id === t.id ? t : x)) }
    }

    case 'unseen': {
      const tab = state.tabs.find((t) => t.id === action.tabId)
      if (!tab || tab.unseen || tab.id === state.activeTabId) return state
      return {
        ...state,
        tabs: state.tabs.map((t) => (t.id === action.tabId ? { ...t, unseen: true } : t))
      }
    }

    case 'activate-tab': {
      return {
        ...state,
        activeTabId: action.tabId,
        tabs: state.tabs.map((t) => (t.id === action.tabId ? { ...t, unseen: false } : t))
      }
    }

    case 'rename-tab': {
      return {
        ...state,
        tabs: state.tabs.map((t) => (t.id === action.tabId ? { ...t, title: action.title } : t))
      }
    }

    case 'focus-pane': {
      const tab = findTabWithPane(state, action.paneId)
      if (!tab) return state
      const t = cloneTab(tab)
      t.activePaneId = action.paneId
      // wezterm `unzoom_on_switch_pane`: switching to a different pane while
      // zoomed unzooms, otherwise the focused pane would stay hidden.
      if (t.zoomedPaneId !== null && t.zoomedPaneId !== action.paneId) t.zoomedPaneId = null
      return { ...state, tabs: state.tabs.map((x) => (x.id === t.id ? t : x)) }
    }

    case 'zoom': {
      const tab = findTabWithPane(state, action.paneId)
      if (!tab) return state
      const t = cloneTab(tab)
      t.zoomedPaneId = t.zoomedPaneId === action.paneId ? null : action.paneId
      return { ...state, tabs: state.tabs.map((x) => (x.id === t.id ? t : x)) }
    }

    case 'close-pane': {
      const tab = findTabWithPane(state, action.paneId)
      if (!tab) return state
      const t = cloneTab(tab)
      if (countPanes(t.root) === 1) {
        // closing the only pane closes the tab
        const tabs = state.tabs.filter((x) => x.id !== t.id)
        return { tabs, activeTabId: state.activeTabId === t.id ? tabs[tabs.length - 1]?.id ?? null : state.activeTabId }
      }
      t.root = removeLeaf(t.root, action.paneId) ?? t.root
      t.panes.delete(action.paneId)
      if (t.zoomedPaneId === action.paneId) t.zoomedPaneId = null
      if (t.activePaneId === action.paneId) t.activePaneId = firstPaneId(t.root)
      return { ...state, tabs: state.tabs.map((x) => (x.id === t.id ? t : x)) }
    }

    case 'close-tab': {
      const tabs = state.tabs.filter((x) => x.id !== action.tabId)
      return { tabs, activeTabId: state.activeTabId === action.tabId ? tabs[tabs.length - 1]?.id ?? null : state.activeTabId }
    }

    case 'resize-split': {
      const tab = state.tabs.find((t) => t.id === action.tabId)
      if (!tab) return state
      const t = cloneTab(tab)
      t.root = setRatioAt(t.root, action.path, action.ratio)
      return { ...state, tabs: state.tabs.map((x) => (x.id === t.id ? t : x)) }
    }

    default:
      return state
  }
}

export function findTabByPaneId(state: MuxState, paneId: number): TabRecord | undefined {
  return findTabWithPane(state, paneId)
}

export { findPane }
