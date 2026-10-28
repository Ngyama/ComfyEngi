// 从 PNG 文本元数据中找出正向 Prompt。
// ComfyUI 保存的 prompt 是 API 格式的整个工作流：从采样器的 positive 输入沿连线向上追踪到文本编码节点，
// 再解析文本输入（字面值或上游文本节点）。负向同样追踪，用来检查同一文本是否同时连到正负两侧。
// 不把所有 CLIPTextEncode 的文本拼在一起：未连接到采样器的文本节点不会被读取。
// 无法可靠区分时标记为「需要确认」，不会静默混入负面 Prompt。

export type PromptSource = 'comfy-api' | 'comfy-workflow' | 'a1111'

export interface ExtractedPrompt {
  status: 'ok' | 'check' | 'error'
  positive: string
  negative: string
  source: PromptSource | null
  notes: string[]
  error?: string
}

type Node = { class_type: string; inputs: Record<string, unknown> }
type Graph = Record<string, Node>
type Link = [string, number]

const isLink = (v: unknown): v is Link => Array.isArray(v) && v.length === 2 && (typeof v[0] === 'string' || typeof v[0] === 'number') && typeof v[1] === 'number'
const linkOf = (v: unknown): Link | null => (isLink(v) ? [String(v[0]), v[1]] : null)

/** 文本编码节点中承载 Prompt 的字段（按顺序；SDXL 的 text_g / text_l 相同时只取一次） */
const ENCODER_TEXT = ['text', 'text_g', 'text_l', 'prompt']
/** 上游文本节点中可能保存字符串的字段 */
const STRING_FIELDS = ['populated_text', 'text', 'string', 'value', 'prompt', 'String', 'Text', 'STRING', 'wildcard_text']
const DELIM_FIELDS = ['delimiter', 'separator', 'delim']
const MAX_DEPTH = 64

class Unsupported extends Error {}

function isEncoder(n: Node): boolean {
  if (/TextEncode|CLIPText/i.test(n.class_type)) return true
  return 'clip' in n.inputs && ENCODER_TEXT.some((f) => f in n.inputs)
}

/** 解析文本输入：字面值直接返回；连线则读取上游文本节点（含常见的文本拼接节点、Reroute） */
function resolveText(g: Graph, v: unknown, notes: Set<string>, depth = 0): string {
  if (typeof v === 'string') return v
  const l = linkOf(v)
  if (!l) throw new Unsupported('文本输入既不是文字也不是连线')
  if (depth > MAX_DEPTH) throw new Unsupported('文本节点连接层级过深')
  const n = g[l[0]]
  if (!n) throw new Unsupported(`文本来自不存在的节点 #${l[0]}`)
  const inputs = n.inputs ?? {}
  for (const f of STRING_FIELDS) if (typeof inputs[f] === 'string') return inputs[f] as string
  if (/concat|join|combine/i.test(n.class_type)) {
    const delim = DELIM_FIELDS.map((f) => inputs[f]).find((x) => typeof x === 'string') as string | undefined
    const parts: string[] = []
    for (const [k, x] of Object.entries(inputs)) {
      if (DELIM_FIELDS.includes(k) || typeof x === 'boolean' || typeof x === 'number') continue
      if (typeof x === 'string' || isLink(x)) parts.push(resolveText(g, x, notes, depth + 1))
    }
    notes.add(`正向 Prompt 由文本拼接节点 #${l[0]}（${n.class_type}）合成`)
    return parts.filter((p) => p.trim()).join(delim ?? ', ')
  }
  // Reroute 等只有一个连线输入的转接节点
  const links = Object.values(inputs).filter(isLink)
  if (links.length === 1 && Object.keys(inputs).length === 1) return resolveText(g, links[0], notes, depth + 1)
  for (const f of STRING_FIELDS) if (isLink(inputs[f])) return resolveText(g, inputs[f], notes, depth + 1)
  throw new Unsupported(`文本来自无法识别的节点 #${l[0]}（${n.class_type}）`)
}

/** 从 conditioning 连线向上追踪，返回参与的文本编码节点及其文本（按出现顺序） */
function traceConditioning(g: Graph, link: Link, notes: Set<string>, out: { node: string; text: string }[], seen: Set<string>, depth = 0) {
  if (depth > MAX_DEPTH) throw new Unsupported('conditioning 连接层级过深')
  const [id, slot] = link
  const key = `${id}:${slot}`
  if (seen.has(key)) return
  seen.add(key)
  const n = g[id]
  if (!n || typeof n !== 'object') throw new Unsupported(`conditioning 来自不存在的节点 #${id}`)
  const inputs = n.inputs ?? {}
  if (isEncoder(n)) {
    const texts: string[] = []
    for (const f of ENCODER_TEXT) {
      if (!(f in inputs)) continue
      const t = resolveText(g, inputs[f], notes)
      if (!texts.includes(t)) texts.push(t)
    }
    if (!texts.length) throw new Unsupported(`文本编码节点 #${id}（${n.class_type}）没有文本输入`)
    out.push({ node: id, text: texts.filter((t) => t.trim()).join(',\n') })
    return
  }
  // ControlNetApplyAdvanced 等同时有 positive / negative 输入的节点：输出 0 为正向，1 为负向
  if (isLink(inputs.positive) && isLink(inputs.negative)) {
    traceConditioning(g, linkOf(slot === 1 ? inputs.negative : inputs.positive)!, notes, out, seen, depth + 1)
    return
  }
  const conds = Object.entries(inputs).filter(([k, v]) => isLink(v) && /^cond|conditioning/i.test(k))
  if (!conds.length) {
    const links = Object.values(inputs).filter(isLink)
    // Reroute
    if (links.length === 1 && Object.keys(inputs).length === 1) return traceConditioning(g, linkOf(links[0])!, notes, out, seen, depth + 1)
    throw new Unsupported(`正向 conditioning 来自无法识别的节点 #${id}（${n.class_type}）`)
  }
  for (const [, v] of conds) traceConditioning(g, linkOf(v)!, notes, out, seen, depth + 1)
}

interface SamplerPrompt {
  id: string
  positive: string
  negative: string
  posNodes: string[]
  negNodes: string[]
  firstPass: boolean
}

const byId = (a: string, b: string) => (Number(a) - Number(b)) || (a < b ? -1 : a > b ? 1 : 0)

/** 采样器的 latent_image 是否直接来自空 Latent（没有图像 / latent 输入的生成节点）——两阶段工作流的第一阶段 */
function isFirstPass(g: Graph, n: Node): boolean {
  const l = linkOf(n.inputs.latent_image)
  if (!l) return false
  const src = g[l[0]]
  if (!src) return false
  return !Object.entries(src.inputs ?? {}).some(([k, v]) => isLink(v) && /latent|image|samples|pixels/i.test(k))
}

export function promptFromApiGraph(graph: unknown): ExtractedPrompt {
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) return fail('prompt 元数据不是 API 格式工作流')
  const g = graph as Graph
  const ids = Object.keys(g).filter((id) => g[id] && typeof g[id] === 'object' && typeof g[id].class_type === 'string' && g[id].inputs && typeof g[id].inputs === 'object').sort(byId)
  if (!ids.length) return fail('prompt 元数据中没有节点')
  const withBoth = ids.filter((id) => isLink(g[id].inputs.positive) && isLink(g[id].inputs.negative))
  // 优先选择真正的采样器（带 latent_image），其次是 CFGGuider 等带 model 的引导节点
  let samplers = withBoth.filter((id) => 'latent_image' in g[id].inputs)
  if (!samplers.length) samplers = withBoth.filter((id) => 'model' in g[id].inputs)
  const positiveOnly = !samplers.length ? ids.filter((id) => /Guider/i.test(g[id].class_type) && isLink(g[id].inputs.conditioning)) : []
  if (!samplers.length && !positiveOnly.length) return fail('没有找到连接正向 Prompt 的采样器节点（可能是不支持的自定义节点）')
  const notes = new Set<string>()
  const results: SamplerPrompt[] = []
  try {
    for (const id of samplers) {
      const pos: { node: string; text: string }[] = []
      const neg: { node: string; text: string }[] = []
      traceConditioning(g, linkOf(g[id].inputs.positive)!, notes, pos, new Set())
      try {
        traceConditioning(g, linkOf(g[id].inputs.negative)!, notes, neg, new Set())
      } catch {
        // 负向无法解析不影响读取正向（只用于冲突检查）
      }
      results.push({ id, positive: joinTexts(pos), negative: joinTexts(neg), posNodes: pos.map((x) => x.node), negNodes: neg.map((x) => x.node), firstPass: isFirstPass(g, g[id]) })
    }
    for (const id of positiveOnly) {
      const pos: { node: string; text: string }[] = []
      traceConditioning(g, linkOf(g[id].inputs.conditioning)!, notes, pos, new Set())
      results.push({ id, positive: joinTexts(pos), negative: '', posNodes: pos.map((x) => x.node), negNodes: [], firstPass: true })
    }
  } catch (e) {
    if (e instanceof Unsupported) return fail(e.message)
    throw e
  }
  return choose(results, [...notes], 'comfy-api')
}

const joinTexts = (parts: { text: string }[]) => parts.map((p) => p.text).filter((t) => t.trim()).join(',\n')

function choose(results: SamplerPrompt[], notes: string[], source: PromptSource): ExtractedPrompt {
  let status: ExtractedPrompt['status'] = 'ok'
  const distinct = [...new Set(results.map((r) => r.positive))]
  let pick = results[0]
  if (distinct.length > 1) {
    const first = results.filter((r) => r.firstPass)
    if (first.length && new Set(first.map((r) => r.positive)).size === 1) {
      pick = first[0]
      notes.push(`检测到 ${results.length} 个采样器使用不同的正向 Prompt，已采用第一阶段采样器 #${pick.id} 的内容`)
    } else {
      status = 'check'
      notes.push(`检测到 ${results.length} 个采样器使用不同的正向 Prompt，无法确定主采样器，已暂用 #${pick.id} 的内容`)
    }
  } else if (results.length > 1) notes.push(`${results.length} 个采样器使用相同的正向 Prompt`)
  const negNodes = new Set(results.flatMap((r) => r.negNodes))
  const shared = pick.posNodes.filter((n) => negNodes.has(n))
  if (shared.length) {
    status = 'check'
    notes.push(`文本节点 #${shared.join('、#')} 同时连接到正向和负向，无法区分正负 Prompt`)
  }
  if (!pick.positive.trim()) return { ...fail('正向 Prompt 为空'), source, notes }
  if (pick.negative.trim() && pick.negative.trim() === pick.positive.trim()) {
    status = 'check'
    notes.push('正向与负向 Prompt 内容相同')
  }
  return { status, positive: pick.positive, negative: pick.negative, source, notes }
}

const fail = (error: string): ExtractedPrompt => ({ status: 'error', positive: '', negative: '', source: null, notes: [], error })

/**
 * 界面格式的工作流（workflow 元数据，只在缺少 prompt 元数据时使用）：转换为近似的 API 图后同样追踪。
 * 只能可靠读取原生文本编码节点（第一个文字控件即文本）与 Reroute / 字符串常量节点。
 */
export function promptFromUiWorkflow(wf: unknown): ExtractedPrompt {
  const w = wf as { nodes?: unknown; links?: unknown }
  if (!w || typeof w !== 'object' || !Array.isArray(w.nodes) || !Array.isArray(w.links)) return fail('workflow 元数据格式无法识别')
  const linkMap = new Map<number, Link>()
  for (const l of w.links as unknown[]) if (Array.isArray(l) && l.length >= 5) linkMap.set(Number(l[0]), [String(l[1]), Number(l[2])])
  const g: Graph = {}
  for (const raw of w.nodes as unknown[]) {
    const n = raw as { id?: unknown; type?: unknown; inputs?: unknown; widgets_values?: unknown; mode?: unknown }
    if (!n || typeof n.type !== 'string' || n.id == null) continue
    if (n.mode === 2 || n.mode === 4) continue // 已静音 / 绕过的节点
    const inputs: Record<string, unknown> = {}
    for (const i of Array.isArray(n.inputs) ? (n.inputs as { name?: unknown; link?: unknown }[]) : []) {
      if (typeof i?.name === 'string' && typeof i.link === 'number' && linkMap.has(i.link)) inputs[i.name] = linkMap.get(i.link)
    }
    const widgets = Array.isArray(n.widgets_values) ? n.widgets_values : []
    const firstString = widgets.find((x) => typeof x === 'string')
    if (/TextEncode|CLIPText/i.test(n.type) && !('text' in inputs) && typeof firstString === 'string') inputs.text = firstString
    else if (/^(PrimitiveNode|PrimitiveString.*|String.*|Text.*)$/i.test(n.type) && typeof firstString === 'string' && !Object.keys(inputs).length) inputs.value = firstString
    if (/^KSampler/i.test(n.type) && !('latent_image' in inputs)) inputs.latent_image = null
    g[String(n.id)] = { class_type: n.type, inputs }
  }
  const r = promptFromApiGraph(g)
  return r.status === 'error' ? r : { ...r, source: 'comfy-workflow', notes: ['只从界面格式工作流读取（PNG 中没有 prompt 元数据）', ...r.notes] }
}

/** A1111 / Forge 等 WebUI 的 parameters 文本：Negative prompt: 之前为正向 */
export function promptFromParameters(text: string): ExtractedPrompt {
  const lines = String(text ?? '').split(/\r?\n/)
  const negAt = lines.findIndex((l) => l.startsWith('Negative prompt:'))
  const stepsAt = lines.findIndex((l) => /^Steps: \d+/.test(l))
  const posEnd = negAt >= 0 ? negAt : stepsAt >= 0 ? stepsAt : lines.length
  const positive = lines.slice(0, posEnd).join('\n').trim()
  const negative = negAt >= 0 ? [lines[negAt].slice('Negative prompt:'.length), ...lines.slice(negAt + 1, stepsAt > negAt ? stepsAt : lines.length)].join('\n').trim() : ''
  if (!positive) return fail('parameters 中没有正向 Prompt')
  return { status: 'ok', positive, negative, source: 'a1111', notes: [] }
}

/** 按优先级读取：ComfyUI prompt（API 图）→ ComfyUI workflow（界面格式）→ WebUI parameters */
export function extractPrompt(chunks: Record<string, string>): ExtractedPrompt {
  const errors: string[] = []
  const parseJson = (k: string) => {
    try {
      return JSON.parse(chunks[k])
    } catch {
      errors.push(`${k} 元数据不是有效的 JSON`)
      return undefined
    }
  }
  if (typeof chunks.prompt === 'string') {
    const g = parseJson('prompt')
    if (g !== undefined) {
      const r = promptFromApiGraph(g)
      if (r.status !== 'error') return r
      errors.push(r.error!)
    }
  }
  if (typeof chunks.workflow === 'string') {
    const w = parseJson('workflow')
    if (w !== undefined) {
      const r = promptFromUiWorkflow(w)
      if (r.status !== 'error') return r
      errors.push(r.error!)
    }
  }
  if (typeof chunks.parameters === 'string') {
    const r = promptFromParameters(chunks.parameters)
    if (r.status !== 'error') return r
    errors.push(r.error!)
  }
  if (!errors.length) return fail('没有找到生成参数（PNG 中没有 prompt / workflow / parameters 元数据）')
  return fail([...new Set(errors)].join('；'))
}
