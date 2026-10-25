// 发布前检查：package.json 版本号必须是语义化版本；给出标签时必须等于 v<版本号>。
// 用法：node scripts/check-version.mjs [v0.2.1]
//   在 GitHub Actions 中未给参数时读取 GITHUB_REF_NAME。

import { readFileSync } from 'node:fs'

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const version = String(pkg.version ?? '')
const tag = process.argv[2] ?? (process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined)

const fail = (msg) => {
  console.error(`版本检查失败：${msg}`)
  process.exit(1)
}
if (!SEMVER.test(version)) fail(`package.json 的版本号「${version}」不是语义化版本（例如 0.2.1）`)
if (tag !== undefined && tag !== `v${version}`) fail(`标签「${tag}」与 package.json 版本 ${version} 不一致，标签应为 v${version}`)
console.log(`版本 ${version}${tag ? `，标签 ${tag}` : ''}：一致`)
console.log(`安装包：dist/ComfyEngi-${version}-setup.exe`)
