// 素材库：全局 / 场景 / 状态 / 表情 / 双人动作。卡片浏览 + 右侧编辑，修改自动保存。
// 状态（旧版单人动作与行为合并而来）、表情、场景只编辑名称、正面 Prompt 与显示优先级；状态和表情在套图任务中分配给主角色或第二角色。
// 优先级只影响选择列表中的排列（高 → 普通 → 低，同级保持手动排序），不影响 Prompt。
// 旧文件中的分类、标签、适用对象、备注等字段不在界面中显示，保存时也不会写入（原值保留）。
// 旧版男性描述与镜头不在素材库中显示：数据与任务引用保持不变，镜头在套图任务中选择和新建。

import { useState } from 'react'
import { ChevronDown, ChevronRight, Copy, GripVertical, Pickaxe, Plus, Shapes, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Chip, EmptyState, FieldLabel, PageHeader, PriorityBadge, PriorityToggle, PromptField, SearchBox, TextInput } from '@/components/common'
import { SortableArea, useSortableItem } from '@/components/sortable'
import { api, call } from '@/lib/api'
import { matchesName, useDraft } from '@/lib/hooks'
import { confirm, reloadLib, templatesOf, useLib, useNav } from '@/lib/stores'
import { cn } from '@/lib/utils'
import { PLACEHOLDER_HELP } from '@shared/prompt'
import { TEMPLATE_KINDS, type Template, type TemplateKind } from '@shared/types'

type Tab = 'global' | 'scene' | 'state' | 'expression' | 'duo'
const TABS: [Tab, string][] = [
  ['global', '全局'],
  ['scene', '场景'],
  ['state', '状态'],
  ['expression', '表情'],
  ['duo', '双人动作'],
]
const STATE_HINT = '状态素材（旧版「单人动作」与「行为」都在这里）。在套图任务中可为主角色、第二角色各选择多个，同一张图片中一起使用；双人动作的「行为」也从这里选择。'
const HINTS: Record<TemplateKind, string> = {
  global: '画质、画风等通用 Prompt。每个套图任务选择其中一个。',
  scene: '可复用的环境 Prompt（卧室、教室、街道等）。与剧情库不同：场景只描述环境，在任务中按动作选择。',
  state: STATE_HINT,
  pose: STATE_HINT,
  position: '双人主体位，例如正常位、骑乘位。每个主体位有一段基础 Prompt，并可以有多个子体位作为补充。',
  subposition: '子体位是主体位的补充 Prompt（例如抬腿），生成时拼在主体位之后，可以只写差异部分。',
  act: STATE_HINT,
  expression: '表情 Prompt。在套图任务中分配给主角色（可多选，平均分配张数）或第二角色。',
  male: '男性描述（兼容素材）：分类为「基础」的可作为任务的男性基础描述；旧版的男性动作 / 表情模板仍可在任务的男性设置中选择。',
  camera: '镜头（兼容素材）：仍可在任务的动作详情中选择，POV 不会自动启用男性出场。',
}
/** 状态可能被引用的位置：主角色 / 第二角色的状态、双人动作的行为，以及旧任务中的单选动作字段 */
const STATE_REFS = ['state_ids', 'second_state_ids', 'act_ids', 'pose_id', 'second_pose_id', 'male_pose_ids']
const REF_FIELDS: Record<TemplateKind, string[]> = {
  global: ['global_id'],
  scene: ['scene_id'],
  state: STATE_REFS,
  pose: STATE_REFS,
  position: ['position_id'],
  subposition: ['subposition_id'],
  act: STATE_REFS,
  expression: ['expression_ids', 'male_expression_ids', 'second_expression_id'],
  male: ['male_base_id', 'male_ids'],
  camera: ['camera_id'],
}
/** 只有全局 Prompt 编辑负面 Prompt；其他素材只有名称与正面（旧文件中的负面仍会使用，如实显示并可清空） */
const WITH_NEGATIVE: TemplateKind[] = ['global']

function TemplateCard({ t, selected, onClick, sortable }: { t: Template; selected: boolean; onClick: () => void; sortable: boolean }) {
  const s = useSortableItem(String(t.id))
  return (
    <div
      ref={s.setNodeRef}
      style={s.style}
      {...(sortable ? { ...s.attributes, ...s.listeners } : {})}
      onClick={onClick}
      data-testid="template-card"
      className={cn(
        'flex h-[104px] cursor-pointer flex-col rounded-xl bg-card p-3 ring-1 ring-tint/[0.08] transition hover:bg-accent/70',
        selected && 'bg-accent/80 ring-primary/60',
        s.isDragging && 'shadow-2xl shadow-tint/15',
      )}
    >
      <div className="flex items-center gap-1.5">
        <span className="truncate text-[13px] font-medium">{t.name || '（未命名）'}</span>
        <PriorityBadge value={t.priority} />
      </div>
      <div className="mt-1.5 line-clamp-3 font-mono text-[11px] leading-snug text-muted-foreground">{t.positive || <span className="italic opacity-60">（空）</span>}</div>
    </div>
  )
}

export function TemplateEditor({ t, onClose, onDeleted }: { t: Template; onClose: () => void; onDeleted: () => void }) {
  const lib = useLib((s) => s.lib)
  const kind = t.kind
  const showNeg = WITH_NEGATIVE.includes(kind)
  const { draft, patch, flush } = useDraft<Template>(t, t.id, async (v) => {
    // 只写入界面上可编辑的字段；分类、标签、适用对象、备注等旧字段不发送，文件中的原值保持不变。
    // 负面 Prompt 只有全局编辑；其他素材只在用户点击「清空」旧负面时发送
    const rec: Record<string, unknown> = { id: v.id, _revision: v._revision, name: v.name, positive: v.positive }
    if (showNeg || v.negative !== t.negative) rec.negative = v.negative
    if (kind === 'subposition') rec.parent_id = v.parent_id ?? null
    if (v.priority) rec.priority = v.priority
    await call(api['templates.save'](rec as never))
    await reloadLib()
  })
  const positions = templatesOf(lib, 'position')
  if (!draft) return null
  return (
    <div className="flex min-h-0 flex-col" data-testid="template-editor">
      <div className="flex items-center gap-2 px-4 pt-3 pb-2">
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
            const children = kind === 'position' ? templatesOf(lib, 'subposition').filter((x) => x.parent_id === t.id) : []
            const ok = await confirm({
              title: `删除「${draft.name}」？`,
              description:
                (used.length ? `以下套图任务正在使用它：${used.join('、')}\n删除后这些任务会提示引用失效。\n` : '') +
                (children.length ? `它下面的 ${children.length} 个子体位也会一起删除（移入工作区回收站 .comfyengi/trash）。\n` : '') +
                '已生成的运行记录不受影响。',
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
      {/* 简单素材只有名称与正面 Prompt：编辑面板随内容高度收缩，不再撑满整列 */}
      <div className="min-h-0 space-y-3 overflow-y-auto px-4 pb-4">
        <div>
          <FieldLabel>名称</FieldLabel>
          <TextInput value={draft.name} onChange={(v) => patch({ name: v })} />
        </div>
        {kind === 'subposition' && (
          <div>
            <FieldLabel hint="子体位的 Prompt 拼在主体位之后">所属主体位</FieldLabel>
            <div className="flex flex-wrap gap-1.5">
              {positions.map((p) => (
                <Chip key={p.id} active={draft.parent_id === p.id} onClick={() => patch({ parent_id: p.id })}>
                  {p.name || '（未命名）'}
                </Chip>
              ))}
              {!positions.length && <span className="text-xs text-muted-foreground">还没有主体位</span>}
            </div>
          </div>
        )}
        <div>
          <FieldLabel>优先级</FieldLabel>
          <PriorityToggle value={draft.priority} onChange={(v) => patch({ priority: v })} />
        </div>
        <PromptField label="正面 Prompt" value={draft.positive} onChange={(v) => patch({ positive: v })} placeholder={`原样保存，不做任何格式转换。可用占位符 ${PLACEHOLDER_HELP}`} minRows={4} copy />
        {showNeg ? (
          <PromptField label="负面 Prompt" value={draft.negative} onChange={(v) => patch({ negative: v })} placeholder="通用负面 Prompt，可留空。新任务的负面 Prompt 统一来自这里" minRows={2} copy />
        ) : (
          <LegacyNegative value={draft.negative} onClear={() => patch({ negative: '' })} />
        )}
      </div>
    </div>
  )
}

/** 卡片网格（按名称搜索、拖动排序） */
function Grid({ kind, sel, onSelect, q }: { kind: TemplateKind; sel: number | null; onSelect: (id: number | null) => void; q: string }) {
  const lib = useLib((s) => s.lib)
  const list = templatesOf(lib, kind).filter((t) => matchesName(t, q))
  const filtered = !!q
  return (
    <>
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
              <TemplateCard key={t.id} t={t} selected={sel === t.id} sortable={!filtered} onClick={() => onSelect(sel === t.id ? null : t.id)} />
            ))}
          </div>
        </SortableArea>
      ) : (
        <EmptyState icon={<Shapes />} title={filtered ? '没有匹配的素材' : `还没有${TEMPLATE_KINDS[kind]}`} description={filtered ? undefined : HINTS[kind]} />
      )}
    </>
  )
}

/** 旧数据中的负面 Prompt：不再提供编辑框，但仍会用于生成，这里如实显示并允许清空（不会自动清空） */
function LegacyNegative({ value, onClear }: { value: string; onClear: () => void }) {
  if (!value) return null
  return (
    <div className="flex items-start gap-2 rounded-lg bg-inset px-3 py-2 text-[11.5px] text-muted-foreground" data-testid="legacy-negative">
      <span className="min-w-0 flex-1 break-all">
        旧版负面 Prompt（仍会用于生成）：<span className="font-mono text-foreground/80">{value}</span>
      </span>
      <button type="button" className="shrink-0 hover:text-destructive" onClick={onClear}>
        清空
      </button>
    </div>
  )
}

/** 名称 + 正面 Prompt 的保存：只发送这两个字段；负面 Prompt 只在用户清空时发送，其他旧字段原样保留 */
function useTemplateDraft(t: Template) {
  return useDraft<Template>(t, t.id, async (v) => {
    const rec: Record<string, unknown> = { id: v.id, _revision: v._revision, name: v.name, positive: v.positive }
    if (v.negative !== t.negative) rec.negative = v.negative
    if (v.priority) rec.priority = v.priority
    await call(api['templates.save'](rec as never))
    await reloadLib()
  })
}

// ---------------------------------------------------------------- 双人互动：主体位 + 子体位（类似角色与服装）

function PositionRow({ p, subs, selected, onClick }: { p: Template; subs: number; selected: boolean; onClick: () => void }) {
  const s = useSortableItem(String(p.id))
  return (
    <div ref={s.setNodeRef} style={s.style} className={cn('flex items-center gap-1.5 rounded-xl py-2 pr-2 pl-1 hover:bg-tint/[0.04]', selected && 'bg-tint/[0.07]', s.isDragging && 'shadow-xl shadow-tint/15')} data-testid="position-row">
      <button type="button" {...s.attributes} {...s.listeners} className="cursor-grab text-muted-foreground/40 hover:text-muted-foreground" aria-label="拖动排序">
        <GripVertical className="size-3.5" />
      </button>
      <button type="button" onClick={onClick} className="min-w-0 flex-1 text-left">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-medium">{p.name || '（未命名）'}</span>
          <PriorityBadge value={p.priority} />
        </div>
        <div className="truncate text-[11px] text-muted-foreground">{subs ? `${subs} 个子体位` : '没有子体位'}</div>
      </button>
    </div>
  )
}

function SubpositionRow({ t, open, onToggle, onDeleted }: { t: Template; open: boolean; onToggle: () => void; onDeleted: () => void }) {
  const s = useSortableItem(String(t.id))
  return (
    <div ref={s.setNodeRef} style={s.style} className={cn('rounded-xl bg-tint/[0.03] ring-1 ring-tint/[0.08]', open && 'bg-tint/[0.045] ring-tint/[0.16]', s.isDragging && 'shadow-2xl shadow-tint/15')} data-testid="subposition-row">
      <div className="flex items-center gap-2 px-2 py-2">
        <button type="button" {...s.attributes} {...s.listeners} className="cursor-grab text-muted-foreground/50 hover:text-muted-foreground" aria-label="拖动排序">
          <GripVertical className="size-4" />
        </button>
        <button type="button" onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          {open ? <ChevronDown className="size-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-4 shrink-0 text-muted-foreground" />}
          <span className="shrink-0 text-[13px] font-medium">{t.name || '（未命名）'}</span>
          <PriorityBadge value={t.priority} />
          {!open && <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">{t.positive || '（空）'}</span>}
        </button>
      </div>
      {open && (
        <div className="px-3 pb-3">
          <SubpositionEditor t={t} onDeleted={onDeleted} />
        </div>
      )}
    </div>
  )
}

function SubpositionEditor({ t, onDeleted }: { t: Template; onDeleted: () => void }) {
  const { draft, patch, flush } = useTemplateDraft(t)
  if (!draft) return null
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <TextInput value={draft.name} onChange={(v) => patch({ name: v })} className="font-medium" />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="复制子体位"
          onClick={async () => {
            flush()
            await call(api['templates.duplicate'](t.id))
            await reloadLib()
          }}
        >
          <Copy />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="删除子体位"
          className="hover:text-destructive"
          onClick={async () => {
            const used = await api.references('subposition_id', t.id)
            if (!(await confirm({ title: `删除子体位「${draft.name}」？`, description: used.length ? `以下套图任务正在使用它：${used.join('、')}\n删除后这些任务会提示引用失效。` : undefined, confirmText: '删除', destructive: true }))) return
            await call(api['templates.remove'](t.id))
            await reloadLib()
            onDeleted()
          }}
        >
          <Trash2 />
        </Button>
      </div>
      <PromptField value={draft.positive} onChange={(v) => patch({ positive: v })} placeholder="补充 Prompt：拼在主体位基础 Prompt 之后（原样保存），可以只写差异部分" minRows={2} />
      <PriorityToggle value={draft.priority} onChange={(v) => patch({ priority: v })} />
      <LegacyNegative value={draft.negative} onClear={() => patch({ negative: '' })} />
    </div>
  )
}

function PositionDetail({ p, onDeleted }: { p: Template; onDeleted: () => void }) {
  const lib = useLib((s) => s.lib)
  const subs = templatesOf(lib, 'subposition').filter((s) => s.parent_id === p.id)
  const [open, setOpen] = useState<number | null>(null)
  const { draft, patch, flush } = useTemplateDraft(p)
  if (!draft) return null
  return (
    <div className="max-w-3xl space-y-6" data-testid="position-detail">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[16px] font-semibold">{draft.name || '（未命名）'}</div>
          <div className="text-xs text-muted-foreground">主体位 · {subs.length} 个子体位</div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={async () => {
            flush()
            const r = await call(api['templates.duplicate'](p.id))
            if (r) {
              await reloadLib()
              toast.success('已复制主体位（含子体位）')
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
            const used = [...new Set([...(await api.references('position_id', p.id)), ...(await Promise.all(subs.map((s) => api.references('subposition_id', s.id)))).flat()])]
            const ok = await confirm({
              title: `删除主体位「${draft.name}」${subs.length ? `及其 ${subs.length} 个子体位` : ''}？`,
              description: (used.length ? `以下套图任务正在使用它们：${used.join('、')}\n删除后这些任务会提示引用失效。\n` : '') + '文件会移入工作区的回收站（.comfyengi/trash），已生成的运行记录不受影响。',
              confirmText: '删除',
              destructive: true,
            })
            if (!ok) return
            await call(api['templates.remove'](p.id))
            await reloadLib()
            onDeleted()
          }}
        >
          <Trash2 /> 删除
        </Button>
      </div>
      <div>
        <FieldLabel>名称</FieldLabel>
        <TextInput value={draft.name} onChange={(v) => patch({ name: v })} />
      </div>
      <div>
        <FieldLabel>优先级</FieldLabel>
        <PriorityToggle value={draft.priority} onChange={(v) => patch({ priority: v })} />
      </div>
      <div className="space-y-2">
        <PromptField label="基础 Prompt" value={draft.positive} onChange={(v) => patch({ positive: v })} placeholder={`主体位的基础 Prompt（原样保存）。可用占位符 ${PLACEHOLDER_HELP}`} minRows={3} copy />
        <LegacyNegative value={draft.negative} onClear={() => patch({ negative: '' })} />
      </div>
      <section>
        <FieldLabel
          hint="补充在基础 Prompt 之后；生成时可以只选主体位。拖动调整顺序，点击展开编辑"
          right={
            <Button
              size="xs"
              variant="ghost"
              onClick={async () => {
                const r = await call(api['templates.save']({ kind: 'subposition', name: `子体位${subs.length + 1}`, parent_id: p.id } as never))
                if (r) {
                  await reloadLib()
                  setOpen(r.id)
                }
              }}
            >
              <Plus /> 新建子体位
            </Button>
          }
        >
          {`子体位${subs.length ? ` · ${subs.length}` : ''}`}
        </FieldLabel>
        <div className="space-y-1.5">
          <SortableArea
            items={subs}
            getId={(t) => String(t.id)}
            onReorder={async (_f, _t, next) => {
              await call(api['templates.reorder'](next.map((t) => t.id)))
              await reloadLib()
            }}
          >
            {subs.map((t) => (
              <SubpositionRow key={t.id} t={t} open={open === t.id} onToggle={() => setOpen(open === t.id ? null : t.id)} onDeleted={() => setOpen(null)} />
            ))}
          </SortableArea>
          {!subs.length && <div className="rounded-xl border border-dashed border-tint/[0.16] px-4 py-5 text-center text-xs text-muted-foreground">还没有子体位。子体位是这个主体位的补充 Prompt（例如抬腿），只属于这个主体位。</div>}
        </div>
      </section>
    </div>
  )
}

/** 双人动作：左侧主体位列表，右侧主体位详情（基础 Prompt 与子体位）。任务中叠加的行为从「状态」中选择 */
function DuoPanel({ sel, onSelect, q }: { sel: number | null; onSelect: (id: number | null) => void; q: string }) {
  const lib = useLib((s) => s.lib)
  const positions = templatesOf(lib, 'position')
  const subs = templatesOf(lib, 'subposition')
  const [pid, setPid] = useState<number | null>(null)
  const orphans = subs.filter((s) => !positions.some((p) => p.id === s.parent_id))
  const shown = positions.filter((p) => matchesName(p, q) || subs.some((s) => s.parent_id === p.id && matchesName(s, q)))
  const cur = positions.find((p) => p.id === pid) ?? shown[0] ?? null
  const create = async () => {
    const r = await call(api['templates.save']({ kind: 'position', name: '新主体位' }))
    if (!r) return
    await reloadLib()
    onSelect(null)
    setPid(r.id)
  }
  return (
    <div className="flex gap-6">
      <section className="w-[240px] shrink-0">
        <FieldLabel
          right={
            <Button size="xs" variant="ghost" onClick={() => void create()}>
              <Plus /> 新建主体位
            </Button>
          }
        >
          主体位
        </FieldLabel>
        <div className="space-y-0.5">
          <SortableArea
            items={shown}
            getId={(t) => String(t.id)}
            disabled={!!q}
            onReorder={async (_f, _t, next) => {
              await call(api['templates.reorder'](next.map((t) => t.id)))
              await reloadLib()
            }}
          >
            {shown.map((p) => (
              <PositionRow
                key={p.id}
                p={p}
                subs={subs.filter((s) => s.parent_id === p.id).length}
                selected={!sel && cur?.id === p.id}
                onClick={() => {
                  onSelect(null)
                  setPid(p.id)
                }}
              />
            ))}
          </SortableArea>
          {!positions.length && <div className="rounded-xl border border-dashed border-tint/[0.16] p-4 text-center text-xs text-muted-foreground">还没有主体位</div>}
          {orphans.length > 0 && (
            <div className="pt-3">
              <div className="px-2 pb-1 text-[11px] text-warning">未归属的子体位（旧版本中主体位已被删除），点击后重新指定所属主体位</div>
              {orphans.map((c) => (
                <button key={c.id} type="button" onClick={() => onSelect(c.id)} className={cn('block w-full truncate rounded-lg px-3 py-1.5 text-left text-[13px] hover:bg-tint/[0.04]', sel === c.id && 'bg-tint/[0.08]')}>
                  {c.name}
                </button>
              ))}
            </div>
          )}
        </div>
      </section>
      <div className="min-w-0 flex-1">
        {cur ? (
          <PositionDetail key={cur.id} p={cur} onDeleted={() => setPid(null)} />
        ) : (
          <EmptyState icon={<Shapes />} title={q ? '没有匹配的主体位' : '还没有主体位'} description={HINTS.position} />
        )}
      </div>
    </div>
  )
}

export default function LibraryPage() {
  const lib = useLib((s) => s.lib)
  const [tab, setTab] = useState<Tab>('state')
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<number | null>(null)
  const kind: TemplateKind | null = tab === 'duo' ? null : tab
  const cur = sel ? lib?.templates.find((t) => t.id === sel) : undefined
  const count = (k: TemplateKind) => templatesOf(lib, k).length
  const tabCount: Record<Tab, number> = {
    global: count('global'),
    scene: count('scene'),
    state: count('state'),
    expression: count('expression'),
    duo: count('position') + count('subposition'),
  }
  const add = async () => {
    if (!kind) return
    const r = await call(api['templates.save']({ kind, name: `新${TEMPLATE_KINDS[kind]}` }))
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
          description={kind ? HINTS[kind] : '双人动作 = 主体位基础 Prompt + 可选的子体位补充 Prompt + 可叠加的行为（在任务中从「状态」素材选择）。'}
          actions={
            <>
              <Button variant="ghost" size="sm" onClick={() => useNav.getState().go('mining')} data-testid="open-mining">
                <Pickaxe /> 从历史图片提取
              </Button>
              {kind && (
                <Button size="sm" onClick={add}>
                  <Plus /> 新建{TEMPLATE_KINDS[kind]}
                </Button>
              )}
            </>
          }
        />
        <div className="flex flex-wrap items-center gap-3 px-6 pb-2.5">
          <div className="flex rounded-xl bg-tint/[0.04] p-1">
            {TABS.map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => {
                  setTab(k)
                  setSel(null)
                }}
                data-active={tab === k || undefined}
                data-testid={`lib-tab-${k}`}
                className="h-7 rounded-lg px-3 text-[12.5px] text-muted-foreground transition hover:text-foreground data-[active]:bg-tint/[0.09] data-[active]:text-foreground"
              >
                {label}
                <span className="ml-1.5 text-[11px] opacity-60">{tabCount[k]}</span>
              </button>
            ))}
          </div>
          <SearchBox value={q} onChange={setQ} placeholder="搜索名称…" className="ml-auto w-64" />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-0.5 pb-6">
          {kind ? <Grid key={kind} kind={kind} sel={sel} onSelect={setSel} q={q} /> : <DuoPanel sel={sel} onSelect={setSel} q={q} />}
        </div>
      </div>
      {cur && (
        <div className="absolute top-3 right-3 z-30 flex max-h-[calc(100%-1.5rem)] w-[440px] flex-col overflow-hidden rounded-2xl bg-popover shadow-2xl ring-1 shadow-tint/15 ring-tint/[0.128] 2xl:static 2xl:my-3 2xl:mr-3 2xl:shrink-0 2xl:self-start 2xl:bg-card 2xl:shadow-none">
          <TemplateEditor key={cur.id} t={cur} onClose={() => setSel(null)} onDeleted={() => setSel(null)} />
        </div>
      )}
    </div>
  )
}
