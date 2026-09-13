import type { ReactElement } from 'react'
import type { TabRecord } from '../mux-model'

export interface TabBarProps {
  tabs: TabRecord[]
  activeTabId: number | null
  onActivate: (tabId: number) => void
  onClose: (tabId: number) => void
  onNewTab: () => void
  onNewSsh: () => void
  onSettings: () => void
}

export function TabBar(props: TabBarProps): ReactElement {
  const { tabs, activeTabId } = props
  return (
    <div className="tab-bar">
      <div className="tab-list">
        {tabs.map((tab, i) => {
          const pane = tab.activePaneId !== null ? tab.panes.get(tab.activePaneId) : undefined
          const title = pane?.title || pane?.label || '…'
          const cls = 'tab' + (tab.id === activeTabId ? ' active' : '') + (tab.unseen ? ' unseen' : '')
          return (
            <div
              key={tab.id}
              className={cls}
              onClick={() => props.onActivate(tab.id)}
              onAuxClick={(e) => {
                if (e.button === 1) props.onClose(tab.id)
              }}
              title={title}
            >
              <span className="tab-index">{i + 1}</span>
              <span className="tab-title">{title}</span>
              <span className="tab-close" onClick={(e) => {
                e.stopPropagation()
                props.onClose(tab.id)
              }}>×</span>
            </div>
          )
        })}
      </div>
      <div className="tab-actions">
        <button className="tab-action" title="Terminal settings (Ctrl+,)" onClick={props.onSettings}>
          ⚙
        </button>
        <button className="tab-action" title="New SSH connection (Ctrl+Shift+S)" onClick={props.onNewSsh}>
          SSH
        </button>
        <button className="tab-action" title="New tab (Ctrl+Shift+T)" onClick={props.onNewTab}>
          +
        </button>
      </div>
    </div>
  )
}
