// 本地 LoRA 管理：扫描 LoRA 根目录（保留真实子目录层级），自动关联同名封面与 ComfyUI-Lora-Manager 的
// `.metadata.json`。扫描对模型目录只做读取（readdir / stat / 读取文件头），从不写入或移动用户文件；
// ComfyEngi 自己的标签、备注、角色关联、手动封面等保存在 Vault 的 loras/ 目录中。

import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { atomic } from './file-library'
import type { LoraResource, LoraSidecar } from '@shared/types'

export const IMAGE_EXTS = ['.jpeg', '.jpg', '.png', '.webp']
export const VIDEO_EXTS = ['.mp4']
/** 图片优先于视频：同名同时存在时使用图片 */
export const COVER_EXTS = [...IMAGE_EXTS, ...VIDEO_EXTS]
export const isVideo = (p: string) => VIDEO_EXTS.includes(extname(p).toLowerCase())
const ID_RE = /^[a-f0-9-]{36}$/i

/** Windows 路径不区分大小写：用于比较 / 去重的键 */
export const pathKey = (p: string) => {
  const r = resolve(p)
  return process.platform === 'win32' ? r.toLowerCase() : r
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const num = (v: unknown) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) ? n : undefined
}
const strList = (v: unknown) => {
  const arr = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []
  const out = [...new Set(arr.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean))]
  return out.length ? out : undefined
}

/** Civitai 描述多为 HTML：转成纯文本展示（不在界面中注入 HTML） */
export function htmlToText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|li|h\d)\s*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 解析 ComfyUI-Lora-Manager 的 metadata schema（model_name / base_model / tags / modelDescription /
 * usage_tips / notes / civitai.{trainedWords, name, model.*, creator}），只保留实际存在且非空的字段。
 */
export function parseSidecar(raw: unknown): LoraSidecar {
  if (!isObj(raw)) throw new Error('metadata.json 不是对象')
  const civ = isObj(raw.civitai) ? raw.civitai : {}
  const model = isObj(civ.model) ? civ.model : {}
  const creator = isObj(civ.creator) ? civ.creator : isObj(model.creator) ? model.creator : {}
  let tips: unknown = raw.usage_tips
  if (typeof tips === 'string') {
    try {
      tips = JSON.parse(tips)
    } catch {
      tips = {}
    }
  }
  const t = isObj(tips) ? tips : {}
  const usage = {
    strength: num(t.strength),
    strengthMin: num(t.strength_min ?? t.strengthMin),
    strengthMax: num(t.strength_max ?? t.strengthMax),
    clipStrength: num(t.clip_strength ?? t.clipStrength),
  }
  const description = text(raw.modelDescription) ?? text(model.description) ?? text(civ.description)
  const out: LoraSidecar = {
    modelName: text(raw.model_name) ?? text(model.name),
    baseModel: text(raw.base_model) ?? text(civ.baseModel),
    description: description ? htmlToText(description) || undefined : undefined,
    tags: strList(raw.tags) ?? strList(model.tags),
    triggerWords: strList(civ.trainedWords) ?? strList(raw.trigger_words ?? raw.trainedWords),
    usage: Object.values(usage).some((v) => v !== undefined) ? usage : undefined,
    notes: text(raw.notes),
    versionName: text(civ.name),
    creator: text(creator.username),
    modelType: text(model.type),
    sha256: text(raw.sha256),
    civitaiModelId: num(civ.modelId ?? model.id),
    civitaiVersionId: num(civ.id),
    favorite: raw.favorite === true ? true : undefined,
    previewUrl: text(raw.preview_url),
  }
  if (out.usage) for (const k of Object.keys(out.usage) as (keyof NonNullable<LoraSidecar['usage']>)[]) if (out.usage[k] === undefined) delete out.usage[k]
  for (const k of Object.keys(out) as (keyof LoraSidecar)[]) if (out[k] === undefined) delete out[k]
  return out
}

/** 读取 safetensors 文件头（只读开头的 JSON，不读取模型权重） */
async function readHeader(path: string, size: number): Promise<Record<string, unknown>> {
  const f = await open(path, 'r')
  try {
    const length = Buffer.alloc(8)
    if ((await f.read(length, 0, 8, 0)).bytesRead !== 8) throw new Error('无效文件头')
    const n = Number(length.readBigUInt64LE())
    if (n < 2 || n > 16 * 1024 * 1024 || n > size - 8) throw new Error('无效或过大的文件头')
    const buf = Buffer.alloc(n)
    if ((await f.read(buf, 0, n, 8)).bytesRead !== n) throw new Error('文件头不完整')
    const meta = JSON.parse(buf.toString('utf8')).__metadata__
    return isObj(meta) ? meta : {}
  } finally {
    await f.close()
  }
}

/** 与键顺序无关的 JSON，用于判断记录是否真正变化 */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
  return JSON.stringify(v) ?? 'null'
}

const DEFAULTS = { root: '', folder: '', cover: '', sidecar: null, sidecarPath: '', sidecarMtime: 0, sidecarError: '' }

export class LoraManager {
  constructor(public root: string) {}

  private get metaDir() {
    return join(this.root, 'loras/metadata')
  }

  async list(): Promise<LoraResource[]> {
    const rows: LoraResource[] = []
    let files: string[] = []
    try {
      files = await readdir(this.metaDir)
    } catch {
      return rows
    }
    for (const f of files)
      if (f.endsWith('.json')) {
        const r = { ...DEFAULTS, ...(JSON.parse(await readFile(join(this.metaDir, f), 'utf8')) as LoraResource) }
        if (!r.folder && r.relativePath) r.folder = dirname(r.relativePath) === '.' ? '' : dirname(r.relativePath).replaceAll('\\', '/')
        r.missing = !(await stat(r.path).catch(() => null))
        rows.push(r)
      }
    return rows
  }

  /** 按 ID 直接读取单条记录（视频分段请求较频繁，避免每次读取全部记录） */
  async get(id: string): Promise<LoraResource | null> {
    if (!ID_RE.test(id)) return null
    try {
      return { ...DEFAULTS, ...(JSON.parse(await readFile(join(this.metaDir, `${id}.json`), 'utf8')) as LoraResource), missing: false }
    } catch {
      return null
    }
  }

  async save(r: LoraResource) {
    const old = (await this.list()).find((x) => x.id === r.id)
    if (!old) throw new Error('未知 LoRA')
    const next = {
      ...old,
      category: String(r.category ?? ''),
      tags: String(r.tags ?? ''),
      note: String(r.note ?? ''),
      recommendedWeight: Number(r.recommendedWeight),
      characterId: r.characterId,
      comfyName: String(r.comfyName ?? ''),
    }
    if (next.characterId !== null && !Number.isSafeInteger(next.characterId)) throw new Error('无效角色 ID')
    if (!Number.isFinite(next.recommendedWeight)) throw new Error('无效权重')
    this.write(next)
  }

  private write(r: LoraResource) {
    const { missing: _m, ...rest } = r
    void _m
    atomic(join(this.metaDir, r.id + '.json'), JSON.stringify(rest, null, 2))
  }

  /** 扫描所有 LoRA 根目录。只读取模型目录；未变化的文件复用缓存，不重复读取文件头和元数据。 */
  async scan(roots: string[]) {
    await mkdir(this.metaDir, { recursive: true })
    const rows = await this.list()
    const byPath = new Map(rows.map((r) => [pathKey(r.path), r]))
    const seen = new Set<string>()
    const errors: string[] = []
    // 嵌套的根目录：文件归属最深的那个根目录
    const rootList = [...new Set(roots.map((r) => resolve(r)))].sort((a, b) => b.length - a.length)
    const prefix = (r: string) => (pathKey(r).endsWith(sep) ? pathKey(r) : pathKey(r) + sep)
    const owner = (p: string) => rootList.find((r) => pathKey(p).startsWith(prefix(r))) ?? ''

    const walk = async (dir: string): Promise<void> => {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch (e) {
        errors.push(`${dir}: ${(e as Error).message}`)
        return
      }
      // 同目录文件名（不区分大小写）→ 实际文件名，用于查找同名封面与 metadata.json
      const names = new Map(entries.filter((e) => e.isFile()).map((e) => [e.name.toLowerCase(), e.name]))
      for (const e of entries) {
        if (e.isSymbolicLink()) continue
        const path = join(dir, e.name)
        if (e.isDirectory()) {
          await walk(path)
          continue
        }
        if (!e.isFile() || extname(e.name).toLowerCase() !== '.safetensors') continue
        const key = pathKey(path)
        if (seen.has(key)) continue
        seen.add(key)
        try {
          await this.scanFile(path, owner(path) || dir, names, byPath.get(key))
        } catch (err) {
          errors.push(`${path}: ${(err as Error).message}`)
        }
      }
    }
    for (const root of rootList) {
      const s = await stat(root).catch(() => null)
      if (!s?.isDirectory()) {
        errors.push(`${root}: 目录不存在或无法访问`)
        continue
      }
      await walk(root)
    }
    return errors
  }

  private async scanFile(path: string, root: string, names: Map<string, string>, old: LoraResource | undefined) {
    const s = await stat(path)
    const name = path.slice(path.lastIndexOf(sep) + 1)
    const stem = name.slice(0, -'.safetensors'.length)
    const dir = dirname(path)
    const sibling = (n: string) => {
      const real = names.get(n.toLowerCase())
      return real ? join(dir, real) : ''
    }

    // 文件头：大小与修改时间都未变时复用缓存
    let metadata = old?.metadata ?? {}
    let metadataError = old?.metadataError ?? ''
    if (!old || old.size !== s.size || old.mtime !== s.mtimeMs || old.missing) {
      try {
        metadata = await readHeader(path, s.size)
        metadataError = ''
      } catch (e) {
        metadata = {}
        metadataError = (e as Error).message
      }
    }

    // 同名 .metadata.json：修改时间未变时复用缓存的摘要
    const sidecarPath = sibling(`${stem}.metadata.json`)
    let sidecar = old?.sidecar ?? null
    let sidecarError = old?.sidecarError ?? ''
    let sidecarMtime = old?.sidecarMtime ?? 0
    if (!sidecarPath) {
      sidecar = null
      sidecarError = ''
      sidecarMtime = 0
    } else {
      const ss = await stat(sidecarPath)
      if (!old || old.sidecarPath !== sidecarPath || old.sidecarMtime !== ss.mtimeMs) {
        try {
          sidecar = parseSidecar(JSON.parse((await readFile(sidecarPath, 'utf8')).replace(/^﻿/, '')))
          sidecarError = ''
        } catch (e) {
          sidecar = null
          sidecarError = `metadata.json 无法解析：${(e as Error).message}`
        }
        sidecarMtime = ss.mtimeMs
      }
    }

    // 同名封面：A.jpeg / A.jpg / A.png / A.webp，其次 A.preview.*，再次 metadata.json 中指向本地文件的 preview_url
    let cover = ''
    for (const base of [stem, `${stem}.preview`]) {
      for (const ext of COVER_EXTS) if (!cover) cover = sibling(base + ext)
    }
    if (!cover && sidecar?.previewUrl && !/^[a-z]+:\/\//i.test(sidecar.previewUrl) && COVER_EXTS.includes(extname(sidecar.previewUrl).toLowerCase())) {
      const p = resolve(dir, sidecar.previewUrl)
      if (await stat(p).catch(() => null)) cover = p
    }

    const relativePath = relative(root, path).replaceAll('\\', '/')
    const folder = relativePath.includes('/') ? relativePath.slice(0, relativePath.lastIndexOf('/')) : ''
    const row: LoraResource = {
      id: randomUUID(),
      category: '',
      tags: '',
      note: '',
      recommendedWeight: sidecar?.usage?.strength ?? 1,
      characterId: null,
      comfyName: '',
      preview: '',
      ...old,
      path,
      name,
      relativePath,
      root,
      folder,
      size: s.size,
      mtime: s.mtimeMs,
      metadata,
      metadataError,
      cover,
      sidecar,
      sidecarPath,
      sidecarMtime,
      sidecarError,
      missing: false,
    }
    // 只在内容变化时写回 Vault，避免每次扫描都改动工作区文件
    const strip = (r: LoraResource | undefined) => (r ? canonical({ ...r, missing: false }) : '')
    if (strip(old) !== strip(row)) this.write(row)
  }

  /** 手动指定封面：复制到 Vault（不修改模型目录） */
  async preview(id: string, source: string) {
    const r = (await this.list()).find((x) => x.id === id)
    if (!r) throw new Error('未知 LoRA')
    await mkdir(join(this.root, 'loras/previews'), { recursive: true })
    const path = join('loras/previews', id + '.image')
    await copyFile(source, join(this.root, path))
    this.write({ ...r, preview: path })
  }

  /** 取消手动封面，恢复自动识别的同名封面 */
  async clearPreview(id: string) {
    const r = (await this.list()).find((x) => x.id === id)
    if (!r) throw new Error('未知 LoRA')
    if (r.preview && /^loras[\\/]previews[\\/][a-f0-9-]+\.image$/i.test(r.preview)) await rm(join(this.root, r.preview), { force: true })
    this.write({ ...r, preview: '' })
  }

  /** 封面来源：手动封面优先，其次自动识别的同名图片 / 视频。返回缩略图缓存路径与源文件信息 */
  async imageSource(id: string, width: number) {
    const r = await this.get(id)
    if (!r) return null
    let source = ''
    if (r.preview && /^loras[\\/]previews[\\/][a-f0-9-]+\.image$/i.test(r.preview)) source = join(this.root, r.preview)
    else if (r.cover) source = r.cover
    if (!source) return null
    const s = await stat(source).catch(() => null)
    if (!s) return null
    const video = isVideo(source)
    // 视频只缓存一张静态帧（由页面抽帧后写入），与请求的宽度无关
    const key = createHash('sha1').update(`${pathKey(source)}|${s.mtimeMs}|${s.size}|${video ? 'frame' : width}`).digest('hex')
    return { source, size: s.size, video, cache: join(this.root, '.comfyengi', 'cache', 'lora-thumbs', `${key}.jpg`) }
  }

  /** 保存页面从视频中抽取的静态帧（JPEG），作为卡片封面缓存 */
  async saveFrame(id: string, jpeg: Buffer) {
    if (jpeg.length < 4 || jpeg.length > 2 * 1024 * 1024 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('无效的封面帧')
    const src = await this.imageSource(id, 0)
    if (!src?.video) throw new Error('该 LoRA 没有视频封面')
    await mkdir(dirname(src.cache), { recursive: true })
    await writeFile(src.cache, jpeg)
  }

  /** 以流的方式提供视频封面（支持 Range，供 <video> 播放与拖动），只允许记录中已识别的视频文件 */
  async serveCover(id: string, range: string | null): Promise<Response> {
    const r = await this.get(id)
    const src = r?.cover && !r.preview && isVideo(r.cover) ? r.cover : ''
    const s = src ? await stat(src).catch(() => null) : null
    if (!s) return new Response('not found', { status: 404 })
    const headers: Record<string, string> = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' }
    const stream = (start: number, end: number) => Readable.toWeb(createReadStream(src, { start, end })) as unknown as ReadableStream
    const m = /^bytes=(\d*)-(\d*)$/.exec(range ?? '')
    if (m && (m[1] || m[2])) {
      let start = m[1] ? Number(m[1]) : Math.max(0, s.size - Number(m[2]))
      let end = m[1] && m[2] ? Math.min(Number(m[2]), s.size - 1) : s.size - 1
      if (!m[1]) end = s.size - 1
      if (start >= s.size || start > end) return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${s.size}` } })
      start = Math.max(0, start)
      return new Response(stream(start, end), { status: 206, headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${s.size}`, 'Content-Length': String(end - start + 1) } })
    }
    if (s.size === 0) return new Response(new Uint8Array(0), { status: 200, headers: { ...headers, 'Content-Length': '0' } })
    return new Response(stream(0, s.size - 1), { status: 200, headers: { ...headers, 'Content-Length': String(s.size) } })
  }
}
