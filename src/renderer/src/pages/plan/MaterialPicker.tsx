// 素材选择器：在较大的窗口中搜索、浏览、选择素材（动作、行为、表情、服装、场景、镜头等）。
// 详情面板只显示当前选择，点击后打开这里。单选点一下即完成；多选可连续点选，搜索不会丢失已选内容，最后点「完成」。

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Check, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { PriorityBadge, SearchBox } from '@/components/common'
import { filterMaterials, selectedOptions, toggleSelection, type MaterialOption } from '@/lib/material-select'
import { cn } from '@/lib/utils'

const oneLine = (s?: string) => (s ?? '').replace(/\s+/g, ' ').trim()

export function MaterialPicker({
  open,
  onOpenChange,
  title,
  description,
  items,
  value,
  multi = false,
  numbered = false,
  noneLabel,
  onChange,
  empty,
  testId,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  title: string
  description?: ReactNode
  items: MaterialOption[]
  value: number[]
  multi?: boolean
  /** 多选时显示点选顺序（例如表情按顺序生成） */
  numbered?: boolean
  /** 单选时提供「不指定」选项的文字；不提供则不能清除 */
  noneLabel?: string
  onChange: (ids: number[]) => void
  empty?: ReactNode
  testId?: string
}) {
  const [q, setQ] = useState('')
  const [draft, setDraft] = useState<number[]>(value)
  useEffect(() => {
    if (open) {
      setQ('')
      setDraft(value)
    }
    // 只在打开时同步：打开期间外部变化不覆盖用户正在进行的选择
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  const shown = useMemo(() => filterMaterials(items, q), [items, q])
  const picked = selectedOptions(items, draft)
  const pick = (id: number) => {
    if (!multi) {
      onChange([id])
      onOpenChange(false)
      return
    }
    setDraft((d) => toggleSelection(d, id, true))
  }
  const finish = () => {
    onChange(draft)
    onOpenChange(false)
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(84vh,760px)] flex-col gap-3 sm:max-w-2xl" data-testid={testId}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description ?? (multi ? '可多选，点击切换；搜索不会影响已选内容。' : '点击选择。')}</DialogDescription>
        </DialogHeader>
        <SearchBox value={q} onChange={setQ} placeholder={`搜索名称（共 ${items.length} 个）…`} autoFocus />
        {multi && (
          <div className="flex min-h-8 shrink-0 flex-wrap items-center gap-1.5 overflow-y-auto rounded-xl bg-tint/[0.03] px-2.5 py-1.5 ring-1 ring-tint/[0.06] [max-height:5.5rem]" data-testid="picker-selected">
            <span className="text-[11.5px] text-muted-foreground">已选 {draft.length}</span>
            {picked.map((t, i) => (
              <span key={t.id} className="inline-flex h-6 items-center gap-1 rounded-md bg-primary/10 pr-1 pl-2 text-[12px] text-foreground">
                {numbered && draft.length > 1 && <span className="text-[10.5px] text-primary tabular-nums">{i + 1}</span>}
                {t.name || '（未命名）'}
                <button type="button" aria-label={`移除 ${t.name}`} className="grid size-4 place-items-center rounded text-muted-foreground hover:bg-tint/[0.08] hover:text-foreground" onClick={() => setDraft((d) => d.filter((x) => x !== t.id))}>
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1" data-testid="picker-list">
          {!multi && noneLabel && (
            <Row active={!value.length} onClick={() => (onChange([]), onOpenChange(false))} name={noneLabel} muted />
          )}
          {shown.map((t) => {
            const n = draft.indexOf(t.id)
            return <Row key={t.id} active={multi ? n >= 0 : value[0] === t.id} order={numbered && multi && n >= 0 && draft.length > 1 ? n + 1 : undefined} onClick={() => pick(t.id)} name={t.name || '（未命名）'} preview={oneLine(t.positive)} priority={t.priority} />
          })}
          {!shown.length && <div className="py-10 text-center text-xs text-muted-foreground">{items.length ? '没有匹配的素材' : (empty ?? '还没有素材')}</div>}
        </div>
        {multi && (
          <div className="flex shrink-0 items-center gap-2 border-t border-tint/[0.06] pt-3">
            <Button variant="ghost" size="sm" onClick={() => setDraft([])} disabled={!draft.length}>
              清空
            </Button>
            <div className="flex-1" />
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button size="sm" onClick={finish} data-testid="picker-done">
              完成（{draft.length}）
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function Row({ active, order, onClick, name, preview, muted, priority }: { active: boolean; order?: number; onClick: () => void; name: string; preview?: string; muted?: boolean; priority?: MaterialOption['priority'] }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-active={active || undefined}
      className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left hover:bg-tint/[0.04] data-[active]:bg-primary/[0.08]"
    >
      <span className={cn('grid size-4.5 shrink-0 place-items-center rounded-[5px] ring-1 ring-tint/[0.2]', active && 'bg-primary text-primary-foreground ring-primary')}>
        {active && (order ? <span className="text-[10px] font-semibold tabular-nums">{order}</span> : <Check className="size-3" />)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className={cn('block truncate text-[13px]', muted && 'text-muted-foreground')}>{name}</span>
          <PriorityBadge value={priority} />
        </span>
        {preview && <span className="block truncate font-mono text-[11px] text-muted-foreground">{preview}</span>}
      </span>
    </button>
  )
}
