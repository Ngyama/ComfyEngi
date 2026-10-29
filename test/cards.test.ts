// 动作卡：基础 Prompt + 子体位 + 兼容素材池 + 受约束的随机组合；入队冻结；旧数据兼容。

import { copyFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { drawPool, mixSeed, normalizeCard, normalizeRule, seededRandom } from '@shared/cards'
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
    pools: { pose: [st.lean, st.back, st.arms, st.hand], expr: [ex.smile, ex.blush] },
    rules: { pose: { mode: 'random', min: 0, max: 2 }, expr: { mode: 'random', min: 1, max: 1 } },
  })
  const duo = card('正常位', 'missionary, 1boy', {
    pools: { pose: [st.legs], interaction: [st.hug, st.kiss], pose2: [st.p2, st.p2b], expr: [ex.cold], expr2: [ex.e2] },
    rules: { pose: { mode: 'random', min: 0, max: 1 }, interaction: { mode: 'random', min: 0, max: 1 }, pose2: { mode: 'random', min: 1, max: 1 }, expr: { mode: 'random', min: 1, max: 1 }, expr2: { mode: 'random', min: 1, max: 1 } },
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
    const it = cardItem(env.solo, 50, { card_rules: { pose: { mode: 'random', fixed: [env.st.arms], min: 0, max: 1 } } })
    const { units } = expand(env, [it])
    for (const u of units) {
      const pose = (u.meta.picks ?? []).filter((p) => p.pool === 'pose')
      expect(pose[0]).toMatchObject({ id: env.st.arms, random: false })
      expect(pose.filter((p) => p.id === env.st.arms)).toHaveLength(1)
      expect(pose.length).toBeLessThanOrEqual(2)
      expect(u.modules.content[0].startsWith('arms_up')).toBe(true)
    }
    expect(units.some((u) => posIds(u, 'pose').length === 2)).toBe(true)
  })

  it('7 / 8. 随机数量按配置抽取；数量为 0 时不加入素材', () => {
    const env = setup()
    const two = expand(env, [cardItem(env.solo, 30, { card_rules: { pose: { mode: 'random', min: 2, max: 2 } } })]).units
    for (const u of two) expect(posIds(u, 'pose')).toHaveLength(2)
    const range = expand(env, [cardItem(env.solo, 60)]).units.map((u) => posIds(u, 'pose').length)
    expect(new Set(range)).toEqual(new Set([0, 1, 2]))
    const zero = expand(env, [cardItem(env.solo, 30, { card_rules: { pose: { mode: 'random', min: 0, max: 0 } } })]).units
    for (const u of zero) {
      expect(posIds(u, 'pose')).toEqual([])
      expect(u.modules.content).toEqual(['', ''])
    }
    // 关闭的池不加入任何内容；固定模式只用固定素材
    const off = expand(env, [cardItem(env.solo, 5, { card_rules: { expr: { mode: 'off' } } })]).units
    for (const u of off) expect(u.modules.expression).toEqual(['', ''])
    const fixed = expand(env, [cardItem(env.solo, 5, { card_rules: { expr: { mode: 'fixed', fixed: [env.ex.blush] } } })]).units
    for (const u of fixed) expect(u.modules.expression[0]).toBe('blush')
  })

  it('9. 互斥组中的素材一张图片最多抽取一个；固定了冲突素材时提示而不修改', () => {
    const env = setup()
    const { units } = expand(env, [cardItem(env.solo, 200, { card_rules: { pose: { mode: 'random', min: 3, max: 3 } } })])
    for (const u of units) {
      const ids = posIds(u, 'pose')
      expect(ids.includes(env.st.lean) && ids.includes(env.st.back)).toBe(false)
      expect(ids).toHaveLength(3) // 4 个候选中有 2 个同组：最多只能抽到 3 个
    }
    const r = expand(env, [cardItem(env.solo, 2, { card_rules: { pose: { mode: 'fixed', fixed: [env.st.lean, env.st.back] } } })])
    expect(r.errors).toEqual([])
    expect(r.warnings.some((w) => w.includes('互斥组「上身」'))).toBe(true)
    for (const u of r.units) expect(u.modules.content[0]).toBe('leaning_forward, leaning_back')
    // 固定素材所在的组也会排除同组的候选
    const g = expand(env, [cardItem(env.solo, 100, { card_rules: { pose: { mode: 'random', fixed: [env.st.lean], min: 3, max: 3 } } })]).units
    for (const u of g) expect(posIds(u, 'pose')).not.toContain(env.st.back)
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
    env.s.save('templates', { id: env.solo, positive: 'CHANGED_BASE', card: { solo: true, pools: { pose: [env.st.legs] } } })
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
    const over = expand(env, [cardItem(env.solo, 20, { card_rules: { pose: { mode: 'off' } }, card_exclude: [env.ex.smile] })]).units
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
    const r2 = expand(env, [cardItem(env.solo, 3, { card_rules: { pose: { mode: 'fixed', fixed: [env.st.lean] } } })])
    expect(r2.errors.some((e) => e.includes('固定的素材已被删除'))).toBe(true)
    env.s.remove('templates', env.solo)
    expect(expand(env, [cardItem(env.solo, 3)]).errors).toEqual(['第 1 个动作：动作卡已被删除'])
  })

  it('抽取规则的边界：负数、超出范围、min > max、未知模式；候选不足时安全处理', () => {
    expect(normalizeRule({ mode: 'random', min: -3, max: 99 })).toEqual({ mode: 'random', min: 0, max: 20 })
    expect(normalizeRule({ mode: 'random', min: 3, max: 1 })).toEqual({ mode: 'random', min: 1, max: 3 })
    expect(normalizeRule({ mode: 'what' }, { mode: 'off' })).toEqual({ mode: 'off' })
    expect(normalizeCard({ solo: 1, pools: { pose: [3, 3, 'x', -1, 4], bogus: [1] }, rules: { expr: { mode: 'fixed', fixed: [9] } } })).toEqual({ pools: { pose: [3, 4] }, rules: { expr: { mode: 'fixed', fixed: [9] } } })
    const t = (id: number) => ({ id, name: String(id), exclusive: '' }) as Template
    expect(drawPool({ mode: 'random', min: 5, max: 5 }, [], [t(1), t(2)], seededRandom(1)).random.map((x) => x.id)).toEqual([1, 2])
    expect(drawPool({ mode: 'random', min: 1, max: 1 }, [], [], seededRandom(1))).toEqual({ fixed: [], random: [] })
  })

  it('复制动作卡：子体位一起复制，卡片中固定的子体位指向副本自己的子体位', () => {
    const env = setup()
    env.s.save('templates', { id: env.duo, card: { ...env.s.get('templates', env.duo)!.card, rules: { variant: { mode: 'fixed', fixed: [env.v2] } } } })
    const copy = env.s.duplicate('templates', env.duo)!
    const subs = env.s.list('templates').filter((t) => t.parent_id === copy)
    expect(subs.map((t) => t.name)).toEqual(['标准', '抬腿'])
    expect(env.s.get('templates', copy)!.card!.rules!.variant!.fixed).toEqual([subs[1].id])
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
    // 没有 card 配置的旧主体位：双人卡、默认规则（随机一个子体位）、素材池为空
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
    s2.save('templates', { id: pos, card: normalizeCard({ solo: true, pools: { pose: [st] }, rules: { pose: { mode: 'random', min: 1, max: 1 } } }) })
    s2.close()
    const s3 = openVault(root)
    expect(s3.get('templates', pos)!.card).toEqual({ solo: true, pools: { pose: [st] }, rules: { pose: { mode: 'random', min: 1, max: 1 } } })
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
