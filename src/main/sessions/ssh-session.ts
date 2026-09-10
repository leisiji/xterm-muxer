import { randomUUID } from 'crypto'
import { Client } from 'ssh2'
import type { ConnectConfig, Channel } from 'ssh2'
import { parseTarget, resolveSshConfig } from './ssh-config'
import type { ResolvedSshConfig } from './ssh-config'
import { addKnownHost, checkKnownHost, defaultKnownHostsFiles, fingerprint, keyTypeOf } from './known-hosts'
import { createAuthHandler } from './ssh-auth'
import type { Session, SessionEvents, SessionKind } from './session'
import type { SshCreateOptions } from './session'

/**
 * An SSH remote-shell session built on ssh2, mirroring the behaviour of
 * wezterm's `wezterm ssh` (RemoteSshDomain + wezterm-ssh): an inline banner,
 * TOFU host-key verification and interactive auth all rendered into the
 * terminal itself via prompts.
 */
export class SshSession implements Session {
  readonly id: string
  readonly kind: SessionKind = 'ssh'
  readonly label: string
  private client: Client
  private stream: Channel | null = null
  private size: { cols: number; rows: number }
  private cfg: ResolvedSshConfig
  private prompts = new Map<string, (v: string) => void>()
  private dead = false
  private initialPassword?: string

  constructor(
    id: string,
    opts: SshCreateOptions,
    private events: SessionEvents
  ) {
    this.id = id
    this.size = { cols: opts.cols, rows: opts.rows }
    this.initialPassword = opts.password
    const target = parseTarget(opts.target)
    const cfg = resolveSshConfig(target.host, opts.user ?? target.user, opts.port ?? target.port, opts.identity)
    this.cfg = cfg
    const user = opts.user ?? target.user ?? cfg.user
    this.label = `${user}@${cfg.host}${cfg.port !== 22 ? `:${cfg.port}` : ''}`
    this.client = new Client()
  }

  connect(): void {
    const c = this.cfg
    this.events.onOutput(`\r\nUsing ssh2 to connect to ${c.user}@${c.host}:${c.port}\r\n`)
    this.events.onStatus('connecting')

    this.client.on('ready', () => this.onReady())
    this.client.on('error', (err) => this.onError(err))
    this.client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
      this.onKeyboardInteractive(prompts, finish)
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
        password: this.initialPassword,
        ask: (text, echo) => this.ask(text, echo),
        interactive: (name, instructions, lang, prompts, finish) =>
          this.client.emit('keyboard-interactive', name, instructions, lang, prompts, finish),
        log: (m) => this.events.onOutput(`\r\n${m}\r\n`)
      })
    }
    this.client.connect(connectConfig)
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
    try {
      this.client.end()
    } catch {
      /* ignore */
    }
  }

  answerPrompt(promptId: string, value: string): void {
    const resolve = this.prompts.get(promptId)
    if (resolve) {
      this.prompts.delete(promptId)
      resolve(value)
    }
  }

  private onReady(): void {
    this.events.onStatus('connected')
    this.client.shell(
      { cols: this.size.cols, rows: this.size.rows, term: 'xterm-256color' },
      (err, stream) => {
        if (err) return this.onError(err)
        this.stream = stream
        stream.on('data', (d: Buffer) => {
          if (!this.dead) this.events.onOutput(d.toString('utf8'))
        })
        stream.on('close', () => {
          if (this.dead) return
          this.dead = true
          this.events.onExit(0)
        })
        stream.on('error', (e: Error) => this.onError(e))
      }
    )
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
      this.writeHostKeyChanged()
      cb(false)
      return
    }
    // not found: TOFU first-connect prompt (mirrors wezterm HostVerify + ssh hostkey prompt)
    this.events.onStatus('authenticating')
    const fp = fingerprint(key)
    const ans = await this.ask(
      `The authenticity of host '${c.host}:${c.port}' can't be established.\r\n` +
        `${keyTypeOf(key)} key fingerprint is ${fp}.\r\n` +
        `Are you sure you want to continue connecting (yes/no)? `,
      true
    )
    if (ans === 'yes' || ans === 'y') {
      addKnownHost(c.host, c.port, key, files)
      cb(true)
    } else {
      this.events.onOutput('\r\nHost key verification failed.\r\n')
      cb(false)
    }
  }

  private writeHostKeyChanged(): void {
    const banner =
      '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\r\n' +
      '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!                    @\r\n' +
      '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\r\n' +
      'IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!\r\n' +
      'Someone could be eavesdropping on you right now (man-in-the-middle attack)!\r\n' +
      'The fingerprint for the ' +
      `${this.cfg.host} key sent by the remote host differs from what is recorded in known_hosts.\r\n`
    this.events.onOutput('\r\n' + banner)
  }

  private async onKeyboardInteractive(
    prompts: Array<{ prompt: string; echo?: boolean }>,
    finish: (answers: string[]) => void
  ): Promise<void> {
    this.events.onStatus('authenticating')
    const answers: string[] = []
    let preset = this.initialPassword
    this.initialPassword = undefined
    for (const p of prompts) {
      // Use the password supplied in the connection dialog for a password-looking
      // prompt instead of asking again.
      if (preset && /password/i.test(p.prompt)) {
        answers.push(preset)
        preset = undefined
        continue
      }
      answers.push(await this.ask(p.prompt, p.echo !== false))
    }
    finish(answers)
  }

  private async ask(text: string, echo: boolean): Promise<string> {
    const promptId = randomUUID()
    return new Promise<string>((resolve) => {
      this.prompts.set(promptId, resolve)
      this.events.onPrompt({ promptId, text, echo })
    })
  }

  private onError(err: Error): void {
    if (this.dead) return
    this.dead = true
    this.events.onStatus('error', err.message)
    this.events.onOutput(`\r\nError: ${err.message}\r\n`)
    this.events.onExit(null, err.message)
    try {
      this.client.end()
    } catch {
      /* ignore */
    }
  }
}
