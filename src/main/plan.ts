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
  settings = settings ?? store.settings()
  const data = normalizeTaskData(task.data)
  const { units, errors } = expandTask(data, loadPlanLibrary(store), settings, task.name ?? '')
  const warnings: string[] = []
  const wf = resolveWorkflow(store, data.workflow_id)
  if (!wf) {
    warnings.push('尚未选择 ComfyUI 工作流：可以预览 Prompt，但不能加入执行队列')
  } else {
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
