
import { useEffect, useRef } from 'react'
import type { ReactElement } from 'react'
import { Terminal } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import { WebglAddon } from 'xterm-addon-webgl'
import { SearchAddon } from 'xterm-addon-search'
import { Unicode11Addon } from 'xterm-addon-unicode11'
import type { PaneRecord } from '../mux-model'
import type { RendererConfig, SessionCreateOpts } from '../types'
import { resolveTheme } from '../theme'

export interface TerminalHandle {
  term: Terminal
  search: SearchAddon
}

export interface TerminalPaneProps {
  pane: PaneRecord
  config: RendererConfig
  /** True when this pane is the focused pane of the active tab. */
  active?: boolean
  registerTerminal: (sessionId: string, handle: TerminalHandle) => void
  unregisterTerminal: (sessionId: string) => void
  onAttach: (paneId: number, sessionId: string, label: string) => void
  onTitle: (paneId: number, title: string) => void
  onCwd: (paneId: number, cwd: string) => void
  onFocus: (paneId: number) => void
  resolvePrompt: (promptId: string, value: string) => void
}

interface ActivePrompt {
  promptId: string
  echo: boolean
  buffer: string
}

/** Guard against loading the WebGL renderer where no GL context exists (it
 * throws asynchronously and breaks rendering). Cached: probing allocates a
 * throwaway context, so only do it once. */
let webglChecked: boolean | null = null
function webglAvailable(): boolean {
  if (webglChecked !== null) return webglChecked
  try {
    const canvas = document.createElement('canvas')
    webglChecked = !!(canvas.getContext('webgl2') || canvas.getContext('webgl'))
  } catch {
    webglChecked = false
  }
  return webglChecked
}

function parseOsc7(data: string): string {
  const s = data.trim()
  if (s.startsWith('file://')) {
    try {
      const u = new URL(s)
      let p = u.pathname
      if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1) // Windows drive path
      return decodeURIComponent(p)
    } catch {
      return s
    }
  }
  return s
}

export function TerminalPane(props: TerminalPaneProps): ReactElement {
  const { pane, config, onFocus } = props
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const promptRef = useRef<ActivePrompt | null>(null)

  // Create the xterm instance and (lazily) the backing session, once per pane.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const colors = resolveTheme(config)

    const term = new Terminal({
      allowProposedApi: true,
      fontFamily: config.font.family || (navigator.platform.includes('Win') ? 'Cascadia Mono, Consolas, monospace' : '"Cascadia Mono", "JetBrains Mono", "Fira Code", Menlo, monospace'),
      fontSize: config.font.size,
      lineHeight: config.font.lineHeight,
      scrollback: config.scrollback,
      cursorBlink: true,
      cursorStyle: 'bar',
      theme: colors,
      macOptionIsMeta: true,
      allowTransparency: true,
      fontWeight: '400'
    })
    const fit = new FitAddon()
    const search = new SearchAddon()
    const unicode = new Unicode11Addon()
    term.loadAddon(fit)
    term.loadAddon(search)
    term.loadAddon(unicode)
    term.unicode.activeVersion = '11'
    try {
      if (webglAvailable()) {
        const webgl = new WebglAddon()
        webgl.onContextLoss(() => webgl.dispose())
        term.loadAddon(webgl)
      }
    } catch {
      /* WebGL unavailable -> DOM renderer fallback */
    }

    term.open(container)
    try {
      fit.fit()
    } catch {
      /* layout not ready yet */
    }
    termRef.current = term

    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        /* ignore */
      }
      const sid = sessionIdRef.current
      if (sid) void window.api.sessions.resize(sid, term.cols, term.rows)
    })
    ro.observe(container)

    term.onData((data: string) => {
      const prompt = promptRef.current
      if (prompt) {
        // Clear the prompt immediately once answered so the next keystrokes go
        // to the session (the effect below also clears it defensively).
        if (handlePromptKey(term, prompt, data, (pid, value) => props.resolvePrompt(pid, value))) {
          promptRef.current = null
        }
      } else {
        const sid = sessionIdRef.current
        if (sid) void window.api.sessions.write(sid, data)
      }
    })

    term.onTitleChange((title: string) => {
      props.onTitle(pane.id, title)
    })

    try {
      term.parser.registerOscHandler(7, (d: string) => {
        props.onCwd(pane.id, parseOsc7(d))
        return true
      })
    } catch {
      /* older xterm */
    }

    let cancelled = false
    if (!pane.sessionId && pane.pendingCreate) {
      const pc = pane.pendingCreate
      const createOpts: SessionCreateOpts =
        pc.kind === 'local'
          ? { kind: 'local', cwd: pc.cwd, cols: term.cols, rows: term.rows }
          : {
              kind: 'ssh',
              target: pc.target ?? '',
              user: pc.user,
              port: pc.port,
              identity: pc.identity,
              password: pc.password,
              cols: term.cols,
              rows: term.rows
            }
      void window.api.sessions
        .create(createOpts)
        .then((res) => {
          if (cancelled) {
            void window.api.sessions.destroy(res.id)
            return
          }
          sessionIdRef.current = res.id
          props.registerTerminal(res.id, { term, search })
          props.onAttach(pane.id, res.id, res.label)
        })
        .catch((err: unknown) => {
          term.write(`\r\nFailed to create session: ${String(err)}\r\n`)
        })
    }

    return () => {
      cancelled = true
      ro.disconnect()
      const sid = sessionIdRef.current
      if (sid) {
        props.unregisterTerminal(sid)
        void window.api.sessions.destroy(sid)
      }
      term.dispose()
      termRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.id])

  // Enter prompt mode when the session asks a question (wezterm LineEditor analog).
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    if (!pane.prompt) {
      promptRef.current = null
      return
    }
    term.write(pane.prompt.text)
    promptRef.current = { promptId: pane.prompt.promptId, echo: pane.prompt.echo, buffer: '' }
  }, [pane.prompt])

  useEffect(() => {
    if (props.active) termRef.current?.focus()
  }, [pane.sessionId, props.active])

  return (
    <div
      className="terminal-pane"
      ref={containerRef}
      onMouseDown={(e) => {
        onFocus(pane.id)
        // middle-click paste, right-click paste (wezterm/Windows Terminal style)
        if (e.button === 1 || e.button === 2) {
          e.preventDefault()
          void window.navigator.clipboard.readText().then((t) => {
            const sid = sessionIdRef.current
            if (sid && t) void window.api.sessions.write(sid, t)
          })
        }
      }}
    />
  )
}

function handlePromptKey(
  term: Terminal,
  prompt: ActivePrompt,
  data: string,
  resolve: (promptId: string, value: string) => void
): boolean {
  for (const ch of data) {
    if (ch === '\r' || ch === '\n') {
      term.write('\r\n')
      const value = prompt.buffer
      const pid = prompt.promptId
      prompt.buffer = ''
      resolve(pid, value)
      return true
    }
    if (ch === '\x7f' || ch === '\b') {
      if (prompt.buffer.length > 0) {
        prompt.buffer = prompt.buffer.slice(0, -1)
        if (prompt.echo) term.write('\b \b')
      }
      continue
    }
    if (ch === '\x03') {
      // Ctrl+C cancels the prompt
      term.write('^C\r\n')
      const pid = prompt.promptId
      prompt.buffer = ''
      resolve(pid, '')
      return true
    }
    if (ch === '\x15') {
      // Ctrl+U clears the line
      if (prompt.echo && prompt.buffer.length > 0) term.write('\b \b'.repeat(prompt.buffer.length))
      prompt.buffer = ''
      continue
    }
    const code = ch.charCodeAt(0)
    if (code < 0x20 || code === 0x7f) continue // ignore other control characters
    prompt.buffer += ch
    if (prompt.echo) term.write(ch)
  }
  return false
}
