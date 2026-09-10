export interface RendererConfig {
  font: { family?: string; size: number; lineHeight: number }
  theme: {
    mode: 'system' | 'light' | 'dark'
    colors?: { background?: string; foreground?: string; cursor?: string; selectionBackground?: string }
  }
  scrollback: number
  window: { width: number; height: number; title: string }
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
  cols: number
  rows: number
}

export type SessionCreateOpts = SessionCreateLocal | SessionCreateSsh

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
  }
  config: {
    get: () => Promise<RendererConfig>
  }
  smokeTest: boolean
  onEvent: (handler: (payload: MuxEvent) => void) => () => void
}

declare global {
  interface Window {
    api: WindowApi
  }
}
