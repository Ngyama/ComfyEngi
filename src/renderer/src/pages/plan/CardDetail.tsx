// 动作卡条目（动作序列）的详细设置：动作卡与参与的姿态模板、服装、固定表情、行为候选、场景、镜头、各尺寸张数、附加 Prompt。
// 每张图从启用的姿态模板中轮流抽取一个；表情每张相同（需要两种表情时复制动作）；行为每张在「无」和各候选之间等概率抽取一个。
// 旧版素材池动作卡保留「高级组合设置」（按池覆盖规则，只对当前任务生效）。可以把这个动作保存为预设，在其他任务中复用。

import { useMemo, useState } from 'react'
import { BookmarkPlus, Heart, MapPin, RotateCcw, Shirt, Smile, Users, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Disclosure, NumberStepper, PromptField } from '@/components/common'
import { CardPools, PickSources } from '@/components/card-pools'
import type { MaterialOption } from '@/lib/material-select'
import { templatesOf, useLib, usePlan } from '@/lib/stores'
import { cn } from '@/lib/utils'
import { effectivePool, isSoloCard, normalizePool } from '@shared/cards'
import { isTemplateCard } from '@shared/card-templates'
import { setItemSizes, sizeTotal } from '@shared/planner'
import { PLACEHOLDER_HELP } from '@shared/prompt'
import { CARD_POOLS, type CardPoolKey, type PlanUnit, type PoolConfig, type TaskItem } from '@shared/types'
import { MaterialPicker } from './MaterialPicker'
import { CameraField, PickField, Section, SizeCards } from './PoseDetail'
import { TemplateSource } from './TemplateSource'
import { UnitPrompt } from './UnitPrompt'
import { SavePresetDialog } from './presets'

type PickerKey = 'card' | 'scene' | 'outfit' | 'outfit2' | 'expression' | 'expression2' | 'behavior'

export function CardItemDetail({ index, units, onClose }: { index: number; units: PlanUnit[]; onClose: () => void }) {
  const lib = useLib((s) => s.lib)
  const { task, update } = usePlan()
  const item = task?.data.items[index]
  const [picker, setPicker] = useState<PickerKey | null>(null)
  const [shown, setShown] = useState(0)
  const [saving, setSaving] = useState(false)
  const cards = templatesOf(lib, 'position')
  const exprs = templatesOf(lib, 'expression')
  const states = templatesOf(lib, 'state')
  const scenes = templatesOf(lib, 'scene')
  const charId = task?.data.character_id
  const char2Id = task?.data.second_character_id ?? null
  const outfits = useMemo(() => (lib?.outfits ?? []).filter((o) => o.character_id === charId), [lib, charId])
  const outfits2 = useMemo(() => (lib?.outfits ?? []).filter((o) => o.character_id === char2Id), [lib, char2Id])
  if (!task || !item) return null

  const set = (patch: Partial<TaskItem>) => update((d) => Object.assign(d.items[index], patch))
  const T = (id: number | null | undefined) => (id ? lib?.templates.find((t) => t.id === id) : undefined)
  const nameOf = (id: number | null | undefined, list: { id: number; name: string }[]) => {
    if (!id) return []
    const t = list.find((x) => x.id === id)
    return [t ? t.name || '（未命名）' : '（已删除）']
  }
  const card = T(item.card_id)
  const solo = isSoloCard(card)
  const templated = isTemplateCard(card)
  const char = lib?.characters.find((c) => c.id === charId)
  const char2 = char2Id ? lib?.characters.find((c) => c.id === char2Id) : undefined
  const defaultScene = T(task.data.scene_id)
  const sized = !!item.sizes
  const total = sized ? sizeTotal(item.sizes) : item.count
  const overridden = new Set(Object.keys(item.card_rules ?? {}) as CardPoolKey[])
  const tuned = overridden.size + (item.card_exclude?.length ? 1 : 0)
  const pools = Object.fromEntries(CARD_POOLS.map(({ key }) => [key, effectivePool(card, item, key)])) as Record<CardPoolKey, PoolConfig>
  const unit = units[Math.min(shown, Math.max(0, units.length - 1))] ?? null

  const setPool = (key: CardPoolKey, pool: PoolConfig) => update((d) => (d.items[index].card_rules = { ...d.items[index].card_rules, [key]: normalizePool(pool, key) }))
  const resetPool = (key: CardPoolKey) =>
    update((d) => {
      const it = d.items[index]
      const next = { ...it.card_rules }
      delete next[key]
      if (Object.keys(next).length) it.card_rules = next
      else delete it.card_rules
    })
  const restore = () =>
    update((d) => {
      delete d.items[index].card_rules
      delete d.items[index].card_exclude
    })

  const outfitOpts = (list: typeof outfits): MaterialOption[] => list.map((o) => ({ id: o.id, name: o.name, positive: o.positive }))
  const single = (v: number | null | undefined) => (v ? [v] : [])
  const pickers: Record<PickerKey, { title: string; items: MaterialOption[]; value: number[]; noneLabel?: string; onChange: (ids: number[]) => void; description?: string; empty?: string; multi?: boolean }> = {
    // 换成另一张动作卡时，本任务对原卡的覆盖不再适用
    card: { title: '动作卡', items: cards, value: single(item.card_id), onChange: (ids) => ids[0] && ids[0] !== item.card_id && update((d) => Object.assign(d.items[index], { card_id: ids[0], card_rules: undefined, card_exclude: undefined, card_pick: undefined })), empty: '还没有动作卡，可在「素材库 → 动作卡」中添加' },
    scene: { title: '场景', items: scenes, value: single(item.scene_id), noneLabel: defaultScene ? `任务默认：${defaultScene.name}` : '不指定', onChange: (ids) => set({ scene_id: ids[0] ?? null }), empty: '场景库为空，可在「素材库 → 场景」中添加' },
    outfit: { title: `主角色服装（${char?.name ?? ''}）`, items: outfitOpts(outfits), value: single(item.outfit_id), noneLabel: '不指定', onChange: (ids) => set({ outfit_id: ids[0] ?? null }), empty: charId ? '该角色还没有服装' : '先选择主角色' },
    outfit2: { title: `第二角色服装（${char2?.name ?? ''}）`, items: outfitOpts(outfits2), value: single(item.second_outfit_id), noneLabel: '不指定', onChange: (ids) => set({ second_outfit_id: ids[0] ?? null }) },
    expression: { title: '主角色表情', items: exprs, value: single(item.expression_id), noneLabel: '不加表情', onChange: (ids) => set({ expression_id: ids[0] ?? null }), description: '本动作的每张图都使用这个表情，写入模板中 {表情} 的位置。需要两种表情时复制这个动作，分别选择。', empty: '表情库为空，可在「素材库 → 表情」中添加' },
    expression2: { title: `第二角色表情（${char2?.name ?? ''}）`, items: exprs, value: single(item.second_expression_id), noneLabel: '不加表情', onChange: (ids) => set({ second_expression_id: ids[0] ?? null }), description: '写入模板中 {男表情} 的位置（没有时写在 {男服装} 之后）。', empty: '表情库为空，可在「素材库 → 表情」中添加' },
    behavior: { title: '行为候选', items: states, value: item.behavior_ids ?? [], multi: true, onChange: (ids) => set({ behavior_ids: ids.length ? ids : undefined }), description: '每张图在「无行为」和这些候选之间等概率抽取一个（最多一个），写入模板中 {行为} 的位置。不选则不加行为。', empty: '还没有状态素材，可在「素材库 → 状态」中添加（例如 Kiss、Hug）' },
  }
  const cur = picker ? pickers[picker] : null

  return (
    <div className="flex h-full flex-col" data-testid="card-detail">
      <div className="flex items-center gap-2 px-4 pt-4 pb-3">
        <span className="grid size-6 shrink-0 place-items-center rounded-md bg-tint/[0.07] text-xs font-semibold tabular-nums">{index + 1}</span>
        <span className="min-w-0 flex-1 truncate px-1 text-[15px] font-semibold" data-testid="detail-title">
          {card?.name ?? '（动作卡已删除）'}
        </span>
        {card && <span className={cn('shrink-0 rounded-md px-1.5 py-0.5 text-[10.5px]', solo ? 'bg-emerald-500/10 text-emerald-700' : 'bg-sky-500/10 text-sky-700')}>{solo ? '单人' : '双人'}</span>}
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{total} 张</span>
        <Button variant="ghost" size="xs" onClick={() => setSaving(true)} title="把这个动作序列保存为预设，在其他任务中复用" data-testid="save-action-preset">
          <BookmarkPlus /> 保存为预设
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="关闭">
          <X />
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-6">
        <Section title="画面内容" testId="detail-scene">
          <PickField label="动作卡" names={nameOf(item.card_id, cards)} placeholder="选择动作卡" onOpen={() => setPicker('card')} testId="pick-card" hint={card ? (templated ? '每张图从下方启用的姿态模板中轮流抽取一个' : '旧版动作卡：基础 Prompt、子体位、局部姿态、表情和互动按动作卡的默认规则自动组合') : undefined} />
          {templated && (
            <PickField
              label="行为"
              icon={<Heart />}
              names={(item.behavior_ids ?? []).map((id) => T(id)?.name ?? '（已删除）')}
              placeholder="不加行为"
              onOpen={() => setPicker('behavior')}
              onClear={() => set({ behavior_ids: undefined })}
              testId="pick-behavior"
              hint={item.behavior_ids?.length ? `每张在「无」和 ${item.behavior_ids.length} 个候选之间随机抽取一个` : undefined}
            />
          )}
          <PickField label="场景" icon={<MapPin />} names={nameOf(item.scene_id, scenes)} placeholder={defaultScene ? `任务默认：${defaultScene.name}` : '不指定'} onOpen={() => setPicker('scene')} onClear={() => set({ scene_id: null })} testId="pick-scene" />
          <CameraField item={item} onChange={set} />
        </Section>

        <Section title="角色配置" testId="detail-roles">
          <div className="text-[11.5px] font-medium text-muted-foreground" data-testid="role-main">
            主角色：{charId ? (char?.name ?? '（已删除）') : '先在页面顶部选择主角色'}
          </div>
          <PickField label="服装" icon={<Shirt />} names={nameOf(item.outfit_id, outfits)} placeholder="不指定" onOpen={() => setPicker('outfit')} onClear={() => set({ outfit_id: null })} testId="pick-outfit" />
          {templated && <PickField label="表情" icon={<Smile />} names={nameOf(item.expression_id, exprs)} placeholder="不加表情" onOpen={() => setPicker('expression')} onClear={() => set({ expression_id: null })} testId="pick-expression" hint="本动作每张图使用同一个表情" />}
          <div className="flex items-center gap-2 border-t border-tint/[0.06] pt-2.5">
            <Users className="size-3.5 text-muted-foreground" />
            <span className="text-[12.5px] font-medium" data-testid="role-second">
              第二角色
            </span>
            <span className="truncate text-[11.5px] text-muted-foreground" data-testid="second-state">
              {solo ? '单人动作卡：不加入第二角色及其服装、姿态、表情' : char2 ? `${char2.name} 出场` : char2Id ? '第二角色已被删除' : '任务未选择第二角色：只加入第二角色的姿态与表情素材'}
            </span>
          </div>
          {!solo && char2 && <PickField label="服装" icon={<Shirt />} names={nameOf(item.second_outfit_id, outfits2)} placeholder="不指定" onOpen={() => setPicker('outfit2')} onClear={() => set({ second_outfit_id: null })} testId="second-outfit" />}
          {templated && !solo && char2 && <PickField label="表情" icon={<Smile />} names={nameOf(item.second_expression_id, exprs)} placeholder="不加表情" onOpen={() => setPicker('expression2')} onClear={() => set({ second_expression_id: null })} testId="second-expression" />}
        </Section>

        <Section title="生成设置" right={<span className="text-xs text-muted-foreground tabular-nums">本动作共 {total} 张</span>} testId="detail-generate">
          {sized ? (
            <SizeCards
              item={item}
              onChange={(k, v) =>
                update((d) => {
                  const it = d.items[index]
                  setItemSizes(it, { ...it.sizes, [k]: v })
                })
              }
            />
          ) : (
            <div className="flex items-center gap-3" data-testid="legacy-count">
              <NumberStepper value={item.count} onChange={(v) => set({ count: v })} />
              <span className="text-xs text-muted-foreground">张 · 使用工作流默认尺寸</span>
            </div>
          )}
          {!total && <div className="text-xs text-destructive">三种尺寸都为 0：本动作不会生成，不能加入队列</div>}
          <Disclosure title="附加 Prompt" summary={item.extra_positive || item.extra_negative ? '已填写' : '本动作专用，可留空'}>
            <div className="space-y-2">
              <PromptField value={item.extra_positive} onChange={(v) => set({ extra_positive: v })} placeholder={`附加正面，可用占位符 ${PLACEHOLDER_HELP}`} minRows={2} />
              <PromptField value={item.extra_negative} onChange={(v) => set({ extra_negative: v })} placeholder="附加负面" minRows={2} />
            </div>
          </Disclosure>
          <Disclosure title="组合与 Prompt 预览" summary={unit ? `第 ${shown + 1} / ${units.length} 张${unit.width ? ` · ${unit.meta.size}` : ''}${item.prompt_edits?.length ? ` · 手改 ${item.prompt_edits.length} 张` : ''}` : '无法生成'}>
            {unit ? (
              <div className="space-y-3" data-testid="detail-preview">
                <div className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
                  <Button size="xs" variant="ghost" disabled={shown <= 0} onClick={() => setShown(shown - 1)}>
                    上一张
                  </Button>
                  <Button size="xs" variant="ghost" disabled={shown >= units.length - 1} onClick={() => setShown(shown + 1)} data-testid="preview-next">
                    下一张
                  </Button>
                  <span>组合 Seed {unit.meta.combo_seed}（在任务设置中修改）</span>
                </div>
                <PickSources picks={unit.meta.picks} card={unit.meta.card} camera={unit.meta.camera} />
                <UnitPrompt unit={unit} item={item} onEdits={(e) => set({ prompt_edits: e })} />
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">此动作当前无法生成，请查看卡片上的提示。</div>
            )}
          </Disclosure>
        </Section>

        {card && templated && <TemplateSource card={card} pick={item.card_pick} onChange={(p) => set({ card_pick: p })} />}

        {card && !templated && (
          <Disclosure
            title="高级组合设置"
            summary={tuned ? `本任务已修改 ${tuned} 项` : '使用动作卡的默认设置'}
            right={
              tuned ? (
                <Button size="xs" variant="ghost" onClick={restore} data-testid="card-restore">
                  <RotateCcw /> 恢复动作卡默认设置
                </Button>
              ) : undefined
            }
          >
            <div className="space-y-2" data-testid="card-advanced">
              <div className="text-[11px] text-muted-foreground">修改只对当前任务生效。例如把某个子体位或局部姿态拖到固定栏，或移除不想被抽到的随机候选。</div>
              <CardPools card={card} pools={pools} overridden={overridden} onPool={setPool} onReset={resetPool} exclude={item.card_exclude ?? []} onExclude={(ids) => set({ card_exclude: ids.length ? ids : undefined })} />
            </div>
          </Disclosure>
        )}
      </div>

      {cur && (
        <MaterialPicker
          open={!!picker}
          onOpenChange={(o) => !o && setPicker(null)}
          title={cur.title}
          description={cur.description}
          items={cur.items}
          value={cur.value}
          noneLabel={cur.noneLabel}
          onChange={cur.onChange}
          empty={cur.empty}
          multi={cur.multi}
          numbered={cur.multi}
          testId="material-picker"
        />
      )}
      <SavePresetDialog open={saving} onOpenChange={setSaving} kind="action" from={index} to={index} defaultName={[card?.name, nameOf(item.expression_id, exprs)[0]].filter(Boolean).join(' · ')} />
    </div>
  )
}
