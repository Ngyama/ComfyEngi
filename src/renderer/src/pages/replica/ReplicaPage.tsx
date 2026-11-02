// 套图复刻：导入 → 选择替换内容 → 选择新角色 → 预览 → 生成。全部在一个页面内完成，草稿自动保存。

import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, ArrowLeft, Check, ChevronDown, ChevronRight, Copy, FolderOpen, ImageOff, ImagePlus, ListPlus, Pencil, Play, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { EmptyState, PageHeader, SearchBox, StatusDot, TextInput } from '@/components/common'
import { api, call } from '@/lib/api'
import { confirm, useLib, useNav } from '@/lib/stores'
import { cn } from '@/lib/utils'
import type { ReplicaPlanView } from '@shared/api'
import { effectiveLoraConfig } from '@shared/lora-config'
import { normalizeReplicaData, originalPositive, PARAM_KEYS, PARAM_LABELS, tagStats, type ParamKey, type ReplacePart, type ReplicaData, type ReplicaImage, type ReplicaTag } from '@shared/replica'
import type { LoraResource, Workflow } from '@shared/types'
import { findPromptInjectors, findTriggerPaths } from '@shared/workflow-analysis'
import { FinalWorkflowDialog } from '../plan/dialogs'
import { Select } from '../settings/WorkflowEditor'

type Row = ReplicaPlanView['rows'][number]

const STEPS = ['导入', '选择替换内容', '选择新角色', '预览', '生成']
const PAGE = 20

export default function ReplicaPage() {
  const [id, setId] = useState<number | null>(null)
  return id === null ? <DraftList onOpen={setId} /> : <Editor key={id} id={id} onBack={() => setId(null)} />
}

function DraftList({ onOpen }: { onOpen: (id: number) => void }) {
  const [list, setList] = useState<Awaited<ReturnType<(typeof api)['replicas.list']>> | null>(null)
  const load = () => void call(api['replicas.list']()).then((r) => r && setList(r))
  useEffect(load, [])
  const create = async () => {
    const r = await call(api['replicas.create'](`复刻 ${(list?.length ?? 0) + 1}`))
    if (r) onOpen(r.id)
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="套图复刻"
        actions={
          <Button size="sm" onClick={create} data-testid="replica-new">
            <Plus /> 新建
          </Button>
        }
      />
      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-6 pb-5">
        {list?.map((d) => (
          <div key={d.id} className="flex items-center gap-3 rounded-xl bg-card px-3 py-2.5 ring-1 ring-tint/[0.08]" data-testid="replica-draft" data-id={d.id}>
            <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onOpen(d.id)} data-testid="replica-open">
              <div className="truncate text-[13px] font-medium">{d.name || '未命名'}</div>
              <div className="text-[11px] text-muted-foreground">{d.count} 张</div>
            </button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="删除草稿"
              onClick={async () => {
                if (!(await confirm({ title: `删除草稿「${d.name}」？`, description: '原图和已入队的内容不受影响。', confirmText: '删除', destructive: true }))) return
                await call(api['replicas.remove'](d.id))
                load()
              }}
            >
              <Trash2 />
            </Button>
          </div>
        ))}
        {list && !list.length && (
          <EmptyState
            icon={<Copy />}
            title="还没有复刻草稿"
            action={
              <Button onClick={create}>
                <Plus /> 新建复刻
              </Button>
            }
          />
        )}
      </div>
    </div>
  )
}

function Thumb({ path, className, width = 240 }: { path: string; className?: string; width?: number }) {
  const [src, setSrc] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let live = true
    setSrc(null)
    const load = () => void api['mining.image'](path, width).then((s) => live && setSrc(s), () => live && setSrc(null))
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') {
      load()
      return () => {
        live = false
      }
    }
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) {
        io.disconnect()
        load()
      }
    })
    io.observe(el)
    return () => {
      live = false
      io.disconnect()
    }
  }, [path, width])
  return (
    <div ref={ref} className={cn('grid place-items-center overflow-hidden rounded-lg bg-tint/[0.05]', className)}>
      {src ? <img src={src} alt="" className="size-full object-contain" /> : <ImageOff className="size-4 text-muted-foreground/50" />}
    </div>
  )
}

function Parts({ parts }: { parts: ReplacePart[] }) {
  return (
    <div className="font-mono text-[11.5px] leading-relaxed break-words whitespace-pre-wrap select-text" data-testid="replica-parts">
      {parts.map((p, i) =>
        p.kind === 'remove' ? (
          <del key={i} className="rounded bg-destructive/10 px-0.5 text-destructive" data-testid="part-remove">{p.text}</del>
        ) : p.kind === 'add' ? (
          <ins key={i} className="rounded bg-success/15 px-0.5 text-success no-underline" data-testid="part-add">{p.text}</ins>
        ) : (
          <span key={i} className={p.kind === 'sep' ? 'text-muted-foreground' : ''}>{p.text}</span>
        ),
      )}
    </div>
  )
}

function Tile({ label, value, tone, testid }: { label: string; value: React.ReactNode; tone?: 'warn' | 'error'; testid?: string }) {
  return (
    <div className="rounded-lg bg-tint/[0.03] px-3 py-1.5 ring-1 ring-tint/[0.06]" data-testid={testid}>
      <div className="text-[10.5px] text-muted-foreground">{label}</div>
      <div className={cn('text-[15px] font-semibold tabular-nums', tone === 'warn' && value ? 'text-warning' : '', tone === 'error' && value ? 'text-destructive' : '')}>{value}</div>
    </div>
  )
}

function Editor({ id, onBack }: { id: number; onBack: () => void }) {
  const lib = useLib((s) => s.lib)
  const [name, setName] = useState('')
  const [data, setData] = useState<ReplicaData | null>(null)
  const [step, setStep] = useState(0)
  const [plan, setPlan] = useState<ReplicaPlanView | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef<{ name?: string; data?: ReplicaData } | null>(null)
  const flush = async () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const p = pending.current
    pending.current = null
    if (p) await call(api['replicas.save']({ id, ...p }))
  }
  const refreshPlan = async () => {
    await flush()
    const r = await call(api['replicas.plan'](id))
    if (r) setPlan(r)
  }
  const planTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const schedule = (p: { name?: string; data?: ReplicaData }) => {
    pending.current = { ...pending.current, ...p }
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void flush(), 400)
    if (planTimer.current) clearTimeout(planTimer.current)
    planTimer.current = setTimeout(() => void refreshPlan(), 500)
  }
  const update = (patch: Partial<ReplicaData>) =>
    setData((d) => {
      const next = { ...d!, ...patch }
      schedule({ data: next })
      return next
    })
  const load = async () => {
    const r = await call(api['replicas.get'](id))
    if (!r) return onBack()
    setName(r.name ?? '')
    setData(normalizeReplicaData(r.data))
    void refreshPlan()
  }
  useEffect(() => {
    void load()
    return () => {
      void flush()
    }
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return null
  const active = data.images.filter((im) => !im.exclude)
  const setImage = (i: number, patch: Partial<ReplicaImage>) => update({ images: data.images.map((im, n) => (n === i ? { ...im, ...patch } : im)) })
  const counts = { total: data.images.length, valid: plan?.rows.filter((r) => r.state === 'valid').length ?? 0 }
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="replica-editor">
      <div className="flex items-center gap-2 px-6 pt-4 pb-2">
        <Button size="icon-sm" variant="ghost" aria-label="返回" onClick={async () => { await flush(); onBack() }} data-testid="replica-back">
          <ArrowLeft />
        </Button>
        <input
          value={name}
          onChange={(e) => {
            setName(e.target.value)
            schedule({ name: e.target.value })
          }}
          className="min-w-0 flex-1 bg-transparent text-[15px] font-semibold outline-none"
          data-testid="replica-name"
        />
      </div>
      <div className="flex items-center gap-1 px-6 pb-3" data-testid="replica-steps">
        {STEPS.map((s, i) => (
          <button key={s} type="button" onClick={() => setStep(i)} data-active={step === i || undefined} data-testid="replica-step" data-step={i} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12.5px] text-muted-foreground hover:bg-tint/[0.04] data-[active]:bg-primary/15 data-[active]:font-medium data-[active]:text-primary">
            <span className="grid size-4 place-items-center rounded-full bg-tint/[0.08] text-[10px]">{i + 1}</span>
            {s}
            {i === 0 && counts.total > 0 && <span className="text-[10.5px]">{counts.total}</span>}
            {i === 1 && data.removed_tags.length > 0 && <span className="text-[10.5px]">{data.removed_tags.length}</span>}
            {i === 3 && plan && counts.total > 0 && <span className="text-[10.5px]">{counts.valid}</span>}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden px-6 pb-4">
        {step === 0 && <ImportStep id={id} data={data} plan={plan} update={update} setImage={setImage} flush={flush} reload={load} />}
        {step === 1 && <TagStep images={active} removed={data.removed_tags} update={update} plan={plan} />}
        {step === 2 && lib && <CharacterStep data={data} update={update} plan={plan} />}
        {step === 3 && <PreviewStep id={id} data={data} plan={plan} setImage={setImage} update={update} goImport={() => setStep(0)} />}
        {step === 4 && <GenerateStep id={id} data={data} plan={plan} update={update} flush={flush} refresh={refreshPlan} />}
      </div>
      <div className="flex justify-end gap-2 border-t border-tint/[0.06] px-6 py-2.5">
        {step > 0 && <Button variant="ghost" size="sm" onClick={() => setStep(step - 1)} data-testid="replica-prev">上一步</Button>}
        {step < STEPS.length - 1 && <Button size="sm" onClick={() => setStep(step + 1)} data-testid="replica-next">下一步</Button>}
      </div>
    </div>
  )
}

// ---------------- 第 1 步：导入

function ImportStep({ id, data, plan, update, setImage, flush, reload }: { id: number; data: ReplicaData; plan: ReplicaPlanView | null; update: (p: Partial<ReplicaData>) => void; setImage: (i: number, p: Partial<ReplicaImage>) => void; flush: () => Promise<void>; reload: () => Promise<void> }) {
  const [recursive, setRecursive] = useState(false)
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null)
  const [sel, setSel] = useState<number | null>(null)
  const [filter, setFilter] = useState<'all' | 'ok' | 'check' | 'error'>('all')
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    const off = api.onRunnerEvent((e) => {
      if (e.kind === 'mining' && mounted.current && e.total) setBusy(e.done >= e.total ? null : { done: e.done, total: e.total })
    })
    return () => {
      mounted.current = false
      off?.()
    }
  }, [])
  const addFrom = async (p: Promise<{ images: ReplicaImage[]; errors: string[]; cancelled: boolean } | null>) => {
    const r = await call(p)
    setBusy(null)
    if (!r) return
    const known = new Set(data.images.map((im) => im.path))
    const fresh = r.images.filter((im) => !known.has(im.path))
    const images = [...data.images, ...fresh].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    update({ images })
    if (r.errors.length) toast.warning(r.errors[0])
    if (fresh.length) toast.success(`已导入 ${fresh.length} 张图片`)
    else if (r.images.length) toast.info('这些图片已经在草稿中')
  }
  const missing = plan?.rows.filter((r) => r.state === 'missing') ?? []
  const stateOf = (im: ReplicaImage) => (im.status === 'ok' || im.confirmed ? 'ok' : im.status)
  const count = (s: string) => data.images.filter((im) => stateOf(im) === s).length
  const shown = data.images.map((im, i) => [im, i] as const).filter(([im]) => filter === 'all' || stateOf(im) === filter)
  const cur = sel !== null ? data.images[sel] : null
  return (
    <div className="flex h-full min-h-0 gap-4">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 pb-3">
          <Button size="sm" onClick={() => addFrom(api['replicas.addFiles']())} data-testid="replica-add-files">
            <ImagePlus /> 选择图片
          </Button>
          <Button size="sm" variant="secondary" onClick={() => addFrom(api['replicas.addFolder'](recursive))} data-testid="replica-add-folder">
            <FolderOpen /> 选择文件夹
          </Button>
          <label className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
            <Switch checked={recursive} onCheckedChange={setRecursive} /> 含子文件夹
          </label>
          {busy && <span className="text-[11.5px] text-muted-foreground">读取中 {busy.done}/{busy.total}</span>}
          <div className="flex-1" />
          {([['all', '全部', data.images.length], ['ok', '读取成功', count('ok')], ['check', '需确认', count('check')], ['error', '失败', count('error')]] as const).map(([k, l, n]) => (
            <button key={k} type="button" onClick={() => setFilter(k)} data-active={filter === k || undefined} data-testid={`replica-count-${k}`} className={cn('rounded-md bg-tint/[0.04] px-2 py-1 text-[11.5px] data-[active]:bg-primary/15 data-[active]:text-primary', k === 'error' && n ? 'text-destructive' : k === 'check' && n ? 'text-warning' : 'text-muted-foreground')}>
              {l} {n}
            </button>
          ))}
        </div>
        {missing.length > 0 && (
          <div className="mb-3 flex items-center gap-2 rounded-lg bg-destructive/[0.07] px-3 py-2 text-[11.5px] text-destructive" data-testid="replica-missing">
            <AlertCircle className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{missing.length} 张原图不在原来的位置：{missing.slice(0, 4).map((r) => r.name).join('、')}{missing.length > 4 ? ' 等' : ''}</span>
            <Button
              size="sm"
              variant="secondary"
              data-testid="replica-relocate-folder"
              onClick={async () => {
                await flush()
                const r = await call(api['replicas.relocateFolder'](id))
                if (!r) return
                await reload()
                toast.success(`已重新定位 ${r.relocated} 张`, { description: [r.notFound.length ? `没有找到 ${r.notFound.length} 张` : '', r.mismatched.length ? `Prompt 不一致 ${r.mismatched.length} 张：${r.mismatched.slice(0, 3).join('、')}` : ''].filter(Boolean).join('；') || undefined })
              }}
            >
              重新定位
            </Button>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-2">
            {shown.map(([im, i]) => {
              const s = stateOf(im)
              const gone = missing.some((m) => m.index === i)
              return (
                <button key={im.path} type="button" onClick={() => setSel(i)} data-active={sel === i || undefined} data-testid="replica-card" data-name={im.name} data-status={s} className={cn('overflow-hidden rounded-lg bg-card text-left ring-1 ring-tint/[0.08] hover:ring-tint/25 data-[active]:ring-primary/70', im.exclude && 'opacity-45')}>
                  <Thumb path={im.path} className="aspect-square w-full rounded-none" />
                  <div className="flex items-center gap-1 px-1.5 py-1">
                    <StatusDot tone={gone || s === 'error' ? 'error' : s === 'check' ? 'warn' : 'ok'} />
                    <span className="truncate text-[10.5px]" title={im.path}>{im.name}</span>
                  </div>
                </button>
              )
            })}
          </div>
          {!data.images.length && <EmptyState icon={<ImagePlus />} title="选择一套图片开始" description="按原文件名排序，读取 PNG、JPEG、WebP 中的生成参数。" />}
        </div>
      </div>
      {cur && sel !== null && (
        <ImageDetail key={cur.path} im={cur} row={plan?.rows[sel]} onChange={(p) => setImage(sel, p)} onRelocate={async () => { await flush(); const r = await call(api['replicas.relocateFile'](id, sel)); if (r === false) toast.error('这张图片的 Prompt 与草稿中的不一致，没有替换'); if (r) await reload() }} onRemove={() => { update({ images: data.images.filter((_, n) => n !== sel) }); setSel(null) }} />
      )}
    </div>
  )
}

function ImageDetail({ im, row, onChange, onRelocate, onRemove }: { im: ReplicaImage; row?: Row; onChange: (p: Partial<ReplicaImage>) => void; onRelocate: () => void; onRemove: () => void }) {
  const [text, setText] = useState(im.positive)
  const need = (im.status !== 'ok' && !im.confirmed)
  return (
    <div className="w-[320px] shrink-0 space-y-3 overflow-y-auto rounded-xl bg-card p-3 ring-1 ring-tint/[0.08]" data-testid="replica-image-detail">
      <Thumb path={im.path} width={480} className="aspect-[4/3] w-full" />
      <div>
        <div className="truncate text-[12.5px] font-medium select-text" title={im.path}>{im.name}</div>
        {row?.state === 'missing' && (
          <button type="button" className="text-[11.5px] text-primary hover:underline" onClick={onRelocate} data-testid="replica-relocate-file">原图不在原位置，点击定位</button>
        )}
      </div>
      {need && (
        <div className="space-y-1.5 rounded-lg bg-warning/[0.08] p-2 text-[11.5px]" data-testid="replica-need-confirm">
          <div className="text-warning">{im.error || im.notes.at(-1) || '读取结果不确定'}</div>
          {im.candidates.slice(0, 8).map((c) => (
            <button key={c.key} type="button" className="block w-full truncate rounded bg-tint/[0.05] px-1.5 py-1 text-left hover:bg-primary/10" title={c.text} data-testid="replica-candidate" onClick={() => { setText(c.text); onChange({ positive: c.text, status: 'check', confirmed: true }) }}>
              <span className="text-muted-foreground">{c.label}：</span>{c.text}
            </button>
          ))}
        </div>
      )}
      <div>
        <div className="mb-1 text-[11px] text-muted-foreground">正向 Prompt</div>
        <textarea value={text} rows={6} onChange={(e) => setText(e.target.value)} onBlur={() => text !== im.positive && onChange({ positive: text, status: 'check', confirmed: !!text.trim() })} className="w-full rounded-lg bg-tint/[0.045] px-2 py-1.5 font-mono text-[11.5px] ring-1 ring-tint/[0.112] outline-none focus:ring-primary/50" data-testid="replica-image-positive" />
        {need && im.positive.trim() && (
          <Button size="sm" variant="secondary" className="mt-1" onClick={() => onChange({ confirmed: true })} data-testid="replica-confirm">
            <Check /> 确认这个结果
          </Button>
        )}
      </div>
      {im.negative && (
        <div>
          <div className="mb-1 text-[11px] text-muted-foreground">负面 Prompt</div>
          <div className="max-h-24 overflow-y-auto rounded-lg bg-tint/[0.03] px-2 py-1.5 font-mono text-[11px] select-text">{im.negative}</div>
        </div>
      )}
      <ParamList im={im} row={row} onChange={onChange} />
      {im.loras.length > 0 && (
        <div className="text-[11px]">
          <div className="mb-1 text-muted-foreground">原图使用的 LoRA</div>
          {im.loras.map((l) => <div key={l.name} className="truncate font-mono">{l.name} {l.strength ?? ''}</div>)}
        </div>
      )}
      <div className="flex gap-2 pt-1">
        <Button size="sm" variant="ghost" onClick={() => onChange({ exclude: !im.exclude })} data-testid="replica-exclude">{im.exclude ? '恢复' : '排除'}</Button>
        <Button size="sm" variant="ghost" className="text-destructive" onClick={onRemove}>移除</Button>
      </div>
    </div>
  )
}

const STATE_TEXT: Record<string, [string, string]> = { ok: ['已读取', 'text-success'], confirm: ['需确认', 'text-warning'], missing: ['缺失', 'text-muted-foreground'], unmapped: ['不支持', 'text-muted-foreground'] }

function ParamList({ im, row, onChange }: { im: ReplicaImage; row?: Row; onChange: (p: Partial<ReplicaImage>) => void }) {
  const [edit, setEdit] = useState<ParamKey | null>(null)
  return (
    <div data-testid="replica-params">
      <div className="mb-1 text-[11px] text-muted-foreground">生成参数</div>
      <div className="space-y-0.5 text-[11.5px]">
        {PARAM_KEYS.map((k) => {
          const r = row?.params.find((p) => p.key === k)
          const rec = im.params[k]
          const st = r?.state ?? rec?.state ?? 'missing'
          const manual = im.overrides[k]
          return (
            <div key={k} className="flex items-center gap-1.5" data-testid="replica-param" data-key={k} data-state={st} title={r?.note ?? rec?.note}>
              <span className="w-16 shrink-0 text-muted-foreground">{PARAM_LABELS[k]}</span>
              {edit === k ? (
                <input
                  autoFocus
                  defaultValue={String(manual ?? rec?.value ?? '')}
                  className="min-w-0 flex-1 rounded bg-tint/[0.05] px-1 font-mono ring-1 ring-tint/[0.12] outline-none"
                  onBlur={(e) => {
                    const v = e.target.value.trim()
                    const next = { ...im.overrides }
                    if (!v) delete next[k]
                    else next[k] = k === 'sampler' || k === 'scheduler' ? v : Number(v)
                    onChange({ overrides: next })
                    setEdit(null)
                  }}
                  onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                  data-testid="replica-param-input"
                />
              ) : (
                <button type="button" className="min-w-0 flex-1 truncate text-left font-mono hover:text-primary" onClick={() => setEdit(k)} data-testid="replica-param-edit">
                  {String(manual ?? rec?.value ?? '—')}
                </button>
              )}
              <span className={cn('shrink-0 text-[10.5px]', STATE_TEXT[st]?.[1])}>{manual !== undefined ? '手动' : STATE_TEXT[st]?.[0]}</span>
              {r?.applied && <Check className="size-3 shrink-0 text-success" aria-label="写入工作流" />}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ---------------- 第 2 步：Tag 汇总

function TagStep({ images, removed, update, plan }: { images: ReplicaImage[]; removed: string[]; update: (p: Partial<ReplicaData>) => void; plan: ReplicaPlanView | null }) {
  const [q, setQ] = useState('')
  const [minRatio, setMinRatio] = useState(0)
  const [open, setOpen] = useState<string | null>(null)
  const list = useMemo(() => images.map((im) => ({ positive: originalPositive(im) })), [images])
  const tags = useMemo(() => tagStats(list), [list])
  const set = new Set(removed)
  const shown = tags.filter((t) => t.ratio * 100 >= minRatio && (!q || `${t.key} ${t.raw}`.toLowerCase().includes(q.toLowerCase().replace(/\s+/g, '_')) || t.raw.toLowerCase().includes(q.toLowerCase())))
  const toggle = (k: string) => update({ removed_tags: set.has(k) ? removed.filter((x) => x !== k) : [...removed, k] })
  const sample = plan?.rows.find((r) => r.removed.length) ?? plan?.rows.find((r) => r.state !== 'excluded' && r.state !== 'invalid')
  return (
    <div className="flex h-full min-h-0 gap-4">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 pb-2">
          <SearchBox value={q} onChange={setQ} placeholder="搜索 Tag" className="min-w-40 flex-1" />
          <label className="flex items-center gap-1 text-[11.5px] text-muted-foreground">
            出现率 ≥
            <input type="number" min={0} max={100} value={minRatio} onChange={(e) => setMinRatio(Number(e.target.value) || 0)} className="w-14 rounded bg-tint/[0.05] px-1 py-0.5 text-center ring-1 ring-tint/[0.1] outline-none" data-testid="tag-min-ratio" />%
          </label>
          <Button size="sm" variant="ghost" onClick={() => update({ removed_tags: [...new Set([...removed, ...shown.map((t) => t.key)])] })} data-testid="tag-select-shown">全选</Button>
          <Button size="sm" variant="ghost" onClick={() => update({ removed_tags: removed.filter((k) => !shown.some((t) => t.key === k)) })} data-testid="tag-clear-shown">取消</Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto rounded-xl ring-1 ring-tint/[0.08]" data-testid="tag-list">
          {shown.map((t) => (
            <TagRow key={t.key} t={t} checked={set.has(t.key)} open={open === t.key} onToggle={() => toggle(t.key)} onOpen={() => setOpen(open === t.key ? null : t.key)} images={images} />
          ))}
          {!shown.length && <div className="py-8 text-center text-xs text-muted-foreground">{tags.length ? '没有匹配的 Tag' : '导入图片后在这里选择要替换的 Tag'}</div>}
        </div>
      </div>
      <div className="flex w-[320px] shrink-0 flex-col gap-3 overflow-y-auto">
        <div className="rounded-xl bg-card p-3 ring-1 ring-tint/[0.08]" data-testid="tag-selected">
          <div className="mb-1.5 text-[12px] font-medium">已选 {removed.length} 个</div>
          <div className="flex flex-wrap gap-1">
            {removed.map((k) => (
              <button key={k} type="button" onClick={() => toggle(k)} className="rounded-md bg-destructive/10 px-1.5 py-0.5 font-mono text-[11px] text-destructive line-through hover:bg-destructive/20">{k}</button>
            ))}
            {!removed.length && <span className="text-[11.5px] text-muted-foreground">勾选原角色的 Tag</span>}
          </div>
        </div>
        {sample && (
          <div className="rounded-xl bg-card p-3 ring-1 ring-tint/[0.08]" data-testid="tag-sample">
            <div className="mb-1.5 truncate text-[12px] font-medium">替换效果：{sample.name}</div>
            <Parts parts={sample.parts} />
          </div>
        )}
      </div>
    </div>
  )
}

function TagRow({ t, checked, open, onToggle, onOpen, images }: { t: ReplicaTag; checked: boolean; open: boolean; onToggle: () => void; onOpen: () => void; images: ReplicaImage[] }) {
  return (
    <div className="border-b border-tint/[0.05] last:border-0" data-testid="tag-row" data-key={t.key} data-count={t.count}>
      <div className={cn('flex items-center gap-2 px-2.5 py-1.5 text-[12px]', checked && 'bg-destructive/[0.06]')}>
        <input type="checkbox" checked={checked} onChange={onToggle} className="accent-primary" data-testid="tag-check" />
        <button type="button" className="min-w-0 flex-1 truncate text-left font-mono" onClick={onToggle} title={t.raw}>{t.raw}</button>
        {t.grouped > 0 && <span className="shrink-0 rounded bg-warning/10 px-1 text-[10.5px] text-warning" title="这个 Tag 在组合权重里，选中后这些图片需要手动编辑">组合 {t.grouped}</span>}
        <span className="h-1 w-14 shrink-0 overflow-hidden rounded-full bg-tint/[0.08]"><span className="block h-full bg-primary/60" style={{ width: `${t.ratio * 100}%` }} /></span>
        <span className="w-16 shrink-0 text-right text-[11px] text-muted-foreground tabular-nums">{t.count} · {Math.round(t.ratio * 100)}%</span>
        <button type="button" className="shrink-0 text-muted-foreground hover:text-foreground" onClick={onOpen} aria-label="查看详情" data-testid="tag-open">
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
      </div>
      {open && (
        <div className="space-y-1.5 bg-tint/[0.02] px-3 py-2 text-[11px]" data-testid="tag-detail">
          <div className="flex flex-wrap gap-1">
            {t.forms.map((f) => <span key={f.raw} className="rounded bg-tint/[0.06] px-1.5 py-0.5 font-mono">{f.raw}<span className="ml-1 text-muted-foreground">×{f.count}</span></span>)}
          </div>
          <div className="flex flex-wrap gap-1">
            {t.images.slice(0, 18).map((i) => images[i] && <Thumb key={i} path={images[i].path} width={96} className="size-12" />)}
            {t.images.length > 18 && <span className="self-center text-muted-foreground">等 {t.images.length} 张</span>}
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------- 第 3 步：新角色、LoRA、工作流

function CharacterStep({ data, update, plan }: { data: ReplicaData; update: (p: Partial<ReplicaData>) => void; plan: ReplicaPlanView | null }) {
  const lib = useLib((s) => s.lib)!
  const [q, setQ] = useState('')
  const [wf, setWf] = useState<Workflow | null>(null)
  const [resources, setResources] = useState<LoraResource[]>([])
  const wid = data.workflow_id ?? lib.settings.default_workflow_id ?? null
  useEffect(() => {
    if (wid) void call(api['workflows.get'](wid)).then((w) => setWf(w ?? null))
    else setWf(null)
    void call(api['loras.list']()).then((r) => r && setResources(r))
  }, [wid])
  const character = lib.characters.find((c) => c.id === data.character_id)
  const outfits = lib.outfits.filter((o) => o.character_id === data.character_id)
  const cfg = wf ? effectiveLoraConfig(data.lora_config ?? undefined, wf.api_json ?? {}, wf.mapping ?? []) : null
  const toggles = wf ? findPromptInjectors(wf.api_json ?? {}, wf.mapping ?? []).filter((i) => i.kind === 'trigger_toggle' && i.polarity.length) : []
  const cuttable = wf ? findTriggerPaths(wf.api_json ?? {}, wf.mapping ?? []).filter((p) => p.status === 'controllable').length : 0
  const charLora = character?.loras?.find((l) => l.name && !l.disabled)
  const replaceKey = cfg?.char_targets?.lora1?.replace
  const imageLoraNames = [...new Set(data.images.flatMap((im) => im.loras.map((l) => l.name)))]
  const shownChars = lib.characters.filter((c) => !q || c.name.toLowerCase().includes(q.toLowerCase()))
  const field = 'rounded-lg bg-tint/[0.045] px-2 py-1 text-[12px] ring-1 ring-tint/[0.112] outline-none'
  return (
    <div className="grid h-full min-h-0 grid-cols-2 gap-4 overflow-y-auto" data-testid="replica-character-step">
      <div className="space-y-3">
        <section className="rounded-xl bg-card p-3 ring-1 ring-tint/[0.08]">
          <div className="mb-2 flex items-center gap-2 text-[12.5px] font-medium">
            新角色
            <SearchBox value={q} onChange={setQ} placeholder="搜索" className="ml-auto w-40" />
          </div>
          <div className="flex max-h-44 flex-wrap gap-1.5 overflow-y-auto">
            {shownChars.map((c) => (
              <button key={c.id} type="button" onClick={() => update({ character_id: c.id!, outfit_id: null, lora: { enabled: true, name: null, resource_id: null, strength: null } })} data-active={c.id === data.character_id || undefined} data-testid="replica-character" data-id={c.id} className="rounded-lg bg-tint/[0.04] px-2.5 py-1 text-[12px] hover:bg-tint/[0.08] data-[active]:bg-primary/15 data-[active]:text-primary">{c.name}</button>
            ))}
            {!lib.characters.length && <span className="text-[11.5px] text-muted-foreground">角色库还是空的</span>}
          </div>
          {character && (
            <div className="mt-2 space-y-1.5 text-[11.5px]">
              <div className="rounded-lg bg-success/[0.06] px-2 py-1.5 font-mono break-words select-text" data-testid="replica-character-prompt">{character.positive || '（基础 Prompt 为空）'}</div>
              {outfits.length > 0 && (
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">服装</span>
                  <Select value={String(data.outfit_id ?? '')} onChange={(v) => update({ outfit_id: v ? Number(v) : null })} options={[['', '不使用'], ...outfits.map((o) => [String(o.id), o.name] as [string, string])]} className="min-w-40" />
                </div>
              )}
            </div>
          )}
        </section>
        <section className="rounded-xl bg-card p-3 ring-1 ring-tint/[0.08]">
          <div className="mb-2 text-[12.5px] font-medium">负面 Prompt</div>
          <Select value={data.negative_mode} onChange={(v) => update({ negative_mode: v as ReplicaData['negative_mode'] })} options={[['append', '保留原图 + 追加角色负面'], ['keep', '只保留原图'], ['replace', '只用角色负面']]} className="min-w-56" />
        </section>
        <section className="rounded-xl bg-card p-3 ring-1 ring-tint/[0.08]" data-testid="replica-keep">
          <div className="mb-2 text-[12.5px] font-medium">保留原始参数</div>
          <div className="space-y-1.5 text-[12px]">
            {([['seed', 'Seed'], ['size', '尺寸'], ['sampling', 'Steps、CFG、Sampler、Scheduler、Denoise']] as const).map(([k, l]) => (
              <label key={k} className="flex items-center justify-between gap-3">
                {l}
                <Switch checked={data.keep[k]} onCheckedChange={(v) => update({ keep: { ...data.keep, [k]: !!v } })} data-testid={`replica-keep-${k}`} />
              </label>
            ))}
            <label className="flex items-center justify-between gap-3 text-muted-foreground">
              也使用需要确认的值
              <Switch checked={data.accept_uncertain} onCheckedChange={(v) => update({ accept_uncertain: !!v })} data-testid="replica-accept-uncertain" />
            </label>
          </div>
        </section>
      </div>
      <div className="space-y-3">
        <section className="rounded-xl bg-card p-3 ring-1 ring-tint/[0.08]">
          <div className="mb-2 text-[12.5px] font-medium">工作流</div>
          <Select value={String(wid ?? '')} onChange={(v) => update({ workflow_id: v ? Number(v) : null, lora_config: null })} options={[['', '请选择'], ...lib.workflows.map((w) => [String(w.id), w.name] as [string, string])]} className="min-w-56" />
          {toggles.length + cuttable > 0 && (
            <label className="mt-2 flex items-center justify-between gap-3 text-[12px]" data-testid="replica-trigger">
              关闭 LoRA 自动触发词注入（触发词由角色 Prompt 负责）
              <Switch checked={data.disable_triggers} onCheckedChange={(v) => update({ disable_triggers: !!v })} data-testid="replica-trigger-switch" />
            </label>
          )}
        </section>
        <section className="rounded-xl bg-card p-3 ring-1 ring-tint/[0.08]" data-testid="replica-lora">
          <div className="mb-2 text-[12.5px] font-medium">LoRA</div>
          <div className="space-y-1.5 text-[12px]">
            <div className="flex items-center gap-2" data-testid="replica-char-lora">
              <Switch checked={data.lora.enabled} onCheckedChange={(v) => update({ lora: { ...data.lora, enabled: !!v } })} data-testid="replica-char-lora-switch" />
              <span className="shrink-0 text-muted-foreground">新角色</span>
              <Select
                value={data.lora.name ?? ''}
                onChange={(v) => {
                  const r = resources.find((x) => x.comfyName === v)
                  update({ lora: { ...data.lora, name: v || null, resource_id: r?.id ?? null } })
                }}
                options={[['', charLora ? `角色 LoRA：${charLora.name}` : '不加载 LoRA'], ...resources.filter((r) => r.comfyName).map((r) => [r.comfyName!, r.comfyName!] as [string, string])]}
                className="min-w-0 flex-1"
              />
              <input type="number" step="0.05" value={data.lora.strength ?? charLora?.strength ?? 1} onChange={(e) => update({ lora: { ...data.lora, strength: Number(e.target.value) } })} className={cn(field, 'w-16')} data-testid="replica-char-lora-strength" />
            </div>
            <div className="pt-1.5 text-[11px] text-muted-foreground">工作流中的 LoRA</div>
            {cfg?.entries.map((e) => (
              <div key={e.key} className="flex items-center gap-2" data-testid="replica-wf-lora" data-key={e.key}>
                <Switch
                  checked={e.enabled && replaceKey !== e.key}
                  disabled={replaceKey === e.key}
                  onCheckedChange={(v) => update({ lora_config: { ...cfg, entries: cfg.entries.map((x) => (x.key === e.key ? { ...x, enabled: !!v } : x)) } })}
                  data-testid="replica-wf-lora-switch"
                />
                <span className={cn('min-w-0 flex-1 truncate font-mono text-[11.5px]', replaceKey === e.key && 'text-destructive line-through')} title={e.name}>{e.name}</span>
                <Button
                  size="sm"
                  variant={replaceKey === e.key ? 'secondary' : 'ghost'}
                  disabled={!data.lora.enabled || !(data.lora.name || charLora)}
                  onClick={() => update({ lora_config: { ...cfg, char_targets: { ...cfg.char_targets, lora1: replaceKey === e.key ? (undefined as never) : { node: e.node, replace: e.key } } } })}
                  data-testid="replica-wf-lora-replace"
                >
                  {replaceKey === e.key ? '已替换' : '替换'}
                </Button>
              </div>
            ))}
            {cfg && !cfg.entries.length && <div className="text-[11.5px] text-muted-foreground">工作流中没有可控制的 LoRA Loader</div>}
            {imageLoraNames.length > 0 && <div className="pt-1 text-[11px] break-words text-muted-foreground" data-testid="replica-image-loras">原图用过：{imageLoraNames.slice(0, 10).join('、')}</div>}
          </div>
        </section>
        {plan && plan.errors.length > 0 && <Problems list={plan.errors} />}
      </div>
    </div>
  )
}

function Problems({ list, tone = 'error' }: { list: string[]; tone?: 'error' | 'warn' }) {
  return (
    <div className={cn('space-y-0.5 rounded-lg px-3 py-2 text-[11.5px]', tone === 'error' ? 'bg-destructive/[0.07] text-destructive' : 'bg-warning/[0.08] text-warning')} data-testid={tone === 'error' ? 'replica-errors' : 'replica-warnings'}>
      {list.slice(0, 6).map((m, i) => <div key={i}>{m}</div>)}
      {list.length > 6 && <div>等 {list.length} 项</div>}
    </div>
  )
}

// ---------------- 第 4 步：预览

const ROW_LABEL: Record<Row['state'], [string, string]> = { valid: ['可生成', 'text-success'], confirm: ['需确认', 'text-warning'], invalid: ['不能生成', 'text-destructive'], missing: ['原图丢失', 'text-destructive'], excluded: ['已排除', 'text-muted-foreground'] }

function PreviewStep({ id, data, plan, setImage, update, goImport }: { id: number; data: ReplicaData; plan: ReplicaPlanView | null; setImage: (i: number, p: Partial<ReplicaImage>) => void; update: (p: Partial<ReplicaData>) => void; goImport: () => void }) {
  const [page, setPage] = useState(0)
  const [only, setOnly] = useState<'all' | 'problem'>('all')
  const [json, setJson] = useState<number | null>(null)
  if (!plan) return <div className="text-xs text-muted-foreground">计算中…</div>
  const rows = plan.rows
  const n = (s: Row['state']) => rows.filter((r) => r.state === s).length
  const sizes = new Map<string, number>()
  const def = plan.default_size ? `${String(plan.default_size.width)}×${String(plan.default_size.height)}` : '工作流默认'
  for (const r of rows) if (r.state === 'valid') {
    const k = r.width && r.height ? `${r.width}×${r.height}` : `工作流默认 ${def}`
    sizes.set(k, (sizes.get(k) ?? 0) + 1)
  }
  const shown = rows.filter((r) => only === 'all' || (r.state !== 'valid' && r.state !== 'excluded'))
  const confirmable = data.images.map((im, i) => [im, i] as const).filter(([im]) => im.status === 'check' && !im.confirmed && im.positive.trim() && !im.exclude)
  return (
    <div className="flex h-full min-h-0 flex-col gap-3" data-testid="replica-preview">
      <div className="grid grid-cols-5 gap-2">
        <Tile label="总数" value={rows.length} testid="sum-total" />
        <Tile label="可生成" value={n('valid')} testid="sum-valid" />
        <Tile label="需确认" value={n('confirm')} tone="warn" testid="sum-confirm" />
        <Tile label="不能生成" value={n('invalid') + n('missing')} tone="error" testid="sum-invalid" />
        <Tile label="已排除" value={n('excluded')} testid="sum-excluded" />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-muted-foreground" data-testid="replica-summary">
        <span>工作流：<b className="font-medium text-foreground">{plan.workflow?.name ?? '未选择'}</b></span>
        <span data-testid="replica-sizes">尺寸：{[...sizes].map(([k, v]) => `${k} × ${v}`).join('；') || '—'}</span>
        <span data-testid="replica-loras">LoRA：{plan.loras.join('、') || '不加载'}</span>
        <span data-testid="replica-param-summary">原始参数：{PARAM_KEYS.map((k) => `${PARAM_LABELS[k]} ${rows.filter((r) => r.params.find((p) => p.key === k)?.applied).length}`).join('　')}</span>
      </div>
      {plan.errors.length > 0 && <Problems list={plan.errors} />}
      {plan.warnings.length > 0 && <Problems list={plan.warnings} tone="warn" />}
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => { setOnly(only === 'all' ? 'problem' : 'all'); setPage(0) }} className="rounded-md bg-tint/[0.04] px-2 py-1 text-[11.5px] data-[active]:bg-primary/15 data-[active]:text-primary" data-active={only === 'problem' || undefined} data-testid="replica-only-problem">只看需要处理的</button>
        {confirmable.length > 0 && (
          <Button size="sm" variant="secondary" onClick={() => update({ images: data.images.map((im) => (confirmable.some(([x]) => x === im) ? { ...im, confirmed: true } : im)) })} data-testid="replica-confirm-all">
            <Check /> 全部确认（{confirmable.length}）
          </Button>
        )}
        <div className="flex-1" />
        {shown.length > PAGE && (
          <div className="flex items-center gap-1 text-[11.5px] text-muted-foreground">
            <Button size="sm" variant="ghost" disabled={page === 0} onClick={() => setPage(page - 1)}>上一页</Button>
            {page + 1} / {Math.ceil(shown.length / PAGE)}
            <Button size="sm" variant="ghost" disabled={(page + 1) * PAGE >= shown.length} onClick={() => setPage(page + 1)} data-testid="replica-next-page">下一页</Button>
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
        {shown.slice(page * PAGE, (page + 1) * PAGE).map((r) => (
          <PreviewRow key={r.path} r={r} im={data.images[r.index]} characterName={useLib.getState().lib?.characters.find((c) => c.id === data.character_id)?.name ?? ''} onChange={(p) => setImage(r.index, p)} onJson={() => r.unit !== null && setJson(r.unit)} goImport={goImport} />
        ))}
        {!rows.length && <EmptyState icon={<ImagePlus />} title="还没有导入图片" />}
      </div>
      {json !== null && <FinalWorkflowDialog index={json} count={plan.units} load={(i) => api['replicas.finalWorkflow'](id, i)} exportJson={(i) => api['replicas.exportWorkflow'](id, i)} onIndex={setJson} onClose={() => setJson(null)} />}
    </div>
  )
}

function PreviewRow({ r, im, characterName, onChange, onJson, goImport }: { r: Row; im: ReplicaImage; characterName: string; onChange: (p: Partial<ReplicaImage>) => void; onJson: () => void; goImport: () => void }) {
  const [edit, setEdit] = useState(false)
  const [pos, setPos] = useState(r.positive)
  const [neg, setNeg] = useState(r.negative)
  useEffect(() => {
    if (!edit) {
      setPos(r.positive)
      setNeg(r.negative)
    }
  }, [edit, r.positive, r.negative])
  const [label, tone] = ROW_LABEL[r.state]
  return (
    <div className={cn('rounded-xl bg-card p-2.5 ring-1 ring-tint/[0.08]', r.state === 'excluded' && 'opacity-50')} data-testid="replica-row" data-name={r.name} data-state={r.state}>
      <div className="mb-1.5 flex items-center gap-2 text-[11.5px]">
        <span className="font-medium select-text">{r.name}</span>
        <span className="text-muted-foreground" data-testid="replica-output-name">→ {r.output_name}.png</span>
        <span className={tone}>{label}</span>
        {r.manual && <span className="rounded bg-warning/10 px-1 text-[10.5px] text-warning">手动编辑</span>}
        <span className="truncate text-muted-foreground" title={r.reason}>{r.reason}</span>
        <div className="flex-1" />
        <span className="shrink-0 text-muted-foreground">Seed {r.seed}{r.seed_generated ? '（新）' : ''} · {r.width && r.height ? `${r.width}×${r.height}` : '默认尺寸'}</span>
        {r.state === 'confirm' && im.status !== 'ok' && !im.confirmed && <Button size="sm" variant="secondary" onClick={() => onChange({ confirmed: true })} data-testid="replica-row-confirm">确认</Button>}
        {(r.state === 'invalid' || r.state === 'missing') && <Button size="sm" variant="ghost" onClick={goImport}>处理</Button>}
        <Button size="sm" variant="ghost" onClick={() => setEdit(!edit)} data-testid="replica-row-edit"><Pencil /> 编辑</Button>
        {r.unit !== null && <Button size="sm" variant="ghost" onClick={onJson} data-testid="replica-row-json">最终工作流</Button>}
        <Button size="sm" variant="ghost" onClick={() => onChange({ exclude: !im.exclude })} data-testid="replica-row-exclude">{im.exclude ? '恢复' : '排除'}</Button>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex min-w-0 gap-2">
          <Thumb path={r.path} width={160} className="size-20 shrink-0" />
          <div className="max-h-24 min-w-0 flex-1 overflow-y-auto font-mono text-[11.5px] leading-relaxed break-words select-text" data-testid="replica-original">{r.original_positive || <span className="text-muted-foreground">没有读取到 Prompt</span>}</div>
        </div>
        <div className="flex min-w-0 gap-2">
          <div className="grid size-20 shrink-0 place-items-center rounded-lg bg-primary/[0.07] text-center text-[11px] text-primary" data-testid="replica-pending">{characterName || '新角色'}<br />待生成</div>
          <div className="max-h-24 min-w-0 flex-1 overflow-y-auto"><Parts parts={r.parts} /></div>
        </div>
      </div>
      {edit && (
        <div className="mt-2 space-y-1.5">
          <textarea value={pos} rows={4} onChange={(e) => setPos(e.target.value)} className="w-full rounded-lg bg-tint/[0.045] px-2 py-1.5 font-mono text-[11.5px] ring-1 ring-tint/[0.112] outline-none focus:ring-primary/50" data-testid="replica-edit-positive" />
          <textarea value={neg} rows={2} placeholder="负面 Prompt" onChange={(e) => setNeg(e.target.value)} className="w-full rounded-lg bg-tint/[0.045] px-2 py-1.5 font-mono text-[11.5px] ring-1 ring-tint/[0.112] outline-none focus:ring-primary/50" data-testid="replica-edit-negative" />
          <div className="flex gap-2">
            <Button size="sm" onClick={() => { onChange({ manual_positive: pos, manual_negative: neg === r.negative ? im.manual_negative : neg }); setEdit(false) }} data-testid="replica-edit-save">保存</Button>
            {(im.manual_positive !== null || im.manual_negative !== null) && <Button size="sm" variant="ghost" onClick={() => { onChange({ manual_positive: null, manual_negative: null }); setEdit(false) }} data-testid="replica-edit-reset"><RotateCcw /> 恢复自动替换</Button>}
          </div>
          <ParamList im={im} row={r} onChange={onChange} />
        </div>
      )}
    </div>
  )
}

// ---------------- 第 5 步：生成

function GenerateStep({ id, data, plan, update, flush, refresh }: { id: number; data: ReplicaData; plan: ReplicaPlanView | null; update: (p: Partial<ReplicaData>) => void; flush: () => Promise<void>; refresh: () => Promise<void> }) {
  const go = useNav((s) => s.go)
  const [done, setDone] = useState<{ n: number; dir: string } | null>(null)
  const enqueue = async (start: boolean) => {
    await refresh()
    await flush()
    const skipped = plan?.rows.filter((r) => r.state !== 'valid' && r.state !== 'excluded').length ?? 0
    if (skipped && !(await confirm({ title: `有 ${skipped} 张图片不会生成`, description: `${plan!.rows.filter((r) => r.state !== 'valid' && r.state !== 'excluded').slice(0, 8).map((r) => `${r.name}：${r.reason}`).join('\n')}\n\n只生成其余 ${plan!.units} 张？`, confirmText: '继续' }))) return
    const r = await call(api['replicas.enqueue'](id))
    if (!r) return
    if (r.runId === null) return void toast.error('无法加入队列', { description: r.errors.slice(0, 4).join('\n') })
    setDone({ n: r.units, dir: r.output_dir })
    if (start) {
      const st = await api['runner.status']()
      if (!st.alive || st.state === 'paused' || st.state === 'pausing') {
        const pre = await api['runner.precheck']()
        if (pre.error && !(await confirm({ title: '无法连接 ComfyUI', description: `${pre.error}\n\n仍要开始吗？开始后会持续重试连接。`, confirmText: '仍然开始' }))) return
        if (pre.messages.length && !(await confirm({ title: '检查发现问题', description: `${pre.messages.slice(0, 10).join('\n')}\n\n仍要开始吗？`, confirmText: '仍然开始' }))) return
        await api['runner.start']()
      }
    }
    toast.success(`已加入队列（${r.units} 张）`, { description: '之后修改草稿不影响这次入队的内容。', action: { label: '查看队列', onClick: () => go('queue') } })
  }
  const ok = !!plan && !plan.errors.length && plan.units > 0
  return (
    <div className="max-w-2xl space-y-3" data-testid="replica-generate">
      <section className="rounded-xl bg-card p-3 ring-1 ring-tint/[0.08]">
        <div className="mb-1.5 text-[12.5px] font-medium">输出目录</div>
        <TextInput value={data.output.dir} onChange={(v) => update({ output: { dir: v } })} placeholder={plan?.output_dir || '默认：工作区 output 下的新目录'} className="w-full" mono />
        <div className="mt-1.5 text-[11px] text-muted-foreground" data-testid="replica-output-dir">保存到 {plan?.output_dir || '—'}，文件名与原图对应，不覆盖已有文件。</div>
      </section>
      {plan && plan.errors.length > 0 && <Problems list={plan.errors} />}
      {plan && plan.warnings.length > 0 && <Problems list={plan.warnings} tone="warn" />}
      <div className="flex items-center gap-2">
        <Button disabled={!ok} onClick={() => enqueue(true)} data-testid="replica-start"><Play /> 生成 {plan?.units ?? 0} 张</Button>
        <Button disabled={!ok} variant="secondary" onClick={() => enqueue(false)} data-testid="replica-enqueue"><ListPlus /> 只加入队列</Button>
      </div>
      {done && (
        <div className="flex items-center gap-2 rounded-lg bg-success/[0.08] px-3 py-2 text-[12px] text-success" data-testid="replica-done">
          <Check className="size-3.5" /> 已加入队列 {done.n} 张，保存到 {done.dir}
          <button type="button" className="ml-auto underline" onClick={() => go('queue')}>查看队列</button>
        </div>
      )}
    </div>
  )
}
