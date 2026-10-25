// 角色库简化后的数据兼容性：隐藏字段保留、旧多 LoRA 数据、触发词进入 Prompt 与执行快照。

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { newItem, newTaskData } from '@shared/planner'
import { prependTags, promptTags } from '@shared/prompt'
import { decode } from '../src/main/file-library'
import { LoraManager } from '../src/main/lora-manager'
import { enqueueTask, planForTask } from '../src/main/plan'
import { createVault, openVault } from '../src/main/vault'
import { Lib, SAMPLE_MAPPING, SAMPLE_WORKFLOW, tempDir } from './helpers'

function vault() {
  const root = tempDir()
  createVault(root)
  const s = openVault(root)
  const lib = new Lib(s)
  const wf = s.save('workflows', { name: 'wf', api_json: SAMPLE_WORKFLOW, mapping: SAMPLE_MAPPING })
  const task = (extra = {}) => {
    const id = s.save('tasks', { name: 't', data: { ...newTaskData(), seed_base: 1, character_id: lib.charA, workflow_id: wf, items: [newItem(lib.poses['睡觉'], lib.outfitsA[0])], ...extra } })
    return s.get('tasks', id)!
  }
  return { root, s, lib, task }
}

async function managedLora(root: string, triggers = ['char_a', 'red hair']) {
  const models = tempDir()
  const header = Buffer.from(JSON.stringify({ __metadata__: {} }))
  const n = Buffer.alloc(8)
  n.writeBigUInt64LE(BigInt(header.length))
  writeFileSync(join(models, 'A.safetensors'), Buffer.concat([n, header, Buffer.alloc(16)]))
  writeFileSync(join(models, 'A.metadata.json'), JSON.stringify({ model_name: 'Char A', civitai: { trainedWords: triggers } }))
  const m = new LoraManager(root)
  await m.scan([models])
  const r = (await m.list())[0]
  await m.save({ ...r, comfyName: 'chars\\A.safetensors' })
  return { models, r: (await m.list())[0] }
}

describe('角色库兼容性', () => {
  it('保存时不发送的隐藏字段（角色标签、负面 Prompt）原样保留在 Markdown 文件中', () => {
    const { s, lib } = vault()
    const before = s.get('characters', lib.charA)!
    s.save('characters', { id: lib.charA, tag: 'char_a_tag', negative: 'NEG (x:1.2)' })
    // 角色库页面只发送 name / positive / loras / note
    s.save('characters', { id: lib.charA, name: '新名字', positive: 'new base', loras: before.loras, note: 'n' })
    const after = s.get('characters', lib.charA)!
    expect([after.name, after.positive, after.tag, after.negative]).toEqual(['新名字', 'new base', 'char_a_tag', 'NEG (x:1.2)'])
    const file = s.files!.entries.get(`characters:${lib.charA}`)!.path
    const row = decode(readFileSync(file, 'utf8'))
    expect([row.tag, row.negative]).toEqual(['char_a_tag', 'NEG (x:1.2)'])
    s.close()
  })

  it('{角色标签} 占位符仍使用隐藏的角色标签', () => {
    const { s, lib, task } = vault()
    s.save('characters', { id: lib.charA, tag: 'hidden_tag' })
    s.save('templates', { id: lib.poses['睡觉'], positive: 'sleeping {角色标签}' })
    expect(planForTask(s, task()).units[0].positive).toContain('sleeping hidden_tag')
    s.close()
  })

  it('旧版多 LoRA 数据不被覆盖，仍按槽位映射名称与强度', () => {
    const { s, lib, task } = vault()
    const loras = [
      { name: 'charA.safetensors', strength: 0.8 },
      { name: 'style.safetensors', strength: 0.5 },
      { name: 'detail.safetensors', strength: 0.3 },
    ]
    s.save('characters', { id: lib.charA, loras })
    s.save('characters', { id: lib.charA, name: '只改名称', positive: 'p', loras: s.get('characters', lib.charA)!.loras, note: '' })
    expect(s.get('characters', lib.charA)!.loras).toEqual(loras)
    // 槽位 2、3 没有绑定 Loader：启用时不能入队（不静默丢弃），在任务中禁用后即可生成
    expect(planForTask(s, task()).errors.filter((e) => e.includes('没有绑定 LoRA Loader')).length).toBe(2)
    const t = task()
    s.save('tasks', { id: t.id, data: { ...t.data, lora_overrides: { lora2: { enabled: false }, lora3: { enabled: false } } } })
    const plan = planForTask(s, s.get('tasks', t.id)!)
    expect(plan.errors).toEqual([])
    const v = Object.fromEntries(plan.units[0].inputs!.map((x) => [x.source, x.value]))
    expect([v.lora1_name, v.lora1_strength]).toEqual(['charA.safetensors', 0.8])
    s.close()
  })

  it('旧角色文件（没有触发词字段）生成计划不变', () => {
    const { s, task } = vault()
    const p = planForTask(s, task())
    expect(p.errors).toEqual([])
    expect(p.units[0].modules.character).toEqual(['1girl, char_a, red hair', ''])
    s.close()
  })
})

describe('触发词与服装（简化后）', () => {
  it('旧角色已启用的触发词不再自动拼接；预览给出未合并提示，不修改任何数据', async () => {
    const { root, s, lib, task } = vault()
    const { r } = await managedLora(root)
    s.save('characters', { id: lib.charA, loras: [{ resource_id: r.id, name: r.name, strength: 0.7, trigger_words: ['char_a', '(red hair:1.2)'] }] })
    const before = s.get('characters', lib.charA)!
    const p = planForTask(s, task())
    expect(p.errors).toEqual([])
    expect(p.units[0].modules.character).toEqual(['1girl, char_a, red hair', ''])
    expect(p.warnings.some((w) => w.includes('尚未合并到基础 Prompt') && w.includes('(red hair:1.2)'))).toBe(true)
    expect(s.get('characters', lib.charA)).toEqual(before) // 生成计划不会静默修改角色
    s.close()
  })

  it('合并辅助：加在开头，逐个标签去重，原文与特殊语法保持不变', () => {
    expect(prependTags('1girl, Char_A,\n(red hair:1.2)', ['char_a', '(red hair:1.2)', 'blue eyes', ' blue eyes ', ''])).toEqual({
      text: 'blue eyes, 1girl, Char_A,\n(red hair:1.2)',
      added: ['blue eyes'],
      skipped: ['char_a', '(red hair:1.2)', 'blue eyes'],
    })
    expect(prependTags('', ['a', 'b']).text).toBe('a, b')
    expect(prependTags('x, y', ['x']).text).toBe('x, y') // 不重复追加
    expect(promptTags('a,\nb ,  c')).toEqual(['a', 'b', 'c'])
  })

  it('用户确认合并后：触发词只通过基础 Prompt 进入预览、节点值与执行快照；已入队任务不受影响', async () => {
    const { root, s, lib, task } = vault()
    const { r } = await managedLora(root)
    s.save('characters', { id: lib.charA, loras: [{ resource_id: r.id, name: r.name, strength: 0.65, trigger_words: ['char_trigger'] }] })
    const old = enqueueTask(s, task()).runId!
    const oldSnapshot = s.listUnits(old)
    // 角色库中的「合并到基础 Prompt」：基础 Prompt 加入触发词，并清空旧的启用列表
    const ch = s.get('characters', lib.charA)!
    s.save('characters', { id: lib.charA, positive: prependTags(ch.positive, ['char_trigger']).text, loras: ch.loras.map((l) => ({ ...l, trigger_words: [] })) })
    const t = task()
    const p = planForTask(s, t)
    expect(p.warnings.some((w) => w.includes('尚未合并'))).toBe(false)
    expect(p.units[0].modules.character[0]).toBe('char_trigger, 1girl, char_a, red hair')
    const v = Object.fromEntries(p.units[0].inputs!.map((x) => [x.source, x.value]))
    expect(v.positive).toBe(p.units[0].positive)
    expect([v.lora1_name, v.lora1_strength]).toEqual(['chars\\A.safetensors', 0.65]) // 默认权重行为保留
    const run = enqueueTask(s, t).runId!
    expect(s.listUnits(run)[0].positive).toBe(p.units[0].positive)
    expect(s.listUnits(old)).toEqual(oldSnapshot)
    expect(oldSnapshot[0].positive).not.toContain('char_trigger')
    s.close()
  })

  it('服装只保存名称与 Positive 时，旧的负面 Prompt 与备注保留', () => {
    const { s, lib } = vault()
    const oid = lib.outfitsA[0]
    s.save('outfits', { id: oid, negative: 'old neg', note: 'old note' })
    s.save('outfits', { id: oid, name: '改名', positive: 'new outfit' })
    const o = s.get('outfits', oid)!
    expect([o.name, o.positive, o.negative, o.note]).toEqual(['改名', 'new outfit', 'old neg', 'old note'])
    const row = decode(readFileSync(s.files!.entries.get(`outfits:${oid}`)!.path, 'utf8'))
    expect([row.negative, row.note]).toEqual(['old neg', 'old note'])
    s.close()
  })

  it('角色保存不发送备注与权重时，旧值保留', () => {
    const { s, lib } = vault()
    s.save('characters', { id: lib.charA, note: '旧备注' })
    const ch = s.get('characters', lib.charA)!
    s.save('characters', { id: lib.charA, name: 'A2', positive: ch.positive, loras: ch.loras })
    const after = s.get('characters', lib.charA)!
    expect([after.note, after.loras[0].strength]).toEqual(['旧备注', 0.8])
    s.close()
  })

  it('导入触发词只写入角色文件与新服装文件，不修改 metadata.json 与模型文件', async () => {
    const { root, s, lib } = vault()
    const { models } = await managedLora(root)
    const meta = readFileSync(join(models, 'A.metadata.json'))
    const model = readFileSync(join(models, 'A.safetensors'))
    const ch = s.get('characters', lib.charA)!
    s.save('characters', { id: lib.charA, positive: prependTags(ch.positive, ['char_a', 'red hair', 'new_tag']).text })
    s.save('outfits', { character_id: lib.charA, name: '导入的服装', positive: 'school uniform' })
    expect(s.get('characters', lib.charA)!.positive).toBe('new_tag, 1girl, char_a, red hair')
    expect(s.listOutfits(lib.charA)).toHaveLength(6)
    expect(readFileSync(join(models, 'A.metadata.json'))).toEqual(meta)
    expect(readFileSync(join(models, 'A.safetensors'))).toEqual(model)
    s.close()
  })
})
