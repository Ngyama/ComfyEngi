// 组合挖掘测试用的小型模拟数据集与 PNG 构造工具。
import { deflateSync } from 'node:zlib'

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
export function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
/** 1×1 PNG，带若干文本块（tEXt；compress 时用 zTXt；itxt 时用 iTXt） */
export function makePng(texts: Record<string, string>, mode: 'tEXt' | 'zTXt' | 'iTXt' = 'tEXt'): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1, 0)
  ihdr.writeUInt32BE(1, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr)]
  for (const [k, v] of Object.entries(texts)) {
    const key = Buffer.from(k + '\0', 'latin1')
    if (mode === 'tEXt') parts.push(chunk('tEXt', Buffer.concat([key, Buffer.from(v, 'latin1')])))
    else if (mode === 'zTXt') parts.push(chunk('zTXt', Buffer.concat([key, Buffer.from([0]), deflateSync(Buffer.from(v, 'utf8'))])))
    else parts.push(chunk('iTXt', Buffer.concat([key, Buffer.from([1, 0]), Buffer.from('\0\0'), deflateSync(Buffer.from(v, 'utf8'))])))
  }
  parts.push(chunk('IDAT', deflateSync(Buffer.from([0, 255, 255, 255]))), chunk('IEND', Buffer.alloc(0)))
  return Buffer.concat(parts)
}

/** ComfyUI 原生 API 图：正向、负向各一个 CLIPTextEncode，另有一个未连接的文本节点 */
export function comfyGraph(positive: string, negative = 'lowres, bad anatomy, worst quality') {
  return {
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'model.safetensors' } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1536, batch_size: 1 } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: positive, clip: ['4', 1] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['4', 1] } },
    '9': { class_type: 'CLIPTextEncode', inputs: { text: 'unused draft text, should not appear', clip: ['4', 1] } },
    '3': { class_type: 'KSampler', inputs: { seed: 1, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '10': { class_type: 'SaveImage', inputs: { filename_prefix: 'ComfyUI', images: ['8', 0] } },
  }
}

// ---------------- 模拟数据集（18 张）：已知的全局 / 局部组合

export const GLOBAL = 'masterpiece, best quality, 1girl'
/** 两个人工预设的局部组合 */
export const COWGIRL = 'cowgirl position, straddling, sitting on lap'
export const MISSIONARY = 'missionary, lying on back, spread legs'
/** 场景标签：在大部分图片中都随机出现，不应被并入局部组合 */
const SCENES = ['bedroom', 'indoors', 'bedroom, indoors', 'outdoors']
const EXPRS = ['blush, smile', 'open mouth', 'looking at viewer', 'blush, closed eyes', '(blush:1.2), smile']

export function dataset(): { id: string; positive: string }[] {
  const out: { id: string; positive: string }[] = []
  // 8 张骑乘：变化部分为表情与 leaning forward / leaning backward
  for (let i = 0; i < 8; i++) out.push({ id: `C:/imgs/cowgirl_${String(i).padStart(2, '0')}.png`, positive: `${GLOBAL}, ${COWGIRL}, ${i % 2 ? 'leaning forward' : 'leaning backward'}, ${EXPRS[i % EXPRS.length]}, ${SCENES[i % SCENES.length]}` })
  // 7 张正常位
  for (let i = 0; i < 7; i++) out.push({ id: `C:/imgs/missionary_${String(i).padStart(2, '0')}.png`, positive: `${GLOBAL}, ${MISSIONARY}, ${EXPRS[(i + 2) % EXPRS.length]}, ${SCENES[(i + 1) % SCENES.length]}` })
  // 3 张单人站立（与上面无关）
  for (let i = 0; i < 3; i++) out.push({ id: `C:/imgs/solo_${i}.png`, positive: `${GLOBAL}, standing, ${SCENES[i % SCENES.length]}` })
  return out
}

/** 在现有 PNG（例如画布导出的图片）的 IHDR 之后插入文本块 */
export function withText(png: Buffer, texts: Record<string, string>): Buffer {
  const ihdrEnd = 8 + 12 + png.readUInt32BE(8)
  const add = Object.entries(texts).map(([k, v]) => chunk('tEXt', Buffer.concat([Buffer.from(k + '\0', 'latin1'), Buffer.from(v, 'latin1')])))
  return Buffer.concat([png.subarray(0, ihdrEnd), ...add, png.subarray(ihdrEnd)])
}
