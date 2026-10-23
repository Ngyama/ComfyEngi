// 动作详细设置：浮动在主界面右侧，点击其他卡片即可切换，修改即时生效并自动保存。
// 每个动作：单人动作，或双人主体位 + 子体位（行为可叠加）；主角色与第二角色各自的服装、动作、表情在这里分配；场景、镜头。

import { useMemo, useState } from 'react'
import { Camera, ChevronsUpDown, MapPin, Plus, Shirt, Smile, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { Chip, CopyButton, Disclosure, FieldLabel, NumberStepper, PromptField, SearchBox, TextInput } from '@/components/common'
import { api, call } from '@/lib/api'
import { matchesName, useDraft } from '@/lib/hooks'
import { reloadLib, templatesOf, useLib, usePlan } from '@/lib/stores'
import { cn } from '@/lib/utils'
import { PLACEHOLDER_HELP } from '@shared/prompt'
import type { Outfit, PlanUnit, TaskItem, Template } from '@shared/types'

/** 可搜索的单选（动作 / 表情） */
function TemplateCombo({ list, value, onPick, placeholder, allowNone, testId }: { list: Template[]; value: number | null | undefined; onPick: (id: number | null) => void; placeholder: string; allowNone?: boolean; testId?: string }) {
  const [open, setOpen] = useState(false)
  const cur = list.find((t) => t.id === value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" data-testid={testId} className="flex h-9 w-full items-center gap-1.5 rounded-lg bg-tint/[0.04] px-3 text-left text-[13px] ring-1 ring-tint/[0.112] hover:bg-tint/[0.06]">
          <span className={cn('truncate', !cur && 'text-muted-foreground')}>{cur?.name ?? placeholder}</span>
          <ChevronsUpDown className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <Command>
          <CommandInput placeholder="搜索名称…" />
          <CommandList>
            <CommandEmpty>没有匹配的素材</CommandEmpty>
            {allowNone && (
              <CommandItem value="__none__" onSelect={() => (onPick(null), setOpen(false))}>
                <span className="text-muted-foreground">不指定</span>
              </CommandItem>
            )}
            {list.map((p) => (
              <CommandItem key={p.id} value={`${p.name} ${p.id}`} onSelect={() => (onPick(p.id), setOpen(false))}>
                <span className="truncate">{p.name || '（未命名）'}</span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function MultiChips({ list, value, onChange, numbered }: { list: Template[]; value: number[]; onChange: (v: number[]) => void; numbered?: boolean }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {list.map((t) => {
        const n = value.indexOf(t.id)
        return (
          <Chip key={t.id} active={n >= 0} order={numbered && n >= 0 && value.length > 1 ? n + 1 : undefined} title={t.positive} onClick={() => onChange(n >= 0 ? value.filter((x) => x !== t.id) : [...value, t.id])}>
            {t.name || '（未命名）'}
          </Chip>
        )
      })}
    </div>
  )
}

function OutfitChips({ outfits, value, onPick }: { outfits: Outfit[]; value: number | null | undefined; onPick: (id: number | null) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      <Chip active={!value} onClick={() => onPick(null)}>
        不指定
      </Chip>
      {outfits.map((o) => (
        <Chip key={o.id} active={value === o.id} onClick={() => onPick(o.id)} title={o.positive}>
          {o.name || '（未命名）'}
        </Chip>
      ))}
    </div>
  )
}

const Sub = ({ children }: { children: React.ReactNode }) => <div className="mb-1.5 text-[11px] text-muted-foreground">{children}</div>

/** 编辑当前选中的镜头（镜头素材不在素材库中显示，在任务中直接新建和修改） */
function CameraEditor({ t }: { t: Template }) {
  const { draft, patch } = useDraft<Template>(t, t.id, async (v) => {
    await call(api['templates.save']({ id: v.id, _revision: v._revision, name: v.name, positive: v.positive } as never))
    await reloadLib()
  })
  if (!draft) return null
  return (
    <div className="mt-3 space-y-2 rounded-lg bg-tint/[0.03] p-2.5">
      <TextInput value={draft.name} onChange={(v) => patch({ name: v })} placeholder="镜头名称" />
      <PromptField value={draft.positive} onChange={(v) => patch({ positive: v })} placeholder="镜头 Prompt（原样保存），例如 pov, from above" minRows={2} />
      <div className="text-[11px] text-muted-foreground">修改镜头会影响所有使用它的任务（已入队的不受影响）。</div>
    </div>
  )
}

export function PoseDetail({ index, firstUnit, onClose }: { index: number; firstUnit: PlanUnit | null; onClose: () => void }) {
  const lib = useLib((s) => s.lib)
  const { task, update } = usePlan()
  const item = task?.data.items[index]
  const [exprQ, setExprQ] = useState('')
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
  const char = lib?.characters.find((c) => c.id === charId)
  const char2 = char2Id ? lib?.characters.find((c) => c.id === char2Id) : undefined
  const mainName = char?.name ?? '主角色'
  const duo = !!item.position_id
  const position = T(item.position_id)
  const sub = T(item.subposition_id)
  const title = duo ? (position ? (sub ? `${position.name} · ${sub.name}` : position.name) : '选择主体位') : (T(item.pose_id)?.name ?? '选择动作')
  const nExpr = item.expression_ids.length
  const divisible = !nExpr || item.count % nExpr === 0
  const shownExprs = exprs.filter((e) => matchesName(e, exprQ))
  const maleBase = T(maleBaseId)
  const defaultScene = T(task.data.scene_id)
  const actIds = item.act_ids ?? []
  const childSubs = position ? subs.filter((s) => s.parent_id === position.id) : []
  const camera = T(item.camera_id)
  // 旧任务的男性设置：只在该动作仍在使用时显示，便于查看或关闭；新任务使用第二角色
  const legacyMale = item.male_enabled || !!item.male_ids.length || !!(item.male_pose_ids ?? []).length || !!(item.male_expression_ids ?? []).length || !!item.male_extra
  const legacySelected = [...(item.male_pose_ids ?? []), ...(item.male_expression_ids ?? [])].map((id) => T(id)).filter((t): t is Template => !!t)
  const secondOn = !!item.second_enabled

  const newCamera = async () => {
    const r = await call(api['templates.save']({ kind: 'camera', name: `镜头 ${cameras.length + 1}`, positive: '' }))
    if (!r) return
    await reloadLib()
    set({ camera_id: r.id })
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-4 pt-4 pb-3">
        <span className="grid size-6 shrink-0 place-items-center rounded-md bg-tint/[0.07] text-xs font-semibold tabular-nums">{index + 1}</span>
        <span className="min-w-0 flex-1 truncate px-1 text-[15px] font-semibold" data-testid="detail-title">
          {title}
        </span>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="关闭">
          <X />
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 pb-6">
        {/* 动作 */}
        <section>
          <FieldLabel
            right={
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
            }
          >
            动作
          </FieldLabel>
          {!duo ? (
            <>
              <Sub>主角色动作（{mainName}）</Sub>
              <TemplateCombo list={poses} value={item.pose_id} onPick={(id) => set({ pose_id: id })} placeholder="选择单人动作" testId="main-pose" />
            </>
          ) : (
            <div className="space-y-3">
              <div>
                <Sub>主体位</Sub>
                <div className="flex flex-wrap gap-1.5">
                  {positions.map((p) => (
                    <Chip key={p.id} active={item.position_id === p.id} title={p.positive} onClick={() => set({ position_id: p.id, subposition_id: null })}>
                      {p.name || '（未命名）'}
                    </Chip>
                  ))}
                  {!positions.length && <span className="text-xs text-muted-foreground">还没有主体位，可在「素材库 → 动作 → 双人互动」中添加</span>}
                </div>
              </div>
              {childSubs.length > 0 && (
                <div>
                  <Sub>子体位（补充在主体位之后）</Sub>
                  <div className="flex flex-wrap gap-1.5">
                    <Chip active={!item.subposition_id} onClick={() => set({ subposition_id: null })}>
                      不指定
                    </Chip>
                    {childSubs.map((c) => (
                      <Chip key={c.id} active={item.subposition_id === c.id} title={c.positive} onClick={() => set({ subposition_id: c.id })}>
                        {c.name || '（未命名）'}
                      </Chip>
                    ))}
                  </div>
                </div>
              )}
              {acts.length > 0 && (
                <div>
                  <Sub>行为（可叠加）</Sub>
                  <MultiChips list={acts} value={actIds} onChange={(v) => set({ act_ids: v })} />
                </div>
              )}
              <div>
                <Sub>主角色动作（{mainName}，可选）</Sub>
                <TemplateCombo list={poses} value={item.pose_id} onPick={(id) => set({ pose_id: id })} placeholder="不指定" allowNone testId="main-pose" />
              </div>
              {!secondOn && <div className="text-[11px] text-warning">双人互动通常需要在下方启用「第二角色」</div>}
            </div>
          )}
        </section>

        {/* 主角色：服装、表情 */}
        <section>
          <FieldLabel hint={charId ? mainName : '先选择主角色'}>
            <span className="inline-flex items-center gap-1">
              <Shirt className="size-3" /> 主角色服装
            </span>
          </FieldLabel>
          <OutfitChips outfits={outfits} value={item.outfit_id} onPick={(id) => set({ outfit_id: id })} />
        </section>

        <section>
          <FieldLabel>生成张数</FieldLabel>
          <div className="flex items-center gap-3">
            <NumberStepper value={item.count} onChange={(v) => set({ count: v })} />
            <div className="flex gap-1">
              {[10, 20, 30].map((n) => (
                <Chip key={n} active={item.count === n} onClick={() => set({ count: n })}>
                  {n}
                </Chip>
              ))}
            </div>
          </div>
          <div className={cn('mt-2 text-xs', divisible ? 'text-muted-foreground' : 'text-destructive')}>
            {!nExpr
              ? '未选择表情：使用空表情'
              : divisible
                ? `${nExpr} 个表情，每个表情 ${item.count / nExpr} 张，按选择顺序依次生成`
                : `${item.count} 张不能被 ${nExpr} 个表情平均分配，请调整张数（例如 ${Math.ceil(item.count / nExpr) * nExpr}）`}
          </div>
        </section>

        <section>
          <FieldLabel
            right={nExpr ? <button type="button" className="text-[11px] text-muted-foreground hover:text-foreground" onClick={() => set({ expression_ids: [] })}>清空</button> : undefined}
          >
            <span className="inline-flex items-center gap-1">
              <Smile className="size-3" /> 主角色表情（可多选）
            </span>
          </FieldLabel>
          {exprs.length > 12 && <SearchBox value={exprQ} onChange={setExprQ} placeholder="搜索表情名称…" className="mb-2" />}
          <div className="max-h-56 overflow-y-auto">
            <MultiChips list={shownExprs} value={item.expression_ids} onChange={(v) => set({ expression_ids: v })} numbered />
          </div>
          {!exprs.length && <span className="text-xs text-muted-foreground">表情库为空，可在素材库中添加</span>}
        </section>

        {/* 场景 */}
        <section>
          <FieldLabel hint="环境 / 地点 / 背景">
            <span className="inline-flex items-center gap-1">
              <MapPin className="size-3" /> 场景
            </span>
          </FieldLabel>
          <div className="flex flex-wrap gap-1.5">
            <Chip active={!item.scene_id} onClick={() => set({ scene_id: null })}>
              {defaultScene ? `任务默认：${defaultScene.name}` : '不指定'}
            </Chip>
            {scenes.map((c) => (
              <Chip key={c.id} active={item.scene_id === c.id} onClick={() => set({ scene_id: c.id })} title={c.positive}>
                {c.name || '（未命名）'}
              </Chip>
            ))}
            {!scenes.length && <span className="text-xs text-muted-foreground">场景库为空，可在「素材库 → 场景」中添加</span>}
          </div>
        </section>

        {/* 低频：第二角色 / 旧版男性 / 镜头 / 附加 / 预览 */}
        <div className="space-y-2">
          <Disclosure
            title="第二角色"
            summary={!char2 ? (char2Id ? '第二角色已被删除' : '任务未选择第二角色') : secondOn ? `${char2.name} 出场` : '单人画面'}
            open={secondOn}
            right={<Switch checked={secondOn} disabled={!char2 && !secondOn} onCheckedChange={(v) => set({ second_enabled: v })} aria-label="第二角色出场" data-testid="second-switch" />}
          >
            {char2 ? (
              <div className="space-y-3">
                <div>
                  <Sub>服装（{char2.name}）</Sub>
                  <OutfitChips outfits={outfits2} value={item.second_outfit_id} onPick={(id) => set({ second_outfit_id: id })} />
                </div>
                <div>
                  <Sub>动作</Sub>
                  <TemplateCombo list={poses} value={item.second_pose_id} onPick={(id) => set({ second_pose_id: id })} placeholder="不指定" allowNone testId="second-pose" />
                </div>
                <div>
                  <Sub>表情</Sub>
                  <TemplateCombo list={exprs} value={item.second_expression_id} onPick={(id) => set({ second_expression_id: id })} placeholder="不指定" allowNone testId="second-expression" />
                </div>
                <div className="text-[11px] text-muted-foreground">第二角色的基础 Prompt、服装、动作、表情拼在双人互动之后；其 LoRA 需要在工作流映射中设置「第二角色 LoRA」。</div>
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">在页面顶部的「第二角色」中选择一个角色后即可启用。</div>
            )}
          </Disclosure>

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
                {legacyMales.length > 0 && (
                  <div>
                    <Sub>男性描述模板</Sub>
                    <MultiChips list={legacyMales} value={item.male_ids} onChange={(v) => set({ male_ids: v })} />
                  </div>
                )}
                {legacySelected.length > 0 && (
                  <div>
                    <Sub>男性动作 / 表情（点击移除）</Sub>
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

          <Disclosure title="镜头" summary={camera?.name ?? '不指定'}>
            <div className="flex flex-wrap gap-1.5">
              <Chip active={!item.camera_id} onClick={() => set({ camera_id: null })}>
                不指定
              </Chip>
              {cameras.map((c) => (
                <Chip key={c.id} active={item.camera_id === c.id} onClick={() => set({ camera_id: c.id })} title={c.positive}>
                  <Camera className="mr-0.5 inline size-3" />
                  {c.name || '（未命名）'}
                </Chip>
              ))}
              <Chip onClick={() => void newCamera()}>
                <Plus className="mr-0.5 inline size-3" />
                新建镜头
              </Chip>
            </div>
            {camera && <CameraEditor key={camera.id} t={camera} />}
          </Disclosure>

          <Disclosure title="附加 Prompt" summary={item.extra_positive || item.extra_negative ? '已填写' : '本动作专用，可留空'}>
            <div className="space-y-2">
              <PromptField value={item.extra_positive} onChange={(v) => set({ extra_positive: v })} placeholder={`附加正面，可用占位符 ${PLACEHOLDER_HELP}`} minRows={2} />
              <PromptField value={item.extra_negative} onChange={(v) => set({ extra_negative: v })} placeholder="附加负面" minRows={2} />
            </div>
          </Disclosure>

          <Disclosure title="最终 Prompt 预览" summary="本动作第 1 张">
            {firstUnit ? (
              <div className="space-y-3">
                <div>
                  <FieldLabel right={<CopyButton text={firstUnit.positive} />}>正面</FieldLabel>
                  <pre className="max-h-60 overflow-y-auto rounded-lg bg-inset p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap select-text">{firstUnit.positive || '（空）'}</pre>
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
        </div>
      </div>
    </div>
  )
}
