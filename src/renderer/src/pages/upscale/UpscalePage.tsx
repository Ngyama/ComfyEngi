// 批量放大：放大队列中每张图的原图、使用的工作流、状态、结果与失败原因；可以对比原图与放大结果。

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, ArrowRight, FileSearch, FolderOpen, ImageIcon, ImageOff, Info, Maximize2, Play, RefreshCw, RotateCcw, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Chip, EmptyState, FieldLabel, PageHeader } from '@/components/common'
import { api, call } from '@/lib/api'
import { useNav, useRunner } from '@/lib/stores'
import { cn } from '@/lib/utils'
import type { RunUnit, UnitStatus } from '@shared/types'
import { ExecutionDialog } from '../ExecutionDialog'
import { startRunnerChecked } from './UpscaleEnqueueDialog'

type Which = 'source' | 'result'
const cache = new Map<string, string>()

/** 原图或放大结果的预览（只缓存成功读取的图片：结果完成前读取不到，完成后重新读取） */
function useUpscaleImage(u: RunUnit, which: Which, size: number, enabled: boolean) {
  const ready = which === 'source' || u.status === 'done'
  const key = `${u.id}:${which}:${size}:${ready ? u.finished_at ?? 0 : 'wait'}`
  const [src, setSrc] = useState<string | null | undefined>(cache.get(key))
  useEffect(() => {
    if (!enabled || !ready) {
      setSrc(ready ? cache.get(key) : undefined)
      return
    }
    if (cache.has(key)) {
      setSrc(cache.get(key))
      return
    }
    let alive = true
    void api['upscale.image'](u.id, which, size)
      .catch(() => null)
      .then((r) => {
        if (r) cache.set(key, r)
        if (alive) setSrc(r)
      })
    return () => {
      alive = false
    }
  }, [key, u.id, which, size, enabled, ready])
  return src
}

const STATUS: Record<UnitStatus, { label: string; cls: string }> = {
  pending: { label: '等待中', cls: 'text-muted-foreground' },
  submitting: { label: '正在上传 / 提交', cls: 'text-primary' },
  submitted: { label: '正在放大', cls: 'text-primary' },
  done: { label: '完成', cls: 'text-success' },
  failed: { label: '失败', cls: 'text-destructive' },
  skipped: { label: '已跳过', cls: 'text-muted-foreground' },
}

function Pic({ src, className }: { src: string | null | undefined; className?: string }) {
  return (
    <div className={cn('relative overflow-hidden rounded-lg bg-inset', className)}>
      {src ? (
        <img src={src} alt="" className="absolute inset-0 size-full object-cover" draggable={false} />
      ) : (
        <div className="absolute inset-0 grid place-items-center text-muted-foreground/40">{src === null ? <ImageOff className="size-4" /> : <ImageIcon className="size-4" />}</div>
      )}
    </div>
  )
}

function Row({ u, selected, onClick }: { u: RunUnit; selected: boolean; onClick: () => void }) {
  const ref = useRef<HTMLButtonElement>(null)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver((e) => e[0].isIntersecting && setVisible(true), { rootMargin: '200px' })
    io.observe(el)
    return () => io.disconnect()
  }, [])
  const m = u.meta?.upscale
  const src = useUpscaleImage(u, 'source', 240, visible)
  const res = useUpscaleImage(u, 'result', 240, visible)
  const st = STATUS[u.status]
  const notes = (m?.issues ?? []).filter((x) => x.level !== 'note')
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      className={cn('flex w-full items-center gap-3 rounded-xl bg-card p-2.5 text-left ring-1 ring-tint/[0.08] transition hover:ring-tint/[0.24]', selected && 'ring-2 ring-primary/70')}
      data-testid="upscale-row"
    >
      <Pic src={src} className="h-20 w-16 shrink-0" />
      <ArrowRight className="size-3.5 shrink-0 text-muted-foreground/60" />
      {u.status === 'failed' ? (
        <div className="grid h-20 w-16 shrink-0 place-items-center rounded-lg bg-destructive/10 text-destructive/80">
          <AlertTriangle className="size-5" />
        </div>
      ) : (
        <Pic src={u.status === 'done' ? res : undefined} className="h-20 w-16 shrink-0" />
      )}
      <div className="min-w-0 flex-1 space-y-0.5 text-xs">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{m?.source.name ?? u.item_label}</span>
          <span className={cn('shrink-0 text-[11px]', st.cls)}>{st.label}</span>
        </div>
        <div className="truncate text-[11px] text-muted-foreground">
          {m?.source.run_name ?? ''} · {[u.meta?.character, u.meta?.outfit].filter(Boolean).join(' · ') || u.item_label}
        </div>
        <div className="truncate text-[11px] text-muted-foreground">工作流：{m?.workflow.name ?? '—'}</div>
        {u.status === 'failed' && u.error && <div className="line-clamp-2 text-[11px] break-all text-destructive">{u.error}</div>}
        {u.status !== 'failed' && notes.length > 0 && <div className="truncate text-[11px] text-warning">{notes[0].text}</div>}
      </div>
    </button>
  )
}

function Detail({ u, onClose }: { u: RunUnit; onClose: () => void }) {
  const m = u.meta?.upscale
  const done = u.status === 'done'
  const [which, setWhich] = useState<Which>(done ? 'result' : 'source')
  const [hold, setHold] = useState(false)
  const [inspect, setInspect] = useState(false)
  useEffect(() => setWhich(done ? 'result' : 'source'), [u.id, done])
  const src = useUpscaleImage(u, 'source', 1400, true)
  const res = useUpscaleImage(u, 'result', 1400, done)
  // 按住「按住看原图」时临时显示原图，松开回到当前选择
  const shown = hold || which === 'source' ? src : res
  const open = async (w: Which, folder: boolean) => {
    const err = await api['upscale.open'](u.id, w, folder)
    if (err) toast.error(err)
  }
  const retry = async () => {
    const n = await call(api['upscale.retry']([u.id]))
    if (!n) return
    toast.success('已重新加入放大队列', { description: '原图会重新上传；使用入队时冻结的工作流与生成条件。' })
    await startRunnerChecked()
  }
  const rec = m?.recovered
  const loras = rec?.loras ?? []
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-4 pt-4 pb-2">
        <span className="truncate text-[14px] font-semibold">{m?.source.name ?? u.item_label}</span>
        <span className={cn('text-xs', STATUS[u.status].cls)}>{STATUS[u.status].label}</span>
        <div className="flex-1" />
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="关闭">
          <X />
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-5">
        <div className="space-y-2">
          <div className="flex items-center gap-1.5">
            <Chip active={which === 'source'} onClick={() => setWhich('source')}>
              原图
            </Chip>
            <Chip active={which === 'result'} onClick={() => done && setWhich('result')} className={cn(!done && 'opacity-50')}>
              放大结果
            </Chip>
            {done && (
              <button
                type="button"
                className="ml-auto rounded-md px-2 py-1 text-[11px] text-muted-foreground ring-1 ring-tint/[0.12] select-none hover:text-foreground"
                onPointerDown={() => setHold(true)}
                onPointerUp={() => setHold(false)}
                onPointerLeave={() => setHold(false)}
                title="按住时显示原图，松开显示放大结果"
              >
                按住看原图
              </button>
            )}
          </div>
          <div className="overflow-hidden rounded-xl bg-inset">
            {shown ? <img src={shown} alt="" className="max-h-[52vh] w-full object-contain" /> : <div className="grid h-48 place-items-center text-xs text-muted-foreground">{shown === null ? '无法加载预览（文件已移动或删除）' : which === 'result' && !done ? '还没有放大结果' : '加载中…'}</div>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => open('result', false)} disabled={!done}>
            <ImageIcon /> 打开结果
          </Button>
          <Button size="sm" variant="secondary" onClick={() => open('result', true)} disabled={!done}>
            <FolderOpen /> 结果所在文件夹
          </Button>
          <Button size="sm" variant="secondary" onClick={() => open('source', true)}>
            <FolderOpen /> 原图所在文件夹
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setInspect(true)}>
            <FileSearch /> 执行详情
          </Button>
          {u.status === 'failed' && (
            <Button size="sm" onClick={retry}>
              <RotateCcw /> 重试
            </Button>
          )}
        </div>
        {u.error && <div className="rounded-xl bg-destructive/10 p-3 text-xs leading-relaxed whitespace-pre-wrap text-destructive select-text">{u.error}</div>}
        {(m?.issues ?? []).length > 0 && (
          <div className="space-y-1 rounded-xl bg-inset p-3 text-xs leading-relaxed">
            {m!.issues.map((x, i) => (
              <div key={i} className={cn('flex gap-1.5', x.level === 'note' ? 'text-muted-foreground' : 'text-warning')}>
                {x.level === 'note' ? <Info className="mt-0.5 size-3 shrink-0" /> : <AlertTriangle className="mt-0.5 size-3 shrink-0" />}
                <span className="min-w-0 break-words">{x.text}</span>
              </div>
            ))}
          </div>
        )}
        <div className="grid grid-cols-[84px_1fr] gap-x-3 gap-y-1.5 text-xs">
          {(
            [
              ['原图任务', m?.source.run_name ?? ''],
              ['原图文件', m?.source.path ?? ''],
              ['原图 Seed', String(m?.source.seed ?? '—')],
              ['恢复来源', m?.source.snapshot === 'attempt' ? '原图实际提交的工作流快照' : '按冻结的工作流与写入值重建（旧记录没有提交快照）'],
              ['放大工作流', m?.workflow.name ?? ''],
              ['Checkpoint', rec?.checkpoint ?? '（未写入：放大工作流使用自己的设置）'],
              ['结果文件', u.outputs?.find((o) => o.role === 'final')?.saved ?? '—'],
              ['prompt_id', u.prompt_id ?? '—'],
            ] as [string, string][]
          ).map(([k, v]) => (
            <div key={k} className="contents">
              <span className="text-muted-foreground">{k}</span>
              <span className="min-w-0 truncate select-text" title={v}>
                {v}
              </span>
            </div>
          ))}
        </div>
        <div>
          <FieldLabel hint="写入放大工作流的 LoRA 列表，与原图相同（包括停用的条目）">LoRA</FieldLabel>
          <div className="space-y-0.5 font-mono text-[11px] text-muted-foreground select-text">
            {loras.length ? loras.map((l, i) => <div key={i} className={cn(!l.active && 'line-through opacity-60')}>{`${l.name}  ${l.strength}${l.clip !== l.strength ? ` / ${l.clip}` : ''}${l.active ? '' : '（停用）'}`}</div>) : '（原图没有 LoRA）'}
          </div>
        </div>
        <div>
          <FieldLabel>写入的正面 Prompt</FieldLabel>
          <pre className="rounded-xl bg-inset p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap select-text">{u.positive || '（空）'}</pre>
        </div>
        <div>
          <FieldLabel>写入的负面 Prompt</FieldLabel>
          <pre className="rounded-xl bg-inset p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap select-text">{u.negative || '（空）'}</pre>
        </div>
      </div>
      {inspect && <ExecutionDialog unitId={u.id} onClose={() => setInspect(false)} />}
    </div>
  )
}

const FILTERS: [string, string][] = [
  ['', '全部'],
  ['active', '未完成'],
  ['done', '完成'],
  ['failed', '失败'],
]

export default function UpscalePage() {
  const tick = useRunner((s) => s.tick)
  const status = useRunner((s) => s.status)
  const go = useNav((s) => s.go)
  const [rows, setRows] = useState<RunUnit[] | null>(null)
  const [filter, setFilter] = useState('')
  const [sel, setSel] = useState<number | null>(null)
  const load = useCallback(() => void api['upscale.list'](2000).then(setRows), [])
  useEffect(() => {
    const t = setTimeout(load, 200)
    return () => clearTimeout(t)
  }, [load, tick])
  const all = rows ?? []
  const count = (f: (u: RunUnit) => boolean) => all.filter(f).length
  const active = (u: RunUnit) => u.status === 'pending' || u.status === 'submitting' || u.status === 'submitted'
  const pending = count((u) => u.status === 'pending')
  const running = count((u) => u.status === 'submitting' || u.status === 'submitted')
  const failed = all.filter((u) => u.status === 'failed')
  const shown = all.filter((u) => (filter === 'active' ? active(u) : filter ? u.status === filter : true))
  const cur = all.find((u) => u.id === sel)
  const retryAll = async () => {
    const n = await call(api['upscale.retry'](failed.map((u) => u.id)))
    if (!n) return
    toast.success(`已重新加入 ${n} 张`)
    await startRunnerChecked()
  }
  const runnerIdle = !status.alive || status.state === 'paused' || status.state === 'pausing'
  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <PageHeader
          title="批量放大"
          description="在「运行记录」中选择图片加入放大队列。每张图按生成时的 Prompt、Checkpoint 与 LoRA 写入放大工作流；放大参数保持工作流中的值。结果保存在原图所在文件夹的「放大」子文件夹。"
          actions={
            <>
              <Button variant="ghost" size="sm" onClick={() => go('history')}>
                <Maximize2 /> 选择图片
              </Button>
              {failed.length > 0 && (
                <Button variant="ghost" size="sm" onClick={retryAll}>
                  <RotateCcw /> 重试失败（{failed.length}）
                </Button>
              )}
              {pending > 0 && runnerIdle && (
                <Button size="sm" onClick={() => void startRunnerChecked()}>
                  <Play /> 开始执行
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={load}>
                <RefreshCw /> 刷新
              </Button>
            </>
          }
        />
        <div className="flex items-center gap-3 px-6 pb-4">
          <div className="flex gap-1.5">
            {FILTERS.map(([k, l]) => (
              <Chip key={k} active={filter === k} onClick={() => setFilter(k)}>
                {l}
              </Chip>
            ))}
          </div>
          <span className="ml-auto text-xs text-muted-foreground" data-testid="upscale-summary">
            {rows ? `等待 ${pending} · 进行中 ${running} · 完成 ${count((u) => u.status === 'done')} · 失败 ${failed.length}` : ''}
            {pending > 0 && status.state === 'paused' ? '（执行器已暂停）' : ''}
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
          {rows && !shown.length ? (
            <EmptyState
              icon={<Maximize2 />}
              title={filter ? '没有匹配的记录' : '放大队列是空的'}
              description="在「运行记录」中选择图片（可以跨任务累计），点「加入放大队列」并选择放大工作流。"
              action={
                <Button size="sm" variant="secondary" onClick={() => go('history')}>
                  前往运行记录
                </Button>
              }
            />
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-2.5">
              {shown.map((u) => (
                <Row key={u.id} u={u} selected={sel === u.id} onClick={() => setSel(sel === u.id ? null : u.id)} />
              ))}
            </div>
          )}
        </div>
      </div>
      {cur && (
        <div className="absolute inset-y-3 right-3 z-30 w-[440px] overflow-hidden rounded-2xl bg-popover shadow-2xl ring-1 shadow-tint/15 ring-tint/[0.128] 2xl:static 2xl:my-3 2xl:mr-3 2xl:shrink-0 2xl:bg-card 2xl:shadow-none">
          <Detail u={cur} onClose={() => setSel(null)} />
        </div>
      )}
    </div>
  )
}
