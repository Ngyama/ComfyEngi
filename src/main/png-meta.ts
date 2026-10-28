// PNG 文本元数据读取（只读）：逐块读取文件头，只解析 tEXt / zTXt / iTXt，图像数据块直接跳过，不解码图片。
// 对异常文件设有上限：单个文本块、解压后大小、文本总量、块数量，超出时报告原因而不是无限读取。

import { open } from 'node:fs/promises'
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

/** 解析内存中的 PNG（用于测试与小文件）：返回文本元数据（同名关键字保留第一个） */
export function parsePngText(buf: Buffer): Record<string, string> {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new PngError('不是 PNG 文件')
  const out: Record<string, string> = {}
  let pos = 8
  let total = 0
  for (let n = 0; ; n++) {
    if (n > PNG_LIMITS.maxChunks) throw new PngError('PNG 块数量异常')
    if (pos + 8 > buf.length) throw new PngError('PNG 文件不完整（缺少结束块）')
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('latin1', pos + 4, pos + 8)
    if (!/^[A-Za-z]{4}$/.test(type)) throw new PngError('PNG 数据块已损坏')
    if (pos + 12 + len > buf.length) throw new PngError('PNG 文件被截断')
    if (type === 'IEND') break
    if (TEXT_TYPES.has(type)) {
      if (len > PNG_LIMITS.maxChunk) throw new PngError('元数据过大')
      const kv = decodeTextChunk(type, buf.subarray(pos + 8, pos + 8 + len))
      if (kv) {
        total += kv[1].length
        if (total > PNG_LIMITS.maxTotalText) throw new PngError('元数据过大')
        if (!(kv[0] in out)) out[kv[0]] = kv[1]
      }
    }
    pos += 12 + len
  }
  return out
}

/** 从文件读取 PNG 文本元数据：只读取块头与文本块，跳过图像数据；文件以只读方式打开 */
export async function readPngText(path: string): Promise<Record<string, string>> {
  const fh = await open(path, 'r')
  try {
    const size = (await fh.stat()).size
    const head = Buffer.alloc(8)
    const read = async (buf: Buffer, at: number) => {
      const { bytesRead } = await fh.read(buf, 0, buf.length, at)
      return bytesRead
    }
    if ((await read(head, 0)) < 8 || !head.equals(SIGNATURE)) throw new PngError('不是 PNG 文件')
    const out: Record<string, string> = {}
    let pos = 8
    let total = 0
    for (let n = 0; ; n++) {
      if (n > PNG_LIMITS.maxChunks) throw new PngError('PNG 块数量异常')
      if ((await read(head, pos)) < 8) throw new PngError('PNG 文件不完整（缺少结束块）')
      const len = head.readUInt32BE(0)
      const type = head.toString('latin1', 4, 8)
      if (!/^[A-Za-z]{4}$/.test(type)) throw new PngError('PNG 数据块已损坏')
      if (pos + 12 + len > size) throw new PngError('PNG 文件被截断')
      if (type === 'IEND') break
      if (TEXT_TYPES.has(type)) {
        if (len > PNG_LIMITS.maxChunk) throw new PngError('元数据过大')
        const data = Buffer.alloc(len)
        if ((await read(data, pos + 8)) < len) throw new PngError('PNG 文件被截断')
        const kv = decodeTextChunk(type, data)
        if (kv) {
          total += kv[1].length
          if (total > PNG_LIMITS.maxTotalText) throw new PngError('元数据过大')
          if (!(kv[0] in out)) out[kv[0]] = kv[1]
        }
      }
      pos += 12 + len
    }
    return out
  } finally {
    await fh.close()
  }
}
