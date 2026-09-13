import { contextBridge, ipcRenderer } from 'electron'

export interface SessionCreateResult {
  id: string
  label: string
  kind: 'local' | 'ssh'
}

export interface SessionCreateLocalOpts {
  kind: 'local'
  shell?: string
  args?: string[]
  cwd?: string
  cols: number
  rows: number
}

export interface SessionCreateSshOpts {
  kind: 'ssh'
  target: string
  user?: string
  port?: number
  identity?: string
  password?: string
  cols: number
  rows: number
}

export type SessionCreateOpts = SessionCreateLocalOpts | SessionCreateSshOpts

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
  type: 'session:output' | 'session:exit' | 'session:status' | 'session:prompt'
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

const api = {
  sessions: {
    create: (opts: SessionCreateOpts): Promise<SessionCreateResult> =>
      ipcRenderer.invoke('session:create', opts),
    write: (id: string, data: string): Promise<void> =>
      ipcRenderer.invoke('session:write', { id, data }),
    resize: (id: string, cols: number, rows: number): Promise<void> =>
      ipcRenderer.invoke('session:resize', { id, cols, rows }),
    destroy: (id: string): Promise<void> => ipcRenderer.invoke('session:destroy', { id }),
    answerPrompt: (promptId: string, value: string): Promise<void> =>
      ipcRenderer.invoke('session:prompt-answer', { promptId, value }),
    listSshHosts: (): Promise<string[]> => ipcRenderer.invoke('ssh:list-hosts'),
    listSavedHosts: (): Promise<SavedSshHost[]> => ipcRenderer.invoke('ssh:list-saved'),
    saveSshHost: (host: SavedSshHostInput): Promise<SavedSshHost[]> =>
      ipcRenderer.invoke('ssh:save', host),
    deleteSshHost: (id: string): Promise<SavedSshHost[]> => ipcRenderer.invoke('ssh:delete', id)
  },
  config: {
    get: (): Promise<unknown> => ipcRenderer.invoke('config:get'),
    set: (patch: unknown): Promise<unknown> => ipcRenderer.invoke('config:set', patch)
  },
  window: {
    close: (): void => ipcRenderer.send('window:close')
  },
  smokeTest: process.env.SMOKE_TEST === '1',
  /** Subscribe to all main->renderer mux events. Returns an unsubscribe fn. */
  onEvent: (handler: (payload: MuxEvent) => void): (() => void) => {
    const listener = (_event: unknown, payload: MuxEvent): void => handler(payload)
    ipcRenderer.on('mux:event', listener)
    return () => {
      ipcRenderer.removeListener('mux:event', listener)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
