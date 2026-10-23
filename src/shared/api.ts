// Renderer ↔ 主进程 的 IPC 契约。Preload 只暴露这里列出的方法，主进程逐个校验参数。

import type {
  LoraResource,
  Character,
  Library,
  Message,
  Outfit,
  PlanResult,
  PlanUnit,
  Run,
  RunnerEvent,
  RunnerStatus,
  RunUnit,
  Settings,
  Story,
  Task,
  TaskData,
  Template,
  TemplateKind,
  Workflow,
} from './types'

export type SaveResult = { id: number }
export type Plan = PlanResult & { units: PlanUnit[] }

export interface Api {
  'vault.info'(): {root:string|null; errors:string[]}
  'vault.choose'(create:boolean, migrate:boolean): void
  'loras.list'(): LoraResource[]
  'loras.roots'(): string[]
  'loras.addRoot'(): { roots: string[]; errors: string[] } | null
  'loras.removeRoot'(root:string): string[]
  'loras.scan'(): string[]
  'loras.save'(row:LoraResource): void
  'loras.preview'(id:string): void
  'loras.clearPreview'(id:string): void
  'loras.image'(id:string, width?:number): string|null
  'loras.saveFrame'(id:string, jpegDataUrl:string): void
  'loras.open'(id:string): void

  'library.load'(): Library
  'settings.set'(key: keyof Settings, value: unknown): void

  'templates.save'(rec: Partial<Template> & { kind?: TemplateKind }): SaveResult
  'templates.remove'(id: number): void
  'templates.duplicate'(id: number): SaveResult
  'templates.reorder'(ids: number[]): void
  'characters.save'(rec: Partial<Character>): SaveResult
  'characters.remove'(id: number): void
  'characters.duplicate'(id: number): SaveResult
  'outfits.save'(rec: Partial<Outfit>): SaveResult
  'outfits.remove'(id: number): void
  'outfits.duplicate'(id: number): SaveResult
  'outfits.reorder'(ids: number[]): void
  'stories.save'(rec: Partial<Story>): SaveResult
  'stories.remove'(id: number): void
  'stories.duplicate'(id: number): SaveResult
  'references'(field: string, id: number): string[]

  'workflows.get'(id: number): Workflow | null
  'workflows.import'(): { id: number } | { error: string } | null
  'workflows.reimport'(id: number): { ok: true } | { error: string } | null
  'workflows.save'(rec: Partial<Workflow>): SaveResult
  'workflows.remove'(id: number): void
  'workflows.onlineCheck'(id: number): Message[]

  'tasks.get'(id: number): Task | null
  'tasks.create'(name: string, data: TaskData): SaveResult
  'tasks.save'(rec: { id: number; name?: string; data?: TaskData }): SaveResult
  'tasks.remove'(id: number): void
  'tasks.duplicate'(id: number): SaveResult

  'plan.forTask'(taskId: number): Plan
  'queue.enqueue'(taskIds: number[]): { ok: { name: string; runId: number; count: number }[]; failed: { name: string; errors: string[] }[] }
  'queue.list'(includeFinished: boolean): Run[]
  'queue.units'(runId: number): RunUnit[]
  'queue.reorder'(ids: number[]): void
  'queue.remove'(runId: number): void
  'queue.delete'(runId: number): void
  'queue.retry'(runId: number): number
  'queue.pendingSummary'(): { pending: number; inFlight: number }

  'runner.status'(): RunnerStatus
  'runner.precheck'(): { error: string | null; messages: string[] }
  'runner.start'(): RunnerStatus
  'runner.pause'(): RunnerStatus
  'runner.stop'(): RunnerStatus
  'runner.interrupt'(): RunnerStatus
  'runner.logs'(): string[]

  'history.list'(search: string, status: string, limit: number): RunUnit[]
  'history.image'(unitId: number, size: number): string | null
  'history.openImage'(unitId: number): string | null
  'history.showInFolder'(unitId: number): string | null

  'comfy.test'(url: string): { ok: true; info: string } | { ok: false; error: string }
  'app.info'(): { version: string; dataDir: string; dbPath: string; backupDir: string; migratedFrom: number | null; backup: string | null }
  'app.openDataDir'(): void
  'app.backupNow'(): string
  'app.chooseOutputDir'(): string | null
}

export type ApiMethod = keyof Api

/** Preload 暴露的方法白名单 */
export const API_METHODS: ApiMethod[] = [
  'vault.info', 'vault.choose', 'loras.list', 'loras.roots', 'loras.addRoot', 'loras.removeRoot', 'loras.scan', 'loras.save', 'loras.preview', 'loras.clearPreview', 'loras.image', 'loras.saveFrame', 'loras.open',
  'library.load', 'settings.set',
  'templates.save', 'templates.remove', 'templates.duplicate', 'templates.reorder',
  'characters.save', 'characters.remove', 'characters.duplicate',
  'outfits.save', 'outfits.remove', 'outfits.duplicate', 'outfits.reorder',
  'stories.save', 'stories.remove', 'stories.duplicate', 'references',
  'workflows.get', 'workflows.import', 'workflows.reimport', 'workflows.save', 'workflows.remove', 'workflows.onlineCheck',
  'tasks.get', 'tasks.create', 'tasks.save', 'tasks.remove', 'tasks.duplicate',
  'plan.forTask',
  'queue.enqueue', 'queue.list', 'queue.units', 'queue.reorder', 'queue.remove', 'queue.delete', 'queue.retry', 'queue.pendingSummary',
  'runner.status', 'runner.precheck', 'runner.start', 'runner.pause', 'runner.stop', 'runner.interrupt', 'runner.logs',
  'history.list', 'history.image', 'history.openImage', 'history.showInFolder',
  'comfy.test', 'app.info', 'app.openDataDir', 'app.backupNow', 'app.chooseOutputDir',
]

/** Renderer 侧看到的 API：每个方法都是异步的 */
export type RendererApi = {
  [K in ApiMethod]: (...args: Parameters<Api[K]>) => Promise<Awaited<ReturnType<Api[K]>>>
} & {
  onRunnerEvent(cb: (e: RunnerEvent) => void): () => void
}

export const RUNNER_EVENT_CHANNEL = 'runner:event'
export const INVOKE_CHANNEL = 'api:invoke'
