// 任务级输出：文件名前缀（含 %date:…%）写入 ComfyUI 的 filename_prefix；完成后通过 ComfyUI /view 把最终图片复制到任务的输出目录。
// 使用模拟 ComfyUI（真实写文件、真实 /view 下载）；ComfyUI 的 output 目录与任务输出目录分开，验证确实复制到了任务目录。

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { expandDateTokens, renderPrefix } from '@shared/mapping'
import type { ApiWorkflow, MappingEntry } from '@shared/types'
import { enqueueTask, planForTask } from '../src/main/plan'
import { Runner } from '../src/main/runner'
import type { Store } from '../src/main/store'
import { createVault, openVault } from '../src/main/vault'
import { Lib, SAMPLE_MAPPING, SAMPLE_WORKFLOW, tempDir, waitUntil } from './helpers'
import { MockComfy } from './mock-comfy'

const today = (fmt: string) => expandDateTokens(`%date:${fmt}%`)

describe('文件名前缀', () => {
  it('展开 %date:yyyy-MM-dd% 等日期格式，并去掉 Windows 非法字符', () => {
    const d = new Date(2026, 9, 25, 7, 5, 9)
    expect(expandDateTokens('%date:yyyy-MM-dd%/image', d)).toBe('2026-10-25/image')
    expect(expandDateTokens('%date:yyyyMMdd_HHmmss%', d)).toBe('20261025_070509')
    expect(expandDateTokens('%date:yy.M.d h%', d)).toBe('26.10.25 7')
    const u = { meta: { task: '任务:1' }, index: 2, seed: 7 }
    expect(renderPrefix('%date:yyyy-MM-dd%/image', u, '2026-10-25')).toBe('2026-10-25/image')
    expect(renderPrefix('out/{任务}/a*b?c|d/{序号}', u, '2026-10-25')).toBe('out/任务_1/a_b_c_d/0003')
    expect(renderPrefix('../x/%date:HH:mm%/', u, '2026-10-25')).toBe('x/00_00')
  })
})

describe('任务输出目录（模拟 ComfyUI）', () => {
  let mock: MockComfy
  let s: Store
  let lib: Lib
  let root: string
  let comfyOut: string
  let runner: Runner | null
  // 第二个 SaveImage（#20）没有映射输出前缀：视为中间结果，不复制
  const WF: ApiWorkflow = { ...SAMPLE_WORKFLOW, '20': { class_type: 'SaveImage', inputs: { filename_prefix: 'preview/tmp', images: ['8', 0] } } }

  beforeEach(async () => {
    comfyOut = tempDir()
    mock = new MockComfy(0.02, comfyOut)
    await mock.serve(0)
    root = tempDir()
    createVault(root)
    s = openVault(root)
    s.setSetting('comfy_url', mock.url)
    lib = new Lib(s)
    lib.addWorkflow(SAMPLE_MAPPING as MappingEntry[], WF)
    runner = null
  })
  afterEach(async () => {
    runner?.stop()
    await runner?.join()
    await mock.shutdown()
    s.close()
  })
  const run = async (task: ReturnType<Lib['makeTask']>) => {
    const { runId, plan } = enqueueTask(s, task)
    expect(plan.errors).toEqual([])
    runner = new Runner(s, { eventsFactory: null })
    runner.start()
    expect(await waitUntil(() => (s.runCounts(runId!).done ?? 0) === plan.units.length, 10000)).toBe(true)
    await runner.join()
    return s.listUnits(runId!)
  }

  it('默认复制到工作区 output/；前缀展开日期；只复制最终输出；ComfyUI 原文件保留', async () => {
    const task = lib.makeTask([lib.item('睡觉', null, [], 2)], '默认输出', { output: { prefix: '%date:yyyy-MM-dd%/image' } })
    const plan = planForTask(s, task)
    expect(plan.units.map((u) => u.inputs!.find((x) => x.node === '9')!.value)).toEqual([`${today('yyyy-MM-dd')}/image`, `${today('yyyy-MM-dd')}/image`])
    expect(plan.units[0].meta.output_dir).toBe(join(root, 'output'))
    const units = await run(task)
    for (const u of units) {
      const finals = u.outputs.filter((o) => o.saved)
      expect(finals.length).toBe(1)
      expect(finals[0].node).toBe('9')
      expect(finals[0].saved!.startsWith(join(root, 'output', today('yyyy-MM-dd')))).toBe(true)
      expect(readFileSync(finals[0].saved!)).toEqual(readFileSync(join(comfyOut, finals[0].subfolder, finals[0].filename)))
      expect(u.outputs.find((o) => o.node === '20')!.saved).toBeUndefined() // 中间结果不复制
    }
    expect(readdirSync(join(root, 'output', today('yyyy-MM-dd'))).length).toBe(2)
    expect(existsSync(join(root, 'output', 'preview'))).toBe(false)
    expect(readdirSync(join(comfyOut, today('yyyy-MM-dd'))).length).toBe(2) // 原文件未删除
  })

  it('每个任务独立的输出目录；同名文件不覆盖（追加序号）', async () => {
    const a = tempDir()
    const b = join(tempDir(), '不存在的子目录')
    mkdirSync(join(a, 'x'), { recursive: true })
    writeFileSync(join(a, 'x', 'img_00001_.png'), 'existing')
    const ua = await run(lib.makeTask([lib.item('睡觉', null, [], 1)], 'A', { output: { dir: a, prefix: 'x/img' } }))
    const ub = await run(lib.makeTask([lib.item('睡觉', null, [], 1)], 'B', { output: { dir: b, prefix: 'y/img' } }))
    expect(ua[0].outputs.find((o) => o.saved)!.saved).toBe(join(a, 'x', 'img_00001_ (2).png'))
    expect(readFileSync(join(a, 'x', 'img_00001_.png'), 'utf8')).toBe('existing')
    expect(ub[0].outputs.find((o) => o.saved)!.saved!.startsWith(join(b, 'y'))).toBe(true)
  })

  it('输出配置在入队时冻结：之后修改任务不影响已入队的图片', async () => {
    const dir1 = tempDir()
    const task = lib.makeTask([lib.item('睡觉', null, [], 1)], 'T', { output: { dir: dir1, prefix: 'first/img' } })
    const { runId } = enqueueTask(s, task)
    s.save('tasks', { id: task.id, data: { ...task.data, output: { dir: tempDir(), prefix: 'second/img' } } })
    const snap = s.listUnits(runId!)
    expect(snap[0].meta.output_dir).toBe(dir1)
    expect(snap[0].inputs.find((x) => x.node === '9')!.value).toBe('first/img')
    runner = new Runner(s, { eventsFactory: null })
    runner.start()
    expect(await waitUntil(() => (s.runCounts(runId!).done ?? 0) === 1, 10000)).toBe(true)
    await runner.join()
    expect(s.listUnits(runId!)[0].outputs.find((o) => o.saved)!.saved!.startsWith(join(dir1, 'first'))).toBe(true)
  })

  it('保存失败时记录明确原因，图片仍标记为已生成，ComfyUI 原文件保留', async () => {
    const blocker = join(tempDir(), 'file-not-dir')
    writeFileSync(blocker, 'x')
    const units = await run(lib.makeTask([lib.item('睡觉', null, [], 1)], 'F', { output: { dir: blocker, prefix: 'z/img' } }))
    const o = units[0].outputs.find((x) => x.node === '9')!
    expect(units[0].status).toBe('done')
    expect(o.saved).toBeUndefined()
    expect(o.save_error).toContain('复制到')
    expect(existsSync(join(comfyOut, o.subfolder, o.filename))).toBe(true)
    // 不隐藏在普通「完成」中：队列计数与运行记录筛选都能找到
    expect(s.runCounts(units[0].run_id).save_failed).toBe(1)
    expect(s.history('', 'save_failed').map((u) => u.id)).toEqual([units[0].id])
  })

  it('只重试保存：修复目录后从 ComfyUI 重新下载并复制，不重新提交生图', async () => {
    const parent = tempDir()
    const blocker = join(parent, 'out')
    writeFileSync(blocker, 'x')
    const units = await run(lib.makeTask([lib.item('睡觉', null, [], 1)], 'R', { output: { dir: blocker, prefix: 'z/img' } }))
    expect(units[0].outputs.some((o) => o.save_error)).toBe(true)
    const submitted = mock.submitted.length
    // 第一次重试：目录仍不可用，记录原因
    const r0 = new Runner(s, { eventsFactory: null })
    expect((await r0.retrySave([units[0].id])).failed).toBe(1)
    // 用户修复目录后重试
    rmSync(blocker)
    const r1 = await r0.retrySave([units[0].id])
    expect(r1).toEqual({ saved: 1, failed: 0, error: '' })
    const u = s.getUnit(units[0].id)!
    const o = u.outputs.find((x) => x.node === '9')!
    expect(o.save_error).toBeUndefined()
    expect(o.saved!.startsWith(join(blocker, 'z'))).toBe(true)
    expect(readFileSync(o.saved!)).toEqual(readFileSync(join(comfyOut, o.subfolder, o.filename)))
    expect(u.status).toBe('done')
    expect(mock.submitted.length).toBe(submitted) // 没有重新生图
    expect(s.runCounts(u.run_id).save_failed).toBeUndefined()
    // 再次重试：已保存的文件不会重复复制
    expect((await r0.retrySave([u.id])).saved).toBe(0)
    expect(readdirSync(join(blocker, 'z')).length).toBe(1)
  })

  it('没有设置前缀的旧任务沿用工作流映射的模板；入队前没有输出目录的旧记录不复制', async () => {
    const task = lib.makeTask([lib.item('睡觉', null, [], 1)], '旧任务')
    expect(planForTask(s, task).units[0].inputs!.find((x) => x.node === '9')!.value).toBe('T/0001')
    const { runId } = enqueueTask(s, task)
    // 模拟更新前入队的记录：meta 中没有 output_dir
    const u = s.listUnits(runId!)[0]
    s.db.prepare('UPDATE run_units SET meta=? WHERE id=?').run(JSON.stringify({ ...u.meta, output_dir: undefined }), u.id)
    runner = new Runner(s, { eventsFactory: null })
    runner.start()
    expect(await waitUntil(() => (s.runCounts(runId!).done ?? 0) === 1, 10000)).toBe(true)
    await runner.join()
    expect(s.listUnits(runId!)[0].outputs.every((o) => !o.saved)).toBe(true)
  })
})
