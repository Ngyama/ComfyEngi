// 批量放大：本机图片文件 / 文件夹作为来源。
// 图片在测试中生成（只含 tEXt / EXIF 元数据的最小 PNG / JPEG / WebP），prompt 来自 fixtures 中的样本 JSON；
// 执行部分使用模拟 ComfyUI，不能代替在真实 ComfyUI 上的验证。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { newEntry, UPSCALE_CHECKPOINT, UPSCALE_IMAGE, UPSCALE_OUTPUT } from '@shared/mapping'
import type { ApiWorkflow, MappingEntry } from '@shared/types'
import { Runner } from '../src/main/runner'
import type { Store } from '../src/main/store'
import { enqueueUpscale, planUpscale, RESULT_DIR, scanUpscaleFolder, UPLOAD_SUBFOLDER } from '../src/main/upscale'
import { createVault, openVault } from '../src/main/vault'
import { tempDir } from './helpers'
import { ascii, makeJpeg, makeWebp, tiff } from './meta-fixtures'
import { comfyGraph, makePng } from './mining-fixtures'
import { MockComfy } from './mock-comfy'
import { asciiJson, comfyPng, SAMPLE, SAMPLE_POSITIVE, SAMPLE_UP, SAMPLE_UP_MAP } from './upscale-fixtures'

/** 放大工作流（测试用，模拟 ComfyUI 可以执行）：LoadImage → UltimateSDUpscale → SaveImage */
const UP: ApiWorkflow = {
  '1': { class_type: 'LoadImage', inputs: { image: 'example.png', upload: 'image' } },
  '2': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'other.safetensors' } },
  '4': { class_type: 'CLIPTextEncode', inputs: { text: 'up pos', clip: ['2', 1] } },
  '5': { class_type: 'CLIPTextEncode', inputs: { text: 'up neg', clip: ['2', 1] } },
  '9': { class_type: 'UltimateSDUpscale', inputs: { upscale_by: 2, seed: 777, steps: 20, cfg: 6, denoise: 0.25, image: ['1', 0], model: ['2', 0], positive: ['4', 0], negative: ['5', 0], vae: ['2', 2] } },
  '10': { class_type: 'SaveImage', inputs: { filename_prefix: 'up', images: ['9', 0] } },
}
const UP_MAP: MappingEntry[] = [
  newEntry(UPSCALE_IMAGE, '1', 'image'),
  newEntry('positive', '4', 'text'),
  newEntry('negative', '5', 'text'),
  newEntry(UPSCALE_CHECKPOINT, '2', 'ckpt_name'),
  newEntry(UPSCALE_OUTPUT, '10', 'filename_prefix'),
]

const blockText = (c: { issues: { level: string; text: string }[] }) =>
  c.issues
    .filter((x) => x.level === 'block')
    .map((x) => x.text)
    .join('\n')

describe('批量放大：本机图片文件与文件夹', () => {
  let s: Store
  let dir: string
  let upId: number
  let sampleId: number

  beforeEach(() => {
    const root = tempDir()
    createVault(root)
    s = openVault(root)
    upId = s.save('workflows', { name: '放大工作流', api_json: UP, mapping: UP_MAP })
    sampleId = s.save('workflows', { name: '样本放大', api_json: SAMPLE_UP, mapping: SAMPLE_UP_MAP })
    dir = tempDir()
  })
  afterEach(() => s.close())

  const put = (name: string, data: Buffer) => {
    const p = join(dir, name)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, data)
    return p
  }

  it('样本图片的 prompt 元数据：按实际执行的工作流恢复 Prompt / Checkpoint / LoRA，没有运行记录信息', () => {
    const file = put('image_00021_.png', comfyPng(SAMPLE.prompt))
    const plan = planUpscale(s, [{ file }], sampleId)
    expect(plan.errors).toEqual([])
    // 样本放大工作流的 #136 SaveImage 接在前半段采样 #46 之后，不使用输入图片：提示每张图都会多运行一次
    expect(plan.warnings.filter((w) => w.includes('不使用输入图片'))).toHaveLength(1)
    expect(plan.warnings.find((w) => w.includes('不使用输入图片'))).toMatch(/#136/)
    const [c] = plan.candidates
    expect(blockText(c)).toBe('')
    expect(c.kind).toBe('file')
    expect(c.unit_id).toBeNull()
    expect(c.output).toBeNull()
    expect(c.run_name).toBe('')
    expect(c.path).toBe(file)
    expect(c.snapshot).toBe('file')
    expect(c.positive).toBe(SAMPLE_POSITIVE)
    expect(c.negative).toBe(String(SAMPLE.prompt['4'].inputs.populated_text))
    expect(c.checkpoint).toBe('oneObsession_v24.safetensors')
    expect(c.loras!.length).toBeGreaterThan(0)
  })

  it('JPEG / WebP：EXIF 中有 prompt（ComfyUI 写在 Make 中的 "prompt:{…}"）时同样可以放大', () => {
    const exif = tiff([[0x010f, 2, ascii(`prompt:${asciiJson(comfyGraph('1girl, smile'))}`)]])
    for (const file of [put('a.jpg', makeJpeg(exif)), put('b.webp', makeWebp(exif))]) {
      const [c] = planUpscale(s, [{ file }], upId).candidates
      expect(blockText(c)).toBe('')
      expect(c.positive).toBe('1girl, smile')
      expect(c.checkpoint).toBe('model.safetensors')
    }
  })

  it('没有 prompt 块时不能加入，并说明原因（元数据被剥离 / 只有 WebUI parameters / 只有界面格式 workflow / 不是 API 工作流）', () => {
    const cases: [string, Buffer, RegExp][] = [
      ['stripped.png', makePng({}), /没有 ComfyUI 的 prompt 元数据.*剥离/],
      ['webui.png', makePng({ parameters: '1girl\nNegative prompt: lowres\nSteps: 20, Sampler: Euler' }), /只有 WebUI 格式的 parameters/],
      ['ui.png', makePng({ workflow: JSON.stringify({ nodes: [], links: [] }) }), /只有界面格式的 workflow/],
      ['bad.png', makePng({ prompt: JSON.stringify({ a: 1 }) }), /不是 ComfyUI 的 API 工作流/],
      ['stripped.jpg', makeJpeg(tiff([[0x010f, 2, ascii('Canon')]])), /没有 ComfyUI 的 prompt 元数据/],
    ]
    const files = cases.map(([n, d]) => put(n, d))
    const plan = planUpscale(s, files.map((file) => ({ file })), upId)
    for (const [i, [, , re]] of cases.entries()) {
      expect(plan.candidates[i].state).toBe('blocked')
      expect(blockText(plan.candidates[i])).toMatch(re)
    }
    expect(planUpscale(s, [{ file: join(dir, 'missing.png') }], upId).candidates[0].issues[0].text).toMatch(/找不到图片文件/)
    const r = enqueueUpscale(s, files.map((file) => ({ file })), upId, true)
    expect(r.runId).toBeNull()
    expect(r.skipped.map((x) => x.file)).toEqual(files)
  })

  it('放大结果（LoadImage 读取 ComfyEngi 上传的图片）被识别，不能再次放大', () => {
    const g: ApiWorkflow = { ...UP, '1': { class_type: 'LoadImage', inputs: { image: `${UPLOAD_SUBFOLDER}/u0123456789abcdef_x.png`, upload: 'image' } } }
    const file = put('up.png', comfyPng(g))
    const [c] = planUpscale(s, [{ file }], upId).candidates
    expect(c.state).toBe('blocked')
    expect(blockText(c)).toMatch(/^这是放大结果（LoadImage #1/)
  })

  it('映射了「放大：Checkpoint 名称」但原图的 Checkpoint 无法确定时不能加入', () => {
    const g = comfyGraph('1girl') as ApiWorkflow
    g['4'] = { class_type: 'SomeCustomLoader', inputs: { model_path: 'x' } }
    const [c] = planUpscale(s, [{ file: put('nockpt.png', comfyPng(g)) }], upId).candidates
    expect(c.checkpoint).toBeNull()
    expect(c.state).toBe('blocked')
    expect(blockText(c)).toMatch(/无法确定原图使用的 Checkpoint/)
  })

  it('文件夹扫描：按路径排序（数字按大小）；可选包含子文件夹；「放大」子文件夹跳过；非图片文件忽略', () => {
    const png = comfyPng(comfyGraph('x'))
    for (const n of ['b.png', 'a10.png', 'a2.PNG', 'c.webp', 'sub/d.jpg', `${RESULT_DIR}/a.png`, `sub/${RESULT_DIR}/e.png`]) put(n, png)
    put('notes.txt', Buffer.from('x'))
    const flat = scanUpscaleFolder(dir, false)
    expect(flat.files.map((f) => basename(f))).toEqual(['a2.PNG', 'a10.png', 'b.png', 'c.webp'])
    expect(flat.truncated).toBe(false)
    const deep = scanUpscaleFolder(dir, true)
    expect(deep.files.map((f) => f.slice(dir.length + 1).replace(/\\/g, '/'))).toEqual(['a2.PNG', 'a10.png', 'b.png', 'c.webp', 'sub/d.jpg'])
    expect(deep.skipped_dirs).toEqual([join(dir, RESULT_DIR), join(dir, 'sub', RESULT_DIR)])
    const cut = scanUpscaleFolder(dir, true, 2)
    expect(cut.files.length).toBe(2)
    expect(cut.truncated).toBe(true)
    expect(() => scanUpscaleFolder(join(dir, 'nope'), false)).toThrow(/文件夹不存在/)
  })

  it('内容相同的图片（SHA-256 相同）：同一批中只加入第一张；已在队列中的不重复加入（换一个放大工作流可以）', () => {
    const png = comfyPng(comfyGraph('1girl, same'))
    const a = put('a.png', png)
    const b = put('copy/a 副本.png', png)
    const c = put('c.png', comfyPng(comfyGraph('1girl, other')))
    const plan = planUpscale(s, [{ file: a }, { file: b }, { file: c }, { file: a }], upId)
    expect(plan.candidates.map((x) => x.state)).toEqual(['ok', 'blocked', 'ok'])
    expect(blockText(plan.candidates[1])).toBe(`与这次选择的「${a}」内容相同（SHA-256 相同），不重复加入`)
    const r = enqueueUpscale(s, [{ file: a }, { file: b }, { file: c }], upId)
    expect(r.count).toBe(2)
    expect(r.skipped.map((x) => x.file)).toEqual([b])
    // 等待中：同一内容（任意路径）用同一个工作流不重复加入
    const again = planUpscale(s, [{ file: b }], upId).candidates[0]
    expect(blockText(again)).toMatch(/内容相同的图片（SHA-256 相同）已在放大队列中/)
    const other = s.save('workflows', { name: '另一个放大工作流', api_json: UP, mapping: UP_MAP })
    expect(planUpscale(s, [{ file: b }], other).candidates[0].state).toBe('ok')
  })
})

describe('批量放大：文件来源的执行（模拟 ComfyUI）', () => {
  let mock: MockComfy
  let s: Store
  let upId: number
  let runner: Runner | null = null

  beforeEach(async () => {
    mock = new MockComfy(0.01, tempDir())
    await mock.serve(0)
    const root = tempDir()
    createVault(root)
    s = openVault(root)
    s.setSetting('comfy_url', mock.url)
    s.setSetting('poll_interval_sec', 0.05)
    upId = s.save('workflows', { name: '放大工作流', api_json: UP, mapping: UP_MAP })
  })
  afterEach(async () => {
    runner?.stop()
    await runner?.join()
    await mock.shutdown()
    s.close()
  })

  it('上传原图、写入恢复的 Prompt，结果保存到原图所在文件夹的「放大」子文件夹，同名时不覆盖', async () => {
    const dir = tempDir()
    const file = join(dir, '候选 01.png')
    const data = comfyPng(comfyGraph('1girl, smile', 'lowres'))
    writeFileSync(file, data)
    // 已有同名文件：不覆盖，追加 (2)
    mkdirSync(join(dir, RESULT_DIR))
    writeFileSync(join(dir, RESULT_DIR, '候选 01.png'), 'old')
    const r = enqueueUpscale(s, [{ file }], upId)
    expect(r.errors).toEqual([])
    runner = new Runner(s, { eventsFactory: null })
    runner.start()
    await runner.join()
    const [u] = s.listUnits(r.runId!)
    expect(u.status).toBe('done')
    const src = u.meta.upscale!.source
    expect(src).toMatchObject({ kind: 'file', unit_id: null, run_id: null, output: null, snapshot: 'file', path: file, seed: 1 })
    // LoadImage 实际读取的是这张原图（内容相同）
    const [[pid, g]] = mock.submitted
    const loaded = mock.loaded.find(([p]) => p === pid)!
    expect(loaded[2]).toBe(src.sha256)
    expect(String(g['1'].inputs.image).startsWith(`${UPLOAD_SUBFOLDER}/`)).toBe(true)
    expect(g['4'].inputs.text).toBe('1girl, smile')
    expect(g['5'].inputs.text).toBe('lowres')
    expect(g['2'].inputs.ckpt_name).toBe('model.safetensors')
    expect(g['9'].inputs).toMatchObject({ upscale_by: 2, seed: 777, steps: 20, cfg: 6, denoise: 0.25 })
    const fin = u.outputs.find((o) => o.role === 'final')!
    expect(fin.saved).toBe(join(dir, RESULT_DIR, '候选 01 (2).png'))
    expect(existsSync(fin.saved!)).toBe(true)
    expect(readFileSync(join(dir, RESULT_DIR, '候选 01.png'), 'utf8')).toBe('old')
    expect(readFileSync(file).equals(data)).toBe(true)
    // 再次扫描文件夹时不包含放大结果
    expect(scanUpscaleFolder(dir, true).files).toEqual([file])
  })
})
