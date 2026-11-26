// 人物动作 Prompt 库：锚点识别、拼接、计划展开、文件保存与入队冻结。只做静态计算与临时文件读写，不连接 ComfyUI。

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { actionIndex, actionLabel, composeActionPrompt, fromLegacyTemplate, legacyPlaceholders, orphanPrompts, promptAnchors, tagAnchors } from '@shared/action-prompts'
import { newEntry } from '@shared/mapping'
import { expandTask, newActionItem, setItemSizes } from '@shared/planner'
import { itemRefIds, itemSummary, presetFromItems, presetStatus } from '@shared/presets'
import type { TaskItem, Template } from '@shared/types'
import { enqueueTask, loadPlanLibrary, planForTask } from '../src/main/plan'
import { Store } from '../src/main/store'
import { createVault, openVault } from '../src/main/vault'
import { Lib, newStore, SAMPLE_MAPPING, SAMPLE_WORKFLOW, tempDir } from './helpers'

const SPEC = '1girl, shy, {closed eyes|half-closed eyes}, (open mouth:1.2), hands on chest, trembling, spread legs\n1man, missionary, grabbing hips, kissing'

describe('锚点识别', () => {
  it('只认独立的 Tag：逗号、换行分隔，大小写不敏感，不认 1girls / my1girl', () => {
    expect(tagAnchors('1girl, a', '1girl').top).toEqual([{ start: 0, end: 5 }])
    expect(tagAnchors('a,\n  1GIRL  ,b', '1girl').top.length).toBe(1)
    expect(tagAnchors('a，1girl，b', '1girl').top.length).toBe(1)
    expect(tagAnchors('1girls, my1girl, 1girl_solo', '1girl')).toEqual({ top: [], nested: 0 })
  })
  it('括号、权重、Wildcard 内的不能作为锚点（单独计数）；转义括号不算括号', () => {
    expect(tagAnchors('(1girl:1.2), a', '1girl')).toEqual({ top: [], nested: 1 })
    expect(tagAnchors('{1girl, smile|2girls}, a', '1girl')).toEqual({ top: [], nested: 1 })
    expect(tagAnchors('[1girl], a', '1girl')).toEqual({ top: [], nested: 1 })
    expect(tagAnchors('artist \\(x\\), 1girl', '1girl').top.length).toBe(1)
    // 括号内的逗号不切分顶层 Tag
    expect(tagAnchors('{a, b|c}, 1girl, (d, e:1.1)', '1girl').top.length).toBe(1)
  })
  it('多个独立 Tag', () => {
    expect(tagAnchors('1girl, a\n1girl, b', '1girl').top.length).toBe(2)
  })
})

describe('拼接', () => {
  const full = { global: 'masterpiece, best quality,', scene: 'bedroom', camera: 'from above', extra: 'sweat' }
  it('需求示例：全局、场景、镜头在前；角色特征与服装插在 1girl / 1man 之后；附加在末尾', () => {
    const r = composeActionPrompt({ body: SPEC, ...full, female: ['char_a, red hair', 'school uniform'], male: ['old man, beard', 'suit'] })
    expect(r.positive).toBe(
      'masterpiece, best quality,\nbedroom, from above,\n\n' +
        '1girl, char_a, red hair, school uniform, shy, {closed eyes|half-closed eyes}, (open mouth:1.2), hands on chest, trembling, spread legs\n' +
        '1man, old man, beard, suit, missionary, grabbing hips, kissing,\n\nsweat',
    )
    expect(r.problems).toEqual([])
    expect(r.inserted).toEqual({ female: true, male: true })
  })
  it('空模块跳过，不产生多余的逗号；没有附加时 Prompt 末尾保持原样', () => {
    const r = composeActionPrompt({ body: '1girl, smile,', global: '', scene: '', camera: 'pov', extra: '', female: ['', 'dress'], male: null })
    expect(r.positive).toBe('pov,\n\n1girl, dress, smile,')
    expect(composeActionPrompt({ body: '1girl, smile', female: [] }).positive).toBe('1girl, smile')
    expect(composeActionPrompt({ body: '1girl', female: ['a'] }).positive).toBe('1girl, a')
  })
  it('只有 1girl 的单人 Prompt；没有第二角色时 1man 部分原样保留', () => {
    expect(composeActionPrompt({ body: '1girl, solo, smile', female: ['char_a'], male: ['old man'] }).positive).toBe('1girl, char_a, solo, smile')
    expect(composeActionPrompt({ body: '1girl, a\n1man, b', female: ['char_a'], male: null }).positive).toBe('1girl, char_a, a\n1man, b')
  })
  it('Wildcard、权重、换行、空行与 Tag 顺序保持原样（只在锚点之后插入）', () => {
    const body = '1girl, __mood/shy__, {a|b|c}, (blush:1.3), [smile:grin:0.5],\n\n  <lora:x:0.5>, z, y, x\n1man, {1-2$$kiss|hug}'
    const r = composeActionPrompt({ body, female: ['F'], male: ['M'] })
    expect(r.positive).toBe(body.replace('1girl', '1girl, F').replace('1man', '1man, M').trim())
    expect(composeActionPrompt({ body }).positive).toBe(body.trim())
  })
  it('缺少锚点、括号内锚点、重复锚点：不插入，报告问题', () => {
    const miss = composeActionPrompt({ body: 'solo, smile', female: ['char_a'] })
    expect(miss.positive).toBe('solo, smile')
    expect(miss.problems[0]).toMatchObject({ who: 'female', problem: 'missing' })
    expect(composeActionPrompt({ body: '(1girl:1.1), a', female: ['x'] }).problems[0].problem).toBe('nested')
    const dup = composeActionPrompt({ body: '1girl, a\n1man, b\n1man, c', female: ['x'], male: ['y'] })
    expect(dup.problems.map((p) => [p.who, p.problem])).toEqual([['male', 'multiple']])
    expect(dup.positive).toBe('1girl, x, a\n1man, b\n1man, c')
    // 没有内容要插入时不检查锚点
    expect(composeActionPrompt({ body: 'solo', female: ['', '  '] }).problems).toEqual([])
  })
  it('旧版占位符：识别出来以便提示；导入旧版姿态模板时去掉占位符', () => {
    expect(legacyPlaceholders('{全局},\n{女特征}, {a|b}, x')).toEqual(['{全局}', '{女特征}'])
    expect(fromLegacyTemplate('{全局},\n{场景}, {镜头},\n{女特征}, {女服装}, {表情},\n1girl, missionary, {a|b},\n{行为},\n{男特征}, {男服装},\n{附加}')).toBe('1girl, missionary, {a|b}')
  })
})

/** 情绪组 × 视角 × 体位 的测试素材 */
function prompts(s: Store) {
  const mood = (name: string) => s.save('templates', { kind: 'mood', name })
  const posture = (name: string) => s.save('templates', { kind: 'posture', name })
  const m1 = mood('惊讶')
  const m2 = mood('害羞')
  const pA = posture('体位 A')
  const pB = posture('体位 B')
  const act = (m: number, pov: boolean, p: number, positive: string, negative = '') => s.save('templates', { kind: 'action', mood_id: m, pov, posture_id: p, positive, negative })
  return { m1, m2, pA, pB, act }
}

describe('计划展开', () => {
  const setup = () => {
    const s = newStore()
    const lib = new Lib(s)
    const p = prompts(s)
    s.save('characters', { id: lib.charA, positive: 'char_a, red hair' })
    const scene = s.save('templates', { kind: 'scene', name: '卧室', positive: 'bedroom' })
    const male = s.save('characters', { name: '男角色', positive: 'old man, beard', loras: [{ name: 'man.safetensors', strength: 0.7 }] })
    const maleSuit = s.save('outfits', { character_id: male, name: '西装', positive: 'suit' })
    return { s, lib, ...p, scene, male, maleSuit }
  }
  const exp = (s: Store, data: ReturnType<Lib['task']>) => expandTask(data, loadPlanLibrary(s), s.settings(), '任务')

  it('一个任务多个 Prompt 条目；每张都使用同一份 Prompt；尺寸与张数展开', () => {
    const { s, lib, m1, m2, pA, pB, act, scene } = setup()
    const a1 = act(m1, true, pA, '1girl, surprised, {a|b}')
    const a2 = act(m2, false, pB, '1girl, shy, blush')
    const it1 = { ...newActionItem(a1, lib.outfitsA[0]), scene_id: scene, extra_positive: 'sweat' }
    setItemSizes(it1, { portrait: 2, landscape: 1, square: 0 })
    const it2 = { ...newActionItem(a2), camera_ids: [lib.pov] }
    setItemSizes(it2, { portrait: 0, landscape: 0, square: 3 })
    const r = exp(s, lib.task([it1, it2]))
    expect(r.errors).toEqual([])
    expect(r.units.length).toBe(6)
    expect(r.units.map((u) => u.meta.size)).toEqual(['竖图', '竖图', '横图', '方图', '方图', '方图'])
    expect(r.units.map((u) => u.item_label)).toEqual([...Array(3).fill('惊讶 / POV / 体位 A'), ...Array(3).fill('害羞 / 非 POV / 体位 B')])
    expect(r.units[0].positive).toBe('masterpiece, best quality,\nbedroom,\n\n1girl, char_a, red hair, outfit_a1, surprised, {a|b},\n\nsweat')
    expect(new Set(r.units.slice(0, 3).map((u) => u.positive)).size).toBe(1)
    expect(r.units[3].positive).toBe('masterpiece, best quality,\npov,\n\n1girl, char_a, red hair, shy, blush')
    expect(r.units[0]).toMatchObject({ from_template: true, width: 1024, height: 1536, loras: [{ name: 'charA.safetensors' }] })
    expect(r.units[0].meta.action).toEqual({ id: a1, mood: '惊讶', view: 'POV', posture: '体位 A' })
    // 负面仍按模块拼接（全局负面 + Prompt 自己的负面）
    expect(r.units[0].negative).toBe('lowres, bad anatomy')
    expect(r.units.map((u) => u.seed)).toEqual([1000, 1001, 1002, 1003, 1004, 1005])
    s.close()
  })

  it('第二角色：Prompt 中有 1man 时出场（特征、服装、LoRA）；没有 1man 时单人并提示；没有选第二角色时男性部分原样保留', () => {
    const { s, lib, m1, pA, pB, act, male, maleSuit } = setup()
    const duo = act(m1, true, pA, '1girl, a\n1man, b')
    const solo = act(m1, true, pB, '1girl, solo')
    const items = [{ ...newActionItem(duo), second_outfit_id: maleSuit, count: 1 }, { ...newActionItem(solo), count: 1 }]
    const r = exp(s, lib.task(items, { second_character_id: male }))
    expect(r.errors).toEqual([])
    expect(r.units[0].positive).toBe('masterpiece, best quality,\n\n1girl, char_a, red hair, a\n1man, old man, beard, suit, b')
    expect(r.units[0].loras2).toEqual([{ name: 'man.safetensors', strength: 0.7 }])
    expect(r.units[0].meta).toMatchObject({ character2: '男角色', outfit2: '西装' })
    expect(r.units[1].loras2).toBeUndefined()
    expect(r.units[1].meta.character2).toBeUndefined()
    expect(r.warnings.join()).toContain('没有 1man，第二角色「男角色」不出场')
    const alone = exp(s, lib.task([{ ...newActionItem(duo), count: 1 }]))
    expect(alone.errors).toEqual([])
    expect(alone.units[0].positive).toBe('masterpiece, best quality,\n\n1girl, char_a, red hair, a\n1man, b')
    expect(alone.units[0].loras2).toBeUndefined()
    s.close()
  })

  it('缺少锚点、重复锚点、Prompt 被删除或为空：明确报错，不静默插入', () => {
    const { s, lib, m1, pA, pB, act, male } = setup()
    const none = act(m1, true, pA, 'solo, smile')
    const two = act(m1, false, pA, '1girl, a\n1man, b\n1man, c')
    const empty = act(m1, false, pB, '  ')
    const items: TaskItem[] = [newActionItem(none), newActionItem(two), newActionItem(empty), newActionItem(99999)].map((x) => ({ ...x, count: 1 }))
    const r = exp(s, lib.task(items, { second_character_id: male }))
    expect(r.errors.find((e) => e.startsWith('第 1 个动作'))).toContain('没有独立的 1girl')
    expect(r.errors.find((e) => e.startsWith('第 2 个动作'))).toContain('2 个独立的 1man')
    expect(r.errors.find((e) => e.startsWith('第 3 个动作'))).toContain('Prompt 内容为空')
    expect(r.errors.find((e) => e.startsWith('第 4 个动作'))).toContain('已被删除')
    // 主角色没有特征也没有服装时不需要 1girl
    s.save('characters', { id: lib.charA, positive: '' })
    expect(exp(s, lib.task([{ ...newActionItem(none), count: 1 }])).errors).toEqual([])
    s.close()
  })

  it('提示：旧版占位符、角色基础 Prompt 中也有 1girl', () => {
    const { s, lib, m1, pA, act } = setup()
    s.save('characters', { id: lib.charA, positive: '1girl, char_a' })
    const a = act(m1, true, pA, '{全局},\n1girl, a')
    const r = exp(s, lib.task([{ ...newActionItem(a), count: 1 }]))
    expect(r.warnings.join('\n')).toContain('旧版模板占位符 {全局}')
    expect(r.warnings.join('\n')).toContain('基础 Prompt 中也有 1girl')
    s.close()
  })

  it('单张 Prompt 手改：基础结果不变时使用手改；Prompt 修改后要求重新选择', () => {
    const { s, lib, m1, pA, act } = setup()
    const a = act(m1, true, pA, '1girl, a')
    const it = { ...newActionItem(a), count: 2 }
    const base = exp(s, lib.task([it])).units[1]
    it.prompt_edits = [{ k: 1, positive: 'edited', negative: 'n', base_positive: base.positive, base_negative: base.negative }]
    const r = exp(s, lib.task([it]))
    expect(r.units[1]).toMatchObject({ positive: 'edited', negative: 'n', manual: true })
    expect(r.units[0].manual).toBeUndefined()
    s.save('templates', { id: a, positive: '1girl, b' })
    const stale = exp(s, lib.task([it]))
    expect(stale.units[1].edit_stale).toBe(true)
    expect(stale.errors.join()).toContain('手改 Prompt 之后')
    s.close()
  })

  it('旧任务的动作（状态、动作卡）不受影响', () => {
    const { s, lib } = setup()
    const r = exp(s, lib.task([lib.item('睡觉', lib.outfitsA[0], [], 2)]))
    expect(r.errors).toEqual([])
    expect(r.units[0].from_template).toBeUndefined()
    expect(r.units[0].modules.content[0]).toBe('sleeping, lying')
    s.close()
  })
})

describe('工作流映射与入队', () => {
  it('完整 Prompt 映射写入拼接结果；入队后修改素材不影响冻结的计划', () => {
    const s = newStore()
    const lib = new Lib(s)
    lib.addWorkflow()
    const { m1, pA, act } = prompts(s)
    const a = act(m1, true, pA, '1girl, a,\n{x|y}')
    const tid = s.save('tasks', { name: '套图', data: lib.task([{ ...newActionItem(a, lib.outfitsA[1]), count: 2 }]) })
    const task = s.get('tasks', tid)!
    const plan = planForTask(s, task)
    expect(plan.errors).toEqual([])
    const pos = plan.units[0].inputs!.find((x) => x.source === 'positive')!
    expect(pos.value).toBe(plan.units[0].positive)
    // 测试角色的基础 Prompt 自带 1girl：照样插入并提示重复
    expect(pos.value).toBe('masterpiece, best quality,\n\n1girl, 1girl, char_a, red hair, outfit_a2, a,\n{x|y}')
    expect(plan.warnings.join()).toContain('基础 Prompt 中也有 1girl')
    expect(plan.units[0].inputs!.find((x) => x.source === 'lora1_name')?.value).toBe('charA.safetensors')
    const { runId } = enqueueTask(s, task)
    expect(runId).toBeTruthy()
    s.save('templates', { id: a, positive: '1girl, CHANGED' })
    s.save('templates', { id: m1, name: '改名' })
    const units = s.listUnits(runId!)
    expect(units.map((u) => u.positive)).toEqual([pos.value, pos.value])
    expect(units[0].meta.action).toMatchObject({ mood: '惊讶' })
    expect(units[0].inputs.find((x) => x.source === 'positive')?.value).toBe(pos.value)
    expect(planForTask(s, task).units[0].positive).toContain('CHANGED')
    s.close()
  })
  it('正面 Prompt 按模块拆分的工作流：不能入队（不静默改变提交内容）', () => {
    const s = newStore()
    const lib = new Lib(s)
    lib.addWorkflow([...SAMPLE_MAPPING.filter((m) => m.source !== 'positive'), newEntry('positive', '6', 'text', ['global', 'content'])], SAMPLE_WORKFLOW)
    const { m1, pA, act } = prompts(s)
    const tid = s.save('tasks', { name: '套图', data: lib.task([{ ...newActionItem(act(m1, true, pA, '1girl, a')), count: 1 }]) })
    expect(planForTask(s, s.get('tasks', tid)!).errors.join()).toContain('人物动作 Prompt 需要写入完整的正面 Prompt')
    s.close()
  })
})

describe('预设', () => {
  it('引用 Prompt ID；Prompt 修改或删除时提示；摘要显示分类', () => {
    const s = newStore()
    const lib = new Lib(s)
    const { m1, pA, act } = prompts(s)
    const a = act(m1, true, pA, '1girl, a')
    const it = { ...newActionItem(a, lib.outfitsA[0]), count: 3 }
    expect(itemRefIds(it)).toContain(a)
    const data = presetFromItems([it], { templates: s.list('templates'), outfits: s.list('outfits') })
    expect(data.refs[String(a)]).toMatchObject({ name: '惊讶 / POV / 体位 A', kind: 'action' })
    expect(data.items[0].action_id).toBe(a)
    const byId = (id: number) => s.list('templates').find((t) => t.id === id)
    expect(itemSummary(it, byId, 'A服装1')).toEqual(['惊讶 / POV / 体位 A', 'A服装1', '3张'])
    s.save('templates', { id: a, positive: '1girl, b' })
    expect(presetStatus(data, s.list('templates')).changed).toEqual(['惊讶 / POV / 体位 A'])
    s.remove('templates', a)
    expect(presetStatus(data, s.list('templates')).missing).toEqual(['惊讶 / POV / 体位 A'])
    expect(itemSummary(it, byId)[0]).toBe('（Prompt 已删除）')
    s.close()
  })
})

describe('Prompt 库存储', () => {
  const vault = () => {
    const root = tempDir()
    createVault(root)
    return { root, s: openVault(root) }
  }
  it('原始 Prompt 保存后读取完全一致（换行、引号、权重、Wildcard、全角符号、行尾空格）', () => {
    const { root, s } = vault()
    const { m1, pA, act } = prompts(s)
    const raw = '1girl, "quoted", \\(escaped\\), (a:1.2),\n\n  {x|y|z}, __w/c__,  \t\n1man, 中文，标签 , trailing   \n'
    const id = act(m1, true, pA, raw, 'neg\nline')
    s.close()
    const again = openVault(root)
    const t = again.get('templates', id)!
    expect(t.positive).toBe(raw)
    expect(t.negative).toBe('neg\nline')
    expect(t).toMatchObject({ kind: 'action', mood_id: m1, posture_id: pA, pov: true })
    expect(readdirSync(join(root, 'prompts', 'actions'))).toEqual(['惊讶 - POV - 体位 A.md'])
    expect(readFileSync(join(root, 'prompts', 'actions', '惊讶 - POV - 体位 A.md'), 'utf8')).toContain(JSON.stringify(raw))
    again.close()
  })
  it('分类改名、移动 Prompt 时文件名同步；复制情绪组复制其中全部 Prompt；删除分类连同 Prompt 移入回收站', () => {
    const { root, s } = vault()
    const { m1, m2, pA, pB, act } = prompts(s)
    const a = act(m1, true, pA, '1girl, a')
    act(m1, false, pB, '1girl, b')
    act(m2, true, pA, '1girl, c')
    s.save('templates', { id: m1, name: '吃惊' })
    expect(readdirSync(join(root, 'prompts', 'actions')).sort()).toEqual(['吃惊 - POV - 体位 A.md', '吃惊 - 非POV - 体位 B.md', '害羞 - POV - 体位 A.md'])
    s.save('templates', { id: a, pov: false })
    expect(readdirSync(join(root, 'prompts', 'actions'))).toContain('吃惊 - 非POV - 体位 A.md')
    const copy = s.duplicate('templates', m1)!
    const ix = actionIndex(s.list('templates'))
    expect(ix.moods.map((m) => m.name)).toEqual(['吃惊', '害羞', '吃惊 副本'])
    expect(ix.prompts.filter((t) => t.mood_id === copy).map((t) => t.positive).sort()).toEqual(['1girl, a', '1girl, b'])
    expect(ix.at(copy, false, pA).length).toBe(1)
    s.remove('templates', pA)
    const after = actionIndex(s.list('templates'))
    expect(after.prompts.map((t) => t.positive).sort()).toEqual(['1girl, b', '1girl, b'])
    expect(readdirSync(join(root, '.comfyengi', 'trash')).length).toBe(4)
    expect(orphanPrompts(after)).toEqual([])
    s.close()
  })
  it('SQLite 模式：新列由迁移添加，pov 读回后按布尔值使用', () => {
    const s = new Store(':memory:')
    const { m1, pA, act } = prompts(s)
    const id = act(m1, true, pA, '1girl')
    const t = s.get('templates', id)! as Template
    const label = actionLabel(t, (x) => s.get('templates', x))
    expect(label).toBe('惊讶 / POV / 体位 A')
    expect(promptAnchors(t.positive).girl.top.length).toBe(1)
    s.close()
  })
})
