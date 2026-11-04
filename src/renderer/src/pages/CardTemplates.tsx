// 素材库「动作卡」：动作卡（正常位、骑乘位……）→ 姿态模板。
// 左侧动作卡列表；中间是这张卡的姿态模板列表（拖动排序；自动摘要：与其他模板不同的标签）；右侧直接编辑完整 Prompt（自动保存）。
// 主要操作是复制已有模板再改几个标签：Ctrl+D 复制当前模板并选中副本，Alt+↑/↓ 切换模板。
// 动作卡只负责姿态：表情、行为在动作序列中选择。

import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, Check, Copy, Pencil, Plus, Shapes, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { EmptyState, FieldLabel, PromptField, TextInput } from '@/components/common'
import { SortableArea, useSortableItem } from '@/components/sortable'
import { api, call } from '@/lib/api'
import { useDraft } from '@/lib/hooks'
import { confirm, reloadLib, templatesOf, useLib } from '@/lib/stores'
import { cn } from '@/lib/utils'
import { isSoloCard, normalizeCard } from '@shared/cards'
import { cardTemplates, distinctTags, isTemplateCard, moduleAnchor, skeletonOf, TEMPLATE_SLOTS, templatePlaceholders, templateTags } from '@shared/card-templates'
import type { ActionCard, Template } from '@shared/types'

export function CardTemplatePanel({ q }: { q: string }) {
  const lib = useLib((s) => s.lib)
  const cards = templatesOf(lib, 'position')
  const [cid, setCid] = useState<number | null>(null)
  const card = cards.find((c) => c.id === cid) ?? cards[0] ?? null
  const create = async (solo: boolean) => {
    const r = await call(api['templates.save']({ kind: 'position', name: solo ? '新单人动作卡' : '新双人动作卡', card: { templates: true, ...(solo ? { solo: true } : {}) } } as never))
    if (!r) return
    await reloadLib()
    setCid(r.id)
  }
  return (
    <div className="flex h-full min-h-0 gap-4" data-testid="card-templates">
      <section className="flex w-52 shrink-0 flex-col">
        <div className="mb-2 flex gap-1">
          <Button size="xs" variant="secondary" onClick={() => void create(false)} data-testid="new-duo-card">
            <Plus /> 双人动作卡
          </Button>
          <Button size="xs" variant="ghost" onClick={() => void create(true)} data-testid="new-solo-card">
            <Plus /> 单人
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
          {!cards.length && <div className="rounded-xl border border-dashed border-tint/[0.16] p-4 text-center text-xs text-muted-foreground">还没有动作卡</div>}
        </div>
      </section>
      <div className="min-w-0 flex-1">
        {card ? (
          isTemplateCard(card) ? (
            <CardBody key={card.id} card={card} q={q} onDeleted={() => setCid(null)} />
          ) : (
            <EmptyState icon={<Shapes />} title="旧版素材池动作卡" description="这张卡还没有转换为姿态模板。重新打开工作区时会自动转换（转换前备份到 data/backups）。如果转换失败，原因会显示在启动提示中。" />
          )
        ) : (
          <EmptyState icon={<Shapes />} title="还没有动作卡" description="动作卡代表一个动作（正常位、骑乘位……），里面放 5～10 个写好完整 Prompt 的姿态模板。生成时每张图从启用的模板中轮流抽取一个；表情和行为在动作序列中选择。" />
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

/** 一张动作卡：姿态模板列表、编辑区 */
function CardBody({ card, q, onDeleted }: { card: Template; q: string; onDeleted: () => void }) {
  const lib = useLib((s) => s.lib)
  const all = useMemo(() => cardTemplates(card, lib?.templates ?? []), [card, lib])
  const [cur, setCur] = useState<number | null>(null)
  const [sel, setSel] = useState<number[]>([])
  const [source, setSource] = useState<Record<number, number>>({})
  const [settings, setSettings] = useState(false)
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  const searching = words.length > 0
  const match = (t: Template) => !searching || words.every((w) => `${t.name}\n${t.tags}\n${t.positive}`.toLowerCase().includes(w))
  const visible = all.filter(match)
  const current = all.find((t) => t.id === cur) ?? visible[0] ?? null
  const cfg: ActionCard = normalizeCard(card.card)

  const saveCard = async (patch: Partial<ActionCard>) => {
    await call(api['templates.save']({ id: card.id, card: normalizeCard({ ...cfg, ...patch }) } as never))
    await reloadLib()
  }
  const create = async () => {
    const r = await call(api['templates.save']({ kind: 'card_tpl', parent_id: card.id, name: `${card.name || '姿态'} ${String(all.length + 1).padStart(2, '0')}`, positive: skeletonOf(card), category: '', sort: Math.max(0, ...all.map((t) => t.sort ?? 0)) + 1 } as never))
    if (!r) return
    await reloadLib()
    setCur(r.id)
  }
  /** 复制模板：副本紧跟在原模板之后，并记录来源（编辑时显示与原模板的差异） */
  const duplicate = async (list: Template[]) => {
    let last: number | null = null
    let order = all.map((x) => x.id)
    for (const t of list) {
      const r = await call(api['templates.duplicate'](t.id))
      if (!r?.id) continue
      last = r.id
      setSource((m) => ({ ...m, [r.id!]: t.id }))
      const at = order.indexOf(t.id)
      order = [...order.slice(0, at + 1), r.id, ...order.slice(at + 1)]
    }
    if (last) await call(api['templates.reorder'](order))
    await reloadLib()
    if (last) setCur(last)
  }
  const remove = async (ids: number[]) => {
    const used = await api.references('card_id', card.id)
    if (!(await confirm({ title: `删除 ${ids.length} 个姿态模板？`, description: `${used.length ? `使用这张动作卡的任务：${used.join('、')}。删除后这些模板不再参与生成。\n` : ''}文件会移入工作区的回收站（.comfyengi/trash），已生成的运行记录不受影响。`, confirmText: '删除', destructive: true }))) return
    for (const id of ids) await call(api['templates.remove'](id))
    setSel([])
    await reloadLib()
  }

  // 快捷键：Ctrl+D 复制当前模板；Alt+↑/↓ 在模板之间切换
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

  return (
    <div className="flex h-full min-h-0 gap-4">
      <section className="flex min-w-0 flex-1 flex-col" data-testid="card-template-list">
        <CardHeader card={card} n={all.length} open={settings} onOpen={() => setSettings(!settings)} onDeleted={onDeleted} saveCard={saveCard} />
        {settings ? (
          <CardSettings card={card} cfg={cfg} saveCard={saveCard} onClose={() => setSettings(false)} />
        ) : (
          <>
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              <Button size="xs" variant="secondary" onClick={() => void create()} data-testid="new-template">
                <Plus /> 新建姿态模板
              </Button>
              <Button size="xs" variant="ghost" disabled={!current && !selected.length} onClick={() => void duplicate(selected.length ? selected : [current!])} title="Ctrl+D" data-testid="duplicate-template">
                <Copy /> 复制{selected.length ? ` ${selected.length} 个` : ''}
              </Button>
              {selected.length > 0 && (
                <>
                  <Button size="xs" variant="ghost" className="hover:text-destructive" onClick={() => void remove(sel)}>
                    <Trash2 /> 删除 {selected.length} 个
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => setSel([])}>
                    取消多选
                  </Button>
                </>
              )}
              <span className="ml-auto text-[11px] text-muted-foreground">Ctrl / Shift 点击多选 · Ctrl+D 复制 · Alt+↑↓ 切换</span>
            </div>
            <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-0.5 pr-1">
              <SortableArea
                items={visible}
                getId={(t) => String(t.id)}
                disabled={searching}
                onReorder={async (_f, _t, next) => {
                  await call(api['templates.reorder'](next.map((t) => t.id)))
                  await reloadLib()
                }}
              >
                {visible.map((t) => (
                  <TemplateRow key={t.id} t={t} group={all} active={current?.id === t.id && !sel.length} checked={sel.includes(t.id)} onClick={(e) => pick(t, e)} />
                ))}
              </SortableArea>
              {!all.length && (
                <button type="button" onClick={() => void create()} className="w-full rounded-xl border border-dashed border-tint/[0.16] px-4 py-8 text-center text-xs text-muted-foreground hover:text-foreground">
                  新建第一个姿态模板，写好完整 Prompt。之后复制模板再改几个标签即可。
                </button>
              )}
              {all.length > 0 && searching && !visible.length && <div className="px-2 py-6 text-center text-xs text-muted-foreground">没有匹配的模板</div>}
              <div className="px-1 pt-1 text-[10.5px] leading-relaxed text-muted-foreground">
                {card.card?.solo ? '单人动作卡：生成时不加入第二角色。' : '双人动作卡：任务选择了第二角色时填入 {男特征} {男服装} {男表情}。'}生成时每张图从启用的姿态模板中轮流抽取一个；表情、行为在动作序列中选择。
              </div>
            </div>
          </>
        )}
      </section>

      <section className="w-[420px] shrink-0 overflow-y-auto p-0.5" data-testid="template-editor">
        {current ? <TemplateEditor key={current.id} t={current} from={all.find((x) => x.id === source[current.id])} /> : <div className="pt-10 text-center text-xs text-muted-foreground">选择一个姿态模板进行编辑</div>}
      </section>
    </div>
  )
}

function CardHeader({ card, n, open, onOpen, onDeleted, saveCard }: { card: Template; n: number; open: boolean; onOpen: () => void; onDeleted: () => void; saveCard: (p: Partial<ActionCard>) => Promise<void> }) {
  const solo = isSoloCard(card)
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2">
      <div className="min-w-0 truncate text-[15px] font-semibold" title={card.name}>
        {card.name || '（未命名）'}
      </div>
      <button type="button" className={cn('rounded-md px-1.5 py-0.5 text-[11px] hover:bg-tint/[0.06]', solo ? 'bg-emerald-500/10 text-emerald-700' : 'bg-sky-500/10 text-sky-700')} title="切换单人 / 双人" onClick={() => void saveCard({ solo: solo ? undefined : true })} data-testid="card-solo-toggle">
        {solo ? '单人' : '双人'}
      </button>
      <span className="text-[11px] text-muted-foreground">{n} 个姿态模板</span>
      <div className="ml-auto flex gap-1">
        <Button size="xs" variant={open ? 'secondary' : 'ghost'} onClick={onOpen} data-testid="card-settings">
          <Pencil /> 动作卡设置
        </Button>
        <Button
          size="xs"
          variant="ghost"
          onClick={async () => {
            if (await call(api['templates.duplicate'](card.id))) {
              await reloadLib()
              toast.success('已复制动作卡（含全部姿态模板）')
            }
          }}
        >
          <Copy /> 复制动作卡
        </Button>
        <Button
          size="xs"
          variant="ghost"
          className="hover:text-destructive"
          onClick={async () => {
            const used = [...new Set([...(await api.references('position_id', card.id)), ...(await api.references('card_id', card.id))])]
            const ok = await confirm({ title: `删除动作卡「${card.name}」及其 ${n} 个姿态模板？`, description: (used.length ? `以下套图任务正在使用它：${used.join('、')}\n删除后这些任务会提示引用失效。\n` : '') + '文件会移入工作区的回收站（.comfyengi/trash），已生成的运行记录不受影响。', confirmText: '删除', destructive: true })
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

/** 旧版表情设置的提示：新版本不再使用，可以一键清除（不会自动迁移到某个动作序列） */
function LegacyExpressions({ ids, what, onClear }: { ids: number[]; what: string; onClear: () => void }) {
  const lib = useLib((s) => s.lib)
  if (!ids.length) return null
  const names = ids.map((id) => lib?.templates.find((t) => t.id === id)?.name ?? '（已删除）')
  return (
    <div className="flex items-start gap-2 rounded-lg bg-warning/10 px-2.5 py-2 text-[11.5px] text-warning" data-testid="legacy-expressions">
      <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">
        {what}保存了旧版的表情设置（{names.join('、')}）。新版本不再按「模板 × 表情」组合，表情改在动作序列中选择，这些设置不会参与生成。
      </span>
      <button type="button" className="shrink-0 underline hover:text-foreground" onClick={onClear} data-testid="legacy-expressions-clear">
        清除
      </button>
    </div>
  )
}

/** 动作卡设置：名称、新模板的默认正文、动作的负面 Prompt、说明 */
function CardSettings({ card, cfg, saveCard, onClose }: { card: Template; cfg: ActionCard; saveCard: (p: Partial<ActionCard>) => Promise<void>; onClose: () => void }) {
  const { draft, patch } = useDraft<Template>(card, card.id, async (v) => {
    await call(api['templates.save']({ id: v.id, _revision: v._revision, name: v.name, negative: v.negative, note: v.note } as never))
    await reloadLib()
  })
  const [skeleton, setSkeleton] = useState(skeletonOf(card))
  if (!draft) return null
  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-0.5 pr-1" data-testid="card-settings-panel">
      <div className="flex items-center">
        <span className="text-[13px] font-medium">动作卡设置</span>
        <Button size="icon-sm" variant="ghost" className="ml-auto" aria-label="关闭" onClick={onClose}>
          <X />
        </Button>
      </div>
      <div>
        <FieldLabel>名称</FieldLabel>
        <TextInput value={draft.name} onChange={(v) => patch({ name: v })} />
      </div>
      <LegacyExpressions ids={cfg.expressions ?? []} what="这张动作卡" onClear={() => void saveCard({ expressions: undefined })} />
      <div>
        <FieldLabel hint="新建姿态模板时预填的正文。只是复制起点：修改后不影响已有模板">新模板的默认正文</FieldLabel>
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
      <PromptField label="负面 Prompt（这张动作卡的所有姿态模板共用）" value={draft.negative} onChange={(v) => patch({ negative: v })} minRows={2} />
      <PromptField label="说明" value={draft.note ?? ''} onChange={(v) => patch({ note: v })} minRows={3} placeholder="可选。旧版动作卡转换时，没有转换的随机候选会记录在这里" />
    </div>
  )
}

function TemplateRow({ t, group, active, checked, onClick }: { t: Template; group: Template[]; active: boolean; checked: boolean; onClick: (e: React.MouseEvent) => void }) {
  const s = useSortableItem(String(t.id))
  const diff = distinctTags(t, group, 4)
  const bad = templatePlaceholders(t.positive).unknown.length > 0
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

/** 姿态模板编辑：名称、完整 Prompt（自动保存）。点击占位符插入到光标位置 */
function TemplateEditor({ t, from }: { t: Template; from?: Template }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const { draft, patch, flush } = useDraft<Template>(t, t.id, async (v) => {
    await call(api['templates.save']({ id: v.id, _revision: v._revision, name: v.name, positive: v.positive, tags: v.tags ?? '', card: v.card ? normalizeCard(v.card) : null } as never))
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
  const clearExpressions = () => {
    const { expressions: _drop, ...rest } = normalizeCard(draft.card)
    void _drop
    patch({ card: Object.keys(rest).length ? rest : null })
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
  const changes = from ? diffTags(from.positive, draft.positive) : null
  const defaults = [
    !modules.has('expression') && `{表情}${moduleAnchor(draft.positive, 'expression') ? '写在 {女服装} 之后' : '追加在末尾'}`,
    !modules.has('interaction') && `{行为}${moduleAnchor(draft.positive, 'interaction') ? '写在 {男特征} 之前' : '追加在末尾'}`,
  ].filter(Boolean)
  return (
    <div className="space-y-3 rounded-xl bg-card p-3 ring-1 ring-tint/[0.08]" onBlur={flush}>
      <TextInput value={draft.name} onChange={(v) => patch({ name: v })} placeholder="姿态模板名称（例如：双腿抬起）" />
      <LegacyExpressions ids={draft.card?.expressions ?? []} what="这个姿态模板" onClear={clearExpressions} />
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
          {TEMPLATE_SLOTS.filter((s) => s.module !== 'style').map((s) => (
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
      {defaults.length > 0 && <div className="text-[11.5px] text-muted-foreground">没有写占位符时：{defaults.join('；')}（只在动作序列选择了表情 / 行为时写入）</div>}
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
