// 套图任务的 LoRA 配置：LoRA 是工作流参数（写入 LoRA Loader 节点的 lora_name / strength_model / strength_clip），不拼入 Prompt。
// 每张卡片是一个逻辑 LoRA 配置项（槽位）：角色 LoRA 默认来自角色库，可在本任务中调整权重、替换或停用；任务级 LoRA 直接在这里添加。
// 一个配置项可以绑定多个 Loader 节点（例如两次采样），绑定保存在工作流的节点映射中（与设置页的映射是同一份数据）。
// 界面只调整一个统一权重：同时写入 strength_model 与 strength_clip（底层两个字段保持不变）。

import { useEffect, useState } from 'react'
import { AlertCircle, Link2, Plus, Power, Replace, RotateCcw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
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

/** 本地文件名（不含扩展名与目录），与 LoRA 管理中的本地命名一致 */
const fileStem = (name: string) => (name.split(/[\\/]/).pop() ?? name).replace(/\.(safetensors|ckpt|pt|bin)$/i, '')

/** 权重输入：失去焦点或回车时提交 */
function Weight({ value, onChange, disabled }: { value: number; onChange: (v: number) => void; disabled?: boolean }) {
  const [v, setV] = useState(String(value))
  useEffect(() => setV(String(value)), [value])
  const commit = () => {
    const n = Number(v)
    if (Number.isFinite(n)) onChange(Math.round(n * 1000) / 1000)
    else setV(String(value))
  }
  return (
    <input
      type="number"
      step={0.05}
      value={v}
      disabled={disabled}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
      aria-label="权重"
      title="权重（同时用于 Model 与 Clip）"
      className="h-6 w-[52px] rounded-md bg-tint/[0.04] px-1.5 text-right font-mono text-[11.5px] text-foreground ring-1 ring-tint/[0.112] outline-none focus:ring-primary/50 disabled:opacity-50"
    />
  )
}

const IconBtn = ({ label, onClick, className, children, ...rest }: { label: string; onClick?: () => void; className?: string; children: React.ReactNode } & Record<string, unknown>) => (
  <button type="button" aria-label={label} title={label} onClick={onClick} className={cn('grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-tint/[0.06] hover:text-foreground disabled:opacity-40 [&_svg]:size-3.5', className)} {...rest}>
    {children}
  </button>
)

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
        <button
          type="button"
          disabled={!wf}
          data-testid="lora-binding"
          aria-label="绑定的 LoRA Loader"
          title={wf ? (nodes.length ? `已绑定 ${nodes.length} 个 Loader，点击查看或修改` : '未绑定 LoRA Loader，点击绑定') : '请先在右上角选择工作流'}
          className={cn('inline-flex h-6 shrink-0 items-center gap-0.5 rounded-md px-1 text-[11px] text-muted-foreground hover:bg-tint/[0.06] hover:text-foreground disabled:opacity-40', wf && !nodes.length && 'text-warning')}
        >
          <Link2 className="size-3.5" />
          {wf && nodes.length > 0 && <span className="tabular-nums">{nodes.length}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[380px] p-2">
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
  /** 来源说明（主角色 · 名称 / 第二角色 · 名称 / 任务） */
  source: string
  /** 卡片状态标记：已调整等 */
  tag?: string
  lora: { name: string; resource_id?: string; weight: number; enabled: boolean } | null
  resources: LoraResource[]
  wf: Workflow | null
  onWfChanged: () => void
  onPick: (r: LoraResource) => void
  onEnabled: (v: boolean) => void
  onWeight: (v: number) => void
  onReset?: () => void
  onRemove?: () => void
}

/** 紧凑的 LoRA 素材卡：封面、本地文件名、来源、统一权重、绑定 / 替换 / 启停 / 删除图标 */
function LoraCard({ prefix, source, tag, lora, resources, wf, onWfChanged, onPick, onEnabled, onWeight, onReset, onRemove }: CardProps) {
  const r = lora ? (lora.resource_id ? resources.find((x) => x.id === lora.resource_id) : resources.find((x) => x.comfyName === lora.name || x.name === lora.name)) : undefined
  const bound = new Set((wf?.mapping ?? []).filter((m) => m.source === `${prefix}_name`).map((m) => String(m.node))).size
  const has = !!lora?.name
  const on = has && !!lora?.enabled
  const name = r ? fileStem(r.name) : has ? fileStem(lora!.name) : ''
  const meta = r && loraTitle(r) !== name ? loraTitle(r) : ''
  const warn = on && wf && !bound ? '已启用但未绑定 LoRA Loader：不能入队。点击链接图标绑定，或停用此 LoRA' : ''
  return (
    <div
      className={cn('flex min-w-0 items-center gap-2.5 rounded-xl bg-card p-2 ring-1 transition', on ? 'ring-primary/45' : 'opacity-55 ring-tint/[0.08]')}
      data-testid="lora-card"
      data-prefix={prefix}
      data-enabled={on || undefined}
      data-bound={bound}
    >
      {r ? <LoraThumb r={r} width={96} className={cn('h-12 w-9 rounded-md', !on && 'grayscale')} /> : <div className="h-12 w-9 shrink-0 rounded-md bg-inset" />}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          <span className={cn('truncate text-[13px] font-medium', !has && 'text-muted-foreground')} title={[name, meta, lora?.name].filter(Boolean).join('\n')} data-testid="lora-title">
            {has ? name : '未选择 LoRA'}
          </span>
          {warn && (
            <span title={warn} aria-label={warn} data-testid="lora-warning" className="shrink-0 text-destructive">
              <AlertCircle className="size-3.5" />
            </span>
          )}
        </div>
        <div className="truncate text-[11px] text-muted-foreground">
          {source}
          {tag && <span className="text-primary"> · {tag}</span>}
          {has && !lora!.enabled && ' · 已停用'}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <Weight value={lora?.weight ?? 1} onChange={onWeight} disabled={!has} />
        <BindingPopover prefix={prefix} title={name || source} wf={wf} onChanged={onWfChanged} />
        <LoraPicker resources={resources} onPick={onPick}>
          <IconBtn label={has ? '替换 LoRA' : '选择 LoRA'}>{has ? <Replace /> : <Plus />}</IconBtn>
        </LoraPicker>
        {has && (
          <IconBtn label={lora!.enabled ? '停用' : '启用'} onClick={() => onEnabled(!lora!.enabled)} className={cn(lora!.enabled && 'text-primary')}>
            <Power />
          </IconBtn>
        )}
        {onReset && (
          <IconBtn label="恢复角色库默认" onClick={onReset}>
            <RotateCcw />
          </IconBtn>
        )}
        {onRemove && (
          <IconBtn label="删除任务 LoRA" onClick={onRemove} className="hover:text-destructive">
            <Trash2 />
          </IconBtn>
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
  // 统一权重：同时写入 Model 与 Clip
  const both = (w: number) => ({ strength_model: w, strength_clip: w })

  const charCards = (kind: 'lora' | 'second_lora', charId: number | null | undefined, who: string) => {
    const c = charId ? lib.characters.find((x) => x.id === charId) : undefined
    if (!c) return []
    const base: (Lora | null)[] = (c.loras ?? []).filter((l) => l.name)
    if (!base.length) base.push(null)
    return base.map((l, i) => {
      const prefix = `${kind}${i + 1}`
      const o = ov[prefix]
      const name = o?.name ?? l?.name ?? ''
      const lora = name ? { name, resource_id: o?.name ? o.resource_id : l?.resource_id, weight: o?.strength_model ?? l?.strength ?? 1, enabled: o ? o.enabled : true } : null
      return (
        <LoraCard
          key={prefix}
          prefix={prefix}
          source={`${who} · ${c.name}${base.length > 1 ? ` · ${i + 1}` : ''}${l ? '' : '（角色未设置）'}`}
          tag={o ? '已调整' : undefined}
          lora={lora}
          resources={resources}
          wf={wf}
          onWfChanged={() => setNonce((n) => n + 1)}
          onPick={(r) => setOv(prefix, { ...pickName(r), ...both(r.recommendedWeight) })}
          onEnabled={(v) => setOv(prefix, { enabled: v })}
          onWeight={(w) => setOv(prefix, both(w))}
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
      x.task_loras = [...(x.task_loras ?? []), { slot: freeSlot, label: `任务 LoRA ${freeSlot}`, enabled: true, ...pickName(r), ...both(r.recommendedWeight) }]
    })
    toast.success('已添加任务 LoRA', { description: '点击卡片上的链接图标，绑定它要写入的 LoRA Loader。' })
  }

  return (
    <div className="@container px-6 pb-4">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">LoRA</span>
        <span className="text-[11px] text-muted-foreground/70">写入工作流的 LoRA Loader 节点，作用于整套图</span>
        <div className="flex-1" />
        {freeSlot && (
          <LoraPicker resources={resources} onPick={addTask}>
            <button type="button" data-testid="add-task-lora" className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-muted-foreground hover:bg-tint/[0.05] hover:text-primary">
              <Plus className="size-3.5" /> 添加 LoRA
            </button>
          </LoraPicker>
        )}
      </div>
      {/* 稳定网格：容器宽度足够时每行 3 个，中等 2 个，较窄 1 个；不会横向溢出 */}
      <div className="grid grid-cols-1 gap-2 @2xl:grid-cols-2 @5xl:grid-cols-3" data-testid="lora-panel">
        {charCards('lora', d.character_id, '主角色')}
        {charCards('second_lora', d.second_character_id, '第二角色')}
        {taskLoras.map((t) => (
          <LoraCard
            key={`task_lora${t.slot}`}
            prefix={`task_lora${t.slot}`}
            source="任务 LoRA"
            lora={t.name ? { name: t.name, resource_id: t.resource_id, weight: t.strength_model, enabled: t.enabled } : null}
            resources={resources}
            wf={wf}
            onWfChanged={() => setNonce((n) => n + 1)}
            onPick={(r) => setTask(t.slot, pickName(r))}
            onEnabled={(v) => setTask(t.slot, { enabled: v })}
            onWeight={(w) => setTask(t.slot, both(w))}
            onRemove={() => setTask(t.slot, null)}
          />
        ))}
      </div>
    </div>
  )
}
