// 前后端共享的数据模型。字段名与旧版 SQLite 数据库保持一致，保证旧数据无需转换即可读取。

/**
 * 素材类型（kind）。旧类型全部保留：
 * - state：状态（由旧版「单人动作」pose 与「行为」act 合并而来）；在任务中为主角色、第二角色分别多选，
 *   双人动作中的「行为」也从状态中选择
 * - pose / act：旧类型，打开工作区时迁移为 state（只改 kind，原值记录在 legacy_kind）；未迁移的文件按状态显示
 * - position / subposition：动作卡（旧版双人主体位）/ 它的子体位（结构变体，parent_id 指向动作卡）。动作卡配置保存在 card 字段
 * - scene：场景（环境、地点、背景）
 * - male / camera：兼容素材（旧版男性描述、镜头），不在素材库中显示；镜头已是素材库的独立分类
 */
export type TemplateKind = 'global' | 'scene' | 'state' | 'pose' | 'position' | 'subposition' | 'act' | 'expression' | 'male' | 'camera' | 'card_tpl'

export const TEMPLATE_KINDS: Record<TemplateKind, string> = {
  global: '全局 Prompt',
  scene: '场景',
  state: '状态',
  pose: '状态',
  position: '动作卡',
  subposition: '子体位',
  act: '状态',
  expression: '表情',
  male: '男性描述',
  camera: '镜头',
  card_tpl: '动作模板',
}

/** 合并为「状态」的旧类型 */
export const LEGACY_STATE_KINDS: TemplateKind[] = ['pose', 'act']
export const isStateKind = (k: string | undefined): boolean => k === 'state' || k === 'pose' || k === 'act'

/** 素材的显示优先级：只影响选择列表中的排列（高 → 普通 → 低，同级保持原有排序），不影响 Prompt。没有此字段时为普通 */
export type Priority = 'high' | 'normal' | 'low'
export const PRIORITIES: [Priority, string][] = [
  ['high', '高'],
  ['normal', '普通'],
  ['low', '低'],
]
export const priorityRank = (p: unknown): number => (p === 'high' ? 0 : p === 'low' ? 2 : 1)
/** 按优先级稳定排序（同优先级保持传入顺序，即原有的手动排序） */
export function byPriority<T extends { priority?: Priority | null }>(list: T[]): T[] {
  return list.map((t, i) => [t, i] as const).sort((a, b) => priorityRank(a[0].priority) - priorityRank(b[0].priority) || a[1] - b[1]).map(([t]) => t)
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
  /** 显示优先级（没有时为普通） */
  priority?: Priority
  /** 迁移为 state 之前的类型（pose / act），只作记录 */
  legacy_kind?: string
  /** 动作卡配置（只用于主体位 position：主体位即动作卡，子体位即它的结构变体）。没有时为双人动作卡、随机一个子体位、其他素材池为空 */
  card?: ActionCard | null
  /** 互斥组（状态、表情可选）：同一素材池中同组的素材，一张图片最多随机抽取一个 */
  exclusive?: string
}

// ---------------------------------------------------------------- 动作卡
/**
 * 动作卡的素材池：
 * - variant：子体位 / 结构变体（候选为属于该动作卡的子体位）
 * - pose / pose2：主角色 / 第二角色的局部姿态（含手部动作），从「状态」素材中选择
 * - interaction：双人互动（拥抱、接吻等），从「状态」素材中选择
 * - expr / expr2：主角色 / 第二角色的表情，从「表情」素材中选择
 * - extra：附加，从「状态」素材中选择
 */
export type CardPoolKey = 'variant' | 'pose' | 'expr' | 'interaction' | 'pose2' | 'expr2' | 'extra'
/** 素材池（抽取顺序固定，保证同一组合 Seed 结果可复现）；duo 表示只用于双人动作卡 */
export const CARD_POOLS: { key: CardPoolKey; label: string; source: 'variant' | 'state' | 'expression'; duo?: boolean }[] = [
  { key: 'variant', label: '子体位 / 结构变体', source: 'variant' },
  { key: 'pose', label: '主角色局部姿态', source: 'state' },
  { key: 'expr', label: '主角色表情', source: 'expression' },
  { key: 'interaction', label: '双人互动', source: 'state', duo: true },
  { key: 'pose2', label: '第二角色局部姿态', source: 'state', duo: true },
  { key: 'expr2', label: '第二角色表情', source: 'expression', duo: true },
  { key: 'extra', label: '附加', source: 'state' },
]
/**
 * 素材池配置：fixed 中的素材全部加入每张图片；random 中的素材每张图片均匀随机抽取 1 个。两栏都可以为空，同一素材只属于一栏。
 * 子体位没有 random 时，候选为这张卡的全部子体位（固定的除外）。
 */
export interface PoolConfig {
  fixed?: number[]
  random?: number[]
}
/** 旧版抽取规则（关闭 / 固定 / 随机 min～max）：只用于读取旧数据，读取时转换为 PoolConfig */
export interface LegacyPoolRule {
  mode: 'off' | 'fixed' | 'random'
  fixed?: number[]
  min?: number
  max?: number
}
export interface ActionCard {
  /** true = 单人动作卡（不使用第二角色与双人互动）；没有时为双人（旧主体位） */
  solo?: boolean
  /**
   * true = 模板动作卡：每张图从这张卡的 Prompt 模板（kind card_tpl，parent_id 指向本卡）中抽取一份完整模板，
   * 用占位符填入全局、场景、镜头、角色与服装。没有时为旧版素材池动作卡（读取旧数据时仍按素材池展开）
   */
  templates?: boolean
  /** 模板分类的显示顺序（也保存还没有模板的空分类）；模板的 category 不在列表中时排在后面 */
  categories?: string[]
  /** 新建模板时预填的正文（复制使用，不是继承：之后修改骨架不影响已有模板） */
  skeleton?: string
  /**
   * 旧版：动作卡 / 姿态模板上设置的表情（模板 × 表情组合）。新版本由动作序列选择一个固定表情，这里的设置不再参与生成，
   * 只保留数据以便在素材库中提示和清除
   */
  expressions?: number[]
  /** 各素材池的固定素材与随机候选（只保存 ID，不复制 Prompt） */
  pools?: Partial<Record<CardPoolKey, PoolConfig>>
}
/** 一张图片实际使用的素材（随计划冻结在运行记录中，用于查看来源） */
export interface CardPick {
  /** template：模板动作卡抽到的 Prompt 模板 */
  pool: CardPoolKey | 'template' | 'expression' | 'behavior'
  id: number
  name: string
  random: boolean
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
  /** 工作流级节点控制（参数覆盖、节点绕过）；旧工作流没有。不修改 api_json，提交时写入副本 */
  controls?: WorkflowControls | null
  note: string
  sort: number
}

/** 工作流级节点参数覆盖。class_type 用于发现节点 ID 对应的节点已变化 */
export interface NodeOverride {
  node: string
  input: string
  class_type: string
  value: unknown
}
/** 节点绕过：每个被下游使用的输出对应的输入（设置时由 /object_info 确认类型，之后不需要联网也能构建） */
export interface NodeBypass {
  node: string
  class_type: string
  routes: { output: number; input: string; type: string }[]
  output_node?: boolean
}
/** 由 ComfyEngi 管理的触发词路径：提交时把这个拼接输入写成空文本。只切断这一个文本输入，LoRA Loader 本身不变 */
export interface TriggerCut {
  /** 提供 trigger_words 的 Loader */
  loader: string
  node: string
  input: string
  class_type: string
}
export interface WorkflowControls {
  overrides: NodeOverride[]
  bypass: NodeBypass[]
  /** 旧工作流没有这个字段：默认使用插件输出，提交内容不变 */
  trigger_cuts?: TriggerCut[]
}
/** ComfyUI /object_info 中用到的字段 */
export interface ObjectInfoNode {
  input?: { required?: Record<string, unknown>; optional?: Record<string, unknown> }
  output?: unknown[]
  output_name?: unknown[]
  output_is_list?: boolean[]
  is_input_list?: boolean
  output_node?: boolean
}
export type ObjectInfo = Record<string, ObjectInfoNode>

export interface TaskItem {
  /** 主角色的状态（可多选，按选择顺序拼接到同一张图）。旧任务的 pose_id 读取时转换为一个元素的数组 */
  state_ids?: number[]
  /** 第二角色的状态（可多选）。旧任务的 second_pose_id 读取时转换 */
  second_state_ids?: number[]
  /** 旧版：单人动作（读取时迁移到 state_ids 后置空） */
  pose_id: number | null
  outfit_id: number | null
  expression_ids: number[]
  count: number
  /** 旧版：单选镜头。读取时转换为一个元素的 camera_ids；修改镜头时同步为 camera_ids 的第一个 */
  camera_id: number | null
  /** 镜头候选（素材 ID）：选 1 个时每张图片都使用它，选多个时每张图片各抽 1 个，不选则没有镜头 Prompt */
  camera_ids?: number[]
  male_enabled: boolean
  male_ids: number[]
  male_extra: string
  extra_positive: string
  extra_negative: string
  /** 双人动作：主体位、子体位（作为主体位的补充 Prompt）、可叠加的行为（从状态素材中选择） */
  position_id?: number | null
  subposition_id?: number | null
  act_ids?: number[]
  /** 旧版：男性出场时的男性动作与表情（只在 male_enabled 时拼入旧版男性模块） */
  male_pose_ids?: number[]
  male_expression_ids?: number[]
  /** 第二角色是否在本动作中出场（任务需选择 second_character_id）；以及第二角色的服装、旧版动作（迁移到 second_state_ids）、表情 */
  second_enabled?: boolean
  second_outfit_id?: number | null
  second_pose_id?: number | null
  second_expression_id?: number | null
  /**
   * 动作卡（主体位 ID）：有此字段的动作按动作卡展开——基础 Prompt + 各素材池的固定素材与随机抽取结果，单人卡不加入第二角色。
   * 没有此字段的旧动作按原有方式展开（结果不变）
   */
  card_id?: number | null
  /** 本任务对动作卡素材池的覆盖（按池替换，只对当前任务生效；删除即恢复动作卡默认设置）。旧任务中可能是旧版规则 */
  card_rules?: Partial<Record<CardPoolKey, PoolConfig | LegacyPoolRule>>
  /** 旧任务中禁止随机抽取的素材（继续生效，界面可以恢复，不再新增） */
  card_exclude?: number[]
  /** 模板动作卡的抽取来源：没有时为这张卡的全部模板 */
  card_pick?: CardTemplatePick
  /** 在预览中手改的单张 Prompt（k 为本动作内的第几张，从 0 开始）；base 为手改时的自动结果，用于发现来源变化 */
  prompt_edits?: PromptEdit[]
  /** 场景：null 时沿用任务的默认场景 */
  scene_id?: number | null
  /**
   * 各尺寸的张数（竖图 / 横图 / 方图）。没有此字段的旧动作沿用 count 与工作流默认尺寸；
   * 有此字段时总张数为各尺寸之和（count 同步为总数，仅供显示）
   */
  sizes?: SizeCounts
  /** 模板动作卡：主角色的固定表情（本动作的每张图都使用它；需要两种表情时复制一个动作序列） */
  expression_id?: number | null
  /**
   * 模板动作卡：行为候选（状态素材 ID）。每张图在「无行为」和各候选之间等概率抽取一个，写入 {行为}；不选则不加行为。
   * 旧方式动作的 act_ids 仍按原来的固定叠加展开
   */
  behavior_ids?: number[]
}

/**
 * 模板来源：categories 中的分类包含其中现在和以后的全部模板（'' 为未分类）；include 额外加入的模板；exclude 不参与抽取的模板。
 * categories 没有时为全部分类
 */
export interface PromptEdit {
  k: number
  positive: string
  negative: string
  base_positive: string
  base_negative: string
}

export interface CardTemplatePick {
  categories?: string[]
  include?: number[]
  exclude?: number[]
}

export type SizeKey = 'portrait' | 'landscape' | 'square'
export type SizeCounts = Partial<Record<SizeKey, number>>
/** 生成尺寸预设，按此顺序执行 */
export const SIZE_PRESETS: { key: SizeKey; label: string; width: number; height: number }[] = [
  { key: 'portrait', label: '竖图', width: 1024, height: 1536 },
  { key: 'landscape', label: '横图', width: 1536, height: 1024 },
  { key: 'square', label: '方图', width: 1024, height: 1024 },
]
export const SIZE_STEP = 5

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
  /** 动作卡素材抽取的组合 Seed（与 ComfyUI 采样 Seed 无关）；没有时使用 seed_base */
  combo_seed?: number
  items: TaskItem[]
  /** 任务中清除了工作流选择（workflow_id 为 null 时原本表示「使用默认工作流」，为兼容旧任务另用这个标记） */
  workflow_none?: boolean
  /** 默认场景：应用到动作序列中没有单独指定场景的动作（不用于剧情场景） */
  scene_id?: number | null
  /** 第二角色（与主角色来自同一个角色库，可不选择）。character_id 即主角色 */
  second_character_id?: number | null
  /** LoRA 配置：LoRA 是工作流参数（写入 LoRA Loader 节点），不拼入 Prompt */
  lora_overrides?: Record<string, LoraOverride>
  task_loras?: TaskLora[]
  /** 按工作流保存的 LoRA 配置（键为工作流 ID）：工作流中已有的 LoRA 是默认值；切换工作流不会串用 */
  lora_configs?: Record<string, import('./lora-config').WfLoraConfig>
  /** 输出：dir 为最终图片的复制目录（默认工作区 output/）；prefix 为 ComfyUI 的文件名前缀模板（空则使用工作流映射中的模板） */
  output?: TaskOutput
}

// ---------------------------------------------------------------- 动作序列预设 / 套图模板
/**
 * 保存的服装槽位：预设不直接绑定某个角色的服装。second 为第二角色的服装。
 * 导入时每个槽位选择一次当前角色的服装，应用到所有使用该槽位的动作
 */
export interface OutfitSlot {
  key: number
  second?: boolean
  /** 保存时的服装（导入到同一角色时默认沿用） */
  outfit_id: number | null
  name: string
}

/** 预设中的动作：引用素材 ID，不保存展开后的 Prompt；服装换成槽位 */
export type PresetItem = Omit<TaskItem, 'prompt_edits' | 'outfit_id' | 'second_outfit_id'> & {
  outfit_slot?: number | null
  second_outfit_slot?: number | null
}

/** 保存时引用素材的内容指纹，用于提示素材已修改或删除 */
export interface RefStamp {
  name: string
  kind: string
  hash: string
  /** 动作卡：保存时的姿态模板 ID */
  templates?: number[]
}

export interface PresetData {
  items: PresetItem[]
  slots: OutfitSlot[]
  refs: Record<string, RefStamp>
  /** 保存来源（只作说明） */
  source?: { task?: string; character?: string; from?: number; to?: number }
}

/** kind：action 为单个动作序列预设，set 为整组套图模板 */
export type PresetKind = 'action' | 'set'
export interface Preset extends Timestamps {
  id: number
  kind: PresetKind
  name: string
  data: PresetData
  sort: number
}

export interface TaskOutput {
  dir?: string
  prefix?: string
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
  /** 正面 Prompt 顶层模块之间的连接符（模块内部仍用 pos_separator） */
  pos_module_separator: string
  neg_separator: string
  trim_modules: boolean
  default_workflow_id: number | null
  /** 新任务默认值（只在新建任务时使用，不影响已有任务和已入队快照） */
  default_global_id: number | null
  default_item_count: number
  default_output_dir: string
  default_output_prefix: string
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
  pos_module_separator: ',\\n\\n',
  neg_separator: ', ',
  trim_modules: true,
  default_workflow_id: null,
  default_global_id: null,
  default_item_count: 10,
  default_output_dir: '',
  default_output_prefix: '',
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
  /** 主角色的状态名称（多选时按顺序） */
  states?: string[]
  /** 动作卡：名称、类型、本张的结构变体与实际使用的素材（固定 / 随机） */
  card?: string
  card_type?: 'solo' | 'duo'
  variant?: string
  picks?: CardPick[]
  combo_seed?: number
  /** 模板动作卡：抽到的模板名称、分类与表情标签 */
  template?: string
  template_category?: string
  template_label?: string
  /** 入队时冻结的输出目录：完成后最终图片复制到这里（没有时不复制） */
  output_dir?: string
  /** 套图复刻：原图路径、保存时使用的文件名（不含扩展名）与替换记录 */
  source_image?: string
  output_name?: string
  replica?: {
    original_positive: string
    original_negative: string
    removed: string[]
    /** 保留片段是手动填写的（旧版记录为整段手改的最终 Prompt） */
    manual: boolean
    /** 旧版记录：原图参数的写入情况（新版不再继承原图参数） */
    params?: unknown[]
    /** 保留片段、被替换的开头，以及这是同一张原图的第几次生成 */
    retained?: string
    prefix?: string
    variant?: number
    variants?: number
  }
  /** 批量放大：原图、恢复的生成条件与上传信息（入队时冻结） */
  upscale?: UpscaleMeta
  /** 第二角色出场时：角色名、服装、动作、表情 */
  character2?: string
  outfit2?: string
  action2?: string
  expression2?: string
  n: number
  of: number
  index?: number
  seed?: number
  /** 动作的尺寸配置：本张的基础生成尺寸（旧动作没有，使用工作流默认尺寸） */
  size?: string
  width?: number
  height?: number
}

// ---------------------------------------------------------------- 批量放大
/** block：不能加入放大队列；confirm：需要用户确认后才加入；note：说明 */
export type UpscaleIssueLevel = 'block' | 'confirm' | 'note'
export interface UpscaleIssue {
  level: UpscaleIssueLevel
  text: string
}
/** 从原图提交快照中恢复的一个 LoRA（多 LoRA Loader 中只有文件名；标准 Loader 为完整的 lora_name） */
export interface RecoveredLora {
  name: string
  strength: number
  clip: number
  active: boolean
  /** 所在的原图节点与类型 */
  node: string
  kind: 'stack' | 'standard'
}
/** 原图的生成条件：全部来自原图的提交快照（或旧记录中冻结的工作流与写入值），不读取当前角色库与 LoRA 配置 */
export interface RecoveredGeneration {
  /** null：无法确定 */
  positive: string | null
  negative: string | null
  /** 文本完全由快照静态确定（没有运行时才产生的部分） */
  positive_exact: boolean
  negative_exact: boolean
  checkpoint: string | null
  loras: RecoveredLora[] | null
  issues: UpscaleIssue[]
}
export interface UpscaleMeta {
  source: {
    /** run：运行记录中的图片；file：本机的图片文件（从 PNG 等的 prompt 元数据恢复）。旧数据没有这个字段，按 run 处理 */
    kind?: 'run' | 'file'
    /** 以下运行记录字段在 file 来源中为 null */
    unit_id: number | null
    run_id: number | null
    /** 运行记录的任务名称；file 来源为空文本 */
    run_name: string
    task_id: number | null
    /** 原图在 outputs 中的序号与节点 */
    output: number | null
    node: string | null
    /** 原图本地文件（上传的就是这个文件）、文件名与入队时的 SHA-256 */
    path: string
    name: string
    sha256: string
    prompt_id: string | null
    /** 恢复所用的提交快照；rebuilt：旧记录没有快照，按冻结的工作流与写入值重建；file：图片文件中的 prompt 元数据 */
    attempt_id: number | null
    snapshot: 'attempt' | 'rebuilt' | 'file'
    /** 原图的 Seed（运行记录中写入的值；file 来源为静态得到的第一个采样器的 Seed，得不到时为 null） */
    seed: number | null
  }
  workflow: { id: number; name: string }
  recovered: { positive: string; negative: string; checkpoint: string | null; loras: RecoveredLora[]; positive_exact: boolean; negative_exact: boolean }
  /** 加入时的说明与用户确认过的问题 */
  issues: UpscaleIssue[]
  /** 上传到 ComfyUI input 目录的文件名（每张图唯一，不与其他任务共用） */
  upload: { name: string; subfolder: string }
}

export interface InputValue {
  node: string
  input: string
  source: string
  value: unknown
}

/** 计划展开后的一张图 */
export interface PlanUnit {
  section: 'story' | 'pose' | 'replica'
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
  /** 基础生成尺寸：写入映射的「生成宽度 / 高度」；没有时保持工作流原值 */
  width?: number
  height?: number
  inputs?: InputValue[]
  /** 正面 Prompt 来自 Prompt 模板（按占位符位置填入），不能再按模块拆分写入多个节点 */
  from_template?: boolean
  /** 本张的 Prompt 在预览中手改过（正面、负面都是一整段，不能再按模块拆分） */
  manual?: boolean
  /** 手改后自动结果又变化了：需要在预览中选择保留手改还是使用新的 */
  edit_stale?: boolean
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
  /** 复制到任务输出目录后的本地路径（只有最终输出图片会复制） */
  saved?: string
  /** 复制到任务输出目录失败的原因 */
  save_error?: string
  /** 产生这个文件的 ComfyUI Prompt ID */
  prompt_id?: string
  /** final：最终输出（复制到任务目录）；intermediate：其他保存节点，不复制；preview：临时预览（temp） */
  role?: 'final' | 'intermediate' | 'preview'
  /** 从 ComfyUI 下载的原始字节与本地保存文件的 SHA-256 */
  source_sha256?: string
  saved_sha256?: string
  /** 输出目录中已有内容完全相同的文件，直接关联它，没有另存一份（例如程序重启后继续复制） */
  reused?: boolean
  /** 另一个输出节点报告了相同的 subfolder 与文件名：两条记录指向同一个文件 */
  same_file_as_node?: string
  /** 从 PNG 文件头读到的实际宽高 */
  image_width?: number
  image_height?: number
}

/**
 * 一次提交尝试的状态。构建、提交、执行是不同阶段：
 * built 已构建未确认提交；build_failed 无法构建；rejected ComfyUI 拒绝（参数校验失败）；submit_unknown 提交时连接异常，不确定是否收到；
 * submitted 已被 ComfyUI 接受；success / failed / interrupted 执行结果；withdrawn 从队列撤回；lost 在 ComfyUI 中找不到；timeout 等待超时
 */
export type AttemptState = 'built' | 'build_failed' | 'rejected' | 'submit_unknown' | 'submitted' | 'success' | 'failed' | 'interrupted' | 'withdrawn' | 'lost' | 'timeout'

/** 一次提交尝试的记录（不含请求内容；完整 JSON 单独读取，列表不加载） */
export interface ExecutionAttempt {
  id: number
  unit_id: number
  run_id: number
  attempt: number
  state: AttemptState
  prompt_id: string | null
  client_id: string | null
  body_sha256: string
  /** ComfyUI 的响应（接受时的 number、拒绝时的错误详情） */
  response: string
  error: string
  /** ComfyUI 历史记录中保存的工作流与提交快照是否相同（null：没有历史记录或历史中没有工作流） */
  comfy_match: number | null
  built_at: number | null
  submitted_at: number | null
  finished_at: number | null
}

/** 实际提交的工作流与入队时冻结的原始工作流之间的一处差异 */
export interface InputChange {
  node: string
  class_type: string
  title: string
  input: string
  before: unknown
  after: unknown
  /** 写入来源（映射来源名）；没有时表示没有对应的冻结写入值 */
  source?: string
}

export interface PromptInjector {
  node: string
  class_type: string
  title: string
  /** trigger_toggle：已验证结构的 LoraManager 节点；trigger_unknown：无法确定结构的触发词节点；loader_text：LoRA Loader 的文本输出接入 Prompt；unmapped_text：路径上没有映射的文本；unknown_text：无法确定内容的文本来源 */
  kind: 'trigger_toggle' | 'trigger_unknown' | 'loader_text' | 'unmapped_text' | 'unknown_text'
  polarity: ('positive' | 'negative')[]
  /** 可以由 ComfyEngi 安全禁用（只有已验证结构的节点） */
  controllable: boolean
  /** 工作流已设置由 ComfyEngi 禁用，提交时写入 */
  disabled: boolean
  /** 节点的开关状态（触发词组） */
  groups?: { text: string; active: boolean }[]
  /** trigger_words 输入连接自的节点 */
  source_node?: string
  /** 本次 LoRA 配置与保存工作流时不同：插件会绕过开关，输出全部触发词 */
  bypass?: boolean
  message: string
}

/** 一次提交的说明：全部来自提交快照与入队时冻结的工作流，不读取当前素材库 */
export interface ExecutionInspection {
  attempt: ExecutionAttempt
  /** 实际提交的 API 工作流（格式化的 JSON 文本） */
  graph_json: string | null
  /** 入队时冻结的原始工作流（读取队列项中已有的副本，不另外保存） */
  original_json: string | null
  /** 这次提交冻结的节点覆盖与绕过（来自入队时的写入值，不读取当前工作流配置） */
  controls: InputValue[]
  /** 快照内容与记录的 SHA-256 一致 */
  intact: boolean
  changes: InputChange[]
  unchanged: { node: string; class_type: string; title: string; inputs: Record<string, unknown> }[]
  injectors: PromptInjector[]
  loras: { node: string; class_type: string; items: { name: string; strength: unknown; clip?: unknown; active: boolean }[] }[]
  seeds: { node: string; class_type: string; input: string; value: number; changed: boolean }[]
  size: { node: string; class_type: string; width: unknown; height: unknown } | null
}

export interface ExecutionDetail {
  unit: RunUnit
  run: { id: number; task_id: number | null; name: string; workflow_name: string; created_at: number | null } | null
  attempts: ExecutionAttempt[]
  /** 预览显示的输出在 outputs 中的序号，以及实际读取的文件 */
  preview_index: number
  preview_path: string
  /** 本地文件现在的内容是否仍与保存时的 SHA-256 相同（与 outputs 对应；null：没有可比较的文件） */
  file_checks: (boolean | null)[]
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

/** save_failed：已生成但有文件未能复制到任务输出目录的张数（包含在 done 中） */
export type RunCounts = Partial<Record<UnitStatus, number>> & { total: number; save_failed?: number }

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
  /** 需要用户注意的提示（例如图片已生成但未能保存到输出目录） */
  | { kind: 'notice'; level: 'warn' | 'error'; text: string; detail?: string }
  /** 历史 Prompt 提取：图片扫描进度 */
  | { kind: 'mining'; done: number; total: number; file: string }

export interface Library {
  templates: Template[]
  /** 角色文件夹（只在工作区模式下存在） */
  characterFolders?: string[]
  characters: Character[]
  outfits: Outfit[]
  stories: Story[]
  /** upscale：映射了「放大：输入图片」，可用于批量放大 */
  workflows: { id: number; name: string; note: string; nodes: number; mapping: number; errors: number; upscale?: boolean }[]
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
