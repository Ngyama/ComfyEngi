// ComfyUI HTTP 客户端与 WebSocket 事件流（运行在 Electron 主进程，使用内置 fetch / WebSocket）。

import { ComfyError, formatPromptError } from '@shared/mapping'
import type { ApiWorkflow } from '@shared/types'

export class ComfyConnectionError extends ComfyError {}

export class ComfyHTTPError extends ComfyError {
  constructor(
    public status: number,
    public body: unknown,
    message: string,
  ) {
    super(message)
  }
}

export interface HistoryEntry {
  status?: { status_str?: string; completed?: boolean; messages?: unknown[] }
  outputs?: Record<string, unknown>
}

export interface ComfyApi {
  systemStats(): Promise<unknown>
  objectInfo(): Promise<Record<string, unknown>>
  queuePrompt(graph: ApiWorkflow, clientId: string, promptId?: string): Promise<{ prompt_id: string }>
  history(promptId: string): Promise<HistoryEntry | null>
  queueIds(): Promise<[string[], string[]]>
  deleteFromQueue(ids: string[]): Promise<void>
  interrupt(promptId: string): Promise<boolean>
  viewUrl(f: { filename: string; subfolder?: string; type?: string }): string
  fetchImage(f: { filename: string; subfolder?: string; type?: string }): Promise<Buffer>
}

export class ComfyClient implements ComfyApi {
  base: string
  constructor(
    baseUrl: string,
    private timeoutMs = 15000,
  ) {
    this.base = (baseUrl ?? '').replace(/\/+$/, '')
  }

  private async request(method: string, path: string, body?: unknown, timeoutMs?: number, raw = false): Promise<unknown> {
    let res: Response
    try {
      res = await fetch(this.base + path, {
        method,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs ?? this.timeoutMs),
      })
    } catch (e) {
      const err = e as Error & { cause?: { code?: string; message?: string } }
      const reason = err.name === 'TimeoutError' ? '请求超时' : (err.cause?.code ?? err.cause?.message ?? err.message)
      throw new ComfyConnectionError(`无法连接 ComfyUI（${this.base}）：${reason}。请确认 ComfyUI 已启动且地址正确。`)
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      let parsed: unknown = text
      try {
        parsed = JSON.parse(text)
      } catch {
        /* 非 JSON */
      }
      if (res.status === 400 && path === '/prompt') throw new ComfyHTTPError(400, parsed, formatPromptError(parsed))
      throw new ComfyHTTPError(res.status, parsed, `ComfyUI 返回 HTTP ${res.status}（${path}）：${String(text).slice(0, 300)}`)
    }
    if (raw) return Buffer.from(await res.arrayBuffer())
    const text = await res.text()
    if (!text) return null
    try {
      return JSON.parse(text)
    } catch {
      throw new ComfyError(`ComfyUI 返回了无法解析的内容（${path}）`)
    }
  }

  systemStats() {
    return this.request('GET', '/system_stats', undefined, 5000)
  }

  async objectInfo() {
    return ((await this.request('GET', '/object_info', undefined, 60000)) ?? {}) as Record<string, unknown>
  }

  async queuePrompt(graph: ApiWorkflow, clientId: string, promptId?: string) {
    const body: Record<string, unknown> = { prompt: graph, client_id: clientId }
    if (promptId) body.prompt_id = promptId // 新版 ComfyUI 会使用这个 ID，旧版忽略
    const resp = (await this.request('POST', '/prompt', body)) as Record<string, unknown> | null
    if (resp && resp.node_errors && Object.keys(resp.node_errors as object).length)
      throw new ComfyHTTPError(200, resp, formatPromptError(resp))
    if (!resp || typeof resp.prompt_id !== 'string') throw new ComfyError(`ComfyUI 返回了意外的响应：${JSON.stringify(resp)}`)
    return resp as { prompt_id: string }
  }

  async history(promptId: string) {
    const h = (await this.request('GET', `/history/${encodeURIComponent(promptId)}`)) as Record<string, HistoryEntry> | null
    return h?.[promptId] ?? null
  }

  async queueIds(): Promise<[string[], string[]]> {
    const q = ((await this.request('GET', '/queue')) ?? {}) as { queue_running?: unknown[][]; queue_pending?: unknown[][] }
    const ids = (arr?: unknown[][]) => (arr ?? []).filter((x) => Array.isArray(x) && x.length > 1).map((x) => String(x[1]))
    return [ids(q.queue_running), ids(q.queue_pending)]
  }

  /** 只删除指定的（本软件提交的）待执行任务，从不清空整个队列 */
  async deleteFromQueue(ids: string[]) {
    await this.request('POST', '/queue', { delete: ids })
  }

  /** 只有当正在执行的正是该 prompt 时才中断 */
  async interrupt(promptId: string) {
    const [running] = await this.queueIds()
    if (!running.includes(promptId)) return false
    await this.request('POST', '/interrupt', { prompt_id: promptId })
    return true
  }

  viewUrl(f: { filename: string; subfolder?: string; type?: string }) {
    const q = new URLSearchParams({ filename: f.filename, subfolder: f.subfolder ?? '', type: f.type ?? 'output' })
    return `${this.base}/view?${q}`
  }

  async fetchImage(f: { filename: string; subfolder?: string; type?: string }) {
    const q = new URLSearchParams({ filename: f.filename, subfolder: f.subfolder ?? '', type: f.type ?? 'output' })
    return (await this.request('GET', `/view?${q}`, undefined, 30000, true)) as Buffer
  }
}

export interface ComfyEvent {
  type: string
  data?: Record<string, unknown>
}

export interface EventSource {
  connected: boolean
  next(timeoutMs: number): Promise<ComfyEvent | null>
  wake(): void
  close(): void
}

/** 保持 WebSocket 连接（断线自动重连），把 JSON 消息排入队列；二进制预览帧忽略 */
export class EventStream implements EventSource {
  connected = false
  url: string
  private queue: ComfyEvent[] = []
  private waiters: ((e: ComfyEvent | null) => void)[] = []
  private ws: WebSocket | null = null
  private closed = false
  private backoff = 1000
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(baseUrl: string, clientId: string) {
    const u = new URL(baseUrl)
    const scheme = u.protocol === 'https:' ? 'wss' : 'ws'
    this.url = `${scheme}://${u.host}${u.pathname.replace(/\/+$/, '')}/ws?clientId=${encodeURIComponent(clientId)}`
    this.connect()
  }

  private connect() {
    if (this.closed) return
    let ws: WebSocket
    try {
      ws = new WebSocket(this.url)
    } catch {
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    ws.onopen = () => {
      this.connected = true
      this.backoff = 1000
    }
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return
      try {
        this.push(JSON.parse(ev.data) as ComfyEvent)
      } catch {
        /* 忽略 */
      }
    }
    ws.onclose = () => {
      this.connected = false
      this.ws = null
      this.scheduleReconnect()
    }
    ws.onerror = () => {
      /* onclose 会随后触发 */
    }
  }

  private scheduleReconnect() {
    if (this.closed || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.connect()
    }, this.backoff)
    this.backoff = Math.min(this.backoff * 2, 15000)
  }

  private push(e: ComfyEvent) {
    const w = this.waiters.shift()
    if (w) w(e)
    else this.queue.push(e)
  }

  next(timeoutMs: number): Promise<ComfyEvent | null> {
    const e = this.queue.shift()
    if (e) return Promise.resolve(e)
    return new Promise((resolve) => {
      const done = (v: ComfyEvent | null) => {
        clearTimeout(t)
        this.waiters = this.waiters.filter((x) => x !== done)
        resolve(v)
      }
      const t = setTimeout(() => done(null), timeoutMs)
      this.waiters.push(done)
    })
  }

  wake() {
    for (const w of [...this.waiters]) w(null)
  }

  close() {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.wake()
    try {
      this.ws?.close()
    } catch {
      /* 忽略 */
    }
  }
}
