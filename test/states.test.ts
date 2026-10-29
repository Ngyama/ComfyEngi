// 「单人动作」与「行为」合并为「状态」：素材迁移（ID、内容、备份）、状态多选（主角色 / 第二角色）、旧任务与冻结快照兼容、素材显示优先级。

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { expandTask, itemStateIds, newInteractionItem, newItem, normalizeTaskData } from '@shared/planner'
import { byPriority, DEFAULT_SETTINGS, type Template } from '@shared/types'
import { decode } from '../src/main/file-library'
import { enqueueTask, loadPlanLibrary, planForTask } from '../src/main/plan'
import { Store } from '../src/main/store'
import { createVault, openVault } from '../src/main/vault'
import { Lib, SAMPLE_MAPPING, SAMPLE_WORKFLOW, tempDir } from './helpers'

const mdFiles = (dir: string): string[] => (existsSync(dir) ? (readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith('.md')) : [])

/** 旧工作区：用旧类型 pose / act 直接写入文件（模拟升级前的 Vault） */
function legacyVault() {
  const root = tempDir()
  createVault(root)
  const s = openVault(root)
  const T = (kind: string, name: string, positive: string, extra: Record<string, unknown> = {}) => s.save('templates', { kind, name, positive, ...extra })
  const ids = {
    sit: T('pose', '坐姿', '(sitting:1.2), {chair|sofa}', { negative: 'standing', note: '备注', tags: 'a,b', category: '单人' }),
    lean: T('pose', '前倾', 'leaning forward'),
    hug: T('act', '拥抱', 'hug'),
    kiss: T('act', '接吻', 'kiss'),
    missionary: T('position', '正常位', 'missionary'),
    smile: T('expression', '微笑', 'smile'),
  }
  const legsUp = T('subposition', '抬腿', 'legs up', { parent_id: ids.missionary })
  const char = s.save('characters', { name: '角色A', tag: 'char_a', positive: '1girl, char_a', loras: [{ name: 'charA.safetensors', strength: 0.8 }] })
  const char2 = s.save('characters', { name: '角色B', tag: 'char_b', positive: '1boy, char_b', loras: [] })
  const g = T('global', '画质', 'masterpiece', { negative: 'lowres' })
  // 旧任务：单选动作 pose_id、第二角色动作 second_pose_id、双人动作中的行为 act_ids
  const legacyItems = [
    { ...newItem(), state_ids: undefined, second_state_ids: undefined, pose_id: ids.sit, count: 4, expression_ids: [ids.smile] },
    { ...newInteractionItem(ids.missionary, legsUp), state_ids: undefined, second_state_ids: undefined, pose_id: ids.lean, act_ids: [ids.hug, ids.kiss], second_enabled: true, second_pose_id: ids.sit, count: 2 },
  ]
  // 直接写入数据库（不经过 normalizeTaskData），保持旧任务的原始形状
  s.db.prepare('INSERT INTO tasks(name, data, sort) VALUES(?,?,1)').run('旧任务', JSON.stringify({ character_id: char, second_character_id: char2, global_id: g, story_id: null, story_outfit_id: null, male_base_id: null, workflow_id: null, seed_base: 7, items: legacyItems }))
  const wid = s.save('workflows', { name: '测试工作流', api_json: SAMPLE_WORKFLOW, mapping: SAMPLE_MAPPING })
  s.setSetting('default_workflow_id', wid)
  const files = new Map([...s.files!.entries].map(([k, e]) => [k, readFileSync(e.path, 'utf8')]))
  const paths = new Map([...s.files!.entries].map(([k, e]) => [k, e.path]))
  const taskId = s.list('tasks')[0].id
  // 素材迁移前的计划（旧任务只有 pose_id / second_pose_id）：作为迁移前后对比的基准
  const before = planForTask(s, s.get('tasks', taskId)!, undefined, '2000-01-01')
  // 已入队的冻结快照（迁移前入队）
  const runId = enqueueTask(s, s.get('tasks', taskId)!).runId!
  if (!runId) throw new Error(before.errors.join('; '))
  const frozen = s.listUnits(runId)
  s.close()
  return { root, ids: { ...ids, legsUp, char, char2, g }, files, paths, taskId, before, runId, frozen }
}

describe('单人动作、行为合并为状态', () => {
  it('打开工作区时迁移：只改 kind（记录 legacy_kind），ID、名称、Prompt、备注、标签、文件位置不变；先备份原文件', () => {
    const v = legacyVault()
    const s = openVault(v.root)
    for (const id of [v.ids.sit, v.ids.lean, v.ids.hug, v.ids.kiss]) {
      const key = `templates:${id}`
      const e = s.files!.entries.get(key)!
      expect(e.path).toBe(v.paths.get(key)) // 文件留在原目录（poses / acts），不移动、不删除
      const before = decode(v.files.get(key)!)
      const after = decode(readFileSync(e.path, 'utf8'))
      expect(after.kind).toBe('state')
      expect(after.legacy_kind).toBe(before.kind)
      const { kind: _a, legacy_kind: _b, ...rest } = after
      const { kind: _c, ...restBefore } = before
      expect(rest).toEqual(restBefore)
    }
    const sit = s.get('templates', v.ids.sit)!
    expect(sit).toMatchObject({ name: '坐姿', positive: '(sitting:1.2), {chair|sofa}', negative: 'standing', note: '备注', tags: 'a,b', category: '单人' })
    // 双人动作、表情、全局等其他素材逐字节不变；主体位与子体位的关系不变
    for (const [key, text] of v.files) {
      if ([v.ids.sit, v.ids.lean, v.ids.hug, v.ids.kiss].some((id) => key === `templates:${id}`)) continue
      expect(readFileSync(s.files!.entries.get(key)!.path, 'utf8')).toBe(text)
    }
    expect(s.get('templates', v.ids.legsUp)).toMatchObject({ kind: 'subposition', parent_id: v.ids.missionary })
    expect(s.get('templates', v.ids.missionary)?.kind).toBe('position')
    // 备份：data/backups/state-merge-*/ 下保存了 4 个原文件（相对路径相同，内容为迁移前）
    const backups = readdirSync(join(v.root, 'data', 'backups')).filter((d) => d.startsWith('state-merge-'))
    expect(backups.length).toBe(1)
    const bdir = join(v.root, 'data', 'backups', backups[0])
    expect(mdFiles(bdir).length).toBe(4)
    for (const id of [v.ids.sit, v.ids.hug]) {
      const p = v.paths.get(`templates:${id}`)!
      expect(readFileSync(join(bdir, relative(v.root, p)), 'utf8')).toBe(v.files.get(`templates:${id}`))
    }
    expect(readFileSync(join(v.root, '.comfyengi', 'migration-log.jsonl'), 'utf8')).toContain('"count":4')
    // 没有丢失、没有重复 ID
    const all = s.list('templates')
    expect(all.length).toBe([...v.files.keys()].filter((k) => k.startsWith('templates:')).length)
    expect(new Set(all.map((t) => t.id)).size).toBe(all.length)
    expect(all.filter((t) => t.kind === 'state').map((t) => t.id).sort()).toEqual([v.ids.sit, v.ids.lean, v.ids.hug, v.ids.kiss].sort())
    expect(all.some((t) => t.kind === 'pose' || t.kind === 'act')).toBe(false)
    s.close()
    // 再次打开不会重复迁移或重复备份
    const s2 = openVault(v.root)
    expect(readdirSync(join(v.root, 'data', 'backups')).filter((d) => d.startsWith('state-merge-')).length).toBe(1)
    expect(s2.list('templates').length).toBe(all.length)
    s2.close()
  })

  it('旧任务（单选动作、第二角色动作、双人动作中的行为）升级后计划完全相同；冻结的队列快照不变', () => {
    const v = legacyVault()
    const s = openVault(v.root)
    const task = s.get('tasks', v.taskId)!
    const after = planForTask(s, task, undefined, '2000-01-01')
    expect(after.errors, JSON.stringify(after.errors)).toEqual([])
    expect(after.units.map((u) => [u.positive, u.negative, u.seed, u.item_label])).toEqual(v.before.units.map((u) => [u.positive, u.negative, u.seed, u.item_label]))
    expect(after.units.length).toBe(6)
    expect(after.units[0].modules.content[0]).toBe('(sitting:1.2), {chair|sofa}')
    expect(after.units[0].item_label).toBe('坐姿')
    // 双人动作：主体位 + 子体位 + 行为（hug、kiss）原样在双人模块中，主角色状态 = 前倾，第二角色状态 = 坐姿
    const duo = after.units[4]
    expect(duo.modules.interaction[0]).toBe('missionary, legs up, hug, kiss')
    expect(duo.modules.content[0]).toBe('leaning forward')
    expect(duo.modules.content2[0]).toBe('(sitting:1.2), {chair|sofa}')
    // 读取时转换为多选数组（一个元素）
    const d = normalizeTaskData(task.data)
    expect(d.items.map((it) => [it.state_ids, it.second_state_ids, it.pose_id, it.second_pose_id])).toEqual([
      [[v.ids.sit], [], null, null],
      [[v.ids.lean], [v.ids.sit], null, null],
    ])
    expect(d.items[1].act_ids).toEqual([v.ids.hug, v.ids.kiss])
    // 已入队的快照逐项不变
    expect(s.listUnits(v.runId)).toEqual(v.frozen)
    // 引用检查能找到旧字段与新字段中的状态
    expect(s.tasksReferencing('pose_id', v.ids.sit)).toEqual(['旧任务'])
    s.save('tasks', { id: v.taskId, data: d })
    expect(s.tasksReferencing('state_ids', v.ids.sit)).toEqual(['旧任务'])
    expect(s.tasksReferencing('second_state_ids', v.ids.sit)).toEqual(['旧任务'])
    s.close()
  })

  it('SQLite 旧数据库（v2）升级到 v3：迁移前备份，pose / act 改为 state，素材默认普通优先级', () => {
    const dir = tempDir()
    const path = join(dir, 'old.db')
    const db = new DatabaseSync(path)
    db.exec(`CREATE TABLE templates (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', positive TEXT NOT NULL DEFAULT '', negative TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', sort INTEGER NOT NULL DEFAULT 0, created_at REAL, updated_at REAL, target TEXT NOT NULL DEFAULT 'any', parent_id INTEGER);
      INSERT INTO templates(id, kind, name, positive) VALUES (5, 'pose', '坐', 'sitting'), (9, 'act', '抱', 'hug'), (12, 'position', '正常位', 'missionary');
      PRAGMA user_version=2;`)
    db.close()
    const s = new Store(path, { backupDir: join(dir, 'backups') })
    expect(s.openInfo.migratedFrom).toBe(2)
    expect(s.openInfo.backup && existsSync(s.openInfo.backup)).toBeTruthy()
    expect(s.list('templates').map((t) => [t.id, t.kind, t.name, t.positive, t.priority])).toEqual([
      [5, 'state', '坐', 'sitting', 'normal'],
      [9, 'state', '抱', 'hug', 'normal'],
      [12, 'position', '正常位', 'missionary', 'normal'],
    ])
    s.close()
  })
})

describe('状态多选', () => {
  function setup() {
    const root = tempDir()
    createVault(root)
    const s = openVault(root)
    const lib = new Lib(s)
    const T = (name: string, positive: string) => s.save('templates', { kind: 'state', name, positive })
    const st = { sit: T('坐姿', 'sitting'), lean: T('前倾', 'leaning forward, sitting'), hand: T('抬手', '(raised hand:1.1)'), d: T('D', 'state_d'), e: T('E', 'state_e') }
    const charM = s.save('characters', { name: '男角色', tag: 'char_m', positive: '1boy, char_m', loras: [] })
    const missionary = s.save('templates', { kind: 'position', name: '正常位', positive: 'missionary' })
    const hug = T('拥抱', 'hug')
    return { root, s, lib, st, charM, missionary, hug }
  }

  it('单人：多个状态拼接到同一张图片，按选择顺序、原样保留（不去重、不改写），张数不变', () => {
    const { s, lib, st } = setup()
    const item = { ...newItem(null, null), state_ids: [st.sit, st.lean, st.hand], count: 10 }
    const r = expandTask(lib.task([item]), loadPlanLibrary(s), s.settings())
    expect(r.errors).toEqual([])
    expect(r.units.length).toBe(10) // 不拆成多个动作，也不改变张数
    for (const u of r.units) expect(u.modules.content[0]).toBe('sitting, leaning forward, sitting, (raised hand:1.1)')
    expect(r.units[0].item_label).toBe('坐姿 + 前倾 + 抬手')
    expect(r.units[0].meta.states).toEqual(['坐姿', '前倾', '抬手'])
    // 状态模块在主角色服装之后、表情之前（模块之间空一行，沿用现有拼接规则）
    expect(r.units[0].positive).toBe('masterpiece, best quality,\n\n1girl, char_a, red hair,\n\nsitting, leaning forward, sitting, (raised hand:1.1)')
    // 选择顺序不同，拼接顺序随之不同（确定、稳定）
    const r2 = expandTask(lib.task([{ ...item, state_ids: [st.hand, st.sit] }]), loadPlanLibrary(s), s.settings())
    expect(r2.units[0].modules.content[0]).toBe('(raised hand:1.1), sitting')
    // 同一任务重复展开结果完全相同（没有随机）
    expect(expandTask(lib.task([item]), loadPlanLibrary(s), s.settings()).units).toEqual(r.units)
    // 删除其中一个状态：提示引用失效
    s.remove('templates', st.lean)
    expect(expandTask(lib.task([item]), loadPlanLibrary(s), s.settings()).errors[0]).toContain('有状态素材已被删除')
  })

  it('双人：主角色与第二角色分别多选，同一状态可同时分配给两个角色；双人动作的主体位与行为不受影响', () => {
    const { s, lib, st, charM, missionary, hug } = setup()
    const item = { ...newInteractionItem(missionary, null, null, true), state_ids: [st.sit, st.lean, st.hand], second_state_ids: [st.d, st.e, st.sit], act_ids: [hug], count: 5 }
    const r = expandTask(lib.task([item], { second_character_id: charM }), loadPlanLibrary(s), s.settings())
    expect(r.errors).toEqual([])
    expect(r.units.length).toBe(5)
    const m = r.units[0].modules
    expect(m.content[0]).toBe('sitting, leaning forward, sitting, (raised hand:1.1)')
    expect(m.content2[0]).toBe('state_d, state_e, sitting')
    expect(m.interaction[0]).toBe('missionary, hug')
    expect(r.units[0].meta.action2).toBe('D + E + 坐姿')
    // 两组互不影响：修改第二角色的选择不改变主角色
    const r2 = expandTask(lib.task([{ ...item, second_state_ids: [] }], { second_character_id: charM }), loadPlanLibrary(s), s.settings())
    expect(r2.units[0].modules.content[0]).toBe(m.content[0])
    expect(r2.units[0].modules.content2[0]).toBe('')
    // 第二角色未出场时只使用主角色的状态
    const solo = expandTask(lib.task([{ ...item, second_enabled: false }], { second_character_id: charM }), loadPlanLibrary(s), s.settings())
    expect(solo.units[0].modules.content2).toBeUndefined()
    expect(solo.units[0].positive).not.toContain('state_d')
  })

  it('状态选择与优先级在重启后仍然存在', () => {
    const { root, s, lib, st } = setup()
    const tid = s.save('tasks', { name: '多选', data: lib.task([{ ...newItem(null), state_ids: [st.hand, st.sit], second_state_ids: [st.d] }]) })
    s.save('templates', { id: st.hand, priority: 'high' })
    s.close()
    const s2 = openVault(root)
    const d = normalizeTaskData(s2.get('tasks', tid)!.data)
    expect(itemStateIds(d.items[0])).toEqual([st.hand, st.sit])
    expect(d.items[0].second_state_ids).toEqual([st.d])
    expect(s2.get('templates', st.hand)?.priority).toBe('high')
    s2.close()
  })
})

describe('素材显示优先级', () => {
  const t = (id: number, priority?: Template['priority']) => ({ id, priority }) as Template

  it('高 → 普通 → 低；没有优先级视为普通；同优先级保持原有顺序', () => {
    const list = [t(1), t(2, 'low'), t(3, 'high'), t(4, 'normal'), t(5, 'low'), t(6, 'high'), t(7)]
    expect(byPriority(list).map((x) => x.id)).toEqual([3, 6, 1, 4, 7, 2, 5])
    // 全部同优先级时与原顺序完全相同（不破坏手动排序）
    const same = [t(9), t(3), t(5), t(1)]
    expect(byPriority(same).map((x) => x.id)).toEqual([9, 3, 5, 1])
    expect(byPriority(list)).not.toBe(list)
    expect(list.map((x) => x.id)).toEqual([1, 2, 3, 4, 5, 6, 7]) // 不修改原数组
  })

  it('优先级保存在素材文件中；修改优先级不改变 Prompt、排序字段与生成结果', () => {
    const root = tempDir()
    createVault(root)
    const s = openVault(root)
    const lib = new Lib(s)
    const a = s.save('templates', { kind: 'state', name: 'A', positive: 'state_a' })
    const b = s.save('templates', { kind: 'state', name: 'B', positive: 'state_b' })
    const item = { ...newItem(null), state_ids: [a, b], count: 2 }
    const before = expandTask(lib.task([item]), loadPlanLibrary(s), s.settings()).units
    const sortBefore = s.get('templates', b)!.sort
    s.save('templates', { id: b, priority: 'high' })
    s.save('templates', { id: a, priority: 'low' })
    expect(decode(readFileSync(s.files!.entries.get(`templates:${b}`)!.path, 'utf8')).priority).toBe('high')
    expect(s.get('templates', b)!.sort).toBe(sortBefore)
    const after = expandTask(lib.task([item]), loadPlanLibrary(s), s.settings()).units
    expect(after).toEqual(before) // 仍按选择顺序 A, B 拼接
    expect(after[0].modules.content[0]).toBe('state_a, state_b')
    // 选择列表中 B 排在 A 前面
    const states = byPriority(s.list('templates').filter((x) => x.kind === 'state'))
    expect(states.map((x) => x.id).indexOf(b)).toBeLessThan(states.map((x) => x.id).indexOf(a))
    s.close()
  })

  it('主体位 / 子体位在各自列表内按优先级排列，父子关系不变', () => {
    const root = tempDir()
    createVault(root)
    const s = openVault(root)
    const p1 = s.save('templates', { kind: 'position', name: 'P1', positive: 'p1' })
    const p2 = s.save('templates', { kind: 'position', name: 'P2', positive: 'p2', priority: 'high' })
    const c1 = s.save('templates', { kind: 'subposition', name: 'C1', positive: 'c1', parent_id: p1 })
    const c2 = s.save('templates', { kind: 'subposition', name: 'C2', positive: 'c2', parent_id: p1, priority: 'high' })
    const sorted = byPriority(s.list('templates'))
    expect(sorted.filter((x) => x.kind === 'position').map((x) => x.id)).toEqual([p2, p1])
    expect(sorted.filter((x) => x.kind === 'subposition' && x.parent_id === p1).map((x) => x.id)).toEqual([c2, c1])
    expect(s.get('templates', c2)?.parent_id).toBe(p1)
    s.close()
  })
})

it('默认拼接设置未改变（状态模块使用模块内连接符，模块之间空一行）', () => {
  expect(DEFAULT_SETTINGS.pos_separator).toBe(', ')
  expect(DEFAULT_SETTINGS.pos_module_separator).toBe(',\\n\\n')
})
