// 运行记录：以缩略图浏览历史结果，点开查看 Prompt、Seed、prompt_id 与输出位置。

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, FolderOpen, History, ImageIcon, ImageOff, RefreshCw, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Chip, CopyButton, EmptyState, FieldLabel, PageHeader, SearchBox } from '@/components/common'
import { api } from '@/lib/api'
import { useRunner } from '@/lib/stores'
import { cn } from '@/lib/utils'
import type { RunUnit } from '@shared/types'

const thumbCache = new Map<string, string | null>()

function useImage(unitId: number, size: number, enabled = true) {
  const key = `${unitId}:${size}`
  const [src, setSrc] = useState<string | null | undefined>(thumbCache.get(key))
  useEffect(() => {
    if (!enabled || thumbCache.has(key)) {
      setSrc(thumbCache.get(key))
      return
    }
    let alive = true
    void api['history.image'](unitId, size)
      .catch(() => null)
      .then((r) => {
        thumbCache.set(key, r)
        if (alive) setSrc(r)
      })
    return () => {
      alive = false
    }
  }, [key, unitId, size, enabled])
  return src
}

function Thumb({ u, selected, onClick }: { u: RunUnit; selected: boolean; onClick: () => void }) {
  const ref = useRef<HTMLButtonElement>(null)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver((e) => e[0].isIntersecting && setVisible(true), { rootMargin: '200px' })
    io.observe(el)
    return () => io.disconnect()
  }, [])
  const failed = u.status === 'failed'
  const src = useImage(u.id, 360, visible && !failed)
  const m = u.meta
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      className={cn('group overflow-hidden rounded-xl bg-card text-left ring-1 ring-white/[0.05] transition hover:ring-white/[0.15]', selected && 'ring-2 ring-primary/70')}
    >
      <div className="relative aspect-[3/4] bg-black/30">
        {failed ? (
          <div className="absolute inset-0 grid place-items-center text-destructive/80">
            <AlertTriangle className="size-6" />
          </div>
        ) : src ? (
          <img src={src} alt="" className="absolute inset-0 size-full object-cover" draggable={false} />
        ) : (
          <div className="absolute inset-0 grid place-items-center text-muted-foreground/40">{src === null ? <ImageOff className="size-5" /> : <ImageIcon className="size-5" />}</div>
        )}
        <span className="absolute top-2 left-2 rounded-md bg-black/55 px-1.5 py-0.5 font-mono text-[10px] text-white/80">{u.seed}</span>
      </div>
      <div className="px-2.5 py-2">
        <div className="truncate text-[12px] font-medium">{u.item_label}</div>
        <div className="truncate text-[10.5px] text-muted-foreground">
          {[m?.character, m?.outfit, m?.expression].filter(Boolean).join(' · ') || u.run_name}
        </div>
      </div>
    </button>
  )
}

function Detail({ u, onClose }: { u: RunUnit; onClose: () => void }) {
  const src = useImage(u.id, 1400, u.status === 'done')
  const m = u.meta
  const fmt = (t: number | null) => (t ? new Date(t * 1000).toLocaleString('zh-CN') : '—')
  const open = async (kind: 'history.openImage' | 'history.showInFolder') => {
    const err = await api[kind](u.id)
    if (err) toast.error(err)
  }
  const rows: [string, string][] = [
    ['任务', u.run_name ?? ''],
    ['角色', m?.character ?? ''],
    ['剧情', m?.story || '—'],
    [m?.section || '内容', `${u.item_label}（${m?.n}/${m?.of}）`],
    ['服装', m?.outfit || '—'],
    ['表情', m?.expression || '—'],
    ['镜头', m?.camera || '—'],
    ['男性', m?.male ? ['是', ...(m.male_templates ?? [])].join(' · ') : '否'],
    ['prompt_id', u.prompt_id ?? '—'],
    ['提交', fmt(u.submitted_at)],
    ['完成', fmt(u.finished_at)],
  ]
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-4 pt-4 pb-2">
        <span className="truncate text-[14px] font-semibold">{u.item_label}</span>
        <span className={cn('text-xs', u.status === 'done' ? 'text-success' : 'text-destructive')}>{u.status === 'done' ? '成功' : '失败'}</span>
        <div className="flex-1" />
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="关闭">
          <X />
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-5">
        {u.status === 'done' && (
          <div className="overflow-hidden rounded-xl bg-black/30">
            {src ? <img src={src} alt="" className="max-h-[52vh] w-full object-contain" /> : <div className="grid h-48 place-items-center text-xs text-muted-foreground">{src === null ? '无法加载预览（ComfyUI 未启动或文件已移动）' : '加载中…'}</div>}
          </div>
        )}
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={() => open('history.openImage')} disabled={!u.outputs?.length}>
            <ImageIcon /> 打开图片
          </Button>
          <Button size="sm" variant="secondary" onClick={() => open('history.showInFolder')} disabled={!u.outputs?.length}>
            <FolderOpen /> 所在文件夹
          </Button>
          <CopyButton text={String(u.seed)} label={`复制 Seed ${u.seed}`} />
        </div>
        {u.error && <div className="rounded-xl bg-destructive/10 p-3 text-xs leading-relaxed whitespace-pre-wrap text-destructive select-text">{u.error}</div>}
        <div className="grid grid-cols-[72px_1fr] gap-x-3 gap-y-1.5 text-xs">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <span className="text-muted-foreground">{k}</span>
              <span className="min-w-0 truncate select-text" title={v}>
                {v}
              </span>
            </div>
          ))}
        </div>
        <div>
          <FieldLabel>输出文件</FieldLabel>
          <div className="space-y-1 font-mono text-[11px] text-muted-foreground select-text">
            {u.outputs?.length ? u.outputs.map((o, i) => <div key={i} className="break-all">[{o.type}] {o.path || `${o.subfolder ? `${o.subfolder}/` : ''}${o.filename}`}</div>) : '（ComfyUI 未返回文件信息）'}
          </div>
        </div>
        <div>
          <FieldLabel right={<CopyButton text={u.positive} />}>最终正面 Prompt</FieldLabel>
          <pre className="rounded-xl bg-black/25 p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap select-text">{u.positive || '（空）'}</pre>
        </div>
        <div>
          <FieldLabel right={<CopyButton text={u.negative} />}>最终负面 Prompt</FieldLabel>
          <pre className="rounded-xl bg-black/25 p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap select-text">{u.negative || '（空）'}</pre>
        </div>
      </div>
    </div>
  )
}

export default function HistoryPage() {
  const tick = useRunner((s) => s.tick)
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  const [rows, setRows] = useState<RunUnit[] | null>(null)
  const [sel, setSel] = useState<number | null>(null)
  const load = useCallback(() => void api['history.list'](q.trim(), status, 600).then(setRows), [q, status])
  useEffect(() => {
    const t = setTimeout(load, 200)
    return () => clearTimeout(t)
  }, [load, tick])
  const cur = rows?.find((r) => r.id === sel)
  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <PageHeader
          title="运行记录"
          description="每张图的实际 Prompt、Seed 与输出文件；图片仍由 ComfyUI 按原工作流保存。"
          actions={
            <Button variant="ghost" size="sm" onClick={load}>
              <RefreshCw /> 刷新
            </Button>
          }
        />
        <div className="flex items-center gap-3 px-6 pb-4">
          <SearchBox value={q} onChange={setQ} placeholder="搜索任务、角色、动作、表情、Prompt 或 prompt_id…" className="max-w-md flex-1" />
          <div className="flex gap-1.5">
            {[
              ['', '全部'],
              ['done', '成功'],
              ['failed', '失败'],
            ].map(([k, l]) => (
              <Chip key={k} active={status === k} onClick={() => setStatus(k)}>
                {l}
              </Chip>
            ))}
          </div>
          <span className="ml-auto text-xs text-muted-foreground">{rows ? `${rows.length} 条` : ''}</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
          {rows && !rows.length ? (
            <EmptyState icon={<History />} title={q || status ? '没有匹配的记录' : '还没有运行记录'} description="开始生成后，每张图片的结果都会出现在这里。" />
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
              {(rows ?? []).map((u) => (
                <Thumb key={u.id} u={u} selected={sel === u.id} onClick={() => setSel(sel === u.id ? null : u.id)} />
              ))}
            </div>
          )}
        </div>
      </div>
      {cur && (
        <div className="absolute inset-y-3 right-3 z-30 w-[420px] overflow-hidden rounded-2xl bg-popover shadow-2xl ring-1 shadow-black/50 ring-white/[0.08] 2xl:static 2xl:my-3 2xl:mr-3 2xl:shrink-0 2xl:bg-card 2xl:shadow-none">
          <Detail u={cur} onClose={() => setSel(null)} />
        </div>
      )}
    </div>
  )
}
