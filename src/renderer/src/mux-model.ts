/**
 * The renderer-side mux model: tabs of pane-binary-trees, mirroring wezterm's
 * Tab (bintree) + Pane. Sessions are created lazily by each pane component once
 * the terminal knows its dimensions, then attached here.
 */

export type SplitOrientation = 'row' | 'col'

export type PaneNode =
  | { kind: 'pane'; paneId: number }
  | { kind: 'split'; orientation: SplitOrientation; ratio: number; a: PaneNode; b: PaneNode }

export interface PendingCreate {
  kind: 'local' | 'ssh'
  target?: string
  user?: string
  port?: number
  identity?: string
  password?: string
  cwd?: string
}

export interface PromptState {
  promptId: string
  text: string
  echo: boolean
}

export interface SshPaneOpts {
  target: string
  user?: string
  port?: number
  identity?: string
}

export interface PaneRecord {
  id: number
  sessionId: string | null
  label: string
  kind?: 'local' | 'ssh'
  sshOpts?: SshPaneOpts
  title: string | null
  cwd: string | null
  dead: boolean
  status: string | null
  pendingCreate: PendingCreate | null
  prompt: PromptState | null
}

export interface TabRecord {
  id: number
  root: PaneNode
  panes: Map<number, PaneRecord>
  activePaneId: number | null
  zoomedPaneId: number | null
  unseen: boolean
  /** User-set tab name (leader+,). `null` = derive from the active pane. */
  title: string | null
}

export interface MuxState {
  tabs: TabRecord[]
  activeTabId: number | null
}

let tabSeq = 0
let paneSeq = 0
export const nextTabId = (): number => ++tabSeq
export const nextPaneId = (): number => ++paneSeq

export function makePane(pendingCreate: PendingCreate): PaneRecord {
  return {
    id: nextPaneId(),
    sessionId: null,
    label: '',
    title: null,
    cwd: null,
    dead: false,
    status: null,
    pendingCreate,
    prompt: null
  }
}

export function makeTab(pane: PaneRecord): TabRecord {
  return {
    id: nextTabId(),
    root: { kind: 'pane', paneId: pane.id },
    panes: new Map([[pane.id, pane]]),
    activePaneId: pane.id,
    zoomedPaneId: null,
    unseen: false,
    title: null
  }
}

// ---------- tree helpers ----------

export function findPane(tab: TabRecord, paneId: number): PaneRecord | undefined {
  return tab.panes.get(paneId)
}

export function containsPane(node: PaneNode, paneId: number): boolean {
  if (node.kind === 'pane') return node.paneId === paneId
  return containsPane(node.a, paneId) || containsPane(node.b, paneId)
}

export function countPanes(node: PaneNode): number {
  if (node.kind === 'pane') return 1
  return countPanes(node.a) + countPanes(node.b)
}

/** Replace the leaf `paneId` with a split of it and a new pane. */
export function insertSplit(
  node: PaneNode,
  paneId: number,
  orientation: SplitOrientation,
  newPaneId: number
): PaneNode {
  if (node.kind === 'pane') {
    if (node.paneId !== paneId) return node
    return {
      kind: 'split',
      orientation,
      ratio: 0.5,
      a: node,
      b: { kind: 'pane', paneId: newPaneId }
    }
  }
  if (containsPane(node.a, paneId)) {
    return { ...node, a: insertSplit(node.a, paneId, orientation, newPaneId) }
  }
  return { ...node, b: insertSplit(node.b, paneId, orientation, newPaneId) }
}

/** Remove a leaf; collapse splits that would end up with a single child. */
export function removeLeaf(node: PaneNode, paneId: number): PaneNode | null {
  if (node.kind === 'pane') return node.paneId === paneId ? null : node
  const a = removeLeaf(node.a, paneId)
  const b = removeLeaf(node.b, paneId)
  if (a === null && b === null) return null
  if (a === null) return b
  if (b === null) return a
  return { ...node, a, b }
}

/** Set the ratio of the split reached by `path` (array of 'a'|'b'). */
export function setRatioAt(node: PaneNode, path: Array<'a' | 'b'>, ratio: number): PaneNode {
  if (node.kind === 'pane') return node
  // Empty path targets this node — the root divider of a two-pane split.
  if (path.length === 0) return { ...node, ratio }
  const [dir, ...rest] = path
  if (dir === 'a') return { ...node, a: setRatioAt(node.a, rest, ratio) }
  return { ...node, b: setRatioAt(node.b, rest, ratio) }
}

export type ResizeDirection = 'left' | 'right' | 'up' | 'down'

/** Leaves in reading order (preorder) — used to cycle panes for "next pane". */
export function paneOrder(node: PaneNode, out: number[] = []): number[] {
  if (node.kind === 'pane') out.push(node.paneId)
  else {
    paneOrder(node.a, out)
    paneOrder(node.b, out)
  }
  return out
}

/**
 * Nearest ancestor split aligned with `dir` (left/right → 'row', up/down → 'col'),
 * mirroring wezterm's `adjust_pane_size` which walks up from the active leaf.
 */
export function findResizeSplit(
  node: PaneNode,
  paneId: number,
  dir: ResizeDirection
): { path: Array<'a' | 'b'>; ratio: number } | null {
  const wantRow = dir === 'left' || dir === 'right'
  let path: Array<'a' | 'b'> = []
  let current: PaneNode = node
  while (current.kind === 'split') {
    if ((current.orientation === 'row') === wantRow) return { path, ratio: current.ratio }
    const inA = containsPane(current.a, paneId)
    path = [...path, inA ? 'a' : 'b']
    current = inA ? current.a : current.b
  }
  return null
}

/** New ratio for a divider move; Right/Down grow the first child (wezterm sign). */
export function resizeRatio(ratio: number, dir: ResizeDirection, step = 0.05): number {
  const delta = dir === 'right' || dir === 'down' ? step : -step
  return Math.min(0.9, Math.max(0.1, ratio + delta))
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** Compute relative (0..1) rectangles for every leaf, preorder. */
export function leafRects(node: PaneNode, x = 0, y = 0, w = 1, h = 1, out = new Map<number, Rect>()): Map<number, Rect> {
  if (node.kind === 'pane') {
    out.set(node.paneId, { x, y, w, h })
    return out
  }
  if (node.orientation === 'row') {
    const aw = w * node.ratio
    leafRects(node.a, x, y, aw, h, out)
    leafRects(node.b, x + aw, y, w - aw, h, out)
  } else {
    const ah = h * node.ratio
    leafRects(node.a, x, y, w, ah, out)
    leafRects(node.b, x, y + ah, w, h - ah, out)
  }
  return out
}

/** Pick the nearest leaf in a compass direction (for Alt+arrow focus movement). */
export function neighborLeaf(
  node: PaneNode,
  paneId: number,
  dir: 'up' | 'down' | 'left' | 'right'
): number | null {
  const rects = leafRects(node)
  const cur = rects.get(paneId)
  if (!cur) return null
  const cx = cur.x + cur.w / 2
  const cy = cur.y + cur.h / 2
  let best: number | null = null
  let bestScore = Infinity
  for (const [id, r] of rects) {
    if (id === paneId) continue
    const rx = r.x + r.w / 2
    const ry = r.y + r.h / 2
    const dx = rx - cx
    const dy = ry - cy
    let score = Infinity
    switch (dir) {
      case 'left':
        if (dx < 0) score = -dx + Math.abs(dy) * 2
        break
      case 'right':
        if (dx > 0) score = dx + Math.abs(dy) * 2
        break
      case 'up':
        if (dy < 0) score = -dy + Math.abs(dx) * 2
        break
      case 'down':
        if (dy > 0) score = dy + Math.abs(dx) * 2
        break
    }
    if (score < bestScore) {
      bestScore = score
      best = id
    }
  }
  return best
}
