import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'

/**
 * JSON config (wezterm uses lua; JSON is a pragmatic Electron equivalent).
 * Lives in app.getPath('userData')/config.json, deep-merged over defaults.
 */

export interface AppConfig {
  shell?: { path?: string; args?: string[] }
  font: { family?: string; size: number; lineHeight: number }
  theme: {
    mode: 'system' | 'light' | 'dark'
    colors?: { background?: string; foreground?: string; cursor?: string; selectionBackground?: string }
  }
  ssh: { connectTimeout?: number; serverAliveInterval?: number; serverAliveCountMax?: number }
  scrollback: number
  window: { width: number; height: number; title: string }
  keys: Record<string, string>
}

export const defaultConfig: AppConfig = {
  font: { size: 14, lineHeight: 1.15 },
  theme: { mode: 'system' },
  ssh: {},
  scrollback: 10000,
  window: { width: 1100, height: 700, title: 'XtermMuxer' },
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

export function loadConfig(): AppConfig {
  const file = path.join(app.getPath('userData'), 'config.json')
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    return deepMerge(defaultConfig, raw)
  } catch {
    return defaultConfig
  }
}
