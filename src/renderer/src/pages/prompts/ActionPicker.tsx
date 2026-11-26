// 选择人物动作 Prompt：左侧情绪组，中间是体位 × POV / 非 POV 矩阵，也可以搜索全部 Prompt。
// multi：添加动作时可以点选多个（按点选顺序编号，每个成为一个动作）；双击直接添加单个。single：更换动作的 Prompt。

import { useEffect, useMemo, useState } from 'react'
import { Plus, Shapes } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { EmptyState, SearchBox } from '@/components/common'
import { useNav } from '@/lib/stores'
import { cn } from '@/lib/utils'
import type { Template } from '@shared/types'
import { labelOf, MoodList, PromptMatrix, PromptSnippet, searchPrompts, useActionIndex } from './matrix'

export function ActionPicker({ open, onOpenChange, onPick, multi, value, insertAfter, title }: { open: boolean; onOpenChange: (o: boolean) => void; onPick: (ids: number[]) => void; multi?: boolean; value?: number | null; insertAfter?: number | null; title?: string }) {
  const ix = useActionIndex()
  const go = useNav((s) => s.go)
  const [moodId, setMoodId] = useState<number | null>(null)
  const [q, setQ] = useState('')
  const [picked, setPicked] = useState<number[]>([])
  useEffect(() => {
    if (!open) return
    setQ('')
    setPicked([])
    const cur = value != null ? ix.byId.get(value) : undefined
    setMoodId(cur?.mood_id ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  const mood = ix.moods.find((m) => m.id === moodId) ?? ix.moods[0] ?? null
  const hits = useMemo(() => searchPrompts(ix, q), [ix, q])
  const commit = (ids: number[]) => {
    if (!ids.length) return
    onPick(ids)
    onOpenChange(false)
  }
  const click = (t: Template) => {
    if (!multi) return commit([t.id])
    setPicked((p) => (p.includes(t.id) ? p.filter((x) => x !== t.id) : [...p, t.id]))
  }
  const tile = (t: Template, label?: string) => {
    const n = picked.indexOf(t.id)
    return (
      <button
        key={t.id}
        type="button"
        onClick={() => click(t)}
        onDoubleClick={() => multi && commit([t.id])}
        data-testid="pick-prompt"
        data-picked={n >= 0 || undefined}
        className={cn('group/cell relative block h-full min-h-[60px] w-full rounded-lg bg-card p-2 text-left ring-1 ring-tint/[0.08] transition hover:bg-accent', (n >= 0 || (!multi && value === t.id)) && 'bg-primary/10 ring-primary/50')}
      >
        {n >= 0 && <span className="absolute top-1.5 right-1.5 grid size-5 place-items-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">{n + 1}</span>}
        {label && <div className="mb-1 pr-6 text-[12px] font-medium">{label}</div>}
        <div className="pr-5">
          <PromptSnippet t={t} lines={label ? 2 : 3} />
        </div>
      </button>
    )
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[86vh] flex-col gap-3 sm:max-w-4xl"
        data-testid="action-picker"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && picked.length) commit(picked)
        }}
      >
        <DialogHeader>
          <DialogTitle>{title ?? (multi ? '添加动作' : '选择人物动作 Prompt')}</DialogTitle>
          <DialogDescription>
            {multi ? `点选一份或多份 Prompt，每份成为一个动作（按点选顺序）；双击直接添加单个。${insertAfter == null ? '添加到序列末尾' : `插入到第 ${insertAfter + 1} 个动作之后`}。` : '点击一份 Prompt 替换当前动作的 Prompt，其他设置保持不变。'}
          </DialogDescription>
        </DialogHeader>
        <SearchBox value={q} onChange={setQ} placeholder="搜索全部 Prompt（情绪组、体位、正文）…" autoFocus />
        {!ix.prompts.length ? (
          <EmptyState icon={<Shapes />} title="还没有人物动作 Prompt" description="在「动作 Prompt」中按情绪组、视角、体位写好 Prompt 后，在这里选择。" />
        ) : q.trim() ? (
          <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-2 gap-2 overflow-y-auto p-0.5" data-testid="picker-search">
            {hits.map((t) => tile(t, labelOf(ix, t)))}
            {!hits.length && <div className="col-span-2 py-8 text-center text-xs text-muted-foreground">没有匹配的 Prompt</div>}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 gap-3">
            <div className="w-48 shrink-0 overflow-y-auto pr-1">
              <MoodList ix={ix} value={mood?.id ?? null} onSelect={setMoodId} badge={(m) => ix.prompts.filter((t) => t.mood_id === m.id).length || ''} />
            </div>
            <div className="min-w-0 flex-1 overflow-y-auto p-0.5">
              {mood && (
                <PromptMatrix
                  ix={ix}
                  moodId={mood.id}
                  renderCell={(_p, _v, list) =>
                    list.length ? (
                      <div className="space-y-1">{list.map((t) => tile(t))}</div>
                    ) : (
                      <div className="flex h-full min-h-[60px] items-center justify-center rounded-lg border border-dashed border-tint/[0.1] text-[11px] text-muted-foreground/50">没有 Prompt</div>
                    )
                  }
                />
              )}
            </div>
          </div>
        )}
        <DialogFooter className="sm:justify-between">
          <Button
            variant="ghost"
            onClick={() => {
              onOpenChange(false)
              go('prompts')
            }}
          >
            管理动作 Prompt
          </Button>
          {multi && (
            <Button disabled={!picked.length} onClick={() => commit(picked)} data-testid="picker-add">
              <Plus /> 添加 {picked.length || ''} 个动作
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
