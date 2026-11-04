// 预览中的单张 Prompt：可以直接增删 tag（只改这一张，保存到任务，入队时使用）。
// 同时保存手改时的自动结果：之后动作、角色或素材有修改导致自动结果变化时，提示选择保留手改还是使用新的，不会悄悄用过期内容生成。

import { useEffect, useState } from 'react'
import { AlertTriangle, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CopyButton, FieldLabel } from '@/components/common'
import { cn } from '@/lib/utils'
import { templateTags } from '@shared/card-templates'
import type { PlanUnit, PromptEdit, TaskItem } from '@shared/types'

const box = 'block w-full resize-y rounded-lg bg-inset p-3 font-mono text-[12px] leading-relaxed outline-none ring-1 ring-transparent focus:ring-primary/50'

export function UnitPrompt({ unit, item, onEdits }: { unit: PlanUnit; item: TaskItem; onEdits: (edits: PromptEdit[] | undefined) => void }) {
  const k = unit.sub_index
  const edit = (item.prompt_edits ?? []).find((e) => e.k === k)
  // 自动结果：手改生效时为手改时记录的结果（与当前一致）；来源变化或没有手改时为计划中的结果
  const auto = edit && unit.manual ? { positive: edit.base_positive, negative: edit.base_negative } : { positive: unit.positive, negative: unit.negative }
  const value = edit ? { positive: edit.positive, negative: edit.negative } : auto
  const [pos, setPos] = useState(value.positive)
  const [neg, setNeg] = useState(value.negative)
  useEffect(() => {
    setPos(value.positive)
    setNeg(value.negative)
  }, [value.positive, value.negative, k])

  const others = (item.prompt_edits ?? []).filter((e) => e.k !== k)
  const save = (next: { positive: string; negative: string }, base = auto) => {
    if (next.positive === base.positive && next.negative === base.negative) return onEdits(others.length ? others : undefined)
    onEdits([...others, { k, positive: next.positive, negative: next.negative, base_positive: base.positive, base_negative: base.negative }].sort((a, b) => a.k - b.k))
  }
  const commit = () => {
    if (pos !== value.positive || neg !== value.negative) save({ positive: pos, negative: neg })
  }
  const reset = () => onEdits(others.length ? others : undefined)
  const diff = edit && !unit.edit_stale ? tagDiff(auto.positive, edit.positive) : null

  return (
    <div className="space-y-3" data-testid="unit-prompt" data-manual={unit.manual || undefined} data-stale={unit.edit_stale || undefined}>
      {unit.edit_stale && edit && (
        <div className="space-y-2 rounded-lg bg-warning/10 p-2.5 text-[12px] ring-1 ring-warning/30" data-testid="edit-stale">
          <div className="flex items-start gap-1.5">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
            <span>这张图手改过 Prompt，之后动作、角色或素材又有修改，自动结果已经变化。请选择使用哪一个（选择前不能入队）。</span>
          </div>
          <details className="text-[11.5px]">
            <summary className="cursor-pointer text-muted-foreground">查看新的自动结果</summary>
            <pre className="mt-1 max-h-48 overflow-y-auto rounded bg-inset p-2 font-mono whitespace-pre-wrap select-text">{unit.positive || '（空）'}</pre>
          </details>
          <div className="flex gap-1.5">
            <Button size="xs" variant="secondary" onClick={() => save({ positive: edit.positive, negative: edit.negative }, { positive: unit.positive, negative: unit.negative })} data-testid="edit-keep">
              保留手改
            </Button>
            <Button size="xs" variant="ghost" onClick={reset} data-testid="edit-use-new">
              使用新的结果
            </Button>
          </div>
        </div>
      )}
      {edit && !unit.edit_stale && (
        <div className="flex flex-wrap items-center gap-1.5 text-[11.5px]" data-testid="edit-badge">
          <span className="rounded-md bg-amber-500/12 px-1.5 py-0.5 text-amber-700">已手改</span>
          {diff?.added.map((x) => (
            <span key={`+${x}`} className="rounded bg-success/10 px-1 font-mono text-success">
              + {x}
            </span>
          ))}
          {diff?.removed.map((x) => (
            <span key={`-${x}`} className="rounded bg-destructive/10 px-1 font-mono text-destructive line-through">
              {x}
            </span>
          ))}
          <Button size="xs" variant="ghost" className="ml-auto" onClick={reset} data-testid="edit-reset">
            <RotateCcw /> 恢复自动
          </Button>
        </div>
      )}
      <div>
        <FieldLabel hint="可以直接增删 tag，只改这一张；离开输入框时保存" right={<CopyButton text={pos} />}>
          正面
        </FieldLabel>
        <textarea value={pos} onChange={(e) => setPos(e.target.value)} onBlur={commit} rows={Math.min(12, Math.max(3, pos.split('\n').length + 1))} spellCheck={false} className={cn(box, edit && 'ring-amber-500/40')} data-testid="unit-positive" />
      </div>
      <div>
        <FieldLabel right={<CopyButton text={neg} />}>负面</FieldLabel>
        <textarea value={neg} onChange={(e) => setNeg(e.target.value)} onBlur={commit} rows={Math.min(6, Math.max(2, neg.split('\n').length + 1))} spellCheck={false} className={box} data-testid="unit-negative" />
      </div>
    </div>
  )
}

function tagDiff(a: string, b: string) {
  const ta = templateTags(a)
  const tb = templateTags(b)
  return { added: tb.filter((x) => !ta.includes(x)), removed: ta.filter((x) => !tb.includes(x)) }
}
