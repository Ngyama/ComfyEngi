// 图片文本元数据读取（只读）：按文件内容（而不是扩展名）识别 PNG / JPEG / WebP。
// PNG：逐块读取文件头，只解析 tEXt / zTXt / iTXt，图像数据块直接跳过，不解码图片。
// JPEG / WebP：读取 EXIF（UserComment = WebUI 的 parameters；ComfyUI 保存 WebP 时写在 Make / Model 中的 "workflow:" / "prompt:"）、注释与 XMP。
// 对异常文件设有上限：单个文本块、解压后大小、文本总量、块数量，超出时报告原因而不是无限读取。
// 文件结构在中途损坏（截断、缺少结束块）时，已读到的元数据仍然返回，并附带警告。

import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { extname } from 'node:path'
import { inflateSync } from 'node:zlib'

export const PNG_LIMITS = {
  /** 单个文本块（压缩前）最大字节数 */
  maxChunk: 16 * 1024 * 1024,
  /** 解压后单个文本的最大字节数 */
  maxInflated: 32 * 1024 * 1024,
  /** 所有文本合计 */
  maxTotalText: 64 * 1024 * 1024,
  /** 最多读取的块数量 */
  maxChunks: 100_000,
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const TEXT_TYPES = new Set(['tEXt', 'zTXt', 'iTXt'])

export class PngError extends Error {}

export type ImageFormat = 'png' | 'jpeg' | 'webp'

/** 一个文本元数据字段：key 为关键字，via 说明存放位置（tEXt / iTXt / EXIF UserComment …） */
export interface MetaField {
  key: string
  text: string
  via: string
}

export interface ImageMeta {
  format: ImageFormat
  fields: MetaField[]
  /** 文件结构问题（已读到的字段仍然有效） */
  warnings: string[]
}

type Read = (at: number, len: number) => Buffer

function decodeText(buf: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    return buf.toString('latin1')
  }
}

function inflate(buf: Buffer): Buffer {
  try {
    return inflateSync(buf, { maxOutputLength: PNG_LIMITS.maxInflated })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE' || /larger than|maxOutputLength/i.test(String((e as Error).message))) throw new PngError('压缩的元数据解压后过大')
    throw new PngError('压缩的元数据已损坏')
  }
}

/** 解析一个文本块，返回 [关键字, 文本]；格式不正确时返回 null */
export function decodeTextChunk(type: string, data: Buffer): [string, string] | null {
  const z = data.indexOf(0)
  if (z <= 0 || z > 79) return null
  const keyword = data.subarray(0, z).toString('latin1')
  if (type === 'tEXt') return [keyword, decodeText(data.subarray(z + 1))]
  if (type === 'zTXt') {
    if (data[z + 1] !== 0) return null
    return [keyword, decodeText(inflate(data.subarray(z + 2)))]
  }
  // iTXt：关键字\0 压缩标志 压缩方法 语言标签\0 翻译关键字\0 文本（UTF-8）
  const compressed = data[z + 1] === 1
  const lang = data.indexOf(0, z + 3)
  if (lang < 0) return null
  const trans = data.indexOf(0, lang + 1)
  if (trans < 0) return null
  const body = data.subarray(trans + 1)
  return [keyword, (compressed ? inflate(body) : body).toString('utf8')]
}

export function sniffFormat(head: Buffer): ImageFormat | null {
  if (head.length >= 8 && head.subarray(0, 8).equals(SIGNATURE)) return 'png'
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg'
  if (head.length >= 12 && head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') return 'webp'
  return null
}

/** 结构错误：没有读到任何字段时抛出；已有字段时记为警告并停止读取 */
function structural(meta: ImageMeta, msg: string): ImageMeta {
  if (!meta.fields.length) throw new PngError(msg)
  meta.warnings.push(`${msg}（已读取此前的元数据）`)
  return meta
}

function parsePng(read: Read, size: number): ImageMeta {
  const meta: ImageMeta = { format: 'png', fields: [], warnings: [] }
  let pos = 8
  let total = 0
  for (let n = 0; ; n++) {
    if (n > PNG_LIMITS.maxChunks) throw new PngError('PNG 块数量异常')
    const head = read(pos, 8)
    if (head.length < 8) return structural(meta, 'PNG 文件不完整（缺少结束块）')
    const len = head.readUInt32BE(0)
    const type = head.toString('latin1', 4, 8)
    if (!/^[A-Za-z]{4}$/.test(type)) return structural(meta, 'PNG 数据块已损坏')
    if (pos + 12 + len > size) {
      if (TEXT_TYPES.has(type) && len > PNG_LIMITS.maxChunk) throw new PngError('元数据过大')
      return structural(meta, 'PNG 文件被截断')
    }
    if (type === 'IEND') break
    if (TEXT_TYPES.has(type)) {
      if (len > PNG_LIMITS.maxChunk) throw new PngError('元数据过大')
      const kv = decodeTextChunk(type, read(pos + 8, len))
      if (kv) {
        total += kv[1].length
        if (total > PNG_LIMITS.maxTotalText) throw new PngError('元数据过大')
        meta.fields.push({ key: kv[0], text: kv[1], via: type })
      }
    }
    pos += 12 + len
  }
  return meta
}

// ---------------- EXIF（JPEG / WebP）

const EXIF_TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 }
const EXIF_TAGS: Record<number, string> = { 0x010e: 'ImageDescription', 0x010f: 'Make', 0x0110: 'Model', 0x0131: 'Software', 0x9286: 'UserComment' }

/** EXIF UserComment：前 8 字节为编码标识（UNICODE = UTF-16，字节序按内容判断） */
function decodeUserComment(b: Buffer): string {
  const code = b.toString('latin1', 0, 8).replace(/\0+$/, '')
  const body = b.subarray(8)
  if (code === 'UNICODE') {
    let evenZeros = 0
    let oddZeros = 0
    for (let i = 0; i + 1 < Math.min(body.length, 400); i += 2) {
      if (body[i] === 0) evenZeros++
      if (body[i + 1] === 0) oddZeros++
    }
    const le = Buffer.from(body.subarray(0, body.length - (body.length % 2)))
    if (evenZeros > oddZeros) le.swap16()
    return le.toString('utf16le').replace(/\0+$/, '')
  }
  return decodeText(code === 'ASCII' || code === '' || code === 'JIS' ? body : b).replace(/\0+$/, '')
}

function parseExif(tiff: Buffer, via: string, out: MetaField[]) {
  if (tiff.length < 8) return
  const le = tiff.toString('latin1', 0, 2) === 'II'
  if (!le && tiff.toString('latin1', 0, 2) !== 'MM') return
  const u16 = (o: number) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o))
  const u32 = (o: number) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o))
  const seen = new Set<number>()
  const ifd = (off: number) => {
    if (seen.has(off) || off + 2 > tiff.length) return
    seen.add(off)
    const count = u16(off)
    for (let i = 0; i < count; i++) {
      const e = off + 2 + i * 12
      if (e + 12 > tiff.length) return
      const tag = u16(e)
      const type = u16(e + 2)
      const n = u32(e + 4)
      if (tag === 0x8769) {
        ifd(u32(e + 8))
        continue
      }
      const name = EXIF_TAGS[tag]
      if (!name) continue
      const bytes = (EXIF_TYPE_SIZE[type] ?? 1) * n
      if (bytes > PNG_LIMITS.maxChunk) continue
      const at = bytes <= 4 ? e + 8 : u32(e + 8)
      if (at + bytes > tiff.length) continue
      const raw = tiff.subarray(at, at + bytes)
      let text = name === 'UserComment' ? decodeUserComment(raw) : decodeText(raw).replace(/\0+$/, '')
      if (!text.trim()) continue
      let key = name === 'UserComment' ? 'parameters' : name
      // ComfyUI 保存 WebP 时把 prompt / workflow 写成 "prompt:{...}" 放在 Make / Model 等字段中
      const m = /^(\w{1,40}):(?=[\s\S])/.exec(text)
      if (m && (name === 'Make' || name === 'Model' || name === 'ImageDescription') && /^[[{]/.test(text.slice(m[0].length).trimStart())) {
        key = m[1]
        text = text.slice(m[0].length)
      }
      out.push({ key, text, via: `${via} ${name}` })
    }
    const next = off + 2 + count * 12
    if (next + 4 <= tiff.length) {
      const nx = u32(next)
      if (nx) ifd(nx)
    }
  }
  try {
    ifd(u32(4))
  } catch {
    // EXIF 结构异常：保留已读到的字段
  }
}

function parseJpeg(read: Read, size: number): ImageMeta {
  const meta: ImageMeta = { format: 'jpeg', fields: [], warnings: [] }
  let pos = 2
  for (let n = 0; n < 1000; n++) {
    const h = read(pos, 4)
    if (h.length < 2) return structural(meta, 'JPEG 文件不完整')
    if (h[0] !== 0xff) return structural(meta, 'JPEG 数据段已损坏')
    const m = h[1]
    if (m === 0xff) {
      pos++
      continue
    }
    if (m === 0xd9 || m === 0xda) break // 结束 / 图像数据开始：元数据都在之前
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) {
      pos += 2
      continue
    }
    if (h.length < 4) return structural(meta, 'JPEG 文件不完整')
    const len = h.readUInt16BE(2)
    if (len < 2 || pos + 2 + len > size) return structural(meta, 'JPEG 文件被截断')
    if (m === 0xe1 || m === 0xfe) {
      const data = read(pos + 4, len - 2)
      if (m === 0xfe) meta.fields.push({ key: 'Comment', text: decodeText(data).replace(/\0+$/, ''), via: 'JPEG COM' })
      else if (data.toString('latin1', 0, 6) === 'Exif\0\0') parseExif(data.subarray(6), 'EXIF', meta.fields)
      else if (data.toString('latin1', 0, 29) === 'http://ns.adobe.com/xap/1.0/\0') meta.fields.push({ key: 'XMP', text: decodeText(data.subarray(29)), via: 'XMP' })
    }
    pos += 2 + len
  }
  return meta
}

function parseWebp(read: Read, size: number): ImageMeta {
  const meta: ImageMeta = { format: 'webp', fields: [], warnings: [] }
  let pos = 12
  for (let n = 0; pos + 8 <= size; n++) {
    if (n > PNG_LIMITS.maxChunks) throw new PngError('WebP 块数量异常')
    const h = read(pos, 8)
    if (h.length < 8) return structural(meta, 'WebP 文件不完整')
    const type = h.toString('latin1', 0, 4)
    const len = h.readUInt32LE(4)
    if (pos + 8 + len > size) return structural(meta, 'WebP 文件被截断')
    if (type === 'EXIF' || type === 'XMP ') {
      if (len > PNG_LIMITS.maxChunk) throw new PngError('元数据过大')
      const data = read(pos + 8, len)
      if (type === 'XMP ') meta.fields.push({ key: 'XMP', text: decodeText(data), via: 'XMP' })
      else parseExif(data.toString('latin1', 0, 6) === 'Exif\0\0' ? data.subarray(6) : data, 'EXIF', meta.fields)
    }
    pos += 8 + len + (len % 2)
  }
  return meta
}

const EXT_FORMAT: Record<string, ImageFormat> = { '.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg', '.webp': 'webp' }
const FORMAT_NAME: Record<ImageFormat, string> = { png: 'PNG', jpeg: 'JPEG', webp: 'WebP' }

/** 解析图片元数据（按文件内容识别格式；扩展名与内容不符时给出提示） */
export function parseImageMeta(read: Read, size: number, name = ''): ImageMeta {
  const head = read(0, 12)
  const format = sniffFormat(head)
  if (!format) throw new PngError(extname(name).toLowerCase() === '.png' ? '不是 PNG 文件（文件内容不是可识别的图片格式）' : '不是可识别的图片文件（支持 PNG / JPEG / WebP）')
  const meta = format === 'png' ? parsePng(read, size) : format === 'jpeg' ? parseJpeg(read, size) : parseWebp(read, size)
  const expected = EXT_FORMAT[extname(name).toLowerCase()]
  if (name && expected && expected !== format) meta.warnings.unshift(`文件扩展名是 ${extname(name)}，但实际是 ${FORMAT_NAME[format]} 图片，已按 ${FORMAT_NAME[format]} 读取`)
  return meta
}

/** 字段列表 → 关键字表（同名关键字保留第一个） */
export function fieldMap(fields: MetaField[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of fields) if (!(f.key in out)) out[f.key] = f.text
  return out
}

const bufReader = (buf: Buffer): Read => (at, len) => buf.subarray(at, Math.min(buf.length, at + len))

/** 解析内存中的 PNG（用于测试与小文件）：返回文本元数据（同名关键字保留第一个） */
export function parsePngText(buf: Buffer): Record<string, string> {
  if (sniffFormat(buf.subarray(0, 12)) !== 'png') throw new PngError('不是 PNG 文件')
  return fieldMap(parsePng(bufReader(buf), buf.length).fields)
}

export const parseImageBuffer = (buf: Buffer, name = '') => parseImageMeta(bufReader(buf), buf.length, name)

/** 从文件读取图片元数据：只读取块头与文本块，跳过图像数据；文件以只读方式打开 */
export function readImageMeta(path: string): ImageMeta {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const read: Read = (at, len) => {
      const buf = Buffer.alloc(Math.max(0, Math.min(len, size - at)))
      const n = buf.length ? readSync(fd, buf, 0, buf.length, at) : 0
      return n < buf.length ? buf.subarray(0, n) : buf
    }
    return parseImageMeta(read, size, path)
  } finally {
    closeSync(fd)
  }
}

/** 兼容旧接口：读取 PNG 文本元数据 */
export async function readPngText(path: string): Promise<Record<string, string>> {
  return fieldMap(readImageMeta(path).fields)
}
