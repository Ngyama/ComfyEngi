// 动作 Prompt：按「情绪组 × POV / 非 POV × 体位」管理用户写好的完整人物动作 Prompt。
// 左侧情绪组；中间是选中情绪组的体位 × 视角矩阵（点击格子编辑，空格子直接开始写）；右侧编辑原文，修改自动保存。
// 正文原样保存（换行、权重、Wildcard、Tag 顺序不变），不解析、不改写。情绪组与体位可以新建、改名、拖动排序、复制、删除。

import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRightLeft, Check, Copy, FileInput, Pencil, Plus, Shapes, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { CopyButton, EmptyState, FieldLabel, PageHeader, PromptField, SearchBox } from '@/components/common'
import { api, call } from '@/lib/api'
import { confirm, reloadLib, templatesOf, useLib, useNav } from '@/lib/stores'
import { cn } from '@/lib/utils'
import { anchorProblem, fromLegacyTemplate, hasMale, legacyPlaceholders, promptAnchors, viewLabel, VIEWS, type ActionIndex } from '@shared/action-prompts'
import { cardTemplates } from '@shared/card-templates'
import type { Template } from '@shared/types'
import { cellKey, cellOf, labelOf, MoodList, PromptMatrix, PromptSnippet, RenameInput, RowButton, searchPrompts, useActionIndex, type Cell } from './matrix'

const save = (rec: Partial<Template>) => call(api['templates.save'](rec as never))

export default function PromptLibraryPage() {
  const ix = useActionIndex()
  const target = useNav((s) => s.target)
  const [moodId, setMoodId] = useState<number | null>(null)
  const [sel, setSel] = useState<Cell | null>(null)
  const [q, setQ] = useState('')
  const [renaming, setRenaming] = useState<number | null>(null)
  const mood = ix.moods.find((m) => m.id === moodId) ?? ix.moods[0] ?? null

  // 从套图任务跳转过来：选中那份 Prompt
  useEffect(() => {
    const t = target?.actionId ? ix.byId.get(target.actionId) : undefined
    if (t?.kind === 'action') {
      setMoodId(t.mood_id ?? null)
      setSel(cellOf(t))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target])

  const createCategory = async (kind: 'mood' | 'posture') => {
    const list = kind === 'mood' ? ix.moods : ix.postures
    const base = kind === 'mood' ? '新情绪组' : '新体位'
    let n = list.length + 1
    while (list.some((x) => x.name === `${base} ${n}`)) n++
    const r = await save({ kind, name: `${base} ${n}`, sort: Math.max(0, ...list.map((x) => x.sort ?? 0)) + 1 })
    if (!r) return
    await reloadLib()
    if (kind === 'mood') setMoodId(r.id)
    setRenaming(r.id)
  }
  const rename = async (id: number, name: string) => {
    setRenaming(null)
    await save({ id, name })
    await reloadLib()
  }
  const reorder = async (ids: number[]) => {
    await call(api['templates.reorder'](ids))
    await reloadLib()
  }
  const removeCategory = async (c: Template) => {
    const children = ix.prompts.filter((t) => (c.kind === 'mood' ? t.mood_id : t.posture_id) === c.id)
    const used = [...new Set((await Promise.all(children.map((t) => api.references('action_id', t.id)))).flat())]
    const ok = await confirm({
      title: `删除${c.kind === 'mood' ? '情绪组' : '体位'}「${c.name}」？`,
      description:
        (children.length ? `其中的 ${children.length} 份 Prompt 会一起删除（移入工作区回收站 .comfyengi/trash，可找回）。\n` : '') +
        (used.length ? `以下任务或预设正在使用这些 Prompt：${used.join('、')}\n删除后这些动作会提示引用失效。\n` : '') +
        '已加入队列或已生成的记录不受影响。',
      confirmText: '删除',
      destructive: true,
    })
    if (!ok) return
    await call(api['templates.remove'](c.id))
    await reloadLib()
    if (sel && (sel.moodId === c.id || sel.postureId === c.id)) setSel(null)
  }
  const duplicateMood = async (id: number) => {
    const r = await call(api['templates.duplicate'](id))
    if (!r?.id) return
    await reloadLib()
    setMoodId(r.id)
    setRenaming(r.id)
    toast.success('已复制情绪组', { description: '其中的 Prompt 也已复制，可以逐个修改' })
  }

  const hits = useMemo(() => searchPrompts(ix, q), [ix, q])
  const searching = !!q.trim()
  const selPrompt = sel ? (sel.promptId ? ix.byId.get(sel.promptId) : ix.at(sel.moodId, sel.pov, sel.postureId)[0]) : undefined
  const empty = !ix.moods.length || !ix.postures.length

  return (
    <div className="flex h-full" data-testid="prompt-library">
      <div className="flex min-w-0 flex-1 flex-col">
        <PageHeader
          title="动作 Prompt"
          description="每个「情绪组 × POV / 非 POV × 体位」对应一份你写好的完整人物动作 Prompt，原样保存。生成时在 1girl / 1man 之后插入角色特征与服装。"
          actions={<SearchBox value={q} onChange={setQ} placeholder="搜索全部 Prompt（分类名称、正文）…" className="w-72" />}
        />
        <div className="flex min-h-0 flex-1 gap-4 px-6 pb-4">
          <section className="flex w-52 shrink-0 flex-col" data-testid="mood-list">
            <div className="mb-1.5 flex items-center gap-1 px-1">
              <span className="text-[11px] font-medium tracking-wide text-muted-foreground">情绪组</span>
              <Button size="xs" variant="ghost" className="ml-auto" onClick={() => void createCategory('mood')} data-testid="new-mood">
                <Plus /> 新建
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto pr-1">
              <MoodList
                ix={ix}
                value={mood?.id ?? null}
                onSelect={(id) => {
                  setMoodId(id)
                  setQ('')
                }}
                editable
                renaming={renaming}
                onStartRename={setRenaming}
                onRename={(id, name) => void rename(id, name)}
                onReorder={(ids) => void reorder(ids)}
                onDuplicate={(id) => void duplicateMood(id)}
                onDelete={(id) => {
                  const m = ix.byId.get(id)
                  if (m) void removeCategory(m)
                }}
              />
              {!ix.moods.length && <div className="rounded-xl border border-dashed border-tint/[0.16] p-4 text-center text-xs text-muted-foreground">还没有情绪组</div>}
            </div>
            <div className="mt-2 px-1 text-[11px] leading-relaxed text-muted-foreground/80">双击改名，拖动排序。复制情绪组会连同其中的 Prompt 一起复制。</div>
          </section>

          <div className="min-w-0 flex-1 overflow-y-auto pr-1" onClick={() => setSel(null)}>
            <div onClick={(e) => e.stopPropagation()}>
              {searching ? (
                <SearchResults ix={ix} hits={hits} sel={selPrompt} onPick={(t) => setSel(cellOf(t))} />
              ) : empty ? (
                <EmptyState
                  icon={<Shapes />}
                  title={!ix.moods.length && !ix.postures.length ? '先建立分类' : !ix.moods.length ? '还没有情绪组' : '还没有体位'}
                  description="情绪组（惊讶、害羞……）和体位（正常位、骑乘位……）只用于组织和定位 Prompt，不参与拼接。不需要每个组合都写 Prompt。"
                  action={
                    <div className="flex gap-2">
                      {!ix.moods.length && (
                        <Button size="sm" onClick={() => void createCategory('mood')}>
                          <Plus /> 新建情绪组
                        </Button>
                      )}
                      {!ix.postures.length && (
                        <Button size="sm" variant={ix.moods.length ? 'default' : 'secondary'} onClick={() => void createCategory('posture')} data-testid="new-posture-empty">
                          <Plus /> 新建体位
                        </Button>
                      )}
                    </div>
                  }
                />
              ) : (
                mood && (
                  <>
                    <div className="mb-2 flex items-baseline gap-2">
                      <span className="text-[14px] font-semibold" data-testid="matrix-title">
                        {mood.name || '（未命名）'}
                      </span>
                      <span className="text-[11px] text-muted-foreground">点击格子编辑；空格子直接开始写，不需要每个组合都有 Prompt</span>
                    </div>
                    <PromptMatrix
                      ix={ix}
                      moodId={mood.id}
                      sortable={renaming == null}
                      onReorder={(ids) => void reorder(ids)}
                      rowHeader={(p) =>
                        renaming === p.id ? (
                          <RenameInput value={p.name} onDone={(v) => void rename(p.id, v)} onCancel={() => setRenaming(null)} testId="posture-rename" />
                        ) : (
                          <>
                            <span className="min-w-0 flex-1 truncate text-[13px] font-medium" onDoubleClick={() => setRenaming(p.id)} data-testid="posture-name">
                              {p.name || '（未命名）'}
                            </span>
                            <span className="hidden shrink-0 group-hover/row:flex">
                              <RowButton label={`重命名体位 ${p.name}`} onClick={() => setRenaming(p.id)}>
                                <Pencil />
                              </RowButton>
                              <RowButton label={`删除体位 ${p.name}`} onClick={() => void removeCategory(p)} danger testId="posture-delete">
                                <Trash2 />
                              </RowButton>
                            </span>
                          </>
                        )
                      }
                      renderCell={(postureId, pov, list) => {
                        const cell: Cell = { moodId: mood.id, pov, postureId }
                        const on = !!sel && sel.moodId === mood.id && sel.pov === pov && sel.postureId === postureId
                        const t = list[0]
                        return (
                          <button
                            type="button"
                            onClick={() => setSel(t ? cellOf(t) : cell)}
                            data-testid="prompt-cell"
                            data-filled={t ? 'true' : undefined}
                            className={cn(
                              'group/cell block h-full min-h-[64px] w-full rounded-lg p-2 text-left ring-1 transition',
                              t ? 'bg-card ring-tint/[0.08] hover:bg-accent/70' : 'border border-dashed border-tint/[0.14] ring-0 hover:border-primary/40 hover:bg-primary/[0.03]',
                              on && 'bg-accent/80 ring-2 ring-primary/60',
                            )}
                          >
                            {t ? (
                              <>
                                <PromptSnippet t={t} copy />
                                {list.length > 1 && <div className="mt-1 text-[10.5px] text-amber-700">这个组合有 {list.length} 份 Prompt（可在搜索中查看全部）</div>}
                              </>
                            ) : (
                              <span className="flex h-full items-center justify-center gap-1 text-[11.5px] text-muted-foreground/60 group-hover/cell:text-primary">
                                <Plus className="size-3.5" /> 写 Prompt
                              </span>
                            )}
                          </button>
                        )
                      }}
                      footer={
                        <button type="button" onClick={() => void createCategory('posture')} data-testid="new-posture" className="flex h-9 w-[148px] items-center gap-1.5 rounded-lg px-2 text-[12.5px] text-muted-foreground hover:bg-tint/[0.04] hover:text-primary">
                          <Plus className="size-3.5" /> 新建体位
                        </button>
                      }
                    />
                    <Orphans ix={ix} onPick={(t) => setSel(cellOf(t))} />
                  </>
                )
              )}
            </div>
          </div>
        </div>
      </div>
      {sel && (
        <div className="absolute top-3 right-3 z-30 flex max-h-[calc(100%-1.5rem)] w-[480px] flex-col overflow-hidden rounded-2xl bg-popover shadow-2xl ring-1 shadow-tint/15 ring-tint/[0.128] 2xl:static 2xl:my-3 2xl:mr-3 2xl:shrink-0 2xl:self-stretch 2xl:bg-card 2xl:shadow-none">
          <ActionEditor
            // 以选中的格子为 key：在空格子里新建 Prompt 时编辑区不重新挂载（不会丢失正在输入的内容）
            key={cellKey(sel)}
            ix={ix}
            cell={sel}
            prompt={selPrompt}
            onClose={() => setSel(null)}
            onSelect={(c) => {
              setSel(c)
              setMoodId(c.moodId)
            }}
          />
        </div>
      )}
    </div>
  )
}

function SearchResults({ ix, hits, sel, onPick }: { ix: ActionIndex; hits: Template[]; sel: Template | undefined; onPick: (t: Template) => void }) {
  if (!hits.length) return <EmptyState icon={<Shapes />} title="没有匹配的 Prompt" />
  return (
    <div className="space-y-1.5" data-testid="prompt-search">
      <div className="px-1 text-[11px] text-muted-foreground">{hits.length} 份 Prompt</div>
      {hits.map((t) => (
        <button key={t.id} type="button" onClick={() => onPick(t)} data-testid="prompt-hit" className={cn('group/cell block w-full rounded-lg bg-card p-2.5 text-left ring-1 ring-tint/[0.08] hover:bg-accent/70', sel?.id === t.id && 'bg-accent/80 ring-2 ring-primary/60')}>
          <div className="mb-1 text-[12px] font-medium">{labelOf(ix, t)}</div>
          <PromptSnippet t={t} lines={2} copy />
        </button>
      ))}
    </div>
  )
}

/** 分类已不存在的 Prompt（例如在工作区外删除了分类文件）：列出来以便重新归类 */
function Orphans({ ix, onPick }: { ix: ActionIndex; onPick: (t: Template) => void }) {
  const moods = new Set(ix.moods.map((m) => m.id))
  const postures = new Set(ix.postures.map((p) => p.id))
  const list = ix.prompts.filter((t) => !moods.has(t.mood_id ?? -1) || !postures.has(t.posture_id ?? -1))
  if (!list.length) return null
  return (
    <div className="mt-5 space-y-1.5" data-testid="prompt-orphans">
      <div className="px-1 text-[11px] font-medium text-amber-700">{list.length} 份 Prompt 的情绪组或体位已不存在：打开后在编辑区重新选择分类</div>
      {list.map((t) => (
        <button key={t.id} type="button" onClick={() => onPick(t)} className="group/cell block w-full rounded-lg bg-card p-2.5 text-left ring-1 ring-amber-500/30 hover:bg-accent/70">
          <div className="mb-1 text-[12px] font-medium">{labelOf(ix, t)}</div>
          <PromptSnippet t={t} lines={2} />
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- 编辑区
function ActionEditor({ ix, cell, prompt, onClose, onSelect }: { ix: ActionIndex; cell: Cell; prompt: Template | undefined; onClose: () => void; onSelect: (c: Cell) => void }) {
  const lib = useLib((s) => s.lib)
  const [pos, setPos] = useState(prompt?.positive ?? '')
  const [neg, setNeg] = useState(prompt?.negative ?? '')
  const [dialog, setDialog] = useState<null | 'copy' | 'move' | 'import'>(null)
  // 自动保存：还没有 Prompt 的格子在第一次输入时新建；保存串行执行，切换格子或关闭时立即保存
  const id = useRef<number | null>(prompt?.id ?? null)
  const pending = useRef<{ positive: string; negative: string } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const chain = useRef<Promise<unknown>>(Promise.resolve())
  const flush = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const v = pending.current
    pending.current = null
    if (!v) return chain.current
    chain.current = chain.current.then(async () => {
      if (id.current) await save({ id: id.current, _revision: prompt?._revision, positive: v.positive, negative: v.negative })
      else {
        if (!v.positive.trim() && !v.negative.trim()) return
        const r = await save({ kind: 'action', name: '', mood_id: cell.moodId, pov: cell.pov, posture_id: cell.postureId, positive: v.positive, negative: v.negative })
        if (r?.id) id.current = r.id
      }
      await reloadLib()
    })
    return chain.current
  }
  const change = (next: { positive?: string; negative?: string }) => {
    const v = { positive: next.positive ?? pos, negative: next.negative ?? neg }
    if (next.positive !== undefined) setPos(next.positive)
    if (next.negative !== undefined) setNeg(next.negative)
    pending.current = v
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void flush(), 400)
  }
  const flushRef = useRef(flush)
  flushRef.current = flush
  useEffect(() => () => void flushRef.current(), [])

  const mood = ix.byId.get(cell.moodId)
  const posture = ix.byId.get(cell.postureId)
  const title = `${mood?.name || '（未分组）'} / ${viewLabel(cell.pov)} / ${posture?.name || '（未分类）'}`
  const a = promptAnchors(pos)
  const legacy = legacyPlaceholders(pos)
  const legacyTpls = templatesOf(lib, 'card_tpl')

  const remove = async () => {
    await flush()
    if (!id.current) return onClose()
    const used = await api.references('action_id', id.current)
    const ok = await confirm({ title: `删除「${title}」？`, description: `${used.length ? `以下任务或预设正在使用它：${used.join('、')}\n删除后这些动作会提示引用失效。\n` : ''}文件会移入工作区回收站（.comfyengi/trash）。已加入队列或已生成的记录不受影响。`, confirmText: '删除', destructive: true })
    if (!ok) return
    await call(api['templates.remove'](id.current))
    await reloadLib()
    onClose()
  }
  /** 复制到另一个组合（新建一份）或移动（同一份 Prompt 改分类，任务中的引用随之移动） */
  const place = async (to: Cell, move: boolean) => {
    await flush()
    if (move && id.current) await save({ id: id.current, mood_id: to.moodId, pov: to.pov, posture_id: to.postureId })
    else {
      const r = await save({ kind: 'action', name: '', mood_id: to.moodId, pov: to.pov, posture_id: to.postureId, positive: pos, negative: neg })
      if (!r?.id) return
      to = { ...to, promptId: r.id }
    }
    await reloadLib()
    setDialog(null)
    onSelect(move && id.current ? { ...to, promptId: id.current } : to)
    toast.success(move ? '已移动' : '已复制')
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="action-editor">
      <div className="flex items-center gap-1 px-4 pt-3 pb-2">
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold" data-testid="editor-title">
          {title}
        </span>
        <CopyButton text={pos} label="复制原文" />
        <Button variant="ghost" size="xs" disabled={!pos.trim()} onClick={() => setDialog('copy')} data-testid="copy-to">
          <Copy /> 复制到…
        </Button>
        <Button variant="ghost" size="xs" disabled={!id.current && !prompt} onClick={() => setDialog('move')} data-testid="move-to">
          <ArrowRightLeft /> 移动
        </Button>
        <Button variant="ghost" size="icon-sm" className="hover:text-destructive" disabled={!id.current && !prompt} onClick={() => void remove()} aria-label="删除" data-testid="delete-prompt">
          <Trash2 />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="关闭">
          <X />
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-4">
        <div>
          <FieldLabel hint="原样保存：换行、权重、Wildcard、Tag 顺序都不会被修改" right={!pos.trim() && legacyTpls.length > 0 ? (
            <button type="button" className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-tint/[0.06] hover:text-foreground" onClick={() => setDialog('import')} data-testid="import-legacy">
              <FileInput className="size-3" /> 从旧版姿态模板导入
            </button>
          ) : undefined}>
            人物动作 Prompt
          </FieldLabel>
          <PromptField value={pos} onChange={(v) => change({ positive: v })} minRows={12} placeholder={'例如：\n1girl, 情绪专属词, 眼部, 嘴部, 手部, 身体状态, 腿部\n1man, 体位固定词, 抓取, 亲密动作'} />
          <AnchorStatus body={pos} />
          {legacy.length > 0 && <div className="mt-1 text-[11px] text-destructive">有旧版模板占位符 {legacy.join(' ')}：新版不会替换它们，会原样提交，请删除</div>}
        </div>
        <PromptField label="负面 Prompt（可选）" value={neg} onChange={(v) => change({ negative: v })} minRows={2} placeholder="这份 Prompt 专用的负面，可留空；会接在全局等负面之后" />
        {!a.girl.top.length && !pos.trim() && <div className="text-[11px] text-muted-foreground">还没有内容。输入后自动保存为这个组合的 Prompt。</div>}
      </div>
      {dialog === 'copy' || dialog === 'move' ? (
        <CellDialog ix={ix} from={cell} move={dialog === 'move'} onClose={() => setDialog(null)} onPick={(c) => void place(c, dialog === 'move')} />
      ) : null}
      {dialog === 'import' && (
        <LegacyImportDialog
          onClose={() => setDialog(null)}
          onPick={(text) => {
            change({ positive: text })
            setDialog(null)
          }}
        />
      )}
    </div>
  )
}

/** 插入位置的检查结果：生成时角色特征与服装插在这里 */
function AnchorStatus({ body }: { body: string }) {
  if (!body.trim()) return null
  const a = promptAnchors(body)
  const g = anchorProblem(a.girl)
  const m = hasMale(a) ? anchorProblem(a.man) : null
  const item = (ok: boolean, text: string, testId: string) => (
    <span className={cn('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5', ok ? 'bg-success/10 text-success' : 'bg-destructive/10 text-destructive')} data-testid={testId}>
      {ok ? <Check className="size-3" /> : <X className="size-3" />}
      {text}
    </span>
  )
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px]" data-testid="anchor-status">
      {item(!g, g ? (g === 'missing' ? '没有独立的 1girl：无法插入主角色' : g === 'multiple' ? `有 ${a.girl.top.length} 个 1girl：插入位置不明确` : '1girl 在括号内：请写成独立 Tag') : '1girl 之后插入主角色特征与服装', 'anchor-girl')}
      {hasMale(a) ? item(!m, m ? (m === 'multiple' ? `有 ${a.man.top.length} 个 1man：插入位置不明确` : '1man 在括号内：请写成独立 Tag') : '1man 之后插入第二角色（任务选择了第二角色时）', 'anchor-man') : <span className="text-muted-foreground">没有 1man：单人画面</span>}
    </div>
  )
}

/** 选择目标组合（复制 / 移动）：已有 Prompt 的组合不能选（不会覆盖） */
function CellDialog({ ix, from, move, onClose, onPick }: { ix: ActionIndex; from: Cell; move: boolean; onClose: () => void; onPick: (c: Cell) => void }) {
  const [moodId, setMoodId] = useState(from.moodId)
  const [pov, setPov] = useState(from.pov)
  const [postureId, setPostureId] = useState<number | null>(null)
  const taken = (p: number) => ix.at(moodId, pov, p).length > 0
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg" data-testid="cell-dialog">
        <DialogHeader>
          <DialogTitle>{move ? '移动到' : '复制到'}</DialogTitle>
          <DialogDescription>{move ? '同一份 Prompt 改为另一个组合，任务中对它的引用跟随移动。' : '在另一个组合新建一份相同内容的 Prompt，之后可以分别修改。'}已有 Prompt 的组合不能选择（不会覆盖）。</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <FieldLabel>情绪组</FieldLabel>
            <div className="flex flex-wrap gap-1.5">
              {ix.moods.map((m) => (
                <ChipButton key={m.id} on={moodId === m.id} onClick={() => setMoodId(m.id)}>
                  {m.name || '（未命名）'}
                </ChipButton>
              ))}
            </div>
          </div>
          <div>
            <FieldLabel>视角</FieldLabel>
            <div className="flex gap-1.5">
              {VIEWS.map((v) => (
                <ChipButton key={String(v.pov)} on={pov === v.pov} onClick={() => setPov(v.pov)}>
                  {v.label}
                </ChipButton>
              ))}
            </div>
          </div>
          <div>
            <FieldLabel>体位</FieldLabel>
            <div className="flex flex-wrap gap-1.5">
              {ix.postures.map((p) => (
                <ChipButton key={p.id} on={postureId === p.id} disabled={taken(p.id)} onClick={() => setPostureId(p.id)} title={taken(p.id) ? '这个组合已有 Prompt' : undefined}>
                  {p.name || '（未命名）'}
                </ChipButton>
              ))}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button disabled={postureId == null || taken(postureId)} onClick={() => postureId != null && onPick({ moodId, pov, postureId })} data-testid="cell-confirm">
            {move ? '移动' : '复制'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ChipButton({ on, disabled, onClick, title, children }: { on: boolean; disabled?: boolean; onClick: () => void; title?: string; children: React.ReactNode }) {
  return (
    <button type="button" title={title} disabled={disabled} onClick={onClick} className={cn('h-7 rounded-full px-3 text-xs ring-1 transition', on ? 'bg-primary/15 text-primary ring-primary/40' : 'bg-tint/[0.04] ring-tint/[0.1] hover:bg-tint/[0.08]', disabled && 'cursor-not-allowed line-through opacity-40')}>
      {children}
    </button>
  )
}

/** 从旧版动作卡的姿态模板导入：去掉 {全局}、{女特征} 等占位符后填入编辑框（只是草稿，原模板不变） */
function LegacyImportDialog({ onClose, onPick }: { onClose: () => void; onPick: (text: string) => void }) {
  const lib = useLib((s) => s.lib)
  const [q, setQ] = useState('')
  const [cur, setCur] = useState<Template | null>(null)
  const cards = templatesOf(lib, 'position')
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  const match = (card: Template, t: Template) => !words.length || words.every((w) => `${card.name}\n${t.name}\n${t.positive}`.toLowerCase().includes(w))
  const preview = cur ? fromLegacyTemplate(cur.positive) : ''
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[82vh] flex-col sm:max-w-3xl" data-testid="legacy-import">
        <DialogHeader>
          <DialogTitle>从旧版姿态模板导入</DialogTitle>
          <DialogDescription>复制旧模板的正文作为草稿：去掉 {'{全局}'}、{'{女特征}'} 等占位符（生成时这些内容由任务自动拼接），其余文字原样保留。请检查后再使用；旧模板本身不变。</DialogDescription>
        </DialogHeader>
        <SearchBox value={q} onChange={setQ} placeholder="搜索动作卡、模板名称或 Prompt…" autoFocus />
        <div className="flex min-h-0 flex-1 gap-3">
          <div className="w-64 shrink-0 space-y-2 overflow-y-auto">
            {cards.map((card) => {
              const tpls = cardTemplates(card, lib?.templates ?? []).filter((t) => match(card, t))
              if (!tpls.length) return null
              return (
                <div key={card.id}>
                  <div className="px-1 text-[11px] font-medium text-muted-foreground">{card.name || '（未命名）'}</div>
                  {tpls.map((t) => (
                    <button key={t.id} type="button" onClick={() => setCur(t)} data-testid="legacy-template" className={cn('block w-full truncate rounded-md px-2 py-1 text-left text-[12.5px] hover:bg-tint/[0.05]', cur?.id === t.id && 'bg-primary/10 text-primary')}>
                      {t.name || '（未命名）'}
                    </button>
                  ))}
                </div>
              )
            })}
          </div>
          <div className="min-w-0 flex-1 overflow-y-auto rounded-xl bg-inset p-3">
            {cur ? <pre className="font-mono text-[12px] whitespace-pre-wrap [overflow-wrap:anywhere]" data-testid="legacy-preview">{preview || '（去掉占位符后为空）'}</pre> : <div className="pt-8 text-center text-xs text-muted-foreground">选择左侧的姿态模板</div>}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button disabled={!cur || !preview.trim()} onClick={() => onPick(preview)} data-testid="legacy-confirm">
            填入编辑框
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
