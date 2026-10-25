// 套图任务的 LoRA 配置：LoRA 是工作流参数（写入 LoRA Loader 节点的 lora_name / strength_model / strength_clip），不拼入 Prompt。
// 每张卡片是一个逻辑 LoRA 配置项（槽位）：角色 LoRA 默认来自角色库，可在本任务中调整权重、替换或停用；任务级 LoRA 直接在这里添加。
// 一个配置项可以绑定多个 Loader 节点（例如两次采样），绑定保存在工作流的节点映射中（与设置页的映射是同一份数据）。
// 界面只调整一个统一权重：同时写入 strength_model 与 strength_clip（底层两个字段保持不变）。

import { useEffect, useState } from 'react'
import { AlertCircle, Link2, Plus, Power, Replace, RotateCcw, Trash2 } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { LoraPicker, useLoraResources } from '@/components/lora'
import { api, call } from '@/lib/api'
import { reloadLib, useLib, useNav, usePlan } from '@/lib/stores'
import { cn } from '@/lib/utils'
import { LoraThumb, loraTitle } from '@/pages/LorasPage'
import { findLoraLoaders, loraBindingEntries, parseLoraSource, stackBindingEntry, stackReplaceTarget, type LoraLoaderInfo } from '@shared/mapping'
import { controllableLoaders, defaultLoraConfig, effectiveLoraConfig, mappedLoraNodes, roleMapped, rolePlacement, type CharRole, type RolePlacement, type WfLoraConfig, type WfLoraEntry } from '@shared/lora-config'
import { loaderStages } from '@shared/workflow-analysis'
import type { Lora, LoraOverride, LoraResource, MappingEntry, TaskLora, Workflow } from '@shared/types'

const SUPPORT: Record<LoraLoaderInfo['support'], [string, string]> = {
  standard: ['标准', 'bg-success/10 text-success'],
  compatible: ['兼容', 'bg-sky-500/10 text-sky-600'],
  partial: ['仅部分支持', 'bg-warning/10 text-warning'],
  stack: ['多 LoRA 列表', 'bg-primary/10 text-primary'],
  unknown: ['需手动映射', 'bg-tint/[0.06] text-muted-foreground'],
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
      className="h-6 w-[60px] [appearance:textfield] rounded-md bg-tint/[0.04] px-2 text-right font-mono text-[11.5px] text-foreground tabular-nums ring-1 ring-tint/[0.112] outline-none focus:ring-primary/50 disabled:opacity-50 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
    />
  )
}

const IconBtn = ({ label, onClick, className, children, ...rest }: { label: string; onClick?: () => void; className?: string; children: React.ReactNode } & Record<string, unknown>) => (
  <button type="button" aria-label={label} title={label} onClick={onClick} className={cn('grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-tint/[0.06] hover:text-foreground disabled:opacity-40 [&_svg]:size-3.5', className)} {...rest}>
    {children}
  </button>
)

/** 槽位绑定的 Loader：标准 Loader 勾选即映射 lora_name 与全部强度；多 LoRA Loader 选择「追加」或「替换某个条目」 */
function BindingPopover({ prefix, title, wf, onChanged }: { prefix: string; title: string; wf: Workflow | null; onChanged: () => void }) {
  const go = useNav((s) => s.go)
  const loaders = wf ? findLoraLoaders(wf.api_json) : []
  const mapping = wf?.mapping ?? []
  const mine = (node: string) => mapping.find((m) => m.source === `${prefix}_name` && String(m.node) === node)
  const nodes = [...new Set(mapping.filter((m) => m.source === `${prefix}_name`).map((m) => String(m.node)))]
  const ownerOf = (node: string) => [...new Set(mapping.filter((m) => String(m.node) === node && parseLoraSource(m.source)?.field === 'name').map((m) => parseLoraSource(m.source)!.prefix))]
  const save = async (next: MappingEntry[]) => {
    if (!wf) return
    if ((await call(api['workflows.save']({ id: wf.id, mapping: next }))) === undefined) return
    await reloadLib()
    onChanged()
  }
  const without = (node: string) => mapping.filter((m) => !(parseLoraSource(m.source)?.prefix === prefix && String(m.node) === node))
  const toggle = (ld: LoraLoaderInfo) => void save(mine(ld.node) ? without(ld.node) : [...mapping, ...loraBindingEntries(prefix, ld)])
  /** 多 LoRA Loader：选择同一项再次点击即解除绑定 */
  const pickStack = (ld: LoraLoaderInfo, replace: string | null) => {
    const cur = mine(ld.node)
    const same = cur && (stackReplaceTarget(cur) ?? null) === replace
    void save(same ? without(ld.node) : [...without(ld.node), stackBindingEntry(prefix, ld.node, replace)])
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
      <PopoverContent align="end" className="w-[400px] p-2">
        <div className="px-2 pt-1 pb-2 text-[11.5px] text-muted-foreground">
          「{title}」写入哪些 LoRA Loader（工作流「{wf?.name}」）。可以绑定多个，例如两次采样各自的 Loader；未绑定的 Loader 与列表条目保持工作流原值。
        </div>
        <div className="max-h-80 space-y-0.5 overflow-y-auto" data-testid="lora-loaders">
          {loaders.map((ld) => {
            const cur = mine(ld.node)
            const others = ownerOf(ld.node).filter((p) => p !== prefix)
            const [tag, tone] = SUPPORT[ld.support]
            const head = (
              <div className="flex items-center gap-1.5 text-[12.5px]">
                <span className="font-mono text-muted-foreground">#{ld.node}</span>
                <span className="truncate">{ld.title}</span>
                <span className={cn('shrink-0 rounded px-1 text-[10px]', tone)}>{tag}</span>
              </div>
            )
            if (ld.support === 'unknown')
              return (
                <div key={ld.node} className="rounded-lg px-2 py-1.5 opacity-70">
                  {head}
                  <div className="text-[10.5px] text-muted-foreground">结构无法识别，需要在设置中手动映射</div>
                </div>
              )
            if (ld.support === 'stack') {
              const target = cur ? stackReplaceTarget(cur) : undefined
              const opt = (replace: string | null, text: React.ReactNode, key: string) => {
                const on = !!cur && (target ?? null) === replace
                return (
                  <button key={key} type="button" onClick={() => pickStack(ld, replace)} data-testid="stack-option" className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[11.5px] hover:bg-tint/[0.05]', on && 'bg-primary/10 text-primary')}>
                    <span className={cn('grid size-3.5 shrink-0 place-items-center rounded-full border', on ? 'border-primary bg-primary' : 'border-tint/[0.3]')} />
                    <span className="min-w-0 truncate">{text}</span>
                  </button>
                )
              }
              return (
                <div key={ld.node} className={cn('rounded-lg px-2 py-1.5', cur && 'bg-primary/[0.04]')}>
                  {head}
                  <div className="mt-1 space-y-0.5">
                    {opt(null, '追加为新条目（列表中已有同名时直接更新）', 'append')}
                    {(ld.entries ?? []).map((e) => opt(e.name, <>替换「{e.name}」<span className="ml-1 font-mono text-muted-foreground">{e.strength}{e.active ? '' : ' · 停用'}</span></>, e.name))}
                  </div>
                  {others.length > 0 && <div className="mt-0.5 text-[10.5px] text-warning">也绑定在：{others.join('、')}</div>}
                </div>
              )
            }
            const on = !!cur
            return (
              <button key={ld.node} type="button" onClick={() => toggle(ld)} className={cn('flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-tint/[0.05]', on && 'bg-primary/10')}>
                <span className={cn('mt-0.5 grid size-4 shrink-0 place-items-center rounded border text-[10px]', on ? 'border-primary bg-primary text-primary-foreground' : 'border-tint/[0.3]')}>{on ? '✓' : ''}</span>
                <div className="min-w-0 flex-1">
                  {head}
                  <div className="truncate font-mono text-[10.5px] text-muted-foreground">
                    {ld.lora_name || '（空）'} · {ld.strengths.length ? ld.strengths.join(' / ') : '没有识别到强度输入'}
                  </div>
                  {others.length > 0 && <div className="text-[10.5px] text-warning">也绑定在：{others.join('、')}</div>}
                </div>
              </button>
            )
          })}
          {wf && !loaders.length && <div className="px-2 py-3 text-center text-xs text-muted-foreground">工作流中没有识别到 LoRA Loader。</div>}
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
  cardKey: string
  /** 来源说明（主角色 · 名称 / #5 · 工作流 / 任务添加） */
  source: string
  /** 卡片状态标记：已调整等 */
  tag?: string
  lora: { name: string; resource_id?: string; weight: number; enabled: boolean } | null
  resources: LoraResource[]
  onPick: (r: LoraResource) => void
  onEnabled: (v: boolean) => void
  onWeight: (v: number) => void
  onReset?: () => void
  resetLabel?: string
  onRemove?: () => void
  removeLabel?: string
  /** 绑定 / 加载位置控件 */
  extra?: React.ReactNode
  warn?: string
  bound?: number
}

/** 紧凑的 LoRA 素材卡：封面、本地文件名、来源、统一权重、替换 / 启停 / 删除图标 */
function LoraCard({ cardKey, source, tag, lora, resources, onPick, onEnabled, onWeight, onReset, resetLabel = '恢复默认', onRemove, removeLabel = '删除', extra, warn, bound }: CardProps) {
  const stem = lora ? fileStem(lora.name).toLowerCase() : ''
  const r = lora ? (lora.resource_id ? resources.find((x) => x.id === lora.resource_id) : resources.find((x) => x.comfyName === lora.name || x.name === lora.name || fileStem(x.name).toLowerCase() === stem)) : undefined
  const has = !!lora?.name
  const on = has && !!lora?.enabled
  const name = r ? fileStem(r.name) : has ? fileStem(lora!.name) : ''
  const meta = r && loraTitle(r) !== name ? loraTitle(r) : ''
  return (
    <div
      className={cn('flex min-w-0 items-center gap-2.5 rounded-xl bg-card p-2 ring-1 transition', on ? 'ring-primary/45' : 'opacity-55 ring-tint/[0.08]')}
      data-testid="lora-card"
      data-prefix={cardKey}
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
        {extra}
        <LoraPicker resources={resources} onPick={onPick}>
          <IconBtn label={has ? '替换 LoRA' : '选择 LoRA'}>{has ? <Replace /> : <Plus />}</IconBtn>
        </LoraPicker>
        {has && (
          <IconBtn label={lora!.enabled ? '停用' : '启用'} onClick={() => onEnabled(!lora!.enabled)} className={cn(lora!.enabled && 'text-primary')}>
            <Power />
          </IconBtn>
        )}
        {onReset && (
          <IconBtn label={resetLabel} onClick={onReset}>
            <RotateCcw />
          </IconBtn>
        )}
        {onRemove && (
          <IconBtn label={removeLabel} onClick={onRemove} className="hover:text-destructive">
            <Trash2 />
          </IconBtn>
        )}
      </div>
    </div>
  )
}

/** 角色 LoRA 在工作流中的加载位置：默认自动（同名条目关联 / 唯一的多 LoRA Loader 追加），也可以指定追加位置或替换某个条目 */
function PlacementPopover({ cfg, loaders, current, placement, onSet }: { cfg: WfLoraConfig; loaders: LoraLoaderInfo[]; current?: { node: string; replace?: string }; placement: RolePlacement; onSet: (t: { node: string; replace?: string } | null) => void }) {
  const stacks = loaders.filter((l) => l.support === 'stack')
  const opt = (on: boolean, text: React.ReactNode, onClick: () => void, key: string) => (
    <button key={key} type="button" onClick={onClick} data-testid="placement-option" className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[11.5px] hover:bg-tint/[0.05]', on && 'bg-primary/10 text-primary')}>
      <span className={cn('grid size-3.5 shrink-0 place-items-center rounded-full border', on ? 'border-primary bg-primary' : 'border-tint/[0.3]')} />
      <span className="min-w-0 truncate">{text}</span>
    </button>
  )
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" data-testid="lora-placement" aria-label="加载位置" title="角色 LoRA 在工作流中的加载位置" className={cn('inline-flex h-6 shrink-0 items-center rounded-md px-1 text-muted-foreground hover:bg-tint/[0.06] hover:text-foreground', placement.kind === 'none' && 'text-warning')}>
          <Link2 className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[340px] p-2">
        <div className="px-2 pt-1 pb-2 text-[11.5px] text-muted-foreground">角色 LoRA 的加载位置。工作流中已有同名 LoRA 时直接使用该条目，不会重复加载。</div>
        <div className="max-h-72 space-y-0.5 overflow-y-auto">
          {opt(!current, '自动：关联同名条目，否则追加到唯一的多 LoRA 列表', () => onSet(null), 'auto')}
          {stacks.map((l) => opt(!!current && !current.replace && current.node === l.node, stacks.length > 1 ? `追加到 ${l.title}` : '追加到工作流 LoRA', () => onSet({ node: l.node }), `a${l.node}`))}
          {cfg.entries.map((e) => opt(current?.replace === e.key, <>替换「{fileStem(e.name)}」</>, () => onSet({ node: e.node, replace: e.key }), e.key))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

const placementText = (p: RolePlacement, cfg: WfLoraConfig | null) =>
  p.kind === 'link' ? '已在工作流 LoRA 中' : p.kind === 'append' ? '追加到工作流 LoRA' : p.kind === 'replace' ? `替换工作流中的「${fileStem(cfg?.entries.find((e) => e.key === p.key)?.name ?? '')}」` : '工作流中没有加载位置'

export function LoraPanel() {
  const lib = useLib((s) => s.lib)
  const { task, update } = usePlan()
  const { rows: resources } = useLoraResources()
  const wfId = task?.data.workflow_none ? null : (task?.data.workflow_id ?? lib?.settings.default_workflow_id ?? null)
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

  // ---- 本任务对当前工作流的 LoRA 配置（工作流中已有的 LoRA 是默认值；保存在任务中，不修改工作流）
  const api_json = wf?.api_json ?? {}
  const mapping = wf?.mapping ?? []
  const wfKey = wf ? String(wf.id) : ''
  const saved = wf ? d.lora_configs?.[wfKey] : undefined
  const cfg = wf ? effectiveLoraConfig(saved, api_json, mapping) : null
  const defaults = wf ? defaultLoraConfig(api_json, mapping) : null
  const loaders = wf ? controllableLoaders(api_json, mapping) : []
  const setCfg = (fn: (c: WfLoraConfig) => WfLoraConfig) => {
    if (!wf || !cfg) return
    const next = fn(structuredClone(cfg))
    update((x) => {
      x.lora_configs = { ...(x.lora_configs ?? {}), [wfKey]: next }
    })
  }
  const setEntry = (key: string, patch: Partial<WfLoraEntry> | null) =>
    setCfg((c) => ({ ...c, entries: patch === null ? c.entries.filter((e) => e.key !== key) : c.entries.map((e) => (e.key === key ? { ...e, ...patch } : e)) }))
  const resetCfg = () =>
    update((x) => {
      const next = { ...(x.lora_configs ?? {}) }
      delete next[wfKey]
      x.lora_configs = next
    })
  const others = wf ? findLoraLoaders(api_json).filter((l) => !loaders.some((x) => x.node === l.node)) : []
  const cons = (nid: string) => loaderStages(api_json, nid)

  // ---- 角色 LoRA
  const linkedKeys = new Set<string>()
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
      const role = prefix as CharRole
      const advanced = !wf || i > 0 || roleMapped(mapping, role)
      const bound = new Set(mapping.filter((m) => m.source === `${prefix}_name`).map((m) => String(m.node))).size
      const placement: RolePlacement = !advanced && cfg && name ? rolePlacement(cfg, loaders, role, name) : { kind: 'none' }
      if (placement.kind === 'link') linkedKeys.add(placement.key)
      const enabledName = !!lora?.enabled && !!name
      const warn = !wf ? '' : advanced ? (enabledName && !bound ? '已启用但工作流中没有它的加载位置：不能入队。请绑定 Loader，或停用此 LoRA' : '') : enabledName && placement.kind === 'none' ? '工作流中没有同名 LoRA，也没有可以追加的多 LoRA Loader：请选择要替换的条目，或停用此 LoRA' : ''
      return (
        <LoraCard
          key={prefix}
          cardKey={prefix}
          source={`${who} · ${c.name}${base.length > 1 ? ` · ${i + 1}` : ''}${l ? '' : '（角色未设置）'}${!advanced && name ? ` · ${placementText(placement, cfg)}` : ''}`}
          tag={o ? '已调整' : undefined}
          lora={lora}
          resources={resources}
          bound={advanced ? bound : undefined}
          warn={warn}
          extra={
            advanced ? (
              <BindingPopover prefix={prefix} title={name || who} wf={wf} onChanged={() => setNonce((n) => n + 1)} />
            ) : cfg && name ? (
              <PlacementPopover cfg={cfg} loaders={loaders} current={cfg.char_targets?.[role]} placement={placement} onSet={(t) => setCfg((cf) => ({ ...cf, char_targets: Object.fromEntries(Object.entries({ ...(cf.char_targets ?? {}), [role]: t }).filter(([, v]) => v)) as WfLoraConfig['char_targets'] }))} />
            ) : null
          }
          onPick={(r) => setOv(prefix, { ...pickName(r), ...both(r.recommendedWeight) })}
          onEnabled={(v) => setOv(prefix, { enabled: v })}
          onWeight={(w) => setOv(prefix, both(w))}
          onReset={o ? () => setOv(prefix, null) : undefined}
          resetLabel="恢复角色库默认"
        />
      )
    })
  }
  const mainCards = charCards('lora', d.character_id, '主角色')
  const secondCards = charCards('second_lora', d.second_character_id, '第二角色')

  // ---- 工作流中的 LoRA（按 Loader 分组）
  const addTo = (node: string) => (r: LoraResource) =>
    setCfg((c) => ({ ...c, entries: [...c.entries, { key: `${node}:+${Math.random().toString(36).slice(2, 8)}`, node, name: r.comfyName || r.name, resource_id: r.id, strength: r.recommendedWeight, clip: r.recommendedWeight, enabled: true }] }))
  const groups = loaders.map((ld) => {
    const stack = ld.support === 'stack'
    const entries = (cfg?.entries ?? []).filter((e) => e.node === ld.node && !linkedKeys.has(e.key))
    const fed = cons(ld.node)
    return (
      <div key={ld.node} className="contents">
        <div className="col-span-full flex items-center gap-2 pt-1 text-[11px] text-muted-foreground" data-testid="lora-group" data-node={ld.node} title={fed.length ? `使用它的采样节点：${fed.join('、')}` : undefined}>
          <span className="font-medium tracking-wide uppercase">工作流 LoRA</span>
          {loaders.length > 1 && <span className="truncate">{ld.title}</span>}
          <div className="flex-1" />
          {stack && (
            <LoraPicker resources={resources} onPick={addTo(ld.node)}>
              <button type="button" data-testid="add-workflow-lora" className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] hover:bg-tint/[0.05] hover:text-primary">
                <Plus className="size-3.5" /> 添加
              </button>
            </LoraPicker>
          )}
        </div>
        {entries.map((e) => {
          const def = defaults?.entries.find((x) => x.key === e.key)
          const modified = !def || def.name !== e.name || def.strength !== e.strength || def.clip !== e.clip || def.enabled !== e.enabled
          return (
            <LoraCard
              key={e.key}
              cardKey={`wf:${e.key}`}
              source={e.orig == null ? '本任务添加' : '工作流'}
              tag={e.orig != null && modified ? '已修改' : undefined}
              lora={{ name: e.name, resource_id: e.resource_id, weight: e.strength, enabled: e.enabled }}
              resources={resources}
              onPick={(r) => setEntry(e.key, { name: r.comfyName || r.name, resource_id: r.id })}
              onEnabled={(v) => setEntry(e.key, { enabled: v })}
              onWeight={(w) => setEntry(e.key, { strength: w, clip: w })}
              onReset={e.orig != null && modified && def ? () => setEntry(e.key, { ...def }) : undefined}
              resetLabel="恢复工作流原值"
              onRemove={stack ? () => setEntry(e.key, null) : undefined}
              removeLabel="从本任务移除"
            />
          )
        })}
        {!entries.length && <div className="col-span-full rounded-xl border border-dashed border-tint/[0.16] px-3 py-2 text-center text-[11.5px] text-muted-foreground">没有其他工作流 LoRA</div>}
      </div>
    )
  })
  const taskLoras = [...(d.task_loras ?? [])].sort((a, b) => a.slot - b.slot)

  return (
    <div className="@container px-6 pb-4">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">LoRA</span>
        <span className="text-[11px] text-muted-foreground/70">{wf ? '修改只作用于本任务' : '选择工作流后显示工作流 LoRA'}</span>
        <div className="flex-1" />
        {saved && (
          <button type="button" data-testid="reset-lora-config" onClick={resetCfg} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-muted-foreground hover:bg-tint/[0.05] hover:text-primary">
            <RotateCcw className="size-3.5" /> 恢复工作流默认
          </button>
        )}
      </div>
      {/* 稳定网格：容器宽度足够时每行 3 个，中等 2 个，较窄 1 个；不会横向溢出 */}
      <div className="grid grid-cols-1 gap-2 @2xl:grid-cols-2 @5xl:grid-cols-3" data-testid="lora-panel">
        {(mainCards.length > 0 || secondCards.length > 0) && <div className="col-span-full text-[11px] font-medium tracking-wide text-muted-foreground uppercase">角色 LoRA</div>}
        {mainCards}
        {secondCards}
        {groups}
        {taskLoras.map((t) => {
          const bound = new Set(mapping.filter((m) => m.source === `task_lora${t.slot}_name`).map((m) => String(m.node))).size
          return (
            <LoraCard
              key={`task_lora${t.slot}`}
              cardKey={`task_lora${t.slot}`}
              source="任务 LoRA（旧版槽位）"
              lora={t.name ? { name: t.name, resource_id: t.resource_id, weight: t.strength_model, enabled: t.enabled } : null}
              resources={resources}
              bound={bound}
              warn={t.enabled && t.name && wf && !bound ? '已启用但未绑定 LoRA Loader：不能入队。点击链接图标绑定，或停用此 LoRA' : ''}
              extra={<BindingPopover prefix={`task_lora${t.slot}`} title={t.label} wf={wf} onChanged={() => setNonce((n) => n + 1)} />}
              onPick={(r) => setTask(t.slot, pickName(r))}
              onEnabled={(v) => setTask(t.slot, { enabled: v })}
              onWeight={(w) => setTask(t.slot, both(w))}
              onRemove={() => setTask(t.slot, null)}
              removeLabel="删除任务 LoRA"
            />
          )
        })}
      </div>
      {others.length > 0 && (
        <div className="mt-1.5 space-y-0.5 text-[11px] text-muted-foreground">
          {others.map((l) => (
            <div key={l.node}>
              {l.title}：{mappedLoraNodes(mapping).has(l.node) ? '由工作流的高级映射控制' : l.support === 'partial' ? '只识别到 lora_name，权重无法控制，保持工作流原值' : '结构无法识别，保持工作流原值（需要时请在工作流映射中手动设置）'}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
