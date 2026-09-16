/** Pure-JS unit test for the renderer mux model + reducer (runs under plain node). */
import * as assert from 'assert'
import {
  insertSplit,
  removeLeaf,
  setRatioAt,
  neighborLeaf,
  countPanes,
  containsPane,
  leafRects,
  paneOrder,
  findResizeSplit,
  resizeRatio
} from '../src/renderer/src/mux-model'
import { muxReducer } from '../src/renderer/src/mux-reducer'
import { DEFAULT_LEADER_KEYS, resolveLeaderKey, resolveResizeKey } from '../src/renderer/src/keys'
import {
  DEFAULT_DIRECT,
  DIRECT_ORDER,
  LEADER_ORDER,
  captureError,
  comboFromEvent,
  comboSignature,
  decideKey,
  findConflicts,
  formatCombo,
  matchDirect,
  matchLeader,
  parseCombo,
  resolveKeymap
} from '../src/renderer/src/keymap'
import type { KeyContext } from '../src/renderer/src/keymap'
import type { Combo } from '../src/renderer/src/keys'
import { assignLabels, findMatches, matchAtColumn, resolveLabel } from '../src/renderer/src/quick-select'
import type { QuickLine } from '../src/renderer/src/quick-select'
import { decodeOsc52 } from '../src/renderer/src/osc52'
import { pointerMoved } from '../src/renderer/src/pointer-move'
import {
  decodeCopyKey,
  emptyCopyState,
  linearSelectionLength,
  moveCopy,
  repeatMove,
  searchFrom,
  selectionRange
} from '../src/renderer/src/copy-mode'
import type { CopyCursor, CopyModeState, CopyView } from '../src/renderer/src/copy-mode'

let passed = 0
function ok(name: string): void {
  passed++
  console.log(`  ok - ${name}`)
}

// --- tree operations ---
let root: { kind: 'pane'; paneId: number } | ReturnType<typeof insertSplit> = { kind: 'pane', paneId: 1 }
root = insertSplit(root, 1, 'row', 2)
assert.strictEqual(countPanes(root), 2)
assert.ok(containsPane(root, 2))

root = insertSplit(root, 1, 'col', 3)
assert.strictEqual(countPanes(root), 3)

const rects = leafRects(root)
assert.strictEqual(rects.size, 3)
const afterRemove = removeLeaf(root, 3)!
assert.strictEqual(countPanes(afterRemove), 2)

const withRatio = setRatioAt(root, ['a', 'b'], 0.3)
assert.ok(withRatio.kind === 'split', 'setRatioAt returns a tree')
ok('tree ops: split/remove/ratio/rects')

// A vertical (top/bottom) split stacks halves, so the divider sits at y=0.5.
const colPair = insertSplit({ kind: 'pane', paneId: 31 }, 31, 'col', 32)
const colRects = leafRects(colPair)
assert.deepStrictEqual(colRects.get(31), { x: 0, y: 0, w: 1, h: 0.5 })
assert.deepStrictEqual(colRects.get(32), { x: 0, y: 0.5, w: 1, h: 0.5 })
// Regression: the root divider has an empty path and must still resize.
const rootRatio = setRatioAt(colPair, [], 0.3)
assert.ok(rootRatio.kind === 'split' && Math.abs(rootRatio.ratio - 0.3) < 1e-9, 'root divider resizes')
// A nested divider still targets the addressed split only.
const nestedRatio = setRatioAt(root, ['a'], 0.7)
assert.ok(
  nestedRatio.kind === 'split' && nestedRatio.a.kind === 'split' && nestedRatio.a.ratio === 0.7,
  'nested divider resizes'
)
assert.ok(nestedRatio.kind === 'split' && root.kind === 'split' && root.ratio === 0.5, 'prior ratio preserved')
ok('leafRects: col split stacks (divider at 50% height)')

// pane cycling + resize helpers (wezterm ActivatePaneDirection / AdjustPaneSize)
const resizeTree = insertSplit(insertSplit({ kind: 'pane', paneId: 41 }, 41, 'row', 42), 42, 'col', 43)
assert.deepStrictEqual(paneOrder(resizeTree), [41, 42, 43])
// pane 41 (left): the row root is the aligned divider; there is no col ancestor.
assert.deepStrictEqual(findResizeSplit(resizeTree, 41, 'left'), { path: [], ratio: 0.5 })
assert.strictEqual(findResizeSplit(resizeTree, 41, 'up'), null)
// pane 42 (bottom-right): row root for left/right, col split ['b'] for up/down.
assert.deepStrictEqual(findResizeSplit(resizeTree, 42, 'right'), { path: [], ratio: 0.5 })
assert.deepStrictEqual(findResizeSplit(resizeTree, 42, 'down'), { path: ['b'], ratio: 0.5 })
// resizeRatio: right/down grow the first child (ratio up), left/up shrink it.
assert.ok(Math.abs(resizeRatio(0.5, 'right') - 0.55) < 1e-9)
assert.ok(Math.abs(resizeRatio(0.5, 'left') - 0.45) < 1e-9)
assert.ok(Math.abs(resizeRatio(0.5, 'down') - 0.55) < 1e-9)
assert.ok(Math.abs(resizeRatio(0.5, 'up') - 0.45) < 1e-9)
assert.strictEqual(resizeRatio(0.08, 'left'), 0.1, 'clamped low')
assert.strictEqual(resizeRatio(0.95, 'right'), 0.9, 'clamped high')
ok('paneOrder / findResizeSplit / resizeRatio')

// neighborLeaf navigation
const pair = insertSplit({ kind: 'pane', paneId: 10 }, 10, 'row', 20)
assert.strictEqual(neighborLeaf(pair, 10, 'right'), 20)
assert.strictEqual(neighborLeaf(pair, 20, 'left'), 10)
assert.strictEqual(neighborLeaf(pair, 10, 'down'), null)
ok('neighborLeaf')

// --- reducer ---
type State = ReturnType<typeof muxReducer>
let state = muxReducer({ tabs: [], activeTabId: null }, {
  type: 'open-tab',
  tabId: 1,
  paneId: 1,
  pendingCreate: { kind: 'local' }
})
assert.strictEqual(state.tabs.length, 1)
assert.strictEqual(state.activeTabId, 1)

state = muxReducer(state, {
  type: 'add-pane',
  tabId: 1,
  targetPaneId: 1,
  orientation: 'col',
  paneId: 2,
  pendingCreate: { kind: 'local' }
})
assert.strictEqual(countPanes(state.tabs[0].root), 2)
assert.strictEqual(state.tabs[0].activePaneId, 2)

state = muxReducer(state, { type: 'attach', paneId: 1, sessionId: 's1', label: 'bash' })
assert.strictEqual(state.tabs[0].panes.get(1)?.sessionId, 's1')
assert.strictEqual(state.tabs[0].panes.get(1)?.kind, 'local')
ok('reducer: open/attach')

// zoom toggles
state = muxReducer(state, { type: 'zoom', paneId: 1 })
assert.strictEqual(state.tabs[0].zoomedPaneId, 1)
state = muxReducer(state, { type: 'zoom', paneId: 1 })
assert.strictEqual(state.tabs[0].zoomedPaneId, null)
ok('reducer: zoom toggle')

// Switching pane while zoomed must unzoom (wezterm unzoom_on_switch_pane).
let zs: State = muxReducer({ tabs: [], activeTabId: null }, {
  type: 'open-tab',
  tabId: 30,
  paneId: 300,
  pendingCreate: { kind: 'local' }
})
zs = muxReducer(zs, { type: 'add-pane', tabId: 30, targetPaneId: 300, orientation: 'row', paneId: 301, pendingCreate: { kind: 'local' } })
zs = muxReducer(zs, { type: 'zoom', paneId: 300 })
assert.strictEqual(zs.tabs[0].zoomedPaneId, 300)
zs = muxReducer(zs, { type: 'focus-pane', paneId: 301 })
assert.strictEqual(zs.tabs[0].zoomedPaneId, null, 'focus switch unzooms')
assert.strictEqual(zs.tabs[0].activePaneId, 301)
// Re-focusing the zoomed pane itself keeps the zoom.
zs = muxReducer(zs, { type: 'zoom', paneId: 301 })
zs = muxReducer(zs, { type: 'focus-pane', paneId: 301 })
assert.strictEqual(zs.tabs[0].zoomedPaneId, 301, 'same pane keeps zoom')
// Splitting while zoomed also unzooms so the new pane is visible.
zs = muxReducer(zs, { type: 'add-pane', tabId: 30, targetPaneId: 301, orientation: 'col', paneId: 302, pendingCreate: { kind: 'local' } })
assert.strictEqual(zs.tabs[0].zoomedPaneId, null, 'split unzooms')
ok('reducer: zoom + pane switch/split unzoom')

// focus + title + cwd + prompt
state = muxReducer(state, { type: 'focus-pane', paneId: 1 })
assert.strictEqual(state.tabs[0].activePaneId, 1)
state = muxReducer(state, { type: 'title', paneId: 1, title: 'vim' })
assert.strictEqual(state.tabs[0].panes.get(1)?.title, 'vim')
state = muxReducer(state, { type: 'cwd', paneId: 1, cwd: '/tmp' })
assert.strictEqual(state.tabs[0].panes.get(1)?.cwd, '/tmp')
state = muxReducer(state, { type: 'prompt', sessionId: 's1', prompt: { promptId: 'p1', text: 'Password: ', echo: false } })
assert.strictEqual(state.tabs[0].panes.get(1)?.prompt?.promptId, 'p1')
state = muxReducer(state, { type: 'prompt-done', promptId: 'p1' })
assert.strictEqual(state.tabs[0].panes.get(1)?.prompt, null)
ok('reducer: focus/title/cwd/prompt')

// ssh pane split inherits sshOpts
state = muxReducer(state, {
  type: 'attach',
  paneId: 2,
  sessionId: 'ssh1',
  label: 'u@h'
})
state = muxReducer(state, {
  type: 'open-tab',
  tabId: 2,
  paneId: 99,
  pendingCreate: { kind: 'ssh', target: 'u@h:2222' }
})
state = muxReducer(state, { type: 'attach', paneId: 99, sessionId: 'ssh99', label: 'u@h:2222' })
assert.strictEqual(state.tabs[1].panes.get(99)?.sshOpts?.target, 'u@h:2222')
assert.strictEqual(state.tabs[1].panes.get(99)?.kind, 'ssh')
ok('reducer: ssh attach keeps sshOpts')

// A panel spawned with an inherited directory seeds cwd at creation, so the
// chain keeps going even if the shell never reports one of its own (OSC 7).
state = muxReducer(state, { type: 'cwd', paneId: 99, cwd: '/srv/app' })
state = muxReducer(state, {
  type: 'add-pane',
  tabId: 2,
  targetPaneId: 99,
  orientation: 'row',
  paneId: 100,
  pendingCreate: { kind: 'ssh', target: 'u@h:2222', cwd: '/srv/app' }
})
assert.strictEqual(state.tabs[1].panes.get(100)?.cwd, '/srv/app', 'inherited cwd seeded at creation')
assert.strictEqual(state.tabs[1].panes.get(99)?.cwd, '/srv/app', 'source pane keeps its cwd')
let plain: State = muxReducer({ tabs: [], activeTabId: null }, {
  type: 'open-tab',
  tabId: 9,
  paneId: 900,
  pendingCreate: { kind: 'ssh', target: 'u@h' }
})
assert.strictEqual(plain.tabs[0].panes.get(900)?.cwd, null, 'no inherited directory stays null')
plain = muxReducer(plain, { type: 'cwd', paneId: 900, cwd: '/var/log' })
assert.strictEqual(plain.tabs[0].panes.get(900)?.cwd, '/var/log', 'OSC 7 still overrides the seed')
ok('reducer: inherited cwd seeded on new panes')

// closing the only pane closes the tab
let single: State = muxReducer({ tabs: [], activeTabId: null }, {
  type: 'open-tab',
  tabId: 7,
  paneId: 7,
  pendingCreate: { kind: 'local' }
})
single = muxReducer(single, { type: 'close-pane', paneId: 7 })
assert.strictEqual(single.tabs.length, 0)
ok('reducer: closing only pane closes tab')

// close-pane collapses tree
let tree: State = muxReducer({ tabs: [], activeTabId: null }, {
  type: 'open-tab',
  tabId: 8,
  paneId: 10,
  pendingCreate: { kind: 'local' }
})
tree = muxReducer(tree, { type: 'add-pane', tabId: 8, targetPaneId: 10, orientation: 'row', paneId: 11, pendingCreate: { kind: 'local' } })
tree = muxReducer(tree, { type: 'add-pane', tabId: 8, targetPaneId: 11, orientation: 'col', paneId: 12, pendingCreate: { kind: 'local' } })
assert.strictEqual(countPanes(tree.tabs[0].root), 3)
tree = muxReducer(tree, { type: 'close-pane', paneId: 11 })
assert.strictEqual(countPanes(tree.tabs[0].root), 2)
assert.ok(!containsPane(tree.tabs[0].root, 11))
ok('reducer: close-pane collapses split')

// --- leader key (Alt+N prefix) ---
const ev = (key: string, mods: Partial<{ ctrl: boolean; alt: boolean; meta: boolean; shift: boolean }> = {}) => ({
  key,
  ctrlKey: !!mods.ctrl,
  altKey: !!mods.alt,
  metaKey: !!mods.meta,
  shiftKey: !!mods.shift
})
// Regression: Shift+- fires a bare "Shift" keydown first; it must not cancel leader.
assert.deepStrictEqual(resolveLeaderKey(ev('Shift', { shift: true })), { kind: 'ignore' })
assert.deepStrictEqual(resolveLeaderKey(ev('Control', { ctrl: true })), { kind: 'ignore' })
assert.deepStrictEqual(resolveLeaderKey(ev('Alt', { alt: true })), { kind: 'ignore' })
// Then the real key resolves the split commands (both the `_` and `-`+shift forms).
assert.deepStrictEqual(resolveLeaderKey(ev('_', { shift: true })), { kind: 'action', action: 'split-row' })
assert.deepStrictEqual(resolveLeaderKey(ev('-', { shift: true })), { kind: 'action', action: 'split-row' })
assert.deepStrictEqual(resolveLeaderKey(ev('-')), { kind: 'action', action: 'split-col' })
assert.deepStrictEqual(resolveLeaderKey(ev('C', { shift: true })), { kind: 'action', action: 'new-tab' })
assert.deepStrictEqual(resolveLeaderKey(ev('x')), { kind: 'action', action: 'close-pane' })
assert.deepStrictEqual(resolveLeaderKey(ev('X', { shift: true })), { kind: 'action', action: 'close-pane' })
assert.deepStrictEqual(resolveLeaderKey(ev('z')), { kind: 'action', action: 'toggle-zoom' })
assert.deepStrictEqual(resolveLeaderKey(ev(',')), { kind: 'action', action: 'rename-tab' })
assert.deepStrictEqual(resolveResizeKey(ev('h')), { kind: 'resize', action: 'left' })
assert.deepStrictEqual(resolveResizeKey(ev('l')), { kind: 'resize', action: 'right' })
assert.deepStrictEqual(resolveResizeKey(ev('k')), { kind: 'resize', action: 'up' })
assert.deepStrictEqual(resolveResizeKey(ev('j')), { kind: 'resize', action: 'down' })
assert.deepStrictEqual(resolveResizeKey(ev('Shift', { shift: true })), { kind: 'ignore' })
assert.deepStrictEqual(resolveResizeKey(ev('q')), { kind: 'exit' })
assert.deepStrictEqual(resolveLeaderKey(ev('n')), { kind: 'action', action: 'next-tab' })
assert.deepStrictEqual(resolveLeaderKey(ev('p')), { kind: 'action', action: 'prev-tab' })
assert.deepStrictEqual(resolveLeaderKey(ev('3')), { kind: 'tab-index', index: 3 })
assert.deepStrictEqual(resolveLeaderKey(ev('0')), { kind: 'cancel' })
assert.deepStrictEqual(resolveLeaderKey(ev('h')), { kind: 'action', action: 'focus-left' })
assert.deepStrictEqual(resolveLeaderKey(ev('j')), { kind: 'action', action: 'focus-down' })
assert.deepStrictEqual(resolveLeaderKey(ev('k')), { kind: 'action', action: 'focus-up' })
assert.deepStrictEqual(resolveLeaderKey(ev('l')), { kind: 'action', action: 'focus-right' })
assert.deepStrictEqual(resolveLeaderKey(ev('r')), { kind: 'action', action: 'resize-mode' })
// Any other key leaves leader mode.
assert.deepStrictEqual(resolveLeaderKey(ev('q')), { kind: 'cancel' })
assert.deepStrictEqual(resolveLeaderKey(ev('-', { ctrl: true })), { kind: 'cancel' })
ok('leader key: Shift+- splits row, bare Shift ignored, x closes pane, z zooms, , renames, n/p/1-9/hjkl/r')

// rename-tab sets/clears the custom tab name.
let named: State = muxReducer({ tabs: [], activeTabId: null }, {
  type: 'open-tab',
  tabId: 20,
  paneId: 200,
  pendingCreate: { kind: 'local' }
})
assert.strictEqual(named.tabs[0].title, null, 'tab starts with no custom title')
named = muxReducer(named, { type: 'rename-tab', tabId: 20, title: 'build' })
assert.strictEqual(named.tabs[0].title, 'build')
named = muxReducer(named, { type: 'rename-tab', tabId: 20, title: null })
assert.strictEqual(named.tabs[0].title, null)
ok('reducer: rename-tab')

// --- copy mode (Alt+X) ---
const copyLines = ['hello world', '  foo bar baz', 'last']
const copyView: CopyView = {
  lineCount: copyLines.length,
  cols: 20,
  rows: 2,
  lineText: (y: number) => (copyLines[y] ?? '').padEnd(20, ' ')
}
const at = (x: number, y: number): CopyCursor => ({ x, y })
const base: CopyModeState = { active: true, cursor: at(0, 0), anchor: null, mode: 'cell' }
const move = (s: CopyModeState, a: Parameters<typeof moveCopy>[1], n = 1): CopyModeState => repeatMove(s, a, n, copyView)

// hjkl + arrows clamp within the buffer/line.
assert.deepStrictEqual(move(base, 'moveRight').cursor, at(1, 0))
assert.deepStrictEqual(move({ ...base, cursor: at(0, 0) }, 'moveLeft').cursor, at(0, 0))
assert.deepStrictEqual(move({ ...base, cursor: at(5, 2) }, 'moveDown').cursor, at(5, 2))
assert.deepStrictEqual(move({ ...base, cursor: at(5, 0) }, 'moveUp').cursor, at(5, 0))
assert.deepStrictEqual(move(base, 'pageDown').cursor, at(0, 2)) // rows = 2
ok('copy mode: hjkl/page movement')

// Word motions (w/b/e) across lines.
assert.deepStrictEqual(move(base, 'forwardWord').cursor, at(6, 0))
assert.deepStrictEqual(move({ ...base, cursor: at(6, 0) }, 'forwardWord').cursor, at(2, 1))
assert.deepStrictEqual(move({ ...base, cursor: at(6, 0) }, 'backwardWord').cursor, at(0, 0))
assert.deepStrictEqual(move(base, 'forwardWordEnd').cursor, at(4, 0))
assert.deepStrictEqual(move({ ...base, cursor: at(4, 0) }, 'forwardWordEnd').cursor, at(10, 0))
assert.deepStrictEqual(move(base, 'forwardWord', 5).cursor.y, 2) // Alt+w = 5x
ok('copy mode: word motions (w/b/e, Alt repeat)')

// Line/buffer jumps.
assert.deepStrictEqual(move({ ...base, cursor: at(3, 0) }, 'lineStart').cursor, at(0, 0))
assert.deepStrictEqual(move({ ...base, cursor: at(3, 0) }, 'lineEnd').cursor, at(10, 0))
assert.deepStrictEqual(move({ ...base, cursor: at(0, 1) }, 'lineStartContent').cursor, at(2, 1))
assert.deepStrictEqual(move({ ...base, cursor: at(5, 1) }, 'bufferTop').cursor, at(0, 0))
assert.deepStrictEqual(move({ ...base, cursor: at(0, 0) }, 'bufferBottom').cursor, at(3, 2))
ok('copy mode: H/L/^/g/G')

// Selection range + linear length.
const cellSel: CopyModeState = { ...base, anchor: at(0, 0), cursor: at(4, 0), mode: 'cell' }
assert.deepStrictEqual(selectionRange(cellSel), { start: at(0, 0), end: at(4, 0) })
assert.strictEqual(linearSelectionLength(selectionRange(cellSel)!, copyView.cols), 5)
// Reversed selection normalizes.
const rev: CopyModeState = { ...base, anchor: at(6, 1), cursor: at(2, 1), mode: 'cell' }
assert.deepStrictEqual(selectionRange(rev), { start: at(2, 1), end: at(6, 1) })
// Line mode spans whole lines.
const lineSel: CopyModeState = { ...base, anchor: at(6, 0), cursor: at(2, 2), mode: 'line' }
assert.deepStrictEqual(selectionRange(lineSel), { start: at(0, 0), end: at(0, 2) })
assert.deepStrictEqual(selectionRange(base), null)
ok('copy mode: selection range/length')

// Search wraps and moves to the match.
assert.deepStrictEqual(searchFrom(copyView, at(0, 0), 'bar', true), at(6, 1))
assert.deepStrictEqual(searchFrom(copyView, at(6, 1), 'hello', true), at(0, 0))
assert.deepStrictEqual(searchFrom(copyView, at(6, 1), 'bar', false), at(6, 1))
assert.strictEqual(searchFrom(copyView, at(0, 0), 'nope', true), null)
ok('copy mode: search + wrap')

// Key decoding matches the wezterm copy_mode table.
const kev = (key: string, mods: Partial<{ ctrl: boolean; alt: boolean; shift: boolean }> = {}) => ({
  key,
  ctrlKey: !!mods.ctrl,
  altKey: !!mods.alt,
  metaKey: false,
  shiftKey: !!mods.shift
})
assert.deepStrictEqual(decodeCopyKey(kev('h')), { type: 'move', action: 'moveLeft' })
assert.deepStrictEqual(decodeCopyKey(kev('ArrowDown')), { type: 'move', action: 'moveDown' })
assert.deepStrictEqual(decodeCopyKey(kev('w', { alt: true })), { type: 'move', action: 'forwardWord', repeat: 5 })
assert.deepStrictEqual(decodeCopyKey(kev('u', { ctrl: true })), { type: 'move', action: 'pageUp' })
assert.deepStrictEqual(decodeCopyKey(kev('d', { ctrl: true })), { type: 'move', action: 'pageDown' })
assert.deepStrictEqual(decodeCopyKey(kev('v', { ctrl: true })), { type: 'mode', mode: 'block' })
assert.deepStrictEqual(decodeCopyKey(kev('V', { shift: true })), { type: 'mode', mode: 'line' })
assert.deepStrictEqual(decodeCopyKey(kev('v')), { type: 'mode', mode: 'cell' })
assert.deepStrictEqual(decodeCopyKey(kev('y')), { type: 'copy' })
assert.deepStrictEqual(decodeCopyKey(kev('q')), { type: 'close' })
assert.deepStrictEqual(decodeCopyKey(kev('Escape')), { type: 'close' })
assert.deepStrictEqual(decodeCopyKey(kev('/')), { type: 'search' })
assert.deepStrictEqual(decodeCopyKey(kev('N', { shift: true })), { type: 'priorMatch' })
assert.strictEqual(decodeCopyKey(kev('z')), null)
ok('copy mode: key decoding')
assert.strictEqual(emptyCopyState.active, false)

// --- quick select (Alt+I / wezterm QuickSelectArgs) ---
const qline = (row: number, text: string): QuickLine => ({ row, text, columns: text.split('').map((_, i) => i) })
const qlines = [qline(0, 'see https://example.com/x and ./a-b_c'), qline(1, 'plain')]
assert.deepStrictEqual(
  findMatches(qlines).map((m) => m.text),
  ['see', 'https://example.com/x', 'and', './a-b_c', 'plain']
)
// Column mapping accounts for wide (double-width) characters before a match.
const wide: QuickLine = { row: 5, text: '中 abc', columns: [0, 2, 3, 4, 5] }
assert.deepStrictEqual(findMatches([wide]), [{ text: 'abc', row: 5, col: 3, width: 3 }])
// Labels are fixed-width so no label prefixes another.
assert.deepStrictEqual(assignLabels(0), [])
assert.deepStrictEqual(assignLabels(3), ['a', 'b', 'c'])
assert.strictEqual(assignLabels(27).length, 27)
assert.strictEqual(assignLabels(27)[0], 'aa')
assert.deepStrictEqual(resolveLabel(['a', 'b', 'c'], 'a'), { kind: 'commit', index: 0 })
assert.deepStrictEqual(resolveLabel(['a', 'b', 'c'], ''), { kind: 'pending' })
assert.deepStrictEqual(resolveLabel(['a', 'b', 'c'], 'z'), { kind: 'none' })
assert.deepStrictEqual(resolveLabel(assignLabels(30), 'a'), { kind: 'pending' })
assert.deepStrictEqual(resolveLabel(assignLabels(30), 'aa'), { kind: 'commit', index: 0 })
ok('quick select: matches / labels / resolution')

// --- double-click selects by the same rules (no second word-splitting rule) ---
const codeLine = qline(9, 'in /usr/local/foo.cc:12 call foo_bar(baz)')
const mAt = (col: number): string | null => matchAtColumn(codeLine, col)?.text ?? null
// A path is one token, including its slashes and dots -- xterm's own rule (and
// its `:`-free wordSeparator) would have cut it into pieces.
assert.strictEqual(mAt(6), '/usr/local/foo.cc')
assert.strictEqual(mAt(18), '/usr/local/foo.cc')
// Past the path: `:` separates, so the line number is its own token.
assert.strictEqual(mAt(22), '12')
assert.strictEqual(mAt(24), 'call')
assert.strictEqual(mAt(32), 'foo_bar')
assert.strictEqual(mAt(38), 'baz')
assert.strictEqual(mAt(0), 'in')
// Whitespace matches nothing, so the click falls back to xterm's own behaviour.
assert.strictEqual(matchAtColumn(codeLine, 23), null)
assert.strictEqual(matchAtColumn(qline(0, '   '), 1), null)
// A URL wins over the path alternative, exactly as in the overlay.
const urlLine = qline(2, 'see https://example.com/a/b now')
assert.strictEqual(matchAtColumn(urlLine, 20)?.text, 'https://example.com/a/b')
assert.strictEqual(matchAtColumn(urlLine, 4)?.text, 'https://example.com/a/b')
assert.strictEqual(matchAtColumn(urlLine, 1)?.text, 'see')
// Wide characters: the column range covers both cells of a double-width glyph,
// so a click on either half resolves to the same token.
const wideLine: QuickLine = { row: 3, text: '中 abc', columns: [0, 2, 3, 4, 5] }
assert.strictEqual(matchAtColumn(wideLine, 3)?.text, 'abc')
assert.strictEqual(matchAtColumn(wideLine, 5)?.text, 'abc')
assert.strictEqual(matchAtColumn(wideLine, 1), null) // trailing half of 中
ok('quick select: matchAtColumn (double-click token rule)')

// --- OSC 52 (clipboard writes from the terminal) ---
// Payload shape as xterm's parser delivers it: `52;` and the terminator stripped.
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')
assert.strictEqual(decodeOsc52(`c;${b64('hello')}`), 'hello')
// An empty selection target means the clipboard, same as `c`.
assert.strictEqual(decodeOsc52(`;${b64('hello')}`), 'hello')
// Non-ASCII survives as UTF-8 rather than being mangled to latin1.
assert.strictEqual(decodeOsc52(`c;${b64('中文 → ok')}`), '中文 → ok')
assert.strictEqual(decodeOsc52(`c;${b64('line1\nline2')}`), 'line1\nline2')
// An empty payload clears the clipboard -- that is a legitimate write, not a no-op.
assert.strictEqual(decodeOsc52('c;'), '')
// `?` asks us to *read* the local clipboard back; refused so an SSH peer cannot exfiltrate it.
assert.strictEqual(decodeOsc52('c;?'), null)
// Other selections (primary, select, cut buffers 0-7) have no local equivalent.
assert.strictEqual(decodeOsc52(`p;${b64('x')}`), null)
assert.strictEqual(decodeOsc52(`s;${b64('x')}`), null)
assert.strictEqual(decodeOsc52(`0;${b64('x')}`), null)
// Malformed input is ignored rather than throwing.
assert.strictEqual(decodeOsc52(b64('no separator')), null)
assert.strictEqual(decodeOsc52('c;not!valid!base64'), null)
assert.strictEqual(decodeOsc52(`c;${'A'.repeat(100 * 1024 + 1)}`), null)
// A truncated UTF-8 sequence still copies what arrived instead of nothing.
const truncated = Buffer.from([0xe4, 0xb8]).toString('base64') // 2 of the 3 bytes of '中'
assert.strictEqual(decodeOsc52(`c;${truncated}`), '�')
ok('osc 52: decode / selection / read refusal')

// --- focus follows the mouse, not the window (Alt+Tab must not steal focus) ---
assert.strictEqual(pointerMoved(null, { x: 40, y: 12 }), true, 'first position seen counts as a move')
// What the browser re-delivers on window activation: same coordinates, no movement.
assert.strictEqual(pointerMoved({ x: 40, y: 12 }, { x: 40, y: 12 }), false, 're-delivered position is not a move')
// Real movement, in both axes, in either direction.
assert.strictEqual(pointerMoved({ x: 40, y: 12 }, { x: 41, y: 12 }), true, 'move right')
assert.strictEqual(pointerMoved({ x: 40, y: 12 }, { x: 40, y: 11 }), true, 'move up')
assert.strictEqual(pointerMoved({ x: 40, y: 12 }, { x: 399, y: 480 }), true, 'move across panes')
// Sub-pixel positions stay comparable (Chromium reports fractional clientX/Y on
// scaled displays, and a move of less than a pixel is still the user moving).
assert.strictEqual(pointerMoved({ x: 40.5, y: 12 }, { x: 40.5, y: 12 }), false, 'same fractional position')
assert.strictEqual(pointerMoved({ x: 40.5, y: 12 }, { x: 40.75, y: 12 }), true, 'fractional move')
ok('pointerMoved: real movement vs. re-delivered position')

// --- keymap: chord grammar ---
const chordsOf = (id: string): string[] =>
  id.startsWith('leader.') ? (DEFAULT_LEADER_KEYS as Record<string, string[]>)[id.slice(7)] : DEFAULT_DIRECT[id as never]
const parseOk = (s: string): string => {
  const c = parseCombo(s)
  assert.ok(c !== null, `parses ${s}`)
  return formatCombo(c as Combo)
}
// Every default chord survives a parse/format round trip, verbatim.
for (const id of DIRECT_ORDER) for (const chord of chordsOf(id)) assert.strictEqual(parseOk(chord), chord, `${id}: ${chord}`)
for (const action of LEADER_ORDER) for (const chord of chordsOf(`leader.${action}`)) assert.strictEqual(parseOk(chord), chord, `leader.${action}: ${chord}`)
// Non-canonical input re-emits canonically (modifier order fixed, key case preserved).
assert.strictEqual(parseOk('shift+ctrl+t'), 'Ctrl+Shift+t')
assert.strictEqual(parseOk('option+ArrowUp'), 'Alt+ArrowUp')
// A literal '+' key survives the rejoin.
assert.strictEqual(parseOk('Ctrl++'), 'Ctrl++')
// Rejections: a trailing '+', an unknown modifier, a bare modifier, nothing at all.
assert.strictEqual(parseCombo('Ctrl+'), null)
assert.strictEqual(parseCombo('Foo+Bar'), null)
assert.strictEqual(parseCombo('Shift'), null)
assert.strictEqual(parseCombo(''), null)
assert.strictEqual(parseCombo('   '), null)
// The tables and the defaults cannot drift apart.
assert.strictEqual(new Set(DIRECT_ORDER).size, DIRECT_ORDER.length)
assert.strictEqual(new Set(LEADER_ORDER).size, LEADER_ORDER.length)
for (const id of DIRECT_ORDER) assert.ok(Array.isArray(DEFAULT_DIRECT[id]), `defaults for ${id}`)
ok('keymap: chord parse/format round trip and the rejection set')

// --- keymap: conflict signature ---
// Ctrl and Meta are one axis (the matcher cannot tell them apart), and a shifted
// character folds onto the physical key that produced it.
assert.strictEqual(
  comboSignature(parseCombo('Ctrl+T') as Combo),
  comboSignature(parseCombo('Meta+t') as Combo),
  'Ctrl and Meta fold'
)
assert.strictEqual(
  comboSignature(parseCombo('Ctrl+Shift+5') as Combo),
  comboSignature(parseCombo('Ctrl+Shift+%') as Combo),
  'the same physical key folds together'
)
assert.notStrictEqual(
  comboSignature(parseCombo('Ctrl+T') as Combo),
  comboSignature(parseCombo('Ctrl+Shift+T') as Combo),
  'Shift keeps chords distinct'
)
ok('keymap: conflict signature folds Ctrl/Meta and shifted characters')

// --- keymap: defaults reproduce the old if-chain ---
const km0 = resolveKeymap({})
const eventFor = (c: Combo) => ({
  key: c.key,
  ctrlKey: c.mods.includes('Ctrl'),
  altKey: c.mods.includes('Alt'),
  metaKey: c.mods.includes('Meta'),
  shiftKey: c.mods.includes('Shift')
})
for (const id of DIRECT_ORDER) {
  for (const chord of chordsOf(id)) {
    const combo = parseCombo(chord) as Combo
    assert.strictEqual(matchDirect(eventFor(combo), km0), id, `${chord} -> ${id}`)
  }
}
// The alias pairs are load-bearing: a layout may report either spelling.
assert.strictEqual(matchDirect({ key: '"', ctrlKey: true, shiftKey: true, altKey: true, metaKey: false }, km0), 'split-col')
assert.strictEqual(matchDirect({ key: "'", ctrlKey: true, shiftKey: true, altKey: true, metaKey: false }, km0), 'split-col')
assert.strictEqual(matchDirect({ key: '5', ctrlKey: true, shiftKey: true, altKey: true, metaKey: false }, km0), 'split-row')
assert.strictEqual(matchDirect({ key: '%', ctrlKey: true, shiftKey: true, altKey: true, metaKey: false }, km0), 'split-row')
assert.strictEqual(matchDirect(ev('Tab', { ctrl: true }), km0), 'next-tab')
assert.strictEqual(matchDirect(ev('PageDown', { ctrl: true }), km0), 'next-tab')
assert.strictEqual(matchDirect(ev('Tab', { ctrl: true, shift: true }), km0), 'prev-tab')
assert.strictEqual(matchDirect(ev('PageUp', { ctrl: true }), km0), 'prev-tab')
ok('keymap: every default chord resolves to its action, aliases included')

// --- keymap: ordinary typing must not fire a binding ---
for (const e of [
  ev('a'),
  ev('t'),
  ev('Enter'),
  ev('Escape'),
  ev('Tab'),
  ev('F5'),
  ev(' '),
  ev('c', { ctrl: true }),
  ev('v', { ctrl: true }),
  ev('t', { ctrl: true }),
  ev('5', { ctrl: true, shift: true }),
  ev('t', { ctrl: true, shift: true, alt: true }),
  ev('q', { alt: true })
]) {
  assert.strictEqual(matchDirect(e, km0), null, `no binding for ${JSON.stringify(e)}`)
}
ok('keymap: ordinary typing and near-miss chords match nothing')

// --- keymap: physical-key fallback for odd layouts ---
// The original code accepted `e.code === 'KeyN'` for the leader arm; that fallback is
// now general, so Alt+N still arms leader on a layout that reports another key.
assert.strictEqual(matchDirect({ ...ev('n', { alt: true }), key: 'ń', code: 'KeyN' }, km0), 'leader-prefix')
assert.strictEqual(matchDirect({ ...ev('j', { ctrl: true, alt: true }), key: 'ј', code: 'KeyJ' }, km0), null)
ok('keymap: alphanumeric bindings fall back to the physical key')

// --- keymap: config overrides ---
const km1 = resolveKeymap({ 'new-tab': ['Ctrl+J'] })
assert.strictEqual(matchDirect(ev('j', { ctrl: true }), km1), 'new-tab')
assert.strictEqual(matchDirect(ev('t', { ctrl: true, shift: true }), km1), null, 'an override replaces, it does not add')
// [] and '' both mean explicitly unbound.
assert.strictEqual(matchDirect(ev('t', { ctrl: true, shift: true }), resolveKeymap({ 'new-tab': [] })), null)
assert.strictEqual(matchDirect(ev('j', { ctrl: true }), resolveKeymap({ 'new-tab': [] })), null)
// A hand-edited config may write a bare string; the reader is tolerant, the writer is not.
assert.strictEqual(matchDirect(ev('j', { ctrl: true }), resolveKeymap({ 'next-tab': 'Ctrl+J' })), 'next-tab')
assert.strictEqual(matchDirect(ev('Tab', { ctrl: true }), resolveKeymap({ 'next-tab': 'Ctrl+J' })), null)
assert.strictEqual(matchDirect(ev('Tab', { ctrl: true }), resolveKeymap({ 'next-tab': '' })), null)
// A sparse override leaves every other default intact (this is what deepMerge does).
const km5 = resolveKeymap({ 'close-pane': ['Ctrl+Alt+X'] })
assert.strictEqual(matchDirect(ev('t', { ctrl: true, shift: true }), km5), 'new-tab')
assert.strictEqual(matchDirect(ev('w', { ctrl: true, shift: true }), km5), null)
assert.strictEqual(matchDirect(ev('x', { ctrl: true, alt: true }), km5), 'close-pane')
// Unusable values fall back to the default *and* are reported, so a typo can never
// leave an action unreachable.
const km6 = resolveKeymap({ 'new-tab': ['Ctrl+'] })
assert.strictEqual(matchDirect(ev('t', { ctrl: true, shift: true }), km6), 'new-tab')
assert.ok(km6.invalid.includes('new-tab'))
// A bare key would swallow typing, so it is refused too.
const km7 = resolveKeymap({ 'new-tab': ['t'] })
assert.strictEqual(matchDirect(ev('t'), km7), null)
assert.strictEqual(matchDirect(ev('t', { ctrl: true, shift: true }), km7), 'new-tab')
assert.ok(km7.invalid.includes('new-tab'))
// A leader key cannot carry Ctrl/Alt (the decoder requires them up), and the prefix
// must carry one or the leader table would eat ordinary typing.
const km8 = resolveKeymap({ 'leader.new-tab': ['Ctrl+T'] })
assert.ok(km8.invalid.includes('leader.new-tab'))
assert.deepStrictEqual(matchLeader(ev('c'), km8), { kind: 'action', action: 'new-tab' })
assert.ok(resolveKeymap({ 'leader-prefix': ['n'] }).invalid.includes('leader-prefix'))
ok('keymap: overrides replace, unbind, tolerate strings and report invalid values')

// --- keymap: conflict detection ---
assert.deepStrictEqual(findConflicts(km0), [], 'the defaults never conflict')
const dup = resolveKeymap({ 'new-tab': ['Ctrl+Alt+J'], 'new-ssh': ['Ctrl+Alt+J'] })
assert.strictEqual(dup && findConflicts(dup).length, 1)
assert.deepStrictEqual(findConflicts(dup)[0].keys.slice().sort(), ['new-ssh', 'new-tab'])
// Case and modifier order are not a difference.
assert.strictEqual(findConflicts(resolveKeymap({ 'new-tab': ['ctrl+alt+j'], 'new-ssh': ['Alt+Ctrl+J'] })).length, 1)
// Adding Shift makes it a different chord.
assert.deepStrictEqual(findConflicts(resolveKeymap({ 'new-tab': ['Ctrl+T'] })), [])
// Two spellings of one physical key are one chord.
const phys = findConflicts(resolveKeymap({ 'split-row': ['Ctrl+Shift+5'], 'split-col': ['Ctrl+Shift+%'] }))
assert.strictEqual(phys.length, 1)
assert.deepStrictEqual(phys[0].keys.slice().sort(), ['split-col', 'split-row'])
// An unbound action never conflicts, and duplicates inside one action's own list are
// not a conflict either.
assert.deepStrictEqual(findConflicts(resolveKeymap({ 'new-ssh': [] })), [])
assert.deepStrictEqual(findConflicts(resolveKeymap({ 'new-tab': ['Ctrl+J', 'cTrL+j'] })), [])
// Leader entries conflict with each other, in their own namespace.
const leadDup = findConflicts(resolveKeymap({ 'leader.new-tab': ['q'], 'leader.close-pane': ['q'] }))
assert.strictEqual(leadDup.length, 1)
assert.deepStrictEqual(leadDup[0].keys.slice().sort(), ['leader.close-pane', 'leader.new-tab'])
// A direct Ctrl+T and a leader `t` are not in conflict: different moments.
assert.deepStrictEqual(findConflicts(resolveKeymap({ 'new-tab': ['Ctrl+T'], 'leader.resize-mode': ['t'] })), [])
ok('keymap: conflicts are detected per namespace and fold physical keys')

// --- keymap: leader table is configurable ---
const kmL = resolveKeymap({ 'leader.new-tab': ['t'] })
assert.deepStrictEqual(matchLeader(ev('t'), kmL), { kind: 'action', action: 'new-tab' })
assert.deepStrictEqual(matchLeader(ev('c'), kmL), { kind: 'cancel' }, 'the old key is released')
assert.deepStrictEqual(matchLeader(ev('4'), kmL), { kind: 'tab-index', index: 4 }, 'the digit range is fixed')
assert.deepStrictEqual(matchLeader(ev('z'), kmL), { kind: 'action', action: 'toggle-zoom' })
// Shift stays insignificant for leader keys: Shift+- and - are told apart by the
// character they produce, and Shift+c is still `c`.
assert.deepStrictEqual(matchLeader(ev('-', { shift: true }), kmL), { kind: 'action', action: 'split-row' })
assert.deepStrictEqual(matchLeader(ev('_', { shift: true }), kmL), { kind: 'action', action: 'split-row' })
assert.deepStrictEqual(matchLeader(ev('-'), kmL), { kind: 'action', action: 'split-col' })
assert.deepStrictEqual(matchLeader(ev('C', { shift: true }), kmL), { kind: 'cancel' })
assert.deepStrictEqual(matchLeader(ev('Shift', { shift: true }), kmL), { kind: 'ignore' })
assert.deepStrictEqual(matchLeader(ev('-', { ctrl: true }), kmL), { kind: 'cancel' })
// The prefix itself is rebindable.
const kmP = resolveKeymap({ 'leader-prefix': ['Ctrl+B'] })
assert.strictEqual(matchDirect(ev('b', { ctrl: true }), kmP), 'leader-prefix')
assert.strictEqual(matchDirect(ev('n', { alt: true }), kmP), null)
ok('keymap: leader table and prefix are configurable, digits stay fixed')

// --- keymap: dispatch precedence ---
const keyCtx = (over: Partial<KeyContext> = {}): KeyContext => ({
  hasTerminal: true,
  copyMode: false,
  quickSelect: false,
  resizeMode: false,
  leaderArmed: false,
  ...over
})
assert.deepStrictEqual(decideKey(ev('x', { alt: true }), keyCtx(), km0), { kind: 'copy-mode-toggle' })
assert.deepStrictEqual(decideKey(ev('x', { alt: true }), keyCtx({ copyMode: true }), km0), { kind: 'copy-mode-toggle' })
// Without a terminal handle the entry chord falls through, exactly as before.
assert.deepStrictEqual(decideKey(ev('x', { alt: true }), keyCtx({ hasTerminal: false }), km0), { kind: 'pass' })
// An active modal pane owns every keystroke.
assert.deepStrictEqual(decideKey(ev('t', { ctrl: true, shift: true }), keyCtx({ copyMode: true }), km0), { kind: 'copy-mode-key' })
assert.deepStrictEqual(decideKey(ev('i', { alt: true }), keyCtx({ quickSelect: true }), km0), { kind: 'quick-select-toggle' })
assert.deepStrictEqual(decideKey(ev('a'), keyCtx({ quickSelect: true }), km0), { kind: 'quick-select-key' })
// Resize mode, including its bare-modifier passthrough.
assert.deepStrictEqual(decideKey(ev('h'), keyCtx({ resizeMode: true }), km0), { kind: 'resize', action: 'left' })
assert.deepStrictEqual(decideKey(ev('q'), keyCtx({ resizeMode: true }), km0), { kind: 'resize-exit' })
assert.deepStrictEqual(decideKey(ev('Shift', { shift: true }), keyCtx({ resizeMode: true }), km0), { kind: 'pass' })
// An armed leader swallows the next key, including keys that would otherwise be bindings.
assert.deepStrictEqual(decideKey(ev('c'), keyCtx({ leaderArmed: true }), km0), {
  kind: 'leader-result',
  result: { kind: 'action', action: 'new-tab' }
})
assert.deepStrictEqual(decideKey(ev('Shift', { shift: true }), keyCtx({ leaderArmed: true }), km0), { kind: 'pass' })
assert.deepStrictEqual(decideKey(ev('4'), keyCtx({ leaderArmed: true }), km0), {
  kind: 'leader-result',
  result: { kind: 'tab-index', index: 4 }
})
// Deliberate change: Alt+m used to fire even while leader was armed, leaving it armed.
// Now the prefix swallows it.
assert.deepStrictEqual(decideKey(ev('m', { alt: true }), keyCtx({ leaderArmed: true }), km0), {
  kind: 'leader-result',
  result: { kind: 'cancel' }
})
assert.deepStrictEqual(decideKey(ev('m', { alt: true }), keyCtx(), km0), { kind: 'action', id: 'last-tab' })
// Direct table, prefix, and the passthrough for everything else.
assert.deepStrictEqual(decideKey(ev(',', { ctrl: true }), keyCtx(), km0), { kind: 'action', id: 'open-settings' })
assert.deepStrictEqual(decideKey(ev('n', { alt: true }), keyCtx(), km0), { kind: 'arm-leader' })
assert.deepStrictEqual(decideKey(ev('q'), keyCtx(), km0), { kind: 'pass' })
assert.deepStrictEqual(decideKey(ev('Escape'), keyCtx(), km0), { kind: 'pass' })
// A chord completed while leader is armed: the bare modifier passes through first.
assert.deepStrictEqual(decideKey({ ...ev('a', { ctrl: true }), isComposing: true }, keyCtx(), km0), { kind: 'pass' })
ok('keymap: decideKey precedence, modals, leader swallowing, passthrough')

// --- keymap: recording a chord ---
assert.strictEqual(comboFromEvent(ev('Shift', { shift: true })), null)
assert.strictEqual(comboFromEvent(ev('Control', { ctrl: true })), null)
assert.strictEqual(comboFromEvent(ev('Alt', { alt: true })), null)
assert.strictEqual(comboFromEvent(ev('Meta', { meta: true })), null)
assert.strictEqual(comboFromEvent(ev('Dead')), null)
assert.strictEqual(comboFromEvent(ev('Process', { ctrl: true })), null)
assert.strictEqual(comboFromEvent(ev('')), null)
assert.strictEqual(comboFromEvent({ ...ev('a', { ctrl: true }), isComposing: true }), null)
assert.deepStrictEqual(comboFromEvent(ev('n', { alt: true })), { key: 'n', mods: ['Alt'] })
// A modifier-less named key is recordable; a bare glyph is not.
assert.deepStrictEqual(comboFromEvent(ev('F5')), { key: 'F5', mods: [] })
assert.deepStrictEqual(comboFromEvent(ev('t', { ctrl: true, shift: true })), { key: 't', mods: ['Ctrl', 'Shift'] })
// Cmd records as Ctrl: the matcher folds them, so this is what makes a binding work
// on macOS as well.
assert.deepStrictEqual(comboFromEvent(ev('t', { ctrl: true, meta: true, shift: true })), { key: 't', mods: ['Ctrl', 'Shift'] })
assert.deepStrictEqual(comboFromEvent(ev('t', { meta: true })), { key: 't', mods: ['Ctrl'] })
// The reasons shown while the recorder stays armed.
assert.ok((captureError(ev('t')) ?? '').includes('Ctrl or Alt'), 'a bare glyph is refused')
assert.strictEqual(captureError(ev('F5')), null)
assert.ok(captureError(ev('Shift', { shift: true })) !== null, 'a bare modifier waits for the real key')
assert.ok((captureError(ev('5'), { leader: true }) ?? '').includes('1–9'), 'digits are reserved')
assert.ok((captureError(ev('b', { ctrl: true }), { leader: true }) ?? '').includes('Ctrl or Alt'))
assert.strictEqual(captureError(ev('q'), { leader: true }), null)
assert.strictEqual(captureError(ev('Shift', { shift: true }), { leader: true }) !== null, true)
ok('keymap: capture rejects bare modifiers, dead keys, IME and unsafe glyphs')

console.log(`\nMUX TESTS PASSED (${passed} assertions)`)
