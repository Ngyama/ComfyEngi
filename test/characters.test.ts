// 角色库简化后的数据兼容性：隐藏字段保留、旧多 LoRA 数据、触发词进入 Prompt 与执行快照。

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { newItem, newTaskData } from '@shared/planner'
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
    const plan = planForTask(s, task())
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

describe('LoRA 触发词', () => {
  it('启用的触发词加在基础 Prompt 前，原样保留语法，不自动去重；未启用的不加入', async () => {
    const { root, s, lib, task } = vault()
    const { r } = await managedLora(root, ['char_a', '(red hair:1.2)', 'unused'])
    s.save('characters', {
      id: lib.charA,
      loras: [{ resource_id: r.id, name: r.name, strength: 0.7, trigger_words: ['(red hair:1.2)', 'char_a'], custom_triggers: ['my_custom'] }],
    })
    const p = planForTask(s, task())
    expect(p.errors).toEqual([])
    expect(p.units[0].modules.character[0]).toBe('(red hair:1.2), char_a, 1girl, char_a, red hair')
    expect(p.units[0].positive).toContain('(red hair:1.2), char_a, 1girl')
    expect(p.units[0].positive).not.toContain('unused')
    expect(p.units[0].positive).not.toContain('my_custom')
    // 基础 Prompt 本身没有被改写
    expect(s.get('characters', lib.charA)!.positive).toBe('1girl, char_a, red hair')
    s.close()
  })

  it('触发词进入预览、实际写入的节点值和执行快照；LoRA 名称与强度正确映射', async () => {
    const { root, s, lib, task } = vault()
    const { r } = await managedLora(root)
    s.save('characters', { id: lib.charA, loras: [{ resource_id: r.id, name: r.name, strength: 0.65, trigger_words: ['char_a'] }] })
    const t = task()
    const preview = planForTask(s, t)
    const inputs = Object.fromEntries(preview.units[0].inputs!.map((x) => [x.source, x.value]))
    expect(inputs.positive).toBe(preview.units[0].positive)
    expect(String(inputs.positive)).toContain('char_a, 1girl')
    expect([inputs.lora1_name, inputs.lora1_strength]).toEqual(['chars\\A.safetensors', 0.65])
    const runId = enqueueTask(s, t).runId!
    const unit = s.listUnits(runId)[0]
    expect(unit.positive).toBe(preview.units[0].positive)
    expect(unit.inputs.find((x) => x.source === 'positive')?.value).toBe(preview.units[0].positive)
    s.close()
  })

  it('已加入队列的任务不受之后的触发词修改影响', async () => {
    const { root, s, lib, task } = vault()
    const { r } = await managedLora(root)
    s.save('characters', { id: lib.charA, loras: [{ resource_id: r.id, name: r.name, strength: 1, trigger_words: [] }] })
    const runId = enqueueTask(s, task()).runId!
    const snapshot = s.listUnits(runId)
    s.save('characters', { id: lib.charA, loras: [{ resource_id: r.id, name: r.name, strength: 1, trigger_words: ['char_a', 'red hair'] }] })
    expect(s.listUnits(runId)).toEqual(snapshot)
    expect(snapshot[0].positive).not.toContain('char_a, red hair, 1girl')
    s.close()
  })

  it('触发词保存在 Vault 的角色文件中，不修改 LoRA 的 metadata.json 与模型文件', async () => {
    const { root, s, lib } = vault()
    const { models, r } = await managedLora(root)
    const meta = readFileSync(join(models, 'A.metadata.json'))
    const model = readFileSync(join(models, 'A.safetensors'))
    s.save('characters', { id: lib.charA, loras: [{ resource_id: r.id, name: r.name, strength: 1, trigger_words: ['red hair'], custom_triggers: ['extra'] }] })
    const row = decode(readFileSync(s.files!.entries.get(`characters:${lib.charA}`)!.path, 'utf8'))
    expect(row.loras[0].trigger_words).toEqual(['red hair'])
    expect(row.loras[0].custom_triggers).toEqual(['extra'])
    expect(readFileSync(join(models, 'A.metadata.json'))).toEqual(meta)
    expect(readFileSync(join(models, 'A.safetensors'))).toEqual(model)
    s.close()
  })
})
