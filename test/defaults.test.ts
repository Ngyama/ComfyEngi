// 设置 → 生成默认值：只用于新建任务，不改变已有任务和已入队快照。

import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultItemCount, newTaskWithDefaults } from '@shared/planner'
import { DEFAULT_SETTINGS, type MappingEntry } from '@shared/types'
import { enqueueTask, planForTask } from '../src/main/plan'
import { createVault, openVault } from '../src/main/vault'
import { Lib, SAMPLE_MAPPING, SAMPLE_WORKFLOW, tempDir } from './helpers'

describe('新任务默认值', () => {
  const base = { ...DEFAULT_SETTINGS }

  it('未设置时保持原有行为：沿用当前任务，否则第一个全局 Prompt；不写输出配置', () => {
    const d = newTaskWithDefaults(base, { globalIds: [5, 6], maleBaseId: 9 })
    expect(d.global_id).toBe(5)
    expect(d.male_base_id).toBe(9)
    expect(d.output).toBeUndefined()
    const inherited = newTaskWithDefaults(base, { globalIds: [5, 6], inherit: { ...d, global_id: 6, character_id: 3, workflow_id: 2 } })
    expect([inherited.global_id, inherited.character_id, inherited.workflow_id]).toEqual([6, 3, 2])
  })

  it('默认全局 Prompt 优先；模板已删除时退回原有行为', () => {
    const s = { ...base, default_global_id: 6 }
    expect(newTaskWithDefaults(s, { globalIds: [5, 6], inherit: { ...newTaskWithDefaults(base, { globalIds: [] }), global_id: 5 } }).global_id).toBe(6)
    expect(newTaskWithDefaults({ ...base, default_global_id: 99 }, { globalIds: [5, 6] }).global_id).toBe(5)
  })

  it('默认输出目录与文件名前缀写入新任务；默认张数有边界', () => {
    const d = newTaskWithDefaults({ ...base, default_output_dir: ' D:\\out ', default_output_prefix: '%date:yyyy-MM-dd%/image' }, { globalIds: [] })
    expect(d.output).toEqual({ dir: 'D:\\out', prefix: '%date:yyyy-MM-dd%/image' })
    expect(newTaskWithDefaults({ ...base, default_output_prefix: 'x/img' }, { globalIds: [] }).output).toEqual({ prefix: 'x/img' })
    expect(defaultItemCount({ default_item_count: 4 })).toBe(4)
    expect(defaultItemCount({ default_item_count: 0 })).toBe(10)
    expect(defaultItemCount(null)).toBe(10)
  })

  it('修改默认值不影响已有任务和已入队快照', () => {
    const root = tempDir()
    createVault(root)
    const s = openVault(root)
    try {
      const lib = new Lib(s)
      lib.addWorkflow(SAMPLE_MAPPING as MappingEntry[], SAMPLE_WORKFLOW)
      const task = lib.makeTask([lib.item('睡觉', null, [], 1)], '已有任务')
      const { runId } = enqueueTask(s, task)
      const before = s.listUnits(runId!)
      s.setSetting('default_output_dir', tempDir())
      s.setSetting('default_output_prefix', 'changed/img')
      s.setSetting('default_item_count', 3)
      // 已有任务的计划不变（仍是工作流映射模板 + 工作区 output/）
      const plan = planForTask(s, task)
      expect(plan.units[0].meta.output_dir).toBe(join(root, 'output'))
      expect(plan.units[0].inputs!.find((x) => x.node === '9')!.value).toBe('T/0001')
      expect(plan.units.length).toBe(1)
      expect(s.listUnits(runId!)).toEqual(before)
    } finally {
      s.close()
    }
  })
})
