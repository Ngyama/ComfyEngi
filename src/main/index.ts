import { existsSync, readFileSync, watch } from 'node:fs'
import { atomic } from './file-library'
import { createVault, openVault } from './vault'
// Electron 主进程入口：窗口、数据目录、数据库、执行器生命周期。

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, protocol, shell } from 'electron'
import { LoraManager } from './lora-manager'
import { RUNNER_EVENT_CHANNEL } from '@shared/api'
import type { RunnerEvent } from '@shared/types'
import { registerIpc } from './ipc'
import { Runner } from './runner'
import { seedSamples } from './seed'
import { Store } from './store'

// 数据目录：%APPDATA%\ComfyEngi（与旧版相同，旧数据直接沿用）；可用 COMFYENGI_DATA_DIR 覆盖
const dataDir = process.env.COMFYENGI_DATA_DIR || join(app.getPath('appData'), 'ComfyEngi')
const recentFile = join(dataDir, 'recent-vault.json')
let vaultRoot: string | null = process.env.COMFYENGI_VAULT || null
try { if (!vaultRoot && existsSync(recentFile)) vaultRoot = JSON.parse(readFileSync(recentFile,'utf8')).root } catch { /* welcome */ }
const backupDir = join(vaultRoot || dataDir, 'data', 'backups')
mkdirSync(dataDir, { recursive: true })
// Chromium 缓存等放在子目录，避免与数据库混在一起
app.setPath('userData', join(dataDir, 'electron'))
app.setAppUserModelId('ComfyEngi')

const logFile = join(vaultRoot || dataDir, vaultRoot ? 'logs/error.log' : 'error.log')
const logError = (e: unknown) => {
  try {
    appendFileSync(logFile, `\n[${new Date().toISOString()}]\n${e instanceof Error ? e.stack : String(e)}\n`)
  } catch {
    /* 忽略 */
  }
}
process.on('uncaughtException', logError)
process.on('unhandledRejection', logError)

// LoRA 视频封面：以流方式按需读取（支持 Range），避免通过 IPC 传输完整视频
protocol.registerSchemesAsPrivileged([{ scheme: 'comfyengi-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }])

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
      if (vaultRoot && process.env.COMFYENGI_IMPORT_LEGACY && !existsSync(join(vaultRoot,'.comfyengi/vault.json'))) createVault(vaultRoot, process.env.COMFYENGI_IMPORT_LEGACY)
      store = vaultRoot ? openVault(vaultRoot) : new Store(':memory:')
      store.dailyBackup(backupDir)
      if (vaultRoot) seedSamples(store)
    } catch (e) {
      logError(e)
      dialog.showErrorBox('无法打开数据库', `${(e as Error).message}\n\n数据目录：${dataDir}`)
      vaultRoot = null
      store = new Store(':memory:')
    }
    runner = new Runner(store, { onEvent: send })
    protocol.handle('comfyengi-media', (req) => {
      const u = new URL(req.url)
      const id = decodeURIComponent(u.pathname.replace(/^\//, ''))
      if (u.host !== 'lora' || !store.files) return new Response('not found', { status: 404 })
      return new LoraManager(store.files.root).serveCover(id, req.headers.get('range'))
    })
    registerIpc({ store, runner, dataDir: vaultRoot || dataDir, backupDir, logs, window: () => win,
      chooseVault: async (create,migrate) => {
        const r=await dialog.showOpenDialog(win!,{title:create?'创建工作区（选择空目录）':'打开工作区',properties:['openDirectory','createDirectory']})
        if(r.canceled || !r.filePaths[0]) return
        if(runner.isAlive()) throw new Error('队列仍在执行，请先停止')
        const root=r.filePaths[0]
        if(create) createVault(root,migrate ? join(dataDir,'comfyengi.db') : undefined)
        const check=openVault(root); check.close()
        atomic(recentFile,JSON.stringify({root})); app.relaunch(); app.quit()
      }
    })
    if (store.files) {
      let timer: ReturnType<typeof setTimeout>
      const notify = () => {
        clearTimeout(timer)
        timer=setTimeout(()=>{
          if(store.files?.changed()) send({kind:'log',text:'[Vault] 检测到外部文件变化，请复制未保存草稿后使用设置中的刷新。'})
        },800)
      }
      const watchers=['prompts','workflows'].map(d=>watch(join(vaultRoot!,d),{recursive:true},notify))
      app.on('will-quit',()=>{clearTimeout(timer);watchers.forEach(w=>w.close())})
    }
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
