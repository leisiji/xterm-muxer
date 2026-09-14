import { randomUUID } from 'crypto'
import type { Channel } from 'ssh2'
import type { OpenedChannel, SshConnection, SshConnectionClient } from './ssh-connection'
import type { Session, SessionEvents, SessionKind, SessionStatus } from './session'
import type { SshCreateOptions } from './session'

/**
 * An SSH remote-shell session built on a shared {@link SshConnection},
 * mirroring wezterm's `wezterm ssh` (RemoteSshDomain + wezterm-ssh): the first
 * pane authenticates once, and every subsequent split/tab opens another shell
 * channel over that same transport, so no password is asked again.
 *
 * The inline banner, TOFU host-key verification and interactive auth are all
 * rendered into the terminal via prompts.
 */
export class SshSession implements Session, SshConnectionClient {
  readonly id: string
  readonly kind: SessionKind = 'ssh'
  readonly label: string
  private stream: Channel | null = null
  private size: { cols: number; rows: number }
  private prompts = new Map<string, (v: string) => void>()
  private dead = false
  /** Directory to land in, inherited from the pane this one was spawned from. */
  private cwd?: string

  constructor(
    id: string,
    opts: SshCreateOptions,
    private events: SessionEvents,
    private connection: SshConnection
  ) {
    this.id = id
    this.size = { cols: opts.cols, rows: opts.rows }
    this.label = connection.label
    this.cwd = opts.cwd
  }

  /** Open this pane's remote shell channel on the shared transport. */
  start(): void {
    void this.openChannel()
  }

  write(data: string): void {
    if (this.stream && !this.dead) {
      try {
        this.stream.write(data)
      } catch {
        /* closed */
      }
    }
  }

  resize(cols: number, rows: number): void {
    this.size = { cols, rows }
    if (this.stream && !this.dead) {
      try {
        this.stream.setWindow(rows, cols, 0, 0)
      } catch {
        /* closed */
      }
    }
  }

  kill(): void {
    this.dead = true
    try {
      this.stream?.close()
    } catch {
      /* ignore */
    }
    this.connection.detach(this)
  }

  answerPrompt(promptId: string, value: string): void {
    const resolve = this.prompts.get(promptId)
    if (resolve) {
      this.prompts.delete(promptId)
      resolve(value)
    }
  }

  // ---- SshConnectionClient: events from the shared transport ----

  connectionStatus(status: SessionStatus, detail?: string): void {
    this.events.onStatus(status, detail)
  }

  connectionOutput(data: string): void {
    this.events.onOutput(data)
  }

  connectionPrompt(text: string, echo: boolean): Promise<string> {
    return this.ask(text, echo)
  }

  connectionLost(err: Error): void {
    if (this.dead) return
    this.dead = true
    this.events.onExit(null, err.message)
  }

  private async openChannel(): Promise<void> {
    let opened: OpenedChannel
    try {
      // Hand over the size as a getter: the channel opens after authentication,
      // and until then this pane's terminal may have been fitted to a different
      // box (a split is laid out and re-fitted while the transport is still
      // dialling). The copy is what the pty request ends up carrying.
      opened = await this.connection.openChannel(() => ({ cols: this.size.cols, rows: this.size.rows }), this.cwd)
    } catch (err) {
      // A dead transport already reported itself via connectionLost(); a live
      // one that refused the channel surfaces the error here.
      if (!this.dead) this.connectionLost(err instanceof Error ? err : new Error(String(err)))
      return
    }
    const stream = opened.stream
    if (this.dead) {
      try {
        stream.close()
      } catch {
        /* ignore */
      }
      return
    }
    this.stream = stream
    // A resize that landed while the request was in flight only updated
    // `this.size` -- there was no stream to forward it to yet -- so the pty was
    // created at the older size. Forward it now, otherwise a full-screen program
    // starting in this pane draws for a terminal it does not have until the next
    // unrelated resize comes along. (A `window-change` carries the right size in
    // that case, which is what makes a redraw fix the layout.)
    if (opened.size.cols !== this.size.cols || opened.size.rows !== this.size.rows) {
      this.resize(this.size.cols, this.size.rows)
    }
    stream.on('data', (d: Buffer) => {
      if (!this.dead) this.events.onOutput(d.toString('utf8'))
    })
    stream.on('close', () => {
      if (this.dead) return
      this.dead = true
      this.events.onExit(0)
    })
    stream.on('error', (e: Error) => this.connectionLost(e))
  }

  private async ask(text: string, echo: boolean): Promise<string> {
    const promptId = randomUUID()
    return new Promise<string>((resolve) => {
      this.prompts.set(promptId, resolve)
      this.events.onPrompt({ promptId, text, echo })
    })
  }
}
