// Markdown 文件名与显示名称一致：新建、改名、非法字符、重名 / 大小写冲突、外部编辑冲突，以及旧版「ID-UUID」文件名的安全迁移。

import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileLibrary, safeFileName } from '../src/main/file-library'
import { planForTask } from '../src/main/plan'
import { createVault, openVault } from '../src/main/vault'
import { tempDir } from './helpers'

function vault() {
  const root = tempDir()
  createVault(root)
  return { root, s: openVault(root) }
}
const pathOf = (s: ReturnType<typeof openVault>, key: string) => s.files!.entries.get(key)!.path
const nameOf = (s: ReturnType<typeof openVault>, key: string) => basename(pathOf(s, key))
const mdFiles = (root: string) => (readdirSync(join(root, 'prompts'), { recursive: true }) as string[]).filter((f) => f.endsWith('.md')).sort()

describe('可读的 Markdown 文件名', () => {
  it('新建时按名称命名；服装带所属角色名', () => {
    const { s } = vault()
    const miyo = s.save('characters', { name: 'Miyo', positive: '1girl', loras: [] })
    const pose = s.save('templates', { kind: 'pose', name: '鸭子坐', positive: 'wariza' })
    const expr = s.save('templates', { kind: 'expression', name: '害羞', positive: 'blush' })
    const outfit = s.save('outfits', { character_id: miyo, name: '校服', positive: 'school uniform' })
    expect(nameOf(s, `characters:${miyo}`)).toBe('Miyo.md')
    expect(nameOf(s, `templates:${pose}`)).toBe('鸭子坐.md')
    expect(nameOf(s, `templates:${expr}`)).toBe('害羞.md')
    expect(nameOf(s, `outfits:${outfit}`)).toBe('Miyo - 校服.md')
    // 稳定 ID 保存在文件内部
    expect(readFileSync(pathOf(s, `templates:${pose}`), 'utf8')).toContain(`id: ${pose}`)
  })

  it('Windows 非法字符、保留名、空名称与过长名称', () => {
    expect(safeFileName('a/b:c*?"<>|d')).toBe('a_b_c______d')
    expect(safeFileName('CON')).toBe('CON_')
    expect(safeFileName('nul.txt')).toBe('nul.txt_')
    expect(safeFileName('   ')).toBe('未命名')
    expect(safeFileName('结尾的点...')).toBe('结尾的点')
    expect([...safeFileName('长'.repeat(200))].length).toBe(80)
    const { s } = vault()
    const id = s.save('templates', { kind: 'pose', name: 'POV: 坐/站?', positive: '' })
    expect(nameOf(s, `templates:${id}`)).toBe('POV_ 坐_站_.md')
  })

  it('重名与大小写冲突追加序号，不覆盖其他文件', () => {
    const { s } = vault()
    const a = s.save('templates', { kind: 'expression', name: '害羞', positive: 'a' })
    const b = s.save('templates', { kind: 'expression', name: '害羞', positive: 'b' })
    const c = s.save('characters', { name: 'Miyo', loras: [] })
    const d = s.save('characters', { name: 'miyo', loras: [] })
    expect(nameOf(s, `templates:${a}`)).toBe('害羞.md')
    expect(nameOf(s, `templates:${b}`)).toBe('害羞 (2).md')
    expect(nameOf(s, `characters:${c}`)).toBe('Miyo.md')
    expect(nameOf(s, `characters:${d}`)).toBe('miyo (2).md')
    // 把第三个改名为已存在的名称：得到新序号，原有文件内容不变
    const before = readFileSync(pathOf(s, `templates:${a}`), 'utf8')
    const e = s.save('templates', { kind: 'expression', name: '微笑', positive: 'e' })
    s.save('templates', { id: e, name: '害羞' })
    expect(nameOf(s, `templates:${e}`)).toBe('害羞 (3).md')
    expect(readFileSync(pathOf(s, `templates:${a}`), 'utf8')).toBe(before)
    expect(s.get('templates', e)?.positive).toBe('e')
  })

  it('改名同步重命名文件：ID、内容与任务引用不变；只改大小写也可以；角色改名时服装文件一起改名', () => {
    const { root, s } = vault()
    const g = s.save('templates', { kind: 'global', name: '画质', positive: 'masterpiece' })
    const miyo = s.save('characters', { name: 'Miyo', positive: '1girl, miyo', loras: [] })
    const outfit = s.save('outfits', { character_id: miyo, name: '校服', positive: 'school uniform' })
    const pose = s.save('templates', { kind: 'pose', name: '鸭子坐', positive: '(wariza:1.2), {a|b}' })
    const tid = s.save('tasks', { name: 't', data: { character_id: miyo, story_id: null, story_outfit_id: null, global_id: g, male_base_id: null, workflow_id: null, seed_base: 1, items: [{ pose_id: pose, outfit_id: outfit, expression_ids: [], count: 1, camera_id: null, male_enabled: false, male_ids: [], male_extra: '', extra_positive: '', extra_negative: '' }] } })
    const plan = () => planForTask(s, s.get('tasks', tid)!).units.map((u) => u.positive)
    const before = plan()
    const oldPath = pathOf(s, `templates:${pose}`)
    s.save('templates', { id: pose, name: '鸭子坐（新）' })
    expect(nameOf(s, `templates:${pose}`)).toBe('鸭子坐（新）.md')
    expect(existsSync(oldPath)).toBe(false)
    expect(s.get('templates', pose)).toMatchObject({ id: pose, positive: '(wariza:1.2), {a|b}' })
    s.save('characters', { id: miyo, name: 'MIYO' }) // 只改大小写
    expect(nameOf(s, `characters:${miyo}`)).toBe('MIYO.md')
    expect(nameOf(s, `outfits:${outfit}`)).toBe('MIYO - 校服.md')
    expect(plan()).toEqual(before)
    // 重新打开工作区后一切正常，没有多出或丢失文件
    const files = mdFiles(root)
    s.close()
    const s2 = openVault(root)
    expect(mdFiles(root)).toEqual(files)
    expect(s2.get('outfits', outfit)?.character_id).toBe(miyo)
    expect(planForTask(s2, s2.get('tasks', tid)!).units.map((u) => u.positive)).toEqual(before)
    s2.close()
  })

  it('外部编辑冲突：拒绝保存，文件内容与文件名都不变', () => {
    const { s } = vault()
    const id = s.save('templates', { kind: 'pose', name: '站立', positive: 'standing' })
    const path = pathOf(s, `templates:${id}`)
    const rev = s.get('templates', id)!._revision
    const external = readFileSync(path, 'utf8').replace('standing', 'standing, edited outside')
    writeFileSync(path, external)
    expect(() => s.save('templates', { id, _revision: rev, name: '坐姿' })).toThrow(/外部编辑冲突/)
    expect(readFileSync(path, 'utf8')).toBe(external)
    expect(basename(path)).toBe('站立.md')
  })
})

describe('旧版 ID-UUID 文件名迁移', () => {
  /** 模拟旧工作区：把文件改回「数字 ID-UUID.md」 */
  function legacyVault() {
    const { root, s } = vault()
    const miyo = s.save('characters', { name: 'Miyo', positive: '1girl', loras: [] })
    const outfit = s.save('outfits', { character_id: miyo, name: '校服', positive: 'uniform' })
    const p1 = s.save('templates', { kind: 'pose', name: '鸭子坐', positive: 'wariza' })
    const p2 = s.save('templates', { kind: 'pose', name: '鸭子坐', positive: 'wariza 2' })
    const e = s.save('templates', { kind: 'expression', name: 'CON', positive: 'x' })
    const keys = [`characters:${miyo}`, `outfits:${outfit}`, `templates:${p1}`, `templates:${p2}`, `templates:${e}`]
    const contents = new Map<string, string>()
    for (const k of keys) {
      const from = pathOf(s, k)
      const to = join(dirname(from), `${k.split(':')[1]}-${randomUUID()}.md`)
      renameSync(from, to)
      contents.set(k, readFileSync(to, 'utf8'))
    }
    s.close()
    return { root, keys, contents, ids: { miyo, outfit, p1, p2, e } }
  }

  it('打开工作区时迁移为可读名称：内容逐字节不变、稳定 ID 与引用关系不变，并记录日志', () => {
    const { root, keys, contents, ids } = legacyVault()
    const s = openVault(root)
    expect(keys.map((k) => nameOf(s, k))).toEqual(['Miyo.md', 'Miyo - 校服.md', '鸭子坐.md', '鸭子坐 (2).md', 'CON_.md'])
    for (const k of keys) expect(readFileSync(pathOf(s, k), 'utf8')).toBe(contents.get(k))
    expect(mdFiles(root).some((f) => /\d+-[0-9a-f-]{36}\.md$/.test(f))).toBe(false)
    expect(s.get('outfits', ids.outfit)?.character_id).toBe(ids.miyo)
    expect(s.get('templates', ids.p2)?.positive).toBe('wariza 2')
    const log = readFileSync(join(root, '.comfyengi', 'rename-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(log.length).toBe(5)
    s.close()
    // 再次打开不会重复迁移
    const s2 = openVault(root)
    expect(readFileSync(join(root, '.comfyengi', 'rename-log.jsonl'), 'utf8').trim().split('\n').length).toBe(5)
    s2.close()
  })

  it('迁移时文件被外部修改或目标被占用：跳过该文件并保留原名，不丢失、不覆盖', () => {
    const { root, keys } = legacyVault()
    const lib = new FileLibrary(root)
    const modified = lib.entries.get(keys[2])!.path
    writeFileSync(modified, readFileSync(modified, 'utf8') + '\n外部追加\n')
    const n = lib.migrateNames()
    expect(n).toBe(4)
    expect(existsSync(modified)).toBe(true)
    expect(readFileSync(modified, 'utf8')).toContain('外部追加')
    expect(lib.notices.some((x) => x.includes('已保留原文件名'))).toBe(true)
    // 第二个「鸭子坐」占用了「鸭子坐.md」时，被跳过的那个之后会得到新的序号而不是覆盖
    expect(basename(lib.entries.get(keys[3])!.path)).toBe('鸭子坐.md')
    const lib2 = new FileLibrary(root)
    lib2.migrateNames()
    expect(basename(lib2.entries.get(keys[2])!.path)).toBe('鸭子坐 (2).md')
    expect(readFileSync(lib2.entries.get(keys[3])!.path, 'utf8')).toContain('wariza 2')
  })
})
