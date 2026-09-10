import { randomUUID } from 'crypto'
import { LocalSession } from './local-session'
import { SshSession } from './ssh-session'
import { Session, SessionEvents } from './session'
import type { LocalCreateOptions, SshCreateOptions } from './session'

export type RendererSink = (payload: unknown) => void

/**
 * The multiplexer: owns every session and routes data to the renderer.
 * Mirrors wezterm's Mux for the local-only (no remote connect) subset.
 */
export class SessionManager {
  private sessions = new Map<string, Session>()

  constructor(private sink: RendererSink) {}

  createLocal(opts: LocalCreateOptions): Session {
    const id = randomUUID()
    const session = new LocalSession(id, opts, this.eventsFor(id))
    this.sessions.set(id, session)
    return session
  }

  createSsh(opts: SshCreateOptions): Session {
    const id = randomUUID()
    const session = new SshSession(id, opts, this.eventsFor(id))
    this.sessions.set(id, session)
    session.connect()
    return session
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    this.sessions.get(id)?.resize(cols, rows)
  }

  destroy(id: string): void {
    const s = this.sessions.get(id)
    if (s) {
      try {
        s.kill()
      } catch {
        /* ignore */
      }
      this.sessions.delete(id)
    }
  }

  destroyAll(): void {
    for (const s of this.sessions.values()) {
      try {
        s.kill()
      } catch {
        /* ignore */
      }
    }
    this.sessions.clear()
  }

  answerPrompt(promptId: string, value: string): void {
    for (const s of this.sessions.values()) {
      if (s.answerPrompt) {
        s.answerPrompt(promptId, value)
      }
    }
  }

  private eventsFor(id: string): SessionEvents {
    return {
      onOutput: (data) => this.sink({ type: 'session:output', id, data }),
      onExit: (code, reason) => {
        this.sessions.delete(id)
        this.sink({ type: 'session:exit', id, code, reason })
      },
      onStatus: (status, detail) => this.sink({ type: 'session:status', id, status, detail }),
      onPrompt: (prompt) => this.sink({ type: 'session:prompt', id, ...prompt })
    }
  }
}
