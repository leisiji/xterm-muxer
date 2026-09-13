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
import { resolveLeaderKey, resolveResizeKey } from '../src/renderer/src/keys'
import { assignLabels, findMatches, resolveLabel } from '../src/renderer/src/quick-select'
import type { QuickLine } from '../src/renderer/src/quick-select'
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

console.log(`\nMUX TESTS PASSED (${passed} assertions)`)
