import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
// 任务 → 生成计划（预览与入队共用），以及把计划冻结写入执行队列。

import { mappingValues, validateMapping } from '@shared/mapping'
import { expandTask, normalizeTaskData, PlanLibrary } from '@shared/planner'
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

/** units 中的 inputs 就是之后实际写入工作流的值；预览界面显示的也是这份数据 */
export function planForTask(store: Store, task: Task, settings?: Settings, dateStr?: string): FullPlan {
  store.files?.scan()
  settings = settings ?? store.settings()
  const data = normalizeTaskData(task.data)
  const { units, errors } = expandTask(data, loadPlanLibrary(store), settings, task.name ?? '')
  const warnings: string[] = []
  if (store.files) {
    for (const u of units) for (const l of u.loras) if (l.resource_id) {
      try {
        if (!/^[a-f0-9-]{36}$/i.test(l.resource_id)) throw new Error('无效 LoRA 资源 ID')
        const r = JSON.parse(readFileSync(join(store.files.root,'loras/metadata',l.resource_id+'.json'),'utf8'))
        if (!r.comfyName || /^(?:[A-Za-z]:|[\\/])/.test(r.comfyName) || r.comfyName.split(/[\\/]/).includes('..')) throw new Error('请配置 ComfyUI 相对模型名称')
        if (!existsSync(r.path)) throw new Error('模型文件缺失')
        l.name = r.comfyName
      } catch(e) { errors.push(`LoRA ${l.name}: ${(e as Error).message}`) }
    }
  }
  const wf = resolveWorkflow(store, data.workflow_id)
  if (!wf) {
    warnings.push('尚未选择 ComfyUI 工作流：可以预览 Prompt，但不能加入执行队列')
  } else {
    for (const u of units) for (const m of wf.mapping) {
      const slot = /^lora(\d+)_/.exec(m.source)
      if (slot && !u.loras[Number(slot[1])-1]) errors.push(`角色 LoRA 槽位 ${slot[1]} 为空：请移除该槽位映射或补齐角色 LoRA；不能安全推断自定义 Loader 的禁用方式`)
    }
    const msgs = validateMapping(wf.api_json ?? {}, wf.mapping ?? [])
    for (const [lvl, msg] of msgs) (lvl === 'error' ? errors : warnings).push(`工作流「${wf.name}」${msg}`)
    if (!msgs.some(([l]) => l === 'error')) {
      for (const u of units) u.inputs = mappingValues(u, wf.mapping, settings, dateStr)
    }
  }
  if (!units.length && !errors.length) errors.push('计划为空：请选择剧情模板或添加姿态')
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
