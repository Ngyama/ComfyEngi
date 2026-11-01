// 工作流级节点控制：参数覆盖、节点绕过、与映射 / LoRA 配置 / TriggerWord 的冲突规则，以及预览、入队、提交是否一致。
// 节点定义 INFO 是按 ComfyUI 内置节点写的测试数据，全部使用模拟 ComfyUI，不能代替在真实 ComfyUI 与真实插件上的验证。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyInputs, BYPASS_REWIRE, isLink, NODE_BYPASS, NODE_OVERRIDE, newEntry, TRIGGER_DISABLE } from '@shared/mapping'
import { checkBypass, checkFrozenControls, checkOverrideValue, controlInputs, controlProblems, inputControl, inputSpec, mergeControlInputs, normalizeControls } from '@shared/node-controls'
import type { ApiWorkflow, MappingEntry, ObjectInfo, WorkflowControls } from '@shared/types'
import { diffWorkflow } from '@shared/workflow-analysis'
import { enqueueTask, finalWorkflow, planForTask } from '../src/main/plan'
import { Runner } from '../src/main/runner'
import type { Store } from '../src/main/store'
import { createVault, openVault } from '../src/main/vault'
import { Lib, newStore, SAMPLE_MAPPING, SAMPLE_WORKFLOW, tempDir, waitUntil } from './helpers'
import { MockComfy } from './mock-comfy'

const FIXTURE: ApiWorkflow = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'workflow-two-pass.json'), 'utf8'))

/** SAMPLE_WORKFLOW 在 LoRA 与采样器之间加了一个只有模型输入输出的节点 #20，以及一个没有使用者的预览 #21 */
const WF: ApiWorkflow = {
  ...structuredClone(SAMPLE_WORKFLOW),
  '20': { class_type: 'DifferentialDiffusion', inputs: { strength: 1, model: ['10', 0] } },
  '21': { class_type: 'PreviewImage', inputs: { images: ['8', 0] } },
}
WF['3'].inputs.model = ['20', 0]

const INFO: ObjectInfo = {
  KSampler: { input: { required: { seed: ['INT', { min: 0 }], steps: ['INT', { min: 1, max: 100 }], cfg: ['FLOAT', { min: 0, max: 30 }], sampler_name: [['euler', 'euler_ancestral']], scheduler: [['normal']], denoise: ['FLOAT', { min: 0, max: 1 }], model: ['MODEL'], positive: ['CONDITIONING'], negative: ['CONDITIONING'], latent_image: ['LATENT'] } }, output: ['LATENT'] },
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [['illustrious.safetensors']] } }, output: ['MODEL', 'CLIP', 'VAE'] },
  EmptyLatentImage: { input: { required: { width: ['INT', {}], height: ['INT', {}], batch_size: ['INT', {}] } }, output: ['LATENT'] },
  CLIPTextEncode: { input: { required: { text: ['STRING', {}], clip: ['CLIP'] } }, output: ['CONDITIONING'] },
  VAEDecode: { input: { required: { samples: ['LATENT'], vae: ['VAE'] } }, output: ['IMAGE'] },
  SaveImage: { input: { required: { images: ['IMAGE'], filename_prefix: ['STRING', {}] } }, output: [], output_node: true },
  PreviewImage: { input: { required: { images: ['IMAGE'] } }, output: [], output_node: true },
  LoraLoader: { input: { required: { model: ['MODEL'], clip: ['CLIP'], lora_name: [['charA.safetensors']], strength_model: ['FLOAT', {}], strength_clip: ['FLOAT', {}] } }, output: ['MODEL', 'CLIP'] },
  DifferentialDiffusion: { input: { required: { model: ['MODEL'], strength: ['FLOAT', { min: 0, max: 1 }] } }, output: ['MODEL'] },
}

const ov = (node: string, input: string, value: unknown, api: ApiWorkflow = WF): WorkflowControls['overrides'][number] => ({ node, input, class_type: api[node].class_type, value })
const controls = (c: Partial<WorkflowControls>): WorkflowControls => ({ overrides: [], bypass: [], ...c })
const bypassOf = (api: ApiWorkflow, nid: string, info: ObjectInfo = INFO, others: string[] = []) => {
  const r = checkBypass(api, nid, info, others)
  if (!r.ok) throw new Error(r.reason)
  return r.entry
}
const errorsOf = (m: [string, string][]) => m.filter(([l]) => l === 'error').map(([, t]) => t)
/** 所有连接都指向存在的节点 */
const dangling = (g: ApiWorkflow) => Object.entries(g).flatMap(([nid, n]) => Object.entries(n.inputs).filter(([, v]) => isLink(v) && !g[v[0]]).map(([k]) => `${nid}.${k}`))

describe('参数覆盖', () => {
  it('普通覆盖写入最终工作流，原始工作流不变', () => {
    const c = controls({ overrides: [ov('3', 'steps', 40)] })
    expect(controlProblems(WF, SAMPLE_MAPPING, c, INFO)).toEqual([])
    const orig = JSON.stringify(WF)
    const g = applyInputs(WF, controlInputs(WF, c))
    expect(g['3'].inputs.steps).toBe(40)
    expect(g['3'].inputs.cfg).toBe(WF['3'].inputs.cfg)
    expect(JSON.stringify(WF)).toBe(orig)
  })

  it('字符串、数字、布尔值按工作流原值的类型校验', () => {
    expect(checkOverrideValue('a', 'b')).toEqual([])
    expect(checkOverrideValue(1, 2.5)).toEqual([])
    expect(checkOverrideValue(true, false)).toEqual([])
    expect(checkOverrideValue({ a: 1 }, { a: 2 })).toEqual([])
    expect(checkOverrideValue([1, 2, 3], [1, 2])).toEqual([])
    expect(checkOverrideValue('a', 1)[0]).toContain('类型不匹配')
    expect(checkOverrideValue(1, '1')[0]).toContain('类型不匹配')
    expect(checkOverrideValue(true, 1)[0]).toContain('类型不匹配')
    expect(checkOverrideValue({ a: 1 }, 'x')[0]).toContain('类型不匹配')
  })

  it('无效值：空值、非法数字、超出安全整数；有节点定义时检查整数、范围与可选值', () => {
    expect(checkOverrideValue(1, null)[0]).toContain('不能为空')
    expect(checkOverrideValue(1, Number.NaN).join()).toContain('数值无效')
    expect(checkOverrideValue(1, 2 ** 60).join()).toContain('安全整数')
    const steps = inputSpec(INFO.KSampler, 'steps')
    expect(checkOverrideValue(20, 1.5, steps).join()).toContain('整数')
    expect(checkOverrideValue(20, 500, steps).join()).toContain('最大值')
    expect(checkOverrideValue(20, 0, steps).join()).toContain('最小值')
    expect(checkOverrideValue('euler', 'nope', inputSpec(INFO.KSampler, 'sampler_name')).join()).toContain('可选列表')
    expect(checkOverrideValue('euler', 'euler_ancestral', inputSpec(INFO.KSampler, 'sampler_name'))).toEqual([])
    expect(inputSpec({ input: { required: { x: ['COMBO', { options: ['a'] }] } } }, 'x')).toEqual({ type: 'COMBO', options: ['a'] })
    // 离线（没有节点定义）：只做基础检查，简单字面值仍然可以编辑
    expect(checkOverrideValue(20, 500, null)).toEqual([])
    const bad = controls({ overrides: [ov('3', 'steps', 500)] })
    expect(controlProblems(WF, SAMPLE_MAPPING, bad)).toEqual([])
    expect(errorsOf(controlProblems(WF, SAMPLE_MAPPING, bad, INFO)).join()).toContain('最大值')
    expect(checkFrozenControls(WF, controlInputs(WF, bad), INFO)[0][1]).toContain('最大值')
  })

  it('连接输入受保护：不能覆盖，值也不能写成连接的形式', () => {
    const c = controls({ overrides: [ov('3', 'model', ['4', 0])] })
    expect(errorsOf(controlProblems(WF, [], c)).join()).toContain('节点连接')
    expect(inputControl(WF, [], controls({}), '3', 'model').blocked).toBeTruthy()
    // 原值是普通数组时，也不接受 [字符串, 整数] 形式
    expect(checkOverrideValue(['a', 'b'], ['5', 0])[0]).toContain('节点连接')
    // 普通数组不会被当作连接
    expect(isLink(['a', 'b'])).toBe(false)
    expect(checkOverrideValue(['a', 'b'], ['c', 'd'])).toEqual([])
  })

  it('与映射冲突：已映射的 Seed 再设固定值时报错，不决定谁优先', () => {
    const c = controls({ overrides: [ov('3', 'seed', 7)] })
    expect(inputControl(WF, SAMPLE_MAPPING, controls({}), '3', 'seed').state).toBe('mapping')
    const errs = errorsOf(controlProblems(WF, SAMPLE_MAPPING, c))
    expect(errs.join()).toContain('冲突')
    expect(errs.join()).toContain('节点 #3')
    expect(errs.join()).toContain('seed')
  })

  it('与 LoRA 配置冲突：标准 Loader 与 LoraManager 列表都不接受覆盖', () => {
    const map = SAMPLE_MAPPING.filter((m) => !m.source.startsWith('lora1'))
    expect(inputControl(WF, map, controls({}), '10', 'lora_name').state).toBe('lora')
    for (const k of ['lora_name', 'strength_model']) expect(errorsOf(controlProblems(WF, map, controls({ overrides: [ov('10', k, k === 'lora_name' ? 'x' : 0.5)] }))).join()).toContain('任务 LoRA 配置')
    expect(errorsOf(controlProblems(FIXTURE, [], controls({ overrides: [ov('5', 'loras', { __value__: [] }, FIXTURE)] }))).join()).toContain('任务 LoRA 配置')
    expect(errorsOf(controlProblems(FIXTURE, [], controls({ overrides: [ov('5', 'text', 'x', FIXTURE)] }))).join()).toContain('任务 LoRA 配置')
  })

  it('写入时再按每张图的实际写入值检查一次冲突', () => {
    const ctl = controlInputs(WF, controls({ overrides: [ov('3', 'steps', 40)] }))
    const r = mergeControlInputs(WF, [{ node: '3', input: 'steps', source: 'lora_config', value: 1 }], ctl)
    expect(r.conflicts[0]).toContain('冲突')
    // 映射保持原值（null）不算写入
    expect(mergeControlInputs(WF, [{ node: '3', input: 'steps', source: 'seed', value: null }], ctl).conflicts).toEqual([])
    expect(mergeControlInputs(WF, [{ node: '3', input: 'seed', source: 'seed', value: 1 }], ctl).inputs).toHaveLength(2)
  })

  it('复杂插件输入：只允许合法 JSON，结构检查不猜含义', () => {
    const toggle = FIXTURE['34']
    expect(checkOverrideValue(toggle.inputs.toggle_trigger_words, { __value__: [] })).toEqual([])
    expect(checkOverrideValue(toggle.inputs.toggle_trigger_words, 'x')[0]).toContain('类型不匹配')
    expect(controlProblems(FIXTURE, [], controls({ overrides: [ov('34', 'toggle_trigger_words', { __value__: [] }, FIXTURE)] }))).toEqual([])
  })
})

describe('TriggerWord Toggle', () => {
  const disable = [newEntry(TRIGGER_DISABLE, '34', 'toggle_trigger_words')]
  it('禁止注入保持有效，不受其他节点的覆盖影响', () => {
    const other = controls({ overrides: [ov('101', 'scale_by', 3, FIXTURE)] })
    expect(controlProblems(FIXTURE, disable, other)).toEqual([])
    expect(inputControl(FIXTURE, disable, other, '34', 'orinalMessage').state).toBe('trigger')
  })
  it('覆盖禁止注入要写入的输入时报冲突', () => {
    const errs = errorsOf(controlProblems(FIXTURE, disable, controls({ overrides: [ov('34', 'toggle_trigger_words', { __value__: [] }, FIXTURE)] })))
    expect(errs.join()).toContain('禁止触发词注入')
    expect(errs.join()).toContain('#34')
  })
  it('不能绕过触发词节点，提示使用禁止注入', () => {
    const r = checkBypass(FIXTURE, '34', { [FIXTURE['34'].class_type]: { input: { required: {} }, output: ['STRING'] } })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toContain('禁止该节点自动注入触发词')
    const forged = controls({ bypass: [{ node: '34', class_type: FIXTURE['34'].class_type, routes: [] }] })
    expect(errorsOf(controlProblems(FIXTURE, [], forged)).join()).toContain('不支持绕过')
  })
})

describe('节点绕过', () => {
  it('类型确认的简单节点：移除节点，下游改接上游，没有悬空连接，恢复后回到原连接', () => {
    const entry = bypassOf(WF, '20')
    expect(entry.routes).toEqual([{ output: 0, input: 'model', type: 'MODEL' }])
    const c = controls({ bypass: [entry] })
    expect(errorsOf(controlProblems(WF, SAMPLE_MAPPING, c, INFO))).toEqual([])
    const orig = JSON.stringify(WF)
    const inputs = controlInputs(WF, c)
    expect(inputs).toEqual([
      { node: '3', input: 'model', source: BYPASS_REWIRE, value: ['10', 0] },
      { node: '20', input: '*', source: NODE_BYPASS, value: true },
    ])
    const g = applyInputs(WF, inputs)
    expect(g['20']).toBeUndefined()
    expect(g['3'].inputs.model).toEqual(['10', 0])
    expect(dangling(g)).toEqual([])
    expect(JSON.stringify(WF)).toBe(orig)
    // 恢复：去掉配置后最终工作流与原始工作流相同
    expect(applyInputs(WF, controlInputs(WF, controls({})))).toEqual(WF)
    const { changes } = diffWorkflow(WF, g, inputs)
    expect(changes.map((x) => [x.node, x.input, x.source])).toEqual([['3', 'model', BYPASS_REWIRE], ['20', '*', NODE_BYPASS]])
  })

  it('连续绕过多个节点时解析到最上游', () => {
    const api: ApiWorkflow = { ...WF, '22': { class_type: 'DifferentialDiffusion', inputs: { strength: 1, model: ['20', 0] } } }
    api['3'] = { ...api['3'], inputs: { ...api['3'].inputs, model: ['22', 0] } }
    const c = controls({ bypass: [bypassOf(api, '20'), bypassOf(api, '22')] })
    expect(errorsOf(controlProblems(api, [], c, INFO))).toEqual([])
    const g = applyInputs(api, controlInputs(api, c))
    expect(g['3'].inputs.model).toEqual(['10', 0])
    expect(dangling(g)).toEqual([])
  })

  it('多输出 Loader：每个被使用的输出都有确认的路径', () => {
    const entry = bypassOf(WF, '10')
    expect(entry.routes.map((r) => r.input).sort()).toEqual(['clip', 'model'])
    const c = controls({ bypass: [entry] })
    const g = applyInputs(WF, controlInputs(WF, c))
    expect(g['20'].inputs.model).toEqual(['4', 0])
    expect(g['6'].inputs.clip).toEqual(['4', 1])
    expect(dangling(g)).toEqual([])
  })

  it('没有使用者的预览节点：直接不提交；不能绕过工作流唯一的输出', () => {
    expect(bypassOf(WF, '21').routes).toEqual([])
    const r = checkBypass(WF, '9', INFO, ['21'])
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toContain('没有输出节点')
    expect(checkBypass(WF, '9', INFO).ok).toBe(true)
    const saveOnly = controls({ bypass: [bypassOf(WF, '9')] })
    expect(errorsOf(controlProblems(WF, [], saveOnly)).join()).toContain('所有保存节点')
  })

  it('信息不足或结构复杂的节点一律拒绝并说明原因', () => {
    const reason = (api: ApiWorkflow, nid: string, info: ObjectInfo | null = INFO) => {
      const r = checkBypass(api, nid, info)
      return r.ok ? '' : r.reason
    }
    expect(reason(WF, '20', null)).toContain('没有连接 ComfyUI')
    expect(reason(WF, '20', { ...INFO, DifferentialDiffusion: undefined as never })).toContain('节点定义')
    expect(reason(WF, 'nope')).toContain('没有这个节点')
    expect(reason(WF, '6')).toContain('没有同类型的输入') // CLIPTextEncode：CONDITIONING 输出没有同类型输入
    // 没有来源的输入
    expect(reason({ ...WF, '20': { class_type: 'DifferentialDiffusion', inputs: { strength: 1 } } }, '20')).toContain('没有连接')
    // 多个同类型输入（ControlNetApplyAdvanced 的 positive / negative）：不猜
    const cn: ObjectInfo = { ...INFO, Ctl: { input: { required: { positive: ['CONDITIONING'], negative: ['CONDITIONING'] } }, output: ['CONDITIONING', 'CONDITIONING'] } }
    const cnApi: ApiWorkflow = { ...WF, '30': { class_type: 'Ctl', inputs: { positive: ['6', 0], negative: ['7', 0] } } }
    cnApi['3'] = { ...cnApi['3'], inputs: { ...cnApi['3'].inputs, positive: ['30', 0], negative: ['30', 1] } }
    expect(reason(cnApi, '30', cn)).toContain('多个 CONDITIONING')
    const two: ObjectInfo = { ...INFO, Blend: { input: { required: { a: ['IMAGE'], b: ['IMAGE'] } }, output: ['IMAGE'] } }
    const twoApi: ApiWorkflow = { ...WF, '31': { class_type: 'Blend', inputs: { a: ['8', 0], b: ['8', 0] } } }
    twoApi['9'] = { ...twoApi['9'], inputs: { ...twoApi['9'].inputs, images: ['31', 0] } }
    expect(reason(twoApi, '31', two)).toContain('同类型输入')
    // 任意类型、未声明的输出、列表节点、上游类型未知
    const anyT: ObjectInfo = { ...INFO, DifferentialDiffusion: { input: { required: { model: ['*'] } }, output: ['*'] } }
    expect(reason(WF, '20', anyT)).toContain('任意类型')
    expect(reason(WF, '20', { ...INFO, DifferentialDiffusion: { input: { required: { model: ['MODEL'] } } } })).toContain('没有声明输出')
    expect(reason(WF, '20', { ...INFO, DifferentialDiffusion: { ...INFO.DifferentialDiffusion, output_is_list: [true] } })).toContain('列表')
    expect(reason(WF, '20', { ...INFO, LoraLoader: undefined as never })).toContain('未知')
    // LoRA Loader 的触发词输出被 Toggle 使用：没有 STRING 连接可以替代
    const lm: ObjectInfo = { [FIXTURE['5'].class_type]: { input: { required: { model: ['MODEL'], text: ['STRING', {}] }, optional: { clip: ['CLIP'] } }, output: ['MODEL', 'CLIP', 'STRING', 'STRING'] } }
    const lmFull: ObjectInfo = { ...lm, ...Object.fromEntries(Object.values(FIXTURE).filter((n) => n.class_type !== FIXTURE['5'].class_type).map((n) => [n.class_type, { output: ['MODEL', 'CLIP'] }])), CLIPSetLastLayer: { output: ['CLIP'] } }
    expect(reason(FIXTURE, '5', lmFull)).toContain('STRING')
  })

  it('已绕过节点上的映射、覆盖、LoRA 配置都会报告节点、字段与原因', () => {
    const c = controls({ bypass: [bypassOf(WF, '20')] })
    const mapped: MappingEntry[] = [newEntry('seed', '20', 'strength')]
    const errs = errorsOf(controlProblems(WF, mapped, c)).join()
    expect(errs).toContain('#20')
    expect(errs).toContain('strength')
    expect(errorsOf(controlProblems(WF, [], { ...c, overrides: [ov('20', 'strength', 0.5)] })).join()).toContain('不会生效')
    const r = mergeControlInputs(WF, [{ node: '20', input: 'strength', source: 'lora_config', value: 1 }], controlInputs(WF, c))
    expect(r.conflicts[0]).toContain('#20')
    expect(r.conflicts[0]).toContain('strength')
    expect(r.conflicts[0]).toContain('任务 LoRA 配置')
  })

  it('applyInputs 拒绝留下悬空连接（配置与工作流不一致时不提交）', () => {
    expect(() => applyInputs(WF, [{ node: '20', input: '*', source: NODE_BYPASS, value: true }])).toThrow('不存在的节点')
  })
})

describe('工作流更新', () => {
  const c = controls({ overrides: [ov('3', 'steps', 40)], bypass: [bypassOf(WF, '20')] })
  it('节点 ID 不存在、类型变化或输入消失时报告失效，不静默跳过', () => {
    const noNode = structuredClone(WF)
    delete noNode['20']
    noNode['3'].inputs.model = ['10', 0]
    expect(errorsOf(controlProblems(noNode, [], c)).join()).toContain('已没有节点 #20')
    const changed = structuredClone(WF)
    changed['3'] = { class_type: 'KSamplerAdvanced', inputs: { ...changed['3'].inputs } }
    changed['20'] = { class_type: 'Other', inputs: { model: ['10', 0] } }
    const errs = errorsOf(controlProblems(changed, [], c)).join()
    expect(errs).toContain('现在是 KSamplerAdvanced')
    expect(errs).toContain('现在是 Other')
    const noInput = structuredClone(WF)
    delete noInput['3'].inputs.steps
    expect(errorsOf(controlProblems(noInput, [], c)).join()).toContain('已不存在')
    // 输入变成了连接
    const linked = structuredClone(WF)
    linked['3'].inputs.steps = ['5', 0]
    expect(errorsOf(controlProblems(linked, [], c)).join()).toContain('节点连接')
    // 下游使用了路由之外的输出
    const other = structuredClone(WF)
    other['6'].inputs.clip = ['20', 1]
    expect(errorsOf(controlProblems(other, [], c)).join()).toContain('输出 1')
  })
})

describe('配置格式', () => {
  it('只保留已知字段，拒绝错误结构', () => {
    expect(normalizeControls(null)).toBeNull()
    expect(normalizeControls({ overrides: [{ node: '3', input: 'steps', class_type: 'KSampler', value: 1, junk: 1 }] })).toEqual({ overrides: [{ node: '3', input: 'steps', class_type: 'KSampler', value: 1 }], bypass: [] })
    expect(() => normalizeControls({ overrides: 'x' })).toThrow()
    expect(() => normalizeControls({ overrides: [{ node: '3', input: 'steps', class_type: 'K', value: null }] })).toThrow('不能为空')
    expect(() => normalizeControls({ bypass: [{ node: '3', class_type: 'K', routes: [{ output: -1, input: 'x', type: 'T' }] }] })).toThrow()
  })
})

describe('计划、入队与提交', () => {
  let s: Store
  let lib: Lib
  let mock: MockComfy
  let runner: Runner | null
  const useWorkflow = (c: WorkflowControls | null, mapping = SAMPLE_MAPPING, api = WF) => {
    const id = s.save('workflows', { name: '节点控制', api_json: api, mapping, ...(c ? { controls: c } : {}) })
    s.setSetting('default_workflow_id', id)
    return id
  }
  const task = (n = 1) => lib.makeTask([lib.item('睡觉', null, [], n)])
  beforeEach(async () => {
    mock = new MockComfy(0.02)
    await mock.serve(0)
    s = newStore()
    s.setSetting('comfy_url', mock.url)
    lib = new Lib(s)
    runner = null
  })
  afterEach(async () => {
    runner?.stop()
    await runner?.join()
    await mock.shutdown()
    s.close()
  })
  const run = async (runId: number, n: number) => {
    runner = new Runner(s, { eventsFactory: null })
    runner.start()
    expect(await waitUntil(() => (s.runCounts(runId).done ?? 0) === n, 10000)).toBe(true)
  }

  it('没有新配置的工作流完全不变', () => {
    const id = useWorkflow(null)
    const a = planForTask(s, task(2), undefined, '2026-01-01')
    s.save('workflows', { id, controls: controls({}) })
    const b = planForTask(s, task(2), undefined, '2026-01-01')
    expect(b.units.map((u) => u.inputs)).toEqual(a.units.map((u) => u.inputs))
    expect(a.units[0].inputs!.some((x) => [NODE_OVERRIDE, NODE_BYPASS, BYPASS_REWIRE].includes(x.source))).toBe(false)
    expect(a.errors).toEqual(b.errors)
    expect(a.warnings).toEqual(b.warnings)
    // 旧记录：没有节点控制写入值时，applyInputs 不做连接检查（行为与之前相同）
    const broken: ApiWorkflow = { '1': { class_type: 'X', inputs: { a: ['9', 0] } } }
    expect(applyInputs(broken, [])).toEqual(broken)
    expect(s.get('workflows', id)!.mapping).toEqual(SAMPLE_MAPPING)
  })

  it('预览的 JSON 与实际提交的 JSON 完全相同，配置冲突时不能入队也不构建预览', async () => {
    useWorkflow(controls({ overrides: [ov('3', 'steps', 40), ov('5', 'width', 640)], bypass: [bypassOf(WF, '20'), bypassOf(WF, '21')] }))
    const t = task(1)
    const preview = finalWorkflow(s, t, 0)
    expect(preview.json['3'].inputs.steps).toBe(40)
    expect(preview.json['20']).toBeUndefined()
    const sources = preview.changes.map((c) => [c.node, c.input, c.source])
    expect(sources).toContainEqual(['3', 'steps', NODE_OVERRIDE])
    expect(sources).toContainEqual(['20', '*', NODE_BYPASS])
    expect(sources).toContainEqual(['3', 'model', BYPASS_REWIRE])
    const { runId } = enqueueTask(s, t)
    await run(runId!, 1)
    expect(mock.submitted[0][1]).toEqual(preview.json)
    const unit = s.listUnits(runId!)[0]
    const stored = JSON.parse(s.attemptBody(s.latestAttempt(unit.id)!.id)!.body).prompt
    expect(stored).toEqual(preview.json)
    // 冻结的是原始工作流与写入值，队列项里仍有被绕过的节点
    expect((s.getRun(runId!)!.workflow_json as unknown as ApiWorkflow)['20']).toBeDefined()
  })

  it('配置冲突：有错误，不能入队，预览给出原因', () => {
    useWorkflow(controls({ overrides: [ov('3', 'seed', 7)] }))
    const t = task(1)
    const plan = planForTask(s, t)
    expect(plan.errors.join()).toContain('冲突')
    expect(plan.units[0].inputs).toBeUndefined()
    expect(enqueueTask(s, t).runId).toBeNull()
    expect(() => finalWorkflow(s, t, 0)).toThrow('节点控制')
  })

  it('已入队的任务不受之后的配置修改影响', async () => {
    const id = useWorkflow(controls({ overrides: [ov('3', 'steps', 40)] }))
    const t = task(1)
    const { runId } = enqueueTask(s, t)
    s.save('workflows', { id, controls: controls({ overrides: [ov('3', 'steps', 12)], bypass: [bypassOf(WF, '20')] }) })
    await run(runId!, 1)
    expect(mock.submitted[0][1]['3'].inputs.steps).toBe(40)
    expect(mock.submitted[0][1]['20']).toBeDefined()
    // 新任务才使用新配置
    expect(finalWorkflow(s, t, 0).json['3'].inputs.steps).toBe(12)
  })

  it('任务 LoRA 配置与绕过 Loader：角色 LoRA 不会被静默丢弃', () => {
    const map = SAMPLE_MAPPING.filter((m) => !m.source.startsWith('lora1'))
    useWorkflow(controls({ bypass: [bypassOf(WF, '10')] }), map)
    const plan = planForTask(s, task(1))
    expect(plan.errors.join()).toContain('节点绕过')
    expect(plan.errors.join()).toContain('#10')
    expect(plan.units[0].inputs).toBeUndefined()
  })

  it('未被绕过的 LoRA 控制不受其他节点控制影响', () => {
    const map = SAMPLE_MAPPING.filter((m) => !m.source.startsWith('lora1'))
    const a = (useWorkflow(null, map), planForTask(s, task(1), undefined, '2026-01-01'))
    useWorkflow(controls({ overrides: [ov('3', 'steps', 40)] }), map)
    const b = planForTask(s, task(1), undefined, '2026-01-01')
    expect(b.units[0].inputs!.filter((x) => x.source === 'lora_config')).toEqual(a.units[0].inputs!.filter((x) => x.source === 'lora_config'))
  })

  it('配置随工作区保存：写入工作流文件，重新打开后仍在，导入的 api_json 不变', () => {
    const root = tempDir()
    createVault(root)
    const v = openVault(root)
    const c = controls({ overrides: [ov('3', 'steps', 40)] })
    const id = v.save('workflows', { name: '工作区', api_json: WF, mapping: SAMPLE_MAPPING, controls: c })
    v.close()
    const v2 = openVault(root)
    const wf = v2.get('workflows', id)!
    expect(wf.controls).toEqual(c)
    expect(wf.api_json).toEqual(WF)
    v2.close()
  })
})
