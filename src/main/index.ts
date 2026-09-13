import { app, BrowserWindow, Menu } from 'electron'
import * as path from 'path'
import { SessionManager } from './sessions/session-manager'
import { registerIpc } from './ipc'
import { loadConfig } from './config'

let mainWindow: BrowserWindow | null = null
let manager: SessionManager | null = null

function createWindow(): void {
  const cfg = loadConfig()
  mainWindow = new BrowserWindow({
    width: cfg.window.width,
    height: cfg.window.height,
    title: cfg.window.title,
    backgroundColor: '#0b0e14',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  if (process.env.SMOKE_TEST === '1') {
    mainWindow.webContents.on('console-message', (_e, level, message) => {
      console.log(`[renderer:${level}] ${message}`)
    })
    mainWindow.webContents.on('did-finish-load', () => {
      console.log('[smoke] renderer loaded')
    })
    setTimeout(() => {
      manager?.destroyAll()
      console.log('[smoke] done')
      app.exit(0)
    }, 12000)
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function setMenu(): void {
  // On Windows/Linux the File/Edit/View/Window menu bar is removed entirely:
  // it is redundant for a terminal and Alt-based accelerators (the Alt+N leader
  // key) would otherwise fight the menu's Alt-to-show behaviour. macOS keeps a
  // standard app menu, as the OS always shows one.
  if (process.platform === 'darwin') {
    const template: Electron.MenuItemConstructorOptions[] = [
      { role: 'appMenu' as const },
      { role: 'editMenu' as const },
      { role: 'windowMenu' as const }
    ]
    Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  } else {
    Menu.setApplicationMenu(null)
  }
}

if (process.env.SMOKE_TEST === '1') console.log('[smoke] main boot')

app.whenReady().then(() => {
  if (process.env.SMOKE_TEST === '1') console.log('[smoke] app ready')
  manager = new SessionManager((payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('mux:event', payload)
    }
  })
  registerIpc(manager)
  setMenu()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  manager?.destroyAll()
})

app.on('window-all-closed', () => {
  manager?.destroyAll()
  if (process.platform !== 'darwin') app.quit()
})
