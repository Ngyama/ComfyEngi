// 人物动作 Prompt 库的公共界面：情绪组列表、体位 × 视角矩阵、搜索。Prompt 库页面与添加动作的对话框共用。

import { useMemo, useState, type ReactNode } from 'react'
import { AlertCircle, Copy, GripVertical, Pencil, Trash2 } from 'lucide-react'
import { CopyButton } from '@/components/common'
import { SortableArea, useSortableItem } from '@/components/sortable'
import { useLib } from '@/lib/stores'
import { cn } from '@/lib/utils'
import { actionIndex, actionLabel, anchorProblem, hasMale, legacyPlaceholders, promptAnchors, VIEWS, type ActionIndex } from '@shared/action-prompts'
import type { Template } from '@shared/types'

export function useActionIndex(): ActionIndex {
  const lib = useLib((s) => s.lib)
  return useMemo(() => actionIndex(lib?.templates ?? []), [lib])
}

/** 选中的组合（promptId：同一组合有多份 Prompt 时指定其中一份） */
export interface Cell {
  moodId: number
  pov: boolean
  postureId: number
  promptId?: number
}
export const cellKey = (c: Cell) => `${c.moodId}|${c.pov ? 1 : 0}|${c.postureId}|${c.promptId ?? ''}`
export const cellOf = (t: Template): Cell => ({ moodId: t.mood_id ?? 0, pov: !!t.pov, postureId: t.posture_id ?? 0, promptId: t.id })
export const labelOf = (ix: ActionIndex, t: Template) => actionLabel(t, (id) => ix.byId.get(id))

/** 搜索：全部 Prompt 的分类名称与正文（空格分隔的多个词需全部包含） */
export function searchPrompts(ix: ActionIndex, q: string): Template[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  return ix.prompts.filter((t) => {
    const hay = `${labelOf(ix, t)}\n${t.positive}\n${t.negative}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}

/** Prompt 摘要中的提示：缺少 1girl、1girl / 1man 不唯一、残留旧版占位符 */
export function promptIssues(body: string): string[] {
  const a = promptAnchors(body)
  const out: string[] = []
  const g = anchorProblem(a.girl)
  if (g === 'missing') out.push('没有独立的 1girl')
  else if (g) out.push(g === 'multiple' ? '有多个 1girl' : '1girl 在括号内')
  if (hasMale(a) && anchorProblem(a.man)) out.push(anchorProblem(a.man) === 'multiple' ? '有多个 1man' : '1man 在括号内')
  const legacy = legacyPlaceholders(body)
  if (legacy.length) out.push(`旧版占位符 ${legacy.join(' ')}`)
  return out
}

// ---------------------------------------------------------------- 情绪组列表
export function MoodList({
  ix,
  value,
  onSelect,
  editable,
  renaming,
  onRename,
  onReorder,
  onDuplicate,
  onDelete,
  onStartRename,
  badge,
}: {
  ix: ActionIndex
  value: number | null
  onSelect: (id: number) => void
  editable?: boolean
  renaming?: number | null
  onRename?: (id: number, name: string) => void
  onReorder?: (ids: number[]) => void
  onDuplicate?: (id: number) => void
  onDelete?: (id: number) => void
  onStartRename?: (id: number | null) => void
  /** 每个情绪组右侧的数字（默认：Prompt 数 / 组合数） */
  badge?: (m: Template) => ReactNode
}) {
  const total = ix.postures.length * VIEWS.length
  const countOf = (m: Template) => ix.prompts.filter((t) => t.mood_id === m.id && ix.postures.some((p) => p.id === t.posture_id)).length
  const rows = ix.moods.map((m) => (
    <MoodRow
      key={m.id}
      m={m}
      selected={value === m.id}
      editable={!!editable}
      renaming={renaming === m.id}
      badge={badge ? badge(m) : `${countOf(m)}/${total}`}
      onClick={() => onSelect(m.id)}
      onRename={(name) => onRename?.(m.id, name)}
      onStartRename={() => onStartRename?.(m.id)}
      onCancelRename={() => onStartRename?.(null)}
      onDuplicate={() => onDuplicate?.(m.id)}
      onDelete={() => onDelete?.(m.id)}
    />
  ))
  if (!editable) return <div className="space-y-0.5">{rows}</div>
  return (
    <SortableArea items={ix.moods} getId={(t) => String(t.id)} onReorder={(_f, _t, next) => onReorder?.(next.map((t) => t.id))} disabled={renaming != null}>
      <div className="space-y-0.5">{rows}</div>
    </SortableArea>
  )
}

function MoodRow({ m, selected, editable, renaming, badge, onClick, onRename, onStartRename, onCancelRename, onDuplicate, onDelete }: { m: Template; selected: boolean; editable: boolean; renaming: boolean; badge: ReactNode; onClick: () => void; onRename: (name: string) => void; onStartRename: () => void; onCancelRename: () => void; onDuplicate: () => void; onDelete: () => void }) {
  const s = useSortableItem(String(m.id))
  const drag = editable && !renaming ? { ...s.attributes, ...s.listeners } : {}
  return (
    <div
      ref={s.setNodeRef}
      style={s.style}
      {...drag}
      onClick={onClick}
      onDoubleClick={editable ? onStartRename : undefined}
      data-testid="mood-row"
      data-selected={selected || undefined}
      className={cn('group flex h-8 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-[13px] hover:bg-tint/[0.05]', selected && 'bg-tint/[0.08] font-medium', s.isDragging && 'shadow-xl shadow-tint/15')}
    >
      {renaming ? (
        <RenameInput value={m.name} onDone={onRename} onCancel={onCancelRename} testId="mood-rename" />
      ) : (
        <>
          <span className="min-w-0 flex-1 truncate">{m.name || '（未命名）'}</span>
          {editable && (
            <span className="hidden shrink-0 items-center group-hover:flex" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
              <RowButton label={`重命名 ${m.name}`} onClick={onStartRename}>
                <Pencil />
              </RowButton>
              <RowButton label={`复制情绪组 ${m.name}`} onClick={onDuplicate} testId="mood-duplicate">
                <Copy />
              </RowButton>
              <RowButton label={`删除情绪组 ${m.name}`} onClick={onDelete} danger testId="mood-delete">
                <Trash2 />
              </RowButton>
            </span>
          )}
          <span className={cn('shrink-0 text-[11px] font-normal text-muted-foreground tabular-nums', editable && 'group-hover:hidden')}>{badge}</span>
        </>
      )}
    </div>
  )
}

export function RowButton({ label, onClick, danger, children, testId }: { label: string; onClick: () => void; danger?: boolean; children: ReactNode; testId?: string }) {
  return (
    <button type="button" aria-label={label} title={label} data-testid={testId} onClick={onClick} className={cn('grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-tint/[0.08] hover:text-foreground [&_svg]:size-3.5', danger && 'hover:text-destructive')}>
      {children}
    </button>
  )
}

/** 行内改名：Enter / 失去焦点保存，Esc 取消；空名称不保存 */
export function RenameInput({ value, onDone, onCancel, testId, className }: { value: string; onDone: (v: string) => void; onCancel: () => void; testId?: string; className?: string }) {
  const [v, setV] = useState(value)
  return (
    <input
      autoFocus
      value={v}
      data-testid={testId}
      onChange={(e) => setV(e.target.value)}
      onFocus={(e) => e.target.select()}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onBlur={() => (v.trim() && v.trim() !== value ? onDone(v.trim()) : onCancel())}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') {
          setV(value)
          onCancel()
        }
      }}
      className={cn('h-7 min-w-0 flex-1 rounded-md bg-card px-2 text-[13px] ring-1 ring-primary/50 outline-none', className)}
    />
  )
}

// ---------------------------------------------------------------- 矩阵
/** 一个情绪组：每行一个体位，两列为 POV / 非 POV。renderCell 决定格子的内容与操作 */
export function PromptMatrix({
  ix,
  moodId,
  renderCell,
  rowHeader,
  sortable,
  onReorder,
  footer,
}: {
  ix: ActionIndex
  moodId: number
  renderCell: (postureId: number, pov: boolean, prompts: Template[]) => ReactNode
  rowHeader?: (p: Template) => ReactNode
  sortable?: boolean
  onReorder?: (ids: number[]) => void
  footer?: ReactNode
}) {
  const rows = ix.postures.map((p) => <MatrixRow key={p.id} p={p} sortable={!!sortable} header={rowHeader ? rowHeader(p) : <span className="truncate text-[13px] font-medium">{p.name || '（未命名）'}</span>}>{VIEWS.map((v) => <div key={String(v.pov)} className="min-w-0">{renderCell(p.id, v.pov, ix.at(moodId, v.pov, p.id))}</div>)}</MatrixRow>)
  return (
    <div className="space-y-1.5" data-testid="prompt-matrix">
      <div className="grid grid-cols-[148px_1fr_1fr] gap-2 px-1 text-[11px] font-medium tracking-wide text-muted-foreground">
        <span>体位</span>
        {VIEWS.map((v) => (
          <span key={String(v.pov)}>{v.label}</span>
        ))}
      </div>
      {sortable ? (
        <SortableArea items={ix.postures} getId={(t) => String(t.id)} onReorder={(_f, _t, next) => onReorder?.(next.map((t) => t.id))}>
          {rows}
        </SortableArea>
      ) : (
        rows
      )}
      {footer}
    </div>
  )
}

function MatrixRow({ p, sortable, header, children }: { p: Template; sortable: boolean; header: ReactNode; children: ReactNode }) {
  const s = useSortableItem(String(p.id))
  return (
    <div ref={s.setNodeRef} style={s.style} className={cn('group/row grid grid-cols-[148px_1fr_1fr] items-stretch gap-2', s.isDragging && 'opacity-80')} data-testid="posture-row">
      <div className="flex min-w-0 items-center gap-1 rounded-lg bg-tint/[0.025] px-1.5">
        {sortable && (
          <span {...s.attributes} {...s.listeners} className="cursor-grab text-muted-foreground/40 hover:text-muted-foreground" aria-label={`拖动排序 ${p.name}`}>
            <GripVertical className="size-3.5" />
          </span>
        )}
        {header}
      </div>
      {children}
    </div>
  )
}

/** 格子里的 Prompt 摘要（前几行原文）与提示 */
export function PromptSnippet({ t, lines = 3, copy }: { t: Template; lines?: number; copy?: boolean }) {
  const issues = promptIssues(t.positive)
  return (
    <div className="relative min-w-0">
      <div className={cn('font-mono text-[11px] leading-snug whitespace-pre-wrap text-foreground/80 [overflow-wrap:anywhere]', lines === 2 ? 'line-clamp-2' : lines === 4 ? 'line-clamp-4' : 'line-clamp-3')}>{t.positive.trim() || <span className="font-sans text-muted-foreground italic">（空）</span>}</div>
      {issues.length > 0 && (
        <div className="mt-1 flex items-center gap-1 text-[10.5px] text-destructive" title={issues.join('；')} data-testid="prompt-issue">
          <AlertCircle className="size-3 shrink-0" />
          <span className="truncate">{issues.join('；')}</span>
        </div>
      )}
      {copy && (
        <span className="absolute -top-1 -right-1 hidden rounded-md bg-card shadow-sm group-hover/cell:block" onClick={(e) => e.stopPropagation()}>
          <CopyButton text={t.positive} />
        </span>
      )}
    </div>
  )
}
