import type { RendererConfig } from './types'

export interface ThemeColors {
  background: string
  foreground: string
  cursor: string
  cursorAccent: string
  selectionBackground: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

const dark: ThemeColors = {
  background: '#0b0e14',
  foreground: '#c6c8d1',
  cursor: '#f2f4f8',
  cursorAccent: '#0b0e14',
  selectionBackground: 'rgba(113,124,180,0.35)',
  black: '#1b1e28',
  red: '#ff5c57',
  green: '#5af78e',
  yellow: '#f3f99d',
  blue: '#57c7ff',
  magenta: '#ff6ac1',
  cyan: '#9aedfe',
  white: '#f1f1f0',
  brightBlack: '#686868',
  brightRed: '#ff5c57',
  brightGreen: '#5af78e',
  brightYellow: '#f3f99d',
  brightBlue: '#57c7ff',
  brightMagenta: '#ff6ac1',
  brightCyan: '#9aedfe',
  brightWhite: '#f1f1f0'
}

const light: ThemeColors = {
  background: '#ffffff',
  foreground: '#1f2328',
  cursor: '#1f2328',
  cursorAccent: '#ffffff',
  selectionBackground: 'rgba(45,100,200,0.25)',
  black: '#2c2c2c',
  red: '#c91b00',
  green: '#00a200',
  yellow: '#afa000',
  blue: '#0000ba',
  magenta: '#d000d0',
  cyan: '#008080',
  white: '#f0f0f0',
  brightBlack: '#7f7f7f',
  brightRed: '#ff0000',
  brightGreen: '#00ff00',
  brightYellow: '#ffff00',
  brightBlue: '#0000ff',
  brightMagenta: '#ff00ff',
  brightCyan: '#00ffff',
  brightWhite: '#ffffff'
}

export function resolveTheme(config: RendererConfig): ThemeColors {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  const base =
    config.theme.mode === 'dark' || (config.theme.mode === 'system' && prefersDark) ? dark : light
  const c = config.theme.colors ?? {}
  return {
    ...base,
    ...(c.background ? { background: c.background } : {}),
    ...(c.foreground ? { foreground: c.foreground } : {}),
    ...(c.cursor ? { cursor: c.cursor } : {}),
    ...(c.selectionBackground ? { selectionBackground: c.selectionBackground } : {})
  }
}

/** CSS background matching the resolved theme, used for the app chrome. */
export function chromeBackground(colors: ThemeColors): string {
  return colors.background
}
