// 套图复刻端到端测试：在真实窗口中完成「导入 → 勾选 Tag → 选角色 → 预览 → 生成」，提交到模拟 ComfyUI，
// 验证每张图提交的 JSON、输出文件名与原图对应、草稿重新打开、原图不变。模拟 ComfyUI 不能代替真实环境验证。
//
// 用法：npx electron-vite build && node --experimental-strip-types --no-warnings scripts/e2e-replica.mjs [--shots <目录>]

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { makePng } from '../test/mining-fixtures.ts'
import { MockComfy } from '../test/mock-comfy.ts'

const root = resolve(import.meta.dirname, '..')
const argOf = (k) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : null)
const shots = resolve(argOf('--shots') || join(tmpdir(), 'comfyengi-e2e-replica'))
mkdirSync(shots, { recursive: true })
const dataDir = mkdtempSync(join(tmpdir(), 'comfyengi-e2e-replica-'))
const vault = join(dataDir, 'vault')
const imgDir = join(dataDir, 'set')
const comfyOut = join(dataDir, 'comfy-out')
mkdirSync(imgDir, { recursive: true })
mkdirSync(comfyOut, { recursive: true })

const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

const graph = (pos, neg, seed, width) => ({
  1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'm.safetensors' } },
  2: { class_type: 'CLIPTextEncode', inputs: { text: pos, clip: ['1', 1] } },
  3: { class_type: 'CLIPTextEncode', inputs: { text: neg, clip: ['1', 1] } },
  4: { class_type: 'EmptyLatentImage', inputs: { width, height: 1216, batch_size: 1 } },
  5: { class_type: 'KSampler', inputs: { seed, steps: 21, cfg: 6.5, sampler_name: 'euler', scheduler: 'karras', denoise: 1, model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0] } },
  6: { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
  7: { class_type: 'SaveImage', inputs: { filename_prefix: 'x', images: ['6', 0] } },
})
const write = (name, texts) => writeFileSync(join(imgDir, name), makePng(texts))
write('001.png', { prompt: JSON.stringify(graph('1girl, (red hair:1.2), char_a, smile, park', 'lowres', 1001, 832)) })
write('002.png', { prompt: JSON.stringify(graph('1girl, Red_Hair, char_a, sitting, beach', 'blurry', 1002, 1024)) })
write('003.png', { parameters: '1girl, red hair, char_a, running\nNegative prompt: worst\nSteps: 33, Sampler: Euler a, CFG scale: 4, Seed: 1003, Size: 640x960' })
write('004.png', {})

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
const originals = Object.fromEntries(readdirSync(imgDir).map((f) => [f, sha(join(imgDir, f))]))

const mock = new MockComfy(0.02, comfyOut)
await mock.serve(0)

const WF = {
  3: { class_type: 'KSampler', inputs: { seed: 1, steps: 28, cfg: 5.5, sampler_name: 'dpmpp_2m', scheduler: 'normal', denoise: 1, model: ['10', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
  4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'x.safetensors' } },
  5: { class_type: 'EmptyLatentImage', inputs: { width: 832, height: 1216, batch_size: 1 } },
  6: { class_type: 'CLIPTextEncode', inputs: { text: '原', clip: ['10', 1] } },
  7: { class_type: 'CLIPTextEncode', inputs: { text: '原负', clip: ['10', 1] } },
  8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
  9: { class_type: 'SaveImage', inputs: { filename_prefix: 'ComfyUI', images: ['8', 0] } },
  10: { class_type: 'LoraLoader', inputs: { lora_name: 'charA.safetensors', strength_model: 1, strength_clip: 1, model: ['4', 0], clip: ['4', 1] } },
}
const entry = (source, node, input) => ({ source, node, input, modules: [], template: '' })
const MAPPING = [entry('positive', '6', 'text'), entry('negative', '7', 'text'), entry('seed', '3', 'seed'), entry('width', '5', 'width'), entry('height', '5', 'height'), entry('filename_prefix', '9', 'filename_prefix')]

copyFileSync(join(root, 'test/fixtures/legacy-v0.db'), join(dataDir, 'comfyengi.db'))
const env = { ...process.env, COMFYENGI_DATA_DIR: dataDir, COMFYENGI_VAULT: vault, COMFYENGI_IMPORT_LEGACY: join(dataDir, 'comfyengi.db') }
const app = await electron.launch({ args: [root], cwd: root, env })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(String(e)))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
const shot = async (name) => {
  await win.waitForTimeout(400)
  await win.screenshot({ path: join(shots, `${name}.png`) })
}
const nav = (label) => win.locator('nav button').filter({ hasText: new RegExp(`^${label}$`) }).click()
const stubOpen = (paths) => app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: p }) }, paths)
const step = (i) => win.locator(`[data-testid=replica-step][data-step="${i}"]`).click()
const tid = (t) => win.locator(`[data-testid=${t}]`)

try {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 980))
  await win.waitForSelector('nav')
  await win.evaluate(async ([WF, MAPPING, url]) => {
    await window.api['settings.set']('comfy_url', url)
    const c = await window.api['characters.create']('复刻角色', '')
    await window.api['characters.save']({ id: c.id, positive: 'char_b, (pink hair:1.1)', negative: 'bad hands', loras: [{ name: 'charB.safetensors', strength: 0.7 }] })
    await window.api['workflows.save']({ name: '复刻工作流', api_json: WF, mapping: MAPPING })
  }, [WF, MAPPING, mock.url])
  await win.reload()
  await win.waitForSelector('nav')

  await nav('套图复刻')
  await tid('replica-new').click()
  await win.waitForSelector('[data-testid=replica-editor]')
  await win.waitForTimeout(400)

  // 1. 导入
  await stubOpen([imgDir])
  await tid('replica-add-folder').click()
  await win.waitForSelector('[data-testid=replica-card]')
  await win.waitForTimeout(500)
  check('导入文件夹：按文件名排序', (await win.locator('[data-testid=replica-card]').evaluateAll((els) => els.map((e) => e.dataset.name).join(','))) === '001.png,002.png,003.png,004.png')
  check('数量：读取成功 3，失败 1', (await tid('replica-count-ok').innerText()).includes('3') && (await tid('replica-count-error').innerText()).includes('1'))
  await win.locator('[data-testid=replica-card][data-name="001.png"]').click()
  await win.waitForTimeout(300)
  check('单张详情：参数标明状态', (await win.locator('[data-testid=replica-param][data-key=seed]').getAttribute('data-state')) === 'ok' && (await win.locator('[data-testid=replica-param][data-key=seed]').innerText()).includes('1001'))
  await shot('r1-import')

  // 2. 勾选 Tag
  await step(1)
  await win.waitForSelector('[data-testid=tag-row]')
  check('Tag 按频率排序、合并不同写法', (await win.locator('[data-testid=tag-row][data-key=red_hair]').getAttribute('data-count')) === '3')
  await win.locator('[data-testid=tag-row][data-key=red_hair] [data-testid=tag-open]').click()
  await win.waitForTimeout(200)
  check('可以查看写法与权重', (await tid('tag-detail').innerText()).includes('(red hair:1.2)'))
  await win.locator('[data-testid=tag-row][data-key=red_hair] [data-testid=tag-check]').check()
  await win.locator('[data-testid=tag-row][data-key=char_a] [data-testid=tag-check]').check()
  await win.waitForTimeout(800)
  check('高频的 1girl 没有被自动选中', !(await win.locator('[data-testid=tag-row][data-key="1girl"] [data-testid=tag-check]').isChecked()))
  await shot('r2-tags')

  // 3. 新角色
  await step(2)
  await win.waitForSelector('[data-testid=replica-character]')
  await win.locator('[data-testid=replica-character]', { hasText: '复刻角色' }).click()
  await win.waitForTimeout(300)
  check('显示角色 Prompt', (await tid('replica-character-prompt').innerText()).includes('char_b'))
  await win.locator('[data-testid=replica-character-step] section', { hasText: '工作流' }).first().locator('select').first().selectOption({ label: '复刻工作流' })
  await win.waitForTimeout(800)
  await win.locator('[data-testid=replica-wf-lora-replace]').first().click()
  await win.waitForTimeout(800)
  check('替换后显示 原 LoRA → 新 LoRA', (await win.locator('[data-testid=replica-wf-lora]').first().getAttribute('data-replaced')) !== null && (await win.locator('[data-testid=replica-wf-lora-target]').first().innerText()).includes('charB'))
  // 取消替换不会白屏，状态恢复；再次替换供后续步骤使用
  await win.locator('[data-testid=replica-wf-lora-replace]').first().click()
  await win.waitForTimeout(500)
  check('取消替换后页面正常、状态恢复', (await win.locator('[data-testid=replica-crashed]').count()) === 0 && (await win.locator('[data-testid=replica-wf-lora]').first().getAttribute('data-replaced')) === null)
  await win.locator('[data-testid=replica-wf-lora-replace]').first().click()
  await win.waitForTimeout(800)
  await shot('r3-character')

  // 4. 预览
  await step(3)
  await win.waitForSelector('[data-testid=replica-row]')
  await win.waitForTimeout(600)
  const row = (n) => win.locator(`[data-testid=replica-row][data-name="${n}"]`)
  check('汇总：总数 4，可生成 3，不能生成 1', (await tid('sum-total').innerText()).includes('4') && (await tid('sum-valid').innerText()).includes('3') && (await tid('sum-invalid').innerText()).includes('1'))
  check('替换结果保留未选中内容与位置', (await row('001.png').locator('[data-testid=replica-parts]').innerText()).includes('smile, park') && (await row('001.png').locator('[data-testid=part-add]').innerText()).includes('char_b'))
  check('移除的 Tag 以原写法标记', (await row('001.png').locator('[data-testid=part-remove]').first().innerText()) === '(red hair:1.2)')
  check('新角色显示「待生成」，不是假结果', (await row('001.png').locator('[data-testid=replica-pending]').innerText()).includes('待生成'))
  check('输出文件名与原图对应', (await row('002.png').locator('[data-testid=replica-output-name]').innerText()).includes('002.png'))
  check('没有元数据的图片明确标记', (await row('004.png').getAttribute('data-state')) === 'invalid')
  await shot('r4-preview')
  // 手动编辑一张
  await row('003.png').locator('[data-testid=replica-row-edit]').click()
  await row('003.png').locator('[data-testid=replica-edit-positive]').fill('手动, char_b, running')
  await row('003.png').locator('[data-testid=replica-edit-save]').click()
  await win.waitForTimeout(800)
  check('手动编辑写入最终 Prompt', (await row('003.png').locator('[data-testid=replica-parts]').innerText()).includes('手动'))
  // 最终工作流
  await row('001.png').locator('[data-testid=replica-row-json]').click()
  await win.waitForSelector('[data-testid=final-workflow]')
  await win.waitForTimeout(500)
  const changes = await tid('final-workflow-changes').innerText()
  check('最终工作流默认显示可读的变化', changes.includes('Steps') && changes.includes('28') && changes.includes('21') && changes.includes('charB'), changes.slice(0, 300))
  await tid('final-workflow-show-json').click()
  const previewJson = JSON.parse(await tid('final-workflow-json').innerText())
  await win.keyboard.press('Escape')
  await win.waitForTimeout(300)

  // 草稿重新打开
  await win.waitForTimeout(600)
  await tid('replica-back').click()
  await win.waitForSelector('[data-testid=replica-draft]')
  await tid('replica-open').first().click()
  await win.waitForSelector('[data-testid=replica-editor]')
  await win.waitForTimeout(600)
  check('重新打开草稿：图片与选择都保留', (await tid('replica-count-all').innerText()).includes('4'))
  await step(3)
  await win.waitForSelector('[data-testid=replica-row]')
  await win.waitForTimeout(500)
  check('重新打开后手动修改还在', (await row('003.png').locator('[data-testid=replica-parts]').innerText()).includes('手动'))

  // 5. 生成
  await step(4)
  await win.waitForTimeout(500)
  const outDir = (await tid('replica-output-dir').innerText()).replace(/^保存到 /, '').split('，')[0]
  await tid('replica-start').click()
  await win.waitForTimeout(300)
  await win.getByRole('button', { name: '继续' }).click()
  await win.waitForSelector('[data-testid=replica-done]', { timeout: 15000 })
  // 工作区中可能还有其他排队的内容：只看这次复刻提交的
  const mine = () => mock.submitted.filter(([, g]) => String(g['9']?.inputs?.filename_prefix ?? '').startsWith('ComfyEngi复刻/'))
  for (let i = 0; i < 240; i++) {
    if (mine().length >= 3 && existsSync(outDir) && readdirSync(outDir).length >= 3) break
    await win.waitForTimeout(250)
  }
  const submitted = mine()
  check('三张图都提交了', submitted.length === 3, String(submitted.length))
  const texts = submitted.map(([, g]) => g['6'].inputs.text)
  check('每张图的 Prompt 不同，未选中内容不变', texts[0] === '1girl, char_b, (pink hair:1.1), smile, park' && texts[1] === '1girl, char_b, (pink hair:1.1), sitting, beach' && texts[2] === '手动, char_b, running', texts.join(' | '))
  check('每张图的 Seed 与尺寸不同', submitted.map(([, g]) => g['3'].inputs.seed).join() === '1001,1002,1003' && submitted.map(([, g]) => g['5'].inputs.width).join() === '832,1024,640')
  check('负面保留原图并追加角色负面', submitted[0][1]['7'].inputs.text === 'lowres, bad hands')
  check('LoRA 已替换', submitted.every(([, g]) => g['10'].inputs.lora_name === 'charB.safetensors' && g['10'].inputs.strength_model === 0.7))
  check('提交的 JSON 与预览相同', JSON.stringify(submitted[0][1]) === JSON.stringify(previewJson))
  check('输出文件与原图同名', readdirSync(outDir).sort().join() === '001.png,002.png,003.png', readdirSync(outDir).join())
  await nav('运行记录')
  await win.waitForTimeout(500)
  check('运行记录中可以看到这次复刻', (await win.locator('main').innerText()).includes('复刻'))
  await shot('r5-history')
  check('原图没有被修改', Object.entries(originals).every(([f, h]) => sha(join(imgDir, f)) === h))
  check('没有渲染进程错误', errors.length === 0, errors.slice(0, 3).join(' / '))
} catch (e) {
  console.error(e)
  await shot('zz-failure').catch(() => {})
  check('脚本执行', false, String(e).slice(0, 300))
} finally {
  await app.close().catch(() => {})
  await mock.shutdown().catch(() => {})
}
console.log(`\n截图：${shots}\n数据目录：${dataDir}`)
const failed = results.filter((ok) => !ok).length
console.log(failed ? `${failed} 项失败` : '全部通过')
process.exit(failed ? 1 : 0)
