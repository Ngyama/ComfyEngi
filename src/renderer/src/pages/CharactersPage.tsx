// 角色库：一个连续的角色编辑页面——名称 → LoRA → 基础 Prompt → 服装。
// 角色标签、角色负面 Prompt、LoRA 权重、服装负面 / 备注不再显示；保存时不发送这些字段，旧内容原样保留。
// 触发词不再作为隐藏的额外 Prompt 拼接：通过「导入触发词」在确认后写入可编辑的基础 Prompt / 新服装。

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronRight, ChevronsUpDown, Copy, GripVertical, Plus, Shirt, Trash2, Unlink, Users, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Avatar, EmptyState, FieldLabel, PromptField, SearchBox, TextInput } from '@/components/common'
import { SortableArea, useSortableItem } from '@/components/sortable'
import { api, call } from '@/lib/api'
import { hueOf, matches, useDraft } from '@/lib/hooks'
import { confirm, reloadLib, useLib } from '@/lib/stores'
import { cn } from '@/lib/utils'
import { LoraThumb, loraTitle } from '@/pages/LorasPage'
import { prependTags, promptTags } from '@shared/prompt'
import type { Character, Lora, LoraResource, Outfit } from '@shared/types'

// ---------------------------------------------------------------- LoRA 资源（复用 LoRA Manager 的数据接口）

let resourceCache: LoraResource[] | null = null
function useLoraResources() {
  const [rows, setRows] = useState<LoraResource[]>(resourceCache ?? [])
  const refresh = async () => {
    const r = await api['loras.list']().catch(() => null)
    if (r) {
      resourceCache = r
      setRows(r)
    }
  }
  useEffect(() => {
    void refresh()
  }, [])
  return { rows, refresh }
}

const fileStem = (r: LoraResource) => r.name.replace(/\.safetensors$/i, '')
const folderOf = (r: LoraResource) => r.folder || r.root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''

/** 可搜索的 LoRA 选择器：同时匹配本地文件名与 metadata 中的模型名称 */
function LoraPicker({ resources, onPick, children }: { resources: LoraResource[]; onPick: (r: LoraResource) => void; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  useEffect(() => {
    if (open) setQ('')
  }, [open])
  const list = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    return resources
      .filter((r) => !r.missing && !r.offline)
      .filter((r) => {
        const hay = `${r.name} ${r.sidecar?.modelName ?? ''} ${r.folder}`.toLowerCase()
        return words.every((w) => hay.includes(w))
      })
      .sort((a, b) => loraTitle(a).localeCompare(loraTitle(b), 'zh'))
  }, [resources, q])
  const shown = list.slice(0, 60)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-[420px] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput value={q} onValueChange={setQ} placeholder="搜索文件名或模型名称…" />
          <CommandList className="max-h-[380px]">
            <CommandEmpty>{resources.length ? '没有匹配的 LoRA' : '还没有扫描到 LoRA，请先在「LoRA 管理」中添加目录'}</CommandEmpty>
            {shown.map((r) => (
              <CommandItem
                key={r.id}
                value={r.id}
                onSelect={() => {
                  onPick(r)
                  setOpen(false)
                }}
                className="gap-3 py-1.5"
                data-testid="lora-picker-item"
              >
                <LoraThumb r={r} width={96} className="h-12 w-9 rounded-md" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px]">{loraTitle(r)}</div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {folderOf(r)}
                    {r.sidecar?.modelName && r.sidecar.modelName !== fileStem(r) ? ` · ${fileStem(r)}` : ''}
                  </div>
                </div>
                {r.sidecar?.baseModel && <span className="shrink-0 rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-muted-foreground">{r.sidecar.baseModel}</span>}
              </CommandItem>
            ))}
            {list.length > shown.length && <div className="px-3 py-2 text-center text-[11px] text-muted-foreground">还有 {list.length - shown.length} 个结果，请输入更多关键词</div>}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/** 角色的 LoRA：最多关联一个；旧版多 LoRA 数据保持原样并明确提示 */
function LoraSection({ loras, resources, onChange, onResourceChanged, onImport }: { loras: Lora[]; resources: LoraResource[]; onChange: (v: Lora[]) => void; onResourceChanged: () => void; onImport: (r: LoraResource) => void }) {
  const byId = (id?: string) => (id ? resources.find((r) => r.id === id) : undefined)
  // 生成权重沿用 LoRA 的推荐权重（strength 字段保留给生成器使用，之后可由任务级设置覆盖）
  const pick = (r: LoraResource) => {
    const old = loras[0]
    onChange([{ ...(old ?? {}), resource_id: r.id, name: r.comfyName || r.name, strength: r.recommendedWeight }])
  }

  if (loras.length > 1)
    return (
      <div className="space-y-2 rounded-xl bg-warning/[0.07] p-3 ring-1 ring-warning/25" data-testid="legacy-loras">
        <div className="flex items-start gap-2 text-xs leading-relaxed text-warning">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>
            这是旧版保存的 {loras.length} 个 LoRA（多槽位配置），生成时仍按原样全部使用，不会被修改。新版每个角色只关联一个 LoRA；如需改为单个，请点击「改为单个 LoRA」。
          </span>
        </div>
        {loras.map((l, i) => {
          const r = byId(l.resource_id)
          return (
            <div key={i} className="flex items-center gap-3 rounded-lg bg-black/20 p-2">
              <span className="w-12 shrink-0 text-[11px] text-muted-foreground">槽位 {i + 1}</span>
              {r && <LoraThumb r={r} width={96} className="h-10 w-8 rounded" />}
              <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{r ? loraTitle(r) : l.name}</span>
              <span className="text-[12px] text-muted-foreground tabular-nums">{l.strength}</span>
            </div>
          )
        })}
        <Button
          size="sm"
          variant="secondary"
          onClick={async () => {
            if (
              await confirm({
                title: '改为单个 LoRA？',
                description: `将只保留槽位 1，移除该角色的另外 ${loras.length - 1} 个 LoRA 关联。\n不会删除或修改任何 LoRA 文件；之后可以再选择其他 LoRA。`,
                confirmText: '只保留槽位 1',
              })
            )
              onChange(loras.slice(0, 1))
          }}
        >
          改为单个 LoRA
        </Button>
      </div>
    )

  const l = loras[0]
  if (!l)
    return (
      <LoraPicker resources={resources} onPick={pick}>
        <button type="button" className="flex h-11 w-full items-center gap-2 rounded-xl border border-dashed border-white/[0.12] px-3 text-left text-[13px] text-muted-foreground hover:border-primary/40 hover:text-primary" data-testid="lora-picker-open">
          <Plus className="size-4" /> 选择 LoRA…
          <ChevronsUpDown className="ml-auto size-4 opacity-60" />
        </button>
      </LoraPicker>
    )

  const r = byId(l.resource_id)
  const suggested = r ? (/^[a-z]:[\\/]/i.test(r.path) ? r.relativePath.replaceAll('/', '\\') : r.relativePath) : ''
  return (
    <div className="flex items-center gap-3 rounded-xl bg-white/[0.035] p-2.5 ring-1 ring-white/[0.06]" data-testid="character-lora">
      {r ? (
        <LoraThumb r={r} width={160} className="h-16 w-12 rounded-lg" />
      ) : (
        <div className="grid h-16 w-12 shrink-0 place-items-center rounded-lg bg-black/30 text-muted-foreground">
          <Unlink className="size-4" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium">{r ? loraTitle(r) : l.name}</div>
        <div className="truncate text-[11px] text-muted-foreground">
          {r ? `${folderOf(r)} · ${r.name}` : l.resource_id ? 'LoRA 管理中找不到这条记录（可能已移除扫描目录）' : '旧版手动填写的模型名称'}
        </div>
        {r && (r.missing || r.offline) && <div className="mt-0.5 text-[11px] text-destructive">{r.missing ? '模型文件缺失' : '所在目录无法访问'}</div>}
        {r && !r.comfyName && !r.missing && !r.offline && (
          <button
            type="button"
            className="mt-0.5 text-left text-[11px] text-warning hover:underline"
            onClick={async () => {
              await call(api['loras.save']({ ...r, comfyName: suggested }))
              onResourceChanged()
            }}
            title="ComfyUI LoRA 加载节点使用的相对名称"
          >
            尚未设置 ComfyUI 模型名称，点击使用 <span className="font-mono">{suggested}</span>
          </button>
        )}
      </div>
      {r?.sidecar?.triggerWords?.length ? (
        <Button variant="ghost" size="sm" onClick={() => onImport(r)}>
          导入触发词
        </Button>
      ) : null}
      <LoraPicker resources={resources} onPick={pick}>
        <Button variant="ghost" size="sm">
          更换
        </Button>
      </LoraPicker>
      <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive" onClick={() => onChange([])} aria-label="取消关联 LoRA">
        <X />
      </Button>
    </div>
  )
}

// ---------------------------------------------------------------- 服装

function OutfitRow({ o, open, onToggle, onDeleted }: { o: Outfit; open: boolean; onToggle: () => void; onDeleted: () => void }) {
  const s = useSortableItem(String(o.id))
  return (
    <div ref={s.setNodeRef} style={s.style} className={cn('rounded-xl bg-white/[0.03] ring-1 ring-white/[0.05]', open && 'bg-white/[0.045] ring-white/[0.1]', s.isDragging && 'shadow-2xl shadow-black/50')} data-testid="outfit-row">
      <div className="flex items-center gap-2 px-2 py-2">
        <button type="button" {...s.attributes} {...s.listeners} className="cursor-grab text-muted-foreground/50 hover:text-muted-foreground" aria-label="拖动排序">
          <GripVertical className="size-4" />
        </button>
        <button type="button" onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          {open ? <ChevronDown className="size-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-4 shrink-0 text-muted-foreground" />}
          <Shirt className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="shrink-0 text-[13px] font-medium">{o.name || '（未命名）'}</span>
          {!open && <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">{o.positive || '（空）'}</span>}
        </button>
      </div>
      {open && (
        <div className="px-3 pb-3">
          <OutfitEditor o={o} onDeleted={onDeleted} />
        </div>
      )}
    </div>
  )
}

function OutfitEditor({ o, onDeleted }: { o: Outfit; onDeleted: () => void }) {
  const { draft, patch, flush } = useDraft<Outfit>(o, o.id, async (v) => {
    // 只发送名称与 Positive：旧文件中的负面 Prompt 与备注保存时原样保留
    await call(api['outfits.save']({ id: v.id, _revision: v._revision, name: v.name, positive: v.positive }))
    await reloadLib()
  })
  if (!draft) return null
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <TextInput value={draft.name} onChange={(v) => patch({ name: v })} className="font-medium" />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="复制服装"
          onClick={async () => {
            flush()
            await call(api['outfits.duplicate'](o.id))
            await reloadLib()
          }}
        >
          <Copy />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="删除服装"
          className="hover:text-destructive"
          onClick={async () => {
            const used = [...new Set([...(await api.references('outfit_id', o.id)), ...(await api.references('story_outfit_id', o.id))])]
            if (!(await confirm({ title: `删除服装「${draft.name}」？`, description: used.length ? `以下套图任务正在使用它：${used.join('、')}` : undefined, confirmText: '删除', destructive: true }))) return
            await call(api['outfits.remove'](o.id))
            await reloadLib()
            onDeleted()
          }}
        >
          <Trash2 />
        </Button>
      </div>
      <PromptField value={draft.positive} onChange={(v) => patch({ positive: v })} placeholder="服装 / 穿着状态 Prompt（原样保存）" minRows={2} />
    </div>
  )
}

// ---------------------------------------------------------------- 角色

function CharacterAvatar({ c, resources, className }: { c: Character; resources: LoraResource[]; className?: string }) {
  const r = c.loras?.length === 1 && c.loras[0].resource_id ? resources.find((x) => x.id === c.loras[0].resource_id) : undefined
  if (r && (r.preview || r.cover)) return <LoraThumb r={r} width={96} className={cn('size-9 rounded-xl', className)} />
  return <Avatar name={c.name} hue={hueOf(c.name)} className={className} />
}

function Section({ title, hint, right, children }: { title: string; hint?: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section>
      <FieldLabel hint={hint} right={right}>
        {title}
      </FieldLabel>
      {children}
    </section>
  )
}

function CharacterDetail({ c, resources, refreshResources, onDeleted }: { c: Character; resources: LoraResource[]; refreshResources: () => void; onDeleted: () => void }) {
  const lib = useLib((s) => s.lib)
  const [openOutfit, setOpenOutfit] = useState<number | null>(null)
  const [importing, setImporting] = useState<LoraResource | null>(null)
  // 只发送这里可编辑的字段：tag / negative 等隐藏字段不发送，保存时原样保留
  const { draft, patch, flush } = useDraft<Character>(c, c.id, async (v) => {
    await call(api['characters.save']({ id: v.id, _revision: v._revision, name: v.name, positive: v.positive, loras: v.loras }))
    await reloadLib()
  })
  const outfits = (lib?.outfits ?? []).filter((o) => o.character_id === c.id)
  if (!draft) return null
  const loras = draft.loras ?? []
  // 旧版本中已启用的触发词：新版不再自动拼接，由用户确认后合并到基础 Prompt（只执行一次）
  const legacyTriggers = loras.flatMap((l) => l.trigger_words ?? []).filter((w) => w && w.trim())
  const mergeLegacy = () => {
    const { text, added, skipped } = prependTags(draft.positive, legacyTriggers)
    patch({ positive: text, loras: loras.map((l) => ({ ...l, trigger_words: [] })) })
    toast.success(added.length ? `已合并 ${added.length} 个触发词到基础 Prompt` : '这些触发词已在基础 Prompt 中', { description: skipped.length ? `已存在、未重复添加：${skipped.join(', ')}` : undefined })
  }
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 px-6 pt-5 pb-4">
        <CharacterAvatar c={draft} resources={resources} className="size-11 text-base" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[16px] font-semibold">{draft.name || '（未命名）'}</div>
          <div className="text-xs text-muted-foreground">
            {outfits.length} 套服装 · {loras.length ? (loras.length > 1 ? `${loras.length} 个 LoRA（旧配置）` : '1 个 LoRA') : '未关联 LoRA'}
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={async () => {
            flush()
            const r = await call(api['characters.duplicate'](c.id))
            if (r) {
              await reloadLib()
              toast.success('已复制角色（含服装）')
            }
          }}
        >
          <Copy /> 复制
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="hover:text-destructive"
          onClick={async () => {
            const used = await api.references('character_id', c.id)
            if (!(await confirm({ title: `删除角色「${draft.name}」及其全部服装？`, description: (used.length ? `以下套图任务正在使用它：${used.join('、')}\n` : '') + '已生成的运行记录不受影响。', confirmText: '删除', destructive: true }))) return
            await call(api['characters.remove'](c.id))
            await reloadLib()
            onDeleted()
          }}
        >
          <Trash2 /> 删除
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-8">
        <div className="max-w-3xl space-y-6">
          <Section title="名称">
            <TextInput value={draft.name} onChange={(v) => patch({ name: v })} />
          </Section>

          <Section title="LoRA" hint="最多关联一个；模型名称写入工作流中映射的 LoRA 节点">
            <LoraSection loras={loras} resources={resources} onChange={(v) => patch({ loras: v })} onResourceChanged={refreshResources} onImport={setImporting} />
          </Section>

          {legacyTriggers.length > 0 && (
            <div className="flex items-start gap-3 rounded-xl bg-warning/[0.07] p-3 ring-1 ring-warning/25" data-testid="legacy-triggers">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
              <div className="min-w-0 flex-1 text-xs leading-relaxed text-warning">
                之前启用的触发词 <span className="font-mono">{legacyTriggers.join(', ')}</span> 不再自动加入生成。可以合并到基础 Prompt 开头（已存在的不会重复添加），合并前不会修改任何内容。
              </div>
              <Button size="sm" variant="secondary" onClick={mergeLegacy}>
                合并到基础 Prompt
              </Button>
            </div>
          )}

          <PromptField label="基础 Prompt" value={draft.positive} onChange={(v) => patch({ positive: v })} placeholder="角色外观、固定特征（原样保存）" minRows={2} copy />

          <Section
            title={`服装${outfits.length ? ` · ${outfits.length}` : ''}`}
            hint="拖动调整顺序，点击展开编辑"
            right={
              <Button
                size="xs"
                variant="ghost"
                onClick={async () => {
                  const r = await call(api['outfits.save']({ character_id: c.id, name: `服装${outfits.length + 1}` }))
                  if (r) {
                    await reloadLib()
                    setOpenOutfit(r.id)
                  }
                }}
              >
                <Plus /> 新建服装
              </Button>
            }
          >
            <div className="space-y-1.5">
              <SortableArea
                items={outfits}
                getId={(o) => String(o.id)}
                onReorder={async (_f, _t, next) => {
                  await call(api['outfits.reorder'](next.map((o) => o.id)))
                  await reloadLib()
                }}
              >
                {outfits.map((o) => (
                  <OutfitRow key={o.id} o={o} open={openOutfit === o.id} onToggle={() => setOpenOutfit(openOutfit === o.id ? null : o.id)} onDeleted={() => setOpenOutfit(null)} />
                ))}
              </SortableArea>
              {!outfits.length && <div className="rounded-xl border border-dashed border-white/[0.1] px-4 py-5 text-center text-xs text-muted-foreground">还没有服装。每套服装是一段原始 Prompt，只属于这个角色。</div>}
            </div>
          </Section>
        </div>
      </div>
      {importing && (
        <ImportTriggersDialog
          resource={importing}
          base={draft.positive}
          onClose={() => setImporting(null)}
          onConfirm={async (text, drafts) => {
            patch({ positive: text }) // 由自动保存写入角色文件
            let n = 0
            for (const o of drafts) if ((await call(api['outfits.save']({ character_id: c.id, name: o.name, positive: o.positive }))) !== undefined) n++
            await reloadLib()
            setImporting(null)
            toast.success('已导入触发词', { description: n ? `新建 ${n} 套服装` : undefined })
          }}
        />
      )}
    </div>
  )
}

/**
 * 导入触发词：读取 LoRA Manager 已解析的触发词，用户在确认前编辑内容。
 * 默认作为基础 Prompt 的候选文本；可以手动整理出新的服装。metadata 没有服装分组信息，因此不自动拆分。
 * 只写入角色基础 Prompt（加在开头，不覆盖原文）和新建的服装文件，不修改原 metadata.json。
 */
function ImportTriggersDialog({ resource, base, onClose, onConfirm }: { resource: LoraResource; base: string; onClose: () => void; onConfirm: (text: string, outfits: { name: string; positive: string }[]) => void }) {
  const words = resource.sidecar?.triggerWords ?? []
  const existing = new Set(promptTags(base))
  const fresh = words.filter((w) => !existing.has(w.trim().toLowerCase()))
  const [text, setText] = useState(fresh.join(', '))
  const [outfits, setOutfits] = useState<{ name: string; positive: string }[]>([])
  const [target, setTarget] = useState(-1) // -1 = 基础 Prompt，>=0 = 第 n 套新服装
  const append = (cur: string, w: string) => (cur.trim() ? `${cur.replace(/[,\s]+$/, '')}, ${w}` : w)
  const add = (w: string) => {
    if (target < 0) setText((t) => append(t, w))
    else setOutfits((os) => os.map((o, i) => (i === target ? { ...o, positive: append(o.positive, w) } : o)))
  }
  const result = prependTags(base, text.split(',').map((x) => x.trim()))
  const valid = outfits.filter((o) => o.name.trim() && o.positive.trim())
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>导入触发词</DialogTitle>
          <DialogDescription>来自「{loraTitle(resource)}」的 metadata。确认前可以编辑；不会修改 LoRA 的 metadata.json。</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <FieldLabel hint="点击插入到下方选中的位置">触发词</FieldLabel>
            <div className="flex flex-wrap gap-1.5">
              {words.map((w) => (
                <button key={w} type="button" onClick={() => add(w)} className={cn('rounded-full px-2.5 py-1 font-mono text-[11.5px] ring-1', existing.has(w.trim().toLowerCase()) ? 'bg-white/[0.03] text-muted-foreground ring-white/[0.06]' : 'bg-primary/10 text-primary ring-primary/25 hover:bg-primary/20')} title={existing.has(w.trim().toLowerCase()) ? '已在基础 Prompt 中' : '点击插入'}>
                  {w}
                </button>
              ))}
            </div>
          </div>
          <div className={cn('rounded-xl p-3 ring-1', target < 0 ? 'ring-primary/50' : 'ring-white/[0.06]')} onClick={() => setTarget(-1)}>
            <FieldLabel hint="加在基础 Prompt 开头，已存在的标签不会重复">加入基础 Prompt</FieldLabel>
            <PromptField value={text} onChange={setText} minRows={2} placeholder="（不加入基础 Prompt）" />
            {result.skipped.length > 0 && <div className="mt-1 text-[11px] text-muted-foreground">已存在、将跳过：{result.skipped.join(', ')}</div>}
          </div>
          {outfits.map((o, i) => (
            <div key={i} className={cn('space-y-2 rounded-xl p-3 ring-1', target === i ? 'ring-primary/50' : 'ring-white/[0.06]')} onClick={() => setTarget(i)}>
              <div className="flex items-center gap-2">
                <Shirt className="size-3.5 text-muted-foreground" />
                <TextInput value={o.name} onChange={(v) => setOutfits((os) => os.map((x, j) => (j === i ? { ...x, name: v } : x)))} placeholder="服装名称" />
                <Button variant="ghost" size="icon-sm" aria-label="移除这套服装" onClick={(e) => { e.stopPropagation(); setOutfits((os) => os.filter((_, j) => j !== i)); setTarget(-1) }}>
                  <X />
                </Button>
              </div>
              <PromptField value={o.positive} onChange={(v) => setOutfits((os) => os.map((x, j) => (j === i ? { ...x, positive: v } : x)))} minRows={2} placeholder="服装 Prompt" />
            </div>
          ))}
          <Button variant="ghost" size="sm" onClick={() => { setOutfits((os) => [...os, { name: `新服装${os.length + 1}`, positive: '' }]); setTarget(outfits.length) }}>
            <Plus /> 整理为新服装
          </Button>
          <div className="rounded-xl bg-black/25 p-3">
            <FieldLabel>导入后的基础 Prompt</FieldLabel>
            <pre className="font-mono text-[12px] whitespace-pre-wrap text-foreground/85" data-testid="import-preview">{result.text || '（空）'}</pre>
            {valid.length > 0 && <div className="mt-2 text-[11px] text-muted-foreground">将新建服装：{valid.map((o) => o.name).join('、')}（不会修改已有服装）</div>}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button disabled={!result.added.length && !valid.length} onClick={() => onConfirm(result.text, valid)}>
            确认导入
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default function CharactersPage() {
  const lib = useLib((s) => s.lib)
  const { rows: resources, refresh } = useLoraResources()
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<number | null>(lib?.characters[0]?.id ?? null)
  const chars = (lib?.characters ?? []).filter((c) => !q || matches(c as never, q))
  const cur = lib?.characters.find((c) => c.id === sel)
  const outfitCount = (id: number) => (lib?.outfits ?? []).filter((o) => o.character_id === id).length
  return (
    <div className="flex h-full">
      <div className="flex w-[260px] shrink-0 flex-col border-r border-white/[0.05]">
        <div className="flex items-center justify-between px-4 pt-5 pb-3">
          <h1 className="text-[15px] font-semibold">角色库</h1>
          <Button
            size="sm"
            onClick={async () => {
              const r = await call(api['characters.save']({ name: '新角色' }))
              if (r) {
                await reloadLib()
                setQ('')
                setSel(r.id)
              }
            }}
          >
            <Plus /> 新建
          </Button>
        </div>
        <div className="px-4 pb-3">
          <SearchBox value={q} onChange={setQ} placeholder="搜索角色…" />
        </div>
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-3">
          {chars.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setSel(c.id)}
              data-active={sel === c.id || undefined}
              className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-white/[0.04] data-[active]:bg-white/[0.07]"
            >
              <CharacterAvatar c={c} resources={resources} />
              <div className="min-w-0">
                <div className="truncate text-[13px] font-medium">{c.name || '（未命名）'}</div>
                <div className="truncate text-[11px] text-muted-foreground">{outfitCount(c.id)} 套服装</div>
              </div>
            </button>
          ))}
        </div>
      </div>
      <div className="min-w-0 flex-1">
        {cur ? (
          <CharacterDetail key={cur.id} c={cur} resources={resources} refreshResources={refresh} onDeleted={() => setSel(null)} />
        ) : (
          <EmptyState icon={<Users />} title={lib?.characters.length ? '选择一个角色' : '还没有角色'} description="角色包含 LoRA、触发词、基础 Prompt 与专属的服装模板；在套图任务中选择角色后会自动载入。" />
        )}
      </div>
    </div>
  )
}
