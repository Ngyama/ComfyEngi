// 套图复刻（主进程部分）：草稿的图片读取、每张图的计划、入队与最终工作流。
// 每张图是一个独立单元，进入现有的执行队列（暂停、重试、提交快照、输出复制都相同）。不修改原图。

import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { applyInputs, newEntry, toggleDisableInputs, TRIGGER_DISABLE } from '@shared/mapping'
import type { ScannedImage } from '@shared/mining'
import { controlInputs, controlProblems, controlsOf } from '@shared/node-controls'
import { matchRule, type SavedSourceRule } from '@shared/prompt-source'
import { applyTagReplacement, mergeNegative, normalizeReplicaData, normalizeReplicaImage, originalPositive, outputStems, paramPlan, replicaTargets, stableSeed, type ParamRow, type ReplacePart, type ReplicaData, type ReplicaImage, type ReplicaRecord } from '@shared/replica'
import type { ApiWorkflow, Lora, PlanUnit, Settings, UnitMeta, Workflow } from '@shared/types'
import { diffWorkflow, findPromptInjectors } from '@shared/workflow-analysis'
import { buildWorkflowInputs, outputDirOf, resolveLoraName, type FullPlan } from './plan'
import { scanImage } from './mining'
import type { Store } from './store'

/** 这张图的状态：valid 可以生成；confirm 需要用户确认；invalid 没有 Prompt；missing 原图不在原位置；excluded 用户排除 */
export type RowState = 'valid' | 'confirm' | 'invalid' | 'missing' | 'excluded'
export interface ReplicaRow {
  index: number
  path: string
  name: string
  state: RowState
  reason: string
  positive: string
  negative: string
  original_positive: string
  original_negative: string
  parts: ReplacePart[]
  removed: string[]
  manual: boolean
  params: ParamRow[]
  seed: number
  seed_generated: boolean
  width: number | null
  height: number | null
  output_name: string
  /** 在单元列表中的位置（只有 valid 有） */
  unit: number | null
}
export interface ReplicaPlan extends FullPlan {
  rows: ReplicaRow[]
  output_dir: string
  loras: string[]
}

const MAX_CANDIDATES = 12
const MAX_CANDIDATE_TEXT = 8000

/** 把读取结果转成草稿中的图片；只有来源规则能确定的才算可靠（用户保存的规则） */
export function imageFromScan(s: ScannedImage, rules: SavedSourceRule[] = []): ReplicaImage {
  let { status, positive, negative } = s
  const notes = [...s.notes]
  if (status !== 'ok') {
    for (const r of rules) {
      if (!r.enabled) continue
      const hit = matchRule(r.rule, s)
      if (hit) {
        positive = hit.text
        status = 'ok'
        notes.push(`按来源规则「${r.name}」读取`)
        break
      }
    }
  }
  return normalizeReplicaImage({
    path: s.id,
    name: s.name,
    status,
    positive,
    negative,
    source: s.source,
    notes,
    error: s.error,
    params: s.params ?? {},
    loras: s.loras ?? [],
    candidates: status === 'ok' ? [] : s.candidates.slice(0, MAX_CANDIDATES).map((c) => ({ key: c.key, label: c.label, text: c.text.slice(0, MAX_CANDIDATE_TEXT), role: c.role })),
  })
}

/** 原图的文件夹是否与输出目录相同（输出不能放到原图旁边） */
const sameDir = (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase()

function rowState(im: ReplicaImage, status: string, grouped: string[]): { state: RowState; reason: string } {
  if (im.exclude) return { state: 'excluded', reason: '已排除' }
  if (!existsSync(im.path)) return { state: 'missing', reason: '原图不在原来的位置，请重新定位或排除' }
  if (im.manual_positive !== null) return { state: im.manual_positive.trim() ? 'valid' : 'invalid', reason: im.manual_positive.trim() ? '' : '手动编辑的 Prompt 为空' }
  if (im.status === 'error' && !im.confirmed) return { state: 'invalid', reason: im.error || '没有读取到 Prompt，请手动填写' }
  if (im.status === 'check' && !im.confirmed) return { state: 'confirm', reason: im.notes.at(-1) || '读取结果不确定，请确认来源' }
  if (status === 'unsafe') return { state: 'confirm', reason: '括号不配对，无法安全替换，请手动编辑' }
  if (status === 'group') return { state: 'confirm', reason: `${grouped.join('、')} 在组合权重里，无法单独移除，请手动编辑` }
  if (!im.positive.trim()) return { state: 'invalid', reason: 'Prompt 为空' }
  return { state: 'valid', reason: '' }
}

function workflowOf(store: Store, data: ReplicaData): Workflow | null {
  const wid = data.workflow_id || store.getSetting('default_workflow_id')
  return wid ? store.get('workflows', wid) : null
}

/** Prompt 路径上的 TriggerWord Toggle：关闭注入后触发词完全由角色 Prompt 负责 */
function withTriggerOff(wf: Workflow, off: boolean): Workflow {
  if (!off) return wf
  const extra = findPromptInjectors(wf.api_json ?? {}, wf.mapping ?? [])
    .filter((i) => i.kind === 'trigger_toggle' && i.polarity.length && !i.disabled)
    .map((i) => newEntry(TRIGGER_DISABLE, i.node, 'toggle_trigger_words'))
  return extra.length ? { ...wf, mapping: [...wf.mapping, ...extra] } : wf
}

const safeDirName = (s: string) => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || '未命名'

export function planForReplica(store: Store, rec: ReplicaRecord, settings?: Settings, dateStr?: string): ReplicaPlan {
  store.files?.scan()
  settings = settings ?? store.settings()
  const data = normalizeReplicaData(rec.data)
  const name = rec.name || '未命名'
  const errors: string[] = []
  const warnings: string[] = []
  const character = data.character_id ? store.get('characters', data.character_id) : null
  const outfit = data.outfit_id ? store.get('outfits', data.outfit_id) : null
  if (!character) errors.push('请选择新角色')
  if (!data.images.length) errors.push('还没有导入图片')
  const wfBase = workflowOf(store, data)
  if (!wfBase) errors.push('请选择工作流')
  const wf = wfBase ? withTriggerOff(wfBase, data.disable_triggers) : null

  const insert = [character?.positive, outfit?.positive].map((s) => (s ?? '').trim()).filter(Boolean).join(', ')
  const charNegative = [character?.negative, outfit?.negative].map((s) => (s ?? '').trim()).filter(Boolean).join(', ')
  const loras: Lora[] = data.lora.enabled ? structuredClone((character?.loras ?? []).filter((l) => l.name && !l.disabled)) : []
  if (data.lora.enabled && data.lora.name) {
    const replaced: Lora = { name: data.lora.name, resource_id: data.lora.resource_id ?? undefined, strength: data.lora.strength ?? loras[0]?.strength ?? 1 }
    if (loras.length) loras[0] = replaced
    else loras.push(replaced)
  } else if (loras[0] && data.lora.strength !== null) {
    loras[0].strength = data.lora.strength
    loras[0].strength_clip = data.lora.strength
  }
  for (const l of loras) if (l.resource_id) resolveLoraName(store, l, errors)

  const controls = wf ? controlsOf(wf) : { overrides: [], bypass: [] }
  const targets = wf ? replicaTargets(wf.api_json ?? {}, wf.mapping ?? [], controls) : {}
  const stems = outputStems(data.images)
  const outDir = outputDirOf(store, data.output.dir || join('output', `复刻-${safeDirName(name)}${rec.id ? `-${rec.id}` : ''}`))
  const rows: ReplicaRow[] = []
  const units: (PlanUnit & { extra: ReturnType<typeof paramPlan>['inputs'] })[] = []
  data.images.forEach((im, index) => {
    const orig = originalPositive(im)
    const rep = applyTagReplacement(orig, data.removed_tags, insert)
    const manual = im.manual_positive !== null
    const { state, reason } = rowState(im, rep.status, rep.grouped)
    const positive = manual ? im.manual_positive! : rep.text
    const negative = im.manual_negative !== null ? im.manual_negative : mergeNegative(im.negative, charNegative, data.negative_mode)
    const pp = paramPlan(im, targets, wf?.api_json ?? {}, data)
    const seed = pp.seed ?? stableSeed(im.path)
    const row: ReplicaRow = { index, path: im.path, name: im.name, state, reason, positive, negative, original_positive: orig, original_negative: im.negative, parts: manual ? [{ kind: 'keep', text: positive }] : rep.parts, removed: rep.removed, manual, params: pp.rows, seed, seed_generated: pp.seed === null, width: pp.width, height: pp.height, output_name: stems[index], unit: null }
    rows.push(row)
    if (state !== 'valid') return
    row.unit = units.length
    const meta: UnitMeta = {
      task: name,
      character: character?.name ?? '',
      story: '',
      genre: '',
      section: '复刻',
      item: im.name,
      item_no: index + 1,
      outfit: outfit?.name ?? '',
      expression: '',
      camera: '',
      male: false,
      male_templates: [],
      n: 1,
      of: 1,
      source_image: im.path,
      output_name: stems[index],
      replica: { original_positive: orig, original_negative: im.negative, removed: rep.removed, manual, params: pp.rows },
    }
    units.push({ section: 'replica', item_index: index, item_label: im.name, sub_index: 0, modules: {}, positive, negative, loras: structuredClone(loras), meta, index: units.length, seed, ...(pp.width ? { width: pp.width } : {}), ...(pp.height ? { height: pp.height } : {}), extra: pp.inputs })
  })

  if (wf) {
    const split = wf.mapping.filter((m) => (m.source === 'positive' || m.source === 'negative') && (m.modules ?? []).length)
    if (split.length) errors.push(`工作流「${wf.name}」的 Prompt 映射按模块拆分（节点 ${[...new Set(split.map((m) => m.node))].join('、')}），复刻需要写入完整的 Prompt。请在工作流的高级映射中改为完整 Prompt`)
    if (!wf.mapping.some((m) => m.source === 'positive')) errors.push(`工作流「${wf.name}」没有映射正向 Prompt，无法写入每张图的 Prompt`)
    if (!wf.mapping.some((m) => m.source === 'negative') && units.some((u) => u.negative.trim())) warnings.push(`工作流「${wf.name}」没有映射负面 Prompt，负面内容不会提交`)
    const cfg = data.lora_config ?? undefined
    if (loras.length && cfg && !cfg.char_targets?.lora1?.replace && !cfg.entries.some((e) => !e.enabled)) {
      const kept = cfg.entries.map((e) => e.name)
      if (kept.length) warnings.push(`工作流原有的 LoRA（${kept.join('、')}）都会继续加载。如果其中有原角色的 LoRA，请替换或关闭它`)
    }
    buildWorkflowInputs(store, wf, units, { savedCfg: cfg, settings, dateStr, errors, warnings })
    const prefixDir = `ComfyEngi复刻/${safeDirName(name)}`
    for (const u of units) {
      if (!u.inputs) continue
      u.inputs = [...u.inputs.map((x) => (x.source === 'filename_prefix' ? { ...x, value: `${prefixDir}/${u.meta.output_name}` } : x)), ...u.extra]
    }
  }
  if (outDir) {
    for (const u of units) u.meta.output_dir = outDir
    const clash = [...new Set(data.images.filter((im) => !im.exclude).map((im) => dirname(im.path)))].find((d) => sameDir(d, outDir))
    if (clash) errors.push(`输出目录不能是原图所在的文件夹（${clash}），请换一个目录`)
  }
  const blocked = rows.filter((r) => r.state !== 'valid' && r.state !== 'excluded').length
  if (!units.length && data.images.length && !errors.length) errors.push('没有可以生成的图片')
  if (blocked) warnings.push(`有 ${blocked} 张图片还不能生成，入队时不包含它们`)
  const plainUnits: PlanUnit[] = units.map(({ extra: _extra, ...u }) => u)
  return { units: plainUnits, errors, warnings, workflow: wf, rows, output_dir: outDir, loras: loras.map((l) => l.name) }
}

/** 冻结为一个执行队列项：之后修改草稿不影响已入队的内容 */
export function enqueueReplica(store: Store, rec: ReplicaRecord, settings?: Settings): { runId: number | null; plan: ReplicaPlan } {
  const plan = planForReplica(store, rec, settings)
  if (plan.errors.length || !plan.workflow) return { runId: null, plan }
  const wf = plan.workflow
  const runId = store.createRun(null, `复刻 · ${rec.name || '未命名'}`, wf.name, wf.api_json, wf.mapping, plan.units.map((u) => ({ ...u, inputs: u.inputs ?? [] })))
  return { runId, plan }
}

/** 入队前预览某张图的最终工作流（与提交时相同的构建方式） */
export function finalReplicaWorkflow(store: Store, rec: ReplicaRecord, unitIndex: number) {
  const plan = planForReplica(store, rec)
  if (!plan.workflow) throw new Error('请选择工作流')
  const u = plan.units[unitIndex]
  if (!u) throw new Error(plan.units.length ? `没有第 ${unitIndex + 1} 张` : '没有可以生成的图片')
  if (!u.inputs) throw new Error(`工作流配置有错误，无法生成最终 JSON：${plan.errors.slice(0, 3).join('；')}`)
  const json = applyInputs(plan.workflow.api_json, u.inputs)
  const { changes, unchanged } = diffWorkflow(plan.workflow.api_json, json, u.inputs)
  return { json, index: unitIndex, count: plan.units.length, label: u.item_label, seed: u.seed, errors: plan.errors, workflow: plan.workflow.name, changes, unchanged: unchanged.length }
}

/** 工作流页面的最终预览：只包含工作流级的节点控制（覆盖、绕过、禁止触发词注入） */
export function workflowPreview(wf: Workflow): { json: ApiWorkflow; errors: string[]; changes: ReturnType<typeof diffWorkflow>['changes']; unchanged: number } {
  const api = wf.api_json ?? {}
  const problems = controlProblems(api, wf.mapping ?? [], controlsOf(wf))
  const inputs = buildControlOnlyInputs(wf)
  const json = applyInputs(api, inputs)
  const { changes, unchanged } = diffWorkflow(api, json, inputs)
  return { json, errors: problems.filter(([l]) => l === 'error').map(([, m]) => m), changes, unchanged: unchanged.length }
}

function buildControlOnlyInputs(wf: Workflow) {
  const api = wf.api_json ?? {}
  const trigger = (wf.mapping ?? []).filter((m) => m.source === TRIGGER_DISABLE).flatMap((m) => toggleDisableInputs(String(m.node), api[String(m.node)]))
  return [...trigger, ...controlInputs(api, controlsOf(wf))]
}

// ---------------- 图片位置

/** 重新定位：在文件夹（含子文件夹）中按文件名查找不在原位置的图片；读取后 Prompt 不同的不替换，只报告 */
export async function relocateImages(data: ReplicaData, folder: string): Promise<{ images: ReplicaImage[]; relocated: number; mismatched: string[]; notFound: string[] }> {
  const index = new Map<string, string>()
  const walk = (d: string, depth: number) => {
    if (depth > 8) return
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isFile() && !index.has(e.name.toLowerCase())) index.set(e.name.toLowerCase(), p)
      else if (e.isDirectory() && !e.name.startsWith('.')) walk(p, depth + 1)
    }
  }
  walk(folder, 0)
  const images = [...data.images]
  let relocated = 0
  const mismatched: string[] = []
  const notFound: string[] = []
  for (let i = 0; i < images.length; i++) {
    const im = images[i]
    if (existsSync(im.path)) continue
    const p = index.get(im.name.toLowerCase())
    if (!p) {
      notFound.push(im.name)
      continue
    }
    const r = await relocateOne(im, p)
    if (r) {
      images[i] = r
      relocated++
    } else mismatched.push(im.name)
  }
  return { images, relocated, mismatched, notFound }
}

/** 指定一张图的新位置：元数据中的 Prompt 与保存的一致才更新路径（没有元数据的图片不比较） */
export async function relocateOne(im: ReplicaImage, path: string): Promise<ReplicaImage | null> {
  if (!statSync(path).isFile()) return null
  const s = await scanImage(path)
  if (im.status !== 'error' && s.status !== 'error' && s.positive !== im.positive && !im.confirmed) return null
  return { ...im, path, name: im.name }
}
