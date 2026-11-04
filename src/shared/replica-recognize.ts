// 套图复刻：识别每张原图 Prompt 中「要替换的开头」「要删除的旧角色 / 服装 Tag」与「保留片段」。
// 全部是启发式规则（Tag 拆分、顺序、整套共同前缀、出现频率、常见镜头 Tag、1girl 等人数 Tag 之后的角色 Tag、服装词表），
// 不调用模型，也不保证正确：规则判断不可靠的图片会标记为「需要处理」，由用户修正或确认后才会生成，不会静默当作识别成功。
//
// 保留片段 = 第一个镜头 Tag（含）及之后的内容，再删除其中的旧角色、服装 Tag 与 <lora:…> 文字；其余内容逐字节保留
// （权重、括号、换行与顺序不变，删除使用与旧版相同的 applyTagReplacement）。

import { applyTagReplacement, promptUsable, type ReplacePart, type ReplicaData } from './replica'
import { joinModules } from './prompt'
import { normalizeKey, parseToken, topLevelSegments } from './tags'

export type TagClass = 'quality' | 'count' | 'camera' | 'name' | 'appearance' | 'outfit' | 'lora' | 'other'
/** 整套的 Tag 分类修正：character / outfit 删除，keep 保留（即使被识别为角色或服装） */
export type TagFix = 'character' | 'outfit' | 'keep'
/** 单张图的修正：remove 删除，keep 保留，优先于整套 */
export type ImageTagFix = 'remove' | 'keep'

// ---------------- 词表（比较键：小写、空格与下划线统一为下划线，去掉转义）

const CAMERA = new Set([
  'from_side', 'from_above', 'from_below', 'from_behind', 'from_front', 'from_outside', 'side_view', 'back_view', 'rear_view', 'front_view', 'profile',
  'cowboy_shot', 'full_body', 'upper_body', 'lower_body', 'close-up', 'close_up', 'closeup', 'extreme_close-up', 'portrait', 'wide_shot', 'very_wide_shot',
  'medium_shot', 'long_shot', 'dutch_angle', 'pov', 'straight-on', 'low_angle', 'high_angle', "bird's-eye_view", 'birds-eye_view', 'aerial_view', 'fisheye',
  'head_out_of_frame', 'feet_out_of_frame', 'out_of_frame', 'panorama', 'foreshortening', 'perspective', 'facing_viewer', 'facing_away', 'multiple_views',
  'three-quarter_view', 'over_the_shoulder', 'selfie', 'pov_hands', 'vanishing_point',
])
const CAMERA_RE = /^(.+_shot|.+_angle|from_(side|above|below|behind|front))$/

const QUALITY = new Set(['masterpiece', 'best_quality', 'high_quality', 'amazing_quality', 'good_quality', 'normal_quality', 'very_aesthetic', 'aesthetic', 'absurdres', 'highres', 'lowres', 'ultra-detailed', 'ultra_detailed', 'extremely_detailed', 'highly_detailed', 'detailed', '8k', '4k', 'newest', 'recent', 'official_art', 'illustration', 'anime_coloring', 'safe', 'sensitive', 'general', 'questionable', 'explicit', 'nsfw', 'sfw', 'depth_of_field', 'bokeh', 'detailed_background', 'incredibly_absurdres', 'hdr', 'uhd'])
const QUALITY_RE = /^(score_\d+(_up)?|rating_.+|year_\d{4}|source_.+|artist:.+|by_.+|.+_style|.+_quality|artist_.+)$/

const COUNT_RE = /^((\d+|multiple)_?(girls?|boys?|others?|futas?)|solo|solo_focus|no_humans)$/

const APPEARANCE_LAST = new Set(['hair', 'eyes', 'eye', 'bangs', 'ponytail', 'ponytails', 'twintails', 'braid', 'braids', 'bun', 'buns', 'ahoge', 'sidelocks', 'pupils', 'skin', 'ears', 'tail', 'tails', 'horns', 'horn', 'wings', 'halo', 'freckles', 'mole', 'fang', 'fangs', 'breasts', 'eyebrows', 'eyelashes', 'heterochromia', 'hime_cut', 'cut', 'drills', 'forehead', 'tan', 'tanlines', 'elf', 'antenna', 'hairlocks'])
const APPEARANCE_WHOLE = new Set(['dark-skinned_female', 'dark-skinned_male', 'pointy_ears', 'animal_ears', 'flat_chest', 'petite', 'mature_female', 'aged_down', 'loli', 'shota', 'kemonomimi_mode'])
/** 表情、动作与状态：即使以 hair / eyes 结尾也不算角色外貌 */
const NOT_APPEARANCE_FIRST = new Set(['closed', 'half-closed', 'covering', 'rolling', 'wiping', 'hand', 'hands', 'grabbing', 'holding', 'playing', 'touching', 'adjusting', 'pulling', 'tucking', 'wet', 'messy', 'floating', 'flipped', 'tying', 'untying', 'one', 'wide', 'empty', 'glowing', 'crying', 'tears', 'licking', 'biting', 'spread', 'looking'])

const OUTFIT_LAST = new Set([
  'uniform', 'serafuku', 'dress', 'skirt', 'miniskirt', 'shirt', 't-shirt', 'blouse', 'jacket', 'coat', 'hoodie', 'sweater', 'cardigan', 'vest', 'pants', 'shorts', 'jeans', 'leggings',
  'thighhighs', 'kneehighs', 'pantyhose', 'stockings', 'socks', 'legwear', 'boots', 'shoes', 'sneakers', 'heels', 'sandals', 'slippers', 'loafers', 'gloves', 'mittens', 'hat', 'cap',
  'beret', 'helmet', 'hood', 'ribbon', 'bow', 'bowtie', 'necktie', 'collar', 'choker', 'scarf', 'cape', 'cloak', 'kimono', 'yukata', 'hakama', 'swimsuit', 'bikini', 'leotard', 'bodysuit',
  'apron', 'bra', 'panties', 'underwear', 'lingerie', 'nightgown', 'pajamas', 'robe', 'armor', 'garter', 'garters', 'belt', 'suspenders', 'earrings', 'necklace', 'bracelet', 'hairband',
  'headband', 'hairclip', 'ornament', 'headwear', 'headdress', 'headpiece', 'glasses', 'eyewear', 'sleeves', 'neckerchief', 'frills', 'clothes', 'clothing', 'outfit', 'costume', 'attire',
  'sportswear', 'swimwear', 'top', 'corset', 'camisole', 'chemise', 'tunic', 'sash', 'obi', 'tabard', 'overalls', 'tights', 'sweatshirt', 'turtleneck', 'blazer', 'pinafore', 'jumpsuit',
  'cheongsam', 'qipao', 'hairpin', 'hair_flower', 'veil', 'tiara', 'crown', 'brooch', 'pendant', 'anklet', 'wristband', 'wristwatch', 'tie', 'jersey',
])
const OUTFIT_WHOLE = new Set(['maid', 'nun', 'bunny_girl', 'playboy_bunny', 'school_swimsuit', 'gym_uniform', 'hair_ornament', 'hair_ribbon', 'hair_bow', 'detached_sleeves', 'sailor_collar'])
/** 动作与状态：以服装词结尾但描述的是动作（holding hat、no panties） */
const NOT_OUTFIT_FIRST = new Set(['holding', 'adjusting', 'pulling', 'lifting', 'removing', 'taking', 'tugging', 'grabbing', 'touching', 'no', 'hand', 'hands', 'biting', 'untying', 'tying', 'unbuttoning', 'undressing', 'wringing', 'covering'])

const words = (key: string) => key.split('_').filter(Boolean)
const lastWord = (key: string) => words(key).at(-1) ?? ''
const firstWord = (key: string) => words(key)[0] ?? ''

/** 紧跟在人数 Tag 后、但明显不是角色名的常见 Tag（表情、视线、姿势、背景） */
const NOT_NAME = /^(looking_.+|facing_.+|open_.+|closed_.+|parted_.+|.+_background|smile|grin|blush|standing|sitting|lying|kneeling|squatting|walking|running|outdoors|indoors|day|night|upper_teeth_only|expressionless|:d|:o|;d|:3)$/

/** 动态语法 {a|b}、交替 [a|b]、调度 [a:b:0.5] */
const DYNAMIC_RE = /\{[^{}]*\|[^{}]*\}|\[[^[\]]*\|[^[\]]*\]|\[[^[\]]*:[^[\]]*:[^[\]]*\]/

/** 角色名写法：name (series)，或带系列名的 Tag */
const isName = (key: string) => /_\(.+\)$/.test(key) && !/^(artist|by)_/.test(key)
const isLoraText = (raw: string) => /^<\s*lora:/i.test(raw.trim())

export function classifyTag(key: string, raw: string, extraCamera?: Set<string>): TagClass {
  if (isLoraText(raw)) return 'lora'
  if (CAMERA.has(key) || CAMERA_RE.test(key) || extraCamera?.has(key)) return 'camera'
  if (COUNT_RE.test(key)) return 'count'
  if (QUALITY.has(key) || QUALITY_RE.test(key)) return 'quality'
  if (OUTFIT_WHOLE.has(key) || (OUTFIT_LAST.has(lastWord(key)) && !NOT_OUTFIT_FIRST.has(firstWord(key)))) return 'outfit'
  if (APPEARANCE_WHOLE.has(key) || (APPEARANCE_LAST.has(lastWord(key)) && !NOT_APPEARANCE_FIRST.has(firstWord(key)))) return 'appearance'
  if (isName(key)) return 'name'
  return 'other'
}

/** 镜头模板（素材库 kind = camera）中的 Tag：作为额外的镜头词 */
export function cameraKeysOf(templates: { kind: string; positive?: string }[]): string[] {
  const out = new Set<string>()
  for (const t of templates) {
    if (t.kind !== 'camera') continue
    for (const s of topLevelSegments(t.positive ?? '').segments) {
      const k = parseToken(s.raw)?.key
      if (k && !COUNT_RE.test(k) && !QUALITY.has(k)) out.add(k)
    }
  }
  return [...out]
}

// ---------------- 识别

export interface RecognizeImage {
  positive: string
  /** Prompt 可用（读取成功或用户确认）；不可用的图片不参与整套统计 */
  usable: boolean
  cut: number | null
  tag_fix: Record<string, ImageTagFix>
  retained_manual: string | null
  accepted: string | null
  /** 额外的不可靠原因（例如旧版手动编辑过的最终 Prompt） */
  extra_issue?: string
}
export interface RecognizeOptions {
  tag_fix: Record<string, TagFix>
  /** 手动指定的共同前缀（Tag 文本）；null 为自动 */
  prefix_text: string | null
  /** 额外镜头 Tag 的比较键（素材库镜头模板） */
  camera_keys?: string[]
}

export interface Seg {
  raw: string
  key: string
  cls: TagClass
  start: number
  end: number
}
export type SegRole = 'prefix' | 'common' | 'camera' | 'keep' | 'character' | 'outfit' | 'lora'
export interface ImageRecognition {
  /** Prompt 可以安全拆分（括号配对） */
  splittable: boolean
  segments: (Seg & { role: SegRole })[]
  /** 第一个保留的顶层 Tag 的序号（等于 segments.length 时没有保留内容） */
  cut: number
  /** camera：第一个镜头 Tag；prefix：没有镜头 Tag，按共同前缀结尾；manual：手动指定；none：无法判断（从开头保留） */
  cut_reason: 'camera' | 'prefix' | 'manual' | 'none'
  /** 被替换的开头（原文） */
  prefix: string
  /** 保留部分中删除的旧角色 / 服装 Tag 与 LoRA 文字（原始写法） */
  removed_character: string[]
  removed_outfit: string[]
  removed_other: string[]
  /** 最终保留片段 */
  retained: string
  retained_parts: ReplacePart[]
  manual: boolean
  /** 识别不可靠的原因（空为可靠） */
  issues: string[]
  /** 需要用户处理：有问题、不是手动片段，且没有确认过当前结果 */
  needs_fix: boolean
}
export interface TagSummary {
  key: string
  raw: string
  /** 出现的图片数 */
  count: number
  /** auto：规则识别；fix：用户修正 */
  source: 'auto' | 'fix'
}
export interface SetRecognition {
  /** 共同前缀（比较键）与原文 */
  prefix_keys: string[]
  prefix_raw: string
  prefix_auto: boolean
  /** 以共同前缀开头的图片数 / 参与统计的图片数 */
  prefix_matches: number
  usable: number
  character: TagSummary[]
  outfit: TagSummary[]
  /** 用户标记为保留的 Tag */
  kept: TagSummary[]
  images: ImageRecognition[]
}

const keyOf = (raw: string) => parseToken(raw)?.key ?? normalizeKey(raw)

export function segmentsOf(text: string, extraCamera?: Set<string>): { segs: Seg[]; balanced: boolean } {
  const { segments, balanced } = topLevelSegments(String(text ?? ''))
  return { segs: segments.map((s) => { const key = keyOf(s.raw); return { raw: s.raw, key, cls: classifyTag(key, s.raw, extraCamera), start: s.start, end: s.end } }), balanced }
}

/** 共同前缀：每个位置取最多的 Tag，仍然一致的图片不少于 max(2, 60%) 时继续 */
export function commonPrefix(lists: string[][]): string[] {
  if (lists.length < 2) return []
  const need = Math.max(2, Math.ceil(lists.length * 0.6))
  let alive = lists
  const out: string[] = []
  for (let i = 0; ; i++) {
    const freq = new Map<string, number>()
    for (const l of alive) if (l[i] !== undefined) freq.set(l[i], (freq.get(l[i]) ?? 0) + 1)
    const best = [...freq].sort((a, b) => b[1] - a[1])[0]
    if (!best || best[1] < need) break
    out.push(best[0])
    alive = alive.filter((l) => l[i] === best[0])
  }
  return out
}

const startsWith = (keys: string[], prefix: string[]) => prefix.length > 0 && prefix.every((k, i) => keys[i] === k)

/** 识别整套图片。结果只由输入决定：同样的图片与修正得到同样的结果（预览与入队一致） */
export function recognizeReplica(images: RecognizeImage[], opt: RecognizeOptions): SetRecognition {
  const extraCamera = new Set(opt.camera_keys ?? [])
  const parsed = images.map((im) => segmentsOf(im.positive, extraCamera))
  const usableIdx = images.map((im, i) => (im.usable && parsed[i].balanced ? i : -1)).filter((i) => i >= 0)
  const manualPrefix = opt.prefix_text !== null && opt.prefix_text !== undefined
  const prefixSegs = manualPrefix ? segmentsOf(opt.prefix_text!, extraCamera).segs : []
  let prefixKeys = manualPrefix ? prefixSegs.map((s) => s.key) : commonPrefix(usableIdx.map((i) => parsed[i].segs.map((s) => s.key)))
  // 自动前缀在第一个镜头 Tag 处截断（镜头属于保留内容）
  if (!manualPrefix) {
    const cam = prefixKeys.findIndex((k) => classifyTag(k, k, extraCamera) === 'camera')
    if (cam >= 0) prefixKeys = prefixKeys.slice(0, cam)
  }
  const prefixRaw = manualPrefix ? opt.prefix_text!.trim() : (usableIdx.map((i) => parsed[i]).find((p) => startsWith(p.segs.map((s) => s.key), prefixKeys))?.segs.slice(0, prefixKeys.length).map((s) => s.raw).join(', ') ?? '')

  // 每张图的分割位置（不依赖角色 / 服装分类）
  const cuts = images.map((im, i) => {
    const segs = parsed[i].segs
    const n = segs.length
    if (im.cut !== null && Number.isInteger(im.cut) && im.cut >= 0) return { cut: Math.min(im.cut, n), reason: 'manual' as const }
    const cam = segs.findIndex((s) => s.cls === 'camera')
    if (cam >= 0) return { cut: cam, reason: 'camera' as const }
    if (startsWith(segs.map((s) => s.key), prefixKeys)) return { cut: prefixKeys.length, reason: 'prefix' as const }
    return { cut: 0, reason: 'none' as const }
  })

  // 整套的角色 / 服装 Tag
  const total = usableIdx.length || 1
  const charAuto = new Map<string, { raw: string; imgs: Set<number> }>()
  const outfitAuto = new Map<string, { raw: string; imgs: Set<number> }>()
  const seen = new Map<string, { raw: string; imgs: Set<number> }>()
  const add = (m: Map<string, { raw: string; imgs: Set<number> }>, s: Seg, i: number) => {
    const e = m.get(s.key) ?? { raw: s.raw, imgs: new Set<number>() }
    e.imgs.add(i)
    m.set(s.key, e)
  }
  for (const i of usableIdx) {
    const segs = parsed[i].segs
    const cut = cuts[i].cut
    let afterCount = false
    segs.forEach((s, j) => {
      add(seen, s, i)
      if (s.cls === 'outfit') add(outfitAuto, s, i)
      else if (s.cls === 'name') add(charAuto, s, i)
      else if (j < cut) {
        // 开头部分：人数 Tag 之后紧跟的未知 Tag 视为角色名或触发词；外貌 Tag 都属于角色
        if (s.cls === 'appearance') add(charAuto, s, i)
        else if (s.cls === 'other' && afterCount && !NOT_NAME.test(s.key)) add(charAuto, s, i)
      }
      afterCount = s.cls === 'count' || (afterCount && j < cut && (s.cls === 'appearance' || s.cls === 'name'))
    })
  }
  // 保留部分中的外貌 Tag：在至少一半图片中出现时视为角色的固定特征（偶尔出现的多是状态，例如 wet hair）
  for (const [key, e] of seen) {
    if (charAuto.has(key)) continue
    const s = { key, raw: e.raw }
    if (classifyTag(s.key, s.raw, extraCamera) === 'appearance' && e.imgs.size / total >= 0.5) charAuto.set(key, e)
  }
  const fix = opt.tag_fix ?? {}
  const countOf = (key: string) => seen.get(key)?.imgs.size ?? 0
  const rawOf = (key: string) => seen.get(key)?.raw ?? key
  const charKeys = new Set<string>()
  const outfitKeys = new Set<string>()
  for (const k of charAuto.keys()) if (!fix[k]) charKeys.add(k)
  for (const k of outfitAuto.keys()) if (!fix[k] && !charKeys.has(k)) outfitKeys.add(k)
  for (const [k, v] of Object.entries(fix)) {
    if (v === 'character') charKeys.add(k)
    else if (v === 'outfit') outfitKeys.add(k)
  }
  const summary = (keys: Iterable<string>): TagSummary[] => [...keys].map((key) => ({ key, raw: rawOf(key), count: countOf(key), source: fix[key] ? ('fix' as const) : ('auto' as const) })).sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1))

  const results = images.map((im, i): ImageRecognition => {
    const { segs, balanced } = parsed[i]
    const { cut, reason } = cuts[i]
    const issues: string[] = []
    const removeKeys = new Set<string>()
    const roleOf = (s: Seg, j: number): SegRole => {
      if (j < cut) return j < prefixKeys.length && s.key === prefixKeys[j] ? 'common' : 'prefix'
      const f = im.tag_fix[s.key]
      if (s.cls === 'lora' && f !== 'keep') return 'lora'
      if (f === 'keep') return s.cls === 'camera' ? 'camera' : 'keep'
      if (f === 'remove') return outfitKeys.has(s.key) ? 'outfit' : 'character'
      if (fix[s.key] === 'keep') return s.cls === 'camera' ? 'camera' : 'keep'
      if (charKeys.has(s.key)) return 'character'
      if (outfitKeys.has(s.key)) return 'outfit'
      return s.cls === 'camera' ? 'camera' : 'keep'
    }
    const segments = segs.map((s, j) => ({ ...s, role: roleOf(s, j) }))
    for (const s of segments) if (s.role === 'character' || s.role === 'outfit' || s.role === 'lora') removeKeys.add(s.key)
    // 组合 (a, b) 中的单个 Tag：按整套与单张的修正删除
    for (const [k, v] of Object.entries(im.tag_fix)) if (v === 'remove') removeKeys.add(k)
    for (const k of [...charKeys, ...outfitKeys]) if (im.tag_fix[k] !== 'keep' && fix[k] !== 'keep') removeKeys.add(k)
    for (const [k, v] of Object.entries(im.tag_fix)) if (v === 'keep') removeKeys.delete(k)
    const src = String(im.positive ?? '')
    const prefixText = cut > 0 && segs[cut - 1] ? src.slice(0, segs[cut - 1].end).trim() : ''
    const retainedRaw = cut < segs.length ? src.slice(segs[cut].start) : ''
    const manual = im.retained_manual !== null
    let retained = ''
    let parts: ReplacePart[] = []
    const removedChar: string[] = []
    const removedOutfit: string[] = []
    const removedOther: string[] = []
    if (manual) {
      retained = im.retained_manual!
      parts = [{ kind: 'keep', text: retained }]
    } else if (!balanced) {
      retained = ''
      parts = [{ kind: 'keep', text: src }]
      issues.push('括号不配对，无法自动拆分：请手动填写保留片段')
    } else {
      const r = applyTagReplacement(retainedRaw, removeKeys, '')
      retained = r.text.trim()
      parts = r.parts
      for (const raw of r.removed) {
        const k = removedKeyOf(raw)
        if (isLoraText(raw) || !k) removedOther.push(raw)
        else if (charKeys.has(k)) removedChar.push(raw)
        else if (outfitKeys.has(k)) removedOutfit.push(raw)
        else removedOther.push(raw)
      }
      if (r.status === 'group') issues.push(`${r.grouped.join('、')} 在动态语法或无法安全拆开的写法里，没有自动删除：请手动编辑保留片段`)
      // 动态 / 调度语法里的内容无法逐个判断是否属于旧角色或旧服装
      else if (DYNAMIC_RE.test(retained)) issues.push('保留片段中有动态语法或调度语法（{a|b}、[a:b:0.5] 等），其中的旧角色或旧服装 Tag 无法自动判断：请确认或手动编辑保留片段')
    }
    if (!manual && balanced) {
      if (reason === 'prefix') issues.push('没有找到镜头 Tag：按整套共同前缀的结尾分割，请确认保留的起点')
      if (reason === 'none') issues.push(prefixKeys.length ? '没有找到镜头 Tag，开头也与整套的共同前缀不同：无法判断保留的起点，请在 Tag 上点击「从这里保留」' : '没有找到镜头 Tag：无法判断保留的起点，请在 Tag 上点击「从这里保留」，或确认保留整段')
      // 被替换的开头里有不像全局 / 角色 / 服装的内容（可能是动作或场景）
      const odd = segments.slice(0, cut).filter((s) => s.role === 'prefix' && s.cls === 'other' && !charKeys.has(s.key) && !outfitKeys.has(s.key) && fix[s.key] !== 'keep')
      if (odd.length) issues.push(`被替换的开头中有 ${odd.length} 个 Tag 不属于共同前缀，也不像角色或服装（${odd.slice(0, 4).map((s) => s.raw).join('、')}${odd.length > 4 ? ' 等' : ''}），会被丢弃：请确认，或把保留起点移到它们之前`)
      const keptPrefixFix = segments.slice(0, cut).filter((s) => fix[s.key] === 'keep' || im.tag_fix[s.key] === 'keep')
      if (keptPrefixFix.length) issues.push(`${keptPrefixFix.map((s) => s.raw).join('、')} 标记为保留，但在保留起点之前，会随开头一起被替换：请移动保留起点`)
    }
    if (!retained.trim()) issues.push(manual ? '手动填写的保留片段为空' : '保留片段为空')
    if (im.extra_issue && !manual) issues.push(im.extra_issue)
    if (!im.usable) issues.unshift('没有可靠读取到 Prompt')
    const needs_fix = !im.usable || (manual ? !retained.trim() : issues.length > 0 && im.accepted !== retained)
    return { splittable: balanced, segments, cut, cut_reason: reason, prefix: prefixText, removed_character: removedChar, removed_outfit: removedOutfit, removed_other: removedOther, retained, retained_parts: parts, manual, issues, needs_fix }
  })

  const kept = Object.entries(fix).filter(([, v]) => v === 'keep').map(([k]) => k)
  return {
    prefix_keys: prefixKeys,
    prefix_raw: prefixRaw,
    prefix_auto: !manualPrefix,
    prefix_matches: usableIdx.filter((i) => startsWith(parsed[i].segs.map((s) => s.key), prefixKeys)).length,
    usable: usableIdx.length,
    character: summary(charKeys),
    outfit: summary([...outfitKeys].filter((k) => !charKeys.has(k))),
    kept: summary(kept),
    images: results,
  }
}

/** 删除记录中的原始写法 → 比较键（组合内的子 Tag 可能带自己的权重） */
export function removedKeyOf(raw: string): string | null {
  return parseToken(raw.replace(/:\s*-?\d+(?:\.\d+)?\s*$/, ''))?.key ?? null
}

/** 草稿 → 识别结果（预览、计划与入队都调用这里，结果相同）；排除的图片也识别，但不参与整套统计 */
export function recognizeDraft(data: Pick<ReplicaData, 'images' | 'tag_fix' | 'prefix_text'>, cameraKeys: string[] = []): SetRecognition {
  return recognizeReplica(
    data.images.map((im) => ({
      positive: promptUsable(im) ? im.positive : '',
      usable: promptUsable(im) && !im.exclude,
      cut: im.cut,
      tag_fix: im.tag_fix,
      retained_manual: im.retained_manual,
      accepted: im.accepted,
      ...(im.legacy?.manual_positive !== undefined ? { extra_issue: '旧版中手动编辑过这张图的最终 Prompt（含旧版插入的角色 Prompt），无法自动迁移：请确认新的保留片段，或参考旧版手动 Prompt 手动填写' } : {}),
    })),
    { tag_fix: data.tag_fix, prefix_text: data.prefix_text, camera_keys: cameraKeys },
  )
}

// ---------------- 最终正向 Prompt（固定规则）

/** 原图开头（被替换的部分）里的人数 Tag（1girl、solo 等），原写法、去重；手动片段时取整段原 Prompt */
export function countTagsOf(r: ImageRecognition): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const s of r.manual ? r.segments : r.segments.slice(0, r.cut)) {
    if (s.cls !== 'count' || seen.has(s.key)) continue
    seen.add(s.key)
    out.push(s.raw)
  }
  return out
}

/** 文字中第一组连续人数 Tag 的结束位置；没有时为 -1 */
function countRunEnd(text: string): number {
  const segs = topLevelSegments(text).segments
  const i = segs.findIndex((s) => COUNT_RE.test(keyOf(s.raw)))
  if (i < 0) return -1
  let j = i
  while (j + 1 < segs.length && COUNT_RE.test(keyOf(segs[j + 1].raw))) j++
  return segs[j].end
}

export interface ReplicaPromptInput {
  global: string
  scene: string
  retained: string
  character: string
  outfit: string
  /** 原图开头里的人数 Tag（见 countTagsOf） */
  count: string[]
}
export interface ReplicaPrompt {
  positive: string
  /** 显示用：按来源分段，顺序与 positive 相同 */
  parts: { module: string; text: string }[]
  /** 写入工作流的模块文字（角色与服装已经插入到其中一个模块，character / outfit 模块的正向为空） */
  modules: { global: string; scene: string; camera: string }
}

const edgeTrim = (s: string) => s.replace(/^[\s,]+|[\s,]+$/g, '')

/**
 * 套图复刻的最终正向 Prompt：新角色与新服装紧跟在人数 Tag（1girl, solo 等）之后。
 * 依次在全局 / 画风、场景、保留片段中找第一组连续的人数 Tag，插在这组之后；
 * 都没有时使用原图开头的人数 Tag，与角色、服装一起放在保留片段之前；原图也没有时，角色与服装放在保留片段之前。
 */
export function replicaPositive(p: ReplicaPromptInput, moduleSep: string, tagSep: string, trim = true): ReplicaPrompt {
  const ins = [
    { module: 'character', text: edgeTrim(p.character ?? '') },
    { module: 'outfit', text: edgeTrim(p.outfit ?? '') },
  ].filter((x) => x.text)
  const insText = ins.map((x) => x.text).join(tagSep)
  const mods = { global: p.global ?? '', scene: p.scene ?? '', camera: p.retained ?? '' }
  const order = ['global', 'scene', 'camera'] as const
  const join = (m: typeof mods) => joinModules([m.global, m.scene, m.camera], moduleSep, trim)
  for (const m of order) {
    const end = countRunEnd(mods[m])
    if (end < 0) continue
    const before = mods[m].slice(0, end)
    const after = mods[m].slice(end)
    const out = { ...mods, [m]: insText ? `${before}${tagSep}${insText}${after}` : mods[m] }
    const parts: { module: string; text: string }[] = []
    for (const k of order) {
      if (k !== m) {
        if (mods[k].trim()) parts.push({ module: k, text: mods[k].trim() })
        continue
      }
      parts.push({ module: k, text: before.trim() }, ...ins)
      if (edgeTrim(after)) parts.push({ module: k, text: edgeTrim(after) })
    }
    return { positive: join(out), parts, modules: out }
  }
  const countText = p.count.map((t) => t.trim()).filter(Boolean).join(tagSep)
  const lead = [countText, insText].filter(Boolean).join(tagSep)
  const out = { ...mods, camera: joinModules([lead, mods.camera], moduleSep, trim) }
  const parts = [
    ...(['global', 'scene'] as const).filter((k) => mods[k].trim()).map((k) => ({ module: k, text: mods[k].trim() })),
    ...(countText ? [{ module: 'count', text: countText }] : []),
    ...ins,
    ...(mods.camera.trim() ? [{ module: 'camera', text: mods.camera.trim() }] : []),
  ]
  return { positive: join(out), parts, modules: out }
}
