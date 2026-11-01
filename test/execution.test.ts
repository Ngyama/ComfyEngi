// 生成链路：TriggerWord Toggle 的检测与禁用、提交快照、输出来源与校验。
// 全部使用模拟 ComfyUI；TriggerWord Toggle 的输出由 toggleOutput 按插件源码（ComfyUI-Lora-Manager 的 trigger_word_toggle.py）的分支计算，
// 样本是 test/fixtures/workflow-two-pass.json。这些测试不能代替在真实 ComfyUI 与真实插件上的验证。

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyInputs, checkAgainstObjectInfo, isLink, LM_TRIGGER_TOGGLE, loraStackOf, mappingValues, newEntry, primaryOutputIndex, toggleDisableInputs, toggleStructure, TRIGGER_DISABLE, validateMapping } from '@shared/mapping'
import type { ApiNode, ApiWorkflow, MappingEntry, OutputFile } from '@shared/types'
import { analyzeWorkflow, diffWorkflow, findPromptInjectors, generationSize, loaderChangedBy, mergeMapping, unsafeIntegers } from '@shared/workflow-analysis'
import { ComfyClient, promptBody } from '../src/main/comfy-client'
import { enqueueTask, planForTask } from '../src/main/plan'
import { pngSize, Runner, saveVerified, sha256 } from '../src/main/runner'
import { Store } from '../src/main/store'
import { createVault, openVault } from '../src/main/vault'
import { Lib, newStore, SAMPLE_MAPPING, SAMPLE_WORKFLOW, tempDir, waitUntil } from './helpers'
import { MockComfy, tinyPng } from './mock-comfy'

const FIXTURE: ApiWorkflow = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'workflow-two-pass.json'), 'utf8'))
const checked = (api: ApiWorkflow) => analyzeWorkflow(api).suggestions.filter((s) => s.checked).flatMap((s) => s.entries)

/** 插件的执行逻辑（只覆盖本测试需要的分支）。loaderOutput：trigger_words 连接在运行时收到的文本 */
function toggleOutput(node: ApiNode, loaderOutput: string): string {
  const unwrap = (v: unknown) => (v && typeof v === 'object' && '__value__' in v ? (v as { __value__: unknown }).__value__ : v)
  const words = (s: string) => new Set(s.split(/,+/).map((x) => x.trim()).filter(Boolean))
  const same = (a: string, b: string) => {
    const x = words(a)
    const y = words(b)
    return x.size === y.size && [...x].every((w) => y.has(w))
  }
  const i = node.inputs
  const original = typeof unwrap(i.orinalMessage) === 'string' ? (unwrap(i.orinalMessage) as string) : ''
  const raw = isLink(i.trigger_words) ? loaderOutput : unwrap(i.trigger_words)
  if (raw && typeof raw === 'string' && !same(raw, original)) return raw
  const list = unwrap(i.toggle_trigger_words) as { text: string; active: boolean }[] | undefined
  if (list?.length) return list.filter((g) => g.active && g.text.trim()).map((g) => g.text.trim()).join(', ')
  return original
}

const TOGGLE: ApiNode = {
  class_type: LM_TRIGGER_TOGGLE,
  inputs: {
    group_mode: true,
    default_active: true,
    allow_strength_adjustment: false,
    orinalMessage: 'outfit_a1,, outfit_a2',
    toggle_trigger_words: { __value__: [{ text: 'outfit_a1', active: true, highlighted: false, strength: null }, { text: 'outfit_a2', active: true, highlighted: false, strength: null }] },
    trigger_words: ['10', 2],
  },
}
/** SAMPLE_WORKFLOW + 触发词节点 → 拼接 → 正面编码器 */
const TRIGGER_WF: ApiWorkflow = {
  ...SAMPLE_WORKFLOW,
  '6': { class_type: 'CLIPTextEncode', inputs: { text: ['31', 0], clip: ['10', 1] } },
  '30': { class_type: 'PrimitiveString', inputs: { value: '原正面' } },
  '31': { class_type: 'StringConcatenate', inputs: { string_a: ['34', 0], string_b: ['30', 0], delimiter: ',' } },
  '34': TOGGLE,
}
const TRIGGER_MAP: MappingEntry[] = SAMPLE_MAPPING.map((m) => (m.source === 'positive' ? { ...m, node: '30', input: 'value' } : m))

describe('TriggerWord Toggle 检测', () => {
  it('实际样本：#34 位于正面路径，结构已验证，提示包含节点 ID 与类型', () => {
    const inj = findPromptInjectors(FIXTURE, mergeMapping([], checked(FIXTURE))).find((x) => x.node === '34')!
    expect(inj.kind).toBe('trigger_toggle')
    expect(inj.polarity).toEqual(['positive'])
    expect(inj.controllable).toBe(true)
    expect(inj.source_node).toBe('5')
    expect(inj.groups!.length).toBe(5)
    expect(inj.groups!.every((g) => !g.active)).toBe(true)
    expect(inj.message).toContain('#34（TriggerWord Toggle (LoraManager)）')
    expect(inj.message).toContain('服装特征混合')
    expect(analyzeWorkflow(FIXTURE).notes.some((n) => n.includes('#34') && n.includes('触发词'))).toBe(true)
  })

  it('不只看名称：名称相同但结构不同、类型含 trigger 的未知节点都不算已验证，标记为未受控制', () => {
    const wrong: ApiNode = { class_type: LM_TRIGGER_TOGGLE, inputs: { group_mode: true, toggle_trigger_words: 'a, b', trigger_words: ['10', 2] } }
    expect(toggleStructure(wrong)).toBeNull()
    expect(toggleStructure({ class_type: LM_TRIGGER_TOGGLE, inputs: { group_mode: true, toggle_trigger_words: [{ text: 1 }] } })).toBeNull()
    expect(toggleStructure({ class_type: 'SomeTriggerNode', inputs: TOGGLE.inputs })).toBeNull()
    const inj = findPromptInjectors({ ...TRIGGER_WF, '34': { class_type: 'SomeTriggerNode', inputs: { mode: 'x' } } }, TRIGGER_MAP).find((x) => x.node === '34')!
    expect(inj.kind).toBe('trigger_unknown')
    expect(inj.controllable).toBe(false)
    expect(inj.message).toContain('未受控制的 Prompt 注入节点')
  })

  it('结合连接关系：没有连到 Prompt 的节点标记为不在路径上；未映射文本、LoRA Loader 文本、无法确定的节点分别识别', () => {
    const off = { ...SAMPLE_WORKFLOW, '34': TOGGLE }
    const inj = findPromptInjectors(off, SAMPLE_MAPPING)
    expect(inj.map((x) => [x.node, x.polarity])).toEqual([['34', []]])
    expect(inj[0].message).toContain('没有连接到 Prompt 路径')
    const kinds = (api: ApiWorkflow) => Object.fromEntries(findPromptInjectors(api, TRIGGER_MAP).map((x) => [x.node, x.kind]))
    expect(kinds({ ...TRIGGER_WF, '31': { class_type: 'StringConcatenate', inputs: { string_a: ['32', 0], string_b: ['30', 0], delimiter: ',' } }, '32': { class_type: 'PrimitiveString', inputs: { value: 'extra tags' } } })).toEqual({ '32': 'unmapped_text', '34': 'trigger_toggle' })
    expect(kinds({ ...TRIGGER_WF, '31': { class_type: 'StringConcatenate', inputs: { string_a: ['10', 2], string_b: ['30', 0], delimiter: ',' } } })['10']).toBe('loader_text')
    expect(kinds({ ...TRIGGER_WF, '31': { class_type: 'StringConcatenate', inputs: { string_a: ['33', 0], string_b: ['30', 0], delimiter: ',' } }, '33': { class_type: 'WidgetToString', inputs: { id: 30 } } })['33']).toBe('unknown_text')
  })
})

describe('实际问题复现：LoRA 变化时插件绕过开关', () => {
  const allWords = String(FIXTURE['34'].inputs.orinalMessage)

  it('开关全部关闭时：Loader 输出与保存时相同则没有注入；Loader 输出变化则全部触发词进入 Prompt', () => {
    expect(toggleOutput(FIXTURE['34'], allWords)).toBe('')
    expect(toggleOutput(FIXTURE['34'], 'other_char_outfit1, x,, other_char_outfit2, y')).toBe('other_char_outfit1, x,, other_char_outfit2, y')
  })

  it('任务停用工作流中的 LoRA 或改变加载列表：计划提示 #34 会绕过开关', () => {
    const entry = loraStackOf(FIXTURE['5'])![0]
    const off = { node: '5', input: 'loras', source: 'lora_stack', value: { __value__: loraStackOf(FIXTURE['5'])!.map((e) => (e === entry ? { ...e, active: !e.active } : e)) } }
    expect(loaderChangedBy(FIXTURE, [off], '5')).toBe(true)
    // 只改权重不影响插件输出的触发词
    const strength = { ...off, value: { __value__: loraStackOf(FIXTURE['5'])!.map((e) => (e === entry ? { ...e, strength: 0.1 } : e)) } }
    expect(loaderChangedBy(FIXTURE, [strength], '5')).toBe(false)
    expect(findPromptInjectors(applyInputs(FIXTURE, [off]), [], FIXTURE).find((x) => x.node === '34')!.bypass).toBe(true)
  })

  it('任务计划：触发词节点生效时给出带节点 ID 的提示；LoRA 变化时额外提示绕过', () => {
    const s = newStore()
    const lib = new Lib(s)
    lib.addWorkflow(TRIGGER_MAP, TRIGGER_WF)
    const w = planForTask(s, lib.makeTask([lib.item('睡觉', null, [], 1)])).warnings
    expect(w.some((m) => m.includes('#34（TriggerWord Toggle (LoraManager)）') && m.includes('2 / 2 组启用'))).toBe(true)
    expect(w.some((m) => m.includes('绕过工作流中保存的开关状态'))).toBe(false) // 角色 LoRA 与工作流相同
    const other = s.save('characters', { name: '角色C', positive: 'c', loras: [{ name: 'charB.safetensors', strength: 1 }] })
    const w2 = planForTask(s, lib.makeTask([lib.item('睡觉', null, [], 1)], '换角色', { character_id: other })).warnings
    expect(w2.some((m) => m.includes('改变了 #10') && m.includes('#34') && m.includes('绕过工作流中保存的开关状态'))).toBe(true)
    s.close()
  })
})

describe('禁止 TriggerWord Toggle 注入', () => {
  it('实际样本：只写入工作流副本；无论 Loader 输出如何，节点输出都为空；其他节点与连接不变', () => {
    const mapping = [...mergeMapping([], checked(FIXTURE)), newEntry(TRIGGER_DISABLE, '34', 'toggle_trigger_words')]
    expect(validateMapping(FIXTURE, mapping).filter(([l]) => l === 'error')).toEqual([])
    const before = JSON.stringify(FIXTURE)
    const inputs = mappingValues({ modules: {}, positive: 'p', negative: 'n', seed: 7, loras: [], meta: {}, index: 0 }, mapping, { compose_order: [], pos_module_separator: ',', neg_module_separator: ',' } as never, '20260101', FIXTURE)
    const graph = applyInputs(FIXTURE, inputs)
    expect(JSON.stringify(FIXTURE)).toBe(before) // 原始工作流不变
    expect(toggleOutput(graph['34'], 'anything, else')).toBe('')
    expect(toggleOutput(graph['34'], String(FIXTURE['34'].inputs.orinalMessage))).toBe('')
    expect(toggleOutput(graph['34'], '')).toBe('')
    const changed = diffWorkflow(FIXTURE, graph, inputs).changes.filter((c) => c.node === '34').map((c) => [c.input, c.source])
    // 样本中所有组本来就是关闭的，所以 toggle_trigger_words 没有差异
    expect(changed.sort()).toEqual([['orinalMessage', TRIGGER_DISABLE], ['trigger_words', TRIGGER_DISABLE]])
    // 其他节点中只有映射的 Prompt 与 Seed 变化；#5 与下游连接不变
    expect(graph['5']).toEqual(FIXTURE['5'])
    expect(graph['45'].inputs.string_a).toEqual(['34', 0])
    expect(Object.keys(graph)).toEqual(Object.keys(FIXTURE))
  })

  it('全部开关原本启用时也会关闭；每组的其他字段保留，__value__ 结构保留', () => {
    const inputs = toggleDisableInputs('34', TOGGLE)
    const graph = applyInputs(TRIGGER_WF, inputs)
    const v = graph['34'].inputs.toggle_trigger_words as { __value__: Record<string, unknown>[] }
    expect(v.__value__).toEqual([{ text: 'outfit_a1', active: false, highlighted: false, strength: null }, { text: 'outfit_a2', active: false, highlighted: false, strength: null }])
    expect(graph['34'].inputs.group_mode).toBe(true)
    expect(toggleOutput(graph['34'], 'outfit_a1,, outfit_a2')).toBe('')
    // 空列表时插件输出 orinalMessage：同样写空
    const empty: ApiNode = { class_type: LM_TRIGGER_TOGGLE, inputs: { group_mode: true, orinalMessage: 'x', toggle_trigger_words: { __value__: [] } } }
    expect(toggleOutput(applyInputs({ '1': empty }, toggleDisableInputs('1', empty))['1'], '')).toBe('')
  })

  it('不支持的节点不写入任何字段，并提示；LoRA Loader 不受影响', () => {
    expect(toggleDisableInputs('1', { class_type: 'SomeTriggerNode', inputs: { toggle_trigger_words: [], group_mode: true } })).toEqual([])
    expect(toggleDisableInputs('10', SAMPLE_WORKFLOW['10'])).toEqual([])
    const wf = { ...TRIGGER_WF, '34': { class_type: 'SomeTriggerNode', inputs: { foo: 'bar' } } }
    const mapping = [...TRIGGER_MAP, newEntry(TRIGGER_DISABLE, '34', 'toggle_trigger_words')]
    expect(validateMapping(wf, mapping).some(([l, m]) => l === 'warning' && m.includes('#34') && m.includes('不会写入'))).toBe(true)
    const s = newStore()
    const lib = new Lib(s)
    lib.addWorkflow(mapping, wf)
    const plan = planForTask(s, lib.makeTask([lib.item('睡觉', null, [], 1)]))
    expect(plan.errors).toEqual([])
    expect(plan.units[0].inputs!.filter((x) => x.node === '34')).toEqual([])
    expect(findPromptInjectors(wf, mapping).find((x) => x.node === '34')!.disabled).toBe(false)
    s.close()
  })

  it('插件声明的输入与已验证结构不同时，联网校验给出提示', () => {
    expect(checkAgainstObjectInfo(TRIGGER_WF, [], { [LM_TRIGGER_TOGGLE]: { input: { required: {} } } } as never).some(([, m]) => m.includes('#34') && m.includes('可能不生效'))).toBe(true)
    expect(checkAgainstObjectInfo(TRIGGER_WF, [], { [LM_TRIGGER_TOGGLE]: { input: { required: { group_mode: ['BOOLEAN', {}] } } } } as never).some(([, m]) => m.includes('#34'))).toBe(false)
  })

  it('用户不启用时节点保持原样：任务只提示，不修改', () => {
    const s = newStore()
    const lib = new Lib(s)
    lib.addWorkflow(TRIGGER_MAP, TRIGGER_WF)
    const plan = planForTask(s, lib.makeTask([lib.item('睡觉', null, [], 1)]))
    expect(plan.errors).toEqual([])
    expect(applyInputs(TRIGGER_WF, plan.units[0].inputs!)['34']).toEqual(TOGGLE)
    s.close()
  })
})

describe('工作流差异', () => {
  it('列出所有不同的字段，未修改的节点单独列出；尺寸来自实际提交的工作流', () => {
    const graph = applyInputs(SAMPLE_WORKFLOW, [
      { node: '3', input: 'seed', source: 'seed', value: 99 },
      { node: '5', input: 'width', source: 'width', value: 1536 },
      { node: '5', input: 'batch_size', source: 'x', value: null },
    ])
    graph['4'].inputs.ckpt_name = '其他模型' // 没有写入记录的差异也必须显示
    const { changes, unchanged } = diffWorkflow(SAMPLE_WORKFLOW, graph, [{ node: '3', input: 'seed', source: 'seed', value: 99 }, { node: '5', input: 'width', source: 'width', value: 1536 }])
    expect(changes.map((c) => [c.node, c.class_type, c.input, c.before, c.after, c.source])).toEqual([
      ['3', 'KSampler', 'seed', 1, 99, 'seed'],
      ['4', 'CheckpointLoaderSimple', 'ckpt_name', 'illustrious.safetensors', '其他模型', undefined],
      ['5', 'EmptyLatentImage', 'width', 832, 1536, 'width'],
    ])
    expect(unchanged.map((n) => n.node)).toEqual(['6', '7', '8', '9', '10'])
    expect(generationSize(graph)).toMatchObject({ node: '5', width: 1536, height: 1216 })
  })

  it('超过安全整数范围的输入会被指出', () => {
    const big = { ...SAMPLE_WORKFLOW, '40': { class_type: 'SeedNode', inputs: { seed: 2 ** 60 } } }
    expect(unsafeIntegers(big).map((u) => u.node)).toEqual(['40'])
    expect(unsafeIntegers(SAMPLE_WORKFLOW)).toEqual([])
  })
})

describe('提交快照（模拟 ComfyUI）', () => {
  let mock: MockComfy
  let s: Store
  let lib: Lib
  let runner: Runner | null
  beforeEach(async () => {
    mock = new MockComfy(0.02)
    await mock.serve(0)
    s = newStore()
    s.setSetting('comfy_url', mock.url)
    lib = new Lib(s)
    lib.addWorkflow()
    runner = null
  })
  afterEach(async () => {
    runner?.stop()
    await runner?.join()
    await mock.shutdown()
    s.close()
  })
  const start = () => {
    runner = new Runner(s, { eventsFactory: null })
    runner.start()
    return runner
  }
  const finish = async (runId: number, n: number) => {
    expect(await waitUntil(() => (s.runCounts(runId).done ?? 0) + (s.runCounts(runId).failed ?? 0) === n, 10000)).toBe(true)
    runner!.stop()
    await runner!.join()
    runner = null
  }

  it('快照就是发送的请求：逐张记录，与 ComfyUI 收到的工作流完全相同，历史核对通过', async () => {
    const { runId, plan } = enqueueTask(s, lib.makeTask([lib.item('睡觉', null, [], 2)]))
    start()
    await finish(runId!, 2)
    for (const [i, u] of s.listUnits(runId!).entries()) {
      const a = s.attempts(u.id)
      expect(a.length).toBe(1)
      expect(a[0].state).toBe('success')
      expect(a[0].prompt_id).toBe(u.prompt_id)
      expect(a[0].comfy_match).toBe(1)
      const stored = s.attemptBody(a[0].id)!
      expect(stored.intact).toBe(true)
      const body = JSON.parse(stored.body)
      expect(body.prompt_id).toBe(u.prompt_id)
      expect(body.client_id).toBe(u.client_id)
      expect(body.prompt).toEqual(mock.submitted[i][1])
      expect(body.prompt).toEqual(applyInputs(SAMPLE_WORKFLOW, plan.units[i].inputs!)) // 与预览一致
    }
  })

  it('之后修改素材、工作流不影响快照；列表查询不加载请求内容', async () => {
    const task = lib.makeTask([lib.item('睡觉', null, [], 1)])
    const { runId } = enqueueTask(s, task)
    // 入队后、提交前修改工作流与素材：不影响冻结的内容
    s.save('workflows', { id: s.getSetting('default_workflow_id')!, api_json: { ...SAMPLE_WORKFLOW, '3': { ...SAMPLE_WORKFLOW['3'], inputs: { ...SAMPLE_WORKFLOW['3'].inputs, steps: 1 } } } })
    s.save('templates', { id: lib.poses['睡觉'], positive: '已修改' })
    start()
    await finish(runId!, 1)
    const u = s.listUnits(runId!)[0]
    const body = s.attemptBody(s.attempts(u.id)[0].id)!.body
    expect(JSON.parse(body).prompt['3'].inputs.steps).toBe(28)
    expect(JSON.parse(body).prompt['6'].inputs.text).toContain('sleeping')
    expect(JSON.parse(body).prompt['6'].inputs.text).not.toContain('已修改')
    s.save('workflows', { id: s.getSetting('default_workflow_id')!, name: '改名' })
    expect(s.attemptBody(s.attempts(u.id)[0].id)!.body).toBe(body)
    expect(Object.keys(s.attempts(u.id)[0])).not.toContain('body')
    expect(Object.keys(s.history()[0])).not.toContain('body')
  })

  it('快照写入后不能修改：数据库拒绝更新', async () => {
    const { runId } = enqueueTask(s, lib.makeTask([lib.item('睡觉', null, [], 1)]))
    start()
    await finish(runId!, 1)
    const id = s.attempts(s.listUnits(runId!)[0].id)[0].id
    expect(() => s.db.prepare('UPDATE run_attempts SET body=? WHERE id=?').run(Buffer.from('x'), id)).toThrow()
    expect(() => s.db.prepare("UPDATE run_attempts SET body_sha256='x' WHERE id=?").run(id)).toThrow()
  })

  it('ComfyUI 拒绝时保留快照与错误详情，状态与执行失败区分；重试是新的尝试，内容不变', async () => {
    mock.rejectWith = { error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation', details: '' }, node_errors: { '3': { class_type: 'KSampler', errors: [{ message: 'seed 太大', details: '' }] } } }
    const { runId } = enqueueTask(s, lib.makeTask([lib.item('睡觉', null, [], 1)]))
    start()
    await finish(runId!, 1)
    const u = s.listUnits(runId!)[0]
    const [a] = s.attempts(u.id)
    expect(a.state).toBe('rejected')
    expect(a.error).toContain('seed 太大')
    expect(JSON.parse(a.response).node_errors['3'].class_type).toBe('KSampler')
    expect(a.submitted_at).toBeNull()
    const body1 = JSON.parse(s.attemptBody(a.id)!.body)
    expect(body1.prompt['3'].inputs.seed).toBe(u.seed)
    // 重试
    mock.rejectWith = null
    s.retryFailed(runId!)
    start()
    expect(await waitUntil(() => s.getUnit(u.id)!.status === 'done', 10000)).toBe(true)
    runner!.stop()
    await runner!.join()
    runner = null
    const all = s.attempts(u.id)
    expect(all.map((x) => [x.attempt, x.state])).toEqual([[1, 'rejected'], [2, 'success']])
    expect(JSON.parse(s.attemptBody(all[1].id)!.body).prompt).toEqual(body1.prompt)
  })

  it('执行失败与工作流无法构建都有明确状态', async () => {
    mock.failAll = true
    const { runId } = enqueueTask(s, lib.makeTask([lib.item('睡觉', null, [], 1)]))
    start()
    await finish(runId!, 1)
    expect(s.attempts(s.listUnits(runId!)[0].id)[0].state).toBe('failed')
    mock.failAll = false
    const task = lib.makeTask([lib.item('睡觉', null, [], 1)])
    const r2 = enqueueTask(s, task).runId!
    s.db.prepare('UPDATE runs SET workflow_json=? WHERE id=?').run('{}', r2) // 冻结的工作流损坏
    start()
    await finish(r2, 1)
    const [a] = s.attempts(s.listUnits(r2)[0].id)
    expect(a.state).toBe('build_failed')
    expect(s.attemptBody(a.id)).toBeNull()
    expect(mock.submitted.length).toBe(1)
  })

  it('任务恢复：程序重启后已完成的直接补记录，快照不变，不重新提交', async () => {
    const { runId } = enqueueTask(s, lib.makeTask([lib.item('睡觉', null, [], 1)]))
    mock.paused = true
    const r1 = start()
    expect(await waitUntil(() => mock.submitted.length === 1)).toBe(true)
    r1.stop()
    await waitUntil(() => s.listUnits(runId!)[0].status !== 'submitted')
    await r1.join()
    runner = null
    // 上面的停止会撤回排队中的任务；下面模拟提交后程序直接退出：单元保持 submitted
    const u = s.listUnits(runId!)[0]
    const pid = 'after-crash'
    const body = promptBody(applyInputs(SAMPLE_WORKFLOW, u.inputs), 'old-client', pid)
    s.createAttempt(u, body, 'built', { prompt_id: pid, client_id: 'old-client', unit: { status: 'submitting', prompt_id: pid } })
    mock.paused = false
    await new ComfyClient(mock.url).postPrompt(body)
    const submitted = mock.submitted.length
    expect(await waitUntil(() => pid in mock.history)).toBe(true)
    start()
    await finish(runId!, 1)
    const after = s.latestAttempt(u.id)!
    expect(after.prompt_id).toBe(pid)
    expect(after.state).toBe('success')
    expect(s.attemptBody(after.id)!.body).toBe(body)
    expect(mock.submitted.length).toBe(submitted)
    expect(s.getUnit(u.id)!.status).toBe('done')
  })

  it('任务恢复：ComfyUI 中丢失的重新提交时使用完全相同的工作流', async () => {
    const { runId } = enqueueTask(s, lib.makeTask([lib.item('睡觉', null, [], 1)]))
    const u = s.listUnits(runId!)[0]
    const body = promptBody(applyInputs(SAMPLE_WORKFLOW, u.inputs), 'old', 'gone')
    s.createAttempt(u, body, 'built', { prompt_id: 'gone', client_id: 'old', unit: { status: 'submitted', prompt_id: 'gone' } })
    start()
    await finish(runId!, 1)
    const all = s.attempts(u.id)
    expect(all.map((a) => a.state)).toEqual(['lost', 'success'])
    expect(JSON.parse(s.attemptBody(all[1].id)!.body).prompt).toEqual(JSON.parse(body).prompt)
  })

  it('禁用设置进入快照：提交的工作流中节点已关闭，执行详情可以检查', async () => {
    lib.addWorkflow([...TRIGGER_MAP, newEntry(TRIGGER_DISABLE, '34', 'toggle_trigger_words')], TRIGGER_WF)
    const { runId } = enqueueTask(s, lib.makeTask([lib.item('睡觉', null, [], 1)]))
    start()
    await finish(runId!, 1)
    const graph = JSON.parse(s.attemptBody(s.attempts(s.listUnits(runId!)[0].id)[0].id)!.body).prompt as ApiWorkflow
    expect(toggleOutput(graph['34'], 'outfit_a1,, outfit_a2')).toBe('')
    expect(toggleOutput(graph['34'], '其他 LoRA 的触发词')).toBe('')
    expect(findPromptInjectors(graph, s.getRun(runId!)!.mapping_json as MappingEntry[], TRIGGER_WF).find((x) => x.node === '34')!.disabled).toBe(true)
    expect(graph['10']).toEqual(applyInputs(TRIGGER_WF, s.listUnits(runId!)[0].inputs)['10'])
    expect(graph['31'].inputs.string_a).toEqual(['34', 0])
    expect(TRIGGER_WF['34']).toEqual(TOGGLE) // 原始工作流不变
  })

  it('一致性：直接调用 API 与通过 ComfyEngi 提交相同内容，ComfyUI 收到的工作流相同', async () => {
    const { runId, plan } = enqueueTask(s, lib.makeTask([lib.item('睡觉', null, [], 1)]))
    start()
    await finish(runId!, 1)
    const direct = applyInputs(SAMPLE_WORKFLOW, plan.units[0].inputs!)
    await new ComfyClient(mock.url).postPrompt(promptBody(direct, 'direct', 'direct-id'))
    expect(mock.submitted[1][1]).toEqual(mock.submitted[0][1])
    expect(JSON.stringify(mock.submitted[1][1])).toBe(JSON.stringify(mock.submitted[0][1])) // 字段顺序也相同
    const node = mock.submitted[0][1]
    // 未映射的自定义参数保持工作流原值
    expect(node['3'].inputs.steps).toBe(28)
    expect(node['3'].inputs.sampler_name).toBe('euler_ancestral')
  })
})

describe('输出来源与校验（模拟 ComfyUI）', () => {
  let mock: MockComfy
  let s: Store
  let lib: Lib
  let root: string
  let comfyOut: string
  let runner: Runner | null
  const WF: ApiWorkflow = { ...SAMPLE_WORKFLOW, '20': { class_type: 'SaveImage', inputs: { filename_prefix: 'mid/tmp', images: ['8', 0] } } }

  beforeEach(async () => {
    comfyOut = tempDir()
    mock = new MockComfy(0.02, comfyOut)
    await mock.serve(0)
    root = tempDir()
    createVault(root)
    s = openVault(root)
    s.setSetting('comfy_url', mock.url)
    lib = new Lib(s)
    lib.addWorkflow(SAMPLE_MAPPING, WF)
    runner = null
  })
  afterEach(async () => {
    runner?.stop()
    await runner?.join()
    await mock.shutdown()
    s.close()
  })
  const run = async (task: ReturnType<Lib['makeTask']>) => {
    const { runId, plan } = enqueueTask(s, task)
    expect(plan.errors).toEqual([])
    runner = new Runner(s, { eventsFactory: null })
    runner.start()
    expect(await waitUntil(() => (s.runCounts(runId!).done ?? 0) === plan.units.length, 10000)).toBe(true)
    await runner.join()
    return s.listUnits(runId!)
  }

  it('记录完整来源：Prompt ID、节点、文件名、角色、本地路径、双方哈希、实际宽高', async () => {
    const [u] = await run(lib.makeTask([lib.item('睡觉', null, [], 1)], '来源', { output: { prefix: 'x/img' } }))
    const final = u.outputs.find((o) => o.node === '9')!
    const mid = u.outputs.find((o) => o.node === '20')!
    expect(final).toMatchObject({ prompt_id: u.prompt_id, role: 'final', type: 'output', subfolder: 'x', image_width: 256, image_height: 256 })
    expect(final.saved).toBeTruthy()
    const onDisk = sha256(readFileSync(join(comfyOut, final.subfolder, final.filename)))
    expect(final.source_sha256).toBe(onDisk)
    expect(final.saved_sha256).toBe(onDisk)
    expect(sha256(readFileSync(final.saved!))).toBe(onDisk)
    expect(mid).toMatchObject({ prompt_id: u.prompt_id, role: 'intermediate' })
    expect(mid.saved).toBeUndefined()
    expect(mid.source_sha256).toBeUndefined()
    expect(u.outputs[primaryOutputIndex(u)].node).toBe('9')
  })

  it('已确认的问题：最终输出未保存时，预览不再因节点顺序选中中间结果', () => {
    const inputs = [{ node: '9', input: 'filename_prefix', source: 'filename_prefix', value: 'x' }]
    const mid: OutputFile = { node: '20', filename: 'mid.png', subfolder: '', type: 'output', path: '' }
    const final: OutputFile = { node: '9', filename: 'final.png', subfolder: '', type: 'output', path: '', save_error: '失败' }
    // ComfyUI 返回的节点顺序不保证最终输出在前；旧记录没有 role
    expect(primaryOutputIndex({ outputs: [mid, final], inputs })).toBe(1)
    expect(primaryOutputIndex({ outputs: [{ ...mid, role: 'intermediate' }, { ...final, role: 'final' }] })).toBe(1)
    const preview: OutputFile = { node: '99', filename: 'p.png', subfolder: '', type: 'temp', path: '' }
    expect(primaryOutputIndex({ outputs: [preview, final], inputs: [] })).toBe(1)
    expect(primaryOutputIndex({ outputs: [preview], inputs: [] })).toBe(0)
    expect(primaryOutputIndex({ outputs: [], inputs: [] })).toBe(-1)
  })

  it('没有映射输出前缀时多个最终输出都复制并分别记录，不静默选一个', async () => {
    const mapping = SAMPLE_MAPPING.filter((m) => m.source !== 'filename_prefix')
    lib.addWorkflow(mapping, WF)
    const [u] = await run(lib.makeTask([lib.item('睡觉', null, [], 1)], '多输出'))
    const finals = u.outputs.filter((o) => o.role === 'final')
    expect(finals.map((o) => o.node).sort()).toEqual(['20', '9'])
    expect(finals.every((o) => o.saved && o.source_sha256 === o.saved_sha256)).toBe(true)
    expect(new Set(finals.map((o) => o.saved)).size).toBe(2)
  })

  it('已确认的问题：不同节点报告同名文件时第二条记录不再被静默丢弃', async () => {
    const r = new Runner(s, { eventsFactory: null, clientFactory: () => new ComfyClient(mock.url) })
    const { runId } = enqueueTask(s, lib.makeTask([lib.item('睡觉', null, [], 1)]))
    const u = s.listUnits(runId!)[0]
    const mapping = { ...u, inputs: [{ node: '9', input: 'filename_prefix', source: 'filename_prefix', value: 'x' }, { node: '20', input: 'filename_prefix', source: 'filename_prefix', value: 'x' }] }
    writeFileSync(join(comfyOut, 'same.png'), tinyPng([1, 2, 3], 64))
    const outs: OutputFile[] = [
      { node: '9', filename: 'same.png', subfolder: '', type: 'output', path: '' },
      { node: '20', filename: 'same.png', subfolder: '', type: 'output', path: '' },
    ]
    await (r as unknown as { saveOutputs(u: unknown, o: OutputFile[], c: ComfyClient): Promise<void> }).saveOutputs(mapping, outs, new ComfyClient(mock.url))
    expect(outs[0].saved).toBeTruthy()
    expect(outs[1].saved).toBe(outs[0].saved)
    expect(outs[1].same_file_as_node).toBe('9')
    expect(readdirSync(join(root, 'output')).filter((f) => f.startsWith('same')).length).toBe(1)
  })

  it('同名文件：内容不同不覆盖（追加序号），内容相同直接关联（程序重启后继续复制不会多一份）', async () => {
    const dir = tempDir()
    const data = tinyPng([9, 9, 9], 32)
    writeFileSync(join(dir, 'a.png'), 'other')
    const r1 = await saveVerified(dir, 'a.png', data)
    expect(r1).toMatchObject({ path: join(dir, 'a (2).png'), reused: false })
    expect(readFileSync(join(dir, 'a.png'), 'utf8')).toBe('other')
    const r2 = await saveVerified(dir, 'a.png', data)
    expect(r2).toMatchObject({ path: join(dir, 'a (2).png'), reused: true })
    expect(readdirSync(dir).length).toBe(2)
    const r3 = await saveVerified(dir, 'a.png', tinyPng([1, 1, 1], 32))
    expect(r3.path).toBe(join(dir, 'a (3).png'))
  })

  it('保存后内容不一致：删除新文件并报错，不标记为成功', async () => {
    const dir = tempDir()
    await expect(saveVerified(dir, 'a.png', Buffer.from('abc'), async () => Buffer.from('xyz'))).rejects.toThrow('不一致')
    expect(existsSync(join(dir, 'a.png'))).toBe(false)
    const ok = await saveVerified(dir, 'a.png', Buffer.from('abc'))
    expect(ok.source_sha256).toBe(ok.saved_sha256)
  })

  it('任务重试不覆盖之前的图片：每次生成的文件分别保存，记录指向最新一次', async () => {
    const [u] = await run(lib.makeTask([lib.item('睡觉', null, [], 1)], '重试', { output: { prefix: 'r/img' } }))
    const first = u.outputs.find((o) => o.node === '9')!
    s.db.prepare("UPDATE run_units SET status='failed' WHERE id=?").run(u.id)
    s.retryFailed(u.run_id)
    runner = new Runner(s, { eventsFactory: null })
    runner.start()
    expect(await waitUntil(() => s.getUnit(u.id)!.status === 'done' && (s.getUnit(u.id)!.outputs ?? []).length > 0 && s.getUnit(u.id)!.prompt_id !== u.prompt_id, 10000)).toBe(true)
    await runner.join()
    const second = s.getUnit(u.id)!.outputs.find((o) => o.node === '9')!
    expect(second.prompt_id).not.toBe(first.prompt_id)
    expect(second.saved).not.toBe(first.saved)
    expect(existsSync(first.saved!)).toBe(true)
    expect(existsSync(second.saved!)).toBe(true)
  })

  it('确定性工作流：直接调用 API 与通过 ComfyEngi 提交，得到的图片内容相同（模拟的确定性节点）', async () => {
    mock.deterministic = true
    const [u] = await run(lib.makeTask([lib.item('睡觉', null, [], 1)], '确定性', { output: { prefix: 'd/img' } }))
    const stored = JSON.parse(s.attemptBody(s.attempts(u.id)[0].id)!.body).prompt as ApiWorkflow
    const direct = await new ComfyClient(mock.url).postPrompt(promptBody(stored, 'direct', 'direct-id'))
    expect(await waitUntil(() => direct.prompt_id in mock.history)).toBe(true)
    const entry = await new ComfyClient(mock.url).history('direct-id')
    const f = (entry!.outputs!['9'] as { images: { filename: string; subfolder: string }[] }).images[0]
    const directBytes = readFileSync(join(comfyOut, f.subfolder, f.filename))
    const final = u.outputs.find((o) => o.node === '9')!
    expect(sha256(directBytes)).toBe(final.source_sha256)
    expect(pngSize(directBytes)).toEqual({ width: 256, height: 256 })
  })
})
