import { readFileSync, existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
// 任务 → 生成计划（预览与入队共用），以及把计划冻结写入执行队列。

import { applyInputs, findLoraLoaders, renderPrefix, isStackBinding, loraStem, mappingValues, parseLoraSource, slotLora, slotState, SOURCE_LABELS, stackReplaceTarget, validateMapping } from '@shared/mapping'
import { expandTask, normalizeTaskData, PlanLibrary } from '@shared/planner'
import { MODULE_LABELS } from '@shared/prompt'
import type { ApiWorkflow, InputChange, Lora, MappingEntry, PlanUnit, Settings, Task, TaskData, Workflow } from '@shared/types'
import { controllableLoaders, effectiveLoraConfig, loraConfigInputs, loraConfigProblems, rolePlacement, type CharRole, type RoleState, type WfLoraConfig } from '@shared/lora-config'
import { controlInputs, controlProblems, controlsOf, mergeControlInputs, withTriggerCuts } from '@shared/node-controls'
import { diffWorkflow, findPromptInjectors, loaderChangedBy } from '@shared/workflow-analysis'
import type { Store } from './store'

export function loadPlanLibrary(store: Store): PlanLibrary {
  return new PlanLibrary(store.list('templates'), store.list('characters'), store.list('outfits'), store.list('stories'))
}

export function resolveWorkflow(store: Store, workflowId: number | null | undefined, none = false): Workflow | null {
  if (none) return null // 任务中清除了工作流选择
  const wid = workflowId || store.getSetting('default_workflow_id')
  return wid ? store.get('workflows', wid) : null
}

export interface FullPlan {
  units: PlanUnit[]
  errors: string[]
  warnings: string[]
  workflow: Workflow | null
}

/**
 * LoRA 槽位检查（LoRA 是工作流参数，写入 LoRA Loader 节点）：
 * - 启用的 LoRA 必须绑定至少一个 Loader，否则不能入队（不静默丢弃）；
 * - 绑定了 Loader、但这张图不需要加载的槽位（未选择、已禁用、第二角色未出场）要把强度写 0，
 *   只有当绑定节点的全部强度输入都已映射时才能安全禁用，否则不能入队；
 * - 强度映射不完整、只能识别 lora_name 的自定义节点给出提示；没有被映射的 Loader（工作流中固定的 LoRA）保持原样，不检查。
 */
/**
 * LoRA 资源 → 写入工作流的名称（检查名称合法、文件存在）；失败时记录错误并保留原名称。
 * stack：写入多 LoRA Loader（LoraManager 等）的列表。列表只写文件名（loraStem），按文件名查找，
 * 不需要 ComfyUI 相对路径，所以不要求设置 comfyName，名称取自资源的实际文件；单 LoRA Loader 的 lora_name 需要相对路径，仍要求 comfyName。
 */
export function resolveLoraName(store: Store, l: Lora, errors: string[], stack = false): string {
  if (!store.files || !l.resource_id) return l.name
  try {
    if (!/^[a-f0-9-]{36}$/i.test(l.resource_id)) throw new Error('无效 LoRA 资源 ID')
    const r = JSON.parse(readFileSync(join(store.files.root,'loras/metadata',l.resource_id+'.json'),'utf8'))
    if (stack) {
      if (!existsSync(r.path)) throw new Error('模型文件缺失')
      l.name = String(r.path).split(/[\\/]/).pop() || l.name
      return l.name
    }
    if (!r.comfyName || /^(?:[A-Za-z]:|[\\/])/.test(r.comfyName) || r.comfyName.split(/[\\/]/).includes('..')) throw new Error('请配置 ComfyUI 相对模型名称（这个 LoRA 写入单 LoRA Loader 的 lora_name，需要 models/loras 下的相对路径，可在 LoRA 管理中设置）')
    if (!existsSync(r.path)) throw new Error('模型文件缺失')
    l.name = r.comfyName
  } catch(e) { const msg = `LoRA ${l.name}: ${(e as Error).message}`; if (!errors.includes(msg)) errors.push(msg) }
  return l.name
}

/** 任务的输出目录：填写的绝对路径；相对路径相对于工作区；空则为工作区 output/（不在工作区模式下时不复制） */
export function outputDirOf(store: Store, dir?: string): string {
  const d = (dir ?? '').trim()
  if (d && isAbsolute(d)) return d
  if (!store.files) return ''
  return join(store.files.root, d || 'output')
}

/** 第二角色 LoRA 的名称（即使所有图片中第二角色都未出场，也需要它来停用工作流中关联的条目） */
function secondLoraName(store: Store, data: TaskData): string | undefined {
  const c2 = data.second_character_id ? store.get('characters', data.second_character_id) : null
  const o = data.lora_overrides?.second_lora1
  return o?.name || c2?.loras?.find((l) => l.name)?.name
}

function checkLoraSlots(wf: Workflow, units: PlanUnit[], errors: string[], warnings: string[], once: (list: string[], msg: string) => void, handled: Set<CharRole> = new Set()) {
  const loaders = new Map(findLoraLoaders(wf.api_json ?? {}).map((l) => [l.node, l]))
  const bind = new Map<string, { nodes: Set<string>; strengths: Set<string>; stack: Map<string, MappingEntry> }>()
  for (const m of wf.mapping ?? []) {
    const p = parseLoraSource(m.source)
    if (!p) continue
    const b = bind.get(p.prefix) ?? { nodes: new Set<string>(), strengths: new Set<string>(), stack: new Map<string, MappingEntry>() }
    if (p.field === 'name') b.nodes.add(String(m.node))
    else b.strengths.add(`${m.node}.${m.input}`)
    if (isStackBinding(m)) b.stack.set(String(m.node), m)
    bind.set(p.prefix, b)
  }
  const slotTitle = (prefix: string) => (SOURCE_LABELS[`${prefix}_name`] ?? prefix).replace(/ 名称$/, '')
  for (const u of units) {
    const active = new Map<string, string>()
    u.loras.forEach((l, i) => { if (slotLora(u, 'lora', i + 1)) active.set(`lora${i + 1}`, `主角色「${u.meta.character}」的 LoRA「${l.name}」`) })
    ;(u.loras2 ?? []).forEach((l, i) => { if (slotLora(u, 'second_lora', i + 1)) active.set(`second_lora${i + 1}`, `第二角色「${u.meta.character2 ?? ''}」的 LoRA「${l.name}」`) })
    for (const t of u.task_loras ?? []) if (slotLora(u, 'task_lora', t.slot)) active.set(`task_lora${t.slot}`, `任务 LoRA「${t.label}」（${t.name}）`)
    for (const [prefix, label] of active) {
      const b = bind.get(prefix)
      if (!b?.nodes.size && handled.has(prefix as CharRole)) continue // 由任务的 LoRA 配置加载（关联已有条目或追加）
      if (!b?.nodes.size) {
        once(errors, `${label}已启用，但当前工作流没有绑定 LoRA Loader（${slotTitle(prefix)}）：请在套图任务的 LoRA 配置中绑定 Loader，或在本任务中禁用它`)
        continue
      }
      for (const node of b.nodes) {
        const ld = loaders.get(node)
        if (!wf.api_json?.[node]) once(errors, `${slotTitle(prefix)} 绑定的节点 ${node} 不存在于当前工作流中，请重新绑定`)
        else if (!ld) once(warnings, `${slotTitle(prefix)} 绑定的节点 ${node}（${wf.api_json[node].class_type}）不是能识别的 LoRA Loader，请人工确认写入的输入是否正确`)
        else if (ld.support === 'partial') once(warnings, `${slotTitle(prefix)} 绑定的节点 ${node}（${ld.class_type}）只识别到 lora_name，权重无法由本软件控制，请人工确认`)
        else if (ld.support === 'unknown') once(warnings, `${slotTitle(prefix)} 绑定的节点 ${node}（${ld.class_type}）的结构无法识别，请人工确认写入是否生效`)
        else if (ld.support === 'stack') {
          const e = b.stack.get(node)
          if (!e) once(errors, `${slotTitle(prefix)} 绑定的节点 ${node} 是多 LoRA Loader，但映射不是列表绑定：请在 LoRA 配置中重新绑定`)
          else if (!stackReplaceTarget(e)) {
            const stem = loraStem(slotLora(u, parseLoraSource(`${prefix}_name`)!.kind, parseLoraSource(`${prefix}_name`)!.slot)?.name ?? '')
            if ((ld.entries ?? []).some((x) => x.name.toLowerCase() === stem.toLowerCase()))
              once(warnings, `${slotTitle(prefix)} 追加到 Loader ${node} 时，列表中已有同名 LoRA「${stem}」：将直接更新该条目（不会重复加载）`)
          }
        } else {
          const missing = ld.strengths.filter((inp) => !b.strengths.has(`${node}.${inp}`))
          if (missing.length) once(warnings, `${slotTitle(prefix)} 绑定的 Loader ${node} 的 ${missing.join('、')} 没有映射，这些权重会保持工作流原值`)
        }
      }
    }
    for (const [prefix, b] of bind) {
      if (active.has(prefix) || !b.nodes.size) continue
      const p = parseLoraSource(`${prefix}_name`)!
      if (slotState(u, p.kind, p.slot) === 'absent') continue // 本任务没有配置这个任务 LoRA：绑定的 Loader 保持工作流原值
      for (const node of b.nodes) {
        const ld = loaders.get(node)
        // 多 LoRA Loader 总能安全禁用（停用条目或不追加）；标准 Loader 需要全部强度输入都已映射（写 0）
        const safe = ld?.support === 'stack' || (!!ld && ld.support !== 'partial' && ld.support !== 'unknown' && ld.strengths.length > 0 && ld.strengths.every((inp) => b.strengths.has(`${node}.${inp}`)))
        if (!safe)
          once(errors, `${slotTitle(prefix)} 在部分图片中没有要加载的 LoRA（未选择、已禁用或第二角色未出场），但绑定的 Loader ${node} 无法安全禁用：请映射它的全部强度输入（将写为 0），或移除这个绑定`)
      }
    }
  }
}

/**
 * 工作流相关的检查与写入值（套图任务和套图复刻共用）：LoRA 配置、映射、节点控制的问题写入 errors / warnings，
 * 每张图实际写入的值写入 u.inputs。配置有错误时 inputs 为 undefined（预览不会显示没有实际应用的内容）。
 */
export function buildWorkflowInputs(store: Store, wf: Workflow, units: PlanUnit[], opts: { savedCfg?: WfLoraConfig; name2?: string; prefix?: string; sizeHint?: boolean; settings: Settings; dateStr?: string; errors: string[]; warnings: string[] }) {
  const { settings, dateStr, errors, warnings, name2 } = opts
  const seen = new Set<string>()
  const once = (list: string[], msg: string) => {
    if (!seen.has(msg)) list.push(msg)
    seen.add(msg)
  }
  // 任务的 LoRA 配置（按工作流保存；没有保存时使用工作流中已有的 LoRA）
  const cfg = effectiveLoraConfig(opts.savedCfg, wf.api_json ?? {}, wf.mapping ?? [])
  // 在 LoRA 配置中从 LoRA 管理添加或替换的条目：所在 Loader 是多 LoRA 列表时只写文件名，不需要 ComfyUI 相对路径
  const stackNodes = new Set(controllableLoaders(wf.api_json ?? {}, wf.mapping ?? []).filter((l) => l.support === 'stack').map((l) => l.node))
  cfg.entries = cfg.entries.map((e) => (e.resource_id && e.enabled ? { ...e, name: resolveLoraName(store, { name: e.name, resource_id: e.resource_id, strength: e.strength }, errors, stackNodes.has(e.node)) } : e))
  const rolesOf = (u: PlanUnit) => {
    const r: Partial<Record<CharRole, RoleState & { label: string }>> = {}
    if (u.loras.length) r.lora1 = { name: u.loras[0].name, load: slotLora(u, 'lora', 1) ?? null, label: `主角色「${u.meta.character}」的 LoRA` }
    if (name2) r.second_lora1 = { name: name2, load: u.loras2 ? (slotLora(u, 'second_lora', 1) ?? null) : null, label: '第二角色的 LoRA' }
    return r
  }
  const handled = new Set<CharRole>()
  for (const u of units) {
    const p = loraConfigProblems(wf.api_json ?? {}, wf.mapping ?? [], cfg, rolesOf(u))
    p.errors.forEach((m) => once(errors, m))
    p.warnings.forEach((m) => once(warnings, m))
    p.handled.forEach((x) => handled.add(x))
  }
  checkLoraSlots(wf, units, errors, warnings, once, handled)
  // Prompt 节点只拼接部分模块时，检查有内容的模块是否都有去处
  // 模板动作卡的正面 Prompt 是一整段（顺序由模板决定），不能再按模块拆到多个节点
  const splitPos = wf.mapping.filter((m) => m.source === 'positive' && (m.modules ?? []).length)
  if (splitPos.length && units.some((u) => u.from_template))
    once(errors, `工作流「${wf.name}」的正面 Prompt 映射按模块拆分（节点 ${[...new Set(splitPos.map((m) => m.node))].join('、')}），模板动作卡需要写入完整的正面 Prompt。请在工作流的高级映射中改为完整 Prompt`)
  // 手改的单张 Prompt 同样是一整段
  const splitAny = wf.mapping.filter((m) => (m.source === 'positive' || m.source === 'negative') && (m.modules ?? []).length)
  if (splitAny.length && units.some((u) => u.manual))
    once(errors, `工作流「${wf.name}」的 Prompt 映射按模块拆分（节点 ${[...new Set(splitAny.map((m) => m.node))].join('、')}），手改过 Prompt 的图片需要写入完整的 Prompt。请在工作流的高级映射中改为完整 Prompt，或在预览中恢复自动 Prompt`)
  for (const src of ['positive', 'negative']) {
    const entries = wf.mapping.filter((m) => m.source === src)
    if (src === 'positive' && units.some((u) => u.from_template)) continue
    if (!entries.length || entries.some((m) => !(m.modules ?? []).length)) continue
    const covered = new Set(entries.flatMap((m) => m.modules))
    const idx = src === 'positive' ? 0 : 1
    for (const u of units) for (const [k, v] of Object.entries(u.modules)) {
      if (v[idx]?.trim() && !covered.has(k)) once(warnings, `工作流「${wf.name}」的${src === 'positive' ? '正面' : '负面'} Prompt 映射没有包含模块「${MODULE_LABELS[k] ?? k}」，其内容不会提交`)
    }
  }
  const msgs = validateMapping(wf.api_json ?? {}, wf.mapping ?? [])
  for (const [lvl, msg] of msgs) (lvl === 'error' ? errors : warnings).push(`工作流「${wf.name}」${msg}`)
  // 节点控制：配置失效（节点 ID 或结构变化）、类型错误、与映射或 LoRA 配置冲突都阻止入队，不会静默跳过
  const controls = controlsOf(wf)
  const ctlMsgs = controlProblems(wf.api_json ?? {}, wf.mapping ?? [], controls)
  for (const [lvl, msg] of ctlMsgs) (lvl === 'error' ? errors : warnings).push(`工作流「${wf.name}」${msg}`)
  const gone = new Set(controls.bypass.map((b) => b.node))
  if (gone.size) {
    const loaders = controllableLoaders(wf.api_json ?? {}, wf.mapping ?? [])
    for (const u of units)
      for (const [role, r] of Object.entries(rolesOf(u))) {
        if (!r.load) continue
        const p = rolePlacement(cfg, loaders, role as CharRole, r.name)
        if (p.kind !== 'none' && gone.has(p.node)) once(errors, `工作流「${wf.name}」节点绕过：${r.label}「${loraStem(r.name)}」要由 Loader #${p.node} 加载，但这个节点已绕过，LoRA 不会生效。请恢复节点，或在本任务中停用这个 LoRA`)
      }
  }
  if (!msgs.some(([l]) => l === 'error')) {
    for (const u of units) u.inputs = [...mappingValues(u, wf.mapping, settings, dateStr, wf.api_json), ...loraConfigInputs(wf.api_json ?? {}, wf.mapping ?? [], cfg, rolesOf(u))]
    // Prompt 路径上不受控制的节点：明确提示（用户可能有意使用触发词节点，只提示不阻止）
    for (const inj of findPromptInjectors(withTriggerCuts(wf.api_json ?? {}, controls), wf.mapping ?? [])) {
      if (!inj.polarity.length || inj.disabled || gone.has(inj.node)) continue
      once(warnings, `工作流「${wf.name}」${inj.message}`)
      if (inj.source_node && units.some((u) => loaderChangedBy(wf.api_json, u.inputs ?? [], inj.source_node!)))
        once(warnings, `本任务的 LoRA 配置改变了 #${inj.source_node} 实际加载的 LoRA：TriggerWord Toggle #${inj.node} 会绕过工作流中保存的开关状态，输出这些 LoRA 的全部触发词（例如同一 LoRA 的多套服装），可能造成服装特征混合。如不需要，请在工作流检查中禁止它注入`)
    }
    // 任务的文件名前缀：写入工作流映射的输出文件名前缀（ComfyUI 在它自己的 output 目录下按前缀保存）
    const prefix = opts.prefix
    if (prefix) {
      if (!wf.mapping.some((m) => m.source === 'filename_prefix'))
        once(warnings, `工作流「${wf.name}」没有映射「输出文件前缀」，任务中设置的文件名前缀不会生效（最终图片仍会复制到输出目录）。可在工作流映射中用「自动识别」添加`)
      for (const u of units) u.inputs = u.inputs!.map((x) => (x.source === 'filename_prefix' ? { ...x, value: renderPrefix(prefix, u, dateStr) } : x))
    }
    // 动作的尺寸配置需要工作流映射「生成宽度 / 高度」才会生效
    if (opts.sizeHint && units.some((u) => u.width)) {
      const missing = (['width', 'height'] as const).filter((s) => !wf.mapping.some((m) => m.source === s))
      if (missing.length)
        once(warnings, `工作流「${wf.name}」没有映射「${missing.map((s) => (s === 'width' ? '生成宽度' : '生成高度')).join('、')}」，动作中设置的尺寸不会生效（将使用工作流默认尺寸）。可在工作流页面用「自动识别」添加`)
    }
    // 节点覆盖与绕过：最后接到每张图的写入值之后，随计划一起冻结。配置有问题时不构建（预览不会显示没有实际应用的内容）
    if (ctlMsgs.some(([l]) => l === 'error')) for (const u of units) u.inputs = undefined
    else {
      const ctl = controlInputs(wf.api_json ?? {}, controls)
      for (const u of units) {
        const merged = mergeControlInputs(wf.api_json ?? {}, u.inputs!, ctl)
        merged.conflicts.forEach((m) => once(errors, `工作流「${wf.name}」${m}`))
        u.inputs = merged.conflicts.length ? undefined : merged.inputs
      }
    }
  }
}

/** units 中的 inputs 就是之后实际写入工作流的值；预览界面显示的也是这份数据 */
export function planForTask(store: Store, task: Task, settings?: Settings, dateStr?: string): FullPlan {
  store.files?.scan()
  settings = settings ?? store.settings()
  const data = normalizeTaskData(task.data)
  const { units, errors, warnings } = expandTask(data, loadPlanLibrary(store), settings, task.name ?? '')
  if (store.files) {
    for (const u of units) for (const l of [...u.loras, ...(u.loras2 ?? []), ...(u.task_loras ?? [])]) if (l.resource_id && !l.disabled) resolveLoraName(store, l, errors)
  }
  const ch = data.character_id ? store.get('characters', data.character_id) : null
  const legacyTriggers = (ch?.loras ?? []).flatMap((l) => l.trigger_words ?? []).filter((w) => typeof w === 'string' && w.trim())
  if (legacyTriggers.length)
    warnings.push(`角色「${ch!.name}」有之前启用的触发词（${legacyTriggers.join(', ')}）尚未合并到基础 Prompt；新版不再自动加入，可在角色库中一键合并`)
  const wf = resolveWorkflow(store, data.workflow_id, !!data.workflow_none)
  if (!wf) {
    warnings.push('尚未选择 ComfyUI 工作流：可以预览 Prompt，但不能加入执行队列')
  } else {
    const name2 = units.find((u) => u.loras2?.length)?.loras2![0].name ?? secondLoraName(store, data)
    buildWorkflowInputs(store, wf, units, { savedCfg: data.lora_configs?.[String(wf.id)], name2, prefix: data.output?.prefix?.trim(), sizeHint: true, settings, dateStr, errors, warnings })
  }
  // 输出目录：完成后把最终图片从 ComfyUI 复制到这里（默认工作区 output/）；入队时随计划冻结
  const outDir = outputDirOf(store, data.output?.dir)
  if (outDir) for (const u of units) u.meta.output_dir = outDir
  if (!units.length && !errors.length) errors.push('计划为空：请选择剧情模板或添加动作')
  return { units, errors, warnings, workflow: wf }
}

/** 把任务冻结为一个执行队列项。之后修改模板不影响已入队 / 已生成的记录 */
export function enqueueTask(store: Store, task: Task, settings?: Settings): { runId: number | null; plan: FullPlan } {
  const plan = planForTask(store, task, settings)
  if (plan.errors.length || !plan.workflow) return { runId: null, plan }
  const wf = plan.workflow
  const runId = store.createRun(
    task.id ?? null,
    task.name ?? '',
    wf.name,
    wf.api_json,
    wf.mapping,
    plan.units.map((u) => ({ ...u, inputs: u.inputs ?? [] })),
  )
  return { runId, plan }
}

/**
 * 入队前预览：按当前素材与工作流计算某一张图将要提交的工作流 JSON（构建方式与执行相同：applyInputs(工作流, inputs)）。
 * 入队后实际提交的内容以提交快照为准（运行记录的「执行详情」），不要用这个函数查看历史。
 */
export function finalWorkflow(store: Store, task: Task, index: number): { json: ApiWorkflow; index: number; count: number; label: string; seed: number; errors: string[]; workflow: string; changes: InputChange[]; unchanged: number } {
  const plan = planForTask(store, task)
  if (!plan.workflow) throw new Error('尚未选择 ComfyUI 工作流')
  const u = plan.units[index]
  if (!u) throw new Error(plan.units.length ? `没有第 ${index + 1} 张` : '计划为空')
  if (!u.inputs) throw new Error(`工作流映射或节点控制有错误，无法生成最终 JSON：${plan.errors.slice(0, 3).join('；')}`)
  const json = applyInputs(plan.workflow.api_json, u.inputs)
  // 变更列表由实际构建结果与原始工作流比较得到，不是根据表单推算
  const { changes, unchanged } = diffWorkflow(plan.workflow.api_json, json, u.inputs)
  return { json, index, count: plan.units.length, label: `${u.meta.section}「${u.item_label}」`, seed: u.seed, errors: plan.errors, workflow: plan.workflow.name, changes, unchanged: unchanged.length }
}
