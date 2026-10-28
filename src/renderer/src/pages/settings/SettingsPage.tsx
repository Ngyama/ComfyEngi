// 设置：常用（常规、生成默认值、工作流管理）与高级（Prompt 组合、运行与恢复、数据与维护）两组。
import { VaultPanel } from '@/components/VaultPanel'

import { useState, type ReactNode } from 'react'
import { Combine, Database, Download, FolderOpen, GripVertical, Moon, Plug, Plus, RefreshCw, SlidersHorizontal, Star, Workflow as WorkflowIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { EmptyState, FieldLabel, NumberStepper, StatusDot, TextInput } from '@/components/common'
import { SortableArea, useSortableItem } from '@/components/sortable'
import { api, call } from '@/lib/api'
import { useAsync } from '@/lib/hooks'
import { reloadLib, templatesOf, useLib, useNav } from '@/lib/stores'
import { cn } from '@/lib/utils'
import { renderPrefix } from '@shared/mapping'
import { defaultItemCount, defaultSizes } from '@shared/planner'
import { compose, MODULE_LABELS, normalizedOrder } from '@shared/prompt'
import type { Settings } from '@shared/types'
import type { UpdateCheck } from '@shared/update'
import { ImportHint, Select, WorkflowEditor } from './WorkflowEditor'

type Section = 'comfy' | 'defaults' | 'workflows' | 'compose' | 'run' | 'data'
/** 普通设置在上，高级技术配置单独一组 */
const SECTION_GROUPS: [string, [Section, string, ReactNode][]][] = [
  [
    '常用',
    [
      ['comfy', '常规', <Plug key="a" />],
      ['defaults', '生成默认值', <SlidersHorizontal key="f" />],
      ['workflows', '工作流管理', <WorkflowIcon key="b" />],
    ],
  ],
  [
    '高级',
    [
      ['compose', '高级 Prompt 设置', <Combine key="c" />],
      ['run', '运行与恢复', <Moon key="d" />],
      ['data', '数据与维护', <Database key="e" />],
    ],
  ],
]

async function setSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  await call(api['settings.set'](key, value))
  await reloadLib()
}

function Card({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="rounded-2xl bg-card p-5 ring-1 ring-tint/[0.08]">
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
      <Card
        title="ComfyUI 输出目录（基础路径）"
        description="可选，填写 ComfyUI 自己的 output 文件夹，只用于在运行记录中定位 ComfyUI 保存的原文件。生成的图片会另外复制到任务的输出目录（见「生成默认值」）。未填写时通过 ComfyUI 的 /view 接口预览。"
      >
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

function DefaultsSection({ s }: { s: Settings }) {
  const lib = useLib((x) => x.lib)
  const globals = templatesOf(lib, 'global')
  const wfs = lib?.workflows ?? []
  const [vaultRoot] = useAsync(() => api['vault.info']().then((i) => i.root), [])
  const [dir, setDir] = useState(s.default_output_dir)
  const [prefix, setPrefix] = useState(s.default_output_prefix)
  const sep = vaultRoot?.includes('\\') ? '\\' : '/'
  const d = new Date()
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const row = (label: string, hint: ReactNode, control: ReactNode) => (
    <div className="flex items-center gap-4 border-b border-tint/[0.064] py-3 last:border-0">
      <div className="min-w-0 flex-1">
        <div className="text-[13px]">{label}</div>
        <div className="mt-0.5 text-[11.5px] text-muted-foreground">{hint}</div>
      </div>
      {control}
    </div>
  )
  return (
    <div className="space-y-4" data-testid="settings-defaults">
      <Card title="新任务默认值" description="只在新建任务、新加动作时使用；不会修改已有任务，也不影响已入队的生成快照。每个任务仍可单独调整。">
        {row(
          '默认全局 Prompt',
          '未设置时沿用当前任务的全局 Prompt',
          <Select
            className="w-52"
            value={String(s.default_global_id ?? '')}
            onChange={(v) => void setSetting('default_global_id', v ? Number(v) : null)}
            options={[['', '沿用当前任务'], ...globals.map((t): [string, string] => [String(t.id), t.name])]}
          />,
        )}
        {row(
          '默认工作流',
          '任务未单独选择工作流时使用；与「工作流管理」中的「设为默认」相同',
          <Select
            className="w-52"
            value={String(s.default_workflow_id ?? '')}
            onChange={(v) => void setSetting('default_workflow_id', v ? Number(v) : null)}
            options={[...(s.default_workflow_id ? [] : [['', '（未设置）'] as [string, string]]), ...wfs.map((w): [string, string] => [String(w.id), w.name])]}
          />,
        )}
        {row(
          '新动作默认张数',
          '添加动作时放在竖图，以 5 张为单位；之后可在动作详情中按尺寸调整',
          <NumberStepper value={defaultSizes(defaultItemCount(s)).portrait!} min={5} max={995} step={5} onChange={(v) => void setSetting('default_item_count', v)} />,
        )}
      </Card>
      <Card title="新任务默认输出" description="ComfyUI 先按文件名前缀保存到它自己的 output 目录，完成后本软件把最终图片复制到任务的输出目录（不覆盖同名文件，ComfyUI 原文件保留）。新建任务时把这里的值写入任务设置。">
        <FieldLabel>输出目录</FieldLabel>
        <div className="flex gap-2">
          <TextInput value={dir} onChange={setDir} onBlur={() => void setSetting('default_output_dir', dir.trim())} placeholder={vaultRoot ? `留空：${vaultRoot}${sep}output` : '留空：工作区 output 目录'} mono />
          <Button
            variant="secondary"
            onClick={async () => {
              const p = await api['app.chooseOutputDir']('选择新任务的默认输出目录')
              if (p) {
                setDir(p)
                await setSetting('default_output_dir', p)
              }
            }}
          >
            <FolderOpen /> 选择…
          </Button>
        </div>
        <div className="mt-4">
          <FieldLabel>文件名前缀</FieldLabel>
          <TextInput value={prefix} onChange={setPrefix} onBlur={() => void setSetting('default_output_prefix', prefix.trim())} placeholder="留空则使用工作流映射中的模板，例如 %date:yyyy-MM-dd%/image" mono />
          <div className="mt-1.5 text-[11.5px] text-muted-foreground" data-testid="default-prefix-preview">
            {prefix.trim() ? `示例：${renderPrefix(prefix.trim(), { meta: { task: '套图任务' }, index: 0, seed: 0 }, ymd)}_00001_.png` : '相对于 ComfyUI 的 output 目录；用 / 分隔子文件夹，不能填写绝对路径。'}
          </div>
        </div>
      </Card>
    </div>
  )
}

function WorkflowsSection() {
  const lib = useLib((s) => s.lib)
  const wfs = lib?.workflows ?? []
  const [sel, setSel] = useState<number | null>(() => useNav.getState().settingsTarget?.workflowId ?? wfs[0]?.id ?? null)
  const cur = wfs.find((w) => w.id === sel) ?? wfs[0]
  const doImport = async () => {
    const r = await call(api['workflows.import']())
    if (!r) return
    if ('error' in r) return toast.error('无法导入', { description: r.error })
    await reloadLib()
    setSel(r.id)
    toast.success('已导入工作流', {
      description: '下一步：配置节点输入映射（可先试试「自动识别」）。',
    })
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
            className="flex items-center gap-2 rounded-xl bg-card px-3 py-2 text-left ring-1 ring-tint/[0.08] hover:bg-accent data-[active]:ring-primary/60"
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
        <div className="flex min-h-0 flex-1 flex-col rounded-2xl bg-card p-5 ring-1 ring-tint/[0.08]">
          <WorkflowEditor key={cur.id} id={cur.id} onDeleted={() => setSel(null)} />
        </div>
      ) : (
        <div className="rounded-2xl bg-card ring-1 ring-tint/[0.08]">
          <EmptyState
            icon={<WorkflowIcon />}
            title="还没有导入工作流"
            description="导入你在 ComfyUI 中使用的工作流（API 格式），然后指定哪些节点输入接收 Prompt、Seed、LoRA 等。软件不会改动工作流的其他部分。"
            action={
              <Button onClick={doImport}>
                <Plus /> 导入 API 工作流
              </Button>
            }
          />
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
    <div
      ref={s.setNodeRef}
      style={s.style}
      {...s.attributes}
      {...s.listeners}
      className={cn('flex cursor-grab items-center gap-1.5 rounded-lg bg-tint/[0.06] py-1.5 pr-3 pl-2 text-[12.5px] ring-1 ring-tint/[0.096] hover:bg-tint/[0.09]', s.isDragging && 'shadow-xl shadow-tint/15 ring-primary/50')}
    >
      <GripVertical className="size-3.5 text-muted-foreground/60" />
      {MODULE_LABELS[id]}
    </div>
  )
}

function ComposeSection({ s }: { s: Settings }) {
  const order = normalizedOrder(s.compose_order)
  const [pos, setPos] = useState(s.pos_separator)
  const [posModule, setPosModule] = useState(s.pos_module_separator)
  const [neg, setNeg] = useState(s.neg_separator)
  const sample = Object.fromEntries(order.map((m) => [m, [`〔${MODULE_LABELS[m]}〕`, ''] as [string, string]]))
  return (
    <div className="space-y-4">
      <div className="rounded-xl bg-tint/[0.03] px-4 py-3 text-xs leading-relaxed text-muted-foreground ring-1 ring-tint/[0.06]">高级设置：决定 Prompt 各模块的拼接方式，影响所有任务之后的预览与入队。一般不需要修改。</div>
      <Card title="组合顺序" description="拖动调整模块顺序。空模块自动跳过。修改只影响之后的预览与入队，已入队和已生成的记录不变。">
        <SortableArea items={order} grid getId={(m) => m} onReorder={(_f, _t, next) => void setSetting('compose_order', next)}>
          <div className="flex flex-wrap gap-2">
            {order.map((m) => (
              <ModuleChip key={m} id={m} />
            ))}
          </div>
        </SortableArea>
      </Card>
      <Card
        title="连接符"
        description={'原样插入，可写 \\n 表示换行。正面：顶层模块之间默认空一行（",\\n\\n"，前一个模块末尾已有逗号时不会重复）；模块内部（例如主体位、子体位、行为之间）使用「模块内部」连接符。负面保持原有方式。'}
      >
        <div className="grid grid-cols-3 gap-3">
          <div>
            <FieldLabel>正面 · 模块之间</FieldLabel>
            <TextInput value={posModule} onChange={setPosModule} onBlur={() => void setSetting('pos_module_separator', posModule)} mono />
          </div>
          <div>
            <FieldLabel>正面 · 模块内部</FieldLabel>
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
          <pre className="rounded-xl bg-inset p-3 font-mono text-[12px] whitespace-pre-wrap">{compose(sample, { ...s, pos_separator: pos, pos_module_separator: posModule })[0]}</pre>
        </div>
      </Card>
    </div>
  )
}

function RunSection({ s }: { s: Settings }) {
  const row = (label: string, hint: string, key: keyof Settings, min: number, max: number, unit: string) => (
    <div className="flex items-center gap-4 border-b border-tint/[0.064] py-3 last:border-0">
      <div className="min-w-0 flex-1">
        <div className="text-[13px]">{label}</div>
        <div className="mt-0.5 text-[11.5px] text-muted-foreground">{hint}</div>
      </div>
      <NumberStepper value={Number(s[key])} min={min} max={max} onChange={(v) => void setSetting(key, v as never)} />
      <span className="w-10 text-xs text-muted-foreground">{unit}</span>
    </div>
  )
  return (
    <div className="space-y-4">
      <Card title="无人值守运行" description="一次只向 ComfyUI 提交一张；通过 WebSocket 获取进度，并定期查询 /history 兜底。">
        {row('单张最长等待', '超过后该张标记为失败并继续下一张（不会取消 ComfyUI 中的任务）', 'unit_timeout_min', 1, 1440, '分钟')}
        {row('连续失败自动暂停', '例如映射错误、LoRA 不存在时，避免整个队列被刷成失败；0 表示不自动暂停', 'max_consecutive_failures', 0, 1000, '次')}
        {row('ComfyUI 断线最长等待', '无法连接时每 5 秒重试，超过后自动暂停', 'comfy_wait_max_min', 0, 1440, '分钟')}
        {row('结果轮询间隔', 'WebSocket 正常时用于兜底查询 /history', 'poll_interval_sec', 1, 60, '秒')}
      </Card>
      <Card title="中断与恢复" description="自动进行，无需设置。">
        <ul className="list-disc space-y-1.5 pl-4 text-xs leading-relaxed text-muted-foreground">
          <li>队列和每张图片的生成快照保存在数据库中，关闭或崩溃后重新打开仍在，点击「开始」继续执行。</li>
          <li>继续时先核对已提交的图片：ComfyUI 已完成的直接补记录并复制到输出目录；仍在 ComfyUI 队列中的继续等待；找不到的重新提交（Seed 不变）。</li>
          <li>生成失败的图片可在执行队列中「重试失败项」，会重新生图。</li>
          <li>图片已生成但未能复制到输出目录时标记为「未保存」；修复目录后「重试保存」只重新下载并复制，不会重新生图。</li>
        </ul>
      </Card>
    </div>
  )
}

function UpdateCard({ version }: { version: string }) {
  const [checking, setChecking] = useState(false)
  const [r, setR] = useState<UpdateCheck | null>(null)
  const check = async () => {
    setChecking(true)
    const res = await call(api['app.checkUpdate']())
    setChecking(false)
    if (res) setR(res)
  }
  return (
    <Card title="关于与更新" description="检查本项目 GitHub Releases 中的最新正式版本。不会自动下载或安装，更新时请下载新的安装程序覆盖安装，工作区数据不受影响。">
      <div className="flex items-center gap-3" data-testid="update-card">
        <span className="text-[14px] font-semibold">ComfyEngi v{version}</span>
        <Button variant="secondary" size="sm" onClick={check} disabled={checking}>
          <RefreshCw className={cn(checking && 'animate-spin')} /> {checking ? '正在检查…' : '检查更新'}
        </Button>
      </div>
      {r && (
        <div className="mt-3 text-xs leading-relaxed" data-testid="update-result" data-kind={r.kind}>
          {r.kind === 'latest' && (
            <div className="flex items-center gap-2 text-success">
              <StatusDot tone="ok" /> 当前已是最新版（GitHub 最新版本 v{r.latest}）
            </div>
          )}
          {r.kind === 'no-release' && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <StatusDot tone="idle" /> {r.message}
            </div>
          )}
          {r.kind === 'error' && (
            <div className="flex items-start gap-2 text-destructive">
              <StatusDot tone="error" /> <span>检查失败：{r.message}</span>
            </div>
          )}
          {r.kind === 'available' && (
            <div className="space-y-2 rounded-xl bg-primary/[0.06] p-3 ring-1 ring-primary/20">
              <div className="flex items-center gap-2">
                <StatusDot tone="warn" />
                <span className="text-[13px] font-medium">发现新版本 v{r.latest}</span>
                {r.published_at && <span className="text-muted-foreground">{new Date(r.published_at).toLocaleDateString('zh-CN')}</span>}
              </div>
              {r.notes && <pre className="max-h-40 overflow-y-auto font-sans whitespace-pre-wrap text-muted-foreground select-text">{r.notes}</pre>}
              <Button size="sm" onClick={() => void call(api['app.openReleasePage'](r.url))}>
                <Download /> 下载更新
              </Button>
            </div>
          )}
        </div>
      )}
    </Card>
  )
}

function DataSection() {
  const [info] = useAsync(() => api['app.info'](), [])
  if (!info) return null
  return (
    <div className="space-y-4">
      <UpdateCard version={info.version} />
      <Card title="数据库备份" description="数据库保存设置、任务草稿、执行队列、逐张生成快照和运行记录。每天首次启动时自动备份（保留最近 10 份），迁移或升级数据库结构前也会自动备份。">
        <div className="grid grid-cols-[96px_1fr] gap-x-3 gap-y-2 text-xs">
          <span className="text-muted-foreground">工作区</span>
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
                已从旧版数据库（v{info.migratedFrom}）升级，升级前备份：
                <span className="font-mono break-all">{info.backup}</span>
              </span>
            </>
          )}
        </div>
        <div className="mt-4 flex gap-2">
          <Button variant="secondary" onClick={() => void api['app.openDataDir']()}>
            <FolderOpen /> 打开工作区文件夹
          </Button>
          <Button
            variant="secondary"
            onClick={async () => {
              const f = await call(api['app.backupNow']())
              if (f) toast.success('已备份数据库', { description: f })
            }}
          >
            <Database /> 立即备份数据库
          </Button>
        </div>
      </Card>
      <Card title="完整备份" description="数据库备份不包含以下内容，它们以普通文件保存在工作区中：">
        <ul className="list-disc space-y-1.5 pl-4 text-xs leading-relaxed text-muted-foreground">
          <li>角色、服装、动作、表情、剧情等 Prompt 资料（prompts/ 下的 Markdown 文件）</li>
          <li>工作流与节点映射（workflows/ 下的 JSON 文件）</li>
          <li>LoRA 管理信息与预览图（loras/）；LoRA 模型文件本身不在工作区中</li>
          <li>复制出来的生成图片（默认 output/，或任务指定的输出目录）</li>
        </ul>
        <div className="mt-3 text-xs leading-relaxed text-muted-foreground">完整备份：关闭应用后复制整个工作区文件夹。应用内删除的资料会移到 .comfyengi/trash/，可手动恢复。</div>
      </Card>
    </div>
  )
}

export default function SettingsPage() {
  const lib = useLib((s) => s.lib)
  const [sec, setSec] = useState<Section>(() => useNav.getState().settingsTarget?.section ?? 'comfy')
  if (!lib) return null
  const s = lib.settings
  return (
    <div className="flex h-full">
      <div className="w-[200px] shrink-0 px-3 pt-5">
        <h1 className="px-3 pb-3 text-[15px] font-semibold">设置</h1>
        {SECTION_GROUPS.map(([group, items], gi) => (
          <div key={group} className={cn(gi > 0 && 'mt-4')}>
            <div className="px-3 pb-1 text-[11px] text-muted-foreground/70">{group}</div>
            {items.map(([k, label, icon]) => (
              <button
                key={k}
                type="button"
                onClick={() => setSec(k)}
                data-active={sec === k || undefined}
                className="flex h-9 w-full items-center gap-2.5 rounded-lg px-3 text-[13px] text-muted-foreground hover:bg-tint/[0.04] hover:text-foreground data-[active]:bg-tint/[0.07] data-[active]:text-foreground [&_svg]:size-4"
              >
                {icon}
                {label}
              </button>
            ))}
          </div>
        ))}
      </div>
      <div className={cn('min-w-0 flex-1 px-6 py-5', sec === 'workflows' ? 'flex min-h-0 flex-col' : 'overflow-y-auto')}>
        <div className={cn(sec === 'workflows' ? 'flex min-h-0 flex-1 flex-col' : 'max-w-3xl')}>
          {sec === 'comfy' && <ComfySection key={s.comfy_url} s={s} />}
          {sec === 'defaults' && <DefaultsSection s={s} />}
          {sec === 'workflows' && <WorkflowsSection />}
          {sec === 'compose' && <ComposeSection s={s} />}
          {sec === 'run' && <RunSection s={s} />}
          {sec === 'data' && <DataSection />}
        </div>
      </div>
    </div>
  )
}
