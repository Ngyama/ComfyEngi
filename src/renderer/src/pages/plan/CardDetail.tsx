// 动作卡条目的详细设置：日常只需要动作卡、服装、场景和各尺寸张数；局部姿态、表情、双人互动按动作卡保存的默认规则自动抽取。
// 「高级组合设置」默认折叠，可以按池覆盖规则或禁止某些素材，只对当前任务生效（不修改素材库中的动作卡），可一键恢复默认。

import { useMemo, useState } from 'react'
import { Camera, MapPin, RotateCcw, Shirt, Users, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CopyButton, Disclosure, FieldLabel, NumberStepper, PromptField } from '@/components/common'
import { CardPools, PickSources } from '@/components/card-pools'
import { api, call } from '@/lib/api'
import type { MaterialOption } from '@/lib/material-select'
import { reloadLib, templatesOf, useLib, usePlan } from '@/lib/stores'
import { cn } from '@/lib/utils'
import { effectiveRule, isSoloCard, normalizeRule } from '@shared/cards'
import { setItemSizes, sizeTotal } from '@shared/planner'
import { PLACEHOLDER_HELP } from '@shared/prompt'
import { CARD_POOLS, type CardPoolKey, type PlanUnit, type PoolRule, type TaskItem } from '@shared/types'
import { MaterialPicker } from './MaterialPicker'
import { CameraEditor, PickField, Section, SizeCards } from './PoseDetail'

type PickerKey = 'card' | 'scene' | 'camera' | 'outfit' | 'outfit2'

export function CardItemDetail({ index, units, onClose }: { index: number; units: PlanUnit[]; onClose: () => void }) {
  const lib = useLib((s) => s.lib)
  const { task, update } = usePlan()
  const item = task?.data.items[index]
  const [picker, setPicker] = useState<PickerKey | null>(null)
  const [shown, setShown] = useState(0)
  const cards = templatesOf(lib, 'position')
  const scenes = templatesOf(lib, 'scene')
  const cameras = templatesOf(lib, 'camera')
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
  const char = lib?.characters.find((c) => c.id === charId)
  const char2 = char2Id ? lib?.characters.find((c) => c.id === char2Id) : undefined
  const defaultScene = T(task.data.scene_id)
  const camera = T(item.camera_id)
  const sized = !!item.sizes
  const total = sized ? sizeTotal(item.sizes) : item.count
  const overridden = new Set(Object.keys(item.card_rules ?? {}) as CardPoolKey[])
  const tuned = overridden.size + (item.card_exclude?.length ? 1 : 0)
  const rules = Object.fromEntries(CARD_POOLS.map(({ key }) => [key, effectiveRule(card, item, key)])) as Record<CardPoolKey, PoolRule>
  const unit = units[Math.min(shown, Math.max(0, units.length - 1))] ?? null

  const newCamera = async () => {
    const r = await call(api['templates.save']({ kind: 'camera', name: `镜头 ${cameras.length + 1}`, positive: '' }))
    if (!r) return
    await reloadLib()
    set({ camera_id: r.id })
  }
  const setRule = (key: CardPoolKey, rule: PoolRule) => update((d) => (d.items[index].card_rules = { ...d.items[index].card_rules, [key]: normalizeRule(rule) }))
  const resetRule = (key: CardPoolKey) =>
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
  const pickers: Record<PickerKey, { title: string; items: MaterialOption[]; value: number[]; noneLabel?: string; onChange: (ids: number[]) => void; description?: string; empty?: string }> = {
    // 换成另一张动作卡时，本任务对原卡的覆盖不再适用
    card: { title: '动作卡', items: cards, value: single(item.card_id), onChange: (ids) => ids[0] && ids[0] !== item.card_id && update((d) => Object.assign(d.items[index], { card_id: ids[0], card_rules: undefined, card_exclude: undefined })), empty: '还没有动作卡，可在「素材库 → 动作卡」中添加' },
    scene: { title: '场景', items: scenes, value: single(item.scene_id), noneLabel: defaultScene ? `任务默认：${defaultScene.name}` : '不指定', onChange: (ids) => set({ scene_id: ids[0] ?? null }), empty: '场景库为空，可在「素材库 → 场景」中添加' },
    camera: { title: '镜头', items: cameras, value: single(item.camera_id), noneLabel: '不指定', onChange: (ids) => set({ camera_id: ids[0] ?? null }) },
    outfit: { title: `主角色服装（${char?.name ?? ''}）`, items: outfitOpts(outfits), value: single(item.outfit_id), noneLabel: '不指定', onChange: (ids) => set({ outfit_id: ids[0] ?? null }), empty: charId ? '该角色还没有服装' : '先选择主角色' },
    outfit2: { title: `第二角色服装（${char2?.name ?? ''}）`, items: outfitOpts(outfits2), value: single(item.second_outfit_id), noneLabel: '不指定', onChange: (ids) => set({ second_outfit_id: ids[0] ?? null }) },
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
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="关闭">
          <X />
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-6">
        <Section title="画面内容" testId="detail-scene">
          <PickField label="动作卡" names={nameOf(item.card_id, cards)} placeholder="选择动作卡" onOpen={() => setPicker('card')} testId="pick-card" hint={card ? '基础 Prompt、子体位、局部姿态、表情和互动按动作卡的默认规则自动组合' : undefined} />
          <PickField label="场景" icon={<MapPin />} names={nameOf(item.scene_id, scenes)} placeholder={defaultScene ? `任务默认：${defaultScene.name}` : '不指定'} onOpen={() => setPicker('scene')} onClear={() => set({ scene_id: null })} testId="pick-scene" />
          <PickField
            label="镜头"
            icon={<Camera />}
            names={nameOf(item.camera_id, cameras)}
            placeholder="不指定"
            onOpen={() => setPicker('camera')}
            onClear={() => set({ camera_id: null })}
            testId="pick-camera"
            hint={
              <button type="button" className="hover:text-foreground" onClick={() => void newCamera()}>
                + 新建镜头
              </button>
            }
          />
          {camera && <CameraEditor key={camera.id} t={camera} />}
        </Section>

        <Section title="角色配置" testId="detail-roles">
          <div className="text-[11.5px] font-medium text-muted-foreground" data-testid="role-main">
            主角色：{charId ? (char?.name ?? '（已删除）') : '先在页面顶部选择主角色'}
          </div>
          <PickField label="服装" icon={<Shirt />} names={nameOf(item.outfit_id, outfits)} placeholder="不指定" onOpen={() => setPicker('outfit')} onClear={() => set({ outfit_id: null })} testId="pick-outfit" />
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
          <Disclosure title="组合与 Prompt 预览" summary={unit ? `第 ${shown + 1} / ${units.length} 张${unit.width ? ` · ${unit.meta.size}` : ''}` : '无法生成'}>
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
                <PickSources picks={unit.meta.picks} card={unit.meta.card} />
                <div>
                  <FieldLabel right={<CopyButton text={unit.positive} />}>正面</FieldLabel>
                  <pre className="max-h-72 overflow-y-auto rounded-lg bg-inset p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap select-text">{unit.positive || '（空）'}</pre>
                </div>
                <div>
                  <FieldLabel right={<CopyButton text={unit.negative} />}>负面</FieldLabel>
                  <pre className="max-h-40 overflow-y-auto rounded-lg bg-inset p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap select-text">{unit.negative || '（空）'}</pre>
                </div>
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">此动作当前无法生成，请查看卡片上的提示。</div>
            )}
          </Disclosure>
        </Section>

        {card && (
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
              <div className="text-[11px] text-muted-foreground">修改只对当前任务生效。例如固定某个子体位、修改随机数量、关闭随机互动、临时固定某个局部姿态，或禁止某个表情被抽到。</div>
              <CardPools card={card} rules={rules} overridden={overridden} onRule={setRule} onReset={resetRule} exclude={item.card_exclude ?? []} onExclude={(ids) => set({ card_exclude: ids.length ? ids : undefined })} />
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
          testId="material-picker"
        />
      )}
    </div>
  )
}
