// 工作流级节点控制：通用参数覆盖与节点绕过。配置保存在工作流记录的 controls 字段，与映射、任务 LoRA 配置相互独立，原始 API JSON 不会被修改。
//
// 构建顺序（预览、入队、提交都走 mappingValues → loraConfigInputs → controlInputs → applyInputs）：
//   原始工作流 → 映射（含禁止触发词注入）→ 任务 LoRA 配置 → 节点覆盖 → 绕过（改接下游并移除节点）
// 这不是「后写覆盖先写」：同一个输入被多个机制写入时直接报错并阻止入队，结果不会有歧义。
//
// 绕过与 ComfyUI 编辑器一致：被绕过的节点不出现在提交的 API JSON 中，下游连接直接改接到它的上游
// （见 ComfyUI_frontend 的 ExecutableNodeDTO.resolveOutput 与 graphToPrompt）。API JSON 没有输出类型，
// 因此只有在 /object_info 能确认「每个被使用的输出都对应唯一一个同类型、已连接的输入」时才允许，确认结果连同路由保存在配置中。
// 这比编辑器保守：编辑器在多个同类型输入时按序号选择，这里一律拒绝，不猜测连接。

import { controllableLoaders } from './lora-config'
import { BYPASS_REWIRE, findLoraLoaders, isLink, LM_TRIGGER_TOGGLE, NODE_BYPASS, NODE_OVERRIDE, sortNodeIds, sourceLabel, toggleDisableInputs, toggleStructure, TRIGGER_DISABLE } from './mapping'
import type { ApiNode, ApiWorkflow, InputValue, MappingEntry, Message, NodeBypass, ObjectInfo, ObjectInfoNode, WorkflowControls } from './types'

export const EMPTY_CONTROLS: WorkflowControls = { overrides: [], bypass: [] }

const tag = (nid: string, node?: ApiNode) => `节点 #${nid}${node ? `（${node.class_type}）` : ''}`
const isPlainObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** 读取工作流的控制配置（旧工作流没有这个字段） */
export function controlsOf(wf: { controls?: WorkflowControls | null } | null | undefined): WorkflowControls {
  return { overrides: wf?.controls?.overrides ?? [], bypass: wf?.controls?.bypass ?? [] }
}
export const hasControls = (c: WorkflowControls) => c.overrides.length > 0 || c.bypass.length > 0

/** IPC 入口的结构检查：只保留已知字段；是否与当前工作流匹配由 controlProblems 判断 */
export function normalizeControls(val: unknown): WorkflowControls | null {
  if (val === null || val === undefined) return null
  if (!isPlainObj(val)) throw new Error('节点控制配置格式无效')
  const list = (v: unknown, name: string) => {
    if (v === undefined) return []
    if (!Array.isArray(v)) throw new Error(`${name} 必须是数组`)
    return v.map((x) => {
      if (!isPlainObj(x)) throw new Error(`${name} 的条目格式无效`)
      return x
    })
  }
  const text = (v: unknown, name: string) => {
    if (typeof v !== 'string' || !v) throw new Error(`${name} 无效`)
    return v
  }
  const overrides = list(val.overrides, 'overrides').map((o) => {
    if (o.value === undefined || o.value === null) throw new Error('覆盖值不能为空')
    return { node: text(o.node, 'node'), input: text(o.input, 'input'), class_type: text(o.class_type, 'class_type'), value: o.value }
  })
  const bypass = list(val.bypass, 'bypass').map((b) => ({
    node: text(b.node, 'node'),
    class_type: text(b.class_type, 'class_type'),
    routes: list(b.routes, 'routes').map((r) => {
      if (!Number.isInteger(r.output) || (r.output as number) < 0) throw new Error('routes.output 无效')
      return { output: r.output as number, input: text(r.input, 'input'), type: text(r.type, 'type') }
    }),
    output_node: !!b.output_node,
  }))
  return { overrides, bypass }
}

// ---------------- 节点分类（只用于列表显示；认不出的第三方节点放入「其他」，不猜用途）

export type NodeCategory = 'prompt' | 'model' | 'sampler' | 'image' | 'output' | 'other'
export const NODE_CATEGORIES: [NodeCategory, string][] = [['prompt', 'Prompt / 文本'], ['model', '模型与 LoRA'], ['sampler', '采样'], ['image', '图像处理'], ['output', '输出'], ['other', '其他']]

export function nodeCategory(api: ApiWorkflow, nid: string): NodeCategory {
  const n = api[nid]
  if (!n) return 'other'
  const ct = n.class_type
  if (typeof n.inputs?.filename_prefix === 'string' || /^(Save|Preview)|SaveImage|PreviewImage/i.test(ct)) return 'output'
  if (findLoraLoaders(api).some((l) => l.node === nid) || /CheckpointLoader|VAELoader|CLIPLoader|UNETLoader|ControlNetLoader|UpscaleModelLoader|CLIPSetLastLayer|ModelSampling|DifferentialDiffusion/i.test(ct)) return 'model'
  if (/KSampler|SamplerCustom|UltimateSDUpscale|Detailer|BasicScheduler|Guider/i.test(ct)) return 'sampler'
  if (toggleStructure(n) || /TextEncode|Wildcard|TriggerWord|StringConcat|RegexReplace|^String|Prompt|WidgetToString/i.test(ct)) return 'prompt'
  if (/Image|Upscale|VAEDecode|VAEEncode|Canny|ControlNetApply|Latent/i.test(ct)) return 'image'
  return 'other'
}

/** 校验消息中提到的节点（节点列表上的异常标记） */
export function problemNodes(msgs: Message[]): Set<string> {
  const out = new Set<string>()
  for (const [lvl, m] of msgs) if (lvl === 'error') for (const hit of m.matchAll(/(?:节点 #?|#)(\d+)/g)) out.add(hit[1])
  return out
}

// ---------------- 输入类型

export type LiteralKind = 'string' | 'number' | 'boolean' | 'json'
export const literalKind = (v: unknown): LiteralKind => (typeof v === 'string' ? 'string' : typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'json')

export interface InputSpec {
  type: string
  options?: unknown[]
  min?: number
  max?: number
}
/** /object_info 中声明的输入类型；枚举（旧格式 [[...]]、新格式 ['COMBO', {options}]）统一为 COMBO */
export function inputSpec(spec: ObjectInfoNode | undefined, name: string): InputSpec | null {
  const d = spec?.input?.required?.[name] ?? spec?.input?.optional?.[name]
  if (!Array.isArray(d)) return null
  const opts = isPlainObj(d[1]) ? d[1] : {}
  if (Array.isArray(d[0])) return { type: 'COMBO', options: d[0] }
  if (typeof d[0] !== 'string') return null
  return {
    type: d[0],
    ...(Array.isArray(opts.options) ? { options: opts.options as unknown[] } : {}),
    ...(typeof opts.min === 'number' ? { min: opts.min } : {}),
    ...(typeof opts.max === 'number' ? { max: opts.max } : {}),
  }
}

/** 值与类型的校验：离线时按工作流原值的类型检查；有 /object_info 时再核对声明的类型、范围与可选值 */
export function checkOverrideValue(original: unknown, value: unknown, spec?: InputSpec | null): string[] {
  if (value === null || value === undefined) return ['覆盖值不能为空']
  if (isLink(value)) return ['这个值的格式是节点连接 [节点 ID, 输出序号]：覆盖不能用来改接节点']
  const out: string[] = []
  const kind = literalKind(original)
  if (literalKind(value) !== kind) out.push(`类型不匹配：工作流原值是${({ string: '文本', number: '数字', boolean: '布尔值', json: 'JSON 对象或数组' } as const)[kind]}`)
  if (typeof value === 'number' && !Number.isFinite(value)) out.push('数值无效')
  if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) out.push('超过安全整数范围，提交的值会与填写的不同')
  if (kind === 'json' && !isPlainObj(value) && !Array.isArray(value)) out.push('必须是 JSON 对象或数组')
  if (spec) {
    if (spec.type === 'INT' && !Number.isInteger(value)) out.push('ComfyUI 声明这个输入是整数')
    if (spec.type === 'FLOAT' && typeof value !== 'number') out.push('ComfyUI 声明这个输入是数字')
    if (spec.type === 'BOOLEAN' && typeof value !== 'boolean') out.push('ComfyUI 声明这个输入是布尔值')
    if (spec.type === 'STRING' && typeof value !== 'string') out.push('ComfyUI 声明这个输入是文本')
    if (typeof value === 'number' && spec.min !== undefined && value < spec.min) out.push(`小于 ComfyUI 声明的最小值 ${spec.min}`)
    if (typeof value === 'number' && spec.max !== undefined && value > spec.max) out.push(`大于 ComfyUI 声明的最大值 ${spec.max}`)
    if (spec.options && !spec.options.includes(value)) out.push(`不在 ComfyUI 的可选列表中（共 ${spec.options.length} 项）`)
  }
  return out
}

// ---------------- 连接

export function consumersOf(api: ApiWorkflow, nid: string): { node: string; input: string; output: number }[] {
  return sortNodeIds(Object.keys(api)).flatMap((id) =>
    Object.entries(api[id].inputs ?? {})
      .filter(([, v]) => isLink(v) && String(v[0]) === nid)
      .map(([input, v]) => ({ node: id, input, output: (v as [string, number])[1] })),
  )
}

/** 输入已被任务 LoRA 配置接管的 Loader：这些字段不接受其他机制写入 */
function loraOwned(api: ApiWorkflow, mapping: MappingEntry[], nid: string): string[] {
  const ld = controllableLoaders(api, mapping).find((l) => l.node === nid)
  if (!ld) return []
  return ld.support === 'stack' ? ['loras', 'text'] : ['lora_name', ...ld.strengths]
}

export type InputState = 'link' | 'mapping' | 'lora' | 'trigger' | 'override' | 'original'
export interface InputControl {
  state: InputState
  /** 显示给用户的控制来源 */
  label: string
  /** 可以直接确定的待写入值（映射、LoRA 配置的值每张图由计划决定，这里没有） */
  prepared?: { value: unknown } | null
  /** 不能添加节点覆盖的原因；空表示可以 */
  blocked?: string
}

/** 一个输入当前由谁控制（节点详情显示用；判断规则与 controlProblems 相同） */
export function inputControl(api: ApiWorkflow, mapping: MappingEntry[], controls: WorkflowControls, nid: string, input: string): InputControl {
  const node = api[nid]
  const v = node?.inputs?.[input]
  const trigger = mapping.some((m) => m.source === TRIGGER_DISABLE && String(m.node) === nid) ? toggleDisableInputs(nid, node).find((x) => x.input === input) : undefined
  const mapped = mapping.filter((m) => m.source !== TRIGGER_DISABLE && String(m.node) === nid && m.input === input)
  const rewire = isLink(v) && controls.bypass.length ? rewireOf(api, controls, v) : null
  if (trigger) return { state: 'trigger', label: '禁止触发词注入', prepared: { value: trigger.value }, blocked: '已由「禁止触发词注入」控制' }
  if (isLink(v)) return { state: 'link', label: rewire ? `连接（绕过后改接 #${rewire[0]}）` : '连接', prepared: rewire ? { value: rewire } : null, blocked: '这是节点连接，不是可以直接填写的值' }
  if (mapped.length) return { state: 'mapping', label: `映射：${mapped.map((m) => sourceLabel(m.source)).join('、')}`, prepared: null, blocked: '已由映射控制（每张图写入计划中的值）' }
  if (loraOwned(api, mapping, nid).includes(input)) return { state: 'lora', label: '任务 LoRA 配置', prepared: null, blocked: '已由套图任务的 LoRA 配置控制' }
  const ov = controls.overrides.find((o) => o.node === nid && o.input === input)
  if (ov) return { state: 'override', label: '节点参数覆盖', prepared: { value: ov.value } }
  return { state: 'original', label: '保持原值', prepared: null }
}

function rewireOf(api: ApiWorkflow, controls: WorkflowControls, link: [string, number]): [string, number] | null {
  const byNode = new Map(controls.bypass.map((b) => [b.node, b]))
  if (!byNode.has(String(link[0]))) return null
  try {
    return resolveLink(api, byNode, link)
  } catch {
    return null
  }
}

/** 沿被绕过的节点向上游解析连接（可以连续绕过多个节点） */
function resolveLink(api: ApiWorkflow, byNode: Map<string, NodeBypass>, link: [string, number]): [string, number] {
  let cur = link
  const seen = new Set<string>()
  for (;;) {
    const nid = String(cur[0])
    const b = byNode.get(nid)
    if (!b) return cur
    if (seen.has(nid)) throw new Error(`绕过 ${tag(nid, api[nid])} 时遇到循环连接`)
    seen.add(nid)
    const route = b.routes.find((r) => r.output === cur[1])
    if (!route) throw new Error(`${tag(nid, api[nid])} 的输出 ${cur[1]} 没有确认过的绕过路径`)
    const next = api[nid]?.inputs?.[route.input]
    if (!isLink(next)) throw new Error(`${tag(nid, api[nid])} 的输入 ${route.input} 不再是连接`)
    cur = next
  }
}

// ---------------- 绕过能力判断

export type BypassCheck = { ok: true; entry: NodeBypass } | { ok: false; reason: string }

/** 判断节点能否安全绕过。others：已设置绕过的其他节点。信息不足时一律不支持，并说明原因 */
export function checkBypass(api: ApiWorkflow, nid: string, info: ObjectInfo | null, others: string[] = []): BypassCheck {
  const no = (reason: string): BypassCheck => ({ ok: false, reason })
  const node = api[nid]
  if (!node) return no('工作流中没有这个节点')
  if (node.class_type === LM_TRIGGER_TOGGLE || /trigger/i.test(node.class_type)) return no('触发词节点不做绕过：绕过后上游的全部触发词会直接进入 Prompt。需要关闭注入时请使用工作流检查中的「禁止该节点自动注入触发词」')
  if (!info) return no('没有连接 ComfyUI：API 工作流 JSON 不包含节点的输出类型，无法确认哪个输入可以替代输出')
  const spec = info[node.class_type]
  if (!spec) return no(`当前 ComfyUI 没有「${node.class_type}」的节点定义，无法确认输入输出类型`)
  if (!Array.isArray(spec.output)) return no('节点定义没有声明输出类型')
  if (spec.is_input_list || spec.output_is_list?.some(Boolean)) return no('节点按列表处理输入或输出，绕过后执行次数可能改变')
  const declared = [...Object.keys(spec.input?.required ?? {}), ...Object.keys(spec.input?.optional ?? {})]
  const consumed = [...new Set(consumersOf(api, nid).map((c) => c.output))].sort((a, b) => a - b)
  const routes: NodeBypass['routes'] = []
  for (const out of consumed) {
    const type = spec.output[out]
    if (typeof type !== 'string') return no(`输出 ${out} 的类型未知（节点声明了 ${spec.output.length} 个输出）`)
    if (type === '*') return no(`输出 ${out} 是任意类型（*），无法确认连接`)
    if (spec.output.filter((t) => t === type).length > 1) return no(`有多个 ${type} 类型的输出，无法确认各自对应哪个输入`)
    const cands = declared.filter((k) => inputSpec(spec, k)?.type === type)
    if (!cands.length) return no(`输出 ${out}（${type}）被其他节点使用，但节点没有同类型的输入可以替代`)
    if (cands.length > 1) return no(`输出 ${out}（${type}）有 ${cands.length} 个同类型输入（${cands.join('、')}），无法确定应改接哪一个`)
    const v = node.inputs?.[cands[0]]
    if (!isLink(v)) return no(`输出 ${out}（${type}）对应的输入 ${cands[0]} 没有连接：绕过后下游将没有来源`)
    const upType = info[api[String(v[0])]?.class_type ?? '']?.output?.[v[1]]
    if (upType !== type) return no(`输入 ${cands[0]} 来自 #${v[0]} 的输出 ${v[1]}，类型${upType === undefined ? '未知' : `是 ${String(upType)}`}，无法确认与 ${type} 相同`)
    routes.push({ output: out, input: cands[0], type })
  }
  const gone = new Set([...others, nid])
  if (!Object.keys(api).some((id) => !gone.has(id) && info[api[id].class_type]?.output_node)) return no('绕过后工作流没有输出节点，ComfyUI 会拒绝执行（prompt_no_outputs）')
  return { ok: true, entry: { node: nid, class_type: node.class_type, routes, output_node: !!spec.output_node } }
}

// ---------------- 校验

/** 配置与当前工作流、映射的关系：节点结构变化、类型错误、连接保护、与其他机制的冲突。error 阻止入队 */
export function controlProblems(api: ApiWorkflow, mapping: MappingEntry[], controls: WorkflowControls, info?: ObjectInfo | null): Message[] {
  const out: Message[] = []
  const err = (m: string) => out.push(['error', m])
  const bypassed = new Set(controls.bypass.map((b) => b.node))
  const seen = new Set<string>()
  for (const o of controls.overrides) {
    const node = api[o.node]
    const at = `${tag(o.node, node)} 的 ${o.input}`
    if (!node) {
      err(`节点覆盖：工作流中已没有节点 #${o.node}（配置时是 ${o.class_type}）。节点 ID 或结构可能已变化，请重新设置或删除这条覆盖`)
      continue
    }
    if (node.class_type !== o.class_type) {
      err(`节点覆盖：节点 #${o.node} 现在是 ${node.class_type}，配置时是 ${o.class_type}，不会写入 ${o.input}。请重新设置或删除这条覆盖`)
      continue
    }
    const key = `${o.node}\u0000${o.input}`
    if (seen.has(key)) err(`节点覆盖：${at} 有多条覆盖`)
    seen.add(key)
    if (!(o.input in (node.inputs ?? {}))) {
      err(`节点覆盖：${at} 已不存在。请删除这条覆盖`)
      continue
    }
    const cur = node.inputs[o.input]
    if (isLink(cur)) {
      err(`节点覆盖：${at} 是节点连接（来自 #${cur[0]} 的输出 ${cur[1]}），不能覆盖。请修改上游节点的参数，或删除这条覆盖`)
      continue
    }
    if (bypassed.has(o.node)) err(`节点覆盖：${at} 不会生效，这个节点已设置绕过`)
    for (const m of checkOverrideValue(cur, o.value, inputSpec(info?.[node.class_type], o.input))) err(`节点覆盖：${at}：${m}`)
    const c = inputControl(api, mapping, { overrides: [], bypass: [] }, o.node, o.input)
    if (c.state !== 'original') err(`冲突：${at} 同时由节点覆盖和「${c.label}」控制。请删除覆盖或取消另一方，软件不会替你选择`)
    if (info && !info[node.class_type]) out.push(['warning', `节点覆盖：当前 ComfyUI 没有 ${node.class_type} 的节点定义，无法校验 ${o.input} 的值`])
  }
  for (const b of controls.bypass) {
    const node = api[b.node]
    if (!node) {
      err(`节点绕过：工作流中已没有节点 #${b.node}（配置时是 ${b.class_type}）。请恢复这个节点的设置`)
      continue
    }
    if (node.class_type !== b.class_type) {
      err(`节点绕过：节点 #${b.node} 现在是 ${node.class_type}，配置时是 ${b.class_type}，已确认的连接不再适用。请恢复后重新设置`)
      continue
    }
    if (toggleStructure(node) || node.class_type === LM_TRIGGER_TOGGLE) err(`节点绕过：${tag(b.node, node)} 是触发词节点，不支持绕过，请使用「禁止该节点自动注入触发词」`)
    for (const m of mapping) if (String(m.node) === b.node) err(`节点绕过：${tag(b.node, node)} 已绕过，映射「${sourceLabel(m.source)}」要写入的 ${m.input} 不会生效。请删除这条映射或恢复节点`)
    for (const r of b.routes) if (!isLink(node.inputs?.[r.input])) err(`节点绕过：${tag(b.node, node)} 的输入 ${r.input} 不再是连接，无法改接下游。请恢复后重新设置`)
    const byNode = new Map(controls.bypass.map((x) => [x.node, x]))
    for (const c of consumersOf(api, b.node)) {
      if (bypassed.has(c.node)) continue
      try {
        resolveLink(api, byNode, [b.node, c.output])
      } catch (e) {
        err(`节点绕过：#${c.node} 的 ${c.input} 使用 ${tag(b.node, node)} 的输出 ${c.output}，无法改接：${(e as Error).message}。请恢复后重新设置`)
      }
    }
    if (findLoraLoaders(api).some((l) => l.node === b.node)) out.push(['warning', `节点绕过：${tag(b.node, node)} 已绕过，其中的 LoRA 不会加载`])
    if (info) {
      const r = checkBypass(api, b.node, info, [...bypassed].filter((x) => x !== b.node))
      if (!r.ok) err(`节点绕过：${tag(b.node, node)} 不再满足绕过条件：${r.reason}`)
    }
  }
  if (bypassed.size) {
    const saves = Object.keys(api).filter((id) => typeof api[id].inputs?.filename_prefix === 'string')
    if (saves.length && saves.every((id) => bypassed.has(id))) err('节点绕过：工作流中所有保存节点都被绕过，生成结果不会保存')
    if (Object.keys(api).every((id) => bypassed.has(id))) err('节点绕过：所有节点都被绕过')
  }
  return out
}

/** 只与这次任务有关的问题（节点绕过与任务 LoRA 配置的关系）由 mergeControlInputs 按实际写入值判断 */
export function controlInputs(api: ApiWorkflow, controls: WorkflowControls): InputValue[] {
  if (!hasControls(controls)) return []
  const out: InputValue[] = controls.overrides.map((o) => ({ node: o.node, input: o.input, source: NODE_OVERRIDE, value: o.value }))
  const byNode = new Map(controls.bypass.map((b) => [b.node, b]))
  for (const nid of sortNodeIds(Object.keys(api))) {
    if (byNode.has(nid)) continue
    for (const [input, v] of Object.entries(api[nid].inputs ?? {})) if (isLink(v) && byNode.has(String(v[0]))) out.push({ node: nid, input, source: BYPASS_REWIRE, value: resolveLink(api, byNode, v) })
  }
  for (const b of controls.bypass) out.push({ node: b.node, input: '*', source: NODE_BYPASS, value: true })
  return out
}

/** 把节点控制的写入值接到一张图的写入值之后；同一输入被多个机制写入、或要写入已绕过的节点时报告冲突，不做顺序覆盖 */
export function mergeControlInputs(api: ApiWorkflow, base: InputValue[], ctl: InputValue[]): { inputs: InputValue[]; conflicts: string[] } {
  if (!ctl.length) return { inputs: base, conflicts: [] }
  const conflicts: string[] = []
  const gone = new Set(ctl.filter((x) => x.source === NODE_BYPASS).map((x) => String(x.node)))
  const owned = new Map(ctl.filter((x) => x.source !== NODE_BYPASS).map((x) => [`${x.node}\u0000${x.input}`, x]))
  for (const x of base) {
    if (x.value === null || x.value === undefined) continue
    const nid = String(x.node)
    if (gone.has(nid)) conflicts.push(`节点绕过：${tag(nid, api[nid])} 已绕过，但「${sourceLabel(x.source)}」要写入 ${x.input}，这个值不会生效。请恢复节点，或在任务中取消这项配置`)
    const hit = owned.get(`${nid}\u0000${x.input}`)
    if (hit) conflicts.push(`冲突：${tag(nid, api[nid])} 的 ${x.input} 同时由「${sourceLabel(x.source)}」和「${sourceLabel(hit.source)}」写入，软件不会替你选择`)
  }
  return { inputs: [...base, ...ctl], conflicts }
}

/** 提交前联网复查（冻结在队列中的写入值）：覆盖值是否符合当前 ComfyUI 的声明、绕过后是否还有输出节点 */
export function checkFrozenControls(api: ApiWorkflow, inputs: InputValue[], info: ObjectInfo): Message[] {
  const out: Message[] = []
  for (const x of inputs) {
    if (x.source !== NODE_OVERRIDE && x.source !== 'replica_param') continue
    const node = api[String(x.node)]
    for (const m of checkOverrideValue(node?.inputs?.[x.input], x.value, inputSpec(info[node?.class_type ?? ''], x.input))) out.push(['error', `节点覆盖：${tag(String(x.node), node)} 的 ${x.input}：${m}`])
  }
  const gone = new Set(inputs.filter((x) => x.source === NODE_BYPASS).map((x) => String(x.node)))
  if (gone.size && !Object.keys(api).some((id) => !gone.has(id) && info[api[id].class_type]?.output_node)) out.push(['error', '节点绕过：绕过后工作流没有输出节点，ComfyUI 会拒绝执行'])
  return out
}
