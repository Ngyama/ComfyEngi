// 套图复刻端到端测试：在真实窗口中完成「导入 → 识别 / 筛选 → 配置 → 预览 → 入队」，提交到模拟 ComfyUI，
// 验证保留片段、新角色、LoRA 替换、重复生成的变体、提交的 JSON 与预览相同、草稿重新打开、原图不变。模拟 ComfyUI 不能代替真实环境验证。
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
write('001.png', { prompt: JSON.stringify(graph('1girl, (red hair:1.2), char_a, from side, smile, park', 'lowres', 1001, 832)) })
write('002.png', { prompt: JSON.stringify(graph('1girl, Red_Hair, char_a, cowboy shot, sitting, beach', 'blurry', 1002, 1024)) })
// 没有镜头 Tag：识别会标记为需要处理，在界面中手动指定保留起点
write('003.png', { parameters: '1girl, red hair, char_a, running, street\nNegative prompt: worst\nSteps: 33, Sampler: Euler a, CFG scale: 4, Seed: 1003, Size: 640x960' })
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
  check('单张详情：显示原图尺寸', (await tid('replica-image-size').innerText()).includes('832'))
  check('单张详情：原图参数与 LoRA 只作参考', (await tid('replica-image-detail').innerText()).includes('参考'))
  await shot('r1-import')

  // 2. 识别 / 筛选
  await step(1)
  await win.waitForSelector('[data-testid=recog-row]')
  await win.waitForTimeout(500)
  const recogRow = (n) => win.locator(`[data-testid=recog-row][data-name="${n}"]`)
  const charTags = await win.locator('[data-testid=recog-character-tags] [data-testid=recog-tag]').evaluateAll((els) => els.map((e) => e.dataset.key))
  check('识别出旧角色 Tag（合并不同写法）', charTags.includes('red_hair') && charTags.includes('char_a'), charTags.join(','))
  check('保留片段从镜头 Tag 开始', (await recogRow('001.png').locator('[data-testid=recog-retained]').innerText()).includes('from side, smile, park'))
  check('显示被替换的开头与删除的旧角色 Tag', (await recogRow('002.png').locator('[data-testid=recog-prefix-text]').innerText()).includes('1girl') && (await recogRow('002.png').locator('[data-testid=recog-removed-character]').innerText()).includes('Red_Hair'))
  check('没有镜头 Tag 的图片标记为需要处理', (await recogRow('003.png').getAttribute('data-needs-fix')) !== null)
  await shot('r2-recognize')
  // 手动指定 003 的保留起点
  await recogRow('003.png').locator('[data-testid=recog-seg]', { hasText: 'running' }).first().click()
  await win.locator('[data-testid=seg-cut]').click()
  await win.waitForTimeout(800)
  check('手动指定保留起点后不再需要处理', (await recogRow('003.png').getAttribute('data-needs-fix')) === null && (await recogRow('003.png').locator('[data-testid=recog-retained]').innerText()).includes('running, street'))
  check('最终 Prompt 预览显示新角色位置', (await recogRow('001.png').locator('[data-testid=recog-final]').count()) === 1)

  // 3. 配置：工作流、角色、LoRA、重复次数
  await step(2)
  await win.waitForSelector('[data-testid=replica-configure]')
  check('未选择角色时明确提示', (await tid('replica-character-missing').count()) === 1)
  await win.locator('[data-testid=replica-workflow] [data-testid=workflow-menu]').click()
  await win.locator('[role=dialog] button, [data-radix-popper-content-wrapper] button', { hasText: '复刻工作流' }).first().click()
  await win.waitForTimeout(600)
  await tid('replica-pick-character').click()
  await win.locator('[role=dialog] button', { hasText: '复刻角色' }).first().click()
  await win.waitForTimeout(600)
  check('显示角色 Prompt', (await tid('replica-character-prompt').innerText()).includes('char_b'))
  // 角色 LoRA 替换工作流中的 charA
  await win.locator('[data-testid=replica-lora] [data-testid=lora-placement]').first().click()
  await win.locator('[data-testid=placement-option]', { hasText: '替换「charA」' }).click()
  await win.waitForTimeout(800)
  check('LoRA 面板显示替换', (await tid('replica-lora').innerText()).includes('替换'))
  await tid('replica-repeat-input').fill('2')
  await win.waitForTimeout(800)
  await shot('r3-configure')

  // 4. 预览
  await step(3)
  await win.waitForSelector('[data-testid=replica-unit]')
  await win.waitForTimeout(600)
  const outputs = await win.locator('[data-testid=replica-unit]').evaluateAll((els) => els.map((e) => e.dataset.output))
  check('3 张 × 2 次 = 6 个单元，变体名称可以区分', outputs.join() === '001_v01,002_v01,003_v01,001_v02,002_v02,003_v02', outputs.join())
  check('汇总显示单元数', (await tid('replica-units-summary').innerText()).includes('6'))
  const unit = (o) => win.locator(`[data-testid=replica-unit][data-output="${o}"]`)
  check('最终 Prompt：保留片段 + 新角色', (await unit('001_v01').locator('[data-testid=replica-unit-positive]').innerText()).includes('from side, smile, park') && (await unit('001_v01').locator('[data-testid=replica-unit-positive]').innerText()).includes('char_b'))
  check('最终 Prompt 不含旧角色 Tag', !(await unit('002_v01').locator('[data-testid=replica-unit-positive]').innerText()).includes('Red_Hair'))
  await shot('r4-preview')
  // 最终工作流
  await unit('001_v01').locator('[data-testid=replica-unit-json]').click()
  await win.waitForSelector('[data-testid=final-workflow]')
  await win.waitForTimeout(500)
  const changes = await tid('final-workflow-changes').innerText()
  check('最终工作流显示可读的变化：LoRA 替换', changes.includes('charB'), changes.slice(0, 300))
  await tid('final-workflow-show-json').click()
  const previewJson = JSON.parse(await tid('final-workflow-json').innerText())
  check('不继承原图的 Steps / CFG / Sampler', previewJson['3'].inputs.steps === 28 && previewJson['3'].inputs.cfg === 5.5 && previewJson['3'].inputs.sampler_name === 'dpmpp_2m')
  await win.keyboard.press('Escape')
  await win.waitForTimeout(300)

  // 草稿重新打开
  await win.waitForTimeout(600)
  await tid('replica-back').click()
  await win.waitForSelector('[data-testid=replica-draft]')
  await tid('replica-open').first().click()
  await win.waitForSelector('[data-testid=replica-editor]')
  await win.waitForTimeout(600)
  check('重新打开草稿：图片都保留', (await tid('replica-count-all').innerText()).includes('4'))
  await step(1)
  await win.waitForSelector('[data-testid=recog-row]')
  await win.waitForTimeout(500)
  check('重新打开后手动修正还在', (await recogRow('003.png').locator('[data-testid=recog-retained]').innerText()).includes('running, street'))

  // 5. 入队
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
    if (mine().length >= 6 && existsSync(outDir) && readdirSync(outDir).length >= 6) break
    await win.waitForTimeout(250)
  }
  const submitted = mine()
  check('六个单元都提交了', submitted.length === 6, String(submitted.length))
  const SEP = ',\n\n'
  const texts = submitted.map(([, g]) => g['6'].inputs.text)
  const tail = `${SEP}char_b, (pink hair:1.1)`
  check('每张图的 Prompt = 保留片段 + 新角色', texts[0] === `from side, smile, park${tail}` && texts[1] === `cowboy shot, sitting, beach${tail}` && texts[2] === `running, street${tail}` && texts[3] === texts[0], texts.join(' | '))
  check('Seed 来自新工作流的逻辑，每个单元不同', new Set(submitted.map(([, g]) => g['3'].inputs.seed)).size === 6 && !submitted.some(([, g]) => [1001, 1002, 1003].includes(g['3'].inputs.seed)))
  check('尺寸按原图', submitted.slice(0, 3).map(([, g]) => g['5'].inputs.width).join() === '832,1024,640')
  check('负面只用角色负面（默认不保留原图负面）', submitted[0][1]['7'].inputs.text === 'bad hands')
  check('LoRA 已替换', submitted.every(([, g]) => g['10'].inputs.lora_name === 'charB.safetensors' && g['10'].inputs.strength_model === 0.7))
  check('提交的 JSON 与预览相同', JSON.stringify(submitted[0][1]) === JSON.stringify(previewJson))
  check('输出文件按原图名称与变体编号', readdirSync(outDir).sort().join() === '001_v01.png,001_v02.png,002_v01.png,002_v02.png,003_v01.png,003_v02.png', readdirSync(outDir).join())
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
