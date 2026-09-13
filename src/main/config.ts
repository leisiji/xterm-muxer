import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'

/**
 * JSON config (wezterm uses lua; JSON is a pragmatic Electron equivalent).
 * Lives in app.getPath('userData')/config.json, deep-merged over defaults.
 */

/** A saved SSH connection profile. Passwords are never persisted. */
export interface SavedSshHost {
  id: string
  name: string
  host: string
  user?: string
  port?: number
  identity?: string
}

export interface AppConfig {
  shell?: { path?: string; args?: string[] }
  font: { family?: string; size: number; lineHeight: number }
  theme: {
    mode: 'system' | 'light' | 'dark'
    colors?: { background?: string; foreground?: string; cursor?: string; selectionBackground?: string }
  }
  ssh: {
    connectTimeout?: number
    serverAliveInterval?: number
    serverAliveCountMax?: number
    hosts?: SavedSshHost[]
    /** When set, new tabs/panes default to this SSH target instead of a local shell. */
    defaultTarget?: string
  }
  scrollback: number
  window: { width: number; height: number; title: string }
  /** Where the tab bar sits: at the top (default) or bottom of the window. */
  tabBar: { position: 'top' | 'bottom' }
  /** Copy the current selection to the clipboard as soon as it is made. Default true. */
  copyOnSelect?: boolean
  /** Focus the pane under the mouse pointer (wezterm pane_focus_follows_mouse). Default true. */
  focusFollowsMouse?: boolean
  /**
   * What to do when a session's process exits / an SSH connection drops:
   *   close            always close the pane
   *   closeOnCleanExit close only on a clean exit (code 0), hold on errors (default)
   *   hold             keep the pane open showing "Session ended"
   * Closing the last pane of the last tab closes the window.
   */
  exitBehavior?: 'close' | 'closeOnCleanExit' | 'hold'
  keys: Record<string, string>
}

export const defaultConfig: AppConfig = {
  font: { family: 'Maple Mono NF CN', size: 14, lineHeight: 1.15 },
  theme: { mode: 'system' },
  ssh: {},
  scrollback: 10000,
  window: { width: 1100, height: 700, title: 'XtermMuxer' },
  tabBar: { position: 'top' },
  copyOnSelect: true,
  focusFollowsMouse: true,
  exitBehavior: 'closeOnCleanExit',
  keys: {}
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function deepMerge<T>(base: T, override: unknown): T {
  if (!isRecord(base) || !isRecord(override)) {
    return (override === undefined ? base : (override as T))
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(override)) {
    const b = (base as Record<string, unknown>)[k]
    out[k] = isRecord(b) && isRecord(v) ? deepMerge(b, v) : v
  }
  return out as T
}

function configFile(): string {
  return path.join(app.getPath('userData'), 'config.json')
}

export function loadConfig(): AppConfig {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(configFile(), 'utf8'))
    return deepMerge(structuredClone(defaultConfig), raw)
  } catch {
    // Return a fresh copy so callers can safely mutate the result.
    return structuredClone(defaultConfig)
  }
}

/** Persist the full config, creating the userData directory if needed. */
export function saveConfig(config: AppConfig): void {
  const file = configFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', 'utf8')
}

/**
 * Deep-merge a partial patch (e.g. `{ font: { size: 16 } }`) into the stored
 * config, persist it and return the merged result.
 */
export function updateConfig(patch: unknown): AppConfig {
  const merged = deepMerge(loadConfig(), patch) as AppConfig
  saveConfig(merged)
  return merged
}

/** List saved SSH connection profiles. */
export function listSavedHosts(): SavedSshHost[] {
  return loadConfig().ssh.hosts ?? []
}

/**
 * Insert or update a saved SSH profile. An entry with a matching id is updated;
 * otherwise a new profile is created (a duplicate host/user/port is also
 * updated in place to avoid piling up identical entries).
 */
export function saveSshHost(host: SavedSshHost): SavedSshHost[] {
  const cfg = loadConfig()
  const hosts = cfg.ssh.hosts ? [...cfg.ssh.hosts] : []
  const key = profileKey(host)
  const idx = hosts.findIndex((h) => h.id === host.id || profileKey(h) === key)
  if (idx >= 0) hosts[idx] = { ...host, id: hosts[idx].id }
  else hosts.push(host)
  cfg.ssh = { ...cfg.ssh, hosts }
  saveConfig(cfg)
  return hosts
}

/** Remove a saved SSH profile by id. */
export function deleteSshHost(id: string): SavedSshHost[] {
  const cfg = loadConfig()
  const hosts = (cfg.ssh.hosts ?? []).filter((h) => h.id !== id)
  cfg.ssh = { ...cfg.ssh, hosts }
  saveConfig(cfg)
  return hosts
}

function profileKey(h: Pick<SavedSshHost, 'host' | 'user' | 'port'>): string {
  return `${h.host}\u0000${h.user ?? ''}\u0000${h.port ?? 22}`
}
