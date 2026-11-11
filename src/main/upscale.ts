// 批量放大（主进程部分）：从运行记录中选中的图片找到原图文件与提交快照，恢复生成条件，冻结为执行队列中的一个队列项。
// 每张图一个单元（section='upscale'），使用现有的执行队列、提交快照、暂停 / 停止 / 重试与输出复制。
// 原图的生成条件只来自它自己的提交快照（旧记录没有快照时按冻结的工作流与写入值重建，并要求确认），不读取当前角色库或 LoRA 配置。

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { applyInputs, primaryOutputIndex, UPSCALE_IMAGE, UPSCALE_SEED } from '@shared/mapping'
import { parseJsonLoose } from '@shared/prompt-source'
import type { ApiWorkflow, InputValue, MappingEntry, OutputFile, RunUnit, UnitMeta, UpscaleIssue, UpscaleMeta, Workflow } from '@shared/types'
import { isFileSelection, recoverGeneration, upscaleInputs, upscaleWorkflowProblems, type UpscaleCandidate, type UpscalePlan, type UpscaleSelection, type UpscaleSkipped, type UpscaleFolderScan } from '@shared/upscale'
export type { UpscaleCandidate, UpscalePlan, UpscaleSelection, UpscaleSkipped }
import { fieldMap, PngError, readImageMeta } from './png-meta'
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
  /** file 来源在预览时已计算的 SHA-256（运行记录来源在入队时计算） */
  sha?: string
}

const keyOf = (unitId: number, output: number) => `${unitId}:${output}`
const IN_FLIGHT = ['pending', 'submitting', 'submitted']
/** 可以作为放大来源的图片扩展名（实际格式按文件内容识别） */
export const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp']
/** 放大结果所在的子文件夹名称（扫描文件夹时跳过） */
export const RESULT_DIR = '放大'

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const blank = (key: string, kind: UpscaleCandidate['kind']): UpscaleCandidate => ({
  key,
  kind,
  unit_id: null,
  output: null,
  run_name: '',
  label: '',
  name: '',
  path: '',
  state: 'blocked',
  issues: [],
  positive: null,
  negative: null,
  checkpoint: null,
  loras: null,
  snapshot: null,
})

/**
 * 本机图片文件：从元数据中的 prompt（ComfyUI 实际执行的 API 工作流）恢复生成条件。
 * 没有 prompt 的图片（元数据被剥离、只有 WebUI 的 parameters、只有界面格式的 workflow）不能放大，给出原因。
 */
function fileSource(file: string): Source {
  const path = resolve(file)
  const name = basename(path)
  const cand = { ...blank(`file:${path}`, 'file'), label: name, name, path }
  const blocked = (text: string): Source => ({ cand: { ...cand, issues: [...cand.issues, { level: 'block', text }] }, unit: null, rec: null, meta: null })
  if (!existsSync(path)) return blocked(`找不到图片文件：${path}`)
  let fields: Record<string, string>
  let data: Buffer
  try {
    data = readFileSync(path)
    const meta = readImageMeta(path)
    fields = fieldMap(meta.fields)
    for (const w of meta.warnings) cand.issues.push({ level: 'note', text: `图片文件：${w}` })
  } catch (e) {
    return blocked(e instanceof PngError ? `无法读取图片元数据：${e.message}` : `读取图片失败：${(e as Error).message}`)
  }
  const sha = sha256(data)
  if (!fields.prompt) {
    if (fields.parameters) return { ...blocked('图片只有 WebUI 格式的 parameters 元数据，没有 ComfyUI 的 prompt（实际执行的 API 工作流），无法恢复 Checkpoint、LoRA 与 Prompt 链路'), sha }
    if (fields.workflow) return { ...blocked('图片只有界面格式的 workflow 元数据，没有 ComfyUI 的 prompt（实际执行的 API 工作流）：界面格式不能确定实际提交的值'), sha }
    return { ...blocked('图片中没有 ComfyUI 的 prompt 元数据（可能经过截图、压缩或其他软件保存，元数据已被剥离）'), sha }
  }
  let graph: ApiWorkflow
  try {
    const g = parseJsonLoose(fields.prompt)
    if (!g || typeof g !== 'object' || Array.isArray(g) || !Object.values(g).some((n) => n && typeof n === 'object' && typeof (n as { class_type?: unknown }).class_type === 'string')) throw new Error('不是 API 工作流')
    graph = g as ApiWorkflow
  } catch (e) {
    return { ...blocked(`图片中的 prompt 元数据不是 ComfyUI 的 API 工作流（${(e as Error).message}）`), sha }
  }
  // 放大结果：LoadImage 读取的是 ComfyEngi 上传到 comfyengi_upscale/ 的图片
  const loaded = Object.entries(graph).find(([, n]) => n?.class_type === 'LoadImage' && typeof n.inputs?.image === 'string' && n.inputs.image.replace(/\\/g, '/').startsWith(`${UPLOAD_SUBFOLDER}/`))
  if (loaded) return { ...blocked(`这是放大结果（LoadImage #${loaded[0]} 读取的是 ComfyEngi 上传的 ${String(loaded[1].inputs.image)}），不能再次放大：请选择原图`), sha }
  const rec = recoverGeneration(graph, { original: graph })
  cand.issues.push(...rec.issues)
  const meta: Source['meta'] = {
    kind: 'file',
    unit_id: null,
    run_id: null,
    run_name: '',
    task_id: null,
    output: null,
    node: null,
    path,
    name,
    prompt_id: null,
    attempt_id: null,
    snapshot: 'file',
    seed: rec.seed ?? null,
  }
  return { cand: { ...cand, positive: rec.positive, negative: rec.negative, checkpoint: rec.checkpoint, loras: rec.loras, snapshot: 'file' }, unit: null, rec, meta, sha }
}

/**
 * 扫描文件夹中的图片（可选包含子文件夹），按路径排序。名为「放大」的子文件夹（放大结果）跳过；符号链接不跟随。
 * 最多返回 limit 张，超出时 truncated 为 true。
 */
export function scanUpscaleFolder(dir: string, recursive: boolean, limit = 2000): UpscaleFolderScan {
  const root = resolve(dir)
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`文件夹不存在：${root}`)
  const files: string[] = []
  const skipped: string[] = []
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) {
        if (!recursive) continue
        if (e.name === RESULT_DIR) skipped.push(p)
        else walk(p)
      } else if (e.isFile() && IMAGE_EXTS.includes(extname(e.name).toLowerCase())) files.push(p)
    }
  }
  walk(root)
  const collator = new Intl.Collator('zh-CN', { numeric: true })
  files.sort((a, b) => collator.compare(a, b))
  skipped.sort((a, b) => collator.compare(a, b))
  return { files: files.slice(0, limit), skipped_dirs: skipped, truncated: files.length > limit }
}

/** 找到原图与它的提交快照，恢复生成条件 */
function sourceOf(store: Store, sel: UpscaleSelection, runs: Map<number, ReturnType<Store['getRun']>>): Source {
  if (isFileSelection(sel)) return fileSource(sel.file)
  const unit = store.getUnit(sel.unit_id)
  const base = (issues: UpscaleIssue[], extra: Partial<UpscaleCandidate> = {}): UpscaleCandidate => ({
    ...blank(keyOf(sel.unit_id, sel.output ?? -1), 'run'),
    unit_id: sel.unit_id,
    output: sel.output ?? -1,
    issues,
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
    kind: 'run',
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
  // 同一张原图（运行记录中的同一输出，或内容相同的文件）用同一个工作流，在队列中等待或正在处理时不重复加入
  const busyRun = new Set<string>()
  const busySha = new Set<string>()
  for (const u of store.listSection(UPSCALE_SECTION, IN_FLIGHT)) {
    const m = u.meta?.upscale
    if (!m) continue
    if (m.source.unit_id != null && m.source.output != null) busyRun.add(`${keyOf(m.source.unit_id, m.source.output)}@${m.workflow.id}`)
    if (m.source.sha256) busySha.add(`${m.source.sha256}@${m.workflow.id}`)
  }
  const runs = new Map<number, ReturnType<Store['getRun']>>()
  const seen = new Set<string>()
  const seenSha = new Map<string, string>()
  const sources: Source[] = []
  for (const sel of sels) {
    const src = sourceOf(store, sel, runs)
    if (seen.has(src.cand.key)) continue
    seen.add(src.cand.key)
    const dup = (text: string) => src.cand.issues.unshift({ level: 'block', text })
    if (wf && src.cand.kind === 'run' && busyRun.has(`${src.cand.key}@${wf.id}`)) dup(`这张图已在放大队列中（使用「${wf.name}」，等待或正在处理），不重复加入`)
    else if (wf && src.sha && busySha.has(`${src.sha}@${wf.id}`)) dup(`内容相同的图片（SHA-256 相同）已在放大队列中（使用「${wf.name}」，等待或正在处理），不重复加入`)
    if (src.sha) {
      const prev = seenSha.get(src.sha)
      if (prev) dup(`与这次选择的「${prev}」内容相同（SHA-256 相同），不重复加入`)
      else seenSha.set(src.sha, src.cand.path || src.cand.name)
    }
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

/**
 * 加入放大队列：一次加入为一个队列项（冻结放大工作流的 JSON 与映射），每张图一个单元。
 * acceptConfirm：同时加入需要确认的图片（例如 Prompt 中有运行时产生的文本、旧记录没有快照）；不能放大的图片总是跳过。
 */
export function enqueueUpscale(store: Store, sels: UpscaleSelection[], workflowId: number | null, acceptConfirm = false): { runId: number | null; count: number; errors: string[]; skipped: UpscaleSkipped[] } {
  const p = planInternal(store, sels, workflowId)
  const skipped: UpscaleSkipped[] = []
  if (p.errors.length || !p.wf) return { runId: null, count: 0, errors: p.errors, skipped }
  const wf = p.wf as Workflow
  const units: { section: string; item_label: string; meta: UnitMeta; modules: unknown; positive: string; negative: string; seed: number; inputs: InputValue[] }[] = []
  for (const s of p.sources) {
    const c = s.cand
    const take = c.state === 'ok' || (c.state === 'confirm' && acceptConfirm)
    const skip = (reason: string) => skipped.push({ key: c.key, unit_id: c.unit_id, file: c.kind === 'file' ? c.path : null, label: c.name || c.label || `记录 ${c.unit_id}`, reason })
    if (!take || !s.rec || !s.meta || (c.kind === 'run' && !s.unit)) {
      skip(c.issues.find((i) => i.level === 'block' || i.level === 'confirm')?.text ?? '不能放大')
      continue
    }
    let data: Buffer
    try {
      data = readFileSync(s.meta.path)
    } catch (e) {
      skip(`读取原图失败：${(e as Error).message}`)
      continue
    }
    const sha = sha256(data)
    if (s.sha && s.sha !== sha) {
      skip('图片文件在检查期间被修改，请重新选择')
      continue
    }
    // 上传文件名：内容哈希 + 随机串，只含 ASCII（不受中文文件名影响），每张图唯一，不同任务之间不会串图
    const ext = (extname(s.meta.path).toLowerCase() || '.png').replace(/[^.a-z0-9]/g, '')
    const upload = { name: `u${sha.slice(0, 16)}_${randomUUID().replace(/-/g, '').slice(0, 10)}${ext}`, subfolder: UPLOAD_SUBFOLDER }
    const up = upscaleInputs(wf, s.rec, `${upload.subfolder}/${upload.name}`)
    if (!up.inputs) {
      skip(up.issues.find((i) => i.level === 'block')?.text ?? '无法构建')
      continue
    }
    // 运行记录来源沿用原图的任务信息；文件来源只有文件所在的文件夹
    const src = s.unit?.meta ?? ({} as Partial<UnitMeta>)
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
        task: src.task ?? (s.meta.run_name || basename(dirname(s.meta.path))),
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
        output_dir: join(dirname(s.meta.path), RESULT_DIR),
        output_name: stem,
        upscale,
      },
      modules: {},
      // 写入放大工作流的正负 Prompt（与 inputs 中的值相同），用于运行记录的显示与搜索
      positive: String(up.inputs.find((x) => x.source === 'positive')?.value ?? s.rec.positive ?? ''),
      negative: String(up.inputs.find((x) => x.source === 'negative')?.value ?? s.rec.negative ?? ''),
      // 映射了「放大：Seed」时为写入的 Seed，否则为 0（采样参数保持放大工作流的值）
      seed: Number(up.inputs.find((x) => x.source === UPSCALE_SEED)?.value ?? 0),
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
