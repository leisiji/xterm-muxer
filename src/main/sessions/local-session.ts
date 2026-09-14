import * as path from 'path'
import * as pty from 'node-pty'
import { LocalCreateOptions, Session, SessionEvents, SessionKind } from './session'

/** Default shell, mirroring wezterm: Windows -> %ComSpec% (cmd.exe), Unix -> $SHELL. */
export function defaultShell(): string {
  if (process.platform === 'win32') {
    return process.env.ComSpec || 'cmd.exe'
  }
  return process.env.SHELL || '/bin/bash'
}

/** Resolve the basename used as the fallback tab title (mirrors wezterm process-basename fallback). */
function basenameLabel(shell: string): string {
  const b = path.basename(shell)
  return b.endsWith('.exe') ? b.slice(0, -4) : b
}

/**
 * A local shell session backed by a node-pty (ConPTY on Windows, like wezterm's ConPtySystem).
 */
export class LocalSession implements Session {
  readonly id: string
  readonly kind: SessionKind = 'local'
  readonly label: string
  private proc: pty.IPty

  constructor(id: string, opts: LocalCreateOptions, events: SessionEvents) {
    this.id = id
    const shell = opts.shell ?? defaultShell()
    const args = opts.args ?? []
    this.label = basenameLabel(shell)

    this.proc = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        XTERM_MUXER: '1',
        // Programs pick an image protocol off TERM_PROGRAM, and the renderer
        // carries @xterm/addon-image (iTerm IIP + SIXEL). VSCode's terminal is
        // xterm.js with the same addon, so its label is the honest one to claim
        // -- and the only label yazi maps to IIP. Without it yazi falls back to
        // chafa, which draws no real image.
        TERM_PROGRAM: 'vscode',
        ...opts.env
      },
      encoding: 'utf8'
    })

    this.proc.onData((data: string) => events.onOutput(data))
    this.proc.onExit(({ exitCode, signal }) => {
      events.onExit(exitCode ?? null, signal ? `terminated by signal ${signal}` : undefined)
    })
    // A spawned pty is immediately usable; signals the pane as "established" so
    // exit handling treats it like a connected session.
    events.onStatus('connected')
  }

  write(data: string): void {
    try {
      this.proc.write(data)
    } catch {
      /* pty already closed */
    }
  }

  resize(cols: number, rows: number): void {
    try {
      this.proc.resize(cols, rows)
    } catch {
      /* pty already closed */
    }
  }

  kill(): void {
    try {
      this.proc.kill()
    } catch {
      /* already dead */
    }
  }
}
