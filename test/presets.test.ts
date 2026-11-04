// 动作序列预设与套图模板：保存、读取、插入、替换、服装槽位映射、素材更新提示、入队冻结。只做静态计算与临时数据库读写，不连接 ComfyUI。

import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { newEntry } from '@shared/mapping'
import { expandTask, newCardItem } from '@shared/planner'
import { defaultSlotMap, fingerprint, insertItems, itemsFromPreset, itemSummary, normalizePresetData, presetFromItems, presetMessages, presetStatus } from '@shared/presets'
import type { PresetData, TaskItem } from '@shared/types'
import { enqueueTask, loadPlanLibrary, planForTask } from '../src/main/plan'
import { SCHEMA_VERSION, Store } from '../src/main/store'
import { Lib, newStore, SAMPLE_WORKFLOW, tempDir } from './helpers'

const setup = () => {
  const s = newStore()
  const lib = new Lib(s)
  const card = s.save('templates', { kind: 'position', name: '正常位', positive: '', negative: '', card: { templates: true } })
  const tpl = (name: string, positive: string) => s.save('templates', { kind: 'card_tpl', parent_id: card, name, positive, category: '' })
  const legs = tpl('双腿抬起', '{女特征}, {女服装}, {表情}, legs up, {行为}')
  const hold = tpl('抱紧', '{女特征}, {女服装}, {表情}, holding, {行为}')
  const kiss = s.save('templates', { kind: 'state', name: 'Kiss', positive: 'kiss' })
  const hug = s.save('templates', { kind: 'state', name: 'Hug', positive: 'hug' })
  const item = (extra: Partial<TaskItem> = {}): TaskItem => ({ ...newCardItem(card, lib.outfitsA[0]), sizes: { portrait: 12, landscape: 4, square: 4 }, count: 20, expression_id: lib.exprs[0], behavior_ids: [kiss], camera_ids: [lib.pov, lib.above], ...extra })
  const ctx = () => ({ templates: s.list('templates'), outfits: s.list('outfits') })
  const plan = (items: TaskItem[], extra = {}) => expandTask(lib.task(items, { combo_seed: 9, ...extra }), loadPlanLibrary(s), s.settings(), '任务')
  return { s, lib, card, legs, hold, kiss, hug, item, ctx, plan }
}

describe('保存预设', () => {
  it('只保存引用与设置：手改 Prompt 不保存，服装换成槽位，记录素材指纹', () => {
    const { lib, card, legs, hold, kiss, item, ctx } = setup()
    const src = item({ prompt_edits: [{ k: 0, positive: 'x', negative: '', base_positive: '', base_negative: '' }], second_outfit_id: lib.outfitsB[0] })
    const d = presetFromItems([src, item({ outfit_id: lib.outfitsA[1] }), item()], ctx(), { task: '任务A' })
    expect(d.items).toHaveLength(3)
    expect(d.items[0]).not.toHaveProperty('prompt_edits')
    expect(d.items[0]).not.toHaveProperty('outfit_id')
    expect(d.items.map((x) => x.outfit_slot)).toEqual([1, 3, 1])
    expect(d.items[0].second_outfit_slot).toBe(2)
    expect(d.slots).toEqual([
      { key: 1, outfit_id: lib.outfitsA[0], name: 'A服装1' },
      { key: 2, second: true, outfit_id: lib.outfitsB[0], name: 'B服装1' },
      { key: 3, outfit_id: lib.outfitsA[1], name: 'A服装2' },
    ])
    expect(d.items[0]).toMatchObject({ card_id: card, expression_id: lib.exprs[0], behavior_ids: [kiss], sizes: { portrait: 12, landscape: 4, square: 4 } })
    expect(d.refs[String(card)].templates).toEqual([legs, hold])
    expect(Object.keys(d.refs).map(Number).sort((a, b) => a - b)).toEqual([card, legs, hold, kiss, lib.exprs[0], lib.pov, lib.above].sort((a, b) => a - b))
    expect(d.refs[String(legs)].hash).toBe(fingerprint({ positive: '{女特征}, {女服装}, {表情}, legs up, {行为}', negative: '' }))
    // 预设只保存引用：修改源任务的动作不影响预设
    src.expression_id = lib.exprs[3]
    expect(d.items[0].expression_id).toBe(lib.exprs[0])
  })
  it('存入数据库（presets 表）后读取不丢字段；旧数据缺字段时补默认值', () => {
    const { s, item, ctx } = setup()
    const data = presetFromItems([item()], ctx())
    const id = s.save('presets', { kind: 'action', name: '正常位 · 脸红', data })
    const back = s.get('presets', id)!
    expect(back).toMatchObject({ kind: 'action', name: '正常位 · 脸红' })
    expect(back.data).toEqual(data)
    const dup = s.duplicate('presets', id)!
    expect(s.get('presets', dup)!.name).toBe('正常位 · 脸红 副本')
    s.save('presets', { id, name: '改名' })
    expect(s.get('presets', id)!.data).toEqual(data)
    s.remove('presets', id)
    expect(s.list('presets').map((p) => p.id)).toEqual([dup])
    expect(normalizePresetData({ items: [{ card_id: 1 }] } as never)).toMatchObject({ items: [{ card_id: 1 }], slots: [], refs: {} })
  })
  it('旧版本数据库（v7）打开时自动建 presets 表，已有数据不变', () => {
    const dir = tempDir()
    const file = join(dir, 'db.sqlite')
    const first = new Store(file)
    const tid = first.save('tasks', { name: '旧任务', data: { items: [] } as never })
    first.db.exec('DROP TABLE presets; PRAGMA user_version=7')
    first.close()
    const raw = new DatabaseSync(file)
    expect((raw.prepare("SELECT name FROM sqlite_master WHERE name='presets'").all() as unknown[]).length).toBe(0)
    raw.close()
    const s = new Store(file)
    expect((s.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION)
    expect(s.list('presets')).toEqual([])
    expect(s.get('tasks', tid)!.name).toBe('旧任务')
    s.close()
  })
})

describe('导入预设', () => {
  it('导入同一角色：服装沿用，展开后的 Prompt 与源任务完全相同（同样的组合 Seed）', () => {
    const { s, lib, item, ctx, plan } = setup()
    const items = [item(), item({ outfit_id: lib.outfitsA[2], expression_id: lib.exprs[1] })]
    const data = presetFromItems(items, ctx())
    const map = defaultSlotMap(data, s.list('outfits'), lib.charA, null)
    expect(map).toEqual({ 1: lib.outfitsA[0], 2: lib.outfitsA[2] })
    const back = itemsFromPreset(data, map)
    expect(plan(back).units.map((u) => u.positive)).toEqual(plan(items).units.map((u) => u.positive))
    expect(plan(back).errors).toEqual([])
  })
  it('跨角色复用：每个槽位映射一次，应用到所有使用该槽位的动作；按名称匹配，没有时不指定', () => {
    const { s, lib, item, ctx } = setup()
    const data = presetFromItems([item(), item({ outfit_id: lib.outfitsA[1] }), item()], ctx())
    const c = s.save('characters', { name: '角色C', tag: 'char_c', positive: '1girl, char_c', loras: [] })
    const same = s.save('outfits', { character_id: c, name: 'A服装2', positive: 'c_outfit2' })
    expect(defaultSlotMap(data, s.list('outfits'), c, null)).toEqual({ 1: null, 2: same })
    const other = s.save('outfits', { character_id: c, name: '泳装', positive: 'swimsuit' })
    const back = itemsFromPreset(data, { 1: other, 2: same })
    expect(back.map((x) => x.outfit_id)).toEqual([other, same, other])
    expect(back[0]).not.toHaveProperty('outfit_slot')
    // 导入的是独立副本：修改不影响预设
    back[0].behavior_ids!.push(999)
    expect(data.items[0].behavior_ids).toHaveLength(1)
  })
  it('追加、插入到选中动作之后、明确替换；替换以外不改动原有动作', () => {
    const a = [1, 2, 3]
    expect(insertItems(a, [9, 8], 'append')).toEqual([1, 2, 3, 9, 8])
    expect(insertItems(a, [9, 8], 'after', 0)).toEqual([1, 9, 8, 2, 3])
    expect(insertItems(a, [9], 'after', null)).toEqual([1, 2, 3, 9])
    expect(insertItems(a, [9], 'replace')).toEqual([9])
    expect(a).toEqual([1, 2, 3])
  })
  it('整组套图模板：保存一段连续的动作，保持顺序，插入到另一个任务中间', () => {
    const { lib, item, ctx, plan } = setup()
    const items = [item({ expression_id: lib.exprs[0] }), item({ expression_id: lib.exprs[1] }), item({ expression_id: lib.exprs[2] }), item({ expression_id: lib.exprs[3] })]
    const data = presetFromItems(items.slice(1, 3), ctx(), { from: 2, to: 3 })
    expect(data.items.map((x) => x.expression_id)).toEqual([lib.exprs[1], lib.exprs[2]])
    const target = [item({ expression_id: lib.exprs[5] }), item({ expression_id: lib.exprs[6] })]
    const merged = insertItems(target, itemsFromPreset(data, { 1: lib.outfitsA[0] }), 'after', 0)
    expect(merged.map((x) => x.expression_id)).toEqual([lib.exprs[5], lib.exprs[1], lib.exprs[2], lib.exprs[6]])
    const r = plan(merged)
    expect(r.errors).toEqual([])
    expect([...new Set(r.units.map((u) => u.meta.expression))]).toEqual(['表情6', '表情2', '表情3', '表情7'])
  })
  it('序列摘要：动作卡 | 服装 | 表情 | 行为随机 | 张数', () => {
    const { s, lib, item, hug } = setup()
    const T = (id: number) => s.get('templates', id)
    expect(itemSummary(item({ behavior_ids: [s.list('templates').find((t) => t.name === 'Kiss')!.id, hug] }), T, 'A1').join(' | ')).toBe('正常位 | A1 | 表情1 | Kiss/Hug随机 | 20张')
    expect(itemSummary(item({ behavior_ids: [], expression_id: null }), T).join(' | ')).toBe('正常位 | 20张')
    void lib
  })
})

describe('素材更新提示', () => {
  it('素材修改后提示（使用最新内容），删除后报错（不自动替换），动作卡新增模板时说明', () => {
    const { s, lib, card, legs, kiss, item, ctx, plan } = setup()
    const data = presetFromItems([item()], ctx())
    expect(presetMessages('set', presetStatus(data, s.list('templates')))).toEqual([])
    s.save('templates', { id: legs, positive: '{女特征}, {女服装}, {表情}, legs raised high, {行为}' })
    s.save('templates', { id: lib.exprs[0], name: '普通脸红' })
    s.save('templates', { kind: 'card_tpl', parent_id: card, name: '侧身', positive: '{女特征}, side' })
    const st = presetStatus(data, s.list('templates'))
    expect(st.changed).toEqual(['正常位 / 双腿抬起'])
    expect(st.added).toEqual(['正常位 / 侧身'])
    const msgs = presetMessages('set', st)
    expect(msgs[0]).toEqual({ level: 'info', text: '此套图模板引用的部分素材已更新：正常位 / 双腿抬起 在上次保存后 Prompt 已修改。本次将使用素材库中的最新内容。' })
    // 改名不算修改
    expect(st.changed).not.toContain('普通脸红')
    // 导入后使用素材库中的最新内容
    const units = plan(itemsFromPreset(data, { 1: lib.outfitsA[0] })).units
    expect(units.some((u) => u.positive.includes('legs raised high'))).toBe(true)
    s.remove('templates', kiss)
    const gone = presetStatus(data, s.list('templates'))
    expect(gone.missing).toEqual(['Kiss'])
    expect(presetMessages('action', gone).find((m) => m.level === 'error')!.text).toContain('此动作预设引用的素材已被删除：Kiss')
    expect(plan(itemsFromPreset(data, { 1: lib.outfitsA[0] })).errors.join()).toContain('有行为候选已被删除')
  })
  it('删除素材时的引用检查包含预设', () => {
    const { s, kiss, item, ctx } = setup()
    s.save('presets', { kind: 'set', name: '正常位一组', data: presetFromItems([item()], ctx()) })
    expect(s.tasksReferencing('behavior_ids', kiss)).toEqual(['套图模板「正常位一组」'])
  })
})

describe('入队冻结', () => {
  it('入队后修改素材或预设，已入队的 Prompt 与工作流不变；预览与入队提交的 Prompt 一致', () => {
    const { s, lib, legs, hold, item, ctx } = setup()
    const wid = lib.addWorkflow([newEntry('positive', '6', 'text'), newEntry('negative', '7', 'text')], SAMPLE_WORKFLOW)
    const data: PresetData = presetFromItems([item()], ctx())
    const pid = s.save('presets', { kind: 'action', name: 'p', data })
    const task = lib.makeTask(itemsFromPreset(data, { 1: lib.outfitsA[0] }), '套图', { workflow_id: wid, combo_seed: 3 })
    const preview = planForTask(s, task)
    expect(preview.errors).toEqual([])
    const { runId } = enqueueTask(s, task)
    const before = s.listUnits(runId!).map((u) => u.inputs.find((x) => x.node === '6')?.value)
    expect(before).toEqual(preview.units.map((u) => u.positive))
    s.save('templates', { id: legs, positive: 'changed' })
    s.save('templates', { id: hold, positive: 'changed too' })
    s.remove('presets', pid)
    expect(s.listUnits(runId!).map((u) => u.inputs.find((x) => x.node === '6')?.value)).toEqual(before)
    expect(planForTask(s, task).units.map((u) => u.positive)).not.toEqual(before)
  })
})
