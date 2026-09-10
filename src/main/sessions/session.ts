export type SessionKind = 'local' | 'ssh'

export type SessionStatus = 'connecting' | 'authenticating' | 'connected' | 'error'

export interface PromptRequest {
  promptId: string
  text: string
  echo: boolean
}

/** Events that a session reports back to the SessionManager (which forwards over IPC). */
export interface SessionEvents {
  onOutput: (data: string) => void
  onExit: (code: number | null, reason?: string) => void
  onStatus: (status: SessionStatus, detail?: string) => void
  onPrompt: (prompt: PromptRequest) => void
}

/** A terminal-backed session: local PTY or SSH remote shell. Mirrors wezterm's Pane trait. */
export interface Session {
  id: string
  kind: SessionKind
  /** Fallback title (process basename for local, user@host for ssh), shown until OSC title arrives. */
  label: string
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  /** Answer an inline prompt issued via onPrompt. */
  answerPrompt?(promptId: string, value: string): void
}

export interface LocalCreateOptions {
  kind: 'local'
  shell?: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  cols: number
  rows: number
}

export interface SshCreateOptions {
  kind: 'ssh'
  /** "user@host[:port]" — user/port optional, resolved through ssh_config. */
  target: string
  user?: string
  port?: number
  identity?: string
  password?: string
  cols: number
  rows: number
}

export type CreateOptions = LocalCreateOptions | SshCreateOptions
