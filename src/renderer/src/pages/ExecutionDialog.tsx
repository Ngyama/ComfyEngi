// 执行详情：一张图片的每次提交。显示的内容全部来自提交快照与入队时冻结的工作流，不读取当前素材库，也不重新计算。

import { useEffect, useState } from 'react'
import { AlertCircle, CheckCircle2, ChevronDown, ChevronRight, Download } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { CopyButton, FieldLabel } from '@/components/common'
import { PickSources } from '@/components/card-pools'
import { api, call } from '@/lib/api'
import { cn } from '@/lib/utils'
import { SOURCE_LABELS } from '@shared/mapping'
import type { AttemptState, ExecutionDetail, ExecutionInspection, OutputFile } from '@shared/types'

const STATES: Record<AttemptState, [string, 'ok' | 'warn' | 'bad' | 'muted']> = {
  built: ['已构建，尚未确认提交', 'muted'],
  build_failed: ['无法构建', 'bad'],
  rejected: ['已提交，ComfyUI 拒绝（参数校验失败）', 'bad'],
  submit_unknown: ['提交时连接异常，不确定 ComfyUI 是否收到', 'warn'],
  submitted: ['已提交，等待执行结果', 'muted'],
  success: ['已提交，执行成功', 'ok'],
  failed: ['已提交，执行失败', 'bad'],
  interrupted: ['已提交，执行被中断', 'warn'],
  withdrawn: ['已提交，开始前撤回', 'muted'],
  lost: ['在 ComfyUI 中找不到（将重新提交）', 'warn'],
  timeout: ['已提交，等待超时', 'bad'],
}
const TONE = { ok: 'text-success', warn: 'text-warning', bad: 'text-destructive', muted: 'text-muted-foreground' }
const fmt = (t: number | null | undefined) => (t ? new Date(t * 1000).toLocaleString('zh-CN') : '—')
const text = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2) ?? String(v))

function Rows({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-1.5 text-xs">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <span className="text-muted-foreground">{k}</span>
          <span className="min-w-0 break-all select-text">{v}</span>
        </div>
      ))}
    </div>
  )
}

/** 长值默认折叠，展开后显示完整内容 */
function Value({ label, v }: { label: string; v: unknown }) {
  const s = text(v)
  const long = s.length > 160 || s.includes('\n')
  const [open, setOpen] = useState(false)
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2 text-[10.5px] text-muted-foreground">
        {label}
        {long && (
          <button type="button" className="inline-flex items-center hover:text-foreground" onClick={() => setOpen(!open)}>
            {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            {open ? '收起' : `完整值（${s.length} 字符）`}
          </button>
        )}
        <span className="ml-auto">
          <CopyButton text={s} />
        </span>
      </div>
      <pre className="mt-0.5 overflow-x-auto rounded-md bg-inset p-1.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap select-text">{long && !open ? `${s.slice(0, 160)}…` : s || '（空）'}</pre>
    </div>
  )
}

function Fold({ title, children, testid }: { title: string; children: React.ReactNode; testid?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div data-testid={testid}>
      <button type="button" className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        {title}
      </button>
      {open && <div className="mt-2">{children}</div>}
    </div>
  )
}

function Overview({ d, x }: { d: ExecutionDetail; x: ExecutionInspection }) {
  const u = d.unit
  const a = x.attempt
  const [label, tone] = STATES[a.state]
  const o = u.outputs?.[d.preview_index]
  return (
    <div className="space-y-4">
      <Rows
        rows={[
          ['提交状态', <span key="s" className={TONE[tone]} data-testid="attempt-state">{label}</span>],
          ['任务 ID', d.run?.task_id ?? '—'],
          ['任务 / 队列项', `${d.run?.name ?? '—'}（队列项 ${u.run_id}）`],
          ['生成单元 ID', `${u.id}（第 ${u.idx + 1} 张）`],
          ['ComfyUI Prompt ID', a.prompt_id ?? '—'],
          ['工作流', d.run?.workflow_name ?? '—'],
          ['构建时间', fmt(a.built_at)],
          ['提交时间', fmt(a.submitted_at)],
          ['完成时间', fmt(a.finished_at)],
          ['Seed', u.seed],
          ['生成尺寸（工作流）', x.size ? `${String(x.size.width)} × ${String(x.size.height)}（节点 #${x.size.node} ${x.size.class_type}）` : '—'],
          ['图片实际宽高', o?.image_width ? `${o.image_width} × ${o.image_height}` : '—'],
          ['动作卡', u.meta?.card ? `${u.meta.card}${u.meta.variant ? ` · ${u.meta.variant}` : ''}（组合 Seed ${u.meta.combo_seed ?? '—'}）` : '—'],
          ['快照校验', x.graph_json ? (x.intact ? `SHA-256 一致（${a.body_sha256.slice(0, 16)}…）` : '快照内容与记录的 SHA-256 不一致') : '没有快照'],
          ['ComfyUI 历史核对', a.comfy_match === null ? '没有可比较的历史记录' : a.comfy_match ? 'ComfyUI 记录的工作流与快照相同' : 'ComfyUI 记录的工作流与快照不同'],
        ]}
      />
      {a.error && <div className="rounded-xl bg-destructive/10 p-3 text-xs leading-relaxed whitespace-pre-wrap text-destructive select-text">{a.error}</div>}
      {a.response && a.state === 'rejected' && <Value label="ComfyUI 返回的错误详情" v={a.response} />}
      {u.meta?.card && (
        <div>
          <FieldLabel>动作卡素材</FieldLabel>
          <PickSources picks={u.meta.picks} card={u.meta.card} />
        </div>
      )}
      {x.loras.length > 0 && (
        <div>
          <FieldLabel>实际提交的 LoRA</FieldLabel>
          <div className="space-y-2 text-xs">
            {x.loras.map((l) => (
              <div key={l.node}>
                <div className="text-muted-foreground">节点 #{l.node} {l.class_type}</div>
                {l.items.map((i, k) => (
                  <div key={k} className={cn('font-mono text-[11px] select-text', !i.active && 'opacity-50')}>
                    {i.active ? '●' : '○'} {i.name} {String(i.strength ?? '')}{i.clip !== undefined && i.clip !== i.strength ? ` / clip ${String(i.clip)}` : ''}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
      {x.seeds.length > 0 && (
        <div>
          <FieldLabel>工作流中的 Seed 字段</FieldLabel>
          <div className="space-y-0.5 font-mono text-[11px] select-text">
            {x.seeds.map((s) => (
              <div key={`${s.node}.${s.input}`}>
                #{s.node} {s.class_type}.{s.input} = {s.value} <span className="text-muted-foreground">{s.changed ? '（ComfyEngi 写入）' : '（工作流原值）'}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {x.injectors.length > 0 && (
        <div data-testid="exec-injectors">
          <FieldLabel>未受 ComfyEngi Prompt 控制的节点</FieldLabel>
          <div className="space-y-2">
            {x.injectors.map((i) => (
              <div key={i.node} className={cn('rounded-lg p-2.5 text-[11.5px] leading-relaxed', i.disabled ? 'bg-success/[0.07]' : 'bg-warning/[0.07] text-warning')}>
                {i.message}
                {i.bypass && <div className="mt-1 font-medium">本次提交时 #{i.source_node} 加载的 LoRA 与保存工作流时不同：按插件逻辑，这个节点不使用开关状态，会输出这些 LoRA 的全部触发词。</div>}
                {i.groups && (
                  <div className="mt-1 space-y-0.5 font-mono text-[10.5px] text-muted-foreground select-text">
                    {i.groups.map((g, k) => (
                      <div key={k}>{g.active ? '● 启用' : '○ 关闭'} {g.text}</div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function PromptTab({ d }: { d: ExecutionDetail }) {
  const u = d.unit
  const full = `${u.positive}\n\n--- 负面 ---\n\n${u.negative}`
  return (
    <div className="space-y-4">
      <div className="rounded-lg bg-warning/[0.07] p-2.5 text-[11.5px] leading-relaxed text-warning">这是 ComfyEngi 写入工作流的 Prompt，不保证包含自定义节点在执行时额外注入的文本（例如 TriggerWord Toggle 的输出）。</div>
      <div className="flex justify-end"><CopyButton text={full} label="复制完整 Prompt" /></div>
      <div>
        <FieldLabel right={<CopyButton text={u.positive} />}>写入的正面 Prompt</FieldLabel>
        <pre className="rounded-xl bg-inset p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap select-text" data-testid="exec-positive">{u.positive || '（空）'}</pre>
      </div>
      <div>
        <FieldLabel right={<CopyButton text={u.negative} />}>写入的负面 Prompt</FieldLabel>
        <pre className="rounded-xl bg-inset p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap select-text">{u.negative || '（空）'}</pre>
      </div>
    </div>
  )
}

function ChangesTab({ x }: { x: ExecutionInspection }) {
  const nodes = [...new Set(x.changes.map((c) => c.node))]
  return (
    <div className="space-y-4">
      <div className="text-xs text-muted-foreground">比较入队时冻结的原始 API 工作流与这次实际提交的工作流：{nodes.length} 个节点的 {x.changes.length} 个字段不同，其余 {x.unchanged.length} 个节点完全沿用原值。</div>
      {nodes.map((nid) => {
        const list = x.changes.filter((c) => c.node === nid)
        return (
          <div key={nid} className="rounded-xl bg-tint/[0.03] p-3 ring-1 ring-tint/[0.08]" data-testid="exec-change-node" data-node={nid}>
            <div className="mb-2 text-xs font-medium select-text">
              节点 #{nid} {list[0].class_type}
              {list[0].title !== list[0].class_type && <span className="ml-1 font-normal text-muted-foreground">· {list[0].title}</span>}
            </div>
            <div className="space-y-3">
              {list.map((c) => (
                <div key={c.input} className="space-y-1">
                  <div className="font-mono text-[11.5px] select-text">
                    {c.input}
                    <span className="ml-2 font-sans text-[10.5px] text-muted-foreground">{c.source ? (SOURCE_LABELS[c.source] ?? (c.source === 'lora_stack' ? 'LoRA 列表' : c.source)) : '没有对应的写入记录'}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <Value label="原始值" v={c.before} />
                    <Value label="本次提交" v={c.after} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )
      })}
      <Fold title={`未修改的节点（${x.unchanged.length}）`} testid="exec-unchanged">
        <div className="space-y-1">
          {x.unchanged.map((n) => (
            <Fold key={n.node} title={`#${n.node} ${n.class_type}${n.title !== n.class_type ? ` · ${n.title}` : ''}`}>
              <pre className="overflow-x-auto rounded-md bg-inset p-2 font-mono text-[11px] whitespace-pre-wrap select-text">{JSON.stringify(n.inputs, null, 2)}</pre>
            </Fold>
          ))}
        </div>
      </Fold>
    </div>
  )
}

function WorkflowTab({ x }: { x: ExecutionInspection }) {
  const [show, setShow] = useState(false)
  if (!x.graph_json) return <div className="text-xs text-muted-foreground">这次提交没有快照（工作流无法构建，没有发送给 ComfyUI）。</div>
  return (
    <div className="space-y-3">
      <div className="text-xs leading-relaxed text-muted-foreground">格式：<b>API 工作流 JSON</b>，这次发送给 ComfyUI /prompt 的 prompt 字段，来自提交快照。可以直接用于调用 API，但它不是前端工作流，不一定能在 ComfyUI 画布中还原成原来的布局。</div>
      <div className="flex gap-2">
        <CopyButton text={x.graph_json} label="复制 JSON" />
        <Button
          size="sm"
          variant="secondary"
          onClick={async () => {
            const p = await call(api['history.exportAttempt'](x.attempt.id))
            if (p) toast.success('已导出', { description: p })
          }}
        >
          <Download /> 导出 JSON
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setShow(!show)} data-testid="exec-toggle-json">
          {show ? '收起' : `显示完整 JSON（${x.graph_json.length} 字符）`}
        </Button>
      </div>
      {show && <pre className="max-h-[56vh] overflow-auto rounded-xl bg-inset p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre select-text" data-testid="exec-json">{x.graph_json}</pre>}
    </div>
  )
}

const ROLE: Record<NonNullable<OutputFile['role']>, string> = { final: '最终输出', intermediate: '其他保存节点（未复制）', preview: '临时预览（未复制）' }

function OutputsTab({ d }: { d: ExecutionDetail }) {
  const outs = d.unit.outputs ?? []
  if (!outs.length) return <div className="text-xs text-muted-foreground">这次执行没有输出文件信息。</div>
  return (
    <div className="space-y-3">
      {outs.map((o, i) => {
        const check = d.file_checks[i]
        const match = o.source_sha256 && o.saved_sha256 ? o.source_sha256 === o.saved_sha256 : null
        return (
          <div key={i} className="rounded-xl bg-tint/[0.03] p-3 ring-1 ring-tint/[0.08]" data-testid="exec-output" data-node={o.node}>
            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs font-medium">
              节点 #{o.node}
              <span className="font-normal text-muted-foreground">{o.role ? ROLE[o.role] : o.type}</span>
              {i === d.preview_index && <span className="rounded bg-primary/15 px-1.5 text-[10.5px] text-primary" data-testid="exec-preview-mark">预览显示这个文件</span>}
            </div>
            <Rows
              rows={[
                ['Prompt ID', o.prompt_id ?? d.unit.prompt_id ?? '—'],
                ['ComfyUI 文件名', o.filename],
                ['subfolder', o.subfolder || '（无）'],
                ['type', o.type],
                ['本地副本', o.saved ?? (o.save_error ? '未保存' : '未复制')],
                ['下载内容 SHA-256', o.source_sha256 ?? '—'],
                ['本地文件 SHA-256', o.saved_sha256 ?? '—'],
                ['校验', match === null ? '—' : <span key="m" className={cn('inline-flex items-center gap-1', match ? 'text-success' : 'text-destructive')}>{match ? <CheckCircle2 className="size-3" /> : <AlertCircle className="size-3" />}{match ? '一致' : '不一致'}</span>],
                ['本地文件现状', check === null ? '—' : check ? '仍与保存时相同' : '已被修改或已不存在'],
              ]}
            />
            {o.reused && <div className="mt-2 text-[11px] text-muted-foreground">输出目录中已有内容完全相同的文件，直接关联它，没有另存一份。</div>}
            {o.same_file_as_node && <div className="mt-2 text-[11px] text-warning">节点 #{o.same_file_as_node} 报告了同一个 ComfyUI 文件：两个节点的输出写入了同一个文件名，请检查它们的 filename_prefix。</div>}
            {o.save_error && <div className="mt-2 text-[11px] text-destructive">{o.save_error}</div>}
          </div>
        )
      })}
      <div className="text-[11px] leading-relaxed text-muted-foreground">
        预览读取的文件：{d.preview_path || '通过 ComfyUI /view 读取'}。哈希一致只说明下载内容与本地文件相同，预览对应的是上面标记的那条输出记录。
      </div>
    </div>
  )
}

export function ExecutionDialog({ unitId, onClose }: { unitId: number; onClose: () => void }) {
  const [d, setD] = useState<ExecutionDetail | null>(null)
  const [attemptId, setAttemptId] = useState<number | null>(null)
  const [x, setX] = useState<ExecutionInspection | null>(null)
  useEffect(() => {
    void call(api['history.execution'](unitId)).then((r) => {
      if (!r) return
      setD(r)
      setAttemptId(r.attempts.at(-1)?.id ?? null)
    })
  }, [unitId])
  useEffect(() => {
    if (attemptId === null) return
    setX(null)
    void call(api['history.attempt'](attemptId)).then((r) => r && setX(r))
  }, [attemptId])
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[88vh] flex-col gap-3 sm:max-w-4xl" data-testid="execution-dialog">
        <DialogHeader className="shrink-0">
          <DialogTitle>执行详情</DialogTitle>
          <DialogDescription>{d ? `${d.unit.item_label} · 第 ${d.unit.idx + 1} 张。` : ''}内容来自提交时保存的快照，之后修改素材、动作卡或工作流不会改变这里的记录。</DialogDescription>
        </DialogHeader>
        {d && d.attempts.length > 1 && (
          <div className="flex shrink-0 flex-wrap items-center gap-1.5 text-xs" data-testid="attempt-picker">
            <span className="text-muted-foreground">提交记录</span>
            {d.attempts.map((a) => (
              <button key={a.id} type="button" onClick={() => setAttemptId(a.id)} className={cn('rounded-md px-2 py-1 hover:bg-tint/[0.06]', a.id === attemptId && 'bg-primary/15 text-primary')}>
                第 {a.attempt} 次 · <span className={TONE[STATES[a.state][1]]}>{STATES[a.state][0]}</span>
              </button>
            ))}
          </div>
        )}
        {d && !d.attempts.length ? (
          <div className="rounded-xl bg-inset p-4 text-xs leading-relaxed text-muted-foreground" data-testid="exec-no-snapshot">
            这张图片在升级前生成，没有保存提交快照，因此不显示「实际提交的 JSON」（不用当前数据重新计算一份看起来相同的内容）。Prompt：
            <pre className="mt-2 font-mono text-[11.5px] whitespace-pre-wrap select-text">{d.unit.positive}</pre>
          </div>
        ) : d && x ? (
          <Tabs defaultValue="overview" className="min-h-0 flex-1">
            <TabsList className="shrink-0">
              <TabsTrigger value="overview">概览</TabsTrigger>
              <TabsTrigger value="prompt">Prompt</TabsTrigger>
              <TabsTrigger value="changes">参数变更</TabsTrigger>
              <TabsTrigger value="workflow">完整工作流</TabsTrigger>
              <TabsTrigger value="outputs">输出文件</TabsTrigger>
            </TabsList>
            <div className="min-h-0 flex-1 overflow-y-auto pr-1">
              <TabsContent value="overview"><Overview d={d} x={x} /></TabsContent>
              <TabsContent value="prompt"><PromptTab d={d} /></TabsContent>
              <TabsContent value="changes"><ChangesTab x={x} /></TabsContent>
              <TabsContent value="workflow"><WorkflowTab x={x} /></TabsContent>
              <TabsContent value="outputs"><OutputsTab d={d} /></TabsContent>
            </div>
          </Tabs>
        ) : (
          <div className="py-8 text-center text-xs text-muted-foreground">读取中…</div>
        )}
      </DialogContent>
    </Dialog>
  )
}
