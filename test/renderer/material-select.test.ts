// 素材选择器的选择逻辑：300 个素材时按名称搜索、多选、搜索切换后已选内容保留、取消单个已选项。

import { describe, expect, it } from 'vitest'
import { filterMaterials, selectedOptions, toggleSelection, type MaterialOption } from '../../src/renderer/src/lib/material-select'

const items: MaterialOption[] = Array.from({ length: 300 }, (_, i) => ({ id: i + 1, name: `行为${i + 1}`, positive: `act_${i + 1}` }))

describe('素材选择', () => {
  it('按名称搜索（不区分大小写、多个词都要命中），不搜索 Prompt', () => {
    expect(filterMaterials(items, '').length).toBe(300)
    expect(filterMaterials(items, '行为12').map((x) => x.name)).toEqual(['行为12', ...Array.from({ length: 10 }, (_, i) => `行为12${i}`)])
    expect(filterMaterials(items, 'act_5')).toEqual([])
    expect(filterMaterials([{ id: 1, name: 'Hug Tight' }], 'hug  TIGHT').length).toBe(1)
  })

  it('多选：按点选顺序保存；搜索条件变化不影响已选；可取消单个；单选替换', () => {
    let sel: number[] = [7]
    for (const t of filterMaterials(items, '行为12').slice(0, 2)) sel = toggleSelection(sel, t.id, true)
    expect(sel).toEqual([7, 12, 120])
    // 切换搜索后继续选择，之前的选择仍在
    const other = filterMaterials(items, '行为250')[0]
    sel = toggleSelection(sel, other.id, true)
    expect(selectedOptions(items, sel).map((x) => x.name)).toEqual(['行为7', '行为12', '行为120', '行为250'])
    sel = toggleSelection(sel, 120, true)
    expect(sel).toEqual([7, 12, 250])
    expect(toggleSelection(sel, 5, false)).toEqual([5])
    // 已删除的素材不显示在汇总中，但不会被自动移除
    expect(selectedOptions(items, [999, 3]).map((x) => x.id)).toEqual([3])
  })
})
