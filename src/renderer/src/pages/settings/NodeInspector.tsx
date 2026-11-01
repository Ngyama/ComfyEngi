// 节点详情：一个节点的全部输入、连接来源，以及这个工作流的参数覆盖与绕过。只改工作流记录中的控制配置，不修改导入的 API JSON。

import { useEffect, useState } from 'react'
import { AlertCircle, ArrowUpRight, Ban, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { CopyButton, FieldLabel } from '@/components/common'
import { cn } from '@/lib/utils'
import { isLink, nodeTitle } from '@shared/mapping'
import { checkBypass, checkOverrideValue, consumersOf, inputControl, inputSpec, literalKind, type InputState } from '@shared/node-controls'
import type { ApiWorkflow, MappingEntry, ObjectInfo, WorkflowControls } from '@shared/types'
import { Select } from './WorkflowEditor'

const STATE_TONE: Record<InputState, string> = {
  link: 'bg-tint/[0.07] text-muted-foreground',
  mapping: 'bg-primary/15 text-primary',
  lora: 'bg-primary/15 text-primary',
  trigger: 'bg-success/10 text-success',
  override: 'bg-warning/10 text-warning',
  original: 'bg-tint/[0.04] text-muted-foreground',
}

const text = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2) ?? String(v))

function Raw({ label, v, testid }: { label: string; v: unknown; testid?: string }) {
  const s = text(v)
  return (
    <div className="min-w-0" data-testid={testid}>
      <div className="flex items-center text-[10.5px] text-muted-foreground">
        {label}
        <span className="ml-auto">
          <CopyButton text={s} />
        </span>
      </div>
      <pre className="mt-0.5 max-h-40 overflow-auto rounded-md bg-inset p-1.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap select-text">{s || '（空）'}</pre>
    </div>
  )
}

/** 输入框内容 → 值。按工作流原值的类型解析，解析失败返回错误文字 */
function parseDraft(kind: ReturnType<typeof literalKind>, draft: string): { value: unknown } | { error: string } {
  if (kind === 'string') return { value: draft }
  if (kind === 'boolean') return { value: draft === 'true' }
  if (kind === 'number') {
    const n = Number(draft)
    return draft.trim() === '' || Number.isNaN(n) ? { error: '请输入数字' } : { value: n }
  }
  try {
    return { value: JSON.parse(draft) }
  } catch (e) {
    return { error: `JSON 无效：${(e as Error).message}` }
  }
}

function OverrideEditor({ original, current, spec, onSave, onCancel }: { original: unknown; current?: unknown; spec: ReturnType<typeof inputSpec>; onSave: (v: unknown) => void; onCancel: () => void }) {
  const kind = literalKind(original)
  const start = current ?? original
  const [draft, setDraft] = useState(kind === 'json' ? JSON.stringify(start, null, 2) : String(start))
  const [error, setError] = useState('')
  const field = 'w-full rounded-lg bg-tint/[0.045] px-2 py-1.5 font-mono text-[12px] ring-1 ring-tint/[0.112] outline-none focus:ring-primary/50'
  return (
    <div className="space-y-2 rounded-lg bg-tint/[0.03] p-2.5" data-testid="override-edit">
      {kind === 'json' && <div className="flex gap-1.5 text-[11px] leading-relaxed text-warning"><AlertCircle className="mt-0.5 size-3.5 shrink-0" /> 高级 JSON 编辑：ComfyEngi 不理解这个插件输入的含义，只检查 JSON 格式。写错可能导致节点报错或得到意外结果，请自行确认结构。</div>}
      {spec?.options ? (
        <Select value={draft} onChange={setDraft} options={[...spec.options.map((o) => [String(o), String(o)] as [string, string]), ...(spec.options.includes(start) ? [] : [[String(start), `${String(start)}（不在可选列表中）`] as [string, string]])]} className="w-full" />
      ) : kind === 'boolean' ? (
        <label className="flex items-center gap-2 text-xs">
          <Switch checked={draft === 'true'} onCheckedChange={(v) => setDraft(v ? 'true' : 'false')} data-testid="override-bool" /> {draft === 'true' ? 'true' : 'false'}
        </label>
      ) : kind === 'number' ? (
        <input type="number" step="any" value={draft} min={spec?.min} max={spec?.max} onChange={(e) => setDraft(e.target.value)} className={field} data-testid="override-value" />
      ) : (
        <textarea value={draft} rows={kind === 'json' ? 8 : 3} onChange={(e) => setDraft(e.target.value)} className={field} data-testid="override-value" />
      )}
      {!spec && <div className="text-[10.5px] text-muted-foreground">没有 ComfyUI 的节点定义：只按工作流原值的类型做基础检查。</div>}
      {spec && (spec.min !== undefined || spec.max !== undefined) && <div className="text-[10.5px] text-muted-foreground">ComfyUI 声明的范围：{spec.min ?? '—'} ~ {spec.max ?? '—'}</div>}
      {error && <div className="text-[11px] text-destructive" data-testid="override-error">{error}</div>}
      <div className="flex justify-end gap-1.5">
        <Button size="sm" variant="ghost" onClick={onCancel}>取消</Button>
        <Button
          size="sm"
          data-testid="override-save"
          onClick={() => {
            const r = parseDraft(kind, draft)
            if ('error' in r) return setError(r.error)
            const problems = checkOverrideValue(original, r.value, spec)
            if (problems.length) return setError(problems.join('；'))
            onSave(r.value)
          }}
        >
          保存覆盖
        </Button>
      </div>
    </div>
  )
}

export function NodeInspector({ nid, api, mapping, controls, info, infoError, onJump, onClose, onControls }: { nid: string; api: ApiWorkflow; mapping: MappingEntry[]; controls: WorkflowControls; info: ObjectInfo | null; infoError: string | null; onJump: (nid: string) => void; onClose: () => void; onControls: (c: WorkflowControls) => void }) {
  const node = api[nid]
  const [editing, setEditing] = useState<string | null>(null)
  useEffect(() => setEditing(null), [nid])
  if (!node) return null
  const spec = info?.[node.class_type]
  const bypassed = controls.bypass.find((b) => b.node === nid)
  const others = controls.bypass.filter((b) => b.node !== nid).map((b) => b.node)
  const check = checkBypass(api, nid, info, others)
  const nodeMapped = mapping.filter((m) => String(m.node) === nid)
  const nodeOverrides = controls.overrides.filter((o) => o.node === nid)
  const blocked = nodeMapped.length ? `这个节点有 ${nodeMapped.length} 条映射，绕过后不会生效：请先删除映射` : nodeOverrides.length ? '这个节点有参数覆盖，绕过后不会生效：请先恢复这些输入' : ''
  const consumers = consumersOf(api, nid)
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-3xl" data-testid="node-detail" data-node={nid}>
        <DialogHeader className="shrink-0">
          <DialogTitle>节点 #{nid} {nodeTitle(node)}</DialogTitle>
          <DialogDescription className="font-mono text-[11.5px]">{node.class_type}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
          <div className="text-[11.5px] leading-relaxed text-muted-foreground">导入的工作流不会被修改。覆盖与绕过保存在 ComfyEngi 的工作流配置中，只作用于提交时的副本；「更新 JSON」后如果节点已变化会提示失效。</div>

          <section className="rounded-xl bg-tint/[0.03] p-3 ring-1 ring-tint/[0.08]" data-testid="node-bypass">
            <div className="flex items-center gap-2 text-xs font-medium">
              <Ban className="size-3.5" /> 节点绕过
              <div className="flex-1" />
              {bypassed ? (
                <Button size="sm" variant="secondary" data-testid="bypass-restore" onClick={() => onControls({ ...controls, bypass: controls.bypass.filter((b) => b.node !== nid) })}>
                  <RotateCcw /> 恢复节点
                </Button>
              ) : (
                <Button size="sm" variant="secondary" disabled={!check.ok || !!blocked} data-testid="bypass-set" onClick={() => check.ok && onControls({ ...controls, bypass: [...controls.bypass, check.entry] })}>
                  绕过这个节点
                </Button>
              )}
            </div>
            <div className="mt-1.5 text-[11.5px] leading-relaxed" data-testid="bypass-reason">
              {bypassed ? (
                <span className="text-warning">已绕过：提交时不包含这个节点，{bypassed.routes.length ? bypassed.routes.map((r) => `输出 ${r.output}（${r.type}）的使用者改接到 ${r.input} 的来源`).join('；') : '它的输出没有被其他节点使用'}。恢复后使用原来的连接。</span>
              ) : !check.ok ? (
                <span className="text-muted-foreground">不支持自动绕过：{check.reason}{!info && infoError ? `（${infoError}）` : ''}</span>
              ) : blocked ? (
                <span className="text-muted-foreground">{blocked}</span>
              ) : (
                <span className="text-muted-foreground">类型已确认：{check.entry.routes.length ? check.entry.routes.map((r) => `输出 ${r.output}（${r.type}）→ 输入 ${r.input}`).join('；') : '输出没有被其他节点使用'}。与 ComfyUI 编辑器的 Bypass 相同，提交时移除节点并把下游改接到上游。</span>
              )}
            </div>
          </section>

          <section>
            <FieldLabel>全部输入</FieldLabel>
            <div className="space-y-2">
              {Object.entries(node.inputs ?? {}).map(([k, v]) => {
                const c = inputControl(api, mapping, controls, nid, k)
                const ov = controls.overrides.find((o) => o.node === nid && o.input === k)
                const isl = isLink(v)
                const kSpec = inputSpec(spec, k)
                return (
                  <div key={k} className="rounded-xl bg-tint/[0.03] p-2.5 ring-1 ring-tint/[0.08]" data-testid="node-input" data-input={k} data-state={c.state}>
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-mono font-medium">{k}</span>
                      {kSpec && <span className="font-mono text-[10.5px] text-muted-foreground">{kSpec.type}</span>}
                      <span className={cn('rounded px-1.5 text-[10.5px]', STATE_TONE[c.state])} data-testid="input-state">{c.label}</span>
                      <div className="flex-1" />
                      {isl && (
                        <Button size="sm" variant="ghost" data-testid="node-jump" onClick={() => onJump(String(v[0]))}>
                          <ArrowUpRight /> 来自 #{String(v[0])} 输出 {v[1]}
                        </Button>
                      )}
                      {!c.blocked && !ov && editing !== k && (
                        <Button size="sm" variant="ghost" data-testid="override-open" onClick={() => setEditing(k)}>覆盖</Button>
                      )}
                      {ov && editing !== k && (
                        <>
                          <Button size="sm" variant="ghost" data-testid="override-open" onClick={() => setEditing(k)}>修改</Button>
                          <Button size="sm" variant="ghost" data-testid="override-remove" onClick={() => onControls({ ...controls, overrides: controls.overrides.filter((o) => o !== ov) })}><RotateCcw /> 恢复原值</Button>
                        </>
                      )}
                    </div>
                    {editing === k ? (
                      <div className="mt-2">
                        <OverrideEditor original={v} current={ov?.value} spec={kSpec} onCancel={() => setEditing(null)} onSave={(value) => {
                          onControls({ ...controls, overrides: [...controls.overrides.filter((o) => o !== ov), { node: nid, input: k, class_type: node.class_type, value }] })
                          setEditing(null)
                        }} />
                      </div>
                    ) : (
                      <div className="mt-2 grid grid-cols-3 gap-2">
                        <Raw label="工作流原始值" v={v} testid="value-original" />
                        {c.prepared ? <Raw label="ComfyEngi 准备写入" v={c.prepared.value} testid="value-prepared" /> : <div className="text-[10.5px] text-muted-foreground" data-testid="value-prepared">ComfyEngi 准备写入<div className="mt-1.5 leading-relaxed">{c.state === 'mapping' || c.state === 'lora' ? '每张图的值由计划决定' : '不写入'}</div></div>}
                        <div className="text-[10.5px] text-muted-foreground" data-testid="value-actual">实际提交值<div className="mt-1.5 leading-relaxed">{bypassed ? '节点不提交' : c.state === 'mapping' || c.state === 'lora' ? '在任务预览的「最终工作流」或运行记录的「执行详情」中查看' : c.prepared ? '与准备写入的值相同（提交前可在最终工作流中核对）' : '与工作流原始值相同'}</div></div>
                      </div>
                    )}
                  </div>
                )
              })}
              {!Object.keys(node.inputs ?? {}).length && <div className="text-xs text-muted-foreground">这个节点没有输入。</div>}
            </div>
          </section>

          <section>
            <FieldLabel>使用这个节点输出的节点</FieldLabel>
            {!consumers.length && <div className="text-xs text-muted-foreground">没有其他节点使用它的输出。</div>}
            <div className="flex flex-wrap gap-1.5">
              {consumers.map((c) => (
                <button key={`${c.node}.${c.input}`} type="button" className="rounded-md bg-tint/[0.05] px-2 py-1 font-mono text-[11px] hover:bg-primary/10" data-testid="node-consumer" onClick={() => onJump(c.node)}>
                  输出 {c.output} → #{c.node}.{c.input}
                </button>
              ))}
            </div>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  )
}
