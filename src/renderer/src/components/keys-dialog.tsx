import { useEffect, useMemo, useState } from 'react'
import type { KeyboardEvent, ReactElement } from 'react'
import {
  DIRECT_ACTIONS,
  DIRECT_ORDER,
  LEADER_ACTIONS,
  LEADER_DIGIT_ROW,
  LEADER_ORDER,
  captureError,
  comboFromEvent,
  conflictsByKey,
  defaultChords,
  formatCombo,
  resolveKeymap
} from '../keymap'
import type { BindingKey, ChordConflict } from '../keymap'
import type { KeyEventLike } from '../keys'

export interface KeysDialogProps {
  open: boolean
  /** The stored overrides, straight from the config. */
  keys: Record<string, string[]>
  onCancel: () => void
  /** Only the bindings the user touched, so untouched ids keep their stored value. */
  onApply: (patch: Record<string, string[]>) => void
}

interface Row {
  /** null for the locked leader 1..9 range. */
  id: BindingKey | null
  label: string
  hint?: string
  locked?: boolean
}

interface Section {
  title: string
  rows: Row[]
}

const ALL_IDS: BindingKey[] = [...DIRECT_ORDER, ...LEADER_ORDER.map((a) => `leader.${a}` as BindingKey)]

/**
 * The effective binding for every action: what the config resolves to, rendered
 * canonically. Aliased defaults therefore show both of their accepted spellings.
 */
function effectiveChords(keys: Record<string, string[]> | undefined): Record<BindingKey, string[]> {
  const km = resolveKeymap(keys)
  const out = {} as Record<BindingKey, string[]>
  for (const id of DIRECT_ORDER) out[id] = (km.direct.get(id) ?? []).map(formatCombo)
  for (const action of LEADER_ORDER) out[`leader.${action}`] = [...(km.leader.get(action) ?? [])]
  return out
}

function defaultsSnapshot(): Record<BindingKey, string[]> {
  const out = {} as Record<BindingKey, string[]>
  for (const id of ALL_IDS) out[id] = [...defaultChords(id)]
  return out
}

const sameList = (a: string[], b: string[]): boolean => a.length === b.length && a.every((v, i) => v === b[i])

/**
 * The Keybindings editor: one row per binding, click a chord and press the new keys.
 *
 * Capture works through `onKeyDownCapture` on the modal, and the app suspends its
 * global keydown listener while this dialog is open (see app.tsx) — without that the
 * window-level capture listener would claim the keystroke before React saw it.
 */
export function KeysDialog(props: KeysDialogProps): ReactElement | null {
  const [draft, setDraft] = useState<Record<BindingKey, string[]>>(() => effectiveChords(props.keys))
  const [touched, setTouched] = useState<Set<BindingKey>>(() => new Set())
  const [recording, setRecording] = useState<BindingKey | null>(null)
  const [captureMsg, setCaptureMsg] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  // Re-sync the draft from the live config each time the dialog opens.
  useEffect(() => {
    if (props.open) {
      setDraft(effectiveChords(props.keys))
      setTouched(new Set())
      setRecording(null)
      setCaptureMsg(null)
      setFilter('')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open])

  const sections = useMemo((): Section[] => {
    const out: Section[] = []
    const byGroup = new Map<string, Row[]>()
    for (const a of DIRECT_ACTIONS) {
      // The leader prefix belongs with the table it arms, not with the View group.
      if (a.group === 'Leader key') continue
      const rows = byGroup.get(a.group) ?? []
      rows.push({ id: a.key, label: a.label, hint: a.hint })
      byGroup.set(a.group, rows)
    }
    for (const [title, rows] of byGroup) out.push({ title, rows })

    const leaderRows: Row[] = []
    for (const a of DIRECT_ACTIONS) {
      if (a.group === 'Leader key') leaderRows.push({ id: a.key, label: a.label, hint: a.hint })
    }
    for (const a of LEADER_ACTIONS) leaderRows.push({ id: a.key, label: a.label })
    leaderRows.push({ id: null, label: LEADER_DIGIT_ROW.label, hint: LEADER_DIGIT_ROW.hint, locked: true })
    out.push({ title: 'Leader key', rows: leaderRows })
    return out
  }, [])

  const resolved = useMemo(() => resolveKeymap(draft), [draft])
  const conflictByKey = useMemo(() => conflictsByKey(resolved), [resolved])
  const conflictCount = useMemo(() => new Set([...conflictByKey.values()].map((c) => c.signature)).size, [conflictByKey])
  // Ids whose *stored* value could not be used; the dialog starts from the default.
  const invalidStored = useMemo(() => new Set(resolveKeymap(props.keys).invalid), [props.keys])

  if (!props.open) return null

  const labelFor = (id: BindingKey): string => {
    const row = sections.flatMap((s) => s.rows).find((r) => r.id === id)
    return row?.label ?? id
  }

  const markTouched = (id: BindingKey): void => setTouched((prev) => new Set(prev).add(id))

  const setChords = (id: BindingKey, chords: string[]): void => {
    setDraft((d) => ({ ...d, [id]: chords }))
    markTouched(id)
  }

  const startRecording = (id: BindingKey): void => {
    setRecording(id)
    setCaptureMsg(null)
  }

  /** Own every keydown while recording: Tab must not move focus, Enter must not submit. */
  const onKeyDownCapture = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (recording === null) return
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') {
      setRecording(null)
      setCaptureMsg(null)
      return
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      setChords(recording, [])
      setRecording(null)
      setCaptureMsg(null)
      return
    }
    const like: KeyEventLike = {
      key: e.key,
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
      metaKey: e.metaKey,
      shiftKey: e.shiftKey,
      code: e.code,
      isComposing: e.nativeEvent.isComposing
    }
    const leader = recording.startsWith('leader.')
    const error = captureError(like, { leader })
    if (error) {
      setCaptureMsg(error)
      return
    }
    const combo = comboFromEvent(like)
    if (!combo) {
      setCaptureMsg('That key cannot be used')
      return
    }
    // Leader entries store the bare key: the decoder ignores Shift there, so keeping
    // it would only make `_` and `-` indistinguishable in the config.
    setChords(recording, leader ? [combo.key] : [formatCombo(combo)])
    setRecording(null)
    setCaptureMsg(null)
  }

  const apply = (): void => {
    const patch: Record<string, string[]> = {}
    for (const id of touched) patch[id] = draft[id] ?? []
    props.onApply(patch)
  }

  const resetRow = (id: BindingKey): void => setChords(id, [...defaultChords(id)])

  const resetAll = (): void => {
    // Only ids that actually carry something to clear need writing: deepMerge never
    // removes a stored key, so a reset has to be sent explicitly.
    const toWrite = new Set<BindingKey>([...Object.keys(props.keys).filter((k) => ALL_IDS.includes(k as BindingKey)) as BindingKey[], ...touched])
    setDraft(defaultsSnapshot())
    setTouched(toWrite)
    setRecording(null)
    setCaptureMsg(null)
  }

  const prefix = (draft['leader-prefix'] ?? []).join(' / ') || 'unbound'
  const needle = filter.trim().toLowerCase()

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && props.onCancel()}>
      <div
        className="modal keys-modal"
        onKeyDownCapture={onKeyDownCapture}
        onKeyDown={(e) => {
          // Escape while recording cancels the recording (handled above), not the dialog.
          if (e.key === 'Escape' && recording === null) props.onCancel()
        }}
      >
        <h2>Keybindings</h2>

        <label className="field">
          <span>Filter</span>
          <input
            value={filter}
            placeholder="Search actions…"
            autoFocus
            onChange={(e) => setFilter(e.target.value)}
          />
        </label>

        <div className="keys-scroll">
          {sections.map((section) => {
            const rows = section.rows.filter(
              (r) => needle === '' || r.label.toLowerCase().includes(needle) || (r.hint ?? '').toLowerCase().includes(needle)
            )
            const isLeader = section.title === 'Leader key'
            if (rows.length === 0) return null
            return (
              <div key={section.title}>
                <div className="keys-group-label">{section.title}</div>
                {isLeader && <p className="key-hint">Prefix {prefix} — then press the key.</p>}
                <ul className="keys-list">
                  {rows.map((row) => (
                    <li
                      key={row.id ?? row.label}
                      className={'key-row' + (row.locked ? ' locked' : '')}
                    >
                      <span className="key-row-label" title={row.hint}>
                        {row.label}
                      </span>
                      {row.locked ? (
                        <span className="key-cell locked" title="Fixed: jumps straight to the Nth tab">
                          1 … 9
                        </span>
                      ) : (
                        <RowCells
                          id={row.id as BindingKey}
                          chords={draft[row.id as BindingKey] ?? []}
                          recording={recording === row.id}
                          captureMsg={captureMsg}
                          conflict={conflictByKey.get(row.id as BindingKey) ?? null}
                          labelFor={labelFor}
                          invalid={invalidStored.has(row.id as BindingKey)}
                          leaderKeys={isLeader && row.id !== 'leader-prefix'}
                          prefix={prefix}
                          onStart={() => startRecording(row.id as BindingKey)}
                          onClear={() => setChords(row.id as BindingKey, [])}
                          onReset={() => resetRow(row.id as BindingKey)}
                        />
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}
        </div>

        {conflictCount > 0 && (
          <p className="key-conflict-hint">
            {[...conflictByKey.values()].filter((c, i, all) => all.findIndex((x) => x.signature === c.signature) === i).map((c) => (
              <span key={c.signature}>
                {c.display} is used by {c.keys.map((k) => labelFor(k)).join(' and ')}.{' '}
              </span>
            ))}
            Resolve before saving.
          </p>
        )}

        <div className="modal-actions">
          <button className="ghost" onClick={resetAll}>
            Reset all
          </button>
          <div className="spacer" />
          <button onClick={props.onCancel}>Cancel</button>
          <button className="primary" onClick={apply} disabled={conflictCount > 0}>
            Apply
          </button>
        </div>
      </div>
    </div>
  )
}

interface RowCellsProps {
  id: BindingKey
  chords: string[]
  recording: boolean
  captureMsg: string | null
  conflict: ChordConflict | null
  invalid: boolean
  /** Leader rows show the bare key, and their tooltip names the prefix. */
  leaderKeys: boolean
  prefix: string
  labelFor: (id: BindingKey) => string
  onStart: () => void
  onClear: () => void
  onReset: () => void
}

function RowCells(props: RowCellsProps): ReactElement {
  const overridden = !sameList(props.chords, defaultChords(props.id))
  const clash = props.conflict
    ? `Also bound to ${props.conflict.keys.filter((k) => k !== props.id).map(props.labelFor).join(', ')}. `
    : ''
  const className =
    'key-cell' +
    (props.recording ? ' recording' : '') +
    (props.chords.length === 0 ? ' unbound' : '') +
    (props.conflict ? ' conflict' : '')

  return (
    <>
      {props.recording ? (
        <button type="button" className={className} title="Esc cancels, Backspace clears">
          {props.captureMsg ?? 'Press keys…'}
        </button>
      ) : props.chords.length === 0 ? (
        <button
          type="button"
          className={className}
          title={`${clash}Unbound — click, then press the keys`}
          onClick={props.onStart}
        >
          unbound
        </button>
      ) : (
        props.chords.map((chord) => (
          <button
            key={chord}
            type="button"
            className={className}
            title={
              clash +
              (props.leaderKeys
                ? `${props.prefix} then ${chord} — click, then press the new key`
                : 'Click, then press the new keys')
            }
            onClick={props.onStart}
          >
            {chord}
          </button>
        ))
      )}
      {props.invalid && (
        <span
          className="key-row-note"
          title="This value in config.json could not be used, so the default is in effect"
        >
          invalid in config
        </span>
      )}
      {overridden && !props.recording && (
        <button
          type="button"
          className="key-row-action key-reset"
          title="Reset to default"
          onClick={props.onReset}
        >
          ↺
        </button>
      )}
      {props.chords.length > 0 && !props.recording && (
        <button
          type="button"
          className="key-row-action key-clear"
          title="Clear this binding"
          onClick={props.onClear}
        >
          ✕
        </button>
      )}
    </>
  )
}
