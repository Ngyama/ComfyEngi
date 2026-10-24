// 素材库：全局 / 场景 / 动作（单人动作、双人互动）/ 表情。卡片浏览 + 右侧编辑，修改自动保存。
// 单人动作、表情、场景只编辑名称与正面 Prompt；动作和表情在套图任务中分配给主角色或第二角色。
// 旧文件中的分类、标签、适用对象、备注等字段不在界面中显示，保存时也不会写入（原值保留）。
// 旧版男性描述与镜头不在素材库中显示：数据与任务引用保持不变，镜头在套图任务中选择和新建。

import { useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, Copy, GripVertical, Plus, Shapes, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Chip, EmptyState, FieldLabel, PageHeader, PromptField, SearchBox, TextInput } from '@/components/common'
import { SortableArea, useSortableItem } from '@/components/sortable'
import { api, call } from '@/lib/api'
import { matchesName, useDraft } from '@/lib/hooks'
import { confirm, reloadLib, templatesOf, useLib } from '@/lib/stores'
import { cn } from '@/lib/utils'
import { PLACEHOLDER_HELP } from '@shared/prompt'
import { TEMPLATE_KINDS, type Template, type TemplateKind } from '@shared/types'

type Tab = 'global' | 'scene' | 'action' | 'expression'
type Sub = 'pose' | 'duo'
const TABS: [Tab, string][] = [
  ['global', '全局'],
  ['scene', '场景'],
  ['action', '动作'],
  ['expression', '表情'],
]
const SUBS: Partial<Record<Tab, [Sub, string][]>> = {
  action: [
    ['pose', '单人动作'],
    ['duo', '双人互动'],
  ],
}
const HINTS: Record<TemplateKind, string> = {
  global: '画质、画风等通用 Prompt。每个套图任务选择其中一个。',
  scene: '可复用的环境 Prompt（卧室、教室、街道等）。与剧情库不同：场景只描述环境，在任务中按动作选择。',
  pose: '单人动作（旧版「姿态」模板都在这里）。在套图任务中可以分配给主角色或第二角色。',
  position: '双人主体位，例如正常位、骑乘位。',
  subposition: '子体位是主体位的补充 Prompt（例如抬腿），生成时拼在主体位之后，可以只写差异部分。',
  act: '行为是独立的可复用素材（拥抱、接吻等），可以与任意主体位叠加。',
  expression: '表情 Prompt。在套图任务中分配给主角色（可多选，平均分配张数）或第二角色。',
  male: '男性描述（兼容素材）：分类为「基础」的可作为任务的男性基础描述；旧版的男性动作 / 表情模板仍可在任务的男性设置中选择。',
  camera: '镜头（兼容素材）：仍可在任务的动作详情中选择，POV 不会自动启用男性出场。',
}
const REF_FIELDS: Record<TemplateKind, string[]> = {
  global: ['global_id'],
  scene: ['scene_id'],
  pose: ['pose_id', 'male_pose_ids', 'second_pose_id'],
  position: ['position_id'],
  subposition: ['subposition_id'],
  act: ['act_ids'],
  expression: ['expression_ids', 'male_expression_ids', 'second_expression_id'],
  male: ['male_base_id', 'male_ids'],
  camera: ['camera_id'],
}
/** 这些类型编辑负面 Prompt 与备注；单人动作 / 表情 / 场景只有名称与正面（旧文件已有负面时仍显示，避免看不见却仍在生效） */
const WITH_NEGATIVE: TemplateKind[] = ['global', 'position', 'subposition', 'act']
const WITH_NOTE: TemplateKind[] = ['position', 'subposition', 'act']

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
      </div>
      <div className="mt-1.5 line-clamp-3 font-mono text-[11px] leading-snug text-muted-foreground">{t.positive || <span className="italic opacity-60">（空）</span>}</div>
    </div>
  )
}

export function TemplateEditor({ t, onClose, onDeleted }: { t: Template; onClose: () => void; onDeleted: () => void }) {
  const lib = useLib((s) => s.lib)
  const kind = t.kind
  const [showNeg] = useState(() => WITH_NEGATIVE.includes(kind) || !!t.negative)
  const showNote = WITH_NOTE.includes(kind)
  const { draft, patch, flush } = useDraft<Template>(t, t.id, async (v) => {
    // 只写入界面上可编辑的字段；分类、标签、适用对象等旧字段不发送，文件中的原值保持不变
    const rec: Record<string, unknown> = { id: v.id, _revision: v._revision, name: v.name, positive: v.positive }
    if (showNeg) rec.negative = v.negative
    if (showNote) rec.note = v.note
    if (kind === 'subposition') rec.parent_id = v.parent_id ?? null
    await call(api['templates.save'](rec as never))
    await reloadLib()
  })
  const positions = templatesOf(lib, 'position')
  if (!draft) return null
  const moveTo = async (k: TemplateKind) => {
    if (!(await confirm({ title: `把「${draft.name}」移到「${TEMPLATE_KINDS[k]}」？`, description: '只修改素材类型，文件与 Prompt 内容不变；已有任务对它的引用继续有效。', confirmText: '移动' }))) return
    flush()
    await call(api['templates.save']({ id: t.id, kind: k } as never))
    await reloadLib()
    onClose()
    toast.success(`已移到${TEMPLATE_KINDS[k]}`)
  }
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
            const children = kind === 'position' ? templatesOf(lib, 'subposition').filter((x) => x.parent_id === t.id) : []
            const ok = await confirm({
              title: `删除「${draft.name}」？`,
              description:
                (used.length ? `以下套图任务正在使用它：${used.join('、')}\n删除后这些任务会提示引用失效。\n` : '') +
                (children.length ? `它下面的 ${children.length} 个子体位不会被删除，会显示在「未归属的子体位」中。\n` : '') +
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
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-6">
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
        <PromptField label="正面 Prompt" value={draft.positive} onChange={(v) => patch({ positive: v })} placeholder={`原样保存，不做任何格式转换。可用占位符 ${PLACEHOLDER_HELP}`} minRows={5} copy />
        {showNeg && (
          <PromptField
            label={WITH_NEGATIVE.includes(kind) ? '负面 Prompt' : '负面 Prompt（旧数据，仍会使用，可清空）'}
            value={draft.negative}
            onChange={(v) => patch({ negative: v })}
            placeholder="可留空"
            minRows={2}
            copy
          />
        )}
        {showNote && (
          <div>
            <FieldLabel>备注</FieldLabel>
            <TextInput value={draft.note} onChange={(v) => patch({ note: v })} placeholder="可选" />
          </div>
        )}
        {kind === 'pose' && (
          <div className="rounded-xl bg-tint/[0.025] p-3 ring-1 ring-tint/[0.08]">
            <FieldLabel hint="旧「姿态」中的双人内容可以移到双人互动">移动到</FieldLabel>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" onClick={() => void moveTo('position')}>
                双人主体位
              </Button>
              <Button size="sm" variant="secondary" onClick={() => void moveTo('act')}>
                双人行为
              </Button>
            </div>
          </div>
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

function Row({ id, t, selected, depth, onClick, right, toggle }: { id: string; t: Template; selected: boolean; depth: number; onClick: () => void; right?: ReactNode; toggle?: ReactNode }) {
  const s = useSortableItem(id)
  return (
    <div ref={s.setNodeRef} style={s.style} className={cn('group flex items-center gap-1.5 rounded-lg py-1.5 pr-2 hover:bg-tint/[0.04]', selected && 'bg-tint/[0.08]', s.isDragging && 'shadow-xl shadow-tint/15')} data-testid={`${t.kind}-row`}>
      <span style={{ width: depth * 18 }} className="shrink-0" />
      <button type="button" {...s.attributes} {...s.listeners} className="cursor-grab text-muted-foreground/40 hover:text-muted-foreground" aria-label="拖动排序">
        <GripVertical className="size-3.5" />
      </button>
      {toggle ?? <span className="w-4" />}
      <button type="button" onClick={onClick} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <span className={cn('truncate text-[13px]', depth === 0 && 'font-medium')}>{t.name || '（未命名）'}</span>
        <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">{t.positive}</span>
      </button>
      {right}
    </div>
  )
}

/** 双人互动：左侧主体位（含子体位），右侧可复用的行为 */
function DuoPanel({ sel, onSelect, q }: { sel: number | null; onSelect: (id: number | null) => void; q: string }) {
  const lib = useLib((s) => s.lib)
  const [open, setOpen] = useState<Set<number>>(new Set())
  const positions = templatesOf(lib, 'position')
  const subs = templatesOf(lib, 'subposition')
  const ok = (t: Template) => matchesName(t, q)
  const childrenOf = (pid: number) => subs.filter((s) => s.parent_id === pid)
  const orphans = subs.filter((s) => !positions.some((p) => p.id === s.parent_id))
  const shown = positions.filter((p) => ok(p) || childrenOf(p.id).some(ok))
  const create = async (kind: TemplateKind, extra: Record<string, unknown> = {}) => {
    const r = await call(api['templates.save']({ kind, name: `新${TEMPLATE_KINDS[kind]}`, ...extra } as never))
    if (!r) return
    await reloadLib()
    onSelect(r.id)
  }
  const reorder = async (next: Template[]) => {
    await call(api['templates.reorder'](next.map((t) => t.id)))
    await reloadLib()
  }
  return (
    <div className="grid min-h-0 grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] gap-6">
      <section>
        <FieldLabel hint={HINTS.position} right={<Button size="xs" variant="ghost" onClick={() => void create('position')}><Plus /> 新建主体位</Button>}>
          主体位 · 子体位
        </FieldLabel>
        <div className="space-y-0.5">
          <SortableArea items={shown} getId={(t) => `p${t.id}`} disabled={!!q} onReorder={(_f, _t, next) => void reorder(next)}>
            {shown.map((p) => {
              const kids = childrenOf(p.id).filter((c) => ok(c) || ok(p))
              const isOpen = open.has(p.id) || !!q
              return (
                <div key={p.id}>
                  <Row
                    id={`p${p.id}`}
                    t={p}
                    depth={0}
                    selected={sel === p.id}
                    onClick={() => onSelect(p.id)}
                    toggle={
                      <button type="button" className={cn('grid size-4 place-items-center text-muted-foreground', !kids.length && 'invisible')} onClick={() => setOpen((s) => (s.has(p.id) ? new Set([...s].filter((x) => x !== p.id)) : new Set([...s, p.id])))} aria-label="展开子体位">
                        {isOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                      </button>
                    }
                    right={
                      <button type="button" className="hidden shrink-0 text-[11px] text-muted-foreground group-hover:block hover:text-primary" onClick={() => { setOpen((s) => new Set([...s, p.id])); void create('subposition', { parent_id: p.id }) }}>
                        + 子体位
                      </button>
                    }
                  />
                  {isOpen && kids.length > 0 && (
                    <SortableArea items={kids} getId={(t) => `s${t.id}`} disabled={!!q} onReorder={(_f, _t, next) => void reorder(next)}>
                      {kids.map((c) => (
                        <Row key={c.id} id={`s${c.id}`} t={c} depth={1} selected={sel === c.id} onClick={() => onSelect(c.id)} />
                      ))}
                    </SortableArea>
                  )}
                </div>
              )
            })}
          </SortableArea>
          {!positions.length && <div className="rounded-xl border border-dashed border-tint/[0.16] p-4 text-center text-xs text-muted-foreground">还没有主体位</div>}
          {orphans.length > 0 && (
            <div className="pt-3">
              <div className="px-2 pb-1 text-[11px] text-warning">未归属的子体位（所属主体位已删除，可在编辑中重新指定）</div>
              {orphans.map((c) => (
                <button key={c.id} type="button" onClick={() => onSelect(c.id)} className={cn('block w-full truncate rounded-lg px-3 py-1.5 text-left text-[13px] hover:bg-tint/[0.04]', sel === c.id && 'bg-tint/[0.08]')}>
                  {c.name}
                </button>
              ))}
            </div>
          )}
        </div>
      </section>
      <section>
        <FieldLabel hint={HINTS.act} right={<Button size="xs" variant="ghost" onClick={() => void create('act')}><Plus /> 新建行为</Button>}>
          行为
        </FieldLabel>
        <Grid kind="act" sel={sel} onSelect={onSelect} q={q} />
      </section>
    </div>
  )
}

export default function LibraryPage() {
  const lib = useLib((s) => s.lib)
  const [tab, setTab] = useState<Tab>('action')
  const [sub, setSub] = useState<Record<string, Sub>>({ action: 'pose' })
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<number | null>(null)
  const curSub = SUBS[tab] ? sub[tab] : null
  const kind: TemplateKind | null = tab === 'action' ? (curSub === 'duo' ? null : 'pose') : tab
  const cur = sel ? lib?.templates.find((t) => t.id === sel) : undefined
  const count = (k: TemplateKind) => templatesOf(lib, k).length
  const tabCount: Record<Tab, number> = {
    global: count('global'),
    scene: count('scene'),
    action: count('pose') + count('position') + count('subposition') + count('act'),
    expression: count('expression'),
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
          description={kind ? HINTS[kind] : '双人互动由主体位（可带子体位）与可叠加的行为组成。'}
          actions={
            kind && (
              <Button size="sm" onClick={add}>
                <Plus /> 新建{TEMPLATE_KINDS[kind]}
              </Button>
            )
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
                className="h-7 rounded-lg px-3 text-[12.5px] text-muted-foreground transition hover:text-foreground data-[active]:bg-tint/[0.09] data-[active]:text-foreground"
              >
                {label}
                <span className="ml-1.5 text-[11px] opacity-60">{tabCount[k]}</span>
              </button>
            ))}
          </div>
          {SUBS[tab] && (
            <div className="flex gap-1">
              {SUBS[tab]!.map(([k, label]) => (
                <Chip
                  key={k}
                  active={curSub === k}
                  onClick={() => {
                    setSub((s) => ({ ...s, [tab]: k }))
                    setSel(null)
                  }}
                >
                  {label}
                </Chip>
              ))}
            </div>
          )}
          <SearchBox value={q} onChange={setQ} placeholder="搜索名称…" className="ml-auto w-64" />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-0.5 pb-6">
          {kind ? <Grid key={kind} kind={kind} sel={sel} onSelect={setSel} q={q} /> : <DuoPanel sel={sel} onSelect={setSel} q={q} />}
        </div>
      </div>
      {cur && (
        <div className="absolute inset-y-3 right-3 z-30 w-[440px] overflow-hidden rounded-2xl bg-popover shadow-2xl ring-1 shadow-tint/15 ring-tint/[0.128] 2xl:static 2xl:my-3 2xl:mr-3 2xl:shrink-0 2xl:bg-card 2xl:shadow-none">
          <TemplateEditor key={cur.id} t={cur} onClose={() => setSel(null)} onDeleted={() => setSel(null)} />
        </div>
      )}
    </div>
  )
}
