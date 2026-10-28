import { createServer } from 'node:net'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyInputs,
  checkAgainstObjectInfo,
  ComfyError,
  formatPromptError,
  loadApiWorkflow,
  mappingErrors,
  newEntry,
  validateMapping,
} from '@shared/mapping'
import type { RunnerEvent } from '@shared/types'
import { analyzeWorkflow } from '@shared/workflow-analysis'
import { ComfyClient, ComfyConnectionError, EventStream, type ComfyEvent, type EventSource } from '../src/main/comfy-client'
import { enqueueTask, planForTask } from '../src/main/plan'
import { Runner } from '../src/main/runner'
import type { Store } from '../src/main/store'
import { Lib, newStore, SAMPLE_MAPPING, SAMPLE_WORKFLOW, waitUntil } from './helpers'
import { MockComfy, OBJECT_INFO } from './mock-comfy'

describe('工作流导入与映射', () => {
  it('编辑器格式被拒绝并给出说明', () => {
    const editor = { last_node_id: 9, nodes: [{ id: 3, type: 'KSampler' }], links: [], version: 0.4 }
    expect(() => loadApiWorkflow(JSON.stringify(editor))).toThrow(/编辑器格式[\s\S]*API/)
    expect(() => loadApiWorkflow('{not json')).toThrow(/不是有效的 JSON/)
    expect(loadApiWorkflow(JSON.stringify(SAMPLE_WORKFLOW))).toEqual(SAMPLE_WORKFLOW)
    expect(loadApiWorkflow('﻿' + JSON.stringify({ prompt: SAMPLE_WORKFLOW }))).toEqual(SAMPLE_WORKFLOW)
  })

  it('无效节点映射有清晰的提示', () => {
    const bad = [
      newEntry('positive', '99', 'text'),
      newEntry('negative', '7', 'txt'),
      newEntry('seed', '3', 'positive'),
      newEntry('lora1_name', '6', 'text'),
      newEntry('lora1_strength', '6', 'text'),
    ]
    const text = validateMapping(SAMPLE_WORKFLOW, bad).filter(([l]) => l === 'error').map(([, m]) => m).join('\n')
    expect(text).toContain('不存在节点 ID「99」')
    expect(text).toContain('没有输入字段「txt」')
    expect(text).toContain('当前连接自节点 6')
    expect(text).toContain('同一输入不能写入两次')
    expect(validateMapping(SAMPLE_WORKFLOW, []).some(([, m]) => m.includes('尚未映射「正面 Prompt」'))).toBe(true)
    expect(mappingErrors(SAMPLE_WORKFLOW, SAMPLE_MAPPING)).toEqual([])
  })

  it('自动识别建议只作为候选：结构明确的默认勾选，LoRA Loader 需要确认', () => {
    const sug = analyzeWorkflow(SAMPLE_WORKFLOW).suggestions
    const got = sug.filter((s) => s.checked).flatMap((s) => s.entries).map((e) => `${e.source}:${e.node}.${e.input}`)
    expect(got).toEqual(expect.arrayContaining(['positive:6.text', 'negative:7.text', 'seed:3.seed', 'filename_prefix:9.filename_prefix']))
    expect(sug.filter((s) => s.group === 'lora').every((s) => !s.checked)).toBe(true)
  })

  it('只修改映射的输入，原工作流不被改动', () => {
    const g = applyInputs(SAMPLE_WORKFLOW, [
      { node: '6', input: 'text', source: 'positive', value: 'NEW' },
      { node: '10', input: 'lora_name', source: 'lora1_name', value: null },
    ])
    expect(g['6'].inputs.text).toBe('NEW')
    expect(SAMPLE_WORKFLOW['6'].inputs.text).toBe('原正面')
    g['6'].inputs.text = '原正面'
    expect(g).toEqual(SAMPLE_WORKFLOW)
    expect(() => applyInputs(SAMPLE_WORKFLOW, [{ node: '99', input: 'text', source: 'positive', value: 'x' }])).toThrow(ComfyError)
  })

  it('API 400 错误整理成节点级说明', () => {
    const msg = formatPromptError({
      error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation', details: '', extra_info: {} },
      node_errors: { '10': { class_type: 'LoraLoader', dependent_outputs: ['9'], errors: [{ type: 'value_not_in_list', message: 'Value not in list', details: "lora_name: 'x' not in [...]", extra_info: { input_name: 'lora_name' } }] } },
    })
    expect(msg).toContain('ComfyUI 拒绝了任务')
    expect(msg).toContain('节点 10（LoraLoader）')
    expect(msg).toContain('lora_name')
  })

  it('连接失败给出清晰提示', async () => {
    await expect(new ComfyClient('http://127.0.0.1:1', 3000).systemStats()).rejects.toThrow(ComfyConnectionError)
    await expect(new ComfyClient('http://127.0.0.1:1', 3000).systemStats()).rejects.toThrow(/无法连接 ComfyUI/)
  })

  it('联网校验发现不存在的 LoRA 和节点类型', () => {
    const msgs = checkAgainstObjectInfo(SAMPLE_WORKFLOW, [[{ node: '10', input: 'lora_name', source: 'lora1_name', value: 'missing.safetensors' }]], OBJECT_INFO as never)
    expect(msgs.some(([, m]) => m.includes('missing.safetensors'))).toBe(true)
    const api = { ...SAMPLE_WORKFLOW, '11': { class_type: 'CustomNodeX', inputs: {} } }
    expect(checkAgainstObjectInfo(api, [], OBJECT_INFO as never).some(([, m]) => m.includes('CustomNodeX'))).toBe(true)
  })

  it('多个 Prompt 节点可以分别接收模块子集', () => {
    const s = newStore()
    const lib = new Lib(s)
    const api = structuredClone(SAMPLE_WORKFLOW)
    api['11'] = { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['10', 1] } }
    lib.addWorkflow([...SAMPLE_MAPPING.slice(0, 2), newEntry('positive', '11', 'text', ['character', 'outfit'])], api)
    const plan = planForTask(s, lib.makeTask([lib.item('睡觉', lib.outfitsA[0], [], 1)]))
    const vals = Object.fromEntries(plan.units[0].inputs!.map((x) => [x.node, x.value]))
    expect(vals['6']).toBe(plan.units[0].positive)
    expect(vals['11']).toBe('1girl, char_a, red hair,\n\noutfit_a1')
  })

  it('入队被错误阻止', () => {
    const s = newStore()
    const lib = new Lib(s)
    lib.addWorkflow([newEntry('positive', '99', 'text')])
    let r = enqueueTask(s, lib.makeTask([lib.item('睡觉', null, [], 1)]))
    expect(r.runId).toBeNull()
    expect(r.plan.errors.some((e) => e.includes('不存在节点'))).toBe(true)
    lib.addWorkflow()
    r = enqueueTask(s, lib.makeTask([lib.item('睡觉', null, lib.exprs.slice(0, 3), 10)]))
    expect(r.runId).toBeNull()
    expect(r.plan.errors.some((e) => e.includes('平均分配'))).toBe(true)
  })
})

describe('执行队列（模拟 ComfyUI）', () => {
  let mock: MockComfy
  let store: Store
  let lib: Lib
  let runner: Runner | null
  let log: RunnerEvent[]

  beforeEach(async () => {
    mock = new MockComfy(0.05)
    await mock.serve(0)
    store = newStore()
    store.setSetting('comfy_url', mock.url)
    lib = new Lib(store)
    log = []
    runner = null
  })
  afterEach(async () => {
    runner?.stop()
    await runner?.join()
    await mock.shutdown()
    store.close()
  })

  const make = (events: ((u: string, c: string) => EventSource) | null = null) =>
    (runner = new Runner(store, { eventsFactory: events, onEvent: (e) => log.push(e) }))
  const count = (runId: number, k: 'done' | 'failed' | 'pending') => store.runCounts(runId)[k] ?? 0

  it('预览的 Prompt 与实际提交给 ComfyUI 的完全一致', async () => {
    lib.addWorkflow()
    const e = lib.exprs
    const task = lib.makeTask([
      lib.item('睡觉', lib.outfitsA[0], [e[0], e[1]], 4, { camera_id: lib.pov }),
      lib.item('动作A', lib.outfitsA[1], [], 2, { male_enabled: true }),
    ])
    const preview = planForTask(store, task)
    expect(preview.errors).toEqual([])
    const { runId } = enqueueTask(store, task)
    make().start()
    expect(await waitUntil(() => count(runId!, 'done') === 6)).toBe(true)
    await runner!.join()
    expect(mock.submitted).toHaveLength(6)
    preview.units.forEach((u, i) => {
      const g = mock.submitted[i][1]
      expect(g['6'].inputs.text).toBe(u.positive)
      expect(g['7'].inputs.text).toBe(u.negative)
      expect(g['3'].inputs.seed).toBe(u.seed)
      expect(g['10'].inputs.lora_name).toBe('charA.safetensors')
      expect(g['10'].inputs.strength_model).toBe(0.8)
      expect(g['10'].inputs.strength_clip).toBe(1.0) // 未映射的输入保持原值
      expect(g['4']).toEqual(SAMPLE_WORKFLOW['4'])
      expect(g['8']).toEqual(SAMPLE_WORKFLOW['8'])
    })
    const units = store.listUnits(runId!)
    expect(units.every((u) => u.status === 'done' && u.prompt_id && u.outputs.length)).toBe(true)
    expect(units[0].outputs[0].filename.startsWith('0001')).toBe(true)
    expect(store.getRun(runId!)!.status).toBe('done')
  })

  it('入队后修改或删除模板不影响记录', async () => {
    lib.addWorkflow()
    const { runId } = enqueueTask(store, lib.makeTask([lib.item('睡觉', null, [], 1)]))
    const before = store.listUnits(runId!)[0].positive
    store.save('templates', { id: lib.poses['睡觉'], positive: 'CHANGED' })
    store.remove('characters', lib.charB)
    make().start()
    expect(await waitUntil(() => count(runId!, 'done') === 1)).toBe(true)
    expect(store.listUnits(runId!)[0].positive).toBe(before)
    expect(mock.submitted[0][1]['6'].inputs.text).toBe(before)
  })

  it('暂停后不再提交新的任务，继续后完成剩余', async () => {
    mock.delay = 0.4
    lib.addWorkflow()
    const { runId } = enqueueTask(store, lib.makeTask([lib.item('睡觉', null, [], 5)]))
    const r = make()
    r.start()
    expect(await waitUntil(() => mock.submitted.length === 1)).toBe(true)
    r.pause()
    expect(await waitUntil(() => r.state === 'paused', 5000)).toBe(true)
    await new Promise((res) => setTimeout(res, 800))
    expect(mock.submitted).toHaveLength(1)
    expect(count(runId!, 'done')).toBe(1) // 当前那张正常完成并记录
    r.resume()
    expect(await waitUntil(() => count(runId!, 'done') === 5, 10000)).toBe(true)
    expect(mock.submitted).toHaveLength(5)
  })

  it('程序重启后不会盲目重复执行已经完成的任务', async () => {
    lib.addWorkflow()
    const { runId } = enqueueTask(store, lib.makeTask([lib.item('睡觉', null, [], 4)]))
    const units = store.listUnits(runId!)
    // 第 1 张已完成；第 2 张已出图但软件崩溃未记录；第 3 张提交后 ComfyUI 重启丢失；第 4 张未提交
    store.updateUnit(units[0].id, { status: 'done', prompt_id: 'p-done' })
    mock.history['p-crash'] = { outputs: { '9': { images: [{ filename: 'x.png', subfolder: '', type: 'output' }] } }, status: { status_str: 'success', completed: true, messages: [] } }
    store.updateUnit(units[1].id, { status: 'submitted', prompt_id: 'p-crash' })
    store.updateUnit(units[2].id, { status: 'submitting', prompt_id: 'p-lost' })
    make().start()
    expect(await waitUntil(() => count(runId!, 'done') === 4)).toBe(true)
    expect(mock.submitted.map(([, g]) => g['3'].inputs.seed)).toEqual([units[2].seed, units[3].seed])
    const u1 = store.getUnit(units[1].id)!
    expect(u1.outputs[0].filename).toBe('x.png')
    expect(u1.prompt_id).toBe('p-crash')
  })

  it('重启后仍在 ComfyUI 队列中的任务继续等待，不重复提交', async () => {
    lib.addWorkflow()
    const { runId } = enqueueTask(store, lib.makeTask([lib.item('睡觉', null, [], 2)]))
    const units = store.listUnits(runId!)
    mock.paused = true
    mock.pending.push([1, 'p-queued', SAMPLE_WORKFLOW as never])
    store.updateUnit(units[0].id, { status: 'submitted', prompt_id: 'p-queued' })
    make().start()
    await new Promise((res) => setTimeout(res, 300))
    expect(mock.submitted).toHaveLength(0)
    mock.paused = false
    expect(await waitUntil(() => count(runId!, 'done') === 2)).toBe(true)
    expect(mock.submitted).toHaveLength(1)
  })

  it('API 错误记录为失败，连续失败后自动暂停', async () => {
    lib.addWorkflow()
    store.setSetting('max_consecutive_failures', 2)
    mock.rejectWith = {
      error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation', details: '' },
      node_errors: { '6': { class_type: 'CLIPTextEncode', errors: [{ message: 'Required input is missing', details: 'clip', extra_info: { input_name: 'clip' } }] } },
    }
    const { runId } = enqueueTask(store, lib.makeTask([lib.item('睡觉', null, [], 5)]))
    const r = make()
    r.start()
    expect(await waitUntil(() => r.state === 'paused')).toBe(true)
    const failed = store.listUnits(runId!).filter((u) => u.status === 'failed')
    expect(failed).toHaveLength(2)
    expect(failed[0].error).toContain('节点 6（CLIPTextEncode）')
    expect(failed[0].error).toContain('clip')
    expect(r.message).toContain('连续失败')
  })

  it('执行错误被记录', async () => {
    lib.addWorkflow()
    mock.failAll = true
    const { runId } = enqueueTask(store, lib.makeTask([lib.item('睡觉', null, [], 1)]))
    make().start()
    expect(await waitUntil(() => count(runId!, 'failed') === 1)).toBe(true)
    expect(store.listUnits(runId!)[0].error).toContain('KSampler')
  })

  it('停止只撤回本软件排队中的任务，不影响其他任务', async () => {
    lib.addWorkflow()
    mock.paused = true
    mock.pending.push([0, 'someone-else', {}])
    const { runId } = enqueueTask(store, lib.makeTask([lib.item('睡觉', null, [], 3)]))
    const r = make()
    r.start()
    expect(await waitUntil(() => mock.submitted.length === 1)).toBe(true)
    r.stop()
    await r.join()
    expect(r.isAlive()).toBe(false)
    expect(mock.deleted).toEqual([mock.submitted[0][0]])
    expect(mock.pending.map((j) => j[1])).toEqual(['someone-else'])
    expect(count(runId!, 'pending')).toBe(3)
  })

  it('强制中断只针对本软件正在执行的任务', async () => {
    mock.delay = 5
    lib.addWorkflow()
    const { runId } = enqueueTask(store, lib.makeTask([lib.item('睡觉', null, [], 2)]))
    const r = make()
    r.start()
    expect(await waitUntil(() => mock.running !== null)).toBe(true)
    r.interrupt()
    await r.join()
    expect(mock.interruptCalls).toEqual([mock.submitted[0][0]])
    expect(count(runId!, 'pending')).toBe(2)
  })

  it('ComfyUI 未启动时持续重试，超时后自动暂停', async () => {
    lib.addWorkflow()
    store.setSetting('comfy_url', 'http://127.0.0.1:1')
    store.setSetting('comfy_wait_max_min', 0)
    const { runId } = enqueueTask(store, lib.makeTask([lib.item('睡觉', null, [], 1)]))
    const r = make()
    r.start()
    expect(await waitUntil(() => r.state === 'paused', 15000)).toBe(true)
    expect(r.message).toContain('无法连接 ComfyUI')
    expect(count(runId!, 'pending')).toBe(1)
  })

  it('ComfyUI 中途重启导致任务丢失时重新提交', async () => {
    mock.delay = 0.6
    lib.addWorkflow()
    const { runId } = enqueueTask(store, lib.makeTask([lib.item('睡觉', null, [], 2)]))
    make().start()
    expect(await waitUntil(() => mock.running !== null)).toBe(true)
    const first = mock.submitted[0][0]
    mock.restart()
    mock.delay = 0.05
    expect(await waitUntil(() => count(runId!, 'done') === 2, 15000)).toBe(true)
    expect(mock.submitted).toHaveLength(3)
    expect(mock.submitted[1][0]).not.toBe(first)
  })

  it('多个套图按队列顺序执行', async () => {
    lib.addWorkflow()
    const r1 = enqueueTask(store, lib.makeTask([lib.item('睡觉', null, [], 2)], '第一套')).runId!
    const r2 = enqueueTask(store, lib.makeTask([lib.item('动作A', null, [], 2)], '第二套')).runId!
    store.reorderRuns([r2, r1])
    make().start()
    expect(await waitUntil(() => count(r1, 'done') === 2 && count(r2, 'done') === 2)).toBe(true)
    const texts = mock.submitted.map(([, g]) => String(g['6'].inputs.text))
    expect(texts.slice(0, 2).every((t) => t.includes('action_a'))).toBe(true)
    expect(texts.slice(2).every((t) => t.includes('sleeping'))).toBe(true)
  })

  it('WebSocket 进度事件转发给界面，完成事件触发立即查询结果', async () => {
    class FakeEvents implements EventSource {
      connected = true
      q: ComfyEvent[] = []
      async next(ms: number) {
        const end = Date.now() + ms
        while (Date.now() < end) {
          if (this.q.length) return this.q.shift()!
          await new Promise((r) => setTimeout(r, 10))
        }
        return null
      }
      wake() {}
      close() {}
    }
    const fe = new FakeEvents()
    lib.addWorkflow()
    mock.delay = 0.3
    store.setSetting('poll_interval_sec', 30)
    const { runId } = enqueueTask(store, lib.makeTask([lib.item('睡觉', null, [], 1)]))
    make(() => fe).start()
    expect(await waitUntil(() => mock.submitted.length === 1)).toBe(true)
    const pid = mock.submitted[0][0]
    fe.q.push({ type: 'progress', data: { value: 5, max: 28, prompt_id: pid } })
    expect(await waitUntil(() => !!mock.history[pid])).toBe(true)
    fe.q.push({ type: 'executing', data: { node: null, prompt_id: pid } })
    expect(await waitUntil(() => count(runId!, 'done') === 1, 5000)).toBe(true)
    expect(log.some((e) => e.kind === 'status' && e.status.progress.value === 5 && e.status.progress.max === 28)).toBe(true)
  })
})

describe('WebSocket 事件流', () => {
  it('连接地址正确，解析文本消息，忽略二进制预览帧', async () => {
    const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
    const frame = (payload: Buffer, op: number) =>
      Buffer.concat([Buffer.from([0x80 | op, payload.length < 126 ? payload.length : 126]), payload.length < 126 ? Buffer.alloc(0) : Buffer.from([payload.length >> 8, payload.length & 255]), payload])
    let path = ''
    const server = createServer((sock) => {
      let buf = ''
      sock.on('data', (d) => {
        buf += d.toString()
        if (!buf.includes('\r\n\r\n') || path) return
        const lines = buf.split('\r\n')
        path = lines[0].split(' ')[1]
        const key = lines.find((l) => l.toLowerCase().startsWith('sec-websocket-key'))!.split(':')[1].trim()
        const accept = createHash('sha1').update(key + GUID).digest('base64')
        sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
        sock.write(frame(Buffer.from('\x89PNG-preview'), 0x2))
        sock.write(frame(Buffer.from(JSON.stringify({ type: 'progress', data: { value: 3, max: 20, prompt_id: 'abc' } })), 0x1))
      })
      sock.on('error', () => {})
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as { port: number }).port
    const es = new EventStream(`http://127.0.0.1:${port}`, 'client123')
    try {
      const ev = await es.next(5000)
      expect(ev).toEqual({ type: 'progress', data: { value: 3, max: 20, prompt_id: 'abc' } })
      expect(path).toBe('/ws?clientId=client123')
      expect(es.connected).toBe(true)
    } finally {
      es.close()
      server.close()
    }
  })
})
