// 动作卡：基础 Prompt + 子体位 + 兼容素材池 + 受约束的随机组合；入队冻结；旧数据兼容。

import { copyFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { cardPool, drawPool, effectivePool, migrateRule, mixSeed, movePoolItem, normalizeCard, normalizePool, poolSummary, resolvePool, seededRandom } from '@shared/cards'
import { expandTask, newCardItem, newInteractionItem, normalizeTaskData, setItemSizes } from '@shared/planner'
import type { ActionCard, PlanUnit, TaskItem, Template } from '@shared/types'
import { enqueueTask, loadPlanLibrary, planForTask } from '../src/main/plan'
import { SCHEMA_VERSION, Store } from '../src/main/store'
import { createVault, openVault } from '../src/main/vault'
import { Lib, newStore, tempDir } from './helpers'

/** 测试素材：在通用测试库之上加一套局部姿态、互动、表情与动作卡 */
function setup() {
  const s = newStore()
  const lib = new Lib(s)
  const T = (kind: string, name: string, positive: string, extra: Record<string, unknown> = {}) => s.save('templates', { kind, name, positive, ...extra })
  const st = {
    lean: T('state', '前倾', 'leaning_forward', { exclusive: '上身' }),
    back: T('state', '后仰', 'leaning_back', { exclusive: '上身' }),
    arms: T('state', '抬手', 'arms_up'),
    hand: T('state', '比心', 'heart_hands'),
    legs: T('state', '抱膝', 'hugging_own_legs'),
    hug: T('state', '拥抱', 'hug'),
    kiss: T('state', '接吻', 'kiss'),
    p2: T('state', '第二角色侧身', 'p2_side'),
    p2b: T('state', '第二角色低头', 'p2_down'),
  }
  const ex = {
    smile: T('expression', '微笑', 'smile'),
    blush: T('expression', '害羞', 'blush'),
    cold: T('expression', '冷淡', 'expressionless'),
    e2: T('expression', '第二角色微笑', 'e2_smile'),
  }
  const card = (name: string, positive: string, c: ActionCard) => T('position', name, positive, { card: c })
  const solo = card('鸭子坐', 'wariza, sitting', {
    solo: true,
    pools: { pose: { fixed: [], random: [st.lean, st.back, st.arms, st.hand] }, expr: { fixed: [], random: [ex.smile, ex.blush] } },
  })
  const duo = card('正常位', 'missionary, 1boy', {
    pools: { pose: { fixed: [], random: [st.legs] }, interaction: { fixed: [], random: [st.hug, st.kiss] }, pose2: { fixed: [], random: [st.p2, st.p2b] }, expr: { fixed: [], random: [ex.cold] }, expr2: { fixed: [], random: [ex.e2] } },
  })
  const v1 = T('subposition', '标准', 'standard_variant', { parent_id: duo })
  const v2 = T('subposition', '抬腿', 'leg_up', { parent_id: duo })
  const char2 = lib.charB
  return { s, lib, st, ex, solo, duo, v1, v2, char2, T }
}
type Env = ReturnType<typeof setup>

const cardItem = (cardId: number, n = 10, extra: Partial<TaskItem> = {}): TaskItem => {
  const it = { ...newCardItem(cardId), ...extra }
  setItemSizes(it, { portrait: n })
  return it
}
function expand(env: Env, items: TaskItem[], extra: Record<string, unknown> = {}) {
  const data = env.lib.task(items, { male_base_id: null, combo_seed: 42, ...extra })
  return expandTask(normalizeTaskData(data), loadPlanLibrary(env.s), env.s.settings(), 't')
}
const posIds = (u: PlanUnit, pool: string) => (u.meta.picks ?? []).filter((p) => p.pool === pool).map((p) => p.id)

describe('动作卡生成', () => {
  it('1. 单人动作卡：基础 Prompt + 抽取结果，任务选择了第二角色也不加入第二角色、双人互动', () => {
    const env = setup()
    const { units, errors } = expand(env, [cardItem(env.solo, 20)], { second_character_id: env.char2 })
    expect(errors).toEqual([])
    expect(units).toHaveLength(20)
    for (const u of units) {
      expect(u.modules.interaction[0]).toBe('wariza, sitting')
      expect(u.modules.character2).toBeUndefined()
      expect(u.modules.outfit2).toBeUndefined()
      expect(u.modules.content2).toBeUndefined()
      expect(u.modules.expression2).toBeUndefined()
      expect(u.loras2).toBeUndefined()
      expect(u.meta.card_type).toBe('solo')
      expect(u.positive).toContain('wariza, sitting')
      expect(u.positive).not.toContain('char_b')
      expect(posIds(u, 'expr')).toHaveLength(1)
    }
  })

  it('2. 双人动作卡：第二角色出场，结构变体、双人互动与第二角色的姿态 / 表情各自加入', () => {
    const env = setup()
    const { units, errors } = expand(env, [cardItem(env.duo, 20)], { second_character_id: env.char2 })
    expect(errors).toEqual([])
    for (const u of units) {
      expect(u.modules.character2[0]).toContain('char_b')
      expect(u.modules.interaction[0].startsWith('missionary, 1boy, ')).toBe(true)
      expect(posIds(u, 'variant')).toHaveLength(1)
      expect([env.v1, env.v2]).toContain(posIds(u, 'variant')[0])
      expect(posIds(u, 'pose2')).toHaveLength(1)
      expect(u.modules.expression2[0]).toBe('e2_smile')
      expect(u.meta.character2).toBe('角色B')
    }
  })

  it('3. 单人、双人动作卡混合在同一套图中：只有双人卡出现第二角色', () => {
    const env = setup()
    const { units, errors } = expand(env, [cardItem(env.solo, 5), cardItem(env.duo, 5), cardItem(env.solo, 5)], { second_character_id: env.char2 })
    expect(errors).toEqual([])
    expect(units.map((u) => !!u.modules.character2)).toEqual([...Array(5).fill(false), ...Array(5).fill(true), ...Array(5).fill(false)])
    expect(units.map((u) => u.item_label)).toEqual([...Array(5).fill('鸭子坐'), ...Array(5).fill('正常位'), ...Array(5).fill('鸭子坐')])
  })

  it('4 / 5. 各动作卡只从自己的兼容池抽取，不兼容的素材不会出现', () => {
    const env = setup()
    const { units } = expand(env, [cardItem(env.solo, 100), cardItem(env.duo, 100)], { second_character_id: env.char2 })
    const soloAllowed = new Set([env.st.lean, env.st.back, env.st.arms, env.st.hand, env.ex.smile, env.ex.blush])
    const duoAllowed = new Set([env.v1, env.v2, env.st.legs, env.st.hug, env.st.kiss, env.st.p2, env.st.p2b, env.ex.cold, env.ex.e2])
    for (const u of units) for (const p of u.meta.picks ?? []) expect((u.item_index === 0 ? soloAllowed : duoAllowed).has(p.id)).toBe(true)
    // 抽到的素材都确实出现在 Prompt 中，没有抽到的兼容素材不会出现
    for (const u of units.filter((x) => x.item_index === 0)) {
      expect(u.positive.includes('leaning_forward')).toBe(posIds(u, 'pose').includes(env.st.lean))
      expect(u.positive).not.toContain('hug')
    }
  })

  it('6. 固定素材始终出现，且不会再被随机抽到', () => {
    const env = setup()
    const it = cardItem(env.solo, 50, { card_rules: { pose: { fixed: [env.st.arms], random: [env.st.lean, env.st.back, env.st.hand] } } })
    const { units } = expand(env, [it])
    for (const u of units) {
      const pose = (u.meta.picks ?? []).filter((p) => p.pool === 'pose')
      expect(pose[0]).toMatchObject({ id: env.st.arms, random: false })
      expect(pose).toHaveLength(2)
      expect(pose[1].random).toBe(true)
      expect(pose[1].id).not.toBe(env.st.arms)
      expect(u.modules.content[0].startsWith('arms_up, ')).toBe(true)
    }
  })

  it('7 / 8. 两栏为空不加入内容；只有固定素材时全部加入；随机栏只有一个候选时直接使用', () => {
    const env = setup()
    const none = expand(env, [cardItem(env.solo, 5, { card_rules: { pose: { fixed: [], random: [] } } })]).units
    for (const u of none) {
      expect(posIds(u, 'pose')).toEqual([])
      expect(u.modules.content).toEqual(['', ''])
    }
    const fixedOnly = expand(env, [cardItem(env.solo, 5, { card_rules: { pose: { fixed: [env.st.arms, env.st.hand], random: [] } } })]).units
    for (const u of fixedOnly) expect(u.modules.content[0]).toBe('arms_up, heart_hands')
    const single = expand(env, [cardItem(env.solo, 20, { card_rules: { expr: { fixed: [], random: [env.ex.blush] } } })]).units
    for (const u of single) expect(u.modules.expression[0]).toBe('blush')
  })

  it('9. 随机候选中已固定素材的同互斥组素材不会被抽到；固定了冲突素材时提示而不修改', () => {
    const env = setup()
    const r = expand(env, [cardItem(env.solo, 2, { card_rules: { pose: { fixed: [env.st.lean, env.st.back] } } })])
    expect(r.errors).toEqual([])
    expect(r.warnings.some((w) => w.includes('互斥组「上身」'))).toBe(true)
    for (const u of r.units) expect(u.modules.content[0]).toBe('leaning_forward, leaning_back')
    const g = expand(env, [cardItem(env.solo, 100, { card_rules: { pose: { fixed: [env.st.lean], random: [env.st.back, env.st.arms] } } })]).units
    for (const u of g) expect(posIds(u, 'pose')).toEqual([env.st.lean, env.st.arms])
  })

  it('10. 主角色与第二角色的姿态、表情分别进入对应模块', () => {
    const env = setup()
    const { units } = expand(env, [cardItem(env.duo, 30)], { second_character_id: env.char2 })
    for (const u of units) {
      expect(u.modules.content[0]).toBe(posIds(u, 'pose').length ? 'hugging_own_legs' : '')
      expect(u.modules.expression[0]).toBe('expressionless')
      expect(['p2_side', 'p2_down']).toContain(u.modules.content2[0])
      expect(u.modules.expression2[0]).toBe('e2_smile')
      expect(u.modules.content[0]).not.toContain('p2_')
      expect(u.modules.interaction[0]).not.toContain('p2_')
      // 模块顺序：主角色 → 动作卡 → 第二角色（沿用已有的组合顺序）
      const p = u.positive
      expect(p.indexOf('expressionless')).toBeLessThan(p.indexOf('missionary'))
      expect(p.indexOf('missionary')).toBeLessThan(p.indexOf('char_b'))
      expect(p.indexOf('char_b')).toBeLessThan(p.indexOf('e2_smile'))
    }
  })

  it('11 / 12. 同一动作卡的多张图片组合不同；组合 Seed 相同时结果完全一致，不同时变化', () => {
    const env = setup()
    const a = expand(env, [cardItem(env.solo, 30)]).units.map((u) => u.positive)
    expect(new Set(a).size).toBeGreaterThan(3)
    expect(expand(env, [cardItem(env.solo, 30)]).units.map((u) => u.positive)).toEqual(a)
    expect(expand(env, [cardItem(env.solo, 30)], { combo_seed: 7 }).units.map((u) => u.positive)).not.toEqual(a)
    // 组合 Seed 与采样 Seed 相互独立
    const b = expand(env, [cardItem(env.solo, 30)], { seed_base: 999 }).units
    expect(b.map((u) => u.positive)).toEqual(a)
    expect(b[0].seed).toBe(999)
    // 没有组合 Seed 的任务使用起始 Seed，结果同样稳定
    const legacy = env.lib.task([cardItem(env.solo, 5)], { male_base_id: null })
    delete legacy.combo_seed
    const run = () => expandTask(normalizeTaskData(legacy), loadPlanLibrary(env.s), env.s.settings(), 't').units.map((u) => u.positive)
    expect(run()).toEqual(run())
    // 底层随机数
    expect(seededRandom(mixSeed(1, 2, 3))()).toBe(seededRandom(mixSeed(1, 2, 3))())
  })

  it('13. 入队后冻结：修改素材 Prompt、动作卡素材池、组合 Seed 都不影响已入队的图片', () => {
    const env = setup()
    env.lib.addWorkflow()
    const task = env.lib.makeTask([cardItem(env.solo, 10), cardItem(env.duo, 10)], '冻结', { male_base_id: null, second_character_id: env.char2, combo_seed: 5 })
    const { runId, plan } = enqueueTask(env.s, task)
    expect(plan.errors).toEqual([])
    const before = env.s.listUnits(runId!).map((u) => [u.positive, u.meta.picks, u.inputs])
    env.s.save('templates', { id: env.st.lean, positive: 'CHANGED' })
    env.s.save('templates', { id: env.solo, positive: 'CHANGED_BASE', card: { solo: true, pools: { pose: { fixed: [], random: [env.st.legs] } } } })
    env.s.save('tasks', { id: task.id, data: { ...task.data, combo_seed: 6 } })
    expect(env.s.listUnits(runId!).map((u) => [u.positive, u.meta.picks, u.inputs])).toEqual(before)
    // 新计划使用修改后的素材（尚未入队的任务自动使用更新后的内容）
    expect(planForTask(env.s, env.s.get('tasks', task.id)!).units[0].positive).toContain('CHANGED_BASE')
  })

  it('15. 素材优先级只影响显示，不影响 Prompt 与抽取', () => {
    const env = setup()
    const a = expand(env, [cardItem(env.solo, 40), cardItem(env.duo, 40)], { second_character_id: env.char2 }).units.map((u) => [u.positive, u.meta.picks])
    for (const id of [env.st.lean, env.st.hand, env.ex.blush, env.st.kiss, env.v2]) env.s.save('templates', { id, priority: 'high' })
    for (const id of [env.st.back, env.ex.smile, env.v1]) env.s.save('templates', { id, priority: 'low' })
    expect(expand(env, [cardItem(env.solo, 40), cardItem(env.duo, 40)], { second_character_id: env.char2 }).units.map((u) => [u.positive, u.meta.picks])).toEqual(a)
  })

  it('16. 张数、尺寸、LoRA 与工作流配置不受影响', () => {
    const env = setup()
    env.lib.addWorkflow()
    const it = newCardItem(env.duo)
    setItemSizes(it, { portrait: 5, landscape: 5, square: 0 })
    const task = env.lib.makeTask([it], '尺寸', { male_base_id: null, second_character_id: env.char2 })
    const plan = planForTask(env.s, task)
    expect(plan.errors).toEqual([])
    expect(plan.units).toHaveLength(10)
    expect(plan.units.map((u) => u.meta.size)).toEqual([...Array(5).fill('竖图'), ...Array(5).fill('横图')])
    expect(plan.units[0].loras).toEqual([{ name: 'charA.safetensors', strength: 0.8 }])
    expect(plan.units.map((u) => u.seed)).toEqual(Array.from({ length: 10 }, (_, i) => 1000 + i))
    expect(plan.units[0].inputs!.find((x) => x.source === 'positive')!.value).toBe(plan.units[0].positive)
  })
})

describe('任务覆盖与安全处理', () => {
  it('任务中的覆盖只对当前任务生效；删除覆盖即恢复动作卡默认设置', () => {
    const env = setup()
    const card = () => env.s.get('templates', env.solo)!.card
    const before = structuredClone(card())
    const plain = expand(env, [cardItem(env.solo, 20)]).units.map((u) => u.positive)
    const over = expand(env, [cardItem(env.solo, 20, { card_rules: { pose: { fixed: [], random: [] } }, card_exclude: [env.ex.smile] })]).units
    for (const u of over) {
      expect(u.modules.content).toEqual(['', ''])
      expect(u.modules.expression[0]).toBe('blush')
    }
    expect(card()).toEqual(before)
    expect(expand(env, [cardItem(env.solo, 20, { card_rules: undefined, card_exclude: undefined })]).units.map((u) => u.positive)).toEqual(plain)
  })

  it('空素材池、被删除的候选、被删除的固定素材、被删除的动作卡', () => {
    const env = setup()
    const empty = env.T('position', '空卡', 'just_base', { card: { solo: true } })
    const r0 = expand(env, [cardItem(empty, 3)])
    expect(r0.errors).toEqual([])
    for (const u of r0.units) {
      expect(u.positive).toContain('just_base')
      expect(u.meta.picks).toEqual([])
    }
    env.s.remove('templates', env.st.lean)
    const r1 = expand(env, [cardItem(env.solo, 30)])
    expect(r1.errors).toEqual([])
    expect(r1.warnings.some((w) => w.includes('有素材已被删除'))).toBe(true)
    expect(r1.units.every((u) => !posIds(u, 'pose').includes(env.st.lean))).toBe(true)
    const r2 = expand(env, [cardItem(env.solo, 3, { card_rules: { pose: { fixed: [env.st.lean], random: [] } } })])
    expect(r2.errors.some((e) => e.includes('固定的素材已被删除'))).toBe(true)
    env.s.remove('templates', env.solo)
    expect(expand(env, [cardItem(env.solo, 3)]).errors).toEqual(['第 1 个动作：动作卡已被删除'])
  })

  it('配置的边界：非法 ID、重复素材、同时在两栏；候选不足时安全处理', () => {
    expect(normalizePool({ fixed: [3, 3, 'x', -1, 4], random: [4, 5, 5] }, 'pose')).toEqual({ fixed: [3, 4], random: [5] })
    expect(normalizePool(null, 'pose')).toEqual({ fixed: [], random: [] })
    expect(normalizePool(null, 'variant')).toEqual({ fixed: [] })
    expect(normalizeCard({ solo: 1, pools: { pose: { fixed: [3], random: [3, 4] }, bogus: { fixed: [1] }, expr: { fixed: [], random: [] } } })).toEqual({ pools: { pose: { fixed: [3], random: [4] } } })
    const t = (id: number) => ({ id, name: String(id), exclusive: '' }) as Template
    expect(drawPool([], [], seededRandom(1))).toEqual({ fixed: [], random: [] })
    expect(drawPool([t(1)], [t(1)], seededRandom(1)).random).toEqual([])
    expect(poolSummary(0, 0)).toBe('未配置')
    expect(poolSummary(2, 3)).toContain('固定 2 项')
  })

  it('复制动作卡：子体位一起复制，卡片中固定的子体位指向副本自己的子体位', () => {
    const env = setup()
    const c0 = env.s.get('templates', env.duo)!.card!
    env.s.save('templates', { id: env.duo, card: { ...c0, pools: { ...c0.pools, variant: { fixed: [env.v2], random: [] } } } })
    const copy = env.s.duplicate('templates', env.duo)!
    const subs = env.s.list('templates').filter((t) => t.parent_id === copy)
    expect(subs.map((t) => t.name)).toEqual(['标准', '抬腿'])
    expect(env.s.get('templates', copy)!.card!.pools!.variant).toEqual({ fixed: [subs[1].id], random: [] })
    const { units, errors } = expand(env, [cardItem(copy, 2)], { second_character_id: env.char2 })
    expect(errors).toEqual([])
    expect(units[0].modules.interaction[0]).toContain('leg_up')
  })
})

describe('14. 旧素材与任务兼容', () => {
  it('旧任务中的主体位 / 子体位 / 行为动作按原方式展开（Prompt 不变）；旧主体位可直接作为双人动作卡', () => {
    const env = setup()
    const legacy = { ...newInteractionItem(env.duo, env.v2, null, true), act_ids: [env.st.hug], expression_ids: [env.ex.cold], count: 2 }
    const r = expand(env, [legacy], { second_character_id: env.char2 })
    expect(r.errors).toEqual([])
    expect(r.units.map((u) => u.modules.interaction[0])).toEqual(['missionary, 1boy, leg_up, hug', 'missionary, 1boy, leg_up, hug'])
    expect(r.units[0].meta.picks).toBeUndefined()
    // 没有 card 配置的旧主体位：双人卡、随机一个子体位、其他素材池为空
    const old = env.T('position', '旧主体位', 'old_base')
    env.T('subposition', '旧子体位', 'old_sub', { parent_id: old })
    const c = expand(env, [cardItem(old, 3)], { second_character_id: env.char2 })
    expect(c.errors).toEqual([])
    for (const u of c.units) {
      expect(u.modules.interaction[0]).toBe('old_base, old_sub')
      expect(u.modules.character2[0]).toContain('char_b')
    }
  })

  it('SQLite v3 → v4：迁移前自动备份，素材、任务与运行记录不变', () => {
    const dir = tempDir()
    const path = join(dir, 'comfyengi.db')
    const env = setup()
    env.lib.addWorkflow()
    const task = env.lib.makeTask([env.lib.item('鸭子坐', null, [], 2)], '旧', { male_base_id: null })
    const { runId } = enqueueTask(env.s, task)
    const units = env.s.listUnits(runId!)
    env.s.db.prepare('VACUUM INTO ?').run(path)
    // 退回 v3 的表结构（去掉 v4 的列）
    const raw = new DatabaseSync(path)
    raw.exec('ALTER TABLE templates DROP COLUMN card; ALTER TABLE templates DROP COLUMN exclusive; PRAGMA user_version=3')
    const before = raw.prepare('SELECT id, kind, name, positive FROM templates ORDER BY id').all()
    raw.close()
    const s = new Store(path, { backupDir: join(dir, 'backups') })
    expect(s.openInfo.migratedFrom).toBe(3)
    expect(readdirSync(join(dir, 'backups')).some((f) => f.includes(`before-v${SCHEMA_VERSION}-from-v3`))).toBe(true)
    expect(s.list('templates').map(({ id, kind, name, positive }) => ({ id, kind, name, positive }))).toEqual(before)
    expect(s.list('templates').every((t) => t.card === null && t.exclusive === '')).toBe(true)
    expect(s.listUnits(runId!)).toEqual(units)
    expect(planForTask(s, s.get('tasks', task.id)!).units.map((u) => u.positive)).toEqual(planForTask(env.s, task).units.map((u) => u.positive))
    s.close()
  })

  it('Vault：打开工作区不改写旧主体位文件；动作卡配置以 JSON 保存在 frontmatter，重启后不变', () => {
    const root = tempDir()
    createVault(root)
    const s = openVault(root)
    const pos = s.save('templates', { kind: 'position', name: '旧主体位', positive: 'old_base' })
    const path = s.files!.entries.get(`templates:${pos}`)!.path
    const text = readFileSync(path, 'utf8')
    s.close()
    const s2 = openVault(root)
    expect(readFileSync(path, 'utf8')).toBe(text)
    const st = s2.save('templates', { kind: 'state', name: '前倾', positive: 'leaning_forward', exclusive: '上身' })
    s2.save('templates', { id: pos, card: normalizeCard({ solo: true, pools: { pose: { random: [st] } } }) })
    s2.close()
    const s3 = openVault(root)
    expect(s3.get('templates', pos)!.card).toEqual({ solo: true, pools: { pose: { fixed: [], random: [st] } } })
    expect(s3.get('templates', st)!.exclusive).toBe('上身')
    const plan = expandTask(normalizeTaskData({ ...s3.get('tasks', s3.save('tasks', { name: 't', data: { character_id: null, items: [{ ...newCardItem(pos), count: 2 }] } }))!.data }), loadPlanLibrary(s3), s3.settings())
    expect(plan.units.map((u) => u.modules.content[0])).toEqual(['leaning_forward', 'leaning_forward'])
    s3.close()
  })

  it('旧版测试数据库（Python 版）仍能打开并升级到最新版本', () => {
    const dir = tempDir()
    const path = join(dir, 'comfyengi.db')
    copyFileSync(join(__dirname, 'fixtures', 'legacy-v0.db'), path)
    const s = new Store(path, { backupDir: join(dir, 'b') })
    expect((s.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION)
    s.close()
  })
})

describe('素材池：固定 Prompt + 随机候选 Prompt', () => {
  it('固定素材全部加入，每张图片从随机栏独立抽取且只抽取一个（A + B + 一个随机候选）', () => {
    const env = setup()
    const { lean, arms, hand, legs, hug, kiss } = env.st
    const it = cardItem(env.solo, 200, { card_rules: { pose: { fixed: [arms, hand], random: [lean, legs, hug, kiss] } } })
    const { units, errors } = expand(env, [it])
    expect(errors).toEqual([])
    const seen = new Map<number, number>()
    for (const u of units) {
      const pose = (u.meta.picks ?? []).filter((p) => p.pool === 'pose')
      expect(pose.map((p) => p.id).slice(0, 2)).toEqual([arms, hand])
      expect(pose.slice(0, 2).every((p) => !p.random)).toBe(true)
      expect(pose).toHaveLength(3)
      expect(pose[2].random).toBe(true)
      seen.set(pose[2].id, (seen.get(pose[2].id) ?? 0) + 1)
      expect(u.modules.content[0].startsWith('arms_up, heart_hands, ')).toBe(true)
    }
    // 均匀抽取：4 个候选都会出现，且比例接近 1/4；不要求整套图片平均分配
    expect([...seen.keys()].sort((a, b) => a - b)).toEqual([lean, legs, hug, kiss].sort((a, b) => a - b))
    for (const n of seen.values()) expect(n).toBeGreaterThan(25)
  })

  it('各池独立：修改一个池不改变其他池的抽取结果；同一组合 Seed 结果相同', () => {
    const env = setup()
    const exprOf = (extra: Partial<TaskItem>) => expand(env, [cardItem(env.solo, 40, extra)]).units.map((u) => posIds(u, 'expr'))
    const base = exprOf({})
    expect(exprOf({ card_rules: { pose: { fixed: [], random: [] } } })).toEqual(base)
    expect(exprOf({ card_rules: { pose: { fixed: [env.st.arms], random: [env.st.hand] } } })).toEqual(base)
    expect(exprOf({})).toEqual(base)
  })

  it('子体位：没有 random 时为全部子体位；明确列出后只用列出的；只有固定时不抽取', () => {
    const env = setup()
    const card = env.s.get('templates', env.duo)!
    expect(resolvePool(cardPool(card, 'variant'), card, 'variant', env.s.list('templates').filter((t) => t.kind === 'subposition'))).toEqual({ fixed: [], random: [env.v1, env.v2] })
    const only = expand(env, [cardItem(env.duo, 10, { card_rules: { variant: { random: [env.v2] } } })], { second_character_id: env.char2 }).units
    for (const u of only) expect(posIds(u, 'variant')).toEqual([env.v2])
    const fixed = expand(env, [cardItem(env.duo, 10, { card_rules: { variant: { fixed: [env.v1], random: [] } } })], { second_character_id: env.char2 }).units
    for (const u of fixed) expect(u.meta.picks!.filter((p) => p.pool === 'variant')).toEqual([expect.objectContaining({ id: env.v1, random: false })])
    const none = expand(env, [cardItem(env.duo, 3, { card_rules: { variant: { fixed: [], random: [] } } })], { second_character_id: env.char2 }).units
    for (const u of none) expect(posIds(u, 'variant')).toEqual([])
  })

  it('拖动：两栏之间双向移动、栏内排序；移动不复制，素材不会重复', () => {
    const start = { fixed: [1, 2], random: [3, 4, 5] }
    expect(movePoolItem(start, 2, 'random', 1)).toEqual({ fixed: [1], random: [3, 2, 4, 5] })
    expect(movePoolItem(start, 4, 'fixed', 0)).toEqual({ fixed: [4, 1, 2], random: [3, 5] })
    expect(movePoolItem(start, 5, 'random', 0)).toEqual({ fixed: [1, 2], random: [5, 3, 4] })
    expect(movePoolItem(start, 1, 'fixed', 99)).toEqual({ fixed: [2, 1], random: [3, 4, 5] })
    expect(movePoolItem({ fixed: [], random: [7] }, 7, 'fixed', 0)).toEqual({ fixed: [7], random: [] })
    expect(start).toEqual({ fixed: [1, 2], random: [3, 4, 5] })
  })

  it('保存、关闭、重新打开后两栏的顺序和归属不变（Vault）', () => {
    const root = tempDir()
    createVault(root)
    const s = openVault(root)
    const pos = s.save('templates', { kind: 'position', name: '卡', positive: 'base' })
    const a = s.save('templates', { kind: 'state', name: 'A', positive: 'a' })
    const b = s.save('templates', { kind: 'state', name: 'B', positive: 'b' })
    const c = s.save('templates', { kind: 'state', name: 'C', positive: 'c' })
    s.save('templates', { id: pos, card: normalizeCard({ pools: { pose: { fixed: [c, a], random: [b] } } }) })
    s.close()
    const s2 = openVault(root)
    expect(cardPool(s2.get('templates', pos)!, 'pose')).toEqual({ fixed: [c, a], random: [b] })
    s2.close()
  })
})

describe('旧三模式配置迁移', () => {
  it('关闭 → 两栏为空；固定 → 固定栏；随机 → 固定 + 候选，保留顺序，去掉重复，数量不再生效', () => {
    const card = normalizeCard({
      solo: true,
      pools: { pose: [5, 3, 4, 3], expr: [8, 9], interaction: [10], extra: [11], pose2: [12] },
      rules: {
        pose: { mode: 'random', fixed: [7, 4, 7], min: 2, max: 3 },
        expr: { mode: 'fixed', fixed: [9, 8] },
        interaction: { mode: 'off', fixed: [10] },
        pose2: { mode: 'what', min: 0, max: 0 },
      },
    })
    expect(card).toEqual({
      solo: true,
      pools: {
        pose: { fixed: [7, 4], random: [5, 3] },
        expr: { fixed: [9, 8], random: [] },
        pose2: { fixed: [], random: [12] },
      },
    })
    // 再次整理结果不变
    expect(normalizeCard(card)).toEqual(card)
    expect(JSON.stringify(card)).not.toMatch(/mode|min|max|rules/)
  })

  it('没有规则的池沿用旧默认：附加为关闭，其他为随机；子体位保留「全部」「限定」「关闭」「固定」的含义', () => {
    expect(normalizeCard({ pools: { pose: [1], extra: [2] } })).toEqual({ pools: { pose: { fixed: [], random: [1] } } })
    expect(normalizeCard({ pools: { extra: [2] }, rules: { extra: { mode: 'random', min: 0, max: 0 } } })).toEqual({ pools: { extra: { fixed: [], random: [2] } } })
    expect(cardPool({ card: { rules: { variant: { mode: 'random', min: 1, max: 1 } } } as never }, 'variant')).toEqual({ fixed: [] })
    expect(cardPool({ card: { pools: { variant: [3] } } as never }, 'variant')).toEqual({ fixed: [], random: [3] })
    expect(cardPool({ card: { rules: { variant: { mode: 'off' } } } as never }, 'variant')).toEqual({ fixed: [], random: [] })
    expect(cardPool({ card: { rules: { variant: { mode: 'fixed', fixed: [4] } } } as never }, 'variant')).toEqual({ fixed: [4], random: [] })
    expect(migrateRule(undefined, 'extra', [1])).toEqual({ fixed: [], random: [] })
    expect(cardPool(null, 'pose')).toEqual({ fixed: [], random: [] })
  })

  it('旧动作卡可以直接生成：每个随机池每张最多一个，固定素材全部加入；不改写文件，保存后写入新结构且结果相同', () => {
    const env = setup()
    const old = env.T('position', '旧卡', 'old_card', {
      card: { solo: true, pools: { pose: [env.st.lean, env.st.arms, env.st.hand], expr: [env.ex.smile, env.ex.blush] }, rules: { pose: { mode: 'random', fixed: [env.st.legs], min: 2, max: 3 }, expr: { mode: 'fixed', fixed: [env.ex.cold] } } },
    })
    const a = expand(env, [cardItem(old, 30)])
    expect(a.errors).toEqual([])
    for (const u of a.units) {
      const pose = (u.meta.picks ?? []).filter((p) => p.pool === 'pose')
      expect(pose[0]).toMatchObject({ id: env.st.legs, random: false })
      expect(pose).toHaveLength(2)
      expect(posIds(u, 'expr')).toEqual([env.ex.cold])
    }
    const raw = env.s.get('templates', old)!.card as unknown as { rules?: unknown }
    expect(raw.rules).toBeDefined()
    env.s.save('templates', { id: old, card: normalizeCard(raw) })
    expect((env.s.get('templates', old)!.card as unknown as { rules?: unknown }).rules).toBeUndefined()
    expect(expand(env, [cardItem(old, 30)]).units.map((u) => u.positive)).toEqual(a.units.map((u) => u.positive))
  })

  it('任务中的旧覆盖：关闭、固定、随机都能转换，随机候选来自动作卡；禁止抽取继续生效', () => {
    const env = setup()
    const card = env.s.get('templates', env.solo)!
    expect(effectivePool(card, { card_rules: { pose: { mode: 'off' } } }, 'pose')).toEqual({ fixed: [], random: [] })
    expect(effectivePool(card, { card_rules: { pose: { mode: 'fixed', fixed: [env.st.legs] } } }, 'pose')).toEqual({ fixed: [env.st.legs], random: [] })
    expect(effectivePool(card, { card_rules: { pose: { mode: 'random', fixed: [env.st.arms], min: 0, max: 5 } } }, 'pose')).toEqual({ fixed: [env.st.arms], random: [env.st.lean, env.st.back, env.st.hand] })
    expect(effectivePool(card, { card_rules: { pose: { fixed: [env.st.arms], random: [env.st.hand] } } }, 'pose')).toEqual({ fixed: [env.st.arms], random: [env.st.hand] })
    const { units } = expand(env, [cardItem(env.solo, 20, { card_rules: { pose: { mode: 'off' } }, card_exclude: [env.ex.smile] })])
    for (const u of units) {
      expect(posIds(u, 'pose')).toEqual([])
      expect(u.modules.expression[0]).toBe('blush')
    }
  })

  it('已入队的图片不受迁移和后续编辑影响', () => {
    const env = setup()
    env.lib.addWorkflow()
    const old = env.T('position', '旧卡', 'old_card', { card: { solo: true, pools: { pose: [env.st.lean, env.st.arms] }, rules: { pose: { mode: 'random', min: 2, max: 2 } } } })
    const task = env.lib.makeTask([cardItem(old, 10)], '冻结', { male_base_id: null, combo_seed: 5 })
    const { runId } = enqueueTask(env.s, task)
    const before = structuredClone(env.s.listUnits(runId!))
    env.s.save('templates', { id: old, card: normalizeCard(env.s.get('templates', old)!.card) })
    env.s.save('templates', { id: old, card: { solo: true, pools: { pose: { fixed: [env.st.hand], random: [] } } } })
    expect(env.s.listUnits(runId!)).toEqual(before)
  })

  it('复制旧动作卡：固定的子体位指向副本，并写入新结构', () => {
    const env = setup()
    env.s.save('templates', { id: env.duo, card: { rules: { variant: { mode: 'fixed', fixed: [env.v2] } } } as never })
    const copy = env.s.duplicate('templates', env.duo)!
    const subs = env.s.list('templates').filter((t) => t.parent_id === copy)
    expect(env.s.get('templates', copy)!.card!.pools!.variant).toEqual({ fixed: [subs[1].id], random: [] })
  })
})
