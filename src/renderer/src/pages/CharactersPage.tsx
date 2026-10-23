// 角色库：角色资料、LoRA，以及该角色专属的服装模板。

import { useEffect, useState } from 'react'
import { Copy, Plus, Shirt, Trash2, Users, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Avatar, EmptyState, FieldLabel, PromptField, SearchBox, TextInput } from '@/components/common'
import { SortableArea, useSortableItem } from '@/components/sortable'
import { api, call } from '@/lib/api'
import { hueOf, matches, useDraft } from '@/lib/hooks'
import { confirm, reloadLib, useLib } from '@/lib/stores'
import { cn } from '@/lib/utils'
import type { Character, Lora, Outfit } from '@shared/types'

function LoraEditor({ value, onChange }: { value: Lora[]; onChange: (v: Lora[]) => void }) {
  const [resources,setResources]=useState<import('@shared/types').LoraResource[]>([])
  useEffect(()=>{void api['loras.list']().then(setResources).catch(()=>{})},[])
  const set = (i: number, p: Partial<Lora>) => onChange(value.map((l, j) => (j === i ? { ...l, ...p } : l)))
  return (
    <div className="space-y-2">
      <select className="bg-background p-2 rounded-lg text-xs w-full" value="" onChange={e=>{const r=resources.find(r=>r.id===e.target.value);if(r)onChange([...value,{resource_id:r.id,name:r.comfyName||r.name,strength:r.recommendedWeight}])}}><option value="">从 LoRA Manager 添加资源…</option>{resources.filter(r=>!r.missing).map(r=><option key={r.id} value={r.id}>{r.name}</option>)}</select>
      {value.map((l, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="w-12 shrink-0 text-[11px] text-muted-foreground">槽位 {i + 1}</span>
          <TextInput value={l.name} onChange={(v) => set(i, { name: v })} placeholder="与 ComfyUI 中的文件名一致，如 xxx.safetensors" mono />
          <input
            type="number"
            step={0.05}
            value={l.strength}
            onChange={(e) => set(i, { strength: parseFloat(e.target.value) || 0 })}
            className="h-9 w-20 shrink-0 rounded-lg bg-white/[0.04] px-2 text-center text-[13px] tabular-nums ring-1 ring-white/[0.07] outline-none focus:ring-primary/50"
          />
          <Button variant="ghost" size="icon-sm" onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label="删除 LoRA">
            <X />
          </Button>
        </div>
      ))}
      <Button variant="ghost" size="sm" onClick={() => onChange([...value, { name: '', strength: 1 }])} disabled={value.length >= 4}>
        <Plus /> 添加 LoRA
      </Button>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        在「设置 → 工作流」中把「角色 LoRA 名称 / 强度」映射到 LoRA 节点后才会写入；映射的角色槽位必须全部配置，空槽位会阻止入队。若习惯在 Prompt 中写 &lt;lora:…&gt;，直接写进基础 Prompt 即可。
      </p>
    </div>
  )
}

function OutfitCard({ o, selected, onClick }: { o: Outfit; selected: boolean; onClick: () => void }) {
  const s = useSortableItem(String(o.id))
  return (
    <div
      ref={s.setNodeRef}
      style={s.style}
      {...s.attributes}
      {...s.listeners}
      onClick={onClick}
      className={cn('cursor-pointer rounded-xl bg-white/[0.035] p-3 ring-1 ring-white/[0.05] transition hover:bg-white/[0.06]', selected && 'bg-white/[0.07] ring-primary/60', s.isDragging && 'shadow-2xl shadow-black/50')}
    >
      <div className="flex items-center gap-2">
        <Shirt className="size-3.5 text-muted-foreground" />
        <span className="truncate text-[13px] font-medium">{o.name || '（未命名）'}</span>
      </div>
      <div className="mt-1 line-clamp-2 font-mono text-[11px] leading-snug text-muted-foreground">{o.positive || '（空）'}</div>
    </div>
  )
}

function OutfitEditor({ o, onDeleted }: { o: Outfit; onDeleted: () => void }) {
  const { draft, patch, flush } = useDraft<Outfit>(o, o.id, async (v) => {
    await call(api['outfits.save']({ id: v.id, _revision: v._revision, name: v.name, positive: v.positive, negative: v.negative, note: v.note }))
    await reloadLib()
  })
  if (!draft) return null
  return (
    <div className="space-y-3 rounded-xl bg-white/[0.025] p-4 ring-1 ring-white/[0.05]">
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
      <PromptField label="正面 Prompt" value={draft.positive} onChange={(v) => patch({ positive: v })} placeholder="服装 / 穿着状态（原样保存）" minRows={4} copy />
      <PromptField label="负面 Prompt" value={draft.negative} onChange={(v) => patch({ negative: v })} placeholder="可留空" minRows={2} />
      <TextInput value={draft.note} onChange={(v) => patch({ note: v })} placeholder="备注（可选）" />
    </div>
  )
}

function CharacterDetail({ c, onDeleted }: { c: Character; onDeleted: () => void }) {
  const lib = useLib((s) => s.lib)
  const [tab, setTab] = useState('profile')
  const [selOutfit, setSelOutfit] = useState<number | null>(null)
  const { draft, patch, flush } = useDraft<Character>(c, c.id, async (v) => {
    await call(api['characters.save']({ id: v.id, _revision: v._revision, name: v.name, tag: v.tag, positive: v.positive, negative: v.negative, loras: v.loras.filter((l) => l.name.trim()), note: v.note }))
    await reloadLib()
  })
  const outfits = (lib?.outfits ?? []).filter((o) => o.character_id === c.id)
  const curOutfit = outfits.find((o) => o.id === selOutfit) ?? null
  if (!draft) return null
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 px-6 pt-5 pb-3">
        <Avatar name={draft.name} hue={hueOf(draft.name)} className="size-11 text-base" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[16px] font-semibold">{draft.name || '（未命名）'}</div>
          <div className="text-xs text-muted-foreground">
            {outfits.length} 套服装 · {draft.loras.filter((l) => l.name).length} 个 LoRA
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
      <Tabs value={tab} onValueChange={setTab} className="min-h-0 flex-1 gap-0">
        <div className="px-6">
          <TabsList>
            <TabsTrigger value="profile">角色资料</TabsTrigger>
            <TabsTrigger value="outfits">服装 {outfits.length}</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="profile" className="min-h-0 overflow-y-auto px-6 pt-4 pb-6">
          <div className="grid max-w-3xl gap-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <FieldLabel>名称</FieldLabel>
                <TextInput value={draft.name} onChange={(v) => patch({ name: v })} />
              </div>
              <div>
                <FieldLabel hint="可用 {角色标签} 引用">角色标签</FieldLabel>
                <TextInput value={draft.tag} onChange={(v) => patch({ tag: v })} placeholder="例如 Danbooru 角色标签" mono />
              </div>
            </div>
            <PromptField label="基础 Prompt" value={draft.positive} onChange={(v) => patch({ positive: v })} placeholder="角色外观、固定特征（原样保存）" minRows={5} copy />
            <PromptField label="负面 Prompt" value={draft.negative} onChange={(v) => patch({ negative: v })} placeholder="角色专用负面（可留空）" minRows={2} />
            <div>
              <FieldLabel>LoRA</FieldLabel>
              <LoraEditor value={draft.loras ?? []} onChange={(v) => patch({ loras: v })} />
            </div>
            <div>
              <FieldLabel>备注</FieldLabel>
              <TextInput value={draft.note} onChange={(v) => patch({ note: v })} placeholder="可选" />
            </div>
          </div>
        </TabsContent>
        <TabsContent value="outfits" className="flex min-h-0 gap-4 px-6 pt-4 pb-6">
          <div className="w-64 shrink-0 space-y-2 overflow-y-auto">
            <SortableArea
              items={outfits}
              getId={(o) => String(o.id)}
              onReorder={async (_f, _t, next) => {
                await call(api['outfits.reorder'](next.map((o) => o.id)))
                await reloadLib()
              }}
            >
              {outfits.map((o) => (
                <OutfitCard key={o.id} o={o} selected={selOutfit === o.id} onClick={() => setSelOutfit(o.id)} />
              ))}
            </SortableArea>
            <button
              type="button"
              onClick={async () => {
                const r = await call(api['outfits.save']({ character_id: c.id, name: `服装${outfits.length + 1}` }))
                if (r) {
                  await reloadLib()
                  setSelOutfit(r.id)
                }
              }}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-white/[0.1] py-3 text-xs text-muted-foreground hover:border-primary/40 hover:text-primary"
            >
              <Plus className="size-3.5" /> 添加服装
            </button>
          </div>
          <div className="min-w-0 flex-1 overflow-y-auto">
            {curOutfit ? (
              <OutfitEditor key={curOutfit.id} o={curOutfit} onDeleted={() => setSelOutfit(null)} />
            ) : (
              <EmptyState icon={<Shirt />} title={outfits.length ? '选择一套服装进行编辑' : '还没有服装模板'} description="每套服装是一段原始 Prompt，只属于这个角色。拖动左侧卡片调整顺序。" />
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}

export default function CharactersPage() {
  const lib = useLib((s) => s.lib)
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
              <Avatar name={c.name} hue={hueOf(c.name)} />
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
          <CharacterDetail key={cur.id} c={cur} onDeleted={() => setSel(null)} />
        ) : (
          <EmptyState icon={<Users />} title={lib?.characters.length ? '选择一个角色' : '还没有角色'} description="角色包含基础 Prompt、LoRA 与专属的服装模板；在套图任务中选择角色后会自动载入。" />
        )}
      </div>
    </div>
  )
}
