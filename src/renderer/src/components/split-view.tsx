import { useCallback, useRef } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import type { PaneNode, Rect, SplitOrientation, TabRecord } from '../mux-model'
import { leafRects } from '../mux-model'
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

interface DividerInfo {
  path: BranchPath
  orientation: SplitOrientation
  /** Current ratio of the split this divider belongs to. */
  ratio: number
  /** The split node's full area (relative 0..1) — used to translate drag pixels to ratio. */
  area: Rect
  /** The divider band's position (relative 0..1); thickness comes from CSS. */
  line: Rect
}

function collectDividers(
  node: PaneNode,
  x = 0,
  y = 0,
  w = 1,
  h = 1,
  path: BranchPath = [],
  out: DividerInfo[] = []
): DividerInfo[] {
  if (node.kind === 'pane') return out
  const isRow = node.orientation === 'row'
  const aw = isRow ? w * node.ratio : w
  const ah = isRow ? h : h * node.ratio
  out.push({
    path,
    orientation: node.orientation,
    ratio: node.ratio,
    area: { x, y, w, h },
    line: isRow ? { x: x + aw, y, w: 0, h } : { x, y: y + ah, w, h: 0 }
  })
  collectDividers(node.a, x, y, aw, ah, [...path, 'a'], out)
  collectDividers(node.b, isRow ? x + aw : x, isRow ? y : y + ah, isRow ? w - aw : w, isRow ? h - ah : h, [...path, 'b'], out)
  return out
}

/**
 * Rendering note: panes are laid out as a flat, keyed list of absolutely
 * positioned slots instead of nesting `TerminalPane` inside the split tree.
 * Restructuring a nested tree (splitting a pane adds a level) makes React
 * unmount + remount the existing pane, which disposes its xterm instance and
 * kills the session. Keeping panes in a flat keyed list makes splits and closes
 * pure additions/removals, so live terminals are never remounted.
 */
export function SplitView(props: SplitViewProps): ReactElement {
  const { node, tab, config, paneProps, onResizeSplit } = props
  const rects = leafRects(node)
  const zoomedId = tab.zoomedPaneId
  const zoomActive = zoomedId !== null && zoomedId !== undefined
  const dividers = zoomActive ? [] : collectDividers(node)

  return (
    <div className="split-root">
      {[...tab.panes.keys()].map((paneId) => {
        const pane = tab.panes.get(paneId)
        const rect = rects.get(paneId)
        if (!pane || !rect) return null
        const zoomed = zoomActive && zoomedId === paneId
        const hidden = zoomActive && !zoomed
        const style: CSSProperties = zoomed
          ? { left: 0, top: 0, width: '100%', height: '100%' }
          : {
              left: `${rect.x * 100}%`,
              top: `${rect.y * 100}%`,
              width: `${rect.w * 100}%`,
              height: `${rect.h * 100}%`
            }
        return (
          <div key={paneId} className={'pane-abs' + (hidden ? ' pane-abs-hidden' : '')} style={style}>
            <TerminalPane pane={pane} config={config} active={tab.activePaneId === pane.id} {...paneProps} />
          </div>
        )
      })}
      {dividers.map((d) => (
        <Divider key={d.path.length === 0 ? 'root' : d.path.join('.')} info={d} tabId={tab.id} onResize={onResizeSplit} />
      ))}
    </div>
  )
}

function Divider({
  info,
  tabId,
  onResize
}: {
  info: DividerInfo
  tabId: number
  onResize: (tabId: number, path: BranchPath, ratio: number) => void
}): ReactElement {
  const { orientation, line, area, ratio, path } = info
  const startRef = useRef({ ratio, pos: 0, size: 0, axis: 'x' as 'x' | 'y' })

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const container = (e.currentTarget as HTMLElement).parentElement
      if (!container) return
      const rect = container.getBoundingClientRect()
      const axis: 'x' | 'y' = orientation === 'row' ? 'x' : 'y'
      startRef.current = {
        ratio,
        pos: axis === 'x' ? e.clientX : e.clientY,
        size: axis === 'x' ? area.w * rect.width : area.h * rect.height,
        axis
      }

      const onMove = (ev: MouseEvent): void => {
        const { ratio: startRatio, pos, size, axis: a } = startRef.current
        if (size === 0) return
        const delta = (a === 'x' ? ev.clientX : ev.clientY) - pos
        const next = Math.min(0.9, Math.max(0.1, startRatio + delta / size))
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
    [orientation, area.w, area.h, ratio, tabId, path, onResize]
  )

  const style: CSSProperties =
    orientation === 'row'
      ? { left: `calc(${line.x * 100}% - 3px)`, top: `${line.y * 100}%`, width: 6, height: `${line.h * 100}%` }
      : { top: `calc(${line.y * 100}% - 3px)`, left: `${line.x * 100}%`, height: 6, width: `${line.w * 100}%` }

  return <div className={`divider divider-${orientation}`} style={style} onMouseDown={onMouseDown} />
}
