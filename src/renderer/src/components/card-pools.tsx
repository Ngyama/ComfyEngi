// 动作卡的素材池：每个池都是「固定 Prompt + 随机候选 Prompt」两栏，素材显示为自动换行的紧凑标签，在两栏之间拖动。
// 素材库中编辑动作卡，套图任务中按池覆盖（只对当前任务生效）。
// 每个池折叠为一行摘要，一次只展开一个，避免在主界面同时铺开所有素材池。

import { useState } from 'react'
import { createPortal } from 'react-dom'
import { closestCenter, DndContext, DragOverlay, MeasuringStrategy, PointerSensor, pointerWithin, rectIntersection, useDroppable, useSensor, useSensors, type CollisionDetection, type DragMoveEvent } from '@dnd-kit/core'
import { SortableContext, useSortable } from '@dnd-kit/sortable'
import { ChevronDown, ChevronRight, GripVertical, Plus, RotateCcw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { MaterialPicker } from '@/pages/plan/MaterialPicker'
import { fixedConflicts, movePoolItem, normalizePool, poolSummary, poolsOf, resolvePool } from '@shared/cards'
import { CARD_POOLS, type CardPick, type CardPoolKey, type Library, type PoolConfig, type Template } from '@shared/types'
import { templatesOf, useLib } from '@/lib/stores'

const POOL_HINT: Record<CardPoolKey, string> = {
  variant: '这张动作卡的结构变体。默认全部在随机候选中，每张图片抽一个；都移除时只用基础 Prompt。',
  pose: '主角色自身的身体姿态和局部动作（包括手部动作），从「状态」素材中选择。',
  expr: '主角色的表情，从「表情」素材中选择。',
  interaction: '两个角色之间的互动（拥抱、接吻、牵手等），从「状态」素材中选择。',
  pose2: '第二角色的局部姿态，与主角色使用同一个状态库，只是使用的素材不同。',
  expr2: '第二角色的表情，从「表情」素材中选择。',
  extra: '不适合放入以上分类的补充 Prompt，可以不配置。',
}

type Zone = 'fixed' | 'random'
type Lists = { fixed: number[]; random: number[] }
const ZONES: { zone: Zone; title: string; hint: string; empty: string }[] = [
  { zone: 'fixed', title: '固定 Prompt', hint: '这里的素材全部加入每张图片', empty: '没有固定素材。点击添加，或从下方拖到这里' },
  { zone: 'random', title: '随机候选 Prompt', hint: '每张图片从这里随机抽取 1 个', empty: '没有随机候选。点击添加，或从上方拖到这里' },
]
const ZONE_ID: Record<Zone, string> = { fixed: 'zone-fixed', random: 'zone-random' }

/** 指针所在的素材优先；在栏内的空白处时取最近的标签（优先同一行，例如放到行尾），空栏才算放入栏本身 */
const collision: CollisionDetection = (args) => {
  const within = pointerWithin(args)
  const hits = within.length ? within : rectIntersection(args)
  const chips = hits.filter((h) => !String(h.id).startsWith('zone-'))
  if (chips.length) return chips
  const zone = hits.length ? args.droppableRects.get(hits[0].id) : undefined
  const p = args.pointerCoordinates
  if (zone && p) {
    let best: { id: string | number; d: number } | null = null
    for (const { id } of args.droppableContainers) {
      const r = args.droppableRects.get(id)
      if (!r || String(id).startsWith('zone-') || r.top < zone.top || r.bottom > zone.bottom) continue
      const d = Math.max(r.top - p.y, 0, p.y - r.bottom) * 1000 + Math.max(r.left - p.x, 0, p.x - r.right)
      if (!best || d < best.d) best = { id, d }
    }
    if (best) return [{ id: best.id }]
  }
  return hits.length ? hits : closestCenter(args)
}

/** 素材标签的外观：宽度随名称变化，过长时截断（完整名称在 title 中） */
const CHIP = 'inline-flex h-7 max-w-full items-center gap-0.5 rounded-lg px-0.5 text-[12.5px] ring-1'
/** 标签的宽度各不相同，不用位移预览：拖动时直接调整实际顺序，由浏览器重新换行，被拖动的标签由浮层跟随指针 */
const noShift = () => null

/** 一个素材标签：拖动手柄、名称、移除 */
function PoolChip({ id, name, struck, onRemove, onRestore, onKeyMove }: { id: number; name: string; struck: boolean; onRemove: () => void; onRestore?: () => void; onKeyMove: (key: string) => boolean }) {
  const s = useSortable({ id: String(id) })
  return (
    <div ref={s.setNodeRef} data-testid="pool-item" className={cn(CHIP, 'bg-tint/[0.04] ring-tint/[0.08]', s.isDragging && 'bg-primary/[0.08] opacity-60 ring-primary/50')}>
      <button type="button" ref={s.setActivatorNodeRef} {...s.attributes} {...s.listeners} onKeyDown={(e) => onKeyMove(e.key) && e.preventDefault()} data-pool-grip={id} aria-label={`拖动 ${name}`} title="拖动调整；也可以用方向键：左右调整顺序，上下移到另一栏" className="flex size-5 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground hover:text-foreground active:cursor-grabbing">
        <GripVertical className="size-3.5" />
      </button>
      <span className={cn('max-w-64 min-w-0 truncate', struck && 'text-muted-foreground line-through')} title={name}>
        {name}
      </span>
      {struck && onRestore && (
        <Button size="xs" variant="ghost" className="h-5 shrink-0 px-1" onClick={onRestore}>
          恢复抽取
        </Button>
      )}
      <button type="button" aria-label={`移除 ${name}`} onClick={onRemove} className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground">
        <X className="size-3.5" />
      </button>
    </div>
  )
}

/** 一栏：标题、添加按钮、可排序的素材标签；空栏也可以放入。正在拖动的素材所在的栏高亮 */
function PoolZone({ poolKey, zone, title, hint, empty, ids, byId, strike, dragging, onAdd, onRemove, onRestore, onKeyMove }: { poolKey: CardPoolKey; zone: Zone; title: string; hint: string; empty: string; ids: number[]; byId: Map<number, Template>; strike: Set<number>; dragging: number | null; onAdd: () => void; onRemove: (id: number) => void; onRestore: (id: number) => void; onKeyMove: (id: number, key: string) => boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: ZONE_ID[zone] })
  const active = isOver || (dragging !== null && ids.includes(dragging))
  return (
    <div ref={setNodeRef} data-testid={`pool-${poolKey}-${zone}`} data-drop-active={active || undefined} className={cn('rounded-lg bg-tint/[0.02] p-2 ring-1 ring-tint/[0.08]', active && 'bg-primary/[0.03] ring-primary/40')}>
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[12px] font-medium">{title}</span>
        <span className="min-w-0 truncate text-[11px] text-muted-foreground">{hint}</span>
        <Button size="xs" variant="ghost" className="ml-auto shrink-0" onClick={onAdd} data-testid={`pool-${poolKey}-${zone}-add`}>
          <Plus /> 添加
        </Button>
      </div>
      <SortableContext items={ids.map(String)} strategy={noShift}>
        <div className="flex min-h-7 flex-wrap gap-1">
          {ids.map((id) => {
            const struck = zone === 'random' && strike.has(id)
            return <PoolChip key={id} id={id} name={byId.get(id)?.name || '（已删除）'} struck={struck} onRemove={() => onRemove(id)} onRestore={struck ? () => onRestore(id) : undefined} onKeyMove={(key) => onKeyMove(id, key)} />
          })}
          {!ids.length && <div className="flex h-7 w-full items-center justify-center rounded-lg border border-dashed border-tint/[0.14] text-[11px] text-muted-foreground">{empty}</div>}
        </div>
      </SortableContext>
    </div>
  )
}

/** 固定 / 随机两栏。拖动期间用本地状态显示，松手后通过 onChange 保存，保存完成后回到外部数据 */
function PoolEditor({ poolKey, value, byId, strike, onChange, onAdd, onRestore }: { poolKey: CardPoolKey; value: Lists; byId: Map<number, Template>; strike: Set<number>; onChange: (next: Lists) => unknown; onAdd: (zone: Zone) => void; onRestore: (id: number) => void }) {
  const [draft, setDraft] = useState<Lists | null>(null)
  const [dragging, setDragging] = useState<number | null>(null)
  const lists = draft ?? value
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  const zoneOf = (dndId: string | number, l: Lists): Zone | null => {
    const s = String(dndId)
    if (s === ZONE_ID.fixed) return 'fixed'
    if (s === ZONE_ID.random) return 'random'
    if (l.fixed.includes(Number(s))) return 'fixed'
    return l.random.includes(Number(s)) ? 'random' : null
  }
  const same = (a: Lists, b: Lists) => a.fixed.join() === b.fixed.join() && a.random.join() === b.random.join()
  // 拖动时立即把素材移到落点（跨栏是移动，不复制）。指针在目标标签的左半边时放在它前面，右半边时放在它后面：
  // 标签宽度不同也不会来回跳动（换位后指针仍在同一侧，或落在被拖动的标签自己上）
  const track = ({ active, over, activatorEvent, delta }: DragMoveEvent) => {
    if (!over || active.id === over.id) return
    const id = Number(active.id)
    const from = zoneOf(active.id, lists)
    const to = zoneOf(over.id, lists)
    if (!from || !to) return
    const others = lists[to].filter((x) => x !== id)
    const at = others.indexOf(Number(over.id))
    if (at < 0 && from === to) return
    const after = (activatorEvent as PointerEvent).clientX + delta.x > over.rect.left + over.rect.width / 2
    const next = movePoolItem(lists, id, to, at < 0 ? others.length : at + (after ? 1 : 0))
    if (!same(next, lists)) setDraft(next)
  }
  const commit = (next: Lists) => {
    if (same(next, value)) return setDraft(null)
    setDraft(next)
    void Promise.resolve(onChange(next)).finally(() => setDraft(null))
  }
  const onDragEnd = () => {
    setDragging(null)
    commit(lists)
  }
  // 键盘：左右键在栏内调整顺序，上键移到固定栏，下键移到随机栏（放在末尾）；修改立即保存，焦点留在这个素材上
  const onKeyMove = (id: number, key: string) => {
    const zone = zoneOf(id, lists)
    if (!zone) return false
    const at = lists[zone].indexOf(id)
    const moves: Record<string, Lists | undefined> = {
      ArrowLeft: at > 0 ? movePoolItem(lists, id, zone, at - 1) : undefined,
      ArrowRight: at < lists[zone].length - 1 ? movePoolItem(lists, id, zone, at + 1) : undefined,
      ArrowUp: zone === 'random' ? movePoolItem(lists, id, 'fixed', lists.fixed.length) : undefined,
      ArrowDown: zone === 'fixed' ? movePoolItem(lists, id, 'random', lists.random.length) : undefined,
    }
    if (!(key in moves)) return false
    const next = moves[key]
    if (next) {
      commit(next)
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-pool-grip="${id}"]`)?.focus())
    }
    return true
  }
  const remove = (id: number) => onChange({ fixed: lists.fixed.filter((x) => x !== id), random: lists.random.filter((x) => x !== id) })
  const draggingName = dragging === null ? '' : byId.get(dragging)?.name || '（已删除）'
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collision}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragStart={({ active }) => setDragging(Number(active.id))}
      onDragMove={track}
      onDragOver={track}
      onDragEnd={onDragEnd}
      onDragCancel={() => {
        setDragging(null)
        setDraft(null)
      }}
    >
      <div className="space-y-2">
        {ZONES.map((z) => (
          <PoolZone key={z.zone} poolKey={poolKey} {...z} ids={lists[z.zone]} byId={byId} strike={strike} dragging={dragging} onAdd={() => onAdd(z.zone)} onRemove={remove} onRestore={onRestore} onKeyMove={onKeyMove} />
        ))}
      </div>
      {createPortal(
        <DragOverlay dropAnimation={null}>
          {dragging !== null && (
            <div className={cn(CHIP, 'cursor-grabbing bg-popover shadow-lg shadow-tint/20 ring-primary/60')} data-testid="pool-drag-overlay">
              <GripVertical className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="max-w-64 min-w-0 truncate">{draggingName}</span>
              <X className="mx-0.5 size-3.5 shrink-0 text-muted-foreground" />
            </div>
          )}
        </DragOverlay>,
        document.body,
      )}
    </DndContext>
  )
}

/** 某个池可选择的全部素材 */
function sourceOf(lib: Library | null, card: Template, key: CardPoolKey): Template[] {
  const src = CARD_POOLS.find((p) => p.key === key)!.source
  if (src === 'variant') return templatesOf(lib, 'subposition').filter((t) => t.parent_id === card.id)
  return templatesOf(lib, src)
}

/**
 * 素材池列表。
 * - 素材库：编辑动作卡的素材池；
 * - 套图任务：pools 为任务中实际使用的配置，修改保存为任务覆盖，可逐池恢复默认；exclude 为旧任务中禁止抽取的素材（划线显示，可恢复）
 */
export function CardPools({
  card,
  pools: config,
  overridden,
  onPool,
  onReset,
  exclude,
  onExclude,
}: {
  card: Template
  /** 每个池当前生效的配置 */
  pools: Record<CardPoolKey, PoolConfig>
  /** 套图任务：哪些池覆盖了动作卡的配置 */
  overridden?: Set<CardPoolKey>
  onPool: (key: CardPoolKey, pool: PoolConfig) => unknown
  onReset?: (key: CardPoolKey) => void
  exclude?: number[]
  onExclude?: (ids: number[]) => void
}) {
  const lib = useLib((s) => s.lib)
  const [open, setOpen] = useState<CardPoolKey | null>(null)
  const [picker, setPicker] = useState<null | { key: CardPoolKey; zone: Zone }>(null)
  const byId = new Map((lib?.templates ?? []).map((t) => [t.id, t]))
  const variants = templatesOf(lib, 'subposition')
  const ex = new Set(exclude ?? [])
  const pools = poolsOf(!!card.card?.solo)
  const listsOf = (key: CardPoolKey): Lists => resolvePool(config[key], card, key, variants)
  const save = (key: CardPoolKey, next: Lists) => onPool(key, normalizePool(next, key))
  const cur = picker ? pools.find((p) => p.key === picker.key)! : null
  const curLists = picker ? listsOf(picker.key) : null
  return (
    <div className="space-y-1.5" data-testid="card-pools">
      {pools.map(({ key, label }) => {
        const lists = listsOf(key)
        const isOpen = open === key
        const fixedT = lists.fixed.map((id) => byId.get(id)).filter((t): t is Template => !!t)
        const conflicts = fixedConflicts(fixedT)
        const nRandom = lists.random.filter((id) => !ex.has(id)).length
        return (
          <div key={key} className={cn('rounded-xl bg-tint/[0.025] ring-1 ring-tint/[0.08]', isOpen && 'bg-tint/[0.04] ring-tint/[0.14]')} data-testid={`pool-${key}`}>
            <button type="button" className="flex h-10 w-full items-center gap-2 px-3 text-left" onClick={() => setOpen(isOpen ? null : key)}>
              {isOpen ? <ChevronDown className="size-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-4 shrink-0 text-muted-foreground" />}
              <span className="shrink-0 text-[13px] font-medium">{label}</span>
              <span className={cn('min-w-0 truncate text-xs text-muted-foreground', !lists.fixed.length && !nRandom && 'opacity-60')} data-testid={`pool-${key}-summary`}>
                {poolSummary(lists.fixed.length, nRandom)}
              </span>
              {overridden?.has(key) && <span className="ml-auto shrink-0 rounded-md bg-amber-500/12 px-1.5 py-0.5 text-[10.5px] text-amber-700">本任务已修改</span>}
              {conflicts.length > 0 && <span className={cn('shrink-0 text-[10.5px] text-warning', !overridden?.has(key) && 'ml-auto')}>互斥冲突</span>}
            </button>
            {isOpen && (
              <div className="space-y-2 px-3 pb-3">
                <div className="flex items-center gap-2">
                  <div className="min-w-0 flex-1 text-[11px] text-muted-foreground">{POOL_HINT[key]}</div>
                  {overridden?.has(key) && onReset && (
                    <Button size="xs" variant="ghost" className="shrink-0" onClick={() => onReset(key)}>
                      <RotateCcw /> 恢复此项默认
                    </Button>
                  )}
                </div>
                <PoolEditor
                  poolKey={key}
                  value={lists}
                  byId={byId}
                  strike={ex}
                  onChange={(next) => save(key, next)}
                  onAdd={(zone) => setPicker({ key, zone })}
                  onRestore={(id) => onExclude?.((exclude ?? []).filter((x) => x !== id))}
                />
                {conflicts.map((c) => (
                  <div key={c} className="text-[11px] text-warning">
                    {c}：同时固定的素材都会加入 Prompt，请确认是否需要调整（不会自动修改）。
                  </div>
                ))}
                {lists.random.some((id) => ex.has(id)) && <div className="text-[11px] text-muted-foreground">划线的素材在本任务中不会被抽取。</div>}
              </div>
            )}
          </div>
        )
      })}
      {cur && curLists && picker && (
        <MaterialPicker
          open
          onOpenChange={(o) => !o && setPicker(null)}
          title={`${cur.label} · ${picker.zone === 'fixed' ? '固定 Prompt' : '随机候选 Prompt'}`}
          description={picker.zone === 'fixed' ? '这里的素材全部加入每张图片（按点选顺序）。已在随机候选中的素材不会列出。' : '每张图片从这里随机抽取 1 个。只保存素材 ID，修改素材库中的 Prompt 后新任务自动使用新内容。已固定的素材不会列出。可搜索后批量添加。'}
          items={sourceOf(lib, card, picker.key).filter((t) => !curLists[picker.zone === 'fixed' ? 'random' : 'fixed'].includes(t.id))}
          value={curLists[picker.zone]}
          multi
          numbered={picker.zone === 'fixed'}
          bulk
          onChange={(ids) => void save(picker.key, { ...curLists, [picker.zone]: ids })}
          testId="material-picker"
        />
      )}
    </div>
  )
}

const POOL_LABEL = Object.fromEntries(CARD_POOLS.map((p) => [p.key, p.label])) as Record<CardPoolKey, string>

/** 一张图片实际使用的素材：按池列出，标明固定 / 随机（来自冻结的计划，与 Prompt 一致） */
export function PickSources({ picks, card, camera }: { picks?: CardPick[]; card?: string; camera?: string }) {
  if (!card) return null
  const by = new Map<CardPoolKey, CardPick[]>()
  for (const p of picks ?? []) by.set(p.pool, [...(by.get(p.pool) ?? []), p])
  return (
    <div className="space-y-1 rounded-xl bg-tint/[0.025] p-2.5 text-[12px] ring-1 ring-tint/[0.07]" data-testid="pick-sources">
      <div className="flex gap-2">
        <span className="w-28 shrink-0 text-muted-foreground">动作卡基础</span>
        <span>{card}</span>
      </div>
      {[...by].map(([pool, list]) => (
        <div key={pool} className="flex gap-2">
          <span className="w-28 shrink-0 text-muted-foreground">{POOL_LABEL[pool] ?? pool}</span>
          <span className="flex flex-wrap gap-1">
            {list.map((p) => (
              <span key={p.id} className={cn('rounded-md px-1.5 py-0.5', p.random ? 'bg-violet-500/10 text-violet-700' : 'bg-tint/[0.06]')} title={p.random ? '随机抽取' : '固定'}>
                {p.name || '（未命名）'}
                <span className="ml-1 text-[10px] opacity-70">{p.random ? '随机' : '固定'}</span>
              </span>
            ))}
          </span>
        </div>
      ))}
      {!by.size && <div className="text-muted-foreground">本张没有从素材池加入素材（只用基础 Prompt）</div>}
      {camera && (
        <div className="flex gap-2" data-testid="pick-camera-source">
          <span className="w-28 shrink-0 text-muted-foreground">镜头</span>
          <span>{camera}</span>
        </div>
      )}
    </div>
  )
}
