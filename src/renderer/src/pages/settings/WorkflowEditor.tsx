// 工作流节点输入映射编辑：只写入这里列出的输入，工作流其他部分保持原样。

import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, CheckCircle2, ChevronDown, ChevronRight, Globe, Plus, RefreshCw, Sparkles, Star, Trash2, Wand2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { FieldLabel, SearchBox, TextInput } from '@/components/common'
import { api, call } from '@/lib/api'
import { confirm, reloadLib, useLib } from '@/lib/stores'
import { cn } from '@/lib/utils'
import {
  DEFAULT_PREFIX_TEMPLATE,
  describeValue,
  guessInput,
  isLink,
  newEntry,
  nodeTitle,
  PREFIX_HELP,
  PROMPT_SOURCES,
  SOURCES,
  isStackBinding,
  loraStackOf,
  parseLoraSource,
  parseStack,
  sortNodeIds,
  validateMapping,
} from '@shared/mapping'
import { analyzeWorkflow, mergeMapping, type Suggestion, type WorkflowAnalysis } from '@shared/workflow-analysis'
import { MODULES, MODULE_LABELS } from '@shared/prompt'
import type { MappingEntry, Message, Workflow } from '@shared/types'

export function Select({ value, onChange, options, className }: { value: string; onChange: (v: string) => void; options: [string, string][]; className?: string }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn('h-8 min-w-0 rounded-lg bg-tint/[0.045] px-2 text-[12.5px] ring-1 ring-tint/[0.112] outline-none focus:ring-primary/50', className)}
    >
      {options.map(([v, l]) => (
        <option key={v} value={v} className="bg-popover">
          {l}
        </option>
      ))}
    </select>
  )
}

const GROUPS: [Suggestion['group'], string][] = [
  ['prompt', 'Prompt'],
  ['seed', 'Seed'],
  ['lora', 'LoRA Loader'],
  ['output', '输出'],
  ['size', '生成尺寸'],
]

function SuggestDialog({ open, onOpenChange, analysis, onApply }: { open: boolean; onOpenChange: (o: boolean) => void; analysis: WorkflowAnalysis | null; onApply: (e: MappingEntry[]) => void }) {
  const suggestions = analysis?.suggestions ?? []
  const [checked, setChecked] = useState<boolean[]>([])
  useEffect(() => setChecked(suggestions.map((s) => s.checked)), [analysis]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-3xl">
        <DialogHeader className="shrink-0">
          <DialogTitle>自动识别</DialogTitle>
          <DialogDescription>根据节点类型与连接关系找到的候选。结构明确的项目已默认勾选，有歧义的需要你确认；应用后保存到这个工作流的映射中，之后无需重复设置。</DialogDescription>
        </DialogHeader>
        <div className="-mx-1 min-h-0 flex-1 space-y-4 overflow-y-auto px-1 py-0.5" data-testid="suggest-list">
          {(analysis?.notes ?? []).length > 0 && (
            <div className="space-y-1 rounded-lg bg-warning/[0.07] p-3 text-[11.5px] leading-relaxed text-warning" data-testid="suggest-notes">
              {analysis!.notes.map((n, i) => (
                <div key={i} className="flex gap-1.5">
                  <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                  <span>{n}</span>
                </div>
              ))}
            </div>
          )}
          {GROUPS.map(([g, title]) => {
            const rows = suggestions.map((s, i) => [s, i] as const).filter(([s]) => s.group === g)
            if (!rows.length) return null
            return (
              <section key={g}>
                <div className="mb-1 px-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{title}</div>
                {rows.map(([s, i]) => (
                  <label key={i} className="flex cursor-pointer items-start gap-3 rounded-lg px-2.5 py-2 hover:bg-tint/[0.04]" data-testid="suggest-row" data-group={g} data-node={s.node}>
                    <Checkbox className="mt-0.5" checked={!!checked[i]} onCheckedChange={(v) => setChecked((c) => c.map((x, j) => (j === i ? !!v : x)))} />
                    <div className="min-w-0 flex-1 text-[13px]">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="font-medium">{s.title}</span>
                        <span className="font-mono text-[11.5px] text-muted-foreground">{s.nodeLabel}</span>
                        <span className={cn('rounded px-1 text-[10px]', s.confidence === 'high' ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning')}>{s.confidence === 'high' ? '高置信度' : '需确认'}</span>
                      </div>
                      <div className="text-[11px] text-muted-foreground">{s.why}</div>
                      {s.preview && <div className="mt-0.5 truncate font-mono text-[10.5px] text-muted-foreground/80" title={s.preview}>原值：{s.preview}</div>}
                    </div>
                  </label>
                ))}
              </section>
            )
          })}
          {!suggestions.length && <div className="py-6 text-center text-xs text-muted-foreground">没有找到可识别的节点，请在右侧节点列表中手动添加映射。</div>}
        </div>
        <DialogFooter className="shrink-0">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            disabled={!checked.some(Boolean)}
            onClick={() => {
              onApply(suggestions.filter((_, i) => checked[i]).flatMap((s) => s.entries))
              onOpenChange(false)
            }}
          >
            应用勾选项
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ModulesPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="h-8 min-w-0 truncate rounded-lg bg-tint/[0.045] px-2.5 text-left text-[12px] ring-1 ring-tint/[0.112] hover:bg-tint/[0.07]">
          {value.length ? value.map((m) => MODULE_LABELS[m] ?? m).join('、') : '完整 Prompt（全部模块）'}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 space-y-1 p-2" align="start">
        <div className="px-1.5 pb-1.5 text-[11px] leading-relaxed text-muted-foreground">只把勾选的模块拼接到这个输入（按组合顺序）。全部不勾选 = 完整 Prompt。</div>
        {MODULES.map(([k, l]) => (
          <label key={k} className="flex cursor-pointer items-center gap-2.5 rounded-md px-1.5 py-1.5 text-[13px] hover:bg-tint/[0.05]">
            <Checkbox checked={value.includes(k)} onCheckedChange={(v) => onChange(v ? [...value, k] : value.filter((x) => x !== k))} />
            {l}
          </label>
        ))}
      </PopoverContent>
    </Popover>
  )
}

export function WorkflowEditor({ id, onDeleted }: { id: number; onDeleted: () => void }) {
  const lib = useLib((s) => s.lib)
  const [wf, setWf] = useState<Workflow | null>(null)
  const [q, setQ] = useState('')
  const [openNodes, setOpenNodes] = useState<Set<string>>(new Set())
  const [suggest, setSuggest] = useState<WorkflowAnalysis | null>(null)
  const [online, setOnline] = useState<Message[] | null>(null)
  const [checking, setChecking] = useState(false)
  useEffect(() => {
    setOnline(null)
    void api['workflows.get'](id).then(setWf)
  }, [id])
  const api_json = wf?.api_json ?? {}
  const ids = useMemo(() => sortNodeIds(Object.keys(api_json)), [api_json])
  if (!wf) return null
  const mapping = wf.mapping ?? []
  const msgs = validateMapping(api_json, mapping)
  const isDefault = lib?.settings.default_workflow_id === wf.id

  const saveMapping = async (m: MappingEntry[]) => {
    setWf({ ...wf, mapping: m })
    setOnline(null)
    await call(api['workflows.save']({ id: wf.id, _revision: wf._revision, mapping: m }))
    await reloadLib()
  }
  const setEntry = (i: number, p: Partial<MappingEntry>) => {
    const next = mapping.map((e, j) => (j === i ? { ...e, ...p } : e))
    const e = next[i]
    if ('node' in p) e.input = guessInput(e.source, api_json[e.node]?.inputs ?? {})
    if ('source' in p && p.source === 'filename_prefix' && !e.template) e.template = DEFAULT_PREFIX_TEMPLATE
    // LoRA 名称映射到多 LoRA Loader 的 loras 列表：默认追加为新条目
    if (parseLoraSource(e.source)?.field === 'name' && e.input === 'loras' && loraStackOf(api_json[e.node]) && !isStackBinding(e)) e.template = 'stack:append'
    void saveMapping(next)
  }
  const addFromInput = (nid: string, inp: string) => {
    const v = api_json[nid]?.inputs?.[inp]
    if (isLink(v)) {
      toast.error(`「${inp}」连接自节点 ${v[0]}，不是可直接填写的值，请映射提供该值的上游节点`)
      return
    }
    const guess: Record<string, string> = { text: 'positive', seed: 'seed', noise_seed: 'seed', lora_name: 'lora1_name', strength_model: 'lora1_strength', strength_clip: 'lora1_strength', filename_prefix: 'filename_prefix' }
    let src = guess[inp] ?? 'positive'
    if (src === 'positive' && mapping.some((e) => e.source === 'positive') && !mapping.some((e) => e.source === 'negative')) src = 'negative'
    void saveMapping([...mapping, newEntry(src, nid, inp, [], src === 'filename_prefix' ? DEFAULT_PREFIX_TEMPLATE : '')])
    toast.success(`已添加映射：${SOURCES.find(([k]) => k === src)?.[1]} → ${nid}.${inp}`)
  }
  const nodeOptions: [string, string][] = [['', '选择节点'], ...ids.map((nid) => [nid, `${nid} · ${api_json[nid].class_type}${nodeTitle(api_json[nid]) !== api_json[nid].class_type ? ` · ${nodeTitle(api_json[nid])}` : ''}`] as [string, string])]
  const shownIds = ids.filter((nid) => !q || `${nid} ${api_json[nid].class_type} ${nodeTitle(api_json[nid])} ${Object.keys(api_json[nid].inputs ?? {}).join(' ')}`.toLowerCase().includes(q.toLowerCase()))
  const allMsgs = online ?? msgs

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 pb-4">
        <input
          value={wf.name}
          onChange={(e) => setWf({ ...wf, name: e.target.value })}
          onBlur={async () => {
            await call(api['workflows.save']({ id: wf.id, _revision: wf._revision, name: wf.name.trim() || '未命名工作流' }))
            await reloadLib()
          }}
          className="min-w-0 flex-1 rounded-md bg-transparent text-[15px] font-semibold outline-none hover:bg-tint/[0.03] focus:bg-tint/[0.05]"
        />
        <span className="text-xs text-muted-foreground">{ids.length} 个节点</span>
        <Button
          variant={isDefault ? 'secondary' : 'ghost'}
          size="sm"
          disabled={isDefault}
          onClick={async () => {
            await call(api['settings.set']('default_workflow_id', wf.id))
            await reloadLib()
          }}
        >
          <Star className={cn(isDefault && 'fill-current')} /> {isDefault ? '默认工作流' : '设为默认'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={async () => {
            const r = await call(api['workflows.reimport'](wf.id))
            if (!r) return
            if ('error' in r) return toast.error('无法导入', { description: r.error })
            const nw = await api['workflows.get'](wf.id)
            setWf(nw)
            await reloadLib()
            if (nw && validateMapping(nw.api_json, nw.mapping).some(([l]) => l === 'error')) toast.warning('新的工作流与现有映射不匹配（节点 ID 或输入字段可能已变化），请检查下方提示')
            else toast.success('已更新工作流 JSON，映射保持不变')
          }}
        >
          <RefreshCw /> 更新 JSON
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="hover:text-destructive"
          onClick={async () => {
            const used = await api.references('workflow_id', wf.id)
            if (!(await confirm({ title: `删除工作流「${wf.name}」？`, description: '已加入队列的任务保存了工作流快照，不受影响。' + (used.length ? `\n以下任务指定了它，删除后将使用默认工作流：${used.join('、')}` : ''), confirmText: '删除', destructive: true }))) return
            await call(api['workflows.remove'](wf.id))
            await reloadLib()
            onDeleted()
          }}
        >
          <Trash2 />
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 gap-4">
        {/* 映射 */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2 pb-2">
            <FieldLabel hint="只有这里列出的输入会被写入">节点输入映射</FieldLabel>
            <div className="flex-1" />
            <Button size="sm" variant="ghost" onClick={() => setSuggest(analyzeWorkflow(api_json))}>
              <Wand2 /> 自动识别
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void saveMapping([...mapping, newEntry('positive')])}>
              <Plus /> 添加
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={checking}
              onClick={async () => {
                setChecking(true)
                const r = await call(api['workflows.onlineCheck'](wf.id))
                setChecking(false)
                if (r) setOnline(r)
              }}
              title="检查节点类型是否已安装、各角色的 LoRA 名称是否存在于 ComfyUI"
            >
              <Globe /> {checking ? '检查中…' : '联网校验'}
            </Button>
          </div>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
            {mapping.map((e, i) => {
              const node = api_json[e.node]
              const inputs: [string, string][] = Object.entries(node?.inputs ?? {})
                .filter(([, v]) => !isLink(v))
                .map(([k]) => [k, k])
              if (e.input && !inputs.some(([k]) => k === e.input)) inputs.push([e.input, `${e.input}（无效）`])
              if (!e.input) inputs.unshift(['', '选择输入'])
              const nodeOpts = e.node && !node ? [...nodeOptions, [e.node, `${e.node}（不存在）`] as [string, string]] : nodeOptions
              return (
                <div key={i} className="rounded-xl bg-tint/[0.03] p-2.5 ring-1 ring-tint/[0.08]">
                  <div className="grid grid-cols-[150px_minmax(0,1fr)_140px_28px] items-center gap-2">
                    <Select value={e.source} onChange={(v) => setEntry(i, { source: v })} options={SOURCES} />
                    <Select value={e.node} onChange={(v) => setEntry(i, { node: v })} options={nodeOpts} />
                    <Select value={e.input} onChange={(v) => setEntry(i, { input: v })} options={inputs} />
                    <Button variant="ghost" size="icon-sm" className="size-7 text-muted-foreground hover:text-destructive" onClick={() => void saveMapping(mapping.filter((_, j) => j !== i))} aria-label="删除映射">
                      <X />
                    </Button>
                  </div>
                  <div className="mt-2 flex items-center gap-2 pl-[158px] text-[11px] text-muted-foreground">
                    {PROMPT_SOURCES.includes(e.source) ? (
                      <>
                        <span className="shrink-0">写入</span>
                        <ModulesPicker value={e.modules ?? []} onChange={(m) => setEntry(i, { modules: m })} />
                      </>
                    ) : e.source === 'filename_prefix' ? (
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        <span className="shrink-0">模板</span>
                        <TextInput value={e.template || DEFAULT_PREFIX_TEMPLATE} onChange={(v) => setWf({ ...wf, mapping: mapping.map((x, j) => (j === i ? { ...x, template: v } : x)) })} onBlur={() => void saveMapping(wf.mapping)} mono className="h-8" />
                      </div>
                    ) : e.source.endsWith('_strength') ? (
                      '角色没有该槽位的 LoRA 时写入 0'
                    ) : isStackBinding(e) ? (
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        <span className="shrink-0">LoRA 列表</span>
                        <Select
                          value={e.template ?? 'stack:append'}
                          onChange={(v) => setEntry(i, { template: v })}
                          options={[['stack:append', '追加为新条目（同名则更新）'], ...parseStack(loraStackOf(node) ?? []).map((x) => [`stack:replace:${x.name}`, `替换「${x.name}」`] as [string, string])]}
                          className="min-w-0 flex-1"
                        />
                      </div>
                    ) : e.source.endsWith('_name') ? (
                      '角色没有该槽位的 LoRA 时保持工作流原值'
                    ) : (
                      '每张图使用计划中分配的 Seed'
                    )}
                    {node && e.input in (node.inputs ?? {}) && <span className="ml-auto max-w-56 shrink-0 truncate font-mono opacity-70">当前：{describeValue(node.inputs[e.input])}</span>}
                  </div>
                  {e.source === 'filename_prefix' && <div className="mt-1 pl-[158px] text-[10.5px] text-muted-foreground/70">可用占位符：{PREFIX_HELP}；用 / 分隔子文件夹</div>}
                </div>
              )
            })}
            {!mapping.length && (
              <div className="rounded-xl border border-dashed border-tint/[0.16] p-6 text-center text-xs leading-relaxed text-muted-foreground">
                还没有映射。点击「自动识别」查看候选，或在右侧节点列表中点击某个输入添加。
              </div>
            )}
          </div>
          <div className="mt-3 max-h-40 space-y-1 overflow-y-auto rounded-xl bg-inset p-3 text-xs">
            {!allMsgs.length ? (
              <div className="flex items-center gap-1.5 text-success">
                <CheckCircle2 className="size-3.5" /> {online ? '联网校验通过：节点类型均已安装，所有角色的 LoRA 名称都存在' : '映射有效'}
              </div>
            ) : (
              allMsgs.map(([lvl, m], i) => (
                <div key={i} className={cn('flex gap-1.5', lvl === 'error' ? 'text-destructive' : 'text-warning')}>
                  <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                  <span>{m}</span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* 节点浏览 */}
        <div className="flex w-[300px] shrink-0 flex-col">
          <FieldLabel hint="点击输入添加为映射">工作流节点</FieldLabel>
          <SearchBox value={q} onChange={setQ} placeholder="搜索节点 ID、类型或输入…" className="mb-2" />
          <div className="min-h-0 flex-1 overflow-y-auto rounded-xl bg-tint/[0.02] p-1 ring-1 ring-tint/[0.08]">
            {shownIds.map((nid) => {
              const n = api_json[nid]
              const open = openNodes.has(nid) || !!q
              const mapped = mapping.filter((e) => e.node === nid).length
              return (
                <div key={nid}>
                  <button
                    type="button"
                    onClick={() => setOpenNodes((s) => (s.has(nid) ? new Set([...s].filter((x) => x !== nid)) : new Set([...s, nid])))}
                    className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs hover:bg-tint/[0.04]"
                  >
                    {open ? <ChevronDown className="size-3 text-muted-foreground" /> : <ChevronRight className="size-3 text-muted-foreground" />}
                    <span className="w-7 shrink-0 font-mono text-muted-foreground">{nid}</span>
                    <span className="truncate">{n.class_type}</span>
                    {nodeTitle(n) !== n.class_type && <span className="truncate text-muted-foreground">· {nodeTitle(n)}</span>}
                    {mapped > 0 && <span className="ml-auto size-1.5 shrink-0 rounded-full bg-primary" />}
                  </button>
                  {open &&
                    Object.entries(n.inputs ?? {}).map(([k, v]) => {
                      const link = isLink(v)
                      return (
                        <button
                          key={k}
                          type="button"
                          disabled={link}
                          onClick={() => addFromInput(nid, k)}
                          className="group flex w-full items-center gap-2 rounded-md py-1 pr-2 pl-11 text-left text-[11.5px] enabled:hover:bg-primary/10 disabled:opacity-45"
                          title={link ? `连接自节点 ${(v as [string, number])[0]}` : '添加为映射'}
                        >
                          <span className="shrink-0 font-mono">{k}</span>
                          <span className="min-w-0 flex-1 truncate text-muted-foreground">{describeValue(v)}</span>
                          {!link && <Plus className="size-3 shrink-0 opacity-0 group-hover:opacity-100" />}
                        </button>
                      )
                    })}
                </div>
              )
            })}
          </div>
        </div>
      </div>

      <SuggestDialog
        open={!!suggest}
        onOpenChange={(o) => !o && setSuggest(null)}
        analysis={suggest}
        onApply={(entries) => void saveMapping(mergeMapping(mapping, entries))}
      />
    </div>
  )
}

export function ImportHint() {
  return (
    <div className="flex items-start gap-2 text-[11.5px] leading-relaxed text-muted-foreground">
      <Sparkles className="mt-0.5 size-3.5 shrink-0" />
      <span>需要 API 格式的 JSON：新版 ComfyUI 菜单「工作流 → 导出 (API)」；旧版在设置中开启开发者模式后使用 Save (API Format)。编辑器格式（含 nodes/links）会被拒绝。</span>
    </div>
  )
}
