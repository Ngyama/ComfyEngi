// 素材库新结构：场景、单人动作 / 双人互动（主体位、子体位、行为）、适用对象，以及旧数据兼容。

import { copyFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { expandTask, newInteractionItem, newItem, newTaskData, PlanLibrary } from '@shared/planner'
import { compose, normalizedOrder } from '@shared/prompt'
import { DEFAULT_SETTINGS } from '@shared/types'
import { decode } from '../src/main/file-library'
import { enqueueTask, loadPlanLibrary, planForTask } from '../src/main/plan'
import { SCHEMA_VERSION, Store } from '../src/main/store'
import { createVault, openVault } from '../src/main/vault'
import { Lib, newStore, SAMPLE_MAPPING, SAMPLE_WORKFLOW, tempDir } from './helpers'

function fixtures(s: Store) {
  const lib = new Lib(s)
  const T = (kind: string, name: string, positive: string, extra: Record<string, unknown> = {}) => s.save('templates', { kind, name, positive, ...extra })
  const bedroom = T('scene', '卧室', 'bedroom, indoors')
  const street = T('scene', '街道', 'street, outdoors')
  const missionary = T('position', '正常位', 'missionary, (on back:1.2)')
  const legsUp = T('subposition', '抬腿', 'legs up', { parent_id: missionary })
  const cowgirl = T('position', '骑乘位', 'cowgirl position')
  const hug = T('act', '拥抱', 'hug, {embrace|cuddle}')
  const kiss = T('act', '接吻', 'kiss')
  const maleSit = T('pose', '男性坐姿', 'MALE_SITTING', { target: 'male' })
  const maleSmile = T('expression', '男性微笑', 'MALE_SMILE', { target: 'male' })
  const femaleBlush = T('expression', '脸红', 'blush', { target: 'female' })
  return { lib, bedroom, street, missionary, legsUp, cowgirl, hug, kiss, maleSit, maleSmile, femaleBlush }
}

describe('素材分类与数据库迁移', () => {
  it('旧数据库升级到 v2：迁移前备份，只新增列，已有素材默认为通用', () => {
    const dir = tempDir()
    const path = join(dir, 'comfyengi.db')
    copyFileSync(join(import.meta.dirname, 'fixtures/legacy-v0.db'), path)
    const s = new Store(path, { backupDir: join(dir, 'backups') })
    expect(s.openInfo.backup).toContain(`before-v${SCHEMA_VERSION}-from-v0`)
    const t = s.list('templates')
    expect(t.length).toBeGreaterThan(0)
    expect(t.every((x) => x.target === 'any' && x.parent_id === null)).toBe(true)
    expect(t.filter((x) => x.kind === 'state').length).toBeGreaterThan(0) // 旧姿态原样保留为单人动作
    expect(t.some((x) => x.kind === 'male') && t.some((x) => x.kind === 'camera')).toBe(true)
    s.close()
    // 再次打开不会重复迁移或出错
    const s2 = new Store(path, { backupDir: join(dir, 'backups') })
    expect(s2.openInfo.migratedFrom).toBeNull()
    s2.close()
    const raw = new DatabaseSync(path)
    expect((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION)
    raw.close()
  })

  it('新数据库直接包含新列；v1 数据库（旧列结构）也能补齐', () => {
    const s = newStore()
    const id = s.save('templates', { kind: 'subposition', name: 'x', positive: 'p', parent_id: 5, target: 'any' })
    expect(s.get('templates', id)).toMatchObject({ kind: 'subposition', parent_id: 5 })
    s.close()
    const path = join(tempDir(), 'v1.db')
    const raw = new DatabaseSync(path)
    raw.exec("CREATE TABLE templates (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', positive TEXT NOT NULL DEFAULT '', negative TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', sort INTEGER NOT NULL DEFAULT 0, created_at REAL, updated_at REAL); INSERT INTO templates(kind,name,positive) VALUES('pose','旧姿态','old (tag:1.1)'); PRAGMA user_version=1;")
    raw.close()
    const s2 = new Store(path)
    expect(s2.list('templates')[0]).toMatchObject({ name: '旧姿态', positive: 'old (tag:1.1)', target: 'any', parent_id: null })
    s2.close()
  })

  it('工作区：旧姿态文件不改动即可使用；新素材写入各自目录；移动类型保留文件与 ID；不删除文件', () => {
    const root = tempDir()
    createVault(root)
    const s = openVault(root)
    const pose = s.save('templates', { kind: 'pose', name: '旧姿态', positive: 'old' })
    const posePath = s.files!.entries.get(`templates:${pose}`)!.path
    const before = readFileSync(posePath, 'utf8')
    expect(decode(before).target).toBeUndefined() // 旧文件没有 target 字段
    expect(s.get('templates', pose)?.positive).toBe('old')
    const scene = s.save('templates', { kind: 'scene', name: '卧室', positive: 'bedroom' })
    const pos = s.save('templates', { kind: 'position', name: '正常位', positive: 'missionary' })
    const sub = s.save('templates', { kind: 'subposition', name: '抬腿', positive: 'legs up', parent_id: pos })
    const act = s.save('templates', { kind: 'act', name: '拥抱', positive: 'hug' })
    const dir = (id: number) => s.files!.entries.get(`templates:${id}`)!.path.split(/[\\/]/).slice(-2, -1)[0]
    expect([dir(scene), dir(pos), dir(sub), dir(act)]).toEqual(['scenes', 'positions', 'positions', 'acts'])
    expect(decode(readFileSync(s.files!.entries.get(`templates:${sub}`)!.path, 'utf8')).parent_id).toBe(pos)
    // 把旧姿态移到主体位：只改类型，文件位置与 ID 不变
    s.save('templates', { id: pose, kind: 'position' })
    expect(s.get('templates', pose)?.kind).toBe('position')
    expect(s.files!.entries.get(`templates:${pose}`)!.path).toBe(posePath)
    const files = readdirSync(join(root, 'prompts'), { recursive: true }).length
    s.close()
    const s2 = openVault(root)
    expect(readdirSync(join(root, 'prompts'), { recursive: true }).length).toBe(files)
    expect(existsSync(posePath)).toBe(true)
    s2.close()
  })
})

describe('Prompt 组合', () => {
  it('双人互动：主体位 + 子体位 + 行为原样拼接；可另加女性动作；场景单独成模块', () => {
    const s = newStore()
    const f = fixtures(s)
    const item = { ...newInteractionItem(f.missionary, f.legsUp), act_ids: [f.hug, f.kiss], pose_id: f.lib.poses['睡觉'], scene_id: f.bedroom, count: 1 }
    const { units, errors } = expandTask(f.lib.task([item]), loadPlanLibrary(s), s.settings())
    expect(errors).toEqual([])
    const u = units[0]
    expect(u.item_label).toBe('正常位 · 抬腿')
    expect(u.modules.interaction).toEqual(['missionary, (on back:1.2), legs up, hug, {embrace|cuddle}, kiss', ''])
    expect(u.modules.content[0]).toBe('sleeping, lying')
    expect(u.modules.scene).toEqual(['bedroom, indoors', ''])
    expect(u.positive).toBe('masterpiece, best quality,\n\nbedroom, indoors,\n\n1girl, char_a, red hair,\n\nsleeping, lying,\n\nmissionary, (on back:1.2), legs up, hug, {embrace|cuddle}, kiss')
    expect(u.meta).toMatchObject({ position: '正常位', subposition: '抬腿', acts: ['拥抱', '接吻'], scene: '卧室', section: '动作' })
  })

  it('任务默认场景应用到未指定场景的动作，单独指定的覆盖默认；剧情场景不使用', () => {
    const s = newStore()
    const f = fixtures(s)
    const sid = s.save('stories', { genre: 'g', name: 's', scenes: [{ name: '开场', positive: 'opening', negative: '', count: 1, with_male: false }] })
    const data = f.lib.task([f.lib.item('睡觉', null, [], 1), { ...f.lib.item('鸭子坐', null, [], 1), scene_id: f.street }], { scene_id: f.bedroom, story_id: sid })
    const { units, errors } = expandTask(data, loadPlanLibrary(s), s.settings())
    expect(errors).toEqual([])
    expect(units.map((u) => u.modules.scene?.[0] ?? '')).toEqual(['', 'bedroom, indoors', 'street, outdoors'])
  })

  it('男性未启用时不拼入男性动作 / 表情；启用后按 基础 → 动作 → 表情 → 旧模板 → 附加 组成男性模块', () => {
    const s = newStore()
    const f = fixtures(s)
    const base = { ...f.lib.item('动作A', null, [f.femaleBlush], 1), male_pose_ids: [f.maleSit], male_expression_ids: [f.maleSmile], male_ids: [f.lib.maleAct], male_extra: 'extra_m' }
    const off = expandTask(f.lib.task([{ ...base, male_enabled: false }]), loadPlanLibrary(s), s.settings()).units[0]
    expect(off.positive + off.negative).not.toMatch(/MALE/)
    expect(off.modules.expression[0]).toBe('blush')
    const on = expandTask(f.lib.task([{ ...base, male_enabled: true }]), loadPlanLibrary(s), s.settings()).units[0]
    expect(on.modules.male).toEqual(['1boy, MALE_BASE_TAG, MALE_SITTING, MALE_SMILE, MALE_ACTION, extra_m', 'MALE_NEG'])
    expect(on.meta.male_templates).toEqual(['男性坐姿', '男性微笑', '男性动作'])
  })

  it('行为也可以叠加在单人动作上；未选择动作或素材已删除时给出提示', () => {
    const s = newStore()
    const f = fixtures(s)
    const L = () => loadPlanLibrary(s)
    const solo = expandTask(f.lib.task([{ ...f.lib.item('睡觉', null, [], 1), act_ids: [f.hug] }]), L(), s.settings())
    expect(solo.units[0].modules.interaction[0]).toBe('hug, {embrace|cuddle}')
    expect(expandTask(f.lib.task([{ ...newItem(null), count: 1 }]), L(), s.settings()).errors[0]).toContain('未选择状态')
    s.remove('templates', f.missionary)
    const r = expandTask(f.lib.task([{ ...newInteractionItem(f.missionary), count: 1 }]), L(), s.settings())
    expect(r.errors[0]).toContain('主体位已被删除')
  })

  it('旧任务（只有姿态）的计划与以前完全一致，不出现新模块', () => {
    const s = newStore()
    const lib = new Lib(s)
    const data = lib.task([lib.item('睡觉', lib.outfitsA[0], [lib.exprs[0]], 2, { camera_id: lib.pov, male_enabled: true, male_ids: [lib.maleAct] })])
    delete (data as Partial<typeof data>).scene_id
    for (const it of data.items) for (const k of ['position_id', 'subposition_id', 'act_ids', 'male_pose_ids', 'male_expression_ids', 'scene_id']) delete (it as unknown as Record<string, unknown>)[k]
    const { units, errors } = expandTask(data, loadPlanLibrary(s), s.settings())
    expect(errors).toEqual([])
    expect(Object.keys(units[0].modules).sort()).toEqual(['camera', 'character', 'content', 'expression', 'extra', 'global', 'male', 'outfit'])
    expect(units[0].positive).toBe('masterpiece, best quality,\n\npov,\n\n1girl, char_a, red hair,\n\noutfit_a1,\n\nsleeping, lying,\n\nexpr1,\n\n1boy, MALE_BASE_TAG, MALE_ACTION')
  })

  it('预览与实际提交一致；已入队的快照不受之后的素材修改影响', () => {
    const s = newStore()
    const f = fixtures(s)
    const wf = s.save('workflows', { name: 'wf', api_json: SAMPLE_WORKFLOW, mapping: SAMPLE_MAPPING })
    const tid = s.save('tasks', { name: 't', data: f.lib.task([{ ...newInteractionItem(f.cowgirl), act_ids: [f.kiss], count: 1, male_enabled: true }], { workflow_id: wf, scene_id: f.bedroom }) })
    const t = s.get('tasks', tid)!
    const p = planForTask(s, t)
    expect(p.errors).toEqual([])
    const v = Object.fromEntries(p.units[0].inputs!.map((x) => [x.source, x.value]))
    expect(v.positive).toBe(p.units[0].positive)
    const run = enqueueTask(s, t).runId!
    const snap = s.listUnits(run)
    s.save('templates', { id: f.kiss, positive: 'CHANGED' })
    s.save('templates', { id: f.bedroom, positive: 'CHANGED' })
    expect(s.listUnits(run)).toEqual(snap)
    expect(snap[0].positive).toContain('kiss')
    expect(snap[0].positive).toContain('bedroom, indoors')
  })

  it('自定义组合顺序缺少新模块时插在相邻模块之后', () => {
    expect(normalizedOrder(['camera', 'male', 'global'])).toEqual(['camera', 'character', 'outfit', 'content', 'expression', 'interaction', 'male', 'character2', 'outfit2', 'content2', 'expression2', 'extra', 'global', 'scene'])
    const mods = { male: ['M', ''], interaction: ['I', ''], scene: ['S', ''], content: ['C', ''] } as Record<string, [string, string]>
    expect(compose(mods, { ...DEFAULT_SETTINGS })[0]).toBe('S,\n\nC,\n\nI,\n\nM')
  })

  it('PlanLibrary 在界面中构造的结果与主进程一致（新素材类型）', () => {
    const s = newStore()
    const f = fixtures(s)
    const data = f.lib.task([{ ...newInteractionItem(f.missionary, f.legsUp), act_ids: [f.hug], count: 2 }], { scene_id: f.street })
    const L2 = new PlanLibrary(s.list('templates'), s.list('characters'), s.list('outfits'), s.list('stories'))
    expect(expandTask(data, L2, s.settings())).toEqual(expandTask(data, loadPlanLibrary(s), s.settings()))
    void newTaskData
  })
})

describe('主体位与子体位（类似角色与服装）', () => {
  it('只选主体位、加子体位、叠加多个行为：按 主体位 → 子体位 → 行为 原样拼接，预览与写入节点的值一致', () => {
    const s = newStore()
    const f = fixtures(s)
    const wf = s.save('workflows', { name: 'wf', api_json: SAMPLE_WORKFLOW, mapping: SAMPLE_MAPPING })
    const items = [
      { ...newInteractionItem(f.missionary), count: 1 },
      { ...newInteractionItem(f.missionary, f.legsUp), count: 1 },
      { ...newInteractionItem(f.missionary, f.legsUp), act_ids: [f.kiss, f.hug], count: 1 },
    ]
    const tid = s.save('tasks', { name: 't', data: f.lib.task(items, { workflow_id: wf }) })
    const p = planForTask(s, s.get('tasks', tid)!)
    expect(p.errors).toEqual([])
    expect(p.units.map((u) => u.modules.interaction[0])).toEqual(['missionary, (on back:1.2)', 'missionary, (on back:1.2), legs up', 'missionary, (on back:1.2), legs up, kiss, hug, {embrace|cuddle}'])
    expect(p.units.map((u) => u.item_label)).toEqual(['正常位', '正常位 · 抬腿', '正常位 · 抬腿'])
    for (const u of p.units) expect(u.inputs!.find((x) => x.source === 'positive')!.value).toBe(u.positive)
  })

  it('子体位不属于所选主体位时提示错误，不生成错误的组合', () => {
    const s = newStore()
    const f = fixtures(s)
    const r = expandTask(f.lib.task([{ ...newInteractionItem(f.cowgirl, f.legsUp), count: 1 }]), loadPlanLibrary(s), s.settings())
    expect(r.errors[0]).toContain('子体位「抬腿」不属于主体位「骑乘位」')
    expect(r.units[0].positive).not.toContain('legs up')
    f.lib.addWorkflow()
    const t = f.lib.makeTask([{ ...newInteractionItem(f.cowgirl, f.legsUp), count: 1 }])
    expect(enqueueTask(s, t).runId).toBeNull()
  })

  it('重命名、修改 Prompt 不破坏任务引用；复制主体位会一起复制子体位', () => {
    const s = newStore()
    const f = fixtures(s)
    const data = f.lib.task([{ ...newInteractionItem(f.missionary, f.legsUp), count: 1 }])
    s.save('templates', { id: f.missionary, name: '传教士位', positive: 'missionary' })
    s.save('templates', { id: f.legsUp, name: '双腿抬起', positive: 'legs up, spread legs' })
    const u = expandTask(data, loadPlanLibrary(s), s.settings()).units[0]
    expect(u.item_label).toBe('传教士位 · 双腿抬起')
    expect(u.modules.interaction[0]).toBe('missionary, legs up, spread legs')
    const copy = s.duplicate('templates', f.missionary)!
    const kids = s.list('templates').filter((t) => t.kind === 'subposition' && t.parent_id === copy)
    expect(kids.map((k) => [k.name, k.positive])).toEqual([['双腿抬起', 'legs up, spread legs']])
    expect(s.list('templates').filter((t) => t.kind === 'subposition' && t.parent_id === f.missionary).length).toBe(1)
  })

  it('删除主体位时子体位一起移入工作区回收站（不是直接删除），引用它们的任务给出提示', () => {
    const root = tempDir()
    createVault(root)
    const s = openVault(root)
    const pos = s.save('templates', { kind: 'position', name: '正常位', positive: 'missionary' })
    const sub = s.save('templates', { kind: 'subposition', name: '抬腿', positive: 'legs up', parent_id: pos })
    const other = s.save('templates', { kind: 'subposition', name: '其他', positive: 'x', parent_id: 999999 })
    s.remove('templates', pos)
    expect(s.get('templates', sub)).toBeNull()
    expect(s.get('templates', other)).not.toBeNull()
    const trash = readdirSync(join(root, '.comfyengi', 'trash'))
    expect(trash.length).toBe(2)
    expect(trash.map((f) => readFileSync(join(root, '.comfyengi', 'trash', f), 'utf8')).some((t) => t.includes('legs up'))).toBe(true)
    const r = expandTask({ ...newTaskData(), items: [{ ...newInteractionItem(pos, sub), count: 1 }] }, loadPlanLibrary(s), s.settings())
    expect(r.errors.some((e) => e.includes('主体位已被删除'))).toBe(true)
    s.close()
  })

  it('只保存名称与正面 Prompt 时保留旧负面 Prompt；旧负面仍参与生成，新素材的负面只来自全局', () => {
    const s = newStore()
    const f = fixtures(s)
    const old = s.save('templates', { kind: 'position', name: '旧体位', positive: 'old_pos', negative: 'OLD_NEG' })
    s.save('templates', { id: old, name: '旧体位改名', positive: 'old_pos2' })
    expect(s.get('templates', old)).toMatchObject({ name: '旧体位改名', positive: 'old_pos2', negative: 'OLD_NEG' })
    const neg = (pid: number) => expandTask(f.lib.task([{ ...newInteractionItem(pid), count: 1 }]), loadPlanLibrary(s), s.settings()).units[0].negative
    expect(neg(old)).toBe('lowres, bad anatomy, OLD_NEG')
    expect(neg(f.missionary)).toBe('lowres, bad anatomy')
  })
})
