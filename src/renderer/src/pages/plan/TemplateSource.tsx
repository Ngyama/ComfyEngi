// 动作序列的模板来源：勾选分类（包含分类中现在和以后的全部模板），也可以展开分类单独勾选模板。
// 与素材库中动作卡的分类、模板顺序相同；全部勾选时不保存任何设置（等于默认：全部模板）。

import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useLib } from '@/lib/stores'
import { cn } from '@/lib/utils'
import { CATEGORY_BARS, cardTemplates, categoryColor, categoryLabel, categoryOrder, isPicked, pickedTemplates, toggleCategory, toggleTemplate } from '@shared/card-templates'
import type { CardTemplatePick, Template } from '@shared/types'
import { Section } from './PoseDetail'

export function TemplateSource({ card, pick, total, onChange }: { card: Template; pick: CardTemplatePick | undefined; total: number; onChange: (p: CardTemplatePick | undefined) => void }) {
  const lib = useLib((s) => s.lib)
  const [open, setOpen] = useState<string | null>(null)
  const all = cardTemplates(card, lib?.templates ?? [])
  const order = categoryOrder(card.card, all)
  const picked = pickedTemplates(all, pick)
  const set = (p: CardTemplatePick) => onChange(Object.keys(p).length ? p : undefined)
  const per = picked.length ? Math.floor(total / picked.length) : 0
  const rest = picked.length ? total % picked.length : 0
  const summary = !picked.length ? '没有选中模板' : `${picked.length} 个模板 · ${total} 张：每个模板 ${per}${rest ? `～${per + 1}` : ''} 张`
  return (
    <Section
      title="模板来源"
      right={
        pick ? (
          <Button size="xs" variant="ghost" onClick={() => onChange(undefined)} data-testid="template-source-reset">
            <RotateCcw /> 全部模板
          </Button>
        ) : undefined
      }
      testId="template-source"
    >
      <div className={cn('text-[11.5px]', picked.length ? 'text-muted-foreground' : 'text-destructive')} data-testid="template-source-summary">
        {summary}
      </div>
      {!all.length && <div className="text-[11.5px] text-muted-foreground">这张动作卡还没有模板，请在「素材库 → 动作卡」中添加。</div>}
      <div className="space-y-0.5">
        {order.map((c) => {
          const list = all.filter((t) => (t.category ?? '') === c)
          const n = list.filter((t) => isPicked(t, pick)).length
          const color = categoryColor(order, c)
          return (
            <div key={c} data-testid="source-category" data-category={c}>
              <div className="flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-tint/[0.04]">
                <button type="button" className="text-muted-foreground" aria-label="展开" onClick={() => setOpen(open === c ? null : c)}>
                  {open === c ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                </button>
                <TriBox checked={n === list.length && n > 0} mixed={n > 0 && n < list.length} onChange={(v) => set(toggleCategory(all, pick, c, v))} testId="source-category-check" />
                <span className={cn('h-3 w-1 rounded-full', color >= 0 ? CATEGORY_BARS[color] : 'bg-tint/[0.2]')} />
                <span className="min-w-0 flex-1 truncate text-[12.5px]" onClick={() => setOpen(open === c ? null : c)}>
                  {categoryLabel(c)}
                </span>
                <span className="text-[11px] text-muted-foreground tabular-nums">
                  {n}/{list.length}
                </span>
              </div>
              {open === c && (
                <div className="ml-7 space-y-0.5 pb-1">
                  {list.map((t) => (
                    <label key={t.id} className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-0.5 text-[12px] hover:bg-tint/[0.04]" data-testid="source-template">
                      <input type="checkbox" checked={isPicked(t, pick)} onChange={(e) => set(toggleTemplate(all, pick, t, e.target.checked))} />
                      <span className="min-w-0 flex-1 truncate">{t.name || '（未命名）'}</span>
                      {t.tags && <span className="shrink-0 rounded bg-violet-500/10 px-1 text-[10.5px] text-violet-700">{t.tags}</span>}
                    </label>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </Section>
  )
}

function TriBox({ checked, mixed, onChange, testId }: { checked: boolean; mixed: boolean; onChange: (v: boolean) => void; testId?: string }) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = mixed
  }, [mixed])
  return <input ref={ref} type="checkbox" checked={checked} onChange={() => onChange(!checked)} data-testid={testId} />
}
