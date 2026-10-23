// 素材库：姿态、表情、镜头、男性、全局 Prompt。卡片浏览 + 右侧编辑，修改自动保存。

import { useMemo, useState } from 'react'
import { Copy, Plus, Shapes, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Chip, EmptyState, FieldLabel, PageHeader, PromptField, SearchBox, TextInput } from '@/components/common'
import { SortableArea, useSortableItem } from '@/components/sortable'
import { api, call } from '@/lib/api'
import { matches, useDraft } from '@/lib/hooks'
import { confirm, reloadLib, templatesOf, useLib } from '@/lib/stores'
import { cn } from '@/lib/utils'
import { PLACEHOLDER_HELP } from '@shared/prompt'
import { TEMPLATE_KINDS, type Template, type TemplateKind } from '@shared/types'

const KINDS: TemplateKind[] = ['pose', 'expression', 'camera', 'male', 'global']
const HINTS: Record<TemplateKind, string> = {
  pose: '广义的画面内容：单人姿态或双人互动动作，全角色通用。',
  expression: '表情 Prompt。一个姿态可多选表情，每个表情平均分配张数、分别生成。',
  camera: '镜头 / 视角 / 构图。POV 只是镜头属性，不会自动启用男性出场。',
  male: '分类为「基础」的模板可作为任务的男性基础 Prompt；其他（动作 / 表情 / 服装）在姿态中按需勾选。',
  global: '画质词、通用正负面。每个套图任务选择其中一个。',
}
const REF_FIELDS: Record<TemplateKind, string[]> = {
  global: ['global_id'],
  pose: ['pose_id'],
  expression: ['expression_ids'],
  male: ['male_base_id', 'male_ids'],
  camera: ['camera_id'],
}
const CATEGORY_SUGGEST: Partial<Record<TemplateKind, string[]>> = { male: ['基础', '动作', '表情', '服装'] }

function TemplateCard({ t, selected, onClick, sortable }: { t: Template; selected: boolean; onClick: () => void; sortable: boolean }) {
  const s = useSortableItem(String(t.id))
  return (
    <div
      ref={s.setNodeRef}
      style={s.style}
      {...(sortable ? { ...s.attributes, ...s.listeners } : {})}
      onClick={onClick}
      className={cn(
        'flex h-[104px] cursor-pointer flex-col rounded-xl bg-card p-3 ring-1 ring-white/[0.05] transition hover:bg-accent/70',
        selected && 'bg-accent/80 ring-primary/60',
        s.isDragging && 'shadow-2xl shadow-black/50',
      )}
    >
      <div className="flex items-center gap-2">
        <span className="truncate text-[13px] font-medium">{t.name || '（未命名）'}</span>
        {t.category && <span className="ml-auto shrink-0 rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-muted-foreground">{t.category}</span>}
      </div>
      <div className="mt-1.5 line-clamp-3 font-mono text-[11px] leading-snug text-muted-foreground">{t.positive || <span className="italic opacity-60">（空）</span>}</div>
    </div>
  )
}

export function TemplateEditor({ t, kind, onClose, onDeleted }: { t: Template; kind: TemplateKind; onClose: () => void; onDeleted: () => void }) {
  const lib = useLib((s) => s.lib)
  const { draft, patch, flush } = useDraft<Template>(t, t.id, async (v) => {
    await call(api['templates.save']({ id: v.id, _revision: v._revision, name: v.name, category: v.category, tags: v.tags, positive: v.positive, negative: v.negative, note: v.note }))
    await reloadLib()
  })
  const cats = useMemo(() => [...new Set([...templatesOf(lib, kind).map((x) => x.category).filter(Boolean), ...(CATEGORY_SUGGEST[kind] ?? [])])].sort(), [lib, kind])
  if (!draft) return null
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-4 pt-4 pb-3">
        <span className="text-[11px] text-muted-foreground">{TEMPLATE_KINDS[kind]}</span>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          onClick={async () => {
            flush()
            const r = await call(api['templates.duplicate'](t.id))
            if (r) {
              await reloadLib()
              toast.success('已复制')
            }
          }}
        >
          <Copy /> 复制
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="hover:text-destructive"
          onClick={async () => {
            const used = [...new Set((await Promise.all(REF_FIELDS[kind].map((f) => api.references(f, t.id)))).flat())]
            const ok = await confirm({
              title: `删除「${draft.name}」？`,
              description: used.length ? `以下套图任务正在使用它：${used.join('、')}\n删除后这些任务会提示引用失效。（已生成的运行记录不受影响）` : '已生成的运行记录不受影响。',
              confirmText: '删除',
              destructive: true,
            })
            if (!ok) return
            await call(api['templates.remove'](t.id))
            await reloadLib()
            onDeleted()
          }}
        >
          <Trash2 /> 删除
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="关闭">
          <X />
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-6">
        <div>
          <FieldLabel>名称</FieldLabel>
          <TextInput value={draft.name} onChange={(v) => patch({ name: v })} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <FieldLabel>分类</FieldLabel>
            <TextInput value={draft.category} onChange={(v) => patch({ category: v })} placeholder="可选" />
          </div>
          <div>
            <FieldLabel>标签</FieldLabel>
            <TextInput value={draft.tags} onChange={(v) => patch({ tags: v })} placeholder="用于搜索，可选" />
          </div>
        </div>
        {cats.length > 0 && (
          <div className="-mt-2 flex flex-wrap gap-1">
            {cats.map((c) => (
              <Chip key={c} active={draft.category === c} onClick={() => patch({ category: draft.category === c ? '' : c })} className="h-6 text-[11px]">
                {c}
              </Chip>
            ))}
          </div>
        )}
        <PromptField label="正面 Prompt" value={draft.positive} onChange={(v) => patch({ positive: v })} placeholder={`原样保存，不做任何格式转换。可用占位符 ${PLACEHOLDER_HELP}`} minRows={6} copy />
        <PromptField label="负面 Prompt" value={draft.negative} onChange={(v) => patch({ negative: v })} placeholder="可留空" minRows={3} copy />
        <div>
          <FieldLabel>备注</FieldLabel>
          <TextInput value={draft.note} onChange={(v) => patch({ note: v })} placeholder="可选" />
        </div>
      </div>
    </div>
  )
}

export default function LibraryPage() {
  const lib = useLib((s) => s.lib)
  const [kind, setKind] = useState<TemplateKind>('pose')
  const [q, setQ] = useState('')
  const [cat, setCat] = useState<string | null>(null)
  const [sel, setSel] = useState<number | null>(null)
  const all = templatesOf(lib, kind)
  const cats = useMemo(() => [...new Set(all.map((t) => t.category).filter(Boolean))].sort(), [all])
  const list = all.filter((t) => (!cat || t.category === cat) && (!q || matches(t as never, q)))
  const filtered = !!q || !!cat
  const cur = all.find((t) => t.id === sel)

  const add = async () => {
    const r = await call(api['templates.save']({ kind, name: `新${TEMPLATE_KINDS[kind]}`, category: cat ?? '' }))
    if (!r) return
    await reloadLib()
    setQ('')
    setSel(r.id)
  }

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <PageHeader
          title="素材库"
          description={HINTS[kind]}
          actions={
            <Button size="sm" onClick={add}>
              <Plus /> 新建{TEMPLATE_KINDS[kind]}
            </Button>
          }
        />
        <div className="flex items-center gap-3 px-6 pb-3">
          <div className="flex rounded-xl bg-white/[0.04] p-1">
            {KINDS.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => {
                  setKind(k)
                  setSel(null)
                  setCat(null)
                }}
                data-active={kind === k || undefined}
                className="h-7 rounded-lg px-3 text-[12.5px] text-muted-foreground transition hover:text-foreground data-[active]:bg-white/[0.09] data-[active]:text-foreground"
              >
                {TEMPLATE_KINDS[k]}
                <span className="ml-1.5 text-[11px] opacity-60">{templatesOf(lib, k).length}</span>
              </button>
            ))}
          </div>
          <SearchBox value={q} onChange={setQ} placeholder="搜索名称、标签或 Prompt…" className="max-w-xs flex-1" />
        </div>
        {cats.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-6 pb-3">
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
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
          {list.length ? (
            <SortableArea
              items={list}
              grid
              disabled={filtered}
              getId={(t) => String(t.id)}
              onReorder={async (_f, _t, next) => {
                await call(api['templates.reorder'](next.map((t) => t.id)))
                await reloadLib()
              }}
            >
              <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2.5">
                {list.map((t) => (
                  <TemplateCard key={t.id} t={t} selected={sel === t.id} sortable={!filtered} onClick={() => setSel(sel === t.id ? null : t.id)} />
                ))}
              </div>
            </SortableArea>
          ) : (
            <EmptyState
              icon={<Shapes />}
              title={filtered ? '没有匹配的素材' : `还没有${TEMPLATE_KINDS[kind]}模板`}
              description={filtered ? undefined : HINTS[kind]}
              action={!filtered && <Button onClick={add}><Plus /> 新建{TEMPLATE_KINDS[kind]}</Button>}
            />
          )}
          {!filtered && list.length > 1 && <div className="mt-4 text-center text-[11px] text-muted-foreground/60">拖动卡片调整顺序（选择器中按此顺序显示）</div>}
        </div>
      </div>
      {cur && (
        <div className="absolute inset-y-3 right-3 z-30 w-[440px] overflow-hidden rounded-2xl bg-popover shadow-2xl ring-1 shadow-black/50 ring-white/[0.08] 2xl:static 2xl:my-3 2xl:mr-3 2xl:shrink-0 2xl:bg-card 2xl:shadow-none">
          <TemplateEditor key={cur.id} t={cur} kind={kind} onClose={() => setSel(null)} onDeleted={() => setSel(null)} />
        </div>
      )}
    </div>
  )
}
