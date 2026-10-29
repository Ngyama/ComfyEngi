// 历史 Prompt 提取：从保留生成参数的 PNG 中读取正向 Prompt，统计重复出现的标签组合，选择后保存为素材。
// 全部在本地完成（不联网、不需要 ComfyUI），不修改原图片；分析结果只是建议，点「保存所选」后才写入素材库。

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { BookA, ChevronDown, ChevronRight, ChevronUp, Copy, ListChecks, FileImage, FolderOpen, ImageOff, Loader2, Pickaxe, Plus, RotateCcw, Save, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Chip, EmptyState, PageHeader, PromptField, SearchBox, StatusDot, TextInput } from '@/components/common'
import { api, call } from '@/lib/api'
import { confirm, templatesOf, useLib } from '@/lib/stores'
import { cn } from '@/lib/utils'
import { MINING_SAVE_KINDS, type Candidate, type MiningParams, type RawMeta, type ScannedImage, type TagRef } from '@shared/mining'
import type { CandidateRole, SourceRule } from '@shared/prompt-source'
import { parseToken, promptSignature, removeTag, splitTopLevel } from '@shared/tags'
import { TEMPLATE_KINDS, type Template } from '@shared/types'
import {
  addCustom,
  addFiles,
  addFolder,
  analyze,
  applyRule,
  cancelScan,
  candidateOf,
  clearAll,
  clearManual,
  deleteRule,
  effective,
  includeAllCheck,
  includedImages,
  isIncluded,
  loadRules,
  moveRule,
  pickCandidate,
  reportFor,
  saveRule,
  setManualText,
  loadDict,
  patchDraft,
  removeDraft,
  saveSelected,
  setParams,
  toggleInclude,
  updateRule,
  useMining,
  type Draft,
} from './state'

const pct = (x: number) => `${Math.round(x * 100)}%`
const SOURCE_LABEL: Record<string, string> = {
  'comfy-api': 'ComfyUI 工作流（prompt）',
  'comfy-workflow': 'ComfyUI 界面工作流（workflow）',
  a1111: 'WebUI parameters',
  novelai: 'NovelAI',
  invokeai: 'InvokeAI',
  fooocus: 'parameters（JSON）',
  swarmui: 'SwarmUI',
  easydiffusion: '纯文本 prompt 字段',
}
const ROLE_LABEL: Record<CandidateRole, [string, string]> = {
  positive: ['连到正向', 'bg-success/15 text-success'],
  negative: ['连到负向', 'bg-destructive/10 text-destructive'],
  unused: ['未连接采样器', 'bg-tint/[0.06] text-muted-foreground'],
  unknown: ['无法判断', 'bg-warning/15'],
}
/** 失败原因分组：去掉节点编号等细节 */
const reasonKey = (e: string) => e.replace(/#\d+/g, '#…').replace(/\d+/g, 'N')

function useThumb(path: string | null, width: number) {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    setSrc(null)
    if (path) void api['mining.image'](path, width).then((s) => live && setSrc(s), () => live && setSrc(null))
    return () => {
      live = false
    }
  }, [path, width])
  return src
}

function Thumb({ path, width = 240, className }: { path: string; width?: number; className?: string }) {
  const src = useThumb(path, width)
  return (
    <div className={cn('grid place-items-center overflow-hidden rounded-lg bg-tint/[0.05]', className)}>
      {src ? <img src={src} alt="" className="size-full object-contain" /> : <ImageOff className="size-4 text-muted-foreground/50" />}
    </div>
  )
}

// ---------------- 图片列表

type ImgFilter = 'all' | 'ok' | 'check' | 'error' | 'meta' | 'used' | `reason:${string}`

function ImagePanel({ onOpen }: { onOpen: (id: string) => void }) {
  const { images, include, manual, hits, scanning, progress, scanErrors, found } = useMining()
  const [filter, setFilter] = useState<ImgFilter>('all')
  const [q, setQ] = useState('')
  const [showReasons, setShowReasons] = useState(false)
  const st = (im: ScannedImage) => effective(im, { manual, hits }).status
  const on = (im: ScannedImage) => isIncluded(im, { include, manual, hits })
  const match = (im: ScannedImage, f: ImgFilter) =>
    f === 'all' ? true : f === 'meta' ? im.fields.length > 0 : f === 'used' ? on(im) : f.startsWith('reason:') ? st(im) === 'error' && reasonKey(im.error ?? '') === f.slice(7) : st(im) === f
  const count = (f: ImgFilter) => images.filter((i) => match(i, f)).length
  const checkOut = images.filter((i) => st(i) === 'check' && !on(i)).length
  const reasons = useMemo(() => {
    const m = new Map<string, { text: string; n: number }>()
    for (const im of images) {
      if (effective(im, { manual, hits }).status !== 'error') continue
      const k = reasonKey(im.error ?? '')
      m.set(k, { text: m.get(k)?.text ?? im.error ?? '', n: (m.get(k)?.n ?? 0) + 1 })
    }
    return [...m.entries()].sort((a, b) => b[1].n - a[1].n)
  }, [images, manual, hits])
  const shown = images.filter((i) => match(i, filter) && (!q || i.name.toLowerCase().includes(q.toLowerCase())))
  const unsupported = found ? Object.values(found.unsupported).reduce((a, b) => a + b, 0) : 0
  const manualN = images.filter((i) => manual[i.id]?.positive.trim()).length
  const ruleN = images.filter((i) => !manual[i.id]?.positive.trim() && hits[i.id]?.used).length
  const tiles: [ImgFilter, string, string?][] = [
    ['all', '发现图片', unsupported ? `另有 ${unsupported} 张不支持的格式` : undefined],
    ['meta', '读到元数据'],
    ['ok', '提取成功', [manualN && `含手动指定 ${manualN} 张`, ruleN && `按来源规则 ${ruleN} 张`].filter(Boolean).join('，') || undefined],
    ['check', '需确认'],
    ['error', '失败'],
    ['used', '参与分析'],
  ]
  return (
    <div className="flex min-h-0 w-[340px] shrink-0 flex-col border-r border-tint/[0.06]" data-testid="mining-images">
      <div className="grid grid-cols-3 gap-1.5 px-4 pb-2" data-testid="mining-stats">
        {tiles.map(([k, l, sub]) => (
          <button
            key={k}
            type="button"
            onClick={() => setFilter(k)}
            data-active={filter === k || undefined}
            data-testid={`stat-${k}`}
            title={sub}
            className="rounded-lg bg-tint/[0.03] px-2 py-1.5 text-left ring-1 ring-tint/[0.06] hover:bg-tint/[0.05] data-[active]:bg-primary/[0.08] data-[active]:ring-primary/30"
          >
            <div className="truncate text-[10.5px] text-muted-foreground">{l}</div>
            <div className={cn('text-[15px] font-semibold tabular-nums', k === 'error' && count(k) && 'text-destructive', k === 'check' && count(k) && 'text-warning')} data-testid={`stat-${k}-n`}>
              {count(k)}
            </div>
          </button>
        ))}
      </div>
      {scanning && (
        <div className="mx-4 mb-2 rounded-lg bg-primary/[0.06] px-3 py-2 ring-1 ring-primary/20" data-testid="mining-progress">
          <div className="flex items-center gap-2 text-[12px]">
            <Loader2 className="size-3.5 animate-spin text-primary" />
            <span className="flex-1 truncate">{progress?.total ? `正在读取 ${progress.done} / ${progress.total}：${progress.file}` : '正在查找图片…'}</span>
            <Button variant="ghost" size="xs" onClick={cancelScan}>
              取消
            </Button>
          </div>
          {!!progress?.total && (
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-tint/[0.08]">
              <div className="h-full bg-primary transition-all" style={{ width: pct(progress.done / progress.total) }} />
            </div>
          )}
        </div>
      )}
      {!!scanErrors.length && (
        <div className="mx-4 mb-2 rounded-lg bg-warning/10 px-3 py-2 text-[11.5px] whitespace-pre-line text-foreground/80" data-testid="scan-errors">
          {scanErrors.join('\n')}
        </div>
      )}
      {checkOut > 0 && (
        <div className="mx-4 mb-2 flex items-center gap-2 rounded-lg bg-warning/10 px-3 py-2 text-[11.5px]" data-testid="check-banner">
          <span className="flex-1">{checkOut} 张需要确认的图片默认不参与分析</span>
          <Button size="xs" variant="secondary" onClick={() => setFilter('check')}>
            查看
          </Button>
          <Button size="xs" variant="secondary" onClick={includeAllCheck} data-testid="include-check">
            全部纳入
          </Button>
        </div>
      )}
      {!!reasons.length && (
        <div className="mx-4 mb-2 rounded-lg bg-destructive/[0.06] px-3 py-1.5 text-[11.5px]" data-testid="fail-reasons">
          <button type="button" className="flex w-full items-center gap-1 text-left text-destructive" onClick={() => setShowReasons(!showReasons)} data-testid="toggle-reasons">
            {showReasons ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            失败原因（{reasons.length} 类）
          </button>
          {showReasons && (
            <div className="mt-1 space-y-0.5 pb-1">
              {reasons.slice(0, 12).map(([k, r]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setFilter(`reason:${k}`)}
                  className={cn('flex w-full gap-2 rounded px-1 py-0.5 text-left hover:bg-tint/[0.05]', filter === `reason:${k}` && 'bg-tint/[0.06]')}
                  data-testid="fail-reason"
                >
                  <span className="line-clamp-2 min-w-0 flex-1">{r.text}</span>
                  <span className="text-muted-foreground tabular-nums">{r.n} 张</span>
                </button>
              ))}
              <div className="pt-0.5 text-muted-foreground">点击图片可查看原始元数据，并手动指定 Prompt 来源</div>
            </div>
          )}
        </div>
      )}
      <div className="flex items-center gap-2 px-4 pb-2">
        <SearchBox value={q} onChange={setQ} placeholder="搜索文件名…" className="flex-1" />
        <span className="text-[11px] whitespace-nowrap text-muted-foreground">显示 {shown.length}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4" data-testid="mining-image-list">
        {shown.map((im) => (
          <ImageRow key={im.id} im={im} on={on(im)} onOpen={() => onOpen(im.id)} />
        ))}
        {!shown.length && <div className="py-10 text-center text-xs text-muted-foreground">没有图片</div>}
      </div>
    </div>
  )
}

function ImageRow({ im, on, onOpen }: { im: ScannedImage; on: boolean; onOpen: () => void }) {
  const { manual, hits } = useMining()
  const e = effective(im, { manual, hits })
  return (
    <div className="group flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-tint/[0.04]" data-testid="mining-image" data-status={e.status} data-manual={e.manual ? '' : undefined} data-rule={e.viaRule ? '' : undefined}>
      <Checkbox className="mt-0.5" checked={on} disabled={e.status === 'error'} onCheckedChange={(v) => toggleInclude(im.id, !!v)} aria-label={`${im.name} 参与分析`} />
      <button type="button" className="min-w-0 flex-1 text-left" onClick={onOpen}>
        <div className="flex items-center gap-1.5">
          <StatusDot tone={e.status === 'ok' ? 'ok' : e.status === 'check' ? 'warn' : 'error'} />
          <span className="truncate text-[12.5px]">{im.name}</span>
          {e.manual && <span className="shrink-0 rounded bg-primary/10 px-1 text-[10px] text-primary">手动</span>}
          {e.viaRule && <span className="shrink-0 rounded bg-primary/10 px-1 text-[10px] text-primary" title={e.viaRule.rule.name}>规则</span>}
          {!e.manual && hits[im.id]?.conflict && <span className="shrink-0 rounded bg-warning/15 px-1 text-[10px]" title="来源规则得到的 Prompt 与自动识别不同">差异</span>}
        </div>
        <div className={cn('truncate text-[11px]', e.status === 'error' ? 'text-destructive' : 'font-mono text-muted-foreground')}>
          {e.status === 'error' ? im.error : e.status === 'check' ? `需要确认：${im.notes.at(-1)}` : e.positive.replace(/\s+/g, ' ')}
        </div>
      </button>
    </div>
  )
}

type DlgTab = 'prompt' | 'sources' | 'raw'

function ImageDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { images, include, manual, hits, result } = useMining()
  const [tab, setTab] = useState<DlgTab>('prompt')
  const im = images.find((i) => i.id === id)
  useEffect(() => setTab('prompt'), [id])
  const same = result?.duplicates.find((g) => id && g.includes(id))
  const e = im ? effective(im, { manual, hits }) : null
  return (
    <Dialog open={!!im} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[min(88vh,820px)] flex-col gap-3 sm:max-w-5xl" data-testid="mining-image-dialog">
        {im && e && (
          <>
            <DialogHeader>
              <DialogTitle className="truncate">{im.name}</DialogTitle>
              <DialogDescription className="truncate">{im.folder}</DialogDescription>
            </DialogHeader>
            <div className="flex min-h-0 flex-1 gap-4 overflow-hidden">
              <div className="flex w-[32%] shrink-0 flex-col gap-2 self-start">
                <Thumb path={im.id} width={600} className="h-auto max-h-[52vh] w-full" />
                <Button variant="ghost" size="sm" className="self-start" onClick={() => void call(api['mining.showInFolder'](im.id))}>
                  <FolderOpen /> 在文件夹中显示
                </Button>
              </div>
              <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2 text-[12px]">
                  <StatusDot tone={e.status === 'ok' ? 'ok' : e.status === 'check' ? 'warn' : 'error'} />
                  <span data-testid="img-status">{e.manual ? '已手动指定' : e.viaRule ? '按来源规则读取' : e.status === 'ok' ? '已读取' : e.status === 'check' ? '需要确认' : '无法提取'}</span>
                  {im.source && !e.manual && !e.viaRule && <span className="text-muted-foreground">来源：{SOURCE_LABEL[im.source] ?? im.source}</span>}
                  {e.status !== 'error' && (
                    <label className="ml-auto flex items-center gap-1.5">
                      <Checkbox checked={isIncluded(im, { include, manual, hits })} onCheckedChange={(v) => toggleInclude(im.id, !!v)} />
                      参与分析
                    </label>
                  )}
                </div>
                <div className="flex self-start rounded-xl bg-tint/[0.04] p-1">
                  {(
                    [
                      ['prompt', '正向 Prompt'],
                      ['sources', `Prompt 来源 ${im.candidates.length}`],
                      ['raw', `原始元数据 ${im.fields.length}`],
                    ] as [DlgTab, string][]
                  ).map(([k, l]) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setTab(k)}
                      data-active={tab === k || undefined}
                      data-testid={`img-tab-${k}`}
                      className="h-7 rounded-lg px-3 text-[12.5px] text-muted-foreground transition hover:text-foreground data-[active]:bg-tint/[0.09] data-[active]:text-foreground"
                    >
                      {l}
                    </button>
                  ))}
                </div>
                <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
                  {tab === 'prompt' && <PromptPanel im={im} same={same ? same.length - 1 : 0} onSources={() => setTab('sources')} onRaw={() => setTab('raw')} />}
                  {tab === 'sources' && <SourcesPanel im={im} />}
                  {tab === 'raw' && <RawPanel im={im} />}
                </div>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function PromptPanel({ im, same, onSources, onRaw }: { im: ScannedImage; same: number; onSources: () => void; onRaw: () => void }) {
  const { manual, hits } = useMining()
  const e = effective(im, { manual, hits })
  const m = manual[im.id]
  const hit = hits[im.id]
  return (
    <>
      {im.error && !e.manual && !e.viaRule && (
        <div className="rounded-lg bg-destructive/10 px-3 py-2 text-[12px] text-destructive" data-testid="img-error">
          {im.error}
          <div className="mt-1.5 flex flex-wrap gap-2 text-foreground">
            {!!im.candidates.length && (
              <Button size="xs" variant="secondary" onClick={onSources} data-testid="goto-sources">
                从 {im.candidates.length} 个文本来源中选择
              </Button>
            )}
            {!!im.fields.length && (
              <Button size="xs" variant="secondary" onClick={onRaw} data-testid="goto-raw">
                查看原始元数据
              </Button>
            )}
          </div>
        </div>
      )}
      {e.viaRule && !m && (
        <div className="rounded-lg bg-primary/[0.06] px-3 py-2 text-[12px] ring-1 ring-primary/20" data-testid="via-rule">
          按来源规则「{e.viaRule.rule.name}」读取：{e.viaRule.c.label}
          {im.status !== 'ok' && <span className="text-muted-foreground">（自动提取：{im.status === 'error' ? im.error : '需要确认'}）</span>}
          {im.fallback && im.positive && <span className="text-muted-foreground">（自动识别的已知节点结果已被规则替代）</span>}
        </div>
      )}
      {hit?.conflict && !m && (
        <div className="rounded-lg bg-warning/10 px-3 py-2 text-[12px]" data-testid="rule-conflict">
          来源规则「{hit.rule.name}」得到的 Prompt 与自动识别结果不同，当前保留自动识别结果：
          <div className="mt-1 line-clamp-3 font-mono text-[11.5px] break-all whitespace-pre-wrap">{hit.c.text}</div>
          <Button size="xs" variant="secondary" className="mt-1.5" onClick={() => pickCandidate(im.id, hit.c)} data-testid="use-rule-result">
            改用规则结果
          </Button>
        </div>
      )}
      {e.viaRule?.c.warn && !m && <div className="rounded-lg bg-warning/10 px-3 py-2 text-[12px]">{e.viaRule.c.warn}</div>}
      {!!im.notes.length && <div className="rounded-lg bg-warning/10 px-3 py-2 text-[12px] whitespace-pre-line">{im.notes.join('\n')}</div>}
      {same > 0 && <div className="text-[12px] text-muted-foreground">与另外 {same} 张图片的 Prompt 完全相同</div>}
      {m ? (
        <>
          <PromptField label={`正向 Prompt（${m.label ? `手动指定：${m.label}` : '手动修改'}）`} value={m.positive} onChange={(v) => setManualText(im.id, v)} copy minRows={4} />
          <Button size="xs" variant="ghost" onClick={() => clearManual(im.id)} data-testid="clear-manual">
            <RotateCcw /> 恢复自动提取
          </Button>
        </>
      ) : (
        <>
          {e.status !== 'error' && <PromptField label={e.viaRule ? '正向 Prompt（来源规则）' : '正向 Prompt（原文）'} value={e.positive} readOnly copy minRows={4} />}
          <div className="flex gap-2">
            <Button size="xs" variant="ghost" onClick={() => setManualText(im.id, e.positive)} data-testid="edit-manual">
              {e.status === 'error' ? '手动输入 Prompt' : '手动修改'}
            </Button>
            {e.status !== 'error' && !!im.candidates.length && (
              <Button size="xs" variant="ghost" onClick={onSources}>
                改用其他来源
              </Button>
            )}
          </div>
        </>
      )}
      {im.negative && <PromptField label="负向 Prompt（不参与分析）" value={im.negative} readOnly minRows={2} />}
    </>
  )
}

function ApplyBox({ im, rule }: { im: ScannedImage; rule: SourceRule }) {
  const { manual, hits, images } = useMining()
  const [strict, setStrict] = useState(false)
  const [override, setOverride] = useState(false)
  const [name, setName] = useState('')
  const r = useMemo(() => ({ ...rule, strictId: strict && !!rule.nodeId }), [rule, strict])
  const rep = useMemo(() => reportFor(r, im.id, override, { images, manual, hits }), [r, im.id, override, images, manual, hits])
  const isNode = r.kind === 'node'
  const rows: [string, number, string][] = [
    ['已是此来源的 Prompt', rep.same, 'same'],
    ['自动提取已成功（保留）', rep.autoKept, 'auto'],
    [isNode ? `没有 ${r.classType} 节点（或该字段为空）` : '没有这个字段', rep.missing, 'missing'],
    ['有多个同类型节点，无法区分', rep.ambiguous, 'ambiguous'],
    ['唯一的同类型节点连到负向（不会当作正向）', rep.negative, 'negative'],
    [`节点 #${r.nodeId} 是其他类型`, rep.idMismatch, 'id'],
    ['已手动修改，跳过', rep.edited, 'edited'],
    ['没有可读取的元数据', rep.noMeta, 'nometa'],
  ]
  return (
    <div className="space-y-2 rounded-lg bg-primary/[0.06] px-3 py-2.5 text-[12px] ring-1 ring-primary/20" data-testid="apply-rule-box">
      <div>
        当前使用「{rule.label}」{isNode && rule.nodeId ? `（本图节点 #${rule.nodeId}）` : ''}。
        {isNode ? '在其他图片中查找同类型节点的同一字段（不要求其他节点和连线一致），每张图片读取自己节点中的文本。' : '在其他图片中读取同名字段。'}
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11.5px]" data-testid="apply-report">
        <div>
          扫描图片 <b className="tabular-nums">{rep.total}</b> 张
        </div>
        <div data-testid="report-targets">
          可以应用 <b className="text-primary tabular-nums">{rep.targets.length}</b> 张
        </div>
        {rows
          .filter(([, n]) => n > 0)
          .map(([l, n, k]) => (
            <div key={k} className="text-muted-foreground" data-testid={`report-${k}`}>
              {l} <span className="tabular-nums">{n}</span> 张
            </div>
          ))}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        {isNode && rule.nodeId && (
          <label className="flex items-center gap-1.5" title="只匹配相同节点编号的节点，同时校验节点类型与字段">
            <Checkbox checked={strict} onCheckedChange={(v) => setStrict(!!v)} data-testid="strict-id" />
            只匹配节点 #{rule.nodeId}
          </label>
        )}
        {(rep.autoKept > 0 || override) && (
          <label className="flex items-center gap-1.5">
            <Checkbox checked={override} onCheckedChange={(v) => setOverride(!!v)} data-testid="override-auto" />
            也替换自动提取成功但内容不同的图片
          </label>
        )}
        <div className="flex-1" />
        <Button size="xs" disabled={!rep.targets.length} onClick={() => void applyRule(r, im.id, override)} data-testid="apply-rule">
          应用到 {rep.targets.length} 张
        </Button>
      </div>
      <div className="flex items-center gap-2 border-t border-primary/15 pt-2">
        <TextInput value={name} onChange={setName} placeholder={rule.label} className="h-7 max-w-64 text-[12px]" />
        <Button size="xs" variant="secondary" onClick={() => void saveRule(r, name)} data-testid="save-rule">
          保存为来源规则
        </Button>
        <span className="text-[11px] text-muted-foreground">保存在工作区中，以后扫描时自动使用（自动提取可靠时不覆盖，只提示差异）</span>
      </div>
    </div>
  )
}

function SourcesPanel({ im }: { im: ScannedImage }) {
  const manual = useMining((s) => s.manual)
  const cur = manual[im.id]
  if (!im.candidates.length)
    return <EmptyState title="没有可选择的文本来源" description={im.fields.length ? '元数据中没有找到可能是 Prompt 的文本。可以在「原始元数据」中查看内容，或在「正向 Prompt」中手动输入。' : '图片中没有任何文本元数据（可能已被压缩、转存或清除）。'} />
  return (
    <div className="space-y-2" data-testid="img-sources">
      <div className="text-[11.5px] text-muted-foreground">元数据中所有可能是 Prompt 的文本。选择一项作为这张图片的正向 Prompt，然后可以应用到其他图片，或保存为来源规则。</div>
      {cur?.rule && <ApplyBox key={`${cur.rule.key}:${cur.rule.nodeId ?? ''}`} im={im} rule={cur.rule} />}
      {im.candidates.map((c) => {
        const active = !!cur?.rule && cur.positive === c.text && cur.label === c.label
        const [rl, rc] = ROLE_LABEL[c.role]
        return (
          <div key={c.key} className={cn('rounded-lg bg-card p-2.5 ring-1 ring-tint/[0.08]', active && 'ring-primary/50')} data-testid="img-source" data-role={c.role}>
            <div className="flex items-center gap-2 text-[12px]">
              <span className={cn('shrink-0 rounded px-1.5 text-[10.5px]', rc)}>{rl}</span>
              <span className="min-w-0 flex-1 truncate font-medium" title={c.label}>
                {c.label}
              </span>
              {active ? (
                <span className="text-[11px] text-primary">当前使用</span>
              ) : (
                <Button size="xs" variant="secondary" onClick={() => pickCandidate(im.id, c)} data-testid="use-source">
                  使用此文本
                </Button>
              )}
            </div>
            {c.warn && <div className="mt-1 text-[11px] text-warning" data-testid="source-warn">{c.warn}</div>}
            <div className="mt-1 line-clamp-4 font-mono text-[11.5px] break-all whitespace-pre-wrap text-foreground/80">{c.text}</div>
          </div>
        )
      })}
    </div>
  )
}

function RulesDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { rules, hits, images } = useMining()
  const stats = (id: string) => {
    const hs = Object.values(hits).filter((h) => h.rule.id === id)
    return { used: hs.filter((h) => h.used).length, conflict: hs.filter((h) => h.conflict).length }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl" data-testid="rules-dialog">
        <DialogHeader>
          <DialogTitle>Prompt 来源规则</DialogTitle>
          <DialogDescription>
            在图片详情的「Prompt 来源」中选择一项后可保存为规则。扫描图片时，自动提取失败或需要确认的图片按规则读取唯一匹配的节点字段；自动提取可靠时不覆盖，只提示差异。规则保存在工作区 data/prompt-source-rules.json，随工作区迁移；靠前的规则优先。
          </DialogDescription>
        </DialogHeader>
        {!rules.length && <div className="rounded-xl bg-tint/[0.03] px-3 py-6 text-center text-[12.5px] text-muted-foreground">还没有来源规则</div>}
        <div className="max-h-[60vh] space-y-2 overflow-y-auto">
          {rules.map((r, i) => {
            const st = stats(r.id)
            return (
              <div key={r.id} className="rounded-xl bg-card p-3 ring-1 ring-tint/[0.08]" data-testid="rule-row">
                <div className="flex items-center gap-2">
                  <Checkbox checked={r.enabled} onCheckedChange={(v) => void updateRule(r.id, { enabled: !!v })} aria-label={`启用 ${r.name}`} />
                  <TextInput value={r.name} onChange={(v) => useMining.setState({ rules: rules.map((x) => (x.id === r.id ? { ...x, name: v } : x)) })} onBlur={() => void updateRule(r.id, { name: r.name })} className="h-8 max-w-72 text-[13px] font-medium" />
                  <div className="flex-1" />
                  <Button size="icon-sm" variant="ghost" disabled={i === 0} onClick={() => moveRule(r.id, -1)} aria-label="上移">
                    <ChevronUp />
                  </Button>
                  <Button size="icon-sm" variant="ghost" disabled={i === rules.length - 1} onClick={() => moveRule(r.id, 1)} aria-label="下移">
                    <ChevronDown />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`删除 ${r.name}`}
                    data-testid="delete-rule"
                    onClick={async () => {
                      if (await confirm({ title: `删除来源规则「${r.name}」？`, description: '只删除规则，不影响图片、手动指定的内容和已保存的素材。', confirmText: '删除', destructive: true })) await deleteRule(r.id)
                    }}
                  >
                    <Trash2 />
                  </Button>
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-muted-foreground">
                  <span className="font-mono">{r.rule.kind === 'node' ? `${r.rule.classType} · ${r.rule.field === '@encoded' ? '编码的文本' : r.rule.field}` : r.rule.label}</span>
                  {r.rule.kind === 'node' && r.rule.nodeId && (
                    <label className="flex items-center gap-1.5">
                      <Checkbox checked={!!r.rule.strictId} onCheckedChange={(v) => void updateRule(r.id, { strictId: !!v })} />
                      只匹配节点 #{r.rule.nodeId}
                    </label>
                  )}
                  <span>
                    当前 {images.length} 张中按此规则读取 <b className="text-foreground tabular-nums">{st.used}</b> 张{st.conflict ? ` · 与自动识别不同 ${st.conflict} 张` : ''}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function RawPanel({ im }: { im: ScannedImage }) {
  const [meta, setMeta] = useState<RawMeta | null>(null)
  const [open, setOpen] = useState<Record<number, boolean>>({})
  useEffect(() => {
    let live = true
    setMeta(null)
    setOpen({})
    void call(api['mining.meta'](im.id)).then((m) => live && setMeta(m ?? null))
    return () => {
      live = false
    }
  }, [im.id])
  if (!meta) return <div className="py-8 text-center text-xs text-muted-foreground">正在读取…</div>
  return (
    <div className="space-y-2" data-testid="img-raw">
      <div className="text-[11.5px] text-muted-foreground">
        {meta.format ? `${meta.format.toUpperCase()} 图片，` : ''}共 {meta.fields.length} 个文本元数据字段。只读显示，不会修改图片。
      </div>
      {meta.error && <div className="rounded-lg bg-destructive/10 px-3 py-2 text-[12px] text-destructive">{meta.error}</div>}
      {!!meta.warnings.length && <div className="rounded-lg bg-warning/10 px-3 py-2 text-[12px] whitespace-pre-line">{meta.warnings.join('\n')}</div>}
      {!meta.fields.length && !meta.error && <EmptyState title="没有文本元数据" description="这张图片中没有保存任何生成参数（可能已被压缩、转存或清除）。" />}
      {meta.fields.map((f, i) => {
        const o = open[i] ?? meta.fields.length <= 2
        return (
          <div key={i} className="rounded-lg bg-card ring-1 ring-tint/[0.08]" data-testid="raw-field">
            <div className="flex items-center gap-2 px-2.5 py-1.5 text-[12px]">
              <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => setOpen({ ...open, [i]: !o })} data-testid="raw-toggle">
                {o ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
                <span className="truncate font-mono font-medium">{f.key}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {f.via} · {f.size.toLocaleString()} 字符{f.json ? ' · JSON' : ''}
                </span>
              </button>
              <Button
                size="xs"
                variant="ghost"
                onClick={async () => {
                  const n = await call(api['mining.copyMeta'](im.id, i))
                  if (n != null) toast.success(`已复制 ${f.key} 原文（${n.toLocaleString()} 字符）`)
                }}
                data-testid="raw-copy"
              >
                <Copy /> 复制原文
              </Button>
            </div>
            {o && (
              <>
                <pre className="max-h-80 overflow-auto border-t border-tint/[0.06] px-2.5 py-2 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap text-foreground/85" data-testid="raw-text">
                  {f.text}
                </pre>
                {f.truncated && <div className="px-2.5 pb-2 text-[11px] text-warning">内容过长，只显示前 {f.text.length.toLocaleString()} 个字符；「复制原文」会复制完整内容</div>}
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** 来源图片网格 */
function SourcesDialog({ title, ids, onClose, onOpen }: { title: string; ids: string[] | null; onClose: () => void; onOpen: (id: string) => void }) {
  const images = useMining((s) => s.images)
  return (
    <Dialog open={!!ids} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[min(86vh,780px)] flex-col gap-3 sm:max-w-3xl" data-testid="mining-sources">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>共 {ids?.length ?? 0} 张。点击查看原始 Prompt。</DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 grid-cols-4 gap-2.5 overflow-y-auto pr-1">
          {(ids ?? []).map((id) => (
            <button key={id} type="button" className="text-left" onClick={() => onOpen(id)}>
              <Thumb path={id} width={240} className="aspect-[2/3] w-full" />
              <div className="mt-1 truncate text-[11px] text-muted-foreground">{images.find((i) => i.id === id)?.name ?? id}</div>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ---------------- 参数

const PARAMS: { key: keyof MiningParams; label: string; hint: string; min: number; max: number; step: number; percent?: boolean }[] = [
  { key: 'minSupport', label: '最小共同出现', hint: '一个组合至少要在多少张图片中同时出现', min: 2, max: 999, step: 1 },
  { key: 'globalRatio', label: '全局公共阈值', hint: '出现在这个比例以上图片中的标签视为全局公共标签，不参与局部组合', min: 0.5, max: 1, step: 0.05, percent: true },
  { key: 'minSize', label: '最少标签数', hint: '组合至少包含几个标签', min: 1, max: 20, step: 1 },
  { key: 'minLift', label: '关联强度', hint: '组合中的标签与其余标签一起出现的频率，至少是随机搭配时的几倍（总是一起出现的标签不受此限制）。调高可减少碰巧同时出现的组合', min: 1, max: 10, step: 0.5 },
  { key: 'maxCandidates', label: '最多显示', hint: '最多显示多少个候选组合', min: 5, max: 500, step: 5 },
]

function ParamField({ p }: { p: (typeof PARAMS)[number] }) {
  const value = useMining((s) => s.params[p.key])
  const fmt = (v: number) => (p.percent ? `${Math.round(v * 100)}%` : p.key === 'minLift' ? `${v}×` : String(v))
  const set = (v: number) => setParams({ [p.key]: Math.round(Math.min(p.max, Math.max(p.min, v)) * 100) / 100 })
  return (
    <div className="flex items-center gap-1.5" title={p.hint}>
      <span className="text-[11.5px] text-muted-foreground">{p.label}</span>
      <div className="inline-flex h-7 items-center rounded-lg bg-tint/[0.04] ring-1 ring-tint/[0.112]">
        <button type="button" aria-label={`${p.label}减少`} className="grid h-full w-6 place-items-center text-muted-foreground hover:text-foreground" onClick={() => set(value - p.step)}>
          −
        </button>
        <span className="min-w-9 text-center text-[12px] font-semibold tabular-nums" data-testid={`param-${p.key}`}>
          {fmt(value)}
        </span>
        <button type="button" aria-label={`${p.label}增加`} className="grid h-full w-6 place-items-center text-muted-foreground hover:text-foreground" onClick={() => set(value + p.step)}>
          +
        </button>
      </div>
    </div>
  )
}

// ---------------- 候选组合

function useExisting() {
  const lib = useLib((s) => s.lib)
  return useMemo(() => {
    const m = new Map<string, Template>()
    for (const t of lib?.templates ?? []) {
      const sig = promptSignature(t.positive ?? '')
      if (sig && !m.has(sig)) m.set(sig, t)
    }
    return m
  }, [lib])
}

function TagChip({ children, onClick, title, tone, testId }: { children: ReactNode; onClick?: () => void; title?: string; tone?: 'add' | 'active'; testId?: string }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      data-testid={testId}
      className={cn('inline-flex h-6 max-w-full items-center gap-1 rounded-md bg-tint/[0.045] px-2 font-mono text-[11.5px] text-foreground/85 hover:bg-tint/[0.08]', tone === 'active' && 'bg-primary/15 text-primary ring-1 ring-primary/30')}
    >
      {children}
    </button>
  )
}

function DraftCard({ d, c, existing, onSources }: { d: Draft; c?: Candidate; existing: Map<string, Template>; onSources: (title: string, ids: string[]) => void }) {
  const total = useMining((s) => s.result?.total ?? 0)
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState<string[]>([])
  const tokens = splitTopLevel(d.prompt)
  const keys = new Set(tokens.map((t) => parseToken(t)?.key))
  const dup = !d.saved && existing.get(promptSignature(d.prompt))
  const togglePick = (raw: string) => setPicked((p) => (p.includes(raw) ? p.filter((x) => x !== raw) : [...p, raw]))
  const append = (raws: string[]) => patchDraft(d.uid, { prompt: [d.prompt.trim(), ...raws].filter(Boolean).join(', ') })
  const refs = (list: TagRef[], kind: 'var' | 'att') =>
    list.map((v) => (
      <TagChip key={v.key} tone={picked.includes(v.raw) ? 'active' : undefined} onClick={() => togglePick(v.raw)} title={`${v.count} / ${c!.support} 张图片`} testId={kind === 'var' ? 'variation' : 'attached'}>
        {v.raw}
        <span className="text-[10px] text-muted-foreground tabular-nums">{v.count}</span>
      </TagChip>
    ))
  return (
    <div className={cn('rounded-xl bg-card p-3 ring-1 ring-tint/[0.08]', d.selected && 'ring-primary/50', d.saved && 'opacity-70')} data-testid="mining-candidate">
      <div className="flex items-center gap-2">
        <Checkbox checked={d.selected} disabled={!!d.saved} onCheckedChange={(v) => patchDraft(d.uid, { selected: !!v })} aria-label={`选择 ${d.name}`} />
        <TextInput value={d.name} onChange={(v) => patchDraft(d.uid, { name: v })} className="h-8 max-w-64 text-[13px] font-medium" />
        {d.saved && <span className="rounded-full bg-success/15 px-2 py-0.5 text-[11px] text-success">已保存为{TEMPLATE_KINDS[d.saved.kind]}</span>}
        {dup && (
          <span className="truncate rounded-full bg-warning/15 px-2 py-0.5 text-[11px]" data-testid="dup-badge">
            与已有「{dup.name}」（{TEMPLATE_KINDS[dup.kind]}）重复
          </span>
        )}
        <div className="flex-1" />
        {c ? (
          <div className="flex items-center gap-3 text-[11.5px] whitespace-nowrap text-muted-foreground tabular-nums">
            <span title="同时包含组合中全部标签的图片数">
              覆盖 <b className="text-foreground">{c.support}</b> 张 · {pct(c.support / total)}
            </span>
            <span title={`关联度：同时包含全部标签的图片数 ÷ 包含任一标签的图片数。最低提升度 ${c.lift.toFixed(1)}×`}>关联度 {c.cohesion.toFixed(2)}</span>
            <Button variant="ghost" size="xs" onClick={() => onSources(d.name, c.images)}>
              来源图片
            </Button>
          </div>
        ) : (
          <Button variant="ghost" size="icon-sm" aria-label="移除自定义组合" onClick={() => removeDraft(d.uid)}>
            <X />
          </Button>
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        {tokens.map((t, i) => (
          <span key={`${t}-${i}`} className="inline-flex h-6 items-center gap-1 rounded-md bg-primary/[0.08] pr-1 pl-2 font-mono text-[11.5px]" data-testid="draft-tag">
            {t}
            <button type="button" aria-label={`删除标签 ${t}`} className="grid size-4 place-items-center rounded text-muted-foreground hover:bg-tint/[0.08] hover:text-foreground" onClick={() => patchDraft(d.uid, { prompt: removeTag(d.prompt, parseToken(t)?.key ?? '') })}>
              <X className="size-3" />
            </button>
          </span>
        ))}
      </div>
      <PromptField value={d.prompt} onChange={(v) => patchDraft(d.uid, { prompt: v })} minRows={1} className="mt-2" />
      {c && !!c.weightVariants.length && (
        <div className="mt-1.5 text-[11px] text-muted-foreground">
          权重写法不同：{c.weightVariants.map((w) => w.forms.map((f) => `${f.raw}×${f.count}`).join(' / ')).join('；')}
        </div>
      )}
      {c && (c.variations.length > 0 || c.attached.length > 0 || c.extensions.length > 0) && (
        <div className="mt-2">
          <button type="button" className="text-[12px] text-primary hover:underline" onClick={() => setOpen(!open)} data-testid="toggle-variations">
            {open ? '收起' : `变化标签 ${c.variations.length}${c.extensions.length ? ` · 扩展组合 ${c.extensions.length}` : ''}${c.attached.length ? ` · 弱关联 ${c.attached.length}` : ''}`}
          </button>
          {open && (
            <div className="mt-2 space-y-2.5 rounded-lg bg-tint/[0.025] p-2.5">
              {!!c.variations.length && (
                <div>
                  <div className="mb-1 text-[11px] text-muted-foreground">只在部分图片中出现（数字为出现的图片数；只描述共现差异，不代表互斥）</div>
                  <div className="flex flex-wrap gap-1">{refs(c.variations.filter((v) => !keys.has(v.key)), 'var')}</div>
                </div>
              )}
              {!!c.attached.length && (
                <div>
                  <div className="mb-1 text-[11px] text-muted-foreground">这些图片都有，但在其他图片中也大量出现（关联较弱，未放入组合）</div>
                  <div className="flex flex-wrap gap-1">{refs(c.attached.filter((v) => !keys.has(v.key)), 'att')}</div>
                </div>
              )}
              {!!picked.length && (
                <div className="flex items-center gap-2">
                  <span className="text-[11.5px] text-muted-foreground">已选 {picked.length} 个标签</span>
                  <Button size="xs" variant="secondary" onClick={() => (append(picked), setPicked([]))}>
                    加入此组合
                  </Button>
                  <Button size="xs" variant="secondary" onClick={() => (addCustom(picked.join(', ')), setPicked([]))} data-testid="picked-as-new">
                    另存为新组合
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => setPicked([])}>
                    清除
                  </Button>
                </div>
              )}
              {!!c.extensions.length && (
                <div>
                  <div className="mb-1 text-[11px] text-muted-foreground">扩展组合（在部分图片中还一起出现的其他标签）</div>
                  <div className="space-y-1">
                    {c.extensions.map((e) => (
                      <div key={e.id} className="flex items-center gap-2 text-[11.5px]">
                        <span className="min-w-0 flex-1 truncate font-mono">+ {e.tags.filter((_, i) => !c.keys.includes(e.keys[i])).join(', ')}</span>
                        <span className="text-muted-foreground tabular-nums">{e.support} 张</span>
                        <Button size="xs" variant="ghost" onClick={() => onSources(e.prompt, e.images)}>
                          来源
                        </Button>
                        <Button size="xs" variant="ghost" onClick={() => addCustom(e.prompt)}>
                          设为独立组合
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function CandidatesTab({ onSources }: { onSources: (title: string, ids: string[]) => void }) {
  const { drafts, result } = useMining()
  const existing = useExisting()
  const custom = drafts.filter((d) => !d.candId)
  const mined = drafts.filter((d) => d.candId && candidateOf(result, d))
  const selectable = drafts.filter((d) => !d.saved)
  const allOn = selectable.length > 0 && selectable.every((d) => d.selected)
  return (
    <div className="space-y-2.5" data-testid="mining-candidates">
      <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
        <Checkbox checked={allOn} onCheckedChange={(v) => useMining.setState({ drafts: drafts.map((d) => (d.saved ? d : { ...d, selected: !!v })) })} aria-label="全选" />
        <span>
          全选 · 自定义 {custom.length} · 重复组合候选 {mined.length}
        </span>
        <span className="ml-auto">按「覆盖图片数 × 标签数」排序；重复组合只是统计意义上的片段，名称为临时编号</span>
      </div>
      {custom.map((d) => (
        <DraftCard key={d.uid} d={d} existing={existing} onSources={onSources} />
      ))}
      {mined.map((d) => (
        <DraftCard key={d.uid} d={d} c={candidateOf(result, d)} existing={existing} onSources={onSources} />
      ))}
      {!mined.length && !custom.length && <EmptyState icon={<Pickaxe />} title="没有发现重复组合" description="可以降低「最小共同出现」或「关联强度」后重新分析。" />}
    </div>
  )
}

function GlobalTab({ onSources }: { onSources: (title: string, ids: string[]) => void }) {
  const result = useMining((s) => s.result)!
  if (!result.global.length) return <EmptyState title="没有全局公共标签" description={`没有标签出现在 ${pct(result.params.globalRatio)} 以上的图片中，可以降低「全局公共阈值」。`} />
  return (
    <div className="space-y-3" data-testid="mining-global">
      <div className="rounded-xl bg-card p-3 ring-1 ring-tint/[0.08]">
        <PromptField label="全局公共 Prompt 候选（按图片中的顺序）" value={result.globalPrompt} readOnly copy minRows={2} />
        <Button size="sm" variant="secondary" className="mt-2" onClick={() => addCustom(result.globalPrompt, '全局公共 Prompt')} data-testid="global-as-draft">
          <Plus /> 作为组合加入保存列表
        </Button>
      </div>
      <TagTable tags={result.global} onSources={onSources} />
    </div>
  )
}

type TagFilter = 'all' | 'uncovered' | 'unknown'

function TagsTab({ onSources }: { onSources: (title: string, ids: string[]) => void }) {
  const { result, dict } = useMining()
  const [filter, setFilter] = useState<TagFilter>('uncovered')
  const [q, setQ] = useState('')
  const r = result!
  const uncovered = new Set(r.uncovered)
  const list = r.tags.filter((t) => (filter === 'all' || (filter === 'uncovered' ? uncovered.has(t.key) : t.known === false)) && (!q || t.key.includes(q.toLowerCase().trim().replace(/\s+/g, '_'))))
  return (
    <div className="space-y-2.5" data-testid="mining-tags">
      <div className="flex flex-wrap items-center gap-2">
        <Chip active={filter === 'uncovered'} onClick={() => setFilter('uncovered')}>
          未被组合覆盖 {r.uncovered.length}
        </Chip>
        <Chip active={filter === 'all'} onClick={() => setFilter('all')}>
          全部 {r.tags.length}
        </Chip>
        {dict && (
          <Chip active={filter === 'unknown'} onClick={() => setFilter('unknown')}>
            不在词典中 {r.tags.filter((t) => t.known === false).length}
          </Chip>
        )}
        <SearchBox value={q} onChange={setQ} placeholder="搜索标签…" className="ml-auto w-56" />
      </div>
      <TagTable tags={list} onSources={onSources} selectable />
    </div>
  )
}

function TagTable({ tags, onSources, selectable }: { tags: NonNullable<ReturnType<typeof useMining.getState>['result']>['tags']; onSources: (title: string, ids: string[]) => void; selectable?: boolean }) {
  const [picked, setPicked] = useState<string[]>([])
  const shown = tags.slice(0, 500)
  return (
    <div>
      {selectable && !!picked.length && (
        <div className="mb-2 flex items-center gap-2 rounded-lg bg-primary/[0.06] px-3 py-1.5 text-[12px]">
          已选 {picked.length} 个标签
          <Button size="xs" onClick={() => (addCustom(picked.join(', ')), setPicked([]))} data-testid="tags-as-draft">
            创建组合
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setPicked([])}>
            清除
          </Button>
        </div>
      )}
      <div className="overflow-hidden rounded-xl ring-1 ring-tint/[0.08]">
        {shown.map((t) => (
          <div key={t.key} className="flex items-center gap-2 border-b border-tint/[0.05] bg-card px-3 py-1.5 text-[12px] last:border-0" data-testid="tag-row">
            {selectable && <Checkbox checked={picked.includes(t.raw)} onCheckedChange={(v) => setPicked((p) => (v ? [...p, t.raw] : p.filter((x) => x !== t.raw)))} aria-label={`选择 ${t.raw}`} />}
            <span className="min-w-0 flex-1 truncate font-mono">{t.raw}</span>
            {t.forms.length > 1 && <span className="truncate text-[11px] text-muted-foreground" title={t.forms.map((f) => `${f.raw} ×${f.count}`).join('\n')}>{t.forms.length} 种写法</span>}
            {t.known === false && <span className="rounded bg-tint/[0.06] px-1.5 text-[10.5px] text-muted-foreground">词典外</span>}
            <span className="w-20 text-right text-muted-foreground tabular-nums">
              {t.count} 张 · {pct(t.ratio)}
            </span>
            <Button size="xs" variant="ghost" onClick={() => onSources(t.raw, t.images)}>
              来源
            </Button>
          </div>
        ))}
        {!shown.length && <div className="bg-card py-8 text-center text-xs text-muted-foreground">没有标签</div>}
      </div>
      {tags.length > shown.length && <div className="mt-2 text-center text-[11px] text-muted-foreground">只显示前 {shown.length} 个，可搜索查找其他标签</div>}
    </div>
  )
}

// ---------------- 保存

function SaveBar() {
  const { drafts, saveKind, parentId, set } = useMining()
  const lib = useLib((s) => s.lib)
  const n = drafts.filter((d) => d.selected && !d.saved).length
  const positions = templatesOf(lib, 'position')
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-tint/[0.06] bg-background/80 px-6 py-3" data-testid="mining-savebar">
      <span className="text-[12.5px]">
        已选 <b className="tabular-nums">{n}</b> 个组合，保存为
      </span>
      <select
        value={saveKind}
        onChange={(e) => set({ saveKind: e.target.value as never })}
        className="h-8 rounded-lg bg-tint/[0.045] px-2 text-[12.5px] ring-1 ring-tint/[0.112] outline-none focus:ring-primary/50"
        aria-label="保存到的素材类别"
        data-testid="save-kind"
      >
        {MINING_SAVE_KINDS.map((k) => (
          <option key={k} value={k} className="bg-popover">
            {TEMPLATE_KINDS[k]}
            {k === 'camera' ? '（在套图任务中选择）' : ''}
          </option>
        ))}
      </select>
      {saveKind === 'subposition' && (
        <select
          value={parentId ?? ''}
          onChange={(e) => set({ parentId: e.target.value ? Number(e.target.value) : null })}
          className="h-8 rounded-lg bg-tint/[0.045] px-2 text-[12.5px] ring-1 ring-tint/[0.112] outline-none focus:ring-primary/50"
          aria-label="所属主体位"
        >
          <option value="" className="bg-popover">
            选择所属主体位…
          </option>
          {positions.map((p) => (
            <option key={p.id} value={p.id} className="bg-popover">
              {p.name || '（未命名）'}
            </option>
          ))}
        </select>
      )}
      <span className="text-[11.5px] text-muted-foreground">与已有素材标签相同的组合会跳过，不会覆盖任何已有素材</span>
      <div className="flex-1" />
      <Button size="sm" disabled={!n} onClick={() => void saveSelected()} data-testid="mining-save">
        <Save /> 保存所选（{n}）
      </Button>
    </div>
  )
}

// ---------------- 词典

function DictDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const dict = useMining((s) => s.dict)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="dict-dialog">
        <DialogHeader>
          <DialogTitle>标签词典（可选）</DialogTitle>
          <DialogDescription>导入本地的 Danbooru 等标签列表后，分析时会统一别名（例如别名 → 正式标签名）并标记词典外的标签。词典只用于比较，不会改写原 Prompt，也不会按词典类别自动分类；词典外的标签（自定义标签、触发词）照常参与分析。</DialogDescription>
        </DialogHeader>
        <div className="rounded-xl bg-tint/[0.03] px-3 py-2.5 text-[12.5px] ring-1 ring-tint/[0.06]" data-testid="dict-info">
          {dict ? (
            <>
              已导入 <b>{dict.tags.toLocaleString()}</b> 个标签、{dict.aliases.toLocaleString()} 个别名
              <div className="mt-0.5 text-[11.5px] text-muted-foreground">
                来源 {dict.source} · {new Date(dict.imported_at).toLocaleString()}
              </div>
            </>
          ) : (
            '未导入词典（不影响提取与分析）'
          )}
        </div>
        <div className="text-[11.5px] leading-relaxed text-muted-foreground">
          支持格式：CSV（第一列为标签名；a1111-tagcomplete 格式「名称,类别,数量,"别名1,别名2"」会读取别名）、TXT（每行一个标签）、JSON（标签数组或 {'{name, aliases}'} 数组）。词典保存在工作区 data/tag-dictionary.json，不会打包进程序。
        </div>
        <div className="flex justify-end gap-2">
          {dict && (
            <Button
              variant="ghost"
              onClick={async () => {
                if (!(await confirm({ title: '移除标签词典？', description: '只删除工作区中的词典副本，原始词典文件不受影响。', confirmText: '移除', destructive: true }))) return
                await call(api['mining.dictRemove']())
                await loadDict()
              }}
            >
              <Trash2 /> 移除
            </Button>
          )}
          <Button
            onClick={async () => {
              const r = await call(api['mining.dictImport']())
              if (r) {
                await loadDict()
                useMining.setState({ stale: !!useMining.getState().result })
              }
            }}
          >
            <BookA /> 导入词典文件
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ---------------- 页面

type Tab = 'candidates' | 'global' | 'tags'

export default function MiningPage() {
  const { images, scanning, result, stale, analyzing, recursive, set, dict, drafts, scanErrors } = useMining()
  const [tab, setTab] = useState<Tab>('candidates')
  const [openImg, setOpenImg] = useState<string | null>(null)
  const [sources, setSources] = useState<{ title: string; ids: string[] } | null>(null)
  const [dictOpen, setDictOpen] = useState(false)
  const [rulesOpen, setRulesOpen] = useState(false)
  const rulesN = useMining((s) => s.rules.length)
  useEffect(() => {
    void loadDict()
    void loadRules()
  }, [])
  const canAnalyze = includedImages(useMining.getState()).length > 0
  const onSources = (title: string, ids: string[]) => setSources({ title, ids })
  return (
    <div className="flex h-full flex-col" data-testid="mining-page">
      <PageHeader
        title="历史 Prompt 提取"
        description="从保留生成参数的 PNG 中读取正向 Prompt，找出反复出现的标签组合并保存为素材。全部在本地完成，不修改原图片。"
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={() => setRulesOpen(true)} data-testid="open-rules">
              <ListChecks /> 来源规则{rulesN ? `（${rulesN}）` : ''}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setDictOpen(true)} data-testid="open-dict">
              <BookA /> 词典{dict ? `（${dict.tags.toLocaleString()}）` : ''}
            </Button>
            {!!images.length && (
              <Button
                variant="ghost"
                size="sm"
                disabled={scanning}
                onClick={async () => {
                  if (drafts.some((d) => d.selected && !d.saved) && !(await confirm({ title: '清空所有图片和分析结果？', description: '尚未保存的组合会丢失（不影响原图片和已保存的素材）。', confirmText: '清空', destructive: true }))) return
                  clearAll()
                }}
              >
                <RotateCcw /> 清空
              </Button>
            )}
            <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
              <Checkbox checked={recursive} onCheckedChange={(v) => set({ recursive: !!v })} data-testid="recursive" />
              包含子文件夹
            </label>
            <Button variant="secondary" size="sm" disabled={scanning} onClick={() => void addFolder()} data-testid="add-folder">
              <FolderOpen /> 添加文件夹
            </Button>
            <Button size="sm" disabled={scanning} onClick={() => void addFiles()} data-testid="add-files">
              <FileImage /> 添加图片
            </Button>
          </>
        }
      />
      {!images.length && !scanning ? (
        <EmptyState
          icon={<Pickaxe />}
          title={scanErrors.length ? '没有读取到图片' : '选择保留生成参数的图片或文件夹'}
          description={
            scanErrors.length ? (
              <span className="whitespace-pre-line" data-testid="empty-scan-errors">
                {scanErrors.join('\n')}
              </span>
            ) : (
              '支持 PNG（ComfyUI 工作流、WebUI / Forge parameters、NovelAI 等）以及 JPEG / WebP 的 EXIF 参数。ComfyUI 图片会沿采样器的正向输入找到真正的正向 Prompt（不会混入负向和未连接的文本）。然后统计全局公共标签、反复同时出现的标签组合及其变化部分。'
            )
          }
          action={
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={() => void addFolder()}>
                <FolderOpen /> 添加文件夹
              </Button>
              <Button size="sm" onClick={() => void addFiles()}>
                <FileImage /> 添加图片
              </Button>
            </div>
          }
        />
      ) : (
        <div className="flex min-h-0 flex-1">
          <ImagePanel onOpen={setOpenImg} />
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-6 pb-2.5" data-testid="mining-params">
              {PARAMS.map((p) => (
                <ParamField key={p.key} p={p} />
              ))}
              <Button size="sm" variant={stale || !result ? 'default' : 'secondary'} disabled={analyzing || !canAnalyze} onClick={() => void analyze()} data-testid="analyze">
                {analyzing ? <Loader2 className="animate-spin" /> : <Pickaxe />} {result ? '重新分析' : '分析'}
              </Button>
              {stale && result && <span className="text-[11.5px] text-warning">图片或参数已变化，点击重新分析</span>}
            </div>
            {result && (
              <>
                <div className="flex flex-wrap items-center gap-3 px-6 pb-2.5">
                  <div className="flex rounded-xl bg-tint/[0.04] p-1">
                    {(
                      [
                        ['candidates', '重复组合', result.candidates.length],
                        ['global', '全局公共', result.global.length],
                        ['tags', '全部标签', result.tags.length],
                      ] as [Tab, string, number][]
                    ).map(([k, l, n]) => (
                      <button
                        key={k}
                        type="button"
                        onClick={() => setTab(k)}
                        data-active={tab === k || undefined}
                        data-testid={`tab-${k}`}
                        className="h-7 rounded-lg px-3 text-[12.5px] text-muted-foreground transition hover:text-foreground data-[active]:bg-tint/[0.09] data-[active]:text-foreground"
                      >
                        {l}
                        <span className="ml-1.5 text-[11px] opacity-60">{n}</span>
                      </button>
                    ))}
                  </div>
                  <span className="text-[11.5px] text-muted-foreground" data-testid="mining-summary">
                    分析 {result.total} 张 · 不同标签 {result.stats.distinctTags} 个{result.duplicates.length ? ` · ${result.duplicates.reduce((a, g) => a + g.length, 0)} 张图片的 Prompt 完全相同（${result.duplicates.length} 组）` : ''}
                    {result.innerDupes ? ` · 图片内重复标签已合并 ${result.innerDupes} 次` : ''}
                  </span>
                </div>
                {!!result.notes.length && <div className="mx-6 mb-2 rounded-lg bg-warning/10 px-3 py-2 text-[12px] whitespace-pre-line">{result.notes.join('\n')}</div>}
                <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
                  {tab === 'candidates' && <CandidatesTab onSources={onSources} />}
                  {tab === 'global' && <GlobalTab onSources={onSources} />}
                  {tab === 'tags' && <TagsTab onSources={onSources} />}
                </div>
                <SaveBar />
              </>
            )}
            {!result && <div className="px-6 py-10 text-center text-xs text-muted-foreground">{analyzing ? '正在分析…' : scanning ? '读取完成后自动分析' : '点击「分析」开始统计'}</div>}
          </div>
        </div>
      )}
      <ImageDialog id={openImg} onClose={() => setOpenImg(null)} />
      <SourcesDialog title={sources?.title ?? ''} ids={sources?.ids ?? null} onClose={() => setSources(null)} onOpen={setOpenImg} />
      <DictDialog open={dictOpen} onOpenChange={setDictOpen} />
      <RulesDialog open={rulesOpen} onOpenChange={setRulesOpen} />
    </div>
  )
}
