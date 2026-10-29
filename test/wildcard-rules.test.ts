// ImpactWildcardProcessor + LoraManager 工作流：自动识别保存的展开后文本、按「节点类型 + 字段」批量应用来源、
// 持久化来源规则（模拟重启后重新读取）以及批量应用的统计。100 张模拟图片，结构、节点 ID、节点数量各不相同。

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractPrompt, impactCommentOut, matchRuleDetail, type ExtractedPrompt, type SavedSourceRule } from '@shared/prompt-source'
import { resolveEffective, ruleHits, ruleReport, type ManualPrompt } from '@shared/prompt-rules'
import { loadSourceRules, MiningScanner, saveSourceRules, sourceRulesPath } from '../src/main/mining'
import { makePng } from './mining-fixtures'
import { NEG } from './meta-fixtures'

type G = Record<string, { class_type: string; inputs: Record<string, unknown>; _meta?: { title: string } }>

/** 按 Impact Pack / LoraManager 节点的实际输入名编写的工作流；shift 让节点 ID 全部不同 */
function workflow(kind: 'concat' | 'lmprompt' | 'direct-trigger' | 'mystery' | 'missing' | 'two' | 'negative', text: string, shift = 0): G {
  const id = (n: number) => String(n + shift)
  const L = (n: number, slot = 0) => [id(n), slot]
  const g: G = {
    [id(1)]: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'illustrious.safetensors' } },
    [id(5)]: { class_type: 'Lora Loader (LoraManager)', inputs: { model: L(1), clip: L(1, 1), text: '<lora:styleA:0.8>', loras: [{ name: 'styleA', strength: 0.8, active: true }] }, _meta: { title: 'Lora Loader (LoraManager)' } },
    [id(34)]: { class_type: 'TriggerWord Toggle (LoraManager)', inputs: { group_mode: true, default_active: true, allow_strength_adjustment: false, orinalMessage: 'styleA_trigger', toggle_trigger_words: [{ text: 'styleA_trigger', active: true }], trigger_words: L(5, 2) } },
    [id(3)]: { class_type: 'ImpactWildcardProcessor', inputs: { wildcard_text: '__pose__, 1girl, {smile|blush}', populated_text: text, mode: 'populate', seed: 7, 'Select to add Wildcard': 'Select the Wildcard to add to the text' } },
    [id(7)]: { class_type: 'CLIPTextEncode', inputs: { text: NEG, clip: L(5, 1) } },
    [id(8)]: { class_type: 'EmptyLatentImage', inputs: { width: 832, height: 1216, batch_size: 1 } },
    [id(9)]: { class_type: 'KSampler', inputs: { seed: 1, steps: 28, cfg: 6, sampler_name: 'euler', scheduler: 'karras', denoise: 1, model: L(5), positive: L(6), negative: L(7), latent_image: L(8) } },
  }
  if (kind === 'concat') {
    // 触发词 + 通配符文本 → 拼接 → 编码
    g[id(40)] = { class_type: 'StringConcatenate', inputs: { string_a: L(34), string_b: L(3), delimiter: ', ' } }
    g[id(6)] = { class_type: 'CLIPTextEncode', inputs: { text: L(40), clip: L(5, 1) } }
  } else if (kind === 'lmprompt') {
    // LoraManager 的 Prompt 节点：text 来自通配符节点，trigger_words1 来自触发词节点
    g[id(6)] = { class_type: 'Prompt (LoraManager)', inputs: { text: L(3), clip: L(5, 1), trigger_words1: L(34) } }
  } else if (kind === 'direct-trigger') {
    // 编码节点直接读取一个不认识的合并节点：追踪会在触发词处中断
    g[id(41)] = { class_type: 'Custom Text Merge', inputs: { first: L(34), second: L(3), mode: 'prepend' } }
    g[id(6)] = { class_type: 'CLIPTextEncode', inputs: { text: L(41), clip: L(5, 1) } }
  } else {
    g[id(6)] = { class_type: 'CLIPTextEncode', inputs: { text: L(3), clip: L(5, 1) } }
    if (kind === 'mystery' || kind === 'missing' || kind === 'two') {
      // 不认识的采样节点：找不到采样器，连接方向无法判断
      delete g[id(9)]
      g[id(9)] = { class_type: 'MysterySampler', inputs: { model: L(5), cond_pos: L(6), cond_neg: L(7), latent: L(8), seed: 1 } }
    }
    if (kind === 'missing') {
      delete g[id(3)]
      g[id(6)].inputs.text = 'literal prompt, no wildcard node'
    }
    if (kind === 'two') {
      g[id(80)] = { class_type: 'ImpactWildcardProcessor', inputs: { wildcard_text: 'a', populated_text: 'spare text one', mode: 'fixed', seed: 1, 'Select to add Wildcard': 'Select the Wildcard to add to the text' } }
      g[id(81)] = { class_type: 'ImpactWildcardProcessor', inputs: { wildcard_text: 'b', populated_text: 'spare text two', mode: 'fixed', seed: 1, 'Select to add Wildcard': 'Select the Wildcard to add to the text' } }
      // 两个完全相同、都没有连接的同类型节点（连接方向、标题、局部结构、节点 ID 都无法区分）
      delete g[id(3)]
      g[id(6)].inputs.text = 'literal prompt, two spare wildcard nodes'
    }
    if (kind === 'negative') {
      // 通配符节点只连到负向；正向是普通文本
      g[id(6)].inputs.text = 'plain positive, 1girl'
      g[id(7)].inputs.text = L(3)
    }
  }
  return g
}

const promptOf = (i: number) => `masterpiece, 1girl, pose_${i % 5}, unique_${i}, (smile:1.1)`

/** 100 张图片：拼接 30、LoraManager Prompt 10、不认识的合并节点 10、不认识的采样器 25、缺少节点 10、两个同类型节点 5、只连到负向 10 */
function dataset() {
  const plan: [Parameters<typeof workflow>[0], number][] = [
    ['concat', 30],
    ['lmprompt', 10],
    ['direct-trigger', 10],
    ['mystery', 25],
    ['missing', 10],
    ['two', 5],
    ['negative', 10],
  ]
  const out: { id: string; kind: string; text: string; r: ExtractedPrompt & { id: string; fields: unknown[] } }[] = []
  let i = 0
  for (const [kind, n] of plan) {
    for (let k = 0; k < n; k++, i++) {
      const text = promptOf(i)
      const g = workflow(kind, text, k % 3 === 0 ? 0 : (k % 3) * 100) // 部分图片节点 ID 不同
      const id = `C:/hist/${String(i).padStart(3, '0')}_${kind}.png`
      out.push({ id, kind, text, r: { ...extractPrompt({ prompt: JSON.stringify(g) }), id, fields: [{}] } })
    }
  }
  return out
}

describe('ImpactWildcardProcessor 与 LoraManager 节点', () => {
  it('触发词在运行时生成：拼接时省略并说明，采用通配符节点保存的展开后文本', () => {
    const r = extractPrompt({ prompt: JSON.stringify(workflow('concat', promptOf(1))) })
    expect(r).toMatchObject({ status: 'ok', positive: promptOf(1), negative: NEG })
    expect(r.notes.join()).toMatch(/TriggerWord Toggle \(LoraManager\).*触发词未包含/)
    expect(r.fallback).toBeFalsy()
  })

  it('Prompt (LoraManager)：读取 text，说明未包含运行时触发词', () => {
    const r = extractPrompt({ prompt: JSON.stringify(workflow('lmprompt', promptOf(2))) })
    expect(r).toMatchObject({ status: 'ok', positive: promptOf(2) })
    expect(r.notes.join()).toMatch(/触发词未包含/)
  })

  it('追踪在不认识的节点处中断：按连线可达性确认通配符节点连到正向，自动采用其展开后文本', () => {
    const r = extractPrompt({ prompt: JSON.stringify(workflow('direct-trigger', promptOf(3))) })
    expect(r).toMatchObject({ status: 'ok', positive: promptOf(3), fallback: true })
    expect(r.notes.join()).toMatch(/采样器追踪未完成.*Custom Text Merge/)
    expect(r.notes.join()).toMatch(/#3（ImpactWildcardProcessor）保存的展开后文本/)
  })

  it('找不到采样器、无法确认连接方向：只作为需要确认的结果，不当作可靠结果', () => {
    const r = extractPrompt({ prompt: JSON.stringify(workflow('mystery', promptOf(4))) })
    expect(r.status).toBe('check')
    expect(r.positive).toBe(promptOf(4))
    expect(r.notes.join()).toMatch(/无法确认该节点连接到正向/)
  })

  it('LoRA 语法与触发词设置不会成为候选；模板与展开后文本分别标注', () => {
    const r = extractPrompt({ prompt: JSON.stringify(workflow('concat', promptOf(5))) })
    expect(r.candidates.some((c) => c.text.includes('<lora:styleA'))).toBe(false)
    const tpl = r.candidates.find((c) => c.rule.field === 'wildcard_text')!
    expect(tpl.warn).toMatch(/通配符模板/)
    const pop = r.candidates.find((c) => c.rule.field === 'populated_text')!
    expect(pop).toMatchObject({ role: 'positive', text: promptOf(5) })
    expect(pop.warn).toBeUndefined()
  })

  it('populated_text 仍含通配符语法或为空：不伪造最终 Prompt', () => {
    const left = extractPrompt({ prompt: JSON.stringify(workflow('direct-trigger', '__pose__, 1girl, {smile|blush}')) })
    expect(left.status).toBe('check')
    expect(left.notes.join()).toMatch(/仍有通配符语法/)
    const empty = extractPrompt({ prompt: JSON.stringify(workflow('direct-trigger', '')) })
    expect(empty.status).toBe('error')
    expect(empty.positive).toBe('')
    // 与 Impact Pack 相同的注释处理
    expect(impactCommentOut('1girl,\n# comment line\nsmile\nblush')).toBe('1girl, smile\nblush')
  })
})

describe('按节点类型 + 字段批量应用（100 张）', () => {
  const data = dataset()
  const images = data.map((d) => d.r)
  const pickFrom = data.find((d) => d.kind === 'mystery')!
  const rule = pickFrom.r.candidates.find((c) => c.rule.classType === 'ImpactWildcardProcessor' && c.rule.field === 'populated_text')!.rule

  it('自动识别：拼接 / LoraManager Prompt / 中断的追踪都直接提取，每张是自己的文本', () => {
    for (const d of data.filter((x) => ['concat', 'lmprompt', 'direct-trigger'].includes(x.kind))) {
      expect([d.id, d.r.status, d.r.positive]).toEqual([d.id, 'ok', d.text])
    }
    // 只连到负向时，正向是普通文本，通配符文本不会混入
    for (const d of data.filter((x) => x.kind === 'negative')) expect(d.r.positive).toBe('plain positive, 1girl')
  })

  it('一次选择后应用到所有唯一匹配的图片（不要求工作流结构相同），并说明其余图片的原因', () => {
    const manual: Record<string, ManualPrompt> = {}
    // 3 张用户手动修改过的图片
    for (const d of data.filter((x) => x.kind === 'mystery').slice(1, 4)) manual[d.id] = { positive: 'user edited text', label: null, edited: true }
    const rep = ruleReport(rule, pickFrom.id, images, manual, {})
    expect(rep.total).toBe(100)
    expect(rep.edited).toBe(3)
    expect(rep.missing).toBe(10)
    expect(rep.ambiguous).toBe(5)
    expect(rep.negative).toBe(10)
    // 拼接 / LoraManager / 中断追踪的 50 张已自动得到相同文本
    expect(rep.same).toBe(50)
    // 其余不认识采样器的 21 张（25 - 当前 1 - 手动 3）全部可应用，节点 ID 不同的也包括在内
    expect(rep.targets).toHaveLength(21)
    expect(rep.targets.length + rep.same + rep.edited + rep.missing + rep.ambiguous + rep.negative + rep.autoKept + rep.idMismatch + rep.noMeta).toBe(99)
    // 每张图片读取自己的文本，而不是复制第一张
    const byId = new Map(data.map((d) => [d.id, d.text]))
    for (const t of rep.targets) expect(t.c.text).toBe(byId.get(t.id))
    expect(new Set(rep.targets.map((t) => t.c.text)).size).toBe(21)
    // 应用后：手动修改的保持不变
    for (const t of rep.targets) manual[t.id] = { positive: t.c.text, label: t.c.label, rule: t.c.rule }
    expect(manual[data.filter((x) => x.kind === 'mystery')[1].id].positive).toBe('user edited text')
  })

  it('严格匹配节点 ID：同时校验类型与字段', () => {
    const strict = { ...rule, strictId: true }
    const shifted = data.find((d) => d.kind === 'mystery' && d.id !== pickFrom.id && !d.r.candidates.some((c) => c.rule.nodeId === '3'))!
    expect(rule.nodeId).toBe('3')
    expect(matchRuleDetail(strict, shifted.r).reason).toBe('missing')
    const same = data.find((d) => d.kind === 'concat' && d.r.candidates.some((c) => c.rule.nodeId === '3'))!
    expect(matchRuleDetail(strict, same.r)).toMatchObject({ reason: 'ok', c: { text: same.text } })
    // ID 存在但是其他类型的节点
    const other = data.find((d) => d.kind === 'missing' && d.r.nodeTypes?.['5'])!
    expect(matchRuleDetail({ ...strict, nodeId: '5' }, other.r)).toMatchObject({ reason: 'id-mismatch', classType: 'Lora Loader (LoraManager)' })
  })

  it('保存的来源规则：重启后重新读取仍有效；自动结果可靠时不覆盖，只提示差异', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ce-rules-'))
    const file = sourceRulesPath(dir)
    const saved: SavedSourceRule = { id: 'r1', name: '通配符展开后文本', enabled: true, rule, created_at: new Date().toISOString() }
    saveSourceRules(file, [saved])
    // 模拟重启：重新扫描 + 从工作区重新读取规则
    const rules = loadSourceRules(file)
    expect(rules).toEqual([saved])
    const fresh = dataset().map((d) => d.r)
    const hits = ruleHits(fresh, rules)
    const eff = fresh.map((im) => resolveEffective(im, undefined, hits[im.id]))
    data.forEach((d, i) => {
      if (d.kind === 'mystery') expect([d.id, eff[i].status, eff[i].positive, !!eff[i].viaRule]).toEqual([d.id, 'ok', d.text, true])
      if (d.kind === 'concat') expect(hits[d.id]).toBeUndefined() // 自动结果与规则相同
      if (d.kind === 'negative') expect([eff[i].positive, hits[d.id]]).toEqual(['plain positive, 1girl', undefined])
      if (d.kind === 'missing' || d.kind === 'two') expect(eff[i].status).not.toBe('ok')
    })
    // 规则与可靠的自动结果不同：保留自动结果并标记差异
    const tplRule: SavedSourceRule = { ...saved, id: 'r2', rule: data[0].r.candidates.find((c) => c.rule.field === 'wildcard_text')!.rule }
    const h = ruleHits([data[0].r], [tplRule])[data[0].id]
    expect(h).toMatchObject({ used: false, conflict: true })
    expect(resolveEffective(data[0].r, undefined, h).positive).toBe(data[0].text)
    // 禁用后不再使用
    expect(ruleHits(fresh, [{ ...saved, enabled: false }])).toEqual({})
  })

  it('规则文件格式不正确时拒绝保存；损坏的文件读取为空', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ce-rules-'))
    const file = sourceRulesPath(dir)
    expect(() => saveSourceRules(file, [{ id: 'x', rule: { kind: 'node', key: 'a' } }])).toThrow(/格式不正确/)
    writeFileSync(join(dir, 'broken.json'), '{oops')
    expect(loadSourceRules(join(dir, 'broken.json'))).toEqual([])
  })

  it('真实 PNG 文件扫描：100 张都能读取，结果进入后续分析', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ce-wild-'))
    data.forEach((d, i) => writeFileSync(join(dir, `${String(i).padStart(3, '0')}.png`), makePng({ prompt: JSON.stringify(workflow(d.kind as never, d.text, i % 3 ? 100 : 0)) })))
    const r = await new MiningScanner().scan([], [dir], false, () => {})
    expect(r.images).toHaveLength(100)
    const hits = ruleHits(r.images, [{ id: 'r1', name: 'x', enabled: true, rule, created_at: '' }])
    const ok = r.images.filter((im) => resolveEffective(im, undefined, hits[im.id]).status === 'ok')
    // 拼接 30 + LoraManager 10 + 中断追踪 10 + 按规则 25 + 只连负向（正向是普通文本）10
    expect(ok).toHaveLength(85)
  })
})
