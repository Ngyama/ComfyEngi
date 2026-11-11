// TriggerWord Toggle (LoraManager) 的静态计算：与插件 py/nodes/trigger_word_toggle.py（79dd9a1）的各分支逐一对应。
// 期望值按插件源码推算；没有在真实 ComfyUI 中执行插件。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { toggleDisableInputs, toggleStructure } from '@shared/mapping'
import { evalText, triggerToggleOutput } from '@shared/upscale'
import type { ApiNode, ApiWorkflow } from '@shared/types'

const SAMPLE = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'upscale-sample-prompt.json'), 'utf8')) as { prompt: ApiWorkflow; toggle_00022: ApiNode }

type G = { text: string; active: boolean; strength?: number | null; items?: { text: string; active: boolean; strength?: number | null }[] }
const node = (list: G[], o: Record<string, unknown> = {}): Record<string, unknown> => ({ group_mode: true, default_active: true, allow_strength_adjustment: false, orinalMessage: 'orig_a,, orig_b', toggle_trigger_words: { __value__: list }, ...o })
const out = (inputs: Record<string, unknown>, override: unknown = null) => {
  const r = triggerToggleOutput(inputs, override)
  if ('error' in r) throw new Error(r.error)
  return r.text
}

describe('TriggerWord Toggle：组模式 + 子项（items）', () => {
  const groups: G[] = [
    { text: 'a1, a2, a3', active: true, strength: null, items: [{ text: 'a1', active: true }, { text: 'a2', active: false }, { text: 'a3', active: true }] },
    { text: 'b1, b2', active: true, strength: null, items: [{ text: 'b1', active: false }, { text: 'b2', active: false }] },
    { text: 'c1', active: false, strength: null, items: [{ text: 'c1', active: true }] },
    { text: '(d1, d2:1.20)', active: true, strength: 1.2, items: [{ text: 'd1', active: true, strength: 3 }, { text: 'd2', active: true }] },
  ]
  it('启用的组输出启用的子项（", " 拼接）；子项全部关闭的组与未启用的组跳过', () => {
    expect(out(node(groups))).toBe('a1, a3, d1, d2')
  })
  it('允许调整权重时组的权重套在拼好的子项外层，子项不带权重', () => {
    expect(out(node(groups, { allow_strength_adjustment: true }))).toBe('a1, a3, (d1, d2:1.20)')
  })
  it('组 strength 为 null 时使用 text 中的 (词:权重)', () => {
    const g: G[] = [{ text: '(x, y:0.8)', active: true, strength: null, items: [{ text: 'x', active: true }] }]
    expect(out(node(g, { allow_strength_adjustment: true }))).toBe('(x:0.80)')
    expect(out(node(g))).toBe('x')
  })
  it('只要有一组带子项就按子项处理，没有子项的组输出组的文本', () => {
    expect(out(node([{ text: 'plain', active: true }, { text: 'p', active: true, items: [{ text: 'q', active: true }] }]))).toBe('plain, q')
  })
  it('样本 image_00022_.png：第 2 组关闭了两个子项（sweater vest、black vest）', () => {
    const t = out(SAMPLE.toggle_00022.inputs)
    expect(t).toBe('long hair, two side up, crossed bangs, pink hair, multicolored eyes, hair flower, black rose, SajunaSchool, serafuku, red sailor collar, yellow bow, short sleeves, pleated skirt, red skirt, black_thighhighs')
    expect(t).not.toContain('sweater vest')
    // 允许调整权重已开启（第 4 组 strength=1 但未启用，不出现）
    expect(SAMPLE.toggle_00022.inputs.allow_strength_adjustment).toBe(true)
  })
})

describe('TriggerWord Toggle：组模式（没有子项）与非组模式', () => {
  const list: G[] = [
    { text: ' (x:1.2) ', active: true, strength: null },
    { text: 'y', active: true, strength: 0.5 },
    { text: 'z', active: false, strength: null },
    { text: '   ', active: true },
  ]
  it('组模式、不允许调整权重：text 去空白后原样输出（不拆分 (词:权重)）', () => {
    expect(out(node(list))).toBe('(x:1.2), y')
  })
  it('组模式、允许调整权重：拆出 (词:权重)，strength 不为 null 时用 strength，保留两位小数', () => {
    expect(out(node(list, { allow_strength_adjustment: true }))).toBe('(x:1.20), (y:0.50)')
  })
  it('非组模式：不允许调整权重时去掉权重，允许时带权重', () => {
    expect(out(node(list, { group_mode: false }))).toBe('x, y')
    expect(out(node(list, { group_mode: false, allow_strength_adjustment: true }))).toBe('(x:1.20), (y:0.50)')
  })
  it('权重格式与 Python 的 :.2f 相同（恰好在中间时银行家舍入）', () => {
    const w = (s: number) => out(node([{ text: 'w', active: true, strength: s }], { allow_strength_adjustment: true }))
    expect(w(0.125)).toBe('(w:0.12)')
    expect(w(0.375)).toBe('(w:0.38)')
    expect(w(1)).toBe('(w:1.00)')
    expect(w(1.005)).toBe('(w:1.00)')
  })
  it('全部未启用时输出空文本', () => {
    expect(out(node([{ text: 'a', active: false }]))).toBe('')
  })
})

describe('TriggerWord Toggle：覆盖与 fallback', () => {
  it('trigger_words 与 orinalMessage 的词集合不同时直接输出 trigger_words', () => {
    expect(out(node([{ text: 'a', active: true }]), 'new_word')).toBe('new_word')
  })
  it('词集合相同（分组、顺序、空白不同）时不覆盖；空的 trigger_words 不覆盖', () => {
    expect(out(node([{ text: 'a', active: true }]), ' orig_b ,orig_a,,,')).toBe('a')
    expect(out(node([{ text: 'a', active: true }]), '')).toBe('a')
  })
  it('列表为空或不存在时输出 orinalMessage 原文', () => {
    expect(out(node([]))).toBe('orig_a,, orig_b')
    const { toggle_trigger_words: _, ...rest } = node([])
    expect(out(rest)).toBe('orig_a,, orig_b')
  })
  it('不是列表时按 orinalMessage 拆分：组模式按 ,{2,}，非组模式按 ,', () => {
    const o = { orinalMessage: 'a, b,, c', toggle_trigger_words: { __value__: { x: 1 } } }
    expect(out(node([], { ...o }))).toBe('a, b, c')
    expect(out(node([], { ...o, group_mode: false }))).toBe('a, b, c')
    expect(out(node([], { orinalMessage: 'a,b,,c', toggle_trigger_words: { __value__: { x: 1 } } }))).toBe('a,b, c')
  })
  it('JSON 文本形式的列表按列表处理；插件处理出错（条目不是对象）时输出 orinalMessage', () => {
    expect(out(node([], { toggle_trigger_words: JSON.stringify([{ text: 'j', active: true }]) }))).toBe('j')
    expect(out(node([], { toggle_trigger_words: { __value__: ['bad'] } }))).toBe('orig_a,, orig_b')
  })
  it('无法确认与 Python 结果相同时返回 error（文本含 \\r）', () => {
    expect(triggerToggleOutput(node([{ text: 'a\rb', active: true }], { allow_strength_adjustment: true }), null)).toHaveProperty('error')
  })
})

describe('TriggerWord Toggle：结构识别与静态计算', () => {
  it('新格式（items、strength）被识别；子项类型不对时不识别', () => {
    expect(toggleStructure(SAMPLE.prompt['34'])).not.toBeNull()
    const bad: ApiNode = { class_type: 'TriggerWord Toggle (LoraManager)', inputs: node([{ text: 'a', active: true, items: [{ text: 1 as unknown as string, active: true }] }]) }
    expect(toggleStructure(bad)).toBeNull()
  })
  it('allow_strength_adjustment 开启不再判为运行时；trigger_words 连接时按 Loader 未变推断，并保留说明', () => {
    const api = SAMPLE.prompt
    const r = evalText(api, ['34', 0], { original: api })
    expect(r.runtime).toEqual([])
    expect(r.text).toBe('long hair, two side up, crossed bangs, pink hair, multicolored eyes, hair flower, black rose, SajunaSchool, serafuku, red sailor collar, yellow bow, sweater vest, black vest, short sleeves, pleated skirt, red skirt, black_thighhighs')
    expect(r.exact).toBe(false)
    expect(r.inferred[0]).toContain('#34')
  })
  it('禁止注入：只关闭组即可让带子项的节点输出空文本', () => {
    const n = SAMPLE.toggle_00022
    const graph: ApiWorkflow = { '34': { ...n, inputs: { ...n.inputs } } }
    for (const x of toggleDisableInputs('34', n)) graph['34'].inputs[x.input] = x.value
    for (const allow of [true, false]) expect(out({ ...graph['34'].inputs, allow_strength_adjustment: allow }, '')).toBe('')
  })
})
