// LoRA 自动触发词路径：只用静态工作流 JSON 与本地文件，不连接 ComfyUI，不提交任何任务。

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultLoraConfig, effectiveLoraConfig, loraConfigProblems } from '@shared/lora-config'
import { applyInputs, newEntry, TRIGGER_CUT, TRIGGER_DISABLE } from '@shared/mapping'
import { controlInputs, controlProblems, controlsOf, cutOf, inputControl, mergeControlInputs, normalizeControls, withTriggerCuts } from '@shared/node-controls'
import { normalizeReplicaData, normalizeReplicaImage, REPLICA_VERSION, type ReplicaData } from '@shared/replica'
import type { ApiWorkflow, MappingEntry, WorkflowControls } from '@shared/types'
import { changeLines, diffWorkflow, findPromptInjectors, findTriggerPaths } from '@shared/workflow-analysis'
import { enqueueReplica, finalReplicaWorkflow, planForReplica, relocateImages, workflowPreview } from '../src/main/replica'
import type { Store } from '../src/main/store'
import { createVault, openVault } from '../src/main/vault'
import { tempDir } from './helpers'
import { makePng } from './mining-fixtures'

const FIXTURE: ApiWorkflow = JSON.parse(readFileSync(join(__dirname, 'fixtures/workflow-two-pass.json'), 'utf8'))

/** 用户的结构：Loader 的 trigger_words 直接接入 StringConcatenate */
const direct = (): ApiWorkflow => {
  const g = structuredClone(FIXTURE)
  delete g['34']
  g['45'].inputs.string_a = ['5', 2]
  return g
}
const renumber = (g: ApiWorkflow, map: Record<string, string>): ApiWorkflow => {
  const to = (id: string) => map[id] ?? id
  const out: ApiWorkflow = {}
  for (const [nid, n] of Object.entries(g)) {
    const inputs = Object.fromEntries(Object.entries(n.inputs).map(([k, v]) => [k, Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'number' ? [to(v[0]), v[1]] : v]))
    out[to(nid)] = { ...n, inputs }
  }
  return out
}
const errorsOf = (m: [string, string][]) => m.filter(([l]) => l === 'error').map(([, t]) => t)
const managed = (g: ApiWorkflow, mapping: MappingEntry[] = []): WorkflowControls => ({ overrides: [], bypass: [], trigger_cuts: findTriggerPaths(g, mapping).filter((p) => p.status === 'controllable').map(cutOf) })
const build = (g: ApiWorkflow, c: WorkflowControls) => applyInputs(g, controlInputs(g, c))

describe('识别', () => {
  it('找到直接拼接的路径，只看节点类型与连接', () => {
    const [p, ...rest] = findTriggerPaths(direct())
    expect(rest).toEqual([])
    expect(p).toMatchObject({ loader: '5', node: '45', input: 'string_a', status: 'controllable', encoders: ['43'] })
    expect(p.route).toEqual(['5', '45', '47', '43'])
  })
  it('节点 ID 改变后仍能识别', () => {
    const g = renumber(direct(), { '5': '905', '45': '845', '47': '847', '43': '743' })
    const [p] = findTriggerPaths(g)
    expect(p).toMatchObject({ loader: '905', node: '845', status: 'controllable' })
    expect(p.route).toEqual(['905', '845', '847', '743'])
  })
  it('名称含 Lora 的未知节点不按触发词输出处理', () => {
    const g = direct()
    g['5'] = { ...g['5'], class_type: 'Some Lora Loader' }
    expect(findTriggerPaths(g)).toEqual([])
    expect(findPromptInjectors(g, []).find((i) => i.node === '5')?.kind).toBe('loader_text')
  })
  it('其他输出（loaded_loras）不算触发词路径', () => {
    const g = direct()
    g['45'].inputs.string_a = ['5', 3]
    expect(findTriggerPaths(g)).toEqual([])
  })
  it('未知的中间节点不处理，并说明原因', () => {
    const g = direct()
    g['47'] = { class_type: 'MysteryText', inputs: { string: ['45', 0] } }
    const [p] = findTriggerPaths(g)
    expect(p.status).toBe('unsupported')
    expect(p.reason).toContain('#47')
    const c: WorkflowControls = { overrides: [], bypass: [], trigger_cuts: [cutOf(p)] }
    expect(errorsOf(controlProblems(g, [], c)).join()).toContain('无法确认')
  })
  it('未知节点直接使用输出时标记为无法确认', () => {
    const g = direct()
    g['200'] = { class_type: 'MysteryText', inputs: { string: ['5', 2] } }
    const list = findTriggerPaths(g)
    expect(list.map((p) => [p.node, p.status])).toEqual([['45', 'controllable'], ['200', 'unsupported']])
  })
  it('多条路径分别列出，不静默遗漏', () => {
    const g = direct()
    g['200'] = { class_type: 'StringConcatenate', inputs: { string_a: ['5', 2], string_b: 'x', delimiter: ',' } }
    g['43b'] = { class_type: 'CLIPTextEncode', inputs: { text: ['200', 0], clip: ['5', 1] } }
    g['46'].inputs.positive = ['43', 0]
    g['103'].inputs.positive = ['43b', 0]
    const list = findTriggerPaths(g)
    expect(list.map((p) => [p.node, p.status])).toEqual([['45', 'controllable'], ['200', 'controllable']])
    const one = { overrides: [], bypass: [], trigger_cuts: [cutOf(list[0])] }
    const out = build(g, one)
    expect(out['45'].inputs.string_a).toBe('')
    expect(out['200'].inputs.string_a).toEqual(['5', 2])
  })
  it('进入负面 Prompt 时不修改', () => {
    const g = direct()
    g['44'].inputs.text = ['47', 0]
    expect(findTriggerPaths(g)[0]).toMatchObject({ status: 'unsupported' })
  })
  it('经过 TriggerWord Toggle 的路径单独处理', () => {
    const [p] = findTriggerPaths(FIXTURE)
    expect(p).toMatchObject({ node: '34', input: 'trigger_words', status: 'toggle', disabled: false })
    expect(p.route).toEqual(['5', '34', '45', '47', '43'])
    expect(findTriggerPaths(FIXTURE, [newEntry(TRIGGER_DISABLE, '34', 'toggle_trigger_words')])[0].disabled).toBe(true)
  })
})

describe('切断', () => {
  const g = direct()
  it('拼接输入写成空文本，MODEL、CLIP、LoRA 列表不变，原工作流不变', () => {
    const before = JSON.stringify(g)
    const out = build(g, managed(g))
    expect(out['45'].inputs.string_a).toBe('')
    expect(out['45'].inputs.string_b).toEqual(g['45'].inputs.string_b)
    expect(out['5']).toEqual(g['5'])
    for (const nid of ['6', '41', '43', '44', '46', '103', '107']) for (const k of ['model', 'clip']) expect(out[nid].inputs[k]).toEqual(g[nid].inputs[k])
    expect(JSON.stringify(g)).toBe(before)
  })
  it('默认不修改：旧工作流没有这个配置时提交内容不变', () => {
    expect(controlsOf({ controls: { overrides: [], bypass: [] } }).trigger_cuts).toBeUndefined()
    expect(controlInputs(g, controlsOf({}))).toEqual([])
    expect(build(g, controlsOf(null))).toEqual(g)
  })
  it('关闭后恢复原连接', () => {
    expect(build(g, { ...managed(g), trigger_cuts: [] })['45'].inputs.string_a).toEqual(['5', 2])
  })
  it('配置经过 IPC 校验后保留；缺字段时拒绝', () => {
    const c = managed(g)
    expect(normalizeControls(c)).toEqual(c)
    expect(normalizeControls({ overrides: [], bypass: [] })).toEqual({ overrides: [], bypass: [] })
    expect(() => normalizeControls({ trigger_cuts: [{ node: '45' }] })).toThrow()
  })
  it('切断后不再提示未受控制的 Loader 文本', () => {
    expect(findPromptInjectors(g, []).some((i) => i.node === '5' && i.kind === 'loader_text')).toBe(true)
    expect(findPromptInjectors(withTriggerCuts(g, managed(g)), []).some((i) => i.node === '5')).toBe(false)
  })
  it('节点详情显示输入由谁控制', () => {
    expect(inputControl(g, [], managed(g), '45', 'string_a')).toMatchObject({ state: 'trigger', prepared: { value: '' } })
    expect(inputControl(g, [], managed(g), '45', 'string_b').state).toBe('link')
  })
  it('变更列表显示为切断，不显示 JSON 片段', () => {
    const inputs = controlInputs(g, managed(g))
    const [line] = changeLines(diffWorkflow(g, applyInputs(g, inputs), inputs).changes)
    expect(line).toMatchObject({ node: '45', label: 'string_a', before: '#5 的触发词输出', after: '空文本', source: TRIGGER_CUT })
  })
})

describe('与其他控制的关系', () => {
  const g = direct()
  const ctype = (nid: string) => g[nid].class_type
  it('工作流结构变化时报错，不静默失效', () => {
    const c = managed(g)
    const changed = structuredClone(g)
    changed['45'].inputs.string_a = 'fixed'
    expect(errorsOf(controlProblems(changed, [], c)).join()).toContain('不再是')
    const moved = renumber(g, { '45': '845' })
    expect(errorsOf(controlProblems(moved, [], c)).join()).toContain('不再是')
  })
  it('被绕过的节点上不能切断', () => {
    const c = { ...managed(g), bypass: [{ node: '45', class_type: ctype('45'), routes: [{ output: 0, input: 'string_b', type: 'STRING' }] }] }
    expect(errorsOf(controlProblems(g, [], c)).join()).toContain('已绕过')
  })
  it('同时映射同一输入时报冲突', () => {
    const m = [newEntry('positive', '45', 'string_a')]
    expect(errorsOf(controlProblems(g, m, managed(g, m))).join()).toContain('冲突')
    const merged = mergeControlInputs(g, [{ node: '45', input: 'string_a', source: 'positive', value: 'x' }], controlInputs(g, managed(g)))
    expect(merged.conflicts.join()).toContain('string_a')
  })
  it('绕过其他节点时切断仍然有效，也不会把切断的输入改接回去', () => {
    const c: WorkflowControls = { ...managed(g), bypass: [{ node: '48', class_type: ctype('48'), routes: [] }] }
    expect(errorsOf(controlProblems(g, [], c))).toEqual([])
    const out = build(g, c)
    expect(out['45'].inputs.string_a).toBe('')
    expect(out['48']).toBeUndefined()
    expect(controlInputs(g, c).filter((x) => x.node === '45')).toHaveLength(1)
  })
  it('Toggle 的禁止注入不受影响，两种机制不写同一输入', () => {
    const m = [newEntry(TRIGGER_DISABLE, '34', 'toggle_trigger_words')]
    const c = managed(FIXTURE, m)
    expect(c.trigger_cuts).toEqual([])
    expect(errorsOf(controlProblems(FIXTURE, m, c))).toEqual([])
  })
})

describe('计划、预览与队列', () => {
  const SEP = ',\n\n'
  let root: string
  let s: Store
  let srcDir: string
  let charId: number
  const MAPPING: MappingEntry[] = [newEntry('positive', '3', 'populated_text'), newEntry('negative', '4', 'populated_text')]
  const saveWf = (api: ApiWorkflow, controls: WorkflowControls | null = null) => s.save('workflows', { name: 'wf', api_json: api, mapping: MAPPING, controls })
  const image = (name: string, prompt = '1girl, red_hair, from side, smile') => {
    const p = join(srcDir, name)
    writeFileSync(p, makePng({ parameters: `${prompt}\nNegative prompt: bad\nSteps: 20, Sampler: Euler a, CFG scale: 7, Seed: 5, Size: 512x512` }))
    return normalizeReplicaImage({ path: p, name, status: 'ok', positive: prompt, negative: 'bad', source: 'a1111' })
  }
  const draft = (wid: number, images: ReturnType<typeof image>[], over: Partial<ReplicaData> = {}) => {
    const id = s.save('replicas', { name: '复刻', data: normalizeReplicaData({ version: REPLICA_VERSION, images, tag_fix: { red_hair: 'character' }, character_id: charId, workflow_id: wid, output: { dir: join(root, 'out') }, ...over }) })
    return s.get('replicas', id)!
  }
  beforeEach(() => {
    root = tempDir()
    srcDir = tempDir()
    createVault(root)
    s = openVault(root)
    // 不启动 Runner：这里只构建计划与冻结内容，没有任何提交
    charId = s.save('characters', { name: '新角色', positive: 'new girl', negative: '', loras: [{ name: 'char_new', strength: 0.8 }] })
  })
  afterEach(() => s.close())

  it('工作流预览与队列冻结内容一致', () => {
    const g = direct()
    const wid = saveWf(g, managed(g))
    const rec = draft(wid, [image('a.png')], { disable_triggers: false })
    expect(workflowPreview(s.get('workflows', wid)!).json['45'].inputs.string_a).toBe('')
    const final = finalReplicaWorkflow(s, rec, 0)
    expect(final.errors).toEqual([])
    expect(final.json['45'].inputs.string_a).toBe('')
    const { runId } = enqueueReplica(s, rec)
    const run = s.getRun(runId!)!
    const unit = s.listUnits(runId!)[0]
    expect((run.workflow_json as ApiWorkflow)['45'].inputs.string_a).toEqual(['5', 2])
    expect(applyInputs(run.workflow_json, unit.inputs)).toEqual(final.json)
    expect(s.get('workflows', wid)!.api_json['45'].inputs.string_a).toEqual(['5', 2])
  })
  it('使用插件输出时提交的连接不变', () => {
    const wid = saveWf(direct())
    const rec = draft(wid, [image('a.png')], { disable_triggers: false })
    expect(finalReplicaWorkflow(s, rec, 0).json['45'].inputs.string_a).toEqual(['5', 2])
    expect(planForReplica(s, rec).warnings.join()).toContain('LoRA 自动触发词')
  })
  it('复刻关闭注入后，Loader 的触发词不会把原角色带回来；只改提交的副本', () => {
    const g = direct()
    const wid = saveWf(g)
    const rec = draft(wid, [image('a.png')])
    const plan = planForReplica(s, rec)
    expect(plan.errors).toEqual([])
    const json = finalReplicaWorkflow(s, rec, 0).json
    expect(json['45'].inputs.string_a).toBe('')
    expect(json['3'].inputs.populated_text).toBe(`from side, smile${SEP}new girl`)
    expect(json['46'].inputs.model).toEqual(g['46'].inputs.model)
    expect(s.get('workflows', wid)!.controls).toBeNull()
  })
  it('复刻关闭注入时 Toggle 路径同样关闭', () => {
    const rec = draft(saveWf(FIXTURE), [image('a.png')])
    const json = finalReplicaWorkflow(s, rec, 0).json
    expect(json['34'].inputs.trigger_words).toBe('')
    expect(json['45'].inputs.string_a).toEqual(['34', 0])
  })
  it('没有调整过 LoRA 配置时，也提示工作流原有 LoRA 会继续加载', () => {
    const plan = planForReplica(s, draft(saveWf(direct()), [image('a.png')]))
    expect(plan.warnings.join()).toContain('BlueArchiveStyle_illus_1884029')
  })
  it('每张图保留自己的内容', () => {
    const rec = draft(saveWf(direct()), [image('a.png', '1girl, red_hair, from side, smile'), image('b.png', '1girl, red_hair, from above, sit')])
    expect(finalReplicaWorkflow(s, rec, 0).json['3'].inputs.populated_text).toBe(`from side, smile${SEP}new girl`)
    expect(finalReplicaWorkflow(s, rec, 1).json['3'].inputs.populated_text).toBe(`from above, sit${SEP}new girl`)
  })
  it('Prompt 中的 LoRA 文字从保留片段中删除并提示；重复 Tag 只提示，不改内容', () => {
    const rec = draft(saveWf(direct()), [image('a.png', '1girl, red_hair, from side, new girl, <lora:old_char:0.8>')])
    const plan = planForReplica(s, rec)
    expect(plan.warnings.join()).toContain('<lora:')
    expect(plan.warnings.join()).toContain('重复')
    expect(plan.rows[0].removed_other).toEqual(['<lora:old_char:0.8>'])
    expect(plan.rows[0].positive).toBe(`from side, new girl${SEP}new girl`)
  })
  it('关闭一个 LoRA 不影响已绕过的节点，保存映射也不影响节点控制', () => {
    const g = direct()
    const bypass = [{ node: '48', class_type: g['48'].class_type, routes: [] }]
    const wid = saveWf(g, { overrides: [], bypass })
    s.save('workflows', { id: wid, mapping: [...MAPPING] })
    expect(s.get('workflows', wid)!.controls?.bypass).toEqual(bypass)
    const cfg = defaultLoraConfig(g, MAPPING)
    cfg.entries[0].enabled = false
    const json = finalReplicaWorkflow(s, draft(wid, [image('a.png')], { lora_configs: { [String(wid)]: cfg }, disable_triggers: false }), 0).json
    expect(json['48']).toBeUndefined()
    const stack = (json['5'].inputs.loras as { __value__: { name: string; active: boolean }[] }).__value__
    expect(stack.find((e) => e.name === cfg.entries[0].name)?.active).toBe(false)
    expect(Object.keys(json).length).toBe(Object.keys(g).length - 1)
  })
  it('按文件名重新定位时，没有元数据的同名文件不算同一张图', async () => {
    const im = image('a.png')
    const other = tempDir()
    writeFileSync(join(other, 'a.png'), makePng({}))
    const data = normalizeReplicaData({ version: REPLICA_VERSION, images: [{ ...im, path: join(srcDir, 'moved.png') }] })
    const r = await relocateImages(data, other)
    expect(r.relocated).toBe(0)
    expect(r.mismatched).toEqual(['a.png'])
  })
})

describe('LoRA 配置残留', () => {
  it('更新 JSON 后 LoRA 列表变化时提示', () => {
    const g = direct()
    const saved = defaultLoraConfig(g, [])
    expect(loraConfigProblems(g, [], effectiveLoraConfig(saved, g, []), {}).warnings).toEqual([])
    const next = structuredClone(g)
    const list = (next['5'].inputs.loras as { __value__: Record<string, unknown>[] }).__value__
    list.push({ ...list[0], name: 'added_lora' })
    expect(loraConfigProblems(next, [], effectiveLoraConfig(saved, next, []), {}).warnings.join()).toContain('LoRA 列表已经变化')
  })
  it('旧配置没有记录时不误报', () => {
    const g = direct()
    const { sig: _sig, ...old } = defaultLoraConfig(g, [])
    expect(loraConfigProblems(g, [], effectiveLoraConfig(old, g, []), {}).warnings).toEqual([])
  })
})
