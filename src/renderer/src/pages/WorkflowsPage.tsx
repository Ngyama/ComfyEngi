// 工作流：选择、导入，以及节点查看与控制（由 WorkflowEditor 提供）。

import { useEffect, useState } from 'react'
import { Plus, Star, Workflow as WorkflowIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { EmptyState, PageHeader, StatusDot } from '@/components/common'
import { api, call } from '@/lib/api'
import { reloadLib, useLib, useNav } from '@/lib/stores'
import { ImportHint, WorkflowEditor } from './settings/WorkflowEditor'

export default function WorkflowsPage() {
  const lib = useLib((s) => s.lib)
  const target = useNav((s) => s.target?.workflowId)
  const tab = useNav((s) => s.target?.tab)
  const wfs = lib?.workflows ?? []
  const [sel, setSel] = useState<number | null>(target ?? lib?.settings.default_workflow_id ?? wfs[0]?.id ?? null)
  useEffect(() => {
    if (target) setSel(target)
  }, [target])
  const cur = wfs.find((w) => w.id === sel) ?? wfs[0]
  const doImport = async () => {
    const r = await call(api['workflows.import']())
    if (!r) return
    if ('error' in r) return toast.error('无法导入', { description: r.error })
    await reloadLib()
    setSel(r.id)
    toast.success('已导入工作流')
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="工作流"
        className="pb-3"
        actions={
          <Button variant={wfs.length ? 'ghost' : 'default'} size="sm" onClick={doImport} data-testid="workflow-import">
            <Plus /> 导入
          </Button>
        }
      />
      {wfs.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 px-6 pb-3" data-testid="workflow-tabs">
          {wfs.map((w) => (
            <button key={w.id} type="button" onClick={() => setSel(w.id)} data-active={cur?.id === w.id || undefined} className="flex items-center gap-2 rounded-lg bg-card px-2.5 py-1.5 text-left ring-1 ring-tint/[0.08] hover:bg-accent data-[active]:ring-primary/60">
              <StatusDot tone={w.errors ? 'error' : w.mapping ? 'ok' : 'warn'} />
              <span className="text-[12.5px] font-medium">{w.name}</span>
              {lib?.settings.default_workflow_id === w.id && <Star className="size-3 fill-current text-warning" />}
            </button>
          ))}
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col px-6 pb-5">
        {cur ? (
          <WorkflowEditor key={cur.id} id={cur.id} initialTab={cur.id === target ? tab : undefined} onDeleted={() => setSel(null)} />
        ) : (
          <EmptyState
            icon={<WorkflowIcon />}
            title="还没有导入工作流"
            description="导入 ComfyUI 导出的 API 格式工作流。"
            action={
              <Button onClick={doImport}>
                <Plus /> 导入 API 工作流
              </Button>
            }
          />
        )}
        {!wfs.length && <ImportHint />}
      </div>
    </div>
  )
}
