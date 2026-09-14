export interface RendererConfig {
  font: { family?: string; size: number; lineHeight: number }
  theme: {
    mode: 'system' | 'light' | 'dark'
    colors?: { background?: string; foreground?: string; cursor?: string; selectionBackground?: string }
  }
  scrollback: number
  window: { width: number; height: number; title: string }
  /** Where the tab bar sits: at the top (default) or bottom of the window. */
  tabBar?: { position?: 'top' | 'bottom' }
  /** Copy the current selection to the clipboard as soon as it is made. Default true. */
  copyOnSelect?: boolean
  /** Focus the pane under the mouse pointer. Default true. */
  focusFollowsMouse?: boolean
  /** Use the WebGL renderer for panes. Default true (see main/config.ts). */
  webgl?: boolean
  /** SSH settings. `defaultTarget` makes new sessions SSH instead of local. */
  ssh?: { defaultTarget?: string }
  /** What to do when a session exits (see main/config.ts). */
  exitBehavior?: 'close' | 'closeOnCleanExit' | 'hold'
  keys: Record<string, string>
}

export interface SessionCreateLocal {
  kind: 'local'
  cwd?: string
  cols: number
  rows: number
}

export interface SessionCreateSsh {
  kind: 'ssh'
  target: string
  user?: string
  port?: number
  identity?: string
  password?: string
  /** Remote directory to land in, inherited from the pane being spawned from. */
  cwd?: string
  cols: number
  rows: number
}

export type SessionCreateOpts = SessionCreateLocal | SessionCreateSsh

export interface SavedSshHost {
  id: string
  name: string
  host: string
  user?: string
  port?: number
  identity?: string
}

export type SavedSshHostInput = Omit<SavedSshHost, 'id'> & { id?: string }

export interface MuxEvent {
  type: string
  id?: string
  data?: string
  code?: number | null
  reason?: string
  status?: string
  detail?: string
  promptId?: string
  text?: string
  echo?: boolean
}

export interface WindowApi {
  sessions: {
    create: (opts: SessionCreateOpts) => Promise<{ id: string; label: string; kind: string }>
    write: (id: string, data: string) => Promise<void>
    resize: (id: string, cols: number, rows: number) => Promise<void>
    destroy: (id: string) => Promise<void>
    answerPrompt: (promptId: string, value: string) => Promise<void>
    listSshHosts: () => Promise<string[]>
    listSavedHosts: () => Promise<SavedSshHost[]>
    saveSshHost: (host: SavedSshHostInput) => Promise<SavedSshHost[]>
    deleteSshHost: (id: string) => Promise<SavedSshHost[]>
  }
  config: {
    get: () => Promise<RendererConfig>
    set: (patch: Partial<RendererConfig>) => Promise<RendererConfig>
  }
  window: {
    close: () => void
    toggleFullscreen: () => void
  }
  smokeTest: boolean
  onEvent: (handler: (payload: MuxEvent) => void) => () => void
}

declare global {
  interface Window {
    api: WindowApi
  }
}
