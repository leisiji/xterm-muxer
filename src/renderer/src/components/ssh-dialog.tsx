import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { SavedSshHost, SavedSshHostInput } from '../types'

export interface SshDialogProps {
  open: boolean
  hosts: string[]
  savedHosts: SavedSshHost[]
  onCancel: () => void
  onConnect: (target: string, identity?: string, password?: string) => void
  onSave: (host: SavedSshHostInput) => void
  onDelete: (id: string) => void
}

export function SshDialog(props: SshDialogProps): ReactElement | null {
  const [host, setHost] = useState('')
  const [user, setUser] = useState('')
  const [port, setPort] = useState('')
  const [identity, setIdentity] = useState('')
  const [password, setPassword] = useState('')
  const [save, setSave] = useState(false)
  const [name, setName] = useState('')
  const hostRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (props.open) {
      hostRef.current?.focus()
    } else {
      // Reset transient form state whenever the dialog is dismissed.
      setSave(false)
      setName('')
      setPassword('')
    }
  }, [props.open])

  if (!props.open) return null

  const applySaved = (h: SavedSshHost): void => {
    setHost(h.host)
    setUser(h.user ?? '')
    setPort(h.port ? String(h.port) : '')
    setIdentity(h.identity ?? '')
    setSave(false)
  }

  const connect = (): void => {
    const h = host.trim()
    if (!h) return
    if (save) {
      props.onSave({
        name: name.trim() || (user.trim() ? `${user.trim()}@${h}` : h),
        host: h,
        user: user.trim() || undefined,
        port: Number(port.trim()) || undefined,
        identity: identity.trim() || undefined
      })
    }
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

        {props.savedHosts.length > 0 && (
          <div className="saved-hosts">
            <span className="saved-hosts-label">Saved</span>
            <ul className="saved-hosts-list">
              {props.savedHosts.map((h) => (
                <li key={h.id} className="saved-host">
                  <button
                    type="button"
                    className="saved-host-main"
                    title={`${h.user ? `${h.user}@` : ''}${h.host}${h.port ? `:${h.port}` : ''}`}
                    onClick={() => applySaved(h)}
                  >
                    <span className="saved-host-name">{h.name}</span>
                    <span className="saved-host-target">
                      {h.user ? `${h.user}@` : ''}
                      {h.host}
                      {h.port ? `:${h.port}` : ''}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="saved-host-delete"
                    title="Delete saved connection"
                    onClick={() => props.onDelete(h.id)}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

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

        <label className="checkbox-field">
          <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} />
          <span>Save this connection</span>
        </label>

        {save && (
          <label className="field">
            <span>Name</span>
            <input
              value={name}
              placeholder={user.trim() || host.trim() ? `${user.trim() ? `${user.trim()}@` : ''}${host.trim()}` : 'myserver'}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
        )}

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
