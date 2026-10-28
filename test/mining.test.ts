// 历史 Prompt 提取：PNG 元数据读取、正负 Prompt 区分、标签规范化、组合挖掘、保存到 Vault。

import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { minePrompts, DEFAULT_MINING } from '@shared/mining'
import { extractPrompt, promptFromApiGraph, promptFromParameters, promptFromUiWorkflow } from '@shared/prompt-source'
import { buildDictionary, parseDictionary, parseToken, promptSignature, removeTag, splitTopLevel, stripWeight, tokenizePrompt } from '@shared/tags'
import { parsePngText, readPngText } from '../src/main/png-meta'
import { dictionaryInfo, importDictionary, MiningScanner, saveMined, scanImage } from '../src/main/mining'
import { createVault, openVault } from '../src/main/vault'
import { decode } from '../src/main/file-library'
import { chunk, comfyGraph, COWGIRL, dataset, makePng, MISSIONARY } from './mining-fixtures'

const tmp = () => mkdtempSync(join(tmpdir(), 'ce-mining-'))
const hashFile = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex')

describe('PNG 元数据读取', () => {
  it('读取 tEXt / zTXt / iTXt 文本块，跳过图像数据', async () => {
    const graph = JSON.stringify(comfyGraph('1girl, smile'))
    for (const mode of ['tEXt', 'zTXt', 'iTXt'] as const) {
      const buf = makePng({ prompt: graph, workflow: '{"nodes":[],"links":[]}' }, mode)
      expect(parsePngText(buf).prompt).toBe(graph)
      const dir = tmp()
      writeFileSync(join(dir, 'a.png'), buf)
      const r = await readPngText(join(dir, 'a.png'))
      expect(r.prompt).toBe(graph)
      expect(r.workflow).toBe('{"nodes":[],"links":[]}')
    }
  })

  it('iTXt 中的中文按 UTF-8 读取', () => {
    const buf = makePng({ parameters: '少女, smile\nSteps: 20' }, 'iTXt')
    expect(parsePngText(buf).parameters).toBe('少女, smile\nSteps: 20')
  })

  it('缺少元数据、非 PNG、截断与损坏的文件报告原因，不抛出到整批', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'none.png'), makePng({}))
    writeFileSync(join(dir, 'fake.png'), Buffer.from('not a png at all'))
    const good = makePng({ prompt: JSON.stringify(comfyGraph('1girl')) })
    writeFileSync(join(dir, 'cut.png'), good.subarray(0, good.length - 20))
    const bad = Buffer.from(good)
    bad.write('\u0001\u0002\u0003\u0004', 12, 'latin1') // 破坏第一个块的类型
    writeFileSync(join(dir, 'bad.png'), bad)
    // 声明长度超过上限的文本块
    const huge = Buffer.concat([good.subarray(0, 33), (() => { const h = Buffer.alloc(8); h.writeUInt32BE(0x7ffffff0); h.write('tEXt', 4, 'latin1'); return h })()])
    writeFileSync(join(dir, 'huge.png'), huge)
    const res = Object.fromEntries(await Promise.all(['none', 'fake', 'cut', 'bad', 'huge'].map(async (n) => [n, await scanImage(join(dir, `${n}.png`))])))
    expect(res.none.status).toBe('error')
    expect(res.none.error).toMatch(/没有找到生成参数/)
    expect(res.fake.error).toMatch(/不是 PNG/)
    expect(res.cut.error).toMatch(/截断|不完整/)
    expect(res.bad.error).toMatch(/损坏/)
    expect(res.huge.error).toMatch(/截断|过大/)
  })

  it('压缩的元数据解压后超过上限时报错而不是无限读取', () => {
    const big = Buffer.alloc(40 * 1024 * 1024, 0x61)
    const { deflateSync } = require('node:zlib') as typeof import('node:zlib')
    const parts = [makePng({}).subarray(0, 33), chunk('zTXt', Buffer.concat([Buffer.from('prompt\0\0', 'latin1'), deflateSync(big)])), chunk('IEND', Buffer.alloc(0))]
    expect(() => parsePngText(Buffer.concat(parts))).toThrow(/过大/)
  })
})

describe('从 ComfyUI 元数据中区分正向 / 负向 Prompt', () => {
  it('沿采样器 positive 连线读取，不混入负向和未连接的文本节点', () => {
    const r = extractPrompt({ prompt: JSON.stringify(comfyGraph('1girl, (smile:1.2)', 'lowres, worst quality')) })
    expect(r.status).toBe('ok')
    expect(r.source).toBe('comfy-api')
    expect(r.positive).toBe('1girl, (smile:1.2)')
    expect(r.negative).toBe('lowres, worst quality')
    expect(r.positive).not.toMatch(/unused|lowres/)
  })

  it('文本来自上游字符串节点、拼接节点与 ConditioningCombine', () => {
    const g: Record<string, any> = comfyGraph('')
    g['20'] = { class_type: 'PrimitiveStringMultiline', inputs: { value: 'masterpiece, 1girl' } }
    g['21'] = { class_type: 'StringConcatenate', inputs: { string_a: ['20', 0], string_b: 'smile', delimiter: ', ' } }
    g['6'].inputs.text = ['21', 0]
    g['22'] = { class_type: 'CLIPTextEncode', inputs: { text: 'bedroom', clip: ['4', 1] } }
    g['23'] = { class_type: 'ConditioningCombine', inputs: { conditioning_1: ['6', 0], conditioning_2: ['22', 0] } }
    g['3'].inputs.positive = ['23', 0]
    const r = promptFromApiGraph(g)
    expect(r.status).toBe('ok')
    expect(r.positive).toBe('masterpiece, 1girl, smile,\nbedroom')
    expect(r.notes.join()).toMatch(/拼接节点/)
  })

  it('ControlNet 等同时有正负输入的节点：按输出槽区分', () => {
    const g: Record<string, any> = comfyGraph('1girl, smile', 'lowres')
    g['30'] = { class_type: 'ControlNetApplyAdvanced', inputs: { positive: ['6', 0], negative: ['7', 0], control_net: ['31', 0], image: ['32', 0], strength: 1 } }
    g['3'].inputs.positive = ['30', 0]
    g['3'].inputs.negative = ['30', 1]
    const r = promptFromApiGraph(g)
    expect(r.positive).toBe('1girl, smile')
    expect(r.negative).toBe('lowres')
  })

  it('两阶段工作流：相同 Prompt 正常读取；不同 Prompt 采用第一阶段', () => {
    const g: Record<string, any> = comfyGraph('1girl, smile', 'lowres')
    g['40'] = { class_type: 'LatentUpscaleBy', inputs: { samples: ['3', 0], scale_by: 1.5 } }
    g['41'] = { class_type: 'KSampler', inputs: { ...g['3'].inputs, latent_image: ['40', 0], denoise: 0.5 } }
    expect(promptFromApiGraph(g)).toMatchObject({ status: 'ok', positive: '1girl, smile' })
    g['42'] = { class_type: 'CLIPTextEncode', inputs: { text: 'detail pass, sharp', clip: ['4', 1] } }
    g['41'].inputs.positive = ['42', 0]
    const r = promptFromApiGraph(g)
    expect(r.status).toBe('ok')
    expect(r.positive).toBe('1girl, smile')
    expect(r.notes.join()).toMatch(/第一阶段采样器 #3/)
  })

  it('同一文本节点同时连到正负两侧：标记为需要确认，不静默混入', () => {
    const g: Record<string, any> = comfyGraph('1girl, smile', 'lowres')
    g['3'].inputs.negative = ['6', 0]
    const r = promptFromApiGraph(g)
    expect(r.status).toBe('check')
    expect(r.notes.join()).toMatch(/同时连接到正向和负向/)
  })

  it('不支持的自定义节点报告原因', () => {
    const g: Record<string, any> = comfyGraph('x')
    g['50'] = { class_type: 'MysteryPromptLoader', inputs: { seed: 3 } }
    g['3'].inputs.positive = ['50', 0]
    const r = promptFromApiGraph(g)
    expect(r.status).toBe('error')
    expect(r.error).toMatch(/无法识别的节点 #50（MysteryPromptLoader）/)
  })

  it('只有界面格式 workflow 时也能读取原生节点', () => {
    const wf = {
      nodes: [
        { id: 4, type: 'CheckpointLoaderSimple', inputs: [], widgets_values: ['m.safetensors'] },
        { id: 5, type: 'EmptyLatentImage', inputs: [], widgets_values: [1024, 1024, 1] },
        { id: 6, type: 'CLIPTextEncode', inputs: [{ name: 'clip', link: 1 }], widgets_values: ['1girl, smile'] },
        { id: 7, type: 'CLIPTextEncode', inputs: [{ name: 'clip', link: 2 }], widgets_values: ['lowres'] },
        { id: 3, type: 'KSampler', inputs: [{ name: 'model', link: 3 }, { name: 'positive', link: 4 }, { name: 'negative', link: 5 }, { name: 'latent_image', link: 6 }], widgets_values: [1, 'fixed', 20, 7, 'euler', 'normal', 1] },
      ],
      links: [[1, 4, 1, 6, 0, 'CLIP'], [2, 4, 1, 7, 0, 'CLIP'], [3, 4, 0, 3, 0, 'MODEL'], [4, 6, 0, 3, 1, 'CONDITIONING'], [5, 7, 0, 3, 2, 'CONDITIONING'], [6, 5, 0, 3, 3, 'LATENT']],
    }
    const r = promptFromUiWorkflow(wf)
    expect(r).toMatchObject({ status: 'ok', positive: '1girl, smile', negative: 'lowres', source: 'comfy-workflow' })
    expect(extractPrompt({ workflow: JSON.stringify(wf) }).positive).toBe('1girl, smile')
  })

  it('WebUI parameters 与无效 JSON', () => {
    expect(promptFromParameters('1girl, smile,\nblush\nNegative prompt: lowres\nSteps: 20, Sampler: Euler')).toMatchObject({ positive: '1girl, smile,\nblush', negative: 'lowres' })
    expect(extractPrompt({ prompt: '{broken' }).error).toMatch(/不是有效的 JSON/)
  })
})

describe('标签解析与规范化', () => {
  it('最外层逗号切分，保留多词标签与括号内内容', () => {
    expect(splitTopLevel('cowgirl position, (straddling, sitting on lap:1.2), {red|blue} hair,\nblush，smile BREAK, BREAK')).toEqual(['cowgirl position', '(straddling, sitting on lap:1.2)', '{red|blue} hair', 'blush', 'smile BREAK'])
  })

  it('权重语法：(x:1.2)、((x))、[x]、转义括号、嵌套', () => {
    expect(stripWeight('(blush:1.2)')).toEqual({ core: 'blush', weight: 1.2 })
    expect(stripWeight('((smile))')).toEqual({ core: 'smile', weight: 1.21 })
    expect(stripWeight('[open mouth]')).toEqual({ core: 'open mouth', weight: 0.909 })
    expect(stripWeight('((cowgirl position:1.3))')).toEqual({ core: 'cowgirl position', weight: 1.43 })
    expect(stripWeight('[cat:dog:0.5]').core).toBe('[cat:dog:0.5]')
    expect(stripWeight('(a) (b)').core).toBe('(a) (b)')
    expect(parseToken('yorha no. 2 type b \\(cosplay\\)')!.key).toBe('yorha_no._2_type_b_(cosplay)')
    expect(parseToken('(yorha no. 2 type b \\(cosplay\\):1.1)')!.key).toBe('yorha_no._2_type_b_(cosplay)')
    expect(parseToken('<lora:MyChar_v2:0.8>')).toMatchObject({ key: '<lora:mychar_v2>', weight: 0.8 })
  })

  it('Danbooru 下划线与空格、大小写、首尾空格统一为同一比较键，原写法保留', () => {
    const keys = ['cowgirl position', 'cowgirl_position', '  Cowgirl  Position ', '(cowgirl_position:1.2)'].map((s) => parseToken(s)!)
    expect(new Set(keys.map((k) => k.key))).toEqual(new Set(['cowgirl_position']))
    expect(keys[3].raw).toBe('(cowgirl_position:1.2)')
  })

  it('单张图片内重复的标签只保留第一次', () => {
    const r = tokenizePrompt('blush, smile, (blush:1.3), Blush')
    expect(r.tokens.map((t) => t.raw)).toEqual(['blush', 'smile'])
    expect(r.dupes).toBe(2)
  })

  it('词典：CSV（tagcomplete 格式含别名）、TXT、JSON；别名只影响比较键', () => {
    const csv = parseDictionary('name,category,count,aliases\ncowgirl_position,0,1000,"cowgirl,girl_on_top"\nblush,0,5000,\n', 'csv')
    expect(csv.tags).toEqual(['cowgirl_position', 'blush'])
    expect(csv.aliases).toEqual([['cowgirl', 'cowgirl_position'], ['girl_on_top', 'cowgirl_position']])
    expect(parseDictionary('# comment\nopen mouth\nsmile,123\n', 'txt').tags).toEqual(['open_mouth', 'smile'])
    expect(parseDictionary('["a b", {"name":"c","aliases":["d"]}]', 'json')).toEqual({ tags: ['a_b', 'c'], aliases: [['d', 'c']] })
    const dict = buildDictionary(csv)!
    const t = parseToken('(girl on top:1.1)', dict)!
    expect(t).toMatchObject({ key: 'cowgirl_position', raw: '(girl on top:1.1)' })
  })

  it('签名与移除标签', () => {
    expect(promptSignature('Smile, (blush:1.2)')).toBe(promptSignature('blush, smile'))
    expect(removeTag('a, (b:1.2), c', 'b')).toBe('a, c')
  })
})

describe('重复组合挖掘', () => {
  const r = minePrompts(dataset())

  it('全局公共标签：按阈值识别，并从局部组合中排除', () => {
    expect(r.global.map((g) => g.key)).toEqual(['masterpiece', 'best_quality', '1girl'])
    expect(r.globalPrompt).toBe('masterpiece, best quality, 1girl')
    for (const c of r.candidates) expect(c.keys.some((k) => ['masterpiece', 'best_quality', '1girl'].includes(k))).toBe(false)
    // 阈值可调：降低到 40% 时 indoors / bedroom（各约 40%~50%）之一成为全局标签
    const low = minePrompts(dataset(), { globalRatio: 0.4 })
    expect(low.global.length).toBeGreaterThan(3)
    // 100% 一致才算时仍正确
    expect(minePrompts(dataset(), { globalRatio: 1 }).global.map((g) => g.key)).toEqual(['masterpiece', 'best_quality', '1girl'])
  })

  it('局部组合：找回人工预设的两个组合（完整、不混入场景 / 表情标签）', () => {
    const top = r.candidates.slice(0, 2)
    expect(top.map((c) => c.prompt)).toEqual([COWGIRL, MISSIONARY])
    expect(top.map((c) => c.support)).toEqual([8, 7])
    expect(top[0].images.every((id) => id.includes('cowgirl_'))).toBe(true)
    // 场景标签随机出现在大部分图片中，不应出现在任何顶层组合里
    for (const c of r.candidates) expect(c.keys.filter((k) => ['bedroom', 'indoors', 'outdoors'].includes(k))).toEqual([])
  })

  it('变化标签：列出组合内只在部分图片出现的标签及来源', () => {
    const cow = r.candidates[0]
    const v = Object.fromEntries(cow.variations.map((x) => [x.key, x.count]))
    expect(v.leaning_forward).toBe(4)
    expect(v.leaning_backward).toBe(4)
    expect(v.blush).toBe(4)
    expect(cow.variations.find((x) => x.key === 'leaning_forward')!.images.every((id) => id.includes('cowgirl_'))).toBe(true)
    expect(cow.variations.some((x) => x.key === 'masterpiece')).toBe(false)
  })

  it('去冗余：子集不重复列出；超组合嵌套为扩展组合；只出现过一次的标签不会被隐藏', () => {
    const tops = r.candidates.map((c) => c.id)
    expect(new Set(tops).size).toBe(tops.length)
    // 不存在「cowgirl position, straddling」这类同一批图片的子集
    expect(r.candidates.some((c) => c.keys.length === 2 && c.keys.includes('cowgirl_position'))).toBe(false)
    const ext = r.candidates[0].extensions.map((e) => e.keys)
    expect(ext.some((k) => k.includes('leaning_forward'))).toBe(true)
    for (const k of ext) for (const base of r.candidates[0].keys) expect(k).toContain(base)
    // standing 只在 3 张图出现、不构成组合，仍出现在完整标签表与未覆盖列表中
    expect(r.tags.find((t) => t.key === 'standing')!.count).toBe(3)
    expect(r.uncovered).toContain('standing')
    expect(r.tags.find((t) => t.key === 'closed_eyes')).toBeTruthy()
  })

  it('较短组合覆盖更多图片时，与较长组合都保留', () => {
    const imgs = [
      ...Array.from({ length: 10 }, (_, i) => ({ id: `a${i}`, positive: 'q, cowgirl position, straddling, sitting on lap' })),
      ...Array.from({ length: 10 }, (_, i) => ({ id: `b${i}`, positive: 'q, cowgirl position, straddling, hands on chest' })),
      ...Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, positive: `q, standing, x${i}` })),
    ]
    const m = minePrompts(imgs)
    const short = m.candidates.find((c) => c.keys.join() === 'cowgirl_position,straddling')!
    expect(short.support).toBe(20)
    expect(short.extensions.map((e) => [e.keys.join(), e.support])).toEqual([
      ['cowgirl_position,straddling,hands_on_chest', 10],
      ['cowgirl_position,straddling,sitting_on_lap', 10],
    ])
    // 同一批图片：只保留更完整的组合
    const same = minePrompts(imgs.slice(0, 10).concat(imgs.slice(20)))
    expect(same.candidates[0].keys).toEqual(['cowgirl_position', 'straddling', 'sitting_on_lap'])
    expect(same.candidates.some((c) => c.keys.join() === 'cowgirl_position,straddling')).toBe(false)
  })

  it('权重差异：识别为同一标签并记录不同写法；代表写法为最常见的写法', () => {
    const imgs = ['(blush:1.2), smile, x1', 'blush, smile, x2', 'blush, smile, x3', '(blush:1.2), smile, x4'].map((p, i) => ({ id: `i${i}`, positive: p }))
    const m = minePrompts(imgs, { globalRatio: 1.0, minSupport: 2 })
    const t = m.tags.find((x) => x.key === 'blush')!
    expect(t.count).toBe(4)
    expect(t.forms).toEqual([{ raw: '(blush:1.2)', weight: 1.2, count: 2 }, { raw: 'blush', weight: 1, count: 2 }])
    expect(t.raw).toBe('(blush:1.2)') // 次数相同时取最早出现的
  })

  it('同一图片内重复标签只计一次；完全相同的 Prompt 被识别', () => {
    const imgs = [
      { id: 'a', positive: 'blush, smile, blush, blush' },
      { id: 'b', positive: 'blush, smile' },
      { id: 'c', positive: 'blush, smile' },
      { id: 'd', positive: 'other' },
    ]
    const m = minePrompts(imgs, { globalRatio: 1 })
    expect(m.tags.find((t) => t.key === 'blush')!.count).toBe(3)
    expect(m.innerDupes).toBe(2)
    expect(m.duplicates).toEqual([['a', 'b', 'c']])
  })

  it('确定性：输入顺序变化、多次运行得到完全相同的结果', () => {
    const data = dataset()
    const a = minePrompts(data)
    const shuffled = [...data].sort((x, y) => (createHash('md5').update(x.id).digest('hex') < createHash('md5').update(y.id).digest('hex') ? -1 : 1))
    expect(shuffled.map((x) => x.id)).not.toEqual(data.map((x) => x.id))
    expect(minePrompts(shuffled)).toEqual(a)
    expect(minePrompts(data)).toEqual(a)
  })

  it('大量高频标签时不会组合爆炸（有上限、快速完成）', () => {
    // 120 张图，每张 40 个从 60 个标签中随机选的标签（固定种子）
    let seed = 7
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
    const imgs = Array.from({ length: 120 }, (_, i) => {
      const tags = Array.from({ length: 60 }, (_, j) => `tag${j}`).filter(() => rand() < 0.66)
      return { id: `img${String(i).padStart(3, '0')}`, positive: tags.join(', ') }
    })
    const t0 = Date.now()
    const m = minePrompts(imgs, { globalRatio: 0.95 })
    expect(Date.now() - t0).toBeLessThan(15000)
    expect(m.candidates.length).toBeLessThanOrEqual(DEFAULT_MINING.maxCandidates)
    expect(m.stats.closedSets).toBeLessThanOrEqual(20000)
  })
})

describe('扫描、取消与保存到 Vault', () => {
  function vault() {
    const root = join(tmp(), 'vault')
    createVault(root)
    return { root, store: openVault(root) }
  }

  it('扫描文件夹（可递归），失败图片单独报告，原图片不变', async () => {
    const dir = tmp()
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'b.png'), makePng({ prompt: JSON.stringify(comfyGraph('1girl, smile')) }))
    writeFileSync(join(dir, 'a.png'), makePng({}))
    writeFileSync(join(dir, 'sub', 'c.png'), makePng({ prompt: JSON.stringify(comfyGraph('1girl, blush')) }))
    writeFileSync(join(dir, 'note.txt'), 'x')
    const before = ['a.png', 'b.png', 'sub/c.png'].map((f) => [hashFile(join(dir, f)), statSync(join(dir, f)).mtimeMs])
    const s = new MiningScanner()
    const progress: number[] = []
    const flat = await s.scan([], [dir], false, (d) => progress.push(d))
    expect(flat.images.map((i) => i.name)).toEqual(['a.png', 'b.png'])
    expect(flat.images.map((i) => i.status)).toEqual(['error', 'ok'])
    const deep = await s.scan([], [dir], true, () => {})
    expect(deep.images.map((i) => i.name)).toEqual(['a.png', 'b.png', 'c.png'])
    expect(deep.images[2].positive).toBe('1girl, blush')
    expect(progress.at(-1)).toBe(2)
    const after = ['a.png', 'b.png', 'sub/c.png'].map((f) => [hashFile(join(dir, f)), statSync(join(dir, f)).mtimeMs])
    expect(after).toEqual(before)
    expect(s.allowed.has(join(dir, 'b.png'))).toBe(true)
  })

  it('扫描可以取消', async () => {
    const dir = tmp()
    for (let i = 0; i < 30; i++) writeFileSync(join(dir, `${i}.png`), makePng({ prompt: JSON.stringify(comfyGraph(`t${i}`)) }))
    const s = new MiningScanner()
    const job = s.scan([], [dir], false, () => {})
    s.cancel()
    const r = await job
    expect(r.cancelled).toBe(true)
    expect(r.images.length).toBeLessThan(30)
  })

  it('保存为现有 Markdown 素材格式；与已有素材重复时跳过；不修改已有素材', () => {
    const { root, store } = vault()
    const existing = store.save('templates', { kind: 'expression', name: '微笑', positive: 'smile, blush' })
    const existingFile = readdirSync(join(root, 'prompts', 'expressions')).find((f) => f.startsWith('微笑'))!
    const existingHash = hashFile(join(root, 'prompts', 'expressions', existingFile))
    const pos = store.save('templates', { kind: 'position', name: '骑乘位', positive: 'cowgirl position' })
    const out = saveMined(store, [
      { name: '提取组合 001', positive: '(cowgirl position:1.2), straddling, sitting on lap', kind: 'pose' },
      { name: '提取组合 002', positive: '(blush:1.1), Smile', kind: 'expression' },
      { name: '提取组合 003', positive: 'cowgirl_position, straddling, sitting_on_lap', kind: 'act' },
      { name: '子体位', positive: 'leaning forward, hands on chest', kind: 'subposition', parent_id: pos },
      { name: '无主体位', positive: 'leaning back', kind: 'subposition' },
      { name: '空', positive: ' , ', kind: 'pose' },
    ])
    expect(out.map((o) => o.status)).toEqual(['saved', 'duplicate', 'duplicate', 'saved', 'error', 'error'])
    expect(out[1].message).toMatch(/微笑（表情）/)
    expect(out[2].message).toMatch(/提取组合 001（单人动作）/)
    const files = readdirSync(join(root, 'prompts', 'poses'))
    expect(files).toContain('提取组合 001.md')
    const row = decode(readFileSync(join(root, 'prompts', 'poses', '提取组合 001.md'), 'utf8'))
    expect(row).toMatchObject({ type: 'templates', kind: 'pose', name: '提取组合 001', positive: '(cowgirl position:1.2), straddling, sitting on lap', negative: '' })
    expect(Number.isSafeInteger(row.id)).toBe(true)
    const sub = store.list('templates').find((t) => t.name === '子体位')!
    expect(sub).toMatchObject({ kind: 'subposition', parent_id: pos })
    expect(hashFile(join(root, 'prompts', 'expressions', existingFile))).toBe(existingHash)
    expect(store.get('templates', existing)!.positive).toBe('smile, blush')
    // 重新打开工作区后仍能读取（与现有 Vault 扫描规则兼容）
    store.close()
    const again = openVault(root)
    expect(again.list('templates').filter((t) => t.name.startsWith('提取组合')).length).toBe(1)
    again.close()
  })

  it('导入失败（无效文件）不影响已有词典与素材；词典导入与信息', () => {
    const dir = tmp()
    const file = join(dir, 'data', 'tag-dictionary.json')
    writeFileSync(join(dir, 'tags.csv'), 'cowgirl_position,0,10,"cowgirl"\nblush,0,5,\n')
    expect(importDictionary(join(dir, 'tags.csv'), file)).toMatchObject({ tags: 2, aliases: 1, source: 'tags.csv' })
    const before = readFileSync(file, 'utf8')
    writeFileSync(join(dir, 'bad.json'), '{oops')
    expect(() => importDictionary(join(dir, 'bad.json'), file)).toThrow()
    writeFileSync(join(dir, 'empty.txt'), '# nothing\n')
    expect(() => importDictionary(join(dir, 'empty.txt'), file)).toThrow(/没有读到标签/)
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(dictionaryInfo(file)!.tags).toBe(2)
  })

  it('端到端：PNG → 读取 Prompt → 挖掘 → 找回预设组合', async () => {
    const dir = tmp()
    for (const im of dataset()) writeFileSync(join(dir, im.id.replace(/^.*\//, '')), makePng({ prompt: JSON.stringify(comfyGraph(im.positive)) }))
    copyFileSync(join(dir, 'solo_0.png'), join(dir, 'solo_0 copy.png'))
    const scan = await new MiningScanner().scan([], [dir], false, () => {})
    expect(scan.images.every((i) => i.status === 'ok')).toBe(true)
    const m = minePrompts(scan.images.map((i) => ({ id: i.id, positive: i.positive })))
    expect(m.candidates.slice(0, 2).map((c) => c.prompt)).toEqual([COWGIRL, MISSIONARY])
    expect(m.duplicates).toEqual([[join(dir, 'solo_0 copy.png'), join(dir, 'solo_0.png')]])
  })
})
