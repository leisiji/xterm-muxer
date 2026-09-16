/**
 * The user-configurable keymap: binding tables, the chord grammar, capture,
 * config resolution, conflict detection and the precedence router.
 *
 * Pure by design — it imports a few value helpers from keys.ts and only *types*
 * otherwise, and never touches the DOM, Electron or xterm — so scripts/test-mux.ts
 * can bundle it and run it under plain Node.
 *
 * Binding ids are flat strings so that both layers live in one `keys` config map:
 *   "new-tab"           a direct (global) binding
 *   "leader-prefix"     the chord that arms leader mode
 *   "leader.new-tab"    the key pressed after the leader prefix
 */
import {
  BARE_MODIFIERS,
  DEFAULT_LEADER_KEYS,
  combo,
  isCombo,
  matchLeaderKey,
  modsMatch,
  resolveResizeKey,
  unshiftedKey
} from './keys'
import type { Combo, KeyEventLike, LeaderAction, LeaderKeyResult, Mod, ResizeAction } from './keys'

// ---------------------------------------------------------------- action ids

export type DirectActionId =
  | 'copy-mode'
  | 'quick-select'
  | 'toggle-fullscreen'
  | 'last-tab'
  | 'focus-next-pane'
  | 'leader-prefix'
  | 'new-tab'
  | 'new-ssh'
  | 'open-settings'
  | 'open-keybindings'
  | 'close-pane'
  | 'toggle-zoom'
  | 'toggle-search'
  | 'copy'
  | 'paste'
  | 'split-col'
  | 'split-row'
  | 'next-tab'
  | 'prev-tab'
  | 'focus-up'
  | 'focus-down'
  | 'focus-left'
  | 'focus-right'

export type LeaderBindingId = `leader.${LeaderAction}`
export type BindingKey = DirectActionId | LeaderBindingId

export interface ActionDef {
  key: BindingKey
  /** Shown in the Keybindings dialog. */
  label: string
  /** Dialog section; sections appear in the order their first member appears. */
  group: string
  /** Shown but not recordable (the leader 1..9 range). */
  locked?: boolean
  hint?: string
}

/**
 * The direct table, in dispatch precedence order. Copy mode and quick select come
 * first because their entry chords must be recognised *before* the pane they belong
 * to starts swallowing keystrokes; everything else follows the original if-chain.
 *
 * `split-col` and `split-row` name the *pane-tree* orientation, which reads backwards
 * from the user's point of view: `'col'` stacks children vertically (top/bottom) and
 * `'row'` lays them out along x (left/right).
 */
export const DIRECT_ACTIONS: ActionDef[] = [
  { key: 'copy-mode', label: 'Copy mode', group: 'Terminal' },
  { key: 'quick-select', label: 'Quick select', group: 'Terminal' },
  { key: 'toggle-fullscreen', label: 'Toggle fullscreen', group: 'View' },
  { key: 'last-tab', label: 'Previous tab (last used)', group: 'Tabs' },
  { key: 'focus-next-pane', label: 'Next pane', group: 'Panes' },
  {
    key: 'leader-prefix',
    label: 'Leader prefix',
    group: 'Leader key',
    hint: 'Arms the leader key table below'
  },
  { key: 'new-tab', label: 'New tab', group: 'Tabs' },
  { key: 'new-ssh', label: 'New SSH connection', group: 'Sessions' },
  { key: 'open-settings', label: 'Terminal settings', group: 'View' },
  { key: 'open-keybindings', label: 'Keybindings', group: 'View' },
  { key: 'close-pane', label: 'Close pane', group: 'Panes' },
  { key: 'toggle-zoom', label: 'Zoom pane', group: 'Panes' },
  { key: 'toggle-search', label: 'Search', group: 'Terminal' },
  { key: 'copy', label: 'Copy', group: 'Terminal' },
  { key: 'paste', label: 'Paste', group: 'Terminal' },
  { key: 'split-col', label: 'Split top/bottom', group: 'Panes' },
  { key: 'split-row', label: 'Split left/right', group: 'Panes' },
  { key: 'next-tab', label: 'Next tab', group: 'Tabs' },
  { key: 'prev-tab', label: 'Previous tab', group: 'Tabs' },
  { key: 'focus-up', label: 'Focus pane up', group: 'Panes' },
  { key: 'focus-down', label: 'Focus pane down', group: 'Panes' },
  { key: 'focus-left', label: 'Focus pane left', group: 'Panes' },
  { key: 'focus-right', label: 'Focus pane right', group: 'Panes' }
]

/** The leader key table, in the order the original decoder checked it. */
export const LEADER_ACTIONS: ActionDef[] = [
  { key: 'leader.split-col', label: 'Split top/bottom', group: 'Leader key' },
  { key: 'leader.split-row', label: 'Split left/right', group: 'Leader key' },
  { key: 'leader.new-tab', label: 'New tab', group: 'Leader key' },
  { key: 'leader.close-pane', label: 'Close pane', group: 'Leader key' },
  { key: 'leader.toggle-zoom', label: 'Zoom pane', group: 'Leader key' },
  { key: 'leader.rename-tab', label: 'Rename tab', group: 'Leader key' },
  { key: 'leader.next-tab', label: 'Next tab', group: 'Leader key' },
  { key: 'leader.prev-tab', label: 'Previous tab', group: 'Leader key' },
  { key: 'leader.focus-left', label: 'Focus pane left', group: 'Leader key' },
  { key: 'leader.focus-down', label: 'Focus pane down', group: 'Leader key' },
  { key: 'leader.focus-up', label: 'Focus pane up', group: 'Leader key' },
  { key: 'leader.focus-right', label: 'Focus pane right', group: 'Leader key' },
  { key: 'leader.resize-mode', label: 'Resize mode', group: 'Leader key' }
]

/** A dialog row that is shown but cannot be recorded, so it has no binding id. */
export interface LockedActionDef {
  label: string
  group: string
  locked: true
  hint?: string
}

/**
 * Leader + 1..9 activates a tab by index. It is a range rather than a binding, so the
 * dialog shows it as one locked row and the decoder handles it after the table.
 */
export const LEADER_DIGIT_ROW: LockedActionDef = {
  label: 'Activate tab 1–9',
  group: 'Leader key',
  locked: true,
  hint: 'Fixed range: jumps to the Nth tab'
}

export const DIRECT_ORDER: DirectActionId[] = DIRECT_ACTIONS.map((a) => a.key as DirectActionId)
export const LEADER_ORDER: LeaderAction[] = LEADER_ACTIONS.map(
  (a) => a.key.slice('leader.'.length) as LeaderAction
)

/** Handled before anything else: their chords fire even while a pane owns the keys. */
export const ENTRY_ORDER: DirectActionId[] = ['copy-mode', 'quick-select']

export const DEFAULT_PREFIX = 'Alt+N'

/** Defaults, as chord strings. Arrays carry the alternate forms (see the README). */
export const DEFAULT_DIRECT: Record<DirectActionId, string[]> = {
  'copy-mode': ['Alt+X'],
  'quick-select': ['Alt+I'],
  'toggle-fullscreen': ['Alt+Enter'],
  'last-tab': ['Alt+M'],
  'focus-next-pane': ['Alt+P'],
  'leader-prefix': [DEFAULT_PREFIX],
  'new-tab': ['Ctrl+Shift+T'],
  'new-ssh': ['Ctrl+Shift+S'],
  'open-settings': ['Ctrl+,'],
  'open-keybindings': ['Ctrl+Shift+K'],
  'close-pane': ['Ctrl+Shift+W'],
  'toggle-zoom': ['Ctrl+Shift+Z'],
  'toggle-search': ['Ctrl+Shift+F'],
  copy: ['Ctrl+Shift+C'],
  paste: ['Ctrl+Shift+V'],
  // Shift+' produces ", Shift+5 produces % — both spellings are accepted so the
  // default works whether a layout reports the shifted glyph or the base key.
  'split-col': ['Ctrl+Shift+Alt+"', "Ctrl+Shift+Alt+'"],
  'split-row': ['Ctrl+Shift+Alt+5', 'Ctrl+Shift+Alt+%'],
  'next-tab': ['Ctrl+Tab', 'Ctrl+PageDown'],
  'prev-tab': ['Ctrl+Shift+Tab', 'Ctrl+PageUp'],
  'focus-up': ['Alt+ArrowUp'],
  'focus-down': ['Alt+ArrowDown'],
  'focus-left': ['Alt+ArrowLeft'],
  'focus-right': ['Alt+ArrowRight']
}

/** The default chords for a binding id (leader entries included). */
export function defaultChords(id: BindingKey): string[] {
  if (id.startsWith('leader.')) return DEFAULT_LEADER_KEYS[id.slice('leader.'.length) as LeaderAction] ?? []
  return DEFAULT_DIRECT[id as DirectActionId] ?? []
}

// ------------------------------------------------------------- chord grammar

const MOD_NAMES: Record<string, Mod> = {
  ctrl: 'Ctrl',
  control: 'Ctrl',
  shift: 'Shift',
  alt: 'Alt',
  option: 'Alt',
  meta: 'Meta',
  cmd: 'Meta',
  command: 'Meta',
  super: 'Meta',
  win: 'Meta'
}

/** Emission order; also the order `formatCombo` writes. */
const MOD_ORDER: Mod[] = ['Ctrl', 'Shift', 'Alt', 'Meta']

/** Named (multi-character) keys: Tab, Enter, PageDown, ArrowUp, F5, ... */
const NAMED_KEY = /^[A-Za-z][A-Za-z0-9]*$/

const DEAD_KEYS = new Set(['Dead', 'Unidentified', 'Process', 'Compose'])

function isUsableKey(key: string): boolean {
  if (!key || BARE_MODIFIERS.has(key) || DEAD_KEYS.has(key)) return false
  if (key.length === 1) return !/\s/.test(key)
  return NAMED_KEY.test(key)
}

/**
 * Parse a chord string — `"Ctrl+Shift+T"`, `"Alt+ArrowUp"`, `"Shift+_"`, `"Ctrl+,"` —
 * into a Combo, or null when it is not a usable binding. Modifier names are
 * case-insensitive and accepted in any order; the key keeps its case (the matcher is
 * case-insensitive, but a raw `e.key` round-trips exactly).
 */
export function parseCombo(s: string): Combo | null {
  const raw = s.trim()
  if (!raw) return null
  const parts = raw.split('+')
  const mods: Mod[] = []
  let i = 0
  // Never consume the final segment as a modifier, so a literal "+" key survives.
  while (i < parts.length - 1) {
    const name = MOD_NAMES[parts[i].trim().toLowerCase()]
    if (!name) break
    if (!mods.includes(name)) mods.push(name)
    i++
  }
  const key = parts.slice(i).join('+')
  if (!isUsableKey(key)) return null
  return combo(key, mods)
}

/** Render a combo as a canonical chord string. */
export function formatCombo(c: Combo): string {
  return [...MOD_ORDER.filter((m) => c.mods.includes(m)), c.key].join('+')
}

/** True when the combo names Ctrl, Alt or Meta (Ctrl covers Meta: they are folded). */
export function hasModifier(c: Combo): boolean {
  return c.mods.includes('Ctrl') || c.mods.includes('Alt') || c.mods.includes('Meta')
}

/**
 * Whether a combo is acceptable as a *global* binding. Anything without a modifier
 * would swallow ordinary typing, so only named keys (F5, F11) may be bare.
 */
export function isSafeDirectBinding(c: Combo): boolean {
  return hasModifier(c) || c.key.length > 1
}

/**
 * A canonical identity for conflict detection. Ctrl and Meta fold into one axis
 * (the matcher cannot tell them apart) and a shifted character folds onto the
 * physical key that produced it, so `Ctrl+Shift+5` and `Ctrl+Shift+%` — the same
 * keypress — compare equal.
 */
export function comboSignature(c: Combo): string {
  const ctrl = c.mods.includes('Ctrl') || c.mods.includes('Meta')
  const shift = c.mods.includes('Shift')
  const alt = c.mods.includes('Alt')
  const flags = `${ctrl ? 'C' : ''}${alt ? 'A' : ''}${shift ? 'S' : ''}`
  const physical = unshiftedKey(c.key)
  return `${flags}|${codeFor(physical) ?? physical.toLowerCase()}`
}

// ------------------------------------------------------------------- capture

/**
 * Normalize a keydown into a Combo, or null when it cannot be a binding at all
 * (a bare modifier, a dead key, an in-flight IME composition).
 *
 * Ctrl and Meta are folded into `Ctrl`: the matcher treats them as one axis, so
 * recording the platform's Command key as Ctrl is what makes the binding match on
 * macOS as well.
 */
export function comboFromEvent(e: KeyEventLike): Combo | null {
  if (e.isComposing) return null
  if (!isUsableKey(e.key)) return null
  const mods: Mod[] = []
  if (e.ctrlKey || e.metaKey) mods.push('Ctrl')
  if (e.shiftKey) mods.push('Shift')
  if (e.altKey) mods.push('Alt')
  return combo(e.key, mods)
}

/**
 * Why the recorder refused a keydown, or null when it is acceptable. Kept separate
 * from `comboFromEvent` so the dialog can explain the refusal and stay armed.
 */
export function captureError(e: KeyEventLike, opts: { leader?: boolean } = {}): string | null {
  if (e.isComposing) return 'Not while an input method is composing'
  if (DEAD_KEYS.has(e.key) || !e.key) return 'That key cannot be used'
  if (BARE_MODIFIERS.has(e.key)) return 'Keep holding — now press the rest of the chord'
  if (opts.leader) {
    if (e.ctrlKey || e.altKey || e.metaKey) return 'Leader keys cannot use Ctrl or Alt'
    if (/^[1-9]$/.test(e.key)) return 'Digits 1–9 are reserved for jumping to a tab'
    return null
  }
  const c = comboFromEvent(e)
  if (!c) return 'That key cannot be used'
  if (!isSafeDirectBinding(c)) return 'Add Ctrl or Alt — a bare key would break ordinary typing'
  return null
}

// ---------------------------------------------------------------- resolution

export interface ResolvedKeymap {
  direct: Map<DirectActionId, Combo[]>
  /** Leader table entries are bare keys; the decoder ignores Shift for them. */
  leader: Map<LeaderAction, string[]>
  /** Binding ids whose configured value could not be used; the default was kept. */
  invalid: string[]
}

/** A config value may be a chord, a list of chords, or '' / [] for "unbound". */
function toChordList(value: unknown): string[] | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed === '' ? [] : [trimmed]
  }
  if (Array.isArray(value)) {
    return value.every((v) => typeof v === 'string') ? (value as string[]) : null
  }
  return null
}

function parseAll(list: string[]): Combo[] {
  const out: Combo[] = []
  for (const s of list) {
    const c = parseCombo(s)
    if (c) out.push(c)
  }
  return out
}

/**
 * Merge the `keys` config over the defaults. An absent id keeps its default; an
 * unusable value is reported in `invalid` and also falls back to the default, so a
 * typo in a hand-edited config can never leave an action unreachable.
 */
export function resolveKeymap(keys: Record<string, unknown> | undefined): ResolvedKeymap {
  const overrides = keys ?? {}
  const invalid: string[] = []
  const direct = new Map<DirectActionId, Combo[]>()
  const leader = new Map<LeaderAction, string[]>()

  for (const id of DIRECT_ORDER) {
    const fallback = parseAll(DEFAULT_DIRECT[id])
    const raw = overrides[id]
    if (raw === undefined || raw === null) {
      direct.set(id, fallback)
      continue
    }
    const list = toChordList(raw)
    const combos = list === null ? null : parseAll(list)
    const ok =
      combos !== null &&
      combos.length === list!.length &&
      combos.every(isSafeDirectBinding) &&
      // The prefix must be a modified chord, or the leader table would swallow typing.
      (id !== 'leader-prefix' || combos.every(hasModifier))
    if (!combos || !ok) {
      invalid.push(id)
      direct.set(id, fallback)
      continue
    }
    direct.set(id, combos)
  }

  for (const action of LEADER_ORDER) {
    const id: BindingKey = `leader.${action}`
    const fallback = DEFAULT_LEADER_KEYS[action] ?? []
    const raw = overrides[id]
    if (raw === undefined || raw === null) {
      leader.set(action, [...fallback])
      continue
    }
    const list = toChordList(raw)
    const combos = list === null ? null : parseAll(list)
    // Leader keys are bare by construction (the decoder requires no Ctrl/Alt), so a
    // modified chord here would never fire.
    const ok = combos !== null && combos.length === list!.length && combos.every((c) => !hasModifier(c))
    if (!combos || !ok) {
      invalid.push(id)
      leader.set(action, [...fallback])
      continue
    }
    leader.set(action, combos.map((c) => c.key))
  }

  return { direct, leader, invalid }
}

// ------------------------------------------------------------------ matching

/**
 * The physical-key name for a single alphanumeric key ('n' -> 'KeyN', '5' ->
 * 'Digit5'). Used as a fallback so a binding still fires on layouts and IMEs that
 * report a different `key` — the original code did exactly this for the Alt+N arm.
 */
function codeFor(key: string): string | null {
  if (/^[a-z]$/i.test(key)) return 'Key' + key.toUpperCase()
  if (/^[0-9]$/.test(key)) return 'Digit' + key
  return null
}

function comboMatches(e: KeyEventLike, c: Combo): boolean {
  if (isCombo(e, c)) return true
  const code = codeFor(c.key)
  return code !== null && e.code === code && modsMatch(e, c)
}

/** The first action in `order` whose chords match the event. */
export function matchDirect(
  e: KeyEventLike,
  km: ResolvedKeymap,
  order: DirectActionId[] = DIRECT_ORDER
): DirectActionId | null {
  for (const id of order) {
    const list = km.direct.get(id)
    if (!list) continue
    for (const c of list) {
      if (comboMatches(e, c)) return id
    }
  }
  return null
}

/** Decode a keydown while leader mode is armed (delegates to the shared decoder). */
export function matchLeader(e: KeyEventLike, km: ResolvedKeymap): LeaderKeyResult {
  const table: Record<string, string[]> = {}
  for (const [action, keys] of km.leader) table[action] = keys
  return matchLeaderKey(e, table)
}

// ----------------------------------------------------------------- conflicts

export interface ChordConflict {
  signature: string
  /** How the chord reads, taken from the first action that claimed it. */
  display: string
  keys: BindingKey[]
}

/**
 * Chords claimed by two or more actions. Direct and leader bindings are compared in
 * separate namespaces — a direct `Ctrl+T` and a leader `t` are not in conflict — and
 * an unbound action never conflicts.
 */
export function findConflicts(km: ResolvedKeymap): ChordConflict[] {
  const bySignature = new Map<string, { display: string; keys: BindingKey[] }>()
  const claim = (signature: string, display: string, key: BindingKey): void => {
    const entry = bySignature.get(signature)
    if (!entry) {
      bySignature.set(signature, { display, keys: [key] })
      return
    }
    if (!entry.keys.includes(key)) entry.keys.push(key)
  }

  for (const id of DIRECT_ORDER) {
    for (const c of km.direct.get(id) ?? []) claim(comboSignature(c), formatCombo(c), id)
  }
  for (const action of LEADER_ORDER) {
    for (const k of km.leader.get(action) ?? []) {
      claim(`leader|${k.toLowerCase()}`, k, `leader.${action}`)
    }
  }

  return [...bySignature.entries()]
    .filter(([, v]) => v.keys.length > 1)
    .map(([signature, v]) => ({ signature, display: v.display, keys: v.keys }))
    .sort((a, b) => a.signature.localeCompare(b.signature))
}

/** Per-row view of `findConflicts`, for highlighting and tooltips. */
export function conflictsByKey(km: ResolvedKeymap): Map<BindingKey, ChordConflict> {
  const out = new Map<BindingKey, ChordConflict>()
  for (const conflict of findConflicts(km)) {
    for (const key of conflict.keys) out.set(key, conflict)
  }
  return out
}

// ------------------------------------------------------------------- routing

/** What the app currently is, as far as the router cares. */
export interface KeyContext {
  /** A terminal handle exists for the focused pane. */
  hasTerminal: boolean
  copyMode: boolean
  quickSelect: boolean
  resizeMode: boolean
  leaderArmed: boolean
}

export type KeyOutcome =
  /** Not ours: let the key reach the terminal (returns false upstream). */
  | { kind: 'pass' }
  /** Ours, but nothing to do (returns true upstream). */
  | { kind: 'copy-mode-toggle' }
  | { kind: 'copy-mode-key' }
  | { kind: 'quick-select-toggle' }
  | { kind: 'quick-select-key' }
  | { kind: 'resize'; action: ResizeAction }
  | { kind: 'resize-exit' }
  | { kind: 'arm-leader' }
  | { kind: 'leader-result'; result: LeaderKeyResult }
  | { kind: 'action'; id: DirectActionId }

/**
 * Decide what a keydown means. The order mirrors the original if-chain: modal panes
 * (copy mode, quick select) own their keystrokes first, then resize mode, then an
 * armed leader, and only then the direct table.
 *
 * One deliberate difference from the original chain: `Alt+Enter`, `Alt+m` and `Alt+p`
 * used to be checked *before* an armed leader, so they fired and left leader mode
 * armed. They are ordinary table entries now, so an armed leader swallows them —
 * which is what a prefix key is supposed to do.
 */
export function decideKey(e: KeyEventLike, ctx: KeyContext, km: ResolvedKeymap): KeyOutcome {
  if (e.isComposing) return { kind: 'pass' }

  // Copy mode / quick select entry chords, recognised even while a pane owns the keys.
  const entry = matchDirect(e, km, ENTRY_ORDER)
  if (entry !== null) {
    const toggle = entry === 'copy-mode' ? 'copy-mode-toggle' : 'quick-select-toggle'
    // Without a terminal there is nothing to toggle; fall through, as the original did.
    return ctx.hasTerminal ? { kind: toggle } : { kind: 'pass' }
  }
  if (ctx.copyMode) return { kind: 'copy-mode-key' }
  if (ctx.quickSelect) return { kind: 'quick-select-key' }

  if (ctx.resizeMode) {
    const res = resolveResizeKey(e)
    if (res.kind === 'ignore') return { kind: 'pass' }
    return res.kind === 'resize' ? { kind: 'resize', action: res.action } : { kind: 'resize-exit' }
  }

  if (ctx.leaderArmed) {
    const result = matchLeader(e, km)
    // A bare modifier keydown must reach the terminal so a chord like Shift+- can
    // complete ("Shift" arrives first, then "_") without cancelling leader mode.
    if (result.kind === 'ignore') return { kind: 'pass' }
    return { kind: 'leader-result', result }
  }

  const id = matchDirect(e, km)
  if (id === null) return { kind: 'pass' }
  if (id === 'leader-prefix') return { kind: 'arm-leader' }
  return { kind: 'action', id }
}
