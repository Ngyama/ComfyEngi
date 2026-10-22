// 主界面使用的快捷选择器：角色、剧情、姿态。

import { useEffect, useMemo, useState } from 'react'
import { BookOpen, Check, Dices, Plus, Shirt, Sparkles, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Avatar, Chip, EmptyState, FieldLabel, SearchBox } from '@/components/common'
import { hueOf, matches } from '@/lib/hooks'
import { templatesOf, useLib, useNav } from '@/lib/stores'
import { cn } from '@/lib/utils'
import { pickRandomStory } from '@shared/planner'
import type { Story } from '@shared/types'

// ---------------------------------------------------------------- 角色
export function CharacterPicker({ open, onOpenChange, value, onPick }: { open: boolean; onOpenChange: (o: boolean) => void; value: number | null; onPick: (id: number) => void }) {
  const lib = useLib((s) => s.lib)
  const go = useNav((s) => s.go)
  const [q, setQ] = useState('')
  useEffect(() => setQ(''), [open])
  const chars = (lib?.characters ?? []).filter((c) => !q || matches(c as never, q))
  const outfitCount = (id: number) => (lib?.outfits ?? []).filter((o) => o.character_id === id).length
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] flex-col gap-4 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>选择角色</DialogTitle>
          <DialogDescription>角色的基础 Prompt、LoRA 和服装模板会自动载入。</DialogDescription>
        </DialogHeader>
        <SearchBox value={q} onChange={setQ} placeholder="搜索角色名称、标签或 Prompt…" autoFocus />
        <div className="-mx-1 grid min-h-0 flex-1 grid-cols-2 gap-2 overflow-y-auto px-1 pb-1">
          {chars.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => {
                onPick(c.id)
                onOpenChange(false)
              }}
              className={cn(
                'flex items-center gap-3 rounded-xl bg-card p-3 text-left ring-1 ring-white/[0.05] transition hover:bg-accent',
                value === c.id && 'ring-primary/60',
              )}
            >
              <Avatar name={c.name} hue={hueOf(c.name)} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">{c.name || '（未命名）'}</div>
                <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                  {outfitCount(c.id)} 套服装 · {(c.loras ?? []).filter((l) => l.name).length} 个 LoRA{c.tag ? ` · ${c.tag}` : ''}
                </div>
              </div>
              {value === c.id && <Check className="size-4 text-primary" />}
            </button>
          ))}
          {!chars.length && (
            <div className="col-span-2">
              <EmptyState icon={<Users />} title={q ? '没有匹配的角色' : '角色库是空的'} description="在角色库中添加角色、LoRA 和服装模板。" />
            </div>
          )}
        </div>
        <DialogFooter className="sm:justify-between">
          <Button variant="ghost" onClick={() => (onOpenChange(false), go('characters'))}>
            <Users /> 管理角色库
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------- 剧情
export function StoryPicker({
  open,
  onOpenChange,
  storyId,
  outfitId,
  characterId,
  onPick,
  onOutfit,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  storyId: number | null
  outfitId: number | null
  characterId: number | null
  onPick: (id: number | null) => void
  onOutfit: (id: number | null) => void
}) {
  const lib = useLib((s) => s.lib)
  const planLib = useLib((s) => s.planLib)
  const go = useNav((s) => s.go)
  const stories = lib?.stories ?? []
  const genres = useMemo(() => [...new Set(stories.map((s) => s.genre ?? ''))].sort(), [stories])
  const current = stories.find((s) => s.id === storyId)
  const [genre, setGenre] = useState<string | null>(null)
  useEffect(() => {
    if (open) setGenre(current ? (current.genre ?? '') : (genres[0] ?? null))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  const list = stories.filter((s) => genre === null || (s.genre ?? '') === genre)
  const outfits = (lib?.outfits ?? []).filter((o) => o.character_id === characterId)
  const total = (s: Story) => (s.scenes ?? []).reduce((a, x) => a + (Number(x.count) || 0), 0)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[82vh] flex-col gap-4 sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>选择剧情</DialogTitle>
          <DialogDescription>剧情场景按模板中的顺序，先于姿态序列生成。也可以不使用剧情。</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 gap-4">
          <div className="flex w-40 shrink-0 flex-col gap-0.5">
            <FieldLabel>剧情类型</FieldLabel>
            {genres.map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => setGenre(g)}
                data-active={genre === g || undefined}
                className="flex h-8 items-center justify-between rounded-lg px-2.5 text-[13px] text-muted-foreground hover:bg-white/[0.05] data-[active]:bg-white/[0.08] data-[active]:text-foreground"
              >
                <span className="truncate">{g || '未分类'}</span>
                <span className="text-[11px] opacity-60">{stories.filter((s) => (s.genre ?? '') === g).length}</span>
              </button>
            ))}
            {!genres.length && <div className="text-xs text-muted-foreground">还没有剧情模板</div>}
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-2">
            <div className="flex items-center gap-2">
              <FieldLabel>{genre === null ? '全部剧情' : genre || '未分类'}</FieldLabel>
              <div className="flex-1" />
              {genre !== null && list.length > 0 && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    const st = planLib && pickRandomStory(planLib, genre)
                    if (st) onPick(st.id)
                  }}
                >
                  <Dices /> 随机一套
                </Button>
              )}
            </div>
            <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-2 gap-2 overflow-y-auto">
              <button
                type="button"
                onClick={() => onPick(null)}
                className={cn('flex flex-col justify-center gap-1 rounded-xl border border-dashed border-white/[0.1] p-3 text-left hover:bg-white/[0.03]', !storyId && 'border-primary/60 text-primary')}
              >
                <div className="text-[13px]">不使用剧情</div>
                <span className="text-[11px] text-muted-foreground">直接从姿态序列开始</span>
              </button>
              {list.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => onPick(s.id)}
                  className={cn('rounded-xl bg-card p-3 text-left ring-1 ring-white/[0.05] hover:bg-accent', storyId === s.id && 'ring-primary/60')}
                >
                  <div className="flex items-center gap-2">
                    <BookOpen className="size-3.5 text-muted-foreground" />
                    <span className="truncate text-[13px] font-medium">{s.name || '（未命名）'}</span>
                    {storyId === s.id && <Check className="ml-auto size-4 text-primary" />}
                  </div>
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    {(s.scenes ?? []).length} 个场景 · {total(s)} 张
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {(s.scenes ?? []).slice(0, 6).map((sc, i) => (
                      <span key={i} className="rounded-md bg-white/[0.05] px-1.5 py-0.5 text-[10.5px] text-muted-foreground">
                        {i + 1}. {sc.name}
                      </span>
                    ))}
                    {(s.scenes ?? []).length > 6 && <span className="text-[10.5px] text-muted-foreground">…</span>}
                  </div>
                </button>
              ))}
            </div>
            {storyId && (
              <div className="rounded-xl bg-white/[0.025] p-3 ring-1 ring-white/[0.05]">
                <FieldLabel hint="剧情场景统一使用的服装（可不选）">
                  <span className="inline-flex items-center gap-1">
                    <Shirt className="size-3" /> 剧情服装
                  </span>
                </FieldLabel>
                <div className="flex flex-wrap gap-1.5">
                  <Chip active={!outfitId} onClick={() => onOutfit(null)}>
                    不指定
                  </Chip>
                  {outfits.map((o) => (
                    <Chip key={o.id} active={outfitId === o.id} onClick={() => onOutfit(o.id)} title={o.positive}>
                      {o.name}
                    </Chip>
                  ))}
                  {!characterId && <span className="text-xs text-muted-foreground">先选择角色后可指定服装</span>}
                </div>
              </div>
            )}
          </div>
        </div>
        <DialogFooter className="sm:justify-between">
          <Button variant="ghost" onClick={() => (onOpenChange(false), go('stories'))}>
            <BookOpen /> 管理剧情库
          </Button>
          <Button onClick={() => onOpenChange(false)}>完成</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------- 姿态
export function PosePicker({ open, onOpenChange, onAdd, insertAfter }: { open: boolean; onOpenChange: (o: boolean) => void; onAdd: (ids: number[]) => void; insertAfter: number | null }) {
  const lib = useLib((s) => s.lib)
  const go = useNav((s) => s.go)
  const poses = templatesOf(lib, 'pose')
  const cats = useMemo(() => [...new Set(poses.map((p) => p.category).filter(Boolean))].sort(), [poses])
  const [q, setQ] = useState('')
  const [cat, setCat] = useState<string | null>(null)
  const [picked, setPicked] = useState<number[]>([])
  useEffect(() => {
    if (open) {
      setQ('')
      setPicked([])
    }
  }, [open])
  const list = poses.filter((p) => (!cat || p.category === cat) && (!q || matches(p as never, q)))
  const toggle = (id: number) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))
  const commit = (ids: number[]) => {
    if (!ids.length) return
    onAdd(ids)
    onOpenChange(false)
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[82vh] flex-col gap-3 sm:max-w-3xl"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && picked.length) commit(picked)
        }}
      >
        <DialogHeader>
          <DialogTitle>添加姿态</DialogTitle>
          <DialogDescription>
            点选一个或多个姿态（按点选顺序添加），{insertAfter === null ? '添加到序列末尾' : `插入到第 ${insertAfter + 1} 个姿态之后`}。双击可直接添加单个。
          </DialogDescription>
        </DialogHeader>
        <SearchBox value={q} onChange={setQ} placeholder="搜索姿态名称、标签或 Prompt…" autoFocus />
        {cats.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            <Chip active={!cat} onClick={() => setCat(null)}>
              全部
            </Chip>
            {cats.map((c) => (
              <Chip key={c} active={cat === c} onClick={() => setCat(cat === c ? null : c)}>
                {c}
              </Chip>
            ))}
          </div>
        )}
        <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-3 gap-2 overflow-y-auto pb-1">
          {list.map((p) => {
            const n = picked.indexOf(p.id)
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => toggle(p.id)}
                onDoubleClick={() => commit([p.id])}
                className={cn('relative rounded-xl bg-card p-3 text-left ring-1 ring-white/[0.05] transition hover:bg-accent', n >= 0 && 'bg-primary/10 ring-primary/50')}
              >
                {n >= 0 && <span className="absolute top-2 right-2 grid size-5 place-items-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">{n + 1}</span>}
                <div className="truncate pr-6 text-[13px] font-medium">{p.name || '（未命名）'}</div>
                <div className="mt-1 line-clamp-2 font-mono text-[11px] leading-snug text-muted-foreground">{p.positive || '—'}</div>
                {p.category && <div className="mt-2 text-[10.5px] text-muted-foreground/80">{p.category}</div>}
              </button>
            )
          })}
          {!list.length && (
            <div className="col-span-3">
              <EmptyState icon={<Sparkles />} title={poses.length ? '没有匹配的姿态' : '姿态库是空的'} description="姿态模板在「素材库 → 姿态」中管理。" />
            </div>
          )}
        </div>
        <DialogFooter className="sm:justify-between">
          <Button variant="ghost" onClick={() => (onOpenChange(false), go('library'))}>
            管理姿态素材
          </Button>
          <Button disabled={!picked.length} onClick={() => commit(picked)}>
            <Plus /> 添加 {picked.length || ''} 个姿态
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
