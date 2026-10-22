// Prompt 组合：只按用户设置的模块顺序与连接符拼接原始文本，不做任何语义处理。

import type { Character, Modules, Settings } from './types'

export const MODULES: [string, string][] = [
  ['global', '全局'],
  ['character', '角色'],
  ['outfit', '服装'],
  ['content', '剧情场景 / 姿态'],
  ['expression', '表情'],
  ['male', '男性'],
  ['camera', '镜头'],
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

export function normalizedOrder(order: string[] | null | undefined): string[] {
  const valid = (order ?? []).filter((m) => m in MODULE_LABELS)
  return [...valid, ...MODULE_KEYS.filter((m) => !valid.includes(m))]
}

type ComposeSettings = Pick<Settings, 'compose_order' | 'pos_separator' | 'neg_separator' | 'trim_modules'>

/** modules: {模块: [正面, 负面]}；only: 只拼接这些模块（用于多 Prompt 节点）。返回 [正面, 负面] */
export function compose(modules: Modules, settings: ComposeSettings, only?: string[]): [string, string] {
  let order = normalizedOrder(settings.compose_order)
  if (only && only.length) order = order.filter((m) => only.includes(m))
  const trim = settings.trim_modules ?? true
  const posSep = unescapeSeparator(settings.pos_separator ?? ', ')
  const negSep = unescapeSeparator(settings.neg_separator ?? ', ')
  const pos = joinParts(order.map((m) => (modules[m] ?? ['', ''])[0]), posSep, trim)
  const neg = joinParts(order.map((m) => (modules[m] ?? ['', ''])[1]), negSep, trim)
  return [pos, neg]
}
