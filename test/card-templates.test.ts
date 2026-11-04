// 模板动作卡：占位符填入、轮流抽取、模板来源选择、计划展开、旧动作卡转换。只做静态计算与临时文件读写，不连接 ComfyUI。

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cardTemplates, distinctTags, drawTemplate, fillTemplate, legacyCardTemplates, pickedTemplates, splitBySubposition, splitSummary, templateExpressionIds, templatePlaceholders, toggleCategory, toggleTemplate } from '@shared/card-templates'
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
  it('无法识别的中文占位符报告出来；动态语法与角色名占位符不算', () => {
    expect(templatePlaceholders('{女服饰}, {a|b}, {角色名}, {char_tag}, {女特征}')).toEqual({ modules: new Set(['character']), unknown: ['{女服饰}'] })
    expect(fillTemplate('{女服饰}, {a|b}', V)).toBe('{女服饰}, {a|b}')
  })
})

describe('轮流抽取', () => {
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
})

describe('模板来源', () => {
  const all = [T(1, 'a', '抬脚'), T(2, 'b', '抬脚'), T(3, 'c', '贴近'), T(4, 'd', '')]
  const ids = (p: Parameters<typeof pickedTemplates>[1]) => pickedTemplates(all, p).map((t) => t.id)
  it('默认全部；取消分类；之后加入分类的模板自动参与', () => {
    expect(ids(undefined)).toEqual([1, 2, 3, 4])
    const p = toggleCategory(all, undefined, '贴近', false)
    expect(ids(p)).toEqual([1, 2, 4])
    expect(pickedTemplates([...all, T(5, 'e', '抬脚')], p).map((t) => t.id)).toEqual([1, 2, 4, 5])
  })
  it('单独勾选与排除；全部恢复后不保存设置', () => {
    let p = toggleCategory(all, undefined, '贴近', false)
    p = toggleTemplate(all, p, all[2], true)
    p = toggleTemplate(all, p, all[0], false)
    expect(ids(p)).toEqual([2, 3, 4])
    p = toggleTemplate(all, p, all[0], true)
    p = toggleCategory(all, p, '贴近', true)
    expect(p).toEqual({})
  })
  it('自动摘要：与同组模板不同的标签', () => {
    const g = [T(1, '{女特征}, closed eyes, legs up, smile'), T(2, '{女特征}, open eyes, legs up, smile')]
    expect(distinctTags(g[0], g)).toEqual(['closed eyes'])
    expect(distinctTags(g[0], [g[0]])).toEqual([])
  })
})

describe('计划展开', () => {
  const setup = (cardCfg: ActionCard = { templates: true, categories: ['抬脚', '贴近'] }) => {
    const s = newStore()
    const lib = new Lib(s)
    const card = s.save('templates', { kind: 'position', name: '正常位', positive: '', negative: 'bad feet', card: cardCfg })
    const tpl = (name: string, positive: string, category: string, tags = '') => s.save('templates', { kind: 'card_tpl', parent_id: card, name, positive, category, tags })
    const expand = (item: Partial<TaskItem>, extra: Record<string, unknown> = {}) => expandTask(lib.task([{ ...newCardItem(card, lib.outfitsA[0]), count: 4, camera_ids: [lib.pov], ...item }], extra), loadPlanLibrary(s), s.settings(), '任务')
    return { s, lib, card, tpl, expand }
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
    expect(u.meta).toMatchObject({ card: '正常位', template: '抬脚01', template_category: '抬脚', template_label: '闭眼', camera: 'POV' })
    expect(u.meta.picks).toEqual([{ pool: 'template', id: expect.any(Number), name: '抬脚01', random: false }])
  })
  it('第二角色出场时填入 {男特征}；单人卡不填', () => {
    const { lib, tpl, expand } = setup()
    tpl('a', '{女特征}, x, {男特征}, {男服装}', '抬脚')
    const duo = expand({ count: 1, second_outfit_id: lib.outfitsB[1] }, { second_character_id: lib.charB })
    expect(duo.units[0].positive).toBe('1girl, char_a, red hair, x, 1girl, char_b, outfit_b2')
    const solo = setup({ templates: true, solo: true })
    solo.tpl('a', '{女特征}, x, {男特征}', '')
    expect(solo.expand({ count: 1 }, { second_character_id: solo.lib.charB }).units[0].positive).toBe('1girl, char_a, red hair, x')
  })
  it('张数按子体位平分（与模板数量无关），子体位内轮流；只从勾选的子体位生成', () => {
    const { tpl, expand } = setup()
    const ids = [tpl('a1', 'A1', '抬脚'), tpl('a2', 'A2', '抬脚'), tpl('a3', 'A3', '抬脚'), tpl('b1', 'B1', '贴近')]
    const units = expand({ count: 8 }).units
    const by = (cat: string) => units.filter((u) => u.meta.template_category === cat).map((u) => u.meta.template)
    expect(by('抬脚').length).toBe(4)
    expect(by('贴近')).toEqual(['b1', 'b1', 'b1', 'b1'])
    expect(new Set(by('抬脚').slice(0, 3))).toEqual(new Set(['a1', 'a2', 'a3']))
    // 子体位交错排列：多尺寸时每种尺寸都有各个子体位
    expect(units.slice(0, 2).map((u) => u.meta.template_category).sort()).toEqual(['抬脚', '贴近'])
    const only = expand({ count: 4, card_pick: { categories: ['贴近'], include: [ids[0]] } }).units.map((u) => u.meta.template)
    expect(only.filter((x) => x === 'a1').length).toBe(2)
    expect(only.filter((x) => x === 'b1').length).toBe(2)
    expect(expand({ count: 2, card_pick: { categories: [], exclude: ids } }).errors.join()).toContain('没有选中任何子体位')
  })
  it('除不尽时多出的张数随机分给几个子体位（由组合 Seed 决定，可复现）', () => {
    const split = splitBySubposition(4, 10, 7, 0)
    const quota = [0, 1, 2, 3].map((g) => split.filter((s) => s.group === g).length)
    expect(quota.sort()).toEqual([2, 2, 3, 3])
    expect(splitBySubposition(4, 10, 7, 0)).toEqual(split)
    const seeds = new Set(Array.from({ length: 12 }, (_, s) => JSON.stringify([0, 1, 2, 3].map((g) => splitBySubposition(4, 10, s, 0).filter((x) => x.group === g).length))))
    expect(seeds.size).toBeGreaterThan(1)
    expect(splitBySubposition(3, 2, 1, 0).map((s) => s.index)).toEqual([0, 0])
    expect(splitSummary(4, 10)).toBe('每个子体位 2～3 张（多出的 2 张随机分配）')
  })
  it('表情：模板 × 表情组成组合轮流使用；写入 {表情} 的位置；模板单独选择时代替体位默认表情', () => {
    const { s, lib, card, tpl, expand } = setup()
    const [shy, happy, open] = lib.exprs
    s.save('templates', { id: card, card: { templates: true, categories: ['抬脚', '贴近'], expressions: [shy, happy] } })
    tpl('a', '{女特征}, legs up, {表情}, after', '抬脚')
    const own = tpl('b', '{女特征}, hug', '贴近')
    s.save('templates', { id: own, card: { expressions: [open] } })
    const units = expand({ count: 4 }).units
    const a = units.filter((u) => u.meta.template === 'a')
    expect(a.map((u) => u.positive).sort()).toEqual(['1girl, char_a, red hair, legs up, expr1, after', '1girl, char_a, red hair, legs up, expr2, after'])
    expect(a.map((u) => u.meta.expression).sort()).toEqual(['表情1', '表情2'])
    expect(a[0].meta.picks?.map((p) => p.pool)).toEqual(['template', 'expression'])
    // 模板没有 {表情}：写在主角色（服装）之后
    expect(units.filter((u) => u.meta.template === 'b').map((u) => u.positive)).toEqual(['1girl, char_a, red hair, expr3, hug', '1girl, char_a, red hair, expr3, hug'])
    expect(templateExpressionIds({ card: null }, s.get('templates', card))).toEqual([shy, happy])
    // 删除的表情跳过并提示
    s.remove('templates', happy)
    const r = expand({ count: 2, card_pick: { categories: ['抬脚'] } })
    expect(r.units.map((u) => u.meta.expression)).toEqual(['表情1', '表情1'])
    expect(r.warnings.join()).toContain('1 个表情已被删除')
  })
  it('预览中手改单张 Prompt：使用手改内容；来源变化后阻止入队，等待选择', () => {
    const { tpl, expand } = setup()
    tpl('a', '{女特征}, x', '抬脚')
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
    expect(expand({}).errors.join()).toContain('还没有 Prompt 模板')
    tpl('a', 'x, {女服饰}', '抬脚')
    const r = expand({ count: 1 })
    expect(r.errors.join()).toContain('{女服饰}')
    expect(r.warnings.join()).toContain('没有 {女特征}')
    expect(r.warnings.join()).toContain('没有 {全局}')
  })
  it('手改过 Prompt 的图片不能写入按模块拆分的映射（负面同样）', () => {
    const { s, lib, card, tpl } = setup()
    tpl('a', '{全局}, x', '抬脚')
    lib.addWorkflow([newEntry('positive', '6', 'text'), newEntry('negative', '7', 'text', ['global'])])
    const u = planForTask(s, lib.makeTask([{ ...newCardItem(card), count: 1 }])).units[0]
    expect(planForTask(s, lib.makeTask([{ ...newCardItem(card), count: 1 }], '套图1')).errors).toEqual([])
    const edited = lib.makeTask([{ ...newCardItem(card), count: 1, prompt_edits: [{ k: 0, positive: 'y', negative: '', base_positive: u.positive, base_negative: u.negative }] }], '套图2')
    expect(planForTask(s, edited).errors.join()).toContain('手改过 Prompt 的图片')
  })
  it('附加 Prompt：模板没有 {附加} 时追加在末尾', () => {
    const { tpl, expand } = setup()
    tpl('a', '{女特征}, x', '抬脚')
    expect(expand({ count: 1, extra_positive: 'sweat' }).units[0].positive).toBe('1girl, char_a, red hair, x, sweat')
  })
  it('正面 Prompt 按模块拆分的工作流不能用于模板动作卡；完整映射时入队快照与计划一致', () => {
    const { s, lib, card, tpl } = setup()
    tpl('a', '{全局}, {女特征}, x', '抬脚')
    const split = [newEntry('positive', '6', 'text', ['global']), newEntry('positive', '7', 'text', ['character']), newEntry('negative', '7', 'text')]
    lib.addWorkflow(split)
    const task = lib.makeTask([{ ...newCardItem(card), count: 2 }])
    expect(planForTask(s, task).errors.join()).toContain('模板动作卡需要写入完整的正面 Prompt')
    const wid = lib.addWorkflow([newEntry('positive', '6', 'text'), newEntry('negative', '7', 'text')], SAMPLE_WORKFLOW)
    const t2 = lib.makeTask([{ ...newCardItem(card), count: 2 }], '套图2', { workflow_id: wid })
    const plan = planForTask(s, t2)
    expect(plan.errors).toEqual([])
    const { runId } = enqueueTask(s, t2)
    const units = s.listUnits(runId!)
    expect(units.map((u) => u.inputs.find((x) => x.node === '6')?.value)).toEqual(plan.units.map((u) => u.positive))
    expect(units[0].inputs.find((x) => x.node === '6')?.value).toBe('masterpiece, best quality, 1girl, char_a, red hair, x')
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
