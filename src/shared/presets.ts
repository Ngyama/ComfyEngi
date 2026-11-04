// 动作序列预设与套图模板：从当前任务保存一个或一段连续的动作序列，之后在任何任务中插入或新建任务。
// 预设只保存引用（动作卡、姿态模板选择、表情、行为、镜头、场景等素材 ID）和各动作自己的设置，不保存展开后的 Prompt；
// 生成时总是使用素材库中的最新内容。保存时记录引用素材的内容指纹，之后素材被修改或删除时给出提示（不阻止使用，也不自动替换）。
// 服装属于角色，保存为「服装槽位」：导入时每个槽位选择一次当前角色的服装，应用到所有使用该槽位的动作。

import { cardTemplates, isTemplateCard } from './card-templates'
import { itemCameraIds, itemStateIds, itemStateIds2, newItem, sizeTotal } from './planner'
import type { Outfit, OutfitSlot, PresetData, PresetItem, PresetKind, RefStamp, TaskItem, Template } from './types'

export const PRESET_KIND_LABEL: Record<PresetKind, string> = { action: '动作预设', set: '套图模板' }

/** 内容指纹（FNV-1a）：只看会进入 Prompt 的内容，改名不算修改 */
export function fingerprint(t: Pick<Template, 'positive' | 'negative'>): string {
  const text = JSON.stringify([t.positive ?? '', t.negative ?? ''])
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** 一个动作引用的全部素材 ID（动作卡、场景、镜头、表情、行为，以及旧方式动作的状态、主体位等） */
export function itemRefIds(it: Partial<TaskItem>): number[] {
  const list = [
    it.card_id,
    it.scene_id,
    ...itemCameraIds(it),
    it.expression_id,
    it.second_expression_id,
    ...(it.behavior_ids ?? []),
    ...itemStateIds(it),
    ...itemStateIds2(it),
    ...(it.act_ids ?? []),
    ...(it.expression_ids ?? []),
    it.position_id,
    it.subposition_id,
    ...(it.male_ids ?? []),
    ...(it.male_pose_ids ?? []),
    ...(it.male_expression_ids ?? []),
  ]
  return [...new Set(list.filter((x): x is number => typeof x === 'number' && x > 0))]
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v ?? null))

/**
 * 从任务的动作（一个或一段）生成预设数据。手改的单张 Prompt 不保存（它们只属于原任务）；
 * 主角色、第二角色的服装分别编号为槽位
 */
export function presetFromItems(items: TaskItem[], ctx: { templates: Template[]; outfits: Outfit[] }, source?: PresetData['source']): PresetData {
  const slots: OutfitSlot[] = []
  const slotOf = (id: number | null | undefined, second: boolean): number | null => {
    if (id == null) return null
    const hit = slots.find((s) => s.outfit_id === id && !!s.second === second)
    if (hit) return hit.key
    const key = slots.length + 1
    slots.push({ key, ...(second ? { second: true } : {}), outfit_id: id, name: ctx.outfits.find((o) => o.id === id)?.name ?? '（已删除的服装）' })
    return key
  }
  const out: PresetItem[] = items.map((src) => {
    const it = clone(src) as TaskItem & Partial<PresetItem>
    const main = slotOf(src.outfit_id, false)
    const second = slotOf(src.second_outfit_id, true)
    delete (it as Partial<TaskItem>).prompt_edits
    delete (it as Partial<TaskItem>).outfit_id
    delete (it as Partial<TaskItem>).second_outfit_id
    it.outfit_slot = main
    it.second_outfit_slot = second
    return it as PresetItem
  })
  const byId = new Map(ctx.templates.map((t) => [t.id, t]))
  const refs: Record<string, RefStamp> = {}
  const stamp = (t: Template) => {
    refs[String(t.id)] ??= { name: t.name, kind: t.kind, hash: fingerprint(t) }
    return refs[String(t.id)]
  }
  for (const it of items)
    for (const id of itemRefIds(it)) {
      const t = byId.get(id)
      if (!t) continue
      const r = stamp(t)
      if (isTemplateCard(t)) {
        const tpls = cardTemplates(t, ctx.templates)
        r.templates = tpls.map((x) => x.id)
        for (const x of tpls) stamp(x)
      }
    }
  return { items: out, slots, refs, ...(source ? { source } : {}) }
}

/** 规范化读取的预设数据（缺字段时补默认值，不丢弃未知字段） */
export function normalizePresetData(d: Partial<PresetData> | null | undefined): PresetData {
  const items = Array.isArray(d?.items) ? d!.items.filter((x) => x && typeof x === 'object') : []
  const slots = Array.isArray(d?.slots) ? d!.slots.filter((x) => x && typeof x === 'object' && Number.isInteger(x.key)) : []
  const refs = d?.refs && typeof d.refs === 'object' && !Array.isArray(d.refs) ? d.refs : {}
  return { ...(d ?? {}), items, slots, refs }
}

export interface PresetStatus {
  /** 保存后 Prompt 内容被修改的素材（显示名，如「正常位 / 双腿抬起」） */
  changed: string[]
  /** 已删除的素材 */
  missing: string[]
  /** 动作卡在保存后新增的姿态模板（默认参与抽取） */
  added: string[]
}

/** 对比保存时的指纹与素材库的当前内容 */
export function presetStatus(data: PresetData, templates: Template[]): PresetStatus {
  const byId = new Map(templates.map((t) => [t.id, t]))
  const label = (t: Template) => {
    const parent = t.kind === 'card_tpl' && t.parent_id != null ? byId.get(t.parent_id) : null
    return parent ? `${parent.name} / ${t.name || '（未命名）'}` : t.name || '（未命名）'
  }
  const st: PresetStatus = { changed: [], missing: [], added: [] }
  for (const [key, r] of Object.entries(data.refs ?? {})) {
    const t = byId.get(Number(key))
    if (!t) {
      st.missing.push(r.name || `#${key}`)
      continue
    }
    if (fingerprint(t) !== r.hash) st.changed.push(label(t))
    if (r.templates && isTemplateCard(t)) {
      const saved = new Set(r.templates)
      for (const x of cardTemplates(t, templates)) if (!saved.has(x.id)) st.added.push(label(x))
    }
  }
  // 保存时就已缺失的引用（没有指纹）也要提示
  const stamped = new Set(Object.keys(data.refs ?? {}).map(Number))
  for (const it of data.items) for (const id of itemRefIds(it)) if (!stamped.has(id) && !byId.has(id)) st.missing.push(`#${id}`)
  st.missing = [...new Set(st.missing)]
  return st
}

/** 非阻塞的提示文字：没有变化时为空数组 */
export function presetMessages(kind: PresetKind, st: PresetStatus): { level: 'info' | 'error'; text: string }[] {
  const what = `此${PRESET_KIND_LABEL[kind]}`
  const out: { level: 'info' | 'error'; text: string }[] = []
  if (st.changed.length) out.push({ level: 'info', text: `${what}引用的部分素材已更新：${st.changed.join('、')} 在上次保存后 Prompt 已修改。本次将使用素材库中的最新内容。` })
  if (st.added.length) out.push({ level: 'info', text: `动作卡在保存后新增了姿态模板：${st.added.join('、')}，导入后默认参与抽取，可在动作详情中取消。` })
  if (st.missing.length) out.push({ level: 'error', text: `${what}引用的素材已被删除：${st.missing.join('、')}。导入后对应的动作会提示错误，请在动作详情中重新选择（不会自动替换）。` })
  return out
}

/** 导入时服装槽位的默认对应：保存时的服装属于目标角色时沿用，否则按名称匹配目标角色的服装，都没有时不指定 */
export function defaultSlotMap(data: PresetData, outfits: Outfit[], charId: number | null | undefined, char2Id: number | null | undefined): Record<number, number | null> {
  const map: Record<number, number | null> = {}
  for (const s of data.slots) {
    const owner = s.second ? char2Id : charId
    const own = outfits.filter((o) => o.character_id === owner)
    map[s.key] = own.find((o) => o.id === s.outfit_id)?.id ?? own.find((o) => o.name === s.name)?.id ?? null
  }
  return map
}

/** 预设 → 新的任务动作（每次导入都是独立的副本，之后修改任务不影响预设） */
export function itemsFromPreset(data: PresetData, slotMap: Record<number, number | null>): TaskItem[] {
  return data.items.map((src) => {
    const { outfit_slot, second_outfit_slot, ...rest } = clone(src)
    return {
      ...newItem(),
      ...(rest as Partial<TaskItem>),
      outfit_id: outfit_slot != null ? (slotMap[outfit_slot] ?? null) : null,
      second_outfit_id: second_outfit_slot != null ? (slotMap[second_outfit_slot] ?? null) : null,
    }
  })
}

export type InsertMode = 'append' | 'after' | 'replace'

/** 把导入的动作放进任务：追加到末尾、插在第 at 个动作之后，或明确选择替换全部动作 */
export function insertItems<T>(items: T[], added: T[], mode: InsertMode, at?: number | null): T[] {
  if (mode === 'replace') return [...added]
  if (mode === 'after' && at != null && at >= 0 && at < items.length) return [...items.slice(0, at + 1), ...added, ...items.slice(at + 1)]
  return [...items, ...added]
}

/** 动作序列一行的关键信息：动作卡 | 服装 | 表情 | 行为 | 张数（缺少的部分省略） */
export function itemSummary(it: Partial<TaskItem> & { outfit_slot?: number | null }, getT: (id: number) => { name: string } | null | undefined, outfitName?: string | null): string[] {
  const name = (id: number | null | undefined) => (id != null ? (getT(id)?.name ?? '（已删除）') : '')
  const parts: string[] = []
  if (it.card_id != null) parts.push(name(it.card_id))
  if (outfitName) parts.push(outfitName)
  if (it.expression_id != null) parts.push(name(it.expression_id))
  const bs = (it.behavior_ids ?? []).map((id) => name(id))
  if (bs.length) parts.push(`${bs.join('/')}随机`)
  const total = it.sizes ? sizeTotal(it.sizes) : (it.count ?? 0)
  parts.push(`${total}张`)
  return parts
}
