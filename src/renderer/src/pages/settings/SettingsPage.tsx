import { VaultPanel } from '@/components/VaultPanel'
// 设置：ComfyUI 连接、工作流映射、Prompt 组合、无人值守运行、数据与备份。

import { useState, type ReactNode } from 'react'
import { Database, FolderOpen, GripVertical, Moon, Plug, Plus, Combine, Star, Workflow as WorkflowIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { EmptyState, FieldLabel, NumberStepper, StatusDot, TextInput } from '@/components/common'
import { SortableArea, useSortableItem } from '@/components/sortable'
import { api, call } from '@/lib/api'
import { useAsync } from '@/lib/hooks'
import { reloadLib, useLib } from '@/lib/stores'
import { cn } from '@/lib/utils'
import { compose, MODULE_LABELS, normalizedOrder } from '@shared/prompt'
import type { Settings } from '@shared/types'
import { ImportHint, WorkflowEditor } from './WorkflowEditor'

type Section = 'comfy' | 'workflows' | 'compose' | 'run' | 'data'
const SECTIONS: [Section, string, ReactNode][] = [
  ['comfy', 'ComfyUI 连接', <Plug key="a" />],
  ['workflows', '工作流与映射', <WorkflowIcon key="b" />],
  ['compose', 'Prompt 组合', <Combine key="c" />],
  ['run', '无人值守运行', <Moon key="d" />],
  ['data', '数据与备份', <Database key="e" />],
]

async function setSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  await call(api['settings.set'](key, value))
  await reloadLib()
}

function Card({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="rounded-2xl bg-card p-5 ring-1 ring-white/[0.05]">
      <div className="mb-4">
        <div className="text-[14px] font-semibold">{title}</div>
        {description && <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</div>}
      </div>
      {children}
    </div>
  )
}

function ComfySection({ s }: { s: Settings }) {
  const [url, setUrl] = useState(s.comfy_url)
  const [out, setOut] = useState(s.comfy_output_dir)
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null)
  return (
    <div className="space-y-4">
      <VaultPanel />
      <Card title="ComfyUI 地址" description="本地 ComfyUI 的 HTTP 地址；WebSocket 地址会自动推导。">
        <div className="flex gap-2">
          <TextInput value={url} onChange={setUrl} onBlur={() => void setSetting('comfy_url', url.trim().replace(/\/+$/, ''))} mono />
          <Button
            variant="secondary"
            onClick={async () => {
              const u = url.trim().replace(/\/+$/, '')
              await setSetting('comfy_url', u)
              setTest({ ok: true, text: '正在连接…' })
              const r = await api['comfy.test'](u)
              setTest(r.ok ? { ok: true, text: `已连接 ${r.info}` } : { ok: false, text: r.error })
            }}
          >
            测试连接
          </Button>
        </div>
        {test && (
          <div className={cn('mt-3 flex items-center gap-2 text-xs', test.ok ? 'text-success' : 'text-destructive')}>
            <StatusDot tone={test.ok ? 'ok' : 'error'} /> {test.text}
          </div>
        )}
      </Card>
      <Card title="ComfyUI 输出目录" description="可选。软件不复制图片，只记录 ComfyUI 返回的文件信息；填写后可在运行记录中直接打开本地文件。未填写时通过 ComfyUI 的 /view 接口预览。">
        <div className="flex gap-2">
          <TextInput value={out} onChange={setOut} onBlur={() => void setSetting('comfy_output_dir', out.trim())} placeholder="例如 D:\ComfyUI\output" mono />
          <Button
            variant="secondary"
            onClick={async () => {
              const d = await api['app.chooseOutputDir']()
              if (d) {
                setOut(d)
                await setSetting('comfy_output_dir', d)
              }
            }}
          >
            <FolderOpen /> 浏览
          </Button>
        </div>
      </Card>
    </div>
  )
}

function WorkflowsSection() {
  const lib = useLib((s) => s.lib)
  const wfs = lib?.workflows ?? []
  const [sel, setSel] = useState<number | null>(wfs[0]?.id ?? null)
  const cur = wfs.find((w) => w.id === sel) ?? wfs[0]
  const doImport = async () => {
    const r = await call(api['workflows.import']())
    if (!r) return
    if ('error' in r) return toast.error('无法导入', { description: r.error })
    await reloadLib()
    setSel(r.id)
    toast.success('已导入工作流', { description: '下一步：配置节点输入映射（可先试试「自动识别」）。' })
  }
  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {wfs.map((w) => (
          <button
            key={w.id}
            type="button"
            onClick={() => setSel(w.id)}
            data-active={cur?.id === w.id || undefined}
            className="flex items-center gap-2 rounded-xl bg-card px-3 py-2 text-left ring-1 ring-white/[0.05] hover:bg-accent data-[active]:ring-primary/60"
          >
            <StatusDot tone={w.errors ? 'error' : w.mapping ? 'ok' : 'warn'} />
            <span className="text-[13px] font-medium">{w.name}</span>
            {lib?.settings.default_workflow_id === w.id && <Star className="size-3 fill-current text-warning" />}
          </button>
        ))}
        <Button variant={wfs.length ? 'ghost' : 'default'} size="sm" onClick={doImport}>
          <Plus /> 导入 API 工作流
        </Button>
      </div>
      {cur ? (
        <div className="flex min-h-0 flex-1 flex-col rounded-2xl bg-card p-5 ring-1 ring-white/[0.05]">
          <WorkflowEditor key={cur.id} id={cur.id} onDeleted={() => setSel(null)} />
        </div>
      ) : (
        <div className="rounded-2xl bg-card ring-1 ring-white/[0.05]">
          <EmptyState icon={<WorkflowIcon />} title="还没有导入工作流" description="导入你在 ComfyUI 中使用的工作流（API 格式），然后指定哪些节点输入接收 Prompt、Seed、LoRA 等。软件不会改动工作流的其他部分。" action={<Button onClick={doImport}><Plus /> 导入 API 工作流</Button>} />
          <div className="px-6 pb-6">
            <ImportHint />
          </div>
        </div>
      )}
      {cur && <ImportHint />}
    </div>
  )
}

function ModuleChip({ id }: { id: string }) {
  const s = useSortableItem(id)
  return (
    <div ref={s.setNodeRef} style={s.style} {...s.attributes} {...s.listeners} className={cn('flex cursor-grab items-center gap-1.5 rounded-lg bg-white/[0.06] py-1.5 pr-3 pl-2 text-[12.5px] ring-1 ring-white/[0.06] hover:bg-white/[0.09]', s.isDragging && 'shadow-xl shadow-black/50 ring-primary/50')}>
      <GripVertical className="size-3.5 text-muted-foreground/60" />
      {MODULE_LABELS[id]}
    </div>
  )
}

function ComposeSection({ s }: { s: Settings }) {
  const order = normalizedOrder(s.compose_order)
  const [pos, setPos] = useState(s.pos_separator)
  const [neg, setNeg] = useState(s.neg_separator)
  const sample = Object.fromEntries(order.map((m) => [m, [`〔${MODULE_LABELS[m]}〕`, ''] as [string, string]]))
  return (
    <div className="space-y-4">
      <Card title="组合顺序" description="拖动调整模块顺序。空模块自动跳过。修改只影响之后的预览与入队，已入队和已生成的记录不变。">
        <SortableArea items={order} grid getId={(m) => m} onReorder={(_f, _t, next) => void setSetting('compose_order', next)}>
          <div className="flex flex-wrap gap-2">
            {order.map((m) => (
              <ModuleChip key={m} id={m} />
            ))}
          </div>
        </SortableArea>
      </Card>
      <Card title="连接符" description={'原样插入模块之间，可写 \\n 表示换行，例如 ", "、",\\n" 或 "\\nBREAK\\n"。'}>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <FieldLabel>正面</FieldLabel>
            <TextInput value={pos} onChange={setPos} onBlur={() => void setSetting('pos_separator', pos)} mono />
          </div>
          <div>
            <FieldLabel>负面</FieldLabel>
            <TextInput value={neg} onChange={setNeg} onBlur={() => void setSetting('neg_separator', neg)} mono />
          </div>
        </div>
        <label className="mt-4 flex items-center gap-3 text-[13px]">
          <Switch checked={s.trim_modules} onCheckedChange={(v) => void setSetting('trim_modules', v)} />
          去除每个模块首尾的空白（模块内部文本不做任何改动）
        </label>
        <div className="mt-4">
          <FieldLabel>示例</FieldLabel>
          <pre className="rounded-xl bg-black/25 p-3 font-mono text-[12px] whitespace-pre-wrap">{compose(sample, { ...s, pos_separator: pos })[0]}</pre>
        </div>
      </Card>
    </div>
  )
}

function RunSection({ s }: { s: Settings }) {
  const row = (label: string, hint: string, key: keyof Settings, min: number, max: number, unit: string) => (
    <div className="flex items-center gap-4 border-b border-white/[0.04] py-3 last:border-0">
      <div className="min-w-0 flex-1">
        <div className="text-[13px]">{label}</div>
        <div className="mt-0.5 text-[11.5px] text-muted-foreground">{hint}</div>
      </div>
      <NumberStepper value={Number(s[key])} min={min} max={max} onChange={(v) => void setSetting(key, v as never)} />
      <span className="w-10 text-xs text-muted-foreground">{unit}</span>
    </div>
  )
  return (
    <Card title="无人值守运行" description="一次只向 ComfyUI 提交一张；通过 WebSocket 获取进度，并定期查询 /history 兜底。">
      {row('单张最长等待', '超过后该张标记为失败并继续下一张（不会取消 ComfyUI 中的任务）', 'unit_timeout_min', 1, 1440, '分钟')}
      {row('连续失败自动暂停', '例如映射错误、LoRA 不存在时，避免整个队列被刷成失败；0 表示不自动暂停', 'max_consecutive_failures', 0, 1000, '次')}
      {row('ComfyUI 断线最长等待', '无法连接时每 5 秒重试，超过后自动暂停', 'comfy_wait_max_min', 0, 1440, '分钟')}
      {row('结果轮询间隔', 'WebSocket 正常时用于兜底查询 /history', 'poll_interval_sec', 1, 60, '秒')}
    </Card>
  )
}

function DataSection() {
  const [info] = useAsync(() => api['app.info'](), [])
  if (!info) return null
  return (
    <Card title="数据与备份" description="所有模板、任务与运行记录保存在下面的数据库中，与程序代码分开，更新或重新安装程序不会丢失。每天首次启动时自动备份（保留最近 10 份），升级数据库结构前也会自动备份。">
      <div className="grid grid-cols-[96px_1fr] gap-x-3 gap-y-2 text-xs">
        <span className="text-muted-foreground">数据目录</span>
        <span className="font-mono break-all select-text">{info.dataDir}</span>
        <span className="text-muted-foreground">数据库</span>
        <span className="font-mono break-all select-text">{info.dbPath}</span>
        <span className="text-muted-foreground">备份目录</span>
        <span className="font-mono break-all select-text">{info.backupDir}</span>
        <span className="text-muted-foreground">版本</span>
        <span>{info.version}</span>
        {info.migratedFrom !== null && (
          <>
            <span className="text-muted-foreground">本次迁移</span>
            <span className="select-text">
              已从旧版数据库（v{info.migratedFrom}）升级，升级前备份：<span className="font-mono break-all">{info.backup}</span>
            </span>
          </>
        )}
      </div>
      <div className="mt-4 flex gap-2">
        <Button variant="secondary" onClick={() => void api['app.openDataDir']()}>
          <FolderOpen /> 打开数据目录
        </Button>
        <Button
          variant="secondary"
          onClick={async () => {
            const f = await call(api['app.backupNow']())
            if (f) toast.success('已备份', { description: f })
          }}
        >
          <Database /> 立即备份
        </Button>
      </div>
    </Card>
  )
}

export default function SettingsPage() {
  const lib = useLib((s) => s.lib)
  const [sec, setSec] = useState<Section>('comfy')
  if (!lib) return null
  const s = lib.settings
  return (
    <div className="flex h-full">
      <div className="w-[200px] shrink-0 px-3 pt-5">
        <h1 className="px-3 pb-3 text-[15px] font-semibold">设置</h1>
        {SECTIONS.map(([k, label, icon]) => (
          <button
            key={k}
            type="button"
            onClick={() => setSec(k)}
            data-active={sec === k || undefined}
            className="flex h-9 w-full items-center gap-2.5 rounded-lg px-3 text-[13px] text-muted-foreground hover:bg-white/[0.04] hover:text-foreground data-[active]:bg-white/[0.07] data-[active]:text-foreground [&_svg]:size-4"
          >
            {icon}
            {label}
          </button>
        ))}
      </div>
      <div className={cn('min-w-0 flex-1 px-6 py-5', sec === 'workflows' ? 'flex min-h-0 flex-col' : 'overflow-y-auto')}>
        <div className={cn(sec === 'workflows' ? 'flex min-h-0 flex-1 flex-col' : 'max-w-3xl')}>
          {sec === 'comfy' && <ComfySection key={s.comfy_url} s={s} />}
          {sec === 'workflows' && <WorkflowsSection />}
          {sec === 'compose' && <ComposeSection s={s} />}
          {sec === 'run' && <RunSection s={s} />}
          {sec === 'data' && <DataSection />}
        </div>
      </div>
    </div>
  )
}
