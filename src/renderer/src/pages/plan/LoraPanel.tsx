// 套图任务的 LoRA 配置：LoRA 是工作流参数（写入 LoRA Loader 节点的 lora_name / strength_model / strength_clip），不拼入 Prompt。
// 每张卡片是一个逻辑 LoRA 配置项（槽位）：角色 LoRA 默认来自角色库，可在本任务中调整权重、替换或禁用；任务级 LoRA 直接在这里添加。
// 一个配置项可以绑定多个 Loader 节点（例如两次采样），绑定保存在工作流的节点映射中（与设置页的映射是同一份数据）。

import { useEffect, useState } from 'react'
import { AlertCircle, Link2, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { LoraPicker, useLoraResources } from '@/components/lora'
import { api, call } from '@/lib/api'
import { reloadLib, useLib, useNav, usePlan } from '@/lib/stores'
import { cn } from '@/lib/utils'
import { LoraThumb, loraTitle } from '@/pages/LorasPage'
import { findLoraLoaders, loraBindingEntries, MAX_TASK_LORAS, parseLoraSource, type LoraLoaderInfo } from '@shared/mapping'
import type { Lora, LoraOverride, LoraResource, TaskLora, Workflow } from '@shared/types'

const SUPPORT: Record<LoraLoaderInfo['support'], [string, string]> = {
  standard: ['标准', 'bg-success/10 text-success'],
  compatible: ['兼容', 'bg-sky-500/10 text-sky-600'],
  partial: ['仅部分支持', 'bg-warning/10 text-warning'],
}

/** 权重输入：失去焦点或回车时提交 */
function Weight({ label, value, onChange, disabled }: { label: string; value: number; onChange: (v: number) => void; disabled?: boolean }) {
  const [v, setV] = useState(String(value))
  useEffect(() => setV(String(value)), [value])
  const commit = () => {
    const n = Number(v)
    if (Number.isFinite(n)) onChange(Math.round(n * 1000) / 1000)
    else setV(String(value))
  }
  return (
    <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
      {label}
      <input
        type="number"
        step={0.05}
        value={v}
        disabled={disabled}
        onChange={(e) => setV(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
        aria-label={`${label} 权重`}
        className="h-6 w-14 rounded-md bg-tint/[0.04] px-1.5 text-right font-mono text-[11.5px] text-foreground ring-1 ring-tint/[0.112] outline-none focus:ring-primary/50 disabled:opacity-50"
      />
    </label>
  )
}

/** 槽位绑定的 Loader：勾选即把该节点的 lora_name 与全部强度输入映射到此槽位 */
function BindingPopover({ prefix, title, wf, onChanged }: { prefix: string; title: string; wf: Workflow | null; onChanged: () => void }) {
  const go = useNav((s) => s.go)
  const loaders = wf ? findLoraLoaders(wf.api_json) : []
  const mapping = wf?.mapping ?? []
  const nodes = [...new Set(mapping.filter((m) => m.source === `${prefix}_name`).map((m) => String(m.node)))]
  const ownerOf = (node: string) => [...new Set(mapping.filter((m) => String(m.node) === node && parseLoraSource(m.source)?.field === 'name').map((m) => parseLoraSource(m.source)!.prefix))]
  const toggle = async (ld: LoraLoaderInfo) => {
    if (!wf) return
    const on = nodes.includes(ld.node)
    const next = on ? mapping.filter((m) => !(parseLoraSource(m.source)?.prefix === prefix && String(m.node) === ld.node)) : [...mapping, ...loraBindingEntries(prefix, ld)]
    if ((await call(api['workflows.save']({ id: wf.id, mapping: next }))) === undefined) return
    await reloadLib()
    onChanged()
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" disabled={!wf} data-testid="lora-binding" className={cn('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] hover:bg-tint/[0.05] disabled:opacity-50', nodes.length ? 'text-muted-foreground' : 'text-warning')}>
          <Link2 className="size-3" />
          {wf ? (nodes.length ? `绑定 ${nodes.length} 个 Loader` : '未绑定 Loader') : '未选择工作流'}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[380px] p-2">
        <div className="px-2 pt-1 pb-2 text-[11.5px] text-muted-foreground">
          「{title}」写入哪些 LoRA Loader（工作流「{wf?.name}」）。可以绑定多个，例如两次采样各自的 Loader；未绑定的 Loader 保持工作流原值。
        </div>
        <div className="max-h-72 space-y-0.5 overflow-y-auto" data-testid="lora-loaders">
          {loaders.map((ld) => {
            const on = nodes.includes(ld.node)
            const others = ownerOf(ld.node).filter((p) => p !== prefix)
            const [tag, tone] = SUPPORT[ld.support]
            return (
              <button key={ld.node} type="button" onClick={() => void toggle(ld)} className={cn('flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-tint/[0.05]', on && 'bg-primary/10')}>
                <span className={cn('mt-0.5 grid size-4 shrink-0 place-items-center rounded border text-[10px]', on ? 'border-primary bg-primary text-primary-foreground' : 'border-tint/[0.3]')}>{on ? '✓' : ''}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-[12.5px]">
                    <span className="font-mono text-muted-foreground">#{ld.node}</span>
                    <span className="truncate">{ld.title}</span>
                    <span className={cn('shrink-0 rounded px-1 text-[10px]', tone)}>{tag}</span>
                  </div>
                  <div className="truncate font-mono text-[10.5px] text-muted-foreground">
                    {ld.lora_name || '（空）'} · {ld.strengths.length ? ld.strengths.join(' / ') : '没有识别到强度输入'}
                  </div>
                  {others.length > 0 && <div className="text-[10.5px] text-warning">也绑定在：{others.join('、')}</div>}
                </div>
              </button>
            )
          })}
          {wf && !loaders.length && <div className="px-2 py-3 text-center text-xs text-muted-foreground">工作流中没有识别到 LoRA Loader（带 lora_name 输入的节点）。</div>}
        </div>
        <div className="mt-2 border-t border-tint/[0.08] px-2 pt-2 text-[11px] text-muted-foreground">
          自定义节点无法识别时，可以
          <button type="button" className="mx-1 text-primary hover:underline" onClick={() => wf && go('settings', { section: 'workflows', workflowId: wf.id })}>
            在设置中手动映射
          </button>
          （来源选择对应的「LoRA 名称 / 强度」）。
        </div>
      </PopoverContent>
    </Popover>
  )
}

interface CardProps {
  prefix: string
  title: string
  badge: string
  lora: { name: string; resource_id?: string; model: number; clip: number; enabled: boolean } | null
  resources: LoraResource[]
  wf: Workflow | null
  onWfChanged: () => void
  onPick: (r: LoraResource) => void
  onEnabled: (v: boolean) => void
  onWeights: (model: number, clip: number) => void
  onReset?: () => void
  onRemove?: () => void
  onTitle?: (v: string) => void
  note?: string
}

function LoraCard({ prefix, title, badge, lora, resources, wf, onWfChanged, onPick, onEnabled, onWeights, onReset, onRemove, onTitle, note }: CardProps) {
  const r = lora ? (lora.resource_id ? resources.find((x) => x.id === lora.resource_id) : resources.find((x) => x.comfyName === lora.name || x.name === lora.name)) : undefined
  const bound = (wf?.mapping ?? []).some((m) => m.source === `${prefix}_name`)
  const off = !lora?.enabled
  return (
    <div className={cn('flex w-[300px] shrink-0 flex-col gap-2 rounded-xl bg-card p-2.5 ring-1 ring-tint/[0.08]', off && 'opacity-70')} data-testid="lora-card" data-prefix={prefix}>
      <div className="flex gap-2.5">
        {r ? <LoraThumb r={r} width={96} className="h-12 w-9 rounded-md" /> : <div className="h-12 w-9 shrink-0 rounded-md bg-inset" />}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {onTitle ? (
              <input value={title} onChange={(e) => onTitle(e.target.value)} className="min-w-0 flex-1 truncate bg-transparent text-[11px] text-muted-foreground outline-none focus:text-foreground" aria-label="配置项名称" />
            ) : (
              <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{title}</span>
            )}
            <span className="shrink-0 rounded bg-tint/[0.06] px-1 text-[10px] text-muted-foreground">{badge}</span>
          </div>
          <div className="truncate text-[13px] font-medium" title={lora?.name}>
            {lora?.name ? (r ? loraTitle(r) : lora.name) : <span className="text-muted-foreground">未选择 LoRA</span>}
          </div>
          {note && <div className="truncate text-[10.5px] text-muted-foreground">{note}</div>}
        </div>
        <Switch checked={!off} disabled={!lora?.name} onCheckedChange={onEnabled} aria-label="启用" />
      </div>
      <div className="flex items-center gap-2">
        <Weight label="Model" value={lora?.model ?? 1} onChange={(v) => onWeights(v, lora?.clip ?? v)} disabled={!lora?.name} />
        <Weight label="Clip" value={lora?.clip ?? 1} onChange={(v) => onWeights(lora?.model ?? v, v)} disabled={!lora?.name} />
        <div className="flex-1" />
        <LoraPicker resources={resources} onPick={onPick}>
          <Button size="xs" variant="ghost">{lora?.name ? '替换' : '选择'}</Button>
        </LoraPicker>
        {onReset && (
          <Button size="icon-xs" variant="ghost" title="恢复角色库默认" aria-label="恢复角色库默认" onClick={onReset}>
            <RotateCcw />
          </Button>
        )}
        {onRemove && (
          <Button size="icon-xs" variant="ghost" className="hover:text-destructive" title="删除" aria-label="删除任务 LoRA" onClick={onRemove}>
            <Trash2 />
          </Button>
        )}
      </div>
      <div className="flex items-center gap-1">
        <BindingPopover prefix={prefix} title={title} wf={wf} onChanged={onWfChanged} />
        {!off && lora?.name && wf && !bound && (
          <span className="inline-flex items-center gap-1 text-[10.5px] text-destructive">
            <AlertCircle className="size-3" /> 启用但未绑定，不能入队
          </span>
        )}
      </div>
    </div>
  )
}

export function LoraPanel() {
  const lib = useLib((s) => s.lib)
  const { task, update } = usePlan()
  const { rows: resources } = useLoraResources()
  const wfId = task?.data.workflow_id ?? lib?.settings.default_workflow_id ?? null
  const [wf, setWf] = useState<Workflow | null>(null)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    let live = true
    if (!wfId) setWf(null)
    else void api['workflows.get'](wfId).then((w) => live && setWf(w)).catch(() => live && setWf(null))
    return () => {
      live = false
    }
  }, [wfId, lib?.workflows, nonce])
  if (!task || !lib) return null
  const d = task.data
  const ov = d.lora_overrides ?? {}
  const setOv = (prefix: string, patch: Partial<LoraOverride> | null) =>
    update((x) => {
      const next = { ...(x.lora_overrides ?? {}) }
      if (patch === null) delete next[prefix]
      else next[prefix] = Object.assign({ enabled: true }, next[prefix], patch)
      x.lora_overrides = next
    })
  const setTask = (slot: number, patch: Partial<TaskLora> | null) =>
    update((x) => {
      const list = [...(x.task_loras ?? [])]
      const i = list.findIndex((t) => t.slot === slot)
      if (i < 0) return
      if (patch === null) list.splice(i, 1)
      else list[i] = { ...list[i], ...patch }
      x.task_loras = list
    })
  const pickName = (r: LoraResource) => ({ resource_id: r.id, name: r.comfyName || r.name })

  const charCards = (kind: 'lora' | 'second_lora', charId: number | null | undefined, who: string, note?: string) => {
    const c = charId ? lib.characters.find((x) => x.id === charId) : undefined
    if (!c) return []
    const base: (Lora | null)[] = (c.loras ?? []).filter((l) => l.name)
    if (!base.length) base.push(null)
    return base.map((l, i) => {
      const prefix = `${kind}${i + 1}`
      const o = ov[prefix]
      const name = o?.name ?? l?.name ?? ''
      const lora = name ? { name, resource_id: o?.name ? o.resource_id : l?.resource_id, model: o?.strength_model ?? l?.strength ?? 1, clip: o?.strength_clip ?? o?.strength_model ?? l?.strength_clip ?? l?.strength ?? 1, enabled: o ? o.enabled : true } : null
      return (
        <LoraCard
          key={prefix}
          prefix={prefix}
          title={`${who}「${c.name}」${base.length > 1 ? ` LoRA ${i + 1}` : ''}`}
          badge={o ? '本任务已调整' : l ? '角色默认' : '角色未设置'}
          note={note}
          lora={lora}
          resources={resources}
          wf={wf}
          onWfChanged={() => setNonce((n) => n + 1)}
          onPick={(r) => setOv(prefix, { ...pickName(r), strength_model: r.recommendedWeight, strength_clip: r.recommendedWeight })}
          onEnabled={(v) => setOv(prefix, { enabled: v })}
          onWeights={(m, cl) => setOv(prefix, { strength_model: m, strength_clip: cl })}
          onReset={o ? () => setOv(prefix, null) : undefined}
        />
      )
    })
  }
  const taskLoras = [...(d.task_loras ?? [])].sort((a, b) => a.slot - b.slot)
  const freeSlot = Array.from({ length: MAX_TASK_LORAS }, (_, i) => i + 1).find((n) => !taskLoras.some((t) => t.slot === n))
  const addTask = (r: LoraResource) => {
    if (!freeSlot) return
    update((x) => {
      x.task_loras = [...(x.task_loras ?? []), { slot: freeSlot, label: `任务 LoRA ${freeSlot}`, enabled: true, ...pickName(r), strength_model: r.recommendedWeight, strength_clip: r.recommendedWeight }]
    })
    toast.success('已添加任务 LoRA', { description: '请在卡片上绑定它要写入的 LoRA Loader。' })
  }

  return (
    <div className="px-6 pb-4">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">LoRA</span>
        <span className="text-[11px] text-muted-foreground/70">写入工作流的 LoRA Loader 节点，作用于整套图</span>
      </div>
      <div className="scrollbar-none -mx-1 flex gap-2 overflow-x-auto px-1 py-0.5" data-testid="lora-panel">
        {charCards('lora', d.character_id, '主角色')}
        {charCards('second_lora', d.second_character_id, '第二角色', '只在启用第二角色的动作中加载')}
        {taskLoras.map((t) => (
          <LoraCard
            key={`task_lora${t.slot}`}
            prefix={`task_lora${t.slot}`}
            title={t.label}
            badge="任务 LoRA"
            lora={t.name ? { name: t.name, resource_id: t.resource_id, model: t.strength_model, clip: t.strength_clip, enabled: t.enabled } : null}
            resources={resources}
            wf={wf}
            onWfChanged={() => setNonce((n) => n + 1)}
            onPick={(r) => setTask(t.slot, pickName(r))}
            onEnabled={(v) => setTask(t.slot, { enabled: v })}
            onWeights={(m, c) => setTask(t.slot, { strength_model: m, strength_clip: c })}
            onRemove={() => setTask(t.slot, null)}
            onTitle={(v) => setTask(t.slot, { label: v })}
          />
        ))}
        {freeSlot && (
          <LoraPicker resources={resources} onPick={addTask}>
            <button type="button" data-testid="add-task-lora" className="flex w-[150px] shrink-0 flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-tint/[0.16] text-[12px] text-muted-foreground hover:border-primary/40 hover:text-primary">
              <Plus className="size-4" />
              添加任务 LoRA
              <span className="text-[10.5px] opacity-70">画风、辅助、背景等</span>
            </button>
          </LoraPicker>
        )}
      </div>
    </div>
  )
}
