import { ipcMain, BrowserWindow } from 'electron'
import * as crypto from 'crypto'
import type { SessionManager } from './sessions/session-manager'
import { listSshHosts } from './sessions/ssh-config'
import { deleteSshHost, listSavedHosts, loadConfig, saveSshHost, updateConfig } from './config'
import type { SavedSshHost } from './config'
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

  ipcMain.handle('ssh:list-saved', () => listSavedHosts())

  ipcMain.handle('ssh:save', (_e, host: Omit<SavedSshHost, 'id'> & { id?: string }) => {
    const profile: SavedSshHost = {
      id: host.id ?? crypto.randomUUID(),
      name: host.name?.trim() || host.host,
      host: host.host,
      user: host.user || undefined,
      port: host.port || undefined,
      identity: host.identity || undefined
    }
    return saveSshHost(profile)
  })

  ipcMain.handle('ssh:delete', (_e, id: string) => deleteSshHost(id))

  // Used by the renderer to close the window when the last session exits.
  ipcMain.on('window:close', (e) => {
    BrowserWindow.fromWebContents(e.sender)?.close()
  })

  ipcMain.handle('config:get', () => loadConfig())

  ipcMain.handle('config:set', (_e, patch: unknown) => updateConfig(patch))
}
