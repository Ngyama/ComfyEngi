// 图片 Prompt 提取：真实格式的元数据样例，要求提取结果与图片实际使用的正向 Prompt 完全一致；
// 以及原始元数据读取、手动指定来源、按工作流结构批量应用、提取后进入组合挖掘。

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { minePrompts } from '@shared/mining'
import { extractPrompt, matchRule, parseJsonLoose, promptFromApiGraph, promptFromUiWorkflow } from '@shared/prompt-source'
import { parseImageBuffer } from '../src/main/png-meta'
import { MiningScanner, rawField, rawMeta, scanImage } from '../src/main/mining'
import { COWGIRL, makePng, MISSIONARY } from './mining-fixtures'
import {
  A1111,
  A1111_POS,
  apiCustomAdvanced,
  apiCustomComposer,
  apiDefault,
  apiEasyPipe,
  apiEfficient,
  apiFlux,
  apiHiresDetailer,
  apiImpactWildcard,
  apiPowerPrompt,
  apiWasConcat,
  ascii,
  makeJpeg,
  makeWebp,
  NEG,
  NOVELAI,
  POS,
  pyJson,
  tiff,
  uiDefault,
  userComment,
} from './meta-fixtures'

const tmp = () => mkdtempSync(join(tmpdir(), 'ce-extract-'))
const comfy = (g: unknown, extra: Record<string, string> = {}) => extractPrompt({ prompt: JSON.stringify(g), ...extra })

describe('ComfyUI API 工作流（prompt 字段）', () => {
  it('原生默认工作流：正向与负向完全一致，不混入未连接的文本', () => {
    const r = comfy(apiDefault())
    expect(r).toMatchObject({ status: 'ok', source: 'comfy-api', positive: POS, negative: NEG })
  })

  it('与界面格式 workflow 同时存在时以 prompt 为准', () => {
    const r = extractPrompt({ prompt: JSON.stringify(apiDefault()), workflow: JSON.stringify(uiDefault('stale ui text', NEG)) })
    expect(r.positive).toBe(POS)
  })

  it('Python 写出的 NaN / Infinity 不会导致整张图片无法读取', () => {
    const text = JSON.stringify(apiDefault()).replace('"denoise":1', '"denoise":NaN').replace('"cfg":6.5', '"cfg":Infinity')
    expect(() => JSON.parse(text)).toThrow()
    expect(parseJsonLoose('{"a":"NaN in text","b":NaN}')).toEqual({ a: 'NaN in text', b: null })
    expect(extractPrompt({ prompt: text }).positive).toBe(POS)
  })
})

describe('ComfyUI 界面格式工作流（workflow 字段）', () => {
  it('默认工作流：按连线读取，备注节点与其他控件不混入', () => {
    const r = extractPrompt({ workflow: JSON.stringify(uiDefault()) })
    expect(r).toMatchObject({ status: 'ok', source: 'comfy-workflow', positive: POS, negative: NEG })
  })

  it('字符串常量节点连到文本输入、被绕过的 ControlNet、Set/Get 节点', () => {
    const wf = uiDefault('unused widget value', NEG) as any
    const six = wf.nodes.find((n: any) => n.id === 6)
    six.inputs[1].link = 20
    wf.nodes.push({ id: 20, type: 'PrimitiveNode', mode: 0, inputs: [], outputs: [{ name: 'STRING', type: 'STRING', links: [20] }], widgets_values: [POS] })
    // 6 → ControlNetApplyAdvanced（已绕过）→ SetNode("pos") … GetNode("pos") → KSampler.positive
    wf.nodes.push({ id: 30, type: 'ControlNetApplyAdvanced', mode: 4, inputs: [{ name: 'positive', link: 21 }, { name: 'negative', link: 22 }], widgets_values: [1, 0, 1] })
    wf.nodes.push({ id: 31, type: 'SetNode', mode: 0, inputs: [{ name: 'CONDITIONING', link: 23 }], widgets_values: ['pos'] })
    wf.nodes.push({ id: 32, type: 'GetNode', mode: 0, inputs: [], widgets_values: ['pos'] })
    wf.links = wf.links.filter((l: any) => l[0] !== 4 && l[0] !== 6)
    wf.links.push([20, 20, 0, 6, 1, 'STRING'], [21, 6, 0, 30, 0, 'CONDITIONING'], [22, 7, 0, 30, 1, 'CONDITIONING'], [23, 30, 0, 31, 0, 'CONDITIONING'], [24, 32, 0, 3, 1, 'CONDITIONING'], [25, 30, 1, 3, 2, 'CONDITIONING'])
    wf.nodes.find((n: any) => n.id === 3).inputs[1].link = 24
    wf.nodes.find((n: any) => n.id === 3).inputs[2].link = 25
    const r = promptFromUiWorkflow(wf)
    expect(r.status).toBe('ok')
    expect(r.positive).toBe(POS)
    expect(r.negative).toBe(NEG)
  })
})

describe('常见自定义节点与文本拼接', () => {
  it('Efficiency Nodes（Efficient Loader 保存正负文本）', () => {
    expect(comfy(apiEfficient())).toMatchObject({ status: 'ok', positive: POS, negative: NEG })
  })

  it('Impact Pack 通配符：采用展开后的文本；没有保存展开结果时不声称已恢复', () => {
    expect(comfy(apiImpactWildcard('red hair, 1girl, smile'))).toMatchObject({ status: 'ok', positive: 'red hair, 1girl, smile' })
    const r = comfy(apiImpactWildcard(''))
    expect(r.status).toBe('error')
    expect(r.error).toMatch(/没有保存展开后的文本/)
  })

  it('WAS Text Concatenate：按分隔符拼接，不把 clean_whitespace 选项当成文本', () => {
    expect(comfy(apiWasConcat())).toMatchObject({ status: 'ok', positive: 'masterpiece, best quality, 1girl, solo, smile' })
  })

  it('rgthree Power Prompt、Easy-Use 管道采样、Flux（负向为置零 conditioning）', () => {
    expect(comfy(apiPowerPrompt())).toMatchObject({ status: 'ok', positive: POS })
    expect(comfy(apiEasyPipe())).toMatchObject({ status: 'ok', positive: POS, negative: NEG })
    // 负向由正向置零得到：不应被判断为「同一文本同时连到正负两侧」
    expect(comfy(apiFlux())).toMatchObject({ status: 'ok', positive: POS, negative: '' })
  })

  it('Prompt 风格节点：读取原文但标记需要确认（模板内容未保存）', () => {
    const g: any = apiDefault()
    g['30'] = { class_type: 'SDXLPromptStyler', inputs: { text_positive: POS, text_negative: NEG, style: 'sai-anime', log_prompt: false, style_positive: true, style_negative: true } }
    g['6'].inputs.text = ['30', 0]
    g['7'].inputs.text = ['30', 1]
    const r = comfy(g)
    expect(r.status).toBe('check')
    expect(r.positive).toBe(POS)
    expect(r.negative).toBe(NEG)
    expect(r.notes.join()).toMatch(/风格节点 #30/)
  })

  it('动态 Prompt 节点：PNG 中只有模板时报告原因，不把模板当作结果', () => {
    const g: any = apiDefault()
    g['40'] = { class_type: 'DPRandomGenerator', inputs: { text: '{red|blue} hair, 1girl', seed: 5, autorefresh: 'No' } }
    g['6'].inputs.text = ['40', 0]
    const r = comfy(g)
    expect(r.status).toBe('error')
    expect(r.error).toMatch(/运行时生成文本的节点 #40（DPRandomGenerator）/)
    expect(r.positive).toBe('')
  })
})

describe('多阶段采样与多个 Prompt 节点', () => {
  it('Hires 第二阶段与 FaceDetailer 使用不同 Prompt：只取第一阶段，不拼接', () => {
    const r = comfy(apiHiresDetailer())
    expect(r.status).toBe('ok')
    expect(r.positive).toBe(POS)
    expect(r.positive).not.toMatch(/highres|detailed face/)
    expect(r.notes.join()).toMatch(/第一阶段采样器 #3/)
    // 其他文本仍可在候选中找到
    expect(r.candidates.map((c) => c.text)).toEqual(expect.arrayContaining(['highres, sharp focus, detailed', 'detailed face, beautiful eyes']))
  })

  it('SamplerCustomAdvanced + CFGGuider', () => {
    expect(comfy(apiCustomAdvanced())).toMatchObject({ status: 'ok', positive: POS, negative: NEG })
  })

  it('两个独立的第一阶段采样器使用不同 Prompt：需要确认', () => {
    const g: any = apiDefault()
    g['42'] = { class_type: 'CLIPTextEncode', inputs: { text: 'another subject', clip: ['4', 1] } }
    g['41'] = { class_type: 'KSampler', inputs: { ...g['3'].inputs, positive: ['42', 0] } }
    expect(comfy(g).status).toBe('check')
  })
})

describe('WebUI / Forge 与其他软件', () => {
  it('A1111 / Forge parameters：多行正向、BREAK、LoRA 原样保留', () => {
    expect(extractPrompt({ parameters: A1111 })).toMatchObject({ status: 'ok', source: 'a1111', positive: A1111_POS, negative: NEG })
    // 以 { 开头的动态 Prompt 语法不是 JSON
    expect(extractPrompt({ parameters: '{red|blue} hair, 1girl\nSteps: 20' }).positive).toBe('{red|blue} hair, 1girl')
  })

  it('JPEG / WebP：EXIF UserComment（UTF-16）中的 parameters', () => {
    const exif = tiff([], [[0x9286, 7, userComment(A1111)]])
    for (const [buf, fmt] of [
      [makeJpeg(exif), 'jpeg'],
      [makeWebp(exif), 'webp'],
    ] as const) {
      const m = parseImageBuffer(buf, `x.${fmt === 'jpeg' ? 'jpg' : 'webp'}`)
      expect(m.format).toBe(fmt)
      expect(m.fields[0]).toMatchObject({ key: 'parameters', via: 'EXIF UserComment', text: A1111 })
      expect(extractPrompt({ parameters: m.fields[0].text }).positive).toBe(A1111_POS)
    }
  })

  it('ComfyUI 保存的 WebP：EXIF Make / Model 中的 "workflow:" / "prompt:"', () => {
    const m = parseImageBuffer(makeWebp(tiff([[0x010f, 2, ascii(`workflow:${JSON.stringify(uiDefault())}`)], [0x0110, 2, ascii(`prompt:${JSON.stringify(apiDefault())}`)]])), 'a.webp')
    expect(m.fields.map((f) => f.key)).toEqual(['workflow', 'prompt'])
    const chunks = Object.fromEntries(m.fields.map((f) => [f.key, f.text]))
    expect(extractPrompt(chunks)).toMatchObject({ status: 'ok', source: 'comfy-api', positive: POS })
  })

  it('扩展名与内容不符（JPEG 命名为 .png）：按内容读取并提示', () => {
    const m = parseImageBuffer(makeJpeg(tiff([], [[0x9286, 7, userComment(A1111)]])), 'renamed.png')
    expect(m.format).toBe('jpeg')
    expect(m.warnings[0]).toMatch(/扩展名是 \.png，但实际是 JPEG/)
  })

  it('NovelAI、InvokeAI、Easy Diffusion、SwarmUI、Fooocus', () => {
    const nai = extractPrompt(NOVELAI)
    expect(nai).toMatchObject({ status: 'ok', source: 'novelai', positive: '1girl, solo, {{smile}}, school uniform', negative: 'lowres, bad anatomy' })
    expect(nai.notes.join()).toMatch(/1 段角色提示词/)
    expect(extractPrompt({ invokeai_metadata: JSON.stringify({ positive_prompt: '1girl, smile', negative_prompt: 'lowres', model: {} }) })).toMatchObject({ source: 'invokeai', positive: '1girl, smile', negative: 'lowres' })
    expect(extractPrompt({ prompt: '1girl, smile, outdoors', negative_prompt: 'lowres' })).toMatchObject({ source: 'easydiffusion', positive: '1girl, smile, outdoors', negative: 'lowres' })
    expect(extractPrompt({ parameters: JSON.stringify({ sui_image_params: { prompt: '1girl, swarm', negativeprompt: 'bad' } }) })).toMatchObject({ source: 'swarmui', positive: '1girl, swarm' })
    expect(extractPrompt({ parameters: JSON.stringify({ prompt: '1girl, fooocus', negative_prompt: '', styles: '[]' }), fooocus_scheme: 'fooocus' })).toMatchObject({ source: 'fooocus', positive: '1girl, fooocus' })
  })

  it('工作流有歧义时，采用自定义保存节点写入的 parameters', () => {
    const g: any = apiDefault()
    g['3'].inputs.negative = ['6', 0]
    const r = comfy(g, { parameters: `${POS}\nNegative prompt: ${NEG}\nSteps: 20` })
    expect(r).toMatchObject({ status: 'ok', source: 'a1111', positive: POS })
    expect(r.notes.join()).toMatch(/parameters 中直接保存/)
  })
})

describe('没有元数据 / 无法识别', () => {
  it('PNG 没有任何元数据：明确说明', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'plain.png'), makePng({}))
    const r = await scanImage(join(dir, 'plain.png'))
    expect(r.status).toBe('error')
    expect(r.error).toMatch(/没有任何文本元数据/)
    expect(r.fields).toEqual([])
    expect(r.candidates).toEqual([])
  })

  it('有元数据但无法识别正向 Prompt：报告字段名，并提供候选文本', () => {
    const r = extractPrompt({ Software: 'SomeTool 2.1', Comment: 'pink hair, 1girl, garden' })
    expect(r.status).toBe('error')
    expect(r.error).toMatch(/Software、Comment/)
    expect(r.candidates.map((c) => c.text)).toContain('pink hair, 1girl, garden')
  })

  it('不支持的自定义节点：错误信息可理解，且仍列出工作流中的文本', () => {
    const r = comfy(apiCustomComposer('silver hair, 1girl, maid'))
    expect(r.status).toBe('error')
    expect(r.error).toMatch(/无法识别的节点 #50（PromptComposer）/)
    const c = r.candidates.find((x) => x.text === 'silver hair, 1girl, maid')!
    expect(c.role).toBe('positive')
    expect(r.candidates.find((x) => x.text === NEG)!.role).toBe('negative')
  })
})

describe('手动指定来源与批量应用', () => {
  it('自动提取失败后手动指定来源：得到预期的正向 Prompt', () => {
    const r = comfy(apiCustomComposer('silver hair, 1girl, maid'))
    const pick = r.candidates.find((c) => c.label.includes('PromptComposer') && c.label.includes('prompt_text'))!
    expect(pick.text).toBe('silver hair, 1girl, maid')
    expect(pick.rule.kind).toBe('node')
  })

  it('同结构图片按节点类型与连接结构匹配（节点编号不同也能匹配），不同结构不匹配', () => {
    const a = comfy(apiCustomComposer('silver hair, 1girl, maid'))
    const rule = a.candidates.find((c) => c.label.includes('prompt_text'))!.rule
    const b = comfy(apiCustomComposer('black hair, 1girl, nurse', 100)) // 节点全部重新编号
    const g: any = apiCustomComposer('blonde, 1girl', 0)
    g['60'] = { class_type: 'LoraLoader', inputs: { lora_name: 'x.safetensors', strength_model: 1, strength_clip: 1, model: ['4', 0], clip: ['4', 1] } }
    g['6'].inputs.clip = ['60', 1]
    const c = comfy(g)
    expect(b.structure).toBe(a.structure)
    expect(matchRule(rule, b)?.text).toBe('black hair, 1girl, nurse')
    expect(c.structure).not.toBe(a.structure)
    expect(matchRule(rule, c)).toBeNull()
    // 原生工作流中，选择负向节点的规则不会匹配到正向节点
    const neg = a.candidates.find((x) => x.text === NEG)!.rule
    expect(matchRule(neg, b)?.text).toBe(NEG)
  })

  it('结构中有多个完全相同的节点时，只在同结构内按节点 ID 区分', () => {
    const mk = (t1: string, t2: string) => {
      const g: any = apiCustomComposer('x')
      g['70'] = { class_type: 'Text Multiline', inputs: { text: t1 } }
      g['71'] = { class_type: 'Text Multiline', inputs: { text: t2 } }
      return comfy(g)
    }
    const a = mk('one', 'two')
    const b = mk('uno', 'dos')
    const rule = a.candidates.find((c) => c.text === 'two')!.rule
    expect(rule.nodeId).toBe('71')
    expect(matchRule(rule, b)?.text).toBe('dos')
  })

  it('字段规则：按字段名应用到含相同字段的图片', () => {
    const a = extractPrompt({ Software: 'SomeTool', Comment: 'pink hair, 1girl' })
    const b = extractPrompt({ Software: 'SomeTool', Comment: 'green hair, 1girl' })
    const rule = a.candidates.find((c) => c.text === 'pink hair, 1girl')!.rule
    expect(rule.kind).toBe('field')
    expect(matchRule(rule, b)?.text).toBe('green hair, 1girl')
    expect(matchRule(rule, extractPrompt({ Software: 'x' }))).toBeNull()
  })
})

describe('原始元数据诊断', () => {
  it('列出所有字段，JSON 格式化显示，超长内容截断但复制时得到完整原文', () => {
    const dir = tmp()
    const big = 'x, '.repeat(200_000)
    const file = join(dir, 'a.png')
    writeFileSync(file, makePng({ prompt: JSON.stringify(apiCustomComposer('silver hair')), parameters: big }))
    const m = rawMeta(file)
    expect(m.format).toBe('png')
    expect(m.fields.map((f) => [f.key, f.via, f.json])).toEqual([
      ['prompt', 'tEXt', true],
      ['parameters', 'tEXt', false],
    ])
    expect(m.fields[0].text).toContain('\n  "50": {')
    expect(m.fields[0].text).toContain('"clip": ["4", 1]')
    expect(m.fields[1].truncated).toBe(true)
    expect(m.fields[1].text.length).toBeLessThan(big.length)
    expect(rawField(file, 1)).toBe(big)
  })

  it('提取失败、文件被截断时仍返回已读到的元数据', async () => {
    const dir = tmp()
    const good = makePng({ prompt: JSON.stringify(apiCustomComposer('silver hair')) })
    writeFileSync(join(dir, 'cut.png'), good.subarray(0, good.length - 20))
    const r = await scanImage(join(dir, 'cut.png'))
    expect(r.status).toBe('error')
    expect(r.fields.map((f) => f.key)).toEqual(['prompt'])
    expect(r.notes.join()).toMatch(/截断|不完整/)
    expect(rawMeta(join(dir, 'cut.png')).fields[0].key).toBe('prompt')
  })
})

describe('扫描反馈与进入组合挖掘', () => {
  it('混合格式的文件夹：统计扫描范围，提取结果与预期一致，原图不变，进入组合挖掘', async () => {
    const dir = tmp()
    mkdirSync(join(dir, 'sub'))
    const prompts: string[] = []
    for (let i = 0; i < 6; i++) prompts.push(`masterpiece, 1girl, ${COWGIRL}, ${i % 2 ? 'smile' : 'blush'}`)
    for (let i = 0; i < 5; i++) prompts.push(`masterpiece, 1girl, ${MISSIONARY}, ${i % 2 ? 'indoors' : 'outdoors'}`)
    const files: [string, Buffer][] = prompts.map((p, i) => {
      if (i % 4 === 0) return [`sub/e${i}.png`, makePng({ prompt: pyJson(apiEfficient(p)) })]
      if (i % 4 === 1) return [`w${i}.png`, makePng({ workflow: pyJson(uiDefault(p)) })]
      if (i % 4 === 2) return [`a${i}.jpg`, makeJpeg(tiff([], [[0x9286, 7, userComment(`${p}\nNegative prompt: ${NEG}\nSteps: 20`)]]))]
      return [`c${i}.png`, makePng({ prompt: pyJson(apiDefault(p)) }, 'iTXt')]
    })
    files.push(['broken.png', Buffer.from('nope')], ['plain.png', makePng({})], ['anim.gif', Buffer.from('GIF89a')])
    for (const [f, b] of files) writeFileSync(join(dir, f), b)
    const before = files.map(([f]) => createHash('sha256').update(readFileSync(join(dir, f))).digest('hex'))
    const r = await new MiningScanner().scan([], [dir], true, () => {})
    expect(r.found).toMatchObject({ images: 13, unsupported: { '.gif': 1 } })
    expect(r.errors.join()).toMatch(/\.gif 1 个/)
    const byName = new Map(r.images.map((i) => [i.name, i]))
    files.slice(0, prompts.length).forEach(([f], i) => {
      const im = byName.get(f.replace('sub/', ''))!
      expect([f, im.status, im.error]).toEqual([f, "ok", undefined])
      expect(im.positive).toBe(prompts[i])
    })
    expect(byName.get('broken.png')!.error).toMatch(/不是 PNG/)
    expect(byName.get('plain.png')!.error).toMatch(/没有任何文本元数据/)
    const ok = r.images.filter((i) => i.status === 'ok')
    expect(ok).toHaveLength(prompts.length)
    const res = minePrompts(ok.map((i) => ({ id: i.id, positive: i.positive })), { minSupport: 3 }, null)
    expect(res.global.map((t) => t.key)).toEqual(['masterpiece', '1girl'])
    expect(res.candidates.map((c) => c.prompt)).toEqual(expect.arrayContaining([COWGIRL, MISSIONARY]))
    expect(files.map(([f]) => createHash('sha256').update(readFileSync(join(dir, f))).digest('hex'))).toEqual(before)
  })

  it('文件夹中没有支持的图片：说明扫描范围与找到的其他格式', async () => {
    const dir = tmp()
    mkdirSync(join(dir, 'deep'))
    writeFileSync(join(dir, 'a.avif'), 'x')
    writeFileSync(join(dir, 'deep', 'b.png'), makePng({ parameters: A1111 }))
    const r = await new MiningScanner().scan([], [dir], false, () => {})
    expect(r.images).toEqual([])
    expect(r.errors.join()).toMatch(/没有找到 PNG \/ JPEG \/ WebP 图片（扫描了 1 个文件夹，未包含子文件夹）；另有不支持的图片：\.avif 1 个/)
  })
})

describe('不破坏已有解析', () => {
  it('promptFromApiGraph 对原有样例的结果不变', () => {
    expect(promptFromApiGraph(apiDefault())).toMatchObject({ status: 'ok', positive: POS, negative: NEG })
  })
})
