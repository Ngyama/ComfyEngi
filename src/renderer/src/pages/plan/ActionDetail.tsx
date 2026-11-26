// 人物动作 Prompt 条目（动作序列）的详细设置：引用的 Prompt、场景、镜头、主角色 / 第二角色服装、各尺寸张数、附加 Prompt、逐张预览与手改。
// 本动作的每张图都使用同一份 Prompt；动作、表情的变化由 Prompt 中的 Wildcard 与工作流负责，这里不再抽取姿态、表情或行为。

import { useMemo, useState } from 'react'
import { BookmarkPlus, Drama, ExternalLink, MapPin, Shirt, Users, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Disclosure, NumberStepper, PromptField } from '@/components/common'
import type { MaterialOption } from '@/lib/material-select'
import { templatesOf, useLib, useNav, usePlan } from '@/lib/stores'
import { actionLabel, hasMale, promptAnchors } from '@shared/action-prompts'
import { setItemSizes, sizeTotal } from '@shared/planner'
import { PLACEHOLDER_HELP } from '@shared/prompt'
import type { PlanUnit, TaskItem } from '@shared/types'
import { ActionPicker } from '../prompts/ActionPicker'
import { MaterialPicker } from './MaterialPicker'
import { CameraField, PickField, Section, SizeCards } from './PoseDetail'
import { SavePresetDialog } from './presets'
import { UnitPrompt } from './UnitPrompt'

type PickerKey = 'scene' | 'outfit' | 'outfit2'

export function ActionItemDetail({ index, units, error, onClose }: { index: number; units: PlanUnit[]; error?: string; onClose: () => void }) {
  const lib = useLib((s) => s.lib)
  const go = useNav((s) => s.go)
  const { task, update } = usePlan()
  const item = task?.data.items[index]
  const [picker, setPicker] = useState<PickerKey | null>(null)
  const [choosing, setChoosing] = useState(false)
  const [shown, setShown] = useState(0)
  const [saving, setSaving] = useState(false)
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
  const prompt = T(item.action_id)
  const valid = prompt?.kind === 'action'
  const label = valid ? actionLabel(prompt, (id) => T(id)) : '（Prompt 已删除）'
  const anchors = valid ? promptAnchors(prompt.positive) : null
  const male = !!anchors && hasMale(anchors)
  const char = lib?.characters.find((c) => c.id === charId)
  const char2 = char2Id ? lib?.characters.find((c) => c.id === char2Id) : undefined
  const second = male && !!char2
  const defaultScene = T(task.data.scene_id)
  const sized = !!item.sizes
  const total = sized ? sizeTotal(item.sizes) : item.count
  const unit = units[Math.min(shown, Math.max(0, units.length - 1))] ?? null

  const outfitOpts = (list: typeof outfits): MaterialOption[] => list.map((o) => ({ id: o.id, name: o.name, positive: o.positive }))
  const single = (v: number | null | undefined) => (v ? [v] : [])
  const pickers: Record<PickerKey, { title: string; items: MaterialOption[]; value: number[]; noneLabel?: string; onChange: (ids: number[]) => void; empty?: string; description?: string }> = {
    scene: { title: '场景', items: scenes, value: single(item.scene_id), noneLabel: defaultScene ? `任务默认：${defaultScene.name}` : '不指定', onChange: (ids) => set({ scene_id: ids[0] ?? null }), empty: '场景库为空，可在「素材库 → 场景」中添加' },
    outfit: { title: `主角色服装（${char?.name ?? ''}）`, items: outfitOpts(outfits), value: single(item.outfit_id), noneLabel: '不指定', onChange: (ids) => set({ outfit_id: ids[0] ?? null }), empty: charId ? '该角色还没有服装' : '先选择主角色', description: '服装 Prompt（服装 LoRA 的触发词）插在 1girl 之后、角色特征之后。LoRA 本身在 LoRA 配置中加载，不写入 Prompt。' },
    outfit2: { title: `第二角色服装（${char2?.name ?? ''}）`, items: outfitOpts(outfits2), value: single(item.second_outfit_id), noneLabel: '不指定', onChange: (ids) => set({ second_outfit_id: ids[0] ?? null }), description: '插在 1man 之后、第二角色特征之后。' },
  }
  const cur = picker ? pickers[picker] : null

  return (
    <div className="flex h-full flex-col" data-testid="action-detail">
      <div className="flex items-center gap-2 px-4 pt-4 pb-3">
        <span className="grid size-6 shrink-0 place-items-center rounded-md bg-tint/[0.07] text-xs font-semibold tabular-nums">{index + 1}</span>
        <span className="min-w-0 flex-1 truncate px-1 text-[15px] font-semibold" data-testid="detail-title">
          {label}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{total} 张</span>
        <Button variant="ghost" size="xs" onClick={() => setSaving(true)} title="把这个动作保存为预设，在其他任务中复用" data-testid="save-action-preset">
          <BookmarkPlus /> 保存为预设
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="关闭">
          <X />
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-6">
        {error && <div className="rounded-lg bg-destructive/10 px-3 py-2 text-[12px] text-destructive" data-testid="detail-error">{error}</div>}
        <Section title="人物动作" testId="detail-action">
          <PickField label="Prompt" icon={<Drama />} names={[label]} placeholder="选择 Prompt" onOpen={() => setChoosing(true)} testId="pick-action" hint="每张图都使用这份 Prompt；动作与表情的变化由 Prompt 中的 Wildcard 负责" />
          {valid && (
            <div className="rounded-lg bg-inset p-2.5">
              <pre className="max-h-40 overflow-y-auto font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-foreground/80 [overflow-wrap:anywhere] select-text" data-testid="action-body">
                {prompt.positive || '（空）'}
              </pre>
              <div className="mt-1.5 flex justify-end">
                <Button size="xs" variant="ghost" onClick={() => go('prompts', { actionId: prompt.id })} data-testid="edit-action">
                  <ExternalLink /> 在「动作 Prompt」中编辑
                </Button>
              </div>
            </div>
          )}
          <PickField label="场景" icon={<MapPin />} names={nameOf(item.scene_id, scenes)} placeholder={defaultScene ? `任务默认：${defaultScene.name}` : '不指定'} onOpen={() => setPicker('scene')} onClear={() => set({ scene_id: null })} testId="pick-scene" />
          <CameraField item={item} onChange={set} />
        </Section>

        <Section title="角色与服装" testId="detail-roles">
          <div className="text-[11.5px] font-medium text-muted-foreground" data-testid="role-main">
            主角色：{charId ? (char?.name ?? '（已删除）') : '先在页面顶部选择主角色'} · 特征与服装插在 1girl 之后
          </div>
          <PickField label="服装" icon={<Shirt />} names={nameOf(item.outfit_id, outfits)} placeholder="不指定" onOpen={() => setPicker('outfit')} onClear={() => set({ outfit_id: null })} testId="pick-outfit" />
          <div className="flex items-center gap-2 border-t border-tint/[0.06] pt-2.5">
            <Users className="size-3.5 text-muted-foreground" />
            <span className="text-[12.5px] font-medium" data-testid="role-second">
              第二角色
            </span>
            <span className="truncate text-[11.5px] text-muted-foreground" data-testid="second-state">
              {!valid ? '—' : !male ? 'Prompt 中没有 1man：单人画面，第二角色不出场' : char2 ? `${char2.name} 出场：特征与服装插在 1man 之后` : char2Id ? '第二角色已被删除' : '任务未选择第二角色：Prompt 中的男性部分原样保留'}
            </span>
          </div>
          {second && <PickField label="服装" icon={<Shirt />} names={nameOf(item.second_outfit_id, outfits2)} placeholder="不指定" onOpen={() => setPicker('outfit2')} onClear={() => set({ second_outfit_id: null })} testId="second-outfit" />}
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
          <Disclosure title="附加 Prompt" summary={item.extra_positive || item.extra_negative ? '已填写' : '本动作专用，接在正面 Prompt 末尾，可留空'}>
            <div className="space-y-2">
              <PromptField value={item.extra_positive} onChange={(v) => set({ extra_positive: v })} placeholder={`附加正面，可用占位符 ${PLACEHOLDER_HELP}`} minRows={2} />
              <PromptField value={item.extra_negative} onChange={(v) => set({ extra_negative: v })} placeholder="附加负面" minRows={2} />
            </div>
          </Disclosure>
          <Disclosure title="Prompt 预览" summary={unit ? `第 ${shown + 1} / ${units.length} 张${unit.width ? ` · ${unit.meta.size}` : ''}${item.prompt_edits?.length ? ` · 手改 ${item.prompt_edits.length} 张` : ''}` : '无法生成'}>
            {unit ? (
              <div className="space-y-3" data-testid="detail-preview">
                <div className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
                  <Button size="xs" variant="ghost" disabled={shown <= 0} onClick={() => setShown(shown - 1)}>
                    上一张
                  </Button>
                  <Button size="xs" variant="ghost" disabled={shown >= units.length - 1} onClick={() => setShown(shown + 1)} data-testid="preview-next">
                    下一张
                  </Button>
                  {unit.meta.camera && <span className="truncate">镜头 {unit.meta.camera}</span>}
                </div>
                <UnitPrompt unit={unit} item={item} onEdits={(e) => set({ prompt_edits: e })} />
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">此动作当前无法生成，请查看上方的提示。</div>
            )}
          </Disclosure>
        </Section>
      </div>

      {cur && (
        <MaterialPicker open={!!picker} onOpenChange={(o) => !o && setPicker(null)} title={cur.title} description={cur.description} items={cur.items} value={cur.value} noneLabel={cur.noneLabel} onChange={cur.onChange} empty={cur.empty} testId="material-picker" />
      )}
      <ActionPicker open={choosing} onOpenChange={setChoosing} value={item.action_id} onPick={(ids) => ids[0] && ids[0] !== item.action_id && set({ action_id: ids[0] })} title="更换人物动作 Prompt" />
      <SavePresetDialog open={saving} onOpenChange={setSaving} kind="action" from={index} to={index} defaultName={label} />
    </div>
  )
}
