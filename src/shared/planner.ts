// 任务计划：把一套图（剧情场景 + 姿态序列）展开为确定的逐张生成单元，并分配 Seed。
// 执行顺序固定：剧情模板中的场景（按模板顺序）→ 用户排列的姿态序列（按用户顺序）。
// 多表情时按选择顺序依次生成，每个表情张数相同；不能整除时报错，由用户修改张数。

import { compose, fillPlaceholders, joinParts, unescapeSeparator } from './prompt'
import type {
  Character,
  Modules,
  Outfit,
  PlanUnit,
  Settings,
  Story,
  TaskData,
  TaskItem,
  Template,
  UnitMeta,
} from './types'

export const SEED_MOD = 2 ** 32

export function newItem(poseId: number | null = null, outfitId: number | null = null): TaskItem {
  return {
    pose_id: poseId,
    outfit_id: outfitId,
    expression_ids: [],
    count: 10,
    camera_id: null,
    male_enabled: false,
    male_ids: [],
    male_extra: '',
    extra_positive: '',
    extra_negative: '',
    position_id: null,
    subposition_id: null,
    act_ids: [],
    male_pose_ids: [],
    male_expression_ids: [],
    scene_id: null,
  }
}

/** 双人互动条目：主体位（可带子体位） */
export function newInteractionItem(positionId: number, subpositionId: number | null = null, outfitId: number | null = null): TaskItem {
  return { ...newItem(null, outfitId), position_id: positionId, subposition_id: subpositionId }
}

export function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 31)
}

export function newTaskData(): TaskData {
  return {
    character_id: null,
    story_id: null,
    story_outfit_id: null,
    global_id: null,
    male_base_id: null,
    workflow_id: null,
    seed_base: randomSeed(),
    items: [],
  }
}

/** 旧数据中可能缺少字段：补齐默认值（不修改原对象） */
export function normalizeTaskData(d: Partial<TaskData> | null | undefined): TaskData {
  const base = newTaskData()
  const out = { ...base, ...(d ?? {}) } as TaskData
  out.items = (d?.items ?? []).map((it) => ({ ...newItem(), ...it }))
  return out
}

export class PlanLibrary {
  templates = new Map<number, Template>()
  characters = new Map<number, Character>()
  outfits = new Map<number, Outfit>()
  stories = new Map<number, Story>()

  constructor(templates: Template[], characters: Character[], outfits: Outfit[], stories: Story[]) {
    for (const t of templates) this.templates.set(t.id, t)
    for (const c of characters) this.characters.set(c.id, c)
    for (const o of outfits) this.outfits.set(o.id, o)
    for (const s of stories) this.stories.set(s.id, s)
  }

  storiesOfGenre(genre: string): Story[] {
    return [...this.stories.values()].filter((s) => (s.genre ?? '') === genre)
  }
}

/** 从某剧情类型下随机挑选一整套模板（不会打乱模板内部场景顺序） */
export function pickRandomStory(lib: PlanLibrary, genre: string, rnd: () => number = Math.random): Story | null {
  const pool = lib.storiesOfGenre(genre)
  return pool.length ? pool[Math.floor(rnd() * pool.length)] : null
}

type PN = { positive?: string; negative?: string } | null | undefined

const pair = (rec: PN): [string, string] => (rec ? [rec.positive ?? '', rec.negative ?? ''] : ['', ''])

function filled(rec: PN, char: Character | null): [string, string] {
  const [p, n] = pair(rec)
  return [fillPlaceholders(p, char), fillPlaceholders(n, char)]
}

const toInt = (v: unknown): number => {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10)
  return Number.isFinite(n) ? Math.trunc(n) : 0
}

/** 男性模块 = 男性基础 + 选中的男性模板 + 附加文本（只在明确启用男性时调用） */
function maleModule(
  base: Template | null,
  extras: Template[],
  extraText: string,
  settings: Settings,
  char: Character | null,
): [string, string] {
  const parts: [string, string][] = [
    filled(base, char),
    ...extras.map((t) => filled(t, char)),
    [fillPlaceholders(extraText ?? '', char), ''],
  ]
  const trim = settings.trim_modules ?? true
  return [
    joinParts(parts.map((p) => p[0]), unescapeSeparator(settings.pos_separator ?? ', '), trim),
    joinParts(parts.map((p) => p[1]), unescapeSeparator(settings.neg_separator ?? ', '), trim),
  ]
}

export interface ExpandResult {
  units: PlanUnit[]
  errors: string[]
}

export function expandTask(data: TaskData, lib: PlanLibrary, settings: Settings, taskName = ''): ExpandResult {
  const errors: string[] = []
  const units: PlanUnit[] = []
  const char = (data.character_id != null && lib.characters.get(data.character_id)) || null
  if (!char) errors.push('未选择角色（或该角色已被删除）')
  const g = (data.global_id != null && lib.templates.get(data.global_id)) || null
  if (data.global_id && !g) errors.push('所选全局 Prompt 已被删除')
  const maleBase = (data.male_base_id != null && lib.templates.get(data.male_base_id)) || null
  if (data.male_base_id && !maleBase) errors.push('所选男性基础模板已被删除')

  const checkOutfit = (oid: number | null | undefined, where: string): Outfit | null => {
    if (!oid) return null
    const o = lib.outfits.get(oid)
    if (!o) {
      errors.push(`${where}：所选服装已被删除`)
      return null
    }
    if (char && o.character_id !== char.id) {
      errors.push(`${where}：服装「${o.name}」不属于当前角色「${char.name}」`)
      return null
    }
    return o
  }

  const baseModules = (outfit: Outfit | null): Modules => ({
    global: pair(g),
    character: pair(char),
    outfit: pair(outfit),
  })

  const charName = char?.name ?? ''
  const loras = char ? (char.loras ?? []).filter((l) => l.name) : []

  const add = (
    section: 'story' | 'pose',
    itemIndex: number,
    label: string,
    sub: number,
    modules: Modules,
    meta: UnitMeta,
  ) => {
    const [positive, negative] = compose(modules, settings)
    units.push({
      section,
      item_index: itemIndex,
      item_label: label,
      sub_index: sub,
      modules,
      positive,
      negative,
      loras,
      meta,
      index: 0,
      seed: 0,
    })
  }

  // ---- 剧情场景 ----
  let story: Story | null = null
  if (data.story_id) {
    story = lib.stories.get(data.story_id) ?? null
    if (!story) errors.push('所选剧情模板已被删除')
  }
  if (story) {
    const sOutfit = checkOutfit(data.story_outfit_id, '剧情服装')
    ;(story.scenes ?? []).forEach((sc, si) => {
      const count = toInt(sc.count)
      const label = sc.name || `场景${si + 1}`
      for (let k = 0; k < Math.max(0, count); k++) {
        const m = baseModules(sOutfit)
        m.content = filled(sc, char)
        m.expression = ['', '']
        m.male = sc.with_male ? maleModule(maleBase, [], '', settings, char) : ['', '']
        m.camera = ['', '']
        m.extra = ['', '']
        add('story', si, label, k, m, {
          task: taskName,
          character: charName,
          story: story!.name ?? '',
          genre: story!.genre ?? '',
          section: '剧情',
          item: label,
          item_no: si + 1,
          outfit: sOutfit?.name ?? '',
          expression: '',
          camera: '',
          male: !!sc.with_male,
          male_templates: [],
          n: k + 1,
          of: count,
        })
      }
    })
  }

  // ---- 动作序列 ----
  // 每个条目：单人动作（pose_id），或双人主体位 + 子体位（可另加女性动作）；行为可叠加
  const tpl = (id: number | null | undefined) => (id != null && lib.templates.get(id)) || null
  const defaultScene = tpl(data.scene_id)
  if (data.scene_id && !defaultScene) errors.push('所选默认场景已被删除')
  ;(data.items ?? []).forEach((it, pi) => {
    let where = `第 ${pi + 1} 个动作`
    const pose = tpl(it.pose_id)
    const position = tpl(it.position_id)
    if (it.pose_id && !pose) errors.push(`${where}：动作模板已被删除`)
    if (it.position_id && !position) errors.push(`${where}：主体位已被删除`)
    if (!pose && !position) {
      if (!it.pose_id && !it.position_id) errors.push(`${where}：未选择动作`)
      return
    }
    const sub = tpl(it.subposition_id)
    if (it.subposition_id && !sub) errors.push(`${where}：子体位已被删除`)
    const acts = (it.act_ids ?? []).map((x) => tpl(x)).filter((t): t is Template => !!t)
    if (acts.length !== (it.act_ids ?? []).length) errors.push(`${where}：有行为素材已被删除`)
    const label = position ? (sub ? `${position.name} · ${sub.name}` : position.name) : pose!.name
    where = `第 ${pi + 1} 个动作「${label}」`
    const outfit = checkOutfit(it.outfit_id, where)
    const exprs: Template[] = []
    for (const eid of it.expression_ids ?? []) {
      const e = lib.templates.get(eid)
      if (e) exprs.push(e)
      else errors.push(`${where}：有表情模板已被删除`)
    }
    const camera = tpl(it.camera_id)
    if (it.camera_id && !camera) errors.push(`${where}：所选镜头模板已被删除`)
    const scene = it.scene_id ? tpl(it.scene_id) : defaultScene
    if (it.scene_id && !scene) errors.push(`${where}：所选场景已被删除`)
    const maleOn = !!it.male_enabled
    const maleTs = (it.male_ids ?? []).map((x) => tpl(x)).filter((t): t is Template => !!t)
    const malePoses = (it.male_pose_ids ?? []).map((x) => tpl(x)).filter((t): t is Template => !!t)
    const maleExprs = (it.male_expression_ids ?? []).map((x) => tpl(x)).filter((t): t is Template => !!t)
    // 双人互动模块：主体位 + 子体位（补充）+ 行为，原样拼接
    const parts: [string, string][] = position ? [filled(position, char), filled(sub, char), ...acts.map((a) => filled(a, char))] : acts.map((a) => filled(a, char))
    const trim = settings.trim_modules ?? true
    const interaction: [string, string] = [
      joinParts(parts.map((x) => x[0]), unescapeSeparator(settings.pos_separator ?? ', '), trim),
      joinParts(parts.map((x) => x[1]), unescapeSeparator(settings.neg_separator ?? ', '), trim),
    ]
    const count = toInt(it.count)
    if (count <= 0) {
      errors.push(`${where}：生成张数必须大于 0`)
      return
    }
    let groups: [Template | null, number][]
    if (exprs.length) {
      if (count % exprs.length) {
        errors.push(`${where}：张数 ${count} 不能被 ${exprs.length} 个表情平均分配，请修改张数`)
        return
      }
      groups = exprs.map((e) => [e, count / exprs.length])
    } else {
      groups = [[null, count]]
    }
    let k = 0
    for (const [e, n] of groups) {
      for (let j = 0; j < n; j++) {
        const m = baseModules(outfit)
        m.content = filled(pose, char)
        m.expression = filled(e, char)
        // 男性模块：基础描述 + 男性动作 + 男性表情 + 旧版男性模板 + 附加文本；未启用男性时一律为空
        m.male = maleOn ? maleModule(maleBase, [...malePoses, ...maleExprs, ...maleTs], it.male_extra ?? '', settings, char) : ['', '']
        m.camera = filled(camera, char)
        m.extra = [fillPlaceholders(it.extra_positive ?? '', char), fillPlaceholders(it.extra_negative ?? '', char)]
        // 新模块只在有内容时写入，旧任务的计划与快照结构保持不变
        if (interaction[0] || interaction[1]) m.interaction = interaction
        if (scene) m.scene = filled(scene, char)
        const meta: UnitMeta = {
          task: taskName,
          character: charName,
          story: story?.name ?? '',
          genre: story?.genre ?? '',
          section: '动作',
          item: label,
          item_no: pi + 1,
          outfit: outfit?.name ?? '',
          expression: e?.name ?? '',
          expression_n: j + 1,
          expression_of: n,
          camera: camera?.name ?? '',
          male: maleOn,
          male_templates: maleOn ? [...malePoses, ...maleExprs, ...maleTs].map((t) => t.name) : [],
          n: k + 1,
          of: count,
        }
        if (scene) meta.scene = scene.name
        if (position) meta.position = position.name
        if (sub) meta.subposition = sub.name
        if (acts.length) meta.acts = acts.map((a) => a.name)
        add('pose', pi, label, k, m, meta)
        k++
      }
    }
  })

  const base = toInt(data.seed_base)
  units.forEach((u, i) => {
    u.index = i
    u.seed = (((base + i) % SEED_MOD) + SEED_MOD) % SEED_MOD
    u.meta.index = i + 1
    u.meta.seed = u.seed
  })
  return { units, errors }
}
