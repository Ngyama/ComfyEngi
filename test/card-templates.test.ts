// 模板动作卡：占位符填入、轮流抽取、姿态模板选择、固定表情与随机行为、计划展开、旧动作卡转换。只做静态计算与临时文件读写，不连接 ComfyUI。

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cardTemplates, distinctTags, drawBehavior, drawTemplate, fillTemplate, legacyCardTemplates, legacyExpressionIds, legacyPick, moduleAnchor, pickedTemplates, setPicked, templatePlaceholders } from '@shared/card-templates'
import { newEntry } from '@shared/mapping'
import { expandTask, newCardItem } from '@shared/planner'
import type { ActionCard, Template, TaskItem } from '@shared/types'
import { migrateTemplateCards } from '../src/main/card-migration'
import { enqueueTask, loadPlanLibrary, planForTask } from '../src/main/plan'
import { createVault, openVault } from '../src/main/vault'
import { Lib, newStore, SAMPLE_WORKFLOW, tempDir } from './helpers'

const T = (id: number, positive: string, category = '', extra: Partial<Template> = {}): Template => ({ id, kind: 'card_tpl', name: `t${id}`, positive, negative: '', category, tags: '', note: '', sort: id, parent_id: 1, ...extra })

describe('占位符', () => {
  const V = { global: 'masterpiece, best quality,', scene: 'bedroom', camera: '', character: '1girl, char_a, red hair', outfit: 'school uniform', character2: '1boy', outfit2: '', extra: '' }
  it('按模板中的位置填入，其余文字原样保留', () => {
    const body = '{全局},\n{场景}, {镜头},\n{女特征}, {女服装},\nclosed eyes, (blush:1.2), missionary,\n{男特征}, {男服装}, gentle smile'
    expect(fillTemplate(body, V)).toBe('masterpiece, best quality,\nbedroom,\n1girl, char_a, red hair, school uniform,\nclosed eyes, (blush:1.2), missionary,\n1boy, gentle smile')
  })
  it('空内容去掉占位符和相邻的逗号；整行为空时删除这一行', () => {
    expect(fillTemplate('{镜头}, a, {男服装}', V)).toBe('a')
    expect(fillTemplate('a,\n{镜头}, {男服装},\nb', V)).toBe('a,\nb')
    expect(fillTemplate('{镜头}', V)).toBe('')
  })
  it('别名、{附加} 与追加', () => {
    expect(fillTemplate('{主角色}, x', V)).toBe('1girl, char_a, red hair, x')
    expect(fillTemplate('x, {附加}, y', { ...V, extra: 'sweat' })).toBe('x, sweat, y')
    expect(fillTemplate('x,', { ...V, extra: 'sweat' })).toBe('x, sweat')
    expect(fillTemplate('x', V)).toBe('x')
  })
  it('没有 {表情} 时表情写在 {女服装} 之后（服装为空时同样）；都没有时追加在末尾', () => {
    const body = '{女特征}, {女服装},\nmissionary,\n{男特征}, {男服装}'
    expect(fillTemplate(body, { ...V, expression: 'blush' })).toBe('1girl, char_a, red hair, school uniform, blush,\nmissionary,\n1boy')
    expect(fillTemplate(body, { ...V, outfit: '', expression: 'blush' })).toBe('1girl, char_a, red hair, blush,\nmissionary,\n1boy')
    expect(fillTemplate('a, {表情}, {女服装}', { ...V, expression: 'blush' })).toBe('a, blush, school uniform')
    expect(fillTemplate('a, b', { ...V, expression: 'blush' })).toBe('a, b, blush')
  })
  it('{行为} / {男表情}：写在占位符位置；没有占位符时行为写在 {男特征} 之前、男表情写在 {男服装} 之后；为空时不留痕迹', () => {
    const body = '{女特征},\nmissionary,\n{男特征}, {男服装}'
    expect(fillTemplate(body, { ...V, interaction: 'kiss', expression2: 'smile' })).toBe('1girl, char_a, red hair,\nmissionary,\nkiss, 1boy, smile')
    expect(fillTemplate('{行为}, a', { ...V, interaction: 'hug' })).toBe('hug, a')
    expect(fillTemplate('a, {行为},\nb', V)).toBe('a,\nb')
    // 没有任何锚点时追加在末尾
    expect(fillTemplate('a', { ...V, interaction: 'kiss' })).toBe('a, kiss')
    expect(moduleAnchor('{行为}, x', 'interaction')).toBeNull()
  })
  it('需求文档中的示例模板：换行、权重、动态语法原样保留；空模块整行去掉；{画风} 留空', () => {
    const body = '{全局}\n{画风}\n{场景}\n{镜头}\n\n{女特征}\n{女服装}\n{表情}\n\nmissionary, legs raised, (arms around neck:1.1), {smile|grin}\n\n{行为}\n\n{男特征}\n{男服装}\n{男表情}'
    expect(templatePlaceholders(body).unknown).toEqual([])
    const out = fillTemplate(body, { ...V, expression: 'blush', interaction: '', expression2: '' })
    expect(out).toBe('masterpiece, best quality\nbedroom\n\n1girl, char_a, red hair\nschool uniform\nblush\n\nmissionary, legs raised, (arms around neck:1.1), {smile|grin}\n\n1boy')
    // 模板自己写的连续空行保持不变
    expect(fillTemplate('a\n\n\nb', V)).toBe('a\n\n\nb')
  })
  it('无法识别的中文占位符报告出来；动态语法与角色名占位符不算', () => {
    expect(templatePlaceholders('{女服饰}, {a|b}, {角色名}, {char_tag}, {女特征}')).toEqual({ modules: new Set(['character']), unknown: ['{女服饰}'] })
    expect(fillTemplate('{女服饰}, {a|b}', V)).toBe('{女服饰}, {a|b}')
  })
})

describe('轮流抽取与行为', () => {
  const list = Array.from({ length: 20 }, (_, i) => i)
  it('20 个模板 20 张：每个模板正好一张', () => {
    const got = Array.from({ length: 20 }, (_, k) => drawTemplate(list, 7, 0, k))
    expect(new Set(got).size).toBe(20)
  })
  it('30 张：前 20 张覆盖全部，每个模板 1～2 张', () => {
    const got = Array.from({ length: 30 }, (_, k) => drawTemplate(list, 7, 0, k)!)
    expect(new Set(got.slice(0, 20)).size).toBe(20)
    const counts = list.map((x) => got.filter((g) => g === x).length)
    expect(Math.min(...counts)).toBe(1)
    expect(Math.max(...counts)).toBe(2)
  })
  it('同样的组合 Seed 结果相同；只有一个模板时总是它', () => {
    const a = Array.from({ length: 25 }, (_, k) => drawTemplate(list, 3, 1, k))
    expect(Array.from({ length: 25 }, (_, k) => drawTemplate(list, 3, 1, k))).toEqual(a)
    expect(drawTemplate(['only'], 3, 1, 9)).toBe('only')
    expect(drawTemplate([], 3, 1, 0)).toBeNull()
  })
  it('行为：没有候选时总是 null；有候选时在「无」和各候选之间大致等概率，同样的 Seed 可复现', () => {
    expect(Array.from({ length: 10 }, (_, k) => drawBehavior([], 1, 0, k))).toEqual(Array(10).fill(null))
    const draw = (seed: number) => Array.from({ length: 900 }, (_, k) => drawBehavior(['kiss', 'hug'], seed, 0, k))
    const got = draw(5)
    expect(draw(5)).toEqual(got)
    for (const v of [null, 'kiss', 'hug']) {
      const n = got.filter((x) => x === v).length
      expect(n).toBeGreaterThan(240)
      expect(n).toBeLessThan(360)
    }
    expect(draw(6)).not.toEqual(got)
  })
})

describe('姿态模板选择', () => {
  const all = [T(1, 'a', '抬脚'), T(2, 'b', '抬脚'), T(3, 'c', '贴近'), T(4, 'd', '')]
  const ids = (p: Parameters<typeof pickedTemplates>[1]) => pickedTemplates(all, p).map((t) => t.id)
  it('默认全部；取消的模板记录为排除；之后新增的模板默认参与；全部恢复时不保存设置', () => {
    expect(ids(undefined)).toEqual([1, 2, 3, 4])
    const p = setPicked(all, undefined, [3], false)
    expect(p).toEqual({ exclude: [3] })
    expect(pickedTemplates([...all, T(5, 'e')], p).map((t) => t.id)).toEqual([1, 2, 4, 5])
    expect(setPicked(all, p, [3], true)).toBeUndefined()
    expect(setPicked(all, undefined, [1, 2, 3, 4], false)).toEqual({ exclude: [1, 2, 3, 4] })
  })
  it('旧任务按子体位的选择仍然生效；第一次修改时转换为等价的排除列表', () => {
    const old = { categories: ['贴近'], include: [1] }
    expect(legacyPick(old)).toBe(true)
    expect(ids(old)).toEqual([1, 3])
    const next = setPicked(all, old, [3], false)!
    expect(legacyPick(next)).toBe(false)
    expect(ids(next)).toEqual([1])
  })
  it('自动摘要：与其他模板不同的标签', () => {
    const g = [T(1, '{女特征}, closed eyes, legs up, smile'), T(2, '{女特征}, open eyes, legs up, smile')]
    expect(distinctTags(g[0], g)).toEqual(['closed eyes'])
    expect(distinctTags(g[0], [g[0]])).toEqual([])
  })
  it('模板按手动顺序排列，旧版子体位分类不再影响顺序', () => {
    const list = cardTemplates({ id: 1, card: { templates: true, categories: ['贴近', '抬脚'] } }, [T(1, 'a', '抬脚'), T(2, 'b', '贴近'), T(3, 'c', '抬脚')])
    expect(list.map((t) => t.id)).toEqual([1, 2, 3])
  })
})

describe('计划展开', () => {
  const setup = (cardCfg: ActionCard = { templates: true }) => {
    const s = newStore()
    const lib = new Lib(s)
    const card = s.save('templates', { kind: 'position', name: '正常位', positive: '', negative: 'bad feet', card: cardCfg })
    const tpl = (name: string, positive: string, category = '', tags = '') => s.save('templates', { kind: 'card_tpl', parent_id: card, name, positive, category, tags })
    const kiss = s.save('templates', { kind: 'state', name: 'Kiss', positive: 'kiss', negative: 'no_kiss_neg' })
    const hug = s.save('templates', { kind: 'state', name: 'Hug', positive: 'hug' })
    const expand = (item: Partial<TaskItem>, extra: Record<string, unknown> = {}) => expandTask(lib.task([{ ...newCardItem(card, lib.outfitsA[0]), count: 4, camera_ids: [lib.pov], ...item }], extra), loadPlanLibrary(s), s.settings(), '任务')
    return { s, lib, card, tpl, kiss, hug, expand }
  }
  it('完整模板 + 占位符：正面按模板顺序，负面按模块，记录模板来源', () => {
    const { tpl, expand } = setup()
    tpl('抬脚01', '{全局},\n{镜头},\n{女特征}, {女服装},\nclosed eyes, legs up,\n{男特征}, {男服装}', '抬脚', '闭眼')
    const r = expand({ count: 1 })
    expect(r.errors).toEqual([])
    const u = r.units[0]
    expect(u.positive).toBe('masterpiece, best quality,\npov,\n1girl, char_a, red hair, outfit_a1,\nclosed eyes, legs up')
    expect(u.negative).toContain('lowres, bad anatomy')
    expect(u.negative).toContain('bad feet')
    expect(u.from_template).toBe(true)
    expect(u.meta).toMatchObject({ card: '正常位', template: '抬脚01', template_label: '闭眼', camera: 'POV' })
    expect(u.meta.picks).toEqual([{ pool: 'template', id: expect.any(Number), name: '抬脚01', random: false }])
  })
  it('第二角色出场时填入 {男特征} 与 {男表情}；单人卡不填', () => {
    const { lib, tpl, expand } = setup()
    tpl('a', '{女特征}, x, {男特征}, {男服装}, {男表情}')
    const duo = expand({ count: 1, second_outfit_id: lib.outfitsB[1], second_expression_id: lib.exprs[4] }, { second_character_id: lib.charB })
    expect(duo.units[0].positive).toBe('1girl, char_a, red hair, x, 1girl, char_b, outfit_b2, expr5')
    expect(duo.units[0].meta.expression2).toBe('表情5')
    const solo = setup({ templates: true, solo: true })
    solo.tpl('a', '{女特征}, x, {男特征}, {男表情}')
    expect(solo.expand({ count: 1, second_expression_id: solo.lib.exprs[4] }, { second_character_id: solo.lib.charB }).units[0].positive).toBe('1girl, char_a, red hair, x')
  })
  it('所有启用的姿态模板轮流使用（不按子体位分配）；排除的模板不参与；全部排除时报错', () => {
    const { tpl, expand } = setup()
    const ids = [tpl('a1', 'A1', '抬脚'), tpl('a2', 'A2', '抬脚'), tpl('a3', 'A3', '抬脚'), tpl('b1', 'B1', '贴近')]
    const units = expand({ count: 8 }).units
    const names = units.map((u) => u.meta.template)
    for (const n of ['a1', 'a2', 'a3', 'b1']) expect(names.filter((x) => x === n).length).toBe(2)
    expect(new Set(names.slice(0, 4))).toEqual(new Set(['a1', 'a2', 'a3', 'b1']))
    const only = expand({ count: 4, card_pick: { exclude: [ids[0], ids[1]] } }).units.map((u) => u.meta.template)
    expect(only.sort()).toEqual(['a3', 'a3', 'b1', 'b1'])
    // 旧任务按子体位的选择照常生效
    expect(new Set(expand({ count: 4, card_pick: { categories: ['贴近'] } }).units.map((u) => u.meta.template))).toEqual(new Set(['b1']))
    expect(expand({ count: 2, card_pick: { exclude: ids } }).errors.join()).toContain('没有启用任何姿态模板')
  })
  it('固定表情：本动作每张图都相同，写入 {表情}；没有 {表情} 时写在主角色服装之后', () => {
    const { lib, tpl, expand } = setup()
    tpl('a', '{女特征}, {女服装}, {表情}, legs up')
    tpl('b', '{女特征}, {女服装}, hug')
    const units = expand({ count: 6, expression_id: lib.exprs[1] }).units
    expect(units.every((u) => u.meta.expression === '表情2')).toBe(true)
    expect(new Set(units.map((u) => u.positive))).toEqual(new Set(['1girl, char_a, red hair, outfit_a1, expr2, legs up', '1girl, char_a, red hair, outfit_a1, expr2, hug']))
    expect(units[0].meta.picks?.find((p) => p.pool === 'expression')).toMatchObject({ name: '表情2', random: false })
    // 不选表情时不加表情
    expect(expand({ count: 1 }).units[0].positive).not.toContain('expr')
  })
  it('行为候选：每张独立随机 0～1 个，写入 {行为}；负面与动作卡负面一起；同样的组合 Seed 可复现；不选时不加', () => {
    const { tpl, kiss, hug, expand } = setup()
    tpl('a', '{女特征},\nmissionary,\n{行为},\n{男特征}')
    const r = expand({ count: 60, behavior_ids: [kiss, hug] }, { combo_seed: 42 })
    expect(r.errors).toEqual([])
    const acts = r.units.map((u) => u.meta.acts?.[0] ?? null)
    for (const v of [null, 'Kiss', 'Hug']) expect(acts.filter((x) => x === v).length).toBeGreaterThan(8)
    for (const u of r.units) {
      const act = u.meta.acts?.[0]
      expect(u.positive).toBe(`1girl, char_a, red hair,\nmissionary${act ? `,\n${act.toLowerCase()}` : ''}`)
      expect(u.negative.includes('no_kiss_neg')).toBe(act === 'Kiss')
      expect(u.negative).toContain('bad feet')
      expect((u.meta.acts?.length ?? 0) <= 1).toBe(true)
    }
    expect(expand({ count: 60, behavior_ids: [kiss, hug] }, { combo_seed: 42 }).units.map((u) => u.positive)).toEqual(r.units.map((u) => u.positive))
    expect(expand({ count: 60, behavior_ids: [kiss, hug] }, { combo_seed: 43 }).units.map((u) => u.positive)).not.toEqual(r.units.map((u) => u.positive))
    expect(expand({ count: 10 }).units.every((u) => !u.meta.acts)).toBe(true)
  })
  it('引用的表情、行为被删除时报错（不自动替换）；旧版模板表情设置只提示', () => {
    const { s, lib, card, tpl, kiss, expand } = setup()
    tpl('a', '{女特征}, x')
    s.remove('templates', lib.exprs[0])
    s.remove('templates', kiss)
    const r = expand({ count: 2, expression_id: lib.exprs[0], behavior_ids: [kiss] })
    expect(r.errors.join()).toContain('所选表情已被删除')
    expect(r.errors.join()).toContain('有行为候选已被删除')
    s.save('templates', { id: card, card: { templates: true, expressions: [lib.exprs[2]] } })
    expect(legacyExpressionIds(s.get('templates', card), [])).toEqual([lib.exprs[2]])
    const w = expand({ count: 1 })
    expect(w.errors).toEqual([])
    expect(w.warnings.join()).toContain('旧版的模板表情设置')
    expect(w.units[0].positive).toBe('1girl, char_a, red hair, x')
  })
  it('旧方式的动作（状态 + 行为固定叠加）结果不变', () => {
    const { s, lib, kiss, hug } = setup()
    const task = lib.task([{ ...lib.item('睡觉', lib.outfitsA[0], [], 2), act_ids: [kiss, hug] }])
    const r = expandTask(task, loadPlanLibrary(s), s.settings(), '任务')
    expect(r.errors).toEqual([])
    for (const u of r.units) {
      expect(u.positive).toContain('kiss, hug')
      expect(u.meta.acts).toEqual(['Kiss', 'Hug'])
    }
  })
  it('预览中手改单张 Prompt：使用手改内容；来源变化后阻止入队，等待选择', () => {
    const { tpl, expand } = setup()
    tpl('a', '{女特征}, x')
    const auto = expand({ count: 2 }).units[1]
    const edit = { k: 1, positive: '1girl, custom', negative: 'neg', base_positive: auto.positive, base_negative: auto.negative }
    const r = expand({ count: 2, prompt_edits: [edit] })
    expect(r.errors).toEqual([])
    expect(r.units[1]).toMatchObject({ positive: '1girl, custom', negative: 'neg', manual: true })
    expect(r.units[0].manual).toBeUndefined()
    const stale = expand({ count: 2, extra_positive: 'sweat', prompt_edits: [edit] })
    expect(stale.errors.join()).toContain('第 2 张：手改 Prompt 之后')
    expect(stale.units[1]).toMatchObject({ edit_stale: true, positive: '1girl, char_a, red hair, x, sweat' })
  })
  it('有内容但模板没有写占位符时提示；无法识别的占位符、没有模板时报错', () => {
    const { tpl, expand } = setup()
    expect(expand({}).errors.join()).toContain('还没有姿态模板')
    tpl('a', 'x, {女服饰}')
    const r = expand({ count: 1 })
    expect(r.errors.join()).toContain('{女服饰}')
    expect(r.warnings.join()).toContain('没有 {女特征}')
    expect(r.warnings.join()).toContain('没有 {全局}')
  })
  it('手改过 Prompt 的图片不能写入按模块拆分的映射（负面同样）', () => {
    const { s, lib, card, tpl } = setup()
    tpl('a', '{全局}, x')
    lib.addWorkflow([newEntry('positive', '6', 'text'), newEntry('negative', '7', 'text', ['global'])])
    const u = planForTask(s, lib.makeTask([{ ...newCardItem(card), count: 1 }])).units[0]
    expect(planForTask(s, lib.makeTask([{ ...newCardItem(card), count: 1 }], '套图1')).errors).toEqual([])
    const edited = lib.makeTask([{ ...newCardItem(card), count: 1, prompt_edits: [{ k: 0, positive: 'y', negative: '', base_positive: u.positive, base_negative: u.negative }] }], '套图2')
    expect(planForTask(s, edited).errors.join()).toContain('手改过 Prompt 的图片')
  })
  it('附加 Prompt：模板没有 {附加} 时追加在末尾', () => {
    const { tpl, expand } = setup()
    tpl('a', '{女特征}, x')
    expect(expand({ count: 1, extra_positive: 'sweat' }).units[0].positive).toBe('1girl, char_a, red hair, x, sweat')
  })
  it('正面 Prompt 按模块拆分的工作流不能用于模板动作卡；完整映射时预览与入队提交的 Prompt 一致（含表情与行为）', () => {
    const { s, lib, card, tpl, kiss, hug } = setup()
    tpl('a', '{全局}, {女特征}, {表情}, x, {行为}')
    tpl('b', '{全局}, {女特征}, {表情}, y, {行为}')
    const split = [newEntry('positive', '6', 'text', ['global']), newEntry('positive', '7', 'text', ['character']), newEntry('negative', '7', 'text')]
    lib.addWorkflow(split)
    const item = { ...newCardItem(card), count: 6, expression_id: lib.exprs[0], behavior_ids: [kiss, hug] }
    const task = lib.makeTask([item])
    expect(planForTask(s, task).errors.join()).toContain('模板动作卡需要写入完整的正面 Prompt')
    const wid = lib.addWorkflow([newEntry('positive', '6', 'text'), newEntry('negative', '7', 'text')], SAMPLE_WORKFLOW)
    const t2 = lib.makeTask([item], '套图2', { workflow_id: wid })
    const plan = planForTask(s, t2)
    expect(plan.errors).toEqual([])
    const { runId } = enqueueTask(s, t2)
    const units = s.listUnits(runId!)
    expect(units.map((u) => u.inputs.find((x) => x.node === '6')?.value)).toEqual(plan.units.map((u) => u.positive))
    expect(units.map((u) => u.inputs.find((x) => x.node === '7')?.value)).toEqual(plan.units.map((u) => u.negative))
    expect(units[0].inputs.find((x) => x.node === '6')?.value).toMatch(/^masterpiece, best quality, 1girl, char_a, red hair, expr1, [xy]/)
  })
})

describe('旧动作卡转换', () => {
  const legacy = () => {
    const root = tempDir()
    createVault(root)
    const s = openVault(root)
    const lib = new Lib(s)
    const state = s.save('templates', { kind: 'state', name: '抱颈', positive: 'arms around neck' })
    const card = s.save('templates', { kind: 'position', name: '正常位', positive: 'missionary', negative: 'bad', card: { pools: { expr: { fixed: [lib.exprs[0]], random: [lib.exprs[1], lib.exprs[2]] }, pose: { fixed: [state], random: [] } } } })
    const sub1 = s.save('templates', { kind: 'subposition', name: '抬腿', positive: 'legs up', parent_id: card })
    const sub2 = s.save('templates', { kind: 'subposition', name: '贴近', positive: 'close', parent_id: card })
    return { root, s, lib, card, sub1, sub2 }
  }
  it('每个子体位一个模板：基础 + 子体位 + 固定素材放进默认骨架；随机候选写入说明', () => {
    const { s, card } = legacy()
    const c = s.get('templates', card)!
    const subs = s.list('templates').filter((t) => t.kind === 'subposition')
    const { templates, note } = legacyCardTemplates(c, subs, (id) => s.get('templates', id))
    expect(templates.map((t) => t.name)).toEqual(['抬腿', '贴近'])
    expect(templates[0].positive).toBe('{全局},\n{场景}, {镜头},\n{女特征}, {女服装},\nmissionary, legs up, arms around neck, expr1,\n{男特征}, {男服装},\n{附加}')
    // 固定的表情1 已写进模板，说明里只列没有展开的随机候选
    expect(note).not.toContain('表情1')
    expect(note).toContain('表情2、表情3')
    s.close()
  })
  it('迁移：写入模板与卡设置、可重复执行；重新打开工作区时自动转换并备份', () => {
    const { root, s, card } = legacy()
    const backup = join(root, 'bk')
    const r = migrateTemplateCards(s, backup)
    expect(r).toMatchObject({ cards: 1, templates: 2, failed: [] })
    const c = s.get('templates', card)!
    expect(c.card).toMatchObject({ templates: true, categories: ['基础'] })
    expect(c.note).toContain('没有展开的随机候选')
    expect(cardTemplates(c, s.list('templates')).map((t) => [t.name, t.category])).toEqual([['抬腿', '基础'], ['贴近', '基础']])
    expect(existsSync(backup) && readdirSync(join(backup, 'prompts', 'positions')).length).toBe(3)
    expect(migrateTemplateCards(s).cards).toBe(0)
    s.close()

    const other = legacy()
    other.s.close()
    const again = openVault(other.root)
    expect(again.get('templates', other.card)!.card?.templates).toBe(true)
    expect(readdirSync(join(other.root, 'data', 'backups')).some((d) => d.startsWith('card-templates-'))).toBe(true)
    // 删除动作卡时模板一起移入回收站
    again.remove('templates', other.card)
    expect(again.list('templates').filter((t) => t.kind === 'card_tpl')).toEqual([])
    again.close()
  })
})
