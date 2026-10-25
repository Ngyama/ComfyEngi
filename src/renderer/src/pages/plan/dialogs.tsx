// 任务设置与生成计划预览。

import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Dices, ListPlus, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Chip, CopyButton, FieldLabel, TextInput } from '@/components/common'
import { templatesOf, useLib, usePlan } from '@/lib/stores'
import { cn } from '@/lib/utils'
import { SOURCE_LABELS } from '@shared/mapping'
import { randomSeed } from '@shared/planner'
import type { Plan } from '@shared/api'

export function TaskSettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const lib = useLib((s) => s.lib)
  const { task, update } = usePlan()
  if (!task) return null
  const d = task.data
  const maleBase = templatesOf(lib, 'male').find((m) => m.id === d.male_base_id)
  const defaultScene = templatesOf(lib, 'scene').find((t) => t.id === d.scene_id)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>任务设置</DialogTitle>
          <DialogDescription>作用于整套图的生成参数。全局 Prompt 在页面顶部选择，工作流在页面右上角选择，场景在每个动作的详情中选择。</DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          {/* 全局 Prompt 在页面顶部选择、工作流在页面右上角选择、场景在每个动作的详情中选择。
              旧任务的默认场景只在已设置时显示（仍会应用到没有单独指定场景的动作），可以清除 */}
          {!!d.scene_id && (
            <section>
              <FieldLabel hint="旧版设置：应用到没有单独指定场景的动作。新任务请在每个动作的详情中选择场景">默认场景（旧版）</FieldLabel>
              <div className="flex flex-wrap gap-1.5">
                <Chip active={false} onClick={() => update((x) => (x.scene_id = null))}>
                  不再使用
                </Chip>
                <Chip active title={defaultScene?.positive}>
                  {defaultScene?.name ?? '（已删除）'}
                </Chip>
              </div>
            </section>
          )}
          {/* 旧任务的男性基础描述：只在已设置时显示（可清除）；新任务在页面顶部选择第二角色 */}
          {!!d.male_base_id && (
            <section>
              <FieldLabel hint="旧版设置：在动作的「旧版男性设置」或剧情场景启用男性时加入。新任务请使用第二角色">男性基础描述（旧版）</FieldLabel>
              <div className="flex flex-wrap gap-1.5">
                <Chip active={false} onClick={() => update((x) => (x.male_base_id = null))}>
                  不再使用
                </Chip>
                <Chip active title={maleBase?.positive}>
                  {maleBase?.name ?? '（已删除）'}
                </Chip>
              </div>
            </section>
          )}
          <section>
            <FieldLabel hint="第 N 张的 Seed = 起始 Seed + N − 1，预览中即为实际值">起始 Seed</FieldLabel>
            <div className="flex gap-2">
              <TextInput
                value={String(d.seed_base)}
                mono
                onChange={(v) => {
                  const n = parseInt(v.replace(/[^\d]/g, '') || '0', 10)
                  update((x) => (x.seed_base = Math.min(n, 2 ** 31 - 1)))
                }}
                className="w-48"
              />
              <Button variant="secondary" onClick={() => update((x) => (x.seed_base = randomSeed()))}>
                <Dices /> 重新随机
              </Button>
            </div>
          </section>
        </div>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>完成</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function PlanPreviewDialog({ open, onOpenChange, plan, onEnqueue }: { open: boolean; onOpenChange: (o: boolean) => void; plan: Plan | null; onEnqueue: (start: boolean) => void }) {
  const units = plan?.units ?? []
  const groups = useMemo(() => {
    const out: { key: string; label: string; section: string; no: number; units: typeof units }[] = []
    for (const u of units) {
      const key = `${u.section}-${u.item_index}`
      let g = out[out.length - 1]
      if (!g || g.key !== key) {
        g = { key, label: u.item_label, section: u.meta.section, no: u.meta.item_no, units: [] }
        out.push(g)
      }
      g.units.push(u)
    }
    return out
  }, [units])
  const [sel, setSel] = useState(0)
  const [openG, setOpenG] = useState<Set<string>>(new Set())
  useEffect(() => {
    setSel(0)
    setOpenG(new Set(groups.slice(0, 1).map((g) => g.key)))
  }, [plan, groups])
  const u = units[sel]
  const ok = !!plan && !plan.errors.length && !!plan.workflow && units.length > 0
  const nStory = units.filter((x) => x.section === 'story').length
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[86vh] flex-col gap-4 sm:max-w-6xl">
        <DialogHeader>
          <DialogTitle>生成计划预览</DialogTitle>
          <DialogDescription>
            共 {units.length} 张{nStory ? `（剧情 ${nStory} → 动作 ${units.length - nStory}）` : ''}
            {plan?.workflow ? ` · 工作流：${plan.workflow.name}` : ''}。这里显示的 Prompt、Seed 与写入节点的值就是实际提交给 ComfyUI 的内容。
          </DialogDescription>
        </DialogHeader>
        {plan && (plan.errors.length > 0 || plan.warnings.length > 0) && (
          <div className="max-h-28 space-y-1 overflow-y-auto rounded-xl bg-tint/[0.03] p-3 text-xs">
            {plan.errors.map((e, i) => (
              <div key={`e${i}`} className="text-destructive">
                × {e}
              </div>
            ))}
            {plan.warnings.map((w, i) => (
              <div key={`w${i}`} className="text-warning">
                ! {w}
              </div>
            ))}
          </div>
        )}
        <div className="flex min-h-0 flex-1 gap-4">
          <div className="w-[380px] shrink-0 overflow-y-auto rounded-xl bg-tint/[0.02] p-1.5 ring-1 ring-tint/[0.08]">
            {groups.map((g) => {
              const isOpen = openG.has(g.key)
              const exprs = [...new Set(g.units.map((x) => x.meta.expression).filter(Boolean))]
              return (
                <div key={g.key}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-tint/[0.04]"
                    onClick={() => setOpenG((s) => (s.has(g.key) ? new Set([...s].filter((k) => k !== g.key)) : new Set([...s, g.key])))}
                  >
                    {isOpen ? <ChevronDown className="size-3.5 text-muted-foreground" /> : <ChevronRight className="size-3.5 text-muted-foreground" />}
                    <span className="text-[11px] text-muted-foreground">
                      {g.section} {g.no}
                    </span>
                    <span className="truncate text-[13px] font-medium">{g.label}</span>
                    <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">{g.units.length} 张</span>
                  </button>
                  {isOpen && exprs.length > 0 && <div className="truncate px-8 pb-1 text-[11px] text-muted-foreground">表情：{exprs.join(' → ')}</div>}
                  {isOpen &&
                    g.units.map((x) => (
                      <button
                        key={x.index}
                        type="button"
                        onClick={() => setSel(x.index)}
                        className={cn('flex w-full items-center gap-3 rounded-md py-1 pr-2 pl-8 text-left text-xs hover:bg-tint/[0.04]', sel === x.index && 'bg-primary/15 text-primary')}
                      >
                        <span className="w-9 shrink-0 tabular-nums opacity-70">#{x.index + 1}</span>
                        <span className="truncate">{x.meta.expression || x.meta.outfit || x.item_label}</span>
                        <span className="ml-auto font-mono text-[11px] opacity-60">{x.seed}</span>
                      </button>
                    ))}
                </div>
              )
            })}
          </div>
          <div className="min-w-0 flex-1 space-y-4 overflow-y-auto pr-1">
            {u ? (
              <>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span className="text-[13px] font-medium text-foreground">
                    第 {u.index + 1} 张 · {u.meta.section}「{u.item_label}」
                  </span>
                  {u.meta.outfit && <span>服装 {u.meta.outfit}</span>}
                  {u.meta.expression && <span>表情 {u.meta.expression}</span>}
                  {u.meta.camera && <span>镜头 {u.meta.camera}</span>}
                  {u.meta.character2 && <span>第二角色 {u.meta.character2}</span>}
                  {u.meta.male && <span>男性出场</span>}
                  <span className="font-mono">Seed {u.seed}</span>
                </div>
                <div>
                  <FieldLabel right={<CopyButton text={u.positive} label="复制正面" />}>最终正面 Prompt</FieldLabel>
                  <pre className="rounded-xl bg-inset p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap select-text">{u.positive || '（空）'}</pre>
                </div>
                <div>
                  <FieldLabel right={<CopyButton text={u.negative} label="复制负面" />}>最终负面 Prompt</FieldLabel>
                  <pre className="rounded-xl bg-inset p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap select-text">{u.negative || '（空）'}</pre>
                </div>
                {u.inputs && (
                  <div>
                    <FieldLabel>实际写入工作流的值</FieldLabel>
                    <div className="overflow-hidden rounded-xl ring-1 ring-tint/[0.096]">
                      {u.inputs.map((x, i) => (
                        <div key={i} className="flex gap-3 border-b border-tint/[0.064] px-3 py-2 text-xs last:border-0">
                          <span className="w-32 shrink-0 font-mono text-muted-foreground">
                            {x.node}.{x.input}
                          </span>
                          <span className="w-28 shrink-0 text-muted-foreground">{SOURCE_LABELS[x.source] ?? x.source}</span>
                          <span className="min-w-0 flex-1 truncate font-mono select-text" title={String(x.value ?? '')}>
                            {x.value === null ? '（保持工作流原值）' : String(x.value)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="text-sm text-muted-foreground">没有可预览的图片</div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
          <Button variant="secondary" disabled={!ok} onClick={() => onEnqueue(false)}>
            <ListPlus /> 加入队列
          </Button>
          <Button disabled={!ok} onClick={() => onEnqueue(true)}>
            <Play /> 开始生成
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
