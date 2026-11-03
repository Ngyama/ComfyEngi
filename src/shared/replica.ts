// 套图复刻：从原图元数据恢复生成参数、统计 Tag、替换选中的 Tag。
// 替换只移除选中的 Tag，其余文本逐字节保留（不去重、不重排、不改权重）。
// 选择单位是单个 Tag：(a, b:1.2)、((a, b))、[a, b] 这样的组合会逐层展开，只移除选中的子 Tag，保留括号与权重写法，
// 因此其余 Tag 的有效权重不变。动态语法（{a|b}、[a:b:0.5]）不拆开，选中的 Tag 在其中时要求手动编辑。

import { findLoraLoaders, isLink, loraStem } from './mapping'
import { consumersOf, inputControl, literalKind } from './node-controls'
import { parseJsonLoose, samplersOfGraph, type PromptCandidate, type PromptSource } from './prompt-source'
import { normalizeKey, parseToken, peelWeight, splitTopLevel, topLevelSegments } from './tags'
import type { ApiWorkflow, InputValue, MappingEntry, WorkflowControls } from './types'
import type { WfLoraConfig } from './lora-config'

export const REPLICA_PARAM = 'replica_param'

export type ParamKey = 'seed' | 'width' | 'height' | 'steps' | 'cfg' | 'sampler' | 'scheduler' | 'denoise'
export const PARAM_KEYS: ParamKey[] = ['seed', 'width', 'height', 'steps', 'cfg', 'sampler', 'scheduler', 'denoise']
export const PARAM_LABELS: Record<ParamKey, string> = { seed: 'Seed', width: '宽度', height: '高度', steps: 'Steps', cfg: 'CFG', sampler: 'Sampler', scheduler: 'Scheduler', denoise: 'Denoise' }
const INPUT_OF: Record<ParamKey, string[]> = { seed: ['seed', 'noise_seed'], width: ['width'], height: ['height'], steps: ['steps'], cfg: ['cfg'], sampler: ['sampler_name'], scheduler: ['scheduler'], denoise: ['denoise'] }

export type RecoverState = 'ok' | 'confirm' | 'missing'
export interface RecoveredParam {
  value: number | string | null
  state: RecoverState
  note?: string
}
export type RecoveredParams = Partial<Record<ParamKey, RecoveredParam>>
export interface ImageLora {
  name: string
  strength?: number
}

const missing = (note?: string): RecoveredParam => ({ value: null, state: 'missing', ...(note ? { note } : {}) })

/** 值是否可以用于这个参数；不合法时按缺失处理（不把猜测的值写入工作流） */
function checked(key: ParamKey, raw: unknown, state: RecoverState, note?: string): RecoveredParam {
  const num = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN
  const withNote = (value: number | string): RecoveredParam => ({ value, state, ...(note ? { note } : {}) })
  if (raw === null || raw === undefined || raw === '') return missing(note)
  switch (key) {
    case 'seed':
      if (!Number.isInteger(num) || num < 0) return missing('Seed 不是有效的非负整数')
      if (!Number.isSafeInteger(num)) return missing(`Seed ${raw} 超过可以精确保存的范围`)
      return withNote(num)
    case 'width':
    case 'height':
    case 'steps':
      return Number.isInteger(num) && num > 0 ? withNote(num) : missing(`值 ${String(raw)} 无效`)
    case 'cfg':
      return Number.isFinite(num) && num >= 0 ? withNote(num) : missing(`值 ${String(raw)} 无效`)
    case 'denoise':
      return Number.isFinite(num) && num >= 0 && num <= 1 ? withNote(num) : missing(`值 ${String(raw)} 无效`)
    default:
      return typeof raw === 'string' && raw.trim() ? withNote(raw.trim()) : missing()
  }
}

// ---------------- ComfyUI 图

type G = ApiWorkflow
const PRIMITIVE_FIELDS = ['value', 'int', 'float', 'number', 'seed', 'noise_seed', 'string', 'String', 'Value', 'INT', 'FLOAT', 'STRING', 'text']
const SAMPLING_LINKS = ['noise', 'guider', 'sampler', 'sigmas']

/** 字面值，或一层连接后的基础节点的值；连接到无法确定的节点时返回 undefined */
function resolveValue(g: G, v: unknown, names: string[], depth = 0): unknown {
  if (!isLink(v)) return v
  if (depth > 8) return undefined
  const n = g[String(v[0])]
  if (!n) return undefined
  const inputs = n.inputs ?? {}
  for (const f of [...names, ...PRIMITIVE_FIELDS]) if (f in inputs) return resolveValue(g, inputs[f], names, depth + 1)
  return undefined
}

/** 采样器相关的节点：本身、自定义采样的 noise / guider / sampler / sigmas，以及使用这个 Guider 的采样节点 */
function samplingNodes(g: G, id: string): string[] {
  const out = [id]
  const add = (nid: string) => {
    if (!out.includes(nid) && g[nid]) out.push(nid)
    const inputs = g[nid]?.inputs ?? {}
    for (const k of SAMPLING_LINKS) {
      const l = inputs[k]
      if (isLink(l) && !out.includes(String(l[0]))) out.push(String(l[0]))
    }
  }
  add(id)
  for (const c of consumersOf(g, id)) if (c.input === 'guider') add(c.node)
  return out
}

function readSampling(g: G, id: string, names: string[]): unknown {
  for (const nid of samplingNodes(g, id)) {
    const inputs = g[nid]?.inputs ?? {}
    for (const f of names) if (f in inputs) return resolveValue(g, inputs[f], names)
  }
  return undefined
}

function readSize(g: G, id: string, dim: 'width' | 'height'): unknown {
  for (const nid of samplingNodes(g, id)) {
    const l = g[nid]?.inputs?.latent_image
    if (!isLink(l)) continue
    const inputs = g[String(l[0])]?.inputs ?? {}
    if (dim in inputs) return resolveValue(g, inputs[dim], [dim])
  }
  return undefined
}

function fromGraph(g: G): RecoveredParams {
  const list = samplersOfGraph(g)
  if (!list.length) return Object.fromEntries(PARAM_KEYS.map((k) => [k, missing('没有找到采样器')]))
  const firsts = list.filter((s) => s.first)
  const base = firsts.length ? firsts : list
  const others = list.length - base.length
  const out: RecoveredParams = {}
  for (const key of PARAM_KEYS) {
    const values = base.map((s) => (key === 'width' || key === 'height' ? readSize(g, s.id, key) : readSampling(g, s.id, INPUT_OF[key])))
    const known = values.filter((v) => v !== undefined && v !== null && !isLink(v))
    if (!known.length) {
      out[key] = missing(values.some((v) => isLink(v) || v === undefined) && base.some((s) => key !== 'width' && key !== 'height' && samplingNodes(g, s.id).some((n) => INPUT_OF[key].some((f) => f in (g[n]?.inputs ?? {})))) ? '由其他节点计算，无法确定' : undefined)
      continue
    }
    const distinct = new Set(known.map((v) => JSON.stringify(v)))
    if (distinct.size > 1) out[key] = checked(key, known[0], 'confirm', `${base.length} 个采样器的值不同（${[...distinct].slice(0, 3).join('、')}），这里是第一个`)
    else if (!firsts.length) out[key] = checked(key, known[0], 'confirm', '无法判断哪个是第一次采样')
    else out[key] = checked(key, known[0], 'ok', others ? `只取第一次采样，另有 ${others} 个后续采样未读取` : undefined)
  }
  return out
}

// ---------------- 文本与 JSON 格式

const A1111_SAMPLERS: Record<string, string> = { 'euler a': 'euler_ancestral', euler: 'euler', lms: 'lms', heun: 'heun', dpm2: 'dpm_2', 'dpm2 a': 'dpm_2_ancestral', 'dpm++ 2s a': 'dpmpp_2s_ancestral', 'dpm++ 2m': 'dpmpp_2m', 'dpm++ sde': 'dpmpp_sde', 'dpm++ 2m sde': 'dpmpp_2m_sde', 'dpm++ 3m sde': 'dpmpp_3m_sde', ddim: 'ddim', unipc: 'uni_pc', lcm: 'lcm' }
const A1111_SCHEDULERS: Record<string, string> = { karras: 'karras', exponential: 'exponential', 'sgm uniform': 'sgm_uniform', simple: 'simple', normal: 'normal', ddim: 'ddim_uniform', beta: 'beta' }

function fromParameters(text: string): RecoveredParams {
  const line = String(text).split(/\r?\n/).filter((l) => /^Steps: \d+/.test(l)).pop()
  if (!line) return Object.fromEntries(PARAM_KEYS.map((k) => [k, missing('parameters 中没有采样参数')]))
  const kv = new Map<string, string>()
  for (const m of line.matchAll(/([\w][\w \-/]*): ("(?:[^"\\]|\\.)*"|[^,]*)(?:,|$)/g)) kv.set(m[1].trim(), m[2].trim().replace(/^"|"$/g, ''))
  const size = /^(\d+)x(\d+)$/.exec(kv.get('Size') ?? '')
  const rawSampler = kv.get('Sampler') ?? ''
  const karras = /\s+karras$/i.test(rawSampler)
  const sampler = A1111_SAMPLERS[rawSampler.replace(/\s+karras$/i, '').toLowerCase()]
  const schedRaw = kv.get('Schedule type') ?? (karras ? 'karras' : '')
  const sched = A1111_SCHEDULERS[schedRaw.toLowerCase()]
  const hires = [...kv.keys()].some((k) => /^Hires /.test(k))
  return {
    seed: checked('seed', kv.get('Seed'), 'ok'),
    width: size ? checked('width', size[1], 'ok') : missing(),
    height: size ? checked('height', size[2], 'ok') : missing(),
    steps: checked('steps', kv.get('Steps'), 'ok'),
    cfg: checked('cfg', kv.get('CFG scale'), 'ok'),
    sampler: rawSampler ? (sampler ? checked('sampler', sampler, 'confirm', `由「${rawSampler}」对应，请确认`) : missing(`「${rawSampler}」没有对应的 ComfyUI 名称`)) : missing(),
    scheduler: schedRaw ? (sched ? checked('scheduler', sched, 'confirm', `由「${schedRaw}」对应，请确认`) : missing(`「${schedRaw}」没有对应的 ComfyUI 名称`)) : missing(),
    denoise: kv.has('Denoising strength') ? (hires ? missing('这是高清修复的重绘幅度，不是第一次采样') : checked('denoise', kv.get('Denoising strength'), 'confirm', '来自图生图参数，请确认')) : missing(),
  }
}

const pick = (o: Record<string, unknown>, keys: string[]) => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k]
  return undefined
}

/** 其他软件保存的 JSON：字段名明确的数字可靠；采样器名称的写法各软件不同，需要确认 */
function fromObject(o: Record<string, unknown>, samplerKeys = ['sampler', 'sampler_name', 'Sampler'], schedulerKeys = ['scheduler', 'Scheduler']): RecoveredParams {
  const res = /(\d+)\D+(\d+)/.exec(String(pick(o, ['resolution', 'Resolution']) ?? ''))
  const sampler = pick(o, samplerKeys)
  const scheduler = pick(o, schedulerKeys)
  return {
    seed: checked('seed', pick(o, ['seed', 'Seed']), 'ok'),
    width: checked('width', pick(o, ['width', 'Width']) ?? res?.[1], 'ok'),
    height: checked('height', pick(o, ['height', 'Height']) ?? res?.[2], 'ok'),
    steps: checked('steps', pick(o, ['steps', 'Steps', 'num_inference_steps', 'inference_steps']), 'ok'),
    cfg: checked('cfg', pick(o, ['cfg', 'cfg_scale', 'cfgscale', 'cfg_scale_float', 'scale', 'guidance_scale', 'Guidance Scale']), 'ok'),
    sampler: sampler !== undefined ? checked('sampler', sampler, 'confirm', '其他软件的名称可能与 ComfyUI 不同，请确认') : missing(),
    scheduler: scheduler !== undefined ? checked('scheduler', scheduler, 'confirm', '其他软件的名称可能与 ComfyUI 不同，请确认') : missing(),
    denoise: missing(),
  }
}

const tryObject = (text: string | undefined): Record<string, unknown> | null => {
  if (!text) return null
  try {
    const v = parseJsonLoose(text)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * 从元数据恢复生成参数（字段来源与 extractPrompt 选用的 Prompt 来源一致，不混用不同来源的参数）。
 * pixel 为图片实际尺寸：可能经过放大，只在元数据没有尺寸时作为「需要确认」。
 */
export function recoverParams(chunks: Record<string, string>, source: PromptSource | null, pixel?: { width: number; height: number } | null): RecoveredParams {
  const c: Record<string, string> = {}
  for (const [k, v] of Object.entries(chunks)) if (typeof v === 'string' && !(k.toLowerCase() in c)) c[k.toLowerCase()] = v
  let out: RecoveredParams = {}
  const graph = tryObject(c.prompt)
  if (source === 'comfy-api' && graph) out = fromGraph(graph as G)
  else if (source === 'comfy-workflow') out = Object.fromEntries(PARAM_KEYS.map((k) => [k, missing('只有界面格式的工作流，无法可靠地读取参数')]))
  else if (source === 'a1111') out = fromParameters(c.parameters ?? '')
  else if (source === 'swarmui' || source === 'fooocus') {
    const j = tryObject(c.parameters) ?? {}
    const sui = j.sui_image_params
    out = fromObject(sui && typeof sui === 'object' ? (sui as Record<string, unknown>) : j)
  } else if (source === 'novelai') out = fromObject(tryObject(c.comment) ?? {})
  else if (source === 'invokeai') out = fromObject(tryObject(c.invokeai_metadata) ?? {}, ['scheduler'], [])
  else if (source === 'easydiffusion') out = fromObject(c as Record<string, unknown>)
  else if (graph) out = fromGraph(graph as G)
  else out = Object.fromEntries(PARAM_KEYS.map((k) => [k, missing()]))
  for (const dim of ['width', 'height'] as const) if (pixel && out[dim]?.state !== 'ok' && !out[dim]?.value) out[dim] = checked(dim, pixel[dim], 'confirm', '来自图片实际尺寸，可能包含放大')
  return out
}

/** 原图使用的 LoRA（只用于显示，帮助用户判断工作流中哪个 LoRA 属于原角色） */
export function imageLoras(chunks: Record<string, string>, positive: string): ImageLora[] {
  const out = new Map<string, ImageLora>()
  const graph = tryObject(chunks.prompt ?? chunks.Prompt)
  if (graph) {
    try {
      for (const l of findLoraLoaders(graph as G)) {
        if (l.entries) {
          for (const e of l.entries) if (e.active) out.set(loraStem(e.name).toLowerCase(), { name: e.name, strength: e.strength })
        } else if (l.lora_name) {
          const s = (graph as G)[l.node].inputs?.strength_model
          out.set(loraStem(l.lora_name).toLowerCase(), { name: l.lora_name, ...(typeof s === 'number' ? { strength: s } : {}) })
        }
      }
    } catch {
      // 第三方节点结构异常时只是不显示
    }
  }
  for (const m of String(positive ?? '').matchAll(/<lora:([^:>]+)(?::(-?\d+(?:\.\d+)?))?[^>]*>/gi)) out.set(loraStem(m[1]).toLowerCase(), { name: m[1], ...(m[2] ? { strength: Number(m[2]) } : {}) })
  return [...out.values()]
}

// ---------------- Tag 统计

export interface ReplicaTagForm {
  raw: string
  weight: number
  count: number
}
export interface ReplicaTag {
  key: string
  /** 出现最多的原始写法 */
  raw: string
  /** 出现的图片数（同一张图重复只算一次） */
  count: number
  ratio: number
  forms: ReplicaTagForm[]
  /** 出现的图片序号 */
  images: number[]
  /** 有多少张图的这个 Tag 在 (a, b:1.2) 这样的组合里（删除时只移除这个 Tag，组合中其他 Tag 保留） */
  grouped: number
}

/** 组合内的子 Tag 可能带自己的权重写法：(a:1.2, b) */
const subTag = (s: string) => s.replace(/:\s*-?\d+(?:\.\d+)?\s*$/, '')
/** 组合内单个 Tag 的比较键（统计与替换使用同一个规则） */
const atomKey = (s: string) => parseToken(subTag(s))?.key ?? null

/** 表达式中的单个 Tag：权重括号逐层展开，组合按逗号拆开；weight 为有效权重。只有一个 Tag 时不是组合 */
export function tagLeaves(raw: string, weight = 1): { key: string; text: string; weight: number }[] {
  const p = peelWeight(raw)
  if (p) return tagLeaves(p.body, weight * p.weight)
  const { segments } = topLevelSegments(raw)
  if (segments.length > 1) return segments.flatMap((x) => tagLeaves(x.raw, weight))
  const t = parseToken(subTag(raw))
  return t ? [{ key: t.key, text: t.core, weight: Math.round(weight * t.weight * 1000) / 1000 }] : []
}

/** 没有被拆开的部分（动态语法等）中出现的选中 Tag：宽松查找，只用于要求手动确认 */
function looseKeys(raw: string): string[] {
  return raw
    .replace(/\\[()[\]{}]/g, ' ')
    .split(/[()[\]{}|:,，\n]/)
    .filter((x) => x.trim() && !/^\s*-?\d+(?:\.\d+)?\s*$/.test(x))
    .map((x) => parseToken(x)?.key)
    .filter((k): k is string => !!k)
}

interface ExprEdit {
  text: string
  parts: ReplacePart[]
  removed: string[]
}

/** 从一个表达式中移除选中的 Tag：保留括号与显式权重，全部移除时返回空文本 */
function editExpr(s: string, keys: Set<string>): ExprEdit {
  const keep: ExprEdit = { text: s, parts: [{ kind: 'keep', text: s }], removed: [] }
  const p = peelWeight(s)
  if (p) {
    const r = editExpr(p.body, keys)
    if (!r.removed.length) return keep
    if (!r.text.trim()) return { text: '', parts: [{ kind: 'remove', text: s.trim() }], removed: r.removed }
    // 外层括号与权重原样保留，只改括号内的内容
    const lead = s.slice(0, s.indexOf(p.open) + 1)
    const tail = p.suffix + p.close + s.slice(s.lastIndexOf(p.close) + 1)
    return { text: lead + r.text + tail, parts: [{ kind: 'keep', text: lead }, ...r.parts, { kind: 'keep', text: tail }], removed: r.removed }
  }
  const { segments } = topLevelSegments(s)
  if (segments.length > 1) {
    const parts: ReplacePart[] = []
    const removed: string[] = []
    let out = ''
    let cursor = 0
    let wrote = false
    for (const seg of segments) {
      const between = s.slice(cursor, seg.start)
      cursor = seg.end
      const r = editExpr(seg.raw, keys)
      removed.push(...r.removed)
      if (!r.text) {
        parts.push(...r.parts)
        continue
      }
      // 前面的 Tag 被移除时，它后面的分隔符随之移除
      const sep = wrote || seg === segments[0] ? between : ''
      if (sep) parts.push({ kind: 'sep', text: sep })
      out += sep + r.text
      parts.push(...r.parts)
      wrote = true
    }
    const tail = s.slice(cursor)
    if (wrote && tail) {
      parts.push({ kind: 'sep', text: tail })
      out += tail
    }
    return { text: wrote ? out : '', parts, removed }
  }
  const k = atomKey(s)
  if (k && keys.has(k)) return { text: '', parts: [{ kind: 'remove', text: s.trim() }], removed: [s.trim()] }
  return keep
}

export function tagStats(images: { positive: string }[]): ReplicaTag[] {
  const map = new Map<string, { forms: Map<string, ReplicaTagForm>; images: Set<number>; grouped: Set<number> }>()
  const hit = (key: string, raw: string, weight: number, i: number, grouped: boolean) => {
    const e = map.get(key) ?? { forms: new Map(), images: new Set<number>(), grouped: new Set<number>() }
    const f = e.forms.get(raw) ?? { raw, weight, count: 0 }
    f.count++
    e.forms.set(raw, f)
    e.images.add(i)
    if (grouped) e.grouped.add(i)
    map.set(key, e)
  }
  images.forEach((im, i) => {
    for (const part of splitTopLevel(im.positive ?? '')) {
      const t = parseToken(part)
      if (!t) continue
      const leaves = tagLeaves(part)
      // 组合中的每个 Tag 单独统计，写法记录原始表达式
      if (leaves.length > 1) for (const l of leaves) hit(l.key, part, l.weight, i, true)
      else hit(t.key, t.raw, t.weight, i, false)
    }
  })
  const total = images.length || 1
  return [...map.entries()]
    .map(([key, e]) => {
      const forms = [...e.forms.values()].sort((a, b) => b.count - a.count)
      return { key, raw: forms[0].raw, count: e.images.size, ratio: e.images.size / total, forms, images: [...e.images].sort((a, b) => a - b), grouped: e.grouped.size }
    })
    .sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1))
}

// ---------------- 替换

export interface ReplacePart {
  kind: 'keep' | 'remove' | 'add' | 'sep'
  text: string
}
export interface ReplaceResult {
  text: string
  /** unsafe：括号不配对，不做替换；group：选中的 Tag 在无法安全拆开的表达式里（动态语法等），没有移除 */
  status: 'ok' | 'unsafe' | 'group'
  removed: string[]
  /** 留在无法拆开的表达式里、没有移除的 Tag */
  grouped: string[]
  parts: ReplacePart[]
}

const cleanInsert = (s: string) => String(s ?? '').trim().replace(/^[,，\s]+|[,，\s]+$/g, '')

/**
 * 替换选中的 Tag：第一个选中 Tag 的位置放入角色 Prompt（作为整体），其余选中的 Tag 与它前面的分隔符一起移除。
 * 选中的 Tag 在组合里时只移除它，组合保留其余 Tag；第一个选中 Tag 在仍然保留的组合里时，角色 Prompt 放在这个组合前面。
 * 没有选中的 Tag 和它前面的分隔符（逗号、换行、BREAK）逐字节保留。这张图没有选中的 Tag 时，角色 Prompt 放在最前面。
 */
export function applyTagReplacement(text: string, removed: Iterable<string>, insert = ''): ReplaceResult {
  const keys = new Set(removed)
  const src = String(text ?? '')
  const add = cleanInsert(insert)
  const { segments, balanced } = topLevelSegments(src)
  if (!balanced) return { text: src, status: 'unsafe', removed: [], grouped: [], parts: [{ kind: 'keep', text: src }] }
  const parts: ReplacePart[] = []
  const hits: string[] = []
  const grouped: string[] = []
  let out = ''
  let cursor = 0
  let inserted = false
  let wrote = false
  const write = (kind: ReplacePart['kind'], s: string) => {
    if (s) parts.push({ kind, text: s })
    if (kind !== 'remove') out += s
  }
  for (const seg of segments) {
    const between = src.slice(cursor, seg.start)
    cursor = seg.end
    const t = parseToken(seg.raw)
    if (t && keys.has(t.key)) {
      hits.push(seg.raw)
      if (!inserted && add) {
        write('sep', between)
        write('remove', seg.raw)
        write('add', add)
        inserted = true
        wrote = true
      } else {
        parts.push({ kind: 'remove', text: seg.raw })
      }
      continue
    }
    if (t && tagLeaves(seg.raw).length > 1) {
      const r = editExpr(seg.raw, keys)
      if (r.removed.length) {
        hits.push(...r.removed)
        if (!r.text) {
          // 组合中的 Tag 全部选中：整个表达式移除，与单个 Tag 相同
          if (!inserted && add) {
            write('sep', between)
            parts.push(...r.parts)
            write('add', add)
            inserted = true
            wrote = true
          } else parts.push(...r.parts)
          continue
        }
        write('sep', wrote || seg === segments[0] ? between : '')
        if (!inserted && add) {
          write('add', add)
          write('sep', ', ')
          inserted = true
        }
        for (const p of r.parts) write(p.kind, p.text)
        grouped.push(...looseKeys(r.text).filter((k) => keys.has(k)))
        wrote = true
        continue
      }
    }
    if (t) grouped.push(...looseKeys(seg.raw).filter((k) => keys.has(k)))
    // 第一个写出的内容之前只保留开头的文本（前面的 Tag 已被移除时，分隔符随之移除）
    write('sep', wrote || !segments.length || seg === segments[0] ? between : '')
    write('keep', seg.raw)
    wrote = true
  }
  const tail = src.slice(cursor)
  if (add && !inserted) {
    const body = out
    const parts2 = [...parts]
    parts.length = 0
    out = ''
    write('add', add)
    if (body.trim()) write('sep', ', ')
    out += body
    parts.push(...parts2)
    wrote = true
  }
  // 结尾文本：如果全部内容都被移除，不留下多余的分隔符
  write('sep', wrote ? tail : '')
  return { text: out, status: grouped.length ? 'group' : 'ok', removed: hits, grouped: [...new Set(grouped)], parts }
}

export type NegativeMode = 'append' | 'keep' | 'replace'
export function mergeNegative(original: string, character: string, mode: NegativeMode): string {
  const a = String(original ?? '')
  const b = cleanInsert(character)
  if (mode === 'keep') return a
  if (mode === 'replace') return b
  if (!b) return a
  return a.trim() ? `${a.replace(/[,，\s]+$/, '')}, ${b}` : b
}

// ---------------- 草稿

export interface ReplicaImage {
  path: string
  name: string
  status: 'ok' | 'check' | 'error'
  positive: string
  negative: string
  source: PromptSource | null
  notes: string[]
  error?: string
  params: RecoveredParams
  loras: ImageLora[]
  /** 读取结果需要确认时可手动选择的来源（已读取成功的图片不保存） */
  candidates: Pick<PromptCandidate, 'key' | 'label' | 'text' | 'role'>[]
  /** 用户确认了读取结果（status 为 check 时才需要） */
  confirmed: boolean
  exclude: boolean
  /** 用户直接编辑的最终 Prompt（最高优先级，不再做替换） */
  manual_positive: string | null
  manual_negative: string | null
  /** 这张图手动指定的参数 */
  overrides: Partial<Record<ParamKey, number | string>>
  /** 这张图使用的服装：没有这个字段时使用草稿的默认服装；null 为不使用服装。按图片保存，删除或重新排序图片时不会错位 */
  outfit_id?: number | null
}

export interface ReplicaData {
  images: ReplicaImage[]
  /** 要删除的 Tag（比较键） */
  removed_tags: string[]
  character_id: number | null
  outfit_id: number | null
  negative_mode: NegativeMode
  workflow_id: number | null
  /** 本草稿对工作流 LoRA 的配置（替换、保留）；结构与任务的 LoRA 配置相同 */
  lora_config: WfLoraConfig | null
  /** 角色 LoRA：是否加载、改用的 LoRA 与权重 */
  lora: { enabled: boolean; name: string | null; resource_id: string | null; strength: number | null }
  /** 关闭 Prompt 路径上的 TriggerWord Toggle（触发词由角色 Prompt 负责） */
  disable_triggers: boolean
  keep: { seed: boolean; size: boolean; sampling: boolean }
  /** 也使用「需要确认」的参数 */
  accept_uncertain: boolean
  output: { dir: string }
}

export interface ReplicaRecord {
  id?: number
  name?: string
  data?: Partial<ReplicaData>
  sort?: number
}

const num = (v: unknown, dflt: number | null = null) => (typeof v === 'number' && Number.isFinite(v) ? v : dflt)
const text = (v: unknown) => (typeof v === 'string' ? v : '')

export function normalizeReplicaImage(raw: Partial<ReplicaImage>): ReplicaImage {
  const r = raw ?? {}
  const overrides: ReplicaImage['overrides'] = {}
  for (const k of PARAM_KEYS) {
    const v = (r.overrides as Record<string, unknown> | undefined)?.[k]
    if ((typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v)) overrides[k] = v
  }
  return {
    path: text(r.path),
    name: text(r.name),
    status: r.status === 'ok' || r.status === 'check' ? r.status : 'error',
    positive: text(r.positive),
    negative: text(r.negative),
    source: r.source ?? null,
    notes: Array.isArray(r.notes) ? r.notes.map(String) : [],
    ...(r.error ? { error: String(r.error) } : {}),
    params: r.params && typeof r.params === 'object' ? r.params : {},
    loras: Array.isArray(r.loras) ? r.loras : [],
    candidates: Array.isArray(r.candidates) ? r.candidates : [],
    confirmed: r.confirmed === true,
    exclude: r.exclude === true,
    manual_positive: typeof r.manual_positive === 'string' ? r.manual_positive : null,
    manual_negative: typeof r.manual_negative === 'string' ? r.manual_negative : null,
    overrides,
    ...(r.outfit_id === null || (typeof r.outfit_id === 'number' && Number.isSafeInteger(r.outfit_id)) ? { outfit_id: r.outfit_id } : {}),
  }
}

/** 这张图实际使用的服装 ID：没有单独指定时使用默认服装 */
export const imageOutfitId = (im: Pick<ReplicaImage, 'outfit_id'>, fallback: number | null) => (im.outfit_id === undefined ? fallback : im.outfit_id)

/** 去掉单独指定的服装（恢复为默认服装） */
export const withoutOutfit = (im: ReplicaImage): ReplicaImage => {
  if (im.outfit_id === undefined) return im
  const { outfit_id: _drop, ...rest } = im
  return rest
}

/**
 * 给图 from..to（从 1 开始，包含两端）指定服装：value 为服装 ID，null 为不使用服装，undefined 为恢复默认。
 * 结果写在每张图上，之后删除或重新排序图片不会错位。范围不合法时返回错误说明，不修改。
 */
export function assignOutfit(images: ReplicaImage[], from: number, to: number, value: number | null | undefined): { images: ReplicaImage[]; error: string } {
  const n = images.length
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to > n || from > to) return { images, error: `请输入 1 到 ${n} 之间的图片编号，起始不大于结束` }
  return { images: images.map((im, i) => (i + 1 < from || i + 1 > to ? im : value === undefined ? withoutOutfit(im) : { ...im, outfit_id: value })), error: '' }
}

/** 连续使用同一服装设置的图片（显示用，下标从 0 开始） */
export function outfitRuns(images: ReplicaImage[]): { a: number; b: number; value: number | null | undefined; excluded: number }[] {
  const runs: { a: number; b: number; value: number | null | undefined; excluded: number }[] = []
  images.forEach((im, i) => {
    const last = runs.at(-1)
    if (last && last.value === im.outfit_id) {
      last.b = i
      if (im.exclude) last.excluded++
    } else runs.push({ a: i, b: i, value: im.outfit_id, excluded: im.exclude ? 1 : 0 })
  })
  return runs
}

export function normalizeReplicaData(raw: Partial<ReplicaData> | null | undefined): ReplicaData {
  const r = raw ?? {}
  const keep = r.keep ?? ({} as Partial<ReplicaData['keep']>)
  const lora = r.lora ?? ({} as Partial<ReplicaData['lora']>)
  return {
    images: Array.isArray(r.images) ? r.images.map(normalizeReplicaImage) : [],
    removed_tags: Array.isArray(r.removed_tags) ? [...new Set(r.removed_tags.map(String).map(normalizeKey))].filter(Boolean) : [],
    character_id: num(r.character_id),
    outfit_id: num(r.outfit_id),
    negative_mode: r.negative_mode === 'keep' || r.negative_mode === 'replace' ? r.negative_mode : 'append',
    workflow_id: num(r.workflow_id),
    lora_config: r.lora_config && typeof r.lora_config === 'object' ? r.lora_config : null,
    lora: { enabled: lora.enabled !== false, name: lora.name ? String(lora.name) : null, resource_id: lora.resource_id ? String(lora.resource_id) : null, strength: num(lora.strength) },
    disable_triggers: r.disable_triggers !== false,
    keep: { seed: keep.seed !== false, size: keep.size !== false, sampling: keep.sampling !== false },
    accept_uncertain: r.accept_uncertain === true,
    output: { dir: text(r.output?.dir) },
  }
}

/** 一张图用于替换的原始 Prompt（图片读取失败时为空） */
export const originalPositive = (im: ReplicaImage) => (im.status === 'error' && !im.confirmed ? '' : im.positive)

// ---------------- 参数写入

export interface ParamTarget {
  node: string
  input: string
}
export type ParamTargets = Partial<Record<ParamKey, ParamTarget | { mapped: true } | null>>

/** 第一次采样可以写入的输入：字面值，或只有它使用的基础节点；已被映射、覆盖或绕过的不写 */
export function replicaTargets(api: ApiWorkflow, mapping: MappingEntry[], controls: WorkflowControls): ParamTargets {
  const has = (s: string) => mapping.some((m) => m.source === s)
  const out: ParamTargets = { seed: has('seed') ? { mapped: true } : null, width: has('width') ? { mapped: true } : null, height: has('height') ? { mapped: true } : null }
  const all = samplersOfGraph(api)
  const firsts = all.filter((s) => s.first)
  const only = firsts.length === 1 ? firsts[0] : all.length === 1 ? all[0] : null
  const gone = new Set(controls.bypass.map((b) => b.node))
  for (const key of ['steps', 'cfg', 'sampler', 'scheduler', 'denoise'] as const) {
    out[key] = null
    if (!only) continue
    for (const nid of samplingNodes(api, only.id)) {
      const input = INPUT_OF[key].find((f) => f in (api[nid]?.inputs ?? {}))
      if (!input || gone.has(nid)) continue
      const v = api[nid].inputs[input]
      let target: ParamTarget | null = { node: nid, input }
      if (isLink(v)) {
        const up = String(v[0])
        const upInputs = Object.entries(api[up]?.inputs ?? {})
        const field = upInputs.length === 1 && !isLink(upInputs[0][1]) ? upInputs[0][0] : null
        target = field && !gone.has(up) && consumersOf(api, up).length === 1 ? { node: up, input: field } : null
      }
      if (target && inputControl(api, mapping, controls, target.node, target.input).state === 'original') out[key] = target
      break
    }
  }
  return out
}

export interface ParamRow {
  key: ParamKey
  value: number | string | null
  state: RecoverState | 'unmapped'
  /** 这个值实际写入工作流 */
  applied: boolean
  note?: string
}

const groupOf = (k: ParamKey): keyof ReplicaData['keep'] => (k === 'seed' ? 'seed' : k === 'width' || k === 'height' ? 'size' : 'sampling')

/** 决定一张图每个参数的去向。只有读取可靠（或用户接受 / 手动指定）并且当前工作流能写入的值才算「保留」 */
export function paramPlan(im: ReplicaImage, targets: ParamTargets, api: ApiWorkflow, data: Pick<ReplicaData, 'keep' | 'accept_uncertain'>): { rows: ParamRow[]; seed: number | null; width: number | null; height: number | null; inputs: InputValue[] } {
  const rows: ParamRow[] = []
  const inputs: InputValue[] = []
  const direct: Partial<Record<ParamKey, number>> = {}
  for (const key of PARAM_KEYS) {
    const manual = im.overrides[key]
    const rec = manual !== undefined ? { value: manual, state: 'ok' as const, note: '手动指定' } : (im.params[key] ?? missing())
    const t = targets[key]
    const row: ParamRow = { key, value: rec.value, state: rec.state, applied: false, ...(rec.note ? { note: rec.note } : {}) }
    rows.push(row)
    if (rec.value === null) continue
    if (!t) {
      row.state = 'unmapped'
      continue
    }
    if (manual === undefined && (!data.keep[groupOf(key)] || (rec.state === 'confirm' && !data.accept_uncertain))) continue
    if ('mapped' in t) {
      if (typeof rec.value === 'number') {
        direct[key] = rec.value
        row.applied = true
      }
      continue
    }
    const orig = api[t.node]?.inputs?.[t.input]
    if (!isLink(orig) && literalKind(orig) !== typeof rec.value) {
      row.state = 'unmapped'
      row.note = '工作流中这个输入的类型不同'
      continue
    }
    inputs.push({ node: t.node, input: t.input, source: REPLICA_PARAM, value: rec.value })
    row.applied = true
  }
  // 只有一个方向能写入时不写尺寸（避免得到错误的比例）
  if ((direct.width === undefined) !== (direct.height === undefined)) {
    delete direct.width
    delete direct.height
    for (const r of rows) if (r.key === 'width' || r.key === 'height') r.applied = false
  }
  return { rows, seed: direct.seed ?? null, width: direct.width ?? null, height: direct.height ?? null, inputs }
}

/** 没有可用 Seed 时的固定值：由文件路径决定，预览与入队一致 */
export function stableSeed(path: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** 输出文件名（不含扩展名）：与原图相同；不同文件夹中同名的图片加序号，避免互相混淆 */
export function outputStems(images: Pick<ReplicaImage, 'name'>[]): string[] {
  const seen = new Map<string, number>()
  return images.map((im) => {
    const stem = (im.name.replace(/\.[^.]+$/, '') || 'image').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    const n = (seen.get(stem.toLowerCase()) ?? 0) + 1
    seen.set(stem.toLowerCase(), n)
    return n > 1 ? `${stem} (${n})` : stem
  })
}

