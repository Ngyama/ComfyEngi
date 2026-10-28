// 历史 Prompt 提取的页面状态：保存在内存中（切换页面不丢失，重启后清空）。
// 分析结果只是建议，保存前不会写入 Vault；用户编辑过的名称 / Prompt 在重新分析后按组合 ID 保留。

import { create } from 'zustand'
import { toast } from 'sonner'
import { api, call } from '@/lib/api'
import { reloadLib } from '@/lib/stores'
import { DEFAULT_MINING, type Candidate, type DictionaryInfo, type MiningParams, type MiningResult, type MiningSaveOutcome, type ScannedImage, type ScanResult } from '@shared/mining'
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

interface MiningState {
  images: ScannedImage[]
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

/** 参与分析的图片 */
export const includedImages = (s: Pick<MiningState, 'images' | 'include'>) => s.images.filter((i) => i.status !== 'error' && (s.include[i.id] ?? i.status === 'ok'))

async function runScan(p: Promise<ScanResult | null>) {
  setS({ scanning: true, progress: null })
  const r = await call(p)
  setS({ scanning: false, progress: null })
  if (!r) return
  const s = get()
  const byId = new Map(s.images.map((i) => [i.id, i]))
  for (const im of r.images) byId.set(im.id, im)
  const images = [...byId.values()].sort((a, b) => (a.id.toLowerCase() < b.id.toLowerCase() ? -1 : a.id.toLowerCase() > b.id.toLowerCase() ? 1 : 0))
  setS({ images, scanErrors: r.errors, stale: true })
  const n = (st: string) => r.images.filter((i) => i.status === st).length
  const detail = `成功 ${n('ok')}${n('check') ? `，需确认 ${n('check')}` : ''}${n('error') ? `，失败 ${n('error')}` : ''}`
  if (r.cancelled) toast.info(`已取消扫描：读取了 ${r.images.length} 张（${detail}）`)
  else toast.success(`读取 ${r.images.length} 张图片：${detail}`)
  if (!r.cancelled && includedImages(get()).length) await analyze()
}

export const addFiles = () => runScan(api['mining.addFiles']())
export const addFolder = () => runScan(api['mining.addFolder'](get().recursive))
export const cancelScan = () => void api['mining.cancelScan']()

export function clearAll() {
  setS({ images: [], include: {}, result: null, drafts: [], nextNo: 1, stale: false, scanErrors: [], lastSave: null })
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
  const imgs = includedImages(s).map((i) => ({ id: i.id, positive: i.positive }))
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
