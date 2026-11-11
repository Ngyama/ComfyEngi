// 用户的真实结构（样本图片 image_00021_.png 的 prompt 元数据与放大工作流 upscale_workflow_api.json）：
// 正面 Prompt = RegexReplace #47(^,|,$) ← StringConcatenate #45(TriggerWord Toggle #34, ",", ImpactWildcardProcessor #3)。
// 期望值按插件与 ComfyUI 节点源码推算，没有在真实 ComfyUI 中执行。

import { describe, expect, it } from 'vitest'
import { applyInputs, parseStack, loraStackOf, UPSCALE_CHECKPOINT, UPSCALE_IMAGE, UPSCALE_LORA, UPSCALE_OUTPUT, validateMapping } from '@shared/mapping'
import { evalText, pyRegexReplace, recoverGeneration, suggestUpscaleMappingWithNotes, upscaleInputs } from '@shared/upscale'
import type { ApiWorkflow } from '@shared/types'
import { SAMPLE, SAMPLE_POSITIVE, SAMPLE_UP, SAMPLE_UP_MAP } from './upscale-fixtures'

const UP = SAMPLE_UP
const G = SAMPLE.prompt
const EXPECTED_POSITIVE = SAMPLE_POSITIVE

describe('RegexReplace：Python re.sub 的 $ 与默认值', () => {
  const f = (i = true, m = false) => ({ i, m, s: false })
  it('^,|,$ 作用于以 \\n 结尾的文本：非多行模式下 $ 也匹配结尾换行符之前', () => {
    expect(pyRegexReplace(',abc,\n', '^,|,$', '', f(), 0)).toBe('abc\n')
    expect(pyRegexReplace(',a,\nb,\n', '^,|,$', '', f(), 0)).toBe('a,\nb\n')
    expect(pyRegexReplace('a,\n', ',$', 'X', f(), 0)).toBe('aX\n')
    // 只匹配结尾的一个换行符之前（Python 同样不匹配 ,\n\n 中的逗号）
    expect(pyRegexReplace('a,\n\n', ',$', '', f(), 0)).toBe('a,\n\n')
  })
  it('多行模式：$ 与 ^ 按行匹配', () => {
    expect(pyRegexReplace(',a,\n,b,', '^,|,$', '', f(true, true), 0)).toBe('a\nb')
  })
  it('count 与 case_insensitive', () => {
    expect(pyRegexReplace('a A a', 'a', 'b', f(), 2)).toBe('b b a')
    expect(pyRegexReplace('a A a', 'a', 'b', f(false), 0)).toBe('b A b')
  })
  it('替换文本中的 $ 是字面量（与 Python 相同）；含反斜杠的替换文本不计算', () => {
    expect(pyRegexReplace('a', 'a', '$1$&', f(), 0)).toBe('$1$&')
    expect(pyRegexReplace('a', 'a', '\\n', f(), 0)).toBeNull()
  })
  it('无法确认等价时返回 null：字符类里的 $、转义的 \\$、Python 特有语法、换行符与 Unicode 差异', () => {
    for (const p of ['[,$]', 'a\\$', ',$*', '(?P<x>,)', '(?i),', '\\A,', '[]a]', 'a{,2}', '(?<x>a)', '\\1']) expect(pyRegexReplace(',a,\n', p, '', f(), 0)).toBeNull()
    expect(pyRegexReplace('a,\r\n', ',$', '', f(), 0)).toBeNull()
    expect(pyRegexReplace('中文 word', '\\w+', 'x', f(), 0)).toBeNull()
    expect(pyRegexReplace('plain word', '\\w+', 'x', f(), 0)).toBe('x x')
  })
  it('节点的可选输入缺省时按节点默认值（case_insensitive 默认开启）', () => {
    const api: ApiWorkflow = { r: { class_type: 'RegexReplace', inputs: { string: 'aA', regex_pattern: 'a', replace: '' } } }
    expect(evalText(api, ['r', 0])).toMatchObject({ text: '', exact: true })
  })
})

describe('样本 image_00021_.png：恢复生成条件', () => {
  const rec = recoverGeneration(G, { original: G })
  it('正面 Prompt：触发词（组 1、2 的子项）+ "," + #3 的 populated_text，开头没有逗号，以 \\n 结尾', () => {
    expect(rec.positive).toBe(EXPECTED_POSITIVE)
    expect(rec.positive!.startsWith(',')).toBe(false)
    expect(rec.positive!.endsWith('\n')).toBe(true)
    // 触发词按插件逻辑推断（#34 的 trigger_words 在运行时来自 #5），有说明，但不是「运行时才知道」
    expect(rec.issues.filter((x) => x.level !== 'note')).toEqual([])
    expect(rec.issues.some((x) => x.level === 'note' && x.text.includes('#34'))).toBe(true)
  })
  it('负面 Prompt 等于 #4 的 populated_text；Checkpoint 与 LoRA 列表与 #30、#5 相同', () => {
    expect(rec.negative).toBe(G['4'].inputs.populated_text)
    expect(rec.negative_exact).toBe(true)
    expect(rec.checkpoint).toBe('oneObsession_v24.safetensors')
    const want = parseStack(loraStackOf(G['5'])!).map((e) => [e.name, e.strength, e.clipStrength, e.active])
    expect(rec.loras!.map((l) => [l.name, l.strength, l.clip, l.active])).toEqual(want)
    expect(want.filter((x) => !x[3]).map((x) => x[0])).toEqual(['syta_style_v1-step00007000', 'Ugly Man_illus_1001313'])
  })
})

describe('样本放大工作流 upscale_workflow_api.json', () => {
  const wf = { name: '样本放大', api_json: UP, mapping: SAMPLE_UP_MAP }
  const rec = recoverGeneration(G, { original: G })
  const r = upscaleInputs(wf, rec, 'comfyengi_upscale/u0123_abc.png')
  const graph = applyInputs(UP, r.inputs ?? [])
  it('映射没有错误；写入时没有 block', () => {
    expect(validateMapping(UP, SAMPLE_UP_MAP).filter(([l]) => l === 'error')).toEqual([])
    expect(r.issues.filter((x) => x.level === 'block')).toEqual([])
    expect(r.inputs).not.toBeNull()
  })
  it('#3 写入还原文本，#34 禁止注入，#5 的 LoRA 列表替换为原图的，LoadImage #163 写入上传路径', () => {
    expect(graph['3'].inputs.populated_text).toBe(EXPECTED_POSITIVE)
    expect(graph['3'].inputs.wildcard_text).toBe(EXPECTED_POSITIVE)
    expect(graph['4'].inputs.populated_text).toBe(G['4'].inputs.populated_text)
    const t = (graph['34'].inputs.toggle_trigger_words as { __value__: { active: boolean }[] }).__value__
    expect(t.every((g) => !g.active)).toBe(true)
    expect(graph['34'].inputs.trigger_words).toBe('')
    expect(graph['34'].inputs.orinalMessage).toBe('')
    expect(loraStackOf(graph['5'])).toEqual(loraStackOf(G['5']))
    expect(graph['163'].inputs.image).toBe('comfyengi_upscale/u0123_abc.png')
    expect(graph['142'].inputs.image).toBe(UP['142'].inputs.image)
    expect(graph['30'].inputs.ckpt_name).toBe('oneObsession_v24.safetensors')
  })
  it('写入后，进入编码器 #43 / #151 的文本正好是还原文本（^, 去掉拼接产生的开头逗号）', () => {
    for (const enc of ['43', '151']) {
      const e = evalText(graph, graph[enc].inputs.text, { original: graph })
      expect(e.text).toBe(EXPECTED_POSITIVE)
      expect(e.exact).toBe(true)
    }
  })
  it('采样与放大参数保持放大工作流的值', () => {
    for (const nid of ['32', '101', '103', '107', '109', '110']) expect(graph[nid].inputs).toEqual(UP[nid].inputs)
  })
})

describe('识别放大映射：样本放大工作流', () => {
  it('两个 LoadImage（#142 风格参考图、#163）时不替用户选择，并说明原因；Prompt 编码器的 text 是连接时说明要映射上游；两个保存节点时说明', () => {
    const { add, notes } = suggestUpscaleMappingWithNotes(UP)
    expect(add.some((m) => m.source === UPSCALE_IMAGE)).toBe(false)
    expect(add.some((m) => m.source === UPSCALE_OUTPUT)).toBe(false)
    expect(add.map((m) => `${m.source}:${m.node}.${m.input}`)).toEqual(expect.arrayContaining([`${UPSCALE_CHECKPOINT}:30.ckpt_name`, `${UPSCALE_LORA}:5.loras`]))
    const img = notes.find((n) => n.includes('「放大：输入图片」'))!
    expect(img).toMatch(/^有 2 个 LoadImage（#142 .*、#163 .*）/)
    expect(notes.some((n) => n.startsWith('正面 Prompt') && n.includes('#47'))).toBe(true)
    expect(notes.find((n) => n.includes('「放大：最终输出节点」'))).toMatch(/#121.*#136|#136.*#121/)
  })
})
