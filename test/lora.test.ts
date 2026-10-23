// LoRA 本地浏览：文件夹层级、同名封面、ComfyUI-Lora-Manager 元数据、只读保护与缓存。

import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createVault } from '../src/main/vault'
import { htmlToText, LoraManager, parseSidecar } from '../src/main/lora-manager'
import { tempDir } from './helpers'

function safetensors(meta: Record<string, string> = {}) {
  const header = Buffer.from(JSON.stringify({ __metadata__: meta }))
  const n = Buffer.alloc(8)
  n.writeBigUInt64LE(BigInt(header.length))
  return Buffer.concat([n, header, Buffer.alloc(64)])
}

// ComfyUI-Lora-Manager 生成的 metadata.json（字段与其 LoraMetadata 一致，内容为测试数据）
const PLUGIN_META = {
  file_name: 'A',
  model_name: 'Character A',
  file_path: 'D:/ComfyUI/models/loras/characters/A.safetensors',
  size: 123,
  modified: 1700000000.5,
  sha256: 'abc123',
  base_model: 'Illustrious',
  preview_url: 'D:/ComfyUI/models/loras/characters/A.jpeg',
  preview_nsfw_level: 0,
  notes: '自己的笔记',
  from_civitai: true,
  civitai: {
    id: 9001,
    modelId: 42,
    name: 'v2.0',
    baseModel: 'Illustrious',
    trainedWords: ['char_a', 'red hair', 'char_a'],
    model: { name: 'Character A', type: 'LORA', description: '<p>Hello <b>world</b></p><p>2nd</p>', tags: ['ignored-when-root-tags'] },
    creator: { username: 'someone' },
    images: [{ url: 'https://example.invalid/1.jpeg' }],
  },
  tags: ['character', 'anime'],
  modelDescription: '<p>第一段&amp;说明</p><ul><li>要点</li></ul>',
  civitai_deleted: false,
  favorite: true,
  exclude: false,
  usage_tips: '{"strength": 0.8, "strength_min": 0.6, "strength_max": 1.0, "clip_strength": 0.9}',
}

function setupLoras() {
  const root = tempDir()
  const loras = join(root, 'loras')
  for (const d of ['characters', 'background', 'background/night/deep']) mkdirSync(join(loras, d), { recursive: true })
  writeFileSync(join(loras, 'characters/A.safetensors'), safetensors({ ss_output_name: 'A' }))
  writeFileSync(join(loras, 'characters/A.metadata.json'), JSON.stringify(PLUGIN_META))
  writeFileSync(join(loras, 'characters/A.jpeg'), 'jpeg-bytes')
  writeFileSync(join(loras, 'background/B.safetensors'), safetensors())
  writeFileSync(join(loras, 'background/B.metadata.json'), JSON.stringify({ model_name: 'Background B', base_model: '' }))
  writeFileSync(join(loras, 'background/B.JPEG'), 'upper-case-ext')
  writeFileSync(join(loras, 'background/night/deep/C.safetensors'), safetensors())
  writeFileSync(join(loras, 'background/night/deep/C.webp'), 'webp-bytes')
  writeFileSync(join(loras, 'background/night/D.safetensors'), safetensors())
  writeFileSync(join(loras, 'background/night/D.preview.png'), 'png-bytes')
  writeFileSync(join(loras, 'E.safetensors'), safetensors())
  writeFileSync(join(loras, 'E.metadata.json'), '{ broken json')
  return loras
}

function newManager() {
  const vault = tempDir()
  createVault(vault)
  return new LoraManager(vault)
}

const snapshot = (dir: string): Record<string, string> => {
  const out: Record<string, string> = {}
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else out[p] = createHash('sha1').update(readFileSync(p)).digest('hex') + ':' + statSync(p).mtimeMs
    }
  }
  walk(dir)
  return out
}

describe('LoRA Manager 本地浏览', () => {
  it('保留真实子目录层级', async () => {
    const loras = setupLoras()
    const m = newManager()
    expect(await m.scan([loras])).toEqual([])
    const rows = await m.list()
    const by = (n: string) => rows.find((r) => r.name === n)!
    expect(rows).toHaveLength(5)
    expect(by('A.safetensors').folder).toBe('characters')
    expect(by('B.safetensors').folder).toBe('background')
    expect(by('C.safetensors').folder).toBe('background/night/deep')
    expect(by('D.safetensors').folder).toBe('background/night')
    expect(by('E.safetensors').folder).toBe('')
    expect(by('C.safetensors').relativePath).toBe('background/night/deep/C.safetensors')
    expect(rows.every((r) => r.root === loras)).toBe(true)
  })

  it('自动关联同名封面（大小写不敏感、.preview.*），没有封面时为空', async () => {
    const loras = setupLoras()
    const m = newManager()
    await m.scan([loras])
    const rows = await m.list()
    const cover = (n: string) => rows.find((r) => r.name === n)!.cover
    expect(cover('A.safetensors')).toBe(join(loras, 'characters/A.jpeg'))
    expect(cover('B.safetensors')).toBe(join(loras, 'background/B.JPEG'))
    expect(cover('C.safetensors')).toBe(join(loras, 'background/night/deep/C.webp'))
    expect(cover('D.safetensors')).toBe(join(loras, 'background/night/D.preview.png'))
    expect(cover('E.safetensors')).toBe('')
  })

  it('读取同名 metadata.json 中实际存在的字段，损坏的文件不报错', async () => {
    const loras = setupLoras()
    const m = newManager()
    expect(await m.scan([loras])).toEqual([])
    const rows = await m.list()
    const a = rows.find((r) => r.name === 'A.safetensors')!
    expect(a.sidecar).toEqual({
      modelName: 'Character A',
      baseModel: 'Illustrious',
      description: '第一段&说明\n• 要点',
      tags: ['character', 'anime'],
      triggerWords: ['char_a', 'red hair'],
      usage: { strength: 0.8, strengthMin: 0.6, strengthMax: 1, clipStrength: 0.9 },
      notes: '自己的笔记',
      versionName: 'v2.0',
      creator: 'someone',
      modelType: 'LORA',
      sha256: 'abc123',
      civitaiModelId: 42,
      civitaiVersionId: 9001,
      favorite: true,
      previewUrl: 'D:/ComfyUI/models/loras/characters/A.jpeg',
    })
    expect(a.recommendedWeight).toBe(0.8) // 新记录的推荐权重取自 usage_tips
    expect(a.metadata).toEqual({ ss_output_name: 'A' })
    // 只有存在的字段才出现
    expect(rows.find((r) => r.name === 'B.safetensors')!.sidecar).toEqual({ modelName: 'Background B' })
    expect(rows.find((r) => r.name === 'C.safetensors')!.sidecar).toBeNull()
    const e = rows.find((r) => r.name === 'E.safetensors')!
    expect(e.sidecar).toBeNull()
    expect(e.sidecarError).toContain('metadata.json 无法解析')
  })

  it('解析器容忍缺失字段与不同写法', () => {
    expect(parseSidecar({})).toEqual({})
    expect(parseSidecar({ usage_tips: 'not json', tags: 'a, b ,a', civitai: null })).toEqual({ tags: ['a', 'b'] })
    expect(parseSidecar({ usage_tips: { strength: '0.7' } })).toEqual({ usage: { strength: 0.7 } })
    expect(() => parseSidecar([1, 2])).toThrow()
    expect(htmlToText('<p>a<br>b</p>&lt;tag&gt;')).toBe('a\nb\n<tag>')
  })

  it('扫描不修改模型目录中的任何文件', async () => {
    const loras = setupLoras()
    const before = snapshot(loras)
    const m = newManager()
    await m.scan([loras])
    await m.scan([loras])
    expect(snapshot(loras)).toEqual(before)
  })

  it('未变化时不重写 Vault 记录；元数据、封面变化后重新扫描即可更新', async () => {
    const loras = setupLoras()
    const m = newManager()
    await m.scan([loras])
    const metaDir = join(m.root, 'loras/metadata')
    const files = () => Object.fromEntries(readdirSync(metaDir).map((f) => [f, statSync(join(metaDir, f)).mtimeMs]))
    const first = files()
    await new Promise((r) => setTimeout(r, 30))
    await m.scan([loras])
    expect(files()).toEqual(first)

    writeFileSync(join(loras, 'background/B.metadata.json'), JSON.stringify({ model_name: 'Renamed B', tags: ['night'] }))
    const t = Date.now() / 1000 + 5
    utimesSync(join(loras, 'background/B.metadata.json'), t, t)
    writeFileSync(join(loras, 'E.png'), 'new cover')
    await m.scan([loras])
    const rows = await m.list()
    expect(rows.find((r) => r.name === 'B.safetensors')!.sidecar).toEqual({ modelName: 'Renamed B', tags: ['night'] })
    expect(rows.find((r) => r.name === 'E.safetensors')!.cover).toBe(join(loras, 'E.png'))
  })

  it('多个根目录、嵌套根目录、重复添加都不会产生重复记录', async () => {
    const loras = setupLoras()
    const other = tempDir()
    writeFileSync(join(other, 'F.safetensors'), safetensors())
    const m = newManager()
    const dup = process.platform === 'win32' ? loras.toUpperCase() : loras
    expect(await m.scan([loras, join(loras, 'background'), other, dup])).toEqual([])
    const rows = await m.list()
    expect(rows).toHaveLength(6)
    // 嵌套根目录：归属最深的根目录
    const b = rows.find((r) => r.name === 'B.safetensors')!
    expect(b.root).toBe(join(loras, 'background'))
    expect(b.folder).toBe('')
    expect(rows.find((r) => r.name === 'F.safetensors')!.root).toBe(other)
    expect(await m.scan([join(loras, 'missing-dir')])).toEqual([expect.stringContaining('目录不存在')])
  })

  it('ComfyEngi 的标签、备注、角色关联在重新扫描后保留，不写入插件元数据', async () => {
    const loras = setupLoras()
    const m = newManager()
    await m.scan([loras])
    const a = (await m.list()).find((r) => r.name === 'A.safetensors')!
    await m.save({ ...a, tags: '常用', note: '我的备注', characterId: 7, recommendedWeight: 0.65, comfyName: 'characters\\A.safetensors' })
    const sidecarBefore = readFileSync(join(loras, 'characters/A.metadata.json'), 'utf8')
    await m.scan([loras])
    const again = (await m.list()).find((r) => r.id === a.id)!
    expect([again.tags, again.note, again.characterId, again.recommendedWeight, again.comfyName]).toEqual(['常用', '我的备注', 7, 0.65, 'characters\\A.safetensors'])
    expect(again.sidecar?.tags).toEqual(['character', 'anime'])
    expect(readFileSync(join(loras, 'characters/A.metadata.json'), 'utf8')).toBe(sidecarBefore)
  })

  it('手动封面优先，取消后恢复自动封面；缩略图缓存键随源文件变化', async () => {
    const loras = setupLoras()
    const m = newManager()
    await m.scan([loras])
    const a = (await m.list()).find((r) => r.name === 'A.safetensors')!
    const auto = await m.imageSource(a.id, 400)
    expect(auto?.source).toBe(join(loras, 'characters/A.jpeg'))
    expect(auto?.cache).toContain(join('.comfyengi', 'cache', 'lora-thumbs'))
    const manual = join(tempDir(), 'mine.png')
    writeFileSync(manual, 'manual')
    await m.preview(a.id, manual)
    expect((await m.imageSource(a.id, 400))?.source).toBe(join(m.root, 'loras/previews', `${a.id}.image`))
    await m.clearPreview(a.id)
    expect((await m.imageSource(a.id, 400))?.source).toBe(auto?.source)
    writeFileSync(join(loras, 'characters/A.jpeg'), 'changed-bytes!')
    expect((await m.imageSource(a.id, 400))?.cache).not.toBe(auto?.cache)
    const e = (await m.list()).find((r) => r.name === 'E.safetensors')!
    expect(await m.imageSource(e.id, 400)).toBeNull()
  })

  it('兼容旧版记录（没有 root / folder 字段）', async () => {
    const m = newManager()
    const loras = setupLoras()
    const old = { id: '11111111-1111-1111-1111-111111111111', path: join(loras, 'characters/A.safetensors'), name: 'A.safetensors', relativePath: 'characters/A.safetensors', size: 1, mtime: 1, metadata: {}, metadataError: '', category: '', tags: 'old-tag', note: '', recommendedWeight: 1, characterId: 3, comfyName: '', preview: '' }
    writeFileSync(join(m.root, 'loras/metadata', `${old.id}.json`), JSON.stringify(old))
    const listed = (await m.list())[0]
    expect([listed.folder, listed.cover, listed.sidecar]).toEqual(['characters', '', null])
    await m.scan([loras])
    const rows = await m.list()
    const a = rows.find((r) => r.name === 'A.safetensors')!
    expect(rows.filter((r) => r.name === 'A.safetensors')).toHaveLength(1)
    expect([a.id, a.tags, a.characterId, a.root]).toEqual([old.id, 'old-tag', 3, loras])
    expect(a.sidecar?.modelName).toBe('Character A')
  })
})

describe('LoRA 视频封面', () => {
  async function setupVideo() {
    const loras = tempDir()
    mkdirSync(join(loras, 'chars'), { recursive: true })
    writeFileSync(join(loras, 'chars/V.safetensors'), safetensors())
    writeFileSync(join(loras, 'chars/V.mp4'), Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256)))
    writeFileSync(join(loras, 'chars/Both.safetensors'), safetensors())
    writeFileSync(join(loras, 'chars/Both.mp4'), 'video')
    writeFileSync(join(loras, 'chars/Both.png'), 'image')
    const m = newManager()
    await m.scan([loras])
    const rows = await m.list()
    return { loras, m, v: rows.find((r) => r.name === 'V.safetensors')!, both: rows.find((r) => r.name === 'Both.safetensors')! }
  }

  it('自动识别同名 .mp4；同时存在图片时优先使用图片', async () => {
    const { loras, v, both } = await setupVideo()
    expect(v.cover).toBe(join(loras, 'chars/V.mp4'))
    expect(both.cover).toBe(join(loras, 'chars/Both.png'))
  })

  it('以流方式提供视频（支持 Range），只允许记录中的视频封面', async () => {
    const { m, v, both } = await setupVideo()
    const full = await m.serveCover(v.id, null)
    expect(full.status).toBe(200)
    expect(full.headers.get('content-type')).toBe('video/mp4')
    expect(Buffer.from(await full.arrayBuffer())).toHaveLength(1000)
    const part = await m.serveCover(v.id, 'bytes=100-199')
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe('bytes 100-199/1000')
    expect([...Buffer.from(await part.arrayBuffer())]).toEqual(Array.from({ length: 100 }, (_, i) => (100 + i) % 256))
    const open = await m.serveCover(v.id, 'bytes=990-')
    expect(open.headers.get('content-range')).toBe('bytes 990-999/1000')
    const suffix = await m.serveCover(v.id, 'bytes=-10')
    expect(suffix.headers.get('content-range')).toBe('bytes 990-999/1000')
    expect((await m.serveCover(v.id, 'bytes=5000-')).status).toBe(416)
    expect((await m.serveCover(both.id, null)).status).toBe(404) // 图片封面不经过视频协议
    expect((await m.serveCover('../../etc', null)).status).toBe(404)
  })

  it('抽帧缓存：只接受 JPEG，写入工作区缓存；视频变化后缓存失效', async () => {
    const { loras, m, v, both } = await setupVideo()
    const src = await m.imageSource(v.id, 360)
    expect(src?.video).toBe(true)
    expect((await m.imageSource(v.id, 1200))?.cache).toBe(src?.cache) // 静态帧与宽度无关
    await expect(m.saveFrame(v.id, Buffer.from('not a jpeg'))).rejects.toThrow()
    await expect(m.saveFrame(both.id, Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).rejects.toThrow('没有视频封面')
    await m.saveFrame(v.id, Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
    expect(readFileSync(src!.cache)).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
    expect(src!.cache.startsWith(m.root)).toBe(true)
    writeFileSync(join(loras, 'chars/V.mp4'), 'changed video bytes')
    expect((await m.imageSource(v.id, 360))?.cache).not.toBe(src?.cache)
  })
})

describe('缺失与离线的 LoRA', () => {
  const metaCount = (m: LoraManager) => readdirSync(join(m.root, 'loras/metadata')).filter((f) => f.endsWith('.json')).length

  it('已删除的文件标记为缺失，记录与用户信息完整保留，重新扫描不删除也不新增', async () => {
    const loras = setupLoras()
    const m = newManager()
    await m.scan([loras])
    const a = (await m.list()).find((r) => r.name === 'A.safetensors')!
    await m.save({ ...a, tags: '常用', note: '备注', characterId: 5 })
    const n = metaCount(m)
    rmSync(join(loras, 'characters/A.safetensors'))
    await m.scan([loras])
    const row = (await m.list()).find((r) => r.id === a.id)!
    expect([row.missing, row.offline]).toEqual([true, false])
    expect([row.tags, row.note, row.characterId]).toEqual(['常用', '备注', 5])
    expect(metaCount(m)).toBe(n)
    expect((await m.list()).filter((r) => !r.missing && !r.offline)).toHaveLength(4)
  })

  it('文件放回原处后恢复原记录（同一 ID）', async () => {
    const loras = setupLoras()
    const m = newManager()
    await m.scan([loras])
    const a = (await m.list()).find((r) => r.name === 'A.safetensors')!
    await m.save({ ...a, tags: 'keep' })
    const bytes = readFileSync(join(loras, 'characters/A.safetensors'))
    rmSync(join(loras, 'characters/A.safetensors'))
    await m.scan([loras])
    writeFileSync(join(loras, 'characters/A.safetensors'), bytes)
    await m.scan([loras])
    const rows = (await m.list()).filter((r) => r.name === 'A.safetensors')
    expect(rows).toHaveLength(1)
    expect([rows[0].id, rows[0].missing, rows[0].tags]).toEqual([a.id, false, 'keep'])
  })

  it('同名同大小的文件出现在新位置时沿用缺失的旧记录，不产生重复', async () => {
    const loras = setupLoras()
    const m = newManager()
    await m.scan([loras])
    const a = (await m.list()).find((r) => r.name === 'A.safetensors')!
    await m.save({ ...a, tags: 'moved', characterId: 9 })
    mkdirSync(join(loras, 'moved'))
    renameSync(join(loras, 'characters/A.safetensors'), join(loras, 'moved/A.safetensors'))
    await m.scan([loras])
    const rows = (await m.list()).filter((r) => r.name === 'A.safetensors')
    expect(rows).toHaveLength(1)
    expect([rows[0].id, rows[0].folder, rows[0].missing, rows[0].tags, rows[0].characterId]).toEqual([a.id, 'moved', false, 'moved', 9])
  })

  it('无法唯一对应时不猜测：两个同名同大小的缺失记录，新文件创建新记录', async () => {
    const loras = setupLoras()
    mkdirSync(join(loras, 'dup'))
    writeFileSync(join(loras, 'dup/A.safetensors'), readFileSync(join(loras, 'characters/A.safetensors')))
    const m = newManager()
    await m.scan([loras])
    rmSync(join(loras, 'dup/A.safetensors'))
    rmSync(join(loras, 'characters/A.safetensors'))
    await m.scan([loras])
    mkdirSync(join(loras, 'new'))
    writeFileSync(join(loras, 'new/A.safetensors'), safetensors({ ss_output_name: 'A' }))
    await m.scan([loras])
    const rows = (await m.list()).filter((r) => r.name === 'A.safetensors')
    expect(rows).toHaveLength(3)
    expect(rows.filter((r) => r.missing)).toHaveLength(2)
  })

  it('根目录无法访问（磁盘离线 / 目录被移走）时标记为离线而不是缺失，恢复后正常', async () => {
    const loras = setupLoras()
    const m = newManager()
    await m.scan([loras])
    const n = metaCount(m)
    renameSync(loras, loras + '-offline')
    const errors = await m.scan([loras])
    expect(errors).toEqual([expect.stringContaining('无法访问')])
    const rows = await m.list()
    expect(rows.every((r) => r.offline && !r.missing)).toBe(true)
    expect(metaCount(m)).toBe(n)
    renameSync(loras + '-offline', loras)
    await m.scan([loras])
    expect((await m.list()).every((r) => !r.offline && !r.missing)).toBe(true)
    expect(metaCount(m)).toBe(n)
  })

  it('子目录读取失败只报告错误，不把其中的文件当作删除', async () => {
    const loras = setupLoras()
    const m = newManager()
    await m.scan([loras])
    const before = await m.list()
    // 扫描一个不存在的额外根目录：只产生错误，已有记录状态不变
    expect(await m.scan([loras, join(loras, '..', 'not-here')])).toHaveLength(1)
    expect((await m.list()).map((r) => [r.id, r.missing, r.offline])).toEqual(before.map((r) => [r.id, false, false]))
  })
})
