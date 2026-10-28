// 历史 Prompt 提取（主进程部分）：扫描 PNG 读取 Prompt、标签词典的导入与保存、把选中的组合保存为素材。
// 图片只以只读方式打开读取元数据，不修改、移动或重新编码；不访问网络，不需要 ComfyUI。

import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { MINING_LIMITS, MINING_SAVE_KINDS, type DictionaryInfo, type MiningSaveItem, type MiningSaveOutcome, type ScannedImage, type ScanResult } from '@shared/mining'
import { extractPrompt } from '@shared/prompt-source'
import { parseDictionary, promptSignature } from '@shared/tags'
import { TEMPLATE_KINDS } from '@shared/types'
import { atomic } from './file-library'
import { readPngText } from './png-meta'
import type { Store } from './store'

/** 单个 PNG 文件的最大大小（超过时不读取） */
export const MAX_PNG_BYTES = 512 * 1024 * 1024
export const MAX_DICT_BYTES = 128 * 1024 * 1024

const isPng = (p: string) => extname(p).toLowerCase() === '.png'

/** 列出文件夹中的 PNG（可递归；跳过符号链接与隐藏目录）；超过上限时停止并报告 */
export async function listPngs(dir: string, recursive: boolean, errors: string[], limit = MINING_LIMITS.maxImages, isCancelled = () => false): Promise<string[]> {
  const out: string[] = []
  const walk = async (d: string) => {
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
      if (e.isFile() && isPng(e.name)) out.push(p)
      else if (recursive && e.isDirectory() && !e.name.startsWith('.')) await walk(p)
      if (out.length > limit) return
    }
  }
  await walk(dir)
  if (out.length > limit) {
    errors.push(`PNG 数量超过 ${limit} 张，只读取前 ${limit} 张`)
    out.length = limit
  }
  return out
}

/** 读取一张图片的 Prompt：任何异常都转为该图片的错误，不影响整批 */
export async function scanImage(path: string): Promise<ScannedImage> {
  const base = { id: path, name: basename(path), folder: dirname(path), size: 0 }
  try {
    const st = await stat(path)
    base.size = st.size
    if (!st.isFile()) throw new Error('不是文件')
    if (st.size > MAX_PNG_BYTES) throw new Error('文件过大')
    if (!isPng(path)) throw new Error('只支持 PNG 图片')
    const chunks = await readPngText(path)
    return { ...base, ...extractPrompt(chunks) }
  } catch (e) {
    return { ...base, status: 'error', positive: '', negative: '', source: null, notes: [], error: (e as Error).message || String(e) }
  }
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
    try {
      const paths = files.filter(isPng)
      if (files.length > paths.length) errors.push(`已跳过 ${files.length - paths.length} 个非 PNG 文件`)
      for (const f of folders) paths.push(...(await listPngs(f, recursive, errors, MINING_LIMITS.maxImages, () => this.cancelled)))
      const unique = [...new Set(paths)]
      if (unique.length > MINING_LIMITS.maxImages) {
        errors.push(`一次最多读取 ${MINING_LIMITS.maxImages} 张图片，已忽略其余 ${unique.length - MINING_LIMITS.maxImages} 张`)
        unique.length = MINING_LIMITS.maxImages
      }
      const images: ScannedImage[] = []
      let last = 0
      for (let i = 0; i < unique.length; i++) {
        if (this.cancelled || job !== this.job) return { images, cancelled: true, errors }
        images.push(await scanImage(unique[i]))
        this.allowed.add(unique[i])
        const now = Date.now()
        if (now - last > 80 || i === unique.length - 1) {
          last = now
          onProgress(i + 1, unique.length, basename(unique[i]))
        }
      }
      if (!unique.length) onProgress(0, 0, '')
      return { images, cancelled: false, errors }
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
