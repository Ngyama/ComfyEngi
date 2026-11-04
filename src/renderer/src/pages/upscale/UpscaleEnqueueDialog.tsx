// 加入放大队列：选择放大工作流，预览每张图恢复出的生成条件与问题，确认数量后入队。

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CircleCheck, CircleSlash, Info } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { FieldLabel } from '@/components/common'
import { api, call } from '@/lib/api'
import { confirm, useLib, useNav, useUpscaleSel, type UpscalePick } from '@/lib/stores'
import { cn } from '@/lib/utils'
import type { UpscaleCandidate, UpscalePlan } from '@shared/upscale'

const LAST_WF = 'comfyengi.upscale.workflow'
const readLast = () => {
  try {
    return Number(localStorage.getItem(LAST_WF)) || null
  } catch {
    return null
  }
}
const writeLast = (id: number) => {
  try {
    localStorage.setItem(LAST_WF, String(id))
  } catch {
    /* 无法保存时下次重新选择 */
  }
}

/** 执行器未运行时检查 ComfyUI 后开始（与套图任务入队后开始相同） */
export async function startRunnerChecked(): Promise<boolean> {
  const st = await api['runner.status']()
  if (st.alive && st.state !== 'paused' && st.state !== 'pausing') return true
  const pre = await api['runner.precheck']()
  if (pre.error && !(await confirm({ title: '无法连接 ComfyUI', description: `${pre.error}\n\n仍要开始吗？开始后会持续重试连接。`, confirmText: '仍然开始' }))) return false
  if (pre.messages.length && !(await confirm({ title: '检查发现问题', description: `${pre.messages.slice(0, 10).join('\n')}\n\n仍要开始吗？`, confirmText: '仍然开始' }))) return false
  await api['runner.start']()
  return true
}

const STATE: Record<UpscaleCandidate['state'], { label: string; cls: string; icon: typeof CircleCheck }> = {
  ok: { label: '可以放大', cls: 'text-success', icon: CircleCheck },
  confirm: { label: '需要确认', cls: 'text-warning', icon: AlertTriangle },
  blocked: { label: '不能加入', cls: 'text-destructive', icon: CircleSlash },
}

function CandidateRow({ c }: { c: UpscaleCandidate }) {
  const st = STATE[c.state]
  const loras = (c.loras ?? []).filter((l) => l.active)
  return (
    <div className="space-y-1 rounded-xl bg-inset px-3 py-2 text-[11.5px]" data-testid="upscale-candidate">
      <div className="flex items-center gap-2">
        <st.icon className={cn('size-3.5 shrink-0', st.cls)} />
        <span className="min-w-0 truncate font-medium">{c.label || `#${c.unit_id}`}</span>
        <span className="min-w-0 truncate text-muted-foreground">{c.run_name}</span>
        <span className="ml-auto shrink-0 font-mono text-[10.5px] text-muted-foreground" title={c.path}>
          {c.name}
        </span>
      </div>
      {c.positive != null && (
        <div className="line-clamp-2 font-mono text-[10.5px] break-all text-muted-foreground" title={c.positive}>
          正面：{c.positive || '（空）'}
        </div>
      )}
      {(c.checkpoint || loras.length > 0) && (
        <div className="truncate text-[10.5px] text-muted-foreground" title={loras.map((l) => `${l.name} ${l.strength}/${l.clip}`).join('\n')}>
          {c.checkpoint ?? 'Checkpoint 未知'}
          {loras.length ? ` · LoRA：${loras.map((l) => `${l.name} ${l.strength}${l.clip !== l.strength ? `/${l.clip}` : ''}`).join('、')}` : ' · 没有启用的 LoRA'}
        </div>
      )}
      {c.issues.map((x, i) => (
        <div key={i} className={cn('flex gap-1.5 leading-relaxed', x.level === 'block' ? 'text-destructive' : x.level === 'confirm' ? 'text-warning' : 'text-muted-foreground')}>
          {x.level === 'note' ? <Info className="mt-0.5 size-3 shrink-0" /> : <AlertTriangle className="mt-0.5 size-3 shrink-0" />}
          <span className="min-w-0 break-words">{x.text}</span>
        </div>
      ))}
    </div>
  )
}

export function UpscaleEnqueueDialog({ picks, onClose }: { picks: UpscalePick[]; onClose: () => void }) {
  const lib = useLib((s) => s.lib)
  const go = useNav((s) => s.go)
  const remove = useUpscaleSel((s) => s.remove)
  const workflows = useMemo(() => (lib?.workflows ?? []).filter((w) => w.upscale), [lib])
  const [wid, setWid] = useState<number | null>(() => {
    const last = readLast()
    return workflows.find((w) => w.id === last)?.id ?? workflows[0]?.id ?? null
  })
  const [plan, setPlan] = useState<UpscalePlan | null>(null)
  const [accept, setAccept] = useState(false)
  const [busy, setBusy] = useState(false)
  const items = useMemo(() => picks.map((p) => ({ unit_id: p.unit_id })), [picks])

  useEffect(() => {
    if (wid == null) return
    let alive = true
    setPlan(null)
    void call(api['upscale.plan'](items, wid)).then((p) => alive && p && setPlan(p))
    return () => {
      alive = false
    }
  }, [items, wid])

  const n = (st: UpscaleCandidate['state']) => plan?.candidates.filter((c) => c.state === st).length ?? 0
  const ok = n('ok')
  const conf = n('confirm')
  const blocked = n('blocked')
  const count = plan && !plan.errors.length ? ok + (accept ? conf : 0) : 0
  // 有问题的排在前面
  const order = { blocked: 0, confirm: 1, ok: 2 }
  const sorted = [...(plan?.candidates ?? [])].sort((a, b) => order[a.state] - order[b.state])

  const submit = async (start: boolean) => {
    if (wid == null || !count) return
    setBusy(true)
    const r = await call(api['upscale.enqueue'](items, wid, accept))
    setBusy(false)
    if (!r) return
    if (!r.runId) {
      toast.error('没有加入放大队列', { description: [...r.errors, ...r.skipped.slice(0, 4).map((x) => `${x.label}：${x.reason}`)].join('\n') })
      return
    }
    writeLast(wid)
    // 已加入的从选择中移除，未加入的保留以便处理
    const skipped = new Set(r.skipped.map((x) => x.unit_id))
    remove(items.map((x) => x.unit_id).filter((id) => !skipped.has(id)))
    onClose()
    const started = start && (await startRunnerChecked())
    toast.success(`已加入放大队列（${r.count} 张）${started ? '，开始执行' : ''}`, {
      description: r.skipped.length ? `未加入 ${r.skipped.length} 张，仍保留在选择中` : '入队时已冻结工作流与每张图的生成条件。',
      action: { label: '查看', onClick: () => go('upscale') },
    })
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-2xl" data-testid="upscale-dialog">
        <DialogHeader className="shrink-0">
          <DialogTitle>加入放大队列</DialogTitle>
          <DialogDescription>按每张图生成时实际提交的工作流恢复 Prompt、Checkpoint 与 LoRA，写入放大工作流；放大倍数、步数、CFG、采样器、降噪等参数保持放大工作流中的值。</DialogDescription>
        </DialogHeader>
        <div className="scrollbar-none -mx-1 min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-1 py-0.5">
          <div>
            <FieldLabel hint="在「工作流」中导入放大工作流，并映射输入图片与最终输出节点">放大工作流</FieldLabel>
            {workflows.length ? (
              <select
                value={wid ?? ''}
                onChange={(e) => setWid(Number(e.target.value))}
                className="h-9 w-full rounded-lg bg-tint/[0.04] px-3 text-[13px] ring-1 ring-tint/[0.112] outline-none focus:ring-primary/50"
                data-testid="upscale-workflow"
              >
                {workflows.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                    {w.errors ? `（映射有 ${w.errors} 个错误）` : ''}
                  </option>
                ))}
              </select>
            ) : (
              <div className="space-y-2 rounded-xl bg-warning/10 p-3 text-xs leading-relaxed text-warning">
                <div>还没有放大工作流。请在「工作流」中导入放大工作流的 API JSON，在映射中指定「放大：输入图片（LoadImage）」与「放大：最终输出节点」（可以用「识别放大映射」自动填写）。</div>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    onClose()
                    go('workflows')
                  }}
                >
                  前往工作流
                </Button>
              </div>
            )}
          </div>
          {plan && (
            <>
              {plan.errors.map((e, i) => (
                <div key={i} className="rounded-xl bg-destructive/10 p-3 text-xs leading-relaxed text-destructive">
                  {e}
                </div>
              ))}
              {plan.warnings.length > 0 && (
                <div className="space-y-1 rounded-xl bg-warning/10 p-3 text-xs leading-relaxed text-warning">
                  {plan.warnings.map((w, i) => (
                    <div key={i}>{w}</div>
                  ))}
                </div>
              )}
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs" data-testid="upscale-counts">
                <span>共 {plan.candidates.length} 张</span>
                <span className="text-success">可以放大 {ok}</span>
                {conf > 0 && <span className="text-warning">需要确认 {conf}</span>}
                {blocked > 0 && <span className="text-destructive">不能加入 {blocked}</span>}
              </div>
              {conf > 0 && (
                <label className="flex items-start gap-2 rounded-xl bg-warning/10 p-3 text-xs leading-relaxed">
                  <Checkbox checked={accept} onCheckedChange={(v) => setAccept(v === true)} className="mt-0.5" />
                  <span>同时加入「需要确认」的 {conf} 张：这些图的生成条件不能完全从记录中确定（见各项说明），只会写入能确定的部分。</span>
                </label>
              )}
              <div className="space-y-1.5">
                {sorted.map((c) => (
                  <CandidateRow key={c.key} c={c} />
                ))}
              </div>
            </>
          )}
          {!plan && wid != null && <div className="py-6 text-center text-xs text-muted-foreground">正在读取每张图的生成记录…</div>}
        </div>
        <DialogFooter className="shrink-0">
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="secondary" disabled={!count || busy} onClick={() => void submit(false)} data-testid="upscale-confirm">
            加入队列（{count} 张）
          </Button>
          <Button disabled={!count || busy} onClick={() => void submit(true)}>
            加入并开始
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
