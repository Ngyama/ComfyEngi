// 素材选择器的选择逻辑（与界面分开，便于测试）：按名称搜索；多选按点选顺序保存，搜索条件变化不影响已选内容。

export interface MaterialOption {
  id: number
  name: string
  positive?: string
  /** 显示优先级（只用于标记；排列由调用方按优先级排好） */
  priority?: import('@shared/types').Priority
}

/** 按名称搜索（空格分隔的多个词都要命中，不区分大小写） */
export function filterMaterials<T extends MaterialOption>(items: T[], q: string): T[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return items
  return items.filter((it) => {
    const hay = String(it.name ?? '').toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}

/** 点选：多选时切换（保留点选顺序），单选时替换 */
export function toggleSelection(selected: number[], id: number, multi: boolean): number[] {
  if (!multi) return [id]
  return selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]
}

/** 已选内容中仍存在的素材（被删除的素材不显示，但也不会被静默移除，直到用户确认） */
export function selectedOptions<T extends MaterialOption>(items: T[], selected: number[]): T[] {
  const byId = new Map(items.map((it) => [it.id, it]))
  return selected.map((id) => byId.get(id)).filter((x): x is T => !!x)
}
