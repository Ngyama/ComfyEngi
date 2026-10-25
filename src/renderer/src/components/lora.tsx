// LoRA Manager 资源的共享界面：资源列表（缓存）与可搜索的 LoRA 选择器。角色库与套图任务的 LoRA 配置共用。

import { useEffect, useMemo, useState } from 'react'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { api } from '@/lib/api'
import { LoraThumb, loraTitle } from '@/pages/LorasPage'
import type { LoraResource } from '@shared/types'

// ---------------------------------------------------------------- LoRA 资源（复用 LoRA Manager 的数据接口）

let resourceCache: LoraResource[] | null = null
export function useLoraResources() {
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
export const folderOf = (r: LoraResource) => r.folder || r.root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''

/** 可搜索的 LoRA 选择器：同时匹配本地文件名与 metadata 中的模型名称 */
export function LoraPicker({ resources, onPick, children }: { resources: LoraResource[]; onPick: (r: LoraResource) => void; children: React.ReactNode }) {
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
                {r.sidecar?.baseModel && <span className="shrink-0 rounded bg-tint/[0.06] px-1.5 py-0.5 text-[10px] text-muted-foreground">{r.sidecar.baseModel}</span>}
              </CommandItem>
            ))}
            {list.length > shown.length && <div className="px-3 py-2 text-center text-[11px] text-muted-foreground">还有 {list.length - shown.length} 个结果，请输入更多关键词</div>}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

