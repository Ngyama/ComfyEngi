// 批量放大：从原图的提交快照恢复生成条件，并计算写入放大工作流的值。
// - 恢复只读取提交快照（实际发送给 ComfyUI 的 API JSON）：沿采样器的 positive / negative 连接回溯到文本编码器，
//   再静态计算文本节点的输出（字符串拼接、正则替换、ImpactWildcardProcessor、已验证结构的 TriggerWord Toggle）。
//   运行时才产生的文本（Loader 输出的触发词、未验证的节点）无法从 JSON 得到，明确列出，不当作已知内容。
// - Checkpoint 与 LoRA 沿第一个采样器的 model 连接回溯；LoRA 保留原来的启用状态与 model / clip 强度。
// - 写入放大工作流的只有：输入图片、正负 Prompt、Checkpoint、LoRA 加载节点（以及工作流自己的节点控制）。
//   Seed、Steps、CFG、采样器、Denoise、upscale_by、tile、Seam Fix、ControlNet 等全部保持放大工作流 JSON 的值。

import {
  activeLoraNames,
  findLoraLoaders,
  isLink,
  isUpscaleMapping,
  loraStackOf,
  loraStackText,
  loraStem,
  nodeTitle,
  parseStack,
  PROMPT_SOURCES,
  sortNodeIds,
  toggleDisableInputs,
  toggleStructure,
  TRIGGER_DISABLE,
  UPSCALE_CHECKPOINT,
  UPSCALE_IMAGE,
  UPSCALE_LORA,
  UPSCALE_OUTPUT,
  UPSCALE_SEED,
  validateMapping,
} from './mapping'
import { controlInputs, controlProblems, controlsOf, mergeControlInputs, withTriggerCuts } from './node-controls'
import { parseJsonLoose } from './prompt-source'
import type { ApiNode, ApiWorkflow, InputValue, MappingEntry, Message, RecoveredGeneration, RecoveredLora, UpscaleIssue, Workflow, WorkflowControls } from './types'
import { encodersOf, findPromptInjectors, findSamplers, TEXT_FIELDS } from './workflow-analysis'

const label = (api: ApiWorkflow, nid: string) => `#${nid}（${api[nid]?.class_type ?? '?'}）`
const unwrap = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) && '__value__' in v ? (v as { __value__: unknown }).__value__ : v)

// ---------------------------------------------------------------- 入队预览（主进程计算，界面显示）

/** 放大来源：运行记录中的一张图，或本机的一个图片文件（二选一） */
export type UpscaleSelection =
  | {
      unit_id: number
      /** 原图在 outputs 中的序号；没有时为预览使用的最终输出 */
      output?: number
    }
  | {
      /** 图片文件的绝对路径 */
      file: string
    }
export const isFileSelection = (s: UpscaleSelection): s is { file: string } => 'file' in s

/** 预览中的一张图 */
export interface UpscaleCandidate {
  key: string
  kind: 'run' | 'file'
  /** 运行记录来源的单元与输出序号；file 来源为 null */
  unit_id: number | null
  output: number | null
  run_name: string
  label: string
  /** 原图文件名与本机路径 */
  name: string
  path: string
  state: 'ok' | 'confirm' | 'blocked'
  issues: UpscaleIssue[]
  positive: string | null
  negative: string | null
  checkpoint: string | null
  loras: RecoveredLora[] | null
  snapshot: 'attempt' | 'rebuilt' | 'file' | null
}

/** 加入放大队列时没有加入的图片 */
export interface UpscaleSkipped {
  key: string
  unit_id: number | null
  file: string | null
  label: string
  reason: string
}

/** 扫描文件夹的结果 */
export interface UpscaleFolderScan {
  files: string[]
  /** 跳过的「放大」子文件夹（放大结果） */
  skipped_dirs: string[]
  /** 图片超过上限，只返回了前面的部分 */
  truncated: boolean
}

export interface UpscalePlan {
  workflow: { id: number; name: string } | null
  errors: string[]
  warnings: string[]
  candidates: UpscaleCandidate[]
}

// ---------------------------------------------------------------- 文本节点的静态计算

export interface TextResult {
  text: string
  /** 完全由快照确定 */
  exact: boolean
  /** 运行时才产生、无法得到的部分（节点说明） */
  runtime: string[]
  /** 按已知插件逻辑推断的部分 */
  inferred: string[]
  /** 经过的节点 */
  nodes: string[]
}

/** 只有一个文本字段、直接输出它的节点 */
const LITERAL_NODES = new Set(['PrimitiveString', 'PrimitiveStringMultiline', 'String', 'StringMultiline', 'Text Multiline', 'easy string', 'CR Text', 'Text box'])
const WILDCARD_SYNTAX = /__[^\s_][^\s]*?__|\{[^{}]*\|[^{}]*\}/

const merge = (parts: TextResult[], text: string, nodes: string[]): TextResult => ({
  text,
  exact: parts.every((p) => p.exact),
  runtime: parts.flatMap((p) => p.runtime),
  inferred: parts.flatMap((p) => p.inferred),
  nodes: [...nodes, ...parts.flatMap((p) => p.nodes)],
})

interface EvalContext {
  /** 入队时冻结的原始工作流：判断 TriggerWord Toggle 的来源 Loader 是否与保存时相同 */
  original?: ApiWorkflow | null
}

// ---------------- TriggerWord Toggle (LoraManager)
// 与插件 py/nodes/trigger_word_toggle.py（ComfyUI-Lora-Manager，2026-04-21 的 79dd9a1）的 process_trigger_words 逐分支对应：
//   覆盖判断 → toggle_trigger_words 为空时输出 orinalMessage → 列表：组模式（有子项 / 允许调整权重 / 不允许）或非组模式
//   → 不是列表时按 orinalMessage 拆分（fallback）。插件处理列表出错时记录日志并输出 orinalMessage，这里同样处理。
// 无法确认与 Python 结果相同的情况（例如文本含 \r，Python 与 JS 的正则 . 不同）返回 error，不猜测。

/** JS 正则中 . / ^ / $ 视为换行、而 Python 不视为换行的字符 */
const JS_LINE_BREAK = new RegExp('[\\r\\u2028\\u2029]')
/** Python 的 str.isspace 字符（strip() 去掉的字符；与 JS 的 \s 不完全相同：JS 含 U+FEFF，不含 \x1c-\x1f 与 \x85） */
const PY_SPACE = '\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'
const PY_STRIP = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, 'g')
const pyStrip = (s: string) => s.replace(PY_STRIP, '')
/** Python 的真值判断（bool(x)） */
const pyTruthy = (v: unknown) => !(v === false || v === null || v === undefined || v === 0 || v === '' || (Array.isArray(v) && !v.length) || (!!v && typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length))
/** Python 的 f"{x:.2f}"：恰好在两位小数中间时按银行家舍入（JS 的 toFixed 向上），其他情况两者相同 */
function pyFixed2(x: number): string {
  const s = x * 100
  const f = Math.floor(s)
  // x * 8 为整数时 x * 100 精确，才可能恰好在中间
  if (Number.isInteger(x * 8) && s - f === 0.5) return ((f % 2 === 0 ? f : f + 1) / 100).toFixed(2)
  return x.toFixed(2)
}
/** Python float()：只接受十进制数字与一个小数点（插件的正则只会给出 [\d.]+） */
const pyFloat = (s: string) => (/^(\d+\.?\d*|\.\d+)$/.test(s) ? Number(s) : null)

/** 插件处理时会抛出异常的情况（AttributeError / ValueError 等）：插件输出 orinalMessage */
class PyError extends Error {}
/** 无法确认与插件结果相同 */
class Unknowable extends Error {}

interface TriggerItem {
  text: string
  active: boolean
  strength: unknown
}

/** _parse_trigger_item：text 去空白；text 为 (词:权重) 时拆出词与权重（strength 为 null 时才用拆出的权重）；不允许调整权重时 strength 为 null */
function parseTriggerItem(item: unknown, allow: boolean): TriggerItem {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new PyError('item.get')
  const o = item as Record<string, unknown>
  const raw = pyTruthy(o.text) ? o.text : ''
  if (typeof raw !== 'string') throw new PyError('strip')
  let text = pyStrip(raw)
  let strength = o.strength ?? null
  // Python 的 . 不匹配 \n，JS 还不匹配 \r、U+2028、U+2029；Python 的 \d 还匹配其他文字的数字
  if (JS_LINE_BREAK.test(text) || /(?![0-9])\p{Nd}/u.test(text)) throw new Unknowable(`触发词「${text.slice(0, 30)}」含有特殊字符`)
  const m = /^\((.+):([\d.]+)\)$/.exec(text)
  if (m) {
    text = pyStrip(m[1])
    if (strength === null) strength = pyFloat(m[2])
  }
  return { text, active: pyTruthy(o.active ?? false), strength: allow ? strength : null }
}

/** _format_word_output：允许调整权重且有权重时输出 (词:权重两位小数) */
function formatTriggerWord(base: string, strength: unknown, allow: boolean): string {
  if (!allow || strength === null) return base
  if (typeof strength === 'boolean') return `(${base}:${pyFixed2(Number(strength))})`
  if (typeof strength !== 'number' || !Number.isFinite(strength)) throw new PyError('format')
  return `(${base}:${pyFixed2(strength)})`
}

/** _normalize_trigger_words：按 ,{2,} 分组再按 , 分词、去空白、去空串后的集合 */
function normalizeTriggerWords(s: unknown): Set<string> {
  if (typeof s !== 'string' || !s) return new Set()
  return new Set(s.split(/,{2,}/).flatMap((g) => g.split(',')).map(pyStrip).filter(Boolean))
}

/**
 * TriggerWord Toggle (LoraManager) 的输出。
 * inputs：节点的输入（快照中的值）；override：trigger_words 输入的值（连接时为它在运行时收到的文本，未知时由调用方处理）。
 */
export function triggerToggleOutput(inputs: Record<string, unknown>, override: unknown): { text: string } | { error: string } {
  const om = unwrap(inputs.orinalMessage)
  const original = typeof om === 'string' ? om : ''
  const ov = unwrap(override)
  if (pyTruthy(ov) && typeof ov === 'string') {
    const a = normalizeTriggerWords(ov)
    const b = normalizeTriggerWords(original)
    if (a.size !== b.size || [...a].some((w) => !b.has(w))) return { text: ov }
  }
  let data = 'toggle_trigger_words' in inputs ? unwrap(inputs.toggle_trigger_words) : null
  if (!pyTruthy(data)) return { text: original }
  const groupMode = pyTruthy(inputs.group_mode)
  const allow = pyTruthy(inputs.allow_strength_adjustment ?? false)
  try {
    if (typeof data === 'string') {
      try {
        data = parseJsonLoose(data)
      } catch {
        throw new PyError('json.loads')
      }
    }
    if (!Array.isArray(data)) {
      // 不是列表：按 orinalMessage 拆分
      const parts = groupMode ? original.split(/,{2,}/).map(pyStrip).filter(Boolean) : original.split(',').map(pyStrip).filter(Boolean)
      return { text: parts.join(', ') }
    }
    const list: unknown[] = data
    const hasItems = (x: unknown) => !!x && typeof x === 'object' && !Array.isArray(x) && Array.isArray((x as Record<string, unknown>).items)
    let out: string[]
    if (groupMode && list.some(hasItems)) {
      // _process_group_items：启用的组输出启用的子项（子项不带权重，按 ", " 拼接），没有启用的子项时跳过该组；组的权重套在外层
      out = []
      for (const item of list) {
        const g = parseTriggerItem(item, allow)
        if (!g.text || !g.active) continue
        let text = g.text
        if (hasItems(item)) {
          const active = ((item as Record<string, unknown>).items as unknown[]).map((c) => parseTriggerItem(c, false)).filter((c) => c.text && c.active)
          if (!active.length) continue
          text = active.map((c) => c.text).join(', ')
        }
        out.push(formatTriggerWord(text, g.strength, allow))
      }
    } else if (groupMode && !allow) {
      // 组模式、不允许调整权重：组的 text 原样输出（不拆分 (词:权重)）
      out = list
        .map((item) => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) throw new PyError('item.get')
          const o = item as Record<string, unknown>
          const raw = pyTruthy(o.text) ? o.text : ''
          if (typeof raw !== 'string') throw new PyError('strip')
          return { text: pyStrip(raw), active: pyTruthy(o.active ?? false) }
        })
        .filter((x) => x.text && x.active)
        .map((x) => x.text)
    } else {
      // 组模式且允许调整权重，或非组模式：逐项解析权重后输出
      out = list
        .map((item) => parseTriggerItem(item, allow))
        .filter((x) => x.text && x.active)
        .map((x) => formatTriggerWord(x.text, x.strength, allow))
    }
    return { text: out.join(', ') }
  } catch (e) {
    if (e instanceof PyError) return { text: original }
    if (e instanceof Unknowable) return { error: e.message }
    throw e
  }
}

// ---------------- RegexReplace（ComfyUI 内置节点：re.sub(regex_pattern, replace, string, count=count, flags=…)）

/** 含 UTF-16 代理对的字符：JS（不带 u 标志）的 . 与字符类按半个字符匹配，Python 按一个字符 */
const SURROGATE = new RegExp('[\\uD800-\\uDFFF]')
/** Python 的 \w \d \s \b 按 Unicode 判断，JS 只按 ASCII（\s 也不含 \x1c-\x1f） */
const UNICODE_CLASS_TEXT = /[^\x00-\x1b\x20-\x7f]/
/** 不区分大小写时 Python（Unicode 大小写折叠）与 JS（不带 u 标志，按 toUpperCase）结果可能不同的字符 */
const CASE_SPECIAL = new RegExp('[\\u00df\\u017f\\u0130\\u0131\\u1e9e\\u212a\\u212b]')

/**
 * Python 正则 → JS 正则。只转换能确认等价的写法：
 * - 字符类外、未转义的 $：非多行模式下 Python 的 $ 匹配结尾或结尾换行符之前的位置，转为 (?=\n?$)；多行模式两者相同；
 * - ^、. 以及其他转义与量词按原样（调用方另外排除了换行符、Unicode 字符类等差异）。
 * Python 特有或含义不同的写法返回 null：命名组 (?P…) / (?<…>)、行内标志、注释、条件、原子组、{,n}、\A \Z 等转义、反向引用、
 * 字符类内的 $、转义的 \$、$ 后跟量词、以 ] 开头的字符类。
 */
export function pyPatternToJs(p: string, multiline: boolean): string | null {
  if (/\(\?(P|<[A-Za-z_]|[aiLmsux-]+[):]|#|\(|>)/.test(p) || /\{,/.test(p)) return null
  let out = ''
  let inClass = false
  for (let k = 0; k < p.length; k++) {
    const c = p[k]
    if (c === '\\') {
      const d = p[k + 1]
      if (d === undefined || d === '$' || /[0-9]/.test(d)) return null
      if (/[A-Za-z]/.test(d)) {
        if (d === 'x') {
          if (!/^[0-9a-fA-F]{2}$/.test(p.slice(k + 2, k + 4))) return null
        } else if (d === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(p.slice(k + 2, k + 6))) return null
        } else if (!'bBdDfnrsStvwW'.includes(d) || (inClass && d === 'B')) return null
      }
      out += c + d
      k++
      continue
    }
    if (inClass) {
      if (c === '$') return null
      if (c === ']') inClass = false
      out += c
      continue
    }
    if (c === '[') {
      inClass = true
      out += c
      if (p[k + 1] === '^') {
        out += '^'
        k++
      }
      if (p[k + 1] === ']') return null
      continue
    }
    if (c === '$') {
      if (/[*+?{]/.test(p[k + 1] ?? '')) return null
      out += multiline ? '$' : '(?=\\n?$)'
      continue
    }
    out += c
  }
  return inClass ? null : out
}

/** Python re.sub 转为 JS；无法确认结果相同时返回 null（不猜测） */
export function pyRegexReplace(s: string, pattern: string, repl: string, flags: { i: boolean; m: boolean; s: boolean }, count: number): string | null {
  // 替换文本：Python 处理其中的反斜杠转义（\n、\1、\g<…>）；$ 在两者中都是字面量（这里用函数返回替换文本，JS 不解释 $）
  if (repl.includes('\\')) return null
  // JS 的 . ^ $ 还把 \r、U+2028、U+2029 当作换行，Python 只认 \n
  if (JS_LINE_BREAK.test(s) && /[.^$]/.test(pattern)) return null
  if (UNICODE_CLASS_TEXT.test(s) && /\\[wWbBdDsS]/.test(pattern)) return null
  if (SURROGATE.test(s) && /[.[]|\\[WDS]/.test(pattern)) return null
  if (flags.i && (/[^\x00-\x7f]/.test(pattern) || CASE_SPECIAL.test(s))) return null
  const js = pyPatternToJs(pattern, flags.m)
  if (js === null) return null
  let re: RegExp
  try {
    re = new RegExp(js, `g${flags.i ? 'i' : ''}${flags.m ? 'm' : ''}${flags.s ? 's' : ''}`)
  } catch {
    return null
  }
  // count=0 替换全部，否则只替换前 count 处（与 re.sub 相同）
  let n = 0
  return s.replace(re, (m) => (count > 0 && n >= count ? m : (n++, repl)))
}

export function evalText(api: ApiWorkflow, v: unknown, ctx: EvalContext = {}, seen: Set<string> = new Set()): TextResult {
  if (typeof v === 'string') return { text: v, exact: true, runtime: [], inferred: [], nodes: [] }
  const fail = (why: string, nodes: string[] = []): TextResult => ({ text: '', exact: false, runtime: [why], inferred: [], nodes })
  if (!isLink(v)) return fail(`非文本值 ${JSON.stringify(v)?.slice(0, 40)}`)
  const [nid, out] = [String(v[0]), v[1]]
  const n = api[nid]
  if (!n) return fail(`节点 #${nid} 不存在`)
  if (seen.has(nid)) return fail(`${label(api, nid)} 循环连接`, [nid])
  const next = new Set(seen).add(nid)
  const i = n.inputs ?? {}
  const sub = (x: unknown) => evalText(api, x, ctx, next)
  const ct = n.class_type
  if (out !== 0 && !(isLink(i.model) || isLink(i.clip))) return fail(`${label(api, nid)} 的第 ${out + 1} 个输出`, [nid])

  if (ct === 'StringConcatenate') {
    const parts = [sub(i.string_a), sub(i.delimiter ?? ''), sub(i.string_b)]
    return merge(parts, `${parts[0].text}${parts[1].text}${parts[2].text}`, [nid])
  }
  if (ct === 'RegexReplace') {
    const s = sub(i.string)
    // 可选输入的默认值与节点相同：case_insensitive=True、multiline=False、dotall=False、count=0
    const opt = ['case_insensitive', 'multiline', 'dotall', 'count']
    const lit = [i.regex_pattern, i.replace].every((x) => typeof x === 'string') && !opt.some((k) => isLink(i[k])) && (i.count == null || Number.isInteger(i.count))
    const flags = { i: pyTruthy(i.case_insensitive ?? true), m: pyTruthy(i.multiline ?? false), s: pyTruthy(i.dotall ?? false) }
    const r = lit ? pyRegexReplace(s.text, String(i.regex_pattern), String(i.replace), flags, Number(i.count ?? 0)) : null
    if (r === null) return { ...merge([s], s.text, [nid]), exact: false, runtime: [...s.runtime, `${label(api, nid)} 的正则替换无法在 ComfyEngi 中按相同规则计算`] }
    return merge([s], r, [nid])
  }
  if (ct === 'ImpactWildcardProcessor') {
    // 通过 API 执行时输出 populated_text（populate 模式下由网页界面在提交前填写，ComfyEngi 映射时两个字段都写入）
    const p = sub(i.populated_text)
    const res = merge([p], p.text, [nid])
    if (WILDCARD_SYNTAX.test(p.text)) res.inferred.push(`${label(api, nid)} 的 populated_text 含通配符语法，按原样输出处理`)
    return res
  }
  const toggle = toggleStructure(n)
  if (toggle) {
    // 与 ComfyUI-Lora-Manager 的 trigger_word_toggle.py 相同的分支（见 triggerToggleOutput）
    const linked = ['group_mode', 'allow_strength_adjustment', 'toggle_trigger_words', 'orinalMessage'].filter((k) => isLink(i[k]))
    if (linked.length) return fail(`${label(api, nid)} 的 ${linked.join('、')} 是连接，不是快照中的值，输出在运行时决定`, [nid])
    const inferred: string[] = []
    if ('allow_strength_adjustment' in i && typeof i.allow_strength_adjustment !== 'boolean')
      inferred.push(`${label(api, nid)} 的 allow_strength_adjustment 不是布尔值（${JSON.stringify(i.allow_strength_adjustment).slice(0, 40)}），按 Python 的真值规则视为开启`)
    let override: unknown = i.trigger_words
    if (isLink(i.trigger_words)) {
      // trigger_words 在运行时由 LoRA Loader 输出（它加载的 LoRA 的触发词）。插件的网页界面在 Loader 变化时把同样的触发词写入 orinalMessage，
      // 所以 Loader 加载的 LoRA 与工作流保存时相同时，两者的词集合相同，不会触发覆盖
      const loader = String(i.trigger_words[0])
      const orig = ctx.original?.[loader]
      if (!orig || !api[loader] || activeLoraNames(api[loader]).join('\n') !== activeLoraNames(orig).join('\n'))
        return fail(`${label(api, nid)} 输出 LoRA 触发词（来自 ${label(api, loader)}，加载的 LoRA 与工作流保存时不同，插件会绕过开关输出全部触发词），内容在运行时由插件读取`, [nid])
      inferred.push(`${label(api, nid)} 的输出按节点中记录的触发词（orinalMessage）与开关状态推断（假定 ${label(api, loader)} 运行时输出的触发词与记录的相同）`)
      override = null
    }
    const r = triggerToggleOutput(i, override)
    if ('error' in r) return fail(`${label(api, nid)} 的输出无法确认与插件的计算结果相同：${r.error}`, [nid])
    return { text: r.text, exact: !inferred.length, runtime: [], inferred, nodes: [nid] }
  }
  if (isLink(i.model) || isLink(i.clip)) return fail(`${label(api, nid)} 的文本输出（LoRA 触发词 / 已加载列表）在运行时产生`, [nid])
  if (/trigger/i.test(ct)) return fail(`${label(api, nid)} 是结构未验证的触发词节点，输出在运行时产生`, [nid])
  const links = Object.entries(i).filter(([, x]) => isLink(x))
  const field = TEXT_FIELDS.find((f) => typeof i[f] === 'string')
  if (!links.length && field) {
    const res: TextResult = { text: String(i[field]), exact: true, runtime: [], inferred: [], nodes: [nid] }
    if (!LITERAL_NODES.has(ct)) res.inferred.push(`${label(api, nid)} 按它的文本字段「${field}」推断输出`)
    return res
  }
  return fail(`${label(api, nid)} 的输出无法从 JSON 静态确定`, [nid])
}

/** 编码器实际编码的文本 */
function encoderText(api: ApiWorkflow, enc: string, ctx: EvalContext): TextResult {
  const i = api[enc].inputs
  const fields = TEXT_FIELDS.filter((f) => f in i)
  const r = evalText(api, i[fields[0]], ctx)
  const res = { ...r, nodes: [enc, ...r.nodes] }
  if (fields.length > 1) res.inferred = [...res.inferred, `${label(api, enc)} 有多个文本字段（${fields.join('、')}），只恢复「${fields[0]}」`]
  return res
}

// ---------------------------------------------------------------- 原图生成条件的恢复

interface ModelChain {
  checkpoint: string | null
  unet: string | null
  loras: RecoveredLora[]
  issues: UpscaleIssue[]
  /** 原始的多 LoRA 条目（保留插件的其他字段） */
  raw: Map<RecoveredLora, Record<string, unknown>>
}

/** 沿 model 连接向上游回溯：Checkpoint 与途中的 LoRA Loader（按加载顺序） */
function modelChain(api: ApiWorkflow, start: unknown, ctx: EvalContext): ModelChain {
  const res: ModelChain = { checkpoint: null, unet: null, loras: [], issues: [], raw: new Map() }
  const found: RecoveredLora[][] = []
  let link = start
  const seen = new Set<string>()
  while (isLink(link)) {
    const nid = String(link[0])
    if (seen.has(nid)) break
    seen.add(nid)
    const n = api[nid]
    if (!n) {
      res.issues.push({ level: 'confirm', text: `原图模型链上的节点 #${nid} 不存在` })
      break
    }
    const i = n.inputs ?? {}
    if ('ckpt_name' in i) {
      const t = evalText(api, i.ckpt_name, ctx)
      if (t.exact && t.text) res.checkpoint = t.text
      else res.issues.push({ level: 'confirm', text: `原图的 Checkpoint 节点 ${label(api, nid)} 的模型名称无法从快照确定` })
      break
    }
    if ('unet_name' in i) {
      res.unet = typeof i.unet_name === 'string' ? i.unet_name : null
      break
    }
    const ld = findLoraLoaders({ [nid]: n })[0]
    if (ld?.support === 'stack') {
      const raws = loraStackOf(n) ?? []
      const items = parseStack(raws).map((e, k) => {
        const r: RecoveredLora = { name: e.name, strength: e.strength, clip: e.clipStrength, active: e.active, node: nid, kind: 'stack' }
        res.raw.set(r, raws[k])
        return r
      })
      found.push(items)
    } else if (ld && (ld.support === 'standard' || ld.support === 'compatible')) {
      if (typeof i.lora_name !== 'string') res.issues.push({ level: 'confirm', text: `原图的 LoRA 节点 ${label(api, nid)} 的名称不是固定值，无法恢复` })
      else {
        const sm = typeof i.strength_model === 'number' ? i.strength_model : typeof i[ld.strengths[0]] === 'number' ? Number(i[ld.strengths[0]]) : 1
        const sc = typeof i.strength_clip === 'number' ? i.strength_clip : sm
        found.push([{ name: i.lora_name, strength: sm, clip: sc, active: !(sm === 0 && sc === 0), node: nid, kind: 'standard' }])
      }
    } else if (ld) res.issues.push({ level: 'confirm', text: `原图模型链上的 ${label(api, nid)} 看起来是 LoRA 节点，但结构无法识别，它加载的 LoRA 不会恢复` })
    if (isLink(i.model)) link = i.model
    else {
      // ImpactSwitch 等选择节点：按选择的输入继续
      const sel = Number(i.select)
      const pick = Number.isInteger(sel) ? i[`input${sel}`] : undefined
      const links = Object.entries(i).filter(([, x]) => isLink(x))
      link = isLink(pick) ? pick : links.length === 1 ? links[0][1] : null
      if (!isLink(link)) res.issues.push({ level: 'confirm', text: `原图模型链在 ${label(api, nid)} 处无法继续回溯，找不到 Checkpoint` })
    }
  }
  res.loras = found.reverse().flat()
  return res
}

const loraSig = (l: RecoveredLora[]) => l.map((x) => `${loraStem(x.name).toLowerCase()}:${x.strength}:${x.clip}:${x.active ? 1 : 0}`).join('|')

/**
 * 从提交给 ComfyUI 的工作流（graph）恢复原图的生成条件。
 * original：入队时冻结的原始工作流（判断触发词节点）；promptNodes：原图任务映射写入 Prompt 的节点（有多个不同的 Prompt 时用来选择）
 */
export function recoverGeneration(graph: ApiWorkflow, opts: { original?: ApiWorkflow | null; promptNodes?: { positive: string[]; negative: string[] } } = {}): RecoveredGeneration & { raw: Map<RecoveredLora, Record<string, unknown>> } {
  const ctx: EvalContext = { original: opts.original }
  const issues: UpscaleIssue[] = []
  const samplers = findSamplers(graph)
  const empty = { positive: null, negative: null, positive_exact: false, negative_exact: false, checkpoint: null, loras: null, seed: null, seed_note: '原图的工作流中找不到采样器', issues, raw: new Map() }
  if (!samplers.length) {
    issues.push({ level: 'block', text: '原图的工作流中找不到采样器，无法确定 Prompt、Checkpoint 与 LoRA' })
    return empty
  }
  const pick = (pol: 'positive' | 'negative') => {
    const encs: { enc: string; sampler: string }[] = []
    for (const s of samplers) for (const e of encodersOf(graph, graph[s].inputs[pol] as [string, number])) if (!encs.some((x) => x.enc === e)) encs.push({ enc: e, sampler: s })
    if (!encs.length) return null
    const evals = encs.map((x) => ({ ...x, r: encoderText(graph, x.enc, ctx) }))
    const distinct = [...new Set(evals.map((x) => x.r.text))]
    let chosen = evals[0]
    if (distinct.length > 1) {
      const mapped = new Set(opts.promptNodes?.[pol] ?? [])
      chosen = evals.find((x) => x.r.nodes.some((nd) => mapped.has(nd))) ?? evals[0]
      issues.push({ level: 'note', text: `原图工作流有 ${distinct.length} 个不同的${pol === 'positive' ? '正面' : '负面'} Prompt 编码器，使用 ${label(graph, chosen.enc)}（采样器 ${label(graph, chosen.sampler)} 使用的）` })
    }
    return chosen
  }
  const pos = pick('positive')
  const neg = pick('negative')
  const word = { positive: '正面', negative: '负面' }
  for (const [pol, c] of [['positive', pos], ['negative', neg]] as const) {
    if (!c) {
      issues.push({ level: 'block', text: `原图工作流中找不到${word[pol]} Prompt 的文本编码器` })
      continue
    }
    if (c.r.runtime.length)
      issues.push({ level: 'confirm', text: `原图的${word[pol]} Prompt 中有运行时才产生的文本，无法从提交快照得到：${c.r.runtime.join('；')}。放大时只写入能确定的部分` })
    for (const t of c.r.inferred) issues.push({ level: 'note', text: `${word[pol]} Prompt：${t}` })
  }
  // Checkpoint 与 LoRA：使用正面 Prompt 所在的第一个采样器
  const primary = pos?.sampler ?? samplers[0]
  const chain = modelChain(graph, graph[primary].inputs.model, ctx)
  issues.push(...chain.issues)
  if (chain.unet) issues.push({ level: 'note', text: `原图使用 UNET 加载节点（${chain.unet}），没有 Checkpoint 名称` })
  for (const s of samplers) {
    if (s === primary) continue
    const other = modelChain(graph, graph[s].inputs.model, ctx)
    if (other.checkpoint !== chain.checkpoint || loraSig(other.loras) !== loraSig(chain.loras))
      issues.push({ level: 'note', text: `原图的采样器 ${label(graph, s)} 使用的模型或 LoRA 与 ${label(graph, primary)} 不同；放大按 ${label(graph, primary)} 恢复` })
  }
  return {
    positive: pos ? pos.r.text : null,
    negative: neg ? neg.r.text : null,
    positive_exact: !!pos?.r.exact,
    negative_exact: !!neg?.r.exact,
    checkpoint: chain.checkpoint,
    loras: chain.loras,
    ...originalSeed(graph, samplers),
    issues,
    raw: chain.raw,
  }
}

const isSeed = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
/** 只输出自己的一个整数值的节点（种子节点、整数常量） */
const SEED_SOURCE_CLASSES = new Set(['SeedNode', 'easy int', 'easy seed', 'PrimitiveInt'])

/**
 * 原图第一个采样器（上游没有其他采样器的那个）的 Seed。只接受字面值，或连接到只输出一个整数的节点（SeedNode、easy int、PrimitiveInt 等，
 * 节点没有连接输入、只有一个数字输入）；其他情况（运算节点、随机节点、超出 JSON 能精确表示的范围）返回 null 与原因，不猜测。
 */
function originalSeed(graph: ApiWorkflow, samplers: string[]): { seed: number | null; seed_note: string } {
  const ups = new Map(samplers.map((s) => [s, upstreamOf(graph, s)]))
  const first = samplers.find((s) => !samplers.some((o) => o !== s && ups.get(s)!.has(o))) ?? samplers[0]
  const inputs = graph[first].inputs
  const key = 'seed' in inputs ? 'seed' : 'noise_seed' in inputs ? 'noise_seed' : null
  const at = `原图第一个采样器 ${label(graph, first)}`
  if (!key) return { seed: null, seed_note: `${at} 没有 seed / noise_seed 输入` }
  const v = inputs[key]
  if (isSeed(v)) return { seed: v, seed_note: `${at} 的 ${key}` }
  if (!isLink(v)) return { seed: null, seed_note: `${at} 的 ${key} 不是可以精确确定的非负整数（${JSON.stringify(v)}）` }
  const nid = String(v[0])
  const n = graph[nid]
  if (!n) return { seed: null, seed_note: `${at} 的 ${key} 连接的节点 #${nid} 不存在` }
  const vals = Object.values(n.inputs ?? {})
  const nums = vals.filter((x): x is number => typeof x === 'number')
  if (!SEED_SOURCE_CLASSES.has(n.class_type) || Number(v[1]) !== 0 || vals.some(isLink) || nums.length !== 1)
    return { seed: null, seed_note: `${at} 的 ${key} 来自 ${label(graph, nid)}，不是只输出一个整数的节点（支持 ${[...SEED_SOURCE_CLASSES].join('、')}），无法从快照确定实际使用的值` }
  if (!isSeed(nums[0])) return { seed: null, seed_note: `${at} 的 ${key} 来自 ${label(graph, nid)}，值 ${nums[0]} 不是可以精确确定的非负整数` }
  return { seed: nums[0], seed_note: `${at} 的 ${key}，来自 ${label(graph, nid)}` }
}

/** 节点的全部上游节点 */
function upstreamOf(graph: ApiWorkflow, nid: string): Set<string> {
  const out = new Set<string>()
  const stack = [nid]
  while (stack.length) {
    const cur = stack.pop()!
    for (const v of Object.values(graph[cur]?.inputs ?? {}))
      if (isLink(v) && !out.has(String(v[0]))) {
        out.add(String(v[0]))
        stack.push(String(v[0]))
      }
  }
  return out
}

// ---------------------------------------------------------------- 放大工作流

type UpWorkflow = Pick<Workflow, 'name' | 'api_json' | 'mapping'> & { controls?: WorkflowControls | null }

/** 放大工作流本身的问题（与具体图片无关）：映射、节点控制、Prompt 路径上的注入节点、没有映射的 LoRA 节点 */
export function upscaleWorkflowProblems(wf: UpWorkflow): Message[] {
  const api = wf.api_json ?? {}
  const mapping = wf.mapping ?? []
  if (!isUpscaleMapping(mapping)) return [['error', `工作流「${wf.name}」没有映射「放大：输入图片」，不是放大工作流。请在工作流页面的高级映射中添加放大映射`]]
  const controls = controlsOf(wf)
  const out: Message[] = [...validateMapping(api, mapping), ...controlProblems(api, mapping, controls)]
  const gone = new Set(controls.bypass.map((b) => b.node))
  for (const inj of findPromptInjectors(withTriggerCuts(api, controls), mapping)) {
    if (!inj.polarity.length || inj.disabled || gone.has(inj.node)) continue
    out.push(['warning', inj.kind === 'trigger_toggle' ? `放大工作流的 ${label(api, inj.node)} 位于 Prompt 路径上：写入原图的 LoRA 列表后，插件可能绕过开关注入全部触发词，放大时的 Prompt 会与原图不同。可在工作流检查中禁止它注入` : `放大工作流：${inj.message}`])
  }
  const loraNode = mapping.find((m) => m.source === UPSCALE_LORA)?.node
  for (const ld of findLoraLoaders(api)) if (String(ld.node) !== String(loraNode) && !gone.has(ld.node)) out.push(['warning', `放大工作流中的 LoRA 节点 ${label(api, ld.node)} 没有映射为「放大：LoRA 加载节点」：它保持工作流原值，会和原图的 LoRA 一起加载`])
  // 不使用输入图片的输出节点：ComfyUI 执行 API 工作流中的全部输出节点，它与它的上游（例如前半段的采样）每张图都会多运行一次
  const image = mapping.find((m) => m.source === UPSCALE_IMAGE)?.node
  if (image != null && api[String(image)]) {
    const down = new Set([String(image)])
    for (let grew = true; grew; ) {
      grew = false
      for (const [nid, n] of Object.entries(api))
        if (!down.has(nid) && Object.values(n.inputs ?? {}).some((v) => isLink(v) && down.has(String(v[0])))) {
          down.add(nid)
          grew = true
        }
    }
    for (const nid of sortNodeIds(Object.keys(api))) {
      const n = api[nid]
      const isOutput = typeof n.inputs?.filename_prefix === 'string' || /^(Save|Preview)Image/.test(n.class_type)
      if (isOutput && !down.has(nid) && !gone.has(nid))
        out.push(['warning', `放大工作流的输出节点 ${label(api, nid)} 不使用输入图片 ${label(api, String(image))}：ComfyUI 会执行它和它上游的节点（例如前半段的采样），每张图都会多运行一次。可以在工作流的节点控制中绕过它，或从放大工作流中删除`])
    }
  }
  return out
}

/** 放大工作流的最终输出节点 */
export const upscaleOutputNodes = (mapping: MappingEntry[]) => [...new Set(mapping.filter((m) => m.source === UPSCALE_OUTPUT).map((m) => String(m.node)))]

/**
 * 一张图写入放大工作流的值。只写入映射的输入图片、正负 Prompt、Checkpoint、LoRA 加载节点、禁止触发词注入、「放大：Seed」与工作流的节点控制，
 * 其他映射（生成用的 Seed、尺寸、文件名前缀、LoRA 槽位）一律不写入。有 block 级问题时 inputs 为 null。
 */
export function upscaleInputs(wf: UpWorkflow, rec: RecoveredGeneration & { raw?: Map<RecoveredLora, Record<string, unknown>> }, image: string): { inputs: InputValue[] | null; issues: UpscaleIssue[] } {
  const api = wf.api_json ?? {}
  const mapping = wf.mapping ?? []
  const issues: UpscaleIssue[] = []
  const block = (text: string) => issues.push({ level: 'block', text })
  const out: InputValue[] = []
  let seedNoted = false
  for (const e of mapping) {
    const node = String(e.node)
    const n: ApiNode | undefined = api[node]
    if (PROMPT_SOURCES.includes(e.source)) {
      const v = e.source === 'positive' ? rec.positive : rec.negative
      if (v === null) block(`无法确定原图的${e.source === 'positive' ? '正面' : '负面'} Prompt`)
      else out.push({ node, input: e.input, source: e.source, value: v })
    } else if (e.source === UPSCALE_IMAGE) out.push({ node, input: e.input, source: e.source, value: image })
    else if (e.source === UPSCALE_OUTPUT) out.push({ node, input: e.input, source: e.source, value: null })
    else if (e.source === UPSCALE_CHECKPOINT) {
      if (!rec.checkpoint) block('无法确定原图使用的 Checkpoint（放大工作流映射了「放大：Checkpoint 名称」）')
      else out.push({ node, input: e.input, source: e.source, value: rec.checkpoint })
    } else if (e.source === UPSCALE_LORA) {
      if (!rec.loras) {
        block('无法确定原图加载的 LoRA')
        continue
      }
      const stack = loraStackOf(n)
      if (stack) {
        // 替换为原图的 LoRA 列表：名称、启用状态、model / clip 强度都与原图相同，原来未启用的仍未启用。
        // 有原图条目时原样使用（插件界面保存的强度可能是 "1.20" 这样的文本，保持原来的写法）
        const list = rec.loras.map((l) => {
          const raw = rec.raw?.get(l)
          return raw ? { ...raw, active: l.active } : { expanded: false, selected: false, locked: false, name: loraStem(l.name), strength: l.strength, clipStrength: l.clip, active: l.active }
        })
        out.push({ node, input: 'loras', source: UPSCALE_LORA, value: { ...(n!.inputs.loras as object), __value__: list } })
        if (typeof n!.inputs.text === 'string') out.push({ node, input: 'text', source: UPSCALE_LORA, value: loraStackText(list) })
        continue
      }
      const ld = n ? findLoraLoaders({ [node]: n })[0] : undefined
      if (!n || !ld || typeof n.inputs.lora_name !== 'string') {
        block(`放大工作流的「放大：LoRA 加载节点」#${node} 不是可写入的 LoRA Loader`)
        continue
      }
      const active = rec.loras.filter((l) => l.active)
      if (active.length > 1) {
        block(`原图启用了 ${active.length} 个 LoRA（${active.map((l) => loraStem(l.name)).join('、')}），放大工作流的 LoRA 节点 ${label(api, node)} 只能加载一个：请在放大工作流中改用 Lora Loader (LoraManager)`)
        continue
      }
      const l = active[0]
      let name = String(n.inputs.lora_name)
      if (l) {
        if (l.kind === 'standard') name = l.name
        else if (loraStem(name).toLowerCase() !== loraStem(l.name).toLowerCase()) {
          block(`原图的 LoRA「${l.name}」来自多 LoRA 列表（只有文件名，没有 ComfyUI 中的相对路径），无法写入单 LoRA Loader ${label(api, node)}：请在放大工作流中改用 Lora Loader (LoraManager)`)
          continue
        }
      }
      out.push({ node, input: 'lora_name', source: UPSCALE_LORA, value: name })
      for (const k of ld.strengths) out.push({ node, input: k, source: UPSCALE_LORA, value: l ? (/clip/i.test(k) ? l.clip : l.strength) : 0 })
    } else if (e.source === TRIGGER_DISABLE) out.push(...toggleDisableInputs(node, n))
    else if (e.source === UPSCALE_SEED) {
      // 能确定时写入原图的 Seed；不能确定时保持放大工作流的值并要求确认（不猜测）
      if (rec.seed != null) {
        out.push({ node, input: e.input, source: e.source, value: rec.seed })
        if (!seedNoted) issues.push({ level: 'note', text: `Seed：写入原图的 ${rec.seed}（${rec.seed_note ?? '原图'}）` })
      } else issues.push({ level: 'confirm', text: `无法确定原图的 Seed（${rec.seed_note ?? '没有 Seed 信息'}）：${label(api, node)} 的 ${e.input} 保持放大工作流的值（${JSON.stringify(n?.inputs?.[e.input] ?? null)}）` })
      seedNoted = true
    }
  }
  if (issues.some((i) => i.level === 'block')) return { inputs: null, issues }
  const controls = controlsOf(wf)
  if (controlProblems(api, mapping, controls).some(([l]) => l === 'error')) return { inputs: null, issues: [{ level: 'block', text: `放大工作流「${wf.name}」的节点控制有错误，请在工作流页面检查` }] }
  const merged = mergeControlInputs(api, out, controlInputs(api, controls))
  if (merged.conflicts.length) return { inputs: null, issues: merged.conflicts.map((text) => ({ level: 'block', text })) }
  return { inputs: merged.inputs, issues }
}

/** 一键识别放大工作流的映射候选：LoadImage、Checkpoint、LoRA 加载节点、最终保存节点 */
export function suggestUpscaleMapping(api: ApiWorkflow): MappingEntry[] {
  return suggestUpscaleMappingWithNotes(api).add
}

/** 同上，并说明没有填写的项与原因（例如有多个 LoadImage 时不替用户选择） */
export function suggestUpscaleMappingWithNotes(api: ApiWorkflow): { add: MappingEntry[]; notes: string[] } {
  const ids = sortNodeIds(Object.keys(api))
  const out: MappingEntry[] = []
  const notes: string[] = []
  const add = (source: string, node: string, input: string) => out.push({ source, node, input, modules: [], template: '' })
  const loads = ids.filter((id) => api[id].class_type === 'LoadImage' && typeof api[id].inputs?.image === 'string')
  if (loads.length === 1) add(UPSCALE_IMAGE, loads[0], 'image')
  else if (loads.length > 1)
    notes.push(`有 ${loads.length} 个 LoadImage（${loads.map((id) => nodeLabel(api, id)).join('、')}），无法确定哪个读取要放大的图片（其他的可能是 IPAdapter / ControlNet 的参考图）：请手动添加「放大：输入图片」，节点选读取原图的那个，输入选 image`)
  else notes.push('没有 LoadImage 节点：放大工作流需要一个 LoadImage 读取要放大的图片')
  const samplers = findSamplers(api)
  if (samplers.length) {
    let link: unknown = api[samplers[0]].inputs.model
    const seen = new Set<string>()
    while (isLink(link) && !seen.has(String(link[0]))) {
      const nid = String(link[0])
      seen.add(nid)
      const i = api[nid]?.inputs ?? {}
      if (typeof i.ckpt_name === 'string') {
        add(UPSCALE_CHECKPOINT, nid, 'ckpt_name')
        break
      }
      if (loraStackOf(api[nid]) || typeof i.lora_name === 'string') if (!out.some((m) => m.source === UPSCALE_LORA)) add(UPSCALE_LORA, nid, loraStackOf(api[nid]) ? 'loras' : 'lora_name')
      link = i.model
    }
    for (const pol of ['positive', 'negative'] as const) {
      const enc = encodersOf(api, api[samplers[0]].inputs[pol] as [string, number])[0]
      const f = enc ? TEXT_FIELDS.find((k) => typeof api[enc].inputs[k] === 'string') : undefined
      if (enc && f) add(pol, enc, f)
      else if (enc) {
        const linked = TEXT_FIELDS.find((k) => isLink(api[enc].inputs[k]))
        if (linked) notes.push(`${pol === 'positive' ? '正面' : '负面'} Prompt：编码器 ${nodeLabel(api, enc)} 的 ${linked} 连接自 ${nodeLabel(api, String((api[enc].inputs[linked] as [string, number])[0]))}，不能直接写入：请手动映射到上游可以填写文本的节点（例如通配符节点的 populated_text 与 wildcard_text）`)
      }
    }
  } else notes.push('没有找到采样器：没有填写 Checkpoint、LoRA 与 Prompt 映射')
  // 最终输出：没有被其他节点使用、且下游没有其他保存节点的保存节点；只有一个时才建议
  const used = new Set(ids.flatMap((id) => Object.values(api[id].inputs ?? {}).filter(isLink).map((v) => String(v[0]))))
  const finals = ids.filter((id) => typeof api[id].inputs?.filename_prefix === 'string' && !used.has(id))
  if (finals.length === 1) add(UPSCALE_OUTPUT, finals[0], 'filename_prefix')
  else if (finals.length > 1) notes.push(`有 ${finals.length} 个保存节点（${finals.map((id) => nodeLabel(api, id)).join('、')}）：请手动添加「放大：最终输出节点」，选保存放大结果的那个`)
  return { add: out, notes }
}

export const nodeLabel = (api: ApiWorkflow, nid: string) => `#${nid} ${nodeTitle(api[nid])}`
