// 姿态详细设置：浮动在主界面右侧，点击其他卡片即可切换，修改即时生效并自动保存。

import { useMemo, useState } from 'react'
import { Camera, ChevronsUpDown, Shirt, Smile, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { Chip, CopyButton, Disclosure, FieldLabel, NumberStepper, PromptField, SearchBox } from '@/components/common'
import { matches } from '@/lib/hooks'
import { templatesOf, useLib, usePlan } from '@/lib/stores'
import { cn } from '@/lib/utils'
import { PLACEHOLDER_HELP } from '@shared/prompt'
import type { PlanUnit, TaskItem } from '@shared/types'

export function PoseDetail({ index, firstUnit, onClose }: { index: number; firstUnit: PlanUnit | null; onClose: () => void }) {
  const lib = useLib((s) => s.lib)
  const { task, update } = usePlan()
  const item = task?.data.items[index]
  const [exprQ, setExprQ] = useState('')
  const [poseOpen, setPoseOpen] = useState(false)
  const poses = templatesOf(lib, 'pose')
  const exprs = templatesOf(lib, 'expression')
  const cameras = templatesOf(lib, 'camera')
  const maleBaseId = task?.data.male_base_id ?? null
  const males = templatesOf(lib, 'male').filter((t) => t.id !== maleBaseId)
  const outfits = useMemo(() => (lib?.outfits ?? []).filter((o) => o.character_id === task?.data.character_id), [lib, task?.data.character_id])
  if (!task || !item) return null

  const set = (patch: Partial<TaskItem>) => update((d) => Object.assign(d.items[index], patch))
  const pose = lib?.templates.find((t) => t.id === item.pose_id)
  const nExpr = item.expression_ids.length
  const divisible = !nExpr || item.count % nExpr === 0
  const toggleExpr = (id: number) =>
    set({ expression_ids: item.expression_ids.includes(id) ? item.expression_ids.filter((x) => x !== id) : [...item.expression_ids, id] })
  const shownExprs = exprs.filter((e) => !exprQ || matches(e as never, exprQ))
  const maleBase = lib?.templates.find((t) => t.id === maleBaseId)

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-4 pt-4 pb-3">
        <span className="grid size-6 shrink-0 place-items-center rounded-md bg-white/[0.07] text-xs font-semibold tabular-nums">{index + 1}</span>
        <Popover open={poseOpen} onOpenChange={setPoseOpen}>
          <PopoverTrigger asChild>
            <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg px-2 py-1 text-left hover:bg-white/[0.05]">
              <span className="truncate text-[15px] font-semibold">{pose?.name ?? '选择姿态'}</span>
              <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-72 p-0" align="start">
            <Command>
              <CommandInput placeholder="搜索姿态…" />
              <CommandList>
                <CommandEmpty>没有匹配的姿态</CommandEmpty>
                {poses.map((p) => (
                  <CommandItem
                    key={p.id}
                    value={`${p.name} ${p.category} ${p.tags} ${p.id}`}
                    onSelect={() => {
                      set({ pose_id: p.id })
                      setPoseOpen(false)
                    }}
                  >
                    <span className="truncate">{p.name}</span>
                    {p.category && <span className="ml-auto text-[11px] text-muted-foreground">{p.category}</span>}
                  </CommandItem>
                ))}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="关闭">
          <X />
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 pb-6">
        {/* 服装 */}
        <section>
          <FieldLabel hint={task.data.character_id ? undefined : '先选择角色'}>
            <span className="inline-flex items-center gap-1">
              <Shirt className="size-3" /> 服装
            </span>
          </FieldLabel>
          <div className="flex flex-wrap gap-1.5">
            <Chip active={!item.outfit_id} onClick={() => set({ outfit_id: null })}>
              不指定
            </Chip>
            {outfits.map((o) => (
              <Chip key={o.id} active={item.outfit_id === o.id} onClick={() => set({ outfit_id: o.id })} title={o.positive}>
                {o.name || '（未命名）'}
              </Chip>
            ))}
          </div>
        </section>

        {/* 张数 */}
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

        {/* 表情 */}
        <section>
          <FieldLabel
            right={nExpr ? <button type="button" className="text-[11px] text-muted-foreground hover:text-foreground" onClick={() => set({ expression_ids: [] })}>清空</button> : undefined}
          >
            <span className="inline-flex items-center gap-1">
              <Smile className="size-3" /> 表情（可多选）
            </span>
          </FieldLabel>
          {exprs.length > 12 && <SearchBox value={exprQ} onChange={setExprQ} placeholder="筛选表情…" className="mb-2" />}
          <div className="flex max-h-56 flex-wrap gap-1.5 overflow-y-auto">
            {shownExprs.map((e) => {
              const n = item.expression_ids.indexOf(e.id)
              return (
                <Chip key={e.id} active={n >= 0} order={n >= 0 && nExpr > 1 ? n + 1 : undefined} onClick={() => toggleExpr(e.id)} title={e.positive}>
                  {e.name || '（未命名）'}
                </Chip>
              )
            })}
            {!exprs.length && <span className="text-xs text-muted-foreground">表情库为空，可在素材库中添加</span>}
          </div>
        </section>

        {/* 镜头 */}
        <section>
          <FieldLabel hint="POV 等镜头不会自动启用男性">
            <span className="inline-flex items-center gap-1">
              <Camera className="size-3" /> 镜头
            </span>
          </FieldLabel>
          <div className="flex flex-wrap gap-1.5">
            <Chip active={!item.camera_id} onClick={() => set({ camera_id: null })}>
              不指定
            </Chip>
            {cameras.map((c) => (
              <Chip key={c.id} active={item.camera_id === c.id} onClick={() => set({ camera_id: c.id })} title={c.positive}>
                {c.name || '（未命名）'}
              </Chip>
            ))}
          </div>
        </section>

        {/* 低频：男性 / 附加 / 预览 */}
        <div className="space-y-2">
          <Disclosure
            title="男性出场"
            summary={item.male_enabled ? `已启用${item.male_ids.length ? ` · ${item.male_ids.length} 个模板` : ''}` : '单人画面'}
            open={item.male_enabled}
            right={<Switch checked={item.male_enabled} onCheckedChange={(v) => set({ male_enabled: v })} />}
          >
            <div className="space-y-3">
              <div className="text-xs text-muted-foreground">
                男性基础：{maleBase ? <span className="text-foreground/80">{maleBase.name}</span> : '未设置（在任务设置中选择）'}
              </div>
              {males.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {males.map((m) => {
                    const n = item.male_ids.indexOf(m.id)
                    return (
                      <Chip
                        key={m.id}
                        active={n >= 0}
                        title={m.positive}
                        onClick={() => set({ male_ids: n >= 0 ? item.male_ids.filter((x) => x !== m.id) : [...item.male_ids, m.id] })}
                      >
                        {m.name}
                        {m.category ? <span className="opacity-60"> · {m.category}</span> : null}
                      </Chip>
                    )
                  })}
                </div>
              )}
              <PromptField value={item.male_extra} onChange={(v) => set({ male_extra: v })} placeholder="男性附加 Prompt（本姿态专用，如特定互动动作）" minRows={2} />
            </div>
          </Disclosure>

          <Disclosure title="附加 Prompt" summary={item.extra_positive || item.extra_negative ? '已填写' : '本姿态专用，可留空'}>
            <div className="space-y-2">
              <PromptField value={item.extra_positive} onChange={(v) => set({ extra_positive: v })} placeholder={`附加正面，可用占位符 ${PLACEHOLDER_HELP}`} minRows={2} />
              <PromptField value={item.extra_negative} onChange={(v) => set({ extra_negative: v })} placeholder="附加负面" minRows={2} />
            </div>
          </Disclosure>

          <Disclosure title="最终 Prompt 预览" summary="本姿态第 1 张">
            {firstUnit ? (
              <div className="space-y-3">
                <div>
                  <FieldLabel right={<CopyButton text={firstUnit.positive} />}>正面</FieldLabel>
                  <pre className="max-h-60 overflow-y-auto rounded-lg bg-black/25 p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap select-text">{firstUnit.positive || '（空）'}</pre>
                </div>
                <div>
                  <FieldLabel right={<CopyButton text={firstUnit.negative} />}>负面</FieldLabel>
                  <pre className="max-h-40 overflow-y-auto rounded-lg bg-black/25 p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap select-text">{firstUnit.negative || '（空）'}</pre>
                </div>
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">此姿态当前无法生成，请查看卡片上的提示。</div>
            )}
          </Disclosure>
        </div>
      </div>
    </div>
  )
}
