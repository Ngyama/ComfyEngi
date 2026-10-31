// 端到端冒烟测试：启动真实的 Electron 应用（已构建的 out/），连接模拟 ComfyUI，
// 通过界面完成「选择角色 → 添加姿态 → 拖动排序 → 配置 → 预览 → 开始生成 → 查看记录」，并截图。
//
// 用法：npm run e2e                                   （测试 out/ 中的构建结果）
//       node scripts/e2e.mjs --exe dist/win-unpacked/ComfyEngi.exe   （测试打包后的程序）
//       可选 --shots <目录> 指定截图输出位置
// 数据使用临时目录（从旧版数据库样本复制，同时验证旧数据迁移），不会触碰真实用户数据。

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { _electron as electron } from 'playwright-core'
import { MockComfy } from '../test/mock-comfy.ts'

const root = resolve(import.meta.dirname, '..')
const argOf = (k) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : null)
const exe = argOf('--exe')
const shots = resolve(argOf('--shots') || join(tmpdir(), 'comfyengi-e2e-shots'))
mkdirSync(shots, { recursive: true })
const dataDir = mkdtempSync(join(tmpdir(), 'comfyengi-e2e-'))
copyFileSync(join(root, 'test/fixtures/legacy-v0.db'), join(dataDir, 'comfyengi.db'))

const mock = new MockComfy(0.15, join(dataDir, 'comfy-output'))
const url = await mock.serve(0)
{
  const db = new DatabaseSync(join(dataDir, 'comfyengi.db'))
  db.prepare("UPDATE settings SET value=? WHERE key='comfy_url'").run(JSON.stringify(url))
  db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES('comfy_output_dir', ?)").run(JSON.stringify(join(dataDir, 'comfy-output')))
  db.close()
}

const results = []
const check = (name, ok, detail = '') => {
  results.push([ok, name, detail])
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

// 模拟 GitHub「最新 Release」接口，用于检查更新
let releaseReply = [404, { message: 'Not Found' }]
const releaseApi = createServer((_req, res) => res.writeHead(releaseReply[0], { 'content-type': 'application/json' }).end(JSON.stringify(releaseReply[1])))
await new Promise((r) => releaseApi.listen(0, '127.0.0.1', r))
const env = { ...process.env, COMFYENGI_UPDATE_URL: `http://127.0.0.1:${releaseApi.address().port}/latest`, COMFYENGI_DATA_DIR: dataDir, COMFYENGI_VAULT: join(dataDir, 'vault'), COMFYENGI_IMPORT_LEGACY: join(dataDir, 'comfyengi.db') }
const app = exe
  ? await electron.launch({ executablePath: resolve(exe), args: [], env })
  : await electron.launch({ args: [root], cwd: root, env })
console.log(exe ? `测试打包程序：${resolve(exe)}` : '测试构建结果 out/')
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(String(e)))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
const setSize = (w, h) => app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [w, h])
const shot = async (name) => {
  await win.waitForTimeout(350)
  await win.screenshot({ path: join(shots, `${name}.png`) })
}
// 只匹配导航按钮本身（底部的运行状态卡片空闲时也显示「执行队列」）
const nav = (label) => win.locator('nav button').filter({ hasText: new RegExp(`^${label}$`) }).click()

// 亮色主题检查：找出颜色很浅、且所在背景也很浅的文字（看不清）。颜色按 OKLCH / OKLab 的 L 或 sRGB 亮度近似
const lightnessCheck = () =>
  win.evaluate(() => {
    const parse = (str) => {
      const nums = (str.match(/-?[\d.]+%?/g) ?? []).map((x) => (x.endsWith('%') ? parseFloat(x) / 100 : parseFloat(x)))
      const alpha = str.includes('/') || str.startsWith('rgba') ? nums[nums.length - 1] : 1
      if (str.startsWith('oklch') || str.startsWith('oklab')) return { L: nums[0], a: alpha }
      const [r, g, b] = str.startsWith('color(srgb') ? nums.slice(0, 3).map((v) => v * 255) : nums.slice(0, 3)
      const lin = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
      return { L: Math.cbrt(0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)), a: alpha }
    }
    const bgOf = (el) => {
      for (let e = el; e; e = e.parentElement) {
        const cs = getComputedStyle(e)
        if (cs.backgroundImage !== 'none' || e.tagName === 'IMG' || e.tagName === 'VIDEO') return 0 // 图片 / 渐变上的文字不判断
        const c = parse(cs.backgroundColor)
        if (c.a > 0.5) return c.L
      }
      return 1
    }
    const bad = []
    for (const el of document.querySelectorAll('body *')) {
      if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue
      const r = el.getBoundingClientRect()
      if (!r.width || !r.height) continue
      const cs = getComputedStyle(el)
      if (cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) continue
      const c = parse(cs.color)
      if (c.L > 0.85 && c.a > 0.5 && bgOf(el) > 0.8) bad.push(el.textContent.trim().slice(0, 20))
    }
    const L = (el) => parse(getComputedStyle(el).backgroundColor).L
    return { bad, body: L(document.body), main: L(document.querySelector('main > div') ?? document.body), text: parse(getComputedStyle(document.body).color).L }
  })
const themeCheck = async (page) => {
  const r = await lightnessCheck()
  check(`亮色主题：${page}没有看不清的浅色文字`, r.bad.length === 0, r.bad.slice(0, 5).join(' / '))
  return r
}

try {
  await setSize(1920, 1040)
  await win.waitForSelector('text=动作序列', { timeout: 20000 })
  check('旧数据迁移：自动打开旧版任务', await win.locator('text=旧版任务').first().isVisible())
  check('迁移前已备份', readdirSync(join(dataDir, 'vault/data/backups')).some((f) => /before-v\d+-from-v0/.test(f)))
  const cards = win.locator('[aria-roledescription="sortable"]')
  check('旧任务的 2 个姿态以卡片显示', (await cards.count()) === 2, String(await cards.count()))
  await shot('01-plan')
  const cardGap = await win.evaluate(() => {
    const card = document.querySelector('[aria-roledescription="sortable"]')
    let sc = card.parentElement
    while (sc && getComputedStyle(sc).overflowY !== 'auto') sc = sc.parentElement
    return card.getBoundingClientRect().top - (sc.getBoundingClientRect().top + sc.clientTop)
  })
  check('动作序列第一张卡片的顶部描边不被滚动容器裁剪', cardGap >= 1, `${cardGap}px`)
  const th = await themeCheck('套图任务')
  check('亮色主题：外壳为浅粉、主容器接近白色、正文为深色', th.body > 0.9 && th.main > 0.95 && th.text < 0.45, `shell ${th.body.toFixed(3)} main ${th.main.toFixed(3)} text ${th.text.toFixed(3)}`)

  // 选择角色
  await win.locator('button', { hasText: '角色' }).filter({ hasText: '角色A' }).first().click()
  await win.locator('[role=dialog] button', { hasText: '角色A' }).first().click()
  // 添加姿态（插入末尾）
  // 旧方式（状态）：添加对话框中点选的多个状态合并为一个动作，这里分两次各添加一个（新动作插入到当前选中的动作之后）
  await win.locator('button', { hasText: '添加动作' }).first().click()
  check('添加对话框默认显示动作卡（旧数据中还没有动作卡）', (await win.locator('[role=dialog]').innerText()).includes('还没有动作卡'))
  await win.locator('[role=dialog] button', { hasText: '状态（旧方式）' }).click()
  await win.locator('[role=dialog] button', { hasText: '动作C' }).click()
  await win.locator('[role=dialog] button', { hasText: '鸭子坐' }).click()
  await shot('02-pose-picker')
  check('添加对话框：多个状态合并为一个动作', (await win.locator('[role=dialog] button', { hasText: '添加 1 个动作' }).count()) === 1)
  await win.locator('[role=dialog] button', { hasText: '鸭子坐' }).click()
  await win.locator('[role=dialog] button', { hasText: '添加 1 个动作' }).click()
  await win.waitForTimeout(300)
  await win.locator('button', { hasText: '添加动作' }).first().click()
  await win.locator('[role=dialog] button', { hasText: '状态（旧方式）' }).click()
  await win.locator('[role=dialog] button', { hasText: '鸭子坐' }).click()
  await win.locator('[role=dialog] button', { hasText: '添加 1 个动作' }).click()
  const names = async () => (await cards.locator('[data-testid=pose-name]').allInnerTexts())
  check('添加姿态后序列顺序正确', JSON.stringify(await names()) === JSON.stringify(['睡觉', '动作A', '动作C', '鸭子坐']), (await names()).join(','))

  // 拖动：把第 4 张卡片逐步拖到最前
  await win.waitForTimeout(400)
  const b4 = await cards.nth(3).boundingBox()
  const b1 = await cards.nth(0).boundingBox()
  await win.mouse.move(b4.x + 20, b4.y + b4.height / 2)
  await win.mouse.down()
  const dy = b4.y + b4.height / 2 - (b1.y + 4)
  for (let i = 1; i <= 30; i++) {
    await win.mouse.move(b4.x + 20, b4.y + b4.height / 2 - (dy * i) / 30)
    await win.waitForTimeout(16)
  }
  await win.waitForTimeout(200)
  await win.mouse.up()
  await win.waitForTimeout(400)
  check('拖拽排序生效', (await names())[0] === '鸭子坐', (await names()).join(','))

  // 打开第 1 个姿态详情：选服装、两个表情、20 张、镜头
  await cards.nth(0).click()
  // 详情只显示当前选择，点击后在素材选择器中选择
  const picker = win.locator('[data-testid=material-picker]')
  await win.locator('[data-testid=pick-outfit]').click()
  await picker.locator('button', { hasText: 'A服装3' }).click()
  await win.locator('[data-testid=pick-exprs]').click()
  await picker.locator('[data-testid=picker-list] button', { hasText: '表情2' }).click()
  await picker.locator('[data-testid=picker-list] button', { hasText: '表情5' }).click()
  await picker.locator('[data-testid=picker-done]').click()
  // 新动作默认竖图 10 张；竖图 +5 两次 = 20 张
  await win.getByRole('button', { name: '竖图增加 5 张' }).click()
  await win.getByRole('button', { name: '竖图增加 5 张' }).click()
  await win.locator('[data-testid=pick-camera]').click()
  await picker.locator('button', { hasText: '俯视' }).click()
  await picker.locator('[data-testid=picker-done]').click()
  await shot('03-pose-detail')
  const card0 = await cards.nth(0).innerText()
  check('姿态详情配置显示在卡片上', card0.includes('A服装3') && card0.includes('表情2、表情5') && card0.includes('20') && card0.includes('竖20') && card0.includes('俯视'), card0.replace(/\n/g, ' | '))
  check('详情面板加宽到 520px（不超出窗口）', await win.locator('[data-testid=detail-title]').evaluate((el) => { const p = el.closest('.rounded-2xl'); const r = p.getBoundingClientRect(); return r.width >= 500 && r.right <= window.innerWidth }))
  check('尺寸不能直接输入数字', (await win.locator('[data-testid=size-cards] input').count()) === 0)
  // 不能整除：竖图减到 15 张
  await win.getByRole('button', { name: '竖图减少 5 张' }).click()
  await win.waitForTimeout(200)
  check('不能整除时卡片显示错误', (await cards.nth(0).innerText()).includes('不能被 2 个表情平均分配'), (await cards.nth(0).innerText()).replace(/\n/g, ' | '))
  await win.getByRole('button', { name: '竖图增加 5 张' }).click()
  await win.waitForTimeout(200)

  // 预览
  await win.locator('button', { hasText: '预览计划' }).click()
  await win.waitForSelector('text=生成计划预览')
  await win.waitForTimeout(400)
  await shot('04-preview')
  const desc = await win.locator('[role=dialog]').innerText()
  check('预览显示总张数', /共 \d+ 张/.test(desc), desc.match(/共 \d+ 张[^。]*/)?.[0])
  await win.keyboard.press('Escape')
  await win.waitForTimeout(400)
  check('Esc 关闭预览', (await win.locator('[role=dialog]').count()) === 0)

  // 开始生成
  await win.locator('button', { hasText: '开始生成' }).click()
  await win.waitForTimeout(500)
  if (await win.locator('[role=dialog]', { hasText: '仍然开始' }).count()) {
    check('开始前检查无问题', false, await win.locator('[role=dialog]').innerText())
    await win.locator('button', { hasText: '仍然开始' }).click()
  }
  await nav('执行队列')
  await win.waitForSelector('text=生成中', { timeout: 10000 })
  const switchError=await win.evaluate(async()=>{try{await window.api['vault.choose'](false,false);return ''}catch(e){return String(e)}})
  check('运行期间禁止工作区切换',switchError.includes('停止'))
  await shot('05-queue-running')
  await win.waitForSelector('text=全部完成', { timeout: 120000 })
  await shot('06-queue-done')
  await themeCheck('执行队列')
  const total = mock.submitted.length
  check('任务通过模拟 ComfyUI 执行完成', total > 0, `提交 ${total} 张`)
  // 最终图片从 ComfyUI 复制到任务输出目录（默认工作区 output/），ComfyUI 原文件保留
  const walk = (d) => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])) : [])
  const copied = walk(join(dataDir, 'vault', 'output')).filter((f) => f.endsWith('.png'))
  // 本次入队的图片都会复制；迁移来的旧队列项（入队时没有输出目录）不复制
  const planned = Number(desc.match(/共 (\d+) 张/)[1])
  check('本次入队的最终图片已复制到工作区 output/（默认输出目录），旧队列项不复制，ComfyUI 原文件保留', copied.length === planned && planned < total && walk(join(dataDir, 'comfy-output')).filter((f) => f.endsWith('.png')).length >= total, `${copied.length} / 本次 ${planned} / 共提交 ${total}`)
  // 预览中的 Prompt 与实际提交一致（第一张：剧情场景 1）
  const firstNew = mock.submitted.find(([, g]) => String(g['6'].inputs.text).includes('scene1'))
  check('提交内容包含剧情场景与占位符替换', !!firstNew && String(firstNew[1]['6'].inputs.text).includes('scene1 角色A'))

  // 运行记录
  await nav('运行记录')
  await win.waitForTimeout(800)
  await shot('07-history')
  await win.locator('main button.group').first().click()
  await win.waitForTimeout(800)
  await shot('08-history-detail')
  await themeCheck('运行记录')

  // 其他页面
  await nav('LoRA 管理')
  check('LoRA Manager 正常打开', await win.getByRole('button', { name: /全部 LoRA/ }).isVisible())
  await shot('09-loras')
  await themeCheck('LoRA 管理')
  await nav('素材库')
  const tabs = (await win.locator('main button').allInnerTexts()).map((t) => t.replace(/\d+$/, ''))
  check('素材库分类为 全局 / 场景 / 状态 / 表情 / 镜头视角 / 动作卡', JSON.stringify(tabs.slice(tabs.indexOf('全局'), tabs.indexOf('全局') + 6)) === JSON.stringify(['全局', '场景', '状态', '表情', '镜头视角', '动作卡']) && !tabs.includes('双人动作') && !tabs.includes('单人动作') && !tabs.includes('行为'), tabs.slice(0, 12).join(','))
  await win.locator('[data-testid=lib-tab-state]').click()
  await win.waitForTimeout(300)
  check('旧姿态（单人动作）显示在状态中', (await win.locator('[data-testid=template-card]', { hasText: '睡觉' }).count()) === 1)
  const firstCard = (await win.locator('[data-testid=template-card]').first().innerText()).split('\n')[0]
  await win.locator('[data-testid=template-card]', { hasText: '动作C' }).click()
  await shot('09-library')
  await themeCheck('素材库')
  check('状态编辑只有名称、优先级、正面 Prompt 与可选的互斥组（无分类、标签、适用对象、负面）', (await win.getByText('适用对象').count()) === 0 && (await win.getByText('分类', { exact: true }).count()) === 0 && (await win.getByText('负面 Prompt').count()) === 0 && (await win.getByText('互斥组', { exact: true }).count()) === 1 && (await win.locator('[data-testid=priority-toggle]').getAttribute('data-value')) === 'normal')
  // 优先级：设为「高」后排到列表最前（同优先级保持原顺序），保存到素材文件
  await win.locator('[data-testid=priority-high]').click()
  await win.waitForTimeout(1200)
  const cardOrder = (await win.locator('[data-testid=template-card]').allInnerTexts()).map((t) => t.split('\n')[0])
  const prio = await win.evaluate(async () => (await window.api['library.load']()).templates.find((t) => t.name === '动作C')?.priority)
  check('优先级设为高：保存并排到状态列表最前，其余顺序不变', prio === 'high' && cardOrder[0] === '动作C' && cardOrder[1] === firstCard && (await win.locator('[data-testid=template-card]').first().locator('[data-testid=priority-badge]').count()) === 1, `${prio} ${cardOrder.join(',')}`)
  // 旧版单人动作转为单人动作卡：复制 Prompt 作为基础 Prompt，原状态保留为共享素材
  await win.locator('[data-testid=state-to-card]').click()
  await win.waitForTimeout(900)
  await win.locator('[data-testid=lib-tab-cards]').click()
  await win.waitForTimeout(300)
  const kindsC = await win.evaluate(async () => (await window.api['library.load']()).templates.filter((t) => t.name === '动作C').map((t) => `${t.kind}:${t.positive}:${t.card?.solo ?? ''}`).sort().join(','))
  check('状态转为单人动作卡：动作卡列表显示「动作C · 单人」，原状态保留', (await win.locator('[data-testid=position-row]', { hasText: '动作C' }).innerText()).includes('单人') && kindsC === 'position:action_c:true,state:action_c:', kindsC)
  // 动作卡：新建双人动作卡，编辑基础 Prompt；子体位（结构变体）以可展开卡片显示在下方（类似角色与服装）
  await win.locator('[data-testid=new-duo-card]').click()
  await win.waitForTimeout(500)
  const posDetail = win.locator('[data-testid=position-detail]')
  await posDetail.locator('textarea').first().fill('missionary')
  await posDetail.getByRole('button', { name: '新建子体位' }).click()
  await win.waitForTimeout(400)
  const subRow = win.locator('[data-testid=subposition-row]')
  await subRow.locator('input').fill('新子体位')
  await subRow.locator('textarea').fill('legs up')
  await win.waitForTimeout(900)
  await shot('09b-library-card')
  check('动作卡与子体位只有正面 Prompt（没有负面、备注输入）', (await posDetail.getByText('负面 Prompt').count()) === 0 && (await posDetail.getByText('备注').count()) === 0 && (await subRow.locator('textarea').count()) === 1)
  await subRow.getByRole('button', { name: '新子体位' }).click()
  await win.waitForTimeout(300)
  check('子体位卡片收起后显示名称与 Prompt 摘要', (await subRow.innerText()).includes('新子体位') && (await subRow.innerText()).includes('legs up'), (await subRow.innerText()).replace(/\n/g, ' | '))
  // 双人互动素材在「状态」中新建（全局共享），动作卡只记录允许使用哪些
  await win.locator('[data-testid=lib-tab-state]').click()
  await win.locator('main button', { hasText: '新建状态' }).click()
  await win.waitForTimeout(400)
  // 再建一个长名称的状态，检查素材标签的截断（新建后移除，不影响后面的步骤）
  const LONG_NAME = '这是一个名称非常长的局部姿态素材用来检查素材标签是否会被合理截断而不是撑破整个面板的宽度甚至更长一些'
  await win.locator('main button', { hasText: '新建状态' }).click()
  await win.waitForTimeout(400)
  await win.locator('[data-testid=template-editor] input').first().fill(LONG_NAME)
  await win.waitForTimeout(900)
  await win.locator('[data-testid=lib-tab-cards]').click()
  await win.waitForTimeout(300)
  await win.locator('[data-testid=position-row]', { hasText: '新双人动作卡' }).locator('button').nth(1).click()
  await win.waitForTimeout(300)
  const duoRow = win.locator('[data-testid=position-row]', { hasText: '新双人动作卡' })
  check('动作卡：单人卡与新建的双人卡 / 子体位（层级不变）', (await win.locator('[data-testid=position-row]').count()) === 2 && (await win.locator('[data-testid=subposition-row]').count()) === 1 && (await duoRow.innerText()).includes('1 个子体位') && (await duoRow.innerText()).includes('双人'), (await duoRow.innerText()).replace(/\n/g, ' | '))
  // 素材池：主角色局部姿态固定动作A、动作C（在两栏之间拖动），双人互动固定「新状态」，第二角色局部姿态随机候选只有动作B
  const pool = (k) => posDetail.locator(`[data-testid=pool-${k}]`)
  const pickList = win.locator('[data-testid=material-picker] [data-testid=picker-list] button')
  const savedCardNow = () => win.evaluate(async () => (await window.api['library.load']()).templates.find((t) => t.name === '新双人动作卡')?.card)
  const poseNames = async () => win.evaluate(async () => {
    const lib = await window.api['library.load']()
    const p = lib.templates.find((t) => t.name === '新双人动作卡').card.pools.pose
    const n = (ids) => (ids ?? []).map((id) => lib.templates.find((t) => t.id === id)?.name).join('+')
    return `${n(p.fixed)}|${n(p.random)}`
  })
  // 用真实的鼠标事件拖动手柄：target 为素材标签（放在它的 where 一侧）或一栏（where 为 below 时指向栏底部的空白处）
  const dragStart = async (name) => {
    const from = await pool('pose').getByRole('button', { name: `拖动 ${name}` }).boundingBox()
    await win.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
    await win.mouse.down()
    await win.mouse.move(from.x + from.width / 2 + 4, from.y + from.height / 2 + 6, { steps: 3 })
  }
  const dragOverTarget = async (target, where = 'center') => {
    const box = await target.boundingBox()
    const x = where === 'after' ? box.x + box.width - 3 : where === 'before' ? box.x + 3 : box.x + box.width / 2
    const y = where === 'below' ? box.y + box.height - 2 : box.y + box.height / 2
    await win.mouse.move(x, y, { steps: 12 })
    await win.waitForTimeout(120)
    // 拖动途中标签会重新换行：按目标的新位置再对准一次
    const again = await target.boundingBox()
    if (again && (again.x !== box.x || again.y !== box.y)) {
      const x2 = where === 'after' ? again.x + again.width - 3 : where === 'before' ? again.x + 3 : again.x + again.width / 2
      const y2 = where === 'below' ? again.y + again.height - 2 : again.y + again.height / 2
      await win.mouse.move(x2, y2, { steps: 6 })
      await win.waitForTimeout(120)
    }
  }
  const dragPose = async (name, target, where = 'center') => {
    await dragStart(name)
    await dragOverTarget(target, where)
    await win.mouse.up()
    await win.waitForTimeout(700)
  }
  const poseZone = (z) => win.locator(`[data-testid=pool-pose-${z}]`)
  const poseRow = (name) => pool('pose').locator('[data-testid=pool-item]', { hasText: name })
  check('素材池默认折叠为摘要行', (await posDetail.locator('[data-testid=card-pools] input').count()) === 0)
  await pool('pose').locator('button').first().click()
  check('素材池没有模式切换和数量设置，始终显示固定与随机两栏', (await posDetail.locator('[data-testid^=pool-pose-mode]').count()) === 0 && (await pool('pose').locator('input').count()) === 0 && (await poseZone('fixed').innerText()).includes('固定 Prompt') && (await poseZone('random').innerText()).includes('随机候选 Prompt'))
  await win.locator('[data-testid=pool-pose-random-add]').click()
  await pickList.filter({ hasText: /^动作A/ }).first().click()
  await pickList.filter({ hasText: /^动作C/ }).first().click()
  await win.locator('[data-testid=picker-done]').click()
  await win.waitForTimeout(700)
  check('添加的素材进入随机栏', (await poseNames()) === '|动作A+动作C', await poseNames())
  await dragPose('动作A', poseZone('fixed'))
  check('从随机栏拖到空的固定栏（移动，不复制）', (await poseNames()) === '动作A|动作C', await poseNames())
  await dragPose('动作C', poseZone('fixed'), 'below')
  check('随机栏拖到固定栏，随机栏为空', (await poseNames()) === '动作A+动作C|', await poseNames())
  await dragPose('动作A', poseRow('动作C'), 'after')
  check('固定栏内调整顺序', (await poseNames()) === '动作C+动作A|', await poseNames())
  await dragPose('动作A', poseZone('random'))
  check('从固定栏拖到空的随机栏', (await poseNames()) === '动作C|动作A', await poseNames())
  await dragPose('动作A', poseRow('动作C'), 'before')
  check('拖回固定栏并放在目标前面', (await poseNames()) === '动作A+动作C|', await poseNames())
  await win.locator('[data-testid=pool-pose-random-add]').click()
  check('已固定的素材不出现在随机栏的选择器中', (await pickList.filter({ hasText: /^动作A/ }).count()) === 0)
  await pickList.filter({ hasText: /^动作B/ }).first().click()
  await win.locator('[data-testid=picker-done]').click()
  await win.waitForTimeout(700)
  await pool('pose').getByRole('button', { name: '移除 动作B' }).click()
  await win.waitForTimeout(700)
  check('标签上的按钮移除素材', (await poseNames()) === '动作A+动作C|', await poseNames())
  // 紧凑布局：多个标签自动换行、宽度随名称变化、长名称截断并有完整提示；拖动在换行的布局中同样有效
  const chipBoxes = async (zone) => poseZone(zone).locator('[data-testid=pool-item]').evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: Math.round(r.y), w: r.width, right: r.right, text: el.innerText } }))
  const wraps = (boxes) => { const rows = new Map(); for (const b of boxes) rows.set(b.y, (rows.get(b.y) ?? 0) + 1); return { rows: rows.size, most: Math.max(0, ...rows.values()) } }
  const fixedRow = await chipBoxes('fixed')
  check('固定栏多个素材排在同一行（多列）', wraps(fixedRow).rows === 1 && wraps(fixedRow).most === 2 && fixedRow[0].x < fixedRow[1].x, JSON.stringify(fixedRow))
  await win.locator('[data-testid=pool-pose-random-add]').click()
  await win.locator('[data-testid=picker-add-all]').click()
  await win.locator('[data-testid=picker-done]').click()
  await win.waitForTimeout(700)
  const randomBoxes = await chipBoxes('random')
  const zoneBox = await poseZone('random').boundingBox()
  check('随机栏多个素材多列显示并自动换行', randomBoxes.length >= 4 && wraps(randomBoxes).rows >= 2 && wraps(randomBoxes).most >= 2, JSON.stringify(wraps(randomBoxes)))
  check('标签宽度随名称变化，都不超出所在的栏', new Set(randomBoxes.map((b) => Math.round(b.w))).size >= 2 && randomBoxes.every((b) => b.right <= zoneBox.x + zoneBox.width), JSON.stringify(randomBoxes.map((b) => Math.round(b.w))))
  const longName = poseRow(LONG_NAME).locator('span[title]')
  check('长名称截断，title 显示完整名称', (await longName.getAttribute('title')) === LONG_NAME && (await longName.evaluate((el) => el.scrollWidth > el.clientWidth)), LONG_NAME.length)
  check('素材标签比旧的整行素材紧凑（高度不超过 28px）', randomBoxes.length > 0 && (await poseRow('动作B').boundingBox()).height <= 28)
  // 拖动中的反馈：浮层跟随指针，目标栏高亮
  await dragStart('动作B')
  await dragOverTarget(poseRow('动作A'), 'before')
  const dragFeedback = { overlay: await win.locator('[data-testid=pool-drag-overlay]').isVisible(), active: await poseZone('fixed').getAttribute('data-drop-active'), order: (await poseZone('fixed').locator('[data-testid=pool-item]').allInnerTexts()).join('+') }
  await shot('09c0-pool-chips-dragging')
  check('拖动时有浮层、目标栏高亮，素材实时移到落点', dragFeedback.overlay && dragFeedback.active === 'true' && dragFeedback.order.startsWith('动作B'), JSON.stringify(dragFeedback))
  await win.mouse.up()
  await win.waitForTimeout(700)
  check('松手后保存：拖到固定栏最前面', (await poseNames()).startsWith('动作B+动作A+动作C|'), await poseNames())
  // 在换行的布局中排序：把随机栏的第一个拖到最后一个后面（跨行）
  const randomOrder = async () => (await poseNames()).split('|')[1].split('+')
  const beforeSort = await randomOrder()
  await dragPose(beforeSort[0], poseRow(beforeSort[beforeSort.length - 1]), 'after')
  const afterSort = await randomOrder()
  check('随机栏内跨行调整顺序', afterSort[afterSort.length - 1] === beforeSort[0] && afterSort.length === beforeSort.length, afterSort.join('+'))
  // 宽度不同的标签来回调整也不会丢失或重复
  await dragPose(afterSort[afterSort.length - 1], poseRow(LONG_NAME), 'after')
  const afterLong = await randomOrder()
  check('跨过长名称标签排序（不跳动、不丢失）', afterLong.indexOf(afterSort[afterSort.length - 1]) === afterLong.indexOf(LONG_NAME) + 1 && new Set(afterLong).size === beforeSort.length, afterLong.join('+'))
  // 指向一行末尾的空白处：放到最近的标签后面
  const lastChip = (await randomOrder()).at(-1)
  const firstChip = (await randomOrder())[0]
  const lastBox = await poseRow(lastChip).boundingBox()
  const blankZone = await poseZone('random').boundingBox()
  await dragStart(firstChip)
  await win.mouse.move(blankZone.x + blankZone.width - 12, lastBox.y + lastBox.height / 2, { steps: 12 })
  await win.waitForTimeout(150)
  const blankNow = await poseRow(lastChip).boundingBox()
  await win.mouse.move(blankZone.x + blankZone.width - 12, blankNow.y + blankNow.height / 2, { steps: 4 })
  await win.waitForTimeout(150)
  await win.mouse.up()
  await win.waitForTimeout(700)
  check('拖到行尾空白处：放在该行最后', (await randomOrder()).at(-1) === firstChip, (await randomOrder()).join('+'))
  // 键盘：左右键调整顺序，上下键移到另一栏，焦点留在素材上
  await pool('pose').getByRole('button', { name: '拖动 动作A' }).focus()
  await win.keyboard.press('ArrowRight')
  await win.waitForTimeout(500)
  check('键盘左右键调整标签顺序', (await poseNames()).startsWith('动作B+动作C+动作A|'), await poseNames())
  await win.keyboard.press('ArrowDown')
  await win.waitForTimeout(500)
  check('键盘下键移到随机栏', (await randomOrder()).at(-1) === '动作A' && (await poseNames()).startsWith('动作B+动作C|'), await poseNames())
  await win.keyboard.press('ArrowUp')
  await win.waitForTimeout(500)
  check('键盘上键移回固定栏（焦点保留）', (await poseNames()).startsWith('动作B+动作C+动作A|'), await poseNames())
  await dragPose('动作A', poseRow('动作C'), 'before')
  await shot('09c0-pool-chips')
  // 还原：固定栏只留动作A、动作C，随机栏清空
  await pool('pose').getByRole('button', { name: '移除 动作B' }).click()
  await win.waitForTimeout(700)
  await win.locator('[data-testid=pool-pose-random-add]').click()
  await win.locator('[data-testid=material-picker]').getByRole('button', { name: '清空' }).click()
  await win.locator('[data-testid=picker-done]').click()
  await win.waitForTimeout(700)
  check('还原后素材池保存格式不变', (await poseNames()) === '动作A+动作C|', await poseNames())
  await pool('interaction').locator('button').first().click()
  await win.locator('[data-testid=pool-interaction-fixed-add]').click()
  await pickList.filter({ hasText: /^新状态/ }).first().click()
  await win.locator('[data-testid=picker-done]').click()
  await win.waitForTimeout(700)
  await pool('pose2').locator('button').first().click()
  await win.locator('[data-testid=pool-pose2-random-add]').click()
  await pickList.filter({ hasText: /^动作B/ }).first().click()
  await win.locator('[data-testid=picker-done]').click()
  await win.waitForTimeout(900)
  await shot('09c-library-card-pools')
  const savedCard = await savedCardNow()
  check(
    '素材池只保存素材 ID（不复制 Prompt），摘要显示两栏数量',
    savedCard?.pools?.pose?.fixed?.length === 2 && savedCard.pools.pose.random.length === 0 && savedCard.rules === undefined && savedCard.pools.interaction.fixed?.length === 1 && savedCard.pools.pose2.random?.length === 1 && (await win.locator('[data-testid=pool-pose-summary]').innerText()).includes('固定 2 项') && !JSON.stringify(savedCard).includes('action_'),
    JSON.stringify(savedCard),
  )
  // 在任务中使用：添加动作卡（默认显示动作卡，直接使用卡片的默认组合规则）
  await nav('套图任务')
  await win.locator('button', { hasText: '添加动作' }).first().click()
  check('添加对话框默认显示动作卡（单人 / 双人）', (await win.locator('[role=dialog] [data-testid=card-tile]').count()) === 2)
  await shot('09d-card-picker')
  await win.locator('[role=dialog] [data-testid=card-tile]', { hasText: '新双人动作卡' }).click()
  await win.locator('[role=dialog] button', { hasText: '添加 1 个动作' }).click()
  await win.waitForTimeout(300)
  check('任务中添加动作卡（插入在选中动作之后）', (await names())[1] === '新双人动作卡', (await names()).join(','))
  const duoCard = cards.nth(1)
  // 第二角色：与主角色来自同一个角色库；双人动作卡在选择第二角色后由其出场
  await win.locator('button', { hasText: '第二角色' }).filter({ hasText: '不使用' }).first().click()
  await win.locator('[role=dialog] button', { hasText: '角色B' }).first().click()
  await win.waitForTimeout(300)
  check('选择第二角色后双人动作卡由第二角色出场，旧单人动作保持单人', (await duoCard.innerText()).includes('+ 角色B') && !(await cards.nth(0).innerText()).includes('+ 角色B'), (await duoCard.innerText()).replace(/\n/g, ' | '))
  await duoCard.click()
  await win.waitForTimeout(300)
  check('动作卡详情：只需选择服装、场景与张数；高级组合设置默认折叠', (await win.locator('[data-testid=card-detail]').count()) === 1 && (await win.locator('[data-testid=card-advanced]').count()) === 0 && (await win.locator('[data-testid=second-state]').innerText()).includes('角色B 出场') && (await win.locator('[data-testid=main-pose]').count()) === 0)
  await shot('09e-plan-card-detail')
  const unitsOf = (label) =>
    win.evaluate(async (l) => {
      const lib = await window.api['library.load']()
      const p = await window.api['plan.forTask'](lib.settings.last_task_id ?? lib.tasks[0].id)
      return p.units.filter((u) => u.section === 'pose' && u.item_label === l)
    }, label)
  let duoUnits = await unitsOf('新双人动作卡')
  const pos = duoUnits[0]?.positive ?? ''
  check(
    '动作卡按「主角色局部姿态 → 动作卡基础 + 子体位 → 第二角色」组合，每张的素材来源可查',
    duoUnits.length === 10 && duoUnits.every((u) => /action_a,\s*action_c/.test(u.positive) && /missionary,\s*legs up/.test(u.positive) && u.meta.action2 === '动作B' && u.meta.picks.some((p) => p.name === '新状态' && !p.random)) && pos.indexOf('action_a') < pos.indexOf('missionary') && pos.indexOf('missionary') < pos.indexOf('1girl, char_b') && pos.indexOf('1girl, char_b') < pos.indexOf('action_b'),
    pos,
  )
  // 高级组合设置：只对当前任务生效，可恢复动作卡默认设置
  await win.locator('[data-testid=card-detail]').getByText('高级组合设置', { exact: true }).click()
  await win.locator('[data-testid=card-advanced] [data-testid=pool-pose2] button').first().click()
  await win.locator('[data-testid=card-advanced] [data-testid=pool-pose2]').getByRole('button', { name: '移除 动作B' }).click()
  await win.waitForTimeout(1300)
  duoUnits = await unitsOf('新双人动作卡')
  const libCard = await win.evaluate(async () => (await window.api['library.load']()).templates.find((t) => t.name === '新双人动作卡')?.card)
  check('高级组合设置只对当前任务生效：移除第二角色局部姿态后不再加入，素材库中的动作卡不变', duoUnits.length === 10 && duoUnits.every((u) => !u.meta.action2) && libCard?.pools?.pose2?.random?.length === 1 && (await duoCard.innerText()).includes('已调整组合'), JSON.stringify(libCard?.pools?.pose2))
  await shot('09f-plan-card-advanced')
  await win.locator('[data-testid=card-restore]').click()
  await win.waitForTimeout(1300)
  duoUnits = await unitsOf('新双人动作卡')
  check('恢复动作卡默认设置', duoUnits.every((u) => u.meta.action2 === '动作B') && !(await duoCard.innerText()).includes('已调整组合'))
  // ---- 镜头视角：在素材库管理（新建、编辑、优先级、搜索、删除），动作中多选，每张图片抽 1 个
  await nav('素材库')
  await win.locator('[data-testid=lib-tab-camera]').click()
  await win.waitForTimeout(300)
  check('镜头视角是素材库的独立分类', (await win.locator('[data-testid=lib-tab-camera]').innerText()).includes('镜头视角') && (await win.locator('main button', { hasText: '新建镜头' }).count()) === 1)
  const camCount0 = await win.locator('[data-testid=template-card]').count()
  const newLibCamera = async (name, positive, negative, priority) => {
    await win.locator('main button', { hasText: '新建镜头' }).click()
    await win.waitForTimeout(400)
    const ed = win.locator('[data-testid=template-editor]')
    await ed.locator('input').first().fill(name)
    await ed.locator('textarea').nth(0).fill(positive)
    if (negative) await ed.locator('textarea').nth(1).fill(negative)
    if (priority) await ed.locator(`[data-testid=priority-${priority}]`).click()
    await win.waitForTimeout(900)
  }
  await newLibCamera('正面镜头', 'from front', 'from behind', 'low')
  await newLibCamera('侧面镜头', 'from side', '', 'high')
  await newLibCamera('仰视镜头', 'from below', '', '')
  await newLibCamera('待删除镜头', 'to_delete', '', '')
  await shot('09g-library-camera')
  const camsSaved = await win.evaluate(async () => (await window.api['library.load']()).templates.filter((t) => t.kind === 'camera'))
  const camFront = camsSaved.find((t) => t.name === '正面镜头')
  check('新建镜头：名称、正负 Prompt、优先级写入素材', camFront?.positive === 'from front' && camFront.negative === 'from behind' && camFront.priority === 'low' && camsSaved.find((t) => t.name === '侧面镜头')?.priority === 'high', JSON.stringify(camFront))
  check('镜头保存在 Vault 的 cameras 目录（Markdown）', readdirSync(join(dataDir, 'vault', 'prompts', 'cameras')).some((f) => f.includes('正面镜头') && f.endsWith('.md')))
  const camCardNames = async () => win.locator('[data-testid=template-card]').evaluateAll((els) => els.map((e) => e.innerText.split('\n')[0]))
  const camOrder = await camCardNames()
  check('镜头按优先级排列（高 → 普通 → 低）', camOrder[0] === '侧面镜头' && camOrder[camOrder.length - 1] === '正面镜头', camOrder.join(','))
  await win.locator('main input[placeholder^="搜索名称"]').fill('仰视')
  await win.waitForTimeout(200)
  check('搜索镜头', (await win.locator('[data-testid=template-card]').count()) === 1)
  await win.locator('main input[placeholder^="搜索名称"]').fill('')
  await win.waitForTimeout(200)
  await win.locator('[data-testid=template-editor]').getByRole('button', { name: '删除' }).click()
  await win.locator('[role=dialog]').getByRole('button', { name: '删除' }).click()
  await win.waitForTimeout(500)
  check('删除镜头', (await win.locator('[data-testid=template-card]').count()) === camCount0 + 3)

  await nav('套图任务')
  await win.waitForTimeout(300)
  await duoCard.click()
  await win.waitForTimeout(300)
  const camField = win.locator('[data-testid=camera-field]')
  const camTags = () => camField.locator('[data-testid=camera-tag]').allInnerTexts()
  check('动作页不平铺镜头库：未选择时只有一个入口', (await camTags()).length === 0 && (await camField.locator('[data-testid=pick-camera]').innerText()).includes('不指定'))
  await camField.locator('[data-testid=pick-camera]').click()
  const camPicker = win.locator('[data-testid=material-picker]')
  const camList = camPicker.locator('[data-testid=picker-list] button')
  const pickerNames = await camList.evaluateAll((els) => els.map((e) => e.innerText.split('\n')[0]))
  check('镜头选择器按优先级排列', pickerNames[0] === '侧面镜头' && pickerNames[pickerNames.length - 1] === '正面镜头', pickerNames.join(','))
  await camPicker.locator('input').first().fill('仰视')
  await win.waitForTimeout(150)
  check('镜头选择器可以搜索', (await camList.count()) === 1)
  await camList.first().click()
  await camPicker.locator('input').first().fill('')
  await camList.filter({ hasText: '正面镜头' }).click()
  await camList.filter({ hasText: '侧面镜头' }).click()
  await camPicker.locator('[data-testid=picker-done]').click()
  await win.waitForTimeout(1300)
  await shot('09h-plan-camera-multi')
  check('镜头多选：动作详情显示标签与说明', (await camTags()).join() === '仰视镜头,正面镜头,侧面镜头' && (await win.locator('[data-testid=camera-hint]').innerText()).includes('3 个镜头'), (await camTags()).join())
  check('动作卡片显示所选镜头', (await duoCard.locator('[data-testid=camera-badge]').innerText()).includes('正面镜头'), await duoCard.locator('[data-testid=camera-badge]').innerText())
  const camSaved = () => win.evaluate(async () => { const lib = await window.api['library.load'](); const t = lib.tasks.find((x) => x.id === (lib.settings.last_task_id ?? lib.tasks[0].id)) ?? lib.tasks[0]; const full = await window.api['tasks.get'](t.id); const it = full.data.items.find((i) => i.card_id); return { ids: it.camera_ids, id: it.camera_id, names: (it.camera_ids ?? []).map((x) => lib.templates.find((m) => m.id === x)?.name) } })
  const camOfUnits = async () => (await unitsOf('新双人动作卡')).map((u) => u.meta.camera)
  const CAM_TEXT = { 正面镜头: 'from front', 侧面镜头: 'from side', 仰视镜头: 'from below' }
  let camUnits = await unitsOf('新双人动作卡')
  check('每张图片恰好抽到 1 个镜头，Prompt 与记录一致', camUnits.length === 10 && camUnits.every((u) => { const hit = Object.values(CAM_TEXT).filter((p) => u.positive.includes(p)); return hit.length === 1 && hit[0] === CAM_TEXT[u.meta.camera] }), (await camOfUnits()).join(','))
  check('多张图片各自抽取镜头', new Set(await camOfUnits()).size >= 2, (await camOfUnits()).join(','))
  check('同一计划重复展开，镜头结果不变', (await camOfUnits()).join() === camUnits.map((u) => u.meta.camera).join())
  check('任务只保存镜头 ID（camera_id 同步为第一个）', (await camSaved()).names.join() === '仰视镜头,正面镜头,侧面镜头' && (await camSaved()).id === (await camSaved()).ids[0], JSON.stringify(await camSaved()))
  await camField.getByRole('button', { name: '移除镜头 仰视镜头' }).click()
  await win.waitForTimeout(1300)
  check('取消单个镜头', (await camTags()).join() === '正面镜头,侧面镜头' && (await camOfUnits()).every((c) => c === '正面镜头' || c === '侧面镜头'), (await camTags()).join())
  await camField.getByRole('button', { name: '移除镜头 侧面镜头' }).click()
  await win.waitForTimeout(1300)
  camUnits = await unitsOf('新双人动作卡')
  check('只选 1 个镜头：每张图片都使用它，负面 Prompt 同样生效', camUnits.every((u) => u.meta.camera === '正面镜头' && u.positive.includes('from front') && u.negative.includes('from behind')) && (await win.locator('[data-testid=camera-hint]').innerText()).includes('都使用'))
  await camField.locator('[data-testid=camera-clear]').click()
  await win.waitForTimeout(1300)
  camUnits = await unitsOf('新双人动作卡')
  check('清空镜头：没有镜头 Prompt', (await camTags()).length === 0 && camUnits.every((u) => !u.meta.camera && !u.positive.includes('from front')) && (await camSaved()).id === null)
  await win.locator('[data-testid=card-detail]').getByRole('button', { name: '关闭' }).click()
  await win.waitForTimeout(200)
  await nav('角色库')
  await shot('10-characters')
  await themeCheck('角色库')
  check('角色页面为连续布局（无标签页，不显示角色标签 / 负面输入）', (await win.locator('[role=tab]').count()) === 0 && (await win.getByText('角色标签', { exact: true }).count()) === 0)
  await win.locator('[data-testid=outfit-row] button', { hasText: 'A服装1' }).click()
  await win.waitForTimeout(300)
  check('点击服装在当前页面展开编辑（只有名称与 Positive）', (await win.getByPlaceholder('服装 / 穿着状态 Prompt（原样保存）').count()) === 1 && (await win.getByPlaceholder('可留空').count()) === 0)
  await shot('11-character-outfits')
  // 角色文件夹（与工作区 prompts/characters 的真实目录一致）与右键菜单
  const charDir = join(dataDir, 'vault', 'prompts', 'characters')
  await win.getByRole('button', { name: '新建文件夹' }).click()
  await win.locator('[data-testid=name-input]').fill('主角')
  await win.getByRole('button', { name: '创建' }).click()
  await win.waitForTimeout(400)
  check('新建角色文件夹：列表与磁盘目录一致', (await win.locator('[data-testid=folder-row]', { hasText: '主角' }).count()) === 1 && existsSync(join(charDir, '主角')))
  await win.locator('[data-testid=char-row]', { hasText: '角色B' }).click({ button: 'right' })
  await win.getByRole('menuitem', { name: '移动到…' }).click()
  await win.locator('[data-testid=move-targets] button', { hasText: '主角' }).click()
  await win.waitForTimeout(500)
  check('右键移动角色到文件夹：文件移入对应目录', existsSync(join(charDir, '主角', '角色B.md')) && !existsSync(join(charDir, '角色B.md')))
  await win.locator('[data-testid=char-row]', { hasText: '角色B' }).click({ button: 'right' })
  await win.getByRole('menuitem', { name: '重命名' }).click()
  await win.locator('[data-testid=name-input]').fill('角色B2')
  await win.getByRole('button', { name: '重命名', exact: true }).click()
  await win.waitForTimeout(600)
  const outfitFiles = readdirSync(join(dataDir, 'vault', 'prompts', 'outfits'))
  check('右键重命名角色：显示名称、角色文件与服装文件名同步', (await win.locator('[data-testid=char-row]', { hasText: '角色B2' }).count()) === 1 && existsSync(join(charDir, '主角', '角色B2.md')) && outfitFiles.includes('角色B2 - B服装1.md'), outfitFiles.join(','))
  const second = await win.evaluate(async () => {
    const lib = await window.api['library.load']()
    const p = await window.api['plan.forTask'](lib.settings.last_task_id ?? lib.tasks[0].id)
    return { errors: p.errors, name: p.units.find((u) => u.meta.character2)?.meta.character2 }
  })
  check('移动、重命名后任务中的第二角色关联不变', second.name === '角色B2' && !second.errors.some((e) => e.includes('第二角色')), JSON.stringify(second))
  await win.locator('[data-testid=folder-row]', { hasText: '主角' }).click({ button: 'right' })
  check('非空文件夹不能删除', (await win.getByRole('menuitem', { name: '删除（仅空文件夹）' }).getAttribute('data-disabled')) !== null)
  await shot('11b-character-folders')
  await win.keyboard.press('Escape')
  mkdirSync(join(charDir, '外部整理'))
  await win.evaluate(() => window.dispatchEvent(new Event('focus')))
  await win.waitForTimeout(600)
  check('在资源管理器中新建的文件夹回到窗口后显示', (await win.locator('[data-testid=folder-row]', { hasText: '外部整理' }).count()) === 1)
  // 角色列表头像为 3:4
  const av = await win.locator('[data-testid=char-row]').first().locator('> div').first().boundingBox()
  check('角色列表头像为 3:4 竖向', !!av && Math.abs(av.width / av.height - 0.75) < 0.03, av ? `${av.width}×${av.height}` : '')
  // 拖放：把角色A拖进「外部整理」，再拖回根目录（真实移动 Markdown 文件）
  const dragTo = async (from, to) => {
    const a = await from.boundingBox()
    await win.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
    await win.mouse.down()
    for (let i = 1; i <= 8; i++) {
      await win.mouse.move(a.x + a.width / 2 + i, a.y + a.height / 2 + i)
      await win.waitForTimeout(16)
    }
    const b = await to().boundingBox()
    for (let i = 1; i <= 15; i++) {
      await win.mouse.move(a.x + a.width / 2 + ((b.x + b.width / 2 - a.x - a.width / 2) * i) / 15, a.y + a.height / 2 + ((b.y + b.height / 2 - a.y - a.height / 2) * i) / 15)
      await win.waitForTimeout(16)
    }
    await win.waitForTimeout(150)
    await win.mouse.up()
    await win.waitForTimeout(700)
  }
  await dragTo(win.locator('[data-testid=char-row]', { hasText: '角色A' }), () => win.locator('[data-testid=folder-row]', { hasText: '外部整理' }))
  check('拖动角色到文件夹：文件移入对应目录', existsSync(join(charDir, '外部整理', '角色A.md')) && !existsSync(join(charDir, '角色A.md')))
  await dragTo(win.locator('[data-testid=char-row]', { hasText: '角色A' }), () => win.locator('[data-testid=root-drop]'))
  check('拖回根目录', existsSync(join(charDir, '角色A.md')) && !existsSync(join(charDir, '外部整理', '角色A.md')))
  const linkCheck = await win.evaluate(async () => {
    const lib = await window.api['library.load']()
    const a = lib.characters.find((c) => c.name === '角色A')
    return { outfits: lib.outfits.filter((o) => o.character_id === a.id).length, loras: a.loras.length }
  })
  check('拖放后服装与 LoRA 关联不变', linkCheck.outfits === 5 && linkCheck.loras === 1, JSON.stringify(linkCheck))

  // 套图任务：全局 Prompt 在顶部，工作流在页面中选择和导入
  await nav('套图任务')
  await win.waitForTimeout(300)
  const planBefore = await win.evaluate(async () => {
    const lib = await window.api['library.load']()
    return (await window.api['plan.forTask'](lib.settings.last_task_id ?? lib.tasks[0].id)).units.map((u) => u.positive)
  })
  check('页面顶部显示全局 Prompt', (await win.locator('button', { hasText: '全局 Prompt' }).filter({ hasText: '画质' }).count()) === 1)
  await win.locator('button', { hasText: '全局 Prompt' }).click()
  await win.locator('[role=dialog] button', { hasText: '画质' }).click()
  await win.waitForTimeout(800)
  const planAfter = await win.evaluate(async () => {
    const lib = await window.api['library.load']()
    return (await window.api['plan.forTask'](lib.settings.last_task_id ?? lib.tasks[0].id)).units.map((u) => u.positive)
  })
  check('通过顶部重新选择同一全局 Prompt，生成结果不变', JSON.stringify(planBefore) === JSON.stringify(planAfter))
  const wfFile = join(dataDir, 'imported-api.json')
  const apiJson = await win.evaluate(async () => {
    const lib = await window.api['library.load']()
    return (await window.api['workflows.get'](lib.workflows[0].id)).api_json
  })
  writeFileSync(wfFile, JSON.stringify(apiJson))
  await app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] })
  }, wfFile)
  await win.locator('[data-testid=workflow-menu]').click()
  await shot('19a-workflow-menu')
  await win.getByRole('button', { name: '导入 API 工作流' }).click()
  await win.waitForTimeout(800)
  check('在任务页导入工作流后自动设为当前任务的工作流，并提示配置映射', (await win.locator('[data-testid=workflow-menu]').innerText()).includes('imported-api') && (await win.locator('[data-testid=workflow-menu]').innerText()).includes('尚未配置节点映射'), await win.locator('[data-testid=workflow-menu]').innerText())
  await win.locator('[data-testid=workflow-menu]').click()
  await win.getByRole('button', { name: '编辑节点映射' }).click()
  await win.waitForTimeout(500)
  check('从任务页进入该工作流的节点映射编辑', (await win.getByText('节点输入映射').count()) > 0 && (await win.locator('main').innerText()).includes('imported-api'))

  // 真实工作流样本：ImpactWildcardProcessor + 字符串拼接 / 正则 + Lora Loader (LoraManager) + 两次采样
  const twoPass = join(dataDir, 'workflow-two-pass.json')
  copyFileSync(join(root, 'test', 'fixtures', 'workflow-two-pass.json'), twoPass)
  await app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] })
  }, twoPass)
  await nav('套图任务')
  await win.locator('[data-testid=workflow-menu]').click()
  await win.getByRole('button', { name: '导入 API 工作流' }).click()
  await win.waitForTimeout(800)
  await win.locator('[data-testid=workflow-menu]').click()
  await win.getByRole('button', { name: '编辑节点映射' }).click()
  await win.waitForTimeout(600)
  await win.getByRole('button', { name: '自动识别' }).click()
  await win.waitForTimeout(400)
  const rowState = (g, node) => win.locator(`[data-testid=suggest-row][data-group=${g}][data-node="${node}"] [role=checkbox]`).first().getAttribute("data-state")
  await shot('19d-auto-detect')
  check('自动识别：正负 Prompt（#3 / #4）默认勾选，#32 主 Seed 勾选、#107 独立 Seed 不勾选，#121 输出勾选',
    (await rowState('prompt', '3')) === 'checked' && (await rowState('prompt', '4')) === 'checked' && (await rowState('seed', '32')) === 'checked' && (await rowState('seed', '107')) === 'unchecked' && (await rowState('output', '121')) === 'checked')
  const notesText = await win.locator('[data-testid=suggest-notes]').innerText()
  check('自动识别：多 LoRA Loader #5 由任务直接控制（不生成映射建议），并提示触发词节点 #34', (await win.locator('[data-testid=suggest-row][data-group=lora]').count()) === 0 && notesText.includes('#5') && notesText.includes('无需映射') && notesText.includes('#34'))
  await win.getByRole('button', { name: '应用勾选项' }).click()
  await win.waitForTimeout(800)
  check('应用后映射有效', (await win.getByText('映射有效').count()) === 1, (await win.locator('main').innerText()).slice(-300).replace(/\n/g, ' | '))
  await nav('套图任务')
  await win.waitForTimeout(500)
  const wfCards = win.locator('[data-testid=lora-card][data-prefix^="wf:5:"]')
  const stackNow = async () => {
    const p = await win.evaluate(async () => {
      const lib = await window.api['library.load']()
      return window.api['plan.forTask'](lib.settings.last_task_id ?? lib.tasks[0].id)
    })
    return p.units.find((u) => u.section === 'pose').inputs.find((x) => x.node === '5' && x.input === 'loras')?.value.__value__ ?? []
  }
  // 选择工作流后自动读取其中的 LoRA（包括停用条目），主角色 LoRA 不在列表中 → 追加到 #5
  const mainLora = win.locator('[data-testid=lora-card][data-prefix=lora1]')
  check('自动读取工作流 #5 中的 8 个 LoRA（含停用条目），只有一组（三个采样阶段共用）', (await wfCards.count()) === 8 && (await win.locator('[data-testid=lora-group]').count()) === 1 && (await win.locator('[data-testid=lora-card][data-prefix="wf:5:6"]').getAttribute('data-enabled')) === null && (await win.locator('[data-testid=lora-group]').getAttribute('title')).includes('46、103、107') && !(await win.locator('[data-testid=lora-panel]').innerText()).includes('#5'))
  check('主角色 LoRA 不在工作流列表中：自动追加到 #5（不覆盖画风 LoRA）', (await mainLora.innerText()).includes('追加到工作流 LoRA'), (await mainLora.innerText()).replace(/\n/g, ' | '))
  const s1 = await stackNow()
  check('最终 #5 列表 = 工作流原有 8 个 + 角色 LoRA', s1.length === 9 && s1[8].name === 'charA' && s1.filter((e) => e.active).length === 8, JSON.stringify(s1.map((e) => [e.name, e.active])))
  await win.locator('[data-testid=lora-card][data-prefix="wf:5:0"]').getByRole('button', { name: '停用' }).click()
  await win.waitForTimeout(700)
  await win.locator('[data-testid=lora-card][data-prefix="wf:5:1"]').getByRole('button', { name: '从本任务移除' }).click()
  await win.waitForTimeout(700)
  await win.locator('[data-testid=lora-card][data-prefix="wf:5:7"]').getByLabel('权重', { exact: true }).fill('0.6')
  await win.locator('[data-testid=lora-card][data-prefix="wf:5:7"]').getByLabel('权重', { exact: true }).press('Enter')
  await win.waitForTimeout(900)
  const s2 = await stackNow()
  const by = (l, n) => l.find((e) => e.name === n)
  check('停用 / 移除 / 调权重真实写入 #5：停用的 active=false，移除的不在列表中，权重已更新', by(s2, 'BlueArchiveStyle_illus_1884029')?.active === false && !by(s2, 'Lineweight_illus_2238270') && Number(by(s2, 'Inui Sajuna_illus_1115376')?.strength) === 0.6 && JSON.stringify(by(s2, 'il_contrast_slider_d1')) === JSON.stringify(by(s1, 'il_contrast_slider_d1')), JSON.stringify(s2.map((e) => [e.name, e.active, e.strength])))
  const wfFile0 = await win.evaluate(async () => (await window.api['workflows.get']((await window.api['library.load']()).workflows.find((w) => w.name === 'workflow-two-pass').id)).api_json['5'].inputs.loras.__value__.length)
  check('原始工作流不被修改', wfFile0 === 8)
  await shot('19e-workflow-loras')
  // 最终工作流 JSON：与执行时使用相同的构建逻辑，并标明是第几张
  await win.locator('button', { hasText: '预览计划' }).click()
  await win.waitForSelector('text=生成计划预览')
  await win.waitForTimeout(400)
  await win.locator('[data-testid=open-final-workflow]').click()
  await win.waitForTimeout(800)
  const finalText = await win.locator('[data-testid=final-workflow-json]').innerText()
  const finalJson = JSON.parse(finalText)
  const finalList = finalJson['5'].inputs.loras.__value__
  check('最终工作流 JSON：标明第几张，#5 列表与任务配置一致，Prompt 已写入 #3', (await win.locator('[data-testid=final-workflow]').innerText()).includes('第 1 / ') && JSON.stringify(finalList) === JSON.stringify(s2) && finalJson['3'].inputs.populated_text.includes('masterpiece'), finalText.slice(0, 120))
  await shot('19f-final-workflow')
  await win.keyboard.press('Escape')
  await win.waitForTimeout(300)
  await win.keyboard.press('Escape')
  await win.waitForTimeout(300)
  await win.locator('[data-testid=reset-lora-config]').click()
  await win.waitForTimeout(600)
  check('恢复工作流默认后回到 8 个原有条目', (await wfCards.count()) === 8 && (await win.locator('[data-testid=reset-lora-config]').count()) === 0)
  await win.locator('[data-testid=workflow-menu]').click()
  await win.locator('[data-radix-popper-content-wrapper] button', { hasText: '测试工作流' }).last().click()
  await win.waitForTimeout(300)
  // LoRA 配置：角色默认 LoRA 显示在任务中，可调整权重；绑定的 Loader 可在卡片上查看和修改
  const planNow = () => win.evaluate(async () => {
    const lib = await window.api['library.load']()
    return window.api['plan.forTask'](lib.settings.last_task_id ?? lib.tasks[0].id)
  })
  const mainCard = win.locator('[data-testid=lora-card][data-prefix=lora1]')
  check('LoRA 卡片：本地文件名为标题、来源、绑定数量；只有一个权重输入', (await mainCard.locator('[data-testid=lora-title]').innerText()) === 'charA' && (await mainCard.innerText()).includes('主角色') && (await mainCard.getAttribute('data-bound')) === '1' && (await mainCard.locator('input[type=number]').count()) === 1 && (await mainCard.getByText('Clip').count()) === 0, (await mainCard.innerText()).replace(/\n/g, ' | '))
  await mainCard.getByLabel('权重', { exact: true }).fill('0.55')
  await mainCard.getByLabel('权重', { exact: true }).press('Enter')
  await win.waitForTimeout(1800)
  const p1 = await planNow()
  const st = p1.units.find((u) => u.section === 'pose').inputs.find((x) => x.source === 'lora1_strength' && x.input === 'strength_model')
  check('在任务中调整角色 LoRA 权重：写入 Loader 的 strength_model', st?.value === 0.55 && (await mainCard.innerText()).includes('已调整'), JSON.stringify(st))
  await shot('19b-lora-panel')
  // 旧工作流：主角色 LoRA 由高级映射（lora1 → #10）控制，卡片上显示绑定
  const wfBefore = await win.evaluate(async () => {
    const lib = await window.api['library.load']()
    return window.api['workflows.get'](lib.workflows.find((w) => w.name === '测试工作流').id)
  })
  await mainCard.locator('[data-testid=lora-binding]').click()
  await shot('19c-lora-binding')
  await win.locator('[data-testid=lora-loaders] button').first().click()
  await win.waitForTimeout(900)
  await win.keyboard.press('Escape')
  const p2 = await planNow()
  // 解除高级映射后 #10 交给任务的 LoRA 配置：#10 加载的正是角色的 charA，自动关联该条目（不重复、不报错）
  const n10 = p2.units.find((u) => u.section === 'pose').inputs.filter((x) => x.node === '10')
  check('解除高级映射后，任务配置自动关联 #10 中同名的角色 LoRA', !p2.errors.some((e) => e.includes('LoRA')) && (await mainCard.innerText()).includes('已在工作流 LoRA 中'), `${(await mainCard.innerText()).replace(/\n/g, ' | ')} ${JSON.stringify(n10)}`)
  await win.evaluate((w) => window.api['workflows.save']({ id: w.id, mapping: w.mapping }), wfBefore)
  await win.evaluate(() => window.dispatchEvent(new Event('focus')))
  await win.locator('nav button', { hasText: '素材库' }).click()
  await nav('套图任务')
  await win.waitForTimeout(800)
  const p3 = await planNow()
  check('恢复高级映射后由映射控制，计划正常', !p3.errors.some((e) => e.includes('LoRA')) && (await mainCard.getAttribute('data-bound')) === '1', p3.errors.join(' / '))
  // 启停：卡片右侧的电源图标；停用后卡片变暗，Loader 强度写 0
  await mainCard.getByRole('button', { name: '停用' }).click()
  await win.waitForTimeout(900)
  const p4 = await planNow()
  const off = p4.units.find((u) => u.section === 'pose').inputs.find((x) => x.source === 'lora1_strength' && x.input === 'strength_model')
  check('停用角色 LoRA：卡片变暗，Loader 强度写 0', (await mainCard.getAttribute('data-enabled')) === null && off?.value === 0, JSON.stringify(off))
  await mainCard.getByRole('button', { name: '启用' }).click()
  await win.waitForTimeout(500)
  await mainCard.getByRole('button', { name: '恢复角色库默认' }).click()
  await win.waitForTimeout(600)
  await nav('剧情库')
  await win.locator('main button', { hasText: '剧情1' }).first().click()
  await shot('12-stories')
  await nav('设置')
  await shot('13-settings')
  await themeCheck('设置')
  await win.locator('button', { hasText: '工作流管理' }).click()
  await shot('14-workflow-mapping')
  await win.locator('button', { hasText: '高级 Prompt 设置' }).click()
  await shot('15-compose')

  // 小窗口布局
  await setSize(1180, 720)
  await nav('套图任务')
  // 小窗口中详情为浮动面板，盖住卡片右侧；点击卡片左侧切换
  await cards.nth(1).click({ position: { x: 120, y: 20 } })
  await shot('16-plan-small')
  check('小窗口：浮动详情面板不超出窗口', await win.locator('[data-testid=detail-title]').evaluate((el) => { const r = el.closest('.rounded-2xl').getBoundingClientRect(); return r.right <= window.innerWidth && r.left >= 0 }))
  await nav('执行队列')
  await shot('17-queue-small')
  await setSize(1920, 1040)
  await nav('套图任务')
  await win.locator('button', { hasText: '任务设置' }).click()
  await shot('18-task-settings')
  await themeCheck('任务设置弹窗')
  check('任务设置中不再提供「男性基础描述」（只为仍在使用的旧任务显示）', (await win.locator('[role=dialog]').getByText('男性基础描述').count()) === 0 || (await win.locator('[role=dialog]').getByText('男性基础描述（旧版）').count()) === 1)
  await win.keyboard.press('Escape')
  await win.locator('button', { hasText: '剧情' }).filter({ hasText: '剧情1' }).first().click()
  await shot('19-story-picker')
  await win.keyboard.press('Escape')

  await win.waitForFunction(() => !document.querySelector('[role=dialog]'), null, { timeout: 5000 })
  await win.waitForTimeout(300)
  // 侧边栏分组：靠上素材与资料，靠下生成与系统
  const navOrder = await win.locator('nav button').allInnerTexts()
  check('侧边栏分为上下两组', navOrder.slice(0, 9).join(',') === '素材库,Prompt 提取,LoRA 管理,角色库,剧情库,套图任务,执行队列,运行记录,设置', navOrder.join(','))
  // 任务名称旁的重命名 / 复制 / 删除按钮
  check('任务名称旁直接显示重命名、复制、删除按钮', (await win.getByRole('button', { name: '重命名', exact: true }).count()) === 1 && (await win.getByRole('button', { name: '复制任务', exact: true }).count()) === 1 && (await win.getByRole('button', { name: '删除任务', exact: true }).count()) === 1, [await win.getByRole('button', { name: '重命名', exact: true }).count(), await win.getByRole('button', { name: '复制任务', exact: true }).count(), await win.getByRole('button', { name: '删除任务', exact: true }).count(), await win.locator('[aria-label=重命名]').count()].join(','))
  // LoRA 权重输入框：宽度足够、隐藏原生上下箭头
  const wInput = win.locator('[data-testid=lora-card] input[type=number]').first()
  const wStyle = await wInput.evaluate((el) => ({ w: el.getBoundingClientRect().width, a: getComputedStyle(el).appearance, align: getComputedStyle(el).textAlign }))
  check('权重输入框加宽、隐藏 spinner、数字右对齐', wStyle.w >= 58 && wStyle.a === 'textfield' && wStyle.align === 'right', JSON.stringify(wStyle))
  // 清除主角色：任务照常保存，但不能入队；再选回来
  const curTask = () => win.evaluate(async () => { const lib = await window.api['library.load'](); return window.api['tasks.get'](lib.settings.last_task_id ?? lib.tasks[0].id) })
  await win.locator('button', { hasText: '主角色' }).first().click()
  await win.locator('[role=dialog]').getByRole('button', { name: '清除选择' }).click()
  await win.waitForTimeout(1200)
  const cleared = await curTask()
  const pc = await planNow()
  check('清除主角色：任务已保存为未选择状态，但计划提示必须选择角色（不能入队）', cleared.data.character_id === null && pc.errors.some((e) => e.includes('未选择角色')) && (await win.locator('button', { hasText: '主角色' }).first().innerText()).includes('选择主角色'))
  await win.locator('button', { hasText: '主角色' }).first().click()
  await win.locator('[role=dialog] button', { hasText: '角色A' }).first().click()
  await win.waitForTimeout(1000)
  check('重新选择主角色后恢复', (await curTask()).data.character_id !== null && !(await planNow()).errors.some((e) => e.includes('未选择角色')))
  // 清除工作流：恢复未选择状态（不删除工作流）；再选回来
  await win.locator('[data-testid=workflow-menu]').click()
  await win.locator('[data-testid=workflow-clear]').click()
  await win.waitForTimeout(1200)
  const noWf = await planNow()
  check('清除工作流：任务保存为未选择工作流，工作流本身保留', (await curTask()).data.workflow_none === true && !noWf.workflow && (await win.locator('[data-testid=workflow-menu]').innerText()).includes('选择工作流') && (await win.evaluate(async () => (await window.api['library.load']()).workflows.length)) >= 2)
  await win.locator('[data-testid=workflow-menu]').click()
  await win.locator('[data-radix-popper-content-wrapper] button', { hasText: '测试工作流' }).last().click()
  await win.waitForTimeout(1000)
  check('重新选择工作流后恢复', (await planNow()).workflow?.name === '测试工作流')
  // 任务输出：文件名前缀展开 %date:…% 并写入工作流的输出前缀
  await win.locator('button', { hasText: '任务设置' }).click()
  await win.getByPlaceholder('留空则使用工作流映射中的模板，例如 %date:yyyy-MM-dd%/image').fill('%date:yyyy-MM-dd%/image')
  await win.waitForTimeout(1200)
  const d0 = new Date()
  const ymd = `${d0.getFullYear()}-${String(d0.getMonth() + 1).padStart(2, '0')}-${String(d0.getDate()).padStart(2, '0')}`
  await shot('20-task-output')
  check('任务设置显示文件名前缀示例（日期已展开）', (await win.locator('[data-testid=prefix-preview]').innerText()).includes(`${ymd}/image_00001_.png`))
  await win.keyboard.press('Escape')
  const pp = await planNow()
  const pfx = pp.units[0].inputs.find((x) => x.source === 'filename_prefix')
  check('任务的文件名前缀写入工作流的 filename_prefix（日期已展开），输出目录随计划冻结', pfx?.value === `${ymd}/image` && pp.units[0].meta.output_dir === join(dataDir, 'vault', 'output'), JSON.stringify([pfx, pp.units[0].meta.output_dir]))

  // 设置页分组 + 新任务默认值（只作用于新建任务）
  const oldTask = await curTask()
  await nav('设置')
  const setText = await win.locator('main').innerText()
  const order = ['常用', '常规', '生成默认值', '工作流管理', '高级', '高级 Prompt 设置', '运行与恢复', '数据与维护'].map((t) => setText.indexOf(t))
  check('设置页分为常用 / 高级两组，顺序正确', order.every((x, i) => x >= 0 && (i === 0 || x > order[i - 1])), order.join(','))
  await win.locator('main button', { hasText: '生成默认值' }).click()
  const defBox = win.locator('[data-testid=settings-defaults]')
  await defBox.getByPlaceholder('留空则使用工作流映射中的模板，例如 %date:yyyy-MM-dd%/image').fill('def/%date:yyyyMMdd%')
  await win.keyboard.press('Tab')
  await win.evaluate(() => window.api['settings.set']('default_item_count', 15))
  await win.waitForTimeout(600)
  await shot('21-settings-defaults')
  await themeCheck('生成默认值')
  await win.locator('main button', { hasText: '数据与维护' }).click()
  await win.getByText('立即备份数据库').waitFor({ timeout: 5000 }).catch(() => {})
  await shot('22-settings-data')
  // 关于与更新：无 Release、已是最新版、有新版本、请求失败
  const appVersion = await app.evaluate(({ app }) => app.getVersion())
  check('关于与更新显示当前版本', (await win.locator('[data-testid=update-card]').innerText()).includes(`ComfyEngi v${appVersion}`), appVersion)
  const checkUpdate = async () => {
    await win.locator('[data-testid=update-card] button', { hasText: '检查更新' }).click()
    await win.locator('[data-testid=update-result]').waitFor()
    await win.waitForFunction(() => !document.querySelector('[data-testid=update-card] button')?.disabled)
    const el = win.locator('[data-testid=update-result]')
    return { kind: await el.getAttribute('data-kind'), text: await el.innerText() }
  }
  let u = await checkUpdate()
  check('没有任何 Release：明确提示，不显示为已是最新版', u.kind === 'no-release' && !u.text.includes('最新版') && u.text.includes('还没有发布'), u.text)
  releaseReply = [200, { tag_name: `v${appVersion}`, html_url: 'https://github.com/Ngyama/ComfyEngi/releases/tag/v' + appVersion }]
  u = await checkUpdate()
  check('与最新 Release 相同：当前已是最新版', u.kind === 'latest' && u.text.includes('当前已是最新版'), u.text)
  releaseReply = [200, { tag_name: 'v99.1.0', name: 'v99.1.0', html_url: 'https://github.com/Ngyama/ComfyEngi/releases/tag/v99.1.0', body: '## 更新内容\n- 修复若干问题', published_at: '2026-10-20T00:00:00Z' }]
  u = await checkUpdate()
  await shot('23-update-available')
  check('存在更高版本：显示新版本号、说明摘要和下载按钮', u.kind === 'available' && u.text.includes('发现新版本 v99.1.0') && u.text.includes('修复若干问题') && u.text.includes('下载更新'), u.text)
  releaseReply = [200, { tag_name: 'nightly' }]
  u = await checkUpdate()
  check('Release 版本号格式异常：提示无法比较', u.kind === 'error' && u.text.includes('nightly'), u.text)
  releaseApi.close()
  releaseApi.closeAllConnections()
  u = await checkUpdate()
  check('网络请求失败：提示检查网络', u.kind === 'error' && u.text.includes('无法连接 GitHub'), u.text)
  check('只能打开本项目的 Release 页面', await win.evaluate(() => window.api['app.openReleasePage']('https://evil.example/x').then(() => false, () => true)))
  check('数据与维护区分数据库备份与完整备份', (await win.locator('main').innerText()).includes('完整备份') && (await win.locator('main').innerText()).includes('立即备份数据库'))
  await nav('套图任务')
  await win.locator('main button', { hasText: oldTask.name }).first().click()
  await win.locator('button', { hasText: '新建套图任务' }).click()
  await win.keyboard.press('Enter')
  await win.waitForTimeout(600)
  await win.locator('button', { hasText: '添加动作' }).first().click()
  await win.locator('[role=dialog] button', { hasText: '状态（旧方式）' }).click()
  await win.locator('[role=dialog] button', { hasText: '睡觉' }).first().click()
  await win.locator('[role=dialog] button', { hasText: '添加 1 个动作' }).click()
  await win.waitForTimeout(1200)
  const fresh = await curTask()
  check('新任务套用默认文件名前缀，新动作套用默认张数（放在竖图）', fresh.id !== oldTask.id && fresh.data.output?.prefix === 'def/%date:yyyyMMdd%' && fresh.data.items.at(-1)?.count === 15 && fresh.data.items.at(-1)?.sizes?.portrait === 15, JSON.stringify([fresh.data.output, fresh.data.items.map((i) => [i.count, i.sizes])]))
  const oldAfter = await win.evaluate((id) => window.api['tasks.get'](id), oldTask.id)
  check('已有任务不受默认值影响', JSON.stringify(oldAfter.data) === JSON.stringify(oldTask.data))

  // 大量素材：300 个状态，在动作卡素材池的选择器中搜索、多选、切换搜索后保留、取消单个、批量添加搜索结果
  await win.evaluate(async () => {
    for (let i = 1; i <= 300; i++) await window.api['templates.save']({ kind: 'act', name: `批量互动${i}`, positive: `bulk_act_${i}, (weight:1.1)` })
  })
  await win.reload()
  await win.locator('nav').waitFor()
  await nav('素材库')
  await win.locator('[data-testid=lib-tab-cards]').click()
  await win.locator('[data-testid=position-row]', { hasText: '新双人动作卡' }).locator('button').nth(1).click()
  await win.waitForTimeout(300)
  const iPool = win.locator('[data-testid=position-detail] [data-testid=pool-interaction]')
  await iPool.locator('button').first().click()
  await win.locator('[data-testid=pool-interaction-random-add]').click()
  const mp = win.locator('[data-testid=material-picker]')
  const list = mp.locator('[data-testid=picker-list]')
  const bulk = await list.locator('button').count()
  const geo = await mp.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const l = el.querySelector('[data-testid=picker-list]')
    const done = el.querySelector('[data-testid=picker-done]').getBoundingClientRect()
    return { top: r.top, bottom: r.bottom, vh: window.innerHeight, scroll: l.scrollHeight > l.clientHeight, doneVisible: done.bottom <= window.innerHeight && done.top >= 0 }
  })
  check('300 个素材：列表可滚动，标题与完成按钮都在窗口内', bulk >= 300 && geo.scroll && geo.top >= 0 && geo.bottom <= geo.vh && geo.doneVisible, JSON.stringify({ bulk, ...geo }))
  await mp.getByPlaceholder(/搜索名称/).fill('批量互动12')
  check('按名称搜索', (await list.locator('button').count()) === 11, String(await list.locator('button').count()))
  await list.locator('button', { hasText: /^批量互动12bulk/ }).click()
  await list.locator('button', { hasText: /^批量互动125bulk/ }).click()
  await mp.getByPlaceholder(/搜索名称/).fill('批量互动250')
  await list.locator('button', { hasText: /^批量互动250bulk/ }).click()
  await mp.getByPlaceholder(/搜索名称/).fill('')
  await shot('24-material-picker')
  const summary = () => mp.locator('[data-testid=picker-selected]').innerText()
  const summaryText = await summary()
  check('切换搜索后已选内容保留', (await summary()).includes('已选 3') && ['批量互动12', '批量互动125', '批量互动250'].every((n) => summaryText.includes(n)), (await summary()).replace(/\n/g, ' '))
  await mp.getByRole('button', { name: '移除 批量互动125' }).click()
  await mp.locator('[data-testid=picker-done]').click()
  await win.waitForTimeout(1200)
  const poolNames = async () => win.evaluate(async () => { const lib = await window.api['library.load'](); const c = lib.templates.find((t) => t.name === '新双人动作卡'); return (c.card.pools.interaction?.random ?? []).map((id) => lib.templates.find((t) => t.id === id)?.name) })
  check('多选结果按点选顺序保存为候选，取消的项不保留', JSON.stringify(await poolNames()) === JSON.stringify(['批量互动12', '批量互动250']), JSON.stringify(await poolNames()))
  await win.locator('[data-testid=pool-interaction-random-add]').click()
  await mp.getByPlaceholder(/搜索名称/).fill('批量互动29')
  await mp.locator('[data-testid=picker-add-all]').click()
  await mp.locator('[data-testid=picker-done]').click()
  await win.waitForTimeout(1200)
  const after = await poolNames()
  check('批量添加搜索结果（追加在原有候选之后）', after.length === 13 && after[0] === '批量互动12' && after[1] === '批量互动250' && after.slice(2).every((n) => n.startsWith('批量互动29')), JSON.stringify(after))
  // 生成设置：在新任务中添加动作卡，多尺寸张数写入计划
  await nav('套图任务')
  await win.locator('button', { hasText: '添加动作' }).first().click()
  await win.locator('[role=dialog] [data-testid=card-tile]', { hasText: '新双人动作卡' }).click()
  await win.locator('[role=dialog] button', { hasText: '添加 1 个动作' }).click()
  await win.waitForTimeout(500)
  await cards.filter({ hasText: '新双人动作卡' }).first().click({ position: { x: 120, y: 20 } })
  await win.getByRole('button', { name: '横图增加 5 张' }).click()
  await win.waitForTimeout(1000)
  const sp = await planNow()
  const mine = sp.units.filter((u) => u.item_label === '新双人动作卡')
  check('多尺寸：计划中每张带宽高（竖图在前、横图在后）', mine.length === 20 && mine[0].width === 1024 && mine[0].height === 1536 && mine.at(-1).width === 1536 && mine.at(-1).height === 1024, mine.map((u) => `${u.width}x${u.height}`).join(','))
  check('正面 Prompt 模块之间空一行，与提交内容一致', mine[0].positive.includes(',\n\n') && mine[0].inputs.find((x) => x.source === 'positive')?.value === mine[0].positive)
  check('同一动作卡的多张图片抽到不同的互动组合', new Set(mine.map((u) => u.positive)).size > 1)
  await win.locator('[data-testid=detail-generate]').getByText('组合与 Prompt 预览', { exact: true }).click()
  await win.waitForTimeout(300)
  check('动作详情中可查看每张的素材来源', (await win.locator('[data-testid=pick-sources]').innerText()).includes('新状态'))
  await shot('25-detail-sizes')

  check('没有渲染进程错误', errors.length === 0, errors.slice(0, 3).join(' / '))
} catch (e) {
  console.error(e)
  await shot('zz-failure').catch(() => {})
  check('脚本执行', false, String(e).slice(0, 300))
} finally {
  await app.close().catch(() => {})
  await mock.shutdown()
}
const welcomeDir = mkdtempSync(join(tmpdir(), 'comfyengi-welcome-'))
const welcomeEnv = {...process.env, COMFYENGI_DATA_DIR:welcomeDir, COMFYENGI_VAULT:'', COMFYENGI_IMPORT_LEGACY:''}
const welcome = exe
 ? await electron.launch({executablePath:resolve(exe),args:[],env:welcomeEnv})
 : await electron.launch({args:[root],cwd:root,env:welcomeEnv})
try {
 const page=await welcome.firstWindow()
 await page.getByText('创建新工作区',{exact:true}).waitFor()
 check('首次启动显示工作区欢迎页',await page.getByText('创建新工作区',{exact:true}).isVisible())
} finally {await welcome.close()}
console.log(`\n截图：${shots}\n数据目录：${dataDir}`)
const failed = results.filter(([ok]) => !ok).length
console.log(failed ? `${failed} 项失败` : '全部通过')
process.exit(failed ? 1 : 0)
