// 前后端共享的数据模型。字段名与旧版 SQLite 数据库保持一致，保证旧数据无需转换即可读取。

export type TemplateKind = 'global' | 'pose' | 'expression' | 'male' | 'camera'

export const TEMPLATE_KINDS: Record<TemplateKind, string> = {
  pose: '姿态',
  expression: '表情',
  camera: '镜头',
  male: '男性',
  global: '全局 Prompt',
}

interface Timestamps {
  _revision?: string
  created_at?: number | null
  updated_at?: number | null
}

export interface Template extends Timestamps {
  id: number
  kind: TemplateKind
  name: string
  positive: string
  negative: string
  category: string
  tags: string
  note: string
  sort: number
}

export interface Lora {
  resource_id?: string
  name: string
  strength: number
}

export interface Character extends Timestamps {
  id: number
  name: string
  tag: string
  positive: string
  negative: string
  loras: Lora[]
  note: string
  sort: number
}

export interface Outfit extends Timestamps {
  id: number
  character_id: number
  name: string
  positive: string
  negative: string
  note: string
  sort: number
}

export interface Scene {
  name: string
  positive: string
  negative: string
  count: number
  with_male: boolean
}

export interface Story extends Timestamps {
  id: number
  genre: string
  name: string
  note: string
  scenes: Scene[]
  sort: number
}

export type ApiNode = { class_type: string; inputs: Record<string, unknown>; _meta?: { title?: string } }
export type ApiWorkflow = Record<string, ApiNode>

export interface MappingEntry {
  source: string
  node: string
  input: string
  modules: string[]
  template: string
}

export interface Workflow extends Timestamps {
  id: number
  name: string
  api_json: ApiWorkflow
  mapping: MappingEntry[]
  note: string
  sort: number
}

export interface TaskItem {
  pose_id: number | null
  outfit_id: number | null
  expression_ids: number[]
  count: number
  camera_id: number | null
  male_enabled: boolean
  male_ids: number[]
  male_extra: string
  extra_positive: string
  extra_negative: string
}

export interface TaskData {
  character_id: number | null
  story_id: number | null
  story_outfit_id: number | null
  global_id: number | null
  male_base_id: number | null
  workflow_id: number | null
  seed_base: number
  items: TaskItem[]
}

export interface Task extends Timestamps {
  id: number
  name: string
  data: TaskData
  sort: number
}

export interface Settings {
  lora_roots: string[]
  /** LoRA 管理页显示名称：model = metadata 中的模型名称，file = 本地文件名 */
  lora_display_name: string
  comfy_url: string
  comfy_output_dir: string
  compose_order: string[]
  pos_separator: string
  neg_separator: string
  trim_modules: boolean
  default_workflow_id: number | null
  unit_timeout_min: number
  max_consecutive_failures: number
  comfy_wait_max_min: number
  poll_interval_sec: number
  last_task_id: number | null
}

export const DEFAULT_SETTINGS: Settings = {
  lora_roots: [],
  lora_display_name: 'model',
  comfy_url: 'http://127.0.0.1:8188',
  comfy_output_dir: '',
  compose_order: ['global', 'character', 'outfit', 'content', 'expression', 'male', 'camera', 'extra'],
  pos_separator: ', ',
  neg_separator: ', ',
  trim_modules: true,
  default_workflow_id: null,
  unit_timeout_min: 30,
  max_consecutive_failures: 3,
  comfy_wait_max_min: 10,
  poll_interval_sec: 3.0,
  last_task_id: null,
}

/** 每个模块的 [正面, 负面] 原始文本 */
export type Modules = Record<string, [string, string]>

export interface UnitMeta {
  task: string
  character: string
  story: string
  genre: string
  section: string
  item: string
  item_no: number
  outfit: string
  expression: string
  expression_n?: number
  expression_of?: number
  camera: string
  male: boolean
  male_templates: string[]
  n: number
  of: number
  index?: number
  seed?: number
}

export interface InputValue {
  node: string
  input: string
  source: string
  value: unknown
}

/** 计划展开后的一张图 */
export interface PlanUnit {
  section: 'story' | 'pose'
  item_index: number
  item_label: string
  sub_index: number
  modules: Modules
  positive: string
  negative: string
  loras: Lora[]
  meta: UnitMeta
  index: number
  seed: number
  inputs?: InputValue[]
}

export interface PlanResult {
  units: PlanUnit[]
  errors: string[]
  warnings: string[]
  workflow: { id: number; name: string } | null
}

export type UnitStatus = 'pending' | 'submitting' | 'submitted' | 'done' | 'failed' | 'skipped'

export interface OutputFile {
  node: string
  filename: string
  subfolder: string
  type: string
  path: string
}

export interface RunUnit {
  id: number
  run_id: number
  idx: number
  status: UnitStatus
  section: string
  item_label: string
  meta: UnitMeta
  modules: Modules
  positive: string
  negative: string
  seed: number
  inputs: InputValue[]
  prompt_id: string | null
  client_id: string | null
  error: string
  outputs: OutputFile[]
  attempts: number
  submitted_at: number | null
  finished_at: number | null
  run_name?: string
}

export type RunCounts = Partial<Record<UnitStatus, number>> & { total: number }

export interface Run {
  id: number
  task_id: number | null
  name: string
  position: number
  status: 'queued' | 'done' | 'removed'
  workflow_name: string
  created_at: number | null
  finished_at: number | null
  counts: RunCounts
}

export type RunnerState =
  | 'idle'
  | 'running'
  | 'waiting'
  | 'pausing'
  | 'paused'
  | 'stopping'
  | 'stopped'
  | 'finished'

export interface RunnerStatus {
  state: RunnerState
  alive: boolean
  message: string
  current: (RunUnit & { run_name: string }) | null
  progress: { value: number; max: number }
  sessionRuns: number[]
}

export type RunnerEvent =
  | { kind: 'status'; status: RunnerStatus }
  | { kind: 'log'; text: string }
  | { kind: 'unit'; unitId: number; runId: number }

export interface Library {
  templates: Template[]
  characters: Character[]
  outfits: Outfit[]
  stories: Story[]
  workflows: { id: number; name: string; note: string; nodes: number; mapping: number; errors: number }[]
  tasks: { id: number; name: string }[]
  settings: Settings
}

export type Severity = 'error' | 'warning'
export type Message = [Severity, string]

/**
 * 从 ComfyUI-Lora-Manager 的同名 `.metadata.json` 中提取的摘要（只读，只包含文件里实际存在的字段）。
 */
export interface LoraSidecar {
 modelName?:string; baseModel?:string; description?:string; tags?:string[]; triggerWords?:string[]
 usage?:{strength?:number; strengthMin?:number; strengthMax?:number; clipStrength?:number}
 notes?:string; versionName?:string; creator?:string; modelType?:string; sha256?:string
 civitaiModelId?:number; civitaiVersionId?:number; favorite?:boolean; previewUrl?:string
}

export interface LoraResource {
 id:string; name:string; path:string; relativePath:string; size:number; mtime:number;
 metadata:Record<string,unknown>; metadataError:string; category:string; tags:string; note:string;
 characterId:number|null; recommendedWeight:number; comfyName:string; preview:string
 /** 已确认缺失：所在根目录可以访问，但文件不存在（通常是被删除或移走）。列表时计算，不写入 Vault */
 missing:boolean
 /** 暂时无法确认：根目录不可访问（磁盘离线 / 目录被移除）或权限等读取错误。不视为已删除 */
 offline?:boolean
 /** 所属的 LoRA 根目录与相对根目录的文件夹（'/' 分隔，根目录本身为 ''） */
 root:string; folder:string
 /** 自动识别的同名封面（只读引用原文件） */
 cover:string
 /** 同名 .metadata.json 的摘要及缓存依据 */
 sidecar:LoraSidecar|null; sidecarPath:string; sidecarMtime:number; sidecarError:string
}
