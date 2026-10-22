// start.bat 使用：源代码比 out/ 中的构建结果新时返回退出码 0（需要构建），否则返回 1。
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const built = join(root, 'out', 'main', 'index.js')
if (!existsSync(built)) process.exit(0)
const builtAt = statSync(built).mtimeMs
const newest = (dir) => {
  let t = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    t = Math.max(t, e.isDirectory() ? newest(p) : statSync(p).mtimeMs)
  }
  return t
}
const srcAt = Math.max(newest(join(root, 'src')), statSync(join(root, 'package.json')).mtimeMs)
process.exit(srcAt > builtAt ? 0 : 1)
