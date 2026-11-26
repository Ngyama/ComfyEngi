// 人物动作 Prompt 库：情绪组 × 视角（POV / 非 POV）× 体位 → 一份用户写好的完整人物动作 Prompt。
// 三个维度只用于组织和定位，不参与拼接；Prompt 正文原样保存（换行、权重、Wildcard、Tag 顺序都不改）。
//
// 拼接（composeActionPrompt）是这里唯一的 Prompt 处理：
//   {全局},
//   {场景}, {镜头},
//
//   1girl, {女特征}, {女服装}, [用户 Prompt 中 1girl 之后的内容]
//   1man, {男特征}, {男服装}, [用户 Prompt 中 1man 之后的内容]
//
//   {附加}
// 1girl / 1man 必须是独立的 Tag（逗号、换行分隔，且不在括号或 Wildcard 内）；找不到或有多个时不插入，并报告问题。
// 除插入位置与模块之间的连接符外，用户 Prompt 不做任何修改，也不展开 Wildcard。

import { fillTemplate, templatePlaceholders, TEMPLATE_SLOTS } from './card-templates'
import type { Template } from './types'

export const FEMALE_TAG = '1girl'
export const MALE_TAG = '1man'

// ---------------------------------------------------------------- 分类与定位
export const VIEWS: { pov: boolean; label: string }[] = [
  { pov: true, label: 'POV' },
  { pov: false, label: '非 POV' },
]
/** 旧数据或 SQLite 中可能是 0 / 1 */
export const isPov = (t: Pick<Template, 'pov'> | null | undefined): boolean => !!t?.pov
export const viewLabel = (pov: boolean | number | null | undefined) => (pov ? 'POV' : '非 POV')

type Lookup = (id: number) => Pick<Template, 'name'> | null | undefined

/** 「情绪组 / 视角 / 体位」；分类被删除时显示为（未分组） */
export function actionParts(t: Pick<Template, 'mood_id' | 'posture_id' | 'pov'>, get: Lookup): { mood: string; view: string; posture: string } {
  const name = (id: number | null | undefined, missing: string) => (id != null ? get(id)?.name || (get(id) ? '（未命名）' : missing) : missing)
  return { mood: name(t.mood_id, '（未分组）'), view: viewLabel(t.pov), posture: name(t.posture_id, '（未分类）') }
}
export function actionLabel(t: Pick<Template, 'mood_id' | 'posture_id' | 'pov'>, get: Lookup): string {
  const p = actionParts(t, get)
  return `${p.mood} / ${p.view} / ${p.posture}`
}

const bySort = <T extends Pick<Template, 'sort' | 'id'>>(list: T[]) => [...list].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.id - b.id)

export interface ActionIndex {
  moods: Template[]
  postures: Template[]
  prompts: Template[]
  /** 某个组合的 Prompt（数据中同一组合有多份时为全部，按顺序） */
  at(moodId: number, pov: boolean, postureId: number): Template[]
  byId: Map<number, Template>
}
const cellKey = (m: number | null | undefined, pov: boolean, p: number | null | undefined) => `${m ?? ''}|${pov ? 1 : 0}|${p ?? ''}`

export function actionIndex(templates: Iterable<Template>): ActionIndex {
  const all = [...templates]
  const moods = bySort(all.filter((t) => t.kind === 'mood'))
  const postures = bySort(all.filter((t) => t.kind === 'posture'))
  const prompts = bySort(all.filter((t) => t.kind === 'action'))
  const cells = new Map<string, Template[]>()
  for (const t of prompts) {
    const k = cellKey(t.mood_id, isPov(t), t.posture_id)
    cells.set(k, [...(cells.get(k) ?? []), t])
  }
  return { moods, postures, prompts, at: (m, pov, p) => cells.get(cellKey(m, pov, p)) ?? [], byId: new Map(all.map((t) => [t.id, t])) }
}

/** 分类已被删除（或从未设置）的 Prompt：不在矩阵中显示，单独列出以便重新归类 */
export function orphanPrompts(ix: ActionIndex): Template[] {
  const moods = new Set(ix.moods.map((m) => m.id))
  const postures = new Set(ix.postures.map((p) => p.id))
  return ix.prompts.filter((t) => t.mood_id == null || t.posture_id == null || !moods.has(t.mood_id) || !postures.has(t.posture_id))
}

// ---------------------------------------------------------------- 锚点
export interface TagAnchors {
  /** 独立 Tag 的位置（不在括号或 Wildcard 内，逗号 / 换行分隔，大小写不敏感） */
  top: { start: number; end: number }[]
  /** 出现在括号、权重或 Wildcard 内的次数（无法作为插入位置） */
  nested: number
}

const OPEN = '([{'
const CLOSE = ')]}'
const SEPS = new Set([',', '，', '\n'])

export function tagAnchors(text: string, tag: string): TagAnchors {
  const body = text ?? ''
  const want = tag.toLowerCase()
  const top: { start: number; end: number }[] = []
  let depth = 0
  let segStart = 0
  for (let i = 0; i <= body.length; i++) {
    const c = body[i]
    if (i < body.length && c === '\\') {
      i++ // 转义字符（例如 \(）不算括号
      continue
    }
    if (i < body.length && OPEN.includes(c)) depth++
    else if (i < body.length && CLOSE.includes(c)) depth = Math.max(0, depth - 1)
    else if (i === body.length || (depth === 0 && SEPS.has(c))) {
      const seg = body.slice(segStart, i)
      const t = seg.trim()
      if (t.toLowerCase() === want) {
        const start = segStart + (seg.length - seg.trimStart().length)
        top.push({ start, end: start + t.length })
      }
      segStart = i + 1
    }
  }
  const esc = want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const any = [...body.matchAll(new RegExp(`(?<![A-Za-z0-9_])${esc}(?![A-Za-z0-9_])`, 'gi'))].length
  return { top, nested: Math.max(0, any - top.length) }
}

export interface PromptAnchors {
  girl: TagAnchors
  man: TagAnchors
}
export const promptAnchors = (body: string): PromptAnchors => ({ girl: tagAnchors(body, FEMALE_TAG), man: tagAnchors(body, MALE_TAG) })
/** Prompt 中是否有男性部分（任何位置出现 1man 都算，用于界面提示） */
export const hasMale = (a: PromptAnchors) => a.man.top.length + a.man.nested > 0

export type AnchorProblem = 'missing' | 'nested' | 'multiple'
/** 需要在这个锚点插入内容时的问题：唯一的独立 Tag 时为 null */
export function anchorProblem(a: TagAnchors): AnchorProblem | null {
  if (a.top.length === 1) return null
  if (a.top.length > 1) return 'multiple'
  return a.nested ? 'nested' : 'missing'
}
export function anchorMessage(tag: string, a: TagAnchors, what: string): string {
  const p = anchorProblem(a)
  if (p === 'multiple') return `Prompt 中有 ${a.top.length} 个独立的 ${tag}，无法确定${what}的插入位置，请只保留一个`
  if (p === 'nested') return `Prompt 中的 ${tag} 在括号、权重或 Wildcard 内，无法作为${what}的插入位置；请把它写成独立的 Tag（例如「${tag}, ...」）`
  return `Prompt 中没有独立的 ${tag} 标签，无法插入${what}`
}

// ---------------------------------------------------------------- 拼接
/** 模块内容去掉首尾空白与首尾逗号（模块内部原样保留） */
export const cleanPart = (s: string | null | undefined) => (s ?? '').trim().replace(/^[,，\s]+/, '').replace(/[,，\s]+$/, '')
const joinTags = (parts: (string | null | undefined)[]) => parts.map(cleanPart).filter(Boolean).join(', ')

/** 顶层段落之间：去掉前一段末尾的逗号与空白，再用 sep 连接；空段跳过 */
function joinBlocks(parts: string[], sep: string): string {
  const list = parts.filter((p) => p.trim())
  return list.map((p, i) => (i < list.length - 1 ? p.replace(/[,，\s]+$/, '') : p.replace(/\s+$/, ''))).map((p) => p.replace(/^\s+/, '')).join(sep)
}

export interface ActionComposeInput {
  /** 用户写好的人物动作 Prompt（原文） */
  body: string
  global?: string
  scene?: string
  camera?: string
  extra?: string
  /** 插入 1girl 之后：主角色特征、服装等（空内容跳过） */
  female?: (string | null | undefined)[]
  /** 插入 1man 之后：第二角色特征、服装（null / undefined：不插入第二角色信息） */
  male?: (string | null | undefined)[] | null
}
export interface ActionComposeResult {
  positive: string
  /** 有内容要插入、但锚点不唯一而没有插入的问题 */
  problems: { tag: string; who: 'female' | 'male'; problem: AnchorProblem; message: string }[]
  inserted: { female: boolean; male: boolean }
}

/** 在锚点（独立 Tag）之后插入内容：`1girl` → `1girl, 特征, 服装`，其后的原文不变 */
export function insertAfterAnchors(body: string, inserts: { at: number; text: string }[]): string {
  let out = body
  for (const x of [...inserts].sort((a, b) => b.at - a.at)) out = `${out.slice(0, x.at)}, ${x.text}${out.slice(x.at)}`
  return out
}

export function composeActionPrompt(input: ActionComposeInput): ActionComposeResult {
  const body = input.body ?? ''
  const anchors = promptAnchors(body)
  const problems: ActionComposeResult['problems'] = []
  const inserts: { at: number; text: string }[] = []
  const inserted = { female: false, male: false }
  const tryInsert = (who: 'female' | 'male', tag: string, a: TagAnchors, parts: (string | null | undefined)[] | null | undefined, what: string) => {
    const text = joinTags(parts ?? [])
    if (!text) return
    const p = anchorProblem(a)
    if (p) return void problems.push({ tag, who, problem: p, message: anchorMessage(tag, a, what) })
    inserts.push({ at: a.top[0].end, text })
    inserted[who] = true
  }
  tryInsert('female', FEMALE_TAG, anchors.girl, input.female, '主角色特征与服装')
  if (input.male) tryInsert('male', MALE_TAG, anchors.man, input.male, '第二角色特征与服装')
  const head = joinBlocks([cleanPart(input.global), joinTags([input.scene, input.camera])], ',\n')
  const positive = joinBlocks([head, insertAfterAnchors(body, inserts), cleanPart(input.extra)], ',\n\n')
  return { positive, problems, inserted }
}

// ---------------------------------------------------------------- 旧数据
/** Prompt 中残留的旧版模板占位符（{全局}、{女特征} 等）：新版不会替换它们 */
export function legacyPlaceholders(body: string): string[] {
  const mods = templatePlaceholders(body ?? '').modules
  return TEMPLATE_SLOTS.filter((s) => mods.has(s.module)).map((s) => `{${s.names[0]}}`)
}

/** 从旧版姿态模板导入：去掉占位符（连同相邻的逗号与空行），其余文字原样保留。结果只作为草稿，由用户确认后保存 */
export function fromLegacyTemplate(body: string): string {
  return fillTemplate(body ?? '', {})
}
