// 界面状态（zustand）。业务数据由主进程持有，这里只缓存和协调界面。

import { create } from 'zustand'
import { normalizeTaskData, PlanLibrary } from '@shared/planner'
import type { Library, RunnerStatus, Task, TaskData, Template, TemplateKind } from '@shared/types'
import { api } from './api'

export type Page = 'plan' | 'queue' | 'history' | 'library' | 'characters' | 'stories' | 'settings'

// ---------------------------------------------------------------- 导航
interface NavState {
  page: Page
  go(p: Page): void
}
export const useNav = create<NavState>((set) => ({ page: 'plan', go: (page) => set({ page }) }))

// ---------------------------------------------------------------- 素材库缓存
interface LibState {
  lib: Library | null
  planLib: PlanLibrary | null
  reload(): Promise<void>
}
export const useLib = create<LibState>((set) => ({
  lib: null,
  planLib: null,
  reload: async () => {
    const lib = await api['library.load']()
    set({ lib, planLib: new PlanLibrary(lib.templates, lib.characters, lib.outfits, lib.stories) })
  },
}))

export const reloadLib = () => useLib.getState().reload()

export function templatesOf(lib: Library | null, kind: TemplateKind): Template[] {
  return (lib?.templates ?? []).filter((t) => t.kind === kind)
}

// ---------------------------------------------------------------- 当前套图任务（跨页面保留编辑状态）
interface PlanState {
  task: Task | null
  selected: number | null
  saving: boolean
  load(id: number | null): Promise<void>
  update(fn: (d: TaskData) => void): void
  rename(name: string): Promise<void>
  select(i: number | null): void
  flush(): Promise<void>
}

let saveTimer: ReturnType<typeof setTimeout> | null = null

export const usePlan = create<PlanState>((set, get) => ({
  task: null,
  selected: null,
  saving: false,
  load: async (id) => {
    await get().flush()
    let t = id ? await api['tasks.get'](id) : null
    if (!t) {
      const lib = useLib.getState().lib
      const first = lib?.tasks[0]
      t = first ? await api['tasks.get'](first.id) : null
    }
    if (t) {
      t = { ...t, data: normalizeTaskData(t.data) }
      void api['settings.set']('last_task_id', t.id)
    }
    set({ task: t, selected: null })
  },
  update: (fn) => {
    const t = get().task
    if (!t) return
    const data = structuredClone(t.data)
    fn(data)
    set({ task: { ...t, data }, saving: true })
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => void get().flush(), 350)
  },
  rename: async (name) => {
    const t = get().task
    if (!t) return
    await api['tasks.save']({ id: t.id, name })
    set({ task: { ...t, name } })
    await reloadLib()
  },
  select: (i) => set({ selected: i }),
  flush: async () => {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    const t = get().task
    if (t && get().saving) {
      await api['tasks.save']({ id: t.id, data: t.data })
      set({ saving: false })
    }
  },
}))

// ---------------------------------------------------------------- 执行器状态（由主进程事件驱动）
interface RunnerStore {
  status: RunnerStatus
  logs: string[]
  tick: number // 每当单元状态变化时递增，供页面刷新
  init(): Promise<void>
}

const IDLE: RunnerStatus = { state: 'idle', alive: false, message: '', current: null, progress: { value: 0, max: 0 }, sessionRuns: [] }

export const useRunner = create<RunnerStore>((set, get) => ({
  status: IDLE,
  logs: [],
  tick: 0,
  init: async () => {
    const [status, logs] = await Promise.all([api['runner.status'](), api['runner.logs']()])
    set({ status, logs })
    api.onRunnerEvent((e) => {
      if (e.kind === 'status') set({ status: e.status, tick: get().tick + 1 })
      else if (e.kind === 'log') set({ logs: [...get().logs.slice(-999), e.text] })
      else if (e.kind === 'unit') set({ tick: get().tick + 1 })
    })
  },
}))

// ---------------------------------------------------------------- 确认对话框
interface ConfirmReq {
  title: string
  description?: string
  confirmText?: string
  destructive?: boolean
  resolve(v: boolean): void
}
export const useConfirm = create<{ req: ConfirmReq | null; set(r: ConfirmReq | null): void }>((set) => ({
  req: null,
  set: (req) => set({ req }),
}))

export function confirm(opts: Omit<ConfirmReq, 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => useConfirm.getState().set({ ...opts, resolve }))
}
