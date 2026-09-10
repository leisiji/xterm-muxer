import { ipcMain } from 'electron'
import type { SessionManager } from './sessions/session-manager'
import { listSshHosts } from './sessions/ssh-config'
import { loadConfig } from './config'
import type { CreateOptions } from './sessions/session'

export function registerIpc(manager: SessionManager): void {
  ipcMain.handle('session:create', (_e, opts: CreateOptions) => {
    const cfg = loadConfig()
    if (opts.kind === 'local') {
      // Config shell override applies when the renderer didn't specify one.
      const merged = cfg.shell?.path && !opts.shell ? { ...opts, shell: cfg.shell.path } : opts
      const s = manager.createLocal(merged)
      return { id: s.id, label: s.label, kind: s.kind }
    }
    const s = manager.createSsh(opts)
    return { id: s.id, label: s.label, kind: s.kind }
  })

  ipcMain.handle('session:write', (_e, payload: { id: string; data: string }) => {
    manager.write(payload.id, payload.data)
  })

  ipcMain.handle('session:resize', (_e, payload: { id: string; cols: number; rows: number }) => {
    manager.resize(payload.id, payload.cols, payload.rows)
  })

  ipcMain.handle('session:destroy', (_e, payload: { id: string }) => {
    manager.destroy(payload.id)
  })

  ipcMain.handle('session:prompt-answer', (_e, payload: { promptId: string; value: string }) => {
    manager.answerPrompt(payload.promptId, payload.value)
  })

  ipcMain.handle('ssh:list-hosts', () => listSshHosts())

  ipcMain.handle('config:get', () => loadConfig())
}
