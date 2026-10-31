// 动作卡：基础 Prompt + 子体位（结构变体）+ 各素材池的固定素材与随机候选。
// 素材本身是全局共享的，动作卡只保存每个池使用的素材 ID；任务可以按池覆盖（只对当前任务生效）。
// 固定素材全部加入；每个池的随机候选每张图片均匀抽取 1 个。抽取只在生成计划展开时进行：由组合 Seed、动作序号和张序号决定，
// 同样的输入总是得到同样的结果；入队后随计划冻结。
// 旧版的「关闭 / 固定 / 随机 min～max」在读取时转换（不改写文件，下次保存动作卡时写入新结构）。

import type { ActionCard, CardPoolKey, LegacyPoolRule, PoolConfig, TaskItem, Template } from './types'
import { CARD_POOLS } from './types'

const ids = (v: unknown): number[] => (Array.isArray(v) ? [...new Set(v.filter((x): x is number => Number.isSafeInteger(x) && x > 0))] : [])
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** 整理一个池：去掉非法与重复的 ID，同时在两栏的素材留在固定栏。只有子体位可以没有 random（表示全部子体位） */
export function normalizePool(v: unknown, key: CardPoolKey): PoolConfig {
  const o = isObject(v) ? v : {}
  const fixed = ids(o.fixed)
  if (key === 'variant' && o.random === undefined) return { fixed }
  return { fixed, random: ids(o.random).filter((x) => !fixed.includes(x)) }
}

const isLegacyRule = (o: Record<string, unknown>) => 'mode' in o || 'min' in o || 'max' in o

/**
 * 旧版规则转换为新结构：关闭 → 两栏为空；固定 → 固定素材，随机栏为空；随机 → 固定素材 + 候选素材。
 * 旧数量设置不再生效。没有规则或模式不合法时按旧版默认处理（附加默认关闭，其他默认随机）
 */
export function migrateRule(rule: unknown, key: CardPoolKey, candidates: number[] | undefined): PoolConfig {
  const o = isObject(rule) ? rule : {}
  const mode: LegacyPoolRule['mode'] = o.mode === 'off' || o.mode === 'fixed' || o.mode === 'random' ? o.mode : key === 'extra' ? 'off' : 'random'
  if (mode === 'off') return { fixed: [], random: [] }
  if (mode === 'fixed') return { fixed: ids(o.fixed), random: [] }
  return normalizePool({ fixed: o.fixed, random: candidates }, key)
}

/** 整理动作卡配置（保存前调用）：只保留已知的池与数字 ID；旧结构（pools 为 ID 数组，或有 rules）转换为新结构 */
export function normalizeCard(c: unknown): ActionCard {
  const o = isObject(c) ? c : {}
  const out: ActionCard = {}
  if (o.solo === true) out.solo = true
  const pools = isObject(o.pools) ? o.pools : {}
  const rules = isObject(o.rules) ? o.rules : null
  const legacy = !!rules || Object.values(pools).some(Array.isArray)
  for (const { key } of CARD_POOLS) {
    const raw = pools[key]
    let pool: PoolConfig | null = null
    if (legacy) pool = migrateRule(rules?.[key], key, Array.isArray(raw) ? ids(raw) : key === 'variant' ? undefined : [])
    else if (isObject(raw)) pool = normalizePool(raw, key)
    if (!pool) continue
    // 子体位的空随机栏有含义（不使用其他子体位），必须保留；其他池两栏都空等于没有配置
    const keep = pool.fixed!.length > 0 || (key === 'variant' ? pool.random !== undefined : pool.random!.length > 0)
    if (keep) (out.pools ??= {})[key] = pool
  }
  return out
}

export const isSoloCard = (t: Pick<Template, 'card'> | null | undefined): boolean => !!t?.card?.solo
/** 单人动作卡不使用的池 */
export const poolsOf = (solo: boolean) => CARD_POOLS.filter((p) => !solo || !p.duo)

/** 动作卡某个池的配置（旧结构在这里转换） */
export function cardPool(card: Pick<Template, 'card'> | null | undefined, key: CardPoolKey): PoolConfig {
  return normalizeCard(card?.card).pools?.[key] ?? normalizePool(null, key)
}
/** 任务中实际使用的配置：任务覆盖优先，其次动作卡。旧版覆盖规则的随机候选来自动作卡 */
export function effectivePool(card: Pick<Template, 'card'> | null | undefined, item: Pick<TaskItem, 'card_rules'> | null | undefined, key: CardPoolKey): PoolConfig {
  const o = item?.card_rules?.[key]
  if (!isObject(o)) return cardPool(card, key)
  return isLegacyRule(o) ? migrateRule(o, key, cardPool(card, key).random) : normalizePool(o, key)
}

/** 两栏实际包含的素材 ID。子体位只保留属于这张卡的；没有 random 时为这张卡的全部子体位（按素材库顺序） */
export function resolvePool(pool: PoolConfig, card: Pick<Template, 'id'>, key: CardPoolKey, variants: Template[]): { fixed: number[]; random: number[] } {
  const fixed = ids(pool.fixed)
  if (key !== 'variant') return { fixed, random: ids(pool.random).filter((x) => !fixed.includes(x)) }
  const own = variants.filter((v) => v.parent_id === card.id).map((v) => v.id)
  const list = pool.random ? ids(pool.random).filter((x) => own.includes(x)) : own
  return { fixed, random: list.filter((x) => !fixed.includes(x)) }
}

/** 动作卡引用的全部素材 ID（查看素材被哪些动作卡使用） */
export function cardMaterialIds(card: Pick<Template, 'card'>): number[] {
  return [...new Set(CARD_POOLS.flatMap(({ key }) => {
    const p = cardPool(card, key)
    return [...(p.fixed ?? []), ...(p.random ?? [])]
  }))]
}

/** 把素材移动到某一栏的指定位置（拖动）：移动而不是复制，结果中每个素材只出现一次 */
export function movePoolItem(lists: { fixed: number[]; random: number[] }, id: number, to: 'fixed' | 'random', index: number): { fixed: number[]; random: number[] } {
  const next = { fixed: lists.fixed.filter((x) => x !== id), random: lists.random.filter((x) => x !== id) }
  const at = Math.max(0, Math.min(index, next[to].length))
  next[to] = [...next[to].slice(0, at), id, ...next[to].slice(at)]
  return next
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

/** 镜头的随机数单独成流：修改素材池或镜头候选不会互相改变抽取结果 */
const CAMERA_STREAM = 0x63616d

/** 一张图片的镜头：没有候选时为空；只有 1 个时直接使用；多个时由组合 Seed、动作序号和张序号决定，均匀抽取（与优先级无关） */
export function drawCamera<T>(candidates: T[], comboSeed: number, itemIndex: number, n: number): T | null {
  if (candidates.length <= 1) return candidates[0] ?? null
  return candidates[Math.floor(seededRandom(mixSeed(comboSeed, itemIndex, n, CAMERA_STREAM))() * candidates.length)]
}

const groupOf = (t: Template) => (t.exclusive ?? '').trim()

/**
 * 一个池的抽取：fixed 中的素材总是使用（按固定顺序）；再从 candidates（已去掉禁止的素材）中均匀抽取 1 个，
 * 只有 1 个候选时直接使用它。已固定的素材，以及与固定素材同一互斥组的候选不会被抽到。
 * 每个池总是消耗一个随机数，所以修改一个池不会影响其他池的抽取结果。
 */
export function drawPool(fixed: Template[], candidates: Template[], rnd: () => number): { fixed: Template[]; random: Template[] } {
  const r = rnd()
  const fixedIds = new Set(fixed.map((t) => t.id))
  const groups = new Set(fixed.map(groupOf).filter(Boolean))
  const pool = candidates.filter((t) => !fixedIds.has(t.id) && !(groupOf(t) && groups.has(groupOf(t))))
  return { fixed, random: pool.length ? [pool[Math.floor(r * pool.length)]] : [] }
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

/** 素材池的简短说明（界面显示） */
export function poolSummary(nFixed: number, nRandom: number): string {
  const parts = [nFixed ? `固定 ${nFixed} 项` : '', nRandom ? `随机候选 ${nRandom} 项（每张抽 1 项）` : ''].filter(Boolean)
  return parts.join(' + ') || '未配置'
}
