// 选中节点的详情与控制：输入按类型用对应控件直接编辑（写入工作流的控制配置，不修改导入的 API JSON）。

import { useEffect, useState } from 'react'
import { ArrowUpRight, ChevronDown, ChevronRight, Layers, Plus, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { CopyButton } from '@/components/common'
import { cn } from '@/lib/utils'
import { findLoraLoaders, isLink, newEntry, nodeTitle, toggleStructure, TRIGGER_DISABLE } from '@shared/mapping'
import { checkBypass, checkOverrideValue, consumersOf, inputControl, inputSpec, literalKind, type InputSpec, type InputState } from '@shared/node-controls'
import type { ApiWorkflow, MappingEntry, ObjectInfo, WorkflowControls } from '@shared/types'
import { Select } from './WorkflowEditor'

const STATE_TONE: Record<InputState, string> = {
  link: 'bg-tint/[0.07] text-muted-foreground',
  mapping: 'bg-primary/15 text-primary',
  lora: 'bg-primary/15 text-primary',
  trigger: 'bg-success/10 text-success',
  override: 'bg-warning/10 text-warning',
  original: '',
}

const brief = (v: unknown) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return (s ?? '').length > 60 ? `${s.slice(0, 60)}…` : s
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const field = 'w-full rounded-lg bg-tint/[0.045] px-2 py-1.5 text-[12.5px] ring-1 ring-tint/[0.112] outline-none focus:ring-primary/50 disabled:opacity-60'

function Fold({ title, children, testid, defaultOpen = false }: { title: string; children: React.ReactNode; testid?: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div data-testid={testid}>
      <button type="button" className="flex items-center gap-1 text-[11.5px] text-muted-foreground hover:text-foreground" onClick={() => setOpen(!open)} data-testid={testid ? `${testid}-toggle` : undefined}>
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        {title}
      </button>
      {open && <div className="mt-1.5">{children}</div>}
    </div>
  )
}

/** 输入的值：按类型选择控件。离开输入框或按回车时提交；与原值相同等于恢复原值 */
function ValueControl({ original, value, spec, disabled, onCommit }: { original: unknown; value: unknown; spec: InputSpec | null; disabled?: boolean; onCommit: (v: unknown) => string[] }) {
  const kind = literalKind(original)
  const toText = (v: unknown) => (kind === 'json' ? JSON.stringify(v, null, 2) : String(v))
  const [draft, setDraft] = useState(toText(value))
  const [error, setError] = useState('')
  useEffect(() => {
    setDraft(toText(value))
    setError('')
  }, [JSON.stringify(value)]) // eslint-disable-line react-hooks/exhaustive-deps
  const submit = (v: unknown) => setError(onCommit(v).join('；'))
  const commitText = () => {
    if (draft === toText(value)) return setError('')
    if (kind === 'number') {
      if (draft.trim() === '' || Number.isNaN(Number(draft))) return setError('请输入数字')
      return submit(Number(draft))
    }
    if (kind === 'json') {
      try {
        return submit(JSON.parse(draft))
      } catch (e) {
        return setError(`JSON 无效：${(e as Error).message}`)
      }
    }
    submit(draft)
  }
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => e.key === 'Enter' && e.currentTarget.blur()
  let control: React.ReactNode
  if (spec?.options) {
    const opts = spec.options.map((o) => [String(o), String(o)] as [string, string])
    if (!spec.options.includes(value)) opts.push([String(value), `${String(value)}（不在列表中）`])
    control = disabled ? <input className={field} value={String(value)} disabled /> : <Select value={String(value)} onChange={(v) => submit(kind === 'number' ? Number(v) : v)} options={opts} className="w-full" />
  } else if (kind === 'boolean') {
    control = <Switch checked={value === true} disabled={disabled} onCheckedChange={(v) => submit(!!v)} data-testid="override-bool" />
  } else if (kind === 'number') {
    const hint = spec && (spec.min !== undefined || spec.max !== undefined) ? `${spec.min ?? '—'} ~ ${spec.max ?? '—'}` : ''
    control = (
      <div className="flex items-center gap-2">
        <input type="number" step="any" disabled={disabled} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commitText} onKeyDown={onKey} className={cn(field, 'w-36 font-mono')} data-testid="override-value" />
        {hint && <span className="text-[10.5px] text-muted-foreground">{hint}</span>}
      </div>
    )
  } else if (kind === 'string') {
    const long = draft.length > 60 || draft.includes('\n')
    control = long ? (
      <textarea disabled={disabled} value={draft} rows={Math.min(8, 2 + Math.ceil(draft.length / 90))} onChange={(e) => setDraft(e.target.value)} onBlur={commitText} className={cn(field, 'font-mono')} data-testid="override-value" />
    ) : (
      <input disabled={disabled} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commitText} onKeyDown={onKey} className={cn(field, 'font-mono')} data-testid="override-value" />
    )
  } else {
    control = (
      <Fold title="高级 JSON" testid="override-json">
        {!disabled && <div className="mb-1 text-[10.5px] text-warning">插件专用结构，只检查 JSON 格式，写错可能导致节点报错。</div>}
        <textarea disabled={disabled} value={draft} rows={8} onChange={(e) => setDraft(e.target.value)} onBlur={commitText} className={cn(field, 'font-mono text-[11.5px]')} data-testid="override-value" />
      </Fold>
    )
  }
  return (
    <div className="min-w-0">
      {control}
      {error && <div className="mt-1 text-[11px] text-destructive" data-testid="override-error">{error}</div>}
    </div>
  )
}

function Hint({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">{children}</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-80 leading-relaxed">{text}</TooltipContent>
    </Tooltip>
  )
}

export function NodePanel({ nid, api, mapping, controls, info, infoError, onJump, onControls, onMapping, onAddMapping, onLora }: {
  nid: string
  api: ApiWorkflow
  mapping: MappingEntry[]
  controls: WorkflowControls
  info: ObjectInfo | null
  infoError: string | null
  onJump: (nid: string) => void
  onControls: (c: WorkflowControls) => void
  onMapping: (m: MappingEntry[]) => void
  onAddMapping: (input: string) => void
  onLora: () => void
}) {
  const node = api[nid]
  if (!node) return null
  const spec = info?.[node.class_type]
  const bypassed = controls.bypass.find((b) => b.node === nid)
  const check = checkBypass(api, nid, info, controls.bypass.filter((b) => b.node !== nid).map((b) => b.node))
  const nodeMapped = mapping.filter((m) => String(m.node) === nid && m.source !== TRIGGER_DISABLE)
  const nodeOverrides = controls.overrides.filter((o) => o.node === nid)
  const blocked = nodeMapped.length ? '节点有映射，请先删除映射' : nodeOverrides.length ? '节点有参数覆盖，请先恢复原值' : ''
  const reason = !check.ok ? `${check.reason}${!info && infoError ? `（${infoError}）` : ''}` : blocked
  const toggle = toggleStructure(node)
  const triggerOff = mapping.some((m) => m.source === TRIGGER_DISABLE && String(m.node) === nid)
  const loader = findLoraLoaders(api).find((l) => l.node === nid)
  const consumers = consumersOf(api, nid)
  const upstream = Object.entries(node.inputs ?? {}).filter(([, v]) => isLink(v)) as [string, [string, number]][]
  const inputs = Object.entries(node.inputs ?? {}).filter(([, v]) => !isLink(v))
  const setOverride = (k: string, original: unknown, value: unknown): string[] => {
    const rest = controls.overrides.filter((o) => !(o.node === nid && o.input === k))
    if (same(value, original)) {
      onControls({ ...controls, overrides: rest })
      return []
    }
    const problems = checkOverrideValue(original, value, inputSpec(spec, k))
    if (problems.length) return problems
    onControls({ ...controls, overrides: [...rest, { node: nid, input: k, class_type: node.class_type, value }] })
    return []
  }
  const peer = (id: string) => (api[id] ? `#${id} ${nodeTitle(api[id])}` : `#${id}`)
  return (
    <div className="space-y-4" data-testid="node-detail" data-node={nid}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold select-text">#{nid} {nodeTitle(node)}</div>
          <div className="truncate font-mono text-[11px] text-muted-foreground select-text">{node.class_type}</div>
        </div>
        {toggle ? (
          <label className="flex shrink-0 items-center gap-2 text-[12.5px]" data-testid="trigger-control">
            自动注入触发词
            <Switch checked={!triggerOff} onCheckedChange={(on) => onMapping(on ? mapping.filter((m) => !(m.source === TRIGGER_DISABLE && String(m.node) === nid)) : [...mapping, newEntry(TRIGGER_DISABLE, nid, 'toggle_trigger_words')])} data-testid="trigger-switch" />
          </label>
        ) : (
          <div className="flex shrink-0 items-center gap-2 text-[12.5px]" data-testid="node-bypass">
            节点启用
            {bypassed || (check.ok && !blocked) ? (
              <Switch checked={!bypassed} onCheckedChange={(on) => onControls({ ...controls, bypass: on ? controls.bypass.filter((b) => b.node !== nid) : [...controls.bypass, ...(check.ok ? [check.entry] : [])] })} data-testid="bypass-switch" />
            ) : (
              <Hint text={reason}>
                <Switch checked disabled data-testid="bypass-switch" />
              </Hint>
            )}
          </div>
        )}
      </div>
      {!toggle && !bypassed && reason && <div className="truncate text-[11px] text-muted-foreground" title={reason} data-testid="bypass-reason">不能绕过：{reason}</div>}
      {bypassed && <div className="rounded-lg bg-warning/[0.08] px-2.5 py-1.5 text-[11.5px] text-warning" data-testid="bypass-reason">已绕过，提交时不包含这个节点{bypassed.routes.length ? `，下游改接 ${bypassed.routes.map((r) => r.input).join('、')} 的来源` : ''}</div>}
      {toggle && triggerOff && <div className="rounded-lg bg-success/[0.08] px-2.5 py-1.5 text-[11.5px] text-success">提交时节点输出空文本，触发词由角色和服装 Prompt 负责。</div>}

      {loader && (
        <div className="flex items-start gap-2 rounded-xl bg-tint/[0.03] p-2.5 ring-1 ring-tint/[0.08]" data-testid="node-loras">
          <Layers className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1 space-y-0.5 text-[11.5px]">
            {(loader.entries ?? [{ name: loader.lora_name, strength: node.inputs.strength_model ?? node.inputs.strength, active: true }]).map((e, i) => (
              <div key={i} className={cn('truncate font-mono', !e.active && 'opacity-50')}>
                {e.active ? '●' : '○'} {e.name} <span className="text-muted-foreground">{String(e.strength ?? '')}</span>
              </div>
            ))}
          </div>
          <Button size="sm" variant="ghost" onClick={onLora} data-testid="node-loras-open">在任务中配置</Button>
        </div>
      )}

      <div className="space-y-1.5">
        {inputs.map(([k, v]) => {
          const c = inputControl(api, mapping, controls, nid, k)
          const ov = controls.overrides.find((o) => o.node === nid && o.input === k)
          return (
            <div key={k} className={cn('rounded-xl p-2.5 ring-1', ov ? 'bg-warning/[0.04] ring-warning/25' : 'bg-tint/[0.02] ring-tint/[0.07]')} data-testid="node-input" data-input={k} data-state={c.state}>
              <div className="mb-1.5 flex min-h-6 items-center gap-2 text-[12px]">
                <span className="font-medium">{k}</span>
                {inputSpec(spec, k) && <span className="font-mono text-[10px] text-muted-foreground">{inputSpec(spec, k)!.type}</span>}
                {c.state !== 'original' && <span className={cn('rounded px-1.5 text-[10.5px]', STATE_TONE[c.state])} data-testid="input-state">{c.label}</span>}
                <div className="flex-1" />
                {ov && (
                  <>
                    <span className="max-w-48 truncate text-[10.5px] text-muted-foreground" title={String(brief(v))} data-testid="value-original">原值 {brief(v)}</span>
                    <Button size="icon-sm" variant="ghost" className="size-6" title="恢复原值" aria-label="恢复原值" data-testid="override-remove" onClick={() => onControls({ ...controls, overrides: controls.overrides.filter((o) => o !== ov) })}>
                      <RotateCcw />
                    </Button>
                  </>
                )}
                {c.state === 'original' && (
                  <Button size="icon-sm" variant="ghost" className="size-6 text-muted-foreground" title="添加为映射" aria-label="添加为映射" data-testid="add-mapping" onClick={() => onAddMapping(k)}>
                    <Plus />
                  </Button>
                )}
              </div>
              <ValueControl key={`${nid}.${k}`} original={v} value={c.prepared && c.state === 'trigger' ? c.prepared.value : (ov?.value ?? v)} spec={inputSpec(spec, k)} disabled={!!c.blocked || !!bypassed} onCommit={(value) => setOverride(k, v, value)} />
            </div>
          )
        })}
        {!inputs.length && <div className="text-xs text-muted-foreground">没有可编辑的参数。</div>}
      </div>

      {(upstream.length > 0 || consumers.length > 0) && (
        <div className="grid grid-cols-2 gap-3 text-[11.5px]">
          <div>
            <div className="mb-1 text-muted-foreground">上游</div>
            <div className="flex flex-wrap gap-1.5">
              {upstream.map(([k, v]) => {
                const c = inputControl(api, mapping, controls, nid, k)
                return (
                  <button key={k} type="button" className="inline-flex max-w-full items-center gap-1 rounded-md bg-tint/[0.05] px-1.5 py-1 hover:bg-primary/10" data-testid="node-jump" data-input={k} data-state={c.state} onClick={() => onJump(String(v[0]))} title={`${k} ← ${peer(String(v[0]))} 输出 ${v[1]}`}>
                    <ArrowUpRight className="size-3 shrink-0" />
                    <span className="font-mono">{k}</span>
                    <span className="truncate text-muted-foreground">{peer(String(v[0]))}</span>
                  </button>
                )
              })}
              {!upstream.length && <span className="text-muted-foreground">无</span>}
            </div>
          </div>
          <div>
            <div className="mb-1 text-muted-foreground">下游</div>
            <div className="flex flex-wrap gap-1.5">
              {consumers.map((c) => (
                <button key={`${c.node}.${c.input}`} type="button" className="inline-flex max-w-full items-center gap-1 rounded-md bg-tint/[0.05] px-1.5 py-1 hover:bg-primary/10" data-testid="node-consumer" onClick={() => onJump(c.node)} title={`输出 ${c.output} → ${peer(c.node)}.${c.input}`}>
                  <span className="truncate">{peer(c.node)}</span>
                  <span className="font-mono text-muted-foreground">{c.input}</span>
                </button>
              ))}
              {!consumers.length && <span className="text-muted-foreground">无</span>}
            </div>
          </div>
        </div>
      )}

      <Fold title="原始 JSON" testid="node-raw">
        <div className="flex justify-end">
          <CopyButton text={JSON.stringify(node, null, 2)} />
        </div>
        <pre className="mt-1 max-h-72 overflow-auto rounded-lg bg-inset p-2 font-mono text-[11px] whitespace-pre-wrap select-text" data-testid="node-raw-json">{JSON.stringify(node, null, 2)}</pre>
      </Fold>
    </div>
  )
}
