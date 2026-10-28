// Prompt 标签解析与规范化（只用于比较，不改写原文）：
// - 只在最外层的逗号 / 换行处切分，括号内（权重组、动态语法、LoRA）不切分，不按空格拆分多词标签；
// - 比较键：去掉外层权重括号，反转义 \( \)，小写，空格与下划线统一为下划线；
// - 原始写法与权重保留在 raw / weight 中，保存时使用原始写法。

export interface PromptToken {
  /** 原始写法（去掉首尾空白） */
  raw: string
  /** 去掉外层权重语法后的标签文本 */
  core: string
  /** 比较键（有词典时为词典中的规范名称） */
  key: string
  /** 权重：(x:1.2) → 1.2，((x)) → 1.21，[x] → 0.91，无权重为 1 */
  weight: number
}

/** 可选的本地标签词典（例如 Danbooru 标签列表），只辅助规范化和标记已知标签，不用于语义分类 */
export interface TagDictionary {
  tags: Set<string>
  /** 别名 → 规范名称（均为比较键） */
  aliases: Map<string, string>
}

// 尖括号不计入（<3、>_< 等表情很常见；<lora:…> 内不含逗号）
const OPEN: Record<string, string> = { '(': ')', '[': ']', '{': '}' }
const CLOSE = new Set(Object.values(OPEN))

/** 最外层切分：逗号（含全角逗号）与换行；反斜杠转义的字符不参与括号计数；BREAK 关键字忽略 */
export function splitTopLevel(text: string): string[] {
  const s = String(text ?? '')
  const out: string[] = []
  let depth = 0
  let start = 0
  const push = (end: number) => {
    const t = s.slice(start, end).trim()
    if (t && t !== 'BREAK') out.push(t)
  }
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '\\') {
      i++
      continue
    }
    if (c in OPEN) depth++
    else if (CLOSE.has(c)) depth = Math.max(0, depth - 1)
    else if (depth === 0 && (c === ',' || c === '，' || c === '\n' || c === '\r')) {
      push(i)
      start = i + 1
    }
  }
  if (depth > 0) {
    // 括号不配对：剩余部分按普通逗号切分，避免把后面所有内容当成一个标签
    for (const part of s.slice(start).split(/[,，\r\n]/)) {
      const t = part.trim()
      if (t && t !== 'BREAK') out.push(t)
    }
  } else push(s.length)
  return out
}

/** s[0] 处括号对应的闭括号位置；没有时返回 -1 */
function matchClose(s: string, from: number): number {
  const open = s[from]
  const close = OPEN[open]
  let depth = 0
  for (let i = from; i < s.length; i++) {
    const c = s[i]
    if (c === '\\') {
      i++
      continue
    }
    if (c === open) depth++
    else if (c === close && --depth === 0) return i
  }
  return -1
}

/** 最外层（不在括号内）的最后一个冒号位置 */
function lastTopColon(s: string): number {
  let depth = 0
  let pos = -1
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '\\') {
      i++
      continue
    }
    if (c in OPEN) depth++
    else if (CLOSE.has(c)) depth = Math.max(0, depth - 1)
    else if (c === ':' && depth === 0) pos = i
  }
  return pos
}

const hasTop = (s: string, ch: string) => {
  let depth = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '\\') {
      i++
      continue
    }
    if (c in OPEN) depth++
    else if (CLOSE.has(c)) depth = Math.max(0, depth - 1)
    else if (c === ch && depth === 0) return true
  }
  return false
}

const NUM = /^\s*-?\d+(?:\.\d+)?\s*$/

/** 去掉外层权重语法，得到标签文本与权重。不认识的括号内容（[a:b:0.5]、[a|b]、{a|b}）原样保留 */
export function stripWeight(raw: string): { core: string; weight: number } {
  let s = raw.trim()
  let weight = 1
  for (let guard = 0; guard < 32 && s.length >= 2; guard++) {
    const c = s[0]
    if ((c === '(' || c === '[') && matchClose(s, 0) === s.length - 1) {
      const inner = s.slice(1, -1)
      if (c === '(') {
        const colon = lastTopColon(inner)
        if (colon >= 0 && NUM.test(inner.slice(colon + 1))) {
          weight *= Number(inner.slice(colon + 1))
          s = inner.slice(0, colon).trim()
        } else {
          weight *= 1.1
          s = inner.trim()
        }
        continue
      }
      // [a:b:0.5]（提示词切换）与 [a|b]（交替）不是降权语法
      if (hasTop(inner, ':') || hasTop(inner, '|')) break
      weight /= 1.1
      s = inner.trim()
      continue
    }
    break
  }
  // LoRA / 嵌入：<lora:name:0.8> 的比较键不含强度
  const lora = /^<(lora|lyco|hypernet):(.+?)(?::(-?\d+(?:\.\d+)?))?(?::[^:>]*)?>$/i.exec(s)
  if (lora) {
    if (lora[3]) weight *= Number(lora[3])
    s = `<${lora[1].toLowerCase()}:${lora[2]}>`
  }
  return { core: s, weight: Math.round(weight * 1000) / 1000 }
}

/** 比较键：反转义括号，全角转半角，小写，空白与下划线统一为单个下划线 */
export function normalizeKey(core: string): string {
  return core
    .normalize('NFKC')
    .replace(/\\([()[\]{}])/g, '$1')
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '_')
}

export function canonicalKey(key: string, dict?: TagDictionary | null): string {
  return dict?.aliases.get(key) ?? key
}

/** 解析单个标签（raw 为 splitTopLevel 切出的一段） */
export function parseToken(raw: string, dict?: TagDictionary | null): PromptToken | null {
  const { core, weight } = stripWeight(raw)
  const key = canonicalKey(normalizeKey(core), dict)
  if (!key || key === '_') return null
  return { raw: raw.trim(), core, key, weight }
}

/** 把 Prompt 解析为标签列表（保留顺序；同一标签重复出现时保留第一次，dupes 记录被合并的次数） */
export function tokenizePrompt(text: string, dict?: TagDictionary | null): { tokens: PromptToken[]; dupes: number } {
  const seen = new Set<string>()
  const tokens: PromptToken[] = []
  let dupes = 0
  for (const part of splitTopLevel(text)) {
    const t = parseToken(part, dict)
    if (!t) continue
    if (seen.has(t.key)) {
      dupes++
      continue
    }
    seen.add(t.key)
    tokens.push(t)
  }
  return { tokens, dupes }
}

/** 与词典无关的规范化签名（标签集合，忽略顺序与权重）：用于判断与已有素材是否重复 */
export function promptSignature(text: string): string {
  return [...new Set(splitTopLevel(text).map((p) => parseToken(p)?.key).filter((k): k is string => !!k))].sort().join(',')
}

/** 从 Prompt 中移除一个标签（按比较键匹配最外层的标签），其余文本保持原样 */
export function removeTag(text: string, key: string): string {
  return splitTopLevel(text)
    .filter((p) => parseToken(p)?.key !== key)
    .join(', ')
}

// ---------------- 词典导入

/** 解析一行 CSV（支持双引号与 "" 转义） */
export function csvFields(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let q = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (q) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"'
        i++
      } else if (c === '"') q = false
      else cur += c
    } else if (c === '"') q = true
    else if (c === ',') {
      out.push(cur)
      cur = ''
    } else cur += c
  }
  out.push(cur)
  return out
}

export const DICT_LIMITS = { maxTags: 2_000_000 }

/**
 * 解析词典文本：
 * - CSV：第一列为标签名；a1111-tagcomplete 格式（名称,类别,数量,"别名1,别名2"）的第四列作为别名；
 * - TXT：每行一个标签（# 开头为注释；一行中有逗号时取第一段）；
 * - JSON：字符串数组、{name|tag, aliases} 对象数组，或以标签名为键的对象。
 * 返回比较键形式的标签与别名（别名 → 规范名称）。
 */
export function parseDictionary(text: string, format: 'csv' | 'txt' | 'json'): { tags: string[]; aliases: [string, string][] } {
  const tags = new Set<string>()
  const aliases = new Map<string, string>()
  const add = (name: unknown, als?: unknown) => {
    if (typeof name !== 'string') return
    const key = normalizeKey(name)
    if (!key || key === '_') return
    if (tags.size >= DICT_LIMITS.maxTags) throw new Error(`词典标签数量超过 ${DICT_LIMITS.maxTags}，请精简后再导入`)
    tags.add(key)
    const list = Array.isArray(als) ? als : typeof als === 'string' ? als.split(',') : []
    for (const a of list) {
      if (typeof a !== 'string') continue
      const ak = normalizeKey(a)
      if (ak && ak !== key && !aliases.has(ak)) aliases.set(ak, key)
    }
  }
  if (format === 'json') {
    const data = JSON.parse(text)
    if (Array.isArray(data)) for (const x of data) typeof x === 'string' ? add(x) : x && typeof x === 'object' && add(x.name ?? x.tag, x.aliases)
    else if (data && typeof data === 'object') for (const [k, v] of Object.entries(data)) add(k, v && typeof v === 'object' ? (v as { aliases?: unknown }).aliases : undefined)
    else throw new Error('JSON 词典应为标签数组或对象')
  } else {
    let first = true
    for (const line of text.split(/\r?\n/)) {
      const l = line.trim()
      if (!l || l.startsWith('#')) continue
      const f = format === 'csv' ? csvFields(l) : [l.split(',')[0]]
      // 跳过表头
      if (first && format === 'csv' && /^(name|tag|tags|标签)$/i.test(f[0].trim())) {
        first = false
        continue
      }
      first = false
      const tagcomplete = format === 'csv' && f.length >= 4 && NUM.test(f[1]) && NUM.test(f[2])
      add(f[0], tagcomplete ? f[3] : undefined)
    }
  }
  // 别名不应覆盖真实存在的标签
  for (const a of [...aliases.keys()]) if (tags.has(a)) aliases.delete(a)
  return { tags: [...tags], aliases: [...aliases] }
}

export function buildDictionary(data: { tags: string[]; aliases: [string, string][] } | null | undefined): TagDictionary | null {
  if (!data) return null
  return { tags: new Set(data.tags), aliases: new Map(data.aliases) }
}
