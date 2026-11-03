// 普通套图任务：在 LoRA 配置中从 LoRA 管理添加 / 替换的 LoRA 如何解析写入名称。
// 只用静态工作流 JSON 与临时目录中的假模型文件，不连接 ComfyUI，不提交任何任务。

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultLoraConfig, type WfLoraConfig } from '@shared/lora-config'
import { applyInputs, newEntry } from '@shared/mapping'
import { newItem, newTaskData } from '@shared/planner'
import type { ApiWorkflow, LoraResource, MappingEntry } from '@shared/types'
import { LoraManager } from '../src/main/lora-manager'
import { enqueueTask, planForTask } from '../src/main/plan'
import type { Store } from '../src/main/store'
import { createVault, openVault } from '../src/main/vault'
import { Lib, SAMPLE_MAPPING, SAMPLE_WORKFLOW, tempDir } from './helpers'

/** 用户工作流结构：Lora Loader (LoraManager) #5 的多 LoRA 列表 */
const STACK_WF: ApiWorkflow = JSON.parse(readFileSync(join(__dirname, 'fixtures/workflow-two-pass.json'), 'utf8'))
const STACK_MAP: MappingEntry[] = [newEntry('positive', '3', 'populated_text'), newEntry('negative', '4', 'populated_text')]
/** 标准 LoraLoader #10 不映射，由 LoRA 配置控制 */
const SINGLE_MAP = SAMPLE_MAPPING.filter((m) => !m.source.startsWith('lora1'))
type StackEntry = { name: string; strength: number | string; clipStrength: number | string; active: boolean }
const stackOf = (json: ApiWorkflow) => (json['5'].inputs.loras as { __value__: StackEntry[] }).__value__

describe('普通套图：LoRA 配置中的 LoRA 管理资源', () => {
  let root: string
  let models: string
  let s: Store
  let lib: Lib
  let res: Record<string, LoraResource>
  /** LoRA 管理扫描一个与 ComfyUI 相同结构的目录：styles/ 子目录中的 LoRA，未设置 ComfyUI 名称 */
  const scan = async () => {
    const m = new LoraManager(root)
    await m.scan([models])
    res = Object.fromEntries((await m.list()).map((r) => [r.name, r]))
    return m
  }
  const task = (wf: number, cfg: WfLoraConfig) => {
    const id = s.save('tasks', { name: 't', data: { ...newTaskData(), seed_base: 1, character_id: lib.charA, workflow_id: wf, items: [newItem(lib.poses['睡觉'], lib.outfitsA[0])], lora_configs: { [String(wf)]: cfg } } })
    return s.get('tasks', id)!
  }
  /** 与 LoRA 配置面板「添加」相同：名称为 comfyName || 文件名，记录资源 ID */
  const added = (node: string, r: LoraResource, w = 0.6) => ({ key: `${node}:+t${r.name.length}`, node, name: r.comfyName || r.name, resource_id: r.id, strength: w, clip: w, enabled: true })

  beforeEach(async () => {
    root = tempDir()
    models = tempDir()
    mkdirSync(join(models, 'styles'), { recursive: true })
    for (const f of ['BlueArchiveStyle_illus_1884029', 'il_contrast_slider_d1', 'new_style']) writeFileSync(join(models, 'styles', `${f}.safetensors`), Buffer.alloc(32))
    createVault(root)
    s = openVault(root)
    lib = new Lib(s)
    await scan()
  })
  afterEach(() => s.close())

  it('未设置 ComfyUI 名称的资源添加到多 LoRA Loader：可以入队，写入文件名', () => {
    expect(res['new_style.safetensors'].comfyName).toBe('')
    const wf = s.save('workflows', { name: 'wf', api_json: STACK_WF, mapping: STACK_MAP })
    const base = defaultLoraConfig(STACK_WF, STACK_MAP)
    const cfg = { ...base, entries: [...base.entries, added('5', res['new_style.safetensors'], 0.6)] }
    const plan = planForTask(s, task(wf, cfg))
    expect(plan.errors).toEqual([])
    const stack = stackOf(applyInputs(STACK_WF, plan.units[0].inputs!))
    expect(stack.find((e) => e.name === 'new_style')).toMatchObject({ active: true, strength: 0.6 })
    // 已有条目的名称、启用状态与权重不变
    const orig = stackOf(STACK_WF)
    for (const e of orig) expect(stack.find((x) => x.name === e.name)).toMatchObject({ name: e.name, strength: e.strength, clipStrength: e.clipStrength, active: e.active })
  })

  it('用户报告的情况：只保留一个原有 LoRA，再从 LoRA 管理添加两个（子目录中、与其他工作流原有名称相同）', () => {
    const own = structuredClone(STACK_WF)
    const list = stackOf(own)
    ;(own['5'].inputs.loras as { __value__: StackEntry[] }).__value__ = [{ ...list[0], name: 'syta_style_v1-step00007000' }]
    const wf = s.save('workflows', { name: 'new', api_json: own, mapping: STACK_MAP })
    const base = defaultLoraConfig(own, STACK_MAP)
    const cfg = { ...base, entries: [...base.entries, added('5', res['BlueArchiveStyle_illus_1884029.safetensors'], 0.6), added('5', res['il_contrast_slider_d1.safetensors'], 0.2)] }
    const t = task(wf, cfg)
    const plan = planForTask(s, t)
    expect(plan.errors.filter((m) => m.includes('ComfyUI 相对模型名称'))).toEqual([])
    expect(plan.errors).toEqual([])
    const stack = stackOf(applyInputs(own, plan.units[0].inputs!))
    expect(stack.map((e) => [e.name, Number(e.strength), e.active])).toEqual([
      ['syta_style_v1-step00007000', Number(list[0].strength), true],
      ['BlueArchiveStyle_illus_1884029', 0.6, true],
      ['il_contrast_slider_d1', 0.2, true],
      ['charA', 0.8, true],
    ])
    // 入队快照中的名称相同
    const { runId } = enqueueTask(s, t)
    expect(runId).not.toBeNull()
    const run = s.getRun(runId!)!
    const unit = s.listUnits(runId!)[0]
    expect(stackOf(applyInputs(run.workflow_json, unit.inputs)).map((e) => e.name)).toEqual(stack.map((e) => e.name))
  })

  it('替换工作流原有条目为同名资源：名称与原条目一致；停用、启用与权重调整只影响对应条目', () => {
    const wf = s.save('workflows', { name: 'wf', api_json: STACK_WF, mapping: STACK_MAP })
    const base = defaultLoraConfig(STACK_WF, STACK_MAP)
    const r = res['BlueArchiveStyle_illus_1884029.safetensors']
    const entries = base.entries.map((e) =>
      e.name === 'BlueArchiveStyle_illus_1884029' ? { ...e, name: r.comfyName || r.name, resource_id: r.id, strength: 0.3, clip: 0.3 }
      : e.name === 'il_contrast_slider_d1' ? { ...e, enabled: false }
      : e.name === 'Lineweight_illus_2238270' ? { ...e, enabled: true }
      : e)
    const plan = planForTask(s, task(wf, { ...base, entries }))
    expect(plan.errors).toEqual([])
    const stack = stackOf(applyInputs(STACK_WF, plan.units[0].inputs!))
    expect(stack.filter((e) => e.name === 'BlueArchiveStyle_illus_1884029')).toHaveLength(1)
    expect(stack.find((e) => e.name === 'BlueArchiveStyle_illus_1884029')).toMatchObject({ strength: 0.3, active: true })
    expect(stack.find((e) => e.name === 'il_contrast_slider_d1')?.active).toBe(false)
    expect(stack.find((e) => e.name === 'Lineweight_illus_2238270')?.active).toBe(true)
    const untouched = stackOf(STACK_WF).find((e) => e.name === 'il_saturation_slider_d1')!
    expect(stack.find((e) => e.name === 'il_saturation_slider_d1')).toEqual(untouched)
  })

  it('模型文件已删除时，多 LoRA Loader 中的条目仍然报错', () => {
    const wf = s.save('workflows', { name: 'wf', api_json: STACK_WF, mapping: STACK_MAP })
    const base = defaultLoraConfig(STACK_WF, STACK_MAP)
    rmSync(join(models, 'styles', 'new_style.safetensors'))
    const plan = planForTask(s, task(wf, { ...base, entries: [...base.entries, added('5', res['new_style.safetensors'])] }))
    expect(plan.errors.join()).toContain('模型文件缺失')
  })

  it('停用的添加条目不检查、不加载', () => {
    const wf = s.save('workflows', { name: 'wf', api_json: STACK_WF, mapping: STACK_MAP })
    const base = defaultLoraConfig(STACK_WF, STACK_MAP)
    rmSync(join(models, 'styles', 'new_style.safetensors'))
    const plan = planForTask(s, task(wf, { ...base, entries: [...base.entries, { ...added('5', res['new_style.safetensors']), enabled: false }] }))
    expect(plan.errors).toEqual([])
    expect(stackOf(applyInputs(STACK_WF, plan.units[0].inputs!)).find((e) => e.name === 'new_style')?.active ?? false).toBe(false)
  })

  it('单 LoRA Loader 仍需要 ComfyUI 相对路径：未设置时说明原因；设置后写入相对路径', async () => {
    const wf = s.save('workflows', { name: 'single', api_json: SAMPLE_WORKFLOW, mapping: SINGLE_MAP })
    const base = defaultLoraConfig(SAMPLE_WORKFLOW, SINGLE_MAP)
    expect(base.entries.map((e) => e.node)).toEqual(['10'])
    const pick = (r: LoraResource) => ({ ...base, entries: base.entries.map((e) => ({ ...e, name: r.comfyName || r.name, resource_id: r.id })) })
    // 角色 LoRA 与原条目同名，关联到 #10；这里替换 #10 为另一个 LoRA，并停用角色 LoRA 以免冲突
    const t = (cfg: WfLoraConfig) => {
      const x = task(wf, cfg)
      s.save('tasks', { id: x.id, data: { ...x.data, lora_overrides: { lora1: { enabled: false } } } })
      return s.get('tasks', x.id!)!
    }
    const missing = planForTask(s, t(pick(res['new_style.safetensors'])))
    expect(missing.errors.join()).toContain('请配置 ComfyUI 相对模型名称')
    expect(missing.errors.join()).toContain('单 LoRA Loader')

    const m = await scan()
    await m.save({ ...res['new_style.safetensors'], comfyName: 'styles\\new_style.safetensors' })
    await scan()
    const ok = planForTask(s, t(pick(res['new_style.safetensors'])))
    expect(ok.errors).toEqual([])
    expect(applyInputs(SAMPLE_WORKFLOW, ok.units[0].inputs!)['10'].inputs.lora_name).toBe('styles\\new_style.safetensors')
  })

  it('工作流原有的 LoRA（没有资源 ID）不经过 LoRA 管理检查', () => {
    const wf = s.save('workflows', { name: 'wf', api_json: STACK_WF, mapping: STACK_MAP })
    const plan = planForTask(s, task(wf, defaultLoraConfig(STACK_WF, STACK_MAP)))
    expect(plan.errors).toEqual([])
  })
})
