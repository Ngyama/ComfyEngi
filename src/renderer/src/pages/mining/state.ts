// 历史 Prompt 提取的页面状态：保存在内存中（切换页面不丢失，重启后清空）。
// 分析结果只是建议，保存前不会写入 Vault；用户编辑过的名称 / Prompt 在重新分析后按组合 ID 保留。

import { create } from 'zustand'
import { toast } from 'sonner'
import { api, call } from '@/lib/api'
import { reloadLib } from '@/lib/stores'
import { DEFAULT_MINING, type Candidate, type DictionaryInfo, type MiningParams, type MiningResult, type MiningSaveOutcome, type ScanFound, type ScannedImage, type ScanResult } from '@shared/mining'
import { matchRule, type PromptCandidate, type SourceRule } from '@shared/prompt-source'
import type { TemplateKind } from '@shared/types'

export interface Draft {
  uid: string
  name: string
  prompt: string
  selected: boolean
  /** 来自挖掘结果的组合 ID；自定义组合没有 */
  candId?: string
  saved?: { id: number; kind: TemplateKind }
}

/** 手动指定的正向 Prompt（来自某个候选来源，或手动修改的文本） */
export interface ManualPrompt {
  positive: string
  /** 来源说明；手动修改过文本时为 null */
  label: string | null
  rule?: SourceRule
  /** 文本经过手动修改（批量应用规则时不会覆盖） */
  edited?: boolean
}

interface MiningState {
  images: ScannedImage[]
  manual: Record<string, ManualPrompt>
  /** 最近一次扫描的范围统计 */
  found: ScanFound | null
  /** 是否参与分析（「需要确认」的图片默认不参与） */
  include: Record<string, boolean>
  scanning: boolean
  progress: { done: number; total: number; file: string } | null
  scanErrors: string[]
  recursive: boolean
  params: MiningParams
  result: MiningResult | null
  /** 图片或参数在上次分析后有变化 */
  stale: boolean
  analyzing: boolean
  drafts: Draft[]
  nextNo: number
  saveKind: TemplateKind
  parentId: number | null
  dict: DictionaryInfo | null
  lastSave: MiningSaveOutcome[] | null
  set: (p: Partial<MiningState>) => void
}

export const useMining = create<MiningState>((set) => ({
  images: [],
  manual: {},
  found: null,
  include: {},
  scanning: false,
  progress: null,
  scanErrors: [],
  recursive: true,
  params: { ...DEFAULT_MINING },
  result: null,
  stale: false,
  analyzing: false,
  drafts: [],
  nextNo: 1,
  saveKind: 'pose',
  parentId: null,
  dict: null,
  lastSave: null,
  set: (p) => set(p),
}))

const get = () => useMining.getState()
const setS = (p: Partial<MiningState>) => useMining.setState(p)

api.onRunnerEvent((e) => {
  if (e.kind === 'mining') setS({ progress: { done: e.done, total: e.total, file: e.file } })
})

export const draftName = (n: number) => `提取组合 ${String(n).padStart(3, '0')}`

/** 考虑手动指定后的状态与正向 Prompt */
export function effective(im: ScannedImage, manual: Record<string, ManualPrompt>): { status: ScannedImage['status']; positive: string; manual?: ManualPrompt } {
  const m = manual[im.id]
  if (m && m.positive.trim()) return { status: 'ok', positive: m.positive, manual: m }
  return { status: im.status, positive: im.positive }
}

/** 是否参与分析：「需要确认」的图片默认不参与，手动指定后默认参与 */
export const isIncluded = (im: ScannedImage, s: Pick<MiningState, 'include' | 'manual'>) => {
  const e = effective(im, s.manual)
  return e.status !== 'error' && (s.include[im.id] ?? e.status === 'ok')
}

/** 参与分析的图片 */
export const includedImages = (s: Pick<MiningState, 'images' | 'include' | 'manual'>) => s.images.filter((i) => isIncluded(i, s))

async function runScan(p: Promise<ScanResult | null>) {
  setS({ scanning: true, progress: null })
  const r = await call(p)
  setS({ scanning: false, progress: null })
  if (!r) return
  const s = get()
  const byId = new Map(s.images.map((i) => [i.id, i]))
  for (const im of r.images) byId.set(im.id, im)
  const images = [...byId.values()].sort((a, b) => (a.id.toLowerCase() < b.id.toLowerCase() ? -1 : a.id.toLowerCase() > b.id.toLowerCase() ? 1 : 0))
  setS({ images, scanErrors: r.errors, found: r.found, stale: true })
  const n = (st: string) => r.images.filter((i) => i.status === st).length
  const meta = r.images.filter((i) => i.fields.length).length
  const detail = `读到元数据 ${meta} 张，提取成功 ${n('ok')}${n('check') ? `，需确认 ${n('check')}` : ''}${n('error') ? `，失败 ${n('error')}` : ''}`
  if (r.cancelled) toast.info(`已取消扫描：读取了 ${r.images.length} 张（${detail}）`)
  else if (!r.images.length) toast.warning('没有找到可读取的图片', { description: r.errors.join('\n') })
  else if (!n('ok') && !n('check')) toast.error(`读取 ${r.images.length} 张图片，没有提取到正向 Prompt`, { description: `${detail}。点击图片可查看原始元数据和失败原因。` })
  else toast.success(`读取 ${r.images.length} 张图片`, { description: detail })
  if (r.cancelled) return
  if (includedImages(get()).length) await analyze()
  else if (n('check')) toast.info(`${n('check')} 张图片需要确认，默认不参与分析`, { description: '可以在左侧「需确认」中逐张检查，或点「全部纳入分析」。' })
}

export const addFiles = () => runScan(api['mining.addFiles']())
export const addFolder = () => runScan(api['mining.addFolder'](get().recursive))
export const cancelScan = () => void api['mining.cancelScan']()

export function clearAll() {
  setS({ images: [], include: {}, manual: {}, found: null, result: null, drafts: [], nextNo: 1, stale: false, scanErrors: [], lastSave: null })
}

/** 把所有「需要确认」的图片纳入分析 */
export function includeAllCheck() {
  const s = get()
  const include = { ...s.include }
  for (const im of s.images) if (effective(im, s.manual).status === 'check') include[im.id] = true
  setS({ include, stale: true })
}

/** 使用某个候选来源作为正向 Prompt */
export function pickCandidate(id: string, c: PromptCandidate) {
  const s = get()
  setS({ manual: { ...s.manual, [id]: { positive: c.text, label: c.label, rule: c.rule } }, include: { ...s.include, [id]: true }, stale: true })
}

/** 手动修改正向 Prompt */
export function setManualText(id: string, positive: string) {
  const s = get()
  setS({ manual: { ...s.manual, [id]: { positive, label: null, edited: true } }, include: { ...s.include, [id]: true }, stale: true })
}

export function clearManual(id: string) {
  const s = get()
  const manual = { ...s.manual }
  delete manual[id]
  const include = { ...s.include }
  delete include[id]
  setS({ manual, include, stale: true })
}

/** 可以应用某个来源规则的其他图片（跳过手动修改过文本的图片） */
export function ruleTargets(rule: SourceRule, fromId: string, s: Pick<MiningState, 'images' | 'manual'> = get()): { im: ScannedImage; c: PromptCandidate }[] {
  const out: { im: ScannedImage; c: PromptCandidate }[] = []
  for (const im of s.images) {
    if (im.id === fromId || s.manual[im.id]?.edited) continue
    const c = matchRule(rule, im)
    if (c && s.manual[im.id]?.positive !== c.text) out.push({ im, c })
  }
  return out
}

/** 把来源规则应用到相同结构 / 含相同字段的其他图片 */
export function applyRule(rule: SourceRule, fromId: string): number {
  const s = get()
  const targets = ruleTargets(rule, fromId, s)
  if (!targets.length) return 0
  const manual = { ...s.manual }
  const include = { ...s.include }
  for (const { im, c } of targets) {
    manual[im.id] = { positive: c.text, label: c.label, rule: c.rule }
    include[im.id] = true
  }
  setS({ manual, include, stale: true })
  toast.success(`已应用到 ${targets.length} 张图片`)
  return targets.length
}

export function toggleInclude(id: string, on: boolean) {
  setS({ include: { ...get().include, [id]: on }, stale: true })
}

export function setParams(p: Partial<MiningParams>) {
  setS({ params: { ...get().params, ...p }, stale: true })
}

let analyzeSeq = 0
export async function analyze() {
  const s = get()
  const imgs = includedImages(s).map((i) => ({ id: i.id, positive: effective(i, s.manual).positive }))
  if (!imgs.length) {
    toast.error('没有可分析的图片')
    return
  }
  const seq = ++analyzeSeq
  setS({ analyzing: true })
  const r = await call(api['mining.analyze'](imgs, s.params), (msg) => {
    if (seq === analyzeSeq && msg !== '分析已取消') toast.error(msg)
  })
  if (seq !== analyzeSeq) return
  setS({ analyzing: false })
  if (!r) return
  // 保留用户对同一组合（相同标签）的编辑；新组合按顺序编号
  const cur = get()
  const old = new Map(cur.drafts.filter((d) => d.candId).map((d) => [d.candId!, d]))
  let no = cur.nextNo
  const mined: Draft[] = r.candidates.map((c) => old.get(c.id) ?? { uid: `c:${c.id}`, name: draftName(no++), prompt: c.prompt, selected: false, candId: c.id })
  // 新结果中不再出现、但用户已选中或已保存的组合：转为自定义组合保留
  const ids = new Set(r.candidates.map((c) => c.id))
  const orphans = cur.drafts.filter((d) => d.candId && !ids.has(d.candId) && (d.selected || d.saved)).map((d) => ({ ...d, candId: undefined }))
  setS({ result: r, stale: false, drafts: [...orphans, ...cur.drafts.filter((d) => !d.candId), ...mined], nextNo: no })
}

export function patchDraft(uid: string, p: Partial<Draft>) {
  setS({ drafts: get().drafts.map((d) => (d.uid === uid ? { ...d, ...p } : d)) })
}

/** 新建自定义组合（来自变化标签、扩展组合、标签表或全局公共标签） */
export function addCustom(prompt: string, name?: string): string {
  const s = get()
  const uid = `u:${Date.now()}:${s.nextNo}`
  setS({ drafts: [{ uid, name: name ?? draftName(s.nextNo), prompt, selected: true }, ...s.drafts], nextNo: s.nextNo + 1 })
  toast.success('已添加到「自定义组合」')
  return uid
}

export function removeDraft(uid: string) {
  setS({ drafts: get().drafts.filter((d) => d.uid !== uid) })
}

export const candidateOf = (r: MiningResult | null, d: Draft): Candidate | undefined => (d.candId ? r?.candidates.find((c) => c.id === d.candId) : undefined)

export async function saveSelected() {
  const s = get()
  const chosen = s.drafts.filter((d) => d.selected && !d.saved)
  if (!chosen.length) return
  if (s.saveKind === 'subposition' && !s.parentId) {
    toast.error('保存为子体位时请选择所属的主体位')
    return
  }
  const out = await call(api['mining.save'](chosen.map((d) => ({ name: d.name, positive: d.prompt, kind: s.saveKind, parent_id: s.saveKind === 'subposition' ? s.parentId : null }))))
  if (!out) return
  const savedIds = new Map<string, number>()
  chosen.forEach((d, i) => out[i]?.status === 'saved' && savedIds.set(d.uid, out[i].id!))
  setS({ drafts: get().drafts.map((d) => (savedIds.has(d.uid) ? { ...d, saved: { id: savedIds.get(d.uid)!, kind: s.saveKind }, selected: false } : d)), lastSave: out })
  await reloadLib()
  const n = out.filter((o) => o.status === 'saved').length
  const skipped = out.length - n
  if (skipped) toast.warning(`已保存 ${n} 个，跳过 ${skipped} 个`, { description: out.filter((o) => o.status !== 'saved').map((o) => `${o.name}：${o.message}`).join('\n') })
  else toast.success(`已保存 ${n} 个素材`)
}

export async function loadDict() {
  setS({ dict: (await call(api['mining.dictInfo']())) ?? null })
}
