// 批量放大（主进程部分）：从运行记录中选中的图片找到原图文件与提交快照，恢复生成条件，冻结为执行队列中的一个队列项。
// 每张图一个单元（section='upscale'），使用现有的执行队列、提交快照、暂停 / 停止 / 重试与输出复制。
// 原图的生成条件只来自它自己的提交快照（旧记录没有快照时按冻结的工作流与写入值重建，并要求确认），不读取当前角色库或 LoRA 配置。

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { applyInputs, primaryOutputIndex, UPSCALE_IMAGE } from '@shared/mapping'
import type { ApiWorkflow, InputValue, MappingEntry, OutputFile, RunUnit, UnitMeta, UpscaleIssue, UpscaleMeta, Workflow } from '@shared/types'
import { recoverGeneration, upscaleInputs, upscaleWorkflowProblems, type UpscaleCandidate, type UpscalePlan, type UpscaleSelection } from '@shared/upscale'
export type { UpscaleCandidate, UpscalePlan, UpscaleSelection }
import type { Store } from './store'

export const UPSCALE_SECTION = 'upscale'
/** 上传到 ComfyUI input 目录下的子文件夹（文件名每张图唯一，不与其他任务共用） */
export const UPLOAD_SUBFOLDER = 'comfyengi_upscale'

/** 一个输出文件在本机的位置：已复制到任务输出目录的文件优先，其次 ComfyUI 输出目录中的原文件；找不到时为空 */
export function localOutputPath(store: Store, o: OutputFile | undefined): string {
  if (!o) return ''
  if (o.saved && existsSync(o.saved)) return o.saved
  if (o.path && existsSync(o.path)) return o.path
  const base = store.getSetting('comfy_output_dir')
  if (base && o.type === 'output') {
    const p = join(base, o.subfolder ?? '', o.filename)
    if (existsSync(p)) return p
  }
  return ''
}

interface Source {
  cand: UpscaleCandidate
  unit: RunUnit | null
  rec: ReturnType<typeof recoverGeneration> | null
  meta: Omit<UpscaleMeta['source'], 'sha256'> | null
}

const keyOf = (unitId: number, output: number) => `${unitId}:${output}`
const IN_FLIGHT = ['pending', 'submitting', 'submitted']

/** 找到原图与它的提交快照，恢复生成条件 */
function sourceOf(store: Store, sel: UpscaleSelection, runs: Map<number, ReturnType<Store['getRun']>>): Source {
  const unit = store.getUnit(sel.unit_id)
  const base = (issues: UpscaleIssue[], extra: Partial<UpscaleCandidate> = {}): UpscaleCandidate => ({
    key: keyOf(sel.unit_id, sel.output ?? -1),
    unit_id: sel.unit_id,
    output: sel.output ?? -1,
    run_name: '',
    label: '',
    name: '',
    path: '',
    state: 'blocked',
    issues,
    positive: null,
    negative: null,
    checkpoint: null,
    loras: null,
    snapshot: null,
    ...extra,
  })
  if (!unit) return { cand: base([{ level: 'block', text: '这条运行记录已不存在（可能已删除）' }]), unit: null, rec: null, meta: null }
  if (!runs.has(unit.run_id)) runs.set(unit.run_id, store.getRun(unit.run_id))
  const run = runs.get(unit.run_id)
  const wfJson = (run?.workflow_json ?? {}) as unknown as ApiWorkflow
  const output = sel.output ?? primaryOutputIndex(unit, wfJson)
  const o = unit.outputs?.[output]
  const issues: UpscaleIssue[] = []
  const path = localOutputPath(store, o)
  const extra: Partial<UpscaleCandidate> = { key: keyOf(unit.id, output), output, run_name: run?.name ?? '', label: unit.item_label, name: o ? basename(path || o.filename) : '', path }
  if (unit.status !== 'done') issues.push({ level: 'block', text: '这张图没有成功生成，不能放大' })
  else if (unit.section === UPSCALE_SECTION) issues.push({ level: 'block', text: '这是放大结果，不能再次加入放大队列：请选择原图' })
  else if (!o) issues.push({ level: 'block', text: '这条记录没有输出图片' })
  else if (!path) issues.push({ level: 'block', text: `找不到原图文件（${o.saved || o.filename}）：文件可能已移动或删除；没有复制到输出目录的图片需要在设置中填写 ComfyUI 输出目录` })
  else if (o.role === 'intermediate' || o.role === 'preview') issues.push({ level: 'confirm', text: `选中的是中间结果（节点 #${o.node}），不是这张图的最终输出` })
  if (!run) return { cand: base([...issues, { level: 'block', text: '所属队列项已删除，没有入队时冻结的工作流' }], extra), unit, rec: null, meta: null }

  // 原图实际提交的工作流：产生这个文件的那次成功提交的快照
  const attempts = store.attempts(unit.id)
  const ok = attempts.filter((a) => a.state === 'success')
  const attempt = ok.find((a) => o?.prompt_id && a.prompt_id === o.prompt_id) ?? ok.at(-1) ?? attempts.filter((a) => a.prompt_id && a.prompt_id === unit.prompt_id).at(-1) ?? null
  let graph: ApiWorkflow | null = null
  let snapshot: 'attempt' | 'rebuilt' = 'attempt'
  const stored = attempt ? store.attemptBody(attempt.id) : null
  if (stored) {
    if (!stored.intact) issues.push({ level: 'block', text: '这张图的提交快照校验失败（内容与记录的 SHA-256 不一致），不能用来恢复生成条件' })
    else graph = (JSON.parse(stored.body) as { prompt: ApiWorkflow }).prompt
  } else if (Object.keys(wfJson).length) {
    try {
      graph = applyInputs(wfJson, unit.inputs ?? [])
      snapshot = 'rebuilt'
      issues.push({ level: 'confirm', text: '这张图没有提交快照（升级前生成的旧记录），只能按入队时冻结的工作流与写入值重建提交内容；当时的程序版本可能写入了不同的内容' })
    } catch (e) {
      issues.push({ level: 'block', text: `旧记录无法重建提交内容：${(e as Error).message}` })
    }
  } else issues.push({ level: 'block', text: '这张图既没有提交快照，也没有入队时冻结的工作流，无法恢复生成条件' })
  if (!graph) return { cand: base(issues, extra), unit, rec: null, meta: null }

  const mapping = (run.mapping_json ?? []) as MappingEntry[]
  const nodes = (src: string) => mapping.filter((m) => m.source === src).map((m) => String(m.node))
  const rec = recoverGeneration(graph, { original: wfJson, promptNodes: { positive: nodes('positive'), negative: nodes('negative') } })
  issues.push(...rec.issues)
  const meta: Source['meta'] = {
    unit_id: unit.id,
    run_id: unit.run_id,
    run_name: run.name,
    task_id: run.task_id ?? null,
    output,
    node: o?.node ?? '',
    path,
    name: extra.name ?? '',
    prompt_id: o?.prompt_id ?? unit.prompt_id ?? null,
    attempt_id: snapshot === 'attempt' ? (attempt?.id ?? null) : null,
    snapshot,
    seed: unit.seed,
  }
  return { cand: base(issues, { ...extra, positive: rec.positive, negative: rec.negative, checkpoint: rec.checkpoint, loras: rec.loras, snapshot }), unit, rec, meta }
}

const stateOf = (issues: UpscaleIssue[]): UpscaleCandidate['state'] => (issues.some((i) => i.level === 'block') ? 'blocked' : issues.some((i) => i.level === 'confirm') ? 'confirm' : 'ok')

function planInternal(store: Store, sels: UpscaleSelection[], workflowId: number | null) {
  const errors: string[] = []
  const warnings: string[] = []
  const wf = workflowId ? store.get('workflows', workflowId) : null
  if (!wf) errors.push(workflowId ? '选择的放大工作流已不存在' : '请选择放大工作流')
  else
    for (const [lvl, m] of upscaleWorkflowProblems(wf)) (lvl === 'error' ? errors : warnings).push(m)
  // 同一张原图用同一个工作流，在队列中等待或正在处理时不重复加入
  const busy = new Set(
    store
      .listSection(UPSCALE_SECTION, IN_FLIGHT)
      .map((u) => u.meta?.upscale)
      .filter((m): m is UpscaleMeta => !!m)
      .map((m) => `${keyOf(m.source.unit_id, m.source.output)}@${m.workflow.id}`),
  )
  const runs = new Map<number, ReturnType<Store['getRun']>>()
  const seen = new Set<string>()
  const sources: Source[] = []
  for (const sel of sels) {
    const src = sourceOf(store, sel, runs)
    if (seen.has(src.cand.key)) continue
    seen.add(src.cand.key)
    if (wf && busy.has(`${src.cand.key}@${wf.id}`)) src.cand.issues.unshift({ level: 'block', text: `这张图已在放大队列中（使用「${wf.name}」，等待或正在处理），不重复加入` })
    if (wf && src.rec && !errors.length) {
      const up = upscaleInputs(wf, src.rec, `${UPLOAD_SUBFOLDER}/preview.png`)
      src.cand.issues.push(...up.issues)
    }
    src.cand.state = stateOf(src.cand.issues)
    sources.push(src)
  }
  return { wf, errors, warnings, sources }
}

/** 入队前预览：每张图能否放大、恢复出的 Prompt / Checkpoint / LoRA 与问题 */
export function planUpscale(store: Store, sels: UpscaleSelection[], workflowId: number | null): UpscalePlan {
  const p = planInternal(store, sels, workflowId)
  return { workflow: p.wf ? { id: p.wf.id, name: p.wf.name } : null, errors: p.errors, warnings: p.warnings, candidates: p.sources.map((s) => s.cand) }
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

/**
 * 加入放大队列：一次加入为一个队列项（冻结放大工作流的 JSON 与映射），每张图一个单元。
 * acceptConfirm：同时加入需要确认的图片（例如 Prompt 中有运行时产生的文本、旧记录没有快照）；不能放大的图片总是跳过。
 */
export function enqueueUpscale(store: Store, sels: UpscaleSelection[], workflowId: number | null, acceptConfirm = false): { runId: number | null; count: number; errors: string[]; skipped: { unit_id: number; label: string; reason: string }[] } {
  const p = planInternal(store, sels, workflowId)
  const skipped: { unit_id: number; label: string; reason: string }[] = []
  if (p.errors.length || !p.wf) return { runId: null, count: 0, errors: p.errors, skipped }
  const wf = p.wf as Workflow
  const units: { section: string; item_label: string; meta: UnitMeta; modules: unknown; positive: string; negative: string; seed: number; inputs: InputValue[] }[] = []
  for (const s of p.sources) {
    const c = s.cand
    const take = c.state === 'ok' || (c.state === 'confirm' && acceptConfirm)
    if (!take || !s.rec || !s.meta || !s.unit) {
      skipped.push({ unit_id: c.unit_id, label: c.name || c.label || `记录 ${c.unit_id}`, reason: c.issues.find((i) => i.level === 'block' || i.level === 'confirm')?.text ?? '不能放大' })
      continue
    }
    let data: Buffer
    try {
      data = readFileSync(s.meta.path)
    } catch (e) {
      skipped.push({ unit_id: c.unit_id, label: c.name, reason: `读取原图失败：${(e as Error).message}` })
      continue
    }
    const sha = sha256(data)
    // 上传文件名：内容哈希 + 随机串，只含 ASCII（不受中文文件名影响），每张图唯一，不同任务之间不会串图
    const ext = (extname(s.meta.path).toLowerCase() || '.png').replace(/[^.a-z0-9]/g, '')
    const upload = { name: `u${sha.slice(0, 16)}_${randomUUID().replace(/-/g, '').slice(0, 10)}${ext}`, subfolder: UPLOAD_SUBFOLDER }
    const up = upscaleInputs(wf, s.rec, `${upload.subfolder}/${upload.name}`)
    if (!up.inputs) {
      skipped.push({ unit_id: c.unit_id, label: c.name, reason: up.issues[0]?.text ?? '无法构建' })
      continue
    }
    const src = s.unit.meta ?? ({} as UnitMeta)
    const stem = basename(s.meta.path, extname(s.meta.path))
    const issues = c.issues.filter((i) => i.level !== 'block')
    const upscale: UpscaleMeta = {
      source: { ...s.meta, sha256: sha },
      workflow: { id: wf.id, name: wf.name },
      recovered: { positive: s.rec.positive ?? '', negative: s.rec.negative ?? '', checkpoint: s.rec.checkpoint, loras: s.rec.loras ?? [], positive_exact: s.rec.positive_exact, negative_exact: s.rec.negative_exact },
      issues,
      upload,
    }
    units.push({
      section: UPSCALE_SECTION,
      item_label: s.meta.name || c.label,
      meta: {
        task: src.task ?? s.meta.run_name,
        character: src.character ?? '',
        story: src.story ?? '',
        genre: src.genre ?? '',
        section: '放大',
        item: stem,
        item_no: units.length + 1,
        outfit: src.outfit ?? '',
        expression: src.expression ?? '',
        camera: src.camera ?? '',
        male: !!src.male,
        male_templates: [],
        n: 1,
        of: 1,
        index: units.length + 1,
        // 放大结果保存在原图所在文件夹下的「放大」子文件夹，文件名沿用原图名称（同名时追加 (2)、(3)…，不覆盖已有文件）
        output_dir: join(dirname(s.meta.path), '放大'),
        output_name: stem,
        upscale,
      },
      modules: {},
      // 写入放大工作流的正负 Prompt（与 inputs 中的值相同），用于运行记录的显示与搜索
      positive: String(up.inputs.find((x) => x.source === 'positive')?.value ?? s.rec.positive ?? ''),
      negative: String(up.inputs.find((x) => x.source === 'negative')?.value ?? s.rec.negative ?? ''),
      seed: 0,
      inputs: up.inputs,
    })
  }
  if (!units.length) return { runId: null, count: 0, errors: ['没有可以加入放大队列的图片'], skipped }
  const runId = store.createRun(null, `放大 · ${wf.name}`, wf.name, wf.api_json, wf.mapping, units)
  return { runId, count: units.length, errors: [], skipped }
}

/** 放大任务列表（新的在前） */
export function listUpscale(store: Store, limit = 1000): RunUnit[] {
  return store.listSection(UPSCALE_SECTION, [], limit)
}

/** 实际写入 LoadImage 的文件名（ComfyUI 返回的文件名与入队时不同则替换） */
export function withUploadedImage(inputs: InputValue[], actual: string): InputValue[] {
  return inputs.map((x) => (x.source === UPSCALE_IMAGE ? { ...x, value: actual } : x))
}

export const plannedImage = (m: UpscaleMeta) => (m.upload.subfolder ? `${m.upload.subfolder}/${m.upload.name}` : m.upload.name)
