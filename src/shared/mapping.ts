// ComfyUI 工作流：API 格式识别、节点输入映射、校验与写入。
// 原则：只修改映射中明确指定的节点输入，不增删节点、不改其他参数。

import { compose, MODULE_LABELS } from './prompt'
import type { ApiNode, ApiWorkflow, InputValue, MappingEntry, Message, OutputFile, Settings } from './types'

export const MAX_LORA_SLOTS = 4
/** 任务级 LoRA（画风、辅助、背景等）最多几个槽位 */
export const MAX_TASK_LORAS = 12

export const SOURCES: [string, string][] = [
  ['positive', '正面 Prompt'],
  ['negative', '负面 Prompt'],
  ['seed', 'Seed'],
  ...Array.from({ length: MAX_LORA_SLOTS }, (_, i) => [
    [`lora${i + 1}_name`, `角色 LoRA ${i + 1} 名称`] as [string, string],
    [`lora${i + 1}_strength`, `角色 LoRA ${i + 1} 强度`] as [string, string],
  ]).flat(),
  // 第二角色的 LoRA：不假定工作流能加载两个角色 LoRA，需要用户把另外的 LoRA 加载节点映射到这里
  ...Array.from({ length: MAX_LORA_SLOTS }, (_, i) => [
    [`second_lora${i + 1}_name`, `第二角色 LoRA ${i + 1} 名称`] as [string, string],
    [`second_lora${i + 1}_strength`, `第二角色 LoRA ${i + 1} 强度`] as [string, string],
  ]).flat(),
  // 任务级 LoRA：在套图任务的 LoRA 配置中添加（不属于角色库）
  ...Array.from({ length: MAX_TASK_LORAS }, (_, i) => [
    [`task_lora${i + 1}_name`, `任务 LoRA ${i + 1} 名称`] as [string, string],
    [`task_lora${i + 1}_strength`, `任务 LoRA ${i + 1} 强度`] as [string, string],
  ]).flat(),
  ['filename_prefix', '输出文件前缀'],
]
export const SOURCE_LABELS: Record<string, string> = Object.fromEntries(SOURCES)
export const PROMPT_SOURCES = ['positive', 'negative']
export const DEFAULT_PREFIX_TEMPLATE = 'ComfyEngi/{任务}/{序号}_{姿态}'
export const PREFIX_HELP = '{任务} {角色名} {剧情} {姿态} {服装} {表情} {镜头} {序号} {种子} {日期}'

export class ComfyError extends Error {}

// ---------------------------------------------------------------- LoRA 槽位
// 一个逻辑 LoRA 配置项 = 一个映射来源前缀（lora1 / second_lora1 / task_lora1），可以绑定多个 Loader 节点：
// 同一来源映射到多个节点时，生成时会把同一个 LoRA 与权重写入所有这些节点（例如两次采样各有一个 Loader）。
// 强度来源写到哪个输入决定写入 Model 还是 Clip 权重：输入名包含 clip 时写 Clip 权重，否则写 Model 权重。
// 多 LoRA Loader（例如 Lora Loader (LoraManager)，loras.__value__ 是一组 LoRA 记录）用「列表绑定」：
// 槽位可以追加为新条目，或替换列表中的某个条目；没有绑定的条目（工作流中固定的 LoRA）保持原样。

export type LoraSlotKind = 'lora' | 'second_lora' | 'task_lora'
export function parseLoraSource(src: string): { prefix: string; kind: LoraSlotKind; slot: number; field: 'name' | 'strength' } | null {
  const m = /^(lora|second_lora|task_lora)(\d+)_(name|strength)$/.exec(src)
  return m ? { prefix: `${m[1]}${m[2]}`, kind: m[1] as LoraSlotKind, slot: Number(m[2]), field: m[3] as 'name' | 'strength' } : null
}
export const isClipInput = (input: string) => /clip/i.test(input)

type SlotLora = { name: string; strength: number; strength_clip?: number; disabled?: boolean }
type LoraUnit = { loras?: SlotLora[]; loras2?: SlotLora[]; task_loras?: (SlotLora & { slot: number })[] }
/** 某个槽位在这张图中实际要加载的 LoRA；未出场、未配置或已禁用时为 undefined */
export function slotLora(unit: LoraUnit, kind: LoraSlotKind, slot: number): SlotLora | undefined {
  const l = kind === 'lora' ? unit.loras?.[slot - 1] : kind === 'second_lora' ? unit.loras2?.[slot - 1] : unit.task_loras?.find((t) => t.slot === slot)
  return l && !l.disabled && l.name ? l : undefined
}
/**
 * 槽位在这张图中的状态：active 要加载；inactive 不加载（停用、角色没有 LoRA、第二角色未出场），绑定的 Loader 需要禁用；
 * absent 只用于任务 LoRA：本任务没有配置这个槽位，绑定的 Loader 保持工作流原值（不影响其他任务的绑定）
 */
export function slotState(unit: LoraUnit, kind: LoraSlotKind, slot: number): 'active' | 'inactive' | 'absent' {
  if (slotLora(unit, kind, slot)) return 'active'
  if (kind === 'task_lora' && !unit.task_loras?.some((t) => t.slot === slot)) return 'absent'
  return 'inactive'
}

/** ComfyUI 的 LoRA 名称（可能带目录与扩展名）→ 多 LoRA Loader 使用的名称（文件名，不含扩展名） */
export const loraStem = (name: string) => (String(name).split(/[\\/]/).pop() ?? String(name)).replace(/\.(safetensors|ckpt|pt|bin)$/i, '')

export interface StackEntry {
  name: string
  strength: number
  clipStrength: number
  active: boolean
}
/** 多 LoRA Loader 的 LoRA 列表（loras.__value__）；不是这种结构时为 null */
export function loraStackOf(node: ApiNode | undefined): Record<string, unknown>[] | null {
  const v = (node?.inputs?.loras as { __value__?: unknown } | undefined)?.__value__
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : null
}
const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Number(v) : d)
export function parseStack(list: Record<string, unknown>[]): StackEntry[] {
  return list.map((e) => {
    const strength = num(e.strength, 1)
    return { name: String(e.name ?? ''), strength, clipStrength: num(e.clipStrength, strength), active: !!e.active }
  })
}

/** 列表绑定：input 为 loras，template 为 stack:append 或 stack:replace:<条目名称> */
export const isStackBinding = (e: Pick<MappingEntry, 'input' | 'template'>) => e.input === 'loras' && (e.template ?? '').startsWith('stack:')
export const stackReplaceTarget = (e: Pick<MappingEntry, 'template'>) => ((e.template ?? '').startsWith('stack:replace:') ? (e.template ?? '').slice('stack:replace:'.length) : null)
export function stackBindingEntry(prefix: string, node: string, replace: string | null = null): MappingEntry {
  return { source: `${prefix}_name`, node, input: 'loras', modules: [], template: replace ? `stack:replace:${replace}` : 'stack:append' }
}

/**
 * 计算多 LoRA Loader 写入后的列表：从工作流原列表出发，按绑定逐个处理。
 * - 替换：active → 写入名称与权重并启用；inactive → 该条目停用（名称不变）；absent（任务未配置）→ 保持原样
 * - 追加：active → 追加新条目；列表中已有同名条目时直接更新它，避免重复加载；inactive / absent → 不追加
 * 其余条目（没有绑定的固定 LoRA）原样保留。
 */
export function applyLoraStack(orig: Record<string, unknown>[], bindings: MappingEntry[], unit: LoraUnit): Record<string, unknown>[] {
  const list = orig.map((e) => ({ ...e }))
  const find = (name: string) => list.findIndex((x) => String(x.name ?? '').toLowerCase() === name.toLowerCase())
  for (const b of bindings) {
    const p = parseLoraSource(b.source)
    if (!p) continue
    const state = slotState(unit, p.kind, p.slot)
    if (state === 'absent') continue
    const l = slotLora(unit, p.kind, p.slot)
    const values = l ? { name: loraStem(l.name), strength: l.strength, clipStrength: l.strength_clip ?? l.strength, active: true } : null
    const target = stackReplaceTarget(b)
    const origIndex = target ? orig.findIndex((x) => String(x.name ?? '').toLowerCase() === target.toLowerCase()) : -1
    if (target && origIndex >= 0) {
      list[origIndex] = values ? { ...list[origIndex], ...values } : { ...list[origIndex], active: false }
    } else if (values) {
      const i = find(values.name)
      if (i >= 0) list[i] = { ...list[i], ...values }
      else list.push({ ...values, expanded: false, selected: false, locked: false })
    }
  }
  return list
}
/** 与 LoRA 列表对应的 <lora:名称:权重> 文本（插件执行时只读取列表；文本只为保持两者一致） */
export function loraStackText(list: Record<string, unknown>[]): string {
  const f = (n: number) => String(Math.round(n * 100) / 100)
  return parseStack(list)
    .map((e) => `<lora:${e.name}:${f(e.strength)}${Math.abs(e.clipStrength - e.strength) > 0.001 ? `:${f(e.clipStrength)}` : ''}>`)
    .join(' ')
}

/**
 * 能识别的 LoRA Loader：
 * - standard：LoraLoader / LoraLoaderModelOnly，完全支持；
 * - compatible：带 lora_name 与 strength_* 数值输入的自定义节点，按同样方式写入；
 * - partial：只有 lora_name，权重无法控制；
 * - stack：多 LoRA Loader（loras.__value__ 为 LoRA 记录列表），按列表绑定写入；
 * - unknown：类型名看起来与 LoRA 有关、但结构无法识别的节点，需要手动映射（不会被静默忽略）。
 */
export const STANDARD_LORA_LOADERS = ['LoraLoader', 'LoraLoaderModelOnly']
export interface LoraLoaderInfo {
  node: string
  title: string
  class_type: string
  support: 'standard' | 'compatible' | 'partial' | 'stack' | 'unknown'
  lora_name: string
  strengths: string[]
  /** 多 LoRA Loader 中的原有条目 */
  entries?: StackEntry[]
}
export function findLoraLoaders(api: ApiWorkflow): LoraLoaderInfo[] {
  const out: LoraLoaderInfo[] = []
  for (const nid of sortNodeIds(Object.keys(api ?? {}))) {
    const node = api[nid]
    const inputs = node?.inputs ?? {}
    const base = { node: nid, title: nodeTitle(node), class_type: node.class_type }
    const stack = loraStackOf(node)
    if (stack) {
      const entries = parseStack(stack)
      out.push({ ...base, support: 'stack', lora_name: entries.map((e) => e.name).join('、'), strengths: [], entries })
      continue
    }
    if (typeof inputs.lora_name === 'string') {
      const strengths = Object.keys(inputs).filter((k) => /^strength/.test(k) && typeof inputs[k] === 'number')
      const support = STANDARD_LORA_LOADERS.includes(node.class_type) ? 'standard' : strengths.length ? 'compatible' : 'partial'
      out.push({ ...base, support, lora_name: inputs.lora_name as string, strengths })
      continue
    }
    // 名称像 LoRA 加载器，但结构无法识别（触发词等辅助节点除外）
    if (/lora/i.test(node.class_type) && !/trigger|tag|info|stack.*(apply|to)/i.test(node.class_type) && ('model' in inputs || 'clip' in inputs))
      out.push({ ...base, support: 'unknown', lora_name: '', strengths: [] })
  }
  return out
}
/** 把一个 Loader 绑定到槽位时需要的映射：标准 Loader 为名称 + 全部强度输入；多 LoRA Loader 默认追加为新条目 */
export function loraBindingEntries(prefix: string, loader: LoraLoaderInfo): MappingEntry[] {
  if (loader.support === 'stack') return [stackBindingEntry(prefix, loader.node)]
  return [
    { source: `${prefix}_name`, node: loader.node, input: 'lora_name', modules: [], template: '' },
    ...loader.strengths.map((input) => ({ source: `${prefix}_strength`, node: loader.node, input, modules: [], template: '' })),
  ]
}

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
    if (isStackBinding(e)) {
      // 多 LoRA Loader 的列表绑定：同一节点可以有多个槽位；替换的条目应存在于列表中
      const stack = loraStackOf(node)
      if (!stack) out.push(['error', `${tag}：${label} 不是可识别的多 LoRA Loader（没有 loras 列表），请重新绑定`])
      else {
        const target = stackReplaceTarget(e)
        if (target && !parseStack(stack).some((x) => x.name.toLowerCase() === target.toLowerCase())) out.push(['warning', `${tag}：${label} 的 LoRA 列表中没有「${target}」，生成时将改为追加`])
      }
      return
    }
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
  loras: SlotLora[]
  loras2?: SlotLora[]
  task_loras?: (SlotLora & { slot: number })[]
}

/** 计算每个映射目标要写入的值。预览与实际提交都调用这个函数，保证一致。值为 null 表示保持工作流原值 */
export function mappingValues(
  unit: ValueUnit,
  mapping: MappingEntry[],
  settings: Pick<Settings, 'compose_order' | 'pos_separator' | 'neg_separator' | 'trim_modules'>,
  dateStr?: string,
  /** 工作流 JSON：多 LoRA Loader 的列表绑定需要以工作流原列表为基础计算 */
  api?: ApiWorkflow,
): InputValue[] {
  const values: InputValue[] = mapping.filter((e) => !isStackBinding(e)).map((e) => {
    const src = e.source
    let value: unknown = null
    if (PROMPT_SOURCES.includes(src)) {
      const mods = e.modules ?? []
      const [pos, neg] = mods.length ? compose(unit.modules, settings, mods) : [unit.positive, unit.negative]
      value = src === 'positive' ? pos : neg
    } else if (src === 'seed') {
      value = Math.trunc(unit.seed)
    } else if (parseLoraSource(src)) {
      // inactive（未出场、已停用）：名称保持工作流原值、强度写 0；absent（本任务未配置该任务 LoRA）：全部保持原值
      const p = parseLoraSource(src)!
      const state = slotState(unit, p.kind, p.slot)
      const l = slotLora(unit, p.kind, p.slot)
      if (state === 'absent') value = null
      else if (p.field === 'name') value = l ? l.name : null
      else value = l ? Number(isClipInput(e.input) ? (l.strength_clip ?? l.strength ?? 1.0) : (l.strength ?? 1.0)) : 0.0
    } else if (src === 'filename_prefix') {
      value = renderPrefix(e.template || DEFAULT_PREFIX_TEMPLATE, unit, dateStr)
    }
    return { node: String(e.node), input: e.input, source: src, value }
  })
  // 多 LoRA Loader：同一节点的所有列表绑定合并为一次写入（loras 列表，以及与之对应的 text）
  const stackNodes = [...new Set(mapping.filter(isStackBinding).map((e) => String(e.node)))]
  for (const nid of stackNodes) {
    const node = api?.[nid]
    const orig = loraStackOf(node)
    const list = orig ? applyLoraStack(orig, mapping.filter((e) => isStackBinding(e) && String(e.node) === nid), unit) : null
    values.push({ node: nid, input: 'loras', source: 'lora_stack', value: list ? { ...(node!.inputs.loras as object), __value__: list } : null })
    if (list && typeof node?.inputs?.text === 'string') values.push({ node: nid, input: 'text', source: 'lora_stack', value: loraStackText(list) })
  }
  return values
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
