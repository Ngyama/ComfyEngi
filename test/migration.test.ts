// 旧版（Python / PySide6）数据库兼容性：样本由旧版程序真实生成（test/fixtures/legacy-v0.db），
// 期望值由旧版程序导出（legacy-v0.expected.json），包括旧版计算出的生成计划。

import { copyFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { planForTask } from '../src/main/plan'
import { SCHEMA_VERSION, Store } from '../src/main/store'
import { tempDir } from './helpers'
import { normalizedOrder } from '@shared/prompt'
import { DEFAULT_SETTINGS } from '@shared/types'

const FIX = join(__dirname, 'fixtures')
const expected = JSON.parse(readFileSync(join(FIX, 'legacy-v0.expected.json'), 'utf8'))

function openLegacy() {
  const dir = tempDir()
  const path = join(dir, 'comfyengi.db')
  copyFileSync(join(FIX, 'legacy-v0.db'), path)
  const backupDir = join(dir, 'backups')
  return { store: new Store(path, { backupDir }), dir, path, backupDir }
}

describe('旧数据库迁移', () => {
  it('迁移前自动备份，备份内容与原库一致', () => {
    const { store, backupDir } = openLegacy()
    expect(store.openInfo.migratedFrom).toBe(0)
    expect(store.openInfo.backup).toBeTruthy()
    expect(existsSync(store.openInfo.backup!)).toBe(true)
    const b = new DatabaseSync(store.openInfo.backup!)
    expect((b.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(0)
    expect((b.prepare('SELECT COUNT(*) AS n FROM templates').get() as { n: number }).n).toBe(expected.tables.templates.length)
    b.close()
    expect(readdirSync(backupDir)).toHaveLength(1)
    expect((store.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION)
    store.close()
  })

  it('再次打开已迁移的数据库不会重复备份', () => {
    const { store, path, backupDir } = openLegacy()
    store.close()
    const s2 = new Store(path, { backupDir })
    expect(s2.openInfo.migratedFrom).toBeNull()
    expect(readdirSync(backupDir)).toHaveLength(1)
    s2.close()
  })

  it('所有角色、模板、服装、剧情、工作流、任务原样读取', () => {
    const { store } = openLegacy()
    for (const t of ['templates', 'characters', 'outfits', 'stories', 'workflows', 'tasks'] as const) {
      // v2 起素材多了适用对象与层级两个默认列（不修改原有字段）
      const exp = t === 'templates' ? expected.tables[t].map((r: object) => ({ ...r, target: 'any', parent_id: null })) : expected.tables[t]
      expect(store.list(t)).toEqual(exp)
    }
    const raw = store.list('templates').find((t) => t.name === '原样文本')!
    expect(raw.positive).toContain('<lora:foo_v2:0.75>, {red|blue} hair\nBREAK\r\n 全角，「」🌸 ')
    store.close()
  })

  it('设置、执行队列与运行记录原样读取', () => {
    const { store } = openLegacy()
    expect(store.settings()).toEqual({ lora_roots: [], lora_display_name: 'model', ...expected.settings, compose_order: DEFAULT_SETTINGS.compose_order }) // 旧版默认顺序（未自定义）升级为新默认顺序
    expect(normalizedOrder(expected.settings.compose_order)).not.toEqual(DEFAULT_SETTINGS.compose_order)
    const runs = store.listRuns(true)
    expect(runs.map((r) => [r.id, r.name, r.status, r.counts])).toEqual(expected.runs.map((r: { id: number; name: string; status: string; counts: unknown }) => [r.id, r.name, r.status, r.counts]))
    expect(store.listUnits(runs[0].id)).toEqual(expected.units)
    const flight = store.inFlightUnits()
    expect(flight.map((u) => u.prompt_id)).toEqual(['p-3'])
    expect(store.history('', 'failed')[0].error).toBe('节点 3 执行出错')
    store.close()
  })

  it('新版对旧任务计算出的生成计划与旧版完全一致（Prompt、Seed、写入节点的值）', () => {
    const { store } = openLegacy()
    for (const [tid, exp] of Object.entries(expected.plans) as [string, { errors: string[]; warnings: string[]; units: Record<string, unknown>[] }][]) {
      // 组合顺序按需求改为新的默认顺序；这里用旧版顺序计算，验证内容（各模块、Seed、写入值）与旧版完全一致
      const plan = planForTask(store, store.get('tasks', Number(tid))!, { ...store.settings(), compose_order: expected.settings.compose_order }, '20260101')
      expect(plan.errors).toEqual(exp.errors)
      expect(plan.warnings).toEqual(exp.warnings)
      expect(plan.units.length).toBe(exp.units.length)
      plan.units.forEach((u, i) => {
        const e = exp.units[i]
        expect(u.section).toBe(e.section)
        expect(u.item_index).toBe(e.item_index)
        expect(u.item_label).toBe(e.item_label)
        expect(u.positive).toBe(e.positive)
        expect(u.negative).toBe(e.negative)
        expect(u.seed).toBe(e.seed)
        expect(u.modules).toEqual(e.modules)
        expect(u.inputs).toEqual(e.inputs)
        expect(u.meta).toEqual({ ...(e.meta as Record<string, unknown>), section: (e.meta as { section: string }).section === '姿态' ? '动作' : (e.meta as { section: string }).section }) // 「姿态」更名为「动作」
      })
    }
    store.close()
  })

  it('每日自动备份只保留最近若干份', () => {
    const { store, backupDir } = openLegacy()
    expect(store.dailyBackup(backupDir, 3)).toBeTruthy()
    expect(store.dailyBackup(backupDir, 3)).toBeNull() // 同一天只备份一次
    expect(readdirSync(backupDir).filter((f) => f.endsWith('-auto.db'))).toHaveLength(1)
    store.close()
  })
})
