// 套图任务的 LoRA 配置（按工作流保存在任务中）：工作流里已有的 LoRA 是默认值，任务中可以添加、删除、替换、启用 / 停用和调整权重。
// 生成时根据任务配置计算 Loader 节点的输入值（与 Prompt、Seed 一样写入工作流副本），原始工作流与映射都不会被修改。
// - 多 LoRA Loader（loras.__value__，例如 Lora Loader (LoraManager)）：插件执行时只读取列表（text 不参与执行），
//   因此按配置重写列表，未修改的条目保持原始对象，并同步生成 text；删除的条目从列表移除，停用的条目 active=false。
// - 标准 Loader（lora_name / strength_*）：写入名称与权重；停用或删除时强度写 0（节点不能移除）。
// - 已在「高级映射」中绑定了 LoRA 槽位（lora1_name 等）的 Loader 由原有映射控制，不在这里重复控制。
// - 角色 LoRA：工作流中已有同名条目时关联该条目（不重复加载）；否则追加到唯一的多 LoRA Loader，或按任务中选择的位置追加 / 替换；
//   不会自动覆盖画风等固定 LoRA。第二角色未出场的图片中，关联或追加的条目不加载。

import { findLoraLoaders, isLink, loraStackOf, loraStackText, loraStem, parseLoraSource, parseStack, type LoraLoaderInfo } from './mapping'
import type { ApiWorkflow, InputValue, Lora, MappingEntry } from './types'

export interface WfLoraEntry {
  /** 稳定键：工作流原有条目为 `${node}:${原序号}`，任务中添加的为 `${node}:+随机` */
  key: string
  node: string
  /** 原列表中的序号（多 LoRA Loader）；标准 Loader 为 0；任务中添加的条目没有 */
  orig?: number
  name: string
  resource_id?: string
  strength: number
  clip: number
  enabled: boolean
}
export interface WfLoraConfig {
  /** 生成配置时工作流中可控制的 Loader 节点（之后新出现的节点使用工作流默认值） */
  nodes: string[]
  entries: WfLoraEntry[]
  /** 角色 LoRA 在工作流中没有同名条目时的加载位置：追加到某个多 LoRA Loader，或替换某个条目 */
  char_targets?: Record<string, { node: string; replace?: string }>
}

export type CharRole = 'lora1' | 'second_lora1'
export const CHAR_ROLES: CharRole[] = ['lora1', 'second_lora1']

/** 由高级映射控制的 Loader 节点（映射中有 LoRA 槽位来源的节点） */
export function mappedLoraNodes(mapping: MappingEntry[]): Set<string> {
  return new Set((mapping ?? []).filter((m) => parseLoraSource(m.source)).map((m) => String(m.node)))
}
/** 角色是否已由高级映射控制 */
export const roleMapped = (mapping: MappingEntry[], role: CharRole) => (mapping ?? []).some((m) => m.source === `${role}_name`)

/** 本任务可直接控制的 Loader：标准、兼容与多 LoRA Loader，且没有被高级映射控制 */
export function controllableLoaders(api: ApiWorkflow, mapping: MappingEntry[]): LoraLoaderInfo[] {
  const mapped = mappedLoraNodes(mapping)
  return findLoraLoaders(api).filter((l) => ['standard', 'compatible', 'stack'].includes(l.support) && !mapped.has(l.node))
}

const defaultsOf = (api: ApiWorkflow, ld: LoraLoaderInfo): WfLoraEntry[] => {
  if (ld.support === 'stack') return (ld.entries ?? []).map((e, i) => ({ key: `${ld.node}:${i}`, node: ld.node, orig: i, name: e.name, strength: e.strength, clip: e.clipStrength, enabled: e.active }))
  const i = api[ld.node].inputs
  const sm = typeof i.strength_model === 'number' ? i.strength_model : typeof i[ld.strengths[0]] === 'number' ? (i[ld.strengths[0]] as number) : 1
  const sc = typeof i.strength_clip === 'number' ? i.strength_clip : sm
  return [{ key: `${ld.node}:0`, node: ld.node, orig: 0, name: String(i.lora_name), strength: sm, clip: sc, enabled: true }]
}

/** 工作流默认的 LoRA 配置（导入 / 选择工作流后直接读取已有 LoRA，包括停用的条目） */
export function defaultLoraConfig(api: ApiWorkflow, mapping: MappingEntry[]): WfLoraConfig {
  const loaders = controllableLoaders(api, mapping)
  return { nodes: loaders.map((l) => l.node), entries: loaders.flatMap((l) => defaultsOf(api, l)) }
}

/** 本任务对某个工作流的有效配置：任务保存的配置 + 之后才出现的 Loader 的默认值；已不存在的节点忽略 */
export function effectiveLoraConfig(saved: WfLoraConfig | undefined, api: ApiWorkflow, mapping: MappingEntry[]): WfLoraConfig {
  const loaders = controllableLoaders(api, mapping)
  if (!saved) return defaultLoraConfig(api, mapping)
  const live = new Set(loaders.map((l) => l.node))
  const known = new Set(saved.nodes ?? [])
  const fresh = loaders.filter((l) => !known.has(l.node))
  return {
    nodes: loaders.map((l) => l.node),
    entries: [...saved.entries.filter((e) => live.has(e.node)), ...fresh.flatMap((l) => defaultsOf(api, l))],
    char_targets: Object.fromEntries(Object.entries(saved.char_targets ?? {}).filter(([, t]) => live.has(t.node))),
  }
}

/** 角色 LoRA 在本工作流中的位置：link 关联已有同名条目；append 追加到多 LoRA Loader；replace 替换某个条目；none 没有可用位置 */
export type RolePlacement = { kind: 'link'; key: string; node: string } | { kind: 'append'; node: string } | { kind: 'replace'; key: string; node: string } | { kind: 'none' }
export function rolePlacement(cfg: WfLoraConfig, loaders: LoraLoaderInfo[], role: CharRole, loraName: string): RolePlacement {
  const stem = loraStem(loraName).toLowerCase()
  const hit = cfg.entries.find((e) => loraStem(e.name).toLowerCase() === stem)
  if (hit) return { kind: 'link', key: hit.key, node: hit.node }
  const t = cfg.char_targets?.[role]
  if (t?.replace && cfg.entries.some((e) => e.key === t.replace)) return { kind: 'replace', key: t.replace, node: t.node }
  const stacks = loaders.filter((l) => l.support === 'stack')
  if (t && stacks.some((l) => l.node === t.node)) return { kind: 'append', node: t.node }
  if (stacks.length === 1) return { kind: 'append', node: stacks[0].node }
  return { kind: 'none' }
}

/** 一张图中角色 LoRA 的状态：要加载的 LoRA（含任务中的权重调整），或不加载（停用 / 第二角色未出场） */
export interface RoleState {
  /** 用于在工作流中查找同名条目的名称（即使这张图不加载也需要，用于停用关联的条目） */
  name: string
  load: Lora | null
}

const sameNum = (a: number, b: number) => Math.abs(a - b) < 1e-9

/**
 * 计算一张图中由任务 LoRA 配置控制的 Loader 输入值。没有任何变化的节点不写入（保持工作流原样）。
 * 返回值与 Prompt、Seed 等映射值一起冻结进执行队列，预览与提交使用同一份数据。
 */
export function loraConfigInputs(api: ApiWorkflow, mapping: MappingEntry[], cfg: WfLoraConfig, roles: Partial<Record<CharRole, RoleState>>): InputValue[] {
  const loaders = controllableLoaders(api, mapping)
  const out: InputValue[] = []
  // 角色 LoRA 的效果：按条目键（关联 / 替换）或按节点追加
  const driven = new Map<string, Lora | null>()
  const appended = new Map<string, Lora[]>()
  for (const role of CHAR_ROLES) {
    const r = roles[role]
    if (!r || roleMapped(mapping, role)) continue
    const p = rolePlacement(cfg, loaders, role, r.name)
    if (p.kind === 'link' || p.kind === 'replace') driven.set(p.key, r.load)
    else if (p.kind === 'append' && r.load) appended.set(p.node, [...(appended.get(p.node) ?? []), r.load])
  }
  for (const ld of loaders) {
    const node = api[ld.node]
    const entries = cfg.entries.filter((e) => e.node === ld.node)
    if (ld.support === 'stack') {
      const orig = loraStackOf(node) ?? []
      const origParsed = parseStack(orig)
      let changed = entries.length !== orig.length || entries.some((e, i) => e.orig !== i)
      const list: Record<string, unknown>[] = entries.map((e) => {
        const raw = e.orig != null ? orig[e.orig] : undefined
        const p = e.orig != null ? origParsed[e.orig] : undefined
        const ch = driven.has(e.key) ? driven.get(e.key) : undefined
        const v =
          ch !== undefined
            ? ch
              ? { name: loraStem(ch.name), strength: ch.strength, clipStrength: ch.strength_clip ?? ch.strength, active: true }
              : { name: loraStem(e.name), strength: e.strength, clipStrength: e.clip, active: false }
            : { name: loraStem(e.name), strength: e.strength, clipStrength: e.clip, active: e.enabled }
        if (raw && p && p.name === v.name && sameNum(p.strength, v.strength) && sameNum(p.clipStrength, v.clipStrength) && p.active === v.active) return raw
        changed = true
        return { ...(raw ?? { expanded: false, selected: false, locked: false }), ...v }
      })
      for (const l of appended.get(ld.node) ?? []) {
        const stem = loraStem(l.name)
        if (list.some((x) => String(x.name).toLowerCase() === stem.toLowerCase())) continue
        list.push({ name: stem, strength: l.strength, clipStrength: l.strength_clip ?? l.strength, active: true, expanded: false, selected: false, locked: false })
        changed = true
      }
      if (!changed) continue
      out.push({ node: ld.node, input: 'loras', source: 'lora_config', value: { ...(node.inputs.loras as object), __value__: list } })
      if (typeof node.inputs.text === 'string') out.push({ node: ld.node, input: 'text', source: 'lora_config', value: loraStackText(list) })
    } else {
      const e = entries[0]
      const ch = e && driven.has(e.key) ? driven.get(e.key) : undefined
      const load = ch !== undefined ? (ch ? { name: ch.name, model: ch.strength, clip: ch.strength_clip ?? ch.strength } : null) : e?.enabled ? { name: e.name, model: e.strength, clip: e.clip } : null
      const i = node.inputs
      const want: Record<string, unknown> = { lora_name: load ? load.name : i.lora_name }
      for (const k of ld.strengths) want[k] = load ? (/clip/i.test(k) ? load.clip : load.model) : 0
      for (const [k, v] of Object.entries(want)) if (i[k] !== v && !isLink(i[k])) out.push({ node: ld.node, input: k, source: 'lora_config', value: v })
    }
  }
  return out
}

/** 任务配置中的问题：不能安全执行的（errors）与需要注意的（warnings） */
export function loraConfigProblems(api: ApiWorkflow, mapping: MappingEntry[], cfg: WfLoraConfig, roles: Partial<Record<CharRole, RoleState & { label: string }>>): { errors: string[]; warnings: string[]; handled: Set<CharRole> } {
  const loaders = controllableLoaders(api, mapping)
  const errors: string[] = []
  const warnings: string[] = []
  const handled = new Set<CharRole>()
  for (const role of CHAR_ROLES) {
    const r = roles[role]
    if (!r || roleMapped(mapping, role)) continue
    const p = rolePlacement(cfg, loaders, role, r.name)
    if (p.kind === 'none') {
      if (r.load) errors.push(`${r.label}「${loraStem(r.name)}」不在当前工作流的 LoRA 列表中，也没有可以追加的多 LoRA Loader：请在 LoRA 配置中选择要替换的条目，或在本任务中停用它`)
    } else handled.add(role)
  }
  for (const ld of loaders)
    if (ld.support !== 'stack' && !ld.strengths.length && cfg.entries.some((e) => e.node === ld.node && !e.enabled))
      errors.push(`Loader #${ld.node}（${ld.class_type}）没有强度输入，无法停用其中的 LoRA`)
  for (const l of findLoraLoaders(api).filter((x) => x.support === 'unknown' || x.support === 'partial'))
    if (!mappedLoraNodes(mapping).has(l.node)) warnings.push(`节点 #${l.node}（${l.class_type}）无法安全识别，本任务不会修改它；需要控制时请在工作流映射中手动设置`)
  return { errors, warnings, handled }
}
