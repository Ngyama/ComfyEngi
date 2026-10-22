// Preload：只向页面暴露白名单中的业务方法和执行器事件订阅，不暴露 Node / 文件系统能力。
import { contextBridge, ipcRenderer } from 'electron'
import { API_METHODS, INVOKE_CHANNEL, RUNNER_EVENT_CHANNEL, type RendererApi } from '@shared/api'
import type { RunnerEvent } from '@shared/types'

const api = {} as Record<string, unknown>
for (const m of API_METHODS) {
  api[m] = async (...args: unknown[]) => {
    const r = (await ipcRenderer.invoke(INVOKE_CHANNEL, m, args)) as { ok: boolean; value?: unknown; error?: string }
    if (!r.ok) throw new Error(r.error)
    return r.value
  }
}
api.onRunnerEvent = (cb: (e: RunnerEvent) => void) => {
  const fn = (_: unknown, e: RunnerEvent) => cb(e)
  ipcRenderer.on(RUNNER_EVENT_CHANNEL, fn)
  return () => ipcRenderer.removeListener(RUNNER_EVENT_CHANNEL, fn)
}

contextBridge.exposeInMainWorld('api', api as RendererApi)
