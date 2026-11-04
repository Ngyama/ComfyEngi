// 体位的子体位选择：勾选子体位（包含其中现在和以后的全部模板），也可以展开子体位单独勾选模板。
// 添加动作的对话框与动作详情共用；顺序与素材库中体位的子体位、模板顺序相同。全部勾选时不保存任何设置（等于默认：全部子体位）。
// 张数按选中的子体位平分，子体位内的「模板 × 表情」组合轮流使用。

import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SearchBox } from '@/components/common'
import { templatesOf, useLib } from '@/lib/stores'
import { cn } from '@/lib/utils'
import { CATEGORY_BARS, cardTemplates, categoryColor, categoryLabel, categoryOrder, groupBySubposition, isPicked, pickedTemplates, splitSummary, templateCombos, templateExpressionIds, toggleCategory, toggleTemplate } from '@shared/card-templates'
import type { CardTemplatePick, Library, Template } from '@shared/types'
import { Section } from './PoseDetail'

/** 选中的子体位与组合数（序列中的动作卡片、详情摘要共用） */
export function subpositionsOf(lib: Library | null, card: Template, pick: CardTemplatePick | undefined) {
  const exprs = templatesOf(lib, 'expression')
  const picked = pickedTemplates(cardTemplates(card, lib?.templates ?? []), pick)
  const groups = groupBySubposition(card, picked)
  const combos = groups.reduce((n, g) => n + templateCombos(g.templates, card, (id) => exprs.find((e) => e.id === id)).combos.length, 0)
  return { names: groups.map((g) => categoryLabel(g.category)), combos, templates: picked.length }
}

export function SubpositionPicker({ card, pick, total, onChange }: { card: Template; pick: CardTemplatePick | undefined; total?: number; onChange: (p: CardTemplatePick | undefined) => void }) {
  const lib = useLib((s) => s.lib)
  const exprs = templatesOf(lib, 'expression')
  const getExpr = (id: number) => exprs.find((e) => e.id === id)
  const [open, setOpen] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const all = cardTemplates(card, lib?.templates ?? [])
  const order = categoryOrder(card.card, all).filter((c) => all.some((t) => (t.category ?? '') === c))
  const { names, combos } = subpositionsOf(lib, card, pick)
  const set = (p: CardTemplatePick) => onChange(Object.keys(p).length ? p : undefined)
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  const match = (t: Template) => !words.length || words.every((w) => `${t.name}\n${t.category}\n${t.positive}`.toLowerCase().includes(w))
  const summary = !names.length ? '没有选中子体位' : `${names.length} 个子体位 · ${combos} 种组合${total !== undefined ? ` · ${total} 张：${splitSummary(names.length, total)}` : ''}`
  return (
    <div className="space-y-1.5">
      <div className={cn('text-[11.5px]', names.length ? 'text-muted-foreground' : 'text-destructive')} data-testid="template-source-summary">
        {summary}
      </div>
      {!all.length && <div className="text-[11.5px] text-muted-foreground">这个体位还没有模板，请在「素材库 → 体位」中添加。</div>}
      {all.length > 8 && <SearchBox value={q} onChange={setQ} placeholder="搜索模板名称或 Prompt…" />}
      <div className="space-y-0.5">
        {order.map((c) => {
          const list = all.filter((t) => (t.category ?? '') === c)
          const hits = list.filter(match)
          if (!hits.length) return null
          const n = list.filter((t) => isPicked(t, pick)).length
          const k = templateCombos(list.filter((t) => isPicked(t, pick)), card, getExpr).combos.length
          const color = categoryColor(order, c)
          const expanded = open === c || words.length > 0
          return (
            <div key={c} data-testid="source-category" data-category={c}>
              <div className="flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-tint/[0.04]">
                <button type="button" className="text-muted-foreground" aria-label="展开" onClick={() => setOpen(open === c ? null : c)}>
                  {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                </button>
                <TriBox checked={n === list.length && n > 0} mixed={n > 0 && n < list.length} onChange={(v) => set(toggleCategory(all, pick, c, v))} testId="source-category-check" />
                <span className={cn('h-3 w-1 shrink-0 rounded-full', color >= 0 ? CATEGORY_BARS[color] : 'bg-tint/[0.2]')} />
                <span className="min-w-0 flex-1 cursor-pointer truncate text-[12.5px]" onClick={() => setOpen(open === c ? null : c)}>
                  {categoryLabel(c)}
                </span>
                <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                  {n}/{list.length} 个模板{n ? ` · ${k} 种` : ''}
                </span>
              </div>
              {expanded && (
                <div className="ml-7 space-y-0.5 pb-1">
                  {hits.map((t) => {
                    const ex = templateExpressionIds(t, card).length
                    return (
                      <label key={t.id} className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-0.5 text-[12px] hover:bg-tint/[0.04]" data-testid="source-template" title={t.positive}>
                        <input type="checkbox" checked={isPicked(t, pick)} onChange={(e) => set(toggleTemplate(all, pick, t, e.target.checked))} />
                        <span className="min-w-0 flex-1 truncate">{t.name || '（未命名）'}</span>
                        {ex > 0 && <span className="shrink-0 rounded bg-violet-500/10 px-1 text-[10.5px] text-violet-700">表情 ×{ex}</span>}
                      </label>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** 动作详情中的子体位选择（只对当前任务生效） */
export function TemplateSource({ card, pick, total, onChange }: { card: Template; pick: CardTemplatePick | undefined; total: number; onChange: (p: CardTemplatePick | undefined) => void }) {
  return (
    <Section
      title="子体位"
      right={
        pick ? (
          <Button size="xs" variant="ghost" onClick={() => onChange(undefined)} data-testid="template-source-reset">
            <RotateCcw /> 全部子体位
          </Button>
        ) : undefined
      }
      testId="template-source"
    >
      <SubpositionPicker card={card} pick={pick} total={total} onChange={onChange} />
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
