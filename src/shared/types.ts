// 前后端共享的数据模型。字段名与旧版 SQLite 数据库保持一致，保证旧数据无需转换即可读取。

/**
 * 素材类型（kind）。旧类型全部保留：
 * - pose：单人动作（旧「姿态」模板原样归入这里）；在任务中分配给主角色或第二角色
 * - position / subposition / act：双人互动的主体位 / 子体位（parent_id 指向主体位）/ 可复用的行为
 * - scene：场景（环境、地点、背景）
 * - male / camera：兼容素材（旧版男性描述、镜头），不在素材库中显示；镜头在套图任务中选择和新建
 */
export type TemplateKind = 'global' | 'scene' | 'pose' | 'position' | 'subposition' | 'act' | 'expression' | 'male' | 'camera'

export const TEMPLATE_KINDS: Record<TemplateKind, string> = {
  global: '全局 Prompt',
  scene: '场景',
  pose: '单人动作',
  position: '主体位',
  subposition: '子体位',
  act: '行为',
  expression: '表情',
  male: '男性描述',
  camera: '镜头',
}

/** 旧版的适用对象字段：不再在界面中设置或筛选，只为保留旧文件中的值 */
export type Target = 'any' | 'female' | 'male'
export const TARGETS: Record<Target, string> = { any: '通用', female: '女性', male: '男性' }

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
  /** 旧版适用对象（保留原值，不再使用） */
  target?: Target
  /** 子体位所属的主体位 ID */
  parent_id?: number | null
}

export interface Lora {
  resource_id?: string
  name: string
  /** Model 权重（写入映射到 strength_model 等输入） */
  strength: number
  /** Clip 权重（写入映射到 strength_clip 的输入）；没有时与 strength 相同 */
  strength_clip?: number
  /** 任务中临时禁用：映射的 Loader 强度写 0，名称保持工作流原值 */
  disabled?: boolean
  /** 参与生成的触发词（用户勾选，按勾选顺序），与角色基础 Prompt 组合，不写入原 metadata.json */
  trigger_words?: string[]
  /** 用户手动添加的自定义触发词（可勾选或不勾选） */
  custom_triggers?: string[]
}

export interface Character extends Timestamps {
  id: number
  /** 所在文件夹（由文件位置决定，只读，不写入文件） */
  _folder?: string
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
  /** 双人互动：主体位、子体位（作为主体位的补充 Prompt）、可叠加的行为 */
  position_id?: number | null
  subposition_id?: number | null
  act_ids?: number[]
  /** 旧版：男性出场时的男性动作与表情（只在 male_enabled 时拼入旧版男性模块） */
  male_pose_ids?: number[]
  male_expression_ids?: number[]
  /** 第二角色是否在本动作中出场（任务需选择 second_character_id）；以及第二角色的服装、动作、表情 */
  second_enabled?: boolean
  second_outfit_id?: number | null
  second_pose_id?: number | null
  second_expression_id?: number | null
  /** 场景：null 时沿用任务的默认场景 */
  scene_id?: number | null
}

/** 任务对角色默认 LoRA 的调整（键为槽位：lora1 = 主角色，second_lora1 = 第二角色） */
export interface LoraOverride {
  enabled: boolean
  /** 替换为其他 LoRA（不填则沿用角色库中的 LoRA） */
  resource_id?: string
  name?: string
  strength_model?: number
  strength_clip?: number
}

/** 任务级 LoRA（画风、辅助、背景等）：槽位 slot 对应工作流映射中的「任务 LoRA n」 */
export interface TaskLora {
  slot: number
  label: string
  enabled: boolean
  resource_id?: string
  name: string
  strength_model: number
  strength_clip: number
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
  /** 默认场景：应用到动作序列中没有单独指定场景的动作（不用于剧情场景） */
  scene_id?: number | null
  /** 第二角色（与主角色来自同一个角色库，可不选择）。character_id 即主角色 */
  second_character_id?: number | null
  /** LoRA 配置：LoRA 是工作流参数（写入 LoRA Loader 节点），不拼入 Prompt */
  lora_overrides?: Record<string, LoraOverride>
  task_loras?: TaskLora[]
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
  compose_order: ['global', 'scene', 'camera', 'character', 'outfit', 'content', 'expression', 'interaction', 'male', 'character2', 'outfit2', 'content2', 'expression2', 'extra'],
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
  scene?: string
  position?: string
  subposition?: string
  acts?: string[]
  /** 第二角色出场时：角色名、服装、动作、表情 */
  character2?: string
  outfit2?: string
  action2?: string
  expression2?: string
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
  /** 第二角色出场时的 LoRA（映射到「第二角色 LoRA n」） */
  loras2?: Lora[]
  /** 任务级 LoRA（映射到「任务 LoRA n」，n = slot） */
  task_loras?: (Lora & { slot: number; label: string })[]
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
  /** 角色文件夹（只在工作区模式下存在） */
  characterFolders?: string[]
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
