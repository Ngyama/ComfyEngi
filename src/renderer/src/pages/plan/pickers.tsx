// 主界面使用的快捷选择器：全局 Prompt、角色（主角色 / 第二角色）、剧情、动作、工作流。

import { useEffect, useMemo, useState } from 'react'
import { BookOpen, Check, Dices, Plus, Settings2, Shirt, Sparkles, Users, Workflow as WorkflowIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Avatar, Chip, EmptyState, FieldLabel, PriorityBadge, SearchBox, StatusDot } from '@/components/common'
import { api, call } from '@/lib/api'
import { hueOf, matchesName } from '@/lib/hooks'
import { reloadLib, templatesOf, useLib, useNav } from '@/lib/stores'
import { cn } from '@/lib/utils'
import { pickRandomStory } from '@shared/planner'
import type { Story } from '@shared/types'

// ---------------------------------------------------------------- 角色
export function CharacterPicker({
  open,
  onOpenChange,
  value,
  onPick,
  title = '选择角色',
  description = '角色的基础 Prompt、LoRA 和服装模板会自动载入。',
  onClear,
  clearLabel = '清除选择',
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  value: number | null
  onPick: (id: number) => void
  title?: string
  description?: string
  /** 提供时显示「不使用」按钮（第二角色可不选择） */
  onClear?: () => void
  clearLabel?: string
}) {
  const lib = useLib((s) => s.lib)
  const go = useNav((s) => s.go)
  const [q, setQ] = useState('')
  useEffect(() => setQ(''), [open])
  const chars = (lib?.characters ?? []).filter((c) => matchesName(c, q))
  const outfitCount = (id: number) => (lib?.outfits ?? []).filter((o) => o.character_id === id).length
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] flex-col gap-4 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <SearchBox value={q} onChange={setQ} placeholder="搜索角色名称…" autoFocus />
        <div className="-mx-1 -mt-0.5 grid min-h-0 flex-1 grid-cols-2 gap-2 overflow-y-auto px-1 pt-0.5 pb-1">
          {chars.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => {
                onPick(c.id)
                onOpenChange(false)
              }}
              className={cn(
                'flex items-center gap-3 rounded-xl bg-card p-3 text-left ring-1 ring-tint/[0.08] transition hover:bg-accent',
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
          {onClear && value !== null && (
            <Button variant="secondary" onClick={() => (onClear(), onOpenChange(false))}>
              {clearLabel}
            </Button>
          )}
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
          <DialogDescription>剧情场景按模板中的顺序，先于动作序列生成。也可以不使用剧情。</DialogDescription>
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
                className="flex h-8 items-center justify-between rounded-lg px-2.5 text-[13px] text-muted-foreground hover:bg-tint/[0.05] data-[active]:bg-tint/[0.08] data-[active]:text-foreground"
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
                className={cn('flex flex-col justify-center gap-1 rounded-xl border border-dashed border-tint/[0.16] p-3 text-left hover:bg-tint/[0.03]', !storyId && 'border-primary/60 text-primary')}
              >
                <div className="text-[13px]">不使用剧情</div>
                <span className="text-[11px] text-muted-foreground">直接从动作序列开始</span>
              </button>
              {list.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => onPick(s.id)}
                  className={cn('rounded-xl bg-card p-3 text-left ring-1 ring-tint/[0.08] hover:bg-accent', storyId === s.id && 'ring-primary/60')}
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
                      <span key={i} className="rounded-md bg-tint/[0.05] px-1.5 py-0.5 text-[10.5px] text-muted-foreground">
                        {i + 1}. {sc.name}
                      </span>
                    ))}
                    {(s.scenes ?? []).length > 6 && <span className="text-[10.5px] text-muted-foreground">…</span>}
                  </div>
                </button>
              ))}
            </div>
            {storyId && (
              <div className="rounded-xl bg-tint/[0.025] p-3 ring-1 ring-tint/[0.08]">
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

// ---------------------------------------------------------------- 动作
/** 新增的动作：单人（主角色的一个或多个状态，合并为一个动作），或双人主体位（可带子体位） */
export type NewAction = { state_ids: number[] } | { position_id: number; subposition_id: number | null }

export function PosePicker({ open, onOpenChange, onAdd, insertAfter }: { open: boolean; onOpenChange: (o: boolean) => void; onAdd: (items: NewAction[]) => void; insertAfter: number | null }) {
  const lib = useLib((s) => s.lib)
  const go = useNav((s) => s.go)
  const poses = templatesOf(lib, 'state')
  const positions = templatesOf(lib, 'position')
  const subs = templatesOf(lib, 'subposition')
  const [mode, setMode] = useState<'single' | 'duo'>('single')
  const [q, setQ] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  useEffect(() => {
    if (open) {
      setQ('')
      setPicked([])
    }
  }, [open])
  const list = poses.filter((p) => matchesName(p, q))
  const posList = positions.filter((p) => matchesName(p, q) || subs.some((s) => s.parent_id === p.id && matchesName(s, q)))
  const toggle = (key: string) => setPicked((p) => (p.includes(key) ? p.filter((x) => x !== key) : [...p, key]))
  // 点选的多个状态合并为同一个动作（同一张图片中一起使用，不会拆成多个动作）；每个主体位各为一个动作
  const toActions = (keys: string[]): NewAction[] => {
    const states = keys.filter((k) => k.startsWith('p:')).map((k) => Number(k.split(':')[1]))
    const duo = keys.filter((k) => k.startsWith('d:')).map((key): NewAction => {
      const [, a, b] = key.split(':')
      return { position_id: Number(a), subposition_id: b ? Number(b) : null }
    })
    return [...(states.length ? [{ state_ids: states }] : []), ...duo]
  }
  const commit = (keys: string[]) => {
    if (!keys.length) return
    onAdd(toActions(keys))
    onOpenChange(false)
  }
  const nNew = toActions(picked).length
  const Badge = ({ k }: { k: string }) => {
    const n = picked.indexOf(k)
    return n >= 0 ? <span className="absolute top-2 right-2 grid size-5 place-items-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">{n + 1}</span> : null
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
          <DialogTitle>添加动作</DialogTitle>
          <DialogDescription>
            单人：点选的多个状态合并为一个动作，同一张图片中一起使用（按点选顺序拼接）；双人：每个主体位添加为一个动作。{insertAfter === null ? '添加到序列末尾' : `插入到第 ${insertAfter + 1} 个动作之后`}。双击可直接添加单个。
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-3">
          <div className="flex rounded-xl bg-tint/[0.04] p-1">
            {(
              [
                ['single', '单人（状态）'],
                ['duo', '双人动作'],
              ] as const
            ).map(([k, l]) => (
              <button key={k} type="button" onClick={() => setMode(k)} data-active={mode === k || undefined} className="h-7 rounded-lg px-3 text-[12.5px] text-muted-foreground data-[active]:bg-tint/[0.09] data-[active]:text-foreground">
                {l}
              </button>
            ))}
          </div>
          <SearchBox value={q} onChange={setQ} placeholder="搜索名称…" autoFocus className="flex-1" />
        </div>
        <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-3 gap-2 overflow-y-auto pb-1">
          {mode === 'single' &&
            list.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => toggle(`p:${p.id}`)}
                onDoubleClick={() => commit([`p:${p.id}`])}
                className={cn('relative rounded-xl bg-card p-3 text-left ring-1 ring-tint/[0.08] transition hover:bg-accent', picked.includes(`p:${p.id}`) && 'bg-primary/10 ring-primary/50')}
              >
                <Badge k={`p:${p.id}`} />
                <div className="flex items-center gap-1.5 pr-6">
                  <span className="truncate text-[13px] font-medium">{p.name || '（未命名）'}</span>
                  <PriorityBadge value={p.priority} />
                </div>
                <div className="mt-1 line-clamp-2 font-mono text-[11px] leading-snug text-muted-foreground">{p.positive || '—'}</div>
              </button>
            ))}
          {mode === 'duo' &&
            posList.map((p) => {
              const kids = subs.filter((s) => s.parent_id === p.id)
              return (
                <div key={p.id} className={cn('relative rounded-xl bg-card p-3 ring-1 ring-tint/[0.08]', picked.includes(`d:${p.id}`) && 'bg-primary/10 ring-primary/50')}>
                  <Badge k={`d:${p.id}`} />
                  <button type="button" className="block w-full text-left" onClick={() => toggle(`d:${p.id}`)} onDoubleClick={() => commit([`d:${p.id}`])}>
                    <div className="flex items-center gap-1.5 pr-6">
                      <span className="truncate text-[13px] font-medium">{p.name || '（未命名）'}</span>
                      <PriorityBadge value={p.priority} />
                    </div>
                    <div className="mt-1 line-clamp-2 font-mono text-[11px] leading-snug text-muted-foreground">{p.positive || '—'}</div>
                  </button>
                  {kids.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {kids.map((c) => {
                        const key = `d:${p.id}:${c.id}`
                        const n = picked.indexOf(key)
                        return (
                          <Chip key={c.id} active={n >= 0} order={n >= 0 ? n + 1 : undefined} onClick={() => toggle(key)} className="h-6 text-[11px]" title={c.positive}>
                            {c.name}
                          </Chip>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          {((mode === 'single' && !list.length) || (mode === 'duo' && !posList.length)) && (
            <div className="col-span-3">
              <EmptyState
                icon={<Sparkles />}
                title={q ? '没有匹配的素材' : mode === 'single' ? '还没有状态素材' : '还没有双人主体位'}
                description={mode === 'single' ? '状态在「素材库 → 状态」中管理。' : '主体位、子体位在「素材库 → 双人动作」中管理；行为（从状态中选择）在动作详情中叠加。'}
              />
            </div>
          )}
        </div>
        <DialogFooter className="sm:justify-between">
          <Button variant="ghost" onClick={() => (onOpenChange(false), go('library'))}>
            管理动作素材
          </Button>
          <Button disabled={!picked.length} onClick={() => commit(picked)}>
            <Plus /> 添加 {nNew || ''} 个动作
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------- 全局 Prompt
/** 整套任务的全局 Prompt（画质、画风与通用负面）：与剧情、角色并列在页面顶部选择 */
export function GlobalPicker({ open, onOpenChange, value, onPick }: { open: boolean; onOpenChange: (o: boolean) => void; value: number | null; onPick: (id: number | null) => void }) {
  const lib = useLib((s) => s.lib)
  const go = useNav((s) => s.go)
  const list = templatesOf(lib, 'global')
  const pick = (id: number | null) => {
    onPick(id)
    onOpenChange(false)
  }
  const row = (id: number | null, name: string, pos: string, neg: string) => (
    <button
      key={id ?? 'none'}
      type="button"
      onClick={() => pick(id)}
      className={cn('flex w-full items-start gap-3 rounded-xl bg-card p-3 text-left ring-1 ring-tint/[0.08] transition hover:bg-accent', value === id && 'ring-primary/60')}
    >
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">{name}</div>
        {pos && <div className="mt-1 line-clamp-2 font-mono text-[11px] text-muted-foreground">{pos}</div>}
        {neg && <div className="mt-0.5 line-clamp-1 font-mono text-[11px] text-muted-foreground/70">负面：{neg}</div>}
      </div>
      {value === id && <Check className="size-4 shrink-0 text-primary" />}
    </button>
  )
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-xl">
        <DialogHeader className="shrink-0">
          <DialogTitle>全局 Prompt</DialogTitle>
          <DialogDescription>画质、画风与通用负面 Prompt，作用于整套图。</DialogDescription>
        </DialogHeader>
        <div className="-mx-1 min-h-0 flex-1 space-y-2 overflow-y-auto px-1 py-0.5">
          {row(null, '不使用', '', '')}
          {list.map((g) => row(g.id, g.name || '（未命名）', g.positive, g.negative))}
        </div>
        <DialogFooter className="shrink-0 sm:justify-start">
          <Button variant="ghost" onClick={() => (onOpenChange(false), go('library'))}>
            管理全局 Prompt
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------- 工作流
/** 套图任务页面的工作流选择与导入（使用与设置页相同的工作流存储；节点映射在设置中编辑） */
export function WorkflowMenu({ value, none, onPick, onClear }: { value: number | null; none?: boolean; onPick: (id: number | null) => void; onClear?: () => void }) {
  const lib = useLib((s) => s.lib)
  const go = useNav((s) => s.go)
  const [open, setOpen] = useState(false)
  const wfs = lib?.workflows ?? []
  const def = wfs.find((w) => w.id === lib?.settings.default_workflow_id)
  const cur = none ? undefined : wfs.find((w) => w.id === (value ?? lib?.settings.default_workflow_id))
  const problem = (w: (typeof wfs)[number]) => (!w.mapping ? '尚未配置节点映射' : w.errors ? `映射有 ${w.errors} 个错误` : '')
  const editMapping = (id: number) => {
    setOpen(false)
    go('settings', { section: 'workflows', workflowId: id })
  }
  const doImport = async () => {
    const r = await call(api['workflows.import']())
    if (!r) return
    if ('error' in r) return toast.error('无法导入工作流', { description: r.error })
    await reloadLib()
    onPick(r.id)
    setOpen(false)
    toast.success('已导入并设为当前任务的工作流', {
      description: '下一步：配置节点映射（Prompt、Seed、LoRA 写入哪些节点）。',
      action: { label: '配置映射', onClick: () => go('settings', { section: 'workflows', workflowId: r.id }) },
      duration: 10000,
    })
  }
  const item = (id: number | null, label: string, w?: (typeof wfs)[number]) => (
    <button
      key={id ?? 'default'}
      type="button"
      onClick={() => (onPick(id), setOpen(false))}
      className={cn('flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] hover:bg-tint/[0.05]', !none && value === id && 'bg-primary/10 text-primary')}
    >
      <StatusDot tone={!w || !w.mapping ? 'warn' : w.errors ? 'error' : 'ok'} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {w && problem(w) && <span className="shrink-0 text-[11px] text-warning">{problem(w)}</span>}
      {!none && value === id && <Check className="size-3.5 shrink-0" />}
    </button>
  )
  const issue = cur ? problem(cur) : '未选择工作流'
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" data-testid="workflow-menu" className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-tint/[0.05] hover:text-foreground" title={issue || '工作流'}>
          <StatusDot tone={!cur || !cur.mapping ? 'warn' : cur.errors ? 'error' : 'ok'} />
          <WorkflowIcon className="size-3.5" />
          <span className="max-w-40 truncate">{cur ? cur.name : '选择工作流'}</span>
          {issue && <span className="text-warning">· {issue}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-2">
        <div className="px-2 pt-1 pb-1.5 text-[11px] text-muted-foreground">当前任务使用的 ComfyUI 工作流</div>
        <div className="max-h-72 space-y-0.5 overflow-y-auto">
          {item(null, def ? `默认：${def.name}` : '默认（未设置）', def)}
          {wfs.map((w) => item(w.id, w.name, w))}
        </div>
        {cur && issue && (
          <div className="mx-1 mt-2 rounded-lg bg-warning/[0.08] px-2.5 py-2 text-[11.5px] text-warning">
            「{cur.name}」{issue}，生成前需要指定 Prompt、Seed 等写入哪些节点。
          </div>
        )}
        <div className="mt-2 flex gap-1 border-t border-tint/[0.08] pt-2">
          <Button size="sm" variant="ghost" className="flex-1" onClick={() => void doImport()}>
            <Plus /> 导入 API 工作流
          </Button>
          <Button size="sm" variant="ghost" className="flex-1" disabled={!cur} onClick={() => cur && editMapping(cur.id)}>
            <Settings2 /> 编辑节点映射
          </Button>
        </div>
        {onClear && !none && (
          <button type="button" data-testid="workflow-clear" onClick={() => (onClear(), setOpen(false))} className="mt-1 w-full rounded-md px-2 py-1.5 text-left text-[12px] text-muted-foreground hover:bg-tint/[0.05] hover:text-foreground">
            清除选择（本任务不使用工作流）
          </button>
        )}
      </PopoverContent>
    </Popover>
  )
}
