import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newItem, newTaskData } from '@shared/planner'
import type { ApiWorkflow, MappingEntry, TaskData, TaskItem } from '@shared/types'
import { Store } from '../src/main/store'

// 测试用的通用示例工作流（ComfyUI 默认文生图结构 + 一个 LoRA 节点），并非用户的真实工作流
export const SAMPLE_WORKFLOW: ApiWorkflow = {
  '3': { class_type: 'KSampler', inputs: { seed: 1, steps: 28, cfg: 5.5, sampler_name: 'euler_ancestral', scheduler: 'normal', denoise: 1.0, model: ['10', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'illustrious.safetensors' } },
  '5': { class_type: 'EmptyLatentImage', inputs: { width: 832, height: 1216, batch_size: 1 } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: '原正面', clip: ['10', 1] }, _meta: { title: '正面' } },
  '7': { class_type: 'CLIPTextEncode', inputs: { text: '原负面', clip: ['10', 1] }, _meta: { title: '负面' } },
  '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
  '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'ComfyUI', images: ['8', 0] } },
  '10': { class_type: 'LoraLoader', inputs: { lora_name: 'charA.safetensors', strength_model: 1.0, strength_clip: 1.0, model: ['4', 0], clip: ['4', 1] } },
}

export const SAMPLE_MAPPING: MappingEntry[] = [
  { source: 'positive', node: '6', input: 'text', modules: [], template: '' },
  { source: 'negative', node: '7', input: 'text', modules: [], template: '' },
  { source: 'seed', node: '3', input: 'seed', modules: [], template: '' },
  { source: 'lora1_name', node: '10', input: 'lora_name', modules: [], template: '' },
  { source: 'lora1_strength', node: '10', input: 'strength_model', modules: [], template: '' },
  { source: 'filename_prefix', node: '9', input: 'filename_prefix', modules: [], template: 'T/{序号}' },
]

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'comfyengi-test-'))
}

export function newStore(): Store {
  const s = new Store(join(tempDir(), 'test.db'))
  s.setSetting('poll_interval_sec', 0.05)
  return s
}

/** 在数据库中建立一套中性的测试素材 */
export class Lib {
  g: number
  charA: number
  charB: number
  outfitsA: number[]
  outfitsB: number[]
  poses: Record<string, number> = {}
  exprs: number[]
  maleBase: number
  maleAct: number
  pov: number
  above: number

  constructor(public store: Store) {
    const T = (kind: string, name: string, positive: string, negative = '', category = '') =>
      store.save('templates', { kind, name, positive, negative, category })
    this.g = T('global', '画质', 'masterpiece, best quality', 'lowres, bad anatomy')
    this.charA = store.save('characters', { name: '角色A', tag: 'char_a', positive: '1girl, char_a, red hair', negative: '', loras: [{ name: 'charA.safetensors', strength: 0.8 }] })
    this.charB = store.save('characters', { name: '角色B', tag: 'char_b', positive: '1girl, char_b', loras: [] })
    this.outfitsA = [1, 2, 3, 4, 5].map((i) => store.save('outfits', { character_id: this.charA, name: `A服装${i}`, positive: `outfit_a${i}` }))
    this.outfitsB = [1, 2, 3].map((i) => store.save('outfits', { character_id: this.charB, name: `B服装${i}`, positive: `outfit_b${i}` }))
    for (const [n, p] of [['睡觉', 'sleeping, lying'], ['鸭子坐', 'wariza'], ['动作A', 'action_a'], ['动作B', 'action_b'], ['动作C', 'action_c']])
      this.poses[n] = T('pose', n, p)
    this.exprs = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => T('expression', `表情${i}`, `expr${i}`))
    this.maleBase = T('male', '男性基础', '1boy, MALE_BASE_TAG', 'MALE_NEG', '基础')
    this.maleAct = T('male', '男性动作', 'MALE_ACTION')
    this.pov = T('camera', 'POV', 'pov')
    this.above = T('camera', '俯视', 'from above')
  }

  task(items: TaskItem[], extra: Partial<TaskData> = {}): TaskData {
    return { ...newTaskData(), character_id: this.charA, global_id: this.g, male_base_id: this.maleBase, seed_base: 1000, ...extra, items }
  }

  item(pose: string, outfit: number | null = null, exprs: number[] = [], count = 10, extra: Partial<TaskItem> = {}): TaskItem {
    return { ...newItem(this.poses[pose], outfit), expression_ids: [...exprs], count, ...extra }
  }

  addWorkflow(mapping: MappingEntry[] = SAMPLE_MAPPING, api: ApiWorkflow = SAMPLE_WORKFLOW): number {
    const wid = this.store.save('workflows', { name: '测试工作流', api_json: api, mapping })
    this.store.setSetting('default_workflow_id', wid)
    return wid
  }

  makeTask(items: TaskItem[], name = '套图1', extra: Partial<TaskData> = {}) {
    const id = this.store.save('tasks', { name, data: this.task(items, extra) })
    return this.store.get('tasks', id)!
  }
}

export async function waitUntil(cond: () => boolean, timeout = 10000): Promise<boolean> {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, 20))
  }
  return cond()
}
