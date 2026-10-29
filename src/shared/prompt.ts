// Prompt 组合：只按用户设置的模块顺序与连接符拼接原始文本，不做任何语义处理。

import type { Character, Modules, Settings } from './types'

// 默认顺序：全局 → 场景 → 镜头 → 主角色（外貌、服装、动作、表情）→ 双人互动 → 第二角色（外貌、服装、动作、表情）
export const MODULES: [string, string][] = [
  ['global', '全局（画质 / 画风）'],
  ['scene', '场景'],
  ['camera', '镜头'],
  ['character', '主角色'],
  ['outfit', '主角色服装'],
  ['content', '主角色状态 / 剧情场景'],
  ['expression', '主角色表情'],
  ['interaction', '双人动作（主体位 / 子体位 / 行为）'],
  ['male', '旧版男性描述'],
  ['character2', '第二角色'],
  ['outfit2', '第二角色服装'],
  ['content2', '第二角色状态'],
  ['expression2', '第二角色表情'],
  ['extra', '附加'],
]
export const MODULE_LABELS: Record<string, string> = Object.fromEntries(MODULES)
export const MODULE_KEYS = MODULES.map(([k]) => k)

// 只替换下列精确的占位符；其他花括号（如 {a|b} 动态语法）原样保留
export const PLACEHOLDER_HELP = '{角色名}  {角色标签}（英文写法 {char_name}  {char_tag} 等价）'

export function fillPlaceholders(text: string, character: Pick<Character, 'name' | 'tag'> | null | undefined): string {
  if (!text || !character) return text
  const name = character.name ?? ''
  const tag = character.tag ?? ''
  const pairs: [string, string][] = [
    ['{角色名}', name],
    ['{char_name}', name],
    ['{角色标签}', tag],
    ['{char_tag}', tag],
  ]
  for (const [token, value] of pairs) {
    if (text.includes(token)) text = text.split(token).join(value)
  }
  return text
}

/** 设置里的连接符允许写 \n 表示换行 */
export function unescapeSeparator(sep: string): string {
  return sep.split('\\n').join('\n').split('\\t').join('\t')
}

// 与 Python str.strip() 一致：去除首尾空白字符
const strip = (s: string) => s.replace(/^\s+|\s+$/g, '')

export function joinParts(parts: (string | null | undefined)[], sep: string, trim = true): string {
  const out: string[] = []
  for (const p of parts) {
    if (p == null || !strip(p)) continue
    out.push(trim ? strip(p) : p)
  }
  return out.join(sep)
}

/** Prompt 中以逗号或换行分隔的标签（用于判断是否已经存在，不改写原文） */
export function promptTags(text: string): string[] {
  return (text ?? '').split(/[,\n]/).map((t) => t.trim().toLowerCase()).filter(Boolean)
}

/**
 * 把若干标签加到 Prompt 开头：已存在（逐个标签比较）的跳过，原有文本保持原样。
 * 返回新文本以及实际加入 / 跳过的标签。
 */
export function prependTags(base: string, words: string[], sep = ', '): { text: string; added: string[]; skipped: string[] } {
  const have = new Set(promptTags(base))
  const added: string[] = []
  const skipped: string[] = []
  for (const raw of words) {
    const w = (raw ?? '').trim()
    if (!w) continue
    const key = w.toLowerCase()
    if (have.has(key)) skipped.push(w)
    else {
      added.push(w)
      have.add(key)
    }
  }
  if (!added.length) return { text: base, added, skipped }
  return { text: (base ?? '').trim() ? `${added.join(sep)}${sep}${base}` : added.join(sep), added, skipped }
}

/** 以前版本的默认顺序：设置中仍是这些顺序（用户没有自定义过）时升级为新的默认顺序 */
export const LEGACY_DEFAULT_ORDERS: string[][] = [
  ['global', 'character', 'outfit', 'content', 'expression', 'male', 'camera', 'extra'],
  ['global', 'character', 'outfit', 'content', 'expression', 'male', 'interaction', 'scene', 'camera', 'extra'],
]

export function isLegacyDefaultOrder(order: unknown): boolean {
  return Array.isArray(order) && LEGACY_DEFAULT_ORDERS.some((o) => o.length === order.length && o.every((m, i) => order[i] === m))
}

/** 用户保存的顺序缺少新模块时，按默认顺序插到前一个模块之后（而不是全部追加到末尾） */
export function normalizedOrder(order: string[] | null | undefined): string[] {
  const out = (order ?? []).filter((m, i, a) => m in MODULE_LABELS && a.indexOf(m) === i)
  MODULE_KEYS.forEach((m, i) => {
    if (out.includes(m)) return
    const prev = MODULE_KEYS.slice(0, i).reverse().find((k) => out.includes(k))
    out.splice(prev ? out.indexOf(prev) + 1 : 0, 0, m)
  })
  return out
}

/**
 * 顶层模块之间的拼接：空模块跳过；连接符以逗号开头时（例如 ",\n\n"），去掉前一个模块末尾已有的逗号，
 * 避免出现 ",," 。模块内容的其余部分（标签、权重、动态语法、换行）原样保留。
 */
export function joinModules(parts: (string | null | undefined)[], sep: string, trim = true): string {
  const texts: string[] = []
  for (const p of parts) {
    if (p == null || !strip(p)) continue
    texts.push(trim ? strip(p) : p)
  }
  const commaLead = sep.replace(/^[ \t]+/, '').startsWith(',')
  return texts.map((t, i) => (commaLead && i < texts.length - 1 ? t.replace(/,[ \t]*$/, '') : t)).join(sep)
}

export type ComposeSettings = Pick<Settings, 'compose_order' | 'pos_separator' | 'neg_separator' | 'trim_modules'> & Partial<Pick<Settings, 'pos_module_separator'>>

/**
 * modules: {模块: [正面, 负面]}；only: 只拼接这些模块（用于多 Prompt 节点）。返回 [正面, 负面]
 * 正面：顶层模块之间用 pos_module_separator（默认空一行），模块内部各部分在生成模块时已用 pos_separator 拼接；
 * 负面：保持原有方式，模块之间用 neg_separator。
 */
export function compose(modules: Modules, settings: ComposeSettings, only?: string[]): [string, string] {
  let order = normalizedOrder(settings.compose_order)
  if (only && only.length) order = order.filter((m) => only.includes(m))
  const trim = settings.trim_modules ?? true
  const moduleSep = unescapeSeparator(settings.pos_module_separator ?? settings.pos_separator ?? ', ')
  const negSep = unescapeSeparator(settings.neg_separator ?? ', ')
  const pos = joinModules(order.map((m) => (modules[m] ?? ['', ''])[0]), moduleSep, trim)
  const neg = joinParts(order.map((m) => (modules[m] ?? ['', ''])[1]), negSep, trim)
  return [pos, neg]
}
