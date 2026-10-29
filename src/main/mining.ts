// 历史 Prompt 提取（主进程部分）：扫描 PNG 读取 Prompt、标签词典的导入与保存、把选中的组合保存为素材。
// 图片只以只读方式打开读取元数据，不修改、移动或重新编码；不访问网络，不需要 ComfyUI。

import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { MINING_LIMITS, MINING_SAVE_KINDS, type DictionaryInfo, type MiningSaveItem, type MiningSaveOutcome, type RawMeta, type ScannedImage, type ScanFound, type ScanResult } from '@shared/mining'
import { extractPrompt, parseJsonLoose, type SavedSourceRule, type SourceRule } from '@shared/prompt-source'
import { parseDictionary, promptSignature } from '@shared/tags'
import { TEMPLATE_KINDS } from '@shared/types'
import { atomic } from './file-library'
import { fieldMap, readImageMeta } from './png-meta'
import type { Store } from './store'

/** 单个 PNG 文件的最大大小（超过时不读取） */
export const MAX_PNG_BYTES = 512 * 1024 * 1024
export const MAX_DICT_BYTES = 128 * 1024 * 1024

/** 可以读取生成参数的图片格式（按内容识别，扩展名只用于筛选文件） */
export const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp']
/** 不支持读取、但会在扫描结果中计数提示的图片格式 */
const OTHER_IMAGE_EXTS = ['.avif', '.gif', '.bmp', '.tif', '.tiff', '.heic', '.jxl']
const isImage = (p: string) => IMAGE_EXTS.includes(extname(p).toLowerCase())

export const newFound = (): ScanFound => ({ images: 0, byExt: {}, unsupported: {}, folders: 0 })

/** 列出文件夹中支持的图片（可递归；跳过符号链接与隐藏目录）；超过上限时停止并报告 */
export async function listPngs(dir: string, recursive: boolean, errors: string[], limit = MINING_LIMITS.maxImages, isCancelled = () => false, found = newFound()): Promise<string[]> {
  const out: string[] = []
  const walk = async (d: string) => {
    found.folders++
    if (isCancelled() || out.length > limit) return
    let entries
    try {
      entries = await readdir(d, { withFileTypes: true })
    } catch (e) {
      errors.push(`无法读取文件夹 ${d}：${(e as Error).message}`)
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const e of entries) {
      if (e.isSymbolicLink()) continue
      const p = join(d, e.name)
      const ext = extname(e.name).toLowerCase()
      if (e.isFile() && isImage(e.name)) {
        out.push(p)
        found.byExt[ext] = (found.byExt[ext] ?? 0) + 1
      } else if (e.isFile() && OTHER_IMAGE_EXTS.includes(ext)) found.unsupported[ext] = (found.unsupported[ext] ?? 0) + 1
      else if (recursive && e.isDirectory() && !e.name.startsWith('.')) await walk(p)
      if (out.length > limit) return
    }
  }
  await walk(dir)
  if (out.length > limit) {
    errors.push(`图片数量超过 ${limit} 张，只读取前 ${limit} 张`)
    out.length = limit
  }
  return out
}

/** 读取一张图片的 Prompt：任何异常都转为该图片的错误，不影响整批 */
export async function scanImage(path: string): Promise<ScannedImage> {
  const base: Pick<ScannedImage, 'id' | 'name' | 'folder' | 'size' | 'format' | 'fields'> = { id: path, name: basename(path), folder: dirname(path), size: 0, format: null, fields: [] }
  try {
    const st = await stat(path)
    base.size = st.size
    if (!st.isFile()) throw new Error('不是文件')
    if (st.size > MAX_PNG_BYTES) throw new Error('文件过大')
    if (!isImage(path)) throw new Error('只支持 PNG / JPEG / WebP 图片')
    const meta = readImageMeta(path)
    base.format = meta.format
    base.fields = meta.fields.map((f) => ({ key: f.key, via: f.via, size: f.text.length }))
    const r = extractPrompt(fieldMap(meta.fields))
    return { ...base, ...r, notes: [...meta.warnings, ...r.notes] }
  } catch (e) {
    return { ...base, status: 'error', positive: '', negative: '', source: null, notes: [], candidates: [], error: (e as Error).message || String(e) }
  }
}

/** 原始元数据查看：每个字段最多显示 maxShow 个字符；JSON 在不太大时格式化 */
export const RAW_LIMITS = { maxShow: 400 * 1024, maxPretty: 8 * 1024 * 1024 }

export function rawMeta(path: string): RawMeta {
  try {
    const meta = readImageMeta(path)
    return {
      format: meta.format,
      warnings: meta.warnings,
      fields: meta.fields.map((f) => {
        let text = f.text
        let json = false
        if (/^\s*[[{]/.test(text) && text.length <= RAW_LIMITS.maxPretty) {
          try {
            // 节点连线 ["4", 0] 保持在一行，便于阅读
            text = JSON.stringify(parseJsonLoose(text), null, 2).replace(/\[\s+("(?:[^"\\]|\\.)*"|-?\d+),\s+(-?\d+)\s+\]/g, '[$1, $2]')
            json = true
          } catch {
            // 不是有效 JSON：原样显示
          }
        }
        const truncated = text.length > RAW_LIMITS.maxShow
        return { key: f.key, via: f.via, size: f.text.length, json, truncated, text: truncated ? text.slice(0, RAW_LIMITS.maxShow) : text }
      }),
    }
  } catch (e) {
    return { format: null, warnings: [], fields: [], error: (e as Error).message || String(e) }
  }
}

/** 某个字段的完整原文（用于复制） */
export function rawField(path: string, index: number): string {
  const f = readImageMeta(path).fields[index]
  if (!f) throw new Error('字段不存在')
  return f.text
}

/** 一次扫描任务：可取消；只记录本次读取过的路径（缩略图只允许读取这些文件） */
export class MiningScanner {
  readonly allowed = new Set<string>()
  private job = 0
  private cancelled = false
  running = false

  cancel() {
    this.cancelled = true
  }

  async scan(files: string[], folders: string[], recursive: boolean, onProgress: (done: number, total: number, file: string) => void): Promise<ScanResult> {
    if (this.running) throw new Error('正在扫描，请等待完成或先取消')
    this.running = true
    this.cancelled = false
    const job = ++this.job
    const errors: string[] = []
    const found = newFound()
    try {
      const paths = files.filter(isImage)
      for (const p of paths) found.byExt[extname(p).toLowerCase()] = (found.byExt[extname(p).toLowerCase()] ?? 0) + 1
      if (files.length > paths.length) errors.push(`已跳过 ${files.length - paths.length} 个不支持的文件（支持 PNG / JPEG / WebP）`)
      for (const f of folders) paths.push(...(await listPngs(f, recursive, errors, MINING_LIMITS.maxImages, () => this.cancelled, found)))
      const unique = [...new Set(paths)]
      if (unique.length > MINING_LIMITS.maxImages) {
        errors.push(`一次最多读取 ${MINING_LIMITS.maxImages} 张图片，已忽略其余 ${unique.length - MINING_LIMITS.maxImages} 张`)
        unique.length = MINING_LIMITS.maxImages
      }
      found.images = unique.length
      const images: ScannedImage[] = []
      let last = 0
      for (let i = 0; i < unique.length; i++) {
        if (this.cancelled || job !== this.job) return { images, cancelled: true, errors, found }
        images.push(await scanImage(unique[i]))
        this.allowed.add(unique[i])
        const now = Date.now()
        if (now - last > 80 || i === unique.length - 1) {
          last = now
          onProgress(i + 1, unique.length, basename(unique[i]))
        }
      }
      if (!unique.length) {
        onProgress(0, 0, '')
        const other = Object.entries(found.unsupported).map(([e, n]) => `${e} ${n} 个`).join('、')
        if (folders.length) errors.push(`没有找到 PNG / JPEG / WebP 图片（扫描了 ${found.folders} 个文件夹${recursive ? '，包含子文件夹' : '，未包含子文件夹'}）${other ? `；另有不支持的图片：${other}` : ''}`)
      } else if (Object.keys(found.unsupported).length) errors.push(`已跳过不支持读取的图片：${Object.entries(found.unsupported).map(([e, n]) => `${e} ${n} 个`).join('、')}`)
      return { images, cancelled: false, errors, found }
    } finally {
      this.running = false
    }
  }
}

// ---------------- 标签词典（可选，保存在工作区 data/tag-dictionary.json）

export const dictionaryPath = (dataDir: string) => join(dataDir, 'data', 'tag-dictionary.json')

export function dictionaryInfo(file: string): DictionaryInfo | null {
  if (!existsSync(file)) return null
  try {
    const d = JSON.parse(readFileSync(file, 'utf8'))
    return { tags: d.tags?.length ?? 0, aliases: d.aliases?.length ?? 0, source: String(d.source ?? ''), imported_at: String(d.imported_at ?? '') }
  } catch {
    return null
  }
}

/** 导入词典：解析成功后才写入（原子替换），解析失败时保留原有词典 */
export function importDictionary(source: string, file: string): DictionaryInfo {
  if (statSync(source).size > MAX_DICT_BYTES) throw new Error('词典文件过大')
  const ext = extname(source).toLowerCase()
  const format = ext === '.json' ? 'json' : ext === '.csv' ? 'csv' : 'txt'
  const parsed = parseDictionary(readFileSync(source, 'utf8').replace(/^﻿/, ''), format)
  if (!parsed.tags.length) throw new Error('词典中没有读到标签')
  mkdirSync(dirname(file), { recursive: true })
  const data = { version: 1, source: basename(source), imported_at: new Date().toISOString(), tags: parsed.tags, aliases: parsed.aliases }
  atomic(file, JSON.stringify(data))
  return { tags: data.tags.length, aliases: data.aliases.length, source: data.source, imported_at: data.imported_at }
}

// ---------------- 来源规则（保存在工作区 data/prompt-source-rules.json，随 Vault 迁移）

export const sourceRulesPath = (dataDir: string) => join(dataDir, 'data', 'prompt-source-rules.json')
const MAX_RULES = 200

const str = (v: unknown, max = 500) => (typeof v === 'string' ? v.slice(0, max) : undefined)

/** 校验并规范化一条规则（丢弃未知字段） */
export function cleanSourceRule(raw: unknown): SavedSourceRule | null {
  const o = raw as Record<string, unknown>
  const r = o?.rule as Record<string, unknown>
  if (!o || typeof o !== 'object' || !r || typeof r !== 'object') return null
  if (r.kind !== 'node' && r.kind !== 'field') return null
  const key = str(r.key)
  if (!key) return null
  const rule: SourceRule = { kind: r.kind, key, label: str(r.label) ?? key }
  for (const k of ['classType', 'field', 'nodeId', 'title', 'fp'] as const) if (str(r[k])) rule[k] = str(r[k])
  if (r.kind === 'node' && (!rule.classType || !rule.field)) return null
  if (r.role === 'positive' || r.role === 'negative' || r.role === 'unused' || r.role === 'unknown') rule.role = r.role
  if (r.strictId === true && rule.nodeId) rule.strictId = true
  return { id: str(o.id, 80) || `r${Date.now()}`, name: (str(o.name, 120) ?? '').trim() || rule.label, enabled: o.enabled !== false, rule, created_at: str(o.created_at, 40) ?? new Date().toISOString() }
}

export function loadSourceRules(file: string): SavedSourceRule[] {
  if (!existsSync(file)) return []
  try {
    const d = JSON.parse(readFileSync(file, 'utf8'))
    return (Array.isArray(d?.rules) ? d.rules : []).map(cleanSourceRule).filter(Boolean).slice(0, MAX_RULES) as SavedSourceRule[]
  } catch {
    return []
  }
}

/** 整体替换保存（原子写入）；返回规范化后的列表 */
export function saveSourceRules(file: string, rules: unknown[]): SavedSourceRule[] {
  if (rules.length > MAX_RULES) throw new Error(`最多保存 ${MAX_RULES} 条来源规则`)
  const clean = rules.map(cleanSourceRule)
  if (clean.some((r) => !r)) throw new Error('来源规则格式不正确')
  const ids = new Set<string>()
  for (const r of clean as SavedSourceRule[]) {
    if (ids.has(r.id)) throw new Error('来源规则 ID 重复')
    ids.add(r.id)
  }
  mkdirSync(dirname(file), { recursive: true })
  atomic(file, JSON.stringify({ version: 1, rules: clean }, null, 2))
  return clean as SavedSourceRule[]
}

// ---------------- 保存为素材

/**
 * 把选中的组合保存为新的 Prompt 素材（复用现有的模板保存接口与 Vault 写入规则）：
 * 规范化标签集合与已有素材（任意类型）或本批中更早的项目相同时跳过，不覆盖任何已有文件。
 */
export function saveMined(store: Store, items: MiningSaveItem[]): MiningSaveOutcome[] {
  const existing = new Map<string, string>()
  for (const t of store.list('templates')) {
    const sig = promptSignature(t.positive ?? '')
    if (sig && !existing.has(sig)) existing.set(sig, `${t.name || '（未命名）'}（${TEMPLATE_KINDS[t.kind as keyof typeof TEMPLATE_KINDS] ?? t.kind}）`)
  }
  const out: MiningSaveOutcome[] = []
  for (const it of items) {
    const name = String(it.name ?? '').trim() || '提取组合'
    try {
      if (!MINING_SAVE_KINDS.includes(it.kind)) throw new Error(`不支持保存为 ${it.kind}`)
      const positive = String(it.positive ?? '').trim()
      const sig = promptSignature(positive)
      if (!sig) throw new Error('Prompt 为空')
      const dup = existing.get(sig)
      if (dup) {
        out.push({ name, status: 'duplicate', message: `与已有素材「${dup}」的标签相同，已跳过` })
        continue
      }
      const rec: Record<string, unknown> = { kind: it.kind, name, positive, negative: '' }
      if (it.kind === 'subposition') {
        const parent = it.parent_id != null ? store.get('templates', it.parent_id) : null
        if (!parent || parent.kind !== 'position') throw new Error('子体位需要选择所属的主体位')
        rec.parent_id = parent.id
      }
      const id = store.save('templates', rec)
      existing.set(sig, `${name}（${TEMPLATE_KINDS[it.kind]}）`)
      out.push({ name, status: 'saved', id })
    } catch (e) {
      out.push({ name, status: 'error', message: (e as Error).message })
    }
  }
  return out
}
