// 主角色 / 第二角色：同一角色库、动作与表情在任务中分配、固定的 Prompt 组合顺序、第二角色 LoRA 的工作流映射检查。

import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { expandTask, newInteractionItem, PlanLibrary } from '@shared/planner'
import { DEFAULT_SETTINGS, type ApiWorkflow, type MappingEntry, type TaskItem } from '@shared/types'
import { enqueueTask, loadPlanLibrary, planForTask } from '../src/main/plan'
import { Store } from '../src/main/store'
import { createVault, openVault } from '../src/main/vault'
import { Lib, newStore, SAMPLE_MAPPING, SAMPLE_WORKFLOW, tempDir } from './helpers'

function setup(s: Store) {
  const lib = new Lib(s)
  const T = (kind: string, name: string, positive: string, extra: Record<string, unknown> = {}) => s.save('templates', { kind, name, positive, ...extra })
  const charM = s.save('characters', { name: '男角色', tag: 'char_m', positive: '1boy, char_m', loras: [{ name: 'charM.safetensors', strength: 0.7 }] })
  const suit = s.save('outfits', { character_id: charM, name: '西装', positive: 'suit' })
  const bedroom = T('scene', '卧室', 'bedroom')
  const missionary = T('position', '正常位', 'missionary')
  const legsUp = T('subposition', '抬腿', 'legs up', { parent_id: missionary })
  const hug = T('act', '拥抱', 'hug')
  const standing = T('pose', '站立', 'standing')
  const smile = T('expression', '微笑', 'smile')
  const named = T('expression', '看向{角色名}', 'looking at {角色名}')
  return { lib, charM, suit, bedroom, missionary, legsUp, hug, standing, smile, named }
}

const WF2: ApiWorkflow = {
  ...SAMPLE_WORKFLOW,
  '11': { class_type: 'LoraLoader', inputs: { lora_name: 'other.safetensors', strength_model: 1.0, strength_clip: 1.0, model: ['10', 0], clip: ['10', 1] } },
}
const MAP2: MappingEntry[] = [
  ...SAMPLE_MAPPING,
  { source: 'second_lora1_name', node: '11', input: 'lora_name', modules: [], template: '' },
  { source: 'second_lora1_strength', node: '11', input: 'strength_model', modules: [], template: '' },
  { source: 'second_lora1_strength', node: '11', input: 'strength_clip', modules: [], template: '' },
]

describe('双角色 Prompt 组合', () => {
  it('按 全局 → 场景 → 镜头 → 主角色（外貌、服装、动作、表情）→ 双人互动 → 第二角色 的顺序组合，原样保留文本', () => {
    const s = newStore()
    const f = setup(s)
    const item: TaskItem = {
      ...newInteractionItem(f.missionary, f.legsUp, f.lib.outfitsA[0], true),
      pose_id: f.lib.poses['睡觉'],
      expression_ids: [f.lib.exprs[0]],
      act_ids: [f.hug],
      camera_id: f.lib.pov,
      scene_id: f.bedroom,
      second_outfit_id: f.suit,
      second_pose_id: f.standing,
      second_expression_id: f.smile,
      count: 1,
    }
    const { units, errors } = expandTask(f.lib.task([item], { second_character_id: f.charM }), loadPlanLibrary(s), s.settings())
    expect(errors).toEqual([])
    const u = units[0]
    expect(u.positive).toBe('masterpiece, best quality,\n\nbedroom,\n\npov,\n\n1girl, char_a, red hair,\n\noutfit_a1,\n\nsleeping, lying,\n\nexpr1,\n\nmissionary, legs up, hug,\n\n1boy, char_m,\n\nsuit,\n\nstanding,\n\nsmile')
    expect(u.modules.character2).toEqual(['1boy, char_m', ''])
    expect(u.modules.content2).toEqual(['standing', ''])
    expect(u.meta).toMatchObject({ character: '角色A', character2: '男角色', outfit2: '西装', action2: '站立', expression2: '微笑' })
    expect(u.loras).toEqual([{ name: 'charA.safetensors', strength: 0.8 }])
    expect(u.loras2).toEqual([{ name: 'charM.safetensors', strength: 0.7 }])
  })

  it('第二角色按动作启用：未启用的动作是单人图片，不包含第二角色的任何内容', () => {
    const s = newStore()
    const f = setup(s)
    const data = f.lib.task([f.lib.item('睡觉', null, [], 1, { second_pose_id: f.standing }), f.lib.item('鸭子坐', null, [], 1, { second_enabled: true })], { second_character_id: f.charM })
    const { units, errors } = expandTask(data, loadPlanLibrary(s), s.settings())
    expect(errors).toEqual([])
    expect(units[0].positive).not.toMatch(/char_m|standing/)
    expect(Object.keys(units[0].modules)).not.toContain('character2')
    expect(units[0].loras2).toBeUndefined()
    expect(units[0].meta.character2).toBeUndefined()
    expect(units[1].positive).toBe('masterpiece, best quality,\n\n1girl, char_a, red hair,\n\nwariza,\n\n1boy, char_m')
  })

  it('同一个动作 / 表情素材可以分别分配给两个角色；占位符按各自角色填充', () => {
    const s = newStore()
    const f = setup(s)
    const item = f.lib.item('动作A', null, [f.named], 1, { second_enabled: true, second_pose_id: f.lib.poses['动作A'], second_expression_id: f.named })
    const u = expandTask(f.lib.task([item], { second_character_id: f.charM }), loadPlanLibrary(s), s.settings()).units[0]
    expect(u.modules.content[0]).toBe('action_a')
    expect(u.modules.content2[0]).toBe('action_a')
    expect(u.modules.expression[0]).toBe('looking at 角色A')
    expect(u.modules.expression2[0]).toBe('looking at 男角色')
  })

  it('主角色与第二角色可以是同一个角色库中的任意角色（不区分性别）', () => {
    const s = newStore()
    const f = setup(s)
    const data = f.lib.task([f.lib.item('睡觉', null, [], 1, { second_enabled: true, second_outfit_id: f.lib.outfitsB[0] })], { second_character_id: f.lib.charB })
    const r = expandTask(data, loadPlanLibrary(s), s.settings())
    expect(r.errors).toEqual([])
    expect(r.units[0].positive).toBe('masterpiece, best quality,\n\n1girl, char_a, red hair,\n\nsleeping, lying,\n\n1girl, char_b,\n\noutfit_b1')
    expect(r.units[0].loras2).toBeUndefined() // 角色 B 没有 LoRA
  })

  it('配置错误给出明确提示：未选择第二角色、服装不属于第二角色、第二角色已删除', () => {
    const s = newStore()
    const f = setup(s)
    const L = () => loadPlanLibrary(s)
    expect(expandTask(f.lib.task([f.lib.item('睡觉', null, [], 1, { second_enabled: true })]), L(), s.settings()).errors[0]).toContain('还没有选择第二角色')
    const wrong = f.lib.task([f.lib.item('睡觉', null, [], 1, { second_enabled: true, second_outfit_id: f.lib.outfitsA[0] })], { second_character_id: f.charM })
    expect(expandTask(wrong, L(), s.settings()).errors[0]).toContain('不属于角色「男角色」')
    s.remove('characters', f.charM)
    expect(expandTask(f.lib.task([f.lib.item('睡觉', null, [], 1)], { second_character_id: f.charM }), L(), s.settings()).errors).toContain('所选第二角色已被删除')
  })

  it('剧情场景的「男性出场」在选择了第二角色时由第二角色出场（代替旧版男性基础描述）', () => {
    const s = newStore()
    const f = setup(s)
    const sid = s.save('stories', { genre: 'g', name: 's', scenes: [{ name: 'a', positive: 'scene_a', negative: '', count: 1, with_male: true }, { name: 'b', positive: 'scene_b', negative: '', count: 1, with_male: false }] })
    // 没有第二角色：沿用旧版男性基础描述
    expect(expandTask(f.lib.task([], { story_id: sid }), loadPlanLibrary(s), s.settings()).units[0].positive).toContain('MALE_BASE_TAG')
    const { units } = expandTask(f.lib.task([], { story_id: sid, second_character_id: f.charM }), loadPlanLibrary(s), s.settings())
    expect(units[0].positive).toBe('masterpiece, best quality,\n\n1girl, char_a, red hair,\n\nscene_a,\n\n1boy, char_m')
    expect(units[0].loras2).toEqual([{ name: 'charM.safetensors', strength: 0.7 }])
    expect(units[1].positive).not.toContain('char_m')
  })

  it('旧的单人任务（没有第二角色字段）计划结构不变', () => {
    const s = newStore()
    const lib = new Lib(s)
    const data = lib.task([lib.item('睡觉', lib.outfitsA[0], [lib.exprs[0]], 1, { male_enabled: true, male_ids: [lib.maleAct] })])
    for (const it of data.items) for (const k of ['second_enabled', 'second_outfit_id', 'second_pose_id', 'second_expression_id']) delete (it as unknown as Record<string, unknown>)[k]
    const u = expandTask(data, loadPlanLibrary(s), s.settings()).units[0]
    expect(Object.keys(u.modules).sort()).toEqual(['camera', 'character', 'content', 'expression', 'extra', 'global', 'male', 'outfit'])
    expect('loras2' in u).toBe(false)
    expect(u.modules.male[0]).toBe('1boy, MALE_BASE_TAG, MALE_ACTION')
  })
})

describe('第二角色 LoRA 与工作流映射', () => {
  it('工作流没有第二角色 LoRA 映射时不能入队，而不是静默丢弃', () => {
    const s = newStore()
    const f = setup(s)
    f.lib.addWorkflow()
    const t = f.lib.makeTask([f.lib.item('睡觉', null, [], 1, { second_enabled: true })], '双人', { second_character_id: f.charM })
    const p = planForTask(s, t)
    expect(p.errors.some((e) => e.includes('第二角色「男角色」的 LoRA「charM.safetensors」已启用，但当前工作流没有绑定 LoRA Loader'))).toBe(true)
    expect(enqueueTask(s, t).runId).toBeNull()
  })

  it('映射后写入第二个 LoRA 节点；第二角色未出场的图片强度写 0、名称保持原值', () => {
    const s = newStore()
    const f = setup(s)
    f.lib.addWorkflow(MAP2, WF2)
    const t = f.lib.makeTask([f.lib.item('睡觉', null, [], 1, { second_enabled: true }), f.lib.item('鸭子坐', null, [], 1)], '双人', { second_character_id: f.charM })
    const p = planForTask(s, t)
    expect(p.errors).toEqual([])
    const val = (i: number) => p.units[i].inputs!.filter((x) => x.node === '11').map((x) => [x.input, x.value])
    expect(val(0)).toEqual([['lora_name', 'charM.safetensors'], ['strength_model', 0.7], ['strength_clip', 0.7]])
    expect(val(1)).toEqual([['lora_name', null], ['strength_model', 0], ['strength_clip', 0]])
    // 主角色 LoRA 槽位不受影响
    expect(p.units[1].inputs!.find((x) => x.source === 'lora1_name')!.value).toBe('charA.safetensors')
    // 预览与提交一致，入队后快照不随角色修改改变
    expect(p.units[0].inputs!.find((x) => x.source === 'positive')!.value).toBe(p.units[0].positive)
    const run = enqueueTask(s, t).runId!
    const snap = s.listUnits(run)
    s.save('characters', { id: f.charM, positive: 'CHANGED' })
    expect(s.listUnits(run)).toEqual(snap)
    expect(snap[0].positive).toContain('1boy, char_m')
  })

  it('只映射了第二角色 LoRA 名称、没有映射强度时提示无法在单人图片中禁用', () => {
    const s = newStore()
    const f = setup(s)
    f.lib.addWorkflow(MAP2.filter((m) => m.source !== 'second_lora1_strength'), WF2)
    const p = planForTask(s, f.lib.makeTask([f.lib.item('睡觉', null, [], 1)], 't', { second_character_id: f.charM }))
    expect(p.errors.some((e) => e.includes('第二角色 LoRA 1 在部分图片中没有要加载的 LoRA') && e.includes('Loader 11 无法安全禁用'))).toBe(true)
  })

  it('主角色 LoRA 不在工作流中、也没有可追加的 Loader 时不能入队（可在任务中停用）；Prompt 节点只拼接部分模块时提示未包含的第二角色模块', () => {
    const s = newStore()
    const f = setup(s)
    const map = SAMPLE_MAPPING.filter((m) => !m.source.startsWith('lora')).map((m) => (m.source === 'positive' ? { ...m, modules: ['global', 'character', 'content'] } : m))
    // 工作流中的标准 Loader 加载的是画风 LoRA：不会被角色 LoRA 自动覆盖
    f.lib.addWorkflow(map, { ...SAMPLE_WORKFLOW, '10': { ...SAMPLE_WORKFLOW['10'], inputs: { ...SAMPLE_WORKFLOW['10'].inputs, lora_name: 'style.safetensors' } } })
    const t = f.lib.makeTask([f.lib.item('睡觉', null, [], 1, { second_enabled: true })], 't', { second_character_id: f.lib.charB })
    expect(planForTask(s, t).errors.some((e) => e.includes('主角色「角色A」的 LoRA「charA」不在当前工作流的 LoRA 列表中'))).toBe(true)
    s.save('tasks', { id: t.id, data: { ...t.data, lora_overrides: { lora1: { enabled: false } } } })
    const p = planForTask(s, s.get('tasks', t.id)!)
    expect(p.errors).toEqual([])
    expect(p.warnings.some((w) => w.includes('没有包含模块「第二角色」'))).toBe(true)
  })

  it('PlanLibrary 在界面中构造的结果与主进程一致', () => {
    const s = newStore()
    const f = setup(s)
    const data = f.lib.task([f.lib.item('睡觉', null, [f.smile], 2, { second_enabled: true, second_pose_id: f.standing })], { second_character_id: f.charM })
    const L2 = new PlanLibrary(s.list('templates'), s.list('characters'), s.list('outfits'), s.list('stories'))
    expect(expandTask(data, L2, s.settings())).toEqual(expandTask(data, loadPlanLibrary(s), s.settings()))
  })
})

describe('简化后的素材编辑', () => {
  it('只保存名称与正面 Prompt 时，旧文件中的分类、标签、适用对象、负面、备注保持不变', () => {
    const root = tempDir()
    createVault(root)
    const s = openVault(root)
    const id = s.save('templates', { kind: 'pose', name: '旧姿态', positive: 'old', negative: 'bad', category: '站立', tags: 't1', note: 'n', target: 'female' })
    s.save('templates', { id, name: '新名称', positive: 'new (tag:1.2)' })
    s.close()
    const s2 = openVault(root)
    expect(s2.get('templates', id)).toMatchObject({ name: '新名称', positive: 'new (tag:1.2)', negative: 'bad', category: '站立', tags: 't1', note: 'n', target: 'female' })
    s2.close()
  })
})

describe('组合顺序设置升级', () => {
  it('仍是旧版默认顺序时升级一次；自定义顺序保持不变', () => {
    const dir = tempDir()
    const a = join(dir, 'a.db')
    let s = new Store(a)
    s.setSetting('compose_order', ['global', 'character', 'outfit', 'content', 'expression', 'male', 'camera', 'extra'])
    s.db.exec("DELETE FROM settings WHERE key='compose_order_rev'")
    s.close()
    s = new Store(a)
    expect(s.settings().compose_order).toEqual(DEFAULT_SETTINGS.compose_order)
    // 升级后用户再改回旧顺序，不会被再次覆盖
    s.setSetting('compose_order', ['global', 'character', 'outfit', 'content', 'expression', 'male', 'camera', 'extra'])
    s.close()
    s = new Store(a)
    expect(s.settings().compose_order[1]).toBe('character')
    s.close()

    const b = join(dir, 'b.db')
    s = new Store(b)
    s.setSetting('compose_order', ['camera', 'global', 'character'])
    s.db.exec("DELETE FROM settings WHERE key='compose_order_rev'")
    s.close()
    s = new Store(b)
    expect(s.settings().compose_order).toEqual(['camera', 'global', 'character'])
    s.close()
  })
})
