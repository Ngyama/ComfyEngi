// 工作流页面的「LoRA 自动触发词」：列出每一条 trigger_words 路径，分别选择由 ComfyEngi 管理或使用插件输出。
// 选择保存在工作流的节点控制中，只影响提交的 API 副本；LoRA Loader 的 MODEL、CLIP 与 LoRA 列表不变。

import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { newEntry, TRIGGER_DISABLE } from '@shared/mapping'
import { cutOf, isCut } from '@shared/node-controls'
import type { ApiWorkflow, MappingEntry, WorkflowControls } from '@shared/types'
import { findPromptInjectors, findTriggerPaths, type TriggerPath } from '@shared/workflow-analysis'
import { cn } from '@/lib/utils'

const routeText = (p: TriggerPath) => p.route.map((n) => `#${n}`).join(' → ')

function Choice({ managed, disabled, onChange }: { managed: boolean; disabled?: boolean; onChange: (managed: boolean) => void }) {
  const opt = (on: boolean, text: string, v: boolean, testid: string) => (
    <button type="button" role="radio" aria-checked={on} disabled={disabled} onClick={() => !on && onChange(v)} data-testid={testid} data-active={on || undefined} className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] hover:bg-tint/[0.05] disabled:opacity-50">
      <span className={cn('size-3 rounded-full border', on ? 'border-primary bg-primary' : 'border-tint/[0.3]')} />
      {text}
    </button>
  )
  return (
    <div role="radiogroup" className="flex shrink-0 items-center gap-1">
      {opt(managed, '由 ComfyEngi 管理', true, 'trigger-path-managed')}
      {opt(!managed, '使用插件输出', false, 'trigger-path-plugin')}
    </div>
  )
}

export function TriggerPathsPanel({ api, mapping, controls, onControls, onMapping }: { api: ApiWorkflow; mapping: MappingEntry[]; controls: WorkflowControls; onControls: (c: WorkflowControls) => void; onMapping: (m: MappingEntry[]) => void }) {
  const [open, setOpen] = useState<string | null>(null)
  const paths = findTriggerPaths(api, mapping)
  const shown = paths.filter((p) => p.status !== 'off_prompt')
  const quiet = paths.filter((p) => p.status === 'off_prompt')
  // 配置过、但在当前工作流里已经找不到的路径（例如更新 JSON 后节点 ID 变化）
  const stale = (controls.trigger_cuts ?? []).filter((c) => !paths.some((p) => p.status === 'controllable' && p.node === c.node && p.input === c.input && p.loader === c.loader))
  // 其他 Loader 的文本输出接入 Prompt：不是已验证的结构，只显示，不修改
  const known = new Set(paths.map((p) => p.loader))
  const unverified = findPromptInjectors(api, mapping).filter((i) => i.kind === 'loader_text' && i.polarity.length && !known.has(i.node))
  if (!shown.length && !quiet.length && !stale.length && !unverified.length) return null

  const setCut = (p: TriggerPath, managed: boolean) => {
    const rest = (controls.trigger_cuts ?? []).filter((c) => !(c.node === p.node && c.input === p.input))
    onControls({ ...controls, trigger_cuts: managed ? [...rest, cutOf(p)] : rest })
  }
  const setToggle = (p: TriggerPath, managed: boolean) => onMapping(managed ? [...mapping, newEntry(TRIGGER_DISABLE, p.node, 'toggle_trigger_words')] : mapping.filter((m) => !(m.source === TRIGGER_DISABLE && String(m.node) === p.node)))

  return (
    <section className="mb-3 rounded-xl bg-card p-2.5 ring-1 ring-tint/[0.08]" data-testid="trigger-paths">
      <div className="flex items-baseline gap-2 px-1 pb-1">
        <span className="text-[12.5px] font-medium">LoRA 自动触发词</span>
        <span className="text-[11px] text-muted-foreground">{shown.length ? `已检测到 ${shown.length} 条注入路径` : '没有进入 Prompt 的注入路径'}</span>
      </div>
      <div className="space-y-1">
        {shown.map((p) => {
          const key = `${p.node}:${p.input}`
          const toggle = p.status === 'toggle'
          const controllable = p.status === 'controllable'
          const managed = toggle ? p.disabled : isCut(controls, p)
          const expanded = open === key
          return (
            <div key={key} className="rounded-lg bg-tint/[0.025] px-2 py-1.5" data-testid="trigger-path" data-status={p.status} data-node={p.node} data-input={p.input}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <button type="button" onClick={() => setOpen(expanded ? null : key)} className="flex min-w-0 flex-1 items-center gap-1 text-left text-[11.5px] text-muted-foreground hover:text-foreground" data-testid="trigger-path-open">
                  {expanded ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />}
                  <span className="truncate font-mono select-text">{routeText(p)}</span>
                </button>
                {toggle || controllable ? <Choice managed={managed} onChange={(v) => (toggle ? setToggle(p, v) : setCut(p, v))} /> : <span className="shrink-0 rounded bg-warning/10 px-1.5 py-0.5 text-[11px] text-warning" data-testid="trigger-path-unsupported">无法确认，保持原样</span>}
              </div>
              {expanded && (
                <div className="mt-1.5 space-y-0.5 pl-4 text-[11px] leading-relaxed text-muted-foreground select-text" data-testid="trigger-path-detail">
                  {p.reason && <div className={cn(p.status === 'unsupported' && 'text-warning')}>{p.reason}</div>}
                  {controllable && (
                    <div className="font-mono">
                      #{p.node}.{p.input}: {JSON.stringify(api[p.node]?.inputs?.[p.input])} → {managed ? '""' : '不修改'}
                    </div>
                  )}
                  {toggle && <div>选择管理时写入 #{p.node} 的「禁止注入」：所有组关闭，节点输出空文本。</div>}
                  {(toggle || controllable) && <div>只改提交的副本，不修改导入的工作流。Loader #{p.loader} 的 MODEL、CLIP、LoRA 名称和权重不变。选择管理后，触发词由角色和服装 Prompt 负责。</div>}
                </div>
              )}
            </div>
          )
        })}
        {stale.map((c) => (
          <div key={`${c.node}:${c.input}`} className="flex items-center gap-2 rounded-lg bg-destructive/[0.07] px-2 py-1.5 text-[11.5px] text-destructive" data-testid="trigger-path-stale">
            <span className="min-w-0 flex-1">#{c.node}.{c.input} 已不是可确认的触发词路径，这条配置会阻止入队。</span>
            <button type="button" className="shrink-0 underline" data-testid="trigger-path-clear" onClick={() => onControls({ ...controls, trigger_cuts: (controls.trigger_cuts ?? []).filter((x) => x !== c) })}>清除</button>
          </div>
        ))}
        {unverified.map((i) => (
          <div key={i.node} className="rounded-lg bg-warning/[0.07] px-2 py-1.5 text-[11.5px] text-warning" data-testid="trigger-path-unverified">
            #{i.node}（{i.class_type}）的文本输出进入了 Prompt，不是已验证的 Loader 结构，保持原样。
          </div>
        ))}
        {quiet.length > 0 && <div className="px-1 text-[11px] text-muted-foreground">{quiet.map((p) => `#${p.loader} → #${p.node}`).join('、')}：没有进入 Prompt，不需要处理。</div>}
      </div>
    </section>
  )
}
