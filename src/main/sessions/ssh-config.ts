import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as crypto from 'crypto'

/**
 * A minimal ssh_config(5) parser modelled on wezterm-ssh/src/config.rs.
 * Semantics mirrored: Host wildcards (`*`, `?`, `!`) with first-match-wins for
 * scalars, IdentityFile accumulating, Include expansion, Match criteria,
 * `%`-token and `${ENV}` expansion, and defaults injection.
 */

interface Stanza {
  patterns?: string[]
  match?: string
  options: Map<string, string[]>
}

export interface ResolvedSshConfig {
  host: string
  user: string
  port: number
  identityFiles: string[]
  identityAgent?: string
  knownHostsFiles: string[]
  identitiesOnly: boolean
  serverAliveInterval: number
  serverAliveCountMax: number
  connectTimeout: number
  addressFamily?: string
  bindAddress?: string
  proxyCommand?: string
  forwardAgent: boolean
  pubkeyAcceptedTypes?: string
}

interface SshTarget {
  host: string
  user?: string
  port?: number
}

/** Parse "user@host[:port]", mirroring wezterm's SshParameters (config/src/ssh.rs). */
export function parseTarget(target: string): SshTarget {
  const t: SshTarget = { host: target }
  const at = target.lastIndexOf('@')
  if (at >= 0) {
    t.user = target.slice(0, at)
    t.host = target.slice(at + 1)
  }
  let hostport = t.host
  if (hostport.startsWith('[')) {
    const close = hostport.indexOf(']')
    if (close >= 0) {
      t.host = hostport.slice(1, close)
      const rest = hostport.slice(close + 1)
      if (rest.startsWith(':')) t.port = Number(rest.slice(1))
    }
  } else {
    const colon = hostport.lastIndexOf(':')
    if (colon >= 0) {
      const maybePort = Number(hostport.slice(colon + 1))
      if (Number.isInteger(maybePort) && maybePort > 0) {
        t.host = hostport.slice(0, colon)
        t.port = maybePort
      }
    }
  }
  return t
}

function wildcardToRegExp(pattern: string): RegExp {
  let re = '^'
  for (const c of pattern) {
    if (c === '*') re += '.*'
    else if (c === '?') re += '.'
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  re += '$'
  return new RegExp(re)
}

/** Match a Host pattern list: the first matching pattern decides; `!` negates the group. */
function matchGroup(hostname: string, patterns: string[]): boolean {
  for (const p of patterns) {
    const negated = p.startsWith('!')
    const pat = negated ? p.slice(1) : p
    if (wildcardToRegExp(pat).test(hostname)) return !negated
  }
  return false
}

/** Evaluate a `Match` clause. Supports all/canonical/final/exec/host/originalhost/user/localuser. */
function matchCriteria(criteria: string, host: string, user: string, localUser: string): boolean {
  const parts = criteria.trim().split(/\s+/)
  for (let i = 0; i < parts.length; i++) {
    const key = parts[i].toLowerCase()
    if (i + 1 >= parts.length) {
      // keys without a value (e.g. `Match all`, `canonical`, `final`) always hold
      if (key === 'all' || key === 'final') continue
      return false
    }
    const values = parts[++i].split(',')
    const value = valueFor(key)
    if (value === null) return false // canonical/exec: unsupported -> never match
    if (!values.some((v) => wildcardToRegExp(v).test(value))) return false
  }
  return true

  function valueFor(k: string): string | null {
    switch (k) {
      case 'host':
      case 'originalhost':
        return host
      case 'user':
        return user
      case 'localuser':
        return localUser
      case 'all':
      case 'final':
        return 'all'
      case 'canonical':
      case 'exec':
        return null
      default:
        return ''
    }
  }
}

function expandHome(p: string): string {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2))
  return p
}

/** Minimal filesystem glob (for Include): supports `*`, `?`, `[...]`. */
function globFiles(pattern: string): string[] {
  const absolute = path.isAbsolute(pattern)
  const parts = (absolute ? pattern.split(path.sep) : ['.', ...pattern.split('/')]).filter(Boolean)
  let results: string[] = [absolute ? path.parse(pattern).root : '']
  for (const part of parts) {
    const next: string[] = []
    for (const base of results) {
      if (!/\*|\?|\[/.test(part)) {
        const p = path.join(base, part)
        if (fs.existsSync(p)) next.push(p)
        continue
      }
      let entries: string[] = []
      try {
        entries = fs.readdirSync(base)
      } catch {
        continue
      }
      const re = wildcardToRegExp(part)
      for (const e of entries) if (re.test(e)) next.push(path.join(base, e))
    }
    results = next
  }
  return results
}

function configFileCandidates(): string[] {
  const files = [path.join(os.homedir(), '.ssh', 'config')]
  if (process.platform === 'win32') {
    files.push(path.join(process.env.SystemDrive ?? 'C:', 'ProgramData', 'ssh', 'ssh_config'))
  } else {
    files.push('/etc/ssh/ssh_config')
  }
  return files
}

const MAX_INCLUDE_DEPTH = 10

function loadStanzas(): Stanza[] {
  const stanzas: Stanza[] = []
  for (const file of configFileCandidates()) parseStanzasFromFile(file, 0, stanzas)
  return stanzas
}

function parseStanzasFromFile(file: string, depth: number, out: Stanza[]): void {
  if (depth > MAX_INCLUDE_DEPTH) return
  let content: string
  try {
    content = fs.readFileSync(file, 'utf8')
  } catch {
    return
  }
  parseStanzas(content, path.dirname(file), depth, out)
}

function parseStanzas(content: string, baseDir: string, depth: number, out: Stanza[]): void {
  let current: Stanza | null = null

  const addOption = (key: string, value: string): void => {
    const k = key.toLowerCase()
    if (k === 'host' || k === 'match') {
      current = { options: new Map() }
      out.push(current)
      if (k === 'host') current.patterns = value.split(/\s+/)
      else current.match = value
      return
    }
    if (k === 'include') {
      for (const pat of value.split(/\s+/)) {
        for (const f of globFiles(expandHome(pat))) {
          parseStanzasFromFile(path.isAbsolute(f) ? f : path.join(baseDir, f), depth + 1, out)
        }
      }
      return
    }
    if (!current) {
      // option outside any Host/Match block applies globally
      current = { options: new Map() }
      out.push(current)
    }
    const list = current.options.get(k)
    if (list) list.push(value)
    else current.options.set(k, [value])
  }

  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    let key: string
    let value: string
    const eq = line.indexOf('=')
    const ws = line.search(/\s/)
    let sep = -1
    if (eq >= 0 && (ws < 0 || eq < ws)) sep = eq
    else sep = ws
    if (sep < 0) {
      key = line
      value = ''
    } else {
      key = line.slice(0, sep).trim()
      value = line.slice(sep + 1).trim()
    }
    if (!key) continue
    // strip matching surrounding quotes
    if (value.length >= 2) {
      const q = value[0]
      if ((q === '"' || q === "'") && value[value.length - 1] === q) value = value.slice(1, -1)
    }
    addOption(key, value)
  }
}

function localUser(): string {
  try {
    return os.userInfo().username
  } catch {
    return process.env.USERNAME || process.env.USER || 'unknown'
  }
}

function defaults(): Record<string, string> {
  const home = os.homedir()
  const user = process.env.USER || process.env.USERNAME || 'unknown-user'
  const map: Record<string, string> = {
    port: '22',
    user,
    userknownhostsfile: `${path.join(home, '.ssh', 'known_hosts')} ${path.join(home, '.ssh', 'known_hosts2')}`,
    identityfile: ['id_dsa', 'id_ecdsa', 'id_ed25519', 'id_rsa']
      .map((f) => path.join(home, '.ssh', f))
      .join(' '),
    serveraliveinterval: '0',
    serveralivecountmax: '3',
    connecttimeout: '20',
    identitiesonly: 'no',
    forwardagent: 'no'
  }
  if (process.env.SSH_AUTH_SOCK) map.identityagent = process.env.SSH_AUTH_SOCK
  return map
}

/** First-match-wins; only IdentityFile accumulates. Mirrors wezterm's add_option. */
function addOption(map: Record<string, string>, key: string, value: string): void {
  if (key === 'identityfile') {
    map.identityfile = map.identityfile ? `${map.identityfile} ${value}` : value
    return
  }
  if (!(key in map)) map[key] = value
}

const EXPAND_KEYS = new Set([
  'hostname',
  'identityfile',
  'identityagent',
  'userknownhostsfile',
  'proxycommand',
  'bindaddress',
  'certificatefile',
  'controlpath',
  'localforward',
  'remoteforward',
  'remotecommand'
])

/** Expand %-tokens (%h %n %p %r %u %d %C %i %L %l %j %T) and ${ENV} in a value. */
function expandTokens(value: string, ctx: Record<string, string>): string {
  const map: Record<string, string> = {
    h: ctx.host,
    n: ctx.host,
    p: ctx.port,
    r: ctx.user,
    u: ctx.user,
    d: os.homedir(),
    C: ctx.hash,
    i: String(process.getuid ? process.getuid() : 0),
    L: ctx.localHostname,
    l: ctx.localHostname,
    j: '', // ProxyJump unsupported, matching wezterm
    T: '0'
  }
  const out = value.replace(/%(.)/g, (_m, c) => map[c] ?? `%${c}`)
  return out.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name) => process.env[name] ?? '')
}

function tokenCtx(host: string, port: string, user: string): Record<string, string> {
  const localHostname = os.hostname()
  const hash = crypto
    .createHash('sha1')
    .update(localHostname)
    .update(host)
    .update(user)
    .update(port)
    .digest('hex')
    .slice(0, 16)
  return { host, port, user, hash, localHostname }
}

/**
 * Resolve effective configuration for a target host. Explicit user/port/identity
 * (from the UI dialog) override ssh_config.
 */
export function resolveSshConfig(
  targetHost: string,
  explicitUser?: string,
  explicitPort?: number,
  explicitIdentity?: string
): ResolvedSshConfig {
  const map: Record<string, string> = {}
  const stanzas = loadStanzas()
  // For `Match user` comparisons use the explicit user (from the dialog) or the
  // default user, mirroring OpenSSH comparing against the target user name.
  const criteriaUser = explicitUser ?? (process.env.USER || process.env.USERNAME || 'unknown-user')

  // First pass: apply matching stanzas. Config wins over defaults (first-match-wins).
  for (const stanza of stanzas) {
    let matches = true
    if (stanza.patterns) matches = matchGroup(targetHost, stanza.patterns)
    else if (stanza.match) matches = matchCriteria(stanza.match, targetHost, criteriaUser, localUser())
    if (!matches) continue
    for (const [key, values] of stanza.options) {
      for (const v of values) addOption(map, key, v)
    }
  }

  // Second pass: fill in defaults only for keys config did not set.
  for (const [key, value] of Object.entries(defaults())) {
    if (!(key in map)) map[key] = value
  }

  // Effective user after applying ssh_config (explicit user still wins).
  const user = explicitUser ?? map.user

  for (const key of EXPAND_KEYS) {
    if (map[key]) {
      map[key] = expandTokens(map[key], tokenCtx(targetHost, map.port ?? '22', user))
    }
  }

  const host = map.hostname && map.hostname !== targetHost ? map.hostname : targetHost
  const port = explicitPort ?? Number(map.port ?? 22)
  const identityFiles = (explicitIdentity ? [explicitIdentity] : (map.identityfile ?? '').split(/\s+/))
    .filter(Boolean)
    .map(expandHome)
  const knownHostsFiles = (map.userknownhostsfile ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map(expandHome)

  return {
    host,
    user,
    port,
    identityFiles,
    identityAgent: map.identityagent ? expandHome(map.identityagent) : undefined,
    knownHostsFiles,
    identitiesOnly: (map.identitiesonly ?? 'no').toLowerCase() === 'yes',
    serverAliveInterval: Number(map.serveraliveinterval ?? 0) || 0,
    serverAliveCountMax: Number(map.serveralivecountmax ?? 3) || 3,
    connectTimeout: Number(map.connecttimeout ?? 20) || 20,
    addressFamily: map.addressfamily,
    bindAddress: map.bindaddress,
    proxyCommand: map.proxycommand,
    forwardAgent: (map.forwardagent ?? 'no').toLowerCase() === 'yes',
    pubkeyAcceptedTypes: map.pubkeyacceptedtypes
  }
}

/** Literal (non-wildcard) Host names from the config, for the SSH dialog dropdown. */
export function listSshHosts(): string[] {
  const hosts = new Set<string>()
  for (const s of loadStanzas()) {
    if (!s.patterns) continue
    for (const p of s.patterns) {
      if (!p.startsWith('!') && !p.includes('*') && !p.includes('?')) hosts.add(p)
    }
  }
  return [...hosts].sort()
}
