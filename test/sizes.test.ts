// 动作级生成尺寸：竖图 / 横图 / 方图各自的张数，逐张写入工作流的宽高；与多表情的确定性分配；旧动作兼容。
// 以及正面 Prompt 顶层模块之间空一行。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyInputs } from '@shared/mapping'
import { defaultSizes, expandTask, setItemSizes, sizeSchedule, sizeTotal, stepSize } from '@shared/planner'
import { compose, joinModules } from '@shared/prompt'
import { DEFAULT_SETTINGS, type ApiWorkflow, type MappingEntry, type TaskItem } from '@shared/types'
import { analyzeWorkflow, findLatentGenerators, mergeMapping } from '@shared/workflow-analysis'
import { enqueueTask, finalWorkflow, loadPlanLibrary, planForTask } from '../src/main/plan'
import { Lib, newStore } from './helpers'

const WF: ApiWorkflow = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/workflow-two-pass.json'), 'utf8'))
const checkedEntries = (api: ApiWorkflow) => analyzeWorkflow(api).suggestions.filter((s) => s.checked).flatMap((s) => s.entries)
const sized = (lib: Lib, pose: string, sizes: TaskItem['sizes'], exprs: number[] = []) => {
  const it = lib.item(pose, null, exprs, 0)
  setItemSizes(it, sizes ?? {})
  return it
}

describe('尺寸张数', () => {
  it('每次加减 5 张，最小 0；总数为三者之和；新动作默认放在竖图', () => {
    expect(stepSize(0, 1)).toBe(5)
    expect(stepSize(5, 1)).toBe(10)
    expect(stepSize(5, -1)).toBe(0)
    expect(stepSize(0, -1)).toBe(0)
    expect(stepSize(7, -1)).toBe(2) // 旧数据转换来的非 5 倍数也能正常加减
    expect(stepSize(2, -1)).toBe(0)
    expect(sizeTotal({ portrait: 5, landscape: 10, square: 0 })).toBe(15)
    expect(sizeTotal({ portrait: -5, landscape: 2.7 as number })).toBe(2)
    expect(defaultSizes(10)).toEqual({ portrait: 10, landscape: 0, square: 0 })
    expect(defaultSizes(4)).toEqual({ portrait: 5, landscape: 0, square: 0 })
    const it = { count: 0 } as TaskItem
    setItemSizes(it, { portrait: 5, landscape: 10 })
    expect(it).toEqual({ count: 15, sizes: { portrait: 5, landscape: 10, square: 0 } })
  })

  it('多尺寸与多表情：按竖、横、方顺序；每个表情总数相同；同尺寸内按表情分组；结果确定', () => {
    const sch = sizeSchedule({ portrait: 5, landscape: 5, square: 0 }, 2)
    const by = (k: string) => sch.filter((x) => x.size.key === k).map((x) => x.expr)
    expect(by('portrait')).toEqual([0, 0, 0, 1, 1]) // 微笑 3、害羞 2
    expect(by('landscape')).toEqual([0, 0, 1, 1, 1]) // 微笑 2、害羞 3
    expect(sch.map((x) => x.size.key)).toEqual([...Array(5).fill('portrait'), ...Array(5).fill('landscape')])
    expect(sizeSchedule({ portrait: 5, landscape: 5 }, 2)).toEqual(sch)
    const three = sizeSchedule({ portrait: 10, landscape: 5, square: 15 }, 3)
    expect([0, 1, 2].map((e) => three.filter((x) => x.expr === e).length)).toEqual([10, 10, 10])
  })
})

describe('任务展开', () => {
  it('单尺寸与多尺寸：每张带实际宽高，顺序固定；旧动作没有尺寸', () => {
    const s = newStore()
    const lib = new Lib(s)
    const r = expandTask(
      lib.task([sized(lib, '睡觉', { landscape: 5 }), sized(lib, '动作A', { portrait: 5, landscape: 10, square: 0 }), lib.item('动作C', null, [], 3)]),
      loadPlanLibrary(s),
      s.settings(),
    )
    expect(r.errors).toEqual([])
    const sizeOf = (i: number) => r.units.filter((u) => u.item_index === i).map((u) => `${u.width}x${u.height}`)
    expect(sizeOf(0)).toEqual(Array(5).fill('1536x1024'))
    expect(sizeOf(1)).toEqual([...Array(5).fill('1024x1536'), ...Array(10).fill('1536x1024')])
    expect(sizeOf(2)).toEqual(Array(3).fill('undefinedxundefined'))
    const u = r.units.find((x) => x.item_index === 1)!
    expect(u.meta).toMatchObject({ size: '竖图', width: 1024, height: 1536, n: 1, of: 15 })
    expect(r.units.find((x) => x.item_index === 2)!.meta.size).toBeUndefined()
  })

  it('多尺寸 + 多表情：每个表情张数相同；不能整除时沿用原提示；全部为 0 时不能入队', () => {
    const s = newStore()
    const lib = new Lib(s)
    const e = lib.exprs
    const r = expandTask(lib.task([sized(lib, '动作A', { portrait: 5, landscape: 5 }, [e[0], e[1]])]), loadPlanLibrary(s), s.settings())
    expect(r.errors).toEqual([])
    const rows = r.units.map((u) => [u.meta.size, u.meta.expression, u.meta.expression_n, u.meta.expression_of])
    expect(rows).toEqual([
      ['竖图', '表情1', 1, 5],
      ['竖图', '表情1', 2, 5],
      ['竖图', '表情1', 3, 5],
      ['竖图', '表情2', 1, 5],
      ['竖图', '表情2', 2, 5],
      ['横图', '表情1', 4, 5],
      ['横图', '表情1', 5, 5],
      ['横图', '表情2', 3, 5],
      ['横图', '表情2', 4, 5],
      ['横图', '表情2', 5, 5],
    ])
    const bad = expandTask(lib.task([sized(lib, '动作A', { portrait: 5, landscape: 5, square: 5 }, [e[0], e[1]])]), loadPlanLibrary(s), s.settings())
    expect(bad.errors[0]).toContain('张数 15 不能被 2 个表情平均分配')
    const zero = expandTask(lib.task([sized(lib, '动作A', { portrait: 0, landscape: 0, square: 0 })]), loadPlanLibrary(s), s.settings())
    expect(zero.units).toEqual([])
    expect(zero.errors[0]).toContain('竖图、横图、方图的张数都为 0')
  })

  it('旧任务（没有尺寸配置）：张数、表情分配、顺序与以前相同，不写入宽高', () => {
    const s = newStore()
    const lib = new Lib(s)
    const e = lib.exprs
    const r = expandTask(lib.task([lib.item('动作A', null, [e[0], e[1]], 4)]), loadPlanLibrary(s), s.settings())
    expect(r.units.map((u) => [u.meta.expression, u.meta.expression_n, u.width])).toEqual([
      ['表情1', 1, undefined],
      ['表情1', 2, undefined],
      ['表情2', 1, undefined],
      ['表情2', 2, undefined],
    ])
  })
})

describe('写入工作流宽高（Test.json 两次采样）', () => {
  it('自动识别：EmptyLatentImage #37 的宽高连接自整数节点 #1、#12，映射到上游；不涉及放大、分块参数', () => {
    expect(findLatentGenerators(WF)).toEqual(['37'])
    const size = analyzeWorkflow(WF).suggestions.filter((s) => s.group === 'size')
    expect(size.map((s) => [s.entries[0].source, s.entries[0].node, s.entries[0].input, s.checked])).toEqual([
      ['width', '1', 'value', true],
      ['height', '12', 'value', true],
    ])
    const all = checkedEntries(WF)
    expect(all.some((e) => ['107', '101', '110', '19'].includes(e.node))).toBe(false)
  })

  it('直接填写宽高的 EmptyLatentImage 映射到自身；缩放图像节点不算', () => {
    const api: ApiWorkflow = {
      '5': { class_type: 'EmptyLatentImage', inputs: { width: 832, height: 1216, batch_size: 1 } },
      '9': { class_type: 'ImageScale', inputs: { image: ['8', 0], width: 2048, height: 2048, upscale_method: 'lanczos', crop: 'disabled' } },
      '10': { class_type: 'UltimateSDUpscale', inputs: { image: ['8', 0], tile_width: 768, tile_height: 768, upscale_by: 2 } },
    }
    expect(findLatentGenerators(api)).toEqual(['5'])
    const size = analyzeWorkflow(api).suggestions.filter((s) => s.group === 'size')
    expect(size.map((s) => `${s.entries[0].source}:${s.entries[0].node}.${s.entries[0].input}:${s.checked}`)).toEqual(['width:5.width:true', 'height:5.height:true'])
  })

  it('多个空 latent 节点、无法识别的上游：需要确认或手动映射', () => {
    const api: ApiWorkflow = {
      '1': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
      '2': { class_type: 'EmptySD3LatentImage', inputs: { width: ['3', 0], height: 1024, batch_size: 1 } },
      '3': { class_type: 'SimpleMath+', inputs: { a: ['4', 0], value: 2 } },
    }
    const a = analyzeWorkflow(api)
    const size = a.suggestions.filter((s) => s.group === 'size')
    expect(size.every((s) => !s.checked && s.confidence === 'confirm')).toBe(true)
    expect(size.some((s) => s.node === '3')).toBe(false)
    expect(a.notes.some((n) => n.includes('#2') && n.includes('无法自动识别'))).toBe(true)
  })

  it('逐张写入 #1、#12；预览、最终工作流 JSON、入队快照一致；原工作流不变；旧动作保持默认尺寸', () => {
    const s = newStore()
    const lib = new Lib(s)
    const mapping: MappingEntry[] = mergeMapping([], checkedEntries(WF))
    lib.addWorkflow(mapping, WF)
    const before = JSON.stringify(WF)
    const t = lib.makeTask([sized(lib, '睡觉', { portrait: 5, landscape: 5, square: 5 }), lib.item('动作A', null, [], 2)], '尺寸', { male_base_id: null })
    const plan = planForTask(s, t, undefined, '2026-10-28')
    expect(plan.errors).toEqual([])
    expect(plan.warnings.some((w) => w.includes('尺寸不会生效'))).toBe(false)
    const dims = plan.units.map((u) => {
      const g = applyInputs(WF, u.inputs!)
      return `${g['1'].inputs.value}x${g['12'].inputs.value}`
    })
    expect(dims).toEqual([...Array(5).fill('1024x1536'), ...Array(5).fill('1536x1024'), ...Array(5).fill('1024x1024'), '1024x1536', '1024x1536'])
    // 旧动作：#1、#12 保持工作流原值（这个工作流原本就是 1024x1536）
    expect(plan.units[15].inputs!.find((x) => x.source === 'width')!.value).toBeNull()
    // 放大、分块参数不变
    const g6 = applyInputs(WF, plan.units[6].inputs!)
    expect([g6['107'], g6['101'], g6['110'], g6['37']]).toEqual([WF['107'], WF['101'], WF['110'], WF['37']])
    // 最终工作流 JSON 与预览一致；入队快照一致
    const fw = finalWorkflow(s, t, 6)
    expect([fw.json['1'].inputs.value, fw.json['12'].inputs.value]).toEqual([1536, 1024])
    const run = enqueueTask(s, t).runId!
    const snap = s.listUnits(run)
    expect(snap.map((u) => u.inputs.find((x) => x.source === 'width')?.value ?? null)).toEqual(plan.units.map((u) => u.inputs!.find((x) => x.source === 'width')?.value ?? null))
    expect(snap[6].meta).toMatchObject({ size: '横图', width: 1536, height: 1024 })
    expect(JSON.stringify(WF)).toBe(before)
  })

  it('配置了尺寸但工作流没有映射宽高：提示尺寸不会生效', () => {
    const s = newStore()
    const lib = new Lib(s)
    lib.addWorkflow()
    const t = lib.makeTask([sized(lib, '睡觉', { portrait: 5 })])
    expect(planForTask(s, t).warnings.some((w) => w.includes('尺寸不会生效'))).toBe(true)
  })
})

describe('Prompt 模块之间空一行', () => {
  const settings = { ...DEFAULT_SETTINGS }
  it('模块之间空行；空模块跳过；模块末尾的逗号不重复；模块内部与原有换行不变', () => {
    const mods = {
      global: ['masterpiece, best quality, anime screencap,', 'bad'],
      scene: ['indoors, bedroom', ''],
      camera: ['', ''],
      character: ['1girl, long hair,  ', 'worse'],
      interaction: ['missionary, legs up, hug, {embrace|cuddle}, (kiss:1.2)', ''],
      extra: ['line1\nline2,', ''],
    } as Record<string, [string, string]>
    const [pos, neg] = compose(mods, settings)
    expect(pos).toBe('masterpiece, best quality, anime screencap,\n\nindoors, bedroom,\n\n1girl, long hair,\n\nmissionary, legs up, hug, {embrace|cuddle}, (kiss:1.2),\n\nline1\nline2,')
    expect(neg).toBe('bad, worse') // 负面保持原有拼接
    expect(joinModules(['a,', 'b'], ' BREAK ')).toBe('a, BREAK b') // 连接符不以逗号开头时不去掉逗号
  })

  it('最终 Prompt 预览、工作流 JSON 与入队快照完全一致', () => {
    const s = newStore()
    const lib = new Lib(s)
    lib.addWorkflow(mergeMapping([], checkedEntries(WF)), WF)
    const t = lib.makeTask([lib.item('睡觉', lib.outfitsA[0], [lib.exprs[0]], 1)], 'P', { male_base_id: null })
    const plan = planForTask(s, t)
    const u = plan.units[0]
    expect(u.positive).toContain(',\n\n')
    const g = applyInputs(WF, u.inputs!)
    expect(g['3'].inputs.populated_text).toBe(u.positive)
    const run = enqueueTask(s, t).runId!
    expect(s.listUnits(run)[0].positive).toBe(u.positive)
    expect(s.listUnits(run)[0].inputs.find((x) => x.source === 'positive')!.value).toBe(u.positive)
  })
})
