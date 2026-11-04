// 模拟 ComfyUI HTTP API，用于在没有 GPU / ComfyUI 的环境下测试任务调度。
// 实现本软件用到的接口：/system_stats /object_info /prompt /queue /history /interrupt /view。
// 不实现 /ws（客户端会自动退回到轮询 /history）。
//
// 也可单独运行，配合界面演示完整流程（Node 22.18+ 可直接运行 .ts）：
//   node test/mock-comfy.ts --port 8189 --delay 2 --output-dir %TEMP%\mock_comfy_out

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'

export const OBJECT_INFO: Record<string, unknown> = {
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [['illustrious.safetensors']] } } },
  CLIPTextEncode: { input: { required: { text: ['STRING', {}], clip: ['CLIP'] } } },
  KSampler: { input: { required: { seed: ['INT', {}] } } },
  EmptyLatentImage: { input: { required: {} } },
  VAEDecode: { input: { required: {} } },
  SaveImage: { input: { required: { filename_prefix: ['STRING', {}] } }, output: [], output_node: true },
  LoraLoader: { input: { required: { lora_name: [['charA.safetensors', 'charB.safetensors']] } } },
  // 绕过所需的声明（节点定义按 ComfyUI 内置节点的 RETURN_TYPES 填写）
  DifferentialDiffusion: { input: { required: { model: ['MODEL'], strength: ['FLOAT', { min: 0, max: 1 }] } }, output: ['MODEL'] },
  'Lora Loader (LoraManager)': { input: { required: { model: ['MODEL'], text: ['STRING', {}] }, optional: { clip: ['CLIP'] } }, output: ['MODEL', 'CLIP', 'STRING', 'STRING'] },
  PreviewImage: { input: { required: { images: ['IMAGE'] } }, output: [], output_node: true },
  LoadImage: { input: { required: { image: [['example.png'], { image_upload: true }] } }, output: ['IMAGE', 'MASK'] },
}

/** 解析 multipart/form-data（只用于模拟 /upload/image） */
export function parseMultipart(body: Buffer, contentType: string): { fields: Record<string, string>; files: Record<string, { filename: string; data: Buffer }> } {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
  if (!m) throw new Error('缺少 multipart 边界')
  const sep = Buffer.from(`--${m[1] ?? m[2]}`)
  const fields: Record<string, string> = {}
  const files: Record<string, { filename: string; data: Buffer }> = {}
  let pos = body.indexOf(sep)
  while (pos >= 0) {
    const start = pos + sep.length
    if (body.slice(start, start + 2).toString() === '--') break
    const next = body.indexOf(sep, start)
    if (next < 0) break
    const part = body.slice(start + 2, next - 2) // 去掉开头与结尾的 \r\n
    const split = part.indexOf('\r\n\r\n')
    const head = part.slice(0, split).toString('utf8')
    const data = part.slice(split + 4)
    const name = /name="([^"]*)"/i.exec(head)?.[1] ?? ''
    const filename = /filename="([^"]*)"/i.exec(head)?.[1]
    if (filename !== undefined) files[name] = { filename, data }
    else fields[name] = data.toString('utf8')
    pos = next
  }
  return { fields, files }
}

function crc32(buf: Buffer): number {
  let c = ~0
  for (const b of buf) {
    c ^= b
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

export function tinyPng(color: [number, number, number] = [80, 80, 120], size = 64): Buffer {
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array(size).fill(color).flat())])
  const raw = Buffer.concat(Array(size).fill(row))
  const chunk = (t: string, d: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(d.length)
    const td = Buffer.concat([Buffer.from(t), d])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(td))
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>
type Job = [number, string, Graph]

export class MockComfy {
  delay: number
  outputDir: string | null
  pending: Job[] = []
  running: Job | null = null
  history: Record<string, unknown> = {}
  submitted: [string, Graph][] = []
  counter = 0
  number = 0
  rejectWith: unknown = null
  deterministic = false
  failIds = new Set<string>()
  failAll = false
  paused = false
  interruptFlag = false
  interruptCalls: (string | null)[] = []
  deleted: string[] = []
  /** /upload/image 收到的文件（键为 LoadImage 使用的「子文件夹/文件名」）与每次上传的请求 */
  uploads = new Map<string, Buffer>()
  uploadCalls: { name: string; subfolder: string; overwrite: string; saved: string }[] = []
  /** 模拟 ComfyUI 把上传的文件保存为另一个名称（例如不支持覆盖的旧版本） */
  uploadRename: ((name: string) => string) | null = null
  /** 每次执行时 LoadImage 实际读取的文件：[prompt_id, 文件名, SHA-256] */
  loaded: [string, string, string][] = []
  /** 哪些节点类型会产生保存的图片（output）与预览图片（temp）；默认只有 SaveImage，保持旧测试的行为 */
  saveClasses = /^SaveImage$/
  previewClasses: RegExp | null = null
  /** 执行成功但不返回这些节点的输出（模拟节点被静音或跳过） */
  skipOutputs = new Set<string>()
  url = ''
  private server: Server | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private busy = false

  constructor(delay = 0.05, outputDir: string | null = null) {
    this.delay = delay
    this.outputDir = outputDir
    this.timer = setInterval(() => void this.tick(), 5)
  }

  private async tick() {
    if (this.busy || this.paused || this.running || !this.pending.length) return
    this.busy = true
    const job = this.pending.shift()!
    this.running = job
    this.interruptFlag = false
    const [number, pid, graph] = job
    const end = Date.now() + this.delay * 1000
    while (Date.now() < end && !this.interruptFlag && this.running === job) await new Promise((r) => setTimeout(r, 5))
    if (this.running !== job) {
      // 模拟重启时被清空
      this.busy = false
      return
    }
    const entry: Record<string, unknown> = { prompt: [number, pid, graph, {}, []], outputs: {}, meta: {} }
    // LoadImage：只能读取已上传到 input 目录的文件（与 ComfyUI 相同，不能读取 output 目录）
    const missing = Object.entries(graph).find(([, n]) => n.class_type === 'LoadImage' && !this.uploads.has(String(n.inputs.image)))
    for (const [, n] of Object.entries(graph)) {
      const data = n.class_type === 'LoadImage' ? this.uploads.get(String(n.inputs.image)) : undefined
      if (data) this.loaded.push([pid, String(n.inputs.image), createHash('sha256').update(data).digest('hex')])
    }
    if (missing) {
      entry.status = { status_str: 'error', completed: false, messages: [['execution_error', { prompt_id: pid, node_id: missing[0], node_type: 'LoadImage', exception_type: 'FileNotFoundError', exception_message: `Invalid image file: ${missing[1].inputs.image}` }]] }
    } else if (this.interruptFlag) {
      entry.status = { status_str: 'error', completed: false, messages: [['execution_interrupted', { prompt_id: pid }]] }
    } else if (this.failAll || this.failIds.has(pid)) {
      entry.status = {
        status_str: 'error',
        completed: false,
        messages: [['execution_error', { prompt_id: pid, node_id: '3', node_type: 'KSampler', exception_type: 'RuntimeError', exception_message: '模拟错误' }]],
      }
    } else {
      const outputs: Record<string, unknown> = {}
      for (const [nid, node] of Object.entries(graph)) {
        if (this.skipOutputs.has(nid)) continue
        if (this.previewClasses?.test(node.class_type)) {
          this.counter++
          const fname = `ComfyUI_temp_${String(this.counter).padStart(5, '0')}_.png`
          if (this.outputDir) {
            mkdirSync(join(this.outputDir, '_temp'), { recursive: true })
            writeFileSync(join(this.outputDir, '_temp', fname), tinyPng([1, 1, (this.counter * 13) % 255], 32))
          }
          outputs[nid] = { images: [{ filename: fname, subfolder: '', type: 'temp' }] }
          continue
        }
        if (this.saveClasses.test(node.class_type)) {
          this.counter++
          const prefix = String(node.inputs.filename_prefix ?? 'ComfyUI').split('\\').join('/')
          const cut = prefix.lastIndexOf('/')
          const sub = cut >= 0 ? prefix.slice(0, cut) : ''
          const base = cut >= 0 ? prefix.slice(cut + 1) : prefix
          const fname = `${base}_${String(this.counter).padStart(5, '0')}_.png`
          if (this.outputDir) {
            const d = join(this.outputDir, sub)
            mkdirSync(d, { recursive: true })
            // 确定性模式：图片只由工作流参数决定（输出前缀除外），相当于确定性节点
            const color = this.deterministic ? [...createHash('sha256').update(JSON.stringify(graph, (k, v) => (k === 'filename_prefix' ? undefined : v))).digest()].slice(0, 3) : [(this.counter * 37) % 255, 90, 150]
            writeFileSync(join(d, fname), tinyPng(color as [number, number, number], 256))
          }
          outputs[nid] = { images: [{ filename: fname, subfolder: sub, type: 'output' }] }
        }
      }
      entry.outputs = outputs
      entry.status = { status_str: 'success', completed: true, messages: [] }
    }
    this.history[pid] = entry
    this.running = null
    this.busy = false
  }

  handle(method: string, path: string, body: Record<string, unknown> | null): [number, unknown] {
    const u = new URL(path, 'http://x')
    const p = u.pathname
    if (method === 'GET' && p === '/system_stats') return [200, { system: { os: 'mock', comfyui_version: 'mock' }, devices: [] }]
    if (method === 'GET' && p === '/object_info') return [200, OBJECT_INFO]
    if (method === 'POST' && p === '/prompt') {
      if (this.rejectWith) return [400, this.rejectWith]
      const graph = body?.prompt as Graph
      if (!graph || typeof graph !== 'object')
        return [400, { error: { type: 'invalid_prompt', message: 'Cannot execute because prompt is not a dict', details: '' }, node_errors: {} }]
      const pid = typeof body?.prompt_id === 'string' && body.prompt_id ? body.prompt_id : randomUUID()
      this.number++
      this.pending.push([this.number, pid, graph])
      this.submitted.push([pid, JSON.parse(JSON.stringify(graph))])
      return [200, { prompt_id: pid, number: this.number, node_errors: {} }]
    }
    if (method === 'GET' && p === '/queue') {
      const run = this.running ? [[this.running[0], this.running[1], {}, {}, []]] : []
      return [200, { queue_running: run, queue_pending: this.pending.map(([n, i]) => [n, i, {}, {}, []]) }]
    }
    if (method === 'POST' && p === '/queue') {
      if (body?.clear) throw new Error('不应清空整个队列')
      const ids = (body?.delete as string[]) ?? []
      this.deleted.push(...ids)
      this.pending = this.pending.filter((j) => !ids.includes(j[1]))
      return [200, null]
    }
    if (method === 'GET' && p.startsWith('/history/')) {
      const pid = decodeURIComponent(p.slice('/history/'.length))
      return [200, pid in this.history ? { [pid]: this.history[pid] } : {}]
    }
    if (method === 'POST' && p === '/interrupt') {
      const target = (body?.prompt_id as string) ?? null
      this.interruptCalls.push(target)
      if (this.running && (target === null || target === this.running[1])) this.interruptFlag = true
      return [200, null]
    }
    if (method === 'GET' && p === '/view') {
      if (this.outputDir) {
        const fp = join(this.outputDir, u.searchParams.get('type') === 'temp' ? '_temp' : '', u.searchParams.get('subfolder') ?? '', u.searchParams.get('filename') ?? '')
        if (existsSync(fp)) return [200, readFileSync(fp)]
      }
      return [200, tinyPng()]
    }
    return [404, { error: 'not found' }]
  }

  /** POST /upload/image：与 ComfyUI 的处理相同——overwrite 不是 true 时，同名且内容不同的文件改名为「名称 (n).扩展名」，内容相同时直接使用 */
  upload(fields: Record<string, string>, file: { filename: string; data: Buffer } | undefined): [number, unknown] {
    if (!file) return [400, { error: 'no image' }]
    const subfolder = fields.subfolder ?? ''
    const key = (n: string) => (subfolder ? `${subfolder}/${n}` : n)
    let name = this.uploadRename ? this.uploadRename(file.filename) : file.filename
    if (fields.overwrite !== 'true' && fields.overwrite !== '1') {
      const dot = name.lastIndexOf('.')
      const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
      for (let i = 1; this.uploads.has(key(name)) && !this.uploads.get(key(name))!.equals(file.data); i++) name = `${stem} (${i})${ext}`
    }
    this.uploads.set(key(name), file.data)
    this.uploadCalls.push({ name: file.filename, subfolder, overwrite: fields.overwrite ?? '', saved: key(name) })
    return [200, { name, subfolder, type: fields.type || 'input' }]
  }

  serve(port = 0): Promise<string> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        let code: number, resp: unknown
        try {
          const buf = Buffer.concat(chunks)
          const ct = String(req.headers['content-type'] ?? '')
          if (req.method === 'POST' && new URL(req.url ?? '/', 'http://x').pathname === '/upload/image') {
            const form = parseMultipart(buf, ct)
            ;[code, resp] = this.upload(form.fields, form.files.image)
          } else {
            const raw = buf.toString('utf8')
            ;[code, resp] = this.handle(req.method ?? 'GET', req.url ?? '/', raw ? JSON.parse(raw) : null)
          }
        } catch (e) {
          ;[code, resp] = [500, { error: String(e) }]
        }
        const isBin = Buffer.isBuffer(resp)
        const data = isBin ? (resp as Buffer) : Buffer.from(resp === null ? '' : JSON.stringify(resp))
        res.writeHead(code, { 'Content-Type': isBin ? 'image/png' : 'application/json', 'Content-Length': data.length })
        res.end(data)
      })
    })
    return new Promise((resolve) => {
      this.server!.listen(port, '127.0.0.1', () => {
        const addr = this.server!.address()
        this.url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : port}`
        resolve(this.url)
      })
    })
  }

  /** 模拟 ComfyUI 重启：队列和历史全部丢失 */
  restart() {
    this.pending = []
    this.running = null
    this.history = {}
  }

  async shutdown() {
    if (this.timer) clearInterval(this.timer)
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()))
    this.server?.closeAllConnections?.()
  }
}

// 单独运行：node test/mock-comfy.ts --port 8189 --delay 2 --output-dir <目录>
if (process.argv[1] && /mock-comfy\.ts$/.test(process.argv[1])) {
  const arg = (k: string, d: string) => {
    const i = process.argv.indexOf(k)
    return i > 0 ? process.argv[i + 1] : d
  }
  const mc = new MockComfy(parseFloat(arg('--delay', '2')), arg('--output-dir', '') || null)
  mc.serve(parseInt(arg('--port', '8189'), 10)).then((url) => console.log(`模拟 ComfyUI 已启动：${url}（Ctrl+C 退出）`))
}
