// 动作序列预设（单个动作）与套图模板（一组连续的动作）：从当前任务保存，在任何任务中插入或新建任务。
// 预设只保存素材引用与动作设置；导入时服装槽位映射到当前角色的服装；引用的素材修改或删除后给出提示（不阻止导入，不自动替换）。

import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, Copy, Info, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { EmptyState, FieldLabel, SearchBox, TextInput } from '@/components/common'
import { api, call } from '@/lib/api'
import { confirm, useLib, usePlan } from '@/lib/stores'
import { cn } from '@/lib/utils'
import { defaultSlotMap, itemsFromPreset, itemSummary, presetFromItems, presetMessages, presetStatus, PRESET_KIND_LABEL, type InsertMode } from '@shared/presets'
import type { Preset, PresetKind, TaskItem } from '@shared/types'

const field = 'h-8 rounded-lg bg-tint/[0.045] px-2 text-[12.5px] ring-1 ring-tint/[0.112] outline-none focus:ring-primary/50'

/** 保存预设：kind 为 action 时保存第 from 个动作；为 set 时可以调整范围（第 from～to 个，默认全部） */
export function SavePresetDialog({ open, onOpenChange, kind, from, to, defaultName }: { open: boolean; onOpenChange: (o: boolean) => void; kind: PresetKind; from: number; to: number; defaultName?: string }) {
  const lib = useLib((s) => s.lib)
  const task = usePlan((s) => s.task)
  const n = task?.data.items.length ?? 0
  const [name, setName] = useState('')
  const [a, setA] = useState(1)
  const [b, setB] = useState(1)
  useEffect(() => {
    if (!open) return
    setName(defaultName || (kind === 'set' ? `${task?.name ?? ''} 套图模板` : '动作预设'))
    setA(from + 1)
    setB(to + 1)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!task || !lib) return null
  const lo = Math.max(1, Math.min(a, b, n))
  const hi = Math.min(n, Math.max(a, b))
  const items = task.data.items.slice(lo - 1, hi)
  const save = async () => {
    if (!items.length) return
    const char = lib.characters.find((c) => c.id === task.data.character_id)
    const data = presetFromItems(items, { templates: lib.templates, outfits: lib.outfits }, { task: task.name, character: char?.name, from: lo, to: hi })
    const r = await call(api['presets.save']({ kind, name: name.trim() || PRESET_KIND_LABEL[kind], data }))
    if (!r) return
    toast.success(`已保存${PRESET_KIND_LABEL[kind]}「${name.trim() || PRESET_KIND_LABEL[kind]}」`, { description: `${items.length} 个动作 · ${data.slots.length} 个服装槽位` })
    onOpenChange(false)
  }
  const T = (id: number) => lib.templates.find((t) => t.id === id)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="save-preset-dialog">
        <DialogHeader>
          <DialogTitle>保存为{PRESET_KIND_LABEL[kind]}</DialogTitle>
          <DialogDescription>只保存动作卡、姿态模板选择、表情、行为、镜头、场景、张数等引用和设置，不保存展开后的 Prompt；服装保存为槽位，导入时再选择对应角色的服装。手改的单张 Prompt 不保存。</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <FieldLabel>名称</FieldLabel>
            <TextInput value={name} onChange={setName} autoFocus />
          </div>
          {kind === 'set' && (
            <div>
              <FieldLabel hint="保存一段连续的动作，顺序不变">范围</FieldLabel>
              <div className="flex items-center gap-2 text-[12.5px]">
                第
                <input type="number" min={1} max={n} value={a} onChange={(e) => setA(Number(e.target.value) || 1)} className={cn(field, 'w-16')} aria-label="起始动作" data-testid="preset-from" />
                ～
                <input type="number" min={1} max={n} value={b} onChange={(e) => setB(Number(e.target.value) || 1)} className={cn(field, 'w-16')} aria-label="结束动作" data-testid="preset-to" />
                个动作（共 {n} 个）
                <Button size="xs" variant="ghost" onClick={() => (setA(1), setB(n))}>
                  全部
                </Button>
              </div>
            </div>
          )}
          <div className="max-h-48 space-y-0.5 overflow-y-auto rounded-lg bg-tint/[0.03] p-2 text-[12px]" data-testid="preset-preview">
            {items.map((it, i) => (
              <div key={i} className="truncate">
                <span className="mr-1.5 text-muted-foreground tabular-nums">{lo + i}.</span>
                {itemSummary(it, T, lib.outfits.find((o) => o.id === it.outfit_id)?.name).join(' | ')}
              </div>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={!items.length} onClick={() => void save()} data-testid="preset-save">
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export type ImportMode = InsertMode | 'new'

/**
 * 预设管理与导入：按类型浏览、搜索、重命名、复制、删除；选择一个后映射服装槽位，追加、插入、替换全部（需确认）或新建任务。
 * 导入的动作是独立副本：之后修改任务不影响预设，修改预设也不影响已导入的任务
 */
export function PresetDialog({ open, onOpenChange, insertAfter, onImport, initialKind = 'action' }: { open: boolean; onOpenChange: (o: boolean) => void; insertAfter: number | null; onImport: (items: TaskItem[], mode: ImportMode, preset: Preset) => void; initialKind?: PresetKind }) {
  const lib = useLib((s) => s.lib)
  const task = usePlan((s) => s.task)
  const [list, setList] = useState<Preset[]>([])
  const [kind, setKind] = useState<PresetKind>(initialKind)
  const [q, setQ] = useState('')
  const [cur, setCur] = useState<number | null>(null)
  const [slots, setSlots] = useState<Record<number, number | null>>({})
  const [mode, setMode] = useState<ImportMode>('append')
  const [renaming, setRenaming] = useState<string | null>(null)
  const reload = async () => setList((await call(api['presets.list']())) ?? [])
  useEffect(() => {
    if (!open) return
    setKind(initialKind)
    setQ('')
    setCur(null)
    setRenaming(null)
    setMode(insertAfter !== null ? 'after' : 'append')
    void reload()
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  const T = (id: number) => lib?.templates.find((t) => t.id === id)
  const shown = list.filter((p) => p.kind === kind && (!words.length || words.every((w) => `${p.name}\n${p.data.items.map((it) => itemSummary(it, T).join(' ')).join('\n')}`.toLowerCase().includes(w))))
  const preset = shown.find((p) => p.id === cur) ?? shown[0] ?? null
  const status = useMemo(() => (preset && lib ? presetStatus(preset.data, lib.templates) : null), [preset, lib])
  const charId = task?.data.character_id ?? null
  const char2Id = task?.data.second_character_id ?? null
  useEffect(() => {
    if (preset && lib) setSlots(defaultSlotMap(preset.data, lib.outfits, charId, char2Id))
    setRenaming(null)
  }, [preset?.id, lib]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!lib || !task) return null
  const outfitsOf = (second?: boolean) => lib.outfits.filter((o) => o.character_id === (second ? char2Id : charId))
  const outfitName = (id: number | null | undefined) => (id != null ? lib.outfits.find((o) => o.id === id)?.name : undefined)

  const rename = async (p: Preset, name: string) => {
    setRenaming(null)
    if (!name.trim() || name === p.name) return
    await call(api['presets.save']({ id: p.id, name: name.trim() }))
    await reload()
  }
  const duplicate = async (p: Preset) => {
    const r = await call(api['presets.duplicate'](p.id))
    await reload()
    if (r?.id) setCur(r.id)
  }
  const remove = async (p: Preset) => {
    if (!(await confirm({ title: `删除${PRESET_KIND_LABEL[p.kind]}「${p.name}」？`, description: '已经导入到任务中的动作不受影响。', confirmText: '删除', destructive: true }))) return
    await call(api['presets.remove'](p.id))
    setCur(null)
    await reload()
  }
  const run = async () => {
    if (!preset) return
    if (mode === 'replace' && task.data.items.length && !(await confirm({ title: `替换当前任务的全部 ${task.data.items.length} 个动作？`, description: `当前任务「${task.name}」的动作序列会被「${preset.name}」中的 ${preset.data.items.length} 个动作替换（剧情、角色、LoRA 等任务设置不变）。`, confirmText: '替换', destructive: true }))) return
    onImport(itemsFromPreset(preset.data, slots), mode, preset)
    onOpenChange(false)
  }
  const modes: [ImportMode, string][] = [
    ['append', '追加到序列末尾'],
    ...(insertAfter !== null ? ([['after', `插入到第 ${insertAfter + 1} 个动作之后`]] as [ImportMode, string][]) : []),
    ['new', '新建任务（沿用当前角色）'],
    ['replace', '替换当前任务的全部动作'],
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[84vh] flex-col gap-3 sm:max-w-4xl" data-testid="preset-dialog">
        <DialogHeader>
          <DialogTitle>动作预设 / 套图模板</DialogTitle>
          <DialogDescription>导入的动作是独立副本：之后修改任务不会改动预设。需要保存修改时，在任务中重新「保存为预设」。</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-3">
          <div className="flex rounded-xl bg-tint/[0.04] p-1">
            {(['action', 'set'] as const).map((k) => (
              <button key={k} type="button" onClick={() => (setKind(k), setCur(null))} data-active={kind === k || undefined} data-testid={`preset-tab-${k}`} className="h-7 rounded-lg px-3 text-[12.5px] text-muted-foreground data-[active]:bg-tint/[0.09] data-[active]:text-foreground">
                {PRESET_KIND_LABEL[k]} {list.filter((p) => p.kind === k).length || ''}
              </button>
            ))}
          </div>
          <SearchBox value={q} onChange={setQ} placeholder="搜索名称、动作卡、表情…" className="flex-1" />
        </div>
        <div className="flex min-h-0 flex-1 gap-3">
          <div className="w-64 shrink-0 space-y-1 overflow-y-auto p-0.5 pr-1">
            {shown.map((p) => (
              <button key={p.id} type="button" onClick={() => setCur(p.id)} data-testid="preset-row" className={cn('w-full rounded-xl bg-card p-2.5 text-left ring-1 ring-tint/[0.08] hover:bg-accent', preset?.id === p.id && 'bg-primary/10 ring-primary/50')}>
                <div className="truncate text-[13px] font-medium">{p.name || '（未命名）'}</div>
                <div className="mt-0.5 truncate text-[10.5px] text-muted-foreground">
                  {p.data.items.length} 个动作{p.data.slots.length ? ` · ${p.data.slots.length} 个服装槽位` : ''}
                  {p.data.source?.task ? ` · 来自「${p.data.source.task}」` : ''}
                </div>
              </button>
            ))}
            {!shown.length && (
              <EmptyState
                title={q ? '没有匹配的预设' : `还没有${PRESET_KIND_LABEL[kind]}`}
                description={kind === 'action' ? '在动作详情中点击「保存为预设」。' : '在动作序列上方点击「保存套图模板」，可以保存全部或一段连续的动作。'}
              />
            )}
          </div>
          <div className="min-w-0 flex-1 space-y-3 overflow-y-auto rounded-xl bg-tint/[0.02] p-3 ring-1 ring-tint/[0.07]" data-testid="preset-detail">
            {preset ? (
              <>
                <div className="flex items-center gap-2">
                  {renaming !== null ? (
                    <input autoFocus value={renaming} onChange={(e) => setRenaming(e.target.value)} onBlur={() => void rename(preset, renaming)} onKeyDown={(e) => (e.key === 'Enter' ? (e.target as HTMLInputElement).blur() : e.key === 'Escape' && setRenaming(null))} className={cn(field, 'min-w-0 flex-1')} data-testid="preset-name" />
                  ) : (
                    <button type="button" className="min-w-0 flex-1 truncate text-left text-[14px] font-semibold hover:underline" title="点击重命名" onClick={() => setRenaming(preset.name)} data-testid="preset-title">
                      {preset.name || '（未命名）'}
                    </button>
                  )}
                  <Button size="xs" variant="ghost" onClick={() => void duplicate(preset)} data-testid="preset-duplicate">
                    <Copy /> 复制
                  </Button>
                  <Button size="xs" variant="ghost" className="hover:text-destructive" onClick={() => void remove(preset)} data-testid="preset-remove">
                    <Trash2 /> 删除
                  </Button>
                </div>
                {status &&
                  presetMessages(preset.kind, status).map((m, i) => (
                    <div key={i} className={cn('flex items-start gap-2 rounded-lg px-2.5 py-2 text-[11.5px]', m.level === 'error' ? 'bg-destructive/10 text-destructive' : 'bg-sky-500/10 text-sky-700')} data-testid={m.level === 'error' ? 'preset-missing' : 'preset-updated'}>
                      {m.level === 'error' ? <AlertCircle className="mt-0.5 size-3.5 shrink-0" /> : <Info className="mt-0.5 size-3.5 shrink-0" />}
                      <span>{m.text}</span>
                    </div>
                  ))}
                <div className="space-y-0.5 text-[12px]" data-testid="preset-items">
                  {preset.data.items.map((it, i) => {
                    const slot = preset.data.slots.find((s) => s.key === it.outfit_slot && !s.second)
                    return (
                      <div key={i} className="truncate">
                        <span className="mr-1.5 text-muted-foreground tabular-nums">{i + 1}.</span>
                        {itemSummary(it, T, slot ? `槽位${slot.key}（${outfitName(slots[slot.key]) ?? '不指定'}）` : null).join(' | ')}
                      </div>
                    )
                  })}
                </div>
                {preset.data.slots.length > 0 && (
                  <div className="space-y-1.5" data-testid="preset-slots">
                    <FieldLabel hint="每个槽位选择一次，应用到所有使用该槽位的动作">服装槽位</FieldLabel>
                    {preset.data.slots.map((s) => (
                      <div key={s.key} className="flex items-center gap-2 text-[12px]">
                        <span className="w-44 shrink-0 truncate text-muted-foreground" title={`保存时：${s.name}`}>
                          槽位{s.key}{s.second ? '（第二角色）' : ''}：保存时「{s.name}」
                        </span>
                        <select value={slots[s.key] ?? ''} onChange={(e) => setSlots((m) => ({ ...m, [s.key]: e.target.value ? Number(e.target.value) : null }))} className={cn(field, 'min-w-0 flex-1')} data-testid="preset-slot">
                          <option value="">不指定</option>
                          {outfitsOf(s.second).map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    ))}
                    {preset.data.slots.some((s) => (s.second ? !char2Id : !charId)) && <div className="text-[11px] text-muted-foreground">当前任务还没有选择对应的角色，这些槽位暂时不指定服装。</div>}
                  </div>
                )}
                <div className="space-y-1">
                  <FieldLabel>导入方式</FieldLabel>
                  {modes.map(([m, label]) => (
                    <label key={m} className={cn('flex cursor-pointer items-center gap-2 text-[12.5px]', m === 'replace' && 'text-destructive')}>
                      <input type="radio" name="preset-mode" checked={mode === m} onChange={() => setMode(m)} data-testid={`preset-mode-${m}`} />
                      {label}
                    </label>
                  ))}
                </div>
              </>
            ) : (
              <div className="pt-10 text-center text-xs text-muted-foreground">选择左侧的预设查看内容</div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
          <Button disabled={!preset} onClick={() => void run()} data-testid="preset-import">
            导入 {preset ? `${preset.data.items.length} 个动作` : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
