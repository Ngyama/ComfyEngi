// 任务设置与生成计划预览。

import { useEffect, useMemo, useState } from 'react'
import { Braces, ChevronDown, ChevronRight, Dices, Download, ListPlus, Play } from 'lucide-react'
import { toast } from 'sonner'
import { api, call } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Chip, CopyButton, FieldLabel, TextInput } from '@/components/common'
import { PickSources } from '@/components/card-pools'
import { templatesOf, useLib, usePlan } from '@/lib/stores'
import { cn } from '@/lib/utils'
import { SOURCE_LABELS } from '@shared/mapping'
import { randomSeed } from '@shared/planner'
import { renderPrefix } from '@shared/mapping'
import type { Plan } from '@shared/api'

export function TaskSettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const lib = useLib((s) => s.lib)
  const { task, update } = usePlan()
  const [vaultRoot, setVaultRoot] = useState<string | null>(null)
  useEffect(() => {
    if (open) void api['vault.info']().then((v) => setVaultRoot(v.root)).catch(() => setVaultRoot(null))
  }, [open])
  if (!task) return null
  const d = task.data
  const out = d.output ?? {}
  const setOut = (patch: Partial<NonNullable<typeof d.output>>) =>
    update((x) => {
      const next = { ...(x.output ?? {}), ...patch }
      for (const k of Object.keys(next) as (keyof typeof next)[]) if (!next[k]) delete next[k]
      x.output = Object.keys(next).length ? next : undefined
    })
  const sep = vaultRoot?.includes('\\') ? '\\' : '/'
  const defaultDir = vaultRoot ? `${vaultRoot.replace(/[\\/]+$/, '')}${sep}output` : ''
  const prefixPreview = out.prefix ? renderPrefix(out.prefix, { meta: { task: task.name, item: '动作' }, index: 0, seed: d.seed_base }) : ''
  const maleBase = templatesOf(lib, 'male').find((m) => m.id === d.male_base_id)
  const defaultScene = templatesOf(lib, 'scene').find((t) => t.id === d.scene_id)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>任务设置</DialogTitle>
          <DialogDescription>作用于整套图的生成参数。全局 Prompt 在页面顶部选择，工作流在页面右上角选择，场景在每个动作的详情中选择。</DialogDescription>
        </DialogHeader>
        <div className="min-w-0 space-y-5">
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
          <section data-testid="task-output">
            <FieldLabel hint="ComfyUI 先按文件名前缀保存到它自己的 output 目录，完成后本软件把最终图片复制到这里（不覆盖同名文件，不删除 ComfyUI 中的原文件）">输出目录</FieldLabel>
            <div className="flex gap-2">
              <TextInput value={out.dir ?? ''} onChange={(v) => setOut({ dir: v })} placeholder={defaultDir ? `默认：${defaultDir}` : '默认：工作区 output/'} mono className="min-w-0 flex-1" />
              <Button
                variant="secondary"
                onClick={async () => {
                  const dir = await call(api['app.chooseOutputDir']('选择本任务的输出目录'))
                  if (dir) setOut({ dir })
                }}
              >
                选择…
              </Button>
              {out.dir && (
                <Button variant="ghost" onClick={() => setOut({ dir: '' })}>
                  恢复默认
                </Button>
              )}
            </div>
            <div className="mt-3">
              <FieldLabel hint="写入工作流映射的「输出文件前缀」；/ 分隔子文件夹。可用 %date:yyyy-MM-dd% 以及 {任务} {角色名} {姿态} {序号} {种子} 等">文件名前缀</FieldLabel>
            </div>
            <TextInput value={out.prefix ?? ''} onChange={(v) => setOut({ prefix: v })} placeholder="留空则使用工作流映射中的模板，例如 %date:yyyy-MM-dd%/image" mono data-testid="task-prefix" />
            {prefixPreview && <div className="mt-1 font-mono text-[11px] text-muted-foreground" data-testid="prefix-preview">示例：{prefixPreview}_00001_.png</div>}
          </section>
          <section data-testid="combo-seed">
            <FieldLabel hint="动作卡的素材抽取由它决定：同一个组合 Seed 与相同的素材总是抽到同样的组合；与 ComfyUI 的采样 Seed 无关。入队后抽取结果随计划冻结">组合 Seed</FieldLabel>
            <div className="flex gap-2">
              <TextInput
                value={String(d.combo_seed ?? d.seed_base)}
                mono
                onChange={(v) => {
                  const n = parseInt(v.replace(/[^\d]/g, '') || '0', 10)
                  update((x) => (x.combo_seed = Math.min(n, 2 ** 31 - 1)))
                }}
                className="w-48"
              />
              <Button variant="secondary" onClick={() => update((x) => (x.combo_seed = randomSeed()))} data-testid="combo-reroll">
                <Dices /> 重新抽取组合
              </Button>
            </div>
          </section>
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

export function PlanPreviewDialog({ open, onOpenChange, plan, onEnqueue, taskId }: { open: boolean; onOpenChange: (o: boolean) => void; plan: Plan | null; onEnqueue: (start: boolean) => void; taskId?: number }) {
  const [jsonAt, setJsonAt] = useState<number | null>(null)
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
                        <span className="truncate">{x.meta.card ? (x.meta.picks ?? []).filter((p) => p.random).map((p) => p.name).join(' · ') || '（只用基础 Prompt）' : x.meta.expression || x.meta.outfit || x.item_label}</span>
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
                  {u.meta.card && <span>组合 Seed {u.meta.combo_seed}</span>}
                  {u.meta.male && <span>男性出场</span>}
                  <span className="font-mono">Seed {u.seed}</span>
                  {taskId != null && u.inputs && (
                    <Button size="xs" variant="ghost" className="ml-auto" data-testid="open-final-workflow" onClick={() => setJsonAt(u.index)}>
                      <Braces /> 最终工作流 JSON
                    </Button>
                  )}
                </div>
                {u.meta.card && (
                  <div>
                    <FieldLabel hint="本张实际使用的素材（随机 / 固定），入队后与 Prompt 一起冻结">素材来源</FieldLabel>
                    <PickSources picks={u.meta.picks} card={u.meta.card} />
                  </div>
                )}
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
        {jsonAt !== null && taskId != null && <FinalWorkflowDialog taskId={taskId} index={jsonAt} count={units.length} onIndex={setJsonAt} onClose={() => setJsonAt(null)} />}
      </DialogContent>
    </Dialog>
  )
}

/** 某一张图实际要提交给 ComfyUI 的完整工作流 JSON（由主进程用与执行相同的逻辑构建） */
export function FinalWorkflowDialog({ taskId, index, count, onIndex, onClose }: { taskId: number; index: number; count: number; onIndex: (i: number) => void; onClose: () => void }) {
  const [res, setRes] = useState<Awaited<ReturnType<(typeof api)['plan.finalWorkflow']>> | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    let live = true
    setRes(null)
    setErr('')
    api['plan.finalWorkflow'](taskId, index)
      .then((r) => live && setRes(r))
      .catch((e) => live && setErr(String((e as Error).message ?? e)))
    return () => {
      live = false
    }
  }, [taskId, index])
  const text = res ? JSON.stringify(res.json, null, 2) : ''
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[86vh] flex-col gap-3 sm:max-w-4xl" data-testid="final-workflow">
        <DialogHeader className="shrink-0">
          <DialogTitle>最终工作流 JSON</DialogTitle>
          <DialogDescription>
            第 {index + 1} / {count} 张{res ? ` · ${res.label} · Seed ${res.seed} · 工作流「${res.workflow}」` : ''}。这是应用 Prompt、Seed、LoRA 等配置后实际提交给 ComfyUI 的 API 工作流（与执行时使用同一构建逻辑）。
          </DialogDescription>
        </DialogHeader>
        {res && res.errors.length > 0 && <div className="shrink-0 rounded-lg bg-destructive/10 px-3 py-2 text-[11.5px] text-destructive">计划还有 {res.errors.length} 个问题，修正前不能入队：{res.errors[0]}</div>}
        <pre className="min-h-0 flex-1 overflow-auto rounded-xl bg-inset p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre select-text" data-testid="final-workflow-json">
          {err || text || '构建中…'}
        </pre>
        <DialogFooter className="shrink-0 sm:justify-between">
          <div className="flex gap-1">
            <Button variant="ghost" size="sm" disabled={index <= 0} onClick={() => onIndex(index - 1)}>
              上一张
            </Button>
            <Button variant="ghost" size="sm" disabled={index >= count - 1} onClick={() => onIndex(index + 1)}>
              下一张
            </Button>
          </div>
          <div className="flex gap-2">
            {text && <CopyButton text={text} label="复制 JSON" />}
            <Button
              variant="secondary"
              size="sm"
              disabled={!res}
              onClick={async () => {
                const p = await call(api['plan.exportWorkflow'](taskId, index))
                if (p) toast.success('已导出', { description: p })
              }}
            >
              <Download /> 导出 JSON
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
