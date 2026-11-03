// LoRA 资源与 ComfyUI 加载名称。ComfyUI 按 models/loras 下的相对路径加载 LoRA，而 LoRA 管理扫描的目录不一定就是
// ComfyUI 的 loras 目录，所以加载名称（comfyName）要由用户确认；没有确认时只给出建议，提交前 resolveLoraName 会报错，不猜测路径。

import type { LoraResource } from './types'

/** 可以选择的 LoRA：LoRA 管理中识别到、文件仍在的全部资源（不要求已经设置加载名称） */
export const selectableLoras = (list: LoraResource[]) => list.filter((r) => !r.missing && !r.offline)

/** 按扫描目录下的相对路径建议的加载名称（Windows 路径用反斜杠，与 ComfyUI 在 Windows 上的列表一致） */
export const suggestedComfyName = (r: Pick<LoraResource, 'path' | 'relativePath'>) => (/^[a-z]:[\\/]/i.test(r.path) ? r.relativePath.replaceAll('/', '\\') : r.relativePath)

/** 这个资源提交时会使用的加载名称；不能使用时说明原因（与 resolveLoraName 的检查相同） */
export function loadNameOf(r: LoraResource): { name: string; ok: boolean; reason: string } {
  if (r.missing) return { name: r.comfyName, ok: false, reason: '模型文件缺失' }
  if (r.offline) return { name: r.comfyName, ok: false, reason: '所在目录无法访问' }
  if (!r.comfyName) return { name: '', ok: false, reason: '尚未设置 ComfyUI 模型名称' }
  if (/^(?:[A-Za-z]:|[\\/])/.test(r.comfyName) || r.comfyName.split(/[\\/]/).includes('..')) return { name: r.comfyName, ok: false, reason: 'ComfyUI 模型名称必须是 loras 目录下的相对路径' }
  return { name: r.comfyName, ok: true, reason: '' }
}
