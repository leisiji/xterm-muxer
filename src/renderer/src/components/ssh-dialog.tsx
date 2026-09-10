
import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'

export interface SshDialogProps {
  open: boolean
  hosts: string[]
  onCancel: () => void
  onConnect: (target: string, identity?: string, password?: string) => void
}

export function SshDialog(props: SshDialogProps): ReactElement | null {
  const [host, setHost] = useState('')
  const [user, setUser] = useState('')
  const [port, setPort] = useState('')
  const [identity, setIdentity] = useState('')
  const [password, setPassword] = useState('')
  const hostRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (props.open) {
      hostRef.current?.focus()
    }
  }, [props.open])

  if (!props.open) return null

  const connect = (): void => {
    const h = host.trim()
    if (!h) return
    let target = h
    const u = user.trim()
    const p = port.trim()
    if (p) {
      const hostPart = h.includes(':') ? `[${h}]` : h
      target = `${u ? `${u}@` : ''}${hostPart}:${p}`
    } else if (u) {
      target = `${u}@${h}`
    }
    props.onConnect(target, identity.trim() || undefined, password || undefined)
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && props.onCancel()}>
      <div className="modal" onKeyDown={(e) => e.key === 'Enter' && connect()}>
        <h2>New SSH Connection</h2>

        <label className="field">
          <span>Host</span>
          <input
            ref={hostRef}
            value={host}
            placeholder="user@host or host[:port] or ~/.ssh/config alias"
            list="ssh-hosts-list"
            onChange={(e) => setHost(e.target.value)}
          />
          <datalist id="ssh-hosts-list">
            {props.hosts.map((h) => (
              <option key={h} value={h} />
            ))}
          </datalist>
        </label>

        <label className="field">
          <span>User (optional)</span>
          <input value={user} placeholder="resolved via ssh_config if blank" onChange={(e) => setUser(e.target.value)} />
        </label>

        <label className="field">
          <span>Port (optional)</span>
          <input value={port} placeholder="22" onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} />
        </label>

        <label className="field">
          <span>Identity file (optional)</span>
          <input value={identity} placeholder="~/.ssh/id_ed25519" onChange={(e) => setIdentity(e.target.value)} />
        </label>

        <label className="field">
          <span>Password (optional)</span>
          <input type="password" value={password} placeholder="leave blank to prompt" onChange={(e) => setPassword(e.target.value)} />
        </label>

        <div className="modal-actions">
          <button onClick={props.onCancel}>Cancel</button>
          <button className="primary" onClick={connect} disabled={!host.trim()}>
            Connect
          </button>
        </div>
      </div>
    </div>
  )
}
