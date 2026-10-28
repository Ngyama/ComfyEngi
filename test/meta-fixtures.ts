// 提取测试用的真实格式元数据样例：按 ComfyUI / WebUI / NovelAI 等软件实际写入的结构手工编写（不含任何第三方图片或代码）。
// 每个样例都给出图片中实际使用的正向 Prompt，测试要求提取结果与之完全一致。

export const POS = 'masterpiece, best quality, 1girl, solo, (long hair:1.2), smile, <lora:detail_tweaker:0.6>'
export const NEG = 'lowres, (worst quality:1.4), bad anatomy, watermark'

type G = Record<string, { class_type: string; inputs: Record<string, unknown>; _meta?: { title: string } }>

/** ComfyUI 默认文生图工作流（API 格式，含 _meta 标题，与 ComfyUI 保存的 prompt 字段结构一致） */
export function apiDefault(pos = POS, neg = NEG): G {
  return {
    '3': { class_type: 'KSampler', inputs: { seed: 156680208700286, steps: 28, cfg: 6.5, sampler_name: 'euler_ancestral', scheduler: 'karras', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] }, _meta: { title: 'KSampler' } },
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'illustrious\\waiNSFW_v140.safetensors' }, _meta: { title: 'Load Checkpoint' } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: 832, height: 1216, batch_size: 1 }, _meta: { title: 'Empty Latent Image' } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: pos, clip: ['4', 1] }, _meta: { title: 'CLIP Text Encode (Prompt)' } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: neg, clip: ['4', 1] }, _meta: { title: 'CLIP Text Encode (Prompt)' } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] }, _meta: { title: 'VAE Decode' } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'ComfyUI', images: ['8', 0] }, _meta: { title: 'Save Image' } },
  }
}

/** 同一个默认工作流的界面格式（workflow 字段：nodes / links / groups / extra，新版前端的控件输入写法） */
export function uiDefault(pos = POS, neg = NEG) {
  const enc = (id: number, link: number, out: number, text: string, y: number) => ({
    id,
    type: 'CLIPTextEncode',
    pos: [413, y],
    size: [425, 180],
    flags: {},
    order: 2,
    mode: 0,
    inputs: [
      { name: 'clip', type: 'CLIP', link },
      { name: 'text', type: 'STRING', widget: { name: 'text' }, link: null },
    ],
    outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING', links: [out], slot_index: 0 }],
    properties: { 'Node name for S&R': 'CLIPTextEncode' },
    widgets_values: [text],
  })
  return {
    last_node_id: 9,
    last_link_id: 9,
    nodes: [
      { id: 4, type: 'CheckpointLoaderSimple', pos: [26, 474], size: [315, 98], flags: {}, order: 0, mode: 0, inputs: [], outputs: [{ name: 'MODEL', type: 'MODEL', links: [1], slot_index: 0 }, { name: 'CLIP', type: 'CLIP', links: [3, 5], slot_index: 1 }, { name: 'VAE', type: 'VAE', links: [8], slot_index: 2 }], properties: {}, widgets_values: ['waiNSFW_v140.safetensors'] },
      { id: 5, type: 'EmptyLatentImage', pos: [473, 609], size: [315, 106], flags: {}, order: 1, mode: 0, inputs: [], outputs: [{ name: 'LATENT', type: 'LATENT', links: [2], slot_index: 0 }], properties: {}, widgets_values: [832, 1216, 1] },
      enc(6, 5, 4, pos, 186),
      enc(7, 3, 6, neg, 390),
      {
        id: 3,
        type: 'KSampler',
        pos: [863, 186],
        size: [315, 262],
        flags: {},
        order: 4,
        mode: 0,
        inputs: [
          { name: 'model', type: 'MODEL', link: 1 },
          { name: 'positive', type: 'CONDITIONING', link: 4 },
          { name: 'negative', type: 'CONDITIONING', link: 6 },
          { name: 'latent_image', type: 'LATENT', link: 2 },
        ],
        outputs: [{ name: 'LATENT', type: 'LATENT', links: [7], slot_index: 0 }],
        properties: {},
        widgets_values: [156680208700286, 'randomize', 28, 6.5, 'euler_ancestral', 'karras', 1],
      },
      { id: 8, type: 'VAEDecode', pos: [1209, 188], size: [210, 46], flags: {}, order: 5, mode: 0, inputs: [{ name: 'samples', type: 'LATENT', link: 7 }, { name: 'vae', type: 'VAE', link: 8 }], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [9], slot_index: 0 }], properties: {} },
      { id: 9, type: 'SaveImage', pos: [1451, 189], size: [210, 58], flags: {}, order: 6, mode: 0, inputs: [{ name: 'images', type: 'IMAGE', link: 9 }], outputs: [], properties: {}, widgets_values: ['ComfyUI'] },
      { id: 12, type: 'Note', pos: [26, 30], size: [300, 80], flags: {}, order: 7, mode: 0, inputs: [], outputs: [], properties: {}, widgets_values: ['remember: 1girl, standing — draft text in a note'] },
    ],
    links: [
      [1, 4, 0, 3, 0, 'MODEL'],
      [2, 5, 0, 3, 3, 'LATENT'],
      [3, 4, 1, 7, 0, 'CLIP'],
      [4, 6, 0, 3, 1, 'CONDITIONING'],
      [5, 4, 1, 6, 0, 'CLIP'],
      [6, 7, 0, 3, 2, 'CONDITIONING'],
      [7, 3, 0, 8, 0, 'LATENT'],
      [8, 4, 2, 8, 1, 'VAE'],
      [9, 8, 0, 9, 0, 'IMAGE'],
    ],
    groups: [],
    config: {},
    extra: { ds: { scale: 1, offset: [0, 0] } },
    version: 0.4,
  }
}

/** Efficiency Nodes：Efficient Loader 保存正负文本，KSampler (Efficient) 从输出槽 1 / 2 读取 */
export function apiEfficient(pos = POS, neg = NEG): G {
  return {
    '4': { class_type: 'Efficient Loader', inputs: { ckpt_name: 'waiNSFW_v140.safetensors', vae_name: 'Baked VAE', clip_skip: -2, lora_name: 'None', lora_model_strength: 1, lora_clip_strength: 1, positive: pos, negative: neg, token_normalization: 'none', weight_interpretation: 'comfy', empty_latent_width: 832, empty_latent_height: 1216, batch_size: 1 } },
    '3': { class_type: 'KSampler (Efficient)', inputs: { seed: 7, steps: 28, cfg: 6, sampler_name: 'euler', scheduler: 'normal', denoise: 1, preview_method: 'auto', vae_decode: 'true', model: ['4', 0], positive: ['4', 1], negative: ['4', 2], latent_image: ['4', 3], optional_vae: ['4', 4] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'eff', images: ['3', 5] } },
  }
}

/** Impact Pack 通配符编码：populated_text 为展开后的最终文本 */
export function apiImpactWildcard(populated: string, template = '__hair__, 1girl, {smile|frown}'): G {
  const g = apiDefault()
  g['10'] = { class_type: 'ImpactWildcardEncode', inputs: { wildcard_text: template, populated_text: populated, mode: true, 'Select to add LoRA': 'Select the LoRA to add to the text', 'Select to add Wildcard': 'Select the Wildcard to add to the text', seed: 42, model: ['4', 0], clip: ['4', 1] } }
  g['3'].inputs.positive = ['10', 2]
  g['3'].inputs.model = ['10', 0]
  delete g['6']
  return g
}

/** WAS Node Suite：两个 Text Multiline 经 Text Concatenate（含 clean_whitespace 选项）后编码 */
export function apiWasConcat(): G {
  const g = apiDefault()
  g['20'] = { class_type: 'Text Multiline', inputs: { text: 'masterpiece, best quality' } }
  g['21'] = { class_type: 'Text Multiline', inputs: { text: '1girl, solo, smile' } }
  g['22'] = { class_type: 'Text Concatenate', inputs: { delimiter: ', ', clean_whitespace: 'true', text_a: ['20', 0], text_b: ['21', 0] } }
  g['6'].inputs.text = ['22', 0]
  return g
}

/** rgthree Power Prompt：文本 + 可选 clip，输出 CONDITIONING */
export function apiPowerPrompt(): G {
  const g = apiDefault()
  g['30'] = { class_type: 'Power Prompt (rgthree)', inputs: { prompt: POS, opt_model: ['4', 0], opt_clip: ['4', 1], insert_lora: 'CHOOSE', insert_embedding: 'CHOOSE', insert_saved: 'CHOOSE' } }
  g['3'].inputs.positive = ['30', 0]
  delete g['6']
  return g
}

/** ComfyUI-Easy-Use 管道：fullLoader → preSampling → kSampler，采样节点只有 pipe 输入 */
export function apiEasyPipe(pos = POS, neg = NEG): G {
  return {
    '1': { class_type: 'easy fullLoader', inputs: { ckpt_name: 'waiNSFW_v140.safetensors', config_name: 'Default', vae_name: 'Baked VAE', clip_skip: -2, lora_name: 'None', lora_model_strength: 1, lora_clip_strength: 1, resolution: '832 x 1216', empty_latent_width: 512, empty_latent_height: 512, positive: pos, positive_token_normalization: 'none', positive_weight_interpretation: 'comfy', negative: neg, negative_token_normalization: 'none', negative_weight_interpretation: 'comfy', batch_size: 1 } },
    '2': { class_type: 'easy preSampling', inputs: { steps: 20, cfg: 7, sampler_name: 'euler_ancestral', scheduler: 'normal', denoise: 1, seed: 1, pipe: ['1', 0] } },
    '3': { class_type: 'easy kSampler', inputs: { image_output: 'Preview', link_id: 0, save_prefix: 'ComfyUI', pipe: ['2', 0] } },
  }
}

/** Flux：负向为 ConditioningZeroOut(正向)，正向经过 FluxGuidance；SamplerCustomAdvanced + BasicGuider 之外的 KSampler 写法 */
export function apiFlux(pos = POS): G {
  return {
    '11': { class_type: 'DualCLIPLoader', inputs: { clip_name1: 't5xxl_fp8.safetensors', clip_name2: 'clip_l.safetensors', type: 'flux' } },
    '12': { class_type: 'UNETLoader', inputs: { unet_name: 'flux1-dev.safetensors', weight_dtype: 'default' } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: pos, clip: ['11', 0] } },
    '26': { class_type: 'FluxGuidance', inputs: { guidance: 3.5, conditioning: ['6', 0] } },
    '33': { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['6', 0] } },
    '27': { class_type: 'EmptySD3LatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
    '31': { class_type: 'KSampler', inputs: { seed: 1, steps: 20, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1, model: ['12', 0], positive: ['26', 0], negative: ['33', 0], latent_image: ['27', 0] } },
  }
}

/** SamplerCustomAdvanced + CFGGuider */
export function apiCustomAdvanced(pos = POS, neg = NEG): G {
  const g = apiDefault(pos, neg)
  delete g['3']
  g['22'] = { class_type: 'CFGGuider', inputs: { cfg: 5, model: ['4', 0], positive: ['6', 0], negative: ['7', 0] } }
  g['16'] = { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } }
  g['17'] = { class_type: 'BasicScheduler', inputs: { scheduler: 'normal', steps: 20, denoise: 1, model: ['4', 0] } }
  g['25'] = { class_type: 'RandomNoise', inputs: { noise_seed: 1 } }
  g['13'] = { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['25', 0], guider: ['22', 0], sampler: ['16', 0], sigmas: ['17', 0], latent_image: ['5', 0] } }
  g['8'].inputs.samples = ['13', 0]
  return g
}

/** 两阶段（Hires fix）+ FaceDetailer：第二阶段和面部修复使用不同的 Prompt */
export function apiHiresDetailer(pos = POS, neg = NEG): G {
  const g = apiDefault(pos, neg)
  g['40'] = { class_type: 'LatentUpscaleBy', inputs: { upscale_method: 'nearest-exact', scale_by: 1.5, samples: ['3', 0] } }
  g['42'] = { class_type: 'CLIPTextEncode', inputs: { text: 'highres, sharp focus, detailed', clip: ['4', 1] } }
  g['41'] = { class_type: 'KSampler', inputs: { seed: 2, steps: 15, cfg: 5, sampler_name: 'euler', scheduler: 'karras', denoise: 0.45, model: ['4', 0], positive: ['42', 0], negative: ['7', 0], latent_image: ['40', 0] } }
  g['8'].inputs.samples = ['41', 0]
  g['51'] = { class_type: 'CLIPTextEncode', inputs: { text: 'detailed face, beautiful eyes', clip: ['4', 1] } }
  g['50'] = { class_type: 'FaceDetailer', inputs: { guide_size: 512, guide_size_for: true, max_size: 1024, seed: 3, steps: 20, cfg: 6, sampler_name: 'euler', scheduler: 'normal', denoise: 0.4, feather: 5, noise_mask: true, force_inpaint: true, wildcard: '', image: ['8', 0], model: ['4', 0], clip: ['4', 1], vae: ['4', 2], positive: ['51', 0], negative: ['7', 0], bbox_detector: ['52', 0] } }
  g['52'] = { class_type: 'UltralyticsDetectorProvider', inputs: { model_name: 'bbox/face_yolov8m.pt' } }
  g['9'].inputs.images = ['50', 0]
  return g
}

/** 自定义节点生成 Prompt（PNG 中只有它的设置）：自动提取失败，但 prompt_text 字段中有可用文本 */
export function apiCustomComposer(subject: string, idShift = 0): G {
  const g = apiDefault('', NEG)
  const id = (n: number) => String(n + idShift)
  const out: G = {}
  for (const [k, v] of Object.entries(g)) out[id(Number(k))] = JSON.parse(JSON.stringify(v).replace(/\["(\d+)",/g, (_m, n) => `["${id(Number(n))}",`))
  out[id(50)] = { class_type: 'PromptComposer', inputs: { prompt_text: subject, style_preset: 'anime', seed: 9 } }
  out[id(6)].inputs.text = [id(50), 0]
  return out
}

/** A1111 / Forge 的 parameters 文本（多行正向、BREAK、LoRA、Hires 参数） */
export const A1111_POS = 'masterpiece, best quality, 1girl,\n(long hair:1.2), smile BREAK\nindoors, <lora:add_detail:0.5>'
export const A1111 = `${A1111_POS}\nNegative prompt: ${NEG}\nSteps: 28, Sampler: DPM++ 2M, Schedule type: Karras, CFG scale: 6, Seed: 1234, Size: 832x1216, Model hash: 0123abcd, Model: waiNSFW, Denoising strength: 0.4, Hires upscale: 1.5, Hires upscaler: R-ESRGAN 4x+ Anime6B, Lora hashes: "add_detail: 7c6bad76eb54", Version: f2.0.1v1.10.1`

/** NovelAI：Description 为正向，Comment 为 JSON（prompt / uc） */
export const NOVELAI = {
  Title: 'NovelAI generated image',
  Description: '1girl, solo, {{smile}}, school uniform',
  Software: 'NovelAI',
  Source: 'NovelAI Diffusion V4 4F6C3F9E',
  'Generation time': '6.1',
  Comment: JSON.stringify({ prompt: '1girl, solo, {{smile}}, school uniform', steps: 28, height: 1216, width: 832, scale: 5, uc: 'lowres, bad anatomy', seed: 1, sampler: 'k_euler_ancestral', v4_prompt: { caption: { base_caption: '1girl, solo, {{smile}}, school uniform', char_captions: [{ char_caption: 'girl, red eyes', centers: [{ x: 0.5, y: 0.5 }] }] } } }),
}

// ---------------- 非 PNG 容器：EXIF（JPEG / WebP）

type Entry = [tag: number, type: number, data: Buffer]

/** 小端 TIFF：IFD0（可含 ExifIFD 指针）+ ExifIFD */
export function tiff(ifd0: Entry[], exif: Entry[] = []): Buffer {
  const entries0 = exif.length ? [...ifd0, [0x8769, 4, Buffer.alloc(4)] as Entry] : ifd0
  const size = (n: number) => 2 + 12 * n + 4
  const off0 = 8
  const off1 = off0 + size(entries0.length)
  let dataAt = off1 + (exif.length ? size(exif.length) : 0)
  const data: Buffer[] = []
  const ifd = (list: Entry[], ptr?: number) => {
    const b = Buffer.alloc(size(list.length))
    b.writeUInt16LE(list.length, 0)
    list.forEach(([tag, type, d], i) => {
      const e = 2 + i * 12
      b.writeUInt16LE(tag, e)
      b.writeUInt16LE(type, e + 2)
      b.writeUInt32LE(type === 3 ? d.length / 2 : type === 4 ? d.length / 4 : d.length, e + 4)
      if (tag === 0x8769) b.writeUInt32LE(ptr!, e + 8)
      else if (d.length <= 4) d.copy(b, e + 8)
      else {
        b.writeUInt32LE(dataAt, e + 8)
        data.push(d)
        dataAt += d.length
      }
    })
    return b
  }
  const head = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00])
  const a = ifd(entries0, off1)
  const b = exif.length ? ifd(exif) : Buffer.alloc(0)
  return Buffer.concat([head, a, b, ...data])
}

/** A1111 写入 JPEG / WebP 的 UserComment：UNICODE 前缀 + UTF-16BE */
export function userComment(text: string): Buffer {
  const le = Buffer.from(text, 'utf16le')
  return Buffer.concat([Buffer.from('UNICODE\0', 'latin1'), Buffer.from(le).swap16()])
}
export const ascii = (s: string) => Buffer.from(`${s}\0`, 'utf8')

export function makeJpeg(exif: Buffer): Buffer {
  const app1 = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), exif])
  const len = Buffer.alloc(2)
  len.writeUInt16BE(app1.length + 2)
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), len, app1, Buffer.from([0xff, 0xda, 0x00, 0x02, 0x00, 0xff, 0xd9])])
}

export function makeWebp(exif: Buffer): Buffer {
  const chunk = (type: string, d: Buffer) => {
    const h = Buffer.alloc(8)
    h.write(type, 0, 'latin1')
    h.writeUInt32LE(d.length, 4)
    return Buffer.concat([h, d, d.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)])
  }
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), chunk('VP8X', Buffer.alloc(10)), chunk('VP8L', Buffer.alloc(6)), chunk('EXIF', exif)])
  const h = Buffer.alloc(8)
  h.write('RIFF', 0, 'latin1')
  h.writeUInt32LE(body.length, 4)
  return Buffer.concat([h, body])
}

/** 与 Python json.dumps（ensure_ascii）相同：非 ASCII 字符写成 \uXXXX（ComfyUI 写入 tEXt 时的形式） */
export const pyJson = (v: unknown) => JSON.stringify(v).replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
