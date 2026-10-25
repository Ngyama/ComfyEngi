// 手动检查更新：请求 GitHub「最新正式 Release」接口。只读取版本信息，不下载、不安装。

import { interpretRelease, LATEST_RELEASE_API, type UpdateCheck } from '@shared/update'

/** COMFYENGI_UPDATE_URL 仅用于测试（指向本地模拟接口） */
export async function checkForUpdate(current: string, opts: { url?: string; timeoutMs?: number; fetchImpl?: typeof fetch } = {}): Promise<UpdateCheck> {
  const url = opts.url || process.env.COMFYENGI_UPDATE_URL || LATEST_RELEASE_API
  const timeoutMs = opts.timeoutMs ?? 10000
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await (opts.fetchImpl ?? fetch)(url, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `ComfyEngi/${current}`, 'X-GitHub-Api-Version': '2022-11-28' },
      signal: ctrl.signal,
    })
    let json: unknown = null
    try {
      json = await res.json()
    } catch {
      /* 非 JSON 响应按状态码处理 */
    }
    if (res.ok && (json === null || typeof json !== 'object')) return { kind: 'error', current, message: 'GitHub 返回了无法识别的数据，请稍后再试。' }
    return interpretRelease(current, res.status, json, { rateRemaining: res.headers.get('x-ratelimit-remaining') })
  } catch (e) {
    const aborted = ctrl.signal.aborted || (e as Error).name === 'AbortError'
    return {
      kind: 'error',
      current,
      message: aborted ? `连接 GitHub 超时（${Math.round(timeoutMs / 1000)} 秒），请检查网络后重试。` : `无法连接 GitHub，请检查网络或代理设置后重试。（${(e as Error).message}）`,
    }
  } finally {
    clearTimeout(timer)
  }
}
