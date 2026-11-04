// 套图复刻：草稿数据模型（含旧版草稿迁移）、从原图元数据读取尺寸等参数（参数只作参考与尺寸来源）、Tag 统计与删除。
// 删除只移除选中的 Tag，其余文本逐字节保留（不去重、不重排、不改权重）。
// 选择单位是单个 Tag：(a, b:1.2)、((a, b))、[a, b] 这样的组合会逐层展开，只移除选中的子 Tag，保留括号与权重写法，
// 因此其余 Tag 的有效权重不变。动态语法（{a|b}、[a:b:0.5]）不拆开，选中的 Tag 在其中时要求手动编辑。
// 识别保留片段的规则见 replica-recognize.ts。

import { findLoraLoaders, isLink, loraStem } from './mapping'
import { consumersOf } from './node-controls'
import { parseJsonLoose, samplersOfGraph, type PromptCandidate, type PromptSource } from './prompt-source'
import { normalizeKey, parseToken, peelWeight, splitTopLevel, topLevelSegments } from './tags'
import type { ApiWorkflow, LoraOverride } from './types'
import type { WfLoraConfig } from './lora-config'
import type { ImageRecognition, TagSummary } from './replica-recognize'

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

// ---------------- 草稿（v2）
// 复刻 = 导入一套成品图，保留每张图的 Prompt 片段（镜头及之后的内容，去掉旧角色 / 服装 Tag）、尺寸与顺序，
// 再用新的工作流、角色、服装、LoRA 配置、全局 / 画风 Prompt 与场景 Prompt 整套重新生成。
// 不继承原图的工作流、LoRA 与权重、Seed、Steps、CFG、Sampler、Scheduler、Denoise 等生成参数。

export const REPLICA_VERSION = 2
export const MAX_REPEAT = 999

export interface ReplicaImage {
  path: string
  name: string
  status: 'ok' | 'check' | 'error'
  /** 原图的正向 / 负面 Prompt（读取结果；用户可以在第 1 步修正读取错误） */
  positive: string
  negative: string
  source: PromptSource | null
  notes: string[]
  error?: string
  /** 读取到的原图参数：只使用其中的尺寸，其余只作参考，不写入工作流 */
  params: RecoveredParams
  /** 原图使用的 LoRA：只作参考 */
  loras: ImageLora[]
  /** 读取结果需要确认时可手动选择的来源（已读取成功的图片不保存） */
  candidates: Pick<PromptCandidate, 'key' | 'label' | 'text' | 'role'>[]
  /** 用户确认了读取结果（status 为 check 时才需要） */
  confirmed: boolean
  exclude: boolean
  /** 这张图使用的服装：没有这个字段时使用草稿的默认服装；null 为不使用服装。按图片保存，删除或重新排序图片时不会错位 */
  outfit_id?: number | null
  /** 手动指定的保留起点（第一个保留的顶层 Tag 的序号）；null 为自动（第一个镜头 Tag） */
  cut: number | null
  /** 这张图单独的 Tag 修正（比较键 → 删除 / 保留），优先于整套的分类 */
  tag_fix: Record<string, 'remove' | 'keep'>
  /** 手动填写的保留片段（最高优先级，不再自动删除） */
  retained_manual: string | null
  /** 用户确认过的识别结果（确认时的保留片段）：识别结果之后变化时需要重新确认 */
  accepted: string | null
  /** 手动指定的尺寸；null 为原图尺寸 */
  size: { width: number; height: number } | null
  /** 这张图的生成次数；null 为整套设置 */
  repeat: number | null
  /** 旧版草稿中无法转换的内容（只读保存，不参与生成） */
  legacy?: { manual_positive?: string; manual_negative?: string; overrides?: Record<string, unknown> }
}

export interface ReplicaData {
  version: typeof REPLICA_VERSION
  images: ReplicaImage[]
  /** 整套的 Tag 分类修正（比较键 → character / outfit 删除，keep 保留） */
  tag_fix: Record<string, 'character' | 'outfit' | 'keep'>
  /** 手动指定的共同前缀（Tag 文本，逗号分隔）；null 为自动识别 */
  prefix_text: string | null
  workflow_id: number | null
  character_id: number | null
  outfit_id: number | null
  /** 新的全局 / 画风 Prompt：素材库中的全局模板 + 附加文本 */
  global_id: number | null
  global_text: string
  /** 新的场景 Prompt：素材库中的场景模板 + 附加文本 */
  scene_id: number | null
  scene_text: string
  /** 负面 Prompt 是否保留原图的负面（追加在新的负面内容中） */
  keep_source_negative: boolean
  /** 关闭 Prompt 路径上的 TriggerWord Toggle（触发词由角色 Prompt 负责） */
  disable_triggers: boolean
  /** LoRA：与套图任务相同的结构。角色 LoRA 的调整、按工作流保存的 LoRA 配置（工作流中已有的 LoRA 是默认值） */
  lora_overrides: Record<string, LoraOverride>
  lora_configs: Record<string, WfLoraConfig>
  /** 每张图默认生成几次（每张图可以单独设置） */
  repeat: number
  /** set：先完整生成第 1 套再生成第 2 套；image：每张图连续生成 */
  repeat_order: 'set' | 'image'
  /** 采样 Seed 的起点（第 n 个单元使用 seed_base + n），与原图 Seed 无关 */
  seed_base: number
  output: { dir: string }
  /** 由旧版草稿迁移：迁移说明与旧版设置的原始值（只读保存） */
  legacy?: { from: 1; notes: string[]; v1: Record<string, unknown> }
}

export interface ReplicaRecord {
  id?: number
  name?: string
  data?: Partial<ReplicaData>
  sort?: number
}

const num = (v: unknown, dflt: number | null = null) => (typeof v === 'number' && Number.isFinite(v) ? v : dflt)
const text = (v: unknown) => (typeof v === 'string' ? v : '')
const posInt = (v: unknown, max: number) => (typeof v === 'number' && Number.isInteger(v) && v >= 1 ? Math.min(v, max) : null)
const fixMap = <T extends string>(v: unknown, allowed: readonly T[]): Record<string, T> => {
  const out: Record<string, T> = {}
  if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k, x] of Object.entries(v)) if ((allowed as readonly string[]).includes(x as string) && normalizeKey(k)) out[normalizeKey(k)] = x as T
  return out
}
const sizeOf = (v: unknown): ReplicaImage['size'] => {
  const s = v as { width?: unknown; height?: unknown } | null
  return s && typeof s === 'object' && posInt(s.width, 16384) && posInt(s.height, 16384) ? { width: s.width as number, height: s.height as number } : null
}

export function normalizeReplicaImage(raw: Partial<ReplicaImage>): ReplicaImage {
  const r = raw ?? {}
  const legacy = r.legacy && typeof r.legacy === 'object' ? r.legacy : undefined
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
    ...(r.outfit_id === null || (typeof r.outfit_id === 'number' && Number.isSafeInteger(r.outfit_id)) ? { outfit_id: r.outfit_id } : {}),
    cut: typeof r.cut === 'number' && Number.isInteger(r.cut) && r.cut >= 0 ? r.cut : null,
    tag_fix: fixMap(r.tag_fix, ['remove', 'keep'] as const),
    retained_manual: typeof r.retained_manual === 'string' ? r.retained_manual : null,
    accepted: typeof r.accepted === 'string' ? r.accepted : null,
    size: sizeOf(r.size),
    repeat: posInt(r.repeat, MAX_REPEAT),
    ...(legacy ? { legacy } : {}),
  }
}

/** 由内容决定的固定值（旧草稿迁移时的 Seed 起点）：同一份草稿每次读取结果相同，预览与入队一致 */
export function stableSeed(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export interface NormalizeOptions {
  /** 旧版草稿没有选择工作流时使用的默认工作流（用于迁移它的 LoRA 配置） */
  defaultWorkflowId?: number | null
}

/** 读取草稿：v2 直接规范化；旧版（没有 version）迁移为 v2，迁移说明与旧版设置的原始值保存在 legacy 中，不会静默丢弃 */
export function normalizeReplicaData(raw: Partial<ReplicaData> | null | undefined, opts: NormalizeOptions = {}): ReplicaData {
  const r = (raw ?? {}) as Record<string, unknown>
  const isOld = !!raw && r.version !== REPLICA_VERSION && Object.keys(r).length > 0
  if (isOld) return migrateV1(r, opts)
  const images = Array.isArray(r.images) ? (r.images as Partial<ReplicaImage>[]).map(normalizeReplicaImage) : []
  const legacy = r.legacy && typeof r.legacy === 'object' ? (r.legacy as ReplicaData['legacy']) : undefined
  return {
    version: REPLICA_VERSION,
    images,
    tag_fix: fixMap(r.tag_fix, ['character', 'outfit', 'keep'] as const),
    prefix_text: typeof r.prefix_text === 'string' ? r.prefix_text : null,
    workflow_id: num(r.workflow_id),
    character_id: num(r.character_id),
    outfit_id: num(r.outfit_id),
    global_id: num(r.global_id),
    global_text: text(r.global_text),
    scene_id: num(r.scene_id),
    scene_text: text(r.scene_text),
    keep_source_negative: r.keep_source_negative === true,
    disable_triggers: r.disable_triggers !== false,
    lora_overrides: r.lora_overrides && typeof r.lora_overrides === 'object' ? (r.lora_overrides as ReplicaData['lora_overrides']) : {},
    lora_configs: r.lora_configs && typeof r.lora_configs === 'object' ? (r.lora_configs as ReplicaData['lora_configs']) : {},
    repeat: posInt(r.repeat, MAX_REPEAT) ?? 1,
    repeat_order: r.repeat_order === 'image' ? 'image' : 'set',
    seed_base: typeof r.seed_base === 'number' && Number.isSafeInteger(r.seed_base) && r.seed_base >= 0 ? r.seed_base : stableSeed(images.map((im) => im.path).join('\n')),
    output: { dir: text((r.output as { dir?: unknown } | undefined)?.dir) },
    ...(legacy ? { legacy } : {}),
  }
}

/** 旧版草稿（v1：替换选中的 Tag + 保留原图参数）→ v2 */
function migrateV1(r: Record<string, unknown>, opts: NormalizeOptions): ReplicaData {
  const notes: string[] = []
  const { images: rawImages, ...v1 } = r
  let manualCount = 0
  const images = (Array.isArray(rawImages) ? rawImages : []).map((x) => {
    const old = (x ?? {}) as Record<string, unknown>
    const im = normalizeReplicaImage(old as Partial<ReplicaImage>)
    const legacy: NonNullable<ReplicaImage['legacy']> = {}
    if (typeof old.manual_positive === 'string') legacy.manual_positive = old.manual_positive
    if (typeof old.manual_negative === 'string') legacy.manual_negative = old.manual_negative
    const ov = old.overrides && typeof old.overrides === 'object' ? (old.overrides as Record<string, unknown>) : {}
    // 手动指定的尺寸仍然有效（新版保留每张图的尺寸）；其他手动参数不再使用
    const size = sizeOf({ width: ov.width, height: ov.height })
    if (size) im.size = size
    const rest = Object.fromEntries(Object.entries(ov).filter(([k]) => k !== 'width' && k !== 'height'))
    if (Object.keys(rest).length) legacy.overrides = rest
    if (legacy.manual_positive !== undefined) manualCount++
    return Object.keys(legacy).length ? { ...im, legacy } : im
  })
  const removed = Array.isArray(r.removed_tags) ? [...new Set(r.removed_tags.map(String).map(normalizeKey))].filter(Boolean) : []
  const tag_fix: ReplicaData['tag_fix'] = {}
  for (const k of removed) tag_fix[k] = 'character'
  if (removed.length) notes.push(`旧版选中删除的 ${removed.length} 个 Tag 已迁移为「删除」（显示在角色 Tag 中），可以在第 2 步调整`)
  const workflow_id = num(r.workflow_id)
  const lora_configs: ReplicaData['lora_configs'] = {}
  const oldCfg = r.lora_config && typeof r.lora_config === 'object' ? (r.lora_config as WfLoraConfig) : null
  const cfgWf = workflow_id ?? opts.defaultWorkflowId ?? null
  if (oldCfg && cfgWf !== null) lora_configs[String(cfgWf)] = oldCfg
  else if (oldCfg) notes.push('旧版草稿的 LoRA 配置针对「默认工作流」，但现在没有默认工作流，无法确定属于哪个工作流，没有迁移：请在第 3 步重新配置 LoRA')
  const lora = (r.lora ?? {}) as { enabled?: unknown; name?: unknown; resource_id?: unknown; strength?: unknown }
  const lora_overrides: ReplicaData['lora_overrides'] = {}
  const strength = num(lora.strength)
  if (lora.enabled === false) {
    lora_overrides.lora1 = { enabled: false }
    notes.push('旧版关闭了新角色 LoRA：已迁移为停用角色的第 1 个 LoRA（角色有多个 LoRA 时，其余的会正常加载，请在第 3 步检查）')
  } else if (lora.name) {
    lora_overrides.lora1 = { enabled: true, name: String(lora.name), ...(lora.resource_id ? { resource_id: String(lora.resource_id) } : {}), ...(strength !== null ? { strength_model: strength, strength_clip: strength } : {}) }
    notes.push(`旧版改用的角色 LoRA「${String(lora.name)}」已迁移为角色 LoRA 的调整`)
  } else if (strength !== null) lora_overrides.lora1 = { enabled: true, strength_model: strength, strength_clip: strength }
  const keep = (r.keep ?? {}) as { seed?: unknown; size?: unknown; sampling?: unknown }
  if (keep.seed !== false || keep.sampling !== false) notes.push('旧版会保留原图的 Seed 与采样参数（Steps、CFG、Sampler、Scheduler、Denoise）：新版不再继承这些参数，改用新工作流自己的设置与新的 Seed；每张图的尺寸仍按原图')
  if (keep.size === false) notes.push('旧版关闭了「保留尺寸」：新版按原图尺寸生成，可以在第 2 步逐张修改')
  const mode = r.negative_mode
  if (mode === 'keep') notes.push('旧版负面 Prompt 只使用原图负面：新版改为「新的负面 + 原图负面」')
  if (manualCount) notes.push(`${manualCount} 张图在旧版中手动编辑过最终 Prompt（其中包含旧版插入的角色 Prompt），无法自动拆成保留片段：原文保存在图片的「旧版手动 Prompt」中，这些图片需要在第 2 步重新确认`)
  return {
    version: REPLICA_VERSION,
    images,
    tag_fix,
    prefix_text: null,
    workflow_id,
    character_id: num(r.character_id),
    outfit_id: num(r.outfit_id),
    global_id: null,
    global_text: '',
    scene_id: null,
    scene_text: '',
    keep_source_negative: mode !== 'replace',
    disable_triggers: r.disable_triggers !== false,
    lora_overrides,
    lora_configs,
    repeat: 1,
    repeat_order: 'set',
    seed_base: stableSeed(images.map((im) => im.path).join('\n')),
    output: { dir: text((r.output as { dir?: unknown } | undefined)?.dir) },
    legacy: { from: 1, notes, v1 },
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

/** 一张图的 Prompt 是否可用（读取成功，或用户确认 / 修正过） */
export const promptUsable = (im: ReplicaImage) => im.status === 'ok' || im.confirmed

/** 一张图用于识别的原始 Prompt（图片读取失败时为空） */
export const originalPositive = (im: ReplicaImage) => (promptUsable(im) ? im.positive : '')

export interface ImageSize {
  width: number | null
  height: number | null
  /** manual：手动指定；ok：元数据中的生成尺寸；confirm：只有图片实际尺寸（可能经过放大）；missing：使用工作流默认尺寸 */
  state: 'manual' | 'ok' | 'confirm' | 'missing'
  note?: string
}

/** 每张图保留的尺寸：手动指定 > 元数据中的生成尺寸 > 图片实际尺寸（需要确认） */
export function imageSize(im: ReplicaImage): ImageSize {
  if (im.size) return { ...im.size, state: 'manual' }
  const w = im.params.width
  const h = im.params.height
  if (typeof w?.value === 'number' && typeof h?.value === 'number') {
    const state = w.state === 'ok' && h.state === 'ok' ? 'ok' : 'confirm'
    return { width: w.value, height: h.value, state, ...(state === 'confirm' ? { note: w.note || h.note || '尺寸需要确认' } : {}) }
  }
  return { width: null, height: null, state: 'missing', note: '原图没有尺寸信息，使用工作流默认尺寸' }
}

/** 这张图的生成次数 */
export const repeatOf = (im: Pick<ReplicaImage, 'repeat'>, data: Pick<ReplicaData, 'repeat'>) => im.repeat ?? data.repeat

/**
 * 展开为生成顺序：counts[i] 为第 i 张图的次数。set：第 1 轮按原顺序生成每张图，再第 2 轮……；image：每张图连续生成。
 * 返回每个单元对应的图片序号与第几次（从 0 开始）。
 */
export function expandOrder(counts: number[], order: ReplicaData['repeat_order']): { image: number; variant: number }[] {
  const out: { image: number; variant: number }[] = []
  if (order === 'image') {
    counts.forEach((c, image) => {
      for (let v = 0; v < c; v++) out.push({ image, variant: v })
    })
    return out
  }
  const rounds = Math.max(0, ...counts)
  for (let v = 0; v < rounds; v++) counts.forEach((c, image) => v < c && out.push({ image, variant: v }))
  return out
}

/** 输出文件名（不含扩展名）：与原图相同；生成多次时加 _v01、_v02……区分 */
export const variantStem = (stem: string, variant: number, of: number) => (of > 1 ? `${stem}_v${String(variant + 1).padStart(Math.max(2, String(of).length), '0')}` : stem)

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

// ---------------- 计划（主进程计算，界面显示）

/** 这张图的状态：valid 可以生成；confirm 需要用户处理（读取或识别不可靠）；invalid 没有 Prompt；missing 原图不在原位置；excluded 用户排除 */
export type RowState = 'valid' | 'confirm' | 'invalid' | 'missing' | 'excluded'
export interface ReplicaRow {
  index: number
  path: string
  name: string
  state: RowState
  reason: string
  /** 识别不可靠的全部原因 */
  issues: string[]
  original_positive: string
  original_negative: string
  /** 被替换的开头、保留起点与判断方式 */
  prefix: string
  cut: number
  cut_reason: ImageRecognition['cut_reason']
  /** 从保留部分删除的旧角色 / 服装 Tag 与其他内容（LoRA 文字、单张手动删除） */
  removed_character: string[]
  removed_outfit: string[]
  removed_other: string[]
  retained: string
  retained_parts: ReplacePart[]
  /** 保留片段是手动填写的 */
  manual: boolean
  /** 最终 Prompt（每个变体相同；与写入工作流的内容相同） */
  positive: string
  negative: string
  /** 最终 Prompt 按来源分段（显示用，拼接结果就是 positive） */
  positive_parts: { module: string; text: string }[]
  size: ImageSize
  repeat: number
  outfit: string
  outfit_source: 'default' | 'image'
  /** 第一个变体的输出文件名（不含扩展名） */
  output_name: string
  /** 这张图的单元在队列中的序号（每个变体一个） */
  units: number[]
}
export interface ReplicaUnitBrief {
  index: number
  image: number
  variant: number
  of: number
  seed: number
  output_name: string
}
export interface ReplicaPlanCore {
  units: unknown
  rows: ReplicaRow[]
  output_dir: string
  unit_list: ReplicaUnitBrief[]
  summary: {
    character: { name: string; positive: string; negative: string } | null
    outfit: { name: string; positive: string } | null
    global: { name: string; positive: string } | null
    scene: { name: string; positive: string } | null
    /** 角色 LoRA（含本草稿的调整） */
    loras: { name: string; strength: number; clip: number; enabled: boolean }[]
    images: number
    valid: number
    repeat: number
    seed_mapped: boolean
    size_mapped: boolean
  }
  recognition: { prefix_raw: string; prefix_auto: boolean; prefix_matches: number; usable: number; character: TagSummary[]; outfit: TagSummary[]; kept: TagSummary[] }
}

