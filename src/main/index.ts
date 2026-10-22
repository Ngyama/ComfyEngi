// Electron 主进程入口：窗口、数据目录、数据库、执行器生命周期。

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, shell } from 'electron'
import { RUNNER_EVENT_CHANNEL } from '@shared/api'
import type { RunnerEvent } from '@shared/types'
import { registerIpc } from './ipc'
import { Runner } from './runner'
import { seedSamples } from './seed'
import { Store } from './store'

// 数据目录：%APPDATA%\ComfyEngi（与旧版相同，旧数据直接沿用）；可用 COMFYENGI_DATA_DIR 覆盖
const dataDir = process.env.COMFYENGI_DATA_DIR || join(app.getPath('appData'), 'ComfyEngi')
const backupDir = join(dataDir, 'backups')
mkdirSync(dataDir, { recursive: true })
// Chromium 缓存等放在子目录，避免与数据库混在一起
app.setPath('userData', join(dataDir, 'electron'))
app.setAppUserModelId('ComfyEngi')

const logFile = join(dataDir, 'error.log')
const logError = (e: unknown) => {
  try {
    appendFileSync(logFile, `\n[${new Date().toISOString()}]\n${e instanceof Error ? e.stack : String(e)}\n`)
  } catch {
    /* 忽略 */
  }
}
process.on('uncaughtException', logError)
process.on('unhandledRejection', logError)

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  let win: BrowserWindow | null = null
  let store: Store
  let runner: Runner
  const logs: string[] = []

  const send = (e: RunnerEvent) => {
    if (e.kind === 'log') {
      logs.push(e.text)
      if (logs.length > 1000) logs.splice(0, logs.length - 1000)
    }
    if (win && !win.isDestroyed()) win.webContents.send(RUNNER_EVENT_CHANNEL, e)
  }

  const createWindow = () => {
    win = new BrowserWindow({
      width: 1480,
      height: 920,
      minWidth: 1080,
      minHeight: 680,
      show: false,
      backgroundColor: '#0e0f12',
      title: 'ComfyEngi',
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#0e0f12', symbolColor: '#a1a3ad', height: 40 },
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
      },
    })
    win.once('ready-to-show', () => win?.show())
    // 外部链接交给系统浏览器，不在应用内打开新窗口
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    win.webContents.on('will-navigate', (e, url) => {
      if (url !== win?.webContents.getURL()) e.preventDefault()
    })
    win.on('close', (e) => {
      if (runner.isAlive() && !['paused', 'stopped', 'finished'].includes(runner.state)) {
        const r = dialog.showMessageBoxSync(win!, {
          type: 'question',
          buttons: ['关闭', '取消'],
          defaultId: 1,
          cancelId: 1,
          title: '正在执行',
          message: '队列正在执行，确定关闭？',
          detail: '已提交给 ComfyUI 的当前图片仍会由 ComfyUI 完成；下次启动后点击「开始」，软件会先向 ComfyUI 核对结果并补记录，不会重复生成。',
        })
        if (r !== 0) e.preventDefault()
      }
    })
    win.on('closed', () => (win = null))
    if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
    else void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    try {
      store = new Store(join(dataDir, 'comfyengi.db'), { backupDir })
      store.dailyBackup(backupDir)
      seedSamples(store)
    } catch (e) {
      logError(e)
      dialog.showErrorBox('无法打开数据库', `${(e as Error).message}\n\n数据目录：${dataDir}`)
      app.quit()
      return
    }
    runner = new Runner(store, { onEvent: send })
    registerIpc({ store, runner, dataDir, backupDir, logs, window: () => win })
    createWindow()
  })

  app.on('window-all-closed', () => {
    runner?.stop()
    app.quit()
  })

  app.on('will-quit', () => {
    try {
      store?.close()
    } catch {
      /* 忽略 */
    }
  })
}
