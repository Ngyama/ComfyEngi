// Prompt 来源的优先级与批量应用（纯函数，供页面状态与测试使用）。
// 优先级：手动指定 > 已验证的自动解析结果 > 用户保存的来源规则 > 已知节点的专用识别（fallback）> 其他候选（等待确认）。
// 用户规则与可靠的自动结果不同时不覆盖，只标记差异。

import { matchRuleDetail, type ExtractedPrompt, type PromptCandidate, type SavedSourceRule, type SourceRule } from './prompt-source'
import { promptSignature } from './tags'

/** 手动指定的正向 Prompt（来自某个候选来源，或手动修改的文本） */
export interface ManualPrompt {
  positive: string
  /** 来源说明；手动修改过文本时为 null */
  label: string | null
  rule?: SourceRule
  /** 文本经过手动修改（批量应用规则时不会覆盖） */
  edited?: boolean
}

/** 已保存的来源规则在某张图片上的结果 */
export interface RuleHit {
  rule: SavedSourceRule
  c: PromptCandidate
  /** 规则结果被采用（自动结果失败、需要确认或只是已知节点识别时） */
  used: boolean
  /** 自动结果可靠但内容与规则不同：保留自动结果，提示差异 */
  conflict: boolean
}

type Image = Pick<ExtractedPrompt, 'status' | 'positive' | 'candidates' | 'fallback' | 'nodeTypes'> & { id: string; fields?: unknown[] }

const same = (a: string, b: string) => a.trim() === b.trim() || (!!promptSignature(a) && promptSignature(a) === promptSignature(b))
const reliable = (im: Image) => im.status === 'ok' && !im.fallback

/** 按顺序找到第一条唯一匹配的启用规则 */
export function ruleHit(im: Image, rules: SavedSourceRule[]): RuleHit | null {
  for (const rule of rules) {
    if (!rule.enabled) continue
    const m = matchRuleDetail(rule.rule, im)
    if (m.reason !== 'ok') continue
    if (reliable(im)) return same(m.c.text, im.positive) ? null : { rule, c: m.c, used: false, conflict: true }
    return { rule, c: m.c, used: true, conflict: false }
  }
  return null
}

export function ruleHits(images: Image[], rules: SavedSourceRule[]): Record<string, RuleHit> {
  const out: Record<string, RuleHit> = {}
  if (!rules.some((r) => r.enabled)) return out
  for (const im of images) {
    const h = ruleHit(im, rules)
    if (h) out[im.id] = h
  }
  return out
}

export interface Effective {
  status: ExtractedPrompt['status']
  positive: string
  manual?: ManualPrompt
  viaRule?: RuleHit
}

export function resolveEffective(im: Image, manual?: ManualPrompt, hit?: RuleHit): Effective {
  if (manual && manual.positive.trim()) return { status: 'ok', positive: manual.positive, manual }
  if (hit?.used) return { status: hit.c.warn ? 'check' : 'ok', positive: hit.c.text, viaRule: hit }
  return { status: im.status, positive: im.positive }
}

/** 批量应用一个来源规则前的统计（不含当前图片） */
export interface RuleReport {
  total: number
  targets: { id: string; c: PromptCandidate }[]
  /** 当前 Prompt 已经与该来源相同 */
  same: number
  /** 自动提取已成功但内容不同，默认保留自动结果 */
  autoKept: number
  /** 用户手动修改过文本，跳过 */
  edited: number
  /** 没有同类型节点 / 字段 */
  missing: number
  /** 多个同类型节点无法区分 */
  ambiguous: number
  /** 唯一的同类型节点连到负向 */
  negative: number
  /** 严格匹配节点 ID 时，该 ID 是其他类型的节点 */
  idMismatch: number
  /** 图片没有可读取的元数据 */
  noMeta: number
}

export function ruleReport(rule: SourceRule, fromId: string, images: Image[], manual: Record<string, ManualPrompt>, hits: Record<string, RuleHit>, overrideAuto = false): RuleReport {
  const r: RuleReport = { total: images.length, targets: [], same: 0, autoKept: 0, edited: 0, missing: 0, ambiguous: 0, negative: 0, idMismatch: 0, noMeta: 0 }
  for (const im of images) {
    if (im.id === fromId) continue
    if (manual[im.id]?.edited) {
      r.edited++
      continue
    }
    if (!im.candidates.length && !(im.fields?.length ?? 0)) {
      r.noMeta++
      continue
    }
    const m = matchRuleDetail(rule, im)
    if (m.reason === 'missing') r.missing++
    else if (m.reason === 'ambiguous') r.ambiguous++
    else if (m.reason === 'negative') r.negative++
    else if (m.reason === 'id-mismatch') r.idMismatch++
    else {
      const cur = resolveEffective(im, manual[im.id], hits[im.id])
      if (cur.status !== 'error' && same(cur.positive, m.c.text) && (manual[im.id] || cur.status === 'ok')) r.same++
      else if (reliable(im) && !manual[im.id] && !overrideAuto) r.autoKept++
      else r.targets.push({ id: im.id, c: m.c })
    }
  }
  return r
}
