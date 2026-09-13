import { randomUUID } from 'crypto'
import { LocalSession } from './local-session'
import { SshSession } from './ssh-session'
import { SshConnection, sshConnectionKey } from './ssh-connection'
import { resolveSshConfig, parseTarget } from './ssh-config'
import { Session, SessionEvents } from './session'
import type { LocalCreateOptions, SshCreateOptions } from './session'

export type RendererSink = (payload: unknown) => void

/**
 * The multiplexer: owns every session and routes data to the renderer.
 * Mirrors wezterm's Mux for the local-only (no remote connect) subset.
 *
 * SSH transports are pooled by target (wezterm's RemoteSshDomain keeps one
 * authenticated `Session` and opens a channel per pane), so splitting or
 * opening a tab never re-prompts for a password.
 */
export class SessionManager {
  private sessions = new Map<string, Session>()
  private sshConnections = new Map<string, SshConnection>()

  constructor(private sink: RendererSink) {}

  createLocal(opts: LocalCreateOptions): Session {
    const id = randomUUID()
    const session = new LocalSession(id, opts, this.eventsFor(id))
    this.sessions.set(id, session)
    return session
  }

  createSsh(opts: SshCreateOptions): Session {
    const id = randomUUID()
    const { connection, created } = this.acquireConnection(opts)
    const session = new SshSession(id, opts, this.eventsFor(id), connection)
    this.sessions.set(id, session)
    connection.attach(session)
    if (created) connection.connect()
    session.start()
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
    for (const c of [...this.sshConnections.values()]) {
      try {
        c.close()
      } catch {
        /* ignore */
      }
    }
    this.sshConnections.clear()
  }

  answerPrompt(promptId: string, value: string): void {
    for (const s of this.sessions.values()) {
      if (s.answerPrompt) {
        s.answerPrompt(promptId, value)
      }
    }
  }

  /** Reuse the live transport for this target, or dial a new one (wezterm spawn_pane). */
  private acquireConnection(opts: SshCreateOptions): { connection: SshConnection; created: boolean } {
    const target = parseTarget(opts.target)
    const cfg = resolveSshConfig(target.host, opts.user ?? target.user, opts.port ?? target.port, opts.identity)
    const key = sshConnectionKey(cfg)

    const existing = this.sshConnections.get(key)
    if (existing && existing.isAlive()) return { connection: existing, created: false }
    this.sshConnections.delete(key)

    const connection: SshConnection = new SshConnection(opts, () => {
      if (this.sshConnections.get(key) === connection) this.sshConnections.delete(key)
    })
    this.sshConnections.set(key, connection)
    return { connection, created: true }
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
