// 从图片文本元数据中找出正向 Prompt。
// 优先读取可直接得到的字段；ComfyUI 保存的 prompt 是 API 格式的整个工作流：从采样器的 positive 输入沿连线向上追踪
// 到文本编码节点，再解析文本输入（字面值或上游文本节点）。负向同样追踪，用来检查同一文本是否同时连到正负两侧。
// 不把所有 CLIPTextEncode 的文本拼在一起：未连接到采样器的文本节点不会被读取。
// 无法可靠区分时标记为「需要确认」，不会静默混入负面 Prompt；PNG 中没有保存最终文本时报告原因，不猜测。
// 同时列出所有可选的文本来源（候选），自动识别失败时可以手动指定，并按「节点类型 + 字段」把选择应用到同批图片。

export type PromptSource = 'comfy-api' | 'comfy-workflow' | 'a1111' | 'novelai' | 'invokeai' | 'fooocus' | 'swarmui' | 'easydiffusion' | 'manual'

/**
 * 来源规则（手动选择后应用到其他图片，也可以保存为持久规则）：
 * - field：读取同名元数据字段（parameters、Comment 等，与工作流无关）；
 * - node：同类型节点（class_type）的同名字段，不要求其他节点和连线一致。
 *   同一图片中有多个同类型节点时，依次用连接方向（正向 / 负向）、节点标题、局部连接结构、节点 ID 区分，仍无法区分时视为歧义；
 *   strictId 时只匹配指定 ID 的节点，并同时校验类型与字段。
 */
export interface SourceRule {
  kind: 'field' | 'node'
  /** field：候选键；node：class_type + 字段 */
  key: string
  label: string
  classType?: string
  field?: string
  nodeId?: string
  title?: string
  /** 局部连接结构指纹（只用于区分同一图片中的多个同类型节点） */
  fp?: string
  /** 选择时该节点在工作流中的连接方向 */
  role?: CandidateRole
  strictId?: boolean
  /** 兼容旧版本的结构签名（已不再要求一致） */
  structure?: string
}

export type CandidateRole = 'positive' | 'negative' | 'unused' | 'unknown'

/** 一个可以作为正向 Prompt 的文本来源 */
export interface PromptCandidate {
  /** 在同一张图片内唯一 */
  key: string
  label: string
  text: string
  /** 在工作流中的连接位置：连到正向 / 负向 / 未连接到采样器 / 无法判断 */
  role: CandidateRole
  rule: SourceRule
  /** 提醒：通配符模板、仍含通配符语法等（这类文本不是可靠的最终 Prompt） */
  warn?: string
}

export interface ExtractedPrompt {
  status: 'ok' | 'check' | 'error'
  positive: string
  negative: string
  source: PromptSource | null
  notes: string[]
  error?: string
  /** 可手动选择的文本来源 */
  candidates: PromptCandidate[]
  /** 工作流结构签名（ComfyUI 图，仅供参考） */
  structure?: string
  /** 工作流中每个节点的类型（用于严格按节点 ID 匹配时校验类型） */
  nodeTypes?: Record<string, string>
  /** 没有完整追踪到采样器，而是由已知节点（通配符节点保存的展开后文本）识别；优先级低于用户保存的来源规则 */
  fallback?: boolean
}

type Node = { class_type: string; inputs: Record<string, unknown>; bypass?: boolean; _meta?: { title?: unknown } }
type Graph = Record<string, Node>
type Link = [string, number]
type Role = 'positive' | 'negative'
type Piece = { node: string; text: string }

const isLink = (v: unknown): v is Link => Array.isArray(v) && v.length === 2 && (typeof v[0] === 'string' || typeof v[0] === 'number') && typeof v[1] === 'number'
const linkOf = (v: unknown): Link | null => (isLink(v) ? [String(v[0]), v[1]] : null)

/** 文本编码节点中承载 Prompt 的字段（按顺序；SDXL 的 text_g / text_l、Flux 的 clip_l / t5xxl 相同时只取一次） */
const ENCODER_TEXT = ['text', 'text_g', 'text_l', 'prompt', 'populated_text', 'clip_l', 't5xxl']
/** 上游文本节点中可能保存字符串的字段（populated_text 是通配符展开后的最终文本，优先于模板） */
const STRING_FIELDS = ['populated_text', 'text', 'string', 'value', 'prompt', 'String', 'Text', 'STRING']
const DELIM_FIELDS = ['delimiter', 'separator', 'delim']
const MAX_DEPTH = 64
export const CANDIDATE_LIMITS = { maxCandidates: 60, maxText: 64 * 1024 }

class Unsupported extends Error {}
/** 运行时生成的 LoRA 触发词：拼接时可以省略，不影响其余已保存的文本 */
class TriggerWords extends Unsupported {}

/** LoRA 加载 / 触发词节点（LoraManager 等）：text 字段是 LoRA 语法，输出的触发词在运行时生成 */
const TRIGGER = /TriggerWord|Trigger ?Words?|Lora ?Loader|LoRA Text Loader|Lora ?Stack/i
/** 通配符语法：__name__、{a|b}；Impact 运行时会对 populated_text 再展开一次 */
const WILDCARD_SYNTAX = /__[\w.\-+/*\\]+?__|\{[^{}]*\|[^{}]*\}/
/** 与 Impact Pack 相同的注释处理：以 # 开头的行被去掉，下一行接到上一行末尾 */
export function impactCommentOut(text: string): string {
  const out: string[] = []
  let flag = false
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('#')) {
      flag = true
      continue
    }
    if (!out.length) out.push(line)
    else if (flag) {
      out[out.length - 1] += ` ${line}`
      flag = false
    } else out.push(line)
  }
  return out.join('\n')
}

/** 运行时生成文本、PNG 中不保存结果的节点（动态 Prompt、随机通配符、LLM、图像反推） */
const DYNAMIC = /^DP[A-Z]|Dynamic ?Prompt|Random ?Prompt|Wildcard|Magic ?Prompt|Ollama|LLM|GPT|Gemini|Florence|Tagger|WD14|Interrogat|Caption/i
const encoderClass = (ct: string) => /TextEncode|CLIPText|PromptEncode|Encode.*(Text|Prompt)|WildcardEncode/i.test(ct)
const hasCondLinks = (n: Node) => Object.entries(n.inputs).some(([k, v]) => isLink(v) && /^cond|conditioning|pipe/i.test(k))
const textFieldsOf = (n: Node) => ENCODER_TEXT.filter((f) => f in n.inputs && (typeof n.inputs[f] === 'string' || isLink(n.inputs[f])))
const isWildcard = (n: Node) => 'wildcard_text' in n.inputs && 'populated_text' in n.inputs

/** 把文本转换为 conditioning 的节点（原生编码节点，以及有文本字段、没有 conditioning 输入的自定义节点） */
function isEncoder(n: Node): boolean {
  if (TRIGGER.test(n.class_type)) return false
  if (encoderClass(n.class_type)) return textFieldsOf(n).length > 0 || isWildcard(n)
  if (('positive' in n.inputs && 'negative' in n.inputs) || hasCondLinks(n)) return false
  return textFieldsOf(n).length > 0 && Object.keys(n.inputs).some((k) => /clip/i.test(k) && isLink(n.inputs[k]))
}

/** 输出字符串的节点（字符串常量、拼接、风格、通配符） */
function isTextSource(n: Node): boolean {
  if (TRIGGER.test(n.class_type)) return true
  if (isEncoder(n) || hasCondLinks(n) || ('positive' in n.inputs && 'negative' in n.inputs)) return false
  return isWildcard(n) || 'text_positive' in n.inputs || /concat|join|append/i.test(n.class_type) || STRING_FIELDS.some((f) => typeof n.inputs[f] === 'string' || isLink(n.inputs[f]))
}

/** 拼接节点中参与拼接的输入（排除分隔符和 clean_whitespace 之类的选项） */
const isConcatPart = (k: string, v: unknown) => !DELIM_FIELDS.includes(k) && (isLink(v) || (typeof v === 'string' && /text|string|str|prompt|input|^[a-z]$|_[a-z0-9]$|\d$/i.test(k)))

class Tracer {
  notes = new Set<string>()
  /** 需要用户确认的原因 */
  doubts = new Set<string>()
  visited = new Set<string>()
  constructor(readonly g: Graph) {}

  node(id: string): Node {
    const n = this.g[id]
    if (!n) throw new Unsupported(`连线指向不存在的节点 #${id}（可能已被静音或删除）`)
    this.visited.add(id)
    return n
  }

  /** 解析文本输入：字面值直接返回；连线则读取上游文本节点（含常见的文本拼接节点、Reroute） */
  text(v: unknown, depth = 0): string {
    if (typeof v === 'string') return v
    const l = linkOf(v)
    if (!l) throw new Unsupported('文本输入既不是文字也不是连线')
    if (depth > MAX_DEPTH) throw new Unsupported('文本节点连接层级过深')
    const [id, slot] = l
    const n = this.node(id)
    const inputs = n.inputs
    const ct = n.class_type
    if (n.bypass) return this.passthrough(id, n, (x) => this.text(x, depth + 1))
    if (TRIGGER.test(ct)) throw new TriggerWords(`文本来自 LoRA 触发词节点 #${id}（${ct}）：触发词在运行时生成，PNG 中没有保存`)
    // Prompt 风格节点：输出 0 为正向、1 为负向；风格模板内容不保存在元数据中
    if ('text_positive' in inputs && 'text_negative' in inputs) {
      this.doubts.add(`正向 Prompt 经过 Prompt 风格节点 #${id}（${ct}），最终文本可能还包含风格模板的内容`)
      return this.text(slot === 1 ? inputs.text_negative : inputs.text_positive, depth + 1)
    }
    if (isWildcard(n)) return this.wildcard(id, n)
    if (DYNAMIC.test(ct)) throw new Unsupported(`Prompt 来自运行时生成文本的节点 #${id}（${ct}）：PNG 中只保存了模板或设置，没有保存生成的最终文本，无法准确恢复`)
    for (const f of STRING_FIELDS) if (typeof inputs[f] === 'string') return inputs[f] as string
    if (/concat|join|combine|append/i.test(ct)) {
      const delim = DELIM_FIELDS.map((f) => inputs[f]).find((x) => typeof x === 'string') as string | undefined
      const parts: string[] = []
      for (const [k, x] of Object.entries(inputs)) {
        if (!isConcatPart(k, x)) continue
        try {
          parts.push(this.text(x, depth + 1))
        } catch (e) {
          // LoRA 触发词在运行时生成：省略这一段，其余已保存的文本照常拼接
          if (!(e instanceof TriggerWords)) throw e
          this.notes.add(`${e.message.replace(/：.*$/, '')}的触发词未包含在结果中（运行时生成，PNG 中没有保存）`)
        }
      }
      this.notes.add(`Prompt 由文本拼接节点 #${id}（${ct}）合成`)
      return parts.filter((p) => p.trim()).join(delim ?? ', ')
    }
    const links = Object.values(inputs).filter(isLink)
    if (links.length === 1 && Object.keys(inputs).length === 1) return this.text(links[0], depth + 1)
    for (const f of STRING_FIELDS) if (isLink(inputs[f])) return this.text(inputs[f], depth + 1)
    throw new Unsupported(`文本来自无法识别的节点 #${id}（${ct}）：PNG 中只保存了它的设置，没有保存它输出的最终文本`)
  }

  wildcard(id: string, n: Node): string {
    const t = n.inputs.populated_text
    if (typeof t === 'string' && t.trim()) {
      this.notes.add(`采用通配符节点 #${id}（${n.class_type}）保存的展开后文本（populated_text）`)
      const w = wildcardWarn(t)
      if (w) this.doubts.add(`通配符节点 #${id} 的 ${w}`)
      return impactCommentOut(t)
    }
    if (isLink(t)) return this.text(t)
    throw new Unsupported(`通配符节点 #${id}（${n.class_type}）没有保存展开后的文本（PNG 中只有通配符模板），无法准确恢复正向 Prompt`)
  }

  /** 被绕过的节点（界面格式工作流）：输出直接等于同类型的输入 */
  passthrough<T>(id: string, n: Node, next: (v: unknown) => T): T {
    const links = Object.entries(n.inputs).filter(([, v]) => isLink(v))
    const pick = links.find(([k]) => /^cond|conditioning|positive|text|string/i.test(k)) ?? (links.length === 1 ? links[0] : null)
    if (!pick) throw new Unsupported(`Prompt 经过已绕过的节点 #${id}（${n.class_type}），无法确定传递的输入`)
    return next(pick[1])
  }

  /** 从 conditioning 连线向上追踪，收集参与的文本编码节点及其文本（按出现顺序） */
  cond(link: Link, role: Role, out: Piece[], seen: Set<string>, depth = 0): void {
    if (depth > MAX_DEPTH) throw new Unsupported('conditioning 连接层级过深')
    const [id, slot] = link
    const key = `${id}:${slot}`
    if (seen.has(key)) return
    seen.add(key)
    const n = this.node(id)
    const inputs = n.inputs
    const side = role === 'positive' ? '正向' : '负向'
    if (/ZeroOut/i.test(n.class_type)) return // 置零的 conditioning：没有文本
    if (n.bypass && !('positive' in inputs && 'negative' in inputs)) return this.passthrough(id, n, (x) => this.cond(linkOf(x)!, role, out, seen, depth + 1))
    if (isEncoder(n)) {
      const texts: string[] = []
      if (Object.entries(inputs).some(([k, v]) => /^trigger_?words/i.test(k) && isLink(v))) this.notes.add(`编码节点 #${id}（${n.class_type}）在运行时加入的触发词未包含在结果中`)
      for (const f of textFieldsOf(n)) {
        const t = f === 'populated_text' || isWildcard(n) ? this.wildcard(id, n) : this.text(inputs[f])
        if (!texts.includes(t)) texts.push(t)
      }
      out.push({ node: id, text: texts.filter((t) => t.trim()).join(',\n') })
      return
    }
    // 同时有 positive / negative 输入的节点：ControlNet 等（连线）按输出槽区分，加载器类（文字）按追踪方向
    if ('positive' in inputs && 'negative' in inputs) {
      const both = isLink(inputs.positive) && isLink(inputs.negative)
      const field: Role = both && (slot === 0 || slot === 1) && !/loader|pipe/i.test(n.class_type) ? (slot === 1 ? 'negative' : 'positive') : role
      const v = inputs[field]
      if (typeof v === 'string') {
        this.notes.add(`${side} Prompt 来自节点 #${id}（${n.class_type}）的 ${field} 输入`)
        out.push({ node: `${id}.${field}`, text: v })
        return
      }
      if (isLink(v)) {
        // 上游可能是 conditioning，也可能是字符串节点
        const up = this.g[String(v[0])]
        if (up && isTextSource(up)) out.push({ node: `${id}.${field}`, text: this.text(v) })
        else this.cond(linkOf(v)!, role, out, seen, depth + 1)
        return
      }
    }
    const conds = Object.entries(inputs).filter(([k, v]) => isLink(v) && /^cond|conditioning/i.test(k))
    if (conds.length) {
      for (const [, v] of conds) this.cond(linkOf(v)!, role, out, seen, depth + 1)
      return
    }
    // ttN / Easy-Use 等管道（pipe）：向上找到保存 positive / negative 的加载节点
    const pipe = Object.entries(inputs).find(([k, v]) => isLink(v) && /pipe/i.test(k))
    if (pipe) return this.cond(linkOf(pipe[1])!, role, out, seen, depth + 1)
    const links = Object.values(inputs).filter(isLink)
    if (links.length === 1 && Object.keys(inputs).length === 1) return this.cond(linkOf(links[0])!, role, out, seen, depth + 1)
    throw new Unsupported(`${side} Prompt 来自无法识别的节点 #${id}（${n.class_type}）：PNG 中没有保存这个节点生成的文本`)
  }
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
  if (!l) return n.inputs.latent_image === null
  const src = g[l[0]]
  if (!src) return false
  return !Object.entries(src.inputs ?? {}).some(([k, v]) => isLink(v) && /latent|image|samples|pixels/i.test(k))
}

/** 使用该引导节点（CFGGuider 等）的采样器 */
const guiderUsers = (g: Graph, ids: string[], gid: string) => ids.filter((id) => Object.values(g[id].inputs).some((v) => isLink(v) && String(v[0]) === gid) && 'latent_image' in g[id].inputs)

function findSamplers(g: Graph, ids: string[]) {
  const withBoth = ids.filter((id) => isLink(g[id].inputs.positive) && isLink(g[id].inputs.negative))
  // 主采样器：带 latent_image 的采样器，以及被这类采样器使用的引导节点；其次是只带 model 的节点（FaceDetailer 等）
  let samplers = withBoth.filter((id) => 'latent_image' in g[id].inputs || guiderUsers(g, ids, id).length)
  if (!samplers.length) samplers = withBoth.filter((id) => 'model' in g[id].inputs)
  const first = (id: string) => ('latent_image' in g[id].inputs ? isFirstPass(g, g[id]) : guiderUsers(g, ids, id).some((u) => isFirstPass(g, g[u])))
  const positiveOnly = !samplers.length ? ids.filter((id) => /Guider/i.test(g[id].class_type) && isLink(g[id].inputs.conditioning)) : []
  // 管道采样器（ttN / Easy-Use）：只有 pipe 输入
  const pipes = !samplers.length && !positiveOnly.length ? ids.filter((id) => /sampler/i.test(g[id].class_type) && Object.entries(g[id].inputs).some(([k, v]) => isLink(v) && /pipe/i.test(k))) : []
  return { samplers, positiveOnly, pipes, first }
}

const validGraph = (graph: unknown): graph is Graph => !!graph && typeof graph === 'object' && !Array.isArray(graph)
const nodeIds = (g: Graph) => Object.keys(g).filter((id) => g[id] && typeof g[id] === 'object' && typeof g[id].class_type === 'string' && g[id].inputs && typeof g[id].inputs === 'object').sort(byId)

export function promptFromApiGraph(graph: unknown, source: PromptSource = 'comfy-api'): ExtractedPrompt {
  if (!validGraph(graph)) return fail('prompt 元数据不是 API 格式工作流')
  const ids = nodeIds(graph)
  if (!ids.length) return fail('prompt 元数据中没有节点')
  const g: Graph = Object.fromEntries(ids.map((id) => [id, graph[id]]))
  const shape = graphShape(g, source)
  const t = new Tracer(g)
  const { samplers, positiveOnly, pipes, first } = findSamplers(g, ids)
  const posSet = new Set<string>()
  const negSet = new Set<string>()
  const withRole = (set: Set<string>, f: () => void) => {
    t.visited = new Set()
    try {
      f()
    } finally {
      for (const v of t.visited) set.add(v)
    }
  }
  const results: SamplerPrompt[] = []
  let error: string | null = null
  if (!samplers.length && !positiveOnly.length && !pipes.length) error = '没有找到连接正向 Prompt 的采样器节点（可能是不支持的自定义采样节点）'
  try {
    for (const id of [...samplers, ...pipes]) {
      const isPipe = pipes.includes(id)
      const pos: Piece[] = []
      const neg: Piece[] = []
      const start = (role: Role) => (isPipe ? linkOf(Object.entries(g[id].inputs).find(([k, v]) => isLink(v) && /pipe/i.test(k))![1])! : linkOf(g[id].inputs[role])!)
      // 先追踪负向：即使正向无法解析，候选文本也能标出哪些连到负向
      try {
        withRole(negSet, () => t.cond(start('negative'), 'negative', neg, new Set()))
      } catch {
        // 负向无法解析不影响读取正向（只用于冲突检查）
      }
      withRole(posSet, () => t.cond(start('positive'), 'positive', pos, new Set()))
      results.push({ id, positive: joinTexts(pos), negative: joinTexts(neg), posNodes: pos.map((x) => x.node), negNodes: neg.map((x) => x.node), firstPass: isPipe || first(id) })
    }
    for (const id of positiveOnly) {
      const pos: Piece[] = []
      withRole(posSet, () => t.cond(linkOf(g[id].inputs.conditioning)!, 'positive', pos, new Set()))
      results.push({ id, positive: joinTexts(pos), negative: '', posNodes: pos.map((x) => x.node), negNodes: [], firstPass: true })
    }
  } catch (e) {
    if (!(e instanceof Unsupported)) throw e
    error = e.message
  }
  // 连线可达性（不需要理解节点含义）：追踪中途失败时，仍能判断上游节点连到正向还是负向
  const posUp = new Set<string>()
  const negUp = new Set<string>()
  for (const id of [...samplers, ...pipes]) {
    if (pipes.includes(id)) continue
    upstream(g, linkOf(g[id].inputs.positive)?.[0], posUp)
    upstream(g, linkOf(g[id].inputs.negative)?.[0], negUp)
  }
  for (const id of positiveOnly) upstream(g, linkOf(g[id].inputs.conditioning)?.[0], posUp)
  for (const id of posUp) if (!negUp.has(id) && !negSet.has(id)) posSet.add(id)
  for (const id of negUp) if (!posUp.has(id) && !posSet.has(id)) negSet.add(id)
  const candidates = graphCandidates(g, shape, posSet, negSet)
  if (error) {
    const fb = knownNodeFallback(g, posSet, negSet, error, source)
    return { ...(fb ?? fail(error)), candidates, structure: shape.structure, nodeTypes: nodeTypesOf(g) }
  }
  const r = choose(results, [...t.notes], source)
  if (r.status === 'ok' && t.doubts.size) {
    r.status = 'check'
    r.notes.push(...t.doubts)
  }
  return { ...r, candidates, structure: shape.structure, nodeTypes: nodeTypesOf(g) }
}

/** 从某个节点沿输入连线向上能到达的所有节点 */
function upstream(g: Graph, start: string | undefined, out: Set<string>) {
  const stack = start ? [start] : []
  while (stack.length) {
    const id = stack.pop()!
    if (out.has(id) || !g[id]) continue
    out.add(id)
    for (const v of Object.values(g[id].inputs)) if (isLink(v)) stack.push(String(v[0]))
  }
}

const nodeTypesOf = (g: Graph) => Object.fromEntries(Object.entries(g).map(([id, n]) => [id, n.class_type]))

/** populated_text 不是可靠最终文本的原因 */
function wildcardWarn(t: string): string | null {
  return WILDCARD_SYNTAX.test(impactCommentOut(t)) ? 'populated_text 中仍有通配符语法，运行时会再次随机展开，最终文本可能不同' : null
}

/**
 * 已知节点的专用识别：采样器追踪失败（例如中途经过 LoRA 触发词节点）时，
 * 如果正向链路上有通配符节点（ImpactWildcardProcessor / ImpactWildcardEncode）保存了展开后的文本，采用它。
 * 只连到负向的不采用；无法确认连接方向时标记为需要确认。
 */
function knownNodeFallback(g: Graph, posSet: Set<string>, negSet: Set<string>, error: string, source: PromptSource): ExtractedPrompt | null {
  const saved = Object.keys(g)
    .sort(byId)
    .filter((id) => isWildcard(g[id]) && typeof g[id].inputs.populated_text === 'string' && (g[id].inputs.populated_text as string).trim())
    .filter((id) => !negSet.has(id) || posSet.has(id))
  if (!saved.length) return null
  const onPos = saved.filter((id) => posSet.has(id) && !negSet.has(id))
  const pick = onPos.length ? onPos : saved
  const texts = [...new Set(pick.map((id) => impactCommentOut(g[id].inputs.populated_text as string)))]
  const id = pick[0]
  const notes = [`采样器追踪未完成（${error}）`, `已采用通配符节点 #${id}（${g[id].class_type}）保存的展开后文本（populated_text）`]
  let status: ExtractedPrompt['status'] = 'ok'
  if (!onPos.length) {
    status = 'check'
    notes.push('无法确认该节点连接到正向 Prompt')
  }
  if (texts.length > 1) {
    status = 'check'
    notes.push(`有 ${pick.length} 个通配符节点保存了不同的文本，已暂用 #${id}`)
  }
  const w = wildcardWarn(g[id].inputs.populated_text as string)
  if (w) {
    status = 'check'
    notes.push(w)
  }
  return { status, positive: texts[0], negative: '', source, notes, candidates: [], fallback: true }
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
  return { status, positive: pick.positive, negative: pick.negative, source, notes, candidates: [] }
}

const fail = (error: string): ExtractedPrompt => ({ status: 'error', positive: '', negative: '', source: null, notes: [], error, candidates: [] })

// ---------------- 工作流结构与节点指纹（不含参数值，只看节点类型与连接）

function hash(s: string): string {
  let a = 0x811c9dc5
  let b = 0x01000193 ^ 0x5bd1e995
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193)
    b = Math.imul(b ^ c, 0x5bd1e995) ^ (b >>> 13)
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0')
}

interface Shape {
  structure: string
  fp: Map<string, string>
  /** 指纹在本图中出现的次数（>1 时需要节点 ID 区分） */
  fpCount: Map<string, number>
}

/** 节点指纹：类型 + 输入名，再按连接关系迭代细化 3 轮（类似 WL 图哈希）；结构签名为所有指纹的有序集合 */
export function graphShape(g: Graph, source: string): Shape {
  const ids = Object.keys(g)
  const ins = new Map<string, { k: string; src: string; slot: number }[]>(ids.map((id) => [id, []]))
  const outs = new Map<string, { k: string; dst: string; slot: number }[]>(ids.map((id) => [id, []]))
  for (const id of ids) {
    for (const [k, v] of Object.entries(g[id].inputs)) {
      const l = linkOf(v)
      if (!l) continue
      ins.get(id)!.push({ k, src: l[0], slot: l[1] })
      outs.get(l[0])?.push({ k, dst: id, slot: l[1] })
    }
  }
  let label = new Map(ids.map((id) => [id, hash(`${g[id].class_type}|${Object.keys(g[id].inputs).sort().join(',')}|${g[id].bypass ? 'b' : ''}`)]))
  for (let r = 0; r < 3; r++) {
    const next = new Map<string, string>()
    for (const id of ids) {
      const i = ins.get(id)!.map((e) => `${e.k}:${e.slot}:${label.get(e.src) ?? '?'}`).sort()
      const o = outs.get(id)!.map((e) => `${e.k}:${e.slot}:${label.get(e.dst)}`).sort()
      next.set(id, hash(`${label.get(id)}<${i.join(';')}>${o.join(';')}`))
    }
    label = next
  }
  const fpCount = new Map<string, number>()
  for (const v of label.values()) fpCount.set(v, (fpCount.get(v) ?? 0) + 1)
  return { structure: `${source}:${hash([...label.values()].sort().join('|'))}`, fp: label, fpCount }
}

/** 可能是 Prompt 的文字输入（排除文件名、模式等选项） */
const isTextKey = (k: string) => /text|prompt|string|positive|negative|caption|wildcard|^value$|clip_l|t5xxl|tags?$/i.test(k) && !/name$|^filename|prefix|path|format|mode|delimiter|separator|action|tidy|clean|normalization|interpretation|weight|strength|^(sampler|scheduler)/i.test(k)

function graphCandidates(g: Graph, shape: Shape, posSet: Set<string>, negSet: Set<string>): PromptCandidate[] {
  const out: PromptCandidate[] = []
  const roleOf = (id: string, field: string): CandidateRole => {
    const pos = posSet.has(id)
    const neg = negSet.has(id)
    // 同一节点同时保存正负文本（加载器、风格节点）：按字段名区分
    if ((pos || neg) && /negative/i.test(field)) return 'negative'
    if ((pos || neg) && /positive/i.test(field)) return 'positive'
    return pos && neg ? 'unknown' : pos ? 'positive' : neg ? 'negative' : 'unused'
  }
  const add = (id: string, field: string, label: string, text: string, warn?: string) => {
    if (!text.trim() || text.length > CANDIDATE_LIMITS.maxText) return
    const n = g[id]
    const role = roleOf(id, field)
    const title = typeof n._meta?.title === 'string' && n._meta.title !== n.class_type ? n._meta.title : undefined
    const rule: SourceRule = { kind: 'node', key: `${n.class_type}|${field}`, classType: n.class_type, field, nodeId: id, title, fp: shape.fp.get(id), role, label: `${n.class_type} · ${field === '@encoded' ? '编码的文本' : field}` }
    out.push({ key: `n:${id}:${field}`, label, text, role, rule, ...(warn ? { warn } : {}) })
  }
  for (const id of Object.keys(g).sort(byId)) {
    const n = g[id]
    let encoded: string | null = null
    if (isEncoder(n)) {
      try {
        const pieces: Piece[] = []
        const probe = new Tracer(g)
        probe.cond([id, 0], 'positive', pieces, new Set())
        encoded = joinTexts(pieces)
        if (encoded && Object.values(n.inputs).some(isLink) && !textFieldsOf(n).every((f) => typeof n.inputs[f] === 'string')) add(id, '@encoded', `#${id} ${n.class_type}（编码的文本）`, encoded)
      } catch {
        // 文本无法解析：仍列出字面值字段
      }
    }
    if (TRIGGER.test(n.class_type)) continue // LoRA 语法与触发词设置不是 Prompt
    for (const [k, v] of Object.entries(n.inputs)) {
      if (typeof v !== 'string' || !isTextKey(k)) continue
      const warn = isWildcard(n) ? (k === 'wildcard_text' ? '通配符模板（未展开，不是最终 Prompt）' : k === 'populated_text' ? (wildcardWarn(v) ?? undefined) : undefined) : undefined
      add(id, k, `#${id} ${n.class_type} · ${k}`, v, warn)
    }
  }
  const order: Record<CandidateRole, number> = { positive: 0, unknown: 1, unused: 2, negative: 3 }
  return out.sort((a, b) => order[a.role] - order[b.role]).slice(0, CANDIDATE_LIMITS.maxCandidates)
}

// ---------------- 界面格式工作流

/**
 * 界面格式的工作流（workflow 元数据，只在缺少 prompt 元数据或无法读取时使用）：转换为近似的 API 图后同样追踪。
 * 只能可靠读取原生文本编码节点（文字控件即文本）、Reroute、字符串常量节点与 KJNodes 的 Set/Get 节点；
 * 被绕过（bypass）的节点按直通处理，被静音的节点视为不存在。
 */
export function promptFromUiWorkflow(wf: unknown): ExtractedPrompt {
  const w = wf as { nodes?: unknown; links?: unknown; definitions?: { subgraphs?: { id?: string }[] } }
  if (!w || typeof w !== 'object' || !Array.isArray(w.nodes) || !Array.isArray(w.links)) return fail('workflow 元数据格式无法识别')
  const linkMap = new Map<number, Link>()
  for (const l of w.links as unknown[]) {
    if (Array.isArray(l) && l.length >= 5) linkMap.set(Number(l[0]), [String(l[1]), Number(l[2])])
    else if (l && typeof l === 'object') {
      const o = l as { id?: unknown; origin_id?: unknown; origin_slot?: unknown }
      if (o.id != null && o.origin_id != null) linkMap.set(Number(o.id), [String(o.origin_id), Number(o.origin_slot ?? 0)])
    }
  }
  const subgraphs = new Set((w.definitions?.subgraphs ?? []).map((s) => s?.id).filter(Boolean))
  const g: Graph = {}
  const setters = new Map<string, unknown>()
  const getters: [string, string][] = []
  const usesSubgraph: string[] = []
  for (const raw of w.nodes as unknown[]) {
    const n = raw as { id?: unknown; type?: unknown; inputs?: unknown; widgets_values?: unknown; mode?: unknown; title?: unknown }
    if (!n || typeof n.type !== 'string' || n.id == null) continue
    if (n.mode === 2) continue // 已静音的节点
    if (subgraphs.has(n.type)) usesSubgraph.push(String(n.id))
    const inputs: Record<string, unknown> = {}
    for (const i of Array.isArray(n.inputs) ? (n.inputs as { name?: unknown; link?: unknown }[]) : []) {
      if (typeof i?.name === 'string' && typeof i.link === 'number' && linkMap.has(i.link)) inputs[i.name] = linkMap.get(i.link)
    }
    const widgets = Array.isArray(n.widgets_values) ? n.widgets_values : []
    const strings = widgets.filter((x): x is string => typeof x === 'string')
    if (/^SetNode$/i.test(n.type) && strings[0]) setters.set(strings[0], Object.values(inputs).find(isLink))
    if (/^GetNode$/i.test(n.type) && strings[0]) getters.push([String(n.id), strings[0]])
    if (encoderClass(n.type)) {
      const names = /Wildcard/i.test(n.type) ? ['wildcard_text', 'populated_text'] : /SDXL/i.test(n.type) ? ['text_g', 'text_l'] : /Flux/i.test(n.type) ? ['clip_l', 't5xxl'] : ['text', 'text_l']
      strings.slice(0, 2).forEach((s, i) => {
        if (!(names[i] in inputs) && !(i === 0 && 'text' in inputs)) inputs[names[i]] = s
      })
    } else if (/Primitive|String|Text|Prompt/i.test(n.type) && !/^(Note|MarkdownNote)$/i.test(n.type) && strings.length && !Object.keys(inputs).length) inputs.value = strings[0]
    if (/^KSampler/i.test(n.type) && !('latent_image' in inputs)) inputs.latent_image = null
    g[String(n.id)] = { class_type: n.type, inputs, bypass: n.mode === 4 || undefined, ...(typeof n.title === 'string' ? { _meta: { title: n.title } } : {}) }
  }
  for (const [id, name] of getters) {
    const src = setters.get(name)
    if (src) g[id].inputs = { value: src }
  }
  const r = promptFromApiGraph(g, 'comfy-workflow')
  if (r.status === 'error' && usesSubgraph.length) r.error += `；工作流使用了子图（节点 #${usesSubgraph.join('、#')}），界面格式中无法展开，请使用带 prompt 元数据的图片`
  return r.status === 'error' ? r : { ...r, notes: ['只从界面格式工作流读取（PNG 中没有可用的 prompt 元数据）', ...r.notes] }
}

// ---------------- WebUI 及其他软件

/** A1111 / Forge 等 WebUI 的 parameters 文本：Negative prompt: 之前为正向 */
export function promptFromParameters(text: string): ExtractedPrompt {
  const lines = String(text ?? '').split(/\r?\n/)
  const negAt = lines.findIndex((l) => l.startsWith('Negative prompt:'))
  const stepsAt = lines.findIndex((l) => /^Steps: \d+/.test(l))
  const posEnd = negAt >= 0 ? negAt : stepsAt >= 0 ? stepsAt : lines.length
  const positive = lines.slice(0, posEnd).join('\n').trim()
  const negative = negAt >= 0 ? [lines[negAt].slice('Negative prompt:'.length), ...lines.slice(negAt + 1, stepsAt > negAt ? stepsAt : lines.length)].join('\n').trim() : ''
  if (!positive) return fail('parameters 中没有正向 Prompt')
  return { status: 'ok', positive, negative, source: 'a1111', notes: [], candidates: [] }
}

/** 宽松的 JSON 解析：允许 Python json.dumps 写出的 NaN / Infinity */
export function parseJsonLoose(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch (e) {
    const fixed = text.replace(/("(?:[^"\\]|\\.)*")|\b(-?Infinity|NaN)\b/g, (_m, s) => s ?? 'null')
    if (fixed === text) throw e
    return JSON.parse(fixed)
  }
}

const tryJson = (text: string | undefined): unknown => {
  if (typeof text !== 'string' || !/^\s*[[{]/.test(text)) return undefined
  try {
    return parseJsonLoose(text)
  } catch {
    return undefined
  }
}
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
const strOf = (v: unknown): string => (typeof v === 'string' ? v : '')

/** JSON 格式的生成参数（Fooocus、SwarmUI、InvokeAI 等）：返回 [正向, 负向, 来源, 字段路径] */
function promptFromJson(o: Record<string, unknown>): [string, string, PromptSource, string] | null {
  const sui = obj(o.sui_image_params)
  if (sui && strOf(sui.prompt)) return [strOf(sui.prompt), strOf(sui.negativeprompt), 'swarmui', 'sui_image_params.prompt']
  for (const [p, n] of [
    ['prompt', 'negative_prompt'],
    ['positive_prompt', 'negative_prompt'],
    ['Prompt', 'Negative Prompt'],
  ]) {
    if (strOf(o[p]).trim()) return [strOf(o[p]), strOf(o[n]), 'fooocus', p]
  }
  return null
}

const field = (field: string, part: string, label: string, text: string, role: CandidateRole): PromptCandidate => {
  const key = `f:${field.toLowerCase()}:${part}`
  return { key, label, text, role, rule: { kind: 'field', key, label } }
}

/** 直接保存在元数据字段中的文本（与工作流结构无关），作为手动选择的候选 */
function fieldCandidates(chunks: Record<string, string>): PromptCandidate[] {
  const out: PromptCandidate[] = []
  for (const [k, v] of Object.entries(chunks)) {
    const lk = k.toLowerCase()
    if (!v.trim() || v.length > CANDIDATE_LIMITS.maxText * 4) continue
    const json = tryJson(v)
    if (lk === 'parameters' && json === undefined) {
      const p = promptFromParameters(v)
      if (p.positive) out.push(field(k, 'a1111', `${k}（WebUI 格式的正向部分）`, p.positive, 'positive'))
      if (p.negative) out.push(field(k, 'a1111-negative', `${k}（WebUI 格式的负向部分）`, p.negative, 'negative'))
    }
    const o = obj(json)
    if (o && !looksLikeGraph(o)) {
      for (const [path, role] of [
        ['prompt', 'positive'],
        ['positive_prompt', 'positive'],
        ['uc', 'negative'],
        ['negative_prompt', 'negative'],
      ] as [string, CandidateRole][]) {
        if (strOf(o[path]).trim()) out.push(field(k, `json.${path}`, `${k} → ${path}`, strOf(o[path]), role))
      }
      const sui = obj(o.sui_image_params)
      if (sui && strOf(sui.prompt)) out.push(field(k, 'json.sui.prompt', `${k} → sui_image_params.prompt`, strOf(sui.prompt), 'positive'))
    }
    if (json === undefined && v.length <= CANDIDATE_LIMITS.maxText && v.trim().length >= 3) out.push(field(k, 'raw', `${k}（字段全文）`, v, lk === 'description' || lk === 'prompt' ? 'positive' : lk === 'negative_prompt' ? 'negative' : 'unknown'))
  }
  return out
}

const looksLikeGraph = (o: Record<string, unknown>) => Object.values(o).some((n) => obj(n) && typeof (n as Node).class_type === 'string') || Array.isArray(o.nodes)

/** 按大小写不敏感的关键字取值（同名保留第一个） */
function lowerKeys(chunks: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(chunks)) if (typeof v === 'string' && !(k.toLowerCase() in out)) out[k.toLowerCase()] = v
  return out
}

const ok = (positive: string, negative: string, source: PromptSource, notes: string[] = []): ExtractedPrompt => ({ status: 'ok', positive, negative, source, notes, candidates: [] })

/**
 * 按优先级读取：ComfyUI prompt（API 图）→ ComfyUI workflow（界面格式）→ WebUI parameters（文本或 JSON）
 * → NovelAI Comment → InvokeAI → 纯文本 prompt 字段（Easy Diffusion 等）。
 * 无论成功与否都返回所有可选的文本来源，供手动指定。
 */
export function extractPrompt(chunks: Record<string, string>): ExtractedPrompt {
  const c = lowerKeys(chunks)
  const fieldsCands = fieldCandidates(chunks)
  const errors: string[] = []
  let graphResult: ExtractedPrompt | null = null
  const finish = (r: ExtractedPrompt): ExtractedPrompt => {
    const graphCands = graphResult?.candidates ?? []
    const keys = new Set(graphCands.map((x) => x.key))
    return { ...r, candidates: [...graphCands, ...fieldsCands.filter((x) => !keys.has(x.key))].slice(0, CANDIDATE_LIMITS.maxCandidates), structure: graphResult?.structure, nodeTypes: graphResult?.nodeTypes }
  }
  const parseJson = (k: string) => {
    try {
      return parseJsonLoose(c[k])
    } catch {
      errors.push(`${k} 元数据不是有效的 JSON`)
      return undefined
    }
  }
  const params = typeof c.parameters === 'string' ? c.parameters : undefined
  const paramsJson = obj(tryJson(params))
  const paramsResult = params === undefined ? null : paramsJson ? null : promptFromParameters(params)

  if (typeof c.prompt === 'string') {
    if (/^\s*[[{]/.test(c.prompt)) {
      const g = parseJson('prompt')
      if (g !== undefined) {
        const r = promptFromApiGraph(g)
        graphResult = r
        if (r.status === 'ok') return finish(r)
        if (r.status === 'check' && paramsResult?.status === 'ok') return finish({ ...paramsResult, notes: [`工作流中的正向 Prompt 需要确认（${r.notes.at(-1)}），已采用 parameters 中直接保存的正向 Prompt`] })
        if (r.status === 'check') return finish(r)
        errors.push(r.error!)
      }
    } else if (!c.workflow) {
      // Easy Diffusion 等：prompt 字段直接是正向文本
      return finish(ok(c.prompt, c.negative_prompt ?? '', 'easydiffusion', ['prompt 字段是纯文本 Prompt']))
    }
  }
  if (typeof c.workflow === 'string') {
    const w = parseJson('workflow')
    if (w !== undefined) {
      const r = promptFromUiWorkflow(w)
      if (!graphResult?.candidates.length) graphResult = r
      if (r.status === 'ok' || (r.status === 'check' && paramsResult?.status !== 'ok')) return finish(r)
      if (r.status === 'error') errors.push(r.error!)
    }
  }
  if (params !== undefined) {
    if (paramsJson) {
      const j = promptFromJson(paramsJson)
      if (j) return finish(ok(j[0], j[1], j[2], [`从 parameters 的 JSON 字段 ${j[3]} 读取`]))
      errors.push('parameters 是 JSON，但没有找到 prompt 字段')
    } else if (paramsResult!.status === 'ok') {
      return finish(errors.length ? { ...paramsResult!, notes: [`工作流无法读取（${errors.join('；')}），已采用 parameters 中直接保存的正向 Prompt`] } : paramsResult!)
    } else errors.push(paramsResult!.error!)
  }
  // NovelAI：Comment 为 JSON（prompt / uc），Description 为正向
  const comment = obj(tryJson(c.comment))
  if (comment && strOf(comment.prompt).trim()) {
    const notes = ['从 NovelAI 的 Comment 字段读取']
    const v4 = obj(obj(comment.v4_prompt)?.caption)
    const chars = Array.isArray(v4?.char_captions) ? (v4!.char_captions as unknown[]).map((x) => strOf(obj(x)?.char_caption)).filter(Boolean) : []
    if (chars.length) notes.push(`另有 ${chars.length} 段角色提示词（未合并到正向 Prompt，可在「Prompt 来源」中查看）`)
    return finish(ok(strOf(comment.prompt), strOf(comment.uc), 'novelai', notes))
  }
  if (/novelai/i.test(c.software ?? '') && strOf(c.description).trim()) return finish(ok(c.description, '', 'novelai', ['从 NovelAI 的 Description 字段读取']))
  // InvokeAI
  const invoke = obj(tryJson(c.invokeai_metadata))
  if (invoke && strOf(invoke.positive_prompt).trim()) return finish(ok(strOf(invoke.positive_prompt), strOf(invoke.negative_prompt), 'invokeai', ['从 InvokeAI 的 invokeai_metadata 读取']))
  const sdm = obj(obj(tryJson(c['sd-metadata']))?.image)
  if (sdm) {
    const p = Array.isArray(sdm.prompt) ? (sdm.prompt as unknown[]).map((x) => strOf(obj(x)?.prompt)).filter(Boolean).join(', ') : strOf(sdm.prompt)
    if (p.trim()) return finish(ok(p, '', 'invokeai', ['从 InvokeAI 的 sd-metadata 读取']))
  }
  if (typeof c.dream === 'string') {
    const m = /^"([\s\S]*)"\s+-\w/.exec(c.dream)
    if (m?.[1].trim()) return finish(ok(m[1], '', 'invokeai', ['从 InvokeAI 的 Dream 字段读取']))
  }
  if (typeof c.prompt === 'string' && !/^\s*[[{]/.test(c.prompt)) return finish(ok(c.prompt, c.negative_prompt ?? '', 'easydiffusion', ['prompt 字段是纯文本 Prompt']))
  const keys = Object.keys(chunks)
  if (!keys.length) return finish(fail('没有找到生成参数（图片中没有任何文本元数据，可能已被压缩、转存或清除）'))
  if (!errors.length) errors.push(`图片中有元数据字段 ${keys.slice(0, 8).join('、')}${keys.length > 8 ? ' 等' : ''}，但不是可识别的生成参数格式`)
  return finish(fail([...new Set(errors)].join('；')))
}

// ---------------- 手动指定来源

/** 规则在某张图片中的匹配结果 */
export type RuleMatch =
  | { reason: 'ok'; c: PromptCandidate }
  /** 没有这个字段 / 同类型节点（或节点中该字段为空） */
  | { reason: 'missing' }
  /** 有多个同类型节点，无法区分 */
  | { reason: 'ambiguous'; count: number }
  /** 同类型节点连到负向（不会把负向当作正向） */
  | { reason: 'negative' }
  /** 严格匹配节点 ID：该 ID 的节点类型不同 */
  | { reason: 'id-mismatch'; classType: string }

/**
 * 在另一张图片中按规则找到对应的候选。
 * 节点规则不要求整个工作流结构一致：按 class_type + 字段查找；多个同类型节点时依次用连接方向、标题、局部结构、节点 ID 区分。
 */
export function matchRuleDetail(rule: SourceRule, im: Pick<ExtractedPrompt, 'candidates'> & { nodeTypes?: Record<string, string> }): RuleMatch {
  if (rule.kind === 'field') {
    const c = im.candidates.find((x) => x.rule.kind === 'field' && x.rule.key === rule.key)
    return c ? { reason: 'ok', c } : { reason: 'missing' }
  }
  const classType = rule.classType ?? rule.key.split('|')[0]
  const field = rule.field ?? rule.key.split('|').slice(1).join('|')
  let pool = im.candidates.filter((c) => c.rule.kind === 'node' && c.rule.classType === classType && c.rule.field === field)
  if (rule.strictId) {
    const hit = pool.filter((c) => c.rule.nodeId === rule.nodeId)
    if (hit.length === 1) return guardRole(rule, hit[0])
    const other = rule.nodeId ? im.nodeTypes?.[rule.nodeId] : undefined
    return other && other !== classType ? { reason: 'id-mismatch', classType: other } : { reason: 'missing' }
  }
  if (!pool.length) return { reason: 'missing' }
  if (pool.length === 1) return guardRole(rule, pool[0])
  // 多个同类型节点：只用能区分的条件缩小范围
  const narrow = (f: (c: PromptCandidate) => boolean) => {
    const next = pool.filter(f)
    if (next.length) pool = next
    return pool.length === 1
  }
  if (rule.role !== 'negative') {
    // 规则用于读取正向 Prompt：连到负向的节点不参与
    if (pool.every((c) => c.role === 'negative')) return { reason: 'negative' }
    if (narrow((c) => c.role !== 'negative')) return guardRole(rule, pool[0])
  }
  if (rule.role === 'positive' || rule.role === 'negative') {
    if (narrow((c) => c.role === rule.role)) return guardRole(rule, pool[0])
  }
  if (rule.title && narrow((c) => c.rule.title === rule.title)) return guardRole(rule, pool[0])
  if (rule.fp && narrow((c) => c.rule.fp === rule.fp)) return guardRole(rule, pool[0])
  if (rule.nodeId && narrow((c) => c.rule.nodeId === rule.nodeId)) return guardRole(rule, pool[0])
  return { reason: 'ambiguous', count: pool.length }
}

function guardRole(rule: SourceRule, c: PromptCandidate): RuleMatch {
  // 规则用于读取正向 Prompt：除非用户选择的本来就是负向节点，否则不会把连到负向的节点当作正向
  if (rule.role !== 'negative' && c.role === 'negative') return { reason: 'negative' }
  return { reason: 'ok', c }
}

export function matchRule(rule: SourceRule, im: Pick<ExtractedPrompt, 'candidates'> & { nodeTypes?: Record<string, string> }): PromptCandidate | null {
  const m = matchRuleDetail(rule, im)
  return m.reason === 'ok' ? m.c : null
}

/** 用户保存的来源规则（保存在 Vault 的 data/prompt-source-rules.json） */
export interface SavedSourceRule {
  id: string
  name: string
  enabled: boolean
  rule: SourceRule
  created_at: string
}
