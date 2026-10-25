// 界面状态（zustand）。业务数据由主进程持有，这里只缓存和协调界面。

import { create } from 'zustand'
import { normalizeTaskData, PlanLibrary } from '@shared/planner'
import type { Library, RunnerStatus, Task, TaskData, Template, TemplateKind } from '@shared/types'
import { toast } from 'sonner'
import { api } from './api'

export type Page = 'loras' | 'plan' | 'queue' | 'history' | 'library' | 'characters' | 'stories' | 'settings'

// ---------------------------------------------------------------- 导航
/** 跳转到设置页的某个位置（例如从套图任务直接打开某个工作流的节点映射） */
export interface SettingsTarget {
  section: 'workflows'
  workflowId?: number
}
interface NavState {
  page: Page
  settingsTarget: SettingsTarget | null
  go(p: Page, settingsTarget?: SettingsTarget): void
}
export const useNav = create<NavState>((set) => ({ page: 'plan', settingsTarget: null, go: (page, settingsTarget) => set({ page, settingsTarget: settingsTarget ?? null }) }))

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
// 自动保存：每次修改递增 editVersion；保存请求串行执行（不会重叠，旧数据不会晚于新数据写入），
// 只有保存期间没有新修改时才清除 saving，否则继续保存最新数据。
let editVersion = 0
let saveChain: Promise<void> = Promise.resolve()

/** 立即保存当前任务（串行）；保存失败会抛出错误，saving 保持为 true */
function saveNow(get: () => PlanState, set: (p: Partial<PlanState>) => void): Promise<void> {
  const run = async () => {
    // 循环直到没有未保存的修改：保存期间又有修改时，接着保存最新数据
    for (;;) {
      const t = get().task
      if (!t || !get().saving) return
      const v = editVersion
      await api['tasks.save']({ id: t.id, data: t.data })
      if (editVersion === v && get().task?.id === t.id) {
        set({ saving: false })
        return
      }
      if (get().task?.id !== t.id) return
    }
  }
  const p = saveChain.then(run)
  saveChain = p.catch(() => {})
  return p
}

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
    // 读取期间界面上可能又有修改（仍属于旧任务）：切换前再保存一次
    await get().flush()
    if (t) {
      t = { ...t, data: normalizeTaskData(t.data) }
      void api['settings.set']('last_task_id', t.id)
    }
    set({ task: t, selected: null, saving: false })
  },
  update: (fn) => {
    const t = get().task
    if (!t) return
    const data = structuredClone(t.data)
    fn(data)
    editVersion++
    set({ task: { ...t, data }, saving: true })
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      get().flush().catch((e) => toast.error('任务自动保存失败', { description: e instanceof Error ? e.message : String(e) }))
    }, 350)
  },
  rename: async (name) => {
    const t = get().task
    if (!t) return
    await api['tasks.save']({ id: t.id, name })
    // 只改名称：保留等待期间界面上的其他修改
    const cur = get().task
    if (cur?.id === t.id) set({ task: { ...cur, name } })
    await reloadLib()
  },
  select: (i) => set({ selected: i }),
  flush: async () => {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    await saveNow(get, set)
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
