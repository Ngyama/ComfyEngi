// ComfyUI 工作流：API 格式识别、节点输入映射、校验与写入。
// 原则：只修改映射中明确指定的节点输入，不增删节点、不改其他参数。

import { compose, MODULE_LABELS } from './prompt'
import type { ApiNode, ApiWorkflow, InputValue, MappingEntry, Message, OutputFile, Settings } from './types'

export const MAX_LORA_SLOTS = 4

export const SOURCES: [string, string][] = [
  ['positive', '正面 Prompt'],
  ['negative', '负面 Prompt'],
  ['seed', 'Seed'],
  ...Array.from({ length: MAX_LORA_SLOTS }, (_, i) => [
    [`lora${i + 1}_name`, `角色 LoRA ${i + 1} 名称`] as [string, string],
    [`lora${i + 1}_strength`, `角色 LoRA ${i + 1} 强度`] as [string, string],
  ]).flat(),
  ['filename_prefix', '输出文件前缀'],
]
export const SOURCE_LABELS: Record<string, string> = Object.fromEntries(SOURCES)
export const PROMPT_SOURCES = ['positive', 'negative']
export const DEFAULT_PREFIX_TEMPLATE = 'ComfyEngi/{任务}/{序号}_{姿态}'
export const PREFIX_HELP = '{任务} {角色名} {剧情} {姿态} {服装} {表情} {镜头} {序号} {种子} {日期}'

export class ComfyError extends Error {}

// ---------------------------------------------------------------- 工作流导入

export function isLink(v: unknown): v is [string, number] {
  return Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && Number.isInteger(v[1])
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export function detectFormat(data: unknown): 'api' | 'editor' | 'unknown' {
  if (isObj(data)) {
    if (Array.isArray(data.nodes) && 'links' in data) return 'editor'
    const vals = Object.values(data)
    if (vals.length && vals.every((v) => isObj(v) && 'class_type' in v && 'inputs' in v)) return 'api'
  }
  return 'unknown'
}

/** 解析用户导入的 JSON，只接受 API 格式 */
export function loadApiWorkflow(text: string): ApiWorkflow {
  let data: unknown
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch (e) {
    throw new ComfyError(`不是有效的 JSON 文件：${(e as Error).message}`)
  }
  let fmt = detectFormat(data)
  if (fmt === 'unknown' && isObj(data) && isObj(data.prompt)) {
    data = data.prompt
    fmt = detectFormat(data)
  }
  if (fmt === 'editor') {
    throw new ComfyError(
      '这是 ComfyUI 编辑器格式的工作流（包含 nodes/links），不能直接提交给 API。\n' +
        '请在 ComfyUI 中选择「工作流 → 导出 (API)」（旧版需在设置中开启开发者模式后使用 Save (API Format)），再导入导出的文件。',
    )
  }
  if (fmt !== 'api') throw new ComfyError('无法识别的工作流格式：API 格式应为 {节点ID: {class_type, inputs}} 的结构。')
  return data as ApiWorkflow
}

export function nodeTitle(node: ApiNode | undefined): string {
  return node?._meta?.title || node?.class_type || ''
}

export function sortNodeIds(ids: string[]): string[] {
  const key = (x: string) => (/^-?\d+$/.test(x) ? [0, parseInt(x, 10), ''] : [1, 0, x]) as [number, number, string]
  return [...ids].sort((a, b) => {
    const ka = key(a)
    const kb = key(b)
    return ka[0] - kb[0] || ka[1] - kb[1] || (ka[2] < kb[2] ? -1 : ka[2] > kb[2] ? 1 : 0)
  })
}

export function describeValue(v: unknown): string {
  if (isLink(v)) return `← 连接自节点 ${v[0]}`
  const s = JSON.stringify(v) ?? String(v)
  return s.length <= 60 ? s : s.slice(0, 57) + '...'
}

// ---------------------------------------------------------------- 节点映射

export function newEntry(source = 'positive', node = '', input = '', modules: string[] = [], template = ''): MappingEntry {
  return { source, node: String(node), input, modules, template }
}

const isInt = (v: unknown) => typeof v === 'number' && Number.isInteger(v)

export function validateMapping(api: ApiWorkflow, mapping: MappingEntry[]): Message[] {
  const out: Message[] = []
  const seen = new Map<string, number>()
  const sources = new Set<string>()
  mapping.forEach((e, i) => {
    const tag = `映射 ${i + 1}（${SOURCE_LABELS[e.source] ?? e.source}）`
    const src = e.source
    if (!(src in SOURCE_LABELS)) {
      out.push(['error', `${tag}：未知的数据来源 ${src}`])
      return
    }
    sources.add(src)
    const nid = String(e.node ?? '')
    const inp = e.input ?? ''
    const node = api[nid]
    if (!node) {
      out.push(['error', `${tag}：工作流中不存在节点 ID「${nid}」`])
      return
    }
    const inputs = node.inputs ?? {}
    const label = `节点 ${nid}（${nodeTitle(node)}）`
    if (!(inp in inputs)) {
      const avail = Object.entries(inputs).filter(([, v]) => !isLink(v)).map(([k]) => k).join('、') || '无'
      out.push(['error', `${tag}：${label} 没有输入字段「${inp}」。可写入的字段：${avail}`])
      return
    }
    const cur = inputs[inp]
    if (isLink(cur)) {
      out.push(['error', `${tag}：${label} 的「${inp}」当前连接自节点 ${cur[0]}，不是可直接填写的值。请改为映射到上游提供该值的节点。`])
      return
    }
    const key = `${nid}\u0000${inp}`
    if (seen.has(key)) {
      out.push(['error', `${tag}：${label} 的「${inp}」已被映射 ${seen.get(key)! + 1} 使用，同一输入不能写入两次`])
    }
    seen.set(key, i)
    if (PROMPT_SOURCES.includes(src) || src.endsWith('_name') || src === 'filename_prefix') {
      if (typeof cur !== 'string')
        out.push(['warning', `${tag}：${label} 的「${inp}」当前值不是文本（${describeValue(cur)}），请确认是否映射正确`])
    } else if (src === 'seed') {
      if (!isInt(cur)) out.push(['warning', `${tag}：${label} 的「${inp}」当前值不是整数（${describeValue(cur)}）`])
    } else if (src.endsWith('_strength')) {
      if (typeof cur !== 'number') out.push(['warning', `${tag}：${label} 的「${inp}」当前值不是数字（${describeValue(cur)}）`])
    }
    for (const m of e.modules ?? []) {
      if (!(m in MODULE_LABELS)) out.push(['error', `${tag}：未知的 Prompt 模块 ${m}`])
    }
  })
  if (!sources.has('positive')) out.push(['error', '尚未映射「正面 Prompt」，至少需要一个接收正面 Prompt 的节点输入'])
  if (!sources.has('negative')) out.push(['warning', '未映射「负面 Prompt」，将使用工作流中原有的负面 Prompt'])
  if (!sources.has('seed')) out.push(['warning', '未映射 Seed，所有图片将使用工作流中原有的固定 Seed'])
  return out
}

export function mappingErrors(api: ApiWorkflow, mapping: MappingEntry[]): string[] {
  return validateMapping(api, mapping).filter(([l]) => l === 'error').map(([, m]) => m)
}

export interface Suggestion {
  entry: MappingEntry
  checked: boolean
  why: string
}

/** 根据常见节点结构给出映射建议，仅作为供用户勾选确认的候选，不会自动生效 */
export function suggestMapping(api: ApiWorkflow): Suggestion[] {
  const out: Suggestion[] = []
  const seen = new Set<string>()
  const add = (entry: MappingEntry, checked: boolean, why: string) => {
    const k = `${entry.node}\u0000${entry.input}`
    if (seen.has(k)) return
    seen.add(k)
    out.push({ entry, checked, why })
  }
  const ids = sortNodeIds(Object.keys(api))
  for (const nid of ids) {
    const node = api[nid]
    for (const which of ['positive', 'negative']) {
      const link = node.inputs?.[which]
      if (isLink(link)) {
        const src = api[link[0]]
        if (src && typeof src.inputs?.text === 'string')
          add(newEntry(which, link[0], 'text'), true, `节点 ${nid}（${nodeTitle(node)}）的 ${which} 输入来自此节点`)
      }
    }
  }
  for (const nid of ids) {
    const node = api[nid]
    for (const k of ['seed', 'noise_seed']) {
      if (isInt(node.inputs?.[k])) add(newEntry('seed', nid, k), true, `${nodeTitle(node)} 的 ${k}`)
    }
  }
  let loraSeen = false
  for (const nid of ids) {
    const node = api[nid]
    if (typeof node.inputs?.lora_name === 'string') {
      add(newEntry('lora1_name', nid, 'lora_name'), !loraSeen, `${nodeTitle(node)}（请确认这是角色 LoRA 而不是风格 LoRA）`)
      for (const k of ['strength_model', 'strength_clip']) {
        if (typeof node.inputs[k] === 'number') add(newEntry('lora1_strength', nid, k), !loraSeen, `${nodeTitle(node)} 的 ${k}`)
      }
      loraSeen = true
    }
  }
  for (const nid of ids) {
    const node = api[nid]
    if (typeof node.inputs?.filename_prefix === 'string')
      add(
        newEntry('filename_prefix', nid, 'filename_prefix', [], DEFAULT_PREFIX_TEMPLATE),
        false,
        `${nodeTitle(node)}（勾选后将由本软件设置输出文件名前缀）`,
      )
  }
  return out
}

/** 选择节点后，为该数据来源猜测合适的输入字段 */
export function guessInput(source: string, inputs: Record<string, unknown>): string {
  const literal = Object.entries(inputs).filter(([, v]) => !isLink(v)).map(([k]) => k)
  let pref: string[]
  if (PROMPT_SOURCES.includes(source)) pref = ['text']
  else if (source === 'seed') pref = ['seed', 'noise_seed']
  else if (source.endsWith('_name')) pref = ['lora_name']
  else if (source.endsWith('_strength')) pref = ['strength_model', 'strength_clip']
  else pref = ['filename_prefix']
  return pref.find((k) => literal.includes(k)) ?? literal[0] ?? ''
}

// eslint-disable-next-line no-control-regex
const BAD_PATH = /[<>:"\\|?*\x00-\x1f]/g
const safe = (s: unknown) => String(s).replace(BAD_PATH, '_').replace(/^\s+|\s+$/g, '') || '_'

export interface PrefixUnit {
  meta: { task?: string; character?: string; story?: string; item?: string; outfit?: string; expression?: string; camera?: string }
  index: number
  seed: number
}

export function todayStr(d = new Date()): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

export function renderPrefix(template: string, unit: PrefixUnit, dateStr?: string): string {
  const m = unit.meta ?? {}
  const values: [string, unknown][] = [
    ['{任务}', m.task ?? ''],
    ['{角色名}', m.character ?? ''],
    ['{剧情}', m.story ?? ''],
    ['{姿态}', m.item ?? ''],
    ['{服装}', m.outfit ?? ''],
    ['{表情}', m.expression ?? ''],
    ['{镜头}', m.camera ?? ''],
    ['{序号}', String((unit.index ?? 0) + 1).padStart(4, '0')],
    ['{种子}', String(unit.seed ?? '')],
    ['{日期}', dateStr ?? todayStr()],
  ]
  let out = template || DEFAULT_PREFIX_TEMPLATE
  for (const [k, v] of values) out = out.split(k).join(safe(v))
  // 允许 / 作为子目录分隔，去掉空段
  const parts = out.split('\\').join('/').split('/').filter((p) => p.trim() && p !== '.' && p !== '..')
  return parts.join('/') || 'ComfyEngi'
}

export interface ValueUnit extends PrefixUnit {
  modules: Record<string, [string, string]>
  positive: string
  negative: string
  loras: { name: string; strength: number }[]
}

/** 计算每个映射目标要写入的值。预览与实际提交都调用这个函数，保证一致。值为 null 表示保持工作流原值 */
export function mappingValues(
  unit: ValueUnit,
  mapping: MappingEntry[],
  settings: Pick<Settings, 'compose_order' | 'pos_separator' | 'neg_separator' | 'trim_modules'>,
  dateStr?: string,
): InputValue[] {
  const loras = unit.loras ?? []
  return mapping.map((e) => {
    const src = e.source
    let value: unknown = null
    if (PROMPT_SOURCES.includes(src)) {
      const mods = e.modules ?? []
      const [pos, neg] = mods.length ? compose(unit.modules, settings, mods) : [unit.positive, unit.negative]
      value = src === 'positive' ? pos : neg
    } else if (src === 'seed') {
      value = Math.trunc(unit.seed)
    } else if (src.startsWith('lora')) {
      const slot = parseInt(src.slice(4, src.indexOf('_')), 10) - 1
      if (src.endsWith('_name')) value = slot < loras.length ? loras[slot].name : null
      else value = slot < loras.length ? Number(loras[slot].strength ?? 1.0) : 0.0
    } else if (src === 'filename_prefix') {
      value = renderPrefix(e.template || DEFAULT_PREFIX_TEMPLATE, unit, dateStr)
    }
    return { node: String(e.node), input: e.input, source: src, value }
  })
}

/** 复制工作流并只写入映射的输入值 */
export function applyInputs(api: ApiWorkflow, inputs: InputValue[]): ApiWorkflow {
  const graph: ApiWorkflow = structuredClone(api)
  for (const x of inputs) {
    if (x.value === null || x.value === undefined) continue
    const node = graph[String(x.node)]
    if (!node || !(x.input in (node.inputs ?? {})))
      throw new ComfyError(`工作流中找不到节点 ${x.node} 的输入「${x.input}」，映射已失效`)
    node.inputs[x.input] = x.value
  }
  return graph
}

type ObjectInfo = Record<string, { input?: Record<string, Record<string, unknown[]>> }>

/** 联网校验：节点类型是否已安装、LoRA 文件名是否存在于 ComfyUI 的可选列表 */
export function checkAgainstObjectInfo(api: ApiWorkflow, inputsList: InputValue[][], objectInfo: ObjectInfo): Message[] {
  const msgs: Message[] = []
  for (const [nid, node] of Object.entries(api)) {
    if (!(node.class_type in objectInfo))
      msgs.push(['error', `节点 ${nid} 的类型「${node.class_type}」在当前 ComfyUI 中不存在（缺少自定义节点？）`])
  }
  const checked = new Set<string>()
  for (const inputs of inputsList) {
    for (const x of inputs) {
      if (!x.source.endsWith('_name') || x.value == null) continue
      const key = `${x.node}\u0000${x.input}\u0000${x.value}`
      if (checked.has(key)) continue
      checked.add(key)
      const ct = api[x.node]?.class_type
      const spec = (ct && objectInfo[ct]?.input) || {}
      let opts: unknown[] | null = null
      for (const grp of ['required', 'optional']) {
        const d = spec[grp]?.[x.input]
        if (Array.isArray(d) && Array.isArray(d[0])) opts = d[0] as unknown[]
      }
      if (opts && !opts.includes(x.value))
        msgs.push(['error', `LoRA「${x.value}」不在 ComfyUI 的 ${ct}.${x.input} 可选列表中，请检查角色 LoRA 名称`])
    }
  }
  return msgs
}

/** 把 POST /prompt 的 400 响应整理成易读的中文说明 */
export function formatPromptError(body: unknown): string {
  if (!isObj(body)) return `ComfyUI 拒绝了任务：${String(body)}`
  const lines: string[] = []
  const err = body.error
  if (isObj(err)) {
    const msg = String(err.message ?? '')
    const det = err.details ? String(err.details) : ''
    lines.push(`ComfyUI 拒绝了任务：${msg}` + (det ? `（${det}）` : ''))
  } else if (err) {
    lines.push(`ComfyUI 拒绝了任务：${String(err)}`)
  }
  const nodeErrors = isObj(body.node_errors) ? body.node_errors : {}
  for (const [nid, ne] of Object.entries(nodeErrors)) {
    if (!isObj(ne)) continue
    const ct = String(ne.class_type ?? '')
    for (const e of (Array.isArray(ne.errors) ? ne.errors : []) as Record<string, unknown>[]) {
      const inp = isObj(e.extra_info) ? String(e.extra_info.input_name ?? '') : ''
      let s = `  · 节点 ${nid}（${ct}）`
      if (inp) s += ` 输入「${inp}」`
      s += `：${String(e.message ?? '')}`
      if (e.details) s += ` — ${String(e.details)}`
      lines.push(s)
    }
  }
  return lines.join('\n') || 'ComfyUI 拒绝了任务（无详细信息）'
}

type HistoryEntry = { status?: { status_str?: string; completed?: boolean; messages?: unknown[] }; outputs?: Record<string, unknown> }

/** 从 /history 记录中提取执行错误说明 */
export function historyError(entry: HistoryEntry): string {
  for (const msg of entry.status?.messages ?? []) {
    if (Array.isArray(msg) && msg.length === 2) {
      const [kind, data] = msg as [string, Record<string, unknown>]
      if (kind === 'execution_error')
        return `节点 ${data.node_id}（${data.node_type}）执行出错：${data.exception_type ?? ''} ${data.exception_message ?? ''}`.trim()
      if (kind === 'execution_interrupted') return '任务在 ComfyUI 中被中断'
    }
  }
  return 'ComfyUI 报告执行失败'
}

export function historyInterrupted(entry: HistoryEntry): boolean {
  return (entry.status?.messages ?? []).some((m) => Array.isArray(m) && m[0] === 'execution_interrupted')
}

export function extractOutputs(entry: HistoryEntry, outputDir = '', join?: (...p: string[]) => string): OutputFile[] {
  const files: OutputFile[] = []
  for (const [nid, out] of Object.entries(entry.outputs ?? {})) {
    if (!isObj(out)) continue
    for (const val of Object.values(out)) {
      if (!Array.isArray(val)) continue
      for (const f of val) {
        if (isObj(f) && 'filename' in f) {
          const rec: OutputFile = {
            node: nid,
            filename: String(f.filename),
            subfolder: String(f.subfolder ?? ''),
            type: String(f.type ?? 'output'),
            path: '',
          }
          if (outputDir && rec.type === 'output' && join) rec.path = join(outputDir, rec.subfolder, rec.filename)
          files.push(rec)
        }
      }
    }
  }
  return files
}
