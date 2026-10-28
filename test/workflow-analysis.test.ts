// 真实工作流回归样本（test/fixtures/workflow-two-pass.json）：ImpactWildcardProcessor 提供正负 Prompt（正面经字符串拼接、正则替换后进入
// CLIPTextEncode），Lora Loader (LoraManager) 多 LoRA 列表同时供两次采样与 Ultimate SD Upscale 使用，主 Seed 节点 + 放大节点的独立 Seed。
// 没有真实 ComfyUI 环境：这里只在 JSON 层面验证映射与写入结果。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyInputs, applyLoraStack, loraStackOf, findLoraLoaders, isLink, loraBindingEntries, mappingErrors, parseStack, stackBindingEntry, validateMapping } from '@shared/mapping'
import { analyzeWorkflow, findSamplers, mergeMapping } from '@shared/workflow-analysis'
import type { ApiWorkflow, MappingEntry, TaskLora } from '@shared/types'
import { enqueueTask, planForTask } from '../src/main/plan'
import { Lib, newStore } from './helpers'

const WF: ApiWorkflow = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/workflow-two-pass.json'), 'utf8'))
const checkedEntries = (api: ApiWorkflow) => analyzeWorkflow(api).suggestions.filter((s) => s.checked).flatMap((s) => s.entries)
const stackOf = (g: ApiWorkflow, id = '5') => loraStackOf(g[id])!
const tl = (slot: number, name: string, w = 1, enabled = true): TaskLora => ({ slot, label: `L${slot}`, name, enabled, strength_model: w, strength_clip: w })

/** 按节点 ID 整体重新编号（连接一起改），模拟另一份结构相同、ID 不同的工作流 */
function renumber(api: ApiWorkflow, f: (id: string) => string): ApiWorkflow {
  const out: ApiWorkflow = {}
  for (const [id, n] of Object.entries(api)) {
    const inputs = Object.fromEntries(Object.entries(n.inputs).map(([k, v]) => [k, isLink(v) ? [f(v[0]), v[1]] : v]))
    out[f(id)] = { ...n, inputs }
  }
  return out
}

/** 只为验证用的极简字符串求值：沿连接计算某个节点输出的文本（覆盖本工作流用到的节点类型） */
function evalText(api: ApiWorkflow, link: unknown): string {
  if (!isLink(link)) return String(link ?? '')
  const n = api[link[0]]
  const i = n.inputs
  switch (n.class_type) {
    case 'ImpactWildcardProcessor':
      return String(i.populated_text) // 后端执行 populated_text
    case 'StringConcatenate':
      return [evalText(api, i.string_a), evalText(api, i.string_b)].join(String(i.delimiter))
    case 'RegexReplace':
      return evalText(api, i.string).replace(new RegExp(String(i.regex_pattern), 'g'), String(i.replace))
    case 'TriggerWord Toggle (LoraManager)':
      return '' // 所有触发词组都未启用
    default:
      throw new Error(`未覆盖的节点类型 ${n.class_type}`)
  }
}

function setup(extraMapping: (m: MappingEntry[]) => MappingEntry[] = (m) => m, taskExtra: Record<string, unknown> = {}, api: ApiWorkflow = WF) {
  const s = newStore()
  const lib = new Lib(s)
  const mapping = extraMapping(mergeMapping([], checkedEntries(api)))
  lib.addWorkflow(mapping, api)
  const t = lib.makeTask([lib.item('睡觉', null, [], 2)], '两次采样', { male_base_id: null, ...taskExtra })
  const plan = planForTask(s, t, undefined, '2026-10-25')
  const graph = (i = 0) => applyInputs(api, plan.units[i].inputs!)
  return { s, lib, t, plan, graph, mapping }
}

describe('自动识别（Test.json）', () => {
  it('Prompt：穿过字符串拼接与正则替换找到 ImpactWildcardProcessor，正负各一个，写入 populated_text 与 wildcard_text', () => {
    const a = analyzeWorkflow(WF)
    const prompts = a.suggestions.filter((s) => s.group === 'prompt')
    expect(prompts.map((s) => [s.entries.map((e) => `${e.source}:${e.node}.${e.input}`), s.checked])).toEqual([
      [['positive:3.populated_text', 'positive:3.wildcard_text'], true],
      [['negative:4.populated_text', 'negative:4.wildcard_text'], true],
    ])
    // 触发词节点、LoRA Loader 的 text、正则参数都不会被当作 Prompt 来源
    expect(prompts.some((s) => ['34', '5', '47', '45'].includes(s.node))).toBe(false)
    expect(a.notes.some((n) => n.includes('#34') && n.includes('触发词'))).toBe(true)
    expect(prompts[0].preview).toContain('masterpiece, best quality')
  })

  it('Seed：#32 是被引用的主 Seed（默认勾选），#107 的独立 Seed 需要确认、不会被擅自同步', () => {
    const seeds = analyzeWorkflow(WF).suggestions.filter((s) => s.group === 'seed')
    expect(seeds.map((s) => [s.node, s.checked])).toEqual([
      ['32', true],
      ['107', false],
    ])
    expect(analyzeWorkflow(WF).notes.some((n) => n.includes('#107'))).toBe(true)
  })

  it('输出：#121 是最终保存节点（默认勾选），#106 是中间结果（不勾选）', () => {
    const out = analyzeWorkflow(WF).suggestions.filter((s) => s.group === 'output')
    expect(out.map((s) => [s.node, s.checked])).toEqual([
      ['106', false],
      ['121', true],
    ])
  })

  it('LoRA：#5 识别为多 LoRA Loader，解析名称、权重（含字符串）、启用状态；作用于 #46、#103、#107；由任务直接控制、不生成映射建议', () => {
    const [ld] = findLoraLoaders(WF)
    expect(ld.support).toBe('stack')
    expect(ld.entries!.length).toBe(8)
    expect(ld.entries![0]).toEqual({ name: 'BlueArchiveStyle_illus_1884029', strength: 0.85, clipStrength: 0.85, active: true })
    expect(ld.entries!.find((e) => e.name === 'Ugly Man_illus_1001313')!.active).toBe(false)
    const a = analyzeWorkflow(WF)
    expect(a.suggestions.filter((s) => s.group === 'lora')).toEqual([])
    expect(a.notes.some((n) => n.includes('#5') && n.includes('#46、#103、#107') && n.includes('无需映射'))).toBe(true)
    expect(findSamplers(WF)).toEqual(['46', '103', '107'])
  })

  it('默认勾选的建议直接构成可用映射（没有错误）', () => {
    const mapping = mergeMapping([], checkedEntries(WF))
    expect(mappingErrors(WF, mapping)).toEqual([])
    expect(validateMapping(WF, mapping).filter(([l]) => l === 'warning')).toEqual([])
  })

  it('节点 ID 改变后，仍按类型与连接关系识别到相同的结构', () => {
    const moved = renumber(WF, (id) => String(Number(id) + 500))
    const got = (api: ApiWorkflow) => analyzeWorkflow(api).suggestions.map((s) => [s.group, s.checked, s.entries.map((e) => `${e.source}.${e.input}`).join('+')])
    expect(got(moved)).toEqual(got(WF))
    expect(checkedEntries(moved).map((e) => e.node)).toEqual(checkedEntries(WF).map((e) => String(Number(e.node) + 500)))
  })
})

describe('写入与提交（Test.json）', () => {
  it('Positive / Negative 写入；送入采样器的 Prompt 确实来自写入后的文本；预览与提交一致', () => {
    const { plan, graph, s, t } = setup((m) => [...m, stackBindingEntry('lora1', '5')])
    expect(plan.errors).toEqual([])
    const u = plan.units[0]
    const g = graph()
    expect(g['3'].inputs.populated_text).toBe(u.positive)
    expect(g['3'].inputs.wildcard_text).toBe(u.positive)
    expect(g['4'].inputs.populated_text).toBe(u.negative)
    // 采样器 #46 的 positive ← #43 CLIP Text Encode ← #47 正则 ← #45 拼接 ← #3
    expect(evalText(g, g['43'].inputs.text)).toBe(u.positive.replace(/^,|,$/g, '').replace(/^,/, ''))
    expect(evalText(g, g['43'].inputs.text)).toContain('masterpiece, best quality,\n\n1girl, char_a')
    expect(evalText(g, g['44'].inputs.text)).toBe(u.negative)
    // 预览中的值就是提交的值；入队后快照一致
    expect(u.inputs!.find((x) => x.source === 'positive')!.value).toBe(u.positive)
    const run = enqueueTask(s, t).runId!
    expect(s.listUnits(run)[0].inputs).toEqual(u.inputs)
  })

  it('Seed 与输出前缀：写入 #32 与 #121；#107 的独立 Seed 与其他参数保持原值；未映射的节点完全不变', () => {
    const { plan, graph } = setup((m) => [...m, stackBindingEntry('lora1', '5')])
    const g = graph(1)
    expect(g['32'].inputs.seed).toBe(plan.units[1].seed)
    expect(g['107'].inputs.seed).toBe(WF['107'].inputs.seed)
    expect(g['121'].inputs.filename_prefix).toBe('ComfyEngi/两次采样/0002_睡觉')
    const touched = new Set(plan.units[1].inputs!.map((x) => x.node))
    for (const id of Object.keys(WF)) if (!touched.has(id)) expect(g[id]).toEqual(WF[id])
    // 采样器设置、模型连接不变
    for (const id of ['46', '103', '107']) expect(g[id]).toEqual(WF[id])
    // 自动识别同时映射了生成宽高（#1、#12）；这里的动作没有尺寸配置（旧动作），保持工作流默认尺寸
    expect(touched).toEqual(new Set(['3', '4', '32', '121', '5', '1', '12']))
    expect([g['1'], g['12']]).toEqual([WF['1'], WF['12']])
  })

  it('多 LoRA Loader：追加角色 LoRA、替换 / 停用 / 调整任务 LoRA，未交给任务控制的固定 LoRA 保持不变', () => {
    const map = (m: MappingEntry[]) => [
      ...m,
      stackBindingEntry('lora1', '5'),
      stackBindingEntry('task_lora1', '5', 'BlueArchiveStyle_illus_1884029'),
      stackBindingEntry('task_lora2', '5', 'Lineweight_illus_2238270'),
      stackBindingEntry('task_lora3', '5', 'il_contrast_slider_d1'),
    ]
    const { plan, graph } = setup(map, { task_loras: [tl(1, 'styles/NewStyle.safetensors', 0.7), tl(2, 'Lineweight_illus_2238270', -1, false)] })
    expect(plan.errors).toEqual([])
    const g = graph()
    const list = parseStack(stackOf(g))
    const by = (n: string) => list.find((e) => e.name === n)
    expect(list.map((e) => e.name)).toEqual(['NewStyle', 'Lineweight_illus_2238270', 'il_contrast_slider_d1', 'il_color_temp_slider_d1', 'il_saturation_slider_d1', 'il_brightness_slider_d1', 'Ugly Man_illus_1001313', 'Inui Sajuna_illus_1115376', 'charA'])
    expect(by('NewStyle')).toEqual({ name: 'NewStyle', strength: 0.7, clipStrength: 0.7, active: true }) // 替换
    expect(by('Lineweight_illus_2238270')!.active).toBe(false) // 停用
    expect(by('il_contrast_slider_d1')).toEqual({ name: 'il_contrast_slider_d1', strength: 1, clipStrength: 1, active: true }) // 本任务未配置：原样
    expect(by('charA')).toEqual({ name: 'charA', strength: 0.8, clipStrength: 0.8, active: true }) // 追加角色 LoRA
    // 固定条目逐字段保持原样（包括字符串形式的权重与界面字段）
    const orig = stackOf(WF)
    const after = stackOf(g)
    for (const i of [3, 4, 5, 6, 7]) expect(after[i]).toEqual(orig[i])
    // text 与列表一致；不修改 Prompt
    expect(g['5'].inputs.text).toContain('<lora:NewStyle:0.7>')
    expect(g['5'].inputs.text).toContain('<lora:charA:0.8>')
    expect(plan.units[0].positive).not.toContain('<lora:')
    // 模型、clip 连接不变
    expect(g['5'].inputs.model).toEqual(WF['5'].inputs.model)
    expect(g['5'].inputs.clip).toEqual(WF['5'].inputs.clip)
  })

  it('角色 LoRA 与列表中已有条目同名时直接更新该条目（不重复加载），并给出提示', () => {
    const { s, lib } = setup()
    s.save('characters', { id: lib.charA, loras: [{ name: 'chars/Inui Sajuna_illus_1115376.safetensors', strength: 0.9 }] })
    lib.addWorkflow([...mergeMapping([], checkedEntries(WF)), stackBindingEntry('lora1', '5')], WF)
    const plan = planForTask(s, lib.makeTask([lib.item('睡觉', null, [], 1)], 't', { male_base_id: null }))
    const list = parseStack(stackOf(applyInputs(WF, plan.units[0].inputs!)))
    expect(list.filter((e) => e.name === 'Inui Sajuna_illus_1115376')).toEqual([{ name: 'Inui Sajuna_illus_1115376', strength: 0.9, clipStrength: 0.9, active: true }])
    expect(list.length).toBe(8)
    expect(plan.warnings.some((w) => w.includes('已有同名 LoRA'))).toBe(true)
  })

  it('第二角色未出场的图片不追加、替换的条目被停用', () => {
    const { s, lib } = setup()
    const m2 = s.save('characters', { name: '男角色', loras: [{ name: 'boy.safetensors', strength: 0.6 }] })
    lib.addWorkflow([...mergeMapping([], checkedEntries(WF)), stackBindingEntry('lora1', '5'), stackBindingEntry('second_lora1', '5', 'Inui Sajuna_illus_1115376')], WF)
    const plan = planForTask(s, lib.makeTask([lib.item('睡觉', null, [], 1, { second_enabled: true }), lib.item('鸭子坐', null, [], 1)], 't', { male_base_id: null, second_character_id: m2 }))
    expect(plan.errors).toEqual([])
    const list = (i: number) => parseStack(stackOf(applyInputs(WF, plan.units[i].inputs!)))
    expect(list(0).find((e) => e.name === 'boy')!.active).toBe(true)
    expect(list(1).some((e) => e.name === 'boy')).toBe(false)
    expect(list(1).find((e) => e.name === 'Inui Sajuna_illus_1115376')!.active).toBe(false)
  })

  it('同一个 LoRA 配置同时写入多 LoRA Loader 与另一个标准 Loader（多个采样阶段）', () => {
    const api: ApiWorkflow = { ...WF, '200': { class_type: 'LoraLoader', inputs: { lora_name: 'x.safetensors', strength_model: 1, strength_clip: 1, model: ['5', 0], clip: ['5', 1] }, _meta: { title: '放大阶段 LoRA' } } }
    const std = findLoraLoaders(api).find((l) => l.node === '200')!
    const { plan, graph } = setup((m) => [...m, stackBindingEntry('lora1', '5'), ...loraBindingEntries('lora1', std)], {}, api)
    expect(plan.errors).toEqual([])
    const g = graph()
    expect(g['200'].inputs).toMatchObject({ lora_name: 'charA.safetensors', strength_model: 0.8, strength_clip: 0.8 })
    expect(parseStack(stackOf(g)).find((e) => e.name === 'charA')!.strength).toBe(0.8)
  })

  it('applyLoraStack 不修改传入的原列表', () => {
    const orig = structuredClone(stackOf(WF))
    applyLoraStack(orig, [stackBindingEntry('lora1', '5', 'BlueArchiveStyle_illus_1884029')], { loras: [] })
    expect(orig).toEqual(stackOf(WF))
  })
})
