// 工作流自动识别：根据节点类型与连接关系（不依赖固定节点 ID）给出映射建议。
// - Prompt：从采样器的 positive / negative 沿条件（conditioning）回溯到文本编码器，再沿字符串连接回溯到真正提供文本的节点
//   （字符串拼接、正则替换等中间节点会被穿过；触发词节点、LoRA Loader 不会被当作 Prompt 来源）
// - Seed：被其他节点引用的 Seed 节点是主 Seed；采样器里独立填写的 Seed 需要确认，不会擅自同步
// - LoRA Loader：标准 Loader、兼容的自定义 Loader、多 LoRA Loader（列表）全部列出；角色 / 画风无法从结构判断，一律需要确认
// - 输出：最终（不再被其他节点使用的）保存节点
// 所有建议都只是候选，由用户确认后才写入映射。

import { DEFAULT_PREFIX_TEMPLATE, findLoraLoaders, isLink, loraBindingEntries, newEntry, nodeTitle, sortNodeIds, type LoraLoaderInfo } from './mapping'
import type { ApiNode, ApiWorkflow, MappingEntry } from './types'

export type SuggestionGroup = 'prompt' | 'seed' | 'lora' | 'output'
export interface Suggestion {
  group: SuggestionGroup
  /** 勾选后写入的映射（同一个 Prompt 可以写入同一节点的多个字段） */
  entries: MappingEntry[]
  checked: boolean
  /** high：结构明确，默认勾选；confirm：有歧义，需要用户确认 */
  confidence: 'high' | 'confirm'
  title: string
  why: string
  /** 节点信息：ID、标题、类型 */
  node: string
  nodeLabel: string
  /** 原始值预览 */
  preview?: string
}
export interface WorkflowAnalysis {
  suggestions: Suggestion[]
  /** 需要注意但不会自动处理的情况（触发词节点、无法识别的 LoRA 节点、独立 Seed 等） */
  notes: string[]
}

/** 已知会执行的文本字段：ImpactWildcardProcessor 在 API 调用时执行 populated_text（populate 模式下界面才会用 wildcard_text 覆盖它），两者都写入以保持一致 */
const KNOWN_TEXT_SOURCES: Record<string, string[]> = {
  ImpactWildcardProcessor: ['populated_text', 'wildcard_text'],
}
/** 通用文本节点中可能保存 Prompt 的字段（按优先级） */
const TEXT_FIELDS = ['text', 'prompt', 'string', 'value', 'text_g', 'text_l', 'populated_text', 'wildcard_text']
/** 回溯字符串时不跟随的输入（数值 / 模型类），以及这些输入不影响「是否为文本源」的判断 */
const NON_TEXT_LINKS = /^(seed|noise_seed|model|clip|vae|image|images|latent|samples|mask|width|height|batch_size|steps|cfg|denoise)$/

const preview = (v: unknown) => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim()
  return s.length > 120 ? `${s.slice(0, 120)}…` : s
}
const label = (api: ApiWorkflow, nid: string) => `#${nid} ${nodeTitle(api[nid])}${api[nid]?._meta?.title && api[nid]._meta!.title !== api[nid].class_type ? `（${api[nid].class_type}）` : ''}`

/** 采样器：有 model、positive、negative 连接，并有 seed / steps 参数的节点（KSampler、KSamplerAdvanced、UltimateSDUpscale、Detailer 等；ToDetailerPipe 这类只传递条件的节点除外） */
export function findSamplers(api: ApiWorkflow): string[] {
  return sortNodeIds(Object.keys(api)).filter((nid) => {
    const i = api[nid]?.inputs ?? {}
    return isLink(i.model) && isLink(i.positive) && isLink(i.negative) && ['seed', 'noise_seed', 'steps'].some((k) => k in i)
  })
}

/** 文本编码器：有 clip 连接、并有文本字段（文字或连接）的节点 */
const isEncoder = (n: ApiNode) => isLink(n.inputs?.clip) && TEXT_FIELDS.some((f) => f in (n.inputs ?? {}))

/** 从条件连接回溯到文本编码器（穿过 ControlNet 等同时有 positive / negative 的节点，按输出序号区分） */
function encodersOf(api: ApiWorkflow, link: [string, number], seen = new Set<string>()): string[] {
  const [nid, out] = link
  const key = `${nid}:${out}`
  if (seen.has(key)) return []
  seen.add(key)
  const n = api[nid]
  if (!n) return []
  if (isEncoder(n)) return [nid]
  const i = n.inputs ?? {}
  if (isLink(i.positive) && isLink(i.negative)) return encodersOf(api, (out === 1 ? i.negative : i.positive) as [string, number], seen)
  return Object.entries(i)
    .filter(([k, v]) => isLink(v) && /cond/i.test(k))
    .flatMap(([, v]) => encodersOf(api, v as [string, number], seen))
}

interface TextSource {
  node: string
  fields: string[]
  known: boolean
}

/** 从字符串连接回溯到提供文本的节点；记录途中遇到的触发词节点 */
function textSourcesOf(api: ApiWorkflow, nid: string, triggers: Set<string>, seen = new Set<string>()): TextSource[] {
  if (seen.has(nid)) return []
  seen.add(nid)
  const n = api[nid]
  if (!n) return []
  const i = n.inputs ?? {}
  if (/trigger/i.test(n.class_type)) {
    triggers.add(nid)
    return []
  }
  if (isLink(i.model) || isLink(i.clip)) return [] // LoRA Loader 等输出的文本（如已加载的 LoRA 列表）不是 Prompt
  const known = KNOWN_TEXT_SOURCES[n.class_type]
  if (known) return [{ node: nid, fields: known.filter((f) => typeof i[f] === 'string'), known: true }]
  const links = Object.entries(i).filter(([k, v]) => isLink(v) && !NON_TEXT_LINKS.test(k))
  if (!links.length) {
    const f = TEXT_FIELDS.find((k) => typeof i[k] === 'string')
    return f ? [{ node: nid, fields: [f], known: false }] : []
  }
  // 中间节点（拼接、正则替换等）：继续回溯它的字符串输入，自身的参数不是 Prompt
  return links.flatMap(([, v]) => textSourcesOf(api, (v as [string, number])[0], triggers, seen))
}

/** 节点被哪些节点引用 */
function consumers(api: ApiWorkflow): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const [nid, n] of Object.entries(api)) for (const v of Object.values(n.inputs ?? {})) if (isLink(v) && !(out.get(v[0]) ?? []).includes(nid)) out.set(v[0], [...(out.get(v[0]) ?? []), nid])
  return out
}

/** 从某节点沿下游连接找到使用它的采样器 */
function samplersFed(api: ApiWorkflow, nid: string, samplers: Set<string>, cons: Map<string, string[]>): string[] {
  const hit = new Set<string>()
  const seen = new Set<string>([nid])
  const queue = [nid]
  while (queue.length) {
    const cur = queue.shift()!
    for (const next of cons.get(cur) ?? []) {
      if (seen.has(next)) continue
      seen.add(next)
      if (samplers.has(next)) hit.add(next)
      // 只沿模型链继续（经过 LoRA Loader、DifferentialDiffusion 等模型处理节点）
      if (isLink(api[next]?.inputs?.model)) queue.push(next)
    }
  }
  return sortNodeIds([...hit])
}

export function analyzeWorkflow(api: ApiWorkflow): WorkflowAnalysis {
  const suggestions: Suggestion[] = []
  const notes: string[] = []
  const samplers = findSamplers(api)
  const samplerSet = new Set(samplers)
  const cons = consumers(api)

  // ---- Prompt
  const triggers = new Set<string>()
  const byPolarity: Record<'positive' | 'negative', Map<string, TextSource>> = { positive: new Map(), negative: new Map() }
  for (const s of samplers) {
    for (const pol of ['positive', 'negative'] as const) {
      for (const enc of encodersOf(api, api[s].inputs[pol] as [string, number])) {
        const ei = api[enc].inputs
        const field = TEXT_FIELDS.find((f) => f in ei)!
        const sources: TextSource[] = isLink(ei[field]) ? textSourcesOf(api, (ei[field] as [string, number])[0], triggers) : typeof ei[field] === 'string' ? [{ node: enc, fields: [field], known: true }] : []
        for (const src of sources) byPolarity[pol].set(src.node, src)
      }
    }
  }
  for (const pol of ['positive', 'negative'] as const) {
    const other = pol === 'positive' ? 'negative' : 'positive'
    const list = [...byPolarity[pol].values()]
    for (const src of list) {
      const both = byPolarity[other].has(src.node)
      const title = api[src.node]?._meta?.title ?? ''
      const titleConflict = pol === 'positive' ? /neg|负/i.test(title) : /pos|正/i.test(title) && !/neg|负/i.test(title)
      const high = list.length === 1 && !both && !titleConflict && src.fields.length > 0
      const n = api[src.node]
      suggestions.push({
        group: 'prompt',
        entries: src.fields.map((f) => newEntry(pol, src.node, f)),
        checked: high,
        confidence: high ? 'high' : 'confirm',
        title: `${pol === 'positive' ? '正面' : '负面'} Prompt → ${src.fields.join(' + ')}`,
        why: both
          ? '这个节点同时出现在正面与负面路径中，请确认用途'
          : list.length > 1
            ? `${pol === 'positive' ? '正面' : '负面'}路径上有 ${list.length} 个文本来源，请确认哪个用于写入 Prompt（其余保持原样）`
            : KNOWN_TEXT_SOURCES[n.class_type]
              ? `经采样器的 ${pol} 回溯找到；${n.class_type} 实际执行 ${src.fields[0]}，同时写入 ${src.fields.slice(1).join('、') || '—'} 以保持一致`
              : `经采样器的 ${pol} 回溯找到`,
        node: src.node,
        nodeLabel: label(api, src.node),
        preview: preview(n.inputs[src.fields[0]]),
      })
    }
  }
  for (const t of triggers)
    notes.push(`检测到触发词节点 ${label(api, t)}：它会把 LoRA 的触发词拼入正面 Prompt。本软件不会修改它；如果角色基础 Prompt 中也写了触发词，可能会重复。`)
  if (Object.values(api).some((n) => KNOWN_TEXT_SOURCES[n.class_type]))
    notes.push('ImpactWildcardProcessor 通过 API 运行时执行 populated_text（populate 模式只在网页界面中生效），因此会同时写入 populated_text 与 wildcard_text；Prompt 中的通配符语法仍会由该节点按其 Seed 处理。')

  // ---- Seed：被其他节点引用的 Seed 节点为主 Seed；其余独立 Seed 需要确认
  // 只把「连接到其他节点的 seed 输入」算作引用（例如放大节点的图片输出被保存节点使用，不代表它是主 Seed）
  const seedUsers = (nid: string) => Object.entries(api).filter(([, n]) => Object.entries(n.inputs ?? {}).some(([k, v]) => /seed/i.test(k) && isLink(v) && v[0] === nid)).map(([id]) => id)
  const seeds = sortNodeIds(Object.keys(api)).flatMap((nid) =>
    ['seed', 'noise_seed'].filter((k) => Number.isInteger(api[nid]?.inputs?.[k])).map((k) => ({ nid, k, users: sortNodeIds(seedUsers(nid)) })),
  )
  const primary = seeds.filter((s) => s.users.length > 0)
  const firstSampler = seeds.find((s) => samplerSet.has(s.nid))
  for (const s of seeds) {
    const high = primary.length ? primary.includes(s) : s === firstSampler
    suggestions.push({
      group: 'seed',
      entries: [newEntry('seed', s.nid, s.k)],
      checked: high,
      confidence: high ? 'high' : 'confirm',
      title: `Seed → ${s.k}`,
      why: high ? (s.users.length ? `被 ${s.users.length} 个节点用作 Seed（${s.users.map((x) => `#${x}`).join('、')}），是主 Seed` : '采样器的 Seed') : '独立的 Seed：是否与主 Seed 一起按张递增需要确认（不勾选则保持工作流原值）',
      node: s.nid,
      nodeLabel: label(api, s.nid),
      preview: String(api[s.nid].inputs[s.k]),
    })
  }
  const independent = seeds.filter((s) => !primary.includes(s))
  if (primary.length && independent.length) notes.push(`有 ${independent.length} 个独立 Seed（${independent.map((s) => `#${s.nid}`).join('、')}）：默认保持工作流原值，不会与主 Seed 同步，需要时请勾选。`)

  // ---- LoRA Loader：全部列出；角色 / 画风无法从结构判断，一律需要确认
  const loaders = findLoraLoaders(api)
  const fedText = (ld: LoraLoaderInfo) => {
    const fed = samplersFed(api, ld.node, samplerSet, cons)
    return fed.length ? `作用于采样器 ${fed.map((x) => `#${x}`).join('、')}` : '没有找到使用它的采样器'
  }
  for (const ld of loaders) {
    if (ld.support === 'unknown') {
      notes.push(`节点 ${label(api, ld.node)} 看起来是 LoRA 加载节点，但结构无法识别：需要在映射中手动指定，或保持工作流原值。`)
      continue
    }
    const stack = ld.support === 'stack'
    for (const [prefix, who] of [
      ['lora1', '主角色 LoRA'],
      ['second_lora1', '第二角色 LoRA'],
    ] as const) {
      suggestions.push({
        group: 'lora',
        entries: loraBindingEntries(prefix, ld),
        checked: false,
        confidence: 'confirm',
        title: `${who} → ${stack ? '追加到 LoRA 列表' : 'lora_name + 权重'}`,
        why: `${fedText(ld)}。${stack ? `列表中已有 ${ld.entries!.length} 个 LoRA（其中 ${ld.entries!.filter((e) => e.active).length} 个启用），会保持原样；与角色 LoRA 同名的条目会被直接更新` : `当前为「${ld.lora_name}」`}。无法从结构判断这是角色还是画风 LoRA，请确认`,
        node: ld.node,
        nodeLabel: label(api, ld.node),
        preview: stack ? ld.entries!.map((e) => `${e.active ? '' : '（停用）'}${e.name}:${e.strength}`).join('  ') : ld.lora_name,
      })
    }
    if (stack) notes.push(`多 LoRA Loader ${label(api, ld.node)} 按 loras 列表加载（text 字段不参与执行）。其中的 LoRA 默认保持原样；可以在套图任务的 LoRA 配置中把它们导入为任务 LoRA，由任务控制启用与权重。`)
    if (ld.support === 'partial') notes.push(`节点 ${label(api, ld.node)} 只识别到 lora_name，权重无法由本软件控制。`)
  }

  // ---- 输出：不再被其他节点使用的保存节点为最终输出
  const saves = sortNodeIds(Object.keys(api)).filter((nid) => typeof api[nid]?.inputs?.filename_prefix === 'string')
  const finals = saves.filter((nid) => !(cons.get(nid) ?? []).length)
  for (const nid of saves) {
    const high = finals.length === 1 && finals[0] === nid
    suggestions.push({
      group: 'output',
      entries: [newEntry('filename_prefix', nid, 'filename_prefix', [], DEFAULT_PREFIX_TEMPLATE)],
      checked: high,
      confidence: high ? 'high' : 'confirm',
      title: '输出文件前缀',
      why: high ? '最终输出（没有被其他节点继续使用）' : (cons.get(nid) ?? []).length ? `中间结果（被 ${(cons.get(nid) ?? []).join('、')} 继续使用）` : '有多个最终输出，请确认',
      node: nid,
      nodeLabel: label(api, nid),
      preview: String(api[nid].inputs.filename_prefix),
    })
  }
  return { suggestions, notes }
}

/** 应用建议时合并映射：同一节点输入已有映射的跳过（多 LoRA Loader 的列表绑定按槽位区分） */
export function mergeMapping(mapping: MappingEntry[], add: MappingEntry[]): MappingEntry[] {
  const key = (e: MappingEntry) => `${e.node}\u0000${e.input}${e.input === 'loras' ? `\u0000${e.source}` : ''}`
  const have = new Set(mapping.map(key))
  return [...mapping, ...add.filter((e) => !have.has(key(e)) && have.add(key(e)))]
}
