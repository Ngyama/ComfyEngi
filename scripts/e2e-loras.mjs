// LoRA 管理端到端测试：真实窗口中添加两个 LoRA 根目录（含嵌套子目录、同名封面、Lora-Manager metadata.json），
// 验证文件夹导航、封面卡片、详情面板、搜索、角色关联，以及扫描不修改模型目录。
//
// 用法：npx electron-vite build && node --experimental-strip-types --no-warnings scripts/e2e-loras.mjs [--shots <目录>]

import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const root = resolve(import.meta.dirname, '..')
const argOf = (k) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : null)
const shots = resolve(argOf('--shots') || join(tmpdir(), 'comfyengi-e2e-loras'))
mkdirSync(shots, { recursive: true })
const dataDir = mkdtempSync(join(tmpdir(), 'comfyengi-e2e-loras-'))
copyFileSync(join(root, 'test/fixtures/legacy-v0.db'), join(dataDir, 'comfyengi.db'))
const lorasA = join(dataDir, 'models', 'loras')
const lorasB = join(dataDir, 'extra-loras')

const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

function safetensors(meta = {}) {
  const header = Buffer.from(JSON.stringify({ __metadata__: meta }))
  const n = Buffer.alloc(8)
  n.writeBigUInt64LE(BigInt(header.length))
  return Buffer.concat([n, header, Buffer.alloc(2048)])
}
const snapshot = (dir) => {
  const out = {}
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else out[p] = createHash('sha1').update(readFileSync(p)).digest('hex') + ':' + statSync(p).mtimeMs
    }
  }
  walk(dir)
  return out
}

const env = { ...process.env, COMFYENGI_DATA_DIR: dataDir, COMFYENGI_VAULT: join(dataDir, 'vault'), COMFYENGI_IMPORT_LEGACY: join(dataDir, 'comfyengi.db') }
const app = await electron.launch({ args: [root], cwd: root, env })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(String(e)))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
const setSize = (w, h) => app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [w, h])
const shot = async (name) => {
  await win.waitForTimeout(500)
  await win.screenshot({ path: join(shots, `${name}.png`) })
}

try {
  await setSize(1920, 1040)
  await win.waitForSelector('nav')

  // 用页面 canvas 生成真实的 JPEG / PNG / WebP 封面
  const img = (label, hue, type) =>
    win.evaluate(
      ([label, hue, type]) => {
        const c = document.createElement('canvas')
        c.width = 600
        c.height = 800
        const g = c.getContext('2d')
        const grad = g.createLinearGradient(0, 0, 600, 800)
        grad.addColorStop(0, `hsl(${hue} 55% 55%)`)
        grad.addColorStop(1, `hsl(${(hue + 60) % 360} 45% 22%)`)
        g.fillStyle = grad
        g.fillRect(0, 0, 600, 800)
        g.fillStyle = 'rgba(255,255,255,.18)'
        g.beginPath()
        g.arc(300, 330, 170, 0, Math.PI * 2)
        g.fill()
        g.fillStyle = 'white'
        g.font = 'bold 64px sans-serif'
        g.textAlign = 'center'
        g.fillText(label, 300, 650)
        return c.toDataURL(type, 0.9).split(',')[1]
      },
      [label, hue, type],
    )
  const write = async (p, label, hue, type) => {
    mkdirSync(resolve(p, '..'), { recursive: true })
    writeFileSync(p, Buffer.from(await img(label, hue, type), 'base64'))
  }
  const meta = (o) => JSON.stringify(o, null, 2)
  const files = {
    'characters/Alice': { hue: 330, type: 'image/jpeg', ext: '.jpeg', meta: { model_name: 'Alice - Illustrious', base_model: 'Illustrious', tags: ['character', 'girl'], civitai: { trainedWords: ['alice_ce', 'blonde hair', 'blue eyes'], name: 'v1.2', model: { type: 'LORA' }, creator: { username: 'tester' } }, usage_tips: '{"strength": 0.85, "strength_min": 0.6, "strength_max": 1.0}', modelDescription: '<p>示例角色 LoRA。</p><p>建议配合 <b>Illustrious XL</b> 使用。</p>', favorite: true } },
    'characters/Bob': { hue: 210, type: 'image/png', ext: '.png', meta: { model_name: 'Bob', base_model: 'Illustrious', civitai: { trainedWords: ['bob_ce'] } } },
    'characters/Carol': { hue: 150, type: 'image/webp', ext: '.webp', meta: { model_name: 'Carol', base_model: 'NoobAI', tags: ['character'] } },
    'background/Night City': { hue: 250, type: 'image/jpeg', ext: '.jpg', meta: { model_name: 'Night City', base_model: 'Illustrious', tags: ['background', 'city'] } },
    'background/night/deep/Rain': { meta: { model_name: 'Rain Effect', base_model: 'Pony', civitai: { trainedWords: ['rain'] } } },
    'style/Ink': {},
  }
  for (const [rel, f] of Object.entries(files)) {
    const base = join(lorasA, ...rel.split('/'))
    mkdirSync(resolve(base, '..'), { recursive: true })
    writeFileSync(base + '.safetensors', safetensors({ ss_output_name: rel, ss_network_dim: '32' }))
    if (f.meta) writeFileSync(base + '.metadata.json', meta(f.meta))
    if (f.type) await write(base + f.ext, rel.split('/').pop(), f.hue, f.type)
  }
  mkdirSync(lorasB, { recursive: true })
  writeFileSync(join(lorasB, 'Extra.safetensors'), safetensors())
  await write(join(lorasB, 'Extra.preview.png'), 'Extra', 30, 'image/png')
  const mp4 = await win.evaluate(async () => {
    const type = ['video/mp4;codecs=avc1', 'video/mp4'].find((t) => MediaRecorder.isTypeSupported(t))
    if (!type) return null
    const c = document.createElement('canvas')
    c.width = 360
    c.height = 480
    const g = c.getContext('2d')
    const rec = new MediaRecorder(c.captureStream(30), { mimeType: type })
    const chunks = []
    rec.ondataavailable = (e) => chunks.push(e.data)
    rec.start()
    const t0 = performance.now()
    await new Promise((resolve) => {
      const draw = () => {
        const t = (performance.now() - t0) / 1000
        g.fillStyle = `hsl(${(t * 200) % 360} 60% 45%)`
        g.fillRect(0, 0, 360, 480)
        g.fillStyle = 'white'
        g.font = 'bold 48px sans-serif'
        g.fillText('Dance', 100, 260)
        if (t < 1.5) requestAnimationFrame(draw)
        else resolve()
      }
      draw()
    })
    rec.stop()
    await new Promise((r) => (rec.onstop = r))
    const buf = await new Blob(chunks, { type }).arrayBuffer()
    let bin = ''
    const bytes = new Uint8Array(buf)
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return btoa(bin)
  })
  check('Chromium 可以录制测试用 MP4', !!mp4)
  mkdirSync(join(lorasA, 'motion'), { recursive: true })
  writeFileSync(join(lorasA, 'motion', 'Dance.safetensors'), safetensors())
  writeFileSync(join(lorasA, 'motion', 'Dance.metadata.json'), meta({ model_name: 'Dance Motion', base_model: 'Illustrious' }))
  writeFileSync(join(lorasA, 'motion', 'Dance.mp4'), Buffer.from(mp4 ?? '', 'base64'))
  const before = { ...snapshot(lorasA), ...snapshot(lorasB) }

  // 文件夹选择对话框：直接返回两个根目录
  await app.evaluate(({ dialog }, roots) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: roots })
  }, [lorasA, lorasB])

  await win.locator('nav button', { hasText: 'LoRA' }).click()
  await win.waitForSelector('text=还没有添加 LoRA 目录')
  await shot('l00-empty')
  await win.locator('button', { hasText: '添加 LoRA 目录' }).last().click()
  const cards = win.locator('[data-testid=lora-card]')
  await win.waitForFunction(() => document.querySelectorAll('[data-testid=lora-card]').length === 8, null, { timeout: 15000 })
  check('两个根目录共扫描到 8 个 LoRA', (await cards.count()) === 8)
  await win.waitForFunction(() => document.querySelectorAll('[data-testid=lora-card] img').length === 6, null, { timeout: 20000 }).catch(() => {})
  await shot('l01-all')
  const coverCount = await win.locator('[data-testid=lora-card] img').count()
  check('有封面的 LoRA 显示封面（JPEG / PNG / WebP / .preview.png / MP4 静态帧）', coverCount === 6, `${coverCount} 张封面`)
  check('默认不播放任何视频', (await win.locator('video').count()) === 0)
  const thumbs = () => {
    try {
      return readdirSync(join(dataDir, 'vault', '.comfyengi', 'cache', 'lora-thumbs')).length
    } catch {
      return 0
    }
  }
  check('MP4 静态帧已缓存到工作区', thumbs() > 0, `${thumbs()} 个缓存文件`)

  // 悬停播放 / 移开停止
  const dance = win.locator('[data-testid=lora-card]', { hasText: 'Dance' })
  await dance.hover()
  await win.waitForSelector('[data-testid=lora-hover-video]', { timeout: 5000 }).catch(() => {})
  await win.waitForTimeout(800)
  const playing = await win.evaluate(() => {
    const v = document.querySelector('[data-testid=lora-hover-video]')
    return v ? { paused: v.paused, muted: v.muted, loop: v.loop, t: v.currentTime } : null
  })
  check('悬停时静音循环播放视频', !!playing && !playing.paused && playing.muted && playing.loop && playing.t > 0, JSON.stringify(playing))
  await shot('l01b-hover-video')
  await win.mouse.move(5, 500)
  await win.waitForTimeout(300)
  check('移开后停止并恢复静态封面', (await win.locator('video').count()) === 0 && (await dance.locator('img').count()) === 1)
  await win.locator('[data-testid=lora-card]', { hasText: 'Alice' }).hover()
  await win.waitForTimeout(500)
  check('悬停图片封面不会加载视频', (await win.locator('video').count()) === 0)

  // 详情中播放视频
  await dance.click()
  await win.getByRole('button', { name: '播放视频封面' }).click()
  await win.waitForFunction(() => (document.querySelector('[data-testid=lora-detail-video]')?.readyState ?? 0) >= 2, null, { timeout: 8000 }).catch(() => {})
  const detailVideo = await win.evaluate(() => {
    const v = document.querySelector('[data-testid=lora-detail-video]')
    return v ? { ready: v.readyState, controls: v.controls, w: v.videoWidth } : null
  })
  check('详情面板可以播放视频（带控件）', !!detailVideo && detailVideo.ready >= 2 && detailVideo.controls && detailVideo.w === 360, JSON.stringify(detailVideo))
  await shot('l01c-detail-video')
  await win.getByRole('button', { name: '关闭' }).last().click()
  await win.waitForTimeout(300)

  // 文件夹导航
  await win.locator('button', { hasText: /^characters/ }).first().click()
  await win.waitForTimeout(300)
  check('进入 characters 文件夹只显示其中 3 个', (await cards.count()) === 3)
  await win.locator('nav').first() // noop
  await win.locator('div[title="background"] button').nth(1).click()
  await win.waitForTimeout(300)
  check('background 文件夹包含子文件夹中的 LoRA', (await cards.count()) === 2)
  check('网格中显示子文件夹入口', await win.locator('main button', { hasText: 'night' }).first().isVisible())
  await win.locator('main button', { hasText: 'night' }).first().click()
  await win.waitForTimeout(300)
  check('逐级进入子文件夹', (await cards.count()) === 1 && (await cards.first().innerText()).includes('Rain Effect'))
  await shot('l02-subfolder')

  // 全部 + 搜索 + 底模筛选
  await win.locator('button', { hasText: '全部 LoRA' }).first().click()
  await win.locator('input[placeholder="搜索名称、标签、触发词…"]').fill('blonde')
  await win.waitForTimeout(300)
  check('按触发词搜索', (await cards.count()) === 1 && (await cards.first().innerText()).includes('Alice'))
  await win.locator('input[placeholder="搜索名称、标签、触发词…"]').fill('')
  await win.getByRole('button', { name: 'NoobAI', exact: true }).click()
  await win.waitForTimeout(300)
  check('按底模筛选', (await cards.count()) === 1 && (await cards.first().innerText()).includes('Carol'))
  await win.getByRole('button', { name: '全部底模', exact: true }).click()

  // 详情
  await win.locator('[data-testid=lora-card]', { hasText: 'Alice' }).click()
  await win.waitForSelector('text=触发词')
  await win.waitForTimeout(1000)
  const panel = await win.locator('text=ComfyEngi 设置').locator('xpath=ancestor::div[contains(@class,"flex h-full flex-col")][1]').innerText()
  check('详情显示触发词、推荐权重、标签、描述', ['alice_ce', 'blonde hair', '0.85', '0.6 – 1', 'girl', '示例角色 LoRA'].every((s) => panel.includes(s)))
  check('详情不显示空字段', !panel.includes('插件备注') && !panel.includes('undefined'))
  check('新记录推荐权重取自 usage_tips', (await win.locator('input[type=number]').first().inputValue()) === '0.85')
  await shot('l03-detail')

  // 角色关联（保存在 Vault）
  await win.getByRole('button', { name: '角色A', exact: true }).click()
  await win.waitForTimeout(900)
  check('关联角色后卡片显示角色', (await win.locator('[data-testid=lora-card]', { hasText: 'Alice' }).innerText()).includes('角色A'))
  await win.getByRole('button', { name: '已关联角色', exact: true }).click()
  await win.waitForTimeout(300)
  check('按角色关联筛选', (await cards.count()) === 1)
  await win.getByRole('button', { name: '全部', exact: true }).click()

  // 重新扫描：用户数据保留，模型目录未被修改
  await win.locator('button[aria-label="重新扫描全部目录"]').click()
  await win.waitForTimeout(1500)
  check('重新扫描后角色关联保留', (await win.locator('[data-testid=lora-card]', { hasText: 'Alice' }).innerText()).includes('角色A'))
  const after = { ...snapshot(lorasA), ...snapshot(lorasB) }
  check('扫描不修改模型目录中的任何文件', JSON.stringify(after) === JSON.stringify(before))

  // 无封面的详情占位
  await win.locator('[data-testid=lora-card]', { hasText: 'Ink' }).click()
  await win.waitForTimeout(600)
  check('无封面时显示统一占位', await win.locator('text=没有封面').isVisible())
  await shot('l04-no-cover')

  // ---------------- 角色库：LoRA 选择器、导入触发词、旧触发词合并、头像、服装
  const lib0 = await win.evaluate(() => window.api['library.load']())
  const charB = lib0.characters.find((c) => c.name === '角色B')
  const charA = lib0.characters.find((c) => c.name === '角色A')
  // 隐藏字段、旧版多 LoRA 与旧版已启用触发词（通过真实 IPC 写入）
  await win.evaluate(([b, a]) => Promise.all([
    window.api['characters.save']({ id: b.id, tag: 'hidden_tag_b', negative: 'hidden_neg_b', note: 'hidden_note_b' }),
    window.api['characters.save']({ id: a.id, loras: [{ name: 'charA.safetensors', strength: 0.8, trigger_words: ['legacy_t', 'char_a'] }, { name: 'style.safetensors', strength: 0.4 }] }),
  ]), [charB, charA])
  await win.locator('nav button', { hasText: '角色库' }).click()
  await win.waitForTimeout(600)
  await win.locator('main button', { hasText: '角色B' }).first().click()
  await win.waitForTimeout(400)
  check('角色页面只有名称、LoRA、基础 Prompt、服装', (await win.getByPlaceholder('可选').count()) === 0 && (await win.locator('[data-testid=trigger-chip]').count()) === 0)
  await win.locator('[data-testid=lora-picker-open]').click()
  const pickerItems = win.locator('[data-testid=lora-picker-item]')
  await win.waitForTimeout(400)
  check('LoRA 选择器列出可用的 LoRA（不含缺失）', (await pickerItems.count()) === 8, String(await pickerItems.count()))
  const search = win.getByPlaceholder('搜索文件名或模型名称…')
  await search.fill('Effect')
  await win.waitForTimeout(200)
  check('选择器按 metadata 模型名称搜索', (await pickerItems.count()) === 1 && (await pickerItems.first().innerText()).includes('Rain Effect'))
  await search.fill('ink')
  await win.waitForTimeout(200)
  check('选择器按本地文件名搜索', (await pickerItems.count()) === 1 && (await pickerItems.first().innerText()).includes('Ink'))
  await search.fill('alice')
  await win.waitForTimeout(800)
  check('搜索结果显示封面缩略图与目录', (await pickerItems.first().locator('img').count()) === 1 && (await pickerItems.first().innerText()).includes('characters'))
  await shot('c01-lora-picker')
  await pickerItems.first().click()
  await win.waitForTimeout(500)
  const card = win.locator('[data-testid=character-lora]')
  check('选中后显示 LoRA 卡片，没有权重输入框', (await card.innerText()).includes('Alice - Illustrious') && (await win.getByLabel('LoRA 权重').count()) === 0)
  if (await card.getByText('尚未设置 ComfyUI 模型名称').count()) {
    await card.getByText('尚未设置 ComfyUI 模型名称').click()
    await win.waitForTimeout(500)
  }
  check('可一键设置 ComfyUI 模型名称', (await card.getByText('尚未设置 ComfyUI 模型名称').count()) === 0)

  // 导入触发词：确认前可编辑，可整理出新服装
  await card.getByRole('button', { name: '导入触发词' }).click()
  await win.waitForSelector('text=导入后的基础 Prompt')
  const preview = win.locator('[data-testid=import-preview]')
  check('导入前预览：触发词加在原基础 Prompt 前', (await preview.innerText()) === 'alice_ce, blonde hair, blue eyes, 1girl, char_b', await preview.innerText())
  const dlg = win.locator('[role=dialog]')
  await dlg.getByRole('button', { name: '整理为新服装' }).click()
  await dlg.getByPlaceholder('服装名称').fill('金发造型')
  await dlg.getByRole('button', { name: 'blonde hair' }).click()
  await dlg.locator('textarea').first().fill('alice_ce, blue eyes')
  await win.waitForTimeout(200)
  await shot('c02-import-triggers')
  const sb = await win.locator('[data-testid=import-body]').evaluate((el) => ({ overflow: getComputedStyle(el).overflowY, bar: getComputedStyle(el).scrollbarWidth, gutter: el.offsetWidth - el.clientWidth }))
  check('导入触发词弹窗隐藏滚动条但仍可滚动', sb.overflow === 'auto' && sb.bar === 'none' && sb.gutter === 0, JSON.stringify(sb))
  check('编辑后的预览', (await preview.innerText()) === 'alice_ce, blue eyes, 1girl, char_b')
  await dlg.getByRole('button', { name: '确认导入' }).click()
  await win.waitForTimeout(1500)
  const lib1 = await win.evaluate(() => window.api['library.load']())
  const b1 = lib1.characters.find((c) => c.id === charB.id)
  const newOutfit = lib1.outfits.find((o) => o.character_id === charB.id && o.name === '金发造型')
  check('确认后写入基础 Prompt 并新建服装', b1.positive === 'alice_ce, blue eyes, 1girl, char_b' && newOutfit?.positive === 'blonde hair', `${b1.positive} | ${newOutfit?.positive}`)
  check('LoRA 关联保存，沿用默认权重（推荐权重）', b1.loras.length === 1 && b1.loras[0].strength === 0.85)
  check('隐藏字段（角色标签、负面 Prompt、备注）保存后保留', b1.tag === 'hidden_tag_b' && b1.negative === 'hidden_neg_b' && b1.note === 'hidden_note_b')
  check('角色列表头像使用 LoRA 封面', (await win.locator('main button', { hasText: '角色B' }).first().locator('img').count()) === 1)
  const planB = await win.evaluate(async (cid) => {
    const lib = await window.api['library.load']()
    const pose = lib.templates.find((x) => x.kind === 'pose')
    const data = { character_id: cid, story_id: null, story_outfit_id: null, global_id: null, male_base_id: null, workflow_id: null, seed_base: 1, items: [{ pose_id: pose.id, outfit_id: null, expression_ids: [], count: 1, camera_id: null, male_enabled: false, male_ids: [], male_extra: '', extra_positive: '', extra_negative: '' }] }
    const t = await window.api['tasks.create']('触发词测试', data)
    return window.api['plan.forTask'](t.id)
  }, charB.id)
  const u0 = planB.units[0]
  const v0 = Object.fromEntries((u0.inputs ?? []).map((x) => [x.source, x.value]))
  check('角色 Prompt 只来自基础 Prompt（预览与写入节点的值一致）', u0.modules.character[0] === 'alice_ce, blue eyes, 1girl, char_b' && v0.positive === u0.positive, u0.modules.character[0])
  check('LoRA 名称与强度映射到工作流', v0.lora1_name === 'characters\\Alice.safetensors' && v0.lora1_strength === 0.85, `${v0.lora1_name} ${v0.lora1_strength}`)

  // 旧版：多 LoRA 与已启用的触发词
  await win.locator('main button', { hasText: '角色A' }).first().click()
  await win.waitForTimeout(400)
  check('旧版多 LoRA 配置显示提示', await win.locator('[data-testid=legacy-loras]').isVisible())
  check('旧版已启用触发词显示合并提示', await win.locator('[data-testid=legacy-triggers]').isVisible())
  await shot('c03-legacy')
  const planA = await win.evaluate(async (cid) => {
    const t = await window.api['tasks.create']('旧触发词', { character_id: cid, story_id: null, story_outfit_id: null, global_id: null, male_base_id: null, workflow_id: null, seed_base: 1, items: [] })
    return window.api['plan.forTask'](t.id)
  }, charA.id)
  check('未合并前：预览给出提示且不自动拼接', planA.warnings.some((w) => w.includes('legacy_t')))
  await win.getByRole('button', { name: '合并到基础 Prompt' }).click()
  await win.waitForTimeout(1200)
  const a1 = (await win.evaluate(() => window.api['library.load']())).characters.find((c) => c.id === charA.id)
  check('合并后：只加入缺少的触发词，不重复', a1.positive.startsWith('legacy_t, ') && a1.positive.split('char_a').length === 2, a1.positive)
  check('合并后不再提示，多 LoRA 数据保留', (await win.locator('[data-testid=legacy-triggers]').count()) === 0 && a1.loras.length === 2 && a1.loras[1].name === 'style.safetensors')
  await win.locator('[data-testid=outfit-row] button', { hasText: 'A服装2' }).click()
  await win.locator('[data-testid=outfit-row] button', { hasText: 'A服装3' }).click()
  await win.waitForTimeout(300)
  check('服装一次只展开一个编辑区，只有名称与 Positive', (await win.getByPlaceholder('服装 / 穿着状态 Prompt（原样保存）').count()) === 1)
  await shot('c04-outfits')

  // 缺失文件：只在测试临时目录中删除 / 移动，验证界面行为
  await win.locator('nav button', { hasText: 'LoRA' }).click()
  await win.waitForTimeout(500)
  const rescan = async () => {
    await win.locator('button[aria-label="重新扫描全部目录"]').click()
    await win.waitForTimeout(1500)
  }
  const inkPath = join(lorasA, 'style', 'Ink.safetensors')
  const inkBytes = readFileSync(inkPath)
  if (!(await win.getByPlaceholder('例如 常用 主角').isVisible())) await win.locator('[data-testid=lora-card]', { hasText: 'Ink' }).click()
  await win.getByPlaceholder('例如 常用 主角').fill('ink-tag')
  await win.waitForTimeout(800)
  await win.getByRole('button', { name: '关闭' }).last().click()
  rmSync(inkPath)
  await rescan()
  check('已删除的 LoRA 默认隐藏', (await win.locator('[data-testid=lora-card]', { hasText: 'Ink' }).count()) === 0 && (await cards.count()) === 7)
  const toggle = win.getByRole('switch', { name: '显示缺失文件' })
  await toggle.click()
  await win.waitForTimeout(400)
  const inkCard = win.locator('[data-testid=lora-card]', { hasText: 'Ink' })
  check('打开「显示缺失文件」后可查看旧记录', (await inkCard.count()) === 1 && (await inkCard.innerText()).includes('文件缺失'))
  await shot('l07-missing-shown')
  await toggle.click()
  writeFileSync(inkPath, inkBytes)
  await rescan()
  if (!(await win.getByPlaceholder('例如 常用 主角').isVisible())) await win.locator('[data-testid=lora-card]', { hasText: 'Ink' }).click()
  await win.waitForTimeout(400)
  check('文件恢复后显示原记录（标签保留）', (await win.getByPlaceholder('例如 常用 主角').inputValue()) === 'ink-tag' && (await cards.count()) === 8)
  await win.getByRole('button', { name: '关闭' }).last().click()

  renameSync(lorasB, lorasB + '-offline')
  await rescan()
  check('离线目录中的 LoRA 暂时隐藏并给出提示', (await win.locator('[data-testid=lora-card]', { hasText: 'Extra' }).count()) === 0 && (await win.getByText(/所在的目录当前无法访问/).isVisible()))
  await toggle.click()
  await win.waitForTimeout(400)
  const extra = win.locator('[data-testid=lora-card]', { hasText: 'Extra' })
  check('离线记录不显示为「文件缺失」', (await extra.innerText()).includes('目录无法访问') && !(await extra.innerText()).includes('文件缺失'))
  await shot('l08-offline')
  await toggle.click()
  renameSync(lorasB + '-offline', lorasB)
  await rescan()
  check('目录恢复后正常显示', (await win.locator('[data-testid=lora-card]', { hasText: 'Extra' }).count()) === 1 && (await win.getByText(/所在的目录当前无法访问/).count()) === 0)

  // 显示名称切换
  await win.locator('nav button', { hasText: 'LoRA' }).click()
  await win.waitForTimeout(500)
  const titles = async () => (await cards.locator('div.truncate.font-medium').allInnerTexts()).join(',')
  check('默认显示模型名称', (await titles()).includes('Alice - Illustrious'))
  await win.getByRole('button', { name: '文件名称', exact: true }).click()
  await win.waitForTimeout(500)
  check('切换为文件名称（不含扩展名）', (await titles()).includes('Alice') && !(await titles()).includes('Alice - Illustrious') && !(await titles()).includes('.safetensors'), await titles())
  check('名称排序随显示名称切换', (await titles()).split(',')[0] === 'Alice', await titles())
  await win.locator('input[placeholder="搜索名称、标签、触发词…"]').fill('Night City')
  await win.waitForTimeout(300)
  const byModel = await cards.count()
  await win.locator('input[placeholder="搜索名称、标签、触发词…"]').fill('Dance Motion')
  await win.waitForTimeout(300)
  check('文件名称模式下仍可按模型名称搜索', byModel === 1 && (await cards.count()) === 1)
  await win.locator('input[placeholder="搜索名称、标签、触发词…"]').fill('')
  await win.locator('[data-testid=lora-card]', { hasText: 'Alice' }).click()
  await win.waitForTimeout(400)
  check('详情标题同步切换', (await win.locator('h2').last().innerText()) === 'Alice')
  await shot('l06-file-names')

  await setSize(1280, 760)
  await win.locator('nav button', { hasText: 'LoRA' }).click()
  await win.locator('[data-testid=lora-card]', { hasText: 'Alice' }).click()
  await shot('l05-small')
  // 套图任务的任务级 LoRA：从 LoRA Manager 选择；未绑定 Loader 时不能入队；不拼入 Prompt
  await win.locator('nav button', { hasText: '套图任务' }).click()
  await win.waitForTimeout(600)
  await win.locator('[data-testid=add-task-lora]').click()
  await win.getByPlaceholder('搜索文件名或模型名称…').fill('ink')
  await win.waitForTimeout(300)
  await win.locator('[data-testid=lora-picker-item]').first().click()
  await win.waitForTimeout(900)
  const taskCard = win.locator('[data-testid=lora-card][data-prefix=task_lora1]')
  check('添加任务级 LoRA：标题为本地文件名，未绑定时显示警告图标', (await taskCard.count()) === 1 && (await taskCard.locator('[data-testid=lora-title]').innerText()) === 'Ink' && (await taskCard.locator('[data-testid=lora-warning]').count()) === 1, (await taskCard.innerText()).replace(/\n/g, ' | '))
  // 网格：宽窗口 3 列、中等 2 列、较窄 1 列，卡片不超出面板
  const grid = () => win.locator('[data-testid=lora-panel]').evaluate((g) => {
    const cards = [...g.querySelectorAll('[data-testid=lora-card]')].map((c) => c.getBoundingClientRect())
    const box = g.getBoundingClientRect()
    return { cols: new Set(cards.map((r) => Math.round(r.left))).size, inside: cards.every((r) => r.left >= box.left - 1 && r.right <= box.right + 1), width: Math.round(box.width) }
  })
  await win.locator('[data-testid=add-task-lora]').click()
  await win.getByPlaceholder('搜索文件名或模型名称…').fill('bob')
  await win.waitForTimeout(300)
  await win.locator('[data-testid=lora-picker-item]').first().click()
  await win.waitForTimeout(600)
  await setSize(1920, 1040)
  await win.waitForTimeout(400)
  const g3 = await grid()
  await shot('c06-lora-grid-wide')
  await setSize(1180, 760)
  await win.waitForTimeout(400)
  const g2 = await grid()
  await shot('c07-lora-grid-medium')
  await win.locator('[data-testid=lora-panel]').evaluate((g) => (g.parentElement.style.width = '600px'))
  await win.waitForTimeout(300)
  const g1 = await grid()
  await shot('c08-lora-grid-narrow')
  await win.locator('[data-testid=lora-panel]').evaluate((g) => (g.parentElement.style.width = ''))
  check('LoRA 卡片网格：3 / 2 / 1 列，且都在面板内', g3.cols === 3 && g2.cols === 2 && g1.cols === 1 && g3.inside && g2.inside && g1.inside, JSON.stringify({ g3, g2, g1 }))
  await win.locator('[data-testid=lora-card][data-prefix=task_lora2]').getByRole('button', { name: '删除任务 LoRA' }).click()
  await win.waitForTimeout(300)
  const tp = await win.evaluate(async () => {
    const lib = await window.api['library.load']()
    return window.api['plan.forTask'](lib.settings.last_task_id ?? lib.tasks[0].id)
  })
  check('任务 LoRA 未绑定 Loader 时阻止入队，且不写入 Prompt', tp.errors.some((e) => e.includes('任务 LoRA「任务 LoRA 1」') && e.includes('没有绑定 LoRA Loader')) && tp.units.every((u) => !u.positive.includes('<lora:')), tp.errors.join(' / '))
  await shot('c05-task-lora')
  await taskCard.getByRole('button', { name: '删除任务 LoRA' }).click()
  await win.waitForTimeout(500)
  check('删除任务 LoRA', (await win.locator('[data-testid=lora-card][data-prefix=task_lora1]').count()) === 0)

  check('没有渲染进程错误', errors.length === 0, errors.slice(0, 3).join(' / '))
} catch (e) {
  console.error(e)
  await shot('zz-failure').catch(() => {})
  check('脚本执行', false, String(e).slice(0, 300))
} finally {
  await app.close().catch(() => {})
}

// 重启后显示名称选择保持（保存在工作区）
try {
  const app2 = await electron.launch({ args: [root], cwd: root, env: { ...env, COMFYENGI_IMPORT_LEGACY: '' } })
  const w2 = await app2.firstWindow()
  await w2.waitForSelector('nav')
  await w2.locator('nav button', { hasText: 'LoRA' }).click()
  await w2.waitForSelector('[data-testid=lora-card]', { timeout: 15000 })
  const active = await w2.getByRole('button', { name: '文件名称', exact: true }).getAttribute('data-active')
  const t2 = (await w2.locator('[data-testid=lora-card] div.truncate.font-medium').allInnerTexts()).join(',')
  check('重启后保持「文件名称」选择', active !== null && t2.includes('Alice') && !t2.includes('Alice - Illustrious'), t2)
  await app2.close()
} catch (e) {
  check('重启检查', false, String(e).slice(0, 200))
}
console.log(`\n截图：${shots}`)
const failed = results.filter((x) => !x).length
console.log(failed ? `${failed} 项失败` : '全部通过')
process.exit(failed ? 1 : 0)
