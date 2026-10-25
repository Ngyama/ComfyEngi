// LoRA 槽位：LoRA 是工作流参数，直接写入 LoRA Loader 节点（lora_name / strength_model / strength_clip），不拼入 Prompt。
// 一个逻辑槽位可以绑定多个 Loader（例如两次采样），工作流中未被映射的固定 LoRA 保持原样。

import { describe, expect, it } from 'vitest'
import { applyInputs, findLoraLoaders, loraBindingEntries, type LoraLoaderInfo } from '@shared/mapping'
import { expandTask } from '@shared/planner'
import type { ApiWorkflow, MappingEntry, TaskItem, TaskLora } from '@shared/types'
import { enqueueTask, loadPlanLibrary, planForTask } from '../src/main/plan'
import { Lib, newStore, SAMPLE_MAPPING, SAMPLE_WORKFLOW } from './helpers'

const L = (lora: string, model = 1, clip = 1, prev = '4') => ({ class_type: 'LoraLoader', inputs: { lora_name: lora, strength_model: model, strength_clip: clip, model: [prev, 0], clip: [prev, 1] } })
/** 两次采样：10 与 12 分别是第一次、第二次采样的角色 Loader；20 / 21 画风与辅助；30 是工作流中固定的细节 LoRA */
const WF: ApiWorkflow = {
  ...SAMPLE_WORKFLOW,
  '10': L('placeholder_char.safetensors'),
  '12': L('placeholder_char.safetensors', 1, 1, '10'),
  '13': { class_type: 'LoraLoader', inputs: { lora_name: 'placeholder_second.safetensors', strength_model: 1, strength_clip: 1, model: ['12', 0], clip: ['12', 1] } },
  '20': L('placeholder_style.safetensors', 1, 1, '13'),
  '21': L('placeholder_aux.safetensors', 1, 1, '20'),
  '30': L('fixed_detail.safetensors', 0.6, 0.5, '21'),
}
const base = SAMPLE_MAPPING.filter((m) => !m.source.startsWith('lora'))
const loaders = new Map(findLoraLoaders(WF).map((l) => [l.node, l]))
const bindTo = (prefix: string, ...nodes: string[]): MappingEntry[] => nodes.flatMap((n) => loraBindingEntries(prefix, loaders.get(n) as LoraLoaderInfo))
const tl = (slot: number, label: string, name: string, model = 1, clip = 1, enabled = true): TaskLora => ({ slot, label, name, enabled, strength_model: model, strength_clip: clip })

function setup(mapping: MappingEntry[], items?: (lib: Lib) => TaskItem[], extra: Record<string, unknown> = {}) {
  const s = newStore()
  const lib = new Lib(s)
  lib.addWorkflow(mapping, WF)
  const charM = s.save('characters', { name: '男角色', positive: '1boy', loras: [{ name: 'charM.safetensors', strength: 0.7 }] })
  const t = lib.makeTask(items ? items(lib) : [lib.item('睡觉', null, [], 1)], 't', { male_base_id: null, second_character_id: charM, ...extra })
  const plan = planForTask(s, t)
  const node = (i: number, n: string) => Object.fromEntries(plan.units[i].inputs!.filter((x) => x.node === n).map((x) => [x.input, x.value]))
  const graph = (i: number) => applyInputs(WF, plan.units[i].inputs!)
  return { s, lib, t, plan, node, graph }
}

describe('LoRA Loader 识别', () => {
  it('标准 Loader 完全支持；带强度输入的自定义 Loader 兼容；只有 lora_name 的为部分支持', () => {
    const api: ApiWorkflow = {
      '1': { class_type: 'LoraLoader', inputs: { lora_name: 'a', strength_model: 1, strength_clip: 1 } },
      '2': { class_type: 'LoraLoaderModelOnly', inputs: { lora_name: 'b', strength_model: 1 } },
      '3': { class_type: 'MyLoraLoader', inputs: { lora_name: 'c', strength_model: 1 } },
      '4': { class_type: 'WeirdLora', inputs: { lora_name: 'd', weight: 1 } },
      '5': { class_type: 'CLIPTextEncode', inputs: { text: 'x' } },
    }
    expect(findLoraLoaders(api).map((l) => [l.node, l.support, l.strengths])).toEqual([
      ['1', 'standard', ['strength_model', 'strength_clip']],
      ['2', 'standard', ['strength_model']],
      ['3', 'compatible', ['strength_model']],
      ['4', 'partial', []],
    ])
  })
})

describe('LoRA 写入工作流节点', () => {
  it('1. 单个角色 LoRA 写入一个 Loader（Model / Clip 分别写入），不拼入 Prompt', () => {
    const { plan, node, graph } = setup([...base, ...bindTo('lora1', '10')])
    expect(plan.errors).toEqual([])
    expect(node(0, '10')).toEqual({ lora_name: 'charA.safetensors', strength_model: 0.8, strength_clip: 0.8 })
    expect(graph(0)['10'].inputs).toMatchObject({ lora_name: 'charA.safetensors', strength_model: 0.8, strength_clip: 0.8 })
    expect(plan.units[0].positive).not.toMatch(/<lora:/)
    // 任务中调整权重、替换模型：只影响本任务
    const r = setup([...base, ...bindTo('lora1', '10')], undefined, { lora_overrides: { lora1: { enabled: true, name: 'other.safetensors', strength_model: 0.6, strength_clip: 0.4 } } })
    expect(r.node(0, '10')).toEqual({ lora_name: 'other.safetensors', strength_model: 0.6, strength_clip: 0.4 })
  })

  it('2. 同一个角色 LoRA 写入两次采样的两个 Loader，任务中只改一次', () => {
    const { plan, node } = setup([...base, ...bindTo('lora1', '10', '12')], undefined, { lora_overrides: { lora1: { enabled: true, strength_model: 0.65, strength_clip: 0.5 } } })
    expect(plan.errors).toEqual([])
    for (const n of ['10', '12']) expect(node(0, n)).toEqual({ lora_name: 'charA.safetensors', strength_model: 0.65, strength_clip: 0.5 })
  })

  it('3. 任务级画风 LoRA 写入一个 Loader', () => {
    const { plan, node } = setup([...base, ...bindTo('lora1', '10'), ...bindTo('task_lora1', '20')], undefined, { task_loras: [tl(1, '画风 LoRA A', 'style_a.safetensors', 0.9, 0.7)] })
    expect(plan.errors).toEqual([])
    expect(node(0, '20')).toEqual({ lora_name: 'style_a.safetensors', strength_model: 0.9, strength_clip: 0.7 })
  })

  it('4. 多个任务级 LoRA 同时存在；禁用的任务 LoRA 强度写 0', () => {
    const mapping = [...base, ...bindTo('lora1', '10'), ...bindTo('task_lora1', '20'), ...bindTo('task_lora2', '21')]
    const { plan, node } = setup(mapping, undefined, { task_loras: [tl(1, '画风', 'style.safetensors', 0.9, 0.9), tl(2, '辅助', 'aux.safetensors', 0.3, 0.2)] })
    expect(plan.errors).toEqual([])
    expect(node(0, '20')).toEqual({ lora_name: 'style.safetensors', strength_model: 0.9, strength_clip: 0.9 })
    expect(node(0, '21')).toEqual({ lora_name: 'aux.safetensors', strength_model: 0.3, strength_clip: 0.2 })
    const off = setup(mapping, undefined, { task_loras: [tl(1, '画风', 'style.safetensors', 0.9, 0.9), tl(2, '辅助', 'aux.safetensors', 0.3, 0.2, false)] })
    expect(off.plan.errors).toEqual([])
    expect(off.node(0, '21')).toEqual({ lora_name: null, strength_model: 0, strength_clip: 0 })
    expect(off.graph(0)['21'].inputs).toMatchObject({ lora_name: 'placeholder_aux.safetensors', strength_model: 0, strength_clip: 0 })
  })

  it('5. 第二角色未出场的图片不加载第二角色 LoRA；出场的图片加载', () => {
    const mapping = [...base, ...bindTo('lora1', '10'), ...bindTo('second_lora1', '13')]
    const { plan, node } = setup(mapping, (lib) => [lib.item('睡觉', null, [], 1, { second_enabled: true }), lib.item('鸭子坐', null, [], 1)])
    expect(plan.errors).toEqual([])
    expect(node(0, '13')).toEqual({ lora_name: 'charM.safetensors', strength_model: 0.7, strength_clip: 0.7 })
    expect(node(1, '13')).toEqual({ lora_name: null, strength_model: 0, strength_clip: 0 })
    // 在任务中禁用第二角色 LoRA：出场的图片也不加载
    const off = setup(mapping, (lib) => [lib.item('睡觉', null, [], 1, { second_enabled: true })], { lora_overrides: { second_lora1: { enabled: false } } })
    expect(off.node(0, '13')).toEqual({ lora_name: null, strength_model: 0, strength_clip: 0 })
  })

  it('6. 缺少映射时阻止入队并明确提示', () => {
    // 启用的任务 LoRA 没有绑定 Loader
    const a = setup([...base, ...bindTo('lora1', '10')], undefined, { task_loras: [tl(1, '画风', 'style.safetensors')] })
    expect(a.plan.errors.some((e) => e.includes('任务 LoRA「画风」') && e.includes('没有绑定 LoRA Loader'))).toBe(true)
    expect(enqueueTask(a.s, a.t).runId).toBeNull()
    // 主角色有 LoRA，但没有绑定任何 Loader
    const b = setup(base)
    expect(b.plan.errors.some((e) => e.includes('主角色「角色A」的 LoRA「charA.safetensors」已启用，但当前工作流没有绑定 LoRA Loader'))).toBe(true)
    // 绑定的节点不存在于当前工作流
    const c = setup([...base, { source: 'lora1_name', node: '99', input: 'lora_name', modules: [], template: '' }])
    expect(c.plan.errors.some((e) => e.includes('节点 99'))).toBe(true)
    // 只映射了名称：禁用时无法安全写 0
    const d = setup([...base, ...bindTo('lora1', '10'), { source: 'task_lora1_name', node: '20', input: 'lora_name', modules: [], template: '' }], undefined, { task_loras: [tl(1, '画风', 'style.safetensors', 1, 1, false)] })
    expect(d.plan.errors.some((e) => e.includes('任务 LoRA 1') && e.includes('无法安全禁用'))).toBe(true)
    // 强度映射不完整：提示（Clip 权重会保持工作流原值）
    const e = setup([...base, ...bindTo('lora1', '10').filter((m) => m.input !== 'strength_clip')])
    expect(e.plan.errors).toEqual([])
    expect(e.plan.warnings.some((w) => w.includes('Loader 10 的 strength_clip 没有映射'))).toBe(true)
    // 启用但没有选择模型
    const f = setup([...base, ...bindTo('lora1', '10'), ...bindTo('task_lora1', '20')], undefined, { task_loras: [tl(1, '画风', '')] })
    expect(f.plan.errors.some((x) => x.includes('还没有选择模型'))).toBe(true)
  })

  it('7. 工作流中固定的 LoRA（未映射）保持原值，不被判为错误', () => {
    const { plan, graph } = setup([...base, ...bindTo('lora1', '10', '12'), ...bindTo('task_lora1', '20')], undefined, { task_loras: [tl(1, '画风', 'style.safetensors')] })
    expect(plan.errors).toEqual([])
    expect(plan.warnings.join('\n')).not.toContain('30')
    expect(graph(0)['30']).toEqual(WF['30'])
    expect(plan.units[0].inputs!.some((x) => x.node === '30')).toBe(false)
  })
})

describe('兼容性', () => {
  it('没有 LoRA 配置的旧任务：计划结构与以前相同', () => {
    const s = newStore()
    const lib = new Lib(s)
    const { units } = expandTask(lib.task([lib.item('睡觉', null, [], 1)]), loadPlanLibrary(s), s.settings())
    expect(units[0].loras).toEqual([{ name: 'charA.safetensors', strength: 0.8 }])
    expect('task_loras' in units[0]).toBe(false)
  })

  it('已入队的快照不随任务 LoRA 配置的修改而改变', () => {
    const { s, t, plan } = setup([...base, ...bindTo('lora1', '10'), ...bindTo('task_lora1', '20')], undefined, { task_loras: [tl(1, '画风', 'style.safetensors', 0.9, 0.9)] })
    expect(plan.errors).toEqual([])
    const run = enqueueTask(s, t).runId!
    const snap = s.listUnits(run)
    s.save('tasks', { id: t.id, data: { ...t.data, task_loras: [tl(1, '画风', 'changed.safetensors', 0.1, 0.1)] } })
    expect(s.listUnits(run)).toEqual(snap)
    expect(snap[0].inputs.find((x) => x.node === '20' && x.input === 'lora_name')!.value).toBe('style.safetensors')
  })
})
