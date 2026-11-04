// 素材库「体位」：体位 → 子体位 → Prompt 模板。
// 左侧体位列表；中间按子体位分组的模板列表（可展开、收起、拖动排序；自动摘要：与同组模板不同的标签）；右侧直接编辑完整 Prompt 与表情（自动保存）。
// 主要操作是复制已有模板再改几个标签：Ctrl+D 复制当前模板并选中副本，Alt+↑/↓ 切换模板。

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { AlertCircle, Check, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Copy, FolderInput, Pencil, Plus, Shapes, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { EmptyState, FieldLabel, PromptField, TextInput } from '@/components/common'
import { SortableArea, useSortableItem } from '@/components/sortable'
import { api, call } from '@/lib/api'
import { useDraft } from '@/lib/hooks'
import { confirm, reloadLib, templatesOf, useLib } from '@/lib/stores'
import { cn } from '@/lib/utils'
import { isSoloCard, normalizeCard } from '@shared/cards'
import { CATEGORY_BARS, CATEGORY_COLORS, cardTemplates, categoryColor, expressionAnchor, categoryLabel, categoryOrder, distinctTags, isTemplateCard, skeletonOf, TEMPLATE_SLOTS, templateCombos, templateExpressionIds, templatePlaceholders, templateTags, UNCATEGORIZED } from '@shared/card-templates'
import type { ActionCard, Template } from '@shared/types'
import { MaterialPicker } from './plan/MaterialPicker'

const field = 'h-8 rounded-lg bg-tint/[0.045] px-2 text-[12.5px] ring-1 ring-tint/[0.112] outline-none focus:ring-primary/50'

export function CardTemplatePanel({ q }: { q: string }) {
  const lib = useLib((s) => s.lib)
  const cards = templatesOf(lib, 'position')
  const [cid, setCid] = useState<number | null>(null)
  const card = cards.find((c) => c.id === cid) ?? cards[0] ?? null
  const create = async (solo: boolean) => {
    const r = await call(api['templates.save']({ kind: 'position', name: solo ? '新单人体位' : '新双人体位', card: { templates: true, ...(solo ? { solo: true } : {}) } } as never))
    if (!r) return
    await reloadLib()
    setCid(r.id)
  }
  return (
    <div className="flex h-full min-h-0 gap-4" data-testid="card-templates">
      <section className="flex w-52 shrink-0 flex-col">
        <div className="mb-2 flex gap-1">
          <Button size="xs" variant="secondary" onClick={() => void create(false)} data-testid="new-duo-card">
            <Plus /> 双人体位
          </Button>
          <Button size="xs" variant="ghost" onClick={() => void create(true)} data-testid="new-solo-card">
            <Plus /> 单人体位
          </Button>
        </div>
        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-1">
          <SortableArea
            items={cards}
            getId={(t) => String(t.id)}
            onReorder={async (_f, _t, next) => {
              await call(api['templates.reorder'](next.map((t) => t.id)))
              await reloadLib()
            }}
          >
            {cards.map((c) => (
              <CardRow key={c.id} c={c} n={cardTemplates(c, lib?.templates ?? []).length} selected={card?.id === c.id} onClick={() => setCid(c.id)} />
            ))}
          </SortableArea>
          {!cards.length && <div className="rounded-xl border border-dashed border-tint/[0.16] p-4 text-center text-xs text-muted-foreground">还没有体位</div>}
        </div>
      </section>
      <div className="min-w-0 flex-1">
        {card ? (
          isTemplateCard(card) ? (
            <CardBody key={card.id} card={card} q={q} onDeleted={() => setCid(null)} />
          ) : (
            <EmptyState icon={<Shapes />} title="旧版素材池动作卡" description="这张卡还没有转换为模板体位。重新打开工作区时会自动转换（转换前备份到 data/backups）。如果转换失败，原因会显示在启动提示中。" />
          )
        ) : (
          <EmptyState icon={<Shapes />} title="还没有体位" description="体位代表一个大的动作类别（正常位、骑乘位……），下面按子体位管理完整的 Prompt 模板。生成时张数按子体位平分，子体位内的「模板 × 表情」组合轮流使用。" />
        )}
      </div>
    </div>
  )
}

function CardRow({ c, n, selected, onClick }: { c: Template; n: number; selected: boolean; onClick: () => void }) {
  const s = useSortableItem(String(c.id))
  return (
    <div ref={s.setNodeRef} style={s.style} {...s.attributes} {...s.listeners} onClick={onClick} data-testid="card-row" className={cn('flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] hover:bg-tint/[0.05]', selected && 'bg-tint/[0.08] font-medium', s.isDragging && 'shadow-xl shadow-tint/15')}>
      <span className="min-w-0 flex-1 truncate">{c.name || '（未命名）'}</span>
      <span className="text-[10.5px] text-muted-foreground">{isSoloCard(c) ? '单人' : '双人'}</span>
      <span className="w-6 text-right text-[11px] text-muted-foreground tabular-nums">{n}</span>
    </div>
  )
}

/** 一个体位：子体位分组的模板列表、编辑区 */
function CardBody({ card, q, onDeleted }: { card: Template; q: string; onDeleted: () => void }) {
  const lib = useLib((s) => s.lib)
  const all = useMemo(() => cardTemplates(card, lib?.templates ?? []), [card, lib])
  const exprs = templatesOf(lib, 'expression')
  const getExpr = (id: number) => exprs.find((e) => e.id === id)
  const order = categoryOrder(card.card, all)
  const named = order.filter((c) => c !== UNCATEGORIZED)
  const [cur, setCur] = useState<number | null>(null)
  const [sel, setSel] = useState<number[]>([])
  const [source, setSource] = useState<Record<number, number>>({})
  const [settings, setSettings] = useState(false)
  const [closed, setClosed] = useState<string[]>([])
  const [adding, setAdding] = useState<string | null>(null)
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  const searching = words.length > 0
  const match = (t: Template) => !searching || words.every((w) => `${t.name}\n${t.tags}\n${t.positive}`.toLowerCase().includes(w))
  const shown = all.filter(match)
  const isOpen = (c: string) => searching || !closed.includes(c)
  // 搜索时只显示有匹配的子体位；平时也显示还没有模板的子体位
  const groups = order.map((c) => ({ cat: c, list: shown.filter((t) => (t.category ?? '') === c) })).filter((g) => g.list.length || (!searching && g.cat !== UNCATEGORIZED))
  const visible = groups.flatMap((g) => (isOpen(g.cat) ? g.list : []))
  const current = all.find((t) => t.id === cur) ?? visible[0] ?? null
  const cfg: ActionCard = normalizeCard(card.card)

  const saveCard = async (patch: Partial<ActionCard>) => {
    await call(api['templates.save']({ id: card.id, card: normalizeCard({ ...cfg, ...patch }) } as never))
    await reloadLib()
  }
  const create = async (category: string) => {
    const same = all.filter((t) => (t.category ?? '') === category)
    const r = await call(api['templates.save']({ kind: 'card_tpl', parent_id: card.id, name: `${categoryLabel(category)} ${String(same.length + 1).padStart(2, '0')}`, positive: skeletonOf(card), category, sort: Math.max(0, ...same.map((t) => t.sort ?? 0)) + 1 } as never))
    if (!r) return
    setClosed((c) => c.filter((x) => x !== category))
    await reloadLib()
    setCur(r.id)
  }
  /** 复制模板：副本紧跟在原模板之后，并记录来源（编辑时显示与原模板的差异） */
  const duplicate = async (list: Template[]) => {
    let last: number | null = null
    for (const t of list) {
      const r = await call(api['templates.duplicate'](t.id))
      if (!r?.id) continue
      last = r.id
      setSource((m) => ({ ...m, [r.id!]: t.id }))
      const group = all.filter((x) => (x.category ?? '') === (t.category ?? '')).map((x) => x.id)
      const at = group.indexOf(t.id)
      await call(api['templates.reorder']([...group.slice(0, at + 1), r.id, ...group.slice(at + 1)]))
    }
    await reloadLib()
    if (last) setCur(last)
  }
  const move = async (ids: number[], to: string) => {
    for (const id of ids) await call(api['templates.save']({ id, category: to } as never))
    setClosed((c) => c.filter((x) => x !== to))
    await reloadLib()
    toast.success(`已移动 ${ids.length} 个模板到「${categoryLabel(to)}」`)
  }
  const remove = async (ids: number[]) => {
    const used = await api.references('card_id', card.id)
    if (!(await confirm({ title: `删除 ${ids.length} 个模板？`, description: `${used.length ? `使用这个体位的任务：${used.join('、')}。删除后这些模板不再参与生成。\n` : ''}文件会移入工作区的回收站（.comfyengi/trash），已生成的运行记录不受影响。`, confirmText: '删除', destructive: true }))) return
    for (const id of ids) await call(api['templates.remove'](id))
    setSel([])
    await reloadLib()
  }
  const addSub = async (name: string) => {
    const n = name.trim()
    setAdding(null)
    if (!n) return
    if (named.includes(n)) return void toast.error(`已经有子体位「${n}」`)
    await saveCard({ categories: [...named, n] })
  }
  const renameSub = async (from: string, to: string) => {
    const n = to.trim()
    if (!n || n === from) return
    if (named.includes(n)) return void toast.error(`已经有子体位「${n}」`)
    for (const t of all.filter((x) => x.category === from)) await call(api['templates.save']({ id: t.id, category: n } as never))
    setClosed((c) => c.map((x) => (x === from ? n : x)))
    await saveCard({ categories: named.map((c) => (c === from ? n : c)) })
  }
  const dropSub = async (c: string) => {
    const n = all.filter((t) => t.category === c).length
    if (n && !(await confirm({ title: `删除子体位「${c}」？`, description: `其中的 ${n} 个模板移到「未分类」，模板本身不会删除。`, confirmText: '删除子体位' }))) return
    for (const t of all.filter((x) => x.category === c)) await call(api['templates.save']({ id: t.id, category: '' } as never))
    await saveCard({ categories: named.filter((x) => x !== c) })
  }

  // 快捷键：Ctrl+D 复制当前模板；Alt+↑/↓ 在展开的模板之间切换
  const keys = useRef({ current, visible, duplicate })
  keys.current = { current, visible, duplicate }
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const { current: c, visible: list, duplicate: dup } = keys.current
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd' && c) {
        e.preventDefault()
        void dup([c])
      } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && list.length) {
        e.preventDefault()
        const i = c ? list.findIndex((t) => t.id === c.id) : -1
        const next = list[Math.max(0, Math.min(list.length - 1, i + (e.key === 'ArrowUp' ? -1 : 1)))]
        if (next) setCur(next.id)
      }
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [])

  const pick = (t: Template, e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey) setSel((s) => (s.includes(t.id) ? s.filter((x) => x !== t.id) : [...s, t.id]))
    else if (e.shiftKey && current) {
      const a = visible.findIndex((x) => x.id === current.id)
      const b = visible.findIndex((x) => x.id === t.id)
      setSel(visible.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.id))
    } else {
      setSel([])
      setCur(t.id)
    }
  }
  const selected = sel.length ? all.filter((t) => sel.includes(t.id)) : []
  const toggle = (c: string) => setClosed((x) => (x.includes(c) ? x.filter((y) => y !== c) : [...x, c]))
  const section = (g: { cat: string; list: Template[] }, drag?: Drag) => (
    <SubSection
      key={g.cat}
      cat={g.cat}
      n={all.filter((t) => (t.category ?? '') === g.cat).length}
      combos={templateCombos(all.filter((t) => (t.category ?? '') === g.cat), card, getExpr).combos.length}
      color={categoryColor(order, g.cat)}
      open={isOpen(g.cat)}
      onToggle={() => toggle(g.cat)}
      onAdd={() => void create(g.cat)}
      onRename={(to) => void renameSub(g.cat, to)}
      onDelete={() => void dropSub(g.cat)}
      drag={drag}
    >
      <SortableArea
        items={g.list}
        getId={(t) => String(t.id)}
        disabled={searching}
        onReorder={async (_f, _t, next) => {
          await call(api['templates.reorder'](next.map((t) => t.id)))
          await reloadLib()
        }}
      >
        {g.list.map((t) => (
          <TemplateRow key={t.id} t={t} group={g.list.length > 1 ? g.list : all} active={current?.id === t.id && !sel.length} checked={sel.includes(t.id)} onClick={(e) => pick(t, e)} />
        ))}
      </SortableArea>
      {!g.list.length && (
        <button type="button" onClick={() => void create(g.cat)} className="w-full rounded-lg border border-dashed border-tint/[0.14] px-3 py-2.5 text-center text-[11.5px] text-muted-foreground hover:text-foreground">
          这个子体位还没有模板，点击新建
        </button>
      )}
    </SubSection>
  )
  const sortable = groups.filter((g) => g.cat !== UNCATEGORIZED)
  const loose = groups.find((g) => g.cat === UNCATEGORIZED)

  return (
    <div className="flex h-full min-h-0 gap-4">
      <section className="flex min-w-0 flex-1 flex-col" data-testid="card-template-list">
        <CardHeader card={card} n={all.length} subs={named.length} open={settings} onOpen={() => setSettings(!settings)} onDeleted={onDeleted} saveCard={saveCard} />
        {settings ? (
          <CardSettings card={card} cfg={cfg} saveCard={saveCard} onClose={() => setSettings(false)} />
        ) : (
          <>
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              <Button size="xs" variant="secondary" onClick={() => void create(current?.category ?? named[0] ?? UNCATEGORIZED)} data-testid="new-template">
                <Plus /> 新建模板
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setAdding('')} data-testid="add-category">
                <Plus /> 新建子体位
              </Button>
              <Button size="xs" variant="ghost" disabled={!current && !selected.length} onClick={() => void duplicate(selected.length ? selected : [current!])} title="Ctrl+D" data-testid="duplicate-template">
                <Copy /> 复制{selected.length ? ` ${selected.length} 个` : ''}
              </Button>
              {selected.length > 0 && (
                <>
                  <MoveTo order={order} onMove={(to) => void move(sel, to)} />
                  <Button size="xs" variant="ghost" className="hover:text-destructive" onClick={() => void remove(sel)}>
                    <Trash2 /> 删除 {selected.length} 个
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => setSel([])}>
                    取消多选
                  </Button>
                </>
              )}
              <span className="ml-auto text-[11px] text-muted-foreground">Ctrl / Shift 点击多选 · Ctrl+D 复制 · Alt+↑↓ 切换</span>
              {order.length > 1 && (
                <Button size="icon-sm" variant="ghost" aria-label={closed.length ? '全部展开' : '全部收起'} title={closed.length ? '全部展开' : '全部收起'} onClick={() => setClosed(closed.length ? [] : order)} data-testid="toggle-all-subs">
                  {closed.length ? <ChevronsUpDown /> : <ChevronsDownUp />}
                </Button>
              )}
            </div>
            {adding !== null && (
              <input autoFocus value={adding} placeholder="子体位名称（例如：抬脚、贴近），回车确认" onChange={(e) => setAdding(e.target.value)} onBlur={() => void addSub(adding)} onKeyDown={(e) => (e.key === 'Enter' ? (e.target as HTMLInputElement).blur() : e.key === 'Escape' && setAdding(null))} className={cn(field, 'mb-2 w-full')} data-testid="category-name" />
            )}
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
              <SortableArea items={sortable} getId={(g) => `c:${g.cat}`} disabled={searching} onReorder={(_f, _t, next) => void saveCard({ categories: next.map((g) => g.cat) })}>
                {sortable.map((g) => (
                  <SortableSection key={g.cat} id={`c:${g.cat}`}>
                    {(drag) => section(g, drag)}
                  </SortableSection>
                ))}
              </SortableArea>
              {loose && section(loose)}
              {!all.length && !named.length && <div className="rounded-xl border border-dashed border-tint/[0.16] px-4 py-8 text-center text-xs text-muted-foreground">先新建子体位（例如：抬脚、贴近），再在子体位下新建模板，写好完整 Prompt。之后复制模板再改几个标签即可。</div>}
              {all.length > 0 && searching && !shown.length && <div className="px-2 py-6 text-center text-xs text-muted-foreground">没有匹配的模板</div>}
              <div className="px-1 pt-1 text-[10.5px] leading-relaxed text-muted-foreground">{card.card?.solo ? '单人体位：生成时不加入第二角色。' : '双人体位：任务选择了第二角色时填入 {男特征} {男服装}。'}生成时张数按选中的子体位平分，子体位内的「模板 × 表情」组合轮流使用。</div>
            </div>
          </>
        )}
      </section>

      <section className="w-[420px] shrink-0 overflow-y-auto" data-testid="template-editor">
        {current ? <TemplateEditor key={current.id} t={current} card={card} order={order} from={all.find((x) => x.id === source[current.id])} /> : <div className="pt-10 text-center text-xs text-muted-foreground">选择一个模板进行编辑</div>}
      </section>
    </div>
  )
}

type Drag = { ref: (el: HTMLElement | null) => void; style: CSSProperties; handle: Record<string, unknown>; dragging: boolean }

function SortableSection({ id, children }: { id: string; children: (drag: Drag) => ReactNode }) {
  const s = useSortableItem(id)
  return <>{children({ ref: s.setNodeRef, style: s.style, handle: { ...s.attributes, ...s.listeners }, dragging: s.isDragging })}</>
}

/** 一个子体位：标题行点击展开 / 收起，拖动标题行调整子体位顺序 */
function SubSection({ cat, n, combos, color, open, onToggle, onAdd, onRename, onDelete, drag, children }: { cat: string; n: number; combos: number; color: number; open: boolean; onToggle: () => void; onAdd: () => void; onRename: (to: string) => void; onDelete: () => void; drag?: Drag; children: ReactNode }) {
  const [editing, setEditing] = useState<string | null>(null)
  const named = cat !== UNCATEGORIZED
  return (
    <div ref={drag?.ref} style={drag?.style} data-testid="template-group" data-category={cat} data-open={open || undefined} className={cn('rounded-xl bg-card ring-1 ring-tint/[0.07]', drag?.dragging && 'shadow-xl shadow-tint/15')}>
      <div className="group flex cursor-pointer items-center gap-2 rounded-xl px-2 py-1.5 select-none hover:bg-tint/[0.03]" onClick={onToggle} data-testid="category-row" data-category={cat} {...(drag?.handle ?? {})}>
        {open ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
        <span className={cn('h-3.5 w-1 shrink-0 rounded-full', color >= 0 ? CATEGORY_BARS[color] : 'bg-tint/[0.2]')} />
        {editing !== null ? (
          <input
            autoFocus
            value={editing}
            onChange={(e) => setEditing(e.target.value)}
            onBlur={() => (onRename(editing), setEditing(null))}
            onKeyDown={(e) => (e.key === 'Enter' ? (e.target as HTMLInputElement).blur() : e.key === 'Escape' && setEditing(null))}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            className={cn(field, 'h-7 min-w-0 flex-1')}
          />
        ) : (
          <span className="min-w-0 truncate text-[13px] font-medium">{categoryLabel(cat)}</span>
        )}
        <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums" data-testid="category-count">
          {n} 个模板{combos !== n ? ` · ${combos} 种组合` : ''}
        </span>
        <span className="ml-auto flex shrink-0 gap-0.5 opacity-0 group-hover:opacity-100" onPointerDown={(e) => e.stopPropagation()}>
          <button type="button" aria-label="在此子体位新建模板" title="新建模板" className="grid size-6 place-items-center rounded text-muted-foreground hover:text-foreground" onClick={(e) => (e.stopPropagation(), onAdd())}>
            <Plus className="size-3.5" />
          </button>
          {named && (
            <>
              <button type="button" aria-label="重命名" title="重命名" className="grid size-6 place-items-center rounded text-muted-foreground hover:text-foreground" onClick={(e) => (e.stopPropagation(), setEditing(cat))}>
                <Pencil className="size-3" />
              </button>
              <button type="button" aria-label="删除子体位" title="删除子体位（模板移到未分类）" className="grid size-6 place-items-center rounded text-muted-foreground hover:text-destructive" onClick={(e) => (e.stopPropagation(), onDelete())}>
                <X className="size-3.5" />
              </button>
            </>
          )}
        </span>
      </div>
      {open && <div className="space-y-0.5 px-1.5 pb-1.5">{children}</div>}
    </div>
  )
}

function CardHeader({ card, n, subs, open, onOpen, onDeleted, saveCard }: { card: Template; n: number; subs: number; open: boolean; onOpen: () => void; onDeleted: () => void; saveCard: (p: Partial<ActionCard>) => Promise<void> }) {
  const solo = isSoloCard(card)
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2">
      <div className="min-w-0 truncate text-[15px] font-semibold" title={card.name}>
        {card.name || '（未命名）'}
      </div>
      <button type="button" className={cn('rounded-md px-1.5 py-0.5 text-[11px] hover:bg-tint/[0.06]', solo ? 'bg-emerald-500/10 text-emerald-700' : 'bg-sky-500/10 text-sky-700')} title="切换单人 / 双人" onClick={() => void saveCard({ solo: solo ? undefined : true })} data-testid="card-solo-toggle">
        {solo ? '单人' : '双人'}
      </button>
      <span className="text-[11px] text-muted-foreground">
        {subs} 个子体位 · {n} 个模板
      </span>
      <div className="ml-auto flex gap-1">
        <Button size="xs" variant={open ? 'secondary' : 'ghost'} onClick={onOpen} data-testid="card-settings">
          <Pencil /> 体位设置
        </Button>
        <Button
          size="xs"
          variant="ghost"
          onClick={async () => {
            if (await call(api['templates.duplicate'](card.id))) {
              await reloadLib()
              toast.success('已复制体位（含全部模板）')
            }
          }}
        >
          <Copy /> 复制体位
        </Button>
        <Button
          size="xs"
          variant="ghost"
          className="hover:text-destructive"
          onClick={async () => {
            const used = [...new Set([...(await api.references('position_id', card.id)), ...(await api.references('card_id', card.id))])]
            const ok = await confirm({ title: `删除体位「${card.name}」及其 ${n} 个模板？`, description: (used.length ? `以下套图任务正在使用它：${used.join('、')}\n删除后这些任务会提示引用失效。\n` : '') + '文件会移入工作区的回收站（.comfyengi/trash），已生成的运行记录不受影响。', confirmText: '删除', destructive: true })
            if (!ok) return
            await call(api['templates.remove'](card.id))
            await reloadLib()
            onDeleted()
          }}
        >
          <Trash2 /> 删除
        </Button>
      </div>
    </div>
  )
}

/** 体位设置：名称、默认表情、新模板的默认正文、动作的负面 Prompt、说明 */
function CardSettings({ card, cfg, saveCard, onClose }: { card: Template; cfg: ActionCard; saveCard: (p: Partial<ActionCard>) => Promise<void>; onClose: () => void }) {
  const lib = useLib((s) => s.lib)
  const { draft, patch } = useDraft<Template>(card, card.id, async (v) => {
    await call(api['templates.save']({ id: v.id, _revision: v._revision, name: v.name, negative: v.negative, note: v.note } as never))
    await reloadLib()
  })
  const [skeleton, setSkeleton] = useState(skeletonOf(card))
  if (!draft) return null
  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1" data-testid="card-settings-panel">
      <div className="flex items-center">
        <span className="text-[13px] font-medium">体位设置</span>
        <Button size="icon-sm" variant="ghost" className="ml-auto" aria-label="关闭" onClick={onClose}>
          <X />
        </Button>
      </div>
      <div>
        <FieldLabel>名称</FieldLabel>
        <TextInput value={draft.name} onChange={(v) => patch({ name: v })} />
      </div>
      <ExpressionField title="默认表情" hint="没有单独选择表情的模板使用这里的表情：每个表情与模板组成一种组合" value={cfg.expressions ?? []} exprs={templatesOf(lib, 'expression')} onChange={(ids) => void saveCard({ expressions: ids.length ? ids : undefined })} testId="card-expressions" />
      <div>
        <FieldLabel hint="新建模板时预填的正文。只是复制起点：修改后不影响已有模板">新模板的默认正文</FieldLabel>
        <PromptField value={skeleton} onChange={setSkeleton} minRows={6} />
        <div className="mt-1 flex gap-1">
          <Button size="xs" variant="secondary" disabled={skeleton === skeletonOf(card)} onClick={() => void saveCard({ skeleton })}>
            保存默认正文
          </Button>
          {cfg.skeleton !== undefined && (
            <Button size="xs" variant="ghost" onClick={() => void saveCard({ skeleton: undefined }).then(() => setSkeleton(skeletonOf({ card: { ...cfg, skeleton: undefined } })))}>
              恢复内置默认
            </Button>
          )}
        </div>
      </div>
      <PromptField label="负面 Prompt（这个体位的所有模板共用）" value={draft.negative} onChange={(v) => patch({ negative: v })} minRows={2} />
      <PromptField label="说明" value={draft.note ?? ''} onChange={(v) => patch({ note: v })} minRows={3} placeholder="可选。旧版动作卡转换时，没有转换的随机候选会记录在这里" />
    </div>
  )
}

function MoveTo({ order, onMove }: { order: string[]; onMove: (to: string) => void }) {
  const opts = [...order.filter((c) => c !== UNCATEGORIZED), UNCATEGORIZED]
  return (
    <label className="inline-flex items-center gap-1 text-[12px] text-muted-foreground">
      <FolderInput className="size-3.5" />
      <select value="" onChange={(e) => e.target.value !== '' && onMove(e.target.value === '\u0002' ? '' : e.target.value)} className={cn(field, 'h-7')}>
        <option value="">移动到子体位…</option>
        {opts.map((c) => (
          <option key={c || '\u0002'} value={c || '\u0002'}>
            {categoryLabel(c)}
          </option>
        ))}
      </select>
    </label>
  )
}

function TemplateRow({ t, group, active, checked, onClick }: { t: Template; group: Template[]; active: boolean; checked: boolean; onClick: (e: React.MouseEvent) => void }) {
  const s = useSortableItem(String(t.id))
  const diff = distinctTags(t, group, 4)
  const bad = templatePlaceholders(t.positive).unknown.length > 0
  const own = t.card?.expressions?.length ?? 0
  return (
    <div
      ref={s.setNodeRef}
      style={s.style}
      {...s.attributes}
      {...s.listeners}
      onClick={onClick}
      data-testid="template-row"
      data-id={t.id}
      className={cn('flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 ring-1 ring-transparent hover:bg-tint/[0.05]', active && 'bg-accent/80 ring-primary/50', checked && 'bg-primary/10 ring-primary/40', s.isDragging && 'shadow-xl shadow-tint/15')}
    >
      {checked && <Check className="size-3.5 shrink-0 text-primary" />}
      <span className="w-56 max-w-[45%] shrink-0 truncate text-[12.5px] font-medium" title={t.name}>
        {t.name || '（未命名）'}
      </span>
      {own > 0 && (
        <span className="shrink-0 rounded-md bg-violet-500/10 px-1.5 py-0.5 text-[11px] text-violet-700" data-testid="template-expr-count">
          表情 ×{own}
        </span>
      )}
      {t.tags && (
        <span className="shrink-0 rounded-md bg-tint/[0.06] px-1.5 py-0.5 text-[11px] text-muted-foreground" data-testid="template-label">
          {t.tags}
        </span>
      )}
      <span className="flex min-w-0 flex-1 gap-1 overflow-hidden">
        {diff.map((d) => (
          <span key={d} className="shrink-0 truncate rounded bg-tint/[0.05] px-1 py-0.5 font-mono text-[10.5px] text-muted-foreground">
            {d}
          </span>
        ))}
      </span>
      {bad && <AlertCircle className="size-3.5 shrink-0 text-destructive" aria-label="有无法识别的占位符" />}
    </div>
  )
}

/**
 * 表情选择：显示已选表情（可逐个移除），点 + 从素材库的表情中多选（按点选顺序）。
 * inherit：模板没有单独选择时显示体位的默认表情（灰色，只读），可以改为单独选择
 */
function ExpressionField({ title, hint, value, inherit, exprs, onChange, testId }: { title: string; hint?: string; value: number[]; inherit?: number[]; exprs: Template[]; onChange: (ids: number[]) => void; testId: string }) {
  const [open, setOpen] = useState(false)
  const byId = new Map(exprs.map((e) => [e.id, e]))
  const inheriting = !!inherit && !value.length
  const ids = inheriting ? inherit : value
  return (
    <div data-testid={testId}>
      <FieldLabel hint={hint}>{title}</FieldLabel>
      <div className="flex min-h-9 flex-wrap items-center gap-1 rounded-lg bg-tint/[0.035] px-1.5 py-1 ring-1 ring-tint/[0.1]">
        {inheriting && <span className="px-1 text-[11.5px] text-muted-foreground">{inherit.length ? '使用体位默认：' : '不加表情'}</span>}
        {ids.map((id) => {
          const e = byId.get(id)
          const name = e?.name || '（已删除）'
          return (
            <span key={id} title={e?.positive} className={cn('inline-flex h-6 max-w-full items-center gap-0.5 rounded-md pl-1.5 text-[12px]', inheriting ? 'bg-tint/[0.05] pr-1.5 text-muted-foreground' : 'bg-violet-500/10 text-violet-700', !e && 'text-destructive')} data-testid="expression-tag">
              <span className="min-w-0 truncate">{name}</span>
              {!inheriting && (
                <button type="button" aria-label={`移除表情 ${name}`} className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:text-foreground" onClick={() => onChange(value.filter((x) => x !== id))}>
                  <X className="size-3" />
                </button>
              )}
            </span>
          )
        })}
        <button type="button" onClick={() => setOpen(true)} aria-label="选择表情" data-testid="pick-expression" className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[12px] text-muted-foreground hover:bg-tint/[0.06] hover:text-foreground">
          <Plus className="size-3.5" />
          {inheriting ? '单独选择' : ids.length ? '' : '选择表情'}
        </button>
        {!inheriting && value.length > 0 && (
          <button type="button" onClick={() => onChange([])} className="ml-auto h-6 shrink-0 rounded-md px-1.5 text-[11.5px] text-muted-foreground hover:bg-tint/[0.06] hover:text-foreground" data-testid="expression-clear">
            {inherit ? '改用体位默认' : '清空'}
          </button>
        )}
      </div>
      <MaterialPicker
        open={open}
        onOpenChange={setOpen}
        title="表情"
        description="可多选：模板与每个表情各组成一种组合，生成时轮流使用。表情在「素材库 → 表情」中管理，可以在不同体位之间复用。"
        items={exprs}
        value={ids}
        multi
        numbered
        bulk
        onChange={onChange}
        empty="表情库为空，可在「素材库 → 表情」中添加"
        testId="material-picker"
      />
    </div>
  )
}

/** 模板编辑：名称、子体位、表情、完整 Prompt（自动保存）。点击占位符插入到光标位置 */
function TemplateEditor({ t, card, order, from }: { t: Template; card: Template; order: string[]; from?: Template }) {
  const lib = useLib((s) => s.lib)
  const exprs = templatesOf(lib, 'expression')
  const ref = useRef<HTMLTextAreaElement>(null)
  const { draft, patch, flush } = useDraft<Template>(t, t.id, async (v) => {
    await call(api['templates.save']({ id: v.id, _revision: v._revision, name: v.name, positive: v.positive, category: v.category ?? '', tags: v.tags ?? '', card: v.card ? normalizeCard(v.card) : null } as never))
    await reloadLib()
  })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight + 2, 560)}px`
  }, [draft?.positive])
  if (!draft) return null
  const { modules, unknown } = templatePlaceholders(draft.positive)
  const missing = ['character', 'outfit'].filter((m) => !modules.has(m)).map((m) => TEMPLATE_SLOTS.find((s) => s.module === m)!)
  const own = draft.card?.expressions ?? []
  const used = templateExpressionIds(draft, card)
  const combos = templateCombos([draft], card, (id) => exprs.find((e) => e.id === id)).combos
  const setExpressions = (ids: number[]) => {
    const { expressions: _drop, ...rest } = normalizeCard(draft.card)
    patch({ card: ids.length ? { ...rest, expressions: ids } : Object.keys(rest).length ? rest : null })
  }
  const insert = (name: string) => {
    const el = ref.current
    const text = `{${name}}`
    const at = el ? el.selectionStart : draft.positive.length
    const end = el ? el.selectionEnd : at
    patch({ positive: draft.positive.slice(0, at) + text + draft.positive.slice(end) })
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(at + text.length, at + text.length)
    })
  }
  const color = categoryColor(order, draft.category ?? '')
  const changes = from ? diffTags(from.positive, draft.positive) : null
  return (
    <div className="space-y-3 rounded-xl bg-card p-3 ring-1 ring-tint/[0.08]" onBlur={flush}>
      <div className="grid grid-cols-[1fr_auto] gap-2">
        <TextInput value={draft.name} onChange={(v) => patch({ name: v })} placeholder="模板名称" />
        <select value={draft.category ?? ''} onChange={(e) => patch({ category: e.target.value })} title="子体位" className={cn(field, 'h-9', color >= 0 && CATEGORY_COLORS[color])} data-testid="template-category">
          {[...order.filter((c) => c !== UNCATEGORIZED), UNCATEGORIZED].map((c) => (
            <option key={c} value={c}>
              {categoryLabel(c)}
            </option>
          ))}
        </select>
      </div>
      <ExpressionField title="表情" hint="写入模板中 {表情} 的位置。可以只用体位的默认表情，也可以为这个模板单独选择" value={own} inherit={card.card?.expressions ?? []} exprs={exprs} onChange={setExpressions} testId="template-expressions" />
      <div className="text-[11.5px] text-muted-foreground" data-testid="template-combos">
        这个模板生成 {combos.length} 种：{combos.map((c) => c.expression?.name ?? '无表情').join(' / ')}
      </div>
      {draft.tags && (
        <div className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
          旧版表情标签「{draft.tags}」只用于显示，不写入 Prompt
          <button type="button" className="underline hover:text-foreground" onClick={() => patch({ tags: '' })}>
            清除
          </button>
        </div>
      )}
      <div>
        <FieldLabel>完整 Prompt</FieldLabel>
        <textarea
          ref={ref}
          value={draft.positive}
          rows={10}
          spellCheck={false}
          onChange={(e) => patch({ positive: e.target.value })}
          className="block w-full resize-none rounded-lg bg-tint/[0.035] px-3 py-2.5 font-mono text-[12.5px] leading-relaxed ring-1 ring-tint/[0.112] outline-none focus:bg-tint/[0.05] focus:ring-primary/50"
          data-testid="template-positive"
        />
        <div className="mt-1.5 flex flex-wrap gap-1">
          {TEMPLATE_SLOTS.map((s) => (
            <button key={s.module} type="button" title={`${s.label}，点击插入到光标处`} onMouseDown={(e) => e.preventDefault()} onClick={() => insert(s.names[0])} className={cn('rounded-md px-1.5 py-0.5 font-mono text-[11px] ring-1', modules.has(s.module) ? 'bg-primary/10 text-primary ring-primary/25' : 'text-muted-foreground ring-tint/[0.12] hover:text-foreground')}>
              {`{${s.names[0]}}`}
            </button>
          ))}
        </div>
      </div>
      {unknown.length > 0 && (
        <div className="text-[11.5px] text-destructive">
          无法识别的占位符：{unknown.join(' ')}。可用：{TEMPLATE_SLOTS.map((s) => `{${s.names[0]}}`).join(' ')}
        </div>
      )}
      {missing.length > 0 && (
        <div className="text-[11.5px] text-warning">
          没有 {missing.map((s) => `{${s.names[0]}}`).join('、')}：{missing.map((s) => s.label).join('、')}不会写入这个模板生成的图片
        </div>
      )}
      {used.length > 0 && !modules.has('expression') && <div className="text-[11.5px] text-muted-foreground">没有写 {'{表情}'}：表情{expressionAnchor(draft.positive) ? '写在主角色服装之后' : '追加在 Prompt 末尾'}</div>}
      {changes && (changes.added.length > 0 || changes.removed.length > 0) && (
        <div className="space-y-1 text-[11.5px]" data-testid="template-diff">
          <div className="text-muted-foreground">与复制来源「{from!.name}」相比</div>
          <div className="flex flex-wrap gap-1">
            {changes.added.map((x) => (
              <span key={`+${x}`} className="rounded bg-success/10 px-1 font-mono text-success">
                + {x}
              </span>
            ))}
            {changes.removed.map((x) => (
              <span key={`-${x}`} className="rounded bg-destructive/10 px-1 font-mono text-destructive line-through">
                {x}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function diffTags(a: string, b: string) {
  const ta = templateTags(a)
  const tb = templateTags(b)
  return { added: tb.filter((x) => !ta.includes(x)), removed: ta.filter((x) => !tb.includes(x)) }
}
