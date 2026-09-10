/** Pure-JS unit test for the renderer mux model + reducer (runs under plain node). */
import * as assert from 'assert'
import {
  insertSplit,
  removeLeaf,
  setRatioAt,
  neighborLeaf,
  countPanes,
  containsPane,
  leafRects
} from '../src/renderer/src/mux-model'
import { muxReducer } from '../src/renderer/src/mux-reducer'

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

console.log(`\nMUX TESTS PASSED (${passed} assertions)`)
