// 套图任务自动保存（渲染进程 usePlan）：连续快速修改、保存请求重叠、切换任务时不丢数据、旧数据不覆盖新数据。
// 用可控的模拟 API：每次 tasks.save 都挂起，直到测试手动放行，以复现请求重叠。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Task, TaskData } from '@shared/types'

interface Pending { rec: { id: number; name?: string; data?: TaskData }; resolve(): void; reject(e: Error): void }
const db = new Map<number, Task>()
const pending: Pending[] = []
let autoResolve = false

vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }))
vi.mock('../../src/renderer/src/lib/api', () => ({
  api: {
    'tasks.get': async (id: number) => structuredClone(db.get(id) ?? null),
    'tasks.save': (rec: Pending['rec']) =>
      new Promise<{ id: number }>((resolve, reject) => {
        const apply = () => {
          const t = db.get(rec.id)!
          db.set(rec.id, { ...t, ...(rec.name !== undefined ? { name: rec.name } : {}), ...(rec.data ? { data: structuredClone(rec.data) } : {}) })
          resolve({ id: rec.id })
        }
        if (autoResolve) return void setTimeout(apply, 1)
        pending.push({ rec, resolve: apply, reject })
      }),
    'settings.set': async () => undefined,
    'library.load': async () => ({ templates: [], characters: [], outfits: [], stories: [], tasks: [...db.values()], settings: {} }),
  },
}))

const { usePlan } = await import('../../src/renderer/src/lib/stores')
const { newTaskData } = await import('@shared/planner')

const tick = () => new Promise((r) => setTimeout(r, 0))
const release = async () => {
  // 按发出顺序放行一个保存请求
  pending.shift()!.resolve()
  await tick()
}
const seedOf = (id: number) => db.get(id)!.data.seed_base

beforeEach(async () => {
  vi.useRealTimers()
  autoResolve = true
  await usePlan.getState().flush().catch(() => {})
  pending.length = 0
  autoResolve = false
  db.clear()
  for (const id of [1, 2]) db.set(id, { id, name: `T${id}`, data: { ...newTaskData(), seed_base: 0 }, sort: id, created_at: 0, updated_at: 0 } as unknown as Task)
  autoResolve = true
  await usePlan.getState().load(1)
  autoResolve = false
})

describe('任务自动保存', () => {
  it('连续快速修改只保存最后的数据', async () => {
    vi.useFakeTimers()
    const { update } = usePlan.getState()
    for (let i = 1; i <= 20; i++) update((d) => void (d.seed_base = i))
    vi.advanceTimersByTime(400)
    vi.useRealTimers()
    await tick()
    expect(pending.length).toBe(1)
    expect(pending[0].rec.data!.seed_base).toBe(20)
    await release()
    expect(seedOf(1)).toBe(20)
    expect(usePlan.getState().saving).toBe(false)
  })

  it('保存进行中又修改：不会把 saving 错误清除，最新数据随后写入', async () => {
    const s = usePlan.getState()
    s.update((d) => void (d.seed_base = 1))
    const f1 = s.flush()
    await tick()
    expect(pending.length).toBe(1)
    s.update((d) => void (d.seed_base = 2)) // 第一次保存尚未完成
    await release()
    // 第一次完成后仍有未保存修改
    expect(usePlan.getState().saving).toBe(true)
    // 第一次 flush 会接着保存最新数据
    expect(pending.length).toBe(1)
    expect(pending[0].rec.data!.seed_base).toBe(2)
    await release()
    await f1
    expect(seedOf(1)).toBe(2)
    expect(usePlan.getState().saving).toBe(false)
  })

  it('保存请求不重叠：旧数据不会在新数据之后写入', async () => {
    const s = usePlan.getState()
    s.update((d) => void (d.seed_base = 1))
    const f1 = s.flush()
    await tick()
    expect(pending[0].rec.data!.seed_base).toBe(1)
    s.update((d) => void (d.seed_base = 2))
    const f2 = s.flush()
    await tick()
    expect(pending.length).toBe(1) // 第二个请求等第一个完成后才发出
    await release()
    await release()
    await Promise.all([f1, f2])
    expect(pending.length).toBe(0)
    expect(seedOf(1)).toBe(2)
  })

  it('切换任务：未保存的修改写入原任务，不写入新任务', async () => {
    autoResolve = true
    const s = usePlan.getState()
    s.update((d) => void (d.seed_base = 7))
    await s.load(2)
    expect(seedOf(1)).toBe(7)
    expect(seedOf(2)).toBe(0)
    expect(usePlan.getState().task!.id).toBe(2)
    expect(usePlan.getState().task!.data.seed_base).toBe(0)
    usePlan.getState().update((d) => void (d.seed_base = 9))
    await usePlan.getState().flush()
    expect(seedOf(1)).toBe(7)
    expect(seedOf(2)).toBe(9)
  })

  it('重命名期间的其他修改不会被旧数据覆盖', async () => {
    const s = usePlan.getState()
    const r = s.rename('新名称')
    s.update((d) => void (d.seed_base = 5))
    await release() // 放行改名请求
    autoResolve = true
    await r
    expect(usePlan.getState().task!.name).toBe('新名称')
    expect(usePlan.getState().task!.data.seed_base).toBe(5)
    await usePlan.getState().flush()
    expect(seedOf(1)).toBe(5)
    expect(db.get(1)!.name).toBe('新名称')
  })

  it('保存失败：保留未保存状态，flush 报错', async () => {
    const s = usePlan.getState()
    s.update((d) => void (d.seed_base = 3))
    const f = s.flush()
    await tick()
    pending.shift()!.reject(new Error('磁盘已满'))
    await expect(f).rejects.toThrow('磁盘已满')
    expect(usePlan.getState().saving).toBe(true)
    autoResolve = true
    await usePlan.getState().flush()
    expect(seedOf(1)).toBe(3)
    expect(usePlan.getState().saving).toBe(false)
  })
})
