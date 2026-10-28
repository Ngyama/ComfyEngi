// 历史 Prompt 提取端到端测试：在真实窗口中添加一个 PNG 文件夹（含子文件夹、无元数据、损坏、需确认的图片），
// 验证读取进度与统计、自动分析、找回预设组合、全局公共标签、来源与变化标签、编辑后批量保存为素材、重复跳过、
// 参数重新分析、词典导入；无法自动识别的图片：失败原因分组、原始元数据查看与复制、手动指定来源并应用到同结构图片；
// 以及原图片完全不变。
//
// 用法：npx electron-vite build && node --experimental-strip-types --no-warnings scripts/e2e-mining.mjs [--shots <目录>]

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { comfyGraph, COWGIRL, dataset, MISSIONARY, withText } from '../test/mining-fixtures.ts'
import { A1111, apiCustomComposer, makeJpeg, tiff, userComment } from '../test/meta-fixtures.ts'

const root = resolve(import.meta.dirname, '..')
const argOf = (k) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : null)
const exe = argOf('--exe')
const shots = resolve(argOf('--shots') || join(tmpdir(), 'comfyengi-e2e-mining'))
mkdirSync(shots, { recursive: true })
const dataDir = mkdtempSync(join(tmpdir(), 'comfyengi-e2e-mining-'))
copyFileSync(join(root, 'test/fixtures/legacy-v0.db'), join(dataDir, 'comfyengi.db'))
const vault = join(dataDir, 'vault')
const imgDir = join(dataDir, 'history')
mkdirSync(join(imgDir, 'more'), { recursive: true })

const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
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

const env = { ...process.env, COMFYENGI_DATA_DIR: dataDir, COMFYENGI_VAULT: vault, COMFYENGI_IMPORT_LEGACY: join(dataDir, 'comfyengi.db') }
const app = exe ? await electron.launch({ executablePath: resolve(exe), args: [], env }) : await electron.launch({ args: [root], cwd: root, env })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(String(e)))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
const setSize = (w, h) => app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [w, h])
const shot = async (name) => {
  await win.waitForTimeout(400)
  await win.screenshot({ path: join(shots, `${name}.png`) })
}
const nav = (label) => win.locator('nav button').filter({ hasText: new RegExp(`^${label}$`) }).click()
const stubOpen = (paths) => app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: p }) }, paths)
const closeDialogs = async () => {
  for (let i = 0; i < 5 && (await win.locator('[role=dialog]').count()); i++) {
    await win.keyboard.press('Escape')
    await win.waitForTimeout(350)
  }
}
const lib = () => win.evaluate(() => window.api['library.load']())

try {
  await setSize(1600, 980)
  await win.waitForSelector('nav')

  // 用画布生成真实的 PNG，再写入 ComfyUI 元数据（与 ComfyUI 保存的 tEXt 块相同）
  const canvasPng = (hue) =>
    win.evaluate((hue) => {
      const c = document.createElement('canvas')
      c.width = 512
      c.height = 768
      const g = c.getContext('2d')
      const grad = g.createLinearGradient(0, 0, 512, 768)
      grad.addColorStop(0, `hsl(${hue} 70% 85%)`)
      grad.addColorStop(1, `hsl(${(hue + 60) % 360} 60% 60%)`)
      g.fillStyle = grad
      g.fillRect(0, 0, 512, 768)
      return c.toDataURL('image/png').split(',')[1]
    }, hue)
  const data = dataset()
  for (const [i, im] of data.entries()) {
    const png = Buffer.from(await canvasPng(i * 20), 'base64')
    const name = im.id.replace(/^.*\//, '')
    const dir = name.startsWith('solo') ? join(imgDir, 'more') : imgDir
    writeFileSync(join(dir, name), withText(png, { prompt: JSON.stringify(comfyGraph(im.positive)), workflow: '{"nodes":[],"links":[]}' }))
  }
  writeFileSync(join(imgDir, 'zz_no_meta.png'), Buffer.from(await canvasPng(200), 'base64'))
  writeFileSync(join(imgDir, 'zz_broken.png'), Buffer.from('this is not a png'))
  const shared = comfyGraph('1girl, smile')
  shared['3'].inputs.negative = ['6', 0]
  writeFileSync(join(imgDir, 'zz_shared_node.png'), withText(Buffer.from(await canvasPng(300), 'base64'), { prompt: JSON.stringify(shared) }))
  const before = snapshot(imgDir)

  await nav('Prompt 提取')
  await win.locator('[data-testid=mining-page]').waitFor()
  await shot('m01-empty')
  await stubOpen([imgDir])
  await win.locator('[data-testid=add-folder]').first().click()
  await win.locator('[data-testid=mining-candidates]').waitFor({ timeout: 30000 })
  const stat = async (k) => Number((await win.locator(`[data-testid=stat-${k}]`).innerText()).replace(/\D/g, ''))
  check('读取统计：总数 / 成功 / 需确认 / 失败', (await stat('all')) === 21 && (await stat('ok')) === 18 && (await stat('check')) === 1 && (await stat('error')) === 2, `${await stat('all')}/${await stat('ok')}/${await stat('check')}/${await stat('error')}`)
  check('递归读取子文件夹', (await win.locator('[data-testid=mining-image]').filter({ hasText: 'solo_0.png' }).count()) === 1)
  const brokenRow = await win.locator('[data-testid=mining-image][data-status=error]').filter({ hasText: 'zz_broken' }).innerText()
  check('损坏图片显示原因', brokenRow.includes('不是 PNG'), brokenRow.replace(/\n/g, ' '))
  check('无元数据图片显示原因', (await win.locator('[data-testid=mining-image]').filter({ hasText: 'zz_no_meta' }).innerText()).includes('没有找到生成参数'))
  check('需要确认的图片默认不参与分析', !(await win.locator('[data-testid=mining-image][data-status=check] button[role=checkbox]').isChecked()))
  check('分析图片数 = 成功的 18 张', (await win.locator('[data-testid=mining-summary]').innerText()).includes('分析 18 张'))
  await shot('m02-analyzed')

  const cards = win.locator('[data-testid=mining-candidate]')
  const promptOf = (i) => cards.nth(i).locator('textarea').inputValue()
  check('找回预设组合（骑乘）', (await promptOf(0)) === COWGIRL, await promptOf(0))
  check('找回预设组合（正常位）', (await promptOf(1)) === MISSIONARY, await promptOf(1))
  check('临时名称按顺序编号', (await cards.nth(0).locator('input').first().inputValue()) === '提取组合 001')
  check('显示覆盖图片数与比例', (await cards.nth(0).innerText()).includes('覆盖 8 张') && (await cards.nth(0).innerText()).includes('44%'))
  const allPrompts = await cards.locator('textarea').evaluateAll((els) => els.map((e) => e.value))
  check('场景标签没有混入任何组合', allPrompts.every((p) => !/bedroom|indoors|outdoors/.test(p)), allPrompts.join(' | '))

  // 变化标签与来源图片
  await cards.nth(0).locator('[data-testid=toggle-variations]').click()
  const vars = await cards.nth(0).locator('[data-testid=variation]').allInnerTexts()
  check('变化标签列出 leaning forward / backward', vars.some((v) => v.startsWith('leaning forward')) && vars.some((v) => v.startsWith('leaning backward')), vars.join(','))
  await shot('m03-variations')
  await cards.nth(0).getByRole('button', { name: '来源图片' }).click()
  const srcDlg = win.locator('[data-testid=mining-sources]')
  await srcDlg.waitFor()
  await win.waitForTimeout(800)
  const srcNames = await srcDlg.locator('.truncate').allInnerTexts()
  check('来源图片：8 张骑乘图片', srcNames.length === 8 && srcNames.every((n) => n.startsWith('cowgirl_')), srcNames.join(','))
  check('来源图片有缩略图', (await srcDlg.locator('img').count()) >= 1)
  await shot('m04-sources')
  await srcDlg.locator('button').filter({ hasText: 'cowgirl_00.png' }).click()
  const imgDlg = win.locator('[data-testid=mining-image-dialog]')
  await imgDlg.waitFor()
  const rawPrompt = await imgDlg.locator('textarea').first().inputValue()
  check('查看原始 Prompt（不含负向与未连接的文本）', rawPrompt === data[0].positive && !rawPrompt.includes('unused'), rawPrompt)
  check('同时显示负向 Prompt（不参与分析）', /负向 prompt/i.test(await imgDlg.innerText()))
  await shot('m05-image')
  await closeDialogs()

  // 全局公共
  await win.locator('[data-testid=tab-global]').click()
  check('全局公共 Prompt 候选', (await win.locator('[data-testid=mining-global] textarea').first().inputValue()) === 'masterpiece, best quality, 1girl')
  await shot('m06-global')
  // 全部标签：只出现在少数图片中的标签也能看到
  await win.locator('[data-testid=tab-tags]').click()
  const rows = await win.locator('[data-testid=tag-row]').allInnerTexts()
  check('未被组合覆盖的标签可见（standing）', rows.some((r) => r.startsWith('standing')), String(rows.length))
  await win.locator('[data-testid=tag-row]').filter({ hasText: /^standing/ }).locator('button[role=checkbox]').click()
  await win.locator('[data-testid=tags-as-draft]').click()
  await shot('m07-tags')

  // 编辑并批量保存
  await win.locator('[data-testid=tab-candidates]').click()
  const custom = cards.filter({ hasText: 'standing' }).first()
  check('从标签表创建的自定义组合出现在列表顶部并已选中', (await cards.nth(0).locator('textarea').inputValue()) === 'standing' && (await cards.nth(0).locator('button[role=checkbox]').first().isChecked()))
  await custom.getByRole('button', { name: '移除自定义组合' }).click()
  const c0 = cards.nth(0)
  await c0.locator('input').first().fill('骑乘组合')
  await c0.getByRole('button', { name: '删除标签 sitting on lap' }).click()
  check('删除组合中的标签', (await c0.locator('textarea').inputValue()) === 'cowgirl position, straddling')
  await c0.locator('textarea').fill('cowgirl position, straddling, (sitting on lap:1.1)')
  await c0.locator('button[role=checkbox]').first().click()
  await cards.nth(1).locator('button[role=checkbox]').first().click()
  await win.locator('[data-testid=save-kind]').selectOption('pose')
  await shot('m08-before-save')
  await win.locator('[data-testid=mining-save]').click()
  await win.waitForTimeout(1500)
  const poses = existsSync(join(vault, 'prompts', 'poses')) ? readdirSync(join(vault, 'prompts', 'poses')) : []
  check('保存为 Markdown 素材文件', poses.includes('骑乘组合.md') && poses.includes('提取组合 002.md'), poses.join(','))
  const saved = (await lib()).templates.filter((t) => t.name === '骑乘组合' || t.name === '提取组合 002')
  check('素材字段正确（类别、Prompt 原文、空负面）', saved.length === 2 && saved.every((t) => t.kind === 'pose' && t.negative === '') && saved.some((t) => t.positive === 'cowgirl position, straddling, (sitting on lap:1.1)'), JSON.stringify(saved.map((t) => [t.kind, t.positive])))
  check('保存后标记为已保存', (await c0.innerText()).includes('已保存为单人动作'))
  await shot('m09-saved')

  // 与已有素材重复：提示并跳过
  await win.locator('[data-testid=tab-tags]').click()
  await win.locator('[data-testid=mining-tags]').getByRole('button', { name: /^全部/ }).click()
  for (const t of ['missionary', 'lying on back', 'spread legs']) {
    await win.locator('[data-testid=mining-tags] input').fill(t)
    await win.locator('[data-testid=tag-row]').filter({ hasText: new RegExp(`^${t}`) }).locator('button[role=checkbox]').click()
  }
  await win.locator('[data-testid=tags-as-draft]').click()
  await win.locator('[data-testid=tab-candidates]').click()
  check('与已有素材重复时显示提示', (await cards.nth(0).locator('[data-testid=dup-badge]').innerText()).includes('提取组合 002'))
  const countBefore = (await lib()).templates.length
  await win.locator('[data-testid=mining-save]').click()
  await win.waitForTimeout(1200)
  check('重复的组合跳过，不新增也不覆盖', (await lib()).templates.length === countBefore && (await win.getByText(/已保存 0 个，跳过 1 个/).count()) >= 1)

  // 参数调整后重新分析
  for (let i = 0; i < 6; i++) await win.getByRole('button', { name: '最小共同出现增加' }).click()
  check('参数变化后提示重新分析', (await win.getByText('图片或参数已变化').count()) === 1)
  await win.locator('[data-testid=analyze]').click()
  await win.waitForTimeout(1500)
  const after9 = await cards.locator('textarea').evaluateAll((els) => els.map((e) => e.value))
  const tab9 = await win.locator('[data-testid=tab-candidates]').innerText()
  check('提高最小共同出现到 9 后没有局部组合（已保存 / 自定义的组合保留）', /重复组合\s*0/.test(tab9) && after9.includes('cowgirl position, straddling, (sitting on lap:1.1)'), `${tab9} · ${after9.join(' | ')}`)
  for (let i = 0; i < 6; i++) await win.getByRole('button', { name: '最小共同出现减少' }).click()
  await win.locator('[data-testid=analyze]').click()
  await win.waitForTimeout(1500)
  check('恢复参数后得到相同结果，保留之前的编辑', (await cards.locator('textarea').evaluateAll((els) => els.map((e) => e.value))).includes('cowgirl position, straddling, (sitting on lap:1.1)'))

  // 词典
  const dictFile = join(dataDir, 'danbooru.csv')
  writeFileSync(dictFile, 'cowgirl_position,0,1000,"cowgirl"\nstraddling,0,900,\nblush,0,5000,\n')
  await win.locator('[data-testid=open-dict]').click()
  await stubOpen([dictFile])
  await win.locator('[data-testid=dict-dialog]').getByRole('button', { name: '导入词典文件' }).click()
  await win.waitForTimeout(800)
  check('导入词典后显示数量', (await win.locator('[data-testid=dict-info]').innerText()).includes('已导入 3 个标签、1 个别名'))
  check('词典保存在工作区 data 目录', existsSync(join(vault, 'data', 'tag-dictionary.json')))
  await shot('m10-dict')
  await closeDialogs()
  await win.locator('[data-testid=analyze]').click()
  await win.waitForTimeout(1500)
  await win.locator('[data-testid=tab-tags]').click()
  check('有词典时可筛选词典外标签', (await win.getByText(/不在词典中 \d+/).count()) === 1)

  // 无法自动识别的图片：查看原始元数据，手动指定来源并应用到同结构的其他图片
  const customDir = join(dataDir, 'custom')
  mkdirSync(customDir)
  const subjects = ['silver hair, 1girl, maid', 'black hair, 1girl, nurse', 'blonde hair, 1girl, idol']
  for (const [i, t] of subjects.entries()) writeFileSync(join(customDir, `composer_${i}.png`), withText(Buffer.from(await canvasPng(i * 40), 'base64'), { prompt: JSON.stringify(apiCustomComposer(t, i === 2 ? 100 : 0)) }))
  writeFileSync(join(customDir, 'webui.jpg'), makeJpeg(tiff([], [[0x9286, 7, userComment(A1111)]])))
  const customBefore = snapshot(customDir)
  const okBefore = await stat('ok')
  await stubOpen([customDir])
  await win.locator('[data-testid=add-folder]').first().click()
  await win.waitForTimeout(1500)
  check('新增文件夹：JPEG 的 WebUI 参数直接读取', (await stat('ok')) === okBefore + 1 && (await win.locator('[data-testid=mining-image]').filter({ hasText: 'webui.jpg' }).innerText()).includes('masterpiece, best quality, 1girl,'))
  check('统计「读到元数据」', (await stat('meta')) === 23, String(await stat('meta')))
  await win.locator('[data-testid=toggle-reasons]').click()
  const reasons = await win.locator('[data-testid=fail-reason]').allInnerTexts()
  check('失败原因分组：自定义节点 3 张', reasons.some((r) => r.includes('PromptComposer') && r.includes('3 张')), reasons.join(' / '))
  await shot('m11-fail-reasons')
  await win.locator('[data-testid=mining-image]').filter({ hasText: 'composer_0.png' }).locator('button').last().click()
  await imgDlg.waitFor()
  check('图片详情显示失败原因', (await imgDlg.locator('[data-testid=img-error]').innerText()).includes('无法识别的节点 #50（PromptComposer）'))
  await imgDlg.locator('[data-testid=goto-raw]').click()
  await imgDlg.locator('[data-testid=raw-field]').first().waitFor()
  const rawText = await imgDlg.locator('[data-testid=raw-text]').first().innerText()
  check('原始元数据：prompt 字段格式化显示', (await imgDlg.locator('[data-testid=raw-field]').first().innerText()).includes('prompt') && rawText.includes('"class_type": "PromptComposer"'), rawText.slice(0, 80))
  await imgDlg.locator('[data-testid=raw-copy]').first().click()
  await win.waitForTimeout(300)
  const clip = await app.evaluate(({ clipboard }) => clipboard.readText())
  check('复制原文 = PNG 中保存的原始文本', clip === JSON.stringify(apiCustomComposer(subjects[0])))
  await shot('m12-raw')
  await imgDlg.locator('[data-testid=img-tab-sources]').click()
  const src = imgDlg.locator('[data-testid=img-source]').filter({ hasText: 'prompt_text' })
  check('Prompt 来源列出自定义节点的文本（连到正向）', (await src.getAttribute('data-role')) === 'positive' && (await src.innerText()).includes(subjects[0]))
  await src.locator('[data-testid=use-source]').click()
  const box = await imgDlg.locator('[data-testid=apply-rule-box]').innerText()
  check('同结构的其他 2 张可应用（节点编号不同的也能匹配）', box.includes('另有 2 张'), box)
  await shot('m13-sources')
  await imgDlg.locator('[data-testid=apply-rule]').click()
  await imgDlg.locator('[data-testid=img-tab-prompt]').click()
  check('手动指定后的 Prompt', (await imgDlg.locator('textarea').first().inputValue()) === subjects[0])
  await closeDialogs()
  const manualRows = await win.locator('[data-testid=mining-image][data-manual]').allInnerTexts()
  check('3 张图片使用手动指定的来源', manualRows.length === 3 && subjects.every((t) => manualRows.some((r) => r.includes(t))), manualRows.join(' / '))
  check('需确认的图片可以一键纳入分析', (await win.locator('[data-testid=check-banner]').count()) === 1)
  await win.locator('[data-testid=include-check]').click()
  await win.locator('[data-testid=analyze]').click()
  await win.waitForTimeout(1500)
  check('手动指定的图片与需确认的图片进入组合分析', (await win.locator('[data-testid=mining-summary]').innerText()).includes('分析 23 张'), await win.locator('[data-testid=mining-summary]').innerText())
  check('新增文件夹中的图片没有被修改', JSON.stringify(snapshot(customDir)) === JSON.stringify(customBefore))

  // 素材库入口
  await nav('素材库')
  await win.locator('[data-testid=open-mining]').click()
  check('素材库中的入口打开提取页面（结果保留）', (await win.locator('[data-testid=mining-summary]').count()) === 1)

  check('原图片没有被修改', JSON.stringify(snapshot(imgDir)) === JSON.stringify(before))
  check('没有渲染进程错误', errors.length === 0, errors.slice(0, 3).join(' / '))
} catch (e) {
  console.error(e)
  await shot('zz-failure').catch(() => {})
  check('脚本执行', false, String(e).slice(0, 300))
} finally {
  await app.close().catch(() => {})
}
console.log(`\n截图：${shots}\n数据目录：${dataDir}`)
const failed = results.filter((ok) => !ok).length
console.log(failed ? `${failed} 项失败` : '全部通过')
process.exit(failed ? 1 : 0)
