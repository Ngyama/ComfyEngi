// 动作卡（如「正常位」）→ 姿态模板。每个姿态模板是人工写好的完整 Prompt，生成时整份使用，不再临时拼接素材池。
// 模板中的占位符（{全局}、{女特征}、{表情}、{行为} 等）在生成时替换为对应内容，位置由模板决定；其余文字（换行、权重、动态语法）原样保留。
// 动作卡只负责姿态：表情、行为由动作序列选择。每张图从启用的姿态模板中按组合 Seed 轮流抽取一个（每轮打乱一次）。
// 模板的 category 字段是旧版「子体位」，只用于排序，不再参与抽取或分配张数。

import { cardPool, mixSeed, resolvePool, seededRandom } from './cards'
import { CARD_POOLS, type ActionCard, type CardPoolKey, type CardTemplatePick, type Template } from './types'

/** 占位符 → 模块。同一模块可以有多个写法（女特征 / 主角色） */
export const TEMPLATE_SLOTS: { module: string; names: string[]; label: string }[] = [
  { module: 'global', names: ['全局'], label: '全局 Prompt（画质 / 画风）' },
  { module: 'style', names: ['画风'], label: '画风（已合并到 {全局}，这里始终留空）' },
  { module: 'scene', names: ['场景'], label: '场景' },
  { module: 'camera', names: ['镜头'], label: '镜头' },
  { module: 'character', names: ['女特征', '主角色'], label: '主角色基础 Prompt（含 LoRA 触发词）' },
  { module: 'outfit', names: ['女服装', '主角色服装'], label: '主角色服装' },
  { module: 'expression', names: ['表情', '女表情'], label: '主角色表情（动作序列中选择；模板没有 {表情} 时写在 {女服装} 之后）' },
  { module: 'interaction', names: ['行为'], label: '行为（每张从动作序列的行为候选中随机 0～1 个；模板没有 {行为} 时写在 {男特征} 之前）' },
  { module: 'character2', names: ['男特征', '第二角色'], label: '第二角色基础 Prompt' },
  { module: 'outfit2', names: ['男服装', '第二角色服装'], label: '第二角色服装' },
  { module: 'expression2', names: ['男表情', '第二角色表情'], label: '第二角色表情（模板没有 {男表情} 时写在 {男服装} 之后）' },
  { module: 'extra', names: ['附加'], label: '动作的附加 Prompt（模板中没有时追加在末尾）' },
]
const SLOT_OF = new Map(TEMPLATE_SLOTS.flatMap((s) => s.names.map((n) => [n, s.module] as const)))
/** 角色名占位符由 fillPlaceholders 处理，这里只需要认得它们 */
const OTHER_NAMES = new Set(['角色名', '角色标签'])

export const UNCATEGORIZED = ''
export const categoryLabel = (c: string) => c || '未分类'

/** 新建模板的默认正文：双人卡含第二角色一行；中间空行写姿态 */
export function defaultSkeleton(solo: boolean): string {
  return ['{全局},', '{场景}, {镜头},', '{女特征}, {女服装}, {表情},', '', '{行为},', ...(solo ? [] : ['{男特征}, {男服装}, {男表情},']), '{附加}'].join('\n')
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
/**
 * 模板没有写对应占位符时仍会写入的模块及其默认位置（按顺序找第一个存在的锚点；都没有时追加在末尾）。
 * 其他模块没有占位符就不写入（规划时提示）
 */
const ANCHORS: Record<string, { after?: string[]; before?: string[] }> = {
  expression: { after: ['outfit', 'character'] },
  expression2: { after: ['outfit2', 'character2'] },
  interaction: { before: ['character2'] },
  extra: {},
}
export const APPENDED = Object.keys(ANCHORS)
const clean = (v: string | undefined) => (v ?? '').trim().replace(/[,，\s]+$/, '')
const slotRe = (mod: string) => new RegExp(`\\{\\s*(?:${TEMPLATE_SLOTS.find((s) => s.module === mod)!.names.join('|')})\\s*\\}`)

/** 模块的默认插入位置：模板已有该占位符时为 null；index 为插入位置，before 表示插在锚点前 */
export function moduleAnchor(body: string, mod: string): { index: number; before: boolean } | null {
  const a = ANCHORS[mod]
  if (!a || templatePlaceholders(body).modules.has(mod)) return null
  for (const m of a.after ?? []) {
    const hit = slotRe(m).exec(body ?? '')
    if (hit) return { index: hit.index + hit[0].length, before: false }
  }
  for (const m of a.before ?? []) {
    const hit = slotRe(m).exec(body ?? '')
    if (hit) return { index: hit.index, before: true }
  }
  return null
}

/** 表情的默认位置：模板没有 {表情} 时紧跟在主角色服装之后（没有服装占位符时在主角色之后，都没有时追加在末尾） */
export const expressionAnchor = (body: string): { index: number } | null => moduleAnchor(body, 'expression')

/**
 * 按占位符位置填入模块内容。空内容的占位符连同相邻的一个逗号一起去掉；整行只剩占位符时删除这一行。
 * 模板中没有 {表情} / {男表情} / {行为} 而内容不为空时写在默认位置（见 moduleAnchor），没有 {附加} 时追加在末尾。
 * 其他文字（权重、换行、动态语法）原样保留
 */
export function fillTemplate(body: string, values: Partial<Record<string, string>>): string {
  const used = new Set<string>()
  let source = body ?? ''
  for (const mod of APPENDED) {
    if (!clean(values[mod])) continue
    const at = moduleAnchor(source, mod)
    if (!at) continue
    const ph = `{${TEMPLATE_SLOTS.find((s) => s.module === mod)!.names[0]}}`
    source = `${source.slice(0, at.index)}${at.before ? `${ph}, ` : `, ${ph}`}${source.slice(at.index)}`
  }
  const replaced = source.replace(/\{([^{}|]*)\}/g, (all, raw: string) => {
    const mod = SLOT_OF.get(raw.trim())
    if (!mod) return all
    used.add(mod)
    return clean(values[mod]) || S
  })
  // 整行删除后，原本分隔它的两侧空行只保留一个（模板自己写的空行不变）
  const lines: string[] = []
  let removed = false
  for (const line of replaced.split('\n')) {
    const l = line.includes(S)
      ? line
          .replace(new RegExp(`${S}[ \\t]*[,，][ \\t]*`, 'g'), '')
          .replace(new RegExp(`[ \\t]*[,，]?[ \\t]*${S}`, 'g'), '')
          .replace(/[ \t]+$/, '')
      : line
    if (line.includes(S) && !l.trim()) {
      removed = true
      continue
    }
    if (removed && !l.trim() && lines.length && !lines[lines.length - 1].trim()) continue
    removed = false
    lines.push(l)
  }
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

/** 一张动作卡的全部姿态模板，按手动顺序排列（旧版子体位分类不再影响顺序） */
export function cardTemplates(card: Pick<Template, 'id' | 'card'>, all: Iterable<Template>): Template[] {
  return [...all].filter((t) => t.kind === 'card_tpl' && t.parent_id === card.id).sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.id - b.id)
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

/**
 * 勾选 / 取消姿态模板（ids 为要改变的模板）。结果只用 exclude 表示「不参与的模板」，之后新增的模板默认参与；
 * 旧任务中按分类（子体位）的选择在第一次修改时转换为等价的排除列表。全部启用时返回 undefined
 */
export function setPicked(tpls: Template[], pick: CardTemplatePick | null | undefined, ids: number[], on: boolean): CardTemplatePick | undefined {
  const change = new Set(ids)
  const exclude = tpls.filter((t) => (change.has(t.id) ? !on : !isPicked(t, pick))).map((t) => t.id)
  return exclude.length ? { exclude } : undefined
}

/** 旧任务的模板来源是否还在使用分类（子体位）选择 */
export const legacyPick = (pick: CardTemplatePick | null | undefined) => !!(pick?.categories || pick?.include?.length)

// ---------------------------------------------------------------- 抽取
const TEMPLATE_STREAM = 0x74706c
const BEHAVIOR_STREAM = 0x626876

function shuffled(n: number, rnd: () => number): number[] {
  const order = Array.from({ length: n }, (_, i) => i)
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[order[i], order[j]] = [order[j], order[i]]
  }
  return order
}

/** 第 k 张图片的姿态模板：第 r 轮（k / n）把全部模板打乱后依次使用，同样的组合 Seed 得到同样的顺序 */
export function drawTemplate<T>(list: T[], comboSeed: number, itemIndex: number, k: number, stream = 0): T | null {
  const n = list.length
  if (!n) return null
  if (n === 1) return list[0]
  const order = shuffled(n, seededRandom(mixSeed(comboSeed, itemIndex, Math.floor(k / n), TEMPLATE_STREAM + stream)))
  return list[order[k % n]]
}

/** 第 k 张图片的行为：在「无行为」和每个候选之间等概率抽取（每张独立），没有候选时始终为 null */
export function drawBehavior<T>(candidates: T[], comboSeed: number, itemIndex: number, k: number): T | null {
  if (!candidates.length) return null
  const i = Math.floor(seededRandom(mixSeed(comboSeed, itemIndex, k, BEHAVIOR_STREAM))() * (candidates.length + 1))
  return i === 0 ? null : candidates[i - 1]
}

/** 旧版在动作卡 / 姿态模板上设置的表情 ID（新版本不再使用，只用于提示和清除） */
export function legacyExpressionIds(card: Pick<Template, 'card'> | null | undefined, tpls: Pick<Template, 'card'>[]): number[] {
  const out = new Set<number>(card?.card?.expressions ?? [])
  for (const t of tpls) for (const id of t.card?.expressions ?? []) out.add(id)
  return [...out]
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
