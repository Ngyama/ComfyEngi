// 重复标签组合挖掘（确定性统计，不理解标签含义）：
// 1. 全局公共标签：出现在 ≥ globalRatio 比例图片中的标签，从局部挖掘中排除；
// 2. 局部重复组合：对其余标签做闭频繁项集挖掘（LCM：前缀保持的闭包扩展，每个闭项集只枚举一次），
//    闭项集 = 「这些图片共同拥有的全部标签」，天然去掉了「同一批图片的子集」这类冗余；
// 3. 关联过滤：组合中的每个标签必须与其余标签明显相关（提升度 ≥ minLift，或有其余标签时几乎总是出现）；
//    只是碰巧同时出现的常见标签（场景、表情等）不放入组合，单独列为「同时出现但关联较弱」；
// 4. 去冗余：子组合被几乎同样多图片的超组合覆盖时只保留更完整的；包含已列出组合的超组合嵌套为「扩展组合」；
// 5. 变化标签：包含该组合的图片中，只在部分图片出现的其他标签。
// 相同输入与参数总是得到相同结果：图片按路径排序，标签按比较键排序，所有排序都有完整的平局规则。

import type { ExtractedPrompt } from './prompt-source'
import { tokenizePrompt, type PromptToken, type TagDictionary } from './tags'
import type { TemplateKind } from './types'

/** 图片中的一个文本元数据字段（只有摘要；原文通过 mining.meta 按需读取） */
export interface MetaFieldInfo {
  key: string
  /** 存放位置：tEXt / zTXt / iTXt / EXIF UserComment … */
  via: string
  /** 字符数 */
  size: number
}

/** 扫描得到的一张图片（id 为完整路径） */
export interface ScannedImage extends ExtractedPrompt {
  id: string
  name: string
  folder: string
  size: number
  /** 按文件内容识别的格式；无法读取时为 null */
  format: 'png' | 'jpeg' | 'webp' | null
  fields: MetaFieldInfo[]
}

/** 扫描范围统计 */
export interface ScanFound {
  /** 找到的支持格式图片数 */
  images: number
  byExt: Record<string, number>
  /** 找到但不支持读取的图片（按扩展名） */
  unsupported: Record<string, number>
  folders: number
}

export interface ScanResult {
  images: ScannedImage[]
  cancelled: boolean
  /** 扫描文件夹时的问题（例如无法读取的子目录、超出数量上限、没有找到图片） */
  errors: string[]
  found: ScanFound
}

/** 原始元数据（用于诊断）：每个字段的文本可能被截断显示，复制时读取完整原文 */
export interface RawMeta {
  format: 'png' | 'jpeg' | 'webp' | null
  fields: { key: string; via: string; size: number; json: boolean; truncated: boolean; text: string }[]
  warnings: string[]
  error?: string
}

export interface DictionaryInfo {
  tags: number
  aliases: number
  source: string
  imported_at: string
}

/** 可以保存提取结果的素材类型 */
export const MINING_SAVE_KINDS: TemplateKind[] = ['state', 'position', 'subposition', 'expression', 'scene', 'camera', 'global']

export interface MiningSaveItem {
  name: string
  positive: string
  kind: TemplateKind
  parent_id?: number | null
}

export interface MiningSaveOutcome {
  name: string
  status: 'saved' | 'duplicate' | 'error'
  id?: number
  message?: string
}

export interface MiningParams {
  /** 最小共同出现图片数 */
  minSupport: number
  /** 全局公共标签阈值（0~1） */
  globalRatio: number
  /** 最小组合标签数 */
  minSize: number
  /** 关联强度阈值（提升度）：组合中的标签与其余标签一起出现的频率，至少是随机搭配时的几倍 */
  minLift: number
  /** 最多展示的候选组合数 */
  maxCandidates: number
}

export const DEFAULT_MINING: MiningParams = { minSupport: 3, globalRatio: 0.9, minSize: 2, minLift: 2, maxCandidates: 60 }

export const MINING_LIMITS = {
  maxImages: 5000,
  maxPromptLength: 64 * 1024,
  /** 闭项集枚举数量上限（超出时停止并提示提高阈值；按固定顺序枚举，结果仍是确定的） */
  maxClosedSets: 20000,
  /** 去冗余前最多保留的组合数 */
  maxCores: 3000,
  maxVariations: 80,
}

export interface MiningImage {
  id: string
  positive: string
}

export interface TagForm {
  raw: string
  weight: number
  count: number
}

export interface TagStat {
  key: string
  /** 代表写法（出现最多的原始写法；相同时取最早出现的） */
  raw: string
  forms: TagForm[]
  /** 出现的图片数（同一图片中重复只算一次） */
  count: number
  ratio: number
  images: string[]
  /** 是否在词典中；没有导入词典时为 null */
  known: boolean | null
  global: boolean
}

export interface TagRef {
  key: string
  raw: string
  count: number
  images: string[]
}

export interface Candidate {
  /** 由标签比较键决定的稳定 ID */
  id: string
  keys: string[]
  /** 各标签在这些图片中的代表写法（按代表来源图片中的顺序） */
  tags: string[]
  prompt: string
  images: string[]
  support: number
  ratio: number
  /** 关联强度：同时包含全部标签的图片数 ÷ 包含任一标签的图片数 */
  cohesion: number
  /** 组合中最弱的标签提升度：与其余标签一起出现的频率是随机搭配时的几倍 */
  lift: number
  /** 这些图片都有、但在其他图片中也大量出现的标签（关联低于阈值，未放入组合） */
  attached: TagRef[]
  /** 只在部分图片中出现的标签 */
  variations: TagRef[]
  /** 同一标签在这些图片中有不同写法（权重） */
  weightVariants: { key: string; forms: TagForm[] }[]
  /** 代表来源图片 */
  representative: string
  /** 包含本组合、另有额外标签的扩展组合（覆盖更少的图片） */
  extensions: Candidate[]
}

export interface MiningResult {
  params: MiningParams
  total: number
  /** 按路径排序后的图片 ID */
  images: string[]
  global: TagStat[]
  /** 全局公共标签按第一张图片中的顺序拼成的 Prompt */
  globalPrompt: string
  candidates: Candidate[]
  /** 所有标签（按出现图片数降序） */
  tags: TagStat[]
  /** 未被任何候选组合或全局公共标签覆盖的标签 */
  uncovered: string[]
  /** Prompt 完全相同（标签相同、顺序相同）的图片组 */
  duplicates: string[][]
  /** 单张图片内重复出现、统计时已合并的标签次数 */
  innerDupes: number
  truncated: boolean
  /** 实际使用的最小共同出现图片数 */
  minSupport: number
  notes: string[]
  stats: { distinctTags: number; localTags: number; closedSets: number; cores: number }
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const sortIds = (ids: string[]) => [...ids].sort((a, b) => cmp(a.toLowerCase(), b.toLowerCase()) || cmp(a, b))

function clampParams(p: Partial<MiningParams>): MiningParams {
  const n = (v: unknown, d: number, lo: number, hi: number) => {
    const x = Number(v)
    return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d
  }
  return {
    minSupport: Math.round(n(p.minSupport, DEFAULT_MINING.minSupport, 2, 100000)),
    globalRatio: n(p.globalRatio, DEFAULT_MINING.globalRatio, 0.05, 1),
    minSize: Math.round(n(p.minSize, DEFAULT_MINING.minSize, 1, 100)),
    minLift: n(p.minLift, DEFAULT_MINING.minLift, 1, 50),
    maxCandidates: Math.round(n(p.maxCandidates, DEFAULT_MINING.maxCandidates, 1, 1000)),
  }
}

/** 一组图片中某个标签的代表写法：出现最多的写法，相同时取最早出现的 */
function representativeForm(occ: { raw: string; weight: number; order: number }[]): { raw: string; forms: TagForm[] } {
  const m = new Map<string, { raw: string; weight: number; count: number; first: number }>()
  for (const o of occ) {
    const f = m.get(o.raw)
    if (f) f.count++
    else m.set(o.raw, { raw: o.raw, weight: o.weight, count: 1, first: o.order })
  }
  const forms = [...m.values()].sort((a, b) => b.count - a.count || a.first - b.first)
  return { raw: forms[0].raw, forms: forms.map(({ raw, weight, count }) => ({ raw, weight, count })) }
}

export function minePrompts(input: MiningImage[], params: Partial<MiningParams> = {}, dict?: TagDictionary | null): MiningResult {
  const P = clampParams(params)
  const notes: string[] = []
  if (input.length > MINING_LIMITS.maxImages) throw new Error(`一次最多分析 ${MINING_LIMITS.maxImages} 张图片`)
  // 同一 ID 只取一次；按 ID（路径）排序，与文件遍历顺序无关
  const byId = new Map<string, MiningImage>()
  for (const im of input) if (!byId.has(im.id)) byId.set(im.id, im)
  const ids = sortIds([...byId.keys()])
  const N = ids.length
  let innerDupes = 0
  let truncatedPrompts = 0
  const docs: PromptToken[][] = ids.map((id) => {
    let text = byId.get(id)!.positive ?? ''
    if (text.length > MINING_LIMITS.maxPromptLength) {
      text = text.slice(0, MINING_LIMITS.maxPromptLength)
      truncatedPrompts++
    }
    const r = tokenizePrompt(text, dict)
    innerDupes += r.dupes
    return r.tokens
  })
  if (truncatedPrompts) notes.push(`${truncatedPrompts} 张图片的 Prompt 过长，只分析了前 ${MINING_LIMITS.maxPromptLength} 个字符`)

  // ---------------- 标签统计
  type Acc = { key: string; docs: number[]; occ: { raw: string; weight: number; order: number }[]; posSum: number }
  const acc = new Map<string, Acc>()
  let order = 0
  docs.forEach((toks, d) =>
    toks.forEach((t, i) => {
      let a = acc.get(t.key)
      if (!a) acc.set(t.key, (a = { key: t.key, docs: [], occ: [], posSum: 0 }))
      a.docs.push(d)
      a.occ.push({ raw: t.raw, weight: t.weight, order: order++ })
      a.posSum += toks.length > 1 ? i / (toks.length - 1) : 0
    }),
  )
  const globalMin = Math.max(2, Math.ceil(P.globalRatio * N - 1e-9))
  const isGlobal = (a: Acc) => N >= 2 && a.docs.length >= globalMin
  const stats = new Map<string, TagStat>()
  for (const a of acc.values()) {
    const rep = representativeForm(a.occ)
    stats.set(a.key, { key: a.key, raw: rep.raw, forms: rep.forms, count: a.docs.length, ratio: a.docs.length / N, images: a.docs.map((d) => ids[d]), known: dict ? dict.tags.has(a.key) : null, global: isGlobal(a) })
  }
  const tags = [...stats.values()].sort((a, b) => b.count - a.count || acc.get(a.key)!.occ[0].order - acc.get(b.key)!.occ[0].order)
  // 全局公共标签按第一张包含它的图片中的顺序排列（平均位置作为次要依据）
  const global = tags.filter((t) => t.global).sort((a, b) => acc.get(a.key)!.posSum / a.count - acc.get(b.key)!.posSum / b.count || cmp(a.key, b.key))
  const firstWithAll = docs.find((toks) => global.every((g) => toks.some((t) => t.key === g.key)))
  const globalOrdered = firstWithAll ? [...global].sort((a, b) => firstWithAll.findIndex((t) => t.key === a.key) - firstWithAll.findIndex((t) => t.key === b.key)) : global
  const globalPrompt = globalOrdered.map((g) => g.raw).join(', ')

  // ---------------- 局部挖掘：排除全局标签与出现次数不足的标签
  const local = [...acc.values()].filter((a) => !isGlobal(a) && a.docs.length >= P.minSupport).map((a) => a.key).sort(cmp)
  const itemOf = new Map(local.map((k, i) => [k, i]))
  const df = local.map((k) => acc.get(k)!.docs.length)
  const trans: number[][] = docs.map((toks) => toks.map((t) => itemOf.get(t.key)).filter((x): x is number => x !== undefined).sort((a, b) => a - b))
  const m = local.length
  const counts = new Int32Array(m)
  let closedSets = 0
  let truncated = false
  let closed: { items: number[]; tids: number[] }[] = []
  /** 实际使用的最小共同出现图片数（组合过多时自动提高） */
  let minSup = P.minSupport

  /** 在图片集合 T 上：各标签出现次数 */
  const occurrence = (T: number[]) => {
    const touched: number[] = []
    for (const t of T)
      for (const it of trans[t]) {
        if (counts[it]++ === 0) touched.push(it)
      }
    return touched
  }
  const reset = (touched: number[]) => {
    for (const it of touched) counts[it] = 0
  }
  /** 闭包：T 中所有图片都包含的标签 */
  const closure = (T: number[]): number[] => {
    const touched = occurrence(T)
    const out = touched.filter((it) => counts[it] === T.length).sort((a, b) => a - b)
    reset(touched)
    return out
  }
  const rec = (Pset: number[], T: number[], core: number) => {
    if (truncated) return
    if (++closedSets > MINING_LIMITS.maxClosedSets) {
      truncated = true
      return
    }
    if (Pset.length) closed.push({ items: Pset, tids: T })
    const inP = new Set(Pset)
    const touched = occurrence(T)
    const exts = touched.filter((e) => e > core && !inP.has(e) && counts[e] >= minSup).sort((a, b) => a - b)
    reset(touched)
    for (const e of exts) {
      if (truncated) return
      const T2 = T.filter((t) => binHas(trans[t], e))
      const Q = closure(T2)
      // 前缀保持：Q 中小于 e 的标签必须与 P 中小于 e 的标签相同
      let ok = true
      let pi = 0
      for (const q of Q) {
        if (q >= e) break
        if (Pset[pi] !== q) {
          ok = false
          break
        }
        pi++
      }
      if (ok && pi < Pset.length && Pset[pi] < e) ok = false
      if (ok) rec(Q, T2, e)
    }
  }
  // 闭项集超过上限时，不按枚举顺序截断（会偏向某些标签），而是逐步提高最小共同出现图片数后重新枚举
  let gaveUp = false
  for (let attempt = 0; N >= minSup && m; attempt++) {
    closedSets = 0
    truncated = false
    closed = []
    const all = ids.map((_, i) => i)
    rec(closure(all), all, -1)
    if (!truncated) break
    if (attempt >= 12 || minSup >= N) {
      gaveUp = true
      break
    }
    minSup = Math.min(N, Math.ceil(minSup * 1.5))
  }
  if (N < P.minSupport) notes.push(`参与分析的图片（${N} 张）少于最小共同出现图片数（${P.minSupport}），无法发现局部组合`)
  if (minSup > P.minSupport && !gaveUp) notes.push(`重复组合数量过多，已自动把最小共同出现图片数从 ${P.minSupport} 提高到 ${minSup}`)
  if (gaveUp) notes.push(`重复组合数量过多，只枚举了前 ${MINING_LIMITS.maxClosedSets} 个，结果可能不完整。请提高「最小共同出现图片数」或减少图片后重新分析`)

  // ---------------- 关联过滤：得到每个闭项集的「核心标签」，相同核心只保留一次
  const tidsOf = (items: number[]): number[] => {
    if (!items.length) return ids.map((_, i) => i)
    const rarest = items.reduce((a, b) => (df[a] <= df[b] ? a : b))
    return acc.get(local[rarest])!.docs.filter((d) => items.every((it) => binHas(trans[d], it)))
  }
  /**
   * 组合中标签 i 与其余标签的关联：
   * - 提升度 lift = P(i | 其余) ÷ P(i)：与其余标签一起出现的频率是随机搭配时的几倍；
   * - 必要度 need = 有其余标签时 i 也出现的比例；依附度 only = i 出现时其余标签也在的比例。
   *   这两项 ≥ 90% 时说明总是一起使用（例如覆盖大部分图片的组合，提升度上限较低），
   *   但只有在不能用随机搭配解释时才算数（二项分布右尾概率 < 5%），避免少见标签碰巧总和常见背景标签同时出现。
   * 都达不到的标签（例如随机出现的场景、表情）不放入组合。
   */
  const tagAssoc = (items: number[], s: number) =>
    items.map((it) => {
      const rest = tidsOf(items.filter((x) => x !== it)).length
      const need = s / rest
      const only = s / df[it]
      const together = (need >= 0.9 - 1e-9 && binomTail(rest, s, df[it] / N) < 0.05) || (only >= 0.9 - 1e-9 && binomTail(df[it], s, rest / N) < 0.05)
      return { it, lift: (s * N) / (df[it] * rest), need, together }
    })
  const passes = (a: { lift: number; together: boolean }) => a.together || a.lift >= P.minLift - 1e-9
  /** 逐个移除关联最弱且不达标的标签，直到全部达标 */
  const coreOf = (items: number[]): { items: number[]; tids: number[] } => {
    let cur = items
    let tids = tidsOf(cur)
    while (cur.length > 1) {
      const weak = tagAssoc(cur, tids.length)
        .filter((a) => !passes(a))
        .sort((a, b) => a.lift - b.lift || a.need - b.need || a.it - b.it)
      if (!weak.length) break
      cur = cur.filter((x) => x !== weak[0].it)
      tids = tidsOf(cur)
    }
    return { items: cur, tids }
  }
  const cores = new Map<string, { items: number[]; tids: number[] }>()
  for (const c of closed) {
    const core = coreOf(c.items)
    if (core.items.length < P.minSize || core.tids.length < minSup) continue
    const key = core.items.join(',')
    if (!cores.has(key)) cores.set(key, core)
  }

  // ---------------- 排序与去冗余
  type Core = { items: number[]; tids: number[]; key: string; score: number }
  let list: Core[] = [...cores.entries()].map(([key, c]) => ({ ...c, key, score: c.tids.length * c.items.length }))
  const order1 = (a: Core, b: Core) => b.score - a.score || b.tids.length - a.tids.length || b.items.length - a.items.length || cmp(a.key, b.key)
  list.sort(order1)
  if (list.length > MINING_LIMITS.maxCores) list = list.slice(0, MINING_LIMITS.maxCores)
  const isSubset = (a: number[], b: number[]) => a.length < b.length && a.every((x) => binHas(b, x))
  // a. 子组合被几乎同样多图片（≥ 80%）的超组合覆盖：只保留更完整的超组合
  const kept = list.filter((a) => !list.some((b) => isSubset(a.items, b.items) && b.tids.length >= 0.8 * a.tids.length))
  // b. 包含另一个已列出组合的超组合（多出的标签只在部分图片中出现）：嵌套为该组合的「扩展组合」，不在顶层重复列出
  const top: Core[] = []
  const nested = new Map<Core, Core[]>()
  for (const c of kept) {
    const parent = top.find((a) => isSubset(a.items, c.items))
    if (parent) nested.get(parent)!.push(c)
    else {
      top.push(c)
      nested.set(c, [])
    }
  }
  const finalCores = top.slice(0, P.maxCandidates)
  if (top.length > finalCores.length) notes.push(`共有 ${top.length} 个候选组合，只显示前 ${finalCores.length} 个（可在参数中调整）`)

  // ---------------- 组装候选
  const build = (c: Core): Candidate => {
    const T = c.tids
    const coreKeys = new Set(c.items.map((i) => local[i]))
    const rep = docs[T[0]]
    const pos = new Map(rep.map((t, i) => [t.key, i]))
    const keys = [...coreKeys].sort((a, b) => (pos.get(a) ?? 0) - (pos.get(b) ?? 0) || cmp(a, b))
    const occIn = (key: string) => {
      const out: { raw: string; weight: number; order: number }[] = []
      for (const d of T) {
        const t = docs[d].find((x) => x.key === key)
        if (t) out.push({ raw: t.raw, weight: t.weight, order: d })
      }
      return out
    }
    const reps = keys.map((k) => representativeForm(occIn(k)))
    const union = new Set<number>()
    for (const k of keys) for (const d of acc.get(k)!.docs) union.add(d)
    const others = new Map<string, number[]>()
    for (const d of T)
      for (const t of docs[d]) {
        if (coreKeys.has(t.key) || stats.get(t.key)!.global) continue
        const l = others.get(t.key)
        if (l) l.push(d)
        else others.set(t.key, [d])
      }
    const ref = (key: string, ds: number[]): TagRef => ({ key, raw: representativeForm(occIn(key)).raw, count: ds.length, images: ds.map((d) => ids[d]) })
    const byCount = (a: TagRef, b: TagRef) => b.count - a.count || cmp(a.key, b.key)
    const attached = [...others].filter(([, ds]) => ds.length === T.length).map(([k, ds]) => ref(k, ds)).sort(byCount)
    const variations = [...others].filter(([, ds]) => ds.length < T.length).map(([k, ds]) => ref(k, ds)).sort(byCount).slice(0, MINING_LIMITS.maxVariations)
    const assoc = c.items.length > 1 ? tagAssoc(c.items, T.length) : []
    return {
      id: [...keys].sort(cmp).join('\u0001'),
      keys,
      tags: reps.map((r) => r.raw),
      prompt: reps.map((r) => r.raw).join(', '),
      images: T.map((d) => ids[d]),
      support: T.length,
      ratio: T.length / N,
      cohesion: T.length / union.size,
      lift: assoc.length ? Math.min(...assoc.map((a) => a.lift)) : 1,
      attached,
      variations,
      weightVariants: keys.map((k, i) => ({ key: k, forms: reps[i].forms })).filter((w) => w.forms.length > 1),
      representative: ids[T[0]],
      extensions: [],
    }
  }
  const candidates: Candidate[] = finalCores.map((c) => ({ ...build(c), extensions: nested.get(c)!.slice(0, 12).map(build) }))

  const covered = new Set([...global.map((g) => g.key), ...candidates.flatMap((c) => c.keys)])
  const uncovered = tags.filter((t) => !covered.has(t.key)).map((t) => t.key)

  // 完全相同的 Prompt（标签与顺序都相同）
  const sameMap = new Map<string, string[]>()
  docs.forEach((toks, d) => {
    const sig = toks.map((t) => `${t.key}\u0002${t.weight}`).join('\u0001')
    const l = sameMap.get(sig)
    if (l) l.push(ids[d])
    else sameMap.set(sig, [ids[d]])
  })
  const duplicates = [...sameMap.values()].filter((g) => g.length > 1)

  return {
    params: P,
    total: N,
    images: ids,
    global: globalOrdered,
    globalPrompt,
    candidates,
    tags,
    uncovered,
    duplicates,
    innerDupes,
    truncated: gaveUp,
    minSupport: minSup,
    notes,
    stats: { distinctTags: acc.size, localTags: m, closedSets: Math.min(closedSets, MINING_LIMITS.maxClosedSets), cores: cores.size },
  }
}

/** 二项分布右尾概率 P(X ≥ k)，X ~ B(n, p)（对数空间计算，避免大 n 时溢出） */
export function binomTail(n: number, k: number, p: number): number {
  if (k <= 0) return 1
  if (p <= 0) return 0
  if (p >= 1) return 1
  const lp = Math.log(p)
  const lq = Math.log(1 - p)
  let lf = 0 // log(i!)
  const logFact = [0]
  for (let i = 1; i <= n; i++) logFact.push((lf += Math.log(i)))
  let sum = 0
  for (let i = k; i <= n; i++) sum += Math.exp(logFact[n] - logFact[i] - logFact[n - i] + i * lp + (n - i) * lq)
  return Math.min(1, sum)
}

/** 有序数组中是否包含 x */
function binHas(arr: number[], x: number): boolean {
  let lo = 0
  let hi = arr.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid] === x) return true
    if (arr[mid] < x) lo = mid + 1
    else hi = mid - 1
  }
  return false
}
