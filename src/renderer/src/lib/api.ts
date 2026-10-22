import { toast } from 'sonner'
import type { RendererApi } from '@shared/api'

export const api: RendererApi = window.api

/** 调用 API 并把错误以 toast 显示；返回 undefined 表示失败 */
export async function call<T>(p: Promise<T>, onError?: (msg: string) => void): Promise<T | undefined> {
  try {
    return await p
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (onError) onError(msg)
    else toast.error(msg)
    return undefined
  }
}
