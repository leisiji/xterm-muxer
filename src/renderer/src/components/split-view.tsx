
import { useCallback, useRef } from 'react'
import type { ReactElement } from 'react'
import type { PaneNode, TabRecord } from '../mux-model'
import { containsPane } from '../mux-model'
import type { RendererConfig } from '../types'
import { TerminalPane } from './terminal-pane'
import type { TerminalPaneProps } from './terminal-pane'

type BranchPath = Array<'a' | 'b'>

export interface SplitViewProps {
  node: PaneNode
  tab: TabRecord
  config: RendererConfig
  paneProps: Pick<
    TerminalPaneProps,
    'registerTerminal' | 'unregisterTerminal' | 'onAttach' | 'onTitle' | 'onCwd' | 'onFocus' | 'resolvePrompt'
  >
  onResizeSplit: (tabId: number, path: BranchPath, ratio: number) => void
}

export function SplitView(props: SplitViewProps): ReactElement {
  return <SplitNode {...props} path={[]} />
}

function SplitNode({
  node,
  tab,
  config,
  paneProps,
  onResizeSplit,
  path
}: SplitViewProps & { path: BranchPath }): ReactElement {
  if (node.kind === 'pane') {
    const pane = tab.panes.get(node.paneId)
    if (!pane) return <div className="terminal-pane terminal-pane-empty" />
    // Keep every pane mounted (so its session survives tab switches / zoom) and
    // hide the non-zoomed ones with CSS instead of unmounting them.
    const zoomActive = tab.zoomedPaneId !== null && tab.zoomedPaneId !== undefined
    const hidden = zoomActive && tab.zoomedPaneId !== pane.id
    return (
      <div key={pane.id} className={'pane-slot' + (hidden ? ' pane-slot-hidden' : '')}>
        <TerminalPane
          pane={pane}
          config={config}
          active={tab.activePaneId === pane.id}
          {...paneProps}
        />
      </div>
    )
  }
  const zoomActive = tab.zoomedPaneId !== null && tab.zoomedPaneId !== undefined
  const zoomedId = tab.zoomedPaneId
  // Collapse the branches that don't contain the zoomed pane so the zoomed
  // pane's branch fills the workspace, while keeping every pane mounted.
  const hideA = zoomActive && zoomedId !== null && zoomedId !== undefined && !containsPane(node.a, zoomedId)
  const hideB = zoomActive && zoomedId !== null && zoomedId !== undefined && !containsPane(node.b, zoomedId)
  return (
    <div className={`split split-${node.orientation}`}>
      <div className={'split-child' + (hideA ? ' split-child-hidden' : '')} style={{ flex: zoomActive ? '1 1 0%' : `${node.ratio} 1 0%` }}>
        <SplitNode node={node.a} tab={tab} config={config} paneProps={paneProps} onResizeSplit={onResizeSplit} path={[...path, 'a']} />
      </div>
      <Divider node={node} tabId={tab.id} path={path} onResize={onResizeSplit} hidden={zoomActive} />
      <div className={'split-child' + (hideB ? ' split-child-hidden' : '')} style={{ flex: zoomActive ? '1 1 0%' : `${1 - node.ratio} 1 0%` }}>
        <SplitNode node={node.b} tab={tab} config={config} paneProps={paneProps} onResizeSplit={onResizeSplit} path={[...path, 'b']} />
      </div>
    </div>
  )
}

function Divider({
  node,
  tabId,
  path,
  onResize,
  hidden
}: {
  node: Extract<PaneNode, { kind: 'split' }>
  tabId: number
  path: BranchPath
  onResize: (tabId: number, path: BranchPath, ratio: number) => void
  hidden?: boolean
}): ReactElement {
  const startRef = useRef({ ratio: node.ratio, pos: 0, size: 0, axis: 'x' })

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const container = (e.currentTarget as HTMLElement).parentElement
      if (!container) return
      const rect = container.getBoundingClientRect()
      const axis = node.orientation === 'row' ? 'x' : 'y'
      startRef.current = {
        ratio: node.ratio,
        pos: axis === 'x' ? e.clientX : e.clientY,
        size: axis === 'x' ? rect.width : rect.height,
        axis
      }

      const onMove = (ev: MouseEvent): void => {
        const { ratio, pos, size, axis: a } = startRef.current
        if (size === 0) return
        const delta = (a === 'x' ? ev.clientX : ev.clientY) - pos
        const next = Math.min(0.9, Math.max(0.1, ratio + delta / size))
        onResize(tabId, path, next)
      }
      const onUp = (): void => {
        document.body.classList.remove('resizing')
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      document.body.classList.add('resizing')
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [node.ratio, node.orientation, tabId, path, onResize]
  )

  return <div className={`divider divider-${node.orientation}${hidden ? ' divider-hidden' : ''}`} onMouseDown={onMouseDown} />
}
