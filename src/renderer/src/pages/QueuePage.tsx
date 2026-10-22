// 执行队列与运行监控。调度在主进程中进行，本页只负责展示与控制。

import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, CircleStop, GripVertical, ListPlus, MoreHorizontal, Pause, Play, RotateCcw, Terminal, Trash2, Undo2, Zap } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import { EmptyState, PageHeader, StatusDot } from '@/components/common'
import { SortableArea, useSortableItem } from '@/components/sortable'
import { api, call } from '@/lib/api'
import { confirm, useLib, useNav, useRunner } from '@/lib/stores'
import { cn } from '@/lib/utils'
import type { Run, RunnerState, RunUnit } from '@shared/types'

const STATE: Record<RunnerState, [string, 'ok' | 'warn' | 'error' | 'idle' | 'busy']> = {
  idle: ['空闲', 'idle'],
  running: ['生成中', 'busy'],
  waiting: ['等待 ComfyUI', 'warn'],
  pausing: ['当前图片完成后暂停', 'warn'],
  paused: ['已暂停', 'warn'],
  stopping: ['正在停止', 'warn'],
  stopped: ['已停止', 'idle'],
  finished: ['全部完成', 'ok'],
}
const UNIT_STATUS: Record<string, [string, string]> = {
  pending: ['待执行', 'text-muted-foreground'],
  submitting: ['提交中', 'text-primary'],
  submitted: ['生成中', 'text-primary'],
  done: ['完成', 'text-success'],
  failed: ['失败', 'text-destructive'],
  skipped: ['已跳过', 'text-muted-foreground/60'],
}

function Bar({ value, max, className }: { value: number; max: number; className?: string }) {
  return (
    <div className={cn('h-1.5 overflow-hidden rounded-full bg-white/[0.06]', className)}>
      <div className="h-full rounded-full bg-primary transition-all duration-300" style={{ width: max ? `${Math.min(100, (value / max) * 100)}%` : '0%' }} />
    </div>
  )
}

function StatusCard({ runs, onStart }: { runs: Run[]; onStart: () => void }) {
  const { status } = useRunner()
  const [label, tone] = STATE[status.state]
  const st = status.state
  const alive = status.alive
  const active = runs.filter((r) => r.status === 'queued' || status.sessionRuns.includes(r.id))
  const sum = (k: keyof Run['counts']) => active.reduce((a, r) => a + (r.counts[k] ?? 0), 0)
  const total = active.reduce((a, r) => a + r.counts.total - (r.counts.skipped ?? 0), 0)
  const done = sum('done')
  const failed = sum('failed')
  const remain = sum('pending') + sum('submitting') + sum('submitted')
  const cur = status.current
  const p = status.progress
  return (
    <div className="mx-6 rounded-2xl bg-card p-5 ring-1 ring-white/[0.05]">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <StatusDot tone={tone} />
            <span className="text-[15px] font-semibold">{label}</span>
          </div>
          {status.message && <div className={cn('mt-1 text-xs', st === 'paused' || st === 'waiting' ? 'text-warning' : 'text-muted-foreground')}>{status.message}</div>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {(!alive || st === 'paused' || st === 'pausing') && (
            <Button onClick={onStart}>
              <Play /> {alive ? '继续' : '开始'}
            </Button>
          )}
          {alive && (st === 'running' || st === 'waiting') && (
            <Button variant="secondary" onClick={() => void api['runner.pause']()} title="完成当前正在执行的图片后，不再提交下一张">
              <Pause /> 暂停
            </Button>
          )}
          {alive && st !== 'stopping' && (
            <Button
              variant="ghost"
              title="撤回本软件尚在 ComfyUI 排队中的图片；正在生成的图片会完成并记录"
              onClick={async () => {
                if (await confirm({ title: '停止调度？', description: '· 本软件尚在 ComfyUI 排队、未开始生成的那一张会被撤回\n· 正在生成的图片会继续完成并记录\n· 未执行的部分保留在队列中，之后可继续', confirmText: '停止' }))
                  void api['runner.stop']()
              }}
            >
              <CircleStop /> 停止
            </Button>
          )}
          {alive && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="更多">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={async () => {
                    if (await confirm({ title: '强制中断当前图片？', description: '只中断本软件提交且正在生成的那一张，不影响 ComfyUI 中其他程序的任务。被中断的图片继续时会重新生成。', confirmText: '强制中断', destructive: true }))
                      void api['runner.interrupt']()
                  }}
                >
                  <Zap /> 强制中断
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-[1fr_auto] gap-x-8 gap-y-3">
        <div className="min-w-0">
          {cur ? (
            <>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[13px]">
                <span className="font-medium">{cur.run_name}</span>
                <span className="text-muted-foreground">
                  {cur.meta?.section} {cur.meta?.item_no}「{cur.item_label}」（{cur.meta?.n}/{cur.meta?.of}）
                </span>
                {cur.meta?.expression && (
                  <span className="text-muted-foreground">
                    表情 {cur.meta.expression}（{cur.meta.expression_n}/{cur.meta.expression_of}）
                  </span>
                )}
                <span className="font-mono text-[11px] text-muted-foreground">seed {cur.seed}</span>
              </div>
              <div className="mt-2 flex items-center gap-3">
                <Bar value={p.value} max={p.max} className="flex-1" />
                <span className="w-20 text-right text-[11px] text-muted-foreground tabular-nums">{p.max ? `${p.value} / ${p.max} 步` : '等待开始'}</span>
              </div>
            </>
          ) : (
            <div className="text-[13px] text-muted-foreground">{alive ? '等待下一张…' : '当前没有正在生成的图片'}</div>
          )}
        </div>
        <div className="flex items-center gap-6 text-right">
          {(
            [
              ['总数', total, ''],
              ['已完成', done, 'text-success'],
              ['失败', failed, failed ? 'text-destructive' : ''],
              ['剩余', remain, ''],
            ] as const
          ).map(([k, v, c]) => (
            <div key={k}>
              <div className={cn('text-[18px] leading-none font-semibold tabular-nums', c)}>{v}</div>
              <div className="mt-1 text-[11px] text-muted-foreground">{k}</div>
            </div>
          ))}
        </div>
        <Bar value={done + failed} max={total} className="col-span-2 h-1" />
      </div>
    </div>
  )
}

function RunCard({ run, expanded, onToggle, onChanged }: { run: Run; expanded: boolean; onToggle: () => void; onChanged: () => void }) {
  const s = useSortableItem(String(run.id))
  const tick = useRunner((x) => x.tick)
  const [units, setUnits] = useState<RunUnit[]>([])
  useEffect(() => {
    if (expanded) void api['queue.units'](run.id).then(setUnits)
  }, [expanded, run.id, tick])
  const c = run.counts
  const total = c.total - (c.skipped ?? 0)
  const statusText = { queued: c.done || c.failed ? '执行中' : '排队中', done: '已完成', removed: '已移出' }[run.status]
  return (
    <div ref={s.setNodeRef} style={s.style} className={cn('rounded-xl bg-card ring-1 ring-white/[0.05]', s.isDragging && 'shadow-2xl shadow-black/50')}>
      <div className="flex items-center gap-3 px-3 py-3">
        <button type="button" {...s.attributes} {...s.listeners} className="cursor-grab text-muted-foreground/50 hover:text-muted-foreground" aria-label="拖动排序">
          <GripVertical className="size-4" />
        </button>
        <button type="button" onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          {expanded ? <ChevronDown className="size-4 text-muted-foreground" /> : <ChevronRight className="size-4 text-muted-foreground" />}
          <div className="min-w-0">
            <div className="truncate text-[13.5px] font-medium">{run.name}</div>
            <div className="truncate text-[11px] text-muted-foreground">
              {statusText} · {run.workflow_name} · {run.created_at ? new Date(run.created_at * 1000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}
            </div>
          </div>
        </button>
        <div className="w-48 shrink-0">
          <div className="mb-1 flex justify-between text-[11px] text-muted-foreground tabular-nums">
            <span>
              {c.done ?? 0} / {total}
            </span>
            {c.failed ? <span className="text-destructive">失败 {c.failed}</span> : null}
          </div>
          <Bar value={(c.done ?? 0) + (c.failed ?? 0)} max={total} />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="操作">
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              disabled={!c.failed}
              onSelect={async () => {
                const n = await call(api['queue.retry'](run.id))
                if (n !== undefined) toast.success(`已将 ${n} 张失败图片重新加入待执行（Seed 不变）`)
                onChanged()
              }}
            >
              <RotateCcw /> 重试失败项
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={run.status !== 'queued'}
              onSelect={async () => {
                if (await confirm({ title: '移出队列？', description: '未执行的图片将被跳过，已生成的记录保留。', confirmText: '移出' })) {
                  await call(api['queue.remove'](run.id))
                  onChanged()
                }
              }}
            >
              <Undo2 /> 移出队列
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={async () => {
                if (await confirm({ title: '删除记录？', description: '将永久删除该队列项及其所有运行记录（不会删除 ComfyUI 已保存的图片文件）。', confirmText: '删除', destructive: true })) {
                  await call(api['queue.delete'](run.id))
                  onChanged()
                }
              }}
            >
              <Trash2 /> 删除记录
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {expanded && (
        <div className="max-h-80 overflow-y-auto border-t border-white/[0.05] px-3 py-2">
          {units.map((u) => {
            const [t, cls] = UNIT_STATUS[u.status] ?? [u.status, '']
            const files = u.outputs?.filter((o) => o.type === 'output').map((o) => o.filename).join(', ')
            return (
              <div key={u.id} className="flex items-center gap-3 rounded-md px-2 py-1.5 text-xs hover:bg-white/[0.03]">
                <span className="w-10 shrink-0 text-muted-foreground tabular-nums">#{u.idx + 1}</span>
                <span className="w-40 shrink-0 truncate">
                  {u.item_label}
                  <span className="text-muted-foreground">
                    （{u.meta?.n}/{u.meta?.of}）
                  </span>
                </span>
                <span className="w-24 shrink-0 truncate text-muted-foreground">{u.meta?.expression || '—'}</span>
                <span className="w-24 shrink-0 font-mono text-[11px] text-muted-foreground">{u.seed}</span>
                <span className={cn('w-14 shrink-0', cls)}>{t}</span>
                <span className={cn('min-w-0 flex-1 truncate', u.error ? 'text-destructive' : 'text-muted-foreground')} title={u.error || files}>
                  {u.error || files}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function AddTasksDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const tasks = useLib((s) => s.lib?.tasks ?? [])
  const [picked, setPicked] = useState<number[]>([])
  useEffect(() => setPicked([]), [open])
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>添加套图任务到队列</DialogTitle>
          <DialogDescription>按勾选顺序加入队列，之后可以拖动调整执行顺序。</DialogDescription>
        </DialogHeader>
        <div className="max-h-80 space-y-1 overflow-y-auto">
          {tasks.map((t) => (
            <label key={t.id} className="flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 hover:bg-white/[0.04]">
              <Checkbox checked={picked.includes(t.id)} onCheckedChange={(v) => setPicked((p) => (v ? [...p, t.id] : p.filter((x) => x !== t.id)))} />
              <span className="text-[13px]">{t.name}</span>
              {picked.includes(t.id) && <span className="ml-auto text-[11px] text-muted-foreground">第 {picked.indexOf(t.id) + 1} 个</span>}
            </label>
          ))}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            disabled={!picked.length}
            onClick={async () => {
              const r = await call(api['queue.enqueue'](picked))
              if (!r) return
              if (r.ok.length) toast.success(`已加入 ${r.ok.length} 个任务，共 ${r.ok.reduce((a, x) => a + x.count, 0)} 张`)
              for (const f of r.failed) toast.error(`「${f.name}」未加入`, { description: f.errors.slice(0, 3).join('\n') })
              onOpenChange(false)
              onDone()
            }}
          >
            加入队列
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default function QueuePage() {
  const { status, logs, tick } = useRunner()
  const go = useNav((s) => s.go)
  const [runs, setRuns] = useState<Run[]>([])
  const [showDone, setShowDone] = useState(false)
  const [expanded, setExpanded] = useState<number | null>(null)
  const [adding, setAdding] = useState(false)
  const [logOpen, setLogOpen] = useState(false)
  const [recovery, setRecovery] = useState<{ pending: number; inFlight: number } | null>(null)

  const refresh = useCallback(() => void api['queue.list'](true).then(setRuns), [])
  useEffect(refresh, [refresh, tick])
  // 只有在执行器未运行、且存在上次已提交未记录的单元时才提示
  useEffect(() => {
    if (status.alive) setRecovery(null)
    else void api['queue.pendingSummary']().then((s) => setRecovery(s.inFlight ? s : null))
  }, [status.alive])

  const visible = runs.filter((r) => showDone || r.status === 'queued' || status.sessionRuns.includes(r.id))

  const start = async () => {
    if (status.alive) {
      await api['runner.start']()
      return
    }
    const sum = await api['queue.pendingSummary']()
    if (!sum.pending && !sum.inFlight) {
      toast.error('执行队列为空', { description: '请在「套图任务」中把任务加入队列。', action: { label: '前往', onClick: () => go('plan') } })
      return
    }
    const t = toast.loading('正在检查 ComfyUI 与工作流…')
    const pre = await api['runner.precheck']()
    toast.dismiss(t)
    if (pre.error && !(await confirm({ title: '无法连接 ComfyUI', description: `${pre.error}\n\n仍要开始吗？开始后会持续重试连接（超过设置的等待时间后自动暂停）。`, confirmText: '仍然开始' }))) return
    if (pre.messages.length && !(await confirm({ title: '检查发现问题', description: `以下问题可能导致生成失败：\n\n${pre.messages.slice(0, 12).join('\n')}\n\n仍要开始吗？`, confirmText: '仍然开始' }))) return
    setRecovery(null)
    await api['runner.start']()
  }

  return (
    <div className="mx-auto flex h-full max-w-[1240px] flex-col">
      <PageHeader
        title="执行队列"
        description="一次提交一张，按队列顺序执行；关闭页面不影响调度。"
        actions={
          <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>
            <ListPlus /> 添加任务
          </Button>
        }
      />
      <StatusCard runs={runs} onStart={start} />
      {recovery && (
        <div className="mx-6 mt-3 rounded-xl bg-warning/10 px-4 py-3 text-xs leading-relaxed text-warning">
          检测到上次未正常结束的队列：{recovery.inFlight} 张已提交给 ComfyUI 但未记录结果。点击「开始」后会先向 ComfyUI 核对——已完成的直接补记录，仍在排队的继续等待，确实丢失的才重新提交，不会重复生成。
        </div>
      )}
      <div className="flex items-center gap-3 px-6 pt-5 pb-2">
        <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">队列</span>
        <span className="text-[11px] text-muted-foreground/70">拖动调整执行顺序</span>
        <div className="flex-1" />
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch checked={showDone} onCheckedChange={setShowDone} /> 显示已结束
        </label>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-6 pb-4">
        {visible.length ? (
          <SortableArea
            items={visible}
            getId={(r) => String(r.id)}
            onReorder={async (_f, _t, next) => {
              setRuns((rs) => [...next, ...rs.filter((r) => !next.includes(r))])
              await call(api['queue.reorder'](next.map((r) => r.id)))
              refresh()
            }}
          >
            {visible.map((r) => (
              <RunCard key={r.id} run={r} expanded={expanded === r.id} onToggle={() => setExpanded(expanded === r.id ? null : r.id)} onChanged={refresh} />
            ))}
          </SortableArea>
        ) : (
          <EmptyState icon={<ListPlus />} title="队列是空的" description="在「套图任务」中点击「加入队列」或「开始生成」，或者从已保存的任务中添加。" action={<Button variant="secondary" onClick={() => setAdding(true)}>添加任务</Button>} />
        )}
      </div>
      <div className="border-t border-white/[0.05]">
        <button type="button" onClick={() => setLogOpen(!logOpen)} className="flex w-full items-center gap-2 px-6 py-2.5 text-xs text-muted-foreground hover:text-foreground">
          <Terminal className="size-3.5" /> 运行日志
          <span className="truncate opacity-70">{logs[logs.length - 1] ?? ''}</span>
          <span className="ml-auto">{logOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}</span>
        </button>
        {logOpen && (
          <pre className="mx-6 mb-3 max-h-56 overflow-y-auto rounded-xl bg-black/30 p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-muted-foreground select-text">
            {logs.length ? logs.join('\n') : '暂无日志'}
          </pre>
        )}
      </div>
      <AddTasksDialog open={adding} onOpenChange={setAdding} onDone={refresh} />
    </div>
  )
}
