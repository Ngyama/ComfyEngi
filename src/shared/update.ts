// 手动检查更新：解析 GitHub Releases「最新正式版」接口的结果，并按语义化版本比较。
// 只判断与提示，不下载、不安装。

export const RELEASES_REPO = 'Ngyama/ComfyEngi'
export const RELEASES_PAGE = `https://github.com/${RELEASES_REPO}/releases`
export const LATEST_RELEASE_API = `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`

export type UpdateCheck =
  | { kind: 'latest'; current: string; latest: string; url: string }
  | { kind: 'available'; current: string; latest: string; url: string; name: string; notes: string; published_at: string | null }
  | { kind: 'no-release'; current: string; message: string }
  | { kind: 'error'; current: string; message: string }

export interface SemVer {
  major: number
  minor: number
  patch: number
  pre: (string | number)[]
}

const SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

/** 解析 1.2.3 / v1.2.3 / 1.2.3-beta.1（构建元数据 +xxx 忽略）；格式不符返回 null */
export function parseVersion(v: unknown): SemVer | null {
  if (typeof v !== 'string') return null
  const m = SEMVER.exec(v.trim())
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [] }
}

/** a < b 返回负数，相等 0，a > b 正数（规则同 semver.org：预发布版低于正式版） */
export function compareVersions(a: SemVer, b: SemVer): number {
  for (const k of ['major', 'minor', 'patch'] as const) if (a[k] !== b[k]) return a[k] - b[k]
  if (!a.pre.length || !b.pre.length) return (a.pre.length ? -1 : 0) - (b.pre.length ? -1 : 0)
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i]
    const y = b.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    if (typeof x === 'number' && typeof y === 'number') return x - y
    if (typeof x === 'number') return -1
    if (typeof y === 'number') return 1
    return x < y ? -1 : 1
  }
  return 0
}

/** 更新说明摘要：去掉 Markdown 标记，最多 maxLines 行 / maxChars 字 */
export function notesSummary(body: unknown, maxLines = 8, maxChars = 600): string {
  if (typeof body !== 'string') return ''
  const lines = body
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .map((l) => l.replace(/^#{1,6}\s+/, '').replace(/\*\*|__|`/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trimEnd())
    .filter((l) => l.trim())
  let out = lines.slice(0, maxLines).join('\n')
  if (out.length > maxChars) out = `${out.slice(0, maxChars).trimEnd()}…`
  else if (lines.length > maxLines) out += '\n…'
  return out
}

/**
 * 把 GitHub 接口的结果解释为检查结论。
 * status：HTTP 状态码；json：响应体（解析失败为 null）。
 * /releases/latest 只返回最新的正式版（不含草稿和预发布），没有正式版时返回 404。
 */
export function interpretRelease(current: string, status: number, json: unknown, headers: { rateRemaining?: string | null } = {}): UpdateCheck {
  const cur = parseVersion(current)
  if (!cur) return { kind: 'error', current, message: `当前版本号「${current}」格式无法识别，无法比较。` }
  if (status === 404) return { kind: 'no-release', current, message: '项目还没有发布任何正式版本（GitHub Releases 为空），暂时无法判断是否有更新。' }
  if (status === 403 || status === 429) {
    const limited = headers.rateRemaining === '0' || status === 429
    return { kind: 'error', current, message: limited ? 'GitHub 接口访问次数已达上限，请稍后（约一小时内）再试。' : `GitHub 拒绝了请求（HTTP ${status}），请稍后再试。` }
  }
  if (status < 200 || status >= 300) return { kind: 'error', current, message: `GitHub 请求失败（HTTP ${status}），请稍后再试。` }
  const r = (json ?? {}) as Record<string, unknown>
  const tag = typeof r.tag_name === 'string' ? r.tag_name : ''
  const latest = parseVersion(tag)
  if (!latest) return { kind: 'error', current, message: `最新发布的版本标签「${tag || '（空）'}」不是有效的版本号（应为 v1.2.3 形式），无法比较。` }
  const url = typeof r.html_url === 'string' && r.html_url.startsWith('https://github.com/') ? r.html_url : RELEASES_PAGE
  const latestText = tag.replace(/^v/, '')
  if (compareVersions(latest, cur) <= 0) return { kind: 'latest', current, latest: latestText, url }
  return {
    kind: 'available',
    current,
    latest: latestText,
    url,
    name: typeof r.name === 'string' && r.name.trim() ? r.name.trim() : tag,
    notes: notesSummary(r.body),
    published_at: typeof r.published_at === 'string' ? r.published_at : null,
  }
}
