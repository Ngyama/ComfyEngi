// 批量放大：可选的「放大：Seed」映射。能从原图快照静态确定第一个采样器的 Seed 时写入，否则要求确认并保持放大工作流的值。

import { describe, expect, it } from 'vitest'
import { newEntry, UPSCALE_IMAGE, UPSCALE_OUTPUT, UPSCALE_SEED, validateMapping } from '@shared/mapping'
import type { ApiWorkflow, MappingEntry } from '@shared/types'
import { recoverGeneration, upscaleInputs } from '@shared/upscale'
import { comfyGraph } from './mining-fixtures'
import { SAMPLE, SAMPLE_UP, SAMPLE_UP_MAP } from './upscale-fixtures'

/** 原图：comfyGraph 的 KSampler #3，seed 换成给定的值；extra 加入额外节点 */
const gen = (seed: unknown, extra: ApiWorkflow = {}): ApiWorkflow => {
  const g = comfyGraph('1girl') as ApiWorkflow
  g['3'].inputs.seed = seed
  return { ...g, ...extra }
}

const UP: ApiWorkflow = {
  '1': { class_type: 'LoadImage', inputs: { image: 'example.png' } },
  '2': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'x.safetensors' } },
  '4': { class_type: 'CLIPTextEncode', inputs: { text: 'p', clip: ['2', 1] } },
  '5': { class_type: 'CLIPTextEncode', inputs: { text: 'n', clip: ['2', 1] } },
  '8': { class_type: 'KSampler', inputs: { seed: 5, steps: 10, cfg: 5, denoise: 0.4, model: ['2', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['1', 0] } },
  '9': { class_type: 'UltimateSDUpscale', inputs: { seed: 777, upscale_by: 2, image: ['8', 0], model: ['2', 0], positive: ['4', 0], negative: ['5', 0] } },
  '10': { class_type: 'SaveImage', inputs: { filename_prefix: 'up', images: ['9', 0] } },
}
const BASE: MappingEntry[] = [newEntry(UPSCALE_IMAGE, '1', 'image'), newEntry('positive', '4', 'text'), newEntry('negative', '5', 'text'), newEntry(UPSCALE_OUTPUT, '10', 'filename_prefix')]
const wf = (mapping: MappingEntry[]) => ({ name: 'up', api_json: UP, mapping })
const seedsOf = (inputs: { source: string; node: string; value: unknown }[] | null) => (inputs ?? []).filter((x) => x.source === UPSCALE_SEED).map((x) => [x.node, x.value])

describe('原图第一个采样器的 Seed', () => {
  it('字面值、来自 SeedNode / easy int / PrimitiveInt 的值可以确定', () => {
    expect(recoverGeneration(gen(42)).seed).toBe(42)
    for (const ct of ['SeedNode', 'easy int', 'PrimitiveInt']) {
      const r = recoverGeneration(gen(['20', 0], { '20': { class_type: ct, inputs: { [ct === 'SeedNode' ? 'seed' : 'value']: 9007199254740991 } } }))
      expect(r.seed).toBe(9007199254740991)
      expect(r.seed_note).toContain('#20')
    }
    // KSamplerAdvanced 的 noise_seed
    const adv = gen(0)
    delete adv['3'].inputs.seed
    adv['3'].inputs.noise_seed = 12
    expect(recoverGeneration(adv).seed).toBe(12)
  })

  it('不能静态确定时为 null 并说明原因：运算 / 随机节点、有连接输入、多个数字、超出精确范围、负数、非数字', () => {
    const cases: [unknown, ApiWorkflow, RegExp][] = [
      [['20', 0], { '20': { class_type: 'Random Seed', inputs: { seed: 1 } } }, /不是只输出一个整数的节点/],
      [['20', 0], { '20': { class_type: 'easy int', inputs: { value: ['21', 0] } }, '21': { class_type: 'SeedNode', inputs: { seed: 1 } } }, /不是只输出一个整数的节点/],
      [['20', 0], { '20': { class_type: 'SeedNode', inputs: { seed: 1, other: 2 } } }, /不是只输出一个整数的节点/],
      [['20', 0], { '20': { class_type: 'SeedNode', inputs: { seed: 2 ** 60 } } }, /不是可以精确确定的非负整数/],
      [['20', 0], {}, /不存在/],
      [2 ** 60, {}, /不是可以精确确定的非负整数/],
      [-1, {}, /不是可以精确确定的非负整数/],
      ['123', {}, /不是可以精确确定的非负整数/],
    ]
    for (const [seed, extra, re] of cases) {
      const r = recoverGeneration(gen(seed, extra))
      expect(r.seed).toBeNull()
      expect(r.seed_note).toMatch(re)
    }
  })

  it('有多个采样器时使用上游的第一个（不按节点编号）', () => {
    const g = gen(111)
    // #2 是接在 #3 后面的二次采样（编号更小）
    g['2'] = { class_type: 'KSampler', inputs: { seed: 222, steps: 10, cfg: 5, denoise: 0.4, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['3', 0] } }
    const r = recoverGeneration(g)
    expect(r.seed).toBe(111)
    expect(r.seed_note).toContain('#3')
  })

  it('样本图片：#46 KSampler 的 seed 来自 #32 SeedNode', () => {
    const r = recoverGeneration(SAMPLE.prompt, { original: SAMPLE.prompt })
    expect(r.seed).toBe(277707860833163)
    expect(r.seed_note).toMatch(/#46.*#32/)
  })
})

describe('「放大：Seed」写入', () => {
  it('不映射时不写入 Seed，也没有相关问题（与之前相同）', () => {
    const r = upscaleInputs(wf(BASE), recoverGeneration(gen(42)), 'comfyengi_upscale/a.png')
    expect(seedsOf(r.inputs)).toEqual([])
    expect(r.issues.some((x) => x.text.includes('Seed'))).toBe(false)
  })

  it('能确定时写入每个映射的节点，并给出一条说明', () => {
    const map = [...BASE, newEntry(UPSCALE_SEED, '8', 'seed'), newEntry(UPSCALE_SEED, '9', 'seed')]
    expect(validateMapping(UP, map).filter(([l]) => l === 'error')).toEqual([])
    const r = upscaleInputs(wf(map), recoverGeneration(gen(42)), 'comfyengi_upscale/a.png')
    expect(seedsOf(r.inputs)).toEqual([['8', 42], ['9', 42]])
    expect(r.issues.filter((x) => x.text.startsWith('Seed'))).toEqual([{ level: 'note', text: 'Seed：写入原图的 42（原图第一个采样器 #3（KSampler） 的 seed）' }])
  })

  it('不能确定时要求确认，保持放大工作流的值（不写入），其他值照常写入', () => {
    const map = [...BASE, newEntry(UPSCALE_SEED, '8', 'seed')]
    const r = upscaleInputs(wf(map), recoverGeneration(gen(['20', 0], { '20': { class_type: 'Random Seed', inputs: { seed: 1 } } })), 'comfyengi_upscale/a.png')
    expect(r.inputs).not.toBeNull()
    expect(seedsOf(r.inputs)).toEqual([])
    expect(r.inputs!.find((x) => x.source === 'positive')!.value).toBe('1girl')
    const c = r.issues.find((x) => x.level === 'confirm')!
    expect(c.text).toMatch(/^无法确定原图的 Seed（.*#20.*）：#8（KSampler） 的 seed 保持放大工作流的值（5）$/)
    // 旧数据（恢复结果中没有 seed 字段）同样要求确认
    const { seed: _s, seed_note: _n, ...old } = recoverGeneration(gen(42))
    expect(upscaleInputs(wf(map), old, 'comfyengi_upscale/a.png').issues.some((x) => x.level === 'confirm' && x.text.includes('Seed'))).toBe(true)
  })

  it('样本放大工作流：映射到 #32 SeedNode 时二次采样使用原图的 Seed', () => {
    const map = [...SAMPLE_UP_MAP, newEntry(UPSCALE_SEED, '32', 'seed')]
    const r = upscaleInputs({ name: 's', api_json: SAMPLE_UP, mapping: map }, recoverGeneration(SAMPLE.prompt, { original: SAMPLE.prompt }), 'comfyengi_upscale/a.png')
    expect(r.issues.filter((x) => x.level !== 'note')).toEqual([])
    expect(seedsOf(r.inputs)).toEqual([['32', 277707860833163]])
  })
})
