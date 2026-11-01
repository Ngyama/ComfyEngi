// 套图复刻：Tag 统计与替换、参数恢复、每张图的计划、草稿、入队快照与输出。全部使用模拟 ComfyUI，不能代替真实环境验证。

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyInputs, LM_TRIGGER_TOGGLE, newEntry, TRIGGER_DISABLE } from '@shared/mapping'
import { applyTagReplacement, mergeNegative, normalizeReplicaData, normalizeReplicaImage, outputStems, recoverParams, tagStats, type ReplicaData, type ReplicaImage } from '@shared/replica'
import { nodeCategory, problemNodes } from '@shared/node-controls'
import { defaultLoraConfig } from '@shared/lora-config'
import { changeLines } from '@shared/workflow-analysis'
import type { ApiWorkflow, InputChange, MappingEntry } from '@shared/types'
import { MiningScanner, scanImage } from '../src/main/mining'
import { enqueueReplica, finalReplicaWorkflow, imageFromScan, planForReplica, relocateImages, workflowPreview } from '../src/main/replica'
import { Runner, sha256 } from '../src/main/runner'
import type { Store } from '../src/main/store'
import { createVault, openVault } from '../src/main/vault'
import { SAMPLE_MAPPING, SAMPLE_WORKFLOW, tempDir, waitUntil } from './helpers'
import { makePng } from './mining-fixtures'
import { MockComfy } from './mock-comfy'

describe('Tag 替换', () => {
  const replace = (t: string, keys: string[], ins = '') => applyTagReplacement(t, keys, ins)

  it('带权重的 Tag 按规范名匹配，只移除完整表达式，其余逐字节保留', () => {
    const src = '(masterpiece:1.2),  (blue hair:1.2), ((smile)),\nBREAK\n[from side], blue_eyes, artist \\(x\\)'
    const r = replace(src, ['blue_hair'])
    expect(r.text).toBe('(masterpiece:1.2), ((smile)),\nBREAK\n[from side], blue_eyes, artist \\(x\\)')
    expect(r.status).toBe('ok')
    expect(r.removed).toEqual(['(blue hair:1.2)'])
  })

  it('所有写法都能匹配：下划线、空格、大小写、括号、全部重复项', () => {
    const r = replace('Blue_Hair, smile, (blue hair), ((BLUE HAIR:0.8)), [blue hair], long hair', ['blue_hair'])
    expect(r.text).toBe('smile, long hair')
  })

  it('没有选中的 Tag 不重排、不去重、不改权重', () => {
    const src = 'b, a, b, (a:1.3), c'
    expect(replace(src, ['zzz']).text).toBe(src)
    expect(replace(src, ['c']).text).toBe('b, a, b, (a:1.3)')
    expect(replace('x, b, a, b, (a:1.3)', ['x']).text).toBe('b, a, b, (a:1.3)')
  })

  it('角色 Prompt 作为整体放在第一个选中 Tag 的位置；这张图没有选中 Tag 时放在最前面', () => {
    expect(replace('1girl, red hair, smile, blue eyes, park', ['red_hair', 'blue_eyes'], 'char_b, (pink hair:1.1)').text).toBe('1girl, char_b, (pink hair:1.1), smile, park')
    expect(replace('smile, park', ['red_hair'], 'char_b').text).toBe('char_b, smile, park')
    expect(replace('', ['red_hair'], 'char_b').text).toBe('char_b')
    expect(replace('red hair', ['red_hair'], '').text).toBe('')
  })

  it('括号不配对的 Prompt 不自动修改，要求手动编辑', () => {
    for (const bad of ['(a, b', 'a), b', '(a]', '[a, (b]']) {
      const r = replace(bad, ['a'], 'x')
      expect(r.status).toBe('unsafe')
      expect(r.text).toBe(bad)
    }
    expect(replace('a \\( b, c', ['c']).status).toBe('ok')
  })

  it('选中的 Tag 在组合权重里时不拆组合，要求手动处理', () => {
    const r = replace('(blue hair, long hair:1.2), smile', ['blue_hair'], 'x')
    expect(r.status).toBe('group')
    expect(r.text).toContain('(blue hair, long hair:1.2)')
    expect(r.grouped).toEqual(['blue_hair'])
    // 组合中的 Tag 自己带权重也能识别
    expect(replace('(blue hair:1.2, long hair), smile', ['blue_hair']).status).toBe('group')
    // 没选中组合里的内容时不受影响
    expect(replace('(blue hair, long hair:1.2), smile', ['smile']).text).toBe('(blue hair, long hair:1.2)')
  })

  it('全角逗号与换行作为分隔符保留', () => {
    expect(replace('a，b\nc', ['b']).text).toBe('a\nc')
  })

  it('显示用的片段能还原结果', () => {
    const r = replace('1girl, red hair, smile', ['red_hair'], 'char_b')
    expect(r.parts.filter((p) => p.kind !== 'remove').map((p) => p.text).join('')).toBe(r.text)
    expect(r.parts.find((p) => p.kind === 'remove')?.text).toBe('red hair')
    expect(r.parts.find((p) => p.kind === 'add')?.text).toBe('char_b')
  })

  it('负面合并：默认保留原图并追加', () => {
    expect(mergeNegative('lowres, ', 'bad hands', 'append')).toBe('lowres, bad hands')
    expect(mergeNegative('', 'bad hands', 'append')).toBe('bad hands')
    expect(mergeNegative('lowres', '', 'append')).toBe('lowres')
    expect(mergeNegative('lowres', 'x', 'keep')).toBe('lowres')
    expect(mergeNegative('lowres', 'x', 'replace')).toBe('x')
  })
})

describe('Tag 统计', () => {
  it('统计次数、比例、写法、权重与来源图片；同一张图重复只算一次', () => {
    const tags = tagStats([{ positive: 'a, (b:1.2), a' }, { positive: 'B, c' }, { positive: 'c, (a, d:1.1)' }, { positive: '' }])
    const a = tags.find((t) => t.key === 'a')!
    expect(a.count).toBe(2)
    expect(a.ratio).toBe(0.5)
    expect(a.images).toEqual([0, 2])
    expect(a.grouped).toBe(1)
    const b = tags.find((t) => t.key === 'b')!
    expect(b.forms.map((f) => [f.raw, f.weight, f.count])).toEqual(expect.arrayContaining([['(b:1.2)', 1.2, 1], ['B', 1, 1]]))
    expect(tags[0].count).toBeGreaterThanOrEqual(tags.at(-1)!.count)
    // 高频 Tag 不会被自动选中或分类：这里只有统计
    expect(Object.keys(a).sort()).toEqual(['count', 'forms', 'grouped', 'images', 'key', 'ratio', 'raw'])
  })
})

const apiGraph = (over: { seed?: unknown; steps?: number; second?: boolean; width?: number; sampler2?: boolean } = {}) => ({
  '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'm.safetensors' } },
  '2': { class_type: 'CLIPTextEncode', inputs: { text: 'POS', clip: ['1', 1] } },
  '3': { class_type: 'CLIPTextEncode', inputs: { text: 'NEG', clip: ['1', 1] } },
  '4': { class_type: 'EmptyLatentImage', inputs: { width: over.width ?? 832, height: 1216, batch_size: 1 } },
  '5': { class_type: 'KSampler', inputs: { seed: over.seed ?? 111, steps: over.steps ?? 20, cfg: 6.5, sampler_name: 'euler', scheduler: 'karras', denoise: 1, model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0] } },
  ...(over.second ? { '6': { class_type: 'KSampler', inputs: { seed: 999, steps: 8, cfg: 3, sampler_name: 'dpmpp_2m', scheduler: 'normal', denoise: 0.4, model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['5', 0] } } } : {}),
  ...(over.sampler2 ? { '7': { class_type: 'KSampler', inputs: { seed: 222, steps: 30, cfg: 6.5, sampler_name: 'euler', scheduler: 'karras', denoise: 1, model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0] } } } : {}),
})

describe('参数恢复', () => {
  it('ComfyUI：可靠读取第一次采样；二次采样不冒充', () => {
    const p = recoverParams({ prompt: JSON.stringify(apiGraph({ second: true })) }, 'comfy-api')
    expect(p.seed).toMatchObject({ value: 111, state: 'ok' })
    expect(p.steps).toMatchObject({ value: 20, state: 'ok' })
    expect(p.cfg?.value).toBe(6.5)
    expect(p.sampler?.value).toBe('euler')
    expect(p.denoise?.value).toBe(1)
    expect(p.width).toMatchObject({ value: 832, state: 'ok' })
    expect(p.steps?.note).toContain('后续采样')
  })

  it('ComfyUI：多个第一次采样器的值不同时需要确认', () => {
    const p = recoverParams({ prompt: JSON.stringify(apiGraph({ sampler2: true })) }, 'comfy-api')
    expect(p.seed?.state).toBe('confirm')
    expect(p.steps?.state).toBe('confirm')
    expect(p.cfg?.state).toBe('ok')
  })

  it('A1111：数字可靠；采样器名称需要确认；高清修复的重绘幅度不算', () => {
    const text = 'a, b\nNegative prompt: c\nSteps: 28, Sampler: DPM++ 2M Karras, CFG scale: 7, Seed: 12345, Size: 512x768, Denoising strength: 0.4, Hires upscale: 2, Model: "x, y"'
    const p = recoverParams({ parameters: text }, 'a1111')
    expect(p.seed).toMatchObject({ value: 12345, state: 'ok' })
    expect(p.width?.value).toBe(512)
    expect(p.height?.value).toBe(768)
    expect(p.steps?.value).toBe(28)
    expect(p.cfg?.value).toBe(7)
    expect(p.sampler).toMatchObject({ value: 'dpmpp_2m', state: 'confirm' })
    expect(p.scheduler).toMatchObject({ value: 'karras', state: 'confirm' })
    expect(p.denoise?.state).toBe('missing')
  })

  it('不认识的采样器名称算缺失；超范围的 Seed 不写入错误的值', () => {
    const p = recoverParams({ parameters: 'a\nSteps: 20, Sampler: Weird, Seed: 18446744073709551615, Size: 512x512' }, 'a1111')
    expect(p.sampler?.state).toBe('missing')
    expect(p.seed?.state).toBe('missing')
    expect(p.seed?.note).toContain('精确')
  })

  it('其他软件的 JSON 与缺失元数据', () => {
    expect(recoverParams({ Comment: JSON.stringify({ prompt: 'x', steps: 28, scale: 5, seed: 7, width: 640, height: 960, sampler: 'k_euler' }) }, 'novelai')).toMatchObject({ seed: { value: 7, state: 'ok' }, cfg: { value: 5 }, width: { value: 640 }, sampler: { state: 'confirm' } })
    expect(recoverParams({ invokeai_metadata: JSON.stringify({ seed: 9, steps: 30, cfg_scale: 4, width: 512, height: 512, scheduler: 'euler' }) }, 'invokeai').sampler?.value).toBe('euler')
    const none = recoverParams({}, null, { width: 1024, height: 1024 })
    expect(none.seed?.state).toBe('missing')
    expect(none.width).toMatchObject({ value: 1024, state: 'confirm' })
  })
})

describe('输出文件名', () => {
  it('与原图相同，不同文件夹中同名的加序号，去掉非法字符', () => {
    expect(outputStems([{ name: '001.png' }, { name: '002.jpg' }, { name: '001.webp' }, { name: 'a:b.png' }])).toEqual(['001', '002', '001 (2)', 'a_b'])
  })
})

describe('计划与执行', () => {
  let root: string
  let s: Store
  let srcDir: string
  let mock: MockComfy
  let comfyOut: string
  let runner: Runner | null
  let wfId: number
  let charId: number
  let outfitId: number

  const png = (name: string, texts: Record<string, string>) => {
    const p = join(srcDir, name)
    writeFileSync(p, makePng(texts))
    return p
  }
  const comfyMeta = (pos: string, neg: string, seed: number, width: number) => {
    const g = apiGraph({ seed, width }) as unknown as ApiWorkflow
    g['2'].inputs.text = pos
    g['3'].inputs.text = neg
    return { prompt: JSON.stringify(g) }
  }
  const importAll = async (): Promise<ReplicaImage[]> => {
    const scanner = new MiningScanner()
    const r = await scanner.scan([], [srcDir], false, () => {})
    return r.images.map((im) => imageFromScan(im))
  }
  const replacedCfg = () => {
    const cfg = defaultLoraConfig(SAMPLE_WORKFLOW, s.get('workflows', wfId)!.mapping)
    return { ...cfg, char_targets: { lora1: { node: '10', replace: cfg.entries[0].key } } }
  }
  const draft = (images: ReplicaImage[], over: Partial<ReplicaData> = {}) => {
    const data = normalizeReplicaData({ images, removed_tags: ['red_hair', 'char_a'], character_id: charId, workflow_id: wfId, output: { dir: join(root, 'out-replica') }, ...over })
    const id = s.save('replicas', { name: '测试', data })
    return s.get('replicas', id)!
  }

  beforeEach(async () => {
    comfyOut = tempDir()
    mock = new MockComfy(0.005, comfyOut)
    await mock.serve(0)
    root = tempDir()
    createVault(root)
    s = openVault(root)
    s.setSetting('comfy_url', mock.url)
    srcDir = tempDir()
    runner = null
    const mapping: MappingEntry[] = [...SAMPLE_MAPPING.filter((m) => !m.source.startsWith('lora1')), { source: 'width', node: '5', input: 'width', modules: [], template: '' }, { source: 'height', node: '5', input: 'height', modules: [], template: '' }]
    wfId = s.save('workflows', { name: '测试工作流', api_json: SAMPLE_WORKFLOW, mapping })
    charId = s.save('characters', { name: '角色B', tag: 'b', positive: 'char_b, (pink hair:1.1)', negative: 'bad hands', loras: [{ name: 'charB.safetensors', strength: 0.8 }] })
    outfitId = s.save('outfits', { character_id: charId, name: '校服', positive: 'school uniform' })
    png('001.png', comfyMeta('1girl, red hair, char_a, (smile:1.2), park', 'lowres', 111, 832))
    png('002.png', comfyMeta('1girl, (Red_Hair:1.1), char_a, sitting, beach', 'blurry', 222, 1024))
    png('003.png', { parameters: '1girl, red hair, running\nNegative prompt: worst\nSteps: 33, Sampler: Euler a, CFG scale: 4, Seed: 333, Size: 640x960' })
    png('004.png', {})
  })
  afterEach(async () => {
    runner?.stop()
    await runner?.join()
    await mock.shutdown()
    s.close()
  })

  it('批量导入：按文件名排序；读取失败不影响其他图片；可靠结果与失败分开', async () => {
    const images = await importAll()
    expect(images.map((im) => im.name)).toEqual(['001.png', '002.png', '003.png', '004.png'])
    expect(images.map((im) => im.status)).toEqual(['ok', 'ok', 'ok', 'error'])
    expect(images[0].params.seed?.value).toBe(111)
    expect(images[2].params.steps?.value).toBe(33)
  })

  it('每张图有不同的 Prompt、Negative、Seed、尺寸；没有元数据的图不生成也不会被静默丢弃', async () => {
    const plan = planForReplica(s, draft(await importAll(), { outfit_id: outfitId, lora_config: replacedCfg() }))
    expect(plan.errors).toEqual([])
    expect(plan.units).toHaveLength(3)
    const [a, b, c] = plan.units
    expect(a.positive).toBe('1girl, char_b, (pink hair:1.1), school uniform, (smile:1.2), park')
    expect(b.positive).toBe('1girl, char_b, (pink hair:1.1), school uniform, sitting, beach')
    expect(c.positive).toBe('1girl, char_b, (pink hair:1.1), school uniform, running')
    expect(a.negative).toBe('lowres, bad hands')
    expect(b.negative).toBe('blurry, bad hands')
    expect([a.seed, b.seed, c.seed]).toEqual([111, 222, 333])
    expect([a.width, b.width, c.width]).toEqual([832, 1024, 640])
    expect(plan.rows[3]).toMatchObject({ name: '004.png', state: 'invalid' })
    expect(plan.warnings.join()).toContain('1 张')
    const inp = (u: typeof a, node: string, input: string) => u.inputs!.find((x) => x.node === node && x.input === input)?.value
    expect(inp(a, '3', 'seed')).toBe(111)
    expect(inp(b, '5', 'width')).toBe(1024)
    expect(inp(c, '3', 'steps')).toBe(33)
    expect(inp(c, '3', 'cfg')).toBe(4)
    expect(inp(a, '6', 'text')).toBe(a.positive)
    expect(inp(a, '7', 'text')).toBe(a.negative)
  })

  it('保留原始参数只承诺读取到并且能写入的：需要确认的值默认不写，接受后才写', async () => {
    const images = await importAll()
    const lora_config = replacedCfg()
    const plan = planForReplica(s, draft(images, { lora_config }))
    const row = plan.rows[2]
    expect(row.params.find((p) => p.key === 'sampler')).toMatchObject({ value: 'euler_ancestral', state: 'confirm', applied: false })
    expect(row.params.find((p) => p.key === 'steps')?.applied).toBe(true)
    expect(plan.units[2].inputs!.some((x) => x.input === 'sampler_name')).toBe(false)
    const accepted = planForReplica(s, draft(images, { accept_uncertain: true, lora_config }))
    expect(accepted.units[2].inputs!.find((x) => x.input === 'sampler_name')?.value).toBe('euler_ancestral')
    const off = planForReplica(s, draft(images, { keep: { seed: false, size: false, sampling: false }, lora_config }))
    expect(off.units[0].seed).not.toBe(111)
    expect(off.units[0].width).toBeUndefined()
    expect(off.units[0].inputs!.some((x) => x.source === 'replica_param')).toBe(false)
    // 第二次计划得到相同的 Seed（预览与入队一致）
    expect(planForReplica(s, draft(images, { keep: { seed: false, size: false, sampling: false }, lora_config })).units[0].seed).toBe(off.units[0].seed)
  })

  it('缺失 Seed 不阻止生成；不支持映射的参数明确标记', async () => {
    const images = await importAll()
    images[0] = { ...images[0], params: { ...images[0].params, seed: { value: null, state: 'missing' } } }
    const noSeedMap = s.save('workflows', { name: '无映射', api_json: SAMPLE_WORKFLOW, mapping: SAMPLE_MAPPING.filter((m) => !m.source.startsWith('lora1') && m.source !== 'seed') })
    const plan = planForReplica(s, draft(images))
    expect(plan.rows[0]).toMatchObject({ state: 'valid', seed_generated: true })
    const p2 = planForReplica(s, draft(images, { workflow_id: noSeedMap }))
    expect(p2.rows[1].params.find((p) => p.key === 'seed')).toMatchObject({ state: 'unmapped', applied: false })
    expect(p2.rows[1].params.find((p) => p.key === 'width')).toMatchObject({ state: 'unmapped', applied: false })
  })

  it('已被节点覆盖或映射的输入不写原图参数', async () => {
    const wf = s.get('workflows', wfId)!
    s.save('workflows', { id: wfId, controls: { overrides: [{ node: '3', input: 'steps', class_type: 'KSampler', value: 12 }], bypass: [] } })
    const plan = planForReplica(s, draft(await importAll(), { lora_config: replacedCfg() }))
    expect(plan.errors).toEqual([])
    expect(plan.rows[2].params.find((p) => p.key === 'steps')?.state).toBe('unmapped')
    expect(plan.units[2].inputs!.filter((x) => x.input === 'steps').map((x) => x.value)).toEqual([12])
    expect(wf.api_json['3'].inputs.steps).toBe(28)
  })

  it('需确认、括号不配对、组合权重的图片不会自动提交，手动编辑或确认后才进入计划', async () => {
    const images = await importAll()
    images[0] = { ...images[0], status: 'check', notes: ['不确定'] }
    images[1] = { ...images[1], positive: '1girl, (red hair, sitting' }
    images[2] = { ...images[2], positive: '(red hair, long hair:1.2), running' }
    const plan = planForReplica(s, draft(images))
    expect(plan.rows.map((r) => r.state)).toEqual(['confirm', 'confirm', 'confirm', 'invalid'])
    expect(plan.units).toHaveLength(0)
    const fixed = [{ ...images[0], confirmed: true }, { ...images[1], manual_positive: '手动内容' }, images[2], images[3]]
    const p2 = planForReplica(s, draft(fixed))
    expect(p2.rows.map((r) => r.state)).toEqual(['valid', 'valid', 'confirm', 'invalid'])
    expect(p2.units[1].positive).toBe('手动内容')
  })

  it('Prompt 映射按模块拆分的工作流不能用于复刻（不会提交空 Prompt）', async () => {
    const id = s.save('workflows', { name: '模块', api_json: SAMPLE_WORKFLOW, mapping: SAMPLE_MAPPING.map((m) => (m.source === 'positive' ? { ...m, modules: ['character'] } : m)).filter((m) => !m.source.startsWith('lora1')) })
    expect(planForReplica(s, draft(await importAll(), { workflow_id: id })).errors.join()).toContain('按模块拆分')
  })

  it('LoRA：默认保留工作流 LoRA 并提示；可以替换指定的旧 LoRA；可以关闭不相关的', async () => {
    const images = await importAll()
    const cfg = defaultLoraConfig(SAMPLE_WORKFLOW, s.get('workflows', wfId)!.mapping)
    expect(cfg.entries[0].name).toBe('charA.safetensors')
    const noTarget = planForReplica(s, draft(images))
    expect(noTarget.errors.join()).toMatch(/LoRA/)
    const replaced = planForReplica(s, draft(images, { lora_config: { ...cfg, char_targets: { lora1: { node: '10', replace: cfg.entries[0].key } } } }))
    expect(replaced.errors).toEqual([])
    const json = applyInputs(SAMPLE_WORKFLOW, replaced.units[0].inputs!)
    expect(json['10'].inputs.lora_name).toBe('charB.safetensors')
    expect(json['10'].inputs.strength_model).toBe(0.8)
    const stronger = planForReplica(s, draft(images, { lora: { enabled: true, name: null, resource_id: null, strength: 0.5 }, lora_config: { ...cfg, char_targets: { lora1: { node: '10', replace: cfg.entries[0].key } } } }))
    expect(applyInputs(SAMPLE_WORKFLOW, stronger.units[0].inputs!)['10'].inputs.strength_model).toBe(0.5)
    const off = planForReplica(s, draft(images, { lora: { enabled: false, name: null, resource_id: null, strength: null }, lora_config: { ...cfg, entries: cfg.entries.map((e) => ({ ...e, enabled: false })) } }))
    expect(off.errors).toEqual([])
    expect(applyInputs(SAMPLE_WORKFLOW, off.units[0].inputs!)['10'].inputs.strength_model).toBe(0)
    const kept = planForReplica(s, draft(images, { lora: { enabled: false, name: null, resource_id: null, strength: null } }))
    expect(applyInputs(SAMPLE_WORKFLOW, kept.units[0].inputs!)['10'].inputs.lora_name).toBe('charA.safetensors')
  })

  it('TriggerWord Toggle：默认用 trigger_disable 关闭注入，节点不被绕过；可以选择保留', async () => {
    const api: ApiWorkflow = {
      ...SAMPLE_WORKFLOW,
      '6': { class_type: 'CLIPTextEncode', inputs: { text: ['31', 0], clip: ['10', 1] } },
      '30': { class_type: 'PrimitiveString', inputs: { value: '原' } },
      '31': { class_type: 'StringConcatenate', inputs: { string_a: ['34', 0], string_b: ['30', 0], delimiter: ',' } },
      '34': { class_type: LM_TRIGGER_TOGGLE, inputs: { group_mode: true, default_active: true, allow_strength_adjustment: false, orinalMessage: 'w1,, w2', toggle_trigger_words: { __value__: [{ text: 'w1', active: true }, { text: 'w2', active: true }] }, trigger_words: ['10', 2] } },
    }
    const mapping = SAMPLE_MAPPING.filter((m) => !m.source.startsWith('lora1')).map((m) => (m.source === 'positive' ? { ...m, node: '30', input: 'value' } : m))
    const id = s.save('workflows', { name: 'trig', api_json: api, mapping })
    const images = await importAll()
    const cfg = defaultLoraConfig(api, mapping)
    const lora_config = { ...cfg, char_targets: { lora1: { node: '10', replace: cfg.entries[0].key } } }
    const plan = planForReplica(s, draft(images, { workflow_id: id, lora_config }))
    expect(plan.errors).toEqual([])
    expect(plan.workflow!.mapping.some((m) => m.source === TRIGGER_DISABLE && m.node === '34')).toBe(true)
    const json = applyInputs(api, plan.units[0].inputs!)
    expect(json['34']).toBeTruthy()
    expect((json['34'].inputs.toggle_trigger_words as { __value__: { active: boolean }[] }).__value__.every((g) => !g.active)).toBe(true)
    expect(s.get('workflows', id)!.mapping.some((m) => m.source === TRIGGER_DISABLE)).toBe(false)
    const keep = planForReplica(s, draft(images, { workflow_id: id, lora_config, disable_triggers: false }))
    expect(keep.workflow!.mapping.some((m) => m.source === TRIGGER_DISABLE)).toBe(false)
    expect(keep.warnings.join()).toMatch(/触发词|TriggerWord/)
  })

  it('草稿保存与重新打开；图片丢失时列出，可以重新定位，不会静默移除', async () => {
    const images = await importAll()
    const rec = draft(images, { outfit_id: outfitId, negative_mode: 'keep' })
    const again = s.get('replicas', rec.id!)!
    const d = normalizeReplicaData(again.data)
    expect(d.images).toHaveLength(4)
    expect(d.removed_tags).toEqual(['red_hair', 'char_a'])
    expect(d.outfit_id).toBe(outfitId)
    expect(d.negative_mode).toBe('keep')
    expect(d.images[0].params.seed?.value).toBe(111)
    // 移动一张图
    const moved = tempDir()
    renameSync(join(srcDir, '001.png'), join(moved, '001.png'))
    const plan = planForReplica(s, again)
    expect(plan.rows[0]).toMatchObject({ state: 'missing', name: '001.png' })
    expect(plan.rows).toHaveLength(4)
    const res = await relocateImages(d, moved)
    expect(res.relocated).toBe(1)
    expect(res.images[0].path).toBe(join(moved, '001.png'))
    expect(res.images[0].positive).toBe(d.images[0].positive)
    // 同名但内容不同的图片不替换
    writeFileSync(join(moved, '002.png'), makePng(comfyMeta('别的内容', '', 1, 512)))
    renameSync(join(srcDir, '002.png'), join(tempDir(), '002.png'))
    const res2 = await relocateImages(d, moved)
    expect(res2.mismatched).toContain('002.png')
  })

  it('输出目录不能是原图所在的文件夹', async () => {
    expect(planForReplica(s, draft(await importAll(), { output: { dir: srcDir } })).errors.join()).toContain('原图所在')
  })

  it('入队后冻结；提交的 JSON 与预览相同；输出与原图对应；原图没有改动；重试不混淆', async () => {
    const images = await importAll()
    const originals = new Map(readdirSync(srcDir).map((f) => [f, sha256(readFileSync(join(srcDir, f)))]))
    const rec = draft(images, { lora_config: replacedCfg() })
    const previews = [0, 1, 2].map((i) => finalReplicaWorkflow(s, rec, i).json)
    const { runId, plan } = enqueueReplica(s, rec)
    expect(plan.errors).toEqual([])
    // 入队后修改草稿不影响已入队内容
    s.save('replicas', { id: rec.id, data: { ...normalizeReplicaData(rec.data), removed_tags: [], character_id: null } })
    const units = s.listUnits(runId!)
    expect(units.map((u) => u.positive)).toEqual(plan.units.map((u) => u.positive))
    runner = new Runner(s, { eventsFactory: null })
    runner.start()
    expect(await waitUntil(() => (s.runCounts(runId!).done ?? 0) === 3, 10000)).toBe(true)
    runner.stop()
    await runner.join()
    runner = null
    const done = s.listUnits(runId!)
    expect(mock.submitted.map(([, g]) => g)).toEqual(previews)
    done.forEach((u, i) => {
      const snap = s.attemptBody(s.attempts(u.id)[0].id)!
      expect(snap.intact).toBe(true)
      expect(JSON.parse(snap.body).prompt).toEqual(previews[i])
    })
    const saved = readdirSync(join(root, 'out-replica')).sort()
    expect(saved).toEqual(['001.png', '002.png', '003.png'])
    expect(done.map((u) => basename(u.outputs.find((o) => o.saved)!.saved!))).toEqual(saved)
    expect(done.map((u) => u.meta.source_image && basename(u.meta.source_image))).toEqual(['001.png', '002.png', '003.png'])
    for (const [f, sha] of originals) expect(sha256(readFileSync(join(srcDir, f)))).toBe(sha)
    // 第二次入队不覆盖已有文件
    const again = enqueueReplica(s, draft(images, { lora_config: replacedCfg() }))
    mock.deterministic = false
    runner = new Runner(s, { eventsFactory: null })
    runner.start()
    expect(await waitUntil(() => (s.runCounts(again.runId!).done ?? 0) === 3, 10000)).toBe(true)
    runner.stop()
    await runner.join()
    runner = null
    expect(readdirSync(join(root, 'out-replica')).length).toBeGreaterThanOrEqual(3)
    for (const f of saved) expect(existsSync(join(root, 'out-replica', f))).toBe(true)
  })

  it('一百张独立单元', async () => {
    const base = await importAll()
    const many = Array.from({ length: 100 }, (_, i) => normalizeReplicaImage({ ...base[0], path: join(srcDir, '001.png'), name: `${String(i + 1).padStart(3, '0')}.png`, positive: `1girl, red hair, scene_${i}`, params: { seed: { value: 1000 + i, state: 'ok' } } }))
    const plan = planForReplica(s, draft(many, { lora_config: replacedCfg() }))
    expect(plan.errors).toEqual([])
    expect(plan.units).toHaveLength(100)
    expect(new Set(plan.units.map((u) => u.positive)).size).toBe(100)
    expect(new Set(plan.units.map((u) => u.seed)).size).toBe(100)
    expect(plan.units[99].meta.output_name).toBe('100')
  })

  it('真实 PNG 的提取结果可以进入计划：原图只读', async () => {
    const before = readFileSync(join(srcDir, '001.png'))
    const r = await scanImage(join(srcDir, '001.png'))
    expect(r.params?.seed?.value).toBe(111)
    expect(readFileSync(join(srcDir, '001.png')).equals(before)).toBe(true)
    mkdirSync(join(srcDir, 'sub'), { recursive: true })
  })
})

describe('工作流页面的共用逻辑', () => {
  it('节点分组：认不出的第三方节点放入「其他」', () => {
    const api: ApiWorkflow = {
      ...SAMPLE_WORKFLOW,
      '40': { class_type: 'SomeThirdPartyThing', inputs: { foo: 1 } },
      '41': { class_type: 'ImageScaleBy', inputs: { image: ['8', 0], scale_by: 2 } },
    }
    expect(nodeCategory(api, '6')).toBe('prompt')
    expect(nodeCategory(api, '10')).toBe('model')
    expect(nodeCategory(api, '4')).toBe('model')
    expect(nodeCategory(api, '3')).toBe('sampler')
    expect(nodeCategory(api, '8')).toBe('image')
    expect(nodeCategory(api, '41')).toBe('image')
    expect(nodeCategory(api, '9')).toBe('output')
    expect(nodeCategory(api, '40')).toBe('other')
  })

  it('校验消息中的节点用于列表上的异常标记', () => {
    expect([...problemNodes([['error', '节点覆盖：#12 KSampler 的输入已不存在'], ['warning', '#13 只是提示'], ['error', '节点 14 不存在']])].sort()).toEqual(['12', '14'])
  })

  it('变化摘要来自比较结果：参数、LoRA、绕过、禁止注入都用容易读的写法', () => {
    const base = { class_type: 'X', title: 'X' }
    const lines = changeLines([
      { ...base, node: '18', input: 'steps', before: 30, after: 40 },
      { ...base, node: '25', input: 'lora_name', before: 'a.safetensors', after: 'b.safetensors' },
      { ...base, node: '31', input: 'toggle_trigger_words', before: {}, after: {}, source: TRIGGER_DISABLE },
      { ...base, node: '31', input: 'orinalMessage', before: 'x', after: '', source: TRIGGER_DISABLE },
      { ...base, node: '41', input: '*', before: {}, after: null, source: 'node_bypass' },
      { ...base, node: '5', input: 'loras', before: { __value__: [{ name: 'p', strength: 1, active: true }] }, after: { __value__: [{ name: 'q', strength: 0.5, active: true }] } },
      { ...base, node: '5', input: 'text', before: '<lora:p:1>', after: '<lora:q:0.5>' },
    ] as InputChange[])
    expect(lines.map((l) => [l.node, l.kind, l.label, l.before, l.after])).toEqual([
      ['18', 'value', 'Steps', '30', '40'],
      ['25', 'value', 'LoRA', 'a.safetensors', 'b.safetensors'],
      ['31', 'trigger', '', '', ''],
      ['41', 'bypass', '', '', ''],
      ['5', 'lora', 'LoRA', 'p', 'q 0.5'],
    ])
  })

  it('工作流预览只包含节点控制，并由实际结果比较得到', () => {
    const wf = { id: 1, name: 'w', api_json: SAMPLE_WORKFLOW, mapping: [newEntry('positive', '6', 'text')], controls: { overrides: [{ node: '3', input: 'steps', class_type: 'KSampler', value: 40 }], bypass: [] } }
    const p = workflowPreview(wf as never)
    expect(p.json['3'].inputs.steps).toBe(40)
    expect(p.changes.map((c) => [c.node, c.input, c.before, c.after])).toEqual([['3', 'steps', 28, 40]])
    expect(p.json['6'].inputs.text).toBe('原正面')
    expect(p.errors).toEqual([])
  })
})
