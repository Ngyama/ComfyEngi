// 套图复刻（主进程部分）：草稿的图片读取、整套的计划、入队与最终工作流。
// 复刻 = 保留每张原图的 Prompt 片段、尺寸与顺序，用新的工作流、角色、服装、LoRA 配置、全局 / 画风与场景 Prompt 重新生成。
// 不继承原图的工作流、LoRA、Seed、Steps、CFG、Sampler、Scheduler、Denoise：这些全部来自新工作流（与套图任务相同的写入逻辑）。
// 每张图可以生成多次（变体），每个变体是一个独立单元，进入现有的执行队列（暂停、重试、提交快照、输出复制都相同）。不修改原图。

import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { defaultLoraConfig, effectiveLoraConfig } from '@shared/lora-config'
import { applyInputs, loraStem, newEntry, toggleDisableInputs, TRIGGER_DISABLE } from '@shared/mapping'
import type { ScannedImage } from '@shared/mining'
import { controlInputs, controlProblems, controlsOf, cutOf, isCut } from '@shared/node-controls'
import { applyLoraOverrides, SEED_MOD } from '@shared/planner'
import { compose, fillPlaceholders, joinParts, unescapeSeparator } from '@shared/prompt'
import { matchRule, type SavedSourceRule } from '@shared/prompt-source'
import { cameraKeysOf, countTagsOf, recognizeDraft, replicaPositive, type ImageRecognition } from '@shared/replica-recognize'
import { parseToken, splitTopLevel } from '@shared/tags'
import { expandOrder, imageOutfitId, imageSize, normalizeReplicaData, normalizeReplicaImage, originalPositive, outputStems, repeatOf, variantStem, type ReplicaData, type ReplicaImage, type ReplicaPlanCore, type ReplicaRecord, type ReplicaRow, type ReplicaUnitBrief, type RowState } from '@shared/replica'
import type { ApiWorkflow, Lora, Modules, Outfit, PlanUnit, Settings, Template, UnitMeta, Workflow } from '@shared/types'
import { diffWorkflow, findPromptInjectors, findTriggerPaths } from '@shared/workflow-analysis'
import { buildWorkflowInputs, outputDirOf, resolveLoraName, type FullPlan } from './plan'
import { scanImage } from './mining'
import type { Store } from './store'

export type { ReplicaRow, ReplicaUnitBrief, RowState }
export interface ReplicaPlan extends FullPlan, Omit<ReplicaPlanCore, 'units'> {}

const MAX_CANDIDATES = 12
const MAX_CANDIDATE_TEXT = 8000

/** 把读取结果转成草稿中的图片；只有来源规则能确定的才算可靠（用户保存的规则） */
export function imageFromScan(s: ScannedImage, rules: SavedSourceRule[] = []): ReplicaImage {
  let { status, positive, negative } = s
  const notes = [...s.notes]
  if (status !== 'ok') {
    for (const r of rules) {
      if (!r.enabled) continue
      const hit = matchRule(r.rule, s)
      if (hit) {
        positive = hit.text
        status = 'ok'
        notes.push(`按来源规则「${r.name}」读取`)
        break
      }
    }
  }
  return normalizeReplicaImage({
    path: s.id,
    name: s.name,
    status,
    positive,
    negative,
    source: s.source,
    notes,
    error: s.error,
    params: s.params ?? {},
    loras: s.loras ?? [],
    candidates: status === 'ok' ? [] : s.candidates.slice(0, MAX_CANDIDATES).map((c) => ({ key: c.key, label: c.label, text: c.text.slice(0, MAX_CANDIDATE_TEXT), role: c.role })),
  })
}

/** 原图的文件夹是否与输出目录相同（输出不能放到原图旁边） */
const sameDir = (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase()

function rowState(im: ReplicaImage, rec: ImageRecognition): { state: RowState; reason: string } {
  if (im.exclude) return { state: 'excluded', reason: '已排除' }
  if (!existsSync(im.path)) return { state: 'missing', reason: '原图不在原来的位置，请重新定位或排除' }
  if (im.status === 'error' && !im.confirmed) return { state: 'invalid', reason: im.error || '没有读取到 Prompt，请在第 1 步手动填写' }
  if (im.status === 'check' && !im.confirmed) return { state: 'confirm', reason: im.notes.at(-1) || '读取结果不确定，请在第 1 步确认来源' }
  if (rec.needs_fix) return { state: 'confirm', reason: rec.issues[0] ?? '识别结果需要确认' }
  return { state: 'valid', reason: '' }
}

function workflowOf(store: Store, data: ReplicaData): Workflow | null {
  const wid = data.workflow_id || store.getSetting('default_workflow_id')
  return wid ? store.get('workflows', wid) : null
}

/** Prompt 路径上的 TriggerWord Toggle 与直接拼接的 trigger_words：关闭注入后触发词完全由角色 Prompt 负责（换角色后不会再注入 Loader 的触发词） */
function withTriggerOff(wf: Workflow, off: boolean): Workflow {
  if (!off) return wf
  const api = wf.api_json ?? {}
  const extra = findPromptInjectors(api, wf.mapping ?? [])
    .filter((i) => i.kind === 'trigger_toggle' && i.polarity.length && !i.disabled)
    .map((i) => newEntry(TRIGGER_DISABLE, i.node, 'toggle_trigger_words'))
  const controls = controlsOf(wf)
  const gone = new Set(controls.bypass.map((b) => b.node))
  const cuts = findTriggerPaths(api, wf.mapping ?? [])
    .filter((p) => p.status === 'controllable' && !isCut(controls, p) && !gone.has(p.node) && !gone.has(p.loader))
    .map(cutOf)
  if (!extra.length && !cuts.length) return wf
  return { ...wf, mapping: [...wf.mapping, ...extra], controls: { ...controls, ...(cuts.length ? { trigger_cuts: [...(controls.trigger_cuts ?? []), ...cuts] } : {}) } }
}

const safeDirName = (s: string) => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || '未命名'

/** 最终 Prompt 的来源：全局 / 画风 → 场景 → 保留片段；新角色与服装固定插在第一组人数 Tag（1girl, solo 等）之后（见 replicaPositive） */
export const REPLICA_MODULE_LABELS: Record<string, string> = { global: '全局 / 画风', scene: '场景', camera: '保留片段', count: '人数（原图）', character: '角色', outfit: '服装' }

export function planForReplica(store: Store, rec: ReplicaRecord, settings?: Settings, dateStr?: string): ReplicaPlan {
  store.files?.scan()
  settings = settings ?? store.settings()
  const data = normalizeReplicaData(rec.data, { defaultWorkflowId: store.getSetting('default_workflow_id') ?? null })
  const name = rec.name || '未命名'
  const errors: string[] = []
  const warnings: string[] = []
  const templates = store.list('templates')
  const recog = recognizeDraft(data, cameraKeysOf(templates))

  // ---- 新角色、服装、全局与场景
  const character = data.character_id ? store.get('characters', data.character_id) : null
  if (!character) {
    const loraHint = Object.values(data.lora_overrides).some((o) => o?.name) ? '（已调整的角色 LoRA 不代表选择了角色）' : ''
    errors.push(data.character_id ? '选择的新角色已不在角色库中，请在第 3 步重新选择' : `请在第 3 步选择新角色：角色 Prompt 与角色 LoRA 都来自角色库中的角色${loraHint}`)
  }
  const outfits = new Map<number, Outfit | null>()
  const outfitOf = (id: number | null): Outfit | null => {
    if (id === null) return null
    if (!outfits.has(id)) {
      const o = store.get('outfits', id)
      outfits.set(id, o && o.character_id === data.character_id ? o : null)
    }
    return outfits.get(id)!
  }
  if (data.outfit_id !== null && character && !outfitOf(data.outfit_id)) errors.push('默认服装已不存在或不属于当前角色，请在第 3 步重新选择')
  const badOutfit = data.images.map((im, i) => [im, i] as const).filter(([im]) => !im.exclude && im.outfit_id != null && character && !outfitOf(im.outfit_id))
  if (badOutfit.length) errors.push(`${badOutfit.slice(0, 5).map(([im, i]) => `图 ${i + 1}（${im.name}）`).join('、')}${badOutfit.length > 5 ? ` 等 ${badOutfit.length} 张` : ''}指定的服装已不存在或不属于当前角色，请在第 3 步重新分配`)
  const tplOf = (id: number | null, kind: string, label: string): Template | null => {
    if (id === null) return null
    const t = templates.find((x) => x.id === id) ?? null
    if (!t) errors.push(`所选${label}已被删除，请在第 3 步重新选择`)
    else if (t.kind !== kind) errors.push(`所选${label}「${t.name}」不是${label}模板`)
    return t && t.kind === kind ? t : null
  }
  const g = tplOf(data.global_id, 'global', '全局 Prompt')
  const sc = tplOf(data.scene_id, 'scene', '场景')
  if (!data.images.length) errors.push('还没有导入图片')
  const wfBase = workflowOf(store, data)
  if (!wfBase) errors.push('请在第 3 步选择工作流')
  const wf = wfBase ? withTriggerOff(wfBase, data.disable_triggers) : null

  const trim = settings.trim_modules ?? true
  const posSep = unescapeSeparator(settings.pos_separator ?? ', ')
  const negSep = unescapeSeparator(settings.neg_separator ?? ', ')
  const moduleSep = unescapeSeparator(settings.pos_module_separator ?? settings.pos_separator ?? ', ')
  const fill = (s: string | undefined) => fillPlaceholders(s ?? '', character)
  const globalMod: [string, string] = [joinParts([fill(g?.positive), fill(data.global_text)], posSep, trim), joinParts([fill(g?.negative)], negSep, trim)]
  const sceneMod: [string, string] = [joinParts([fill(sc?.positive), fill(data.scene_text)], posSep, trim), joinParts([fill(sc?.negative)], negSep, trim)]

  // ---- 角色 LoRA：角色库中的 LoRA + 本草稿的调整（与套图任务相同）；工作流中的 LoRA 由下面的 LoRA 配置控制
  const loras: Lora[] = applyLoraOverrides((character?.loras ?? []).filter((l) => l.name), data.lora_overrides, 'lora')
  if (store.files) for (const l of loras) if (l.resource_id && !l.disabled) resolveLoraName(store, l, errors)

  // ---- 每张图、每个变体
  const stems = outputStems(data.images)
  const outDir = outputDirOf(store, data.output.dir || join('output', `复刻-${safeDirName(name)}${rec.id ? `-${rec.id}` : ''}`))
  const rows: ReplicaRow[] = data.images.map((im, index) => {
    const r = recog.images[index]
    const outfit = outfitOf(imageOutfitId(im, data.outfit_id))
    // 正向：固定规则，新角色与服装紧跟在人数 Tag（1girl, solo 等）之后；负面按设置的模块顺序
    const pos = replicaPositive({ global: globalMod[0], scene: sceneMod[0], retained: r.retained, character: character?.positive ?? '', outfit: outfit?.positive ?? '', count: countTagsOf(r) }, moduleSep, posSep, trim)
    const modules: Modules = {
      global: [pos.modules.global, globalMod[1]],
      scene: [pos.modules.scene, sceneMod[1]],
      camera: [pos.modules.camera, data.keep_source_negative ? im.negative : ''],
      character: ['', character?.negative ?? ''],
      outfit: ['', outfit?.negative ?? ''],
    }
    const positive = pos.positive
    const negative = compose(modules, settings!)[1]
    const { state, reason } = rowState(im, r)
    const repeat = repeatOf(im, data)
    return {
      index,
      path: im.path,
      name: im.name,
      state,
      reason,
      issues: r.issues,
      original_positive: originalPositive(im),
      original_negative: im.negative,
      prefix: r.prefix,
      cut: r.cut,
      cut_reason: r.cut_reason,
      removed_character: r.removed_character,
      removed_outfit: r.removed_outfit,
      removed_other: r.removed_other,
      retained: r.retained,
      retained_parts: r.retained_parts,
      manual: r.manual,
      positive,
      negative,
      positive_parts: pos.parts,
      size: imageSize(im, data.downscale),
      repeat,
      outfit: outfit?.name ?? '',
      outfit_source: im.outfit_id === undefined ? 'default' : 'image',
      output_name: variantStem(stems[index], 0, repeat),
      units: [],
      _modules: modules,
    } as ReplicaRow & { _modules: Modules }
  })
  const live = rows.filter((r) => r.state === 'valid')
  const order = expandOrder(rows.map((r) => (r.state === 'valid' ? r.repeat : 0)), data.repeat_order)
  const base = data.seed_base
  const units: PlanUnit[] = order.map(({ image, variant }, i) => {
    const row = rows[image] as ReplicaRow & { _modules: Modules }
    const im = data.images[image]
    const seed = (((base + i) % SEED_MOD) + SEED_MOD) % SEED_MOD
    row.units.push(i)
    const output_name = variantStem(stems[image], variant, row.repeat)
    const meta: UnitMeta = {
      task: name,
      character: character?.name ?? '',
      story: '',
      genre: '',
      section: '复刻',
      item: im.name,
      item_no: image + 1,
      outfit: row.outfit,
      expression: '',
      camera: '',
      male: false,
      male_templates: [],
      ...(sc ? { scene: sc.name } : {}),
      n: variant + 1,
      of: row.repeat,
      index: i + 1,
      seed,
      source_image: im.path,
      output_name,
      replica: { original_positive: row.original_positive, original_negative: im.negative, removed: [...row.removed_character, ...row.removed_outfit, ...row.removed_other], manual: row.manual, retained: row.retained, prefix: row.prefix, variant: variant + 1, variants: row.repeat },
    }
    return {
      section: 'replica',
      item_index: image,
      item_label: row.repeat > 1 ? `${im.name} · 第 ${variant + 1}/${row.repeat} 次` : im.name,
      sub_index: variant,
      modules: row._modules,
      positive: row.positive,
      negative: row.negative,
      loras,
      meta,
      index: i,
      seed,
      ...(row.size.width && row.size.height ? { width: row.size.width, height: row.size.height } : {}),
    }
  })
  for (const r of rows) delete (r as Partial<ReplicaRow & { _modules: Modules }>)._modules

  let seedMapped = false
  let sizeMapped = false
  if (wf) {
    if (!wf.mapping.some((m) => m.source === 'positive')) errors.push(`工作流「${wf.name}」没有映射正向 Prompt，无法写入每张图的 Prompt`)
    if (!wf.mapping.some((m) => m.source === 'negative') && units.some((u) => u.negative.trim())) warnings.push(`工作流「${wf.name}」没有映射负面 Prompt，负面内容不会提交`)
    seedMapped = wf.mapping.some((m) => m.source === 'seed')
    sizeMapped = wf.mapping.some((m) => m.source === 'width') && wf.mapping.some((m) => m.source === 'height')
    // LoRA：与套图任务完全相同的写入（标准 Loader、Lora Loader (LoraManager) 列表、高级映射槽位），配置按工作流保存在草稿中
    const savedCfg = data.lora_configs[String(wfBase!.id)]
    // 没有调整过 LoRA 配置时同样提示：新工作流里可能固定着其他角色的 LoRA
    const eff = effectiveLoraConfig(savedCfg, wf.api_json ?? {}, wf.mapping ?? [])
    const defaults = defaultLoraConfig(wf.api_json ?? {}, wf.mapping ?? []).entries
    const touched = eff.entries.some((e) => !e.enabled && defaults.find((d) => d.key === e.key)?.enabled)
    const activeLoras = loras.filter((l) => !l.disabled)
    if (eff.char_targets?.lora1?.replace && !activeLoras.length) warnings.push(`已设置替换工作流中的「${loraStem(eff.entries.find((e) => e.key === eff.char_targets!.lora1!.replace)?.name ?? '')}」，但没有启用的角色 LoRA，替换不会生效，工作流中的这个 LoRA 继续加载`)
    if (activeLoras.length && !eff.char_targets?.lora1?.replace && !touched) {
      const kept = eff.entries.filter((e) => e.enabled).map((e) => e.name)
      if (kept.length) warnings.push(`工作流原有的 LoRA（${kept.join('、')}）都会继续加载。如果其中有其他角色的 LoRA，请在第 3 步替换或关闭它`)
    }
    buildWorkflowInputs(store, wf, units, { savedCfg, settings, dateStr, errors, warnings })
    const prefixDir = `ComfyEngi复刻/${safeDirName(name)}`
    if (units.length && !wf.mapping.some((m) => m.source === 'filename_prefix')) warnings.push(`工作流「${wf.name}」没有映射「输出文件前缀」：ComfyUI 中的文件名不区分变体（复制到输出目录时仍按原图名称与变体编号保存）`)
    for (const u of units) if (u.inputs) u.inputs = u.inputs.map((x) => (x.source === 'filename_prefix' ? { ...x, value: `${prefixDir}/${u.meta.output_name}` } : x))
    if (!seedMapped && units.some((u) => (u.meta.of ?? 1) > 1)) warnings.push(`工作流「${wf.name}」没有映射 Seed：同一张图的多个变体会使用工作流中固定的 Seed，结果可能完全相同。请在工作流映射中添加 Seed`)
    if (!sizeMapped && units.some((u) => u.width)) warnings.push(`工作流「${wf.name}」没有映射「生成宽度 / 高度」：每张图的原图尺寸不会生效（使用工作流默认尺寸）。可在工作流页面用「自动识别」添加`)
  }
  if (outDir) {
    for (const u of units) u.meta.output_dir = outDir
    const clash = [...new Set(data.images.filter((im) => !im.exclude).map((im) => dirname(im.path)))].find((d) => sameDir(d, outDir))
    if (clash) errors.push(`输出目录不能是原图所在的文件夹（${clash}），请换一个目录`)
  }
  const removedLora = live.filter((r) => r.removed_other.some((t) => /^<lora:/i.test(t))).length
  if (removedLora) warnings.push(`有 ${removedLora} 张图的原 Prompt 含有 <lora:…> 文字，已从保留片段中删除：LoRA 只按第 3 步的配置加载`)
  const withSyntax = live.filter((r) => /<lora:/i.test(r.retained)).length
  if (withSyntax) warnings.push(`有 ${withSyntax} 张图的保留片段含有 <lora:…> 文字：ComfyUI 不会因此加载 LoRA，这段文字可能属于原角色`)
  // 保留片段与新角色、服装 Prompt 重复：只提示，不删除
  const insertKeys = new Set(splitTopLevel([character?.positive, ...[...outfits.values()].map((o) => o?.positive)].filter(Boolean).join(', ')).map((p) => parseToken(p)?.key).filter(Boolean))
  const dupes = new Set<string>()
  let dupeRows = 0
  for (const r of live) {
    const hit = splitTopLevel(r.retained).map((p) => parseToken(p)?.key).filter((k): k is string => !!k && insertKeys.has(k))
    if (hit.length) dupeRows++
    hit.forEach((k) => dupes.add(k))
  }
  if (dupeRows) warnings.push(`有 ${dupeRows} 张图的保留片段与新角色或服装 Prompt 重复（${[...dupes].slice(0, 5).join('、')}），可能是原角色 / 服装残留。需要时在第 2 步标记删除`)
  const uncertainSize = live.filter((r) => r.size.state === 'confirm').length
  if (uncertainSize) warnings.push(`有 ${uncertainSize} 张图的尺寸只来自图片实际像素（可能经过放大）${data.downscale === 1 ? '：原图放大过时，请在第 3 步设置缩小倍率' : `，已按缩小倍率 ${data.downscale} 换算`}；也可以在第 2 步逐张修改`)
  const rounded = live.filter((r) => r.size.rounded).length
  if (rounded) warnings.push(`有 ${rounded} 张图的原图尺寸 ÷ ${data.downscale} 不是 8 的整数倍，已取最接近的 8 的倍数（工作流放大后与原图尺寸可能略有差别）`)
  const noSize = live.filter((r) => r.size.state === 'missing').length
  if (noSize) warnings.push(`有 ${noSize} 张图没有尺寸信息，使用工作流默认尺寸`)
  const blocked = rows.filter((r) => r.state !== 'valid' && r.state !== 'excluded').length
  if (!units.length && data.images.length && !errors.length) errors.push(blocked ? `没有可以生成的图片：${blocked} 张需要处理（见第 2 步）` : '没有可以生成的图片')
  if (blocked && units.length) warnings.push(`有 ${blocked} 张图片还需要处理，入队时不包含它们`)

  const defaultOutfit = outfitOf(data.outfit_id)
  return {
    units,
    errors,
    warnings,
    workflow: wf,
    rows,
    output_dir: outDir,
    unit_list: units.map((u) => ({ index: u.index, image: u.item_index, variant: u.sub_index, of: u.meta.of, seed: u.seed, output_name: u.meta.output_name ?? '' })),
    summary: {
      character: character ? { name: character.name, positive: character.positive ?? '', negative: character.negative ?? '' } : null,
      outfit: defaultOutfit ? { name: defaultOutfit.name, positive: defaultOutfit.positive ?? '' } : null,
      global: g || data.global_text.trim() ? { name: g?.name ?? '', positive: globalMod[0] } : null,
      scene: sc || data.scene_text.trim() ? { name: sc?.name ?? '', positive: sceneMod[0] } : null,
      loras: loras.map((l) => ({ name: l.name, strength: l.strength, clip: l.strength_clip ?? l.strength, enabled: !l.disabled })),
      images: data.images.length,
      valid: live.length,
      repeat: data.repeat,
      seed_mapped: seedMapped,
      size_mapped: sizeMapped,
    },
    recognition: { prefix_raw: recog.prefix_raw, prefix_auto: recog.prefix_auto, prefix_matches: recog.prefix_matches, usable: recog.usable, character: recog.character, outfit: recog.outfit, kept: recog.kept },
  }
}

/** 冻结为一个执行队列项：之后修改草稿不影响已入队的内容 */
export function enqueueReplica(store: Store, rec: ReplicaRecord, settings?: Settings): { runId: number | null; plan: ReplicaPlan } {
  const plan = planForReplica(store, rec, settings)
  if (plan.errors.length || !plan.workflow) return { runId: null, plan }
  const wf = plan.workflow
  const runId = store.createRun(null, `复刻 · ${rec.name || '未命名'}`, wf.name, wf.api_json, wf.mapping, plan.units.map((u) => ({ ...u, inputs: u.inputs ?? [] })))
  return { runId, plan }
}

/** 入队前预览某个单元的最终工作流（与提交时相同的构建方式） */
export function finalReplicaWorkflow(store: Store, rec: ReplicaRecord, unitIndex: number) {
  const plan = planForReplica(store, rec)
  if (!plan.workflow) throw new Error('请选择工作流')
  const u = plan.units[unitIndex]
  if (!u) throw new Error(plan.units.length ? `没有第 ${unitIndex + 1} 张` : '没有可以生成的图片')
  if (!u.inputs) throw new Error(`工作流配置有错误，无法生成最终 JSON：${plan.errors.slice(0, 3).join('；')}`)
  const json = applyInputs(plan.workflow.api_json, u.inputs)
  const { changes, unchanged } = diffWorkflow(plan.workflow.api_json, json, u.inputs)
  return { json, index: unitIndex, count: plan.units.length, label: u.item_label, seed: u.seed, errors: plan.errors, workflow: plan.workflow.name, changes, unchanged: unchanged.length }
}

/** 工作流页面的最终预览：只包含工作流级的节点控制（覆盖、绕过、禁止触发词注入） */
export function workflowPreview(wf: Workflow): { json: ApiWorkflow; errors: string[]; changes: ReturnType<typeof diffWorkflow>['changes']; unchanged: number } {
  const api = wf.api_json ?? {}
  const problems = controlProblems(api, wf.mapping ?? [], controlsOf(wf))
  const inputs = buildControlOnlyInputs(wf)
  const json = applyInputs(api, inputs)
  const { changes, unchanged } = diffWorkflow(api, json, inputs)
  return { json, errors: problems.filter(([l]) => l === 'error').map(([, m]) => m), changes, unchanged: unchanged.length }
}

function buildControlOnlyInputs(wf: Workflow) {
  const api = wf.api_json ?? {}
  const trigger = (wf.mapping ?? []).filter((m) => m.source === TRIGGER_DISABLE).flatMap((m) => toggleDisableInputs(String(m.node), api[String(m.node)]))
  return [...trigger, ...controlInputs(api, controlsOf(wf))]
}

// ---------------- 图片位置

/** 重新定位：在文件夹（含子文件夹）中按文件名查找不在原位置的图片；读取后 Prompt 不同的不替换，只报告 */
export async function relocateImages(data: ReplicaData, folder: string): Promise<{ images: ReplicaImage[]; relocated: number; mismatched: string[]; notFound: string[] }> {
  const index = new Map<string, string>()
  const walk = (d: string, depth: number) => {
    if (depth > 8) return
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isFile() && !index.has(e.name.toLowerCase())) index.set(e.name.toLowerCase(), p)
      else if (e.isDirectory() && !e.name.startsWith('.')) walk(p, depth + 1)
    }
  }
  walk(folder, 0)
  const images = [...data.images]
  let relocated = 0
  const mismatched: string[] = []
  const notFound: string[] = []
  for (let i = 0; i < images.length; i++) {
    const im = images[i]
    if (existsSync(im.path)) continue
    const p = index.get(im.name.toLowerCase())
    if (!p) {
      notFound.push(im.name)
      continue
    }
    // 按文件名自动匹配时要求能核对：原图有 Prompt、找到的同名文件没有元数据时，不认为是同一张图
    const r = await relocateOne(im, p, true)
    if (r) {
      images[i] = r
      relocated++
    } else mismatched.push(im.name)
  }
  return { images, relocated, mismatched, notFound }
}

/** 指定一张图的新位置：元数据中的 Prompt 与保存的一致才更新路径（没有元数据的图片不比较） */
export async function relocateOne(im: ReplicaImage, path: string, strict = false): Promise<ReplicaImage | null> {
  if (!statSync(path).isFile()) return null
  const s = await scanImage(path)
  if (strict && im.status !== 'error' && s.status === 'error') return null
  if (im.status !== 'error' && s.status !== 'error' && s.positive !== im.positive && !im.confirmed) return null
  return { ...im, path, name: im.name }
}
