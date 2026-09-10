import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

/**
 * OpenSSH known_hosts handling, mirroring wezterm-ssh/src/host.rs (ssh2 backend):
 * TOFU first-connect, SHA256 fingerprints, hashed (`|1|salt|hash`) entries, and
 * un-hashed writes on accept.
 */

export type KnownHostStatus = 'match' | 'mismatch' | 'notfound'

/** hostspec used in known_hosts: `host` for port 22, `[host]:port` otherwise. */
function hostspec(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`
}

/** Parse the first length-prefixed string of an SSH key blob -> the key type. */
export function keyTypeOf(blob: Buffer): string {
  if (blob.length < 4) return 'unknown'
  const len = blob.readUInt32BE(0)
  return blob.subarray(4, 4 + len).toString('utf8')
}

/** OpenSSH-style SHA256 fingerprint (`SHA256:...`). */
export function fingerprint(blob: Buffer): string {
  const hash = crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')
  return `SHA256:${hash}`
}

interface KnownHostEntry {
  marker: string // '' | '@cert-authority' | '@revoked'
  host: string // plain hostspec or `|1|salt|hash`
  keyType: string
  key: string // base64
}

function parseKnownHosts(content: string): KnownHostEntry[] {
  const entries: KnownHostEntry[] = []
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const parts = line.split(/\s+/)
    let idx = 0
    let marker = ''
    if (parts[0].startsWith('@')) {
      marker = parts[0]
      idx = 1
    }
    if (parts.length < idx + 3) continue
    entries.push({ marker, host: parts[idx], keyType: parts[idx + 1], key: parts[idx + 2] })
  }
  return entries
}

/** OpenSSH hostname hashing: `|1|base64(salt)|base64(hmac-sha1(salt, host))`. */
function hashHost(hostname: string, salt: Buffer): Buffer {
  return crypto.createHmac('sha1', salt).update(hostname, 'utf8').digest()
}

function hostMatches(entryHost: string, host: string, port: number): boolean {
  if (entryHost.startsWith('|')) {
    // |1|salt|hash
    const m = /^\|1\|([^|]+)\|([^|]+)$/.exec(entryHost)
    if (!m) return false
    const salt = Buffer.from(m[1], 'base64')
    const expected = Buffer.from(m[2], 'base64')
    const computed = hashHost(hostspec(host, port), salt)
    return crypto.timingSafeEqual(computed, expected)
  }
  return entryHost === hostspec(host, port)
}

/** Check a host key against the given known_hosts files. */
export function checkKnownHost(
  host: string,
  port: number,
  keyBlob: Buffer,
  files: string[]
): KnownHostStatus {
  const blobB64 = keyBlob.toString('base64')
  for (const file of files) {
    let content: string
    try {
      content = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const entry of parseKnownHosts(content)) {
      if (entry.marker || entry.keyType !== keyTypeOf(keyBlob)) continue
      if (!hostMatches(entry.host, host, port)) continue
      if (entry.key === blobB64) return 'match'
      return 'mismatch'
    }
  }
  return 'notfound'
}

/** Append an (un-hashed) known_hosts entry — TOFU first-connect accept. */
export function addKnownHost(host: string, port: number, keyBlob: Buffer, files: string[]): string {
  const line = `${hostspec(host, port)} ${keyTypeOf(keyBlob)} ${keyBlob.toString('base64')}\n`
  const sshDir = path.join(os.homedir(), '.ssh')

  // Prefer an existing user-known-hosts file; otherwise default known_hosts.
  const target = files.find((f) => {
    try {
      fs.accessSync(f, fs.constants.R_OK)
      return true
    } catch {
      return false
    }
  })
  const file = target ?? files[0] ?? path.join(sshDir, 'known_hosts')

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, line, { mode: 0o600 })
  } catch {
    // best-effort: if we cannot persist, still proceed (key already verified)
  }
  return file
}

/** Load default known_hosts files (~/.ssh/known_hosts [+ known_hosts2]). */
export function defaultKnownHostsFiles(): string[] {
  const ssh = path.join(os.homedir(), '.ssh')
  return [path.join(ssh, 'known_hosts'), path.join(ssh, 'known_hosts2')]
}
