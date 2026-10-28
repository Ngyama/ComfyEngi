// 动作详细设置：浮动在主界面右侧，点击其他卡片即可切换，修改即时生效并自动保存。
// 分三部分：画面内容（单人动作 / 双人主体位、子体位、行为、场景、镜头）、角色配置（主角色与第二角色的服装、动作、表情）、
// 生成设置（各尺寸张数、附加 Prompt、最终 Prompt 预览）。素材较多时不在面板中平铺，点击字段后在选择器中搜索选择。

import { useMemo, useState, type ReactNode } from 'react'
import { Camera, ChevronRight, Image as ImageIcon, MapPin, Minus, Plus, Shirt, Smile, Users, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Chip, CopyButton, Disclosure, FieldLabel, NumberStepper, PromptField, TextInput } from '@/components/common'
import { api, call } from '@/lib/api'
import { useDraft } from '@/lib/hooks'
import type { MaterialOption } from '@/lib/material-select'
import { reloadLib, templatesOf, useLib, usePlan } from '@/lib/stores'
import { cn } from '@/lib/utils'
import { setItemSizes, sizeCount, sizeTotal, stepSize } from '@shared/planner'
import { PLACEHOLDER_HELP } from '@shared/prompt'
import { SIZE_PRESETS, type PlanUnit, type SizeKey, type TaskItem, type Template } from '@shared/types'
import { MaterialPicker } from './MaterialPicker'

function MultiChips({ list, value, onChange }: { list: Template[]; value: number[]; onChange: (v: number[]) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {list.map((t) => {
        const on = value.includes(t.id)
        return (
          <Chip key={t.id} active={on} title={t.positive} onClick={() => onChange(on ? value.filter((x) => x !== t.id) : [...value, t.id])}>
            {t.name || '（未命名）'}
          </Chip>
        )
      })}
    </div>
  )
}

/** 详情中的一个字段：显示当前选择，点击打开选择器 */
function PickField({ label, icon, names, placeholder, onOpen, onClear, disabled, hint, testId }: { label: string; icon?: ReactNode; names: string[]; placeholder: string; onOpen: () => void; onClear?: () => void; disabled?: boolean; hint?: ReactNode; testId?: string }) {
  return (
    <div className="grid grid-cols-[88px_1fr] items-start gap-2">
      <div className="flex items-center gap-1 pt-2 text-[12px] text-muted-foreground [&_svg]:size-3">
        {icon}
        {label}
      </div>
      <div className="min-w-0">
        <div className="group flex min-h-9 items-center gap-1 rounded-lg bg-tint/[0.035] ring-1 ring-tint/[0.1] hover:bg-tint/[0.055] has-[button:disabled]:opacity-50">
          <button type="button" disabled={disabled} onClick={onOpen} data-testid={testId} className="flex min-h-9 min-w-0 flex-1 flex-wrap items-center gap-1 py-1 pl-2.5 text-left text-[13px]">
            {names.length ? (
              names.length === 1 ? (
                <span className="truncate">{names[0]}</span>
              ) : (
                names.map((n, i) => (
                  <span key={`${n}-${i}`} className="rounded-md bg-primary/10 px-1.5 py-0.5 text-[12px]">
                    {n}
                  </span>
                ))
              )
            ) : (
              <span className="text-muted-foreground">{placeholder}</span>
            )}
          </button>
          {onClear && names.length > 0 && !disabled ? (
            <button type="button" aria-label={`清除${label}`} className="mr-1 grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-tint/[0.08] hover:text-foreground" onClick={onClear}>
              <X className="size-3.5" />
            </button>
          ) : (
            <ChevronRight className="mr-2 size-3.5 shrink-0 text-muted-foreground" />
          )}
        </div>
        {hint && <div className="mt-1 text-[11px] text-muted-foreground">{hint}</div>}
      </div>
    </div>
  )
}

function Section({ title, right, children, testId }: { title: string; right?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <section className="rounded-xl bg-card p-3.5 ring-1 ring-tint/[0.07]" data-testid={testId}>
      <div className="mb-3 flex items-center gap-2">
        <span className="text-[13px] font-semibold">{title}</span>
        <div className="ml-auto">{right}</div>
      </div>
      <div className="space-y-2.5">{children}</div>
    </section>
  )
}

/** 尺寸示意：按长宽比画一个小框 */
const ASPECT: Record<SizeKey, string> = { portrait: 'h-6 w-4', landscape: 'h-4 w-6', square: 'size-5' }

/** 三种尺寸各自的张数：每次加减 5 张，最小 0，不能直接输入 */
function SizeCards({ item, onChange }: { item: TaskItem; onChange: (k: SizeKey, v: number) => void }) {
  return (
    <div className="grid grid-cols-3 gap-2" data-testid="size-cards">
      {SIZE_PRESETS.map((p) => {
        const n = sizeCount(item.sizes, p.key)
        return (
          <div key={p.key} data-testid={`size-${p.key}`} data-count={n} className={cn('rounded-xl p-2.5 ring-1 transition-colors', n ? 'bg-primary/[0.05] ring-primary/30' : 'bg-tint/[0.02] ring-tint/[0.08]')}>
            <div className="flex items-center gap-2">
              <span className="grid size-6 place-items-center">
                <span className={cn('rounded-[3px] border-[1.5px]', ASPECT[p.key], n ? 'border-primary/70 bg-primary/10' : 'border-muted-foreground/40')} />
              </span>
              <div className="min-w-0 leading-tight">
                <div className="text-[12.5px] font-medium">{p.label}</div>
                <div className="text-[10.5px] text-muted-foreground tabular-nums">
                  {p.width}×{p.height}
                </div>
              </div>
            </div>
            <div className="mt-2 flex items-center justify-between rounded-lg bg-tint/[0.04] ring-1 ring-tint/[0.08]">
              <button type="button" aria-label={`${p.label}减少 5 张`} disabled={!n} className="grid h-7 w-7 place-items-center text-muted-foreground hover:text-foreground disabled:opacity-30" onClick={() => onChange(p.key, stepSize(n, -1))}>
                <Minus className="size-3.5" />
              </button>
              <span className={cn('text-[13px] font-semibold tabular-nums', !n && 'text-muted-foreground')} data-testid={`size-${p.key}-count`}>
                {n}
              </span>
              <button type="button" aria-label={`${p.label}增加 5 张`} className="grid h-7 w-7 place-items-center text-muted-foreground hover:text-foreground" onClick={() => onChange(p.key, stepSize(n, 1))}>
                <Plus className="size-3.5" />
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** 编辑当前选中的镜头（镜头素材不在素材库中显示，在任务中直接新建和修改） */
function CameraEditor({ t }: { t: Template }) {
  const { draft, patch } = useDraft<Template>(t, t.id, async (v) => {
    await call(api['templates.save']({ id: v.id, _revision: v._revision, name: v.name, positive: v.positive } as never))
    await reloadLib()
  })
  if (!draft) return null
  return (
    <div className="space-y-2 rounded-lg bg-tint/[0.03] p-2.5">
      <TextInput value={draft.name} onChange={(v) => patch({ name: v })} placeholder="镜头名称" />
      <PromptField value={draft.positive} onChange={(v) => patch({ positive: v })} placeholder="镜头 Prompt（原样保存），例如 pov, from above" minRows={2} />
      <div className="text-[11px] text-muted-foreground">修改镜头会影响所有使用它的任务（已入队的不受影响）。</div>
    </div>
  )
}

type PickerKey = 'pose' | 'position' | 'sub' | 'acts' | 'scene' | 'camera' | 'outfit' | 'exprs' | 'outfit2' | 'pose2' | 'expr2'

export function PoseDetail({ index, firstUnit, onClose }: { index: number; firstUnit: PlanUnit | null; onClose: () => void }) {
  const lib = useLib((s) => s.lib)
  const { task, update } = usePlan()
  const item = task?.data.items[index]
  const [picker, setPicker] = useState<PickerKey | null>(null)
  const poses = templatesOf(lib, 'pose')
  const positions = templatesOf(lib, 'position')
  const subs = templatesOf(lib, 'subposition')
  const acts = templatesOf(lib, 'act')
  const scenes = templatesOf(lib, 'scene')
  const exprs = templatesOf(lib, 'expression')
  const cameras = templatesOf(lib, 'camera')
  const maleBaseId = task?.data.male_base_id ?? null
  const legacyMales = templatesOf(lib, 'male').filter((t) => t.id !== maleBaseId)
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
  const char = lib?.characters.find((c) => c.id === charId)
  const char2 = char2Id ? lib?.characters.find((c) => c.id === char2Id) : undefined
  const mainName = char?.name ?? '主角色'
  const duo = !!item.position_id
  const position = T(item.position_id)
  const sub = T(item.subposition_id)
  const title = duo ? (position ? (sub ? `${position.name} · ${sub.name}` : position.name) : '选择主体位') : (T(item.pose_id)?.name ?? '选择动作')
  const nExpr = item.expression_ids.length
  const sized = !!item.sizes
  const total = sized ? sizeTotal(item.sizes) : item.count
  const divisible = !nExpr || total % nExpr === 0
  const maleBase = T(maleBaseId)
  const defaultScene = T(task.data.scene_id)
  const actIds = item.act_ids ?? []
  const childSubs = position ? subs.filter((s) => s.parent_id === position.id) : []
  const camera = T(item.camera_id)
  // 旧任务的男性设置：只在该动作仍在使用时显示，便于查看或关闭；新任务使用第二角色
  const legacyMale = item.male_enabled || !!item.male_ids.length || !!(item.male_pose_ids ?? []).length || !!(item.male_expression_ids ?? []).length || !!item.male_extra
  const legacySelected = [...(item.male_pose_ids ?? []), ...(item.male_expression_ids ?? [])].map((id) => T(id)).filter((t): t is Template => !!t)
  const secondOn = !!item.second_enabled
  const multiNames = (ids: number[]) => ids.map((id) => T(id)?.name || '（已删除）')

  const newCamera = async () => {
    const r = await call(api['templates.save']({ kind: 'camera', name: `镜头 ${cameras.length + 1}`, positive: '' }))
    if (!r) return
    await reloadLib()
    set({ camera_id: r.id })
  }
  const pickPosition = (id: number) => {
    // 子体位从属于主体位：原子体位不属于新主体位时清除
    const keepSub = sub && sub.parent_id === id
    set({ position_id: id, subposition_id: keepSub ? item.subposition_id : null })
  }

  // 当前打开的选择器
  const outfitOpts = (list: typeof outfits): MaterialOption[] => list.map((o) => ({ id: o.id, name: o.name, positive: o.positive }))
  const single = (v: number | null | undefined) => (v ? [v] : [])
  const pickers: Record<PickerKey, { title: string; items: MaterialOption[]; value: number[]; multi?: boolean; numbered?: boolean; noneLabel?: string; onChange: (ids: number[]) => void; description?: string; empty?: string }> = {
    pose: {
      title: duo ? `主角色动作（${mainName}，可选）` : `单人动作（${mainName}）`,
      items: poses,
      value: single(item.pose_id),
      noneLabel: duo ? '不指定' : undefined,
      onChange: (ids) => set({ pose_id: ids[0] ?? null }),
      empty: '动作库为空，可在「素材库 → 动作」中添加',
    },
    position: { title: '主体位', items: positions, value: single(item.position_id), onChange: (ids) => ids[0] && pickPosition(ids[0]), description: '选择主体位后，可以再选择属于它的子体位。', empty: '还没有主体位，可在「素材库 → 动作 → 双人互动」中添加' },
    sub: { title: `子体位（${position?.name ?? ''}）`, items: childSubs, value: single(item.subposition_id), noneLabel: '不指定（只用主体位）', onChange: (ids) => set({ subposition_id: ids[0] ?? null }), description: '只列出属于当前主体位的子体位，补充在主体位之后。' },
    acts: { title: '行为（可叠加）', items: acts, value: actIds, multi: true, onChange: (ids) => set({ act_ids: ids }), description: '可多选，按点选顺序拼接；行为不绑定主体位。', empty: '还没有行为素材' },
    scene: { title: '场景', items: scenes, value: single(item.scene_id), noneLabel: defaultScene ? `任务默认：${defaultScene.name}` : '不指定', onChange: (ids) => set({ scene_id: ids[0] ?? null }), empty: '场景库为空，可在「素材库 → 场景」中添加' },
    camera: { title: '镜头', items: cameras, value: single(item.camera_id), noneLabel: '不指定', onChange: (ids) => set({ camera_id: ids[0] ?? null }) },
    outfit: { title: `主角色服装（${mainName}）`, items: outfitOpts(outfits), value: single(item.outfit_id), noneLabel: '不指定', onChange: (ids) => set({ outfit_id: ids[0] ?? null }), empty: charId ? '该角色还没有服装' : '先选择主角色' },
    exprs: { title: `主角色表情（${mainName}）`, items: exprs, value: item.expression_ids, multi: true, numbered: true, onChange: (ids) => set({ expression_ids: ids }), description: '可多选，总张数平均分配给各表情；序号为生成顺序。', empty: '表情库为空，可在素材库中添加' },
    outfit2: { title: `第二角色服装（${char2?.name ?? ''}）`, items: outfitOpts(outfits2), value: single(item.second_outfit_id), noneLabel: '不指定', onChange: (ids) => set({ second_outfit_id: ids[0] ?? null }) },
    pose2: { title: '第二角色动作', items: poses, value: single(item.second_pose_id), noneLabel: '不指定', onChange: (ids) => set({ second_pose_id: ids[0] ?? null }) },
    expr2: { title: '第二角色表情', items: exprs, value: single(item.second_expression_id), noneLabel: '不指定', onChange: (ids) => set({ second_expression_id: ids[0] ?? null }) },
  }
  const cur = picker ? pickers[picker] : null

  const modeToggle = (
    <div className="flex rounded-lg bg-tint/[0.045] p-0.5">
      {(
        [
          [false, '单人动作'],
          [true, '双人互动'],
        ] as const
      ).map(([isDuo, label]) => (
        <button
          key={label}
          type="button"
          data-active={duo === isDuo || undefined}
          disabled={isDuo && !positions.length}
          title={isDuo && !positions.length ? '先在「素材库 → 动作 → 双人互动」中添加主体位' : undefined}
          className="h-6 rounded-md px-2 text-[11.5px] text-muted-foreground disabled:opacity-40 data-[active]:bg-tint/[0.1] data-[active]:text-foreground"
          onClick={() => {
            if (duo === isDuo) return
            // 切到双人：保留单人动作作为主角色动作；切回单人：清除主体位、子体位与行为
            if (isDuo) set({ position_id: positions[0].id, subposition_id: null, ...(char2 ? { second_enabled: true } : {}) })
            else set({ position_id: null, subposition_id: null, act_ids: [] })
          }}
        >
          {label}
        </button>
      ))}
    </div>
  )

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-4 pt-4 pb-3">
        <span className="grid size-6 shrink-0 place-items-center rounded-md bg-tint/[0.07] text-xs font-semibold tabular-nums">{index + 1}</span>
        <span className="min-w-0 flex-1 truncate px-1 text-[15px] font-semibold" data-testid="detail-title">
          {title}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{total} 张</span>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="关闭">
          <X />
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-6">
        <Section title="画面内容" right={modeToggle} testId="detail-scene">
          {!duo ? (
            <PickField label="动作" names={nameOf(item.pose_id, poses)} placeholder="选择单人动作" onOpen={() => setPicker('pose')} testId="main-pose" />
          ) : (
            <>
              <PickField label="主体位" names={nameOf(item.position_id, positions)} placeholder="选择主体位" onOpen={() => setPicker('position')} testId="pick-position" />
              <PickField
                label="子体位"
                names={nameOf(item.subposition_id, subs)}
                placeholder={childSubs.length ? '不指定（只用主体位）' : '该主体位没有子体位'}
                disabled={!childSubs.length && !item.subposition_id}
                onOpen={() => setPicker('sub')}
                onClear={() => set({ subposition_id: null })}
                testId="pick-sub"
              />
              <PickField label="行为" names={multiNames(actIds)} placeholder={acts.length ? '可叠加，点击选择' : '还没有行为素材'} disabled={!acts.length && !actIds.length} onOpen={() => setPicker('acts')} onClear={() => set({ act_ids: [] })} testId="pick-acts" />
            </>
          )}
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
              <span className="flex gap-3">
                <button type="button" className="hover:text-foreground" onClick={() => void newCamera()}>
                  + 新建镜头
                </button>
              </span>
            }
          />
          {camera && <CameraEditor key={camera.id} t={camera} />}
        </Section>

        <Section title="角色配置" testId="detail-roles">
          <div className="text-[11.5px] text-muted-foreground">主角色：{charId ? mainName : '先在页面顶部选择主角色'}</div>
          <PickField label="服装" icon={<Shirt />} names={nameOf(item.outfit_id, outfits)} placeholder="不指定" onOpen={() => setPicker('outfit')} onClear={() => set({ outfit_id: null })} testId="pick-outfit" />
          {duo && <PickField label="动作" names={nameOf(item.pose_id, poses)} placeholder="不指定（可选）" onOpen={() => setPicker('pose')} onClear={() => set({ pose_id: null })} testId="main-pose" />}
          <PickField label="表情" icon={<Smile />} names={multiNames(item.expression_ids)} placeholder="未选择（使用空表情）" onOpen={() => setPicker('exprs')} onClear={() => set({ expression_ids: [] })} testId="pick-exprs" />
          {duo && !secondOn && <div className="text-[11px] text-warning">双人互动通常需要启用「第二角色」</div>}
          <div className="flex items-center gap-2 border-t border-tint/[0.06] pt-2.5">
            <Users className="size-3.5 text-muted-foreground" />
            <span className="text-[12.5px]">第二角色</span>
            <span className="truncate text-[11.5px] text-muted-foreground">{!char2 ? (char2Id ? '第二角色已被删除' : '任务未选择第二角色') : secondOn ? `${char2.name} 出场` : '单人画面'}</span>
            <Switch className="ml-auto" checked={secondOn} disabled={!char2 && !secondOn} onCheckedChange={(v) => set({ second_enabled: v })} aria-label="第二角色出场" data-testid="second-switch" />
          </div>
          {secondOn && char2 && (
            <>
              <PickField label="服装" icon={<Shirt />} names={nameOf(item.second_outfit_id, outfits2)} placeholder="不指定" onOpen={() => setPicker('outfit2')} onClear={() => set({ second_outfit_id: null })} testId="second-outfit" />
              <PickField label="动作" names={nameOf(item.second_pose_id, poses)} placeholder="不指定" onOpen={() => setPicker('pose2')} onClear={() => set({ second_pose_id: null })} testId="second-pose" />
              <PickField label="表情" icon={<Smile />} names={nameOf(item.second_expression_id, exprs)} placeholder="不指定" onOpen={() => setPicker('expr2')} onClear={() => set({ second_expression_id: null })} testId="second-expression" />
            </>
          )}
          {secondOn && !char2 && <div className="text-xs text-muted-foreground">在页面顶部的「第二角色」中选择一个角色后即可设置。</div>}
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
            <div className="space-y-2 rounded-xl bg-tint/[0.025] p-3 ring-1 ring-tint/[0.06]" data-testid="legacy-count">
              <div className="flex items-center gap-3">
                <NumberStepper value={item.count} onChange={(v) => set({ count: v })} />
                <span className="text-xs text-muted-foreground">张 · 使用工作流默认尺寸</span>
              </div>
              <div className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
                <ImageIcon className="size-3.5" />
                旧动作没有尺寸配置。
                <button type="button" className="text-primary hover:underline" data-testid="enable-sizes" onClick={() => update((d) => setItemSizes(d.items[index], { portrait: d.items[index].count }))}>
                  改用竖图 / 横图 / 方图设置
                </button>
              </div>
            </div>
          )}
          <div className={cn('text-xs', !total || !divisible ? 'text-destructive' : 'text-muted-foreground')} data-testid="count-hint">
            {!total
              ? '三种尺寸都为 0：本动作不会生成，不能加入队列'
              : !nExpr
                ? '未选择表情：使用空表情'
                : divisible
                  ? `${nExpr} 个表情，每个表情 ${total / nExpr} 张${sized ? '（在各尺寸间轮流分配）' : '，按选择顺序依次生成'}`
                  : `${total} 张不能被 ${nExpr} 个表情平均分配，请调整张数`}
          </div>
          <Disclosure title="附加 Prompt" summary={item.extra_positive || item.extra_negative ? '已填写' : '本动作专用，可留空'}>
            <div className="space-y-2">
              <PromptField value={item.extra_positive} onChange={(v) => set({ extra_positive: v })} placeholder={`附加正面，可用占位符 ${PLACEHOLDER_HELP}`} minRows={2} />
              <PromptField value={item.extra_negative} onChange={(v) => set({ extra_negative: v })} placeholder="附加负面" minRows={2} />
            </div>
          </Disclosure>
          <Disclosure title="最终 Prompt 预览" summary={firstUnit ? `本动作第 1 张${firstUnit.width ? ` · ${firstUnit.meta.size} ${firstUnit.width}×${firstUnit.height}` : ''}` : '无法生成'}>
            {firstUnit ? (
              <div className="space-y-3" data-testid="detail-preview">
                <div>
                  <FieldLabel right={<CopyButton text={firstUnit.positive} />}>正面</FieldLabel>
                  <pre className="max-h-72 overflow-y-auto rounded-lg bg-inset p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap select-text">{firstUnit.positive || '（空）'}</pre>
                </div>
                <div>
                  <FieldLabel right={<CopyButton text={firstUnit.negative} />}>负面</FieldLabel>
                  <pre className="max-h-40 overflow-y-auto rounded-lg bg-inset p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap select-text">{firstUnit.negative || '（空）'}</pre>
                </div>
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">此动作当前无法生成，请查看卡片上的提示。</div>
            )}
          </Disclosure>
        </Section>

        {legacyMale && (
          <Disclosure
            title="旧版男性设置"
            summary={item.male_enabled ? '已启用（兼容旧任务）' : '未启用'}
            open={item.male_enabled}
            right={<Switch checked={item.male_enabled} onCheckedChange={(v) => set({ male_enabled: v })} aria-label="旧版男性设置" />}
          >
            <div className="space-y-3">
              <div className="text-xs text-muted-foreground">
                旧任务中的男性描述，原样保留并继续生效。新任务请改用「第二角色」。男性基础描述：
                {maleBase ? <span className="text-foreground/80">{maleBase.name}</span> : '未设置'}
              </div>
              {legacyMales.length > 0 && <MultiChips list={legacyMales} value={item.male_ids} onChange={(v) => set({ male_ids: v })} />}
              {legacySelected.length > 0 && (
                <div>
                  <div className="mb-1.5 text-[11px] text-muted-foreground">男性动作 / 表情（点击移除）</div>
                  <MultiChips
                    list={legacySelected}
                    value={legacySelected.map((t) => t.id)}
                    onChange={(v) => set({ male_pose_ids: (item.male_pose_ids ?? []).filter((x) => v.includes(x)), male_expression_ids: (item.male_expression_ids ?? []).filter((x) => v.includes(x)) })}
                  />
                </div>
              )}
              <PromptField value={item.male_extra} onChange={(v) => set({ male_extra: v })} placeholder="男性附加 Prompt（本动作专用）" minRows={2} />
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
          multi={cur.multi}
          numbered={cur.numbered}
          noneLabel={cur.noneLabel}
          onChange={cur.onChange}
          empty={cur.empty}
          testId="material-picker"
        />
      )}
    </div>
  )
}
