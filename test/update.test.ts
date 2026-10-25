// 手动检查更新：语义化版本比较，以及 GitHub 接口各种结果（同版本、新版本、无 Release、失败、超时、格式异常）。

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { compareVersions, interpretRelease, notesSummary, parseVersion, RELEASES_PAGE } from '@shared/update'
import { checkForUpdate } from '../src/main/update'

const v = (s: string) => parseVersion(s)!
const cmp = (a: string, b: string) => Math.sign(compareVersions(v(a), v(b)))

describe('版本号', () => {
  it('按数字比较而不是字符串', () => {
    expect(cmp('0.10.0', '0.9.0')).toBe(1)
    expect(cmp('v0.2.0', '0.2.0')).toBe(0)
    expect(cmp('1.0.0', '0.99.99')).toBe(1)
    expect(cmp('0.2.1', '0.2.10')).toBe(-1)
  })
  it('预发布版低于正式版，预发布标识按规则比较；构建元数据忽略', () => {
    expect(cmp('0.3.0-beta.1', '0.3.0')).toBe(-1)
    expect(cmp('0.3.0-beta.2', '0.3.0-beta.10')).toBe(-1)
    expect(cmp('0.3.0-alpha', '0.3.0-beta')).toBe(-1)
    expect(cmp('0.3.0-1', '0.3.0-alpha')).toBe(-1)
    expect(cmp('0.3.0+build.5', '0.3.0')).toBe(0)
  })
  it('格式异常返回 null', () => {
    for (const s of ['', 'latest', '0.2', '1.2.3.4', 'v01.2.3', '1.2.x', ' v', null, 3]) expect(parseVersion(s)).toBeNull()
  })
})

describe('解释 GitHub 返回结果', () => {
  const rel = (tag: string, body = '') => ({ tag_name: tag, name: `ComfyEngi ${tag}`, html_url: `${RELEASES_PAGE}/tag/${tag}`, body, published_at: '2026-10-01T00:00:00Z' })
  it('当前版本与最新 Release 相同 / 更旧的 Release：已是最新版', () => {
    expect(interpretRelease('0.2.0', 200, rel('v0.2.0'))).toMatchObject({ kind: 'latest', latest: '0.2.0' })
    expect(interpretRelease('0.2.0', 200, rel('v0.1.9'))).toMatchObject({ kind: 'latest' })
  })
  it('存在更高版本：返回版本号、说明摘要和 Release 页面', () => {
    const r = interpretRelease('0.2.0', 200, rel('v0.2.1', '## 更新内容\n- **修复** 保存问题\n- 新增 [文档](https://x)\n<!-- hidden -->'))
    expect(r).toMatchObject({ kind: 'available', latest: '0.2.1', url: `${RELEASES_PAGE}/tag/v0.2.1`, name: 'ComfyEngi v0.2.1' })
    expect(r.kind === 'available' && r.notes).toBe('更新内容\n- 修复 保存问题\n- 新增 文档')
  })
  it('没有任何 Release（404）不能当作已是最新版', () => {
    expect(interpretRelease('0.2.0', 404, { message: 'Not Found' }).kind).toBe('no-release')
  })
  it('限流、服务器错误', () => {
    expect(interpretRelease('0.2.0', 403, {}, { rateRemaining: '0' })).toMatchObject({ kind: 'error', message: expect.stringContaining('上限') })
    expect(interpretRelease('0.2.0', 500, null)).toMatchObject({ kind: 'error', message: expect.stringContaining('HTTP 500') })
  })
  it('版本号格式异常', () => {
    expect(interpretRelease('0.2.0', 200, rel('release-latest'))).toMatchObject({ kind: 'error', message: expect.stringContaining('release-latest') })
    expect(interpretRelease('0.2.0', 200, {})).toMatchObject({ kind: 'error' })
    expect(interpretRelease('dev', 200, rel('v0.2.1'))).toMatchObject({ kind: 'error', message: expect.stringContaining('dev') })
  })
  it('非本项目的链接退回 Release 列表页；说明摘要截断', () => {
    const r = interpretRelease('0.2.0', 200, { ...rel('v1.0.0'), html_url: 'https://evil.example/x' })
    expect(r.kind === 'available' && r.url).toBe(RELEASES_PAGE)
    expect(notesSummary(Array.from({ length: 20 }, (_, i) => `- 第 ${i} 项`).join('\n')).split('\n').length).toBe(9)
  })
})

describe('请求 GitHub（本地模拟接口）', () => {
  let server: Server | null = null
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())))
  const serve = (handler: Parameters<typeof createServer>[1]) =>
    new Promise<string>((resolve) => {
      server = createServer(handler).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}/latest`))
    })

  it('同版本、更高版本、无 Release', async () => {
    let reply: [number, unknown] = [200, { tag_name: 'v0.2.0', html_url: `${RELEASES_PAGE}/tag/v0.2.0` }]
    let ua = ''
    const url = await serve((req, res) => {
      ua = String(req.headers['user-agent'])
      res.writeHead(reply[0], { 'content-type': 'application/json' }).end(JSON.stringify(reply[1]))
    })
    expect((await checkForUpdate('0.2.0', { url })).kind).toBe('latest')
    expect(ua).toBe('ComfyEngi/0.2.0')
    reply = [200, { tag_name: 'v0.3.0', html_url: `${RELEASES_PAGE}/tag/v0.3.0`, body: '新功能' }]
    expect(await checkForUpdate('0.2.0', { url })).toMatchObject({ kind: 'available', latest: '0.3.0', notes: '新功能' })
    reply = [404, { message: 'Not Found' }]
    expect((await checkForUpdate('0.2.0', { url })).kind).toBe('no-release')
  })

  it('非 JSON 响应', async () => {
    const url = await serve((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<html>captive portal</html>'))
    expect((await checkForUpdate('0.2.0', { url })).kind).toBe('error')
  })

  it('超时', async () => {
    const url = await serve(() => {
      /* 不响应 */
    })
    const r = await checkForUpdate('0.2.0', { url, timeoutMs: 200 })
    expect(r).toMatchObject({ kind: 'error', message: expect.stringContaining('超时') })
    server!.closeAllConnections()
  })

  it('网络不可用', async () => {
    const r = await checkForUpdate('0.2.0', { url: 'http://127.0.0.1:1/latest', timeoutMs: 3000 })
    expect(r).toMatchObject({ kind: 'error', message: expect.stringContaining('无法连接 GitHub') })
  })
})
