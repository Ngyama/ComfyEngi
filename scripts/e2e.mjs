// 端到端冒烟测试：启动真实的 Electron 应用（已构建的 out/），连接模拟 ComfyUI，
// 通过界面完成「选择角色 → 添加姿态 → 拖动排序 → 配置 → 预览 → 开始生成 → 查看记录」，并截图。
//
// 用法：npm run e2e                                   （测试 out/ 中的构建结果）
//       node scripts/e2e.mjs --exe dist/win-unpacked/ComfyEngi.exe   （测试打包后的程序）
//       可选 --shots <目录> 指定截图输出位置
// 数据使用临时目录（从旧版数据库样本复制，同时验证旧数据迁移），不会触碰真实用户数据。

import { copyFileSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

const env = { ...process.env, COMFYENGI_DATA_DIR: dataDir, COMFYENGI_VAULT: join(dataDir, 'vault'), COMFYENGI_IMPORT_LEGACY: join(dataDir, 'comfyengi.db') }
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
const nav = (label) => win.locator('nav button', { hasText: label }).click()

try {
  await setSize(1920, 1040)
  await win.waitForSelector('text=姿态序列', { timeout: 20000 })
  check('旧数据迁移：自动打开旧版任务', await win.locator('text=旧版任务').first().isVisible())
  check('迁移前已备份', readdirSync(join(dataDir, 'vault/data/backups')).some((f) => f.includes('before-v1-from-v0')))
  const cards = win.locator('[aria-roledescription="sortable"]')
  check('旧任务的 2 个姿态以卡片显示', (await cards.count()) === 2, String(await cards.count()))
  await shot('01-plan')

  // 选择角色
  await win.locator('button', { hasText: '角色' }).filter({ hasText: '角色A' }).first().click()
  await win.locator('[role=dialog] button', { hasText: '角色A' }).first().click()
  // 添加姿态（插入末尾）
  await win.locator('button', { hasText: '添加姿态' }).first().click()
  await win.locator('[role=dialog] button', { hasText: '动作C' }).click()
  await win.locator('[role=dialog] button', { hasText: '鸭子坐' }).click()
  await shot('02-pose-picker')
  await win.locator('[role=dialog] button', { hasText: '添加 2 个姿态' }).click()
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
  const panel = win.locator('div.w-\\[380px\\], div.\\32xl\\:w-\\[400px\\]').last()
  await win.locator('button', { hasText: 'A服装3' }).last().click()
  await win.locator('button', { hasText: '表情2' }).last().click()
  await win.locator('button', { hasText: '表情5' }).last().click()
  await win.locator('button', { hasText: /^20$/ }).last().click()
  await win.locator('button', { hasText: '俯视' }).last().click()
  await shot('03-pose-detail')
  const card0 = await cards.nth(0).innerText()
  check('姿态详情配置显示在卡片上', card0.includes('A服装3') && card0.includes('表情2、表情5') && card0.includes('20') && card0.includes('俯视'), card0.replace(/\n/g, ' | '))
  void panel
  // 不能整除：设为 21 张
  await win.locator('input[inputmode=numeric]').last().fill('21')
  await win.waitForTimeout(200)
  check('不能整除时卡片显示错误', (await cards.nth(0).innerText()).includes('不能被 2 个表情平均分配'), (await cards.nth(0).innerText()).replace(/\n/g, ' | '))
  await win.locator('input[inputmode=numeric]').last().fill('20')
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
  const total = mock.submitted.length
  check('任务通过模拟 ComfyUI 执行完成', total > 0, `提交 ${total} 张`)
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

  // 其他页面
  await nav('LoRA 管理')
  check('LoRA Manager 正常打开', await win.getByRole('button', { name: /全部 LoRA/ }).isVisible())
  await shot('09-loras')
  await nav('素材库')
  await win.locator('main .grid > div').first().click()
  await shot('09-library')
  await nav('角色库')
  await shot('10-characters')
  check('角色页面为连续布局（无标签页，不显示角色标签 / 负面输入）', (await win.locator('[role=tab]').count()) === 0 && (await win.getByText('角色标签', { exact: true }).count()) === 0)
  await win.locator('[data-testid=outfit-row] button', { hasText: 'A服装1' }).click()
  await win.waitForTimeout(300)
  check('点击服装在当前页面展开编辑（只有名称与 Positive）', (await win.getByPlaceholder('服装 / 穿着状态 Prompt（原样保存）').count()) === 1 && (await win.getByPlaceholder('可留空').count()) === 0)
  await shot('11-character-outfits')
  await nav('剧情库')
  await win.locator('main button', { hasText: '剧情1' }).first().click()
  await shot('12-stories')
  await nav('设置')
  await shot('13-settings')
  await win.locator('button', { hasText: '工作流与映射' }).click()
  await shot('14-workflow-mapping')
  await win.locator('button', { hasText: 'Prompt 组合' }).click()
  await shot('15-compose')

  // 小窗口布局
  await setSize(1180, 720)
  await nav('套图任务')
  await cards.nth(1).click()
  await shot('16-plan-small')
  await nav('执行队列')
  await shot('17-queue-small')
  await setSize(1920, 1040)
  await nav('套图任务')
  await win.locator('button', { hasText: '任务设置' }).click()
  await shot('18-task-settings')
  await win.keyboard.press('Escape')
  await win.locator('button', { hasText: '剧情' }).filter({ hasText: '剧情1' }).first().click()
  await shot('19-story-picker')
  await win.keyboard.press('Escape')

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
