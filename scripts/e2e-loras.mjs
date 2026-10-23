// LoRA 管理端到端测试：真实窗口中添加两个 LoRA 根目录（含嵌套子目录、同名封面、Lora-Manager metadata.json），
// 验证文件夹导航、封面卡片、详情面板、搜索、角色关联，以及扫描不修改模型目录。
//
// 用法：npx electron-vite build && node --experimental-strip-types --no-warnings scripts/e2e-loras.mjs [--shots <目录>]

import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
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
  await win.waitForFunction(() => document.querySelectorAll('[data-testid=lora-card]').length === 7, null, { timeout: 15000 })
  check('两个根目录共扫描到 7 个 LoRA', (await cards.count()) === 7)
  await win.waitForTimeout(1200)
  await shot('l01-all')
  const coverCount = await win.locator('[data-testid=lora-card] img').count()
  check('有封面的 LoRA 显示封面（JPEG / PNG / WebP / .preview.png）', coverCount === 5, `${coverCount} 张封面`)

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

  // 角色库中可以选择受管 LoRA
  await win.locator('nav button', { hasText: '角色库' }).click()
  await win.waitForTimeout(600)
  const opts = await win.locator('select option').allInnerTexts()
  check('角色库可以从 LoRA Manager 添加资源', opts.some((o) => o.includes('Alice')))

  await setSize(1280, 760)
  await win.locator('nav button', { hasText: 'LoRA' }).click()
  await win.locator('[data-testid=lora-card]', { hasText: 'Alice' }).click()
  await shot('l05-small')
  check('没有渲染进程错误', errors.length === 0, errors.slice(0, 3).join(' / '))
} catch (e) {
  console.error(e)
  await shot('zz-failure').catch(() => {})
  check('脚本执行', false, String(e).slice(0, 300))
} finally {
  await app.close().catch(() => {})
}
console.log(`\n截图：${shots}`)
const failed = results.filter((x) => !x).length
console.log(failed ? `${failed} 项失败` : '全部通过')
process.exit(failed ? 1 : 0)
