// 动作卡的姿态模板选择：默认全部启用（之后新增的模板也会参与），可以取消不想用的模板。
// 添加动作的对话框与动作详情共用；顺序与素材库中动作卡的模板顺序相同。全部启用时不保存任何设置。
// 每张图从启用的模板中按组合 Seed 轮流抽取一个。

import { useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SearchBox } from '@/components/common'
import { useLib } from '@/lib/stores'
import { cn } from '@/lib/utils'
import { cardTemplates, isPicked, legacyPick, pickedTemplates, setPicked } from '@shared/card-templates'
import type { CardTemplatePick, Library, Template } from '@shared/types'
import { Section } from './PoseDetail'

/** 启用的姿态模板数量（序列中的动作卡片、详情摘要共用） */
export function posesOf(lib: Library | null, card: Template, pick: CardTemplatePick | undefined) {
  const all = cardTemplates(card, lib?.templates ?? [])
  const picked = pickedTemplates(all, pick)
  return { picked: picked.length, total: all.length, names: picked.map((t) => t.name || '（未命名）') }
}

export function PoseTemplatePicker({ card, pick, onChange }: { card: Template; pick: CardTemplatePick | undefined; onChange: (p: CardTemplatePick | undefined) => void }) {
  const lib = useLib((s) => s.lib)
  const [q, setQ] = useState('')
  const all = cardTemplates(card, lib?.templates ?? [])
  const { picked } = posesOf(lib, card, pick)
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  const match = (t: Template) => !words.length || words.every((w) => `${t.name}\n${t.positive}`.toLowerCase().includes(w))
  const hits = all.filter(match)
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span className={cn('text-[11.5px]', picked ? 'text-muted-foreground' : 'text-destructive')} data-testid="template-source-summary">
          {!all.length ? '这张动作卡还没有姿态模板' : picked ? `启用 ${picked} / ${all.length} 个姿态模板，每张图轮流抽取一个` : '没有启用任何姿态模板'}
        </span>
        {all.length > 1 && (
          <span className="ml-auto flex gap-1">
            <Button size="xs" variant="ghost" disabled={picked === all.length} onClick={() => onChange(setPicked(all, pick, all.map((t) => t.id), true))} data-testid="source-all">
              全选
            </Button>
            <Button size="xs" variant="ghost" disabled={!picked} onClick={() => onChange(setPicked(all, pick, all.map((t) => t.id), false))} data-testid="source-none">
              全不选
            </Button>
          </span>
        )}
      </div>
      {!all.length && <div className="text-[11.5px] text-muted-foreground">请在「素材库 → 动作卡」中添加姿态模板。</div>}
      {legacyPick(pick) && <div className="text-[11px] text-muted-foreground">这个动作沿用旧版按子体位的选择；修改任意勾选后会转换为排除列表，当前启用的模板不变。</div>}
      {all.length > 8 && <SearchBox value={q} onChange={setQ} placeholder="搜索姿态模板名称或 Prompt…" />}
      <div className="space-y-0.5">
        {hits.map((t) => (
          <label key={t.id} className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-[12.5px] hover:bg-tint/[0.04]" data-testid="source-template" title={t.positive}>
            <input type="checkbox" checked={isPicked(t, pick)} onChange={(e) => onChange(setPicked(all, pick, [t.id], e.target.checked))} />
            <span className="min-w-0 flex-1 truncate">{t.name || '（未命名）'}</span>
          </label>
        ))}
      </div>
    </div>
  )
}

/** 动作详情中的姿态模板选择（只对当前任务生效） */
export function TemplateSource({ card, pick, onChange }: { card: Template; pick: CardTemplatePick | undefined; onChange: (p: CardTemplatePick | undefined) => void }) {
  return (
    <Section
      title="姿态模板"
      right={
        pick ? (
          <Button size="xs" variant="ghost" onClick={() => onChange(undefined)} data-testid="template-source-reset">
            <RotateCcw /> 全部启用
          </Button>
        ) : undefined
      }
      testId="template-source"
    >
      <PoseTemplatePicker card={card} pick={pick} onChange={onChange} />
    </Section>
  )
}
