// 批量放大：原图生成条件的恢复、放大工作流的写入、上传、最终输出识别与结果关联。
// 全部使用模拟 ComfyUI（test/mock-comfy.ts）与测试用的中性工作流（不是用户的真实工作流），不能代替在真实 ComfyUI 与插件上的验证。

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { finalOutputNodes, newEntry, primaryOutputIndex, TRIGGER_DISABLE, UPSCALE_CHECKPOINT, UPSCALE_IMAGE, UPSCALE_LORA, UPSCALE_OUTPUT, validateMapping } from '@shared/mapping'
import type { ApiWorkflow, MappingEntry, OutputFile, RunUnit } from '@shared/types'
import { evalText, recoverGeneration, suggestUpscaleMapping, upscaleInputs, upscaleWorkflowProblems } from '@shared/upscale'
import { diffWorkflow } from '@shared/workflow-analysis'
import { ComfyClient } from '../src/main/comfy-client'
import { enqueueTask } from '../src/main/plan'
import { Runner, sha256 } from '../src/main/runner'
import type { Store } from '../src/main/store'
import { enqueueUpscale, planUpscale } from '../src/main/upscale'
import { createVault, openVault } from '../src/main/vault'
import { Lib, tempDir } from './helpers'
import { MockComfy } from './mock-comfy'

const FIXTURE: ApiWorkflow = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'workflow-two-pass.json'), 'utf8'))

/** 生成工作流（测试用）：LoraManager 列表 + TriggerWord Toggle + 拼接 + 正则 + 通配符节点，两个前后相连的保存节点 */
const GEN: ApiWorkflow = {
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'illustrious.safetensors' } },
  '5': {
    class_type: 'Lora Loader (LoraManager)',
    inputs: {
      model: ['4', 0],
      clip: ['4', 1],
      text: '<lora:charA:0.8> <lora:styleX:0.5:0.3>',
      loras: {
        __value__: [
          { name: 'charA', strength: 0.8, clipStrength: 0.8, active: true, expanded: false, locked: false },
          { name: 'styleX', strength: 0.5, clipStrength: 0.3, active: true, expanded: false, locked: false },
          { name: 'unusedY', strength: 1, clipStrength: 1, active: false, expanded: false, locked: false },
        ],
      },
    },
  },
  '3': { class_type: 'ImpactWildcardProcessor', inputs: { wildcard_text: '', populated_text: '', mode: 'populate', seed: 1 } },
  '34': { class_type: 'TriggerWord Toggle (LoraManager)', inputs: { group_mode: true, default_active: true, allow_strength_adjustment: false, orinalMessage: 'trig_a', toggle_trigger_words: { __value__: [{ text: 'trig_a', active: true, highlighted: false, strength: null }] }, trigger_words: ['5', 2] } },
  '45': { class_type: 'StringConcatenate', inputs: { string_a: ['34', 0], string_b: ['3', 0], delimiter: ',' } },
  '47': { class_type: 'RegexReplace', inputs: { string: ['45', 0], regex_pattern: '^,|,$', replace: '', case_insensitive: true, multiline: false, dotall: false, count: 0 } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: ['47', 0], clip: ['5', 1] } },
  '7': { class_type: 'CLIPTextEncode', inputs: { text: '原负面', clip: ['5', 1] } },
  '8': { class_type: 'EmptyLatentImage', inputs: { width: 832, height: 1216, batch_size: 1 } },
  '9': { class_type: 'KSampler', inputs: { seed: 1, steps: 28, cfg: 5.5, sampler_name: 'euler_ancestral', scheduler: 'normal', denoise: 1, model: ['5', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['8', 0] } },
  '10': { class_type: 'VAEDecode', inputs: { samples: ['9', 0], vae: ['4', 2] } },
  '106': { class_type: 'SaveImageAdvanced', inputs: { filename_prefix: 'ComfyUI', format: 'png', images: ['10', 0] } },
  '107': { class_type: 'UltimateSDUpscale', inputs: { upscale_by: 1.5, seed: 5, steps: 18, cfg: 5.5, sampler_name: 'dpmpp_2m_sde', scheduler: 'karras', denoise: 0.2, image: ['106', 0], model: ['5', 0], positive: ['6', 0], negative: ['7', 0], vae: ['4', 2] } },
  '121': { class_type: 'SaveImage', inputs: { filename_prefix: 'x', images: ['107', 0] } },
}
const GEN_MAP: MappingEntry[] = [
  newEntry('positive', '3', 'populated_text'),
  newEntry('positive', '3', 'wildcard_text'),
  newEntry('negative', '7', 'text'),
  newEntry('seed', '9', 'seed'),
  newEntry('filename_prefix', '106', 'filename_prefix', [], 'mid/{序号}'),
  newEntry('filename_prefix', '121', 'filename_prefix', [], '套图/图片{序号}'),
]

/** 放大工作流（测试用）：LoadImage → ControlNet + UltimateSDUpscale → SaveImage；另有一个预览和一个中间保存节点 */
const UP: ApiWorkflow = {
  '1': { class_type: 'LoadImage', inputs: { image: 'example.png', upload: 'image' } },
  '2': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'other.safetensors' } },
  '3': { class_type: 'Lora Loader (LoraManager)', inputs: { model: ['2', 0], clip: ['2', 1], text: '<lora:detailer:0.3>', loras: { __value__: [{ name: 'detailer', strength: 0.3, clipStrength: 0.3, active: true }] } } },
  '4': { class_type: 'CLIPTextEncode', inputs: { text: 'up pos', clip: ['3', 1] } },
  '5': { class_type: 'CLIPTextEncode', inputs: { text: 'up neg', clip: ['3', 1] } },
  '6': { class_type: 'ControlNetLoader', inputs: { control_net_name: 'tile.safetensors' } },
  '7': { class_type: 'ControlNetApplyAdvanced', inputs: { strength: 0.4, start_percent: 0, end_percent: 0.6, positive: ['4', 0], negative: ['5', 0], control_net: ['6', 0], image: ['1', 0], vae: ['2', 2] } },
  '8': { class_type: 'UpscaleModelLoader', inputs: { model_name: '4x.pth' } },
  '9': { class_type: 'UltimateSDUpscale', inputs: { upscale_by: 2, seed: 777, steps: 20, cfg: 6, sampler_name: 'dpmpp_2m', scheduler: 'karras', denoise: 0.25, mode_type: 'Linear', tile_width: 1024, tile_height: 1024, mask_blur: 8, tile_padding: 32, seam_fix_mode: 'None', seam_fix_denoise: 1, image: ['1', 0], model: ['3', 0], positive: ['7', 0], negative: ['7', 1], vae: ['2', 2], upscale_model: ['8', 0] } },
  '10': { class_type: 'SaveImage', inputs: { filename_prefix: 'up', images: ['9', 0] } },
  '11': { class_type: 'PreviewImage', inputs: { images: ['9', 0] } },
  '12': { class_type: 'SaveImage', inputs: { filename_prefix: 'mid', images: ['1', 0] } },
}
const UP_MAP: MappingEntry[] = [
  newEntry(UPSCALE_IMAGE, '1', 'image'),
  newEntry('positive', '4', 'text'),
  newEntry('negative', '5', 'text'),
  newEntry(UPSCALE_CHECKPOINT, '2', 'ckpt_name'),
  newEntry(UPSCALE_LORA, '3', 'loras'),
  newEntry(UPSCALE_OUTPUT, '10', 'filename_prefix'),
]

const submittedUpscales = (mock: MockComfy) => mock.submitted.filter(([, g]) => Object.values(g).some((n) => n.class_type === 'LoadImage'))
const stackOf = (g: ApiWorkflow, nid: string) => (g[nid].inputs.loras as { __value__: Record<string, unknown>[] }).__value__

describe('批量放大（模拟 ComfyUI）', () => {
  let mock: MockComfy
  let s: Store
  let lib: Lib
  let root: string
  let comfyOut: string
  let runner: Runner | null
  let upId: number

  beforeEach(async () => {
    comfyOut = tempDir()
    mock = new MockComfy(0.01, comfyOut)
    mock.saveClasses = /^SaveImage(Advanced)?$/
    mock.previewClasses = /^PreviewImage$/
    await mock.serve(0)
    root = tempDir()
    createVault(root)
    s = openVault(root)
    s.setSetting('comfy_url', mock.url)
    s.setSetting('poll_interval_sec', 0.05)
    lib = new Lib(s)
    lib.addWorkflow(GEN_MAP, GEN)
    upId = s.save('workflows', { name: '放大工作流', api_json: UP, mapping: UP_MAP })
    runner = null
  })
  afterEach(async () => {
    runner?.stop()
    await runner?.join()
    await mock.shutdown()
    s.close()
  })

  /** 执行队列直到全部完成（或失败） */
  const drain = async () => {
    runner = new Runner(s, { eventsFactory: null })
    runner.start()
    await runner.join()
  }
  const generate = async (task: ReturnType<Lib['makeTask']>) => {
    const { runId, plan } = enqueueTask(s, task)
    expect(plan.errors).toEqual([])
    await drain()
    const units = s.listUnits(runId!)
    expect(units.every((u) => u.status === 'done')).toBe(true)
    return units
  }
  const upscale = async (units: RunUnit[], accept = false, wid = upId) => {
    const r = enqueueUpscale(s, units.map((u) => ({ unit_id: u.id })), wid, accept)
    expect(r.errors).toEqual([])
    await drain()
    return s.listUnits(r.runId!)
  }

  it('修复：前后相连的保存节点只有最下游的是最终输出，上游的中间保存节点不再占用文件名与预览', async () => {
    const [u] = await generate(lib.makeTask([lib.item('睡觉', null, [], 1)], '两个保存'))
    const mid = u.outputs.find((o) => o.node === '106')!
    const fin = u.outputs.find((o) => o.node === '121')!
    expect(mid.role).toBe('intermediate')
    expect(mid.saved).toBeUndefined()
    expect(fin.role).toBe('final')
    expect(existsSync(fin.saved!)).toBe(true)
    expect(u.outputs[primaryOutputIndex(u)].node).toBe('121')
    // 旧记录（两个都被标为 final）：有冻结的工作流时预览按连接改选最下游的节点
    const legacy = { ...u, outputs: u.outputs.map((o) => ({ ...o, role: 'final' as const })) }
    expect(legacy.outputs[primaryOutputIndex(legacy, GEN)].node).toBe('121')
    // 用户的实际样本：106 SaveImageAdvanced → 107 UltimateSDUpscale → 121 SaveImage
    const both = [{ node: '106', input: 'filename_prefix', source: 'filename_prefix', value: 'a' }, { node: '121', input: 'filename_prefix', source: 'filename_prefix', value: 'a' }]
    expect([...finalOutputNodes(both, FIXTURE)]).toEqual(['121'])
    expect([...finalOutputNodes([both[0]], FIXTURE)]).toEqual(['121'])
    expect([...finalOutputNodes([], FIXTURE)]).toEqual(['121'])
  })

  it('修复：套图复刻统一文件名（output_name）时，最终图得到不带后缀的文件名，上游中间图不复制', async () => {
    const [u] = await generate(lib.makeTask([lib.item('睡觉', null, [], 1)], '同名'))
    const r = new Runner(s, { eventsFactory: null })
    const dir = tempDir()
    const outs: OutputFile[] = u.outputs.map((o) => ({ ...o, role: undefined, saved: undefined, source_sha256: undefined, saved_sha256: undefined }))
    const unit = { ...u, meta: { ...u.meta, output_dir: dir, output_name: '原图名' } }
    await (r as unknown as { saveOutputs(u: unknown, o: OutputFile[], c: unknown): Promise<void> }).saveOutputs(unit, outs, new ComfyClient(mock.url))
    const fin = outs.find((o) => o.node === '121')!
    expect(basename(fin.saved!)).toBe('原图名.png')
    expect(outs.find((o) => o.node === '106')!.saved).toBeUndefined()
  })

  it('同批图片 Prompt 不同时分别恢复；运行时注入的触发词按插件逻辑推断并说明', async () => {
    const units = await generate(lib.makeTask([lib.item('睡觉', null, [], 1), lib.item('鸭子坐', null, [], 1)], '两张'))
    expect(units[0].positive).not.toBe(units[1].positive)
    const plan = planUpscale(s, units.map((u) => ({ unit_id: u.id })), upId)
    expect(plan.errors).toEqual([])
    for (const [i, c] of plan.candidates.entries()) {
      expect(c.state).toBe('ok')
      // 实际编码的文本 = 触发词节点输出 + ',' + 写入的 Prompt（正则去掉首尾逗号）
      expect(c.positive).toBe(`trig_a,${units[i].positive}`)
      expect(c.negative).toBe(units[i].negative)
      expect(c.checkpoint).toBe('illustrious.safetensors')
      expect(c.issues.some((x) => x.level === 'note' && x.text.includes('#34') && x.text.includes('推断'))).toBe(true)
    }
  })

  it('ComfyEngi 禁止了触发词注入时 Prompt 完全由快照确定；LoRA 变化让插件绕过开关时要求确认，不假装知道触发词', async () => {
    lib.addWorkflow([...GEN_MAP, newEntry(TRIGGER_DISABLE, '34', 'toggle_trigger_words')], GEN)
    const [u] = await generate(lib.makeTask([lib.item('睡觉', null, [], 1)], '禁止注入'))
    const [c] = planUpscale(s, [{ unit_id: u.id }], upId).candidates
    expect(c.positive).toBe(u.positive)
    expect(c.issues.filter((x) => x.level !== 'note')).toEqual([])
    lib.addWorkflow(GEN_MAP, GEN)
    const other = s.save('characters', { name: '角色C', tag: 'c', positive: '1girl, char_c', loras: [{ name: 'charC.safetensors', strength: 1 }] })
    const [u2] = await generate(lib.makeTask([lib.item('睡觉', null, [], 1)], '换角色', { character_id: other }))
    const [c2] = planUpscale(s, [{ unit_id: u2.id }], upId).candidates
    expect(c2.state).toBe('confirm')
    expect(c2.issues.find((x) => x.level === 'confirm')!.text).toMatch(/运行时.*#34/)
    expect(c2.positive).toBe(u2.positive) // 只包含能确定的部分
    // 不确认就不加入；确认后加入，并把问题记录在任务中
    const r = enqueueUpscale(s, [{ unit_id: u2.id }], upId, false)
    expect(r.runId).toBeNull()
    expect(r.skipped[0].reason).toMatch(/运行时/)
    const r2 = enqueueUpscale(s, [{ unit_id: u2.id }], upId, true)
    expect(s.getUnit(s.listUnits(r2.runId!)[0].id)!.meta.upscale!.issues.some((x) => x.level === 'confirm')).toBe(true)
  })

  it('LoRA 权重不同的图片分别恢复（LoraManager 列表的名称、启用状态、model / clip 强度），原来未启用的不会被启用', async () => {
    const a = (await generate(lib.makeTask([lib.item('睡觉', null, [], 1)], '权重A')))[0]
    const b = (await generate(lib.makeTask([lib.item('睡觉', null, [], 1)], '权重B', { lora_overrides: { lora1: { enabled: true, strength_model: 0.55, strength_clip: 0.4 } } })))[0]
    const done = await upscale([a, b])
    expect(done.map((u) => u.status)).toEqual(['done', 'done'])
    const [ga, gb] = submittedUpscales(mock).map(([, g]) => g)
    const pick = (g: ApiWorkflow) => stackOf(g, '3').map((e) => [e.name, e.strength, e.clipStrength, e.active])
    expect(pick(ga)).toEqual([['charA', 0.8, 0.8, true], ['styleX', 0.5, 0.3, true], ['unusedY', 1, 1, false]])
    expect(pick(gb)).toEqual([['charA', 0.55, 0.4, true], ['styleX', 0.5, 0.3, true], ['unusedY', 1, 1, false]])
    // 结构化列表与 text 一致；放大工作流原有的 LoRA 列表被替换为原图的
    expect(gb['3'].inputs.text).toBe('<lora:charA:0.55:0.4> <lora:styleX:0.5:0.3> <lora:unusedY:1>')
    expect(stackOf(gb, '3').some((e) => e.name === 'detailer')).toBe(false)
    expect(done[1].meta.upscale!.recovered.loras.find((l) => l.name === 'charA')).toMatchObject({ strength: 0.55, clip: 0.4, active: true })
  })

  it('生成后修改角色库与 LoRA 配置，旧图仍按生成时的快照恢复', async () => {
    const [u] = await generate(lib.makeTask([lib.item('睡觉', null, [], 1)], '修改前'))
    const before = planUpscale(s, [{ unit_id: u.id }], upId).candidates[0]
    s.save('characters', { id: lib.charA, positive: '1girl, CHANGED', loras: [{ name: 'charA.safetensors', strength: 0.1 }] })
    s.save('templates', { id: lib.poses['睡觉'], positive: 'CHANGED_POSE' })
    s.save('workflows', { id: s.getSetting('default_workflow_id')!, api_json: { ...GEN, '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'changed.safetensors' } } } })
    const after = planUpscale(s, [{ unit_id: u.id }], upId).candidates[0]
    expect(after.positive).toBe(before.positive)
    expect(after.positive).not.toContain('CHANGED')
    expect(after.checkpoint).toBe('illustrious.safetensors')
    expect(after.loras).toEqual(before.loras)
  })

  it('连续放大不同图片：每张图的输入图片、Prompt、LoRA 不串用；只写入允许的输入，采样参数保持放大工作流的值', async () => {
    const units = await generate(lib.makeTask([lib.item('睡觉', null, [], 1), lib.item('动作A', null, [], 1)], '连续', { lora_overrides: { lora1: { enabled: true, strength_model: 0.7 } } }))
    const done = await upscale(units)
    expect(done.map((u) => u.status)).toEqual(['done', 'done'])
    const subs = submittedUpscales(mock)
    expect(subs.length).toBe(2)
    const names = subs.map(([, g]) => String(g['1'].inputs.image))
    expect(new Set(names).size).toBe(2)
    for (const [i, [pid, g]] of subs.entries()) {
      const src = done[i].meta.upscale!.source
      expect(src.unit_id).toBe(units[i].id)
      // LoadImage 实际读取的文件内容就是这张原图
      const loaded = mock.loaded.find(([p]) => p === pid)!
      expect(loaded[1]).toBe(names[i])
      expect(loaded[2]).toBe(sha256(readFileSync(src.path)))
      expect(g['4'].inputs.text).toBe(`trig_a,${units[i].positive}`)
      expect(g['5'].inputs.text).toBe(units[i].negative)
      expect(g['2'].inputs.ckpt_name).toBe('illustrious.safetensors')
      // 与放大工作流相比只改动了允许的输入：采样参数、upscale_by、tile、ControlNet 都是放大工作流的值
      const changed = diffWorkflow(UP, g).changes.map((c) => `${c.node}.${c.input}`).sort()
      expect(changed).toEqual(['1.image', '2.ckpt_name', '3.loras', '3.text', '4.text', '5.text'])
      expect(g['9'].inputs).toMatchObject({ seed: 777, steps: 20, cfg: 6, sampler_name: 'dpmpp_2m', scheduler: 'karras', denoise: 0.25, upscale_by: 2, tile_width: 1024, tile_padding: 32 })
      expect(g['7'].inputs.strength).toBe(0.4)
    }
    // 提交快照中保存的就是实际发送的 JSON
    const a = s.latestAttempt(done[0].id)!
    expect(JSON.parse(s.attemptBody(a.id)!.body).prompt).toEqual(subs[0][1])
  })

  it('只取映射指定的最终输出节点：中间保存节点与预览不当作结果；结果保存到原图旁的「放大」文件夹并与原图关联', async () => {
    const [u] = await generate(lib.makeTask([lib.item('睡觉', null, [], 1)], '输出'))
    const srcPath = u.outputs.find((o) => o.role === 'final')!.saved!
    const srcHash = sha256(readFileSync(srcPath))
    const [up] = await upscale([u])
    expect(up.status).toBe('done')
    const roles = Object.fromEntries(up.outputs.map((o) => [o.node, o.role]))
    expect(roles).toEqual({ '10': 'final', '11': 'preview', '12': 'intermediate' })
    const fin = up.outputs.find((o) => o.node === '10')!
    expect(dirname(fin.saved!)).toBe(join(dirname(srcPath), '放大'))
    expect(basename(fin.saved!)).toBe(basename(srcPath))
    expect(up.outputs[primaryOutputIndex(up)].node).toBe('10')
    expect(up.meta.upscale!.source).toMatchObject({ unit_id: u.id, run_id: u.run_id, path: srcPath, sha256: srcHash, snapshot: 'attempt' })
    expect(up.meta.upscale!.workflow).toEqual({ id: upId, name: '放大工作流' })
    // 放大结果本身不能再次加入
    expect(planUpscale(s, [{ unit_id: up.id }], upId).candidates[0].issues[0].text).toMatch(/这是放大结果/)
    // 再用另一个工作流放大同一张图：不覆盖原图和之前的结果
    const up2Id = s.save('workflows', { name: '放大2', api_json: { ...UP, '9': { ...UP['9'], inputs: { ...UP['9'].inputs, upscale_by: 1.5 } } }, mapping: UP_MAP })
    const [again] = await upscale([u], false, up2Id)
    const fin2 = again.outputs.find((o) => o.role === 'final')!
    expect(basename(fin2.saved!)).toBe(basename(srcPath).replace(/\.png$/, ' (2).png'))
    expect(existsSync(fin.saved!)).toBe(true)
    expect(sha256(readFileSync(srcPath))).toBe(srcHash)
  })

  it('执行完成但最终输出节点没有返回图片：标记失败并说明，不把其他节点的图片当作结果；可以单独重试', async () => {
    const [u] = await generate(lib.makeTask([lib.item('睡觉', null, [], 1)], '缺输出'))
    mock.skipOutputs.add('10')
    const [up] = await upscale([u])
    expect(up.status).toBe('failed')
    expect(up.error).toMatch(/最终输出节点 #10 没有返回图片/)
    expect(up.outputs.every((o) => !o.saved)).toBe(true)
    mock.skipOutputs.clear()
    expect(s.retryUnits([up.id])).toBe(1)
    await drain()
    expect(s.getUnit(up.id)!.status).toBe('done')
    expect(s.attempts(up.id).map((a) => a.state)).toEqual(['failed', 'success'])
  })

  it('中文文件名、重名：上传使用每张图唯一的 ASCII 文件名；ComfyUI 返回其他文件名时使用返回值', async () => {
    const units = await generate(lib.makeTask([lib.item('睡觉', null, [], 1), lib.item('鸭子坐', null, [], 1)], '中文'))
    // 两张原图内容相同（重名 / 重复内容也不会共用上传文件）
    const p0 = units[0].outputs.find((o) => o.role === 'final')!.saved!
    expect(basename(p0)).toMatch(/^图片/)
    const r = enqueueUpscale(s, units.map((u) => ({ unit_id: u.id })), upId)
    const [m0, m1] = s.listUnits(r.runId!).map((u) => u.meta.upscale!)
    expect(m0.upload.name).toMatch(/^u[0-9a-f]{16}_[0-9a-f]{10}\.png$/)
    expect(m0.upload.name).not.toBe(m1.upload.name)
    mock.uploadRename = (n) => `renamed_${n}`
    await drain()
    const done = s.listUnits(r.runId!)
    expect(done.every((u) => u.status === 'done')).toBe(true)
    expect(mock.uploadCalls.every((c) => c.overwrite === 'true' && c.subfolder === 'comfyengi_upscale')).toBe(true)
    const used = submittedUpscales(mock).map(([, g]) => g['1'].inputs.image)
    expect(used).toEqual([`comfyengi_upscale/renamed_${m0.upload.name}`, `comfyengi_upscale/renamed_${m1.upload.name}`])
  })

  it('防止重复加入：同一张图用同一个工作流在队列中等待时不再加入', async () => {
    const [u] = await generate(lib.makeTask([lib.item('睡觉', null, [], 1)], '重复'))
    expect(enqueueUpscale(s, [{ unit_id: u.id }, { unit_id: u.id }], upId).count).toBe(1)
    const [c] = planUpscale(s, [{ unit_id: u.id }], upId).candidates
    expect(c.state).toBe('blocked')
    expect(c.issues[0].text).toMatch(/已在放大队列中/)
  })

  it('原图在加入后被替换：不提交，标记失败并说明（避免串图）', async () => {
    const [u] = await generate(lib.makeTask([lib.item('睡觉', null, [], 1)], '替换'))
    const r = enqueueUpscale(s, [{ unit_id: u.id }], upId)
    writeFileSync(s.listUnits(r.runId!)[0].meta.upscale!.source.path, Buffer.from('not the same image'))
    await drain()
    const [up] = s.listUnits(r.runId!)
    expect(up.status).toBe('failed')
    expect(up.error).toMatch(/SHA-256 与入队时不同/)
    expect(submittedUpscales(mock)).toEqual([])
    expect(mock.uploadCalls).toEqual([])
  })

  it('旧数据缺少信息时明确提示：没有提交快照需要确认；没有冻结工作流、找不到原图文件时不能加入', async () => {
    const [u] = await generate(lib.makeTask([lib.item('睡觉', null, [], 1)], '旧数据'))
    s.db.prepare('DELETE FROM run_attempts WHERE unit_id=?').run(u.id)
    const [c] = planUpscale(s, [{ unit_id: u.id }], upId).candidates
    expect(c.state).toBe('confirm')
    expect(c.snapshot).toBe('rebuilt')
    expect(c.issues.some((x) => x.text.includes('没有提交快照'))).toBe(true)
    expect(c.positive).toBe(`trig_a,${u.positive}`) // 按冻结的工作流与写入值重建，与当时提交的相同
    s.db.prepare("UPDATE runs SET workflow_json='{}' WHERE id=?").run(u.run_id)
    const [c2] = planUpscale(s, [{ unit_id: u.id }], upId).candidates
    expect(c2.state).toBe('blocked')
    expect(c2.issues.some((x) => x.text.includes('没有入队时冻结的工作流'))).toBe(true)
    const r = enqueueUpscale(s, [{ unit_id: u.id }], upId, true)
    expect(r.runId).toBeNull()
    expect(r.errors[0]).toMatch(/没有可以加入/)
    const [u2] = await generate(lib.makeTask([lib.item('睡觉', null, [], 1)], '文件丢失'))
    const out = u2.outputs.find((o) => o.role === 'final')!
    s.updateUnit(u2.id, { outputs: u2.outputs.map((o) => (o === out ? { ...o, saved: join(root, 'gone.png'), path: '' } : o)) })
    s.setSetting('comfy_output_dir', '')
    const [c3] = planUpscale(s, [{ unit_id: u2.id }], upId).candidates
    expect(c3.state).toBe('blocked')
    expect(c3.issues[0].text).toMatch(/找不到原图文件/)
  })

  it('放大工作流的问题：未映射最终输出节点不能使用；采样相关映射不会写入；工作流中其他 LoRA 节点与触发词节点给出提示', () => {
    const noOut = UP_MAP.filter((m) => m.source !== UPSCALE_OUTPUT)
    expect(upscaleWorkflowProblems({ name: 'w', api_json: UP, mapping: noOut }).some(([l, m]) => l === 'error' && m.includes('最终输出节点'))).toBe(true)
    expect(upscaleWorkflowProblems({ name: 'w', api_json: UP, mapping: [] })[0][1]).toMatch(/不是放大工作流/)
    const extra: ApiWorkflow = { ...UP, '20': { class_type: 'LoraLoader', inputs: { lora_name: 'x.safetensors', strength_model: 1, strength_clip: 1, model: ['3', 0], clip: ['3', 1] } } }
    const msgs = upscaleWorkflowProblems({ name: 'w', api_json: extra, mapping: [...UP_MAP, newEntry('seed', '9', 'seed')] })
    expect(msgs.some(([l, m]) => l === 'warning' && m.includes('#20') && m.includes('一起加载'))).toBe(true)
    expect(msgs.some(([l, m]) => l === 'warning' && m.includes('Seed') && m.includes('不会写入'))).toBe(true)
    // 映射了 Seed 也不写入
    const rec = recoverGeneration(applyGen())
    const inputs = upscaleInputs({ name: 'w', api_json: UP, mapping: [...UP_MAP, newEntry('seed', '9', 'seed')] }, rec, 'a.png').inputs!
    expect(inputs.some((x) => x.source === 'seed')).toBe(false)
    expect(validateMapping(UP, UP_MAP).filter(([l]) => l === 'error')).toEqual([])
    // 自动识别放大映射
    expect(suggestUpscaleMapping(UP).map((m) => `${m.source}:${m.node}.${m.input}`).sort()).toEqual([`${UPSCALE_CHECKPOINT}:2.ckpt_name`, `${UPSCALE_IMAGE}:1.image`, `${UPSCALE_LORA}:3.loras`, 'negative:5.text', 'positive:4.text'].sort())
  })

  it('单 LoRA Loader 放大工作流：原图启用多个 LoRA 时不能写入，明确说明', () => {
    const single: ApiWorkflow = { ...UP, '3': { class_type: 'LoraLoader', inputs: { lora_name: 'detailer.safetensors', strength_model: 0.3, strength_clip: 0.3, model: ['2', 0], clip: ['2', 1] } } }
    const map = UP_MAP.map((m) => (m.source === UPSCALE_LORA ? { ...m, input: 'lora_name' } : m))
    const r = upscaleInputs({ name: 'w', api_json: single, mapping: map }, recoverGeneration(applyGen()), 'a.png')
    expect(r.inputs).toBeNull()
    expect(r.issues[0].text).toMatch(/启用了 2 个 LoRA/)
  })
})

/** 测试用：直接构建一份「已提交」的生成工作流 */
function applyGen(): ApiWorkflow {
  const g: ApiWorkflow = structuredClone(GEN)
  g['3'].inputs.populated_text = 'masterpiece, 1girl'
  return g
}

describe('文本节点的静态计算', () => {
  it('拼接、正则替换、通配符节点按 ComfyUI 的规则计算；无法确定的节点明确列出', () => {
    const api: ApiWorkflow = {
      a: { class_type: 'PrimitiveString', inputs: { value: 'x, y' } },
      b: { class_type: 'StringConcatenate', inputs: { string_a: ['a', 0], string_b: 'z', delimiter: ', ' } },
      c: { class_type: 'RegexReplace', inputs: { string: ['b', 0], regex_pattern: 'Y', replace: 'w', case_insensitive: true, multiline: false, dotall: false, count: 0 } },
      d: { class_type: 'SomeCustomNode', inputs: { text: ['c', 0], mode: 'x' } },
      e: { class_type: 'RegexReplace', inputs: { string: ['b', 0], regex_pattern: '(?P<n>x)', replace: '\\g<n>', case_insensitive: false, multiline: false, dotall: false, count: 0 } },
    }
    expect(evalText(api, ['c', 0])).toMatchObject({ text: 'x, w, z', exact: true })
    const d = evalText(api, ['d', 0])
    expect(d.exact).toBe(false)
    expect(d.runtime[0]).toContain('#d（SomeCustomNode）')
    expect(evalText(api, ['e', 0]).exact).toBe(false)
  })

  it('用户样本（workflow-two-pass.json）：正面 Prompt 经过 TriggerWord Toggle 与拼接、正则；Checkpoint 与 LoRA 列表沿模型链恢复', () => {
    const rec = recoverGeneration(FIXTURE, { original: FIXTURE })
    expect(rec.checkpoint).toBe('iceZ.safetensors')
    expect(rec.positive).toContain('masterpiece, best quality')
    expect(rec.negative).toContain('bad quality')
    expect(rec.loras!.length).toBe((FIXTURE['5'].inputs.loras as { __value__: unknown[] }).__value__.length)
    // 开关全部关闭、Loader 与保存时相同：推断为不注入，并给出说明
    expect(rec.issues.some((x) => x.text.includes('#34') && x.level === 'note')).toBe(true)
  })
})
