// 套图复刻第 2–4 步的数据流：LoRA 选择与替换、按图片分配服装、计划与入队快照。
// 只用静态工作流 JSON 与本地临时文件，不连接 ComfyUI，不提交任何任务，不能代替真实环境验证。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultLoraConfig, effectiveLoraConfig, setCharTarget, type WfLoraConfig } from '@shared/lora-config'
import { loadNameOf, selectableLoras, suggestedComfyName } from '@shared/lora-names'
import { applyInputs, loraStem, newEntry } from '@shared/mapping'
import { assignOutfit, normalizeReplicaData, normalizeReplicaImage, outfitRuns, type ReplicaData, type ReplicaImage } from '@shared/replica'
import type { ApiWorkflow, LoraResource, MappingEntry } from '@shared/types'
import { enqueueReplica, finalReplicaWorkflow, planForReplica } from '../src/main/replica'
import type { Store } from '../src/main/store'
import { createVault, openVault } from '../src/main/vault'
import { tempDir } from './helpers'
import { makePng } from './mining-fixtures'

const FIXTURE: ApiWorkflow = JSON.parse(readFileSync(join(__dirname, 'fixtures/workflow-two-pass.json'), 'utf8'))
const MAPPING: MappingEntry[] = [newEntry('positive', '3', 'populated_text'), newEntry('negative', '4', 'populated_text')]
type StackEntry = { name: string; strength: number | string; active: boolean }
const stackOf = (json: ApiWorkflow) => (json['5'].inputs.loras as { __value__: StackEntry[] }).__value__

const resource = (over: Partial<LoraResource> = {}): LoraResource => ({
  id: '00000000-0000-0000-0000-000000000001', name: 'my_char', path: 'D:\\loras\\chars\\my_char.safetensors', relativePath: 'chars/my_char.safetensors', size: 1, mtime: 0,
  metadata: {}, metadataError: '', category: '', tags: '', note: '', characterId: null, recommendedWeight: 1, comfyName: '', preview: '', missing: false,
  root: 'D:\\loras', folder: 'chars', cover: '', sidecar: null, sidecarPath: '', sidecarMtime: 0, sidecarError: '', ...over,
})

describe('LoRA 名称', () => {
  it('没有设置 ComfyUI 名称的 LoRA 也可以选择；缺失或离线的不能选', () => {
    const list = [resource(), resource({ id: 'b', comfyName: 'x.safetensors' }), resource({ id: 'c', missing: true }), resource({ id: 'd', offline: true })]
    expect(selectableLoras(list).map((r) => r.id)).toEqual([resource().id, 'b'])
  })
  it('同名 LoRA 按 ID 与文件夹区分，不合并', () => {
    const a = resource({ id: 'a', folder: 'chars', relativePath: 'chars/my_char.safetensors' })
    const b = resource({ id: 'b', folder: 'old', relativePath: 'old/my_char.safetensors' })
    expect(selectableLoras([a, b]).map((r) => [r.id, r.folder])).toEqual([['a', 'chars'], ['b', 'old']])
    expect(suggestedComfyName(a)).not.toBe(suggestedComfyName(b))
  })
  it('显示名称与加载名称分开；不能加载时给出原因', () => {
    expect(loadNameOf(resource())).toMatchObject({ ok: false, reason: '尚未设置 ComfyUI 模型名称' })
    expect(loadNameOf(resource({ comfyName: 'chars\\my_char.safetensors' }))).toEqual({ name: 'chars\\my_char.safetensors', ok: true, reason: '' })
    expect(loadNameOf(resource({ comfyName: 'D:\\loras\\my_char.safetensors' })).ok).toBe(false)
    expect(loadNameOf(resource({ comfyName: '../x.safetensors' })).ok).toBe(false)
    expect(loadNameOf(resource({ comfyName: 'x', missing: true })).reason).toBe('模型文件缺失')
    expect(suggestedComfyName(resource())).toBe('chars\\my_char.safetensors')
    expect(suggestedComfyName(resource({ path: '/home/u/loras/chars/my_char.safetensors' }))).toBe('chars/my_char.safetensors')
  })
})

describe('替换目标', () => {
  const cfg = () => defaultLoraConfig(FIXTURE, MAPPING)
  it('取消替换时删除目标，不留下空值', () => {
    const c = cfg()
    const on = setCharTarget(c, 'lora1', { node: '5', replace: c.entries[1].key })
    expect(on.char_targets?.lora1).toEqual({ node: '5', replace: c.entries[1].key })
    const off = setCharTarget(on, 'lora1', null)
    expect(off.char_targets).toEqual({})
    expect('lora1' in off.char_targets!).toBe(false)
  })
  it('旧版界面留下的 undefined / null 目标不会导致出错', () => {
    for (const bad of [undefined, null, 'x', { replace: 'k' }]) {
      const saved = { ...cfg(), char_targets: { lora1: bad } } as unknown as WfLoraConfig
      expect(() => effectiveLoraConfig(saved, FIXTURE, MAPPING)).not.toThrow()
      expect(effectiveLoraConfig(saved, FIXTURE, MAPPING).char_targets).toEqual({})
    }
  })
  it('反复替换与取消后回到原状态', () => {
    const c = cfg()
    let cur = c
    for (let i = 0; i < 7; i++) cur = setCharTarget(cur, 'lora1', i % 2 === 0 ? { node: '5', replace: c.entries[i % c.entries.length].key } : null)
    expect(cur.char_targets?.lora1?.replace).toBe(c.entries[6 % c.entries.length].key)
    cur = setCharTarget(cur, 'lora1', null)
    expect(cur.entries).toEqual(c.entries)
    expect(cur.char_targets).toEqual({})
  })
})

describe('计划、最终 JSON 与入队快照', () => {
  let root: string
  let s: Store
  let srcDir: string
  let charId: number
  let otherId: number
  let outfitA: number
  let outfitB: number
  let otherOutfit: number
  let wid: number
  const image = (name: string, prompt = 'red_hair, smile') => {
    const p = join(srcDir, name)
    writeFileSync(p, makePng({ parameters: `${prompt}\nNegative prompt: bad\nSteps: 20, Sampler: Euler a, CFG scale: 7, Seed: 5, Size: 512x512` }))
    return normalizeReplicaImage({ path: p, name, status: 'ok', positive: prompt, negative: 'bad', source: 'a1111' })
  }
  const images = (n: number) => Array.from({ length: n }, (_, i) => image(`${String(i + 1).padStart(3, '0')}.png`))
  const draft = (imgs: ReplicaImage[], over: Partial<ReplicaData> = {}) => {
    const id = s.save('replicas', { name: '复刻', data: normalizeReplicaData({ images: imgs, removed_tags: ['red_hair'], character_id: charId, workflow_id: wid, output: { dir: join(root, 'out') }, ...over }) })
    return s.get('replicas', id)!
  }
  /** 在 LoRA 管理的元数据目录中登记一个资源（与 resolveLoraName 读取的位置相同） */
  const register = (id: string, comfyName: string) => {
    const file = join(root, 'models', `${id}.safetensors`)
    mkdirSync(join(root, 'models'), { recursive: true })
    writeFileSync(file, '')
    mkdirSync(join(s.files!.root, 'loras/metadata'), { recursive: true })
    writeFileSync(join(s.files!.root, 'loras/metadata', `${id}.json`), JSON.stringify({ ...resource({ id, path: file, comfyName }) }))
  }
  beforeEach(() => {
    root = tempDir()
    srcDir = tempDir()
    createVault(root)
    s = openVault(root)
    charId = s.save('characters', { name: '新角色', positive: 'new girl', negative: 'char neg', loras: [] })
    otherId = s.save('characters', { name: '另一个角色', positive: 'other girl', negative: '', loras: [] })
    outfitA = s.save('outfits', { character_id: charId, name: '校服', positive: 'school uniform', negative: '', note: '', sort: 0 })
    outfitB = s.save('outfits', { character_id: charId, name: '泳装', positive: 'swimsuit', negative: 'coat', note: '', sort: 1 })
    otherOutfit = s.save('outfits', { character_id: otherId, name: '别人的', positive: 'armor', negative: '', note: '', sort: 0 })
    wid = s.save('workflows', { name: 'wf', api_json: FIXTURE, mapping: MAPPING, controls: null })
  })
  afterEach(() => s.close())

  describe('LoRA', () => {
    const ID = '11111111-2222-3333-4444-555555555555'
    it('选择的 LoRA 写入最终 JSON，第 4 步显示名称、权重与加载位置', () => {
      register(ID, 'chars\\my_char.safetensors')
      const rec = draft([image('a.png')], { lora: { enabled: true, name: 'my_char', resource_id: ID, strength: 0.7 } })
      const plan = planForReplica(s, rec)
      expect(plan.errors).toEqual([])
      expect(plan.lora_info).toEqual([{ name: 'chars\\my_char.safetensors', strength: 0.7, placement: '追加到 #5 的 LoRA 列表', ok: true }])
      const hit = stackOf(finalReplicaWorkflow(s, rec, 0).json).find((e) => loraStem(e.name) === 'my_char')
      expect(hit).toMatchObject({ active: true })
      expect(Number(hit!.strength)).toBe(0.7)
    })
    it('没有设置 ComfyUI 名称时明确报错，不猜测路径', () => {
      register(ID, '')
      const plan = planForReplica(s, draft([image('a.png')], { lora: { enabled: true, name: 'my_char', resource_id: ID, strength: 1 } }))
      expect(plan.errors.join()).toContain('请配置 ComfyUI 相对模型名称')
    })
    it('只选择 LoRA、没有选择角色时说明需要角色', () => {
      register(ID, 'my_char.safetensors')
      const plan = planForReplica(s, draft([image('a.png')], { character_id: null, lora: { enabled: true, name: 'my_char', resource_id: ID, strength: 1 } }))
      expect(plan.errors.join()).toContain('只选择 LoRA 不够')
    })
    it('替换工作流中的 LoRA：原条目不再加载，新 LoRA 加载；取消后恢复', () => {
      register(ID, 'my_char.safetensors')
      const base = defaultLoraConfig(FIXTURE, MAPPING)
      const old = base.entries[0]
      const lora = { enabled: true, name: 'my_char', resource_id: ID, strength: 0.8 }
      const on = draft([image('a.png')], { lora, lora_config: setCharTarget(base, 'lora1', { node: old.node, replace: old.key }) })
      const plan = planForReplica(s, on)
      expect(plan.errors).toEqual([])
      expect(plan.lora_info[0].placement).toBe(`替换 #5 中的「${loraStem(old.name)}」`)
      const stack = stackOf(finalReplicaWorkflow(s, on, 0).json)
      expect(stack.some((e) => e.name === old.name && e.active)).toBe(false)
      expect(stack.some((e) => loraStem(e.name) === 'my_char' && e.active)).toBe(true)

      const off = draft([image('a.png')], { lora, lora_config: setCharTarget(on.data!.lora_config!, 'lora1', null) })
      expect(planForReplica(s, off).lora_info[0].placement).toBe('追加到 #5 的 LoRA 列表')
      const back = stackOf(finalReplicaWorkflow(s, off, 0).json)
      expect(back.find((e) => e.name === old.name)?.active).toBe(true)
    })
    it('设置了替换但没有新 LoRA 时提示替换不会生效', () => {
      const base = defaultLoraConfig(FIXTURE, MAPPING)
      const rec = draft([image('a.png')], { lora: { enabled: false, name: null, resource_id: null, strength: null }, lora_config: setCharTarget(base, 'lora1', { node: '5', replace: base.entries[0].key }) })
      const plan = planForReplica(s, rec)
      expect(plan.warnings.join()).toContain('替换不会生效')
      expect(plan.lora_info).toEqual([])
    })
    it('草稿中残留的 undefined 替换目标不影响计划', () => {
      const saved = { ...defaultLoraConfig(FIXTURE, MAPPING), char_targets: { lora1: undefined } } as unknown as WfLoraConfig
      expect(() => planForReplica(s, draft([image('a.png')], { lora_config: saved }))).not.toThrow()
    })
    it('保存后重新打开，LoRA 选择与替换目标不变', () => {
      const base = defaultLoraConfig(FIXTURE, MAPPING)
      const lora = { enabled: true, name: 'my_char', resource_id: ID, strength: 0.6 }
      const cfg = setCharTarget(base, 'lora1', { node: '5', replace: base.entries[2].key })
      const rec = draft([image('a.png')], { lora, lora_config: cfg })
      const again = normalizeReplicaData(JSON.parse(JSON.stringify(s.get('replicas', rec.id!)!.data)))
      expect(again.lora).toEqual(lora)
      expect(again.lora_config?.char_targets).toEqual(cfg.char_targets)
    })
  })

  describe('服装', () => {
    it('全局默认服装：角色 Prompt + 服装 Prompt 放在被移除 Tag 的位置', () => {
      const rec = draft([image('a.png')], { outfit_id: outfitA })
      const plan = planForReplica(s, rec)
      expect(plan.errors).toEqual([])
      expect(plan.rows[0]).toMatchObject({ positive: 'new girl, school uniform, smile', outfit: '校服', outfit_source: 'default' })
    })
    it('20 张图两种服装', () => {
      const imgs = assignOutfit(assignOutfit(images(20), 1, 10, outfitA).images, 11, 20, outfitB).images
      const plan = planForReplica(s, draft(imgs))
      expect(plan.errors).toEqual([])
      expect(plan.rows.map((r) => r.outfit)).toEqual([...Array(10).fill('校服'), ...Array(10).fill('泳装')])
      expect(plan.rows[9].positive).toBe('new girl, school uniform, smile')
      expect(plan.rows[10].positive).toBe('new girl, swimsuit, smile')
      expect(plan.rows[10].negative).toContain('coat')
      expect(plan.rows[9].negative).not.toContain('coat')
    })
    it('100 张图多段分配，重叠时后应用的覆盖，没有分配的使用默认', () => {
      let imgs = images(100)
      imgs = assignOutfit(imgs, 1, 40, outfitA).images
      imgs = assignOutfit(imgs, 30, 60, outfitB).images
      imgs = assignOutfit(imgs, 90, 100, null).images
      const plan = planForReplica(s, draft(imgs, { outfit_id: outfitA }))
      expect(plan.errors).toEqual([])
      const names = plan.rows.map((r) => r.outfit)
      expect(names.slice(0, 29).every((n) => n === '校服')).toBe(true)
      expect(names.slice(29, 60).every((n) => n === '泳装')).toBe(true)
      expect(plan.rows.slice(60, 89).every((r) => r.outfit === '校服' && r.outfit_source === 'default')).toBe(true)
      expect(plan.rows.slice(89).every((r) => r.outfit === '' && r.outfit_source === 'image' && r.positive === 'new girl, smile')).toBe(true)
      expect(outfitRuns(imgs).map((r) => [r.a + 1, r.b + 1, r.value])).toEqual([[1, 29, outfitA], [30, 60, outfitB], [61, 89, undefined], [90, 100, null]])
    })
    it('边界：只分配第一张、最后一张；不合法的范围不修改', () => {
      const imgs = images(5)
      expect(assignOutfit(imgs, 1, 1, outfitB).images.map((im) => im.outfit_id)).toEqual([outfitB, undefined, undefined, undefined, undefined])
      expect(assignOutfit(imgs, 5, 5, outfitB).images.map((im) => im.outfit_id)).toEqual([undefined, undefined, undefined, undefined, outfitB])
      for (const [a, b] of [[0, 2], [2, 6], [3, 2], [1.5, 2], [Number.NaN, 2]]) {
        const r = assignOutfit(imgs, a, b, outfitB)
        expect(r.error, `${a}-${b}`).toContain('1 到 5')
        expect(r.images).toBe(imgs)
      }
      // 恢复默认时去掉字段，而不是写 undefined
      const cleared = assignOutfit(assignOutfit(imgs, 1, 5, outfitA).images, 2, 3, undefined).images
      expect(cleared.map((im) => 'outfit_id' in im)).toEqual([true, false, false, true, true])
    })
    it('删除图片后其余图片的服装不变', () => {
      const imgs = assignOutfit(images(6), 4, 6, outfitB).images
      const left = imgs.filter((_, i) => i !== 1)
      const plan = planForReplica(s, draft(left, { outfit_id: outfitA }))
      expect(plan.rows.map((r) => [r.name, r.outfit])).toEqual([['001.png', '校服'], ['003.png', '校服'], ['004.png', '泳装'], ['005.png', '泳装'], ['006.png', '泳装']])
    })
    it('换角色后旧角色的服装报错，指出是哪几张图；已排除的图不报错', () => {
      let imgs = assignOutfit(images(4), 2, 3, outfitA).images
      imgs = imgs.map((im, i) => (i === 2 ? { ...im, exclude: true } : im))
      const plan = planForReplica(s, draft(imgs, { character_id: otherId, outfit_id: null }))
      const msg = plan.errors.find((m) => m.includes('服装'))!
      expect(msg).toContain('图 2（002.png）')
      expect(msg).not.toContain('图 3')
      const bad = planForReplica(s, draft(images(1), { character_id: charId, outfit_id: otherOutfit }))
      expect(bad.errors.join()).toContain('默认服装已不存在或不属于当前角色')
    })
    it('旧草稿只有 outfit_id：全部图片使用默认服装；保存后重新读取不变', () => {
      const old = normalizeReplicaData(JSON.parse(JSON.stringify({ images: images(3).map(({ outfit_id: _x, ...im }) => im), outfit_id: outfitA, character_id: charId, workflow_id: wid })))
      expect(old.images.every((im) => !('outfit_id' in im))).toBe(true)
      const rec = draft(old.images, { outfit_id: outfitA })
      expect(planForReplica(s, rec).rows.map((r) => r.outfit)).toEqual(['校服', '校服', '校服'])
      const mixed = draft(assignOutfit(old.images, 2, 2, null).images, { outfit_id: outfitA })
      const again = normalizeReplicaData(JSON.parse(JSON.stringify(s.get('replicas', mixed.id!)!.data)))
      expect(again.images.map((im) => im.outfit_id)).toEqual([undefined, null, undefined])
      expect(normalizeReplicaImage({ ...again.images[0], outfit_id: 'x' as never }).outfit_id).toBeUndefined()
    })
    it('入队快照：每张图的 Prompt 与服装和预览一致', () => {
      const imgs = assignOutfit(images(3), 3, 3, outfitB).images
      const rec = draft(imgs, { outfit_id: outfitA })
      const plan = planForReplica(s, rec)
      const { runId } = enqueueReplica(s, rec)
      const run = s.getRun(runId!)!
      const units = s.listUnits(runId!)
      expect(units.map((u) => u.meta.outfit)).toEqual(['校服', '校服', '泳装'])
      units.forEach((u, i) => {
        const json = applyInputs(run.workflow_json, u.inputs)
        expect(json['3'].inputs.populated_text).toBe(plan.rows[i].positive)
        expect(json).toEqual(finalReplicaWorkflow(s, rec, i).json)
      })
      expect(plan.rows[2].positive).toBe('new girl, swimsuit, smile')
    })
  })
})
