// 套图复刻：导入成品套图 → 识别 / 筛选保留片段 → 配置新的工作流、角色、服装、LoRA、全局与场景 → 预览 → 入队。
// 每张图保留「镜头及之后的内容（去掉旧角色 / 服装 Tag）」、尺寸与顺序；不继承原图的工作流、LoRA、Seed 与采样参数。
// 全部在一个页面内完成，草稿自动保存。预览显示的 Prompt 与写入工作流的内容由主进程同一份计划计算。

import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AlertCircle, ArrowLeft, Check, ChevronDown, ChevronRight, Copy, FolderOpen, ImageOff, ImagePlus, ListPlus, Pencil, Play, Plus, RotateCcw, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { EmptyState, PageHeader, StatusDot, TextInput } from '@/components/common'
import { api, call } from '@/lib/api'
import { confirm, templatesOf, useLib, useNav } from '@/lib/stores'
import { cn } from '@/lib/utils'
import type { ReplicaPlanView } from '@shared/api'
import { loraStem } from '@shared/mapping'
import { normalizeKey } from '@shared/tags'
import { assignOutfit, imageSize, MAX_REPEAT, normalizeReplicaData, outfitRuns, promptUsable, repeatOf, withoutOutfit, type ReplicaData, type ReplicaImage, type ReplicaRow } from '@shared/replica'
import { cameraKeysOf, recognizeDraft, type ImageRecognition, type SegRole, type SetRecognition, type TagSummary } from '@shared/replica-recognize'
import type { Outfit } from '@shared/types'
import { FinalWorkflowDialog } from '../plan/dialogs'
import { LoraPanelView, type LoraPanelData } from '../plan/LoraPanel'
import { CharacterPicker, GlobalPicker, WorkflowMenu } from '../plan/pickers'
import { Select } from '../settings/WorkflowEditor'

/** 草稿修改：传入函数时基于最新状态计算（连续操作、异步回调不会用旧状态覆盖新状态） */
type Update = (p: Partial<ReplicaData> | ((d: ReplicaData) => Partial<ReplicaData>)) => void

const STEPS = ['导入', '识别 / 筛选', '配置', '预览', '入队']
const PAGE = 20

export default function ReplicaPage() {
  const [id, setId] = useState<number | null>(null)
  const [attempt, setAttempt] = useState(0)
  if (id === null) return <DraftList onOpen={setId} />
  return (
    <Guard key={`${id}:${attempt}`} onBack={() => setId(null)} onRetry={() => setAttempt((n) => n + 1)}>
      <Editor id={id} onBack={() => setId(null)} />
    </Guard>
  )
}

/** 页面出错时显示原因并允许返回或重新打开草稿（不吞掉错误：原因显示给用户，同时写入控制台） */
class Guard extends Component<{ onBack: () => void; onRetry: () => void; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error) {
    console.error('套图复刻页面出错', error)
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center" data-testid="replica-crashed">
        <AlertCircle className="size-6 text-destructive" />
        <div className="text-[13px] font-medium">套图复刻页面出错，草稿中已保存的内容不受影响</div>
        <div className="max-w-xl font-mono text-[11.5px] break-words text-muted-foreground select-text">{this.state.error.message}</div>
        <div className="flex gap-2">
          <Button size="sm" onClick={this.props.onRetry}>重新打开草稿</Button>
          <Button size="sm" variant="ghost" onClick={this.props.onBack}>返回列表</Button>
        </div>
      </div>
    )
  }
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
      <div className="px-6 pb-2 text-[11.5px] text-muted-foreground">导入一套成品图，保留每张图的镜头与动作描述、尺寸和顺序，换上新的工作流、角色、服装、LoRA、画风与场景整套重新生成。</div>
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

function Tile({ label, value, tone, testid }: { label: string; value: React.ReactNode; tone?: 'warn' | 'error'; testid?: string }) {
  return (
    <div className="rounded-lg bg-tint/[0.03] px-3 py-1.5 ring-1 ring-tint/[0.06]" data-testid={testid}>
      <div className="text-[10.5px] text-muted-foreground">{label}</div>
      <div className={cn('text-[15px] font-semibold tabular-nums', tone === 'warn' && value ? 'text-warning' : '', tone === 'error' && value ? 'text-destructive' : '')}>{value}</div>
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

function Pager({ page, total, size, onPage }: { page: number; total: number; size: number; onPage: (p: number) => void }) {
  if (total <= size) return null
  return (
    <div className="flex items-center gap-1 text-[11.5px] text-muted-foreground">
      <Button size="sm" variant="ghost" disabled={page === 0} onClick={() => onPage(page - 1)}>上一页</Button>
      {page + 1} / {Math.ceil(total / size)}
      <Button size="sm" variant="ghost" disabled={(page + 1) * size >= total} onClick={() => onPage(page + 1)} data-testid="replica-next-page">下一页</Button>
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
  /** 保存失败时把修改放回待保存队列（下次修改或返回时重试），返回是否已全部保存 */
  const flush = async (): Promise<boolean> => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const p = pending.current
    pending.current = null
    if (!p) return true
    const r = await call(api['replicas.save']({ id, ...p }), (m) => toast.error('草稿没有保存，修改仍保留在界面上，下次修改时会重试', { description: m }))
    if (r !== undefined) return true
    // 保存期间又有新的修改时，新修改优先
    const later = pending.current as typeof p | null
    pending.current = { ...p, ...later }
    return false
  }
  // 只采用最后一次请求的计划：较早的请求晚返回时不能覆盖新的结果
  const planSeq = useRef(0)
  const refreshPlan = async () => {
    const seq = ++planSeq.current
    await flush()
    const r = await call(api['replicas.plan'](id))
    if (r && seq === planSeq.current) setPlan(r)
    return r
  }
  const planTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const schedule = (p: { name?: string; data?: ReplicaData }) => {
    pending.current = { ...pending.current, ...p }
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void flush(), 400)
    if (planTimer.current) clearTimeout(planTimer.current)
    planTimer.current = setTimeout(() => void refreshPlan(), 500)
  }
  const update: Update = (patch) =>
    setData((d) => {
      const next = { ...d!, ...(typeof patch === 'function' ? patch(d!) : patch) }
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
  const cameraKeys = useMemo(() => cameraKeysOf(lib?.templates ?? []), [lib?.templates])
  const recog = useMemo(() => (data ? recognizeDraft(data, cameraKeys) : null), [data, cameraKeys])
  if (!data || !recog) return null
  const setImage = (i: number, patch: Partial<ReplicaImage>) => update((d) => ({ images: d.images.map((im, n) => (n === i ? { ...im, ...patch } : im)) }))
  const needFix = data.images.filter((im, i) => !im.exclude && promptUsable(im) && recog.images[i].needs_fix).length
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="replica-editor">
      <div className="flex items-center gap-2 px-6 pt-4 pb-2">
        <Button size="icon-sm" variant="ghost" aria-label="返回" onClick={async () => { if ((await flush()) || (await confirm({ title: '草稿没有保存', description: '最近的修改没有写入草稿，返回后会丢失。仍要返回吗？', confirmText: '仍然返回', destructive: true }))) onBack() }} data-testid="replica-back">
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
      {data.legacy && <LegacyNotice data={data} />}
      <div className="flex items-center gap-1 px-6 pb-3" data-testid="replica-steps">
        {STEPS.map((s, i) => (
          <button key={s} type="button" onClick={() => setStep(i)} data-active={step === i || undefined} data-testid="replica-step" data-step={i} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12.5px] text-muted-foreground hover:bg-tint/[0.04] data-[active]:bg-primary/15 data-[active]:font-medium data-[active]:text-primary">
            <span className="grid size-4 place-items-center rounded-full bg-tint/[0.08] text-[10px]">{i + 1}</span>
            {s}
            {i === 0 && data.images.length > 0 && <span className="text-[10.5px]">{data.images.length}</span>}
            {i === 1 && needFix > 0 && <span className="text-[10.5px] text-warning" data-testid="replica-need-fix-count">{needFix} 待处理</span>}
            {i === 3 && plan && data.images.length > 0 && <span className="text-[10.5px]">{plan.units}</span>}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden px-6 pb-4">
        {step === 0 && <ImportStep id={id} data={data} plan={plan} update={update} setImage={setImage} flush={flush} reload={load} />}
        {step === 1 && <RecognizeStep data={data} recog={recog} plan={plan} update={update} setImage={setImage} />}
        {step === 2 && lib && <ConfigureStep data={data} plan={plan} update={update} />}
        {step === 3 && <PreviewStep id={id} data={data} plan={plan} goRecognize={() => setStep(1)} />}
        {step === 4 && <GenerateStep id={id} data={data} plan={plan} update={update} flush={flush} refresh={refreshPlan} />}
      </div>
      <div className="flex justify-end gap-2 border-t border-tint/[0.06] px-6 py-2.5">
        {step > 0 && <Button variant="ghost" size="sm" onClick={() => setStep(step - 1)} data-testid="replica-prev">上一步</Button>}
        {step < STEPS.length - 1 && <Button size="sm" onClick={() => setStep(step + 1)} data-testid="replica-next">下一步</Button>}
      </div>
    </div>
  )
}

/** 旧版草稿：说明迁移了什么、哪些内容无法迁移（旧版设置的原始值保存在草稿中，不会丢失） */
function LegacyNotice({ data }: { data: ReplicaData }) {
  const [open, setOpen] = useState(false)
  const notes = data.legacy?.notes ?? []
  return (
    <div className="mx-6 mb-2 rounded-lg bg-warning/[0.08] px-3 py-2 text-[11.5px] text-warning" data-testid="replica-legacy">
      <button type="button" className="flex w-full items-center gap-1.5 text-left" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        这是旧版复刻草稿，已按新版规则读取（{notes.length} 条说明）。旧版设置的原始值保存在草稿中，不会被删除。
      </button>
      {open && (
        <ul className="mt-1.5 list-disc space-y-0.5 pl-6" data-testid="replica-legacy-notes">
          {notes.map((n, i) => <li key={i}>{n}</li>)}
          {!notes.length && <li>没有需要特别注意的内容</li>}
        </ul>
      )}
    </div>
  )
}

// ---------------- 第 1 步：导入

function ImportStep({ id, data, plan, update, setImage, flush, reload }: { id: number; data: ReplicaData; plan: ReplicaPlanView | null; update: Update; setImage: (i: number, p: Partial<ReplicaImage>) => void; flush: () => Promise<boolean>; reload: () => Promise<void> }) {
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
    // 读取期间草稿可能已被修改：基于最新状态合并
    const known = new Set(data.images.map((im) => im.path))
    const fresh = r.images.filter((im) => !known.has(im.path))
    update((d) => {
      const have = new Set(d.images.map((im) => im.path))
      return { images: [...d.images, ...r.images.filter((im) => !have.has(im.path))].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })) }
    })
    if (r.errors.length) toast.warning(r.errors[0])
    if (fresh.length) toast.success(`已导入 ${fresh.length} 张图片`)
    else if (r.images.length) toast.info('这些图片已经在草稿中')
  }
  const missing = plan?.rows.filter((r) => r.state === 'missing') ?? []
  const stateOf = (im: ReplicaImage) => (promptUsable(im) ? 'ok' : im.status)
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
                if (!(await flush())) return
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
                    <span className="truncate text-[10.5px]" title={im.path}><span className="text-muted-foreground tabular-nums">{i + 1}</span> {im.name}</span>
                  </div>
                </button>
              )
            })}
          </div>
          {!data.images.length && <EmptyState icon={<ImagePlus />} title="选择一套图片开始" description="按原文件名排序，读取 PNG、JPEG、WebP 中的 Prompt 与尺寸。" />}
        </div>
      </div>
      {cur && sel !== null && (
        <ImageDetail key={cur.path} im={cur} gone={missing.some((m) => m.index === sel)} onChange={(p) => setImage(sel, p)} onRelocate={async () => { if (!(await flush())) return; const r = await call(api['replicas.relocateFile'](id, sel)); if (r === false) toast.error('这张图片的 Prompt 与草稿中的不一致，没有替换'); if (r) await reload() }} onRemove={() => { const path = cur.path; update((d) => ({ images: d.images.filter((x) => x.path !== path) })); setSel(null) }} />
      )}
    </div>
  )
}

function ImageDetail({ im, gone, onChange, onRelocate, onRemove }: { im: ReplicaImage; gone: boolean; onChange: (p: Partial<ReplicaImage>) => void; onRelocate: () => void; onRemove: () => void }) {
  const [text, setText] = useState(im.positive)
  const need = !promptUsable(im)
  const size = imageSize(im)
  return (
    <div className="w-[320px] shrink-0 space-y-3 overflow-y-auto rounded-xl bg-card p-3 ring-1 ring-tint/[0.08]" data-testid="replica-image-detail">
      <Thumb path={im.path} width={480} className="aspect-[4/3] w-full" />
      <div>
        <div className="truncate text-[12.5px] font-medium select-text" title={im.path}>{im.name}</div>
        {gone && (
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
        <div className="mb-1 text-[11px] text-muted-foreground">原图正向 Prompt</div>
        <textarea value={text} rows={6} onChange={(e) => setText(e.target.value)} onBlur={() => text !== im.positive && onChange({ positive: text, status: 'check', confirmed: !!text.trim() })} className="w-full rounded-lg bg-tint/[0.045] px-2 py-1.5 font-mono text-[11.5px] ring-1 ring-tint/[0.112] outline-none focus:ring-primary/50" data-testid="replica-image-positive" />
        {need && im.positive.trim() && (
          <Button size="sm" variant="secondary" className="mt-1" onClick={() => onChange({ confirmed: true })} data-testid="replica-confirm">
            <Check /> 确认这个结果
          </Button>
        )}
      </div>
      {im.negative && (
        <div>
          <div className="mb-1 text-[11px] text-muted-foreground">原图负面 Prompt</div>
          <div className="max-h-24 overflow-y-auto rounded-lg bg-tint/[0.03] px-2 py-1.5 font-mono text-[11px] select-text">{im.negative}</div>
        </div>
      )}
      <div className="text-[11.5px]" data-testid="replica-image-size">
        <span className="text-muted-foreground">尺寸：</span>
        {size.width ? `${size.width} × ${size.height}` : '没有尺寸信息'}
        {size.state === 'confirm' && <span className="ml-1 text-warning">（{size.note}）</span>}
      </div>
      <div className="rounded-lg bg-tint/[0.03] px-2 py-1.5 text-[11px] text-muted-foreground" data-testid="replica-source-info">
        原图的 Seed、Steps、CFG、Sampler、工作流和 LoRA 只作参考，不会用于重新生成。
        {im.loras.length > 0 && <div className="mt-1 font-mono">原图 LoRA：{im.loras.map((l) => `${loraStem(l.name)}${l.strength !== undefined ? ` ${l.strength}` : ''}`).join('、')}</div>}
      </div>
      <div className="flex gap-2 pt-1">
        <Button size="sm" variant="ghost" onClick={() => onChange({ exclude: !im.exclude })} data-testid="replica-exclude">{im.exclude ? '恢复' : '排除'}</Button>
        <Button size="sm" variant="ghost" className="text-destructive" onClick={onRemove}>移除</Button>
      </div>
    </div>
  )
}

// ---------------- 第 2 步：识别 / 筛选

const ROLE_STYLE: Record<SegRole, string> = {
  common: 'text-muted-foreground line-through decoration-muted-foreground/60',
  prefix: 'text-warning line-through',
  camera: 'rounded bg-sky-500/15 px-0.5 text-sky-700 dark:text-sky-300',
  keep: '',
  character: 'rounded bg-destructive/10 px-0.5 text-destructive line-through',
  outfit: 'rounded bg-violet-500/15 px-0.5 text-violet-700 line-through dark:text-violet-300',
  lora: 'rounded bg-destructive/10 px-0.5 text-destructive line-through',
}
const ROLE_LABEL: Record<SegRole, string> = { common: '共同前缀（替换）', prefix: '开头（替换）', camera: '镜头（保留起点）', keep: '保留', character: '旧角色 Tag（删除）', outfit: '旧服装 Tag（删除）', lora: 'LoRA 文字（删除）' }

function RecognizeStep({ data, recog, plan, update, setImage }: { data: ReplicaData; recog: SetRecognition; plan: ReplicaPlanView | null; update: Update; setImage: (i: number, p: Partial<ReplicaImage>) => void }) {
  const [filter, setFilter] = useState<'all' | 'fix' | 'ok'>('all')
  const [page, setPage] = useState(0)
  const live = data.images.map((im, i) => [im, i] as const).filter(([im]) => !im.exclude && promptUsable(im))
  const fixCount = live.filter(([, i]) => recog.images[i].needs_fix).length
  const shown = live.filter(([, i]) => filter === 'all' || (filter === 'fix' ? recog.images[i].needs_fix : !recog.images[i].needs_fix))
  const setFix = (key: string, v: ReplicaData['tag_fix'][string] | null) =>
    update((d) => {
      const next = { ...d.tag_fix }
      if (v === null) delete next[key]
      else next[key] = v
      return { tag_fix: next }
    })
  const acceptAll = async () => {
    const list = live.filter(([im, i]) => recog.images[i].needs_fix && recog.images[i].retained.trim() && !recog.images[i].manual && im.retained_manual === null)
    if (!list.length) return
    if (!(await confirm({ title: `确认 ${list.length} 张图的当前识别结果？`, description: '这些图片的识别结果不可靠（原因见每张图）。确认后按当前显示的保留片段生成；之后识别结果变化时需要重新确认。', confirmText: '全部确认' }))) return
    const paths = new Map(list.map(([im, i]) => [im.path, recog.images[i].retained]))
    update((d) => ({ images: d.images.map((im) => (paths.has(im.path) ? { ...im, accepted: paths.get(im.path)! } : im)) }))
  }
  if (!data.images.length) return <EmptyState icon={<ImagePlus />} title="还没有导入图片" description="在第 1 步导入一套成品图。" />
  return (
    <div className="flex h-full min-h-0 flex-col gap-3" data-testid="replica-recognize">
      <SetSummary data={data} recog={recog} update={update} setFix={setFix} />
      <div className="flex flex-wrap items-center gap-2">
        {([['all', '全部', live.length], ['fix', '需要处理', fixCount], ['ok', '可靠', live.length - fixCount]] as const).map(([k, l, n]) => (
          <button key={k} type="button" onClick={() => { setFilter(k); setPage(0) }} data-active={filter === k || undefined} data-testid={`recog-filter-${k}`} className={cn('rounded-md bg-tint/[0.04] px-2 py-1 text-[11.5px] data-[active]:bg-primary/15 data-[active]:text-primary', k === 'fix' && n ? 'text-warning' : 'text-muted-foreground')}>
            {l} {n}
          </button>
        ))}
        {fixCount > 0 && <Button size="sm" variant="ghost" onClick={acceptAll} data-testid="recog-accept-all"><Check /> 确认全部当前结果</Button>}
        <span className="text-[11px] text-muted-foreground">点击 Tag 可以修正：设为保留起点、删除或保留。</span>
        <div className="flex-1" />
        <Pager page={page} total={shown.length} size={PAGE} onPage={setPage} />
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
        {shown.slice(page * PAGE, (page + 1) * PAGE).map(([im, i]) => (
          <RecogRow key={im.path} index={i} im={im} r={recog.images[i]} row={plan?.rows[i]} data={data} setImage={(p) => setImage(i, p)} setFix={setFix} />
        ))}
        {!shown.length && <div className="py-8 text-center text-xs text-muted-foreground">{filter === 'fix' ? '没有需要处理的图片' : '没有可以识别的图片（请先在第 1 步处理读取失败的图片）'}</div>}
      </div>
    </div>
  )
}

function TagChips({ list, tone, onRemove, removeTitle, testid }: { list: TagSummary[]; tone: string; onRemove: (k: string) => void; removeTitle: string; testid: string }) {
  return (
    <div className="flex flex-wrap gap-1" data-testid={testid}>
      {list.map((t) => (
        <span key={t.key} className={cn('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[11px]', tone)} data-testid="recog-tag" data-key={t.key} data-source={t.source} title={`${t.raw}（${t.count} 张${t.source === 'fix' ? '，手动修正' : '，自动识别'}）`}>
          {t.key}
          <span className="opacity-60">{t.count}</span>
          {t.source === 'fix' && <span className="opacity-60">✎</span>}
          <button type="button" aria-label={removeTitle} title={removeTitle} onClick={() => onRemove(t.key)} className="opacity-60 hover:opacity-100" data-testid="recog-tag-remove">
            <X className="size-3" />
          </button>
        </span>
      ))}
      {!list.length && <span className="text-[11px] text-muted-foreground">没有</span>}
    </div>
  )
}

/** 整套的识别结果：共同前缀、要删除的角色 / 服装 Tag，以及手动修正 */
function SetSummary({ data, recog, update, setFix }: { data: ReplicaData; recog: SetRecognition; update: Update; setFix: (key: string, v: ReplicaData['tag_fix'][string] | null) => void }) {
  const [editPrefix, setEditPrefix] = useState(false)
  const [prefix, setPrefix] = useState(data.prefix_text ?? recog.prefix_raw)
  const [add, setAdd] = useState('')
  const [addAs, setAddAs] = useState<'character' | 'outfit' | 'keep'>('character')
  const addTags = () => {
    const keys = add.split(/[,，\n]/).map((s) => normalizeKey(s)).filter(Boolean)
    if (!keys.length) return
    update((d) => ({ tag_fix: { ...d.tag_fix, ...Object.fromEntries(keys.map((k) => [k, addAs])) } }))
    setAdd('')
  }
  // 自动识别的 Tag：移除时标记为保留；手动加入的：移除修正
  const drop = (t: TagSummary[]) => (k: string) => setFix(k, t.find((x) => x.key === k)?.source === 'fix' ? null : 'keep')
  return (
    <section className="space-y-2 rounded-xl bg-card p-3 text-[12px] ring-1 ring-tint/[0.08]" data-testid="recog-summary">
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-24 shrink-0 font-medium">共同前缀</span>
        {editPrefix ? (
          <>
            <TextInput value={prefix} onChange={setPrefix} className="min-w-0 flex-1" mono placeholder="逗号分隔的 Tag，例如 masterpiece, best quality, 1girl" />
            <Button size="sm" onClick={() => { update({ prefix_text: prefix }); setEditPrefix(false) }} data-testid="recog-prefix-save">保存</Button>
            <Button size="sm" variant="ghost" onClick={() => setEditPrefix(false)}>取消</Button>
          </>
        ) : (
          <>
            <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted-foreground" title={recog.prefix_raw} data-testid="recog-prefix">{recog.prefix_raw || '（没有识别到共同前缀）'}</span>
            <span className="shrink-0 text-[11px] text-muted-foreground">{recog.prefix_auto ? '自动识别' : '手动指定'} · {recog.prefix_matches}/{recog.usable} 张以它开头</span>
            <Button size="sm" variant="ghost" onClick={() => { setPrefix(data.prefix_text ?? recog.prefix_raw); setEditPrefix(true) }} data-testid="recog-prefix-edit"><Pencil /> 修改</Button>
            {!recog.prefix_auto && <Button size="sm" variant="ghost" onClick={() => update({ prefix_text: null })} data-testid="recog-prefix-reset"><RotateCcw /> 自动</Button>}
          </>
        )}
      </div>
      <div className="text-[11px] text-muted-foreground">每张图从第一个镜头 Tag（from side、cowboy shot 等，以及素材库中的镜头模板）开始保留，之前的内容替换为新的全局 / 场景 Prompt；没有镜头 Tag 时按共同前缀的结尾分割，并标记为需要确认。</div>
      <div className="flex items-start gap-2">
        <span className="w-24 shrink-0 pt-0.5 font-medium">删除：旧角色</span>
        <TagChips list={recog.character} tone="bg-destructive/10 text-destructive" onRemove={drop(recog.character)} removeTitle="不删除这个 Tag" testid="recog-character-tags" />
      </div>
      <div className="flex items-start gap-2">
        <span className="w-24 shrink-0 pt-0.5 font-medium">删除：旧服装</span>
        <TagChips list={recog.outfit} tone="bg-violet-500/15 text-violet-700 dark:text-violet-300" onRemove={drop(recog.outfit)} removeTitle="不删除这个 Tag" testid="recog-outfit-tags" />
      </div>
      {recog.kept.length > 0 && (
        <div className="flex items-start gap-2">
          <span className="w-24 shrink-0 pt-0.5 font-medium">强制保留</span>
          <TagChips list={recog.kept} tone="bg-success/10 text-success" onRemove={(k) => setFix(k, null)} removeTitle="恢复自动判断" testid="recog-kept-tags" />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-24 shrink-0 font-medium">手动添加</span>
        <TextInput value={add} onChange={setAdd} className="min-w-40 flex-1" mono placeholder="Tag（可用逗号分隔多个）" />
        <Select value={addAs} onChange={(v) => setAddAs(v as typeof addAs)} options={[['character', '作为旧角色删除'], ['outfit', '作为旧服装删除'], ['keep', '强制保留']]} className="min-w-32" />
        <Button size="sm" variant="secondary" onClick={addTags} data-testid="recog-add">添加</Button>
      </div>
    </section>
  )
}

function RecogRow({ index, im, r, row, data, setImage, setFix }: { index: number; im: ReplicaImage; r: ImageRecognition; row?: ReplicaRow; data: ReplicaData; setImage: (p: Partial<ReplicaImage>) => void; setFix: (key: string, v: ReplicaData['tag_fix'][string] | null) => void }) {
  const [edit, setEdit] = useState(false)
  const [text, setText] = useState(r.retained)
  const [w, setW] = useState('')
  const [h, setH] = useState('')
  const size = imageSize(im)
  const fixImage = (key: string, v: 'remove' | 'keep' | null) => {
    const next = { ...im.tag_fix }
    if (v === null) delete next[key]
    else next[key] = v
    setImage({ tag_fix: next })
  }
  return (
    <div className={cn('rounded-xl bg-card p-2.5 ring-1', r.needs_fix ? 'ring-warning/50' : 'ring-tint/[0.08]')} data-testid="recog-row" data-name={im.name} data-needs-fix={r.needs_fix || undefined}>
      <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[11.5px]">
        <span className="text-muted-foreground tabular-nums">图 {index + 1}</span>
        <span className="font-medium select-text">{im.name}</span>
        {r.needs_fix ? <span className="text-warning" data-testid="recog-state">需要处理</span> : <span className="text-success" data-testid="recog-state">{r.manual ? '手动片段' : im.accepted !== null && r.issues.length ? '已确认' : '可靠'}</span>}
        <span className="text-muted-foreground" data-testid="recog-cut-reason">{r.cut_reason === 'camera' ? '从镜头 Tag 保留' : r.cut_reason === 'prefix' ? '按共同前缀分割' : r.cut_reason === 'manual' ? '手动保留起点' : '无法判断起点'}</span>
        <div className="flex-1" />
        <span className="text-muted-foreground" data-testid="recog-size">{size.width ? `${size.width}×${size.height}` : '工作流默认尺寸'}{size.state === 'confirm' ? '（需确认）' : size.state === 'manual' ? '（手动）' : ''}</span>
        <span className="text-muted-foreground">× {repeatOf(im, data)} 次</span>
      </div>
      {r.issues.length > 0 && (
        <div className={cn('mb-1.5 space-y-0.5 rounded-lg px-2 py-1 text-[11px]', r.needs_fix ? 'bg-warning/[0.08] text-warning' : 'bg-tint/[0.03] text-muted-foreground')} data-testid="recog-issues">
          {r.issues.map((m, i) => <div key={i}>{m}</div>)}
        </div>
      )}
      <div className="flex gap-2">
        <Thumb path={im.path} width={160} className="size-20 shrink-0" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div>
            <div className="text-[10.5px] text-muted-foreground">原图 Prompt（点击 Tag 修正）</div>
            <div className="font-mono text-[11.5px] leading-relaxed break-words" data-testid="recog-original">
              {r.splittable ? (
                r.segments.map((s, j) => (
                  <span key={j}>
                    {j > 0 && <span className="text-muted-foreground">, </span>}
                    <SegMenu label={s.raw} role={s.role} cls={j === r.cut ? 'ring-1 ring-sky-500/60' : ''} onCut={() => setImage({ cut: j })} isCut={j === r.cut} imageFix={im.tag_fix[s.key] ?? null} setFix={data.tag_fix[s.key] ?? null} onImageFix={(v) => fixImage(s.key, v)} onSetFix={(v) => setFix(s.key, v)} />
                  </span>
                ))
              ) : (
                <span className="text-muted-foreground">{im.positive}</span>
              )}
            </div>
            <div className="mt-0.5 flex flex-wrap gap-x-3 text-[10.5px] text-muted-foreground">
              {(Object.keys(ROLE_LABEL) as SegRole[]).filter((k) => r.segments.some((s) => s.role === k)).map((k) => <span key={k} className={ROLE_STYLE[k]}>{ROLE_LABEL[k]}</span>)}
            </div>
          </div>
          <div className="grid grid-cols-[6.5rem_1fr] gap-x-2 gap-y-0.5 text-[11.5px]">
            <span className="text-muted-foreground">替换的开头</span>
            <span className="font-mono break-words text-muted-foreground" data-testid="recog-prefix-text">{r.prefix || '（没有）'}</span>
            <span className="text-muted-foreground">删除的角色 Tag</span>
            <span className="font-mono break-words text-destructive" data-testid="recog-removed-character">{r.removed_character.join(', ') || '（没有）'}</span>
            <span className="text-muted-foreground">删除的服装 Tag</span>
            <span className="font-mono break-words text-violet-700 dark:text-violet-300" data-testid="recog-removed-outfit">{r.removed_outfit.join(', ') || '（没有）'}</span>
            {r.removed_other.length > 0 && (
              <>
                <span className="text-muted-foreground">其他删除</span>
                <span className="font-mono break-words text-destructive" data-testid="recog-removed-other">{r.removed_other.join(', ')}</span>
              </>
            )}
            <span className="text-muted-foreground">保留片段{r.manual ? '（手动）' : ''}</span>
            <span className="font-mono break-words" data-testid="recog-retained">{r.retained || <span className="text-warning">（空）</span>}</span>
            <span className="text-muted-foreground">最终 Prompt</span>
            <span className="font-mono break-words text-[11px]" data-testid="recog-final">
              {row ? <ModuleParts parts={row.positive_parts} /> : <span className="text-muted-foreground">计算中…</span>}
            </span>
          </div>
          {im.legacy?.manual_positive !== undefined && (
            <div className="rounded-lg bg-tint/[0.03] px-2 py-1 text-[11px]" data-testid="recog-legacy-manual">
              <span className="text-muted-foreground">旧版手动 Prompt：</span>
              <span className="font-mono">{im.legacy.manual_positive}</span>
              <button type="button" className="ml-2 text-primary hover:underline" onClick={() => { setText(im.legacy!.manual_positive!); setEdit(true) }}>填入编辑框</button>
            </div>
          )}
          {edit && (
            <div className="space-y-1.5">
              <textarea value={text} rows={3} onChange={(e) => setText(e.target.value)} className="w-full rounded-lg bg-tint/[0.045] px-2 py-1.5 font-mono text-[11.5px] ring-1 ring-tint/[0.112] outline-none focus:ring-primary/50" data-testid="recog-edit-retained" />
              <div className="flex gap-2">
                <Button size="sm" onClick={() => { setImage({ retained_manual: text }); setEdit(false) }} data-testid="recog-edit-save">保存保留片段</Button>
                <Button size="sm" variant="ghost" onClick={() => setEdit(false)}>取消</Button>
              </div>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            {r.needs_fix && !r.manual && r.retained.trim() && <Button size="sm" variant="secondary" onClick={() => setImage({ accepted: r.retained })} data-testid="recog-accept"><Check /> 确认这个结果</Button>}
            {!edit && <Button size="sm" variant="ghost" onClick={() => { setText(r.retained); setEdit(true) }} data-testid="recog-edit"><Pencil /> 手动编辑保留片段</Button>}
            {r.manual && <Button size="sm" variant="ghost" onClick={() => setImage({ retained_manual: null })} data-testid="recog-edit-reset"><RotateCcw /> 恢复自动识别</Button>}
            {im.cut !== null && <Button size="sm" variant="ghost" onClick={() => setImage({ cut: null })} data-testid="recog-cut-reset"><RotateCcw /> 恢复自动起点</Button>}
            {Object.keys(im.tag_fix).length > 0 && <Button size="sm" variant="ghost" onClick={() => setImage({ tag_fix: {} })} data-testid="recog-fix-reset"><RotateCcw /> 清除这张图的修正（{Object.keys(im.tag_fix).length}）</Button>}
            <div className="flex-1" />
            <span className="text-[11px] text-muted-foreground">尺寸</span>
            <input value={w} placeholder={String(size.width ?? '宽')} onChange={(e) => setW(e.target.value)} className="w-14 rounded bg-tint/[0.05] px-1 py-0.5 text-center text-[11.5px] ring-1 ring-tint/[0.1] outline-none" data-testid="recog-size-w" />
            ×
            <input value={h} placeholder={String(size.height ?? '高')} onChange={(e) => setH(e.target.value)} className="w-14 rounded bg-tint/[0.05] px-1 py-0.5 text-center text-[11.5px] ring-1 ring-tint/[0.1] outline-none" data-testid="recog-size-h" />
            <Button size="sm" variant="ghost" onClick={() => { const a = Number(w || size.width); const b = Number(h || size.height); if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < 1) return void toast.error('请输入正整数尺寸'); setImage({ size: { width: a, height: b } }); setW(''); setH('') }} data-testid="recog-size-save">设置</Button>
            {im.size && <Button size="sm" variant="ghost" onClick={() => setImage({ size: null })} data-testid="recog-size-reset">原图尺寸</Button>}
            <span className="text-[11px] text-muted-foreground">次数</span>
            <input type="number" min={1} max={MAX_REPEAT} value={im.repeat ?? ''} placeholder={String(data.repeat)} onChange={(e) => { const n = Number(e.target.value); setImage({ repeat: e.target.value && Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_REPEAT) : null }) }} className="w-14 rounded bg-tint/[0.05] px-1 py-0.5 text-center text-[11.5px] ring-1 ring-tint/[0.1] outline-none" data-testid="recog-repeat" />
          </div>
        </div>
      </div>
    </div>
  )
}

function SegMenu({ label, role, cls, onCut, isCut, imageFix, setFix, onImageFix, onSetFix }: { label: string; role: SegRole; cls: string; onCut: () => void; isCut: boolean; imageFix: 'remove' | 'keep' | null; setFix: 'character' | 'outfit' | 'keep' | null; onImageFix: (v: 'remove' | 'keep' | null) => void; onSetFix: (v: 'character' | 'outfit' | 'keep' | null) => void }) {
  const [open, setOpen] = useState(false)
  const item = (text: string, on: boolean, fn: () => void, testid: string) => (
    <button type="button" onClick={() => { fn(); setOpen(false) }} data-testid={testid} className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[11.5px] hover:bg-tint/[0.05]', on && 'text-primary')}>
      <span className="w-3">{on ? '✓' : ''}</span>
      {text}
    </button>
  )
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={cn('cursor-pointer hover:underline', ROLE_STYLE[role], cls)} title={ROLE_LABEL[role]} data-testid="recog-seg" data-role={role}>
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-1.5">
        <div className="truncate px-2 pb-1 font-mono text-[11px] text-muted-foreground">{label} · {ROLE_LABEL[role]}</div>
        {item('从这里开始保留（这张图）', isCut, onCut, 'seg-cut')}
        <div className="my-1 border-t border-tint/[0.08]" />
        {item('这张图：删除', imageFix === 'remove', () => onImageFix(imageFix === 'remove' ? null : 'remove'), 'seg-image-remove')}
        {item('这张图：保留', imageFix === 'keep', () => onImageFix(imageFix === 'keep' ? null : 'keep'), 'seg-image-keep')}
        <div className="my-1 border-t border-tint/[0.08]" />
        {item('整套：作为旧角色删除', setFix === 'character', () => onSetFix(setFix === 'character' ? null : 'character'), 'seg-set-character')}
        {item('整套：作为旧服装删除', setFix === 'outfit', () => onSetFix(setFix === 'outfit' ? null : 'outfit'), 'seg-set-outfit')}
        {item('整套：强制保留', setFix === 'keep', () => onSetFix(setFix === 'keep' ? null : 'keep'), 'seg-set-keep')}
        {setFix !== null && item('整套：恢复自动判断', false, () => onSetFix(null), 'seg-set-reset')}
      </PopoverContent>
    </Popover>
  )
}

const MODULE_STYLE: Record<string, [string, string]> = {
  global: ['全局 / 画风', 'text-sky-700 dark:text-sky-300'],
  scene: ['场景', 'text-emerald-700 dark:text-emerald-300'],
  camera: ['保留片段', ''],
  character: ['角色', 'text-primary'],
  outfit: ['服装', 'text-violet-700 dark:text-violet-300'],
}

/** 最终 Prompt 按来源着色显示（文字与写入工作流的 Prompt 相同，模块之间的连接符按设置） */
function ModuleParts({ parts }: { parts: { module: string; text: string }[] }) {
  return (
    <span className="whitespace-pre-wrap select-text">
      {parts.map((p, i) => (
        <span key={i} className={MODULE_STYLE[p.module]?.[1]} title={MODULE_STYLE[p.module]?.[0] ?? p.module} data-module={p.module}>
          {i > 0 && <span className="text-muted-foreground"> │ </span>}
          {p.text}
        </span>
      ))}
    </span>
  )
}

// ---------------- 第 3 步：配置

function ConfigureStep({ data, plan, update }: { data: ReplicaData; plan: ReplicaPlanView | null; update: Update }) {
  const lib = useLib((s) => s.lib)!
  const [pickChar, setPickChar] = useState(false)
  const [pickGlobal, setPickGlobal] = useState(false)
  const character = lib.characters.find((c) => c.id === data.character_id)
  const outfits = lib.outfits.filter((o) => o.character_id === data.character_id)
  const defaultOutfit = outfits.find((o) => o.id === data.outfit_id)
  const global = lib.templates.find((t) => t.id === data.global_id)
  const scenes = templatesOf(lib, 'scene')
  const scene = scenes.find((t) => t.id === data.scene_id)
  const assigned = data.images.filter((im) => im.outfit_id !== undefined).length
  const sourceLoras = useMemo(() => {
    const m = new Map<string, number>()
    for (const im of data.images) for (const l of im.loras) m.set(loraStem(l.name), (m.get(loraStem(l.name)) ?? 0) + 1)
    return [...m].sort((a, b) => b[1] - a[1])
  }, [data.images])
  const chooseCharacter = (cid: number) => {
    if (cid === data.character_id) return
    const hadOv = Object.keys(data.lora_overrides).length > 0
    // 服装与角色 LoRA 的调整属于之前的角色：换角色时清除
    if (assigned || hadOv) toast.info('已清除之前角色的设置', { description: [assigned ? `${assigned} 张图片单独指定的服装` : '', hadOv ? '角色 LoRA 的调整' : ''].filter(Boolean).join('、') })
    update((d) => ({ character_id: cid, outfit_id: null, lora_overrides: {}, images: d.images.map(withoutOutfit) }))
  }
  const loraData: LoraPanelData = { character_id: data.character_id, workflow_id: data.workflow_id, lora_overrides: data.lora_overrides, lora_configs: data.lora_configs }
  const loraUpdate = (fn: (x: LoraPanelData) => void) =>
    update((d) => {
      const x: LoraPanelData = structuredClone({ character_id: d.character_id, workflow_id: d.workflow_id, lora_overrides: d.lora_overrides, lora_configs: d.lora_configs })
      fn(x)
      return { lora_overrides: x.lora_overrides ?? {}, lora_configs: x.lora_configs ?? {} }
    })
  const valid = plan?.summary.valid ?? 0
  const field = 'w-full rounded-lg bg-tint/[0.045] px-2 py-1.5 font-mono text-[11.5px] ring-1 ring-tint/[0.112] outline-none focus:ring-primary/50'
  return (
    <div className="h-full min-h-0 space-y-3 overflow-y-auto pr-1" data-testid="replica-configure">
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <section className="space-y-2 rounded-xl bg-card p-3 ring-1 ring-tint/[0.08]" data-testid="replica-workflow">
          <div className="flex items-center gap-2 text-[12.5px] font-medium">
            新工作流
            <div className="flex-1" />
            <WorkflowMenu value={data.workflow_id} onPick={(wid) => update({ workflow_id: wid })} />
          </div>
          <div className="text-[11px] text-muted-foreground">Seed、Steps、CFG、Sampler、Scheduler、Denoise 全部使用这个工作流的设置（Seed 按映射写入新的值），不继承原图。LoRA 配置按工作流分别保存。</div>
          {plan?.workflow && !plan.summary.size_mapped && <div className="text-[11px] text-warning">工作流没有映射生成宽度 / 高度：每张图的原图尺寸不会生效。</div>}
          {data.disable_triggers !== undefined && (
            <label className="flex items-center justify-between gap-3 text-[12px]" data-testid="replica-trigger">
              关闭 LoRA 自动触发词注入（触发词由角色 Prompt 负责）
              <Switch checked={data.disable_triggers} onCheckedChange={(v) => update({ disable_triggers: !!v })} data-testid="replica-trigger-switch" />
            </label>
          )}
        </section>
        <section className="space-y-2 rounded-xl bg-card p-3 ring-1 ring-tint/[0.08]" data-testid="replica-character">
          <div className="flex items-center gap-2 text-[12.5px] font-medium">
            新角色
            <span className={cn('text-[12px] font-normal', !character && 'text-warning')} data-testid="replica-character-name">{character?.name ?? '未选择'}</span>
            <div className="flex-1" />
            <Button size="sm" variant="secondary" onClick={() => setPickChar(true)} data-testid="replica-pick-character">{character ? '更换' : '选择角色'}</Button>
          </div>
          {character ? (
            <div className="space-y-1 text-[11.5px]">
              <div className="text-muted-foreground">角色 Prompt（加在保留片段之后）</div>
              <div className="rounded-lg bg-primary/[0.06] px-2 py-1.5 font-mono break-words select-text" data-testid="replica-character-prompt">{character.positive || '（基础 Prompt 为空）'}</div>
              {character.negative && <div className="font-mono text-[11px] text-muted-foreground">负面：{character.negative}</div>}
              <div className="text-[11px] text-muted-foreground">角色 LoRA：{(character.loras ?? []).filter((l) => l.name).map((l) => loraStem(l.name)).join('、') || '没有'}（在下方 LoRA 中调整）</div>
            </div>
          ) : (
            <div className="rounded-lg bg-warning/[0.08] px-2 py-1.5 text-[11.5px] text-warning" data-testid="replica-character-missing">还没有选择角色。角色库中的角色提供角色 Prompt、角色 LoRA 和服装；在 LoRA 中添加的 LoRA 不会自动选择角色。</div>
          )}
          <CharacterPicker open={pickChar} onOpenChange={setPickChar} value={data.character_id} onPick={chooseCharacter} title="选择新角色" description="角色的基础 Prompt、LoRA 和服装用于整套重新生成。" />
        </section>
        {character && (
          <section className="space-y-2 rounded-xl bg-card p-3 ring-1 ring-tint/[0.08]">
            <OutfitSection data={data} outfits={outfits} update={update} plan={plan} />
            <div className="text-[11.5px]">
              <div className="text-muted-foreground">默认服装 Prompt（加在角色 Prompt 之后）</div>
              <div className="rounded-lg bg-violet-500/[0.06] px-2 py-1.5 font-mono break-words select-text" data-testid="replica-outfit-prompt">{defaultOutfit ? defaultOutfit.positive || '（服装 Prompt 为空）' : '不使用服装'}</div>
            </div>
          </section>
        )}
        <section className="space-y-2 rounded-xl bg-card p-3 ring-1 ring-tint/[0.08]" data-testid="replica-global">
          <div className="flex items-center gap-2 text-[12.5px] font-medium">
            新的全局 / 画风 Prompt
            <span className="text-[12px] font-normal text-muted-foreground">{global?.name ?? '不使用模板'}</span>
            <div className="flex-1" />
            <Button size="sm" variant="secondary" onClick={() => setPickGlobal(true)} data-testid="replica-pick-global">选择模板</Button>
          </div>
          {global?.positive && <div className="font-mono text-[11px] break-words text-muted-foreground">{global.positive}</div>}
          <textarea value={data.global_text} rows={2} placeholder="附加的画质 / 画风 Tag（放在模板之后）" onChange={(e) => update({ global_text: e.target.value })} className={field} data-testid="replica-global-text" />
          <GlobalPicker open={pickGlobal} onOpenChange={setPickGlobal} value={data.global_id} onPick={(gid) => update({ global_id: gid })} />
          <div className="mt-1 flex items-center gap-2 text-[12.5px] font-medium">
            新的场景 Prompt
            <div className="flex-1" />
            <Select value={String(data.scene_id ?? '')} onChange={(v) => update({ scene_id: v ? Number(v) : null })} options={[['', '不使用场景模板'], ...scenes.map((t) => [String(t.id), t.name || '（未命名）'] as [string, string])]} className="min-w-40" />
          </div>
          {scene?.positive && <div className="font-mono text-[11px] break-words text-muted-foreground">{scene.positive}</div>}
          <textarea value={data.scene_text} rows={2} placeholder="附加的场景 Tag（放在场景模板之后）" onChange={(e) => update({ scene_text: e.target.value })} className={field} data-testid="replica-scene-text" />
          <label className="flex items-center justify-between gap-3 text-[12px]">
            负面 Prompt 同时保留原图的负面
            <Switch checked={data.keep_source_negative} onCheckedChange={(v) => update({ keep_source_negative: !!v })} data-testid="replica-keep-negative" />
          </label>
        </section>
        <section className="space-y-2 rounded-xl bg-card p-3 ring-1 ring-tint/[0.08]" data-testid="replica-repeat">
          <div className="text-[12.5px] font-medium">生成次数</div>
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            每张图
            <input type="number" min={1} max={MAX_REPEAT} value={data.repeat} onChange={(e) => { const n = Number(e.target.value); if (Number.isInteger(n) && n >= 1) update({ repeat: Math.min(n, MAX_REPEAT) }) }} className="w-16 rounded bg-tint/[0.05] px-1 py-0.5 text-center ring-1 ring-tint/[0.1] outline-none" data-testid="replica-repeat-input" />
            次
            <Select value={data.repeat_order} onChange={(v) => update({ repeat_order: v as ReplicaData['repeat_order'] })} options={[['set', '按套：先完整生成第 1 套'], ['image', '按图：每张图连续生成']]} className="min-w-44" />
          </div>
          <div className="text-[11.5px]" data-testid="replica-repeat-summary">
            {valid} 张可生成 → <b>{plan?.units ?? 0}</b> 个生成单元
            {data.images.some((im) => im.repeat !== null) && <span className="text-muted-foreground">（{data.images.filter((im) => im.repeat !== null).length} 张单独设置了次数）</span>}
          </div>
          <div className="text-[11px] text-muted-foreground">多次生成时文件名加 _v01、_v02……，Seed 按顺序递增（不使用原图 Seed）。每张图的次数可以在第 2 步单独设置。</div>
        </section>
      </div>
      <section className="rounded-xl bg-card py-3 ring-1 ring-tint/[0.08]" data-testid="replica-lora">
        <LoraPanelView data={loraData} update={loraUpdate} separateClip note="只作用于本草稿；基于所选工作流中的 LoRA 与角色 LoRA，不使用原图的 LoRA" />
        <div className="px-6 text-[11px] text-muted-foreground" data-testid="replica-image-loras">
          原图使用过（仅供参考，不会加载）：{sourceLoras.length ? sourceLoras.slice(0, 12).map(([n, c]) => `${n} ×${c}`).join('、') : '没有读取到'}
        </div>
      </section>
      {plan && plan.errors.length > 0 && <Problems list={plan.errors} />}
    </div>
  )
}

/** 默认服装 + 按图片编号范围分配。分配结果保存在每张图上，删除或重新排序图片时不会错位 */
function OutfitSection({ data, outfits, update, plan }: { data: ReplicaData; outfits: Outfit[]; update: Update; plan: ReplicaPlanView | null }) {
  const n = data.images.length
  const [from, setFrom] = useState('1')
  const [to, setTo] = useState(String(n || 1))
  const [pick, setPick] = useState('default')
  const label = (v: number | null | undefined) => (v === undefined ? `默认（${data.outfit_id === null ? '不使用' : (outfits.find((o) => o.id === data.outfit_id)?.name ?? '无效')}）` : v === null ? '不使用服装' : (outfits.find((o) => o.id === v)?.name ?? '已不属于当前角色'))
  const apply = () => {
    const a = Number(from)
    const b = Number(to)
    const value = pick === 'default' ? undefined : pick === 'none' ? null : Number(pick)
    const { error } = assignOutfit(data.images, a, b, value)
    if (error) return void toast.error(error)
    update((d) => ({ images: assignOutfit(d.images, a, b, value).images }))
  }
  const runs = outfitRuns(data.images)
  const bad = plan?.errors.filter((m) => m.includes('服装')) ?? []
  return (
    <div className="text-[12px]" data-testid="replica-outfits">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[12.5px] font-medium">新服装</span>
        <span className="text-muted-foreground">默认</span>
        <Select value={String(data.outfit_id ?? '')} onChange={(v) => update({ outfit_id: v ? Number(v) : null })} options={[['', '不使用'], ...outfits.map((o) => [String(o.id), o.name] as [string, string])]} className="min-w-40" />
      </div>
      {n > 1 && (
        <>
          <div className="flex flex-wrap items-center gap-1.5 text-[11.5px]">
            <span className="text-muted-foreground">图</span>
            <input type="number" min={1} max={n} value={from} onChange={(e) => setFrom(e.target.value)} className="w-14 rounded bg-tint/[0.05] px-1 py-0.5 text-center ring-1 ring-tint/[0.1] outline-none" data-testid="outfit-from" />
            <span className="text-muted-foreground">到</span>
            <input type="number" min={1} max={n} value={to} onChange={(e) => setTo(e.target.value)} className="w-14 rounded bg-tint/[0.05] px-1 py-0.5 text-center ring-1 ring-tint/[0.1] outline-none" data-testid="outfit-to" />
            <Select value={pick} onChange={setPick} options={[['default', '使用默认服装'], ['none', '不使用服装'], ...outfits.map((o) => [String(o.id), o.name] as [string, string])]} className="min-w-32" />
            <Button size="sm" variant="secondary" onClick={apply} data-testid="outfit-apply">应用</Button>
          </div>
          {runs.length > 1 && (
            <div className="mt-2 space-y-0.5" data-testid="outfit-runs">
              {runs.map((r) => (
                <div key={r.a} className="flex items-center gap-2 text-[11.5px]" data-testid="outfit-run" data-from={r.a + 1} data-to={r.b + 1}>
                  <span className="w-20 shrink-0 tabular-nums text-muted-foreground">图 {r.a + 1}{r.b > r.a ? `–${r.b + 1}` : ''}</span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground" title={data.images.slice(r.a, r.b + 1).map((im) => im.name).join('\n')}>{data.images[r.a].name}{r.b > r.a ? ` … ${data.images[r.b].name}` : ''}</span>
                  <span className={cn('shrink-0', r.value !== undefined && 'font-medium')}>{label(r.value)}</span>
                  {r.value !== undefined && <button type="button" className="shrink-0 text-muted-foreground hover:text-foreground" title="恢复为默认服装" onClick={() => { const paths = new Set(data.images.slice(r.a, r.b + 1).map((im) => im.path)); update((d) => ({ images: d.images.map((im) => (paths.has(im.path) ? withoutOutfit(im) : im)) })) }} data-testid="outfit-run-clear"><X className="size-3.5" /></button>}
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {bad.length > 0 && <div className="mt-1.5 text-[11px] text-destructive">{bad[0]}</div>}
    </div>
  )
}

// ---------------- 第 4 步：预览

function PreviewStep({ id, data, plan, goRecognize }: { id: number; data: ReplicaData; plan: ReplicaPlanView | null; goRecognize: () => void }) {
  const [page, setPage] = useState(0)
  const [json, setJson] = useState<number | null>(null)
  if (!plan) return <div className="text-xs text-muted-foreground">计算中…</div>
  const rows = plan.rows
  const n = (s: ReplicaRow['state']) => rows.filter((r) => r.state === s).length
  const s = plan.summary
  const size = 30
  return (
    <div className="flex h-full min-h-0 flex-col gap-3" data-testid="replica-preview">
      <div className="grid grid-cols-5 gap-2">
        <Tile label="原图" value={rows.length} testid="sum-total" />
        <Tile label="可生成" value={n('valid')} testid="sum-valid" />
        <Tile label="需要处理" value={n('confirm')} tone="warn" testid="sum-confirm" />
        <Tile label="不能生成" value={n('invalid') + n('missing')} tone="error" testid="sum-invalid" />
        <Tile label="生成单元" value={plan.units} testid="sum-units" />
      </div>
      <div className="grid grid-cols-[6rem_1fr] gap-x-2 gap-y-0.5 rounded-xl bg-card p-3 text-[11.5px] ring-1 ring-tint/[0.08]" data-testid="replica-summary">
        <span className="text-muted-foreground">工作流</span>
        <span>{plan.workflow?.name ?? '未选择'}</span>
        <span className="text-muted-foreground">角色</span>
        <span className={cn(!s.character && 'text-warning')}>{s.character ? <>{s.character.name}<span className="ml-2 font-mono text-muted-foreground">{s.character.positive}</span></> : '未选择'}</span>
        <span className="text-muted-foreground">默认服装</span>
        <span>{s.outfit ? <>{s.outfit.name}<span className="ml-2 font-mono text-muted-foreground">{s.outfit.positive}</span></> : '不使用'}{data.images.some((im) => im.outfit_id !== undefined) ? '（部分图片单独指定）' : ''}</span>
        <span className="text-muted-foreground">全局 / 画风</span>
        <span className="font-mono">{s.global?.positive || '不使用'}</span>
        <span className="text-muted-foreground">场景</span>
        <span className="font-mono">{s.scene?.positive || '不使用'}</span>
        <span className="text-muted-foreground">角色 LoRA</span>
        <span data-testid="replica-loras">{s.loras.map((l) => `${loraStem(l.name)} ${l.strength}${l.clip !== l.strength ? ` / Clip ${l.clip}` : ''}${l.enabled ? '' : '（停用）'}`).join('、') || '没有'}（工作流 LoRA 见第 3 步，最终写入见「最终工作流」）</span>
        <span className="text-muted-foreground">次数</span>
        <span data-testid="replica-units-summary">{n('valid')} 张 → {plan.units} 个单元{s.seed_mapped ? '' : '（工作流没有映射 Seed）'}</span>
      </div>
      {plan.errors.length > 0 && <Problems list={plan.errors} />}
      {plan.warnings.length > 0 && <Problems list={plan.warnings} tone="warn" />}
      <div className="flex items-center gap-2">
        {n('confirm') > 0 && <Button size="sm" variant="secondary" onClick={goRecognize} data-testid="replica-go-fix">处理 {n('confirm')} 张需要处理的图片</Button>}
        <span className="text-[11px] text-muted-foreground">下面的 Prompt 就是写入工作流的内容（颜色表示来源：全局 / 场景 / 保留片段 / 角色 / 服装）。</span>
        <div className="flex-1" />
        <Pager page={page} total={plan.unit_list.length} size={size} onPage={setPage} />
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
        {plan.unit_list.slice(page * size, (page + 1) * size).map((u) => {
          const r = rows[u.image]
          return (
            <div key={u.index} className="flex gap-2 rounded-xl bg-card p-2.5 ring-1 ring-tint/[0.08]" data-testid="replica-unit" data-index={u.index} data-output={u.output_name}>
              <Thumb path={r.path} width={160} className="size-16 shrink-0" />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
                  <span className="text-muted-foreground tabular-nums">#{u.index + 1}</span>
                  <span className="font-medium">图 {u.image + 1} · {r.name}</span>
                  {u.of > 1 && <span className="rounded bg-primary/10 px-1 text-[10.5px] text-primary" data-testid="replica-unit-variant">第 {u.variant + 1}/{u.of} 次</span>}
                  <span className="text-muted-foreground" data-testid="replica-output-name">→ {u.output_name}</span>
                  <span className="text-muted-foreground">服装：{r.outfit || '不使用'}</span>
                  <div className="flex-1" />
                  <span className="text-muted-foreground">Seed {u.seed} · {r.size.width ? `${r.size.width}×${r.size.height}` : '默认尺寸'}</span>
                  <Button size="sm" variant="ghost" onClick={() => setJson(u.index)} data-testid="replica-unit-json">最终工作流</Button>
                </div>
                <div className="font-mono text-[11.5px] leading-relaxed break-words" data-testid="replica-unit-positive" title={r.positive}>
                  <ModuleParts parts={r.positive_parts} />
                </div>
                {r.negative && <div className="font-mono text-[11px] break-words text-muted-foreground" data-testid="replica-unit-negative">负面：{r.negative}</div>}
              </div>
            </div>
          )
        })}
        {!plan.unit_list.length && <EmptyState icon={<ImagePlus />} title="还没有可以生成的内容" description={rows.length ? '处理第 2 步中需要处理的图片，并在第 3 步完成配置。' : '在第 1 步导入图片。'} />}
      </div>
      {json !== null && <FinalWorkflowDialog index={json} count={plan.units} load={(i) => api['replicas.finalWorkflow'](id, i)} exportJson={(i) => api['replicas.exportWorkflow'](id, i)} onIndex={setJson} onClose={() => setJson(null)} />}
    </div>
  )
}

// ---------------- 第 5 步：入队

function GenerateStep({ id, data, plan, update, flush, refresh }: { id: number; data: ReplicaData; plan: ReplicaPlanView | null; update: Update; flush: () => Promise<boolean>; refresh: () => Promise<ReplicaPlanView | undefined> }) {
  const go = useNav((s) => s.go)
  const [done, setDone] = useState<{ n: number; dir: string } | null>(null)
  const enqueue = async (start: boolean) => {
    // 入队使用已保存的草稿：保存失败时不入队，避免队列内容与界面不一致
    if (!(await flush())) return
    const fresh = await refresh()
    if (!fresh) return
    const bad = fresh.rows.filter((r) => r.state !== 'valid' && r.state !== 'excluded')
    if (bad.length && !(await confirm({ title: `有 ${bad.length} 张图片不会生成`, description: `${bad.slice(0, 8).map((r) => `${r.name}：${r.reason}`).join('\n')}\n\n只生成其余图片（${fresh.units} 个单元）？`, confirmText: '继续' }))) return
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
    toast.success(`已加入队列（${r.units} 个单元）`, { description: '之后修改草稿不影响这次入队的内容。', action: { label: '查看队列', onClick: () => go('queue') } })
  }
  const ok = !!plan && !plan.errors.length && plan.units > 0
  const valid = plan?.summary.valid ?? 0
  return (
    <div className="max-w-2xl space-y-3" data-testid="replica-generate">
      <section className="rounded-xl bg-card p-3 ring-1 ring-tint/[0.08]">
        <div className="mb-1.5 text-[12.5px] font-medium">输出目录</div>
        <TextInput value={data.output.dir} onChange={(v) => update({ output: { dir: v } })} placeholder={plan?.output_dir || '默认：工作区 output 下的新目录'} className="w-full" mono />
        <div className="mt-1.5 text-[11px] text-muted-foreground" data-testid="replica-output-dir">保存到 {plan?.output_dir || '—'}，文件名与原图对应（多次生成时加 _v01、_v02……），不覆盖已有文件。</div>
      </section>
      <div className="rounded-xl bg-card p-3 text-[12px] ring-1 ring-tint/[0.08]" data-testid="replica-enqueue-summary">
        {valid} 张图{data.repeat > 1 || data.images.some((im) => im.repeat !== null) ? `（每张 ${data.repeat} 次${data.images.some((im) => im.repeat !== null) ? '，部分单独设置' : ''}）` : ''} → <b>{plan?.units ?? 0}</b> 个生成单元
      </div>
      {plan && plan.errors.length > 0 && <Problems list={plan.errors} />}
      {plan && plan.warnings.length > 0 && <Problems list={plan.warnings} tone="warn" />}
      <div className="flex items-center gap-2">
        <Button disabled={!ok} onClick={() => enqueue(true)} data-testid="replica-start"><Play /> 生成 {plan?.units ?? 0} 个</Button>
        <Button disabled={!ok} variant="secondary" onClick={() => enqueue(false)} data-testid="replica-enqueue"><ListPlus /> 只加入队列</Button>
      </div>
      {done && (
        <div className="flex items-center gap-2 rounded-lg bg-success/[0.08] px-3 py-2 text-[12px] text-success" data-testid="replica-done">
          <Check className="size-3.5" /> 已加入队列 {done.n} 个单元，保存到 {done.dir}
          <button type="button" className="ml-auto underline" onClick={() => go('queue')}>查看队列</button>
        </div>
      )}
    </div>
  )
}
