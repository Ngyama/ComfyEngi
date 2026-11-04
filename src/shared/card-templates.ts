// 模板体位：体位（动作卡）→ 子体位（分类）→ Prompt 模板。每个模板是人工写好的完整 Prompt，生成时整份使用，不再临时拼接素材池。
// 模板中的占位符（{全局}、{女特征}、{表情} 等）在生成时替换为对应内容，位置由模板决定；其余文字原样保留。
// 张数先按选中的子体位平分（除不尽的几张由组合 Seed 随机分给其中几个子体位），子体位内的「模板 × 表情」组合轮流使用。

import { cardPool, mixSeed, resolvePool, seededRandom } from './cards'
import { CARD_POOLS, type ActionCard, type CardPoolKey, type CardTemplatePick, type Template } from './types'

/** 占位符 → 模块。同一模块可以有多个写法（女特征 / 主角色） */
export const TEMPLATE_SLOTS: { module: string; names: string[]; label: string }[] = [
  { module: 'global', names: ['全局'], label: '全局 Prompt（画质 / 画风）' },
  { module: 'scene', names: ['场景'], label: '场景' },
  { module: 'camera', names: ['镜头'], label: '镜头' },
  { module: 'character', names: ['女特征', '主角色'], label: '主角色基础 Prompt（含 LoRA 触发词）' },
  { module: 'outfit', names: ['女服装', '主角色服装'], label: '主角色服装' },
  { module: 'expression', names: ['表情'], label: '表情（模板没有 {表情} 时追加在末尾）' },
  { module: 'character2', names: ['男特征', '第二角色'], label: '第二角色基础 Prompt' },
  { module: 'outfit2', names: ['男服装', '第二角色服装'], label: '第二角色服装' },
  { module: 'extra', names: ['附加'], label: '动作的附加 Prompt（模板中没有时追加在末尾）' },
]
const SLOT_OF = new Map(TEMPLATE_SLOTS.flatMap((s) => s.names.map((n) => [n, s.module] as const)))
/** 角色名占位符由 fillPlaceholders 处理，这里只需要认得它们 */
const OTHER_NAMES = new Set(['角色名', '角色标签'])

export const UNCATEGORIZED = ''
export const categoryLabel = (c: string) => c || '未分类'

/** 新建模板的默认正文：双人卡含第二角色一行；中间空行写动作 */
export function defaultSkeleton(solo: boolean): string {
  return ['{全局},', '{场景}, {镜头},', '{女特征}, {女服装},', '', '{表情},', ...(solo ? [] : ['{男特征}, {男服装},']), '{附加}'].join('\n')
}
export const skeletonOf = (card: Pick<Template, 'card'> | null | undefined) => card?.card?.skeleton ?? defaultSkeleton(!!card?.card?.solo)

/** 模板中出现的占位符：已知的模块、无法识别的名称（只检查含中文的花括号，{a|b} 等动态语法不算） */
export function templatePlaceholders(body: string): { modules: Set<string>; unknown: string[] } {
  const modules = new Set<string>()
  const unknown: string[] = []
  for (const m of (body ?? '').matchAll(/\{([^{}|]*)\}/g)) {
    const name = m[1].trim()
    const mod = SLOT_OF.get(name)
    if (mod) modules.add(mod)
    else if (/[一-鿿]/.test(name) && !OTHER_NAMES.has(name) && !unknown.includes(m[0])) unknown.push(m[0])
  }
  return { modules, unknown }
}

const S = '\u0000'
/** 模板没有写占位符时追加在末尾的模块（其他模块没有占位符就不写入） */
export const APPENDED = ['expression', 'extra']
const clean = (v: string | undefined) => (v ?? '').trim().replace(/[,，\s]+$/, '')

/**
 * 按占位符位置填入模块内容。空内容的占位符连同相邻的一个逗号一起去掉；整行只剩占位符时删除这一行。
 * 模板中没有 {表情}、{附加} 而内容不为空时，依次追加在末尾。其他文字（权重、换行、动态语法）原样保留
 */
export function fillTemplate(body: string, values: Partial<Record<string, string>>): string {
  const used = new Set<string>()
  const replaced = (body ?? '').replace(/\{([^{}|]*)\}/g, (all, raw: string) => {
    const mod = SLOT_OF.get(raw.trim())
    if (!mod) return all
    used.add(mod)
    return clean(values[mod]) || S
  })
  const lines = replaced.split('\n').flatMap((line) => {
    if (!line.includes(S)) return [line]
    const l = line
      .replace(new RegExp(`${S}[ \\t]*[,，][ \\t]*`, 'g'), '')
      .replace(new RegExp(`[ \\t]*[,，]?[ \\t]*${S}`, 'g'), '')
      .replace(/[ \t]+$/, '')
    return l.trim() ? [l] : []
  })
  let text = lines.join('\n').trim()
  for (const mod of APPENDED) {
    const v = clean(values[mod])
    if (!used.has(mod) && v) text = text ? `${text.replace(/[,，\s]+$/, '')}, ${v}` : v
  }
  // 末尾的占位符为空时会留下悬空的逗号
  return text.replace(/[,，\s]+$/, '')
}

// ---------------------------------------------------------------- 分类与选择
export const isTemplateCard = (t: Pick<Template, 'kind' | 'card'> | null | undefined): boolean => t?.kind === 'position' && !!t.card?.templates

/** 分类的显示顺序：动作卡保存的顺序，其后是模板中出现但没有登记的分类，未分类最后 */
export function categoryOrder(card: ActionCard | null | undefined, tpls: Pick<Template, 'category'>[]): string[] {
  const out: string[] = []
  for (const c of card?.categories ?? []) if (c && !out.includes(c)) out.push(c)
  for (const t of tpls) if (t.category && !out.includes(t.category)) out.push(t.category)
  if (tpls.some((t) => !t.category)) out.push(UNCATEGORIZED)
  return out
}

/** 一张动作卡的全部模板，按分类顺序、分类内的手动顺序排列 */
export function cardTemplates(card: Pick<Template, 'id' | 'card'>, all: Iterable<Template>): Template[] {
  const own = [...all].filter((t) => t.kind === 'card_tpl' && t.parent_id === card.id)
  const order = categoryOrder(card.card, own)
  const rank = (c: string) => {
    const i = order.indexOf(c ?? '')
    return i < 0 ? order.length : i
  }
  return own.sort((a, b) => rank(a.category) - rank(b.category) || (a.sort ?? 0) - (b.sort ?? 0) || a.id - b.id)
}

/** 动作序列实际参与抽取的模板（顺序与 cardTemplates 相同） */
export function pickedTemplates(tpls: Template[], pick: CardTemplatePick | null | undefined): Template[] {
  if (!pick) return tpls
  const cats = pick.categories ? new Set(pick.categories) : null
  const include = new Set(pick.include ?? [])
  const exclude = new Set(pick.exclude ?? [])
  return tpls.filter((t) => !exclude.has(t.id) && (!cats || cats.has(t.category ?? '') || include.has(t.id)))
}

/** 一个模板是否参与抽取（界面勾选状态，与 pickedTemplates 一致） */
export const isPicked = (t: Template, pick: CardTemplatePick | null | undefined) => pickedTemplates([t], pick).length === 1

/** 勾选 / 取消一个分类：之前单独加入或排除的这个分类的模板恢复跟随分类 */
export function toggleCategory(tpls: Template[], pick: CardTemplatePick | null | undefined, cat: string, on: boolean): CardTemplatePick {
  const all = categoryOrder(null, tpls)
  const cats = new Set(pick?.categories ?? all)
  if (on) cats.add(cat)
  else cats.delete(cat)
  const inCat = new Set(tpls.filter((t) => (t.category ?? '') === cat).map((t) => t.id))
  return simplify(tpls, { categories: [...cats], include: (pick?.include ?? []).filter((x) => !inCat.has(x)), exclude: (pick?.exclude ?? []).filter((x) => !inCat.has(x)) })
}

/** 勾选 / 取消一个模板 */
export function toggleTemplate(tpls: Template[], pick: CardTemplatePick | null | undefined, t: Template, on: boolean): CardTemplatePick {
  const cats = new Set(pick?.categories ?? categoryOrder(null, tpls))
  const follows = cats.has(t.category ?? '')
  const include = (pick?.include ?? []).filter((x) => x !== t.id)
  const exclude = (pick?.exclude ?? []).filter((x) => x !== t.id)
  if (on && !follows) include.push(t.id)
  if (!on && follows) exclude.push(t.id)
  return simplify(tpls, { categories: [...cats], include, exclude })
}

/** 全部勾选时去掉多余字段（等于默认：全部模板，之后新增的模板也参与） */
function simplify(tpls: Template[], p: CardTemplatePick): CardTemplatePick {
  const all = categoryOrder(null, tpls)
  const known = new Set(tpls.map((t) => t.id))
  const out: CardTemplatePick = {}
  const cats = (p.categories ?? []).filter((c, i, a) => a.indexOf(c) === i)
  if (!all.every((c) => cats.includes(c))) out.categories = cats
  const include = (p.include ?? []).filter((x) => known.has(x))
  const exclude = (p.exclude ?? []).filter((x) => known.has(x))
  if (include.length) out.include = include
  if (exclude.length) out.exclude = exclude
  return out
}

// ---------------------------------------------------------------- 抽取
const TEMPLATE_STREAM = 0x74706c

const SPLIT_STREAM = 0x737562

function shuffled(n: number, rnd: () => number): number[] {
  const order = Array.from({ length: n }, (_, i) => i)
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[order[i], order[j]] = [order[j], order[i]]
  }
  return order
}

/** 第 k 张图片的组合：第 r 轮（k / n）把全部组合打乱后依次使用，同样的组合 Seed 得到同样的顺序。stream 区分同一动作中的不同子体位 */
export function drawTemplate<T>(list: T[], comboSeed: number, itemIndex: number, k: number, stream = 0): T | null {
  const n = list.length
  if (!n) return null
  if (n === 1) return list[0]
  const order = shuffled(n, seededRandom(mixSeed(comboSeed, itemIndex, Math.floor(k / n), TEMPLATE_STREAM + stream)))
  return list[order[k % n]]
}

/** 模板使用的表情 ID：模板单独设置的优先，没有时使用体位的默认表情 */
export const templateExpressionIds = (t: Pick<Template, 'card'>, card: Pick<Template, 'card'> | null | undefined): number[] => (t.card?.expressions?.length ? t.card.expressions : card?.card?.expressions) ?? []

export interface TemplateCombo {
  template: Template
  expression: Template | null
}

/** 模板 × 表情：每个模板与它的每个表情组成一种组合；没有表情时模板单独成一种。已删除的表情跳过并计入 missing */
export function templateCombos(list: Template[], card: Pick<Template, 'card'> | null | undefined, getExpr: (id: number) => Template | null | undefined): { combos: TemplateCombo[]; missing: number } {
  let missing = 0
  const combos = list.flatMap((t): TemplateCombo[] => {
    const ids = templateExpressionIds(t, card)
    if (!ids.length) return [{ template: t, expression: null }]
    const ex = ids.map((id) => getExpr(id)).filter((e): e is Template => !!e)
    missing += ids.length - ex.length
    return ex.length ? ex.map((e) => ({ template: t, expression: e })) : [{ template: t, expression: null }]
  })
  return { combos, missing }
}

/** 选中的模板按子体位分组（顺序与 categoryOrder 相同；没有选中模板的子体位不出现） */
export function groupBySubposition(card: Pick<Template, 'card'> | null | undefined, list: Template[]): { category: string; templates: Template[] }[] {
  return categoryOrder(card?.card, list)
    .map((c) => ({ category: c, templates: list.filter((t) => (t.category ?? '') === c) }))
    .filter((g) => g.templates.length)
}

/**
 * 张数在 n 个子体位之间平分；除不尽的 r 张由组合 Seed 随机分给 r 个子体位。
 * 返回每张图片属于第几个子体位、是该子体位的第几张；各子体位交错排列（多尺寸时每种尺寸都有各个子体位）
 */
export function splitBySubposition(n: number, total: number, comboSeed: number, itemIndex: number): { group: number; index: number }[] {
  if (n <= 0 || total <= 0) return []
  const quota = Array.from({ length: n }, () => Math.floor(total / n))
  const order = shuffled(n, seededRandom(mixSeed(comboSeed, itemIndex, 0, SPLIT_STREAM)))
  for (let i = 0; i < total % n; i++) quota[order[i]]++
  const used = quota.map(() => 0)
  const out: { group: number; index: number }[] = []
  for (let r = 0; out.length < total; r++) for (let g = 0; g < n; g++) if (r < quota[g]) out.push({ group: g, index: used[g]++ })
  return out
}

/** 界面说明：每个子体位多少张 */
export function splitSummary(n: number, total: number): string {
  if (!n) return '没有选中子体位'
  const per = Math.floor(total / n)
  const rest = total % n
  return n === 1 ? `${total} 张` : `每个子体位 ${per}${rest ? `～${per + 1}` : ''} 张${rest ? `（多出的 ${rest} 张随机分配）` : ''}`
}

// ---------------------------------------------------------------- 显示
/** 模板中直接书写的标签（不含占位符），用于自动摘要 */
export function templateTags(body: string): string[] {
  return (body ?? '')
    .split(/[,，\n]/)
    .map((s) => s.trim())
    .filter((s) => s && !/^\{[^{}|]*\}$/.test(s))
}
const tagKey = (s: string) => s.toLowerCase().replace(/[\s_]+/g, ' ').replace(/^[([{]+|[)\]}]+$/g, '').replace(/:[\d.]+$/, '').trim()

/** 自动摘要：这个模板有、而同组模板不全有的标签（同组只有它自己时与整张卡比较） */
export function distinctTags(t: Template, group: Template[], max = 5): string[] {
  const others = group.filter((x) => x.id !== t.id)
  if (!others.length) return []
  const sets = others.map((x) => new Set(templateTags(x.positive).map(tagKey)))
  const out: string[] = []
  for (const tag of templateTags(t.positive)) {
    const k = tagKey(tag)
    if (!sets.every((s) => s.has(k)) && !out.some((x) => tagKey(x) === k)) out.push(tag)
    if (out.length >= max) break
  }
  return out
}

/** 分类颜色（只作辅助，按分类顺序循环使用柔和的颜色） */
export const CATEGORY_COLORS = [
  'bg-sky-500/10 text-sky-700 ring-sky-500/25',
  'bg-amber-500/10 text-amber-700 ring-amber-500/25',
  'bg-emerald-500/10 text-emerald-700 ring-emerald-500/25',
  'bg-rose-500/10 text-rose-700 ring-rose-500/25',
  'bg-violet-500/10 text-violet-700 ring-violet-500/25',
  'bg-teal-500/10 text-teal-700 ring-teal-500/25',
  'bg-orange-500/10 text-orange-700 ring-orange-500/25',
  'bg-indigo-500/10 text-indigo-700 ring-indigo-500/25',
]
export const CATEGORY_BARS = ['bg-sky-500/50', 'bg-amber-500/50', 'bg-emerald-500/50', 'bg-rose-500/50', 'bg-violet-500/50', 'bg-teal-500/50', 'bg-orange-500/50', 'bg-indigo-500/50']
export function categoryColor(order: string[], cat: string): number {
  if (!cat) return -1
  const i = order.indexOf(cat)
  return i < 0 ? -1 : i % CATEGORY_COLORS.length
}

// ---------------------------------------------------------------- 旧版素材池动作卡 → 模板
export const MIGRATED_CATEGORY = '基础'

/**
 * 旧动作卡转换为模板：基础 Prompt + 子体位（每个子体位一个模板）+ 各池的固定素材，放进默认骨架。
 * 随机候选不展开组合（避免生成大量没有检查过的组合），列在说明中由用户补充。
 * get：按 ID 读取素材；subs：这张卡的子体位（按顺序）
 */
export function legacyCardTemplates(card: Template, subs: Template[], get: (id: number) => Template | null | undefined): { templates: { name: string; positive: string }[]; note: string } {
  const solo = !!card.card?.solo
  const pools = new Map(CARD_POOLS.map(({ key }) => [key, resolvePool(cardPool(card, key), card, key, subs)]))
  const names = (list: number[]) => list.map((id) => get(id)).filter((t): t is Template => !!t)
  const text = (list: Template[]) => list.map((t) => (t.positive ?? '').trim().replace(/[,，\s]+$/, '')).filter(Boolean)
  const fixed = (key: CardPoolKey) => text(names(pools.get(key)!.fixed))
  const own = (body: string[], male: string[]) => {
    const lines = ['{全局},', '{场景}, {镜头},', '{女特征}, {女服装},']
    if (body.length) lines.push(`${body.join(', ')},`)
    if (!solo) lines.push(['{男特征}, {男服装}', ...male].join(', ') + ',')
    lines.push('{附加}')
    return lines.join('\n')
  }
  const base = [(card.positive ?? '').trim().replace(/[,，\s]+$/, '')].filter(Boolean)
  const shared = [...fixed('pose'), ...fixed('expr'), ...(solo ? [] : fixed('interaction')), ...fixed('extra')]
  const male = solo ? [] : [...fixed('pose2'), ...fixed('expr2')]
  const variant = pools.get('variant')!
  const fixedVariants = names(variant.fixed)
  const randomVariants = names(variant.random)
  const templates: { name: string; positive: string }[] = []
  const make = (name: string, vs: Template[]) => templates.push({ name, positive: own([...base, ...text(vs), ...shared], male) })
  if (randomVariants.length) for (const v of randomVariants) make(v.name || card.name, [...fixedVariants, v])
  else make(fixedVariants.length ? fixedVariants.map((v) => v.name).join(' + ') : card.name, fixedVariants)
  const lost = CARD_POOLS.filter(({ key, duo }) => key !== 'variant' && !(solo && duo))
    .map(({ key, label }) => [label, names(pools.get(key)!.random).map((t) => t.name || '（未命名）')] as const)
    .filter(([, list]) => list.length)
  const negs = [...fixedVariants, ...randomVariants].filter((v) => (v.negative ?? '').trim()).map((v) => `${v.name}：${v.negative.trim()}`)
  const note = [
    lost.length ? `转换为模板时没有展开的随机候选（可复制模板后手动加入）：\n${lost.map(([l, list]) => `- ${l}：${list.join('、')}`).join('\n')}` : '',
    negs.length ? `子体位的负面 Prompt（模板只有正面，需要时写入动作卡的负面 Prompt）：\n${negs.map((x) => `- ${x}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n')
  return { templates, note }
}
