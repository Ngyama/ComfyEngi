import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
// 任务 → 生成计划（预览与入队共用），以及把计划冻结写入执行队列。

import { findLoraLoaders, mappingValues, parseLoraSource, slotLora, SOURCE_LABELS, validateMapping } from '@shared/mapping'
import { expandTask, normalizeTaskData, PlanLibrary } from '@shared/planner'
import { MODULE_LABELS } from '@shared/prompt'
import type { PlanUnit, Settings, Task, Workflow } from '@shared/types'
import type { Store } from './store'

export function loadPlanLibrary(store: Store): PlanLibrary {
  return new PlanLibrary(store.list('templates'), store.list('characters'), store.list('outfits'), store.list('stories'))
}

export function resolveWorkflow(store: Store, workflowId: number | null | undefined): Workflow | null {
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
function checkLoraSlots(wf: Workflow, units: PlanUnit[], errors: string[], warnings: string[], once: (list: string[], msg: string) => void) {
  const loaders = new Map(findLoraLoaders(wf.api_json ?? {}).map((l) => [l.node, l]))
  const bind = new Map<string, { nodes: Set<string>; strengths: Set<string> }>()
  for (const m of wf.mapping ?? []) {
    const p = parseLoraSource(m.source)
    if (!p) continue
    const b = bind.get(p.prefix) ?? { nodes: new Set<string>(), strengths: new Set<string>() }
    if (p.field === 'name') b.nodes.add(String(m.node))
    else b.strengths.add(`${m.node}.${m.input}`)
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
      if (!b?.nodes.size) {
        once(errors, `${label}已启用，但当前工作流没有绑定 LoRA Loader（${slotTitle(prefix)}）：请在套图任务的 LoRA 配置中绑定 Loader，或在本任务中禁用它`)
        continue
      }
      for (const node of b.nodes) {
        const ld = loaders.get(node)
        if (!wf.api_json?.[node]) once(errors, `${slotTitle(prefix)} 绑定的节点 ${node} 不存在于当前工作流中，请重新绑定`)
        else if (!ld) once(warnings, `${slotTitle(prefix)} 绑定的节点 ${node}（${wf.api_json[node].class_type}）不是能识别的 LoRA Loader，请人工确认写入的输入是否正确`)
        else if (ld.support === 'partial') once(warnings, `${slotTitle(prefix)} 绑定的节点 ${node}（${ld.class_type}）只识别到 lora_name，权重无法由本软件控制，请人工确认`)
        else {
          const missing = ld.strengths.filter((inp) => !b.strengths.has(`${node}.${inp}`))
          if (missing.length) once(warnings, `${slotTitle(prefix)} 绑定的 Loader ${node} 的 ${missing.join('、')} 没有映射，这些权重会保持工作流原值`)
        }
      }
    }
    for (const [prefix, b] of bind) {
      if (active.has(prefix) || !b.nodes.size) continue
      for (const node of b.nodes) {
        const ld = loaders.get(node)
        const safe = !!ld && ld.support !== 'partial' && ld.strengths.length > 0 && ld.strengths.every((inp) => b.strengths.has(`${node}.${inp}`))
        if (!safe)
          once(errors, `${slotTitle(prefix)} 在部分图片中没有要加载的 LoRA（未选择、已禁用或第二角色未出场），但绑定的 Loader ${node} 无法安全禁用：请映射它的全部强度输入（将写为 0），或移除这个绑定`)
      }
    }
  }
}

/** units 中的 inputs 就是之后实际写入工作流的值；预览界面显示的也是这份数据 */
export function planForTask(store: Store, task: Task, settings?: Settings, dateStr?: string): FullPlan {
  store.files?.scan()
  settings = settings ?? store.settings()
  const data = normalizeTaskData(task.data)
  const { units, errors } = expandTask(data, loadPlanLibrary(store), settings, task.name ?? '')
  const warnings: string[] = []
  if (store.files) {
    for (const u of units) for (const l of [...u.loras, ...(u.loras2 ?? []), ...(u.task_loras ?? [])]) if (l.resource_id && !l.disabled) {
      try {
        if (!/^[a-f0-9-]{36}$/i.test(l.resource_id)) throw new Error('无效 LoRA 资源 ID')
        const r = JSON.parse(readFileSync(join(store.files.root,'loras/metadata',l.resource_id+'.json'),'utf8'))
        if (!r.comfyName || /^(?:[A-Za-z]:|[\\/])/.test(r.comfyName) || r.comfyName.split(/[\\/]/).includes('..')) throw new Error('请配置 ComfyUI 相对模型名称')
        if (!existsSync(r.path)) throw new Error('模型文件缺失')
        l.name = r.comfyName
      } catch(e) { const msg = `LoRA ${l.name}: ${(e as Error).message}`; if (!errors.includes(msg)) errors.push(msg) }
    }
  }
  const ch = data.character_id ? store.get('characters', data.character_id) : null
  const legacyTriggers = (ch?.loras ?? []).flatMap((l) => l.trigger_words ?? []).filter((w) => typeof w === 'string' && w.trim())
  if (legacyTriggers.length)
    warnings.push(`角色「${ch!.name}」有之前启用的触发词（${legacyTriggers.join(', ')}）尚未合并到基础 Prompt；新版不再自动加入，可在角色库中一键合并`)
  const wf = resolveWorkflow(store, data.workflow_id)
  if (!wf) {
    warnings.push('尚未选择 ComfyUI 工作流：可以预览 Prompt，但不能加入执行队列')
  } else {
    const seen = new Set<string>()
    const once = (list: string[], msg: string) => {
      if (!seen.has(msg)) list.push(msg)
      seen.add(msg)
    }
    checkLoraSlots(wf, units, errors, warnings, once)
    // Prompt 节点只拼接部分模块时，检查有内容的模块是否都有去处
    for (const src of ['positive', 'negative']) {
      const entries = wf.mapping.filter((m) => m.source === src)
      if (!entries.length || entries.some((m) => !(m.modules ?? []).length)) continue
      const covered = new Set(entries.flatMap((m) => m.modules))
      const idx = src === 'positive' ? 0 : 1
      for (const u of units) for (const [k, v] of Object.entries(u.modules)) {
        if (v[idx]?.trim() && !covered.has(k)) once(warnings, `工作流「${wf.name}」的${src === 'positive' ? '正面' : '负面'} Prompt 映射没有包含模块「${MODULE_LABELS[k] ?? k}」，其内容不会提交`)
      }
    }
    const msgs = validateMapping(wf.api_json ?? {}, wf.mapping ?? [])
    for (const [lvl, msg] of msgs) (lvl === 'error' ? errors : warnings).push(`工作流「${wf.name}」${msg}`)
    if (!msgs.some(([l]) => l === 'error')) {
      for (const u of units) u.inputs = mappingValues(u, wf.mapping, settings, dateStr)
    }
  }
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
