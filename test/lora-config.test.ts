// 任务级 LoRA 配置（按工作流保存）：工作流中已有的 LoRA 是默认值，任务中添加 / 删除 / 替换 / 启停 / 调权重后，
// 实际提交的工作流 JSON 必须与之完全一致。样本：test/fixtures/workflow-two-pass.json（Lora Loader (LoraManager) #5）与标准 LoraLoader。
// 没有真实 ComfyUI：在 JSON 层面验证（applyInputs 与执行队列使用的是同一个函数）。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyInputs, loraStackOf, parseStack, stackBindingEntry } from '@shared/mapping'
import { controllableLoaders, defaultLoraConfig, type WfLoraConfig, type WfLoraEntry } from '@shared/lora-config'
import { analyzeWorkflow, mergeMapping } from '@shared/workflow-analysis'
import type { ApiWorkflow, MappingEntry, TaskData } from '@shared/types'
import { enqueueTask, finalWorkflow, planForTask } from '../src/main/plan'
import { Lib, newStore, SAMPLE_MAPPING, SAMPLE_WORKFLOW } from './helpers'

const WF: ApiWorkflow = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/workflow-two-pass.json'), 'utf8'))
const AUTO: MappingEntry[] = mergeMapping([], analyzeWorkflow(WF).suggestions.filter((s) => s.checked).flatMap((s) => s.entries))
const ORIG = loraStackOf(WF['5'])!

function setup(opts: { cfg?: (c: WfLoraConfig) => WfLoraConfig; extra?: Partial<TaskData>; charLora?: string | null; api?: ApiWorkflow; mapping?: MappingEntry[]; items?: (lib: Lib) => ReturnType<Lib['item']>[] } = {}) {
  const s = newStore()
  const lib = new Lib(s)
  if (opts.charLora !== undefined) s.save('characters', { id: lib.charA, loras: opts.charLora ? [{ name: opts.charLora, strength: 0.9 }] : [] })
  const api = opts.api ?? WF
  const mapping = opts.mapping ?? AUTO
  const wid = lib.addWorkflow(mapping, api)
  const cfg = opts.cfg ? opts.cfg(defaultLoraConfig(api, mapping)) : undefined
  const t = lib.makeTask(opts.items ? opts.items(lib) : [lib.item('睡觉', null, [], 2)], 't', { male_base_id: null, ...(cfg ? { lora_configs: { [wid]: cfg } } : {}), ...opts.extra })
  const plan = planForTask(s, t)
  const graph = (i = 0) => applyInputs(api, plan.units[i].inputs!)
  const list = (i = 0) => loraStackOf(graph(i)['5'])!
  return { s, lib, t, wid, plan, graph, list }
}
const names = (l: Record<string, unknown>[]) => parseStack(l).map((e) => `${e.name}${e.active ? '' : '(off)'}`)
const edit = (key: string, p: Partial<WfLoraEntry>) => (c: WfLoraConfig) => ({ ...c, entries: c.entries.map((e) => (e.key === key ? { ...e, ...p } : e)) })

describe('读取工作流中已有的 LoRA', () => {
  it('#5 的 8 个 LoRA（含停用条目）成为任务的默认配置；三个采样阶段共用 #5，只有一组', () => {
    const cfg = defaultLoraConfig(WF, AUTO)
    expect(controllableLoaders(WF, AUTO).map((l) => l.node)).toEqual(['5'])
    expect(cfg.entries.map((e) => [e.key, e.name, e.strength, e.enabled])).toEqual([
      ['5:0', 'BlueArchiveStyle_illus_1884029', 0.85, true],
      ['5:1', 'Lineweight_illus_2238270', -1, true],
      ['5:2', 'il_contrast_slider_d1', 1, true],
      ['5:3', 'il_color_temp_slider_d1', -1, true],
      ['5:4', 'il_saturation_slider_d1', 0.5, true],
      ['5:5', 'il_brightness_slider_d1', 0.5, true],
      ['5:6', 'Ugly Man_illus_1001313', 0.5, false],
      ['5:7', 'Inui Sajuna_illus_1115376', 0.45, true],
    ])
  })

  it('没有任何修改时不写入 #5（工作流原样提交）', () => {
    const { plan, graph } = setup({ charLora: null })
    expect(plan.errors).toEqual([])
    expect(plan.units[0].inputs!.some((x) => x.node === '5')).toBe(false)
    expect(graph()['5']).toEqual(WF['5'])
  })
})

describe('任务中的修改写入最终工作流（#5 LoraManager 列表）', () => {
  it('新增：最终列表包含新 LoRA，text 同步', () => {
    const add: WfLoraEntry = { key: '5:+a', node: '5', name: 'styles/NewStyle.safetensors', strength: 0.6, clip: 0.6, enabled: true }
    const { plan, list, graph } = setup({ charLora: null, cfg: (c) => ({ ...c, entries: [...c.entries, add] }) })
    expect(plan.errors).toEqual([])
    expect(parseStack(list()).at(-1)).toEqual({ name: 'NewStyle', strength: 0.6, clipStrength: 0.6, active: true })
    expect(graph()['5'].inputs.text).toContain('<lora:NewStyle:0.6>')
  })

  it('删除：最终列表中不再有它（不会继续加载），其余条目保持原始对象', () => {
    const { list } = setup({ charLora: null, cfg: (c) => ({ ...c, entries: c.entries.filter((e) => e.key !== '5:1') }) })
    expect(names(list())).not.toContain('Lineweight_illus_2238270')
    expect(list().length).toBe(7)
    expect(list().filter((x) => x.name !== 'Lineweight_illus_2238270')).toEqual(ORIG.filter((x) => x.name !== 'Lineweight_illus_2238270'))
  })

  it('启用 / 停用真实生效：停用画风 LoRA → active=false；启用原本停用的 → active=true', () => {
    const { list, graph } = setup({ charLora: null, cfg: (c) => edit('5:6', { enabled: true })(edit('5:0', { enabled: false })(c)) })
    const by = (n: string) => parseStack(list()).find((e) => e.name === n)!
    expect(by('BlueArchiveStyle_illus_1884029').active).toBe(false)
    expect(by('Ugly Man_illus_1001313').active).toBe(true)
    // 插件只按 loras 列表加载；text 与列表一致（包含全部条目）
    expect(graph()['5'].inputs.text).toContain('<lora:BlueArchiveStyle_illus_1884029:0.85>')
  })

  it('修改权重与替换模型：写入新权重与新名称，不再加载原模型；未修改的固定 LoRA 原样保留', () => {
    const { list } = setup({ charLora: null, cfg: (c) => edit('5:2', { name: 'other/OtherSlider.safetensors', strength: 0.3, clip: 0.3 })(edit('5:7', { strength: 0.7, clip: 0.7 })(c)) })
    const l = parseStack(list())
    expect(l[7]).toEqual({ name: 'Inui Sajuna_illus_1115376', strength: 0.7, clipStrength: 0.7, active: true })
    expect(l[2]).toEqual({ name: 'OtherSlider', strength: 0.3, clipStrength: 0.3, active: true })
    expect(names(list())).not.toContain('il_contrast_slider_d1')
    for (const i of [0, 1, 3, 4, 5, 6]) expect(list()[i]).toEqual(ORIG[i])
  })
})

describe('角色 LoRA 与工作流已有 LoRA', () => {
  it('不在列表中：追加到 #5（唯一的多 LoRA Loader），不覆盖画风 LoRA', () => {
    const { plan, list } = setup()
    expect(plan.errors).toEqual([])
    expect(names(list())).toEqual([...names(ORIG), 'charA'])
    expect(parseStack(list()).at(-1)).toEqual({ name: 'charA', strength: 0.8, clipStrength: 0.8, active: true })
    for (let i = 0; i < 8; i++) expect(list()[i]).toEqual(ORIG[i])
  })

  it('已在列表中：关联已有条目（使用角色权重），不重复添加；任务中停用角色 LoRA → 该条目停用', () => {
    const on = setup({ charLora: 'chars/Inui Sajuna_illus_1115376.safetensors' })
    expect(on.list().length).toBe(8)
    expect(parseStack(on.list())[7]).toEqual({ name: 'Inui Sajuna_illus_1115376', strength: 0.9, clipStrength: 0.9, active: true })
    const off = setup({ charLora: 'chars/Inui Sajuna_illus_1115376.safetensors', extra: { lora_overrides: { lora1: { enabled: false } } } })
    expect(parseStack(off.list())[7].active).toBe(false)
    expect(off.list().length).toBe(8)
  })

  it('指定替换某个条目：只替换该条目，不追加', () => {
    const { list } = setup({ cfg: (c) => ({ ...c, char_targets: { lora1: { node: '5', replace: '5:7' } } }) })
    expect(names(list())).toEqual([...names(ORIG).slice(0, 7), 'charA'])
  })

  it('第二角色未出场的图片不加载第二角色 LoRA；关联已有条目时该条目停用', () => {
    const items = (lib: Lib) => [lib.item('睡觉', null, [], 1, { second_enabled: true }), lib.item('鸭子坐', null, [], 1)]
    const s0 = setup({ charLora: null, items })
    const m2 = s0.s.save('characters', { name: '男角色', loras: [{ name: 'boy.safetensors', strength: 0.6 }] })
    const t = s0.lib.makeTask(items(s0.lib), 't2', { male_base_id: null, second_character_id: m2 })
    const p = planForTask(s0.s, t)
    expect(p.errors).toEqual([])
    const l = (i: number) => names(loraStackOf(applyInputs(WF, p.units[i].inputs!)['5'])!)
    expect(l(0)).toContain('boy')
    expect(l(1)).not.toContain('boy')
    // 第二角色 LoRA 就是工作流中的 Inui：未出场的图片中停用该条目
    s0.s.save('characters', { id: m2, loras: [{ name: 'Inui Sajuna_illus_1115376.safetensors', strength: 0.6 }] })
    const p2 = planForTask(s0.s, s0.s.get('tasks', t.id)!)
    const st = (i: number) => parseStack(loraStackOf(applyInputs(WF, p2.units[i].inputs!)['5'])!).find((e) => e.name.startsWith('Inui'))!
    expect([st(0).active, st(0).strength, st(1).active]).toEqual([true, 0.6, false])
  })
})

describe('标准 LoRA Loader、切换工作流与一致性', () => {
  const STD_MAP = SAMPLE_MAPPING.filter((m) => !m.source.startsWith('lora'))
  const STD: ApiWorkflow = { ...SAMPLE_WORKFLOW, '11': { class_type: 'LoraLoader', inputs: { lora_name: 'style.safetensors', strength_model: 0.7, strength_clip: 0.6, model: ['10', 0], clip: ['10', 1] } } }

  it('标准 Loader：读取已有 LoRA；角色 LoRA 关联同名的 #10；停用写 0、替换与权重写入 lora_name / strength', () => {
    expect(defaultLoraConfig(STD, STD_MAP).entries.map((e) => [e.node, e.name, e.strength, e.clip])).toEqual([
      ['10', 'charA.safetensors', 1, 1],
      ['11', 'style.safetensors', 0.7, 0.6],
    ])
    const a = setup({ api: STD, mapping: STD_MAP })
    expect(a.plan.errors).toEqual([])
    expect(a.graph()['10'].inputs).toMatchObject({ lora_name: 'charA.safetensors', strength_model: 0.8, strength_clip: 0.8 })
    expect(a.graph()['11']).toEqual(STD['11'])
    const c = setup({ api: STD, mapping: STD_MAP, cfg: (cf) => edit('11:0', { enabled: false })(cf) })
    expect(c.graph()['11'].inputs).toMatchObject({ lora_name: 'style.safetensors', strength_model: 0, strength_clip: 0 })
    const d = setup({ api: STD, mapping: STD_MAP, cfg: (cf) => edit('11:0', { name: 'other.safetensors', strength: 0.4, clip: 0.4 })(cf) })
    expect(d.graph()['11'].inputs).toMatchObject({ lora_name: 'other.safetensors', strength_model: 0.4, strength_clip: 0.4 })
    // 未映射的其他节点完全不变
    for (const id of ['4', '5', '8']) expect(d.graph()[id]).toEqual(STD[id])
  })

  it('切换工作流不串用：为 Test.json 保存的配置不会套到另一个工作流上，切回时恢复', () => {
    const s = newStore()
    const lib = new Lib(s)
    s.save('characters', { id: lib.charA, loras: [] })
    const w1 = lib.addWorkflow(AUTO, WF)
    const w2 = lib.addWorkflow(STD_MAP, STD)
    const cfg1 = edit('5:0', { enabled: false })(defaultLoraConfig(WF, AUTO))
    const mk = (wid: number) => lib.makeTask([lib.item('睡觉', null, [], 1)], 't', { male_base_id: null, workflow_id: wid, lora_configs: { [w1]: cfg1 } })
    const p2 = planForTask(s, mk(w2))
    expect(p2.errors).toEqual([])
    expect(applyInputs(STD, p2.units[0].inputs!)['11']).toEqual(STD['11'])
    const p1 = planForTask(s, mk(w1))
    expect(parseStack(loraStackOf(applyInputs(WF, p1.units[0].inputs!)['5'])!)[0].active).toBe(false)
  })

  it('已有高级映射（列表绑定）的 Loader 仍由映射控制，任务配置不重复控制', () => {
    const mapping = [...AUTO, stackBindingEntry('lora1', '5')]
    expect(controllableLoaders(WF, mapping)).toEqual([])
    const { plan, list } = setup({ mapping, cfg: undefined })
    expect(plan.errors).toEqual([])
    expect(names(list())).toEqual([...names(ORIG), 'charA'])
  })

  it('最终工作流预览与入队、执行使用的 JSON 一致；原始工作流与映射不被修改；入队快照不随后续编辑变化', () => {
    const { s, t, wid, plan, graph } = setup({ cfg: (c) => edit('5:0', { strength: 0.5, clip: 0.5 })(c) })
    const run = enqueueTask(s, t).runId!
    const units = s.listUnits(run)
    // 执行时：applyInputs(入队时冻结的工作流, 冻结的输入)；预览：同一个函数作用于计划
    const frozen = s.getRun(run)!.workflow_json as unknown as ApiWorkflow
    expect(units.map((u) => u.inputs)).toEqual(plan.units.map((u) => u.inputs))
    for (const i of [0, 1]) expect(applyInputs(frozen, units[i].inputs)).toEqual(graph(i))
    // 「查看 / 导出最终工作流 JSON」与执行时提交的 JSON 相同，并标明是第几张
    for (const i of [0, 1]) {
      const f = finalWorkflow(s, t, i)
      expect(f.json).toEqual(applyInputs(frozen, units[i].inputs))
      expect([f.index, f.count, f.seed]).toEqual([i, 2, plan.units[i].seed])
    }
    expect(parseStack(loraStackOf(finalWorkflow(s, t, 0).json['5'])!)[0].strength).toBe(0.5)
    expect(s.get('workflows', wid)!.api_json).toEqual(WF)
    expect(s.get('workflows', wid)!.mapping).toEqual(AUTO)
    s.save('tasks', { id: t.id, data: { ...t.data, lora_configs: {} } })
    expect(s.listUnits(run).map((u) => u.inputs)).toEqual(units.map((u) => u.inputs))
  })
})
