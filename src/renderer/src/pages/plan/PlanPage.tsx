// 套图生成计划编辑器（默认主页面）：剧情 → 主角色 / 第二角色 → 动作序列 → 每个动作的配置 → 检查 → 开始。

import { useMemo, useState } from 'react'
import {
  AlertCircle,
  BookOpen,
  Camera,
  Check,
  ChevronDown,
  Copy,
  Eye,
  GripVertical,
  ListPlus,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  Settings2,
  Shirt,
  Smile,
  Trash2,
  User,
  UserPlus,
  Workflow as WorkflowIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Avatar, EmptyState, IconButton, StatusDot } from '@/components/common'
import { SortableArea, useSortableItem } from '@/components/sortable'
import { api, call } from '@/lib/api'
import { hueOf } from '@/lib/hooks'
import { confirm, reloadLib, templatesOf, useLib, useNav, usePlan, useRunner } from '@/lib/stores'
import { cn } from '@/lib/utils'
import { expandTask, newInteractionItem, newItem, newTaskData } from '@shared/planner'
import type { Plan } from '@shared/api'
import type { PlanUnit, TaskItem } from '@shared/types'
import { PlanPreviewDialog, TaskSettingsDialog } from './dialogs'
import { CharacterPicker, PosePicker, StoryPicker, type NewAction } from './pickers'
import { PoseDetail } from './PoseDetail'

// ---------------------------------------------------------------- 任务切换
function TaskSwitcher() {
  const lib = useLib((s) => s.lib)
  const { task, load, rename } = usePlan()
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')

  const create = async () => {
    const d = newTaskData()
    const cur = task?.data
    const g = templatesOf(lib, 'global')[0]
    const mb = templatesOf(lib, 'male').find((t) => t.category === '基础')
    d.global_id = cur?.global_id ?? g?.id ?? null
    d.male_base_id = cur?.male_base_id ?? mb?.id ?? null
    d.character_id = cur?.character_id ?? null // 沿用当前任务的角色，减少重复选择
    d.workflow_id = cur?.workflow_id ?? null
    const r = await call(api['tasks.create'](`套图任务 ${(lib?.tasks.length ?? 0) + 1}`, d))
    if (!r) return
    await reloadLib()
    await load(r.id)
    setOpen(false)
    setName(`套图任务 ${(lib?.tasks.length ?? 0) + 1}`)
    setEditing(true)
  }

  if (editing && task)
    return (
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={() => {
          setEditing(false)
          if (name.trim() && name.trim() !== task.name) void rename(name.trim())
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') {
            setName(task.name)
            setEditing(false)
          }
        }}
        className="h-9 w-72 rounded-lg bg-tint/[0.06] px-3 text-[15px] font-semibold ring-1 ring-primary/50 outline-none"
      />
    )

  return (
    <div className="flex min-w-0 items-center gap-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button type="button" className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-tint/[0.05]">
            <span className="truncate text-[16px] font-semibold tracking-tight">{task?.name ?? '无任务'}</span>
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-1.5" align="start">
          <div className="px-2 pt-1 pb-2 text-[11px] text-muted-foreground">已保存的套图任务</div>
          <div className="max-h-72 overflow-y-auto">
            {(lib?.tasks ?? []).map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => {
                  void load(t.id)
                  setOpen(false)
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] hover:bg-tint/[0.05]"
              >
                <span className="truncate">{t.name}</span>
                {t.id === task?.id && <Check className="ml-auto size-4 text-primary" />}
              </button>
            ))}
          </div>
          <div className="mt-1 border-t border-tint/[0.096] pt-1">
            <button type="button" onClick={create} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] text-primary hover:bg-tint/[0.05]">
              <Plus className="size-4" /> 新建套图任务
            </button>
          </div>
        </PopoverContent>
      </Popover>
      {task && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="任务操作">
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem
              onSelect={() => {
                setName(task.name)
                setEditing(true)
              }}
            >
              <Pencil /> 重命名
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={async () => {
                await usePlan.getState().flush()
                const r = await call(api['tasks.duplicate'](task.id))
                if (r) {
                  await reloadLib()
                  await load(r.id)
                  toast.success('已复制任务')
                }
              }}
            >
              <Copy /> 复制任务
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={async () => {
                if (!(await confirm({ title: `删除「${task.name}」？`, description: '已加入队列或已生成的记录不受影响。', confirmText: '删除', destructive: true }))) return
                await api['tasks.remove'](task.id)
                await reloadLib()
                await load(null)
              }}
            >
              <Trash2 /> 删除任务
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- 顶部上下文卡片
function ContextCard({ icon, label, title, sub, onClick, empty }: { icon: React.ReactNode; label: string; title: string; sub?: string; onClick: () => void; empty?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group flex min-w-0 flex-1 items-center gap-3 rounded-xl bg-card p-3 text-left ring-1 ring-tint/[0.08] transition hover:bg-accent hover:ring-tint/[0.16]',
        empty && 'border border-dashed border-tint/[0.192] bg-transparent ring-0',
      )}
    >
      {icon}
      <div className="min-w-0 flex-1">
        <div className="text-[10.5px] tracking-wide text-muted-foreground uppercase">{label}</div>
        <div className={cn('truncate text-[13.5px] font-medium', empty && 'text-muted-foreground')}>{title}</div>
        {sub && <div className="truncate text-[11px] text-muted-foreground">{sub}</div>}
      </div>
      <ChevronDown className="size-4 shrink-0 text-muted-foreground opacity-0 transition group-hover:opacity-100" />
    </button>
  )
}

// ---------------------------------------------------------------- 姿态卡片
function PoseCard({
  id,
  index,
  item,
  second,
  selected,
  error,
  onSelect,
  onDuplicate,
  onDelete,
}: {
  id: string
  index: number
  item: TaskItem
  /** 第二角色名称（任务选择了第二角色时） */
  second?: string
  selected: boolean
  error?: string
  onSelect: () => void
  onDuplicate: () => void
  onDelete: () => void
}) {
  const lib = useLib((s) => s.lib)
  const s = useSortableItem(id)
  const T = (tid: number | null) => (tid ? lib?.templates.find((t) => t.id === tid) : undefined)
  const pose = T(item.pose_id)
  const position = T(item.position_id ?? null)
  const sub = T(item.subposition_id ?? null)
  const acts = (item.act_ids ?? []).map((a) => T(a)?.name ?? '（已删除）')
  const scene = T(item.scene_id ?? null)
  const label = item.position_id ? (position ? (sub ? `${position.name} · ${sub.name}` : position.name) : '（主体位已删除）') : item.pose_id ? (pose?.name ?? '（动作已删除）') : '（未选择动作）'
  const missing = item.position_id ? !position : !pose
  const outfit = item.outfit_id ? lib?.outfits.find((o) => o.id === item.outfit_id) : undefined
  const exprs = item.expression_ids.map((e) => T(e)?.name ?? '（已删除）')
  const camera = T(item.camera_id)
  const per = exprs.length && item.count % exprs.length === 0 ? item.count / exprs.length : null
  return (
    <div
      ref={s.setNodeRef}
      style={s.style}
      {...s.attributes}
      {...s.listeners}
      onClick={onSelect}
      className={cn(
        'group flex cursor-pointer items-center gap-3 rounded-xl bg-card px-3 py-3 ring-1 ring-tint/[0.08] transition-[background,box-shadow] outline-none hover:bg-accent/70',
        selected && 'bg-accent/80 ring-primary/60',
        error && !selected && 'ring-destructive/40',
        s.isDragging && 'shadow-2xl shadow-tint/15 ring-primary/40',
      )}
    >
      <GripVertical className="size-4 shrink-0 cursor-grab text-muted-foreground/40 group-hover:text-muted-foreground" />
      <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-tint/[0.06] text-xs font-semibold text-muted-foreground tabular-nums">{index + 1}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span data-testid="pose-name" className={cn('truncate text-[14px] font-medium', missing && 'text-destructive')}>{label}</span>
          {item.position_id && pose && <span className="shrink-0 truncate text-[11px] text-muted-foreground">+ {pose.name}</span>}
          {acts.length > 0 && (
            <span className="shrink-0 rounded-md bg-violet-500/10 px-1.5 py-0.5 text-[10.5px] text-violet-600" title="行为">
              {acts.join(' + ')}
            </span>
          )}
          {scene && (
            <span className="shrink-0 rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[10.5px] text-emerald-600" title="场景">
              {scene.name}
            </span>
          )}
          {item.second_enabled && (
            <span className="shrink-0 truncate rounded-md bg-sky-500/10 px-1.5 py-0.5 text-[10.5px] text-sky-600" title="第二角色出场" data-testid="second-badge">
              + {second ?? '（未选择第二角色）'}
            </span>
          )}
          {item.male_enabled && (
            <span className="shrink-0 rounded-md bg-sky-500/10 px-1.5 py-0.5 text-[10.5px] text-sky-600" title="旧版男性设置">
              ♂ 男性（旧版）
            </span>
          )}
          {camera && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-tint/[0.06] px-1.5 py-0.5 text-[10.5px] text-muted-foreground">
              <Camera className="size-3" />
              {camera.name}
            </span>
          )}
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-3 text-xs text-muted-foreground">
          <span className={cn('inline-flex min-w-0 items-center gap-1', !outfit && 'opacity-60')}>
            <Shirt className="size-3 shrink-0" />
            <span className="truncate">{outfit?.name ?? '未指定服装'}</span>
          </span>
          <span className={cn('inline-flex min-w-0 items-center gap-1', !exprs.length && 'opacity-60')}>
            <Smile className="size-3 shrink-0" />
            <span className="truncate">{exprs.length ? exprs.join('、') : '无表情'}</span>
          </span>
        </div>
        {error && (
          <div className="mt-1.5 flex items-center gap-1 text-[11.5px] text-destructive">
            <AlertCircle className="size-3 shrink-0" />
            <span className="truncate">{error}</span>
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
        <IconButton tip="复制" onClick={onDuplicate}>
          <Copy />
        </IconButton>
        <IconButton tip="删除" onClick={onDelete} className="hover:text-destructive">
          <Trash2 />
        </IconButton>
      </div>
      <div className="w-16 shrink-0 text-right">
        <div className="text-[17px] leading-none font-semibold tabular-nums">{item.count}</div>
        <div className="mt-1 text-[10.5px] text-muted-foreground">{per ? `${exprs.length}×${per} 张` : '张'}</div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- 页面
export default function PlanPage() {
  const lib = useLib((s) => s.lib)
  const planLib = useLib((s) => s.planLib)
  const go = useNav((s) => s.go)
  const { task, update, selected, select, saving } = usePlan()
  const runner = useRunner((s) => s.status)
  const [picker, setPicker] = useState<null | 'char' | 'char2' | 'story' | 'pose' | 'settings'>(null)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  // 卡片的稳定 key（拖拽需要），与 items 一一对应
  const [keys, setKeys] = useState<string[]>([])
  const items = task?.data.items ?? []
  const itemKeys = useMemo(() => {
    const k = keys.slice(0, items.length)
    while (k.length < items.length) k.push(Math.random().toString(36).slice(2))
    return k
  }, [keys, items.length])

  const result = useMemo(() => {
    if (!task || !planLib || !lib) return null
    return expandTask(task.data, planLib, lib.settings, task.name)
  }, [task, planLib, lib])

  if (!task)
    return (
      <EmptyState
        icon={<ListPlus />}
        title="还没有套图任务"
        description="新建一个任务，开始编排角色的套图。"
        action={
          <Button
            onClick={async () => {
              const r = await call(api['tasks.create']('套图任务 1', newTaskData()))
              if (r) {
                await reloadLib()
                await usePlan.getState().load(r.id)
              }
            }}
          >
            <Plus /> 新建任务
          </Button>
        }
      />
    )

  const d = task.data
  const char = lib?.characters.find((c) => c.id === d.character_id)
  const char2 = d.second_character_id ? lib?.characters.find((c) => c.id === d.second_character_id) : undefined
  const story = lib?.stories.find((s) => s.id === d.story_id)
  const storyOutfit = lib?.outfits.find((o) => o.id === d.story_outfit_id)
  const wfId = d.workflow_id ?? lib?.settings.default_workflow_id
  const wf = lib?.workflows.find((w) => w.id === wfId)
  const units = result?.units ?? []
  const errors = result?.errors ?? []
  const itemError = (i: number) => errors.find((e) => e.startsWith(`第 ${i + 1} 个动作`))?.replace(/^第 \d+ 个动作(「[^」]*」)?：/, '')
  const globalErrors = errors.filter((e) => !/^第 \d+ 个动作/.test(e))
  const nStory = units.filter((u) => u.section === 'story').length
  const firstUnitOf = (i: number): PlanUnit | null => units.find((u) => u.section === 'pose' && u.item_index === i) ?? null
  const outfitsOf = (cid: number | null | undefined) => (lib?.outfits ?? []).filter((o) => o.character_id === cid).length

  const setKeysAfter = (fn: (k: string[]) => string[]) => setKeys(fn(itemKeys))

  const addPoses = (ids: NewAction[]) => {
    const at = selected !== null && selected < items.length ? selected + 1 : items.length
    const prev = at > 0 ? items[at - 1] : null
    // 服装默认继承上一个动作
    // 双人互动在选择了第二角色时默认让第二角色出场；单人动作默认是单人图片
    update((x) =>
      x.items.splice(at, 0, ...ids.map((a) => ('pose_id' in a ? newItem(a.pose_id, prev?.outfit_id ?? null) : newInteractionItem(a.position_id, a.subposition_id, prev?.outfit_id ?? null, !!x.second_character_id)))),
    )
    setKeysAfter((k) => [...k.slice(0, at), ...ids.map(() => Math.random().toString(36).slice(2)), ...k.slice(at)])
    select(at + ids.length - 1)
  }
  const duplicate = (i: number) => {
    update((x) => x.items.splice(i + 1, 0, structuredClone(x.items[i])))
    setKeysAfter((k) => [...k.slice(0, i + 1), Math.random().toString(36).slice(2), ...k.slice(i + 1)])
    select(i + 1)
  }
  const remove = (i: number) => {
    update((x) => x.items.splice(i, 1))
    setKeysAfter((k) => k.filter((_, j) => j !== i))
    if (selected === i) select(null)
    else if (selected !== null && selected > i) select(selected - 1)
    toast('已删除动作', {
      action: {
        label: '撤销',
        onClick: () => {
          const removed = items[i]
          update((x) => x.items.splice(i, 0, removed))
          setKeysAfter((k) => [...k.slice(0, i), Math.random().toString(36).slice(2), ...k.slice(i)])
        },
      },
    })
  }

  const changeCharacter = (cid: number) => {
    if (cid === d.character_id) return
    const old = new Map((lib?.outfits ?? []).filter((o) => o.character_id === d.character_id).map((o) => [o.id, o.name]))
    const byName = new Map((lib?.outfits ?? []).filter((o) => o.character_id === cid).map((o) => [o.name, o.id]))
    let lost = 0
    update((x) => {
      x.character_id = cid
      for (const it of x.items) {
        if (!it.outfit_id) continue
        const nid = byName.get(old.get(it.outfit_id) ?? '\u0000') ?? null
        if (!nid) lost++
        it.outfit_id = nid
      }
      if (x.story_outfit_id) x.story_outfit_id = byName.get(old.get(x.story_outfit_id) ?? '\u0000') ?? null
    })
    if (lost) toast.warning(`已切换角色：${lost} 个动作的服装在新角色中没有同名服装，请重新选择`)
  }

  /** 第二角色：切换时按同名服装对应；首次选择时让双人互动的动作启用第二角色；取消时所有动作回到单人 */
  const changeSecondCharacter = (cid: number | null) => {
    const prevId = d.second_character_id ?? null
    if (cid === prevId) return
    const old = new Map((lib?.outfits ?? []).filter((o) => o.character_id === prevId).map((o) => [o.id, o.name]))
    const byName = new Map((lib?.outfits ?? []).filter((o) => o.character_id === cid).map((o) => [o.name, o.id]))
    let lost = 0
    update((x) => {
      x.second_character_id = cid
      for (const it of x.items) {
        if (cid === null) it.second_enabled = false
        else if (prevId === null && it.position_id) it.second_enabled = true
        if (!it.second_outfit_id) continue
        const nid = cid === null ? null : (byName.get(old.get(it.second_outfit_id) ?? '\u0000') ?? null)
        if (!nid && cid !== null) lost++
        it.second_outfit_id = nid
      }
    })
    if (lost) toast.warning(`已切换第二角色：${lost} 个动作的服装在新角色中没有同名服装，请重新选择`)
  }

  const openPreview = async () => {
    await usePlan.getState().flush()
    const p = await call(api['plan.forTask'](task.id))
    if (p) {
      setPlan(p)
      setPreviewOpen(true)
    }
  }

  const enqueue = async (start: boolean) => {
    await usePlan.getState().flush()
    const r = await call(api['queue.enqueue']([task.id]))
    if (!r) return
    if (r.failed.length) {
      toast.error('无法加入队列', { description: r.failed[0].errors.slice(0, 4).join('\n') })
      return
    }
    setPreviewOpen(false)
    const n = r.ok[0]?.count ?? 0
    if (start) {
      const st = await api['runner.status']()
      if (!st.alive || st.state === 'paused' || st.state === 'pausing') {
        const pre = await api['runner.precheck']()
        if (pre.error && !(await confirm({ title: '无法连接 ComfyUI', description: `${pre.error}\n\n仍要开始吗？开始后会持续重试连接。`, confirmText: '仍然开始' }))) return
        if (pre.messages.length && !(await confirm({ title: '检查发现问题', description: `${pre.messages.slice(0, 10).join('\n')}\n\n仍要开始吗？`, confirmText: '仍然开始' }))) return
        await api['runner.start']()
      }
      toast.success(`已加入队列并开始生成（${n} 张）`, { action: { label: '查看队列', onClick: () => go('queue') } })
    } else {
      toast.success(`已加入执行队列（${n} 张）`, { description: '之后修改模板不会影响这次入队的内容。', action: { label: '查看队列', onClick: () => go('queue') } })
    }
  }

  const detailOpen = selected !== null && selected < items.length

  return (
    <div className="flex h-full">
      <div className="mx-auto flex w-full max-w-[1120px] min-w-0 flex-1 flex-col">
        {/* 标题与任务操作 */}
        <div className="flex items-center gap-3 px-6 pt-4 pb-3">
          <TaskSwitcher />
          <span className="text-[11px] text-muted-foreground">{saving ? '保存中…' : '已自动保存'}</span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => (wf ? setPicker('settings') : go('settings'))}
            className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-tint/[0.05] hover:text-foreground"
            title={wf ? '工作流（在任务设置中更改）' : '尚未配置工作流，点击前往设置'}
          >
            <StatusDot tone={!wf ? 'warn' : wf.errors ? 'error' : 'ok'} />
            <WorkflowIcon className="size-3.5" />
            <span className="max-w-40 truncate">{wf ? wf.name : '未配置工作流'}</span>
          </button>
          <Button variant="secondary" size="sm" onClick={() => setPicker('settings')}>
            <Settings2 /> 任务设置
          </Button>
        </div>

        {/* 剧情与角色 */}
        <div className="flex gap-3 px-6 pb-4">
          <ContextCard
            icon={<div className="grid size-9 shrink-0 place-items-center rounded-xl bg-amber-500/10 text-amber-600"><BookOpen className="size-4" /></div>}
            label="剧情"
            title={story ? story.name : '不使用剧情'}
            sub={story ? `${story.genre || '未分类'} · ${(story.scenes ?? []).length} 个场景 · ${nStory} 张${storyOutfit ? ` · ${storyOutfit.name}` : ''}` : '直接从动作序列开始'}
            empty={!story}
            onClick={() => setPicker('story')}
          />
          <ContextCard
            icon={char ? <Avatar name={char.name} hue={hueOf(char.name)} /> : <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-tint/[0.05] text-muted-foreground"><User className="size-4" /></div>}
            label="主角色"
            title={char ? char.name : '选择主角色'}
            sub={char ? `${outfitsOf(char.id)} 套服装 · ${(char.loras ?? []).filter((l) => l.name).length} 个 LoRA` : '必选'}
            empty={!char}
            onClick={() => setPicker('char')}
          />
          <ContextCard
            icon={char2 ? <Avatar name={char2.name} hue={hueOf(char2.name)} /> : <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-tint/[0.05] text-muted-foreground"><UserPlus className="size-4" /></div>}
            label="第二角色"
            title={char2 ? char2.name : d.second_character_id ? '（第二角色已被删除）' : '不使用'}
            sub={char2 ? `${outfitsOf(char2.id)} 套服装 · ${(char2.loras ?? []).filter((l) => l.name).length} 个 LoRA · 在动作中启用` : '可选：双人图片时选择'}
            empty={!char2}
            onClick={() => setPicker('char2')}
          />
        </div>

        {/* 动作序列 */}
        <div className="flex items-center gap-2 px-6 pb-1.5">
          <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">动作序列</span>
          <span className="text-[11px] text-muted-foreground/70">按此顺序生成 · 拖动调整</span>
          <div className="flex-1" />
          <Button size="sm" variant="ghost" onClick={() => setPicker('pose')}>
            <Plus /> 添加动作
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-0.5 pb-4" onClick={() => select(null)}>
          {globalErrors.length > 0 && (
            <div className="mb-2 space-y-1 rounded-xl bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {globalErrors.map((e, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <AlertCircle className="size-3.5 shrink-0" />
                  {e}
                </div>
              ))}
            </div>
          )}
          <div className="space-y-2" onClick={(e) => e.stopPropagation()}>
            <SortableArea
              items={items}
              getId={(_, i) => itemKeys[i]}
              onReorder={(from, to, next) => {
                update((x) => (x.items = structuredClone(next)))
                const k = [...itemKeys]
                k.splice(to, 0, k.splice(from, 1)[0])
                setKeys(k)
                if (selected === from) select(to)
                else if (selected !== null) {
                  const order = items.map((_, j) => j)
                  order.splice(to, 0, order.splice(from, 1)[0])
                  select(order.indexOf(selected))
                }
              }}
            >
              {items.map((it, i) => (
                <PoseCard
                  key={itemKeys[i]}
                  id={itemKeys[i]}
                  index={i}
                  item={it}
                  second={char2?.name}
                  selected={selected === i}
                  error={itemError(i)}
                  onSelect={() => select(i)}
                  onDuplicate={() => duplicate(i)}
                  onDelete={() => remove(i)}
                />
              ))}
            </SortableArea>
            <button
              type="button"
              onClick={() => setPicker('pose')}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-tint/[0.16] py-4 text-[13px] text-muted-foreground transition hover:border-primary/40 hover:bg-primary/[0.04] hover:text-primary"
            >
              <Plus className="size-4" />
              {items.length ? '添加动作' : '从素材库添加第一个动作'}
            </button>
          </div>
        </div>

        {/* 底部操作 */}
        <div className="flex items-center gap-3 border-t border-tint/[0.08] px-6 py-3">
          <div className="min-w-0">
            <div className="text-[13px]">
              共 <span className="text-[15px] font-semibold tabular-nums">{units.length}</span> 张
              <span className="ml-2 text-xs text-muted-foreground">
                {nStory ? `剧情 ${nStory} + ` : ''}动作 {units.length - nStory} · {items.length} 个动作
              </span>
            </div>
          </div>
          {errors.length > 0 && (
            <Popover>
              <PopoverTrigger asChild>
                <button type="button" className="inline-flex items-center gap-1.5 rounded-full bg-destructive/12 px-2.5 py-1 text-xs text-destructive hover:bg-destructive/20">
                  <AlertCircle className="size-3.5" /> {errors.length} 个问题
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-96 space-y-1.5 text-xs" side="top" align="start">
                {errors.map((e, i) => (
                  <div key={i} className="text-destructive">
                    × {e}
                  </div>
                ))}
              </PopoverContent>
            </Popover>
          )}
          <div className="flex-1" />
          <Button variant="ghost" onClick={openPreview} disabled={!items.length && !story}>
            <Eye /> 预览计划
          </Button>
          <Button variant="secondary" onClick={() => enqueue(false)} disabled={!units.length || errors.length > 0}>
            <ListPlus /> 加入队列
          </Button>
          <Button onClick={() => enqueue(true)} disabled={!units.length || errors.length > 0}>
            <Play /> {runner.alive && runner.state === 'running' ? '加入并继续生成' : '开始生成'}
          </Button>
        </div>
      </div>

      {/* 姿态详情：宽屏时并排，窄屏时浮在序列上方 */}
      {detailOpen && (
        <div className="absolute top-3 right-3 bottom-[76px] z-30 w-[380px] overflow-hidden rounded-2xl bg-popover shadow-2xl ring-1 shadow-tint/15 ring-tint/[0.128] 2xl:static 2xl:my-3 2xl:mr-3 2xl:w-[400px] 2xl:shrink-0 2xl:bg-card 2xl:shadow-none">
          <PoseDetail index={selected!} firstUnit={firstUnitOf(selected!)} onClose={() => select(null)} />
        </div>
      )}

      <CharacterPicker open={picker === 'char'} onOpenChange={(o) => setPicker(o ? 'char' : null)} value={d.character_id} onPick={changeCharacter} title="选择主角色" />
      <CharacterPicker
        open={picker === 'char2'}
        onOpenChange={(o) => setPicker(o ? 'char2' : null)}
        value={d.second_character_id ?? null}
        onPick={changeSecondCharacter}
        onClear={() => changeSecondCharacter(null)}
        title="选择第二角色"
        description="与主角色来自同一个角色库。第二角色在每个动作中单独启用，可分别选择服装、动作和表情；未启用的动作生成单人图片。"
      />
      <StoryPicker
        open={picker === 'story'}
        onOpenChange={(o) => setPicker(o ? 'story' : null)}
        storyId={d.story_id}
        outfitId={d.story_outfit_id}
        characterId={d.character_id}
        onPick={(id) => update((x) => (x.story_id = id))}
        onOutfit={(id) => update((x) => (x.story_outfit_id = id))}
      />
      <PosePicker open={picker === 'pose'} onOpenChange={(o) => setPicker(o ? 'pose' : null)} onAdd={addPoses} insertAfter={selected !== null && selected < items.length ? selected : null} />
      <TaskSettingsDialog open={picker === 'settings'} onOpenChange={(o) => setPicker(o ? 'settings' : null)} />
      <PlanPreviewDialog open={previewOpen} onOpenChange={setPreviewOpen} plan={plan} onEnqueue={enqueue} />
    </div>
  )
}
