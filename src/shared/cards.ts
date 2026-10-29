// 动作卡：基础 Prompt + 子体位（结构变体）+ 各素材池按规则抽取。
// 素材本身是全局共享的，动作卡只保存每个池允许使用的素材 ID；任务可以按池覆盖规则（只对当前任务生效）。
// 随机抽取只在生成计划展开时进行：由组合 Seed、动作序号和张序号决定，同样的输入总是得到同样的结果；入队后随计划冻结。

import type { ActionCard, CardPoolKey, PoolMode, PoolRule, TaskItem, Template } from './types'
import { CARD_POOLS, DEFAULT_POOL_RULES } from './types'

export const MAX_DRAW = 20

const ids = (v: unknown): number[] => (Array.isArray(v) ? [...new Set(v.filter((x): x is number => Number.isSafeInteger(x) && x > 0))] : [])
const count = (v: unknown, d: number): number => {
  const n = Math.trunc(Number(v))
  return Number.isFinite(n) ? Math.min(MAX_DRAW, Math.max(0, n)) : d
}

/** 整理一条规则：模式只能是 off / fixed / random；数量限制在 0～20，min 不大于 max */
export function normalizeRule(r: unknown, fallback: PoolRule = { mode: 'off' }): PoolRule {
  if (!r || typeof r !== 'object') return { ...fallback }
  const o = r as Record<string, unknown>
  const mode: PoolMode = o.mode === 'fixed' || o.mode === 'random' || o.mode === 'off' ? o.mode : fallback.mode
  const out: PoolRule = { mode }
  const fixed = ids(o.fixed)
  if (fixed.length) out.fixed = fixed
  if (mode === 'random') {
    let min = count(o.min, fallback.min ?? 0)
    let max = count(o.max, fallback.max ?? Math.max(1, min))
    if (min > max) [min, max] = [max, min]
    out.min = min
    out.max = max
  }
  return out
}

/** 整理动作卡配置（保存前调用）：只保留已知的池、数字 ID 与合法规则 */
export function normalizeCard(c: unknown): ActionCard {
  const o = c && typeof c === 'object' ? (c as Record<string, unknown>) : {}
  const out: ActionCard = {}
  if (o.solo === true) out.solo = true
  const pools = o.pools && typeof o.pools === 'object' ? (o.pools as Record<string, unknown>) : {}
  const rules = o.rules && typeof o.rules === 'object' ? (o.rules as Record<string, unknown>) : {}
  for (const { key } of CARD_POOLS) {
    if (key in pools && Array.isArray(pools[key])) (out.pools ??= {})[key] = ids(pools[key])
    if (rules[key]) (out.rules ??= {})[key] = normalizeRule(rules[key], DEFAULT_POOL_RULES[key])
  }
  return out
}

export const isSoloCard = (t: Pick<Template, 'card'> | null | undefined): boolean => !!t?.card?.solo
/** 单人动作卡不使用的池 */
export const poolsOf = (solo: boolean) => CARD_POOLS.filter((p) => !solo || !p.duo)

/** 动作卡的默认规则（卡片中没有设置的池使用全局默认） */
export function cardRule(card: Pick<Template, 'card'> | null | undefined, key: CardPoolKey): PoolRule {
  return normalizeRule(card?.card?.rules?.[key], DEFAULT_POOL_RULES[key])
}
/** 任务中实际使用的规则：任务覆盖优先，其次动作卡默认 */
export function effectiveRule(card: Pick<Template, 'card'> | null | undefined, item: Pick<TaskItem, 'card_rules'> | null | undefined, key: CardPoolKey): PoolRule {
  const o = item?.card_rules?.[key]
  return o ? normalizeRule(o, cardRule(card, key)) : cardRule(card, key)
}

/**
 * 动作卡某个池的候选 ID（按卡片中保存的顺序）。子体位：卡片没有限定时为全部属于该卡的子体位（按素材库顺序）
 */
export function poolCandidates(card: Template, key: CardPoolKey, variants: Template[]): number[] {
  if (key === 'variant') {
    const own = variants.filter((v) => v.parent_id === card.id).map((v) => v.id)
    const list = card.card?.pools?.variant
    return list ? ids(list).filter((x) => own.includes(x)) : own
  }
  return ids(card.card?.pools?.[key])
}

// ---------------------------------------------------------------- 可复现的随机数
/** 把若干整数混合为 32 位种子 */
export function mixSeed(...parts: number[]): number {
  let h = 0x811c9dc5
  for (const p of parts) {
    let x = Math.trunc(p) >>> 0
    for (let i = 0; i < 4; i++) {
      h ^= x & 0xff
      h = Math.imul(h, 0x01000193) >>> 0
      x >>>= 8
    }
  }
  return h >>> 0
}
/** mulberry32：确定的伪随机数生成器，返回 [0, 1) */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
/** 某个动作第 n 张图片的抽取随机数：只由组合 Seed、动作序号、张序号决定 */
export const unitRandom = (comboSeed: number, itemIndex: number, n: number) => seededRandom(mixSeed(comboSeed, itemIndex, n))

const groupOf = (t: Template) => (t.exclusive ?? '').trim()

/**
 * 一个池的抽取：fixed 中的素材总是使用（按固定顺序）；random 时再从 candidates（已去掉固定与禁止的素材）中
 * 抽取 min～max 个，不重复、同一互斥组最多一个（与固定素材同组的也跳过）。候选不足时抽取能抽到的数量。
 * 随机结果按候选顺序排列，保证拼接顺序稳定。
 */
export function drawPool(rule: PoolRule, fixed: Template[], candidates: Template[], rnd: () => number): { fixed: Template[]; random: Template[] } {
  if (rule.mode === 'off') return { fixed: [], random: [] }
  if (rule.mode === 'fixed') return { fixed, random: [] }
  const fixedIds = new Set(fixed.map((t) => t.id))
  const pool = candidates.filter((t) => !fixedIds.has(t.id))
  const min = rule.min ?? 0
  const max = Math.max(min, rule.max ?? min)
  const want = min + Math.floor(rnd() * (max - min + 1))
  if (!want || !pool.length) return { fixed, random: [] }
  const order = pool.map((_, i) => i)
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[order[i], order[j]] = [order[j], order[i]]
  }
  const used = new Set(fixed.map(groupOf).filter(Boolean))
  const picked: number[] = []
  for (const i of order) {
    if (picked.length >= want) break
    const g = groupOf(pool[i])
    if (g && used.has(g)) continue
    if (g) used.add(g)
    picked.push(i)
  }
  return { fixed, random: picked.sort((a, b) => a - b).map((i) => pool[i]) }
}

/** 固定素材中同一互斥组的冲突（只提示，不修改用户的选择） */
export function fixedConflicts(fixed: Template[]): string[] {
  const by = new Map<string, string[]>()
  for (const t of fixed) {
    const g = groupOf(t)
    if (g) by.set(g, [...(by.get(g) ?? []), t.name || '（未命名）'])
  }
  return [...by].filter(([, n]) => n.length > 1).map(([g, n]) => `互斥组「${g}」中的 ${n.join('、')} 被同时固定`)
}

/** 规则的简短说明（界面显示） */
export function ruleSummary(rule: PoolRule, nCandidates: number): string {
  const nf = rule.fixed?.length ?? 0
  if (rule.mode === 'off') return '关闭'
  if (rule.mode === 'fixed') return nf ? `固定 ${nf} 项` : '固定（未选择）'
  const range = rule.min === rule.max ? `${rule.min}` : `${rule.min}～${rule.max}`
  return `${nf ? `固定 ${nf} 项 + ` : ''}随机 ${range} 项 · 候选 ${nCandidates}`
}
