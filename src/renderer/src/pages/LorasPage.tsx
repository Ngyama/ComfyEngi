// LoRA 管理：左侧真实文件夹树，右侧以封面为核心的卡片网格，点击卡片打开详情面板。
// 封面与 ComfyUI-Lora-Manager 的 metadata.json 由主进程只读扫描；ComfyEngi 自己的标签 / 备注 / 角色关联单独保存在 Vault。

import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { create } from 'zustand'
import {
  ChevronDown,
  ChevronRight,
  Copy,
  FolderOpen,
  FolderPlus,
  Folder,
  ImageIcon,
  ImageOff,
  Layers,
  Play,
  RefreshCw,
  RotateCcw,
  Star,
  Unlink,
  User,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Chip, CopyButton, Disclosure, EmptyState, FieldLabel, IconButton, SearchBox, TextInput } from '@/components/common'
import { api, call } from '@/lib/api'
import { useDraft } from '@/lib/hooks'
import { confirm, reloadLib, useLib } from '@/lib/stores'
import { cn } from '@/lib/utils'
import type { LoraResource } from '@shared/types'

// ---------------------------------------------------------------- 工具

export type NameMode = 'model' | 'file'
const fileStem = (r: LoraResource) => r.name.replace(/\.safetensors$/i, '')
/** 显示名称：model = metadata 中的模型名称（没有时退回文件名），file = 本地文件名（不含扩展名） */
export const loraTitle = (r: LoraResource, mode: NameMode = 'model') => (mode === 'file' ? fileStem(r) : r.sidecar?.modelName || fileStem(r))
const useNameMode = (): NameMode => (useLib((s) => s.lib?.settings.lora_display_name) === 'file' ? 'file' : 'model')
/** 自动识别的视频封面（手动封面始终是图片） */
const hasVideo = (r: LoraResource) => !r.preview && /\.mp4$/i.test(r.cover)
const mediaUrl = (r: LoraResource) => `comfyengi-media://lora/${r.id}?v=${encodeURIComponent(r.cover)}`
const baseName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p
const sameRoot = (a: string, b: string) => a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()
const fmtSize = (n: number) => (n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(2)} GB` : `${(n / (1 << 20)).toFixed(1)} MB`)
const words = (s: string) => s.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean)

/** 缩略图缓存（主进程另有磁盘缓存） */
const imageCache = new Map<string, string | null>()
const imageKey = (r: LoraResource, w: number) => `${r.id}|${w}|${r.preview}|${r.cover}`

// 视频抽帧：最多同时处理 2 个，只针对进入可视区域的卡片；结果写入主进程缓存，下次直接读取
let grabbing = 0
const grabQueue: (() => void)[] = []
async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (grabbing >= 2) await new Promise<void>((r) => grabQueue.push(r))
  grabbing++
  try {
    return await fn()
  } finally {
    grabbing--
    grabQueue.shift()?.()
  }
}

function grabFrame(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const v = document.createElement('video')
    let done = false
    const finish = (x: string | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      v.removeAttribute('src')
      v.load()
      resolve(x)
    }
    const timer = setTimeout(() => finish(null), 15000)
    v.muted = true
    v.preload = 'auto'
    v.crossOrigin = 'anonymous'
    v.playsInline = true
    v.onloadedmetadata = () => {
      v.currentTime = Math.min(0.5, (Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 1) * 0.1)
    }
    v.onseeked = () => {
      try {
        const w = Math.min(480, v.videoWidth || 480)
        const h = Math.round((w / (v.videoWidth || 1)) * (v.videoHeight || 1)) || Math.round((w * 4) / 3)
        const c = document.createElement('canvas')
        c.width = w
        c.height = h
        c.getContext('2d')!.drawImage(v, 0, 0, w, h)
        finish(c.toDataURL('image/jpeg', 0.85))
      } catch {
        finish(null)
      }
    }
    v.onerror = () => finish(null)
    v.src = url
  })
}

function useLoraImage(r: LoraResource | null, width: number, enabled = true) {
  const key = r ? imageKey(r, width) : ''
  const [src, setSrc] = useState<string | null | undefined>(() => (key ? imageCache.get(key) : undefined))
  useEffect(() => {
    if (!r || !enabled) return
    if (imageCache.has(key)) {
      setSrc(imageCache.get(key))
      return
    }
    if (!r.preview && !r.cover) {
      imageCache.set(key, null)
      setSrc(null)
      return
    }
    let alive = true
    setSrc(undefined)
    void api['loras.image'](r.id, width)
      .catch(() => null)
      .then(async (v) => {
        if (!v && hasVideo(r)) {
          v = await limited(() => grabFrame(mediaUrl(r)))
          if (v) void api['loras.saveFrame'](r.id, v).catch(() => {})
        }
        return v
      })
      .then((v) => {
        imageCache.set(key, v)
        if (alive) setSrc(v)
      })
    return () => {
      alive = false
    }
  }, [key, enabled]) // eslint-disable-line react-hooks/exhaustive-deps
  return src
}

/** 小型 LoRA 封面（供角色库等页面复用，支持图片封面与 MP4 静态帧） */
export function LoraThumb({ r, width = 160, className }: { r: LoraResource; width?: number; className?: string }) {
  const src = useLoraImage(r, width)
  return (
    <div className={cn('relative shrink-0 overflow-hidden bg-inset', className)}>
      {src ? (
        <img src={src} alt="" draggable={false} className="absolute inset-0 size-full object-cover" />
      ) : src === null || (!r.preview && !r.cover) ? (
        <div className="absolute inset-0 grid place-items-center text-muted-foreground/60">
          <Layers className="size-4" />
        </div>
      ) : (
        <div className="absolute inset-0 animate-pulse bg-tint/[0.04]" />
      )}
    </div>
  )
}

function Placeholder({ r, large }: { r: LoraResource; large?: boolean }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[radial-gradient(circle_at_30%_20%,oklch(0.95_0.03_8/.9),transparent_60%),linear-gradient(160deg,oklch(0.975_0.01_8),oklch(0.95_0.014_8))] text-muted-foreground/60">
      <Layers className={large ? 'size-10' : 'size-7'} />
      {large && <span className="text-xs">没有封面</span>}
      {!large && r.sidecar?.baseModel && <span className="text-[10px] tracking-wide">{r.sidecar.baseModel}</span>}
    </div>
  )
}

// ---------------------------------------------------------------- 页面状态（切换页面后保留）

type Place = { root: string; folder: string } | null
type SortKey = 'name' | 'mtime' | 'size'
interface View {
  place: Place
  q: string
  base: string | null
  link: 'all' | 'linked' | 'unlinked'
  /** 显示已缺失或暂时无法访问的旧记录（默认隐藏） */
  showMissing: boolean
  sort: SortKey
  sel: string | null
  open: Set<string>
  /** 已经出现过的根目录：新出现的根目录默认展开，之后尊重用户的折叠状态 */
  seenRoots: Set<string>
  set(p: Partial<View>): void
}
const useView = create<View>((set) => ({
  place: null,
  q: '',
  base: null,
  link: 'all',
  showMissing: false,
  sort: 'name',
  sel: null,
  open: new Set(),
  seenRoots: new Set(),
  set: (p) => set(p),
}))

// ---------------------------------------------------------------- 文件夹树

interface Node {
  key: string
  root: string
  folder: string
  name: string
  count: number
  children: Node[]
}

function buildTree(roots: string[], rows: LoraResource[]): Node[] {
  const allRoots = [...roots]
  for (const r of rows) if (r.root && !allRoots.some((x) => sameRoot(x, r.root))) allRoots.push(r.root)
  return allRoots.map((root) => {
    const top: Node = { key: root, root, folder: '', name: baseName(root), count: 0, children: [] }
    for (const r of rows) {
      if (!sameRoot(r.root, root)) continue
      top.count++
      let node = top
      let path = ''
      for (const part of r.folder ? r.folder.split('/') : []) {
        path = path ? `${path}/${part}` : part
        let child = node.children.find((c) => c.name === part)
        if (!child) {
          child = { key: `${root}|${path}`, root, folder: path, name: part, count: 0, children: [] }
          node.children.push(child)
        }
        child.count++
        node = child
      }
    }
    const sort = (n: Node) => {
      n.children.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
      n.children.forEach(sort)
    }
    sort(top)
    return top
  })
}

function TreeRow({ node, depth, roots, onRemoveRoot }: { node: Node; depth: number; roots: string[]; onRemoveRoot: (r: string) => void }) {
  const { place, open, set } = useView()
  const isOpen = open.has(node.key)
  const active = !!place && sameRoot(place.root, node.root) && place.folder === node.folder
  const isRoot = depth === 0
  const configured = roots.some((r) => sameRoot(r, node.root))
  const toggle = () => {
    const next = new Set(open)
    if (isOpen) next.delete(node.key)
    else next.add(node.key)
    set({ open: next })
  }
  return (
    <>
      <div
        data-active={active || undefined}
        className="group flex h-8 items-center gap-1 rounded-lg pr-1.5 text-[13px] text-muted-foreground hover:bg-tint/[0.04] hover:text-foreground data-[active]:bg-tint/[0.08] data-[active]:text-foreground"
        style={{ paddingLeft: 6 + depth * 14 }}
        title={isRoot ? node.root : node.folder}
      >
        <button type="button" onClick={toggle} className={cn('grid size-5 shrink-0 place-items-center rounded hover:bg-tint/[0.06]', !node.children.length && 'invisible')} aria-label="展开">
          {isOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => {
            set({ place: { root: node.root, folder: node.folder }, sel: null })
            if (!isOpen && node.children.length) toggle()
          }}
        >
          {isRoot ? <FolderOpen className="size-4 shrink-0 text-primary/80" /> : <Folder className="size-4 shrink-0" />}
          <span className={cn('truncate', isRoot && 'font-medium text-foreground/90')}>{node.name}</span>
          {isRoot && !configured && <span className="shrink-0 text-[10px] text-warning">已移除</span>}
        </button>
        <span className="shrink-0 text-[11px] tabular-nums opacity-60 group-hover:hidden">{node.count}</span>
        {isRoot && configured && (
          <button type="button" onClick={() => onRemoveRoot(node.root)} className="hidden size-5 shrink-0 place-items-center rounded text-muted-foreground hover:text-destructive group-hover:grid" title="从扫描目录中移除（不删除任何文件）">
            <X className="size-3.5" />
          </button>
        )}
      </div>
      {isOpen && node.children.map((c) => <TreeRow key={c.key} node={c} depth={depth + 1} roots={roots} onRemoveRoot={onRemoveRoot} />)}
    </>
  )
}

// ---------------------------------------------------------------- 卡片

const LoraCard = memo(function LoraCard({ r, selected, characterName, nameMode, onClick }: { r: LoraResource; selected: boolean; characterName?: string; nameMode: NameMode; onClick: () => void }) {
  const ref = useRef<HTMLButtonElement>(null)
  const [visible, setVisible] = useState(false)
  // 视频只在悬停时挂载并静音循环播放，移开即卸载（停止并释放），同一时间最多一个
  const video = hasVideo(r)
  const [hover, setHover] = useState(false)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(hoverTimer.current), [])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver((e) => e[0].isIntersecting && setVisible(true), { rootMargin: '300px' })
    io.observe(el)
    return () => io.disconnect()
  }, [])
  const src = useLoraImage(r, 360, visible)
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      onMouseEnter={() => {
        if (video) hoverTimer.current = setTimeout(() => setHover(true), 160)
      }}
      onMouseLeave={() => {
        clearTimeout(hoverTimer.current)
        setHover(false)
      }}
      data-testid="lora-card"
      className={cn(
        'group overflow-hidden rounded-xl bg-card text-left ring-1 ring-tint/[0.08] transition hover:-translate-y-0.5 hover:ring-tint/[0.224]',
        selected && 'ring-2 ring-primary/70',
        (r.missing || r.offline) && 'opacity-60',
      )}
    >
      <div className="relative aspect-[3/4] overflow-hidden bg-inset">
        {src ? <img src={src} alt="" draggable={false} className="absolute inset-0 size-full object-cover transition duration-300 group-hover:scale-[1.03]" /> : src === null || (!r.preview && !r.cover) ? <Placeholder r={r} /> : <div className="absolute inset-0 animate-pulse bg-tint/[0.03]" />}
        {video && hover && <video data-testid="lora-hover-video" src={mediaUrl(r)} autoPlay muted loop playsInline className="absolute inset-0 size-full object-cover" />}
        {video && !hover && (
          <span className="absolute right-2 bottom-2 grid size-6 place-items-center rounded-full bg-black/60 text-white/90 backdrop-blur-sm" title="视频封面：悬停播放">
            <Play className="size-3 fill-current" />
          </span>
        )}
        <div className="absolute inset-x-0 top-0 flex items-start gap-1 p-2">
          {r.sidecar?.baseModel && <span className="max-w-[70%] truncate rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] text-white/85 backdrop-blur-sm">{r.sidecar.baseModel}</span>}
          <span className="flex-1" />
          {r.sidecar?.favorite && <Star className="size-4 fill-warning text-warning drop-shadow" />}
        </div>
        {r.missing && <span className="absolute inset-x-2 bottom-2 rounded-md bg-destructive/85 px-2 py-1 text-center text-[10.5px] text-white">文件缺失</span>}
        {r.offline && <span className="absolute inset-x-2 bottom-2 rounded-md bg-warning/85 px-2 py-1 text-center text-[10.5px] text-black">目录无法访问</span>}
        {!r.missing && !r.offline && characterName && (
          <span className="absolute bottom-2 left-2 inline-flex max-w-[85%] items-center gap-1 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] text-white/85 backdrop-blur-sm">
            <User className="size-3 shrink-0" />
            <span className="truncate">{characterName}</span>
          </span>
        )}
      </div>
      <div className="px-2.5 py-2">
        <div className="truncate text-[12.5px] font-medium" title={loraTitle(r, nameMode)}>
          {loraTitle(r, nameMode)}
        </div>
        <div className="truncate text-[10.5px] text-muted-foreground" title={r.relativePath}>
          {r.folder || baseName(r.root) || r.name}
        </div>
      </div>
    </button>
  )
})

// ---------------------------------------------------------------- 详情面板

function Section({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section>
      <FieldLabel right={right}>{title}</FieldLabel>
      {children}
    </section>
  )
}

function Detail({ r, onClose, onChanged }: { r: LoraResource; onClose: () => void; onChanged: (row?: LoraResource) => void }) {
  const lib = useLib((s) => s.lib)
  const src = useLoraImage(r, 1200)
  const nameMode = useNameMode()
  const video = hasVideo(r)
  const [playing, setPlaying] = useState(false)
  const [descOpen, setDescOpen] = useState(false)
  const { draft, patch } = useDraft<LoraResource>(r, r.id, async (v) => {
    try {
      await api['loras.save'](v)
      onChanged(v)
    } catch (e) {
      toast.error((e as Error).message)
    }
  })
  const sc = r.sidecar
  const usage = sc?.usage
  const header = Object.entries(r.metadata ?? {})
  const isWindows = /^[a-z]:[\\/]/i.test(r.path)
  const suggested = isWindows ? r.relativePath.replaceAll('/', '\\') : r.relativePath
  if (!draft) return null
  const chars = lib?.characters ?? []
  const badges = [sc?.baseModel, sc?.modelType, sc?.versionName, sc?.creator ? `by ${sc.creator}` : undefined].filter(Boolean) as string[]
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-4 pt-3 pb-2">
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" title={r.path}>
          {baseName(r.root)}
          {r.folder ? ` / ${r.folder.replaceAll('/', ' / ')}` : ''}
        </span>
        <IconButton tip="在资源管理器中显示" onClick={() => void call(api['loras.open'](r.id))}>
          <FolderOpen />
        </IconButton>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="关闭">
          <X />
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 pb-6">
        {/* 大预览 */}
        <div className="group relative overflow-hidden rounded-xl bg-inset">
          <div className="relative mx-auto aspect-[3/4] max-h-[44vh] w-full">
            {video && playing ? (
              <video data-testid="lora-detail-video" src={mediaUrl(r)} poster={src ?? undefined} controls autoPlay muted loop playsInline className="absolute inset-0 size-full bg-black object-contain" />
            ) : src ? (
              <img src={src} alt="" className="absolute inset-0 size-full object-contain" />
            ) : src === null || (!r.preview && !r.cover) ? (
              <Placeholder r={r} large />
            ) : (
              <div className="absolute inset-0 animate-pulse bg-tint/[0.03]" />
            )}
            {video && !playing && (
              <button type="button" onClick={() => setPlaying(true)} className="absolute inset-0 grid place-items-center" aria-label="播放视频封面">
                <span className="grid size-14 place-items-center rounded-full bg-black/55 text-white ring-1 ring-white/20 backdrop-blur-sm transition hover:scale-105 hover:bg-black/70">
                  <Play className="ml-0.5 size-6 fill-current" />
                </span>
              </button>
            )}
          </div>
          <div className={cn('absolute right-2 flex gap-1.5 opacity-0 transition group-hover:opacity-100', playing ? 'top-2' : 'bottom-2')}>
            <Button
              size="xs"
              variant="secondary"
              onClick={async () => {
                await call(api['loras.preview'](r.id))
                onChanged()
              }}
            >
              <ImageIcon /> 更换封面
            </Button>
            {r.preview && (
              <Button
                size="xs"
                variant="secondary"
                onClick={async () => {
                  await call(api['loras.clearPreview'](r.id))
                  onChanged()
                }}
              >
                <RotateCcw /> 恢复自动封面
              </Button>
            )}
          </div>
          {r.preview && <span className="absolute top-2 left-2 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] text-white/80">手动封面</span>}
        </div>

        {/* 标题 */}
        <div>
          <div className="flex items-start gap-2">
            <h2 className="min-w-0 flex-1 text-[16px] leading-snug font-semibold break-words">{loraTitle(r, nameMode)}</h2>
            {sc?.favorite && <Star className="mt-1 size-4 shrink-0 fill-warning text-warning" />}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-muted-foreground" title={r.name}>
            {nameMode === 'file' && sc?.modelName ? sc.modelName : <span className="font-mono">{r.name}</span>}
          </div>
          {badges.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {badges.map((b, i) => (
                <span key={b} className={cn('rounded-md px-2 py-0.5 text-[11px]', i === 0 && sc?.baseModel ? 'bg-primary/15 text-primary' : 'bg-tint/[0.06] text-muted-foreground')}>
                  {b}
                </span>
              ))}
            </div>
          )}
          {r.missing && <div className="mt-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">模型文件已不在原位置（可能已删除或移走）。记录与角色关联会保留；文件放回原处或同名同大小的文件重新出现在扫描目录中，重新扫描后会自动恢复这条记录。</div>}
          {r.offline && <div className="mt-2 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">所在目录当前无法访问（磁盘未连接、目录被移除或没有权限），暂时无法确认文件状态，不会当作已删除处理。</div>}
        </div>

        {/* 触发词 */}
        {sc?.triggerWords?.length ? (
          <Section title="触发词" right={<CopyButton text={sc.triggerWords.join(', ')} label="复制全部" />}>
            <div className="flex flex-wrap gap-1.5">
              {sc.triggerWords.map((w) => (
                <button
                  key={w}
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(w)
                    toast.success(`已复制「${w}」`)
                  }}
                  className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-1 font-mono text-[11.5px] text-primary ring-1 ring-primary/25 hover:bg-primary/20"
                  title="点击复制"
                >
                  {w}
                  <Copy className="size-3 opacity-60" />
                </button>
              ))}
            </div>
          </Section>
        ) : null}

        {/* 推荐权重（来自插件 usage_tips） */}
        {usage && (
          <Section title="推荐权重（元数据）">
            <div className="grid grid-cols-3 gap-2">
              {usage.strength !== undefined && (
                <div className="rounded-lg bg-tint/[0.035] p-2.5 text-center">
                  <div className="text-[15px] font-semibold tabular-nums">{usage.strength}</div>
                  <div className="text-[10.5px] text-muted-foreground">强度</div>
                </div>
              )}
              {(usage.strengthMin !== undefined || usage.strengthMax !== undefined) && (
                <div className="rounded-lg bg-tint/[0.035] p-2.5 text-center">
                  <div className="text-[15px] font-semibold tabular-nums">
                    {usage.strengthMin ?? '…'} – {usage.strengthMax ?? '…'}
                  </div>
                  <div className="text-[10.5px] text-muted-foreground">范围</div>
                </div>
              )}
              {usage.clipStrength !== undefined && (
                <div className="rounded-lg bg-tint/[0.035] p-2.5 text-center">
                  <div className="text-[15px] font-semibold tabular-nums">{usage.clipStrength}</div>
                  <div className="text-[10.5px] text-muted-foreground">CLIP 强度</div>
                </div>
              )}
            </div>
          </Section>
        )}

        {sc?.tags?.length ? (
          <Section title="标签">
            <div className="flex flex-wrap gap-1.5">
              {sc.tags.map((t) => (
                <span key={t} className="rounded-full bg-tint/[0.05] px-2.5 py-1 text-[11.5px] text-foreground/80">
                  {t}
                </span>
              ))}
            </div>
          </Section>
        ) : null}

        {sc?.description && (
          <Section title="描述" right={sc.description.length > 240 ? <button type="button" className="text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setDescOpen(!descOpen)}>{descOpen ? '收起' : '展开'}</button> : undefined}>
            <p className={cn('text-[12.5px] leading-relaxed whitespace-pre-line text-foreground/80 select-text', !descOpen && 'line-clamp-5')}>{sc.description}</p>
          </Section>
        )}

        {sc?.notes && (
          <Section title="插件备注">
            <p className="text-[12.5px] leading-relaxed whitespace-pre-line text-foreground/80 select-text">{sc.notes}</p>
          </Section>
        )}

        {r.sidecarError && <div className="rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">{r.sidecarError}</div>}

        {/* ComfyEngi 自己的信息（保存在 Vault，不写入插件元数据） */}
        <div className="space-y-3 rounded-xl bg-tint/[0.025] p-3.5 ring-1 ring-tint/[0.08]">
          <div className="text-[12px] font-medium">ComfyEngi 设置</div>
          <div>
            <FieldLabel hint="角色 LoRA 槽位默认使用该权重">推荐权重</FieldLabel>
            <div className="flex items-center gap-2">
              <input
                type="number"
                step={0.05}
                value={draft.recommendedWeight}
                onChange={(e) => patch({ recommendedWeight: Number(e.target.value) })}
                className="h-8 w-24 rounded-lg bg-tint/[0.04] px-2 text-center text-[13px] tabular-nums ring-1 ring-tint/[0.112] outline-none focus:ring-primary/50"
              />
              {usage?.strength !== undefined && usage.strength !== draft.recommendedWeight && (
                <button type="button" className="text-[11px] text-muted-foreground hover:text-foreground" onClick={() => patch({ recommendedWeight: usage.strength! })}>
                  使用元数据中的 {usage.strength}
                </button>
              )}
            </div>
          </div>
          <div>
            <FieldLabel>关联角色</FieldLabel>
            <div className="flex flex-wrap gap-1.5">
              <Chip active={draft.characterId === null} onClick={() => patch({ characterId: null })}>
                <Unlink className="mr-0.5 inline size-3" />
                不关联
              </Chip>
              {chars.map((c) => (
                <Chip key={c.id} active={draft.characterId === c.id} onClick={() => patch({ characterId: c.id })}>
                  {c.name || '（未命名）'}
                </Chip>
              ))}
            </div>
          </div>
          <div>
            <FieldLabel hint="空格或逗号分隔，用于搜索">我的标签</FieldLabel>
            <TextInput value={draft.tags} onChange={(v) => patch({ tags: v })} placeholder="例如 常用 主角" />
          </div>
          <div>
            <FieldLabel>备注</FieldLabel>
            <TextInput value={draft.note} onChange={(v) => patch({ note: v })} placeholder="可选" />
          </div>
          <div>
            <FieldLabel hint="须与 ComfyUI LoRA 加载节点的选项一致">ComfyUI 模型名称</FieldLabel>
            <TextInput value={draft.comfyName} onChange={(v) => patch({ comfyName: v })} placeholder={suggested} mono />
            {draft.comfyName !== suggested && (
              <button type="button" className="mt-1.5 text-[11px] text-muted-foreground hover:text-foreground" onClick={() => patch({ comfyName: suggested })}>
                按相对路径填入：<span className="font-mono">{suggested}</span>
              </button>
            )}
          </div>
        </div>

        {/* 文件信息 */}
        <Disclosure title="文件信息" summary={`${fmtSize(r.size)} · ${new Date(r.mtime).toLocaleDateString('zh-CN')}`}>
          <div className="grid grid-cols-[72px_1fr] gap-x-3 gap-y-1.5 text-[11.5px]">
            {(
              [
                ['路径', r.path],
                ['大小', fmtSize(r.size)],
                ['修改时间', new Date(r.mtime).toLocaleString('zh-CN')],
                ['封面', r.preview ? '手动指定（保存在工作区）' : r.cover ? `${r.cover}${video ? '（视频）' : ''}` : '—'],
                ['元数据', r.sidecarPath || '—'],
                ...(sc?.sha256 ? [['SHA256', sc.sha256]] : []),
                ...(sc?.civitaiModelId ? [['Civitai', `模型 ${sc.civitaiModelId}${sc.civitaiVersionId ? ` · 版本 ${sc.civitaiVersionId}` : ''}`]] : []),
              ] as [string, string][]
            ).map(([k, v]) => (
              <div key={k} className="contents">
                <span className="text-muted-foreground">{k}</span>
                <span className="min-w-0 font-mono break-all select-text">{v}</span>
              </div>
            ))}
          </div>
        </Disclosure>

        {(header.length > 0 || r.metadataError) && (
          <Disclosure title="训练元数据（文件头）" summary={r.metadataError ? '无法读取' : `${header.length} 项`}>
            {r.metadataError ? (
              <div className="text-xs text-muted-foreground">{r.metadataError}</div>
            ) : (
              <div className="max-h-72 space-y-1 overflow-y-auto text-[11px]">
                {header.map(([k, v]) => {
                  const s = typeof v === 'string' ? v : JSON.stringify(v)
                  return (
                    <div key={k} className="flex gap-2">
                      <span className="w-40 shrink-0 truncate font-mono text-muted-foreground" title={k}>
                        {k}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-mono select-text" title={s.length > 2000 ? `${s.slice(0, 2000)}…` : s}>
                        {s}
                      </span>
                    </div>
                  )
                })}
              </div>
            )}
          </Disclosure>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- 页面

export default function LorasPage() {
  const lib = useLib((s) => s.lib)
  const v = useView()
  const [rows, setRows] = useState<LoraResource[] | null>(null)
  const [roots, setRoots] = useState<string[]>([])
  const [scanning, setScanning] = useState(false)

  const reload = async () => {
    const [r, rt] = await Promise.all([call(api['loras.list']()), call(api['loras.roots']())])
    if (r) setRows(r)
    if (rt) setRoots(rt)
  }
  useEffect(() => {
    void reload()
  }, [])

  const report = (errors: string[] | undefined) => {
    if (!errors) return
    if (errors.length) toast.warning(`扫描完成，${errors.length} 个问题`, { description: errors.slice(0, 5).join('\n') })
    else toast.success('扫描完成')
  }
  const rescan = async () => {
    setScanning(true)
    const errors = await call(api['loras.scan']())
    imageCache.clear()
    await reload()
    setScanning(false)
    report(errors)
  }
  const addRoot = async () => {
    setScanning(true)
    const r = await call(api['loras.addRoot']())
    imageCache.clear()
    await reload()
    setScanning(false)
    if (r) report(r.errors)
  }
  const removeRoot = async (root: string) => {
    if (!(await confirm({ title: `不再扫描「${baseName(root)}」？`, description: `${root}\n\n只是从扫描目录中移除，不会删除或修改任何文件；已有的角色关联保留。`, confirmText: '移除' }))) return
    const rt = await call(api['loras.removeRoot'](root))
    if (rt) setRoots(rt)
    if (v.place && sameRoot(v.place.root, root)) v.set({ place: null })
  }

  const records = useMemo(() => rows ?? [], [rows])
  // 默认只显示实际存在的 LoRA；缺失 / 无法访问的记录仍保留在 Vault 中，打开开关即可查看
  const hiddenCount = useMemo(() => records.filter((r) => r.missing || r.offline).length, [records])
  const offlineCount = useMemo(() => records.filter((r) => r.offline).length, [records])
  const all = useMemo(() => (v.showMissing ? records : records.filter((r) => !r.missing && !r.offline)), [records, v.showMissing])
  const tree = useMemo(() => buildTree(roots, all), [roots, all])
  useEffect(() => {
    const fresh = tree.filter((n) => !v.seenRoots.has(n.key))
    if (!fresh.length) return
    v.set({ open: new Set([...v.open, ...fresh.map((n) => n.key)]), seenRoots: new Set([...v.seenRoots, ...fresh.map((n) => n.key)]) })
  }, [tree]) // eslint-disable-line react-hooks/exhaustive-deps
  const nameMode = useNameMode()
  const setNameMode = async (m: NameMode) => {
    await call(api['settings.set']('lora_display_name', m))
    await reloadLib()
  }
  const charName = useMemo(() => new Map((lib?.characters ?? []).map((c) => [c.id, c.name])), [lib])
  const bases = useMemo(() => [...new Set(all.map((r) => r.sidecar?.baseModel).filter(Boolean) as string[])].sort(), [all])

  const inPlace = (r: LoraResource) => !v.place || (sameRoot(r.root, v.place.root) && (!v.place.folder || r.folder === v.place.folder || r.folder.startsWith(`${v.place.folder}/`)))
  const list = useMemo(() => {
    const q = words(v.q.toLowerCase())
    const out = all.filter((r) => {
      if (!inPlace(r)) return false
      if (v.base && r.sidecar?.baseModel !== v.base) return false
      if (v.link === 'linked' && r.characterId === null) return false
      if (v.link === 'unlinked' && r.characterId !== null) return false
      if (!q.length) return true
      const sc = r.sidecar
      const hay = [r.name, sc?.modelName, r.folder, r.tags, r.note, r.category, sc?.baseModel, ...(sc?.tags ?? []), ...(sc?.triggerWords ?? []), r.characterId !== null ? charName.get(r.characterId) : '']
        .join(' ')
        .toLowerCase()
      return q.every((w) => hay.includes(w))
    })
    const cmp: Record<SortKey, (a: LoraResource, b: LoraResource) => number> = {
      name: (a, b) => loraTitle(a, nameMode).localeCompare(loraTitle(b, nameMode), 'zh'),
      mtime: (a, b) => b.mtime - a.mtime,
      size: (a, b) => b.size - a.size,
    }
    return out.sort(cmp[v.sort])
  }, [all, v.place, v.q, v.base, v.link, v.sort, charName, nameMode]) // eslint-disable-line react-hooks/exhaustive-deps

  // 当前文件夹的直接子文件夹，方便在网格中逐级进入
  const subfolders = useMemo(() => {
    if (!v.place) return []
    const findNode = (nodes: Node[]): Node | undefined => {
      for (const n of nodes) {
        if (sameRoot(n.root, v.place!.root) && n.folder === v.place!.folder) return n
        const f = findNode(n.children)
        if (f) return f
      }
    }
    return findNode(tree)?.children ?? []
  }, [tree, v.place])

  const cur = records.find((r) => r.id === v.sel) ?? null
  const crumbs = v.place ? [baseName(v.place.root), ...(v.place.folder ? v.place.folder.split('/') : [])] : []
  const filtered = !!v.q || !!v.base || v.link !== 'all'

  return (
    <div className="flex h-full">
      {/* 文件夹树 */}
      <div className="flex w-[248px] shrink-0 flex-col border-r border-tint/[0.08]">
        <div className="flex items-center gap-1 px-4 pt-5 pb-3">
          <h1 className="flex-1 text-[15px] font-semibold">LoRA</h1>
          <IconButton tip="添加 LoRA 目录" onClick={addRoot}>
            <FolderPlus />
          </IconButton>
          <IconButton tip="重新扫描全部目录" onClick={rescan} disabled={scanning || !roots.length}>
            <RefreshCw className={cn(scanning && 'animate-spin')} />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          <button
            type="button"
            data-active={!v.place || undefined}
            onClick={() => v.set({ place: null, sel: null })}
            className="mb-1 flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-[13px] text-muted-foreground hover:bg-tint/[0.04] hover:text-foreground data-[active]:bg-tint/[0.08] data-[active]:text-foreground"
          >
            <Layers className="size-4" />
            <span className="flex-1 text-left">全部 LoRA</span>
            <span className="text-[11px] tabular-nums opacity-60">{all.length}</span>
          </button>
          {tree.map((n) => (
            <TreeRow key={n.key} node={n} depth={0} roots={roots} onRemoveRoot={removeRoot} />
          ))}
          {!roots.length && rows && (
            <div className="mt-3 px-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
              添加 ComfyUI 的 LoRA 目录（例如 <span className="font-mono">ComfyUI\models\loras</span>），可以添加多个。
            </div>
          )}
        </div>
        <div className="border-t border-tint/[0.08] px-4 py-3 text-[10.5px] leading-relaxed text-muted-foreground/70">扫描只读取模型、同名封面与 .metadata.json，不修改任何文件。</div>
      </div>

      {/* 卡片网格 */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-3 px-6 pt-5 pb-3">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 text-[15px] font-semibold">
            {v.place ? (
              crumbs.map((c, i) => (
                <span key={i} className="flex min-w-0 items-center gap-1.5">
                  {i > 0 && <ChevronRight className="size-4 shrink-0 text-muted-foreground" />}
                  <button
                    type="button"
                    className={cn('truncate hover:text-primary', i < crumbs.length - 1 && 'text-muted-foreground')}
                    onClick={() => v.set({ place: { root: v.place!.root, folder: crumbs.slice(1, i + 1).join('/') }, sel: null })}
                  >
                    {c}
                  </button>
                </span>
              ))
            ) : (
              <span>全部 LoRA</span>
            )}
            <span className="ml-1 shrink-0 text-xs font-normal text-muted-foreground">{list.length} 个</span>
          </div>
          <SearchBox value={v.q} onChange={(q) => v.set({ q })} placeholder="搜索名称、标签、触发词…" className="w-72" />
          <div className="flex rounded-lg bg-tint/[0.045] p-0.5 ring-1 ring-tint/[0.096]" role="group" aria-label="显示名称">
            {(
              [
                ['model', '模型名称'],
                ['file', '文件名称'],
              ] as const
            ).map(([k, l]) => (
              <button
                key={k}
                type="button"
                onClick={() => void setNameMode(k)}
                data-active={nameMode === k || undefined}
                className="h-7 rounded-md px-2.5 text-[12px] text-muted-foreground hover:text-foreground data-[active]:bg-tint/[0.1] data-[active]:text-foreground"
              >
                {l}
              </button>
            ))}
          </div>
          <select
            value={v.sort}
            onChange={(e) => v.set({ sort: e.target.value as SortKey })}
            className="h-8 rounded-lg bg-tint/[0.045] px-2 text-[12.5px] ring-1 ring-tint/[0.112] outline-none focus:ring-primary/50"
            aria-label="排序"
          >
            <option value="name" className="bg-popover">按名称</option>
            <option value="mtime" className="bg-popover">最近修改</option>
            <option value="size" className="bg-popover">文件大小</option>
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 px-6 pb-3">
          {bases.length > 0 && (
            <>
              <Chip active={!v.base} onClick={() => v.set({ base: null })}>
                全部底模
              </Chip>
              {bases.map((b) => (
                <Chip key={b} active={v.base === b} onClick={() => v.set({ base: v.base === b ? null : b })}>
                  {b}
                </Chip>
              ))}
              <span className="mx-1 h-4 w-px bg-tint/[0.08]" />
            </>
          )}
          {(
            [
              ['all', '全部'],
              ['linked', '已关联角色'],
              ['unlinked', '未关联'],
            ] as const
          ).map(([k, l]) => (
            <Chip key={k} active={v.link === k} onClick={() => v.set({ link: k })}>
              {l}
            </Chip>
          ))}
          {hiddenCount > 0 && (
            <>
              <span className="mx-1 h-4 w-px bg-tint/[0.08]" />
              <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground" title="已删除、移走或所在目录暂时无法访问的旧记录。记录会一直保留，不会自动删除。">
                <Switch checked={v.showMissing} onCheckedChange={(on) => v.set({ showMissing: on })} aria-label="显示缺失文件" />
                显示缺失文件（{hiddenCount}）
              </label>
            </>
          )}
        </div>
        {offlineCount > 0 && !v.showMissing && (
          <div className="mx-6 mb-3 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
            {offlineCount} 个 LoRA 所在的目录当前无法访问（磁盘未连接或目录被移除），已暂时隐藏；记录不会被删除，目录恢复后重新扫描即可。
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
          {subfolders.length > 0 && (
            <div className="mb-4 flex flex-wrap gap-2">
              {subfolders.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => {
                    const open = new Set(v.open)
                    open.add(f.key)
                    for (const n of tree) if (sameRoot(n.root, f.root)) open.add(n.key)
                    v.set({ place: { root: f.root, folder: f.folder }, sel: null, open })
                  }}
                  className="flex items-center gap-2 rounded-xl bg-tint/[0.035] px-3 py-2 text-[12.5px] ring-1 ring-tint/[0.08] hover:bg-tint/[0.07]"
                >
                  <Folder className="size-4 text-muted-foreground" />
                  {f.name}
                  <span className="text-[11px] text-muted-foreground">{f.count}</span>
                </button>
              ))}
            </div>
          )}
          {rows === null ? null : list.length ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-3">
              {list.map((r) => (
                <LoraCard key={r.id} r={r} selected={v.sel === r.id} characterName={r.characterId !== null ? charName.get(r.characterId) : undefined} nameMode={nameMode} onClick={() => v.set({ sel: v.sel === r.id ? null : r.id })} />
              ))}
            </div>
          ) : (
            <EmptyState
              icon={<ImageOff />}
              title={!roots.length && !all.length ? '还没有添加 LoRA 目录' : filtered ? '没有匹配的 LoRA' : '这个文件夹中没有 LoRA'}
              description={!roots.length && !all.length ? '添加 ComfyUI 的 LoRA 目录后，会按真实文件夹结构显示，并自动读取同名封面和 .metadata.json。' : undefined}
              action={
                !roots.length && !all.length ? (
                  <Button onClick={addRoot}>
                    <FolderPlus /> 添加 LoRA 目录
                  </Button>
                ) : filtered ? (
                  <Button variant="secondary" onClick={() => v.set({ q: '', base: null, link: 'all' })}>
                    清除筛选
                  </Button>
                ) : undefined
              }
            />
          )}
        </div>
      </div>

      {cur && (
        <div className="absolute inset-y-3 right-3 z-30 w-[440px] overflow-hidden rounded-2xl bg-popover shadow-2xl ring-1 shadow-tint/15 ring-tint/[0.128] 2xl:static 2xl:my-3 2xl:mr-3 2xl:shrink-0 2xl:bg-card 2xl:shadow-none">
          <Detail
            key={cur.id}
            r={cur}
            onClose={() => v.set({ sel: null })}
            onChanged={(row) => {
              if (row) setRows((rs) => rs?.map((x) => (x.id === row.id ? { ...x, ...row } : x)) ?? rs)
              else {
                for (const k of [...imageCache.keys()]) if (k.startsWith(`${cur.id}|`)) imageCache.delete(k)
                void reload()
              }
            }}
          />
        </div>
      )}
    </div>
  )
}
