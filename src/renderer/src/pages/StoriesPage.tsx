// 剧情库：按类型管理手工编写的完整剧情模板与有序场景。

import { useMemo, useState } from 'react'
import { BookOpen, ChevronDown, ChevronRight, Copy, GripVertical, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Chip, EmptyState, FieldLabel, NumberStepper, PromptField, SearchBox, TextInput } from '@/components/common'
import { SortableArea, useSortableItem } from '@/components/sortable'
import { api, call } from '@/lib/api'
import { matches, useDraft } from '@/lib/hooks'
import { confirm, reloadLib, useLib } from '@/lib/stores'
import { cn } from '@/lib/utils'
import { PLACEHOLDER_HELP } from '@shared/prompt'
import type { Scene, Story } from '@shared/types'

const newScene = (n: number): Scene => ({ name: `场景${n}`, positive: '', negative: '', count: 1, with_male: false })

function SceneCard({ id, i, sc, open, onToggle, onChange, onDuplicate, onDelete }: { id: string; i: number; sc: Scene; open: boolean; onToggle: () => void; onChange: (p: Partial<Scene>) => void; onDuplicate: () => void; onDelete: () => void }) {
  const s = useSortableItem(id)
  return (
    <div ref={s.setNodeRef} style={s.style} className={cn('rounded-xl bg-card ring-1 ring-tint/[0.08]', open && 'ring-tint/[0.16]', s.isDragging && 'shadow-2xl shadow-tint/15')}>
      <div className="flex items-center gap-3 px-3 py-2.5">
        <button type="button" {...s.attributes} {...s.listeners} className="cursor-grab text-muted-foreground/50 hover:text-muted-foreground" aria-label="拖动排序">
          <GripVertical className="size-4" />
        </button>
        <span className="grid size-6 shrink-0 place-items-center rounded-md bg-tint/[0.06] text-[11px] font-semibold text-muted-foreground tabular-nums">{i + 1}</span>
        <input
          value={sc.name}
          onChange={(e) => onChange({ name: e.target.value })}
          className="h-8 min-w-0 flex-1 rounded-md bg-transparent px-2 text-[13.5px] font-medium outline-none hover:bg-tint/[0.04] focus:bg-tint/[0.06]"
        />
        <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground" title="勾选后该场景会加入任务中选择的男性基础 Prompt">
          <Switch checked={sc.with_male} onCheckedChange={(v) => onChange({ with_male: v })} /> 男性
        </label>
        <NumberStepper value={Number(sc.count) || 0} min={0} onChange={(v) => onChange({ count: v })} />
        <Button variant="ghost" size="icon-sm" className="text-muted-foreground" onClick={onDuplicate} aria-label="复制场景">
          <Copy />
        </Button>
        <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive" onClick={onDelete} aria-label="删除场景">
          <Trash2 />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={onToggle} aria-label="展开">
          {open ? <ChevronDown /> : <ChevronRight />}
        </Button>
      </div>
      {!open && <div className="truncate px-[76px] pb-2.5 font-mono text-[11px] text-muted-foreground" onClick={onToggle}>{sc.positive || '（点击展开填写场景 Prompt）'}</div>}
      {open && (
        <div className="space-y-2 px-3 pb-3 pl-[76px]">
          <PromptField value={sc.positive} onChange={(v) => onChange({ positive: v })} placeholder={`场景正面 Prompt，会与角色、服装等组合；可用占位符 ${PLACEHOLDER_HELP}`} minRows={3} />
          <PromptField value={sc.negative} onChange={(v) => onChange({ negative: v })} placeholder="场景负面 Prompt（可留空）" minRows={1} />
        </div>
      )}
    </div>
  )
}

function StoryDetail({ st, onDeleted }: { st: Story; onDeleted: () => void }) {
  const lib = useLib((s) => s.lib)
  const genres = useMemo(() => [...new Set((lib?.stories ?? []).map((s) => s.genre).filter(Boolean))].sort(), [lib])
  const { draft, patch, flush } = useDraft<Story & { keys: string[] }>(
    { ...st, scenes: st.scenes ?? [], keys: (st.scenes ?? []).map(() => Math.random().toString(36).slice(2)) },
    st.id,
    async (v) => {
      await call(api['stories.save']({ id: v.id, _revision: v._revision, name: v.name, genre: v.genre.trim(), note: v.note, scenes: v.scenes }))
      await reloadLib()
    },
  )
  const [open, setOpen] = useState<string | null>(null)
  if (!draft) return null
  const scenes = draft.scenes
  const keys = draft.keys
  const setScenes = (sc: Scene[], k: string[]) => patch({ scenes: sc, keys: k })
  const total = scenes.reduce((a, s) => a + (Number(s.count) || 0), 0)
  const newKey = () => Math.random().toString(36).slice(2)
  return (
    <div className="flex h-full max-w-[1080px] flex-col">
      <div className="flex items-center gap-3 px-6 pt-5 pb-4">
        <div className="min-w-0 flex-1">
          <input value={draft.name} onChange={(e) => patch({ name: e.target.value })} className="w-full rounded-md bg-transparent text-[16px] font-semibold outline-none hover:bg-tint/[0.03] focus:bg-tint/[0.05]" />
          <div className="text-xs text-muted-foreground">
            {scenes.length} 个场景 · 共 {total} 张 · 按顺序生成，先于姿态序列
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={async () => {
            flush()
            const r = await call(api['stories.duplicate'](st.id))
            if (r) {
              await reloadLib()
              toast.success('已复制剧情')
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
            const used = await api.references('story_id', st.id)
            if (!(await confirm({ title: `删除剧情「${draft.name}」？`, description: used.length ? `以下套图任务正在使用它：${used.join('、')}` : undefined, confirmText: '删除', destructive: true }))) return
            await call(api['stories.remove'](st.id))
            await reloadLib()
            onDeleted()
          }}
        >
          <Trash2 /> 删除
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
        <div className="mb-5 grid max-w-3xl grid-cols-2 gap-3">
          <div>
            <FieldLabel>剧情类型</FieldLabel>
            <TextInput value={draft.genre} onChange={(v) => patch({ genre: v })} placeholder="例如 纯爱、NTR（输入新名称即可创建）" />
            <div className="mt-2 flex flex-wrap gap-1">
              {genres.map((g) => (
                <Chip key={g} active={draft.genre === g} onClick={() => patch({ genre: g })} className="h-6 text-[11px]">
                  {g}
                </Chip>
              ))}
            </div>
          </div>
          <div>
            <FieldLabel>备注</FieldLabel>
            <TextInput value={draft.note} onChange={(v) => patch({ note: v })} placeholder="可选" />
          </div>
        </div>
        <FieldLabel hint="拖动调整顺序，右侧设置每个场景的张数">场景</FieldLabel>
        <div className="space-y-2">
          <SortableArea items={scenes} getId={(_, i) => keys[i]} onReorder={(from, to, next) => {
            const k = [...keys]
            k.splice(to, 0, k.splice(from, 1)[0])
            setScenes(next, k)
          }}>
            {scenes.map((sc, i) => (
              <SceneCard
                key={keys[i]}
                id={keys[i]}
                i={i}
                sc={sc}
                open={open === keys[i]}
                onToggle={() => setOpen(open === keys[i] ? null : keys[i])}
                onChange={(p) => setScenes(scenes.map((x, j) => (j === i ? { ...x, ...p } : x)), keys)}
                onDuplicate={() => setScenes([...scenes.slice(0, i + 1), { ...sc }, ...scenes.slice(i + 1)], [...keys.slice(0, i + 1), newKey(), ...keys.slice(i + 1)])}
                onDelete={() => setScenes(scenes.filter((_, j) => j !== i), keys.filter((_, j) => j !== i))}
              />
            ))}
          </SortableArea>
          <button
            type="button"
            onClick={() => {
              const k = newKey()
              setScenes([...scenes, newScene(scenes.length + 1)], [...keys, k])
              setOpen(k)
            }}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-tint/[0.16] py-3 text-xs text-muted-foreground hover:border-primary/40 hover:text-primary"
          >
            <Plus className="size-3.5" /> 添加场景
          </button>
        </div>
      </div>
    </div>
  )
}

export default function StoriesPage() {
  const lib = useLib((s) => s.lib)
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<number | null>(lib?.stories[0]?.id ?? null)
  const stories = (lib?.stories ?? []).filter((s) => !q || matches(s as never, q))
  const groups = useMemo(() => {
    const m = new Map<string, Story[]>()
    for (const s of stories) m.set(s.genre || '未分类', [...(m.get(s.genre || '未分类') ?? []), s])
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [stories])
  const cur = lib?.stories.find((s) => s.id === sel)
  return (
    <div className="flex h-full">
      <div className="flex w-[260px] shrink-0 flex-col border-r border-tint/[0.08]">
        <div className="flex items-center justify-between px-4 pt-5 pb-3">
          <h1 className="text-[15px] font-semibold">剧情库</h1>
          <Button
            size="sm"
            onClick={async () => {
              const r = await call(api['stories.save']({ name: '新剧情', genre: cur?.genre ?? '', scenes: [newScene(1)] }))
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
          <SearchBox value={q} onChange={setQ} placeholder="搜索剧情…" />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {groups.map(([g, list]) => (
            <div key={g} className="mb-3">
              <div className="px-2 pb-1 text-[11px] text-muted-foreground">{g}</div>
              {list.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setSel(s.id)}
                  data-active={sel === s.id || undefined}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-tint/[0.04] data-[active]:bg-tint/[0.07]"
                >
                  <BookOpen className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate text-[13px]">{s.name || '（未命名）'}</span>
                  <span className="ml-auto text-[11px] text-muted-foreground">{(s.scenes ?? []).length}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="min-w-0 flex-1">
        {cur ? (
          <StoryDetail key={cur.id} st={cur} onDeleted={() => setSel(null)} />
        ) : (
          <EmptyState icon={<BookOpen />} title={lib?.stories.length ? '选择一个剧情' : '还没有剧情模板'} description="每个剧情模板包含若干按顺序生成的场景，由你手工编写；软件不会自动编故事。" />
        )}
      </div>
    </div>
  )
}
