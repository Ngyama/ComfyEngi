// 执行队列：在主进程中按顺序一次提交一张，与界面是否打开某个页面无关。
// - 暂停：完成当前正在执行的图片后，不再提交下一张
// - 停止：撤回本软件尚在 ComfyUI 排队中的任务；正在生成的那张完成并记录后停止
// - 强制中断：只中断本软件提交且正在执行的那一张；被中断的图片继续时重新生成
// - 重启核对：提交前先写入 prompt_id，重启后向 ComfyUI 核对，已完成的补记录，丢失的才重新提交
// - 提交快照：发送前把序列化好的请求写入 run_attempts，发送的就是这个字符串；重试、恢复都从冻结的工作流与写入值构建，内容不变
// 扩展点：将来的「自动筛图」可在 record() 标记 done 之前插入检查步骤。

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { applyInputs, ComfyError, extractOutputs, historyError, historyInterrupted, unitFinalNodes, UPSCALE_OUTPUT } from '@shared/mapping'
import type { AttemptState, ExecutionAttempt, InputValue, OutputFile, RunnerEvent, RunnerState, RunnerStatus, RunUnit, Settings } from '@shared/types'
import { ComfyClient, ComfyHTTPError, EventStream, promptBody, type ComfyApi, type EventSource, type HistoryEntry } from './comfy-client'
import type { Store } from './store'
import { plannedImage, withUploadedImage } from './upscale'

type Result = 'done' | 'failed' | 'withdrawn' | 'requeued' | 'interrupted' | 'uncertain'

export const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex')

/**
 * 把下载到的字节保存为新文件并校验：不覆盖已有文件（同名时追加 (2)、(3)…）；已有文件内容完全相同时直接关联它（程序重启后继续复制不会多出一份）；
 * 写入后读回文件计算 SHA-256，与下载内容不一致时删除这个新文件并报错。
 */
export async function saveVerified(dir: string, name: string, data: Uint8Array, readBack: (p: string) => Promise<Uint8Array> = readFile): Promise<{ path: string; source_sha256: string; saved_sha256: string; reused: boolean }> {
  const source = sha256(data)
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let n = 1; ; n++) {
    const p = join(dir, n > 1 ? `${stem} (${n})${ext}` : name)
    try {
      await writeFile(p, data, { flag: 'wx' })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || n > 9999) throw e
      if (sha256(await readFile(p)) === source) return { path: p, source_sha256: source, saved_sha256: source, reused: true }
      continue
    }
    const saved = sha256(await readBack(p))
    if (saved !== source) {
      await rm(p, { force: true })
      throw new Error(`保存后的文件与下载内容不一致（下载 ${source.slice(0, 12)}…，保存 ${saved.slice(0, 12)}…）`)
    }
    return { path: p, source_sha256: source, saved_sha256: saved, reused: false }
  }
}

/** 从 PNG 文件头读取宽高；不是 PNG 时返回 null */
export function pngSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 24 || b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) return null
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  return { width: v.getUint32(16), height: v.getUint32(20) }
}

/** 键排序后序列化：比较两份工作流时不受字段顺序影响 */
const canonical = (v: unknown): string => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as object).sort(([a], [b]) => (a < b ? -1 : 1))) : x))

const num = (s: Settings, key: keyof Settings, def: number) => {
  const v = s[key]
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''))
  return v === null || v === undefined || v === '' || !Number.isFinite(n) ? def : n
}

export interface RunnerOptions {
  clientFactory?: (url: string) => ComfyApi
  eventsFactory?: ((url: string, clientId: string) => EventSource) | null
  onEvent?: (e: RunnerEvent) => void
}

export class Runner {
  clientId = randomUUID().replace(/-/g, '')
  state: RunnerState = 'idle'
  message = ''
  current: (RunUnit & { run_name: string }) | null = null
  progress = { value: 0, max: 0 }
  sessionRuns = new Set<number>()

  private pauseFlag = false
  private stopFlag = false
  private interruptFlag = false
  private pauseReason = ''
  private interruptSent: string | null = null
  private loop: Promise<void> | null = null
  private events: EventSource | null = null
  private wakers = new Set<() => void>()
  private wfCache = new Map<number, ReturnType<Store['getRun']>>()
  private clientFactory: (url: string) => ComfyApi
  private eventsFactory: ((url: string, clientId: string) => EventSource) | null
  private onEvent: (e: RunnerEvent) => void

  constructor(
    private store: Store,
    opts: RunnerOptions = {},
  ) {
    this.clientFactory = opts.clientFactory ?? ((url) => new ComfyClient(url))
    this.eventsFactory = opts.eventsFactory === undefined ? (url, id) => new EventStream(url, id) : opts.eventsFactory
    this.onEvent = opts.onEvent ?? (() => {})
  }

  // ---------------------------------------------------------------- 控制
  isAlive() {
    return this.loop !== null
  }

  status(): RunnerStatus {
    return {
      state: this.state,
      alive: this.isAlive(),
      message: this.message,
      current: this.current,
      progress: this.progress,
      sessionRuns: [...this.sessionRuns],
    }
  }

  /** 开始或继续 */
  start() {
    this.pauseFlag = false
    this.stopFlag = false
    this.interruptFlag = false
    this.pauseReason = ''
    this.wake()
    if (this.loop) {
      this.setState('running', '')
      return
    }
    this.loop = this.main().finally(() => {
      this.loop = null
      this.emitStatus()
    })
  }

  resume() {
    this.start()
  }

  pause() {
    if (!this.loop) return
    this.pauseFlag = true
    this.wake()
    this.setState(this.current ? 'pausing' : 'paused', this.current ? '当前图片完成后暂停' : '已暂停')
  }

  stop() {
    this.stopFlag = true
    this.wake()
    if (this.loop) this.setState('stopping', '正在停止…')
  }

  interrupt() {
    this.stopFlag = true
    this.interruptFlag = true
    this.wake()
    if (this.loop) this.setState('stopping', '正在强制中断当前图片…')
  }

  async join() {
    await this.loop
  }

  // ---------------------------------------------------------------- 内部工具
  private emitStatus() {
    this.onEvent({ kind: 'status', status: this.status() })
  }

  private log(text: string) {
    const d = new Date()
    const t = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
    this.onEvent({ kind: 'log', text: `${t} ${text}` })
  }

  private setState(state: RunnerState, message?: string) {
    this.state = state
    if (message !== undefined) this.message = message
    this.emitStatus()
  }

  private wake() {
    for (const w of [...this.wakers]) w()
    this.events?.wake()
  }

  private sleep(ms: number) {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(t)
        this.wakers.delete(done)
        resolve()
      }
      const t = setTimeout(done, ms)
      this.wakers.add(done)
    })
  }

  private autoPause(reason: string) {
    this.pauseFlag = true
    this.pauseReason = reason
    this.log(reason)
  }

  private run(runId: number) {
    if (!this.wfCache.has(runId)) this.wfCache.set(runId, this.store.getRun(runId))
    return this.wfCache.get(runId)!
  }

  // ---------------------------------------------------------------- 主循环
  private async main() {
    const s = this.store.settings()
    const client = this.clientFactory(s.comfy_url)
    this.events = null
    if (this.eventsFactory) {
      try {
        this.events = this.eventsFactory(s.comfy_url, this.clientId)
      } catch {
        this.events = null
      }
    }
    this.setState('running', '')
    this.log('开始执行队列')
    let failures = 0
    try {
      if (await this.ensureComfy(client)) await this.reconcile(client)
      for (;;) {
        if (this.stopFlag) break
        if (this.pauseFlag) {
          this.setState('paused', this.pauseReason || '已暂停')
          while (this.pauseFlag && !this.stopFlag) await this.sleep(1000)
          if (this.stopFlag) break
          this.setState('running', '')
          this.log('继续执行')
          failures = 0
          continue
        }
        const unit = this.store.nextPendingUnit()
        if (!unit) {
          this.setState('finished', '队列中的任务已全部完成')
          this.log('队列已全部完成')
          return
        }
        if (!(await this.ensureComfy(client))) continue
        const result = await this.runUnit(client, unit)
        if (result === 'failed') {
          failures++
          const limit = num(this.store.settings(), 'max_consecutive_failures', 3)
          if (limit && failures >= limit)
            this.autoPause(`连续失败 ${failures} 次，已自动暂停。请检查工作流、映射或 ComfyUI 日志后再继续。`)
        } else if (result === 'done') {
          failures = 0
        }
      }
      this.setState('stopped', '已停止')
      this.log('已停止')
    } catch (e) {
      // 防御：任何意外都不应让调度悄无声息地消失
      this.setState('stopped', `执行器异常停止：${(e as Error).message}`)
      this.log(`执行器异常：${(e as Error).stack ?? e}`)
    } finally {
      this.current = null
      this.events?.close()
      this.events = null
    }
  }

  private async ensureComfy(client: ComfyApi): Promise<boolean> {
    const start = Date.now()
    let first = true
    for (;;) {
      if (this.stopFlag || this.pauseFlag) return false
      try {
        await client.systemStats()
        if (!first) {
          this.log('ComfyUI 已恢复连接')
          this.setState('running', '')
        }
        return true
      } catch (e) {
        if (!(e instanceof ComfyError)) throw e
        if (first) {
          this.log(e.message)
          this.setState('waiting', `无法连接 ComfyUI，正在重试…（${e.message}）`)
        }
        first = false
        const maxWait = num(this.store.settings(), 'comfy_wait_max_min', 10) * 60000
        if (Date.now() - start >= maxWait) {
          this.autoPause(`超过 ${Math.round(maxWait / 60000)} 分钟仍无法连接 ComfyUI，已自动暂停。（${e.message}）`)
          return false
        }
        await this.sleep(5000)
      }
    }
  }

  /** 程序重启后核对已提交但未记录结果的单元 */
  private async reconcile(client: ComfyApi) {
    for (const u of this.store.inFlightUnits()) {
      const pid = u.prompt_id
      if (!pid) {
        this.markAttempt(u, 'lost')
        this.store.updateUnit(u.id, { status: 'pending' })
        continue
      }
      let running: string[], pending: string[], entry: HistoryEntry | null
      try {
        ;[running, pending] = await client.queueIds()
        entry = await client.history(pid)
      } catch (e) {
        this.log(`核对未完成任务失败：${(e as Error).message}`)
        return
      }
      if (entry) {
        this.log(`补记录：第 ${u.idx + 1} 张（${u.item_label}）已在 ComfyUI 完成`)
        await this.record(u, pid, entry, client)
      } else if (running.includes(pid) || pending.includes(pid)) {
        this.log(`第 ${u.idx + 1} 张仍在 ComfyUI 队列中，继续等待结果`)
        this.store.updateUnit(u.id, { status: 'submitted' })
        this.markAttempt(u, 'submitted', { submitted_at: Date.now() / 1000 })
        await this.waitUnit(client, u, pid)
      } else {
        this.log(`第 ${u.idx + 1} 张在 ComfyUI 中找不到（可能 ComfyUI 已重启），将重新提交`)
        this.markAttempt(u, 'lost')
        this.store.updateUnit(u.id, { status: 'pending', prompt_id: null })
      }
      this.onEvent({ kind: 'unit', unitId: u.id, runId: u.run_id })
      this.store.finishRunIfComplete(u.run_id)
    }
  }

  private async runUnit(client: ComfyApi, unit: RunUnit): Promise<Result> {
    const run = this.run(unit.run_id)
    if (!run) {
      this.store.updateUnit(unit.id, { status: 'failed', error: '所属队列项已被删除' })
      return 'failed'
    }
    this.sessionRuns.add(unit.run_id)
    const pid = randomUUID()
    let body: string
    try {
      // 批量放大：先把原图上传到 ComfyUI 的 input 目录（每次提交都重新上传同一个文件名，内容由入队时的 SHA-256 核对）
      const inputs = unit.meta?.upscale ? await this.uploadSource(client, unit) : (unit.inputs ?? [])
      body = promptBody(applyInputs(run.workflow_json, inputs), this.clientId, pid)
    } catch (e) {
      const error = (e as Error).message
      this.store.createAttempt(unit, null, 'build_failed', { error, unit: { status: 'failed', error, finished_at: Date.now() / 1000 } })
      this.afterUnit(unit)
      return 'failed'
    }
    // 先写入提交快照与 prompt_id 再提交：即使提交后程序崩溃，重启时也能在 ComfyUI 历史中找到它，快照也已保留。
    // 发送的就是快照中的这个字符串，之后不再有任何修改
    const attemptId = this.store.createAttempt(unit, body, 'built', {
      prompt_id: pid,
      client_id: this.clientId,
      unit: {
        status: 'submitting',
        prompt_id: pid,
        client_id: this.clientId,
        submitted_at: Date.now() / 1000,
        finished_at: null,
        attempts: (unit.attempts ?? 0) + 1,
        error: '',
        outputs: [],
      },
    })
    this.current = { ...unit, run_name: run.name }
    this.progress = { value: 0, max: 0 }
    this.emitStatus()
    const m = unit.meta
    let desc = `[${run.name}] 第 ${unit.idx + 1} 张 · ${m?.section ?? ''}「${unit.item_label}」`
    const up = unit.meta?.upscale
    if (m?.expression) desc += ` · 表情「${m.expression}」`
    let resp: { prompt_id: string }
    try {
      resp = await client.postPrompt(body)
    } catch (e) {
      if (e instanceof ComfyHTTPError) {
        this.store.updateAttempt(attemptId, { state: 'rejected', error: e.message, response: JSON.stringify(e.body ?? null), finished_at: Date.now() / 1000 })
        this.store.updateUnit(unit.id, { status: 'failed', error: e.message, finished_at: Date.now() / 1000 })
        this.log(`${desc} 提交失败：${e.message}`)
        this.afterUnit(unit)
        return 'failed'
      }
      // 网络异常：不确定 ComfyUI 是否已收到，交给核对逻辑处理
      this.log(`${desc} 提交时连接异常：${(e as Error).message}`)
      this.store.updateAttempt(attemptId, { state: 'submit_unknown', error: (e as Error).message })
      this.store.updateUnit(unit.id, { status: 'submitted' })
      if (await this.ensureComfy(client)) await this.reconcile(client)
      this.afterUnit(unit)
      return 'uncertain'
    }
    const real = resp.prompt_id || pid
    this.store.updateAttempt(attemptId, { state: 'submitted', prompt_id: real, submitted_at: Date.now() / 1000, response: JSON.stringify(resp) })
    this.store.updateUnit(unit.id, { status: 'submitted', prompt_id: real })
    this.log(up ? `${desc} 已提交（放大工作流「${up.workflow.name}」，采样参数保持工作流原值）` : `${desc} 已提交（seed ${unit.seed}）`)
    const result = await this.waitUnit(client, unit, real)
    this.afterUnit(unit)
    return result
  }

  /**
   * 上传放大的原图：读取入队时记录的文件并核对 SHA-256（文件被替换时停止，避免串图），用入队时确定的唯一文件名上传。
   * ComfyUI 返回的文件名与预定的不同时（例如旧版 ComfyUI 不支持覆盖）改用返回的文件名，并记录在日志中
   */
  private async uploadSource(client: ComfyApi, unit: RunUnit): Promise<InputValue[]> {
    const up = unit.meta!.upscale!
    let data: Buffer
    try {
      data = await readFile(up.source.path)
    } catch (e) {
      throw new Error(`读取原图失败（${up.source.path}）：${(e as NodeJS.ErrnoException).code === 'ENOENT' ? '文件已移动或删除' : (e as Error).message}`)
    }
    if (sha256(data) !== up.source.sha256) throw new Error(`原图在加入放大队列后被修改或替换（${up.source.path}，SHA-256 与入队时不同）。为避免使用错误的图片，没有提交；请重新加入放大队列`)
    let r: { name: string; subfolder: string }
    try {
      r = await client.uploadImage(data, up.upload.name, up.upload.subfolder, true)
    } catch (e) {
      throw new Error(`上传原图到 ComfyUI 失败：${(e as Error).message}`)
    }
    const actual = r.subfolder ? `${r.subfolder}/${r.name}` : r.name
    if (actual === plannedImage(up)) return unit.inputs ?? []
    this.log(`第 ${unit.idx + 1} 张：ComfyUI 把上传的原图保存为「${actual}」（预定为「${plannedImage(up)}」），LoadImage 使用 ComfyUI 返回的文件名`)
    return withUploadedImage(unit.inputs ?? [], actual)
  }

  /** 更新这张图最新一次提交的状态（更新前的记录没有快照时不做任何事） */
  private markAttempt(unit: RunUnit, state: AttemptState, fields: Partial<ExecutionAttempt> = {}) {
    const a = this.store.latestAttempt(unit.id)
    if (a) this.store.updateAttempt(a.id, { state, ...(state === 'submitted' ? {} : { finished_at: Date.now() / 1000 }), ...fields })
  }

  /** 核对 ComfyUI 历史中保存的工作流是否就是提交快照中的工作流 */
  private comfyMatch(unit: RunUnit, entry: HistoryEntry): number | null {
    const received = entry.prompt?.[2]
    const a = this.store.latestAttempt(unit.id)
    const stored = a && this.store.attemptBody(a.id)
    if (!received || !stored) return null
    return canonical(received) === canonical((JSON.parse(stored.body) as { prompt: unknown }).prompt) ? 1 : 0
  }

  private afterUnit(unit: RunUnit) {
    this.current = null
    this.progress = { value: 0, max: 0 }
    this.onEvent({ kind: 'unit', unitId: unit.id, runId: unit.run_id })
    if (this.store.finishRunIfComplete(unit.run_id)) this.log(`队列项「${this.run(unit.run_id)?.name}」已完成`)
    this.emitStatus()
  }

  private async waitUnit(client: ComfyApi, unit: RunUnit, pid: string): Promise<Result> {
    const s = this.store.settings()
    const timeout = num(s, 'unit_timeout_min', 30) * 60000
    const poll = Math.max(20, num(s, 'poll_interval_sec', 3) * 1000)
    const deadline = Date.now() + timeout
    let lastPoll = 0
    let finishedHint = false
    let lost = 0
    let withdrawnChecked = false
    let connDown = false
    for (;;) {
      const stop = this.stopFlag
      const intr = this.interruptFlag
      if (stop && (!withdrawnChecked || (intr && this.interruptSent !== pid))) {
        withdrawnChecked = true
        try {
          const [running, pending] = await client.queueIds()
          if (pending.includes(pid)) {
            await client.deleteFromQueue([pid])
            this.markAttempt(unit, 'withdrawn')
            this.store.updateUnit(unit.id, { status: 'pending', prompt_id: null })
            this.log(`已从 ComfyUI 队列撤回第 ${unit.idx + 1} 张（尚未开始生成）`)
            return 'withdrawn'
          }
          if (intr && running.includes(pid) && this.interruptSent !== pid) {
            this.interruptSent = pid
            await client.interrupt(pid)
            this.log(`已请求中断第 ${unit.idx + 1} 张`)
          }
        } catch (e) {
          this.log(`停止时操作 ComfyUI 队列失败：${(e as Error).message}`)
        }
      }
      const ev = this.events ? await this.events.next(500) : (await this.sleep(Math.min(500, poll)), null)
      if (ev && ev.data?.prompt_id === pid) {
        const d = ev.data
        if (ev.type === 'progress') {
          this.progress = { value: Number(d.value ?? 0), max: Number(d.max ?? 0) }
          this.emitStatus()
        } else if (ev.type === 'executing' && d.node == null) finishedHint = true
        else if (['execution_success', 'execution_error', 'execution_interrupted'].includes(ev.type)) finishedHint = true
        else if (ev.type === 'execution_start') {
          this.progress = { value: 0, max: 0 }
          this.emitStatus()
        }
      }
      const now = Date.now()
      const interval = this.events?.connected ? poll : Math.min(poll, 2000)
      if (finishedHint || now - lastPoll >= interval) {
        lastPoll = now
        try {
          let entry = await client.history(pid)
          if (entry) return await this.record(unit, pid, entry, client)
          const [running, pending] = await client.queueIds()
          if (connDown) {
            connDown = false
            this.log('ComfyUI 连接已恢复')
            if (!stop) this.setState('running', '')
          }
          if (running.includes(pid) || pending.includes(pid)) {
            lost = 0
          } else {
            // 先查队列再查历史，两次都找不到才认定丢失（避免完成瞬间的竞态）
            entry = await client.history(pid)
            if (entry) return await this.record(unit, pid, entry, client)
            if (++lost >= 2) {
              this.log(`第 ${unit.idx + 1} 张在 ComfyUI 中消失（可能 ComfyUI 重启），将重新提交`)
              this.markAttempt(unit, 'lost')
              this.store.updateUnit(unit.id, { status: 'pending', prompt_id: null })
              return 'requeued'
            }
          }
          finishedHint = false
        } catch (e) {
          if (!(e instanceof ComfyError)) throw e
          if (!connDown) {
            connDown = true
            this.log(`与 ComfyUI 的连接中断，等待恢复：${e.message}`)
            this.setState('waiting', '与 ComfyUI 的连接中断，等待恢复…')
          }
        }
      }
      if (Date.now() > deadline) {
        const msg = `等待超过 ${Math.round(timeout / 60000)} 分钟仍未完成，已标记为失败（ComfyUI 中的任务未被取消）`
        this.markAttempt(unit, 'timeout', { error: msg })
        this.store.updateUnit(unit.id, { status: 'failed', error: msg, finished_at: Date.now() / 1000 })
        this.log(`第 ${unit.idx + 1} 张：${msg}`)
        return 'failed'
      }
    }
  }

  /**
   * 把这张图的最终输出从 ComfyUI 复制到入队时冻结的输出目录（unit.meta.output_dir）。
   * - ComfyUI 的 filename_prefix 只能指定它自己 output 目录下的子路径，因此由本软件通过 /view 下载后保存，
   *   ComfyUI 本机或远程运行都适用；ComfyUI 中的原文件不删除、不移动
   * - 只复制最终输出：映射了「输出文件前缀」的保存节点；没有该映射时为工作流中没有被其他节点使用的保存节点；预览图（temp）不复制
   * - 不覆盖已有文件；保存路径、失败原因与校验结果记录在输出信息中
   * - 不同节点报告同一个文件（subfolder 与文件名都相同）时只复制一次，两条记录都关联到它，并记下这一点
   */
  private async saveOutputs(unit: RunUnit, outputs: OutputFile[], client: ComfyApi) {
    const wf = this.store.getRun(unit.run_id)?.workflow_json
    // 有绕过时按实际提交的结构判断（被绕过的节点不算输出，也不再算使用者）；前后相连的保存节点只有最下游的是最终输出
    const finals = unitFinalNodes(unit.inputs, wf)
    // 映射指定的最终输出节点（放大）：只取这些节点的图片，预览类型（temp）也作为最终输出下载保存
    const explicit = unit.inputs?.some((x) => x.source === UPSCALE_OUTPUT)
    for (const o of outputs) o.role = explicit ? (finals.has(o.node) ? 'final' : o.type !== 'output' ? 'preview' : 'intermediate') : o.type !== 'output' ? 'preview' : finals.size && !finals.has(o.node) ? 'intermediate' : 'final'
    const dir = unit.meta?.output_dir
    if (!dir) return
    const seen = new Map<string, OutputFile>()
    for (const o of outputs) {
      if (o.role !== 'final') continue
      const k = `${o.subfolder}/${o.filename}`
      const first = seen.get(k)
      if (first) {
        if (first.node !== o.node) o.same_file_as_node = first.node
        delete o.save_error
        if (first.saved) Object.assign(o, { saved: first.saved, source_sha256: first.source_sha256, saved_sha256: first.saved_sha256, image_width: first.image_width, image_height: first.image_height })
        else if (first.save_error) o.save_error = first.save_error
        continue
      }
      seen.set(k, o)
      if (o.saved) continue // 重试保存时跳过已成功的文件
      delete o.save_error
      try {
        const sub = String(o.subfolder ?? '').split(/[\\/]/).filter((p) => p && p !== '.' && p !== '..').map((p) => p.replace(/[<>:"|?*\x00-\x1f]/g, '_'))
        const base = String(o.filename).split(/[\\/]/).pop()!.replace(/[<>:"|?*\x00-\x1f]/g, '_')
        if (!base) throw new Error('ComfyUI 没有返回文件名')
        // 套图复刻：保存为与原图相同的文件名（不覆盖已有文件），不使用 ComfyUI 的子文件夹
        const stem = unit.meta?.output_name
        const name = stem ? `${stem}${extname(base)}` : base
        const target = stem ? dir : join(dir, ...sub)
        await mkdir(target, { recursive: true })
        const data = await client.fetchImage(o)
        const r = await saveVerified(target, name, data)
        Object.assign(o, { saved: r.path, source_sha256: r.source_sha256, saved_sha256: r.saved_sha256, ...(r.reused ? { reused: true } : {}) })
        const size = pngSize(data)
        if (size) Object.assign(o, { image_width: size.width, image_height: size.height })
      } catch (e) {
        o.save_error = `复制到 ${dir} 失败：${(e as Error).message}`
      }
    }
  }

  private async record(unit: RunUnit, pid: string, entry: HistoryEntry, client: ComfyApi): Promise<Result> {
    const s = this.store.settings()
    const now = Date.now() / 1000
    const outputs = extractOutputs(entry, s.comfy_output_dir || '', (...p) => join(...p)).map((o) => ({ ...o, prompt_id: pid }))
    const comfy_match = this.comfyMatch(unit, entry)
    if (historyInterrupted(entry)) {
      this.markAttempt(unit, 'interrupted', { comfy_match })
      if (this.interruptSent === pid) {
        this.store.updateUnit(unit.id, { status: 'pending', prompt_id: null, error: '已强制中断，继续执行时会重新生成' })
        this.log(`第 ${unit.idx + 1} 张已中断，继续时将重新生成`)
        return 'interrupted'
      }
      this.store.updateUnit(unit.id, { status: 'failed', error: '任务在 ComfyUI 中被中断（非本软件操作）', outputs, finished_at: now })
      this.log(`第 ${unit.idx + 1} 张在 ComfyUI 中被中断`)
      return 'failed'
    }
    if (entry.status?.status_str === 'error') {
      const err = historyError(entry)
      this.markAttempt(unit, 'failed', { comfy_match, error: err })
      this.store.updateUnit(unit.id, { status: 'failed', error: err, outputs, finished_at: now })
      this.log(`第 ${unit.idx + 1} 张失败：${err}`)
      return 'failed'
    }
    // 扩展点：将来在这里插入自动筛图（检查 outputs 后决定是否继续后续处理）
    await this.saveOutputs(unit, outputs, client)
    // 映射指定了最终输出节点，但执行完成后这个节点没有返回图片：不能把其他节点的图片当作结果
    if (unit.inputs?.some((x) => x.source === UPSCALE_OUTPUT) && !outputs.some((o) => o.role === 'final')) {
      const want = [...new Set(unit.inputs.filter((x) => x.source === UPSCALE_OUTPUT).map((x) => `#${x.node}`))].join('、')
      const got = outputs.map((o) => `#${o.node}（${o.type}）`).join('、') || '没有任何图片'
      const err = `ComfyUI 已执行完成，但指定的最终输出节点 ${want} 没有返回图片（历史记录中的输出：${got}）。没有保存任何文件，请检查工作流中该节点是否被绕过或静音`
      this.markAttempt(unit, 'failed', { comfy_match, error: err })
      this.store.updateUnit(unit.id, { status: 'failed', error: err, outputs, finished_at: now })
      this.log(`第 ${unit.idx + 1} 张失败：${err}`)
      return 'failed'
    }
    this.markAttempt(unit, 'success', { comfy_match })
    this.store.updateUnit(unit.id, { status: 'done', outputs, finished_at: now, error: '' })
    const files = outputs.filter((o) => o.type === 'output').map((o) => o.saved || o.filename).join(', ') || '无输出文件信息'
    this.log(`第 ${unit.idx + 1} 张完成：${files}`)
    const failed = outputs.filter((o) => o.save_error)
    if (failed.length) {
      this.log(`第 ${unit.idx + 1} 张有 ${failed.length} 个文件未能复制到输出目录：${failed[0].save_error}（ComfyUI 中的原文件不受影响）`)
      this.onEvent({ kind: 'notice', level: 'warn', text: `第 ${unit.idx + 1} 张已生成，但未能保存到输出目录`, detail: `${failed[0].save_error}。ComfyUI 中的原图保留，可在执行队列或运行记录中「重试保存」，无需重新生图。` })
    }
    return 'done'
  }

  /** 只重试文件保存：从 ComfyUI /view 重新下载已生成的图片并复制到入队时冻结的输出目录，不重新提交生图 */
  async retrySave(unitIds: number[]): Promise<{ saved: number; failed: number; error: string }> {
    const client = this.clientFactory(this.store.settings().comfy_url)
    let saved = 0
    let failed = 0
    let error = ''
    for (const id of unitIds) {
      const unit = this.store.getUnit(id)
      if (!unit || unit.status !== 'done' || !unit.outputs?.some((o) => o.save_error)) continue
      const outputs = structuredClone(unit.outputs)
      const before = outputs.filter((o) => o.saved).length
      await this.saveOutputs(unit, outputs, client)
      this.store.updateUnit(unit.id, { outputs })
      this.onEvent({ kind: 'unit', unitId: unit.id, runId: unit.run_id })
      saved += outputs.filter((o) => o.saved).length - before
      const bad = outputs.filter((o) => o.save_error)
      failed += bad.length
      if (bad.length) error ||= bad[0].save_error!
    }
    this.log(`重试保存：成功 ${saved} 个文件${failed ? `，仍失败 ${failed} 个：${error}` : ''}`)
    return { saved, failed, error }
  }
}
