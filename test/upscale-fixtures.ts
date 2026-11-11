// 批量放大测试共用的数据：用户的真实结构（样本图片的 prompt 元数据与放大工作流），以及 README 中说明的放大映射。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { newEntry, TRIGGER_DISABLE, UPSCALE_CHECKPOINT, UPSCALE_IMAGE, UPSCALE_LORA, UPSCALE_OUTPUT } from '@shared/mapping'
import type { ApiWorkflow, MappingEntry } from '@shared/types'
import { makePng } from './mining-fixtures'

export const SAMPLE = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'upscale-sample-prompt.json'), 'utf8')) as { prompt: ApiWorkflow; toggle_00022: ApiWorkflow[string] }
export const SAMPLE_UP: ApiWorkflow = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'upscale-workflow-sample.json'), 'utf8'))

/** README 中说明的放大映射：正面 / 负面写入上游的通配符节点，#34 禁止注入 */
export const SAMPLE_UP_MAP: MappingEntry[] = [
  newEntry(UPSCALE_IMAGE, '163', 'image'),
  newEntry('positive', '3', 'populated_text'),
  newEntry('positive', '3', 'wildcard_text'),
  newEntry('negative', '4', 'populated_text'),
  newEntry('negative', '4', 'wildcard_text'),
  newEntry(UPSCALE_CHECKPOINT, '30', 'ckpt_name'),
  newEntry(UPSCALE_LORA, '5', 'loras'),
  newEntry(TRIGGER_DISABLE, '34', 'toggle_trigger_words'),
  newEntry(UPSCALE_OUTPUT, '121', 'filename_prefix'),
]

export const SAMPLE_TRIGGERS =
  'long hair, two side up, crossed bangs, pink hair, multicolored eyes, hair flower, black rose, SajunaSchool, serafuku, red sailor collar, yellow bow, sweater vest, black vest, short sleeves, pleated skirt, red skirt, black_thighhighs'
export const SAMPLE_POSITIVE = `${SAMPLE_TRIGGERS},${String(SAMPLE.prompt['3'].inputs.populated_text)}`

/** 与 ComfyUI 的 json.dumps 相同：非 ASCII 字符写成 \uXXXX（tEXt 块是 latin1） */
export function asciiJson(v: unknown): string {
  const bs = String.fromCharCode(92)
  // 按 UTF-16 码元逐个转义（与 Python 相同，补充平面字符写成代理对）
  return JSON.stringify(v)
    .split('')
    .map((c) => (c.charCodeAt(0) > 127 ? `${bs}u${c.charCodeAt(0).toString(16).padStart(4, '0')}` : c))
    .join('')
}

/** ComfyUI 保存的 PNG：tEXt 中的 prompt（API 工作流），可选 workflow */
export function comfyPng(prompt: ApiWorkflow | null, extra: Record<string, string> = {}): Buffer {
  return makePng({ ...(prompt ? { prompt: asciiJson(prompt) } : {}), ...extra })
}
