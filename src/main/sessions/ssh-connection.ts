import { Client } from 'ssh2'
import type { Channel, ConnectConfig, PseudoTtyOptions } from 'ssh2'
import { parseTarget, resolveSshConfig } from './ssh-config'
import type { ResolvedSshConfig } from './ssh-config'
import { addKnownHost, checkKnownHost, defaultKnownHostsFiles, fingerprint, keyTypeOf } from './known-hosts'
import { createAuthHandler } from './ssh-auth'
import type { SessionStatus } from './session'

/**
 * One remote-shell pane's view of a shared SSH transport. Every call is routed
 * back to the owning SshSession so prompts/output land in the right terminal.
 */
export interface SshConnectionClient {
  /** A status change on the shared transport (connecting/authenticating/connected/error). */
  connectionStatus(status: SessionStatus, detail?: string): void
  /** Banner / diagnostic output for this pane. */
  connectionOutput(data: string): void
  /** Inline prompt (host-key TOFU, password, passphrase) answered in this pane. */
  connectionPrompt(text: string, echo: boolean): Promise<string>
  /** The shared transport failed or dropped; this pane is over. */
  connectionLost(err: Error): void
}

export interface SshConnectionInit {
  target: string
  user?: string
  port?: number
  identity?: string
  password?: string
}

type ConnectionState = 'connecting' | 'ready' | 'dead'

/**
 * A single multiplexed SSH transport shared by every pane/tab targeting the
 * same host. This is the analogue of wezterm's `RemoteSshDomain`
 * (`mux/src/ssh.rs`), which keeps one `Session` and opens an additional PTY
 * channel per `spawn_pane`: authenticating once means a split or new tab never
 * re-prompts for the password / re-verifies the host key.
 */
export class SshConnection {
  readonly key: string
  readonly label: string
  private readonly cfg: ResolvedSshConfig
  private readonly client = new Client()
  private readonly password?: string
  private readonly clients = new Set<SshConnectionClient>()
  private readyWaiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = []
  private state: ConnectionState = 'connecting'
  private failure: Error | null = null

  constructor(init: SshConnectionInit, private readonly onClosed?: () => void) {
    const target = parseTarget(init.target)
    this.cfg = resolveSshConfig(target.host, init.user ?? target.user, init.port ?? target.port, init.identity)
    const user = init.user ?? target.user ?? this.cfg.user
    this.label = `${user}@${this.cfg.host}${this.cfg.port !== 22 ? `:${this.cfg.port}` : ''}`
    this.key = sshConnectionKey(this.cfg)
    this.password = init.password
  }

  isAlive(): boolean {
    return this.state !== 'dead'
  }

  attach(client: SshConnectionClient): void {
    this.clients.add(client)
    // A pane joining an already-authenticated transport is immediately connected;
    // without this the renderer would treat a later drop as a failed connect.
    if (this.state === 'ready') client.connectionStatus('connected')
    else if (this.state === 'dead') client.connectionStatus('error', this.failure?.message)
  }

  detach(client: SshConnectionClient): void {
    this.clients.delete(client)
  }

  connect(): void {
    const c = this.cfg
    this.promptTarget().connectionOutput(`\r\nUsing ssh2 to connect to ${c.user}@${c.host}:${c.port}\r\n`)
    this.emitStatus('connecting')

    this.client.on('ready', () => {
      if (this.state === 'dead') return
      this.state = 'ready'
      this.emitStatus('connected')
      for (const w of this.readyWaiters) w.resolve()
      this.readyWaiters = []
    })
    this.client.on('error', (err) => this.fail(err))
    this.client.on('close', () => {
      if (this.state !== 'dead') this.fail(new Error('connection closed'))
    })
    this.client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
      void this.onKeyboardInteractive(prompts, finish)
    })

    const agent = c.identityAgent ?? process.env.SSH_AUTH_SOCK
    const connectConfig: ConnectConfig = {
      host: c.host,
      port: c.port,
      username: c.user,
      readyTimeout: c.connectTimeout * 1000,
      keepaliveInterval: c.serverAliveInterval > 0 ? c.serverAliveInterval * 1000 : 0,
      keepaliveCountMax: c.serverAliveCountMax,
      tryKeyboard: true,
      agent,
      hostVerifier: (key: Buffer, cb: (valid: boolean) => void) => {
        void this.verifyHostKey(key, cb)
      },
      authHandler: createAuthHandler({
        host: c.host,
        port: c.port,
        user: c.user,
        identityFiles: c.identityFiles,
        identitiesOnly: c.identitiesOnly,
        agent,
        password: this.password,
        ask: (text, echo) => this.promptTarget().connectionPrompt(text, echo),
        interactive: (name, instructions, lang, prompts, finish) =>
          this.client.emit('keyboard-interactive', name, instructions, lang, prompts, finish),
        log: (m) => this.promptTarget().connectionOutput(`\r\n${m}\r\n`)
      })
    }
    this.client.connect(connectConfig)
  }

  /**
   * Wait until authenticated, then open a fresh remote shell channel, landing in
   * `cwd` when the spawning pane had one (it comes from the remote's own OSC 7,
   * so it is a path on the far side).
   *
   * The landing directory is applied by an exec wrapper rather than by typing
   * `cd` at the prompt (wezterm-ssh does the same for its ssh domain): the `cd`
   * happens in a throwaway non-interactive process, so neither the command nor a
   * shell-history entry ever reaches the pane. A server that refuses the exec
   * request falls back to a plain shell channel with the `cd` typed in.
   *
   * No `cwd` means this is byte-for-byte the plain `ssh host` path.
   */
  async openChannel(size: { cols: number; rows: number }, cwd?: string): Promise<Channel> {
    await this.ready()
    if (cwd) {
      try {
        return await this.openExec(remoteShellCommand(cwd), size)
      } catch {
        // Exec refused (restricted server): a plain shell still works, the `cd`
        // just becomes visible as a line of typed input.
      }
    }
    const stream = await this.openShell(size)
    if (cwd) writeInto(stream, [`cd -- ${shQuote(cwd)} 2>/dev/null`])
    return stream
  }

  /** Open a PTY-backed channel running `command` (an exec request). */
  private openExec(command: string, size: { cols: number; rows: number }): Promise<Channel> {
    return new Promise<Channel>((resolve, reject) => {
      this.client.exec(command, { env: TERM_ENV, pty: ptyOptions(size) }, (err, stream) => {
        if (err) reject(err)
        else resolve(stream)
      })
    })
  }

  /** Open a PTY-backed login shell channel (what `ssh host` gives you). */
  private openShell(size: { cols: number; rows: number }): Promise<Channel> {
    return new Promise<Channel>((resolve, reject) => {
      this.client.shell(ptyOptions(size), { env: TERM_ENV }, (err, stream) => {
        if (err) reject(err)
        else resolve(stream)
      })
    })
  }

  /** Tear the transport down (app shutdown). */
  close(): void {
    if (this.state === 'dead') return
    this.state = 'dead'
    try {
      this.client.end()
    } catch {
      /* ignore */
    }
    this.onClosed?.()
  }

  private ready(): Promise<void> {
    if (this.state === 'ready') return Promise.resolve()
    if (this.state === 'dead') return Promise.reject(this.failure ?? new Error('connection closed'))
    return new Promise<void>((resolve, reject) => {
      this.readyWaiters.push({ resolve, reject })
    })
  }

  private fail(err: Error): void {
    if (this.state === 'dead') return
    this.state = 'dead'
    this.failure = err
    this.emitStatus('error', err.message)
    for (const w of this.readyWaiters) w.reject(err)
    this.readyWaiters = []
    for (const client of [...this.clients]) client.connectionLost(err)
    try {
      this.client.end()
    } catch {
      /* ignore */
    }
    this.onClosed?.()
  }

  private emitStatus(status: SessionStatus, detail?: string): void {
    for (const client of [...this.clients]) client.connectionStatus(status, detail)
  }

  /** The pane that owns authentication prompts: the first attached session. */
  private promptTarget(): SshConnectionClient {
    const first = this.clients.values().next()
    if (first.done) {
      // Should never happen (a connection is only connected while attached), but
      // keep prompts from throwing if the originating pane vanished.
      throw new Error('no client attached to SSH connection')
    }
    return first.value
  }

  private async verifyHostKey(key: Buffer, cb: (ok: boolean) => void): Promise<void> {
    const c = this.cfg
    const files = c.knownHostsFiles.length ? c.knownHostsFiles : defaultKnownHostsFiles()
    const status = checkKnownHost(c.host, c.port, key, files)
    if (status === 'match') {
      cb(true)
      return
    }
    if (status === 'mismatch') {
      this.promptTarget().connectionOutput('\r\n' + hostKeyChangedBanner(c.host))
      cb(false)
      return
    }
    // not found: TOFU first-connect prompt (mirrors wezterm HostVerify + ssh hostkey prompt)
    this.emitStatus('authenticating')
    const fp = fingerprint(key)
    const ans = await this.promptTarget().connectionPrompt(
      `The authenticity of host '${c.host}:${c.port}' can't be established.\r\n` +
        `${keyTypeOf(key)} key fingerprint is ${fp}.\r\n` +
        `Are you sure you want to continue connecting (yes/no)? `,
      true
    )
    if (ans === 'yes' || ans === 'y') {
      addKnownHost(c.host, c.port, key, files)
      cb(true)
    } else {
      this.promptTarget().connectionOutput('\r\nHost key verification failed.\r\n')
      cb(false)
    }
  }

  private async onKeyboardInteractive(
    prompts: Array<{ prompt: string; echo?: boolean }>,
    finish: (answers: string[]) => void
  ): Promise<void> {
    this.emitStatus('authenticating')
    const answers: string[] = []
    let preset = this.password
    for (const p of prompts) {
      // Use the password supplied in the connection dialog for a password-looking
      // prompt instead of asking again.
      if (preset && /password/i.test(p.prompt)) {
        answers.push(preset)
        preset = undefined
        continue
      }
      answers.push(await this.promptTarget().connectionPrompt(p.prompt, p.echo !== false))
    }
    finish(answers)
  }
}

/** Stable identity for connection reuse: same user/host/port/keys => same transport. */
export function sshConnectionKey(cfg: ResolvedSshConfig): string {
  return `${cfg.user}@${cfg.host}:${cfg.port}|${cfg.identityFiles.join(',')}`
}

/**
 * Env requests sent with every channel. TERM_PROGRAM is best-effort: sshd only
 * applies it when the remote ssh_config accepts the name (OpenSSH's AcceptEnv
 * defaults to LANG/LC_*), and a refusal is silently ignored. When it does land,
 * a remote yazi picks IIP instead of falling back to chafa, and the size
 * reports the image addon answers round-trip back over the same channel.
 */
const TERM_ENV = { TERM_PROGRAM: 'vscode' }

function ptyOptions(size: { cols: number; rows: number }): PseudoTtyOptions {
  return { cols: size.cols, rows: size.rows, term: 'xterm-256color' }
}

/** POSIX single-quoting: wrap in '...' and turn each embedded ' into '\''. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

/**
 * The command an exec channel runs to land the pane in `cwd` and hand the pty
 * over to a login shell. `-l` reproduces what sshd does for a plain shell
 * request -- a login shell, so /etc/profile and ~/.bash_profile still run -- and
 * `$SHELL`, which sshd sets for the session, is the shell to reproduce it in.
 * A `cwd` that no longer exists quietly leaves the shell in the login directory.
 */
function remoteShellCommand(cwd: string): string {
  return `cd -- ${shQuote(cwd)} 2>/dev/null; exec "\${SHELL:-/bin/sh}" -l`
}

/** Type lines into a freshly opened channel (used by the exec-less fallback). */
function writeInto(stream: Channel, lines: string[]): void {
  if (lines.length === 0) return
  try {
    stream.write(lines.join('\r') + '\r')
  } catch {
    /* channel already gone */
  }
}

function hostKeyChangedBanner(host: string): string {
  return (
    '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\r\n' +
    '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!                    @\r\n' +
    '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\r\n' +
    'IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!\r\n' +
    'Someone could be eavesdropping on you right now (man-in-the-middle attack)!\r\n' +
    'The fingerprint for the ' +
    `${host} key sent by the remote host differs from what is recorded in known_hosts.\r\n`
  )
}
