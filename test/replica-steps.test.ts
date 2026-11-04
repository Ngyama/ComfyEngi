// 套图复刻（新版语义）：识别保留片段、手动修正、最终 Prompt 组成、LoRA 配置、角色 / 服装、重复生成、旧草稿迁移。
// 只用静态工作流 JSON 与本地临时文件，不连接 ComfyUI，不提交任何任务，不能代替真实环境验证。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultLoraConfig, setCharTarget } from '@shared/lora-config'
import { applyInputs, newEntry } from '@shared/mapping'
import { assignOutfit, expandOrder, normalizeReplicaData, normalizeReplicaImage, outfitRuns, REPLICA_VERSION, variantStem, type ReplicaData, type ReplicaImage } from '@shared/replica'
import { cameraKeysOf, classifyTag, commonPrefix, recognizeDraft } from '@shared/replica-recognize'
import { DEFAULT_SETTINGS, type ApiWorkflow, type LoraResource, type MappingEntry } from '@shared/types'
import { enqueueReplica, finalReplicaWorkflow, planForReplica } from '../src/main/replica'
import type { Store } from '../src/main/store'
import { createVault, openVault } from '../src/main/vault'
import { SAMPLE_MAPPING, SAMPLE_WORKFLOW, tempDir } from './helpers'
import { makePng } from './mining-fixtures'

const FIXTURE: ApiWorkflow = JSON.parse(readFileSync(join(__dirname, 'fixtures/workflow-two-pass.json'), 'utf8'))
type StackEntry = { name: string; strength: number | string; clipStrength: number | string; active: boolean }
const stackOf = (json: ApiWorkflow) => (json['5'].inputs.loras as { __value__: StackEntry[] }).__value__
const SEP = ',\n\n'

/** 只用于识别的图片（不需要文件） */
const im = (positive: string, over: Partial<ReplicaImage> = {}): ReplicaImage => normalizeReplicaImage({ path: `X:/src/${Math.random()}.png`, name: 'x.png', status: 'ok', positive, negative: '', source: 'a1111', ...over })
const recog = (images: ReplicaImage[], over: Partial<ReplicaData> = {}, camera: string[] = []) => recognizeDraft(normalizeReplicaData({ version: REPLICA_VERSION, images, ...over }), camera)

const SET = [
  'masterpiece, best quality, 1girl, char_a, red hair, blue eyes, school uniform, from side, sitting, smile, park',
  'masterpiece, best quality, 1girl, char_a, red hair, blue eyes, school uniform, cowboy shot, standing, (red hair:1.1), beach',
  'masterpiece, best quality, 1girl, char_a, red hair, blue eyes, serafuku, from above, lying, pleated skirt, bed',
]

describe('识别保留片段', () => {
  it('共同前缀、镜头起点、旧角色与旧服装 Tag', () => {
    const r = recog(SET.map((p) => im(p)))
    expect(r.prefix_keys).toEqual(['masterpiece', 'best_quality', '1girl', 'char_a', 'red_hair', 'blue_eyes', 'school_uniform'])
    expect(r.prefix_matches).toBe(2)
    expect(r.character.map((t) => t.key).sort()).toEqual(['blue_eyes', 'char_a', 'red_hair'])
    expect(r.outfit.map((t) => t.key).sort()).toEqual(['pleated_skirt', 'school_uniform', 'serafuku'])
    const [a, b, c] = r.images
    expect(a).toMatchObject({ cut: 7, cut_reason: 'camera', retained: 'from side, sitting, smile, park', needs_fix: false, issues: [] })
    expect(a.prefix).toBe('masterpiece, best quality, 1girl, char_a, red hair, blue eyes, school uniform')
    expect(b).toMatchObject({ retained: 'cowboy shot, standing, beach', removed_character: ['(red hair:1.1)'], needs_fix: false })
    expect(c).toMatchObject({ cut: 7, retained: 'from above, lying, bed', removed_outfit: ['pleated skirt'], needs_fix: false })
    expect(a.segments.map((s) => s.role)).toEqual(['common', 'common', 'common', 'common', 'common', 'common', 'common', 'camera', 'keep', 'keep', 'keep'])
  })

  it('权重、组合与换行逐字保留，只删除选中的 Tag；<lora:…> 文字删除', () => {
    const r = recog([im('1girl, char_a, red hair,\n(from side:1.1), (red hair, smile:1.2), <lora:old:0.8>, park')])
    expect(r.images[0].retained).toBe('(from side:1.1), (smile:1.2), park')
    expect(r.images[0].removed_other).toEqual(['<lora:old:0.8>'])
  })

  it('不可靠的图片被标记为需要处理，不会当作识别成功', () => {
    const r = recog([
      ...SET.map((p) => im(p)),
      im('masterpiece, best quality, 1girl, char_a, sitting, park'),
      im('(masterpiece, from side, smile'),
      im('masterpiece, best quality, 1girl, char_a, red hair, blue eyes, school uniform, holding umbrella, rain, from side, smile'),
      im('masterpiece, from side, {red hair|blue hair}, smile'),
      im('masterpiece, best quality, 1girl, char_a, red hair, blue eyes, school uniform, smile, park'),
    ])
    const [, , , none, unbalanced, odd, dynamic, prefixOnly] = r.images
    expect(none).toMatchObject({ cut_reason: 'none', needs_fix: true })
    expect(unbalanced.needs_fix).toBe(true)
    expect(unbalanced.issues.join()).toContain('括号不配对')
    expect(odd.needs_fix).toBe(true)
    expect(odd.issues.join()).toContain('holding umbrella')
    expect(dynamic.needs_fix).toBe(true)
    expect(dynamic.issues.join()).toContain('动态语法')
    expect(prefixOnly).toMatchObject({ cut_reason: 'prefix', retained: 'smile, park', needs_fix: true })
    expect(r.images.slice(0, 3).every((x) => !x.needs_fix)).toBe(true)
  })

  it('确认后不再标记；识别结果之后变化时需要重新确认', () => {
    const imgs = [...SET.map((p) => im(p)), im('masterpiece, best quality, 1girl, char_a, red hair, blue eyes, school uniform, smile, park')]
    const first = recog(imgs).images[3]
    expect(first.needs_fix).toBe(true)
    imgs[3] = { ...imgs[3], accepted: first.retained }
    expect(recog(imgs).images[3].needs_fix).toBe(false)
    // 整套标记 smile 为旧角色 Tag 后，保留片段变化，需要重新确认
    const changed = recog(imgs, { tag_fix: { smile: 'character' } }).images[3]
    expect(changed.retained).toBe('park')
    expect(changed.needs_fix).toBe(true)
  })

  it('手动修正：保留起点、单张删除 / 保留、整套分类、手动片段；结果稳定，保存后重新读取不变', () => {
    const imgs = SET.map((p) => im(p))
    imgs[0] = { ...imgs[0], cut: 8, tag_fix: { park: 'remove' } }
    imgs[1] = { ...imgs[1], tag_fix: { red_hair: 'keep' } }
    imgs[2] = { ...imgs[2], retained_manual: 'from above, lying on bed' }
    const over: Partial<ReplicaData> = { tag_fix: { smile: 'outfit', serafuku: 'keep' }, prefix_text: 'masterpiece, best quality' }
    const r = recog(imgs, over)
    expect(r.prefix_keys).toEqual(['masterpiece', 'best_quality'])
    expect(r.prefix_auto).toBe(false)
    expect(r.images[0]).toMatchObject({ cut: 8, cut_reason: 'manual', retained: 'sitting' })
    expect(r.images[0].removed_outfit).toEqual(['smile'])
    expect(r.images[0].removed_other).toEqual(['park'])
    expect(r.images[1].retained).toBe('cowboy shot, standing, (red hair:1.1), beach')
    expect(r.images[2]).toMatchObject({ retained: 'from above, lying on bed', manual: true, needs_fix: false })
    expect(r.outfit.map((t) => t.key)).not.toContain('serafuku')
    expect(r.kept.map((t) => t.key)).toEqual(['serafuku'])
    // 相同输入得到相同结果；草稿经过 JSON 保存与重新读取后结果不变
    const data = normalizeReplicaData({ version: REPLICA_VERSION, images: imgs, ...over })
    const again = normalizeReplicaData(JSON.parse(JSON.stringify(data)))
    expect(again).toEqual(data)
    expect(recognizeDraft(again)).toEqual(recognizeDraft(data))
    expect(recognizeDraft(again)).toEqual(r)
  })

  it('镜头词：常见写法与素材库中的镜头模板', () => {
    expect(['from_side', 'cowboy_shot', 'full_body', 'dutch_angle', 'pov', 'close-up'].map((k) => classifyTag(k, k))).toEqual(Array(6).fill('camera'))
    expect(classifyTag('holding_hat', 'holding hat')).toBe('other')
    expect(classifyTag('closed_eyes', 'closed eyes')).toBe('other')
    expect(classifyTag('long_hair', 'long hair')).toBe('appearance')
    expect(classifyTag('white_thighhighs', 'white thighhighs')).toBe('outfit')
    const cam = cameraKeysOf([{ kind: 'camera', positive: 'tilted frame, 1girl' }, { kind: 'scene', positive: 'park' }])
    expect(cam).toEqual(['tilted_frame'])
    expect(recog([im('1girl, char_a, tilted frame, smile')], {}, cam).images[0]).toMatchObject({ cut_reason: 'camera', retained: 'tilted frame, smile' })
    expect(commonPrefix([['a', 'b'], ['a', 'c'], ['x']])).toEqual(['a'])
    expect(commonPrefix([['a']])).toEqual([])
  })
})

describe('重复生成的顺序与文件名', () => {
  it('100 张 × 10 次 = 1000 个单元，每个变体可以区分', () => {
    const set = expandOrder(Array(100).fill(10), 'set')
    expect(set).toHaveLength(1000)
    expect(set.slice(0, 100).every((u, i) => u.image === i && u.variant === 0)).toBe(true)
    expect(set[100]).toEqual({ image: 0, variant: 1 })
    const byImage = expandOrder(Array(100).fill(10), 'image')
    expect(byImage.slice(0, 10).every((u, v) => u.image === 0 && u.variant === v)).toBe(true)
    const names = new Set(set.map((u) => variantStem(String(u.image + 1).padStart(3, '0'), u.variant, 10)))
    expect(names.size).toBe(1000)
    expect(variantStem('001', 0, 10)).toBe('001_v01')
    expect(variantStem('001', 0, 1)).toBe('001')
    expect(variantStem('001', 99, 100)).toBe('001_v100')
    expect(expandOrder([3, 1, 0, 2], 'set').map((u) => `${u.image}.${u.variant}`)).toEqual(['0.0', '1.0', '3.0', '0.1', '3.1', '0.2'])
  })
})

const resource = (over: Partial<LoraResource> = {}): LoraResource => ({
  id: '00000000-0000-0000-0000-000000000001', name: 'my_char', path: 'D:\\loras\\chars\\my_char.safetensors', relativePath: 'chars/my_char.safetensors', size: 1, mtime: 0,
  metadata: {}, metadataError: '', category: '', tags: '', note: '', characterId: null, recommendedWeight: 1, comfyName: '', preview: '', missing: false,
  root: 'D:\\loras', folder: 'chars', cover: '', sidecar: null, sidecarPath: '', sidecarMtime: 0, sidecarError: '', ...over,
})

describe('计划、最终 JSON 与入队快照', () => {
  let root: string
  let s: Store
  let srcDir: string
  let charId: number
  let otherId: number
  let outfitA: number
  let outfitB: number
  let globalId: number
  let sceneId: number
  /** 标准 Loader（#10 charA）：没有高级映射，由草稿的 LoRA 配置控制；映射 Seed 与尺寸 */
  let wid: number
  /** Lora Loader (LoraManager) 列表（#5） */
  let stackWid: number
  const MAPPING: MappingEntry[] = [...SAMPLE_MAPPING.filter((m) => !m.source.startsWith('lora1')), newEntry('width', '5', 'width'), newEntry('height', '5', 'height')]
  const STACK_MAPPING: MappingEntry[] = [newEntry('positive', '3', 'populated_text'), newEntry('negative', '4', 'populated_text'), newEntry('seed', '32', 'seed'), newEntry('width', '1', 'value'), newEntry('height', '12', 'value')]
  const image = (name: string, prompt = 'masterpiece, 1girl, char_a, red hair, from side, smile', meta = 'Steps: 33, Sampler: Euler a, CFG scale: 4, Seed: 111, Size: 640x960') => {
    const p = join(srcDir, name)
    writeFileSync(p, makePng({ parameters: `${prompt}\nNegative prompt: bad\n${meta}` }))
    return normalizeReplicaImage({ path: p, name, status: 'ok', positive: prompt, negative: 'bad', source: 'a1111', params: { seed: { value: 111, state: 'ok' }, steps: { value: 33, state: 'ok' }, cfg: { value: 4, state: 'ok' }, width: { value: 640, state: 'ok' }, height: { value: 960, state: 'ok' } } })
  }
  const images = (n: number) => Array.from({ length: n }, (_, i) => image(`${String(i + 1).padStart(3, '0')}.png`, `masterpiece, 1girl, char_a, red hair, from side, pose_${i}`))
  const replaceCfg = (w = wid) => {
    const wf = s.get('workflows', w)!
    const base = defaultLoraConfig(wf.api_json, wf.mapping)
    return setCharTarget(base, 'lora1', { node: base.entries[0].node, replace: base.entries[0].key })
  }
  const draft = (imgs: ReplicaImage[], over: Partial<ReplicaData> = {}) => {
    const w = over.workflow_id ?? wid
    const data = normalizeReplicaData({ version: REPLICA_VERSION, images: imgs, character_id: charId, workflow_id: w, seed_base: 1000, lora_configs: over.lora_configs ?? { [String(w)]: replaceCfg(w) }, output: { dir: join(root, 'out') }, ...over })
    const id = s.save('replicas', { name: '复刻', data })
    return s.get('replicas', id)!
  }
  const register = (id: string, comfyName: string, name = 'my_char') => {
    const file = join(root, 'models', `${name}.safetensors`)
    mkdirSync(join(root, 'models'), { recursive: true })
    writeFileSync(file, '')
    mkdirSync(join(s.files!.root, 'loras/metadata'), { recursive: true })
    writeFileSync(join(s.files!.root, 'loras/metadata', `${id}.json`), JSON.stringify({ ...resource({ id, name, path: file, comfyName }) }))
  }
  beforeEach(() => {
    root = tempDir()
    srcDir = tempDir()
    createVault(root)
    s = openVault(root)
    charId = s.save('characters', { name: '新角色', positive: 'new girl', negative: 'char neg', loras: [{ name: 'charB.safetensors', strength: 0.8 }] })
    otherId = s.save('characters', { name: '另一个角色', positive: 'other girl', negative: '', loras: [] })
    outfitA = s.save('outfits', { character_id: charId, name: '校服', positive: 'school uniform', negative: '', note: '', sort: 0 })
    outfitB = s.save('outfits', { character_id: charId, name: '泳装', positive: 'swimsuit', negative: 'coat', note: '', sort: 1 })
    globalId = s.save('templates', { kind: 'global', name: '画风', positive: 'newest, flat color', negative: 'lowres' })
    sceneId = s.save('templates', { kind: 'scene', name: '教室', positive: 'classroom', negative: '' })
    wid = s.save('workflows', { name: 'wf', api_json: SAMPLE_WORKFLOW, mapping: MAPPING, controls: null })
    stackWid = s.save('workflows', { name: 'stack', api_json: FIXTURE, mapping: STACK_MAPPING, controls: null })
  })
  afterEach(() => s.close())

  it('最终 Prompt = 新全局 / 画风 + 新场景 + 保留片段 + 新角色 + 新服装；预览就是写入工作流的内容', () => {
    const rec = draft([image('a.png')], { global_id: globalId, global_text: 'soft light', scene_id: sceneId, scene_text: 'window', outfit_id: outfitA })
    const plan = planForReplica(s, rec)
    expect(plan.errors).toEqual([])
    const row = plan.rows[0]
    expect(row.retained).toBe('from side, smile')
    expect(row.positive).toBe(['newest, flat color, soft light', 'classroom, window', 'from side, smile', 'new girl', 'school uniform'].join(SEP))
    expect(row.positive_parts.map((p) => p.module)).toEqual(['global', 'scene', 'camera', 'character', 'outfit'])
    expect(row.negative).toBe('lowres, char neg')
    const json = finalReplicaWorkflow(s, rec, 0).json
    expect(json['6'].inputs.text).toBe(row.positive)
    expect(json['7'].inputs.text).toBe(row.negative)
    expect(plan.units[0].positive).toBe(row.positive)
    // 可选：同时保留原图负面
    expect(planForReplica(s, draft([image('a.png')], { keep_source_negative: true })).rows[0].negative).toBe('bad, char neg')
  })

  it('不继承原图的 Seed、Steps、CFG、Sampler 与 LoRA；尺寸按原图', () => {
    const rec = draft([image('a.png'), image('b.png')])
    const plan = planForReplica(s, rec)
    expect(plan.errors).toEqual([])
    expect(plan.units.map((u) => u.seed)).toEqual([1000, 1001])
    const json = finalReplicaWorkflow(s, rec, 0).json
    expect(json['3'].inputs).toMatchObject({ seed: 1000, steps: 28, cfg: 5.5, sampler_name: 'euler_ancestral', scheduler: 'normal', denoise: 1 })
    expect(json['5'].inputs).toMatchObject({ width: 640, height: 960 })
    expect(plan.units[0].inputs!.some((x) => x.source === 'replica_param')).toBe(false)
    // 手动尺寸优先
    const sized = draft([{ ...image('a.png'), size: { width: 1024, height: 1536 } }])
    expect(finalReplicaWorkflow(s, sized, 0).json['5'].inputs).toMatchObject({ width: 1024, height: 1536 })
  })

  it('100 张 × 10 次：1000 个单元，Seed、文件名与记录可以区分', () => {
    const rec = draft(images(100), { repeat: 10 })
    const plan = planForReplica(s, rec)
    expect(plan.errors).toEqual([])
    expect(plan.units).toHaveLength(1000)
    expect(plan.unit_list).toHaveLength(1000)
    expect(new Set(plan.units.map((u) => u.seed)).size).toBe(1000)
    expect(new Set(plan.units.map((u) => u.meta.output_name)).size).toBe(1000)
    expect(plan.units[0].meta).toMatchObject({ output_name: '001_v01', n: 1, of: 10, item_no: 1 })
    expect(plan.units[100].meta).toMatchObject({ output_name: '001_v02', n: 2, of: 10 })
    expect(plan.units[100].meta.replica).toMatchObject({ variant: 2, variants: 10, retained: 'from side, pose_0' })
    expect(plan.units[100].positive).toBe(plan.units[0].positive)
    expect(plan.rows[0].units).toHaveLength(10)
    const prefix = (i: number) => plan.units[i].inputs!.find((x) => x.source === 'filename_prefix')?.value
    expect(prefix(0)).toBe('ComfyEngi复刻/复刻/001_v01')
    expect(prefix(100)).toBe('ComfyEngi复刻/复刻/001_v02')
    // 单张覆盖次数
    const imgs = images(3)
    imgs[1] = { ...imgs[1], repeat: 3 }
    const p2 = planForReplica(s, draft(imgs, { repeat: 1, repeat_order: 'image' }))
    expect(p2.units.map((u) => u.meta.output_name)).toEqual(['001', '002_v01', '002_v02', '002_v03', '003'])
  })

  it('需要处理的图片不入队；确认后进入计划', () => {
    const imgs = [image('a.png'), image('b.png', 'masterpiece, 1girl, sitting, park')]
    const plan = planForReplica(s, draft(imgs))
    expect(plan.rows.map((r) => r.state)).toEqual(['valid', 'confirm'])
    expect(plan.units).toHaveLength(1)
    expect(plan.rows[1].reason).toContain('镜头')
    imgs[1] = { ...imgs[1], accepted: plan.rows[1].retained }
    expect(planForReplica(s, draft(imgs)).units).toHaveLength(2)
  })

  describe('LoRA', () => {
    const ID = '11111111-2222-3333-4444-555555555555'
    it('标准 Loader：替换工作流中的旧 LoRA 为角色 LoRA；Model 与 Clip 权重分别写入', () => {
      const rec = draft([image('a.png')], { lora_overrides: { lora1: { enabled: true, strength_model: 0.6, strength_clip: 0.3 } } })
      const json = finalReplicaWorkflow(s, rec, 0).json
      expect(json['10'].inputs).toMatchObject({ lora_name: 'charB.safetensors', strength_model: 0.6, strength_clip: 0.3 })
      expect(planForReplica(s, rec).summary.loras).toEqual([{ name: 'charB.safetensors', strength: 0.6, clip: 0.3, enabled: true }])
    })
    it('没有加载位置时报错（与套图任务相同），不会静默保留原 LoRA', () => {
      const wf = s.get('workflows', wid)!
      const plan = planForReplica(s, draft([image('a.png')], { lora_configs: { [String(wid)]: defaultLoraConfig(wf.api_json, wf.mapping) } }))
      expect(plan.errors.join()).toContain('不在当前工作流的 LoRA 列表中')
    })
    it('停用角色 LoRA 并停用工作流 LoRA：强度写 0', () => {
      const wf = s.get('workflows', wid)!
      const cfg = defaultLoraConfig(wf.api_json, wf.mapping)
      cfg.entries[0].enabled = false
      const rec = draft([image('a.png')], { lora_overrides: { lora1: { enabled: false } }, lora_configs: { [String(wid)]: cfg } })
      const plan = planForReplica(s, rec)
      expect(plan.errors).toEqual([])
      expect(finalReplicaWorkflow(s, rec, 0).json['10'].inputs).toMatchObject({ strength_model: 0, strength_clip: 0 })
    })
    it('高级映射的 LoRA 槽位（lora1_name 等）同样按角色 LoRA 写入', () => {
      const mapped = s.save('workflows', { name: 'mapped', api_json: SAMPLE_WORKFLOW, mapping: SAMPLE_MAPPING })
      const rec = draft([image('a.png')], { workflow_id: mapped, lora_configs: {} })
      const plan = planForReplica(s, rec)
      expect(plan.errors).toEqual([])
      expect(finalReplicaWorkflow(s, rec, 0).json['10'].inputs).toMatchObject({ lora_name: 'charB.safetensors', strength_model: 0.8 })
    })
    it('Lora Loader (LoraManager)：添加、删除、停用、权重与 Clip 权重写入列表；角色 LoRA 追加', () => {
      register(ID, 'chars/my_char.safetensors')
      s.save('characters', { id: charId, loras: [{ name: 'my_char', resource_id: ID, strength: 0.9 }] })
      const wf = s.get('workflows', stackWid)!
      const cfg = defaultLoraConfig(wf.api_json, wf.mapping)
      const [first, second, ...rest] = cfg.entries
      expect(first.node).toBe('5')
      cfg.entries = [{ ...second, enabled: false }, ...rest.map((e, i) => (i === 0 ? { ...e, strength: 0.45, clip: 0.25 } : e)), { key: '5:+added', node: '5', name: 'extra.safetensors', strength: 0.7, clip: 0.5, enabled: true }]
      const rec = draft([image('a.png')], { workflow_id: stackWid, lora_configs: { [String(stackWid)]: cfg } })
      const plan = planForReplica(s, rec)
      expect(plan.errors).toEqual([])
      const stack = stackOf(finalReplicaWorkflow(s, rec, 0).json)
      expect(stack.some((e) => e.name === first.name.replace(/\.safetensors$/, ''))).toBe(false)
      expect(stack.find((e) => e.name === second.name.replace(/\.safetensors$/, ''))?.active).toBe(false)
      if (rest[0]) expect(stack.find((e) => e.name === rest[0].name.replace(/\.safetensors$/, ''))).toMatchObject({ strength: 0.45, clipStrength: 0.25 })
      expect(stack.find((e) => e.name === 'extra')).toMatchObject({ strength: 0.7, clipStrength: 0.5, active: true })
      expect(stack.find((e) => e.name === 'my_char')).toMatchObject({ strength: 0.9, active: true })
      expect(s.get('workflows', stackWid)!.api_json['5']).toEqual(FIXTURE['5'])
    })
    it('原图的 LoRA 只作参考：不会出现在写入的内容中', () => {
      const a = { ...image('a.png'), loras: [{ name: 'old_char_lora', strength: 1 }] }
      const json = JSON.stringify(finalReplicaWorkflow(s, draft([a]), 0).json)
      expect(json).not.toContain('old_char_lora')
    })
  })

  describe('角色与服装', () => {
    it('没有选择角色时明确说明（调整过角色 LoRA 也一样）', () => {
      const plan = planForReplica(s, draft([image('a.png')], { character_id: null, lora_overrides: { lora1: { enabled: true, name: 'x.safetensors' } } }))
      expect(plan.errors.join()).toContain('角色 Prompt 与角色 LoRA 都来自角色库')
      expect(plan.errors.join()).toContain('已调整的角色 LoRA 不代表选择了角色')
    })
    it('默认服装与按图片分配；换角色后旧服装报错', () => {
      const imgs = assignOutfit(images(4), 3, 4, outfitB).images
      const plan = planForReplica(s, draft(imgs, { outfit_id: outfitA }))
      expect(plan.errors).toEqual([])
      expect(plan.rows.map((r) => r.outfit)).toEqual(['校服', '校服', '泳装', '泳装'])
      expect(plan.rows[2].positive.endsWith(`new girl${SEP}swimsuit`)).toBe(true)
      expect(plan.rows[2].negative).toContain('coat')
      expect(plan.summary.character).toMatchObject({ name: '新角色', positive: 'new girl' })
      expect(plan.summary.outfit).toMatchObject({ name: '校服', positive: 'school uniform' })
      expect(outfitRuns(imgs).map((r) => [r.a + 1, r.b + 1])).toEqual([[1, 2], [3, 4]])
      const bad = planForReplica(s, draft(imgs, { character_id: otherId, outfit_id: null }))
      expect(bad.errors.find((m) => m.includes('服装'))).toContain('图 3（003.png）')
    })
  })

  it('入队快照与预览相同：每个单元的工作流、Prompt、Seed、文件名', () => {
    const rec = draft(images(3), { repeat: 2, global_id: globalId })
    const plan = planForReplica(s, rec)
    const { runId } = enqueueReplica(s, rec)
    const run = s.getRun(runId!)!
    const units = s.listUnits(runId!)
    expect(units).toHaveLength(6)
    units.forEach((u, i) => {
      const json = applyInputs(run.workflow_json, u.inputs)
      expect(json).toEqual(finalReplicaWorkflow(s, rec, i).json)
      expect(json['6'].inputs.text).toBe(plan.units[i].positive)
      expect(json['3'].inputs.seed).toBe(1000 + i)
      expect(u.meta.output_name).toBe(plan.unit_list[i].output_name)
    })
    expect(units.map((u) => u.meta.output_name)).toEqual(['001_v01', '002_v01', '003_v01', '001_v02', '002_v02', '003_v02'])
  })

  it('工作流没有映射 Seed 时提示多个变体可能相同', () => {
    const noSeed = s.save('workflows', { name: 'ns', api_json: SAMPLE_WORKFLOW, mapping: MAPPING.filter((m) => m.source !== 'seed') })
    const plan = planForReplica(s, draft([image('a.png')], { workflow_id: noSeed, repeat: 3 }))
    expect(plan.warnings.join()).toContain('没有映射 Seed')
  })

  describe('旧版草稿', () => {
    const v1 = (imgs: object[], over: Record<string, unknown> = {}) => ({
      images: imgs,
      removed_tags: ['Red_Hair', 'char_a'],
      character_id: charId,
      outfit_id: outfitA,
      negative_mode: 'keep',
      workflow_id: wid,
      lora_config: replaceCfg(),
      lora: { enabled: true, name: 'charB.safetensors', resource_id: null, strength: 0.5 },
      disable_triggers: true,
      keep: { seed: true, size: true, sampling: true },
      accept_uncertain: true,
      output: { dir: join(root, 'old-out') },
      ...over,
    })
    it('迁移为新版：能对应的设置迁移，无法迁移的明确说明并保存原值', () => {
      const a = image('a.png')
      const raw = v1([{ ...a, manual_positive: 'old manual prompt', manual_negative: 'old neg', overrides: { seed: 5, steps: 12, width: 768, height: 1152 } }, image('b.png')])
      const d = normalizeReplicaData(JSON.parse(JSON.stringify(raw)) as never)
      expect(d.version).toBe(REPLICA_VERSION)
      expect(d.tag_fix).toEqual({ red_hair: 'character', char_a: 'character' })
      expect(d.lora_configs[String(wid)]).toEqual(raw.lora_config)
      expect(d.lora_overrides.lora1).toEqual({ enabled: true, name: 'charB.safetensors', strength_model: 0.5, strength_clip: 0.5 })
      expect(d.keep_source_negative).toBe(true)
      expect(d.output.dir).toBe(join(root, 'old-out'))
      expect(d.images[0].size).toEqual({ width: 768, height: 1152 })
      expect(d.images[0].legacy).toEqual({ manual_positive: 'old manual prompt', manual_negative: 'old neg', overrides: { seed: 5, steps: 12 } })
      expect(d.legacy?.v1).toMatchObject({ keep: raw.keep, accept_uncertain: true, negative_mode: 'keep', lora: raw.lora })
      const notes = d.legacy!.notes.join('\n')
      expect(notes).toContain('不再继承')
      expect(notes).toContain('手动编辑过最终 Prompt')
      expect(notes).toContain('只使用原图负面')
      // 再次读取不变（不会重复迁移）
      expect(normalizeReplicaData(JSON.parse(JSON.stringify(d)))).toEqual(d)
    })
    it('旧草稿可以直接计划：手动编辑过最终 Prompt 的图片要求重新确认，不会静默使用', () => {
      const id = s.save('replicas', { name: '旧', data: v1([{ ...image('a.png'), manual_positive: 'old manual' }, image('b.png')]) as never })
      const plan = planForReplica(s, s.get('replicas', id)!)
      expect(plan.errors).toEqual([])
      expect(plan.rows.map((r) => r.state)).toEqual(['confirm', 'valid'])
      expect(plan.rows[0].reason).toContain('旧版')
      expect(plan.rows[1].retained).toBe('from side, smile')
      expect(plan.units[0].positive).not.toContain('old manual')
    })
    it('旧草稿使用默认工作流：LoRA 配置迁移到当时的默认工作流；没有默认工作流时说明', () => {
      const raw = v1([image('a.png')], { workflow_id: null })
      expect(normalizeReplicaData(raw as never, { defaultWorkflowId: wid }).lora_configs[String(wid)]).toBeTruthy()
      const lost = normalizeReplicaData(raw as never)
      expect(lost.lora_configs).toEqual({})
      expect(lost.legacy!.notes.join()).toContain('没有迁移')
      expect(lost.legacy!.v1.lora_config).toEqual(raw.lora_config)
    })
    it('新建草稿是新版结构', () => {
      const d = normalizeReplicaData(null)
      expect(d.version).toBe(REPLICA_VERSION)
      expect(d.legacy).toBeUndefined()
      expect(d.repeat).toBe(1)
      expect(DEFAULT_SETTINGS.pos_module_separator).toBe(',\\n\\n')
    })
  })
})
