// 动作卡的素材池与抽取规则：素材库中编辑动作卡的默认设置，套图任务中按池覆盖（只对当前任务生效）。
// 每个池折叠为一行摘要，一次只展开一个，避免在主界面同时铺开所有素材池。

import { useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { NumberStepper } from '@/components/common'
import { cn } from '@/lib/utils'
import { MaterialPicker } from '@/pages/plan/MaterialPicker'
import { fixedConflicts, MAX_DRAW, normalizeRule, poolCandidates, poolsOf, ruleSummary } from '@shared/cards'
import { CARD_POOLS, DEFAULT_POOL_RULES, type CardPick, type CardPoolKey, type Library, type PoolMode, type PoolRule, type Template } from '@shared/types'
import { templatesOf, useLib } from '@/lib/stores'

const MODES: [PoolMode, string][] = [
  ['off', '关闭'],
  ['fixed', '固定'],
  ['random', '随机'],
]
const POOL_HINT: Record<CardPoolKey, string> = {
  variant: '候选为这张动作卡的全部子体位；随机 1 项即每张图片从中抽一个，0 项时只用基础 Prompt。',
  pose: '主角色自身的身体姿态和局部动作（包括手部动作），从「状态」素材中选择。',
  expr: '主角色的表情，从「表情」素材中选择。',
  interaction: '两个角色之间的互动（拥抱、接吻、牵手等），从「状态」素材中选择。',
  pose2: '第二角色的局部姿态，与主角色使用同一个状态库，只是允许的素材不同。',
  expr2: '第二角色的表情，从「表情」素材中选择。',
  extra: '不适合放入以上分类的补充 Prompt，可以不配置。',
}

/** 某个池可选择的全部素材（固定素材与候选从这里选） */
function sourceOf(lib: Library | null, card: Template, key: CardPoolKey): Template[] {
  const src = CARD_POOLS.find((p) => p.key === key)!.source
  if (src === 'variant') return templatesOf(lib, 'subposition').filter((t) => t.parent_id === card.id)
  return templatesOf(lib, src)
}

function Names({ ids, byId, empty, strike }: { ids: number[]; byId: Map<number, Template>; empty: string; strike?: Set<number> }) {
  if (!ids.length) return <span className="text-muted-foreground">{empty}</span>
  return (
    <span className="flex flex-wrap gap-1">
      {ids.map((id) => (
        <span key={id} className={cn('rounded-md bg-primary/10 px-1.5 py-0.5 text-[11.5px]', strike?.has(id) && 'bg-tint/[0.05] text-muted-foreground line-through')}>
          {byId.get(id)?.name || '（已删除）'}
        </span>
      ))}
    </span>
  )
}

function Field({ label, children, onClick, testId }: { label: string; children: ReactNode; onClick?: () => void; testId?: string }) {
  return (
    <div className="grid grid-cols-[72px_1fr] items-start gap-2">
      <div className="pt-1.5 text-[11.5px] text-muted-foreground">{label}</div>
      <button type="button" disabled={!onClick} onClick={onClick} data-testid={testId} className="min-h-8 rounded-lg bg-tint/[0.035] px-2 py-1 text-left text-[12.5px] ring-1 ring-tint/[0.1] enabled:hover:bg-tint/[0.055]">
        {children}
      </button>
    </div>
  )
}

/**
 * 素材池列表。
 * - 素材库（onCandidates）：编辑动作卡默认规则与候选素材；
 * - 套图任务（onExclude）：rules 为任务覆盖，exclude 为本任务禁止抽取的素材，可逐池恢复默认
 */
export function CardPools({
  card,
  rules,
  overridden,
  onRule,
  onReset,
  onCandidates,
  exclude,
  onExclude,
}: {
  card: Template
  /** 每个池当前生效的规则 */
  rules: Record<CardPoolKey, PoolRule>
  /** 套图任务：哪些池覆盖了动作卡默认规则 */
  overridden?: Set<CardPoolKey>
  onRule: (key: CardPoolKey, rule: PoolRule) => void
  onReset?: (key: CardPoolKey) => void
  onCandidates?: (key: CardPoolKey, ids: number[]) => void
  exclude?: number[]
  onExclude?: (ids: number[]) => void
}) {
  const lib = useLib((s) => s.lib)
  const [open, setOpen] = useState<CardPoolKey | null>(null)
  const [picker, setPicker] = useState<null | { key: CardPoolKey; what: 'fixed' | 'candidates' | 'exclude' }>(null)
  const byId = new Map((lib?.templates ?? []).map((t) => [t.id, t]))
  const variants = templatesOf(lib, 'subposition')
  const ex = new Set(exclude ?? [])
  const pools = poolsOf(!!card.card?.solo)
  const cur = picker ? pools.find((p) => p.key === picker.key)! : null
  const curRule = picker ? rules[picker.key] : null
  const curCands = picker ? poolCandidates(card, picker.key, variants) : []
  return (
    <div className="space-y-1.5" data-testid="card-pools">
      {pools.map(({ key, label }) => {
        const rule = rules[key]
        const cands = poolCandidates(card, key, variants)
        const isOpen = open === key
        const fixedT = (rule.fixed ?? []).map((id) => byId.get(id)).filter((t): t is Template => !!t)
        const conflicts = rule.mode === 'off' ? [] : fixedConflicts(fixedT)
        const nRandom = cands.filter((id) => !ex.has(id) && !(rule.fixed ?? []).includes(id)).length
        return (
          <div key={key} className={cn('rounded-xl bg-tint/[0.025] ring-1 ring-tint/[0.08]', isOpen && 'bg-tint/[0.04] ring-tint/[0.14]')} data-testid={`pool-${key}`}>
            <button type="button" className="flex h-10 w-full items-center gap-2 px-3 text-left" onClick={() => setOpen(isOpen ? null : key)}>
              {isOpen ? <ChevronDown className="size-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-4 shrink-0 text-muted-foreground" />}
              <span className="shrink-0 text-[13px] font-medium">{label}</span>
              <span className={cn('min-w-0 truncate text-xs text-muted-foreground', rule.mode === 'off' && 'opacity-60')} data-testid={`pool-${key}-summary`}>
                {ruleSummary(rule, nRandom)}
              </span>
              {overridden?.has(key) && <span className="ml-auto shrink-0 rounded-md bg-amber-500/12 px-1.5 py-0.5 text-[10.5px] text-amber-700">本任务已修改</span>}
              {conflicts.length > 0 && <span className={cn('shrink-0 text-[10.5px] text-warning', !overridden?.has(key) && 'ml-auto')}>互斥冲突</span>}
            </button>
            {isOpen && (
              <div className="space-y-2.5 px-3 pb-3">
                <div className="text-[11px] text-muted-foreground">{POOL_HINT[key]}</div>
                <div className="flex items-center gap-2">
                  <div className="flex rounded-lg bg-tint/[0.045] p-0.5">
                    {MODES.map(([m, l]) => (
                      <button
                        key={m}
                        type="button"
                        data-active={rule.mode === m || undefined}
                        data-testid={`pool-${key}-mode-${m}`}
                        className="h-6 rounded-md px-2.5 text-[11.5px] text-muted-foreground data-[active]:bg-tint/[0.1] data-[active]:text-foreground"
                        onClick={() => onRule(key, normalizeRule({ ...rule, mode: m }, DEFAULT_POOL_RULES[key]))}
                      >
                        {l}
                      </button>
                    ))}
                  </div>
                  {overridden?.has(key) && onReset && (
                    <Button size="xs" variant="ghost" className="ml-auto" onClick={() => onReset(key)}>
                      <RotateCcw /> 恢复此项默认
                    </Button>
                  )}
                </div>
                {rule.mode !== 'off' && (
                  <Field label="固定" onClick={() => setPicker({ key, what: 'fixed' })} testId={`pool-${key}-fixed`}>
                    <Names ids={rule.fixed ?? []} byId={byId} empty={rule.mode === 'fixed' ? '选择始终使用的素材' : '不固定（可选）'} />
                  </Field>
                )}
                {conflicts.map((c) => (
                  <div key={c} className="text-[11px] text-warning">
                    {c}：同时固定的素材都会加入 Prompt，请确认是否需要调整（不会自动修改）。
                  </div>
                ))}
                {rule.mode === 'random' && (
                  <>
                    <Field
                      label={onExclude ? '候选' : '候选素材'}
                      onClick={key === 'variant' && onCandidates ? undefined : () => setPicker({ key, what: onCandidates ? 'candidates' : 'exclude' })}
                      testId={`pool-${key}-candidates`}
                    >
                      <Names ids={cands} byId={byId} strike={ex} empty={key === 'variant' ? '还没有子体位' : onCandidates ? '点击选择允许随机抽取的素材（可批量添加）' : '动作卡没有配置候选素材'} />
                    </Field>
                    {onExclude && cands.some((id) => ex.has(id)) && <div className="pl-[80px] text-[11px] text-muted-foreground">划线的素材在本任务中不会被抽取。</div>}
                    <div className="flex items-center gap-2 pl-[80px] text-[12px] text-muted-foreground">
                      每张随机
                      <NumberStepper value={rule.min ?? 0} min={0} max={MAX_DRAW} onChange={(v) => onRule(key, normalizeRule({ ...rule, min: v, max: Math.max(v, rule.max ?? v) }))} />
                      ～
                      <NumberStepper value={rule.max ?? 0} min={0} max={MAX_DRAW} onChange={(v) => onRule(key, normalizeRule({ ...rule, max: v, min: Math.min(v, rule.min ?? v) }))} />
                      项
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )
      })}
      {cur && curRule && picker && (
        <MaterialPicker
          open
          onOpenChange={(o) => !o && setPicker(null)}
          title={`${cur.label} · ${picker.what === 'fixed' ? '固定素材' : picker.what === 'candidates' ? '候选素材' : '本任务禁止抽取'}`}
          description={
            picker.what === 'fixed'
              ? '固定素材总是加入每张图片（按点选顺序），不会再被随机抽到。'
              : picker.what === 'candidates'
                ? '只从这些素材中随机抽取（只保存素材 ID，修改素材库中的 Prompt 后新任务自动使用新内容）。可搜索后批量添加。'
                : '选中的素材在本任务中不会被随机抽取（只影响当前任务）。'
          }
          items={picker.what === 'exclude' ? curCands.map((id) => byId.get(id)).filter((t): t is Template => !!t) : sourceOf(lib, card, picker.key)}
          value={picker.what === 'fixed' ? (curRule.fixed ?? []) : picker.what === 'candidates' ? curCands : curCands.filter((id) => ex.has(id))}
          multi
          numbered={picker.what === 'fixed'}
          bulk={picker.what === 'candidates'}
          onChange={(ids) => {
            if (picker.what === 'fixed') onRule(picker.key, normalizeRule({ ...curRule, fixed: ids }))
            else if (picker.what === 'candidates') onCandidates?.(picker.key, ids)
            else onExclude?.([...(exclude ?? []).filter((id) => !curCands.includes(id)), ...ids])
          }}
          testId="material-picker"
        />
      )}
    </div>
  )
}

const POOL_LABEL = Object.fromEntries(CARD_POOLS.map((p) => [p.key, p.label])) as Record<CardPoolKey, string>

/** 一张图片实际使用的素材：按池列出，标明固定 / 随机（来自冻结的计划，与 Prompt 一致） */
export function PickSources({ picks, card }: { picks?: CardPick[]; card?: string }) {
  if (!card) return null
  const by = new Map<CardPoolKey, CardPick[]>()
  for (const p of picks ?? []) by.set(p.pool, [...(by.get(p.pool) ?? []), p])
  return (
    <div className="space-y-1 rounded-xl bg-tint/[0.025] p-2.5 text-[12px] ring-1 ring-tint/[0.07]" data-testid="pick-sources">
      <div className="flex gap-2">
        <span className="w-28 shrink-0 text-muted-foreground">动作卡基础</span>
        <span>{card}</span>
      </div>
      {[...by].map(([pool, list]) => (
        <div key={pool} className="flex gap-2">
          <span className="w-28 shrink-0 text-muted-foreground">{POOL_LABEL[pool] ?? pool}</span>
          <span className="flex flex-wrap gap-1">
            {list.map((p) => (
              <span key={p.id} className={cn('rounded-md px-1.5 py-0.5', p.random ? 'bg-violet-500/10 text-violet-700' : 'bg-tint/[0.06]')} title={p.random ? '随机抽取' : '固定'}>
                {p.name || '（未命名）'}
                <span className="ml-1 text-[10px] opacity-70">{p.random ? '随机' : '固定'}</span>
              </span>
            ))}
          </span>
        </div>
      ))}
      {!by.size && <div className="text-muted-foreground">本张没有从素材池加入素材（只用基础 Prompt）</div>}
    </div>
  )
}
