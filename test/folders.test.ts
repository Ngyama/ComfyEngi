// 角色文件夹：与 prompts/characters 下的真实目录一致。移动、重命名、空文件夹删除、外部变更，以及角色与服装、LoRA、任务的关联。

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { planForTask } from '../src/main/plan'
import { createVault, openVault } from '../src/main/vault'
import { tempDir } from './helpers'

function setup() {
  const root = tempDir()
  createVault(root)
  const s = openVault(root)
  const lib = s.files!
  const miyo = s.save('characters', { name: 'Miyo', positive: '1girl, miyo', loras: [{ resource_id: 'r1', name: 'miyo.safetensors', strength: 0.8 }] })
  const outfit = s.save('outfits', { character_id: miyo, name: '校服', positive: 'school uniform' })
  const pose = s.save('templates', { kind: 'pose', name: '站立', positive: 'standing' })
  const tid = s.save('tasks', { name: 't', data: { character_id: miyo, story_id: null, story_outfit_id: null, global_id: null, male_base_id: null, workflow_id: null, seed_base: 1, items: [{ pose_id: pose, outfit_id: outfit, expression_ids: [], count: 1, camera_id: null, male_enabled: false, male_ids: [], male_extra: '', extra_positive: '', extra_negative: '' }] } })
  const chars = join(root, 'prompts', 'characters')
  const plan = () => planForTask(s, s.get('tasks', tid)!).units.map((u) => [u.positive, u.loras])
  return { root, s, lib, miyo, outfit, tid, chars, plan }
}
const folderOf = (s: ReturnType<typeof openVault>, id: number) => s.list('characters').find((c) => c.id === id)?._folder

describe('角色文件夹', () => {
  it('创建文件夹与子文件夹，在指定文件夹内新建角色；文件夹列表与真实目录一致', () => {
    const { s, lib, chars } = setup()
    expect(lib.createFolder('', '主角')).toBe('主角')
    expect(lib.createFolder('主角', '女主')).toBe('主角/女主')
    expect(lib.createFolder('', '配角:临时?')).toBe('配角_临时_')
    expect(() => lib.createFolder('', '主角')).toThrow(/已存在/)
    expect(() => lib.createFolder('', '主角'.toUpperCase())).toThrow(/已存在/) // 中文无大小写，确保同名检测仍生效
    expect(() => lib.createFolder('../..', 'x')).toThrow(/无效的文件夹路径/)
    expect([...lib.folders()].sort()).toEqual(['主角', '主角/女主', '配角_临时_'].sort())
    const yuki = lib.save('characters', { name: 'Yuki', loras: [] }, { folder: '主角/女主' })
    expect(existsSync(join(chars, '主角', '女主', 'Yuki.md'))).toBe(true)
    expect(folderOf(s, yuki)).toBe('主角/女主')
    expect(readFileSync(join(chars, '主角', '女主', 'Yuki.md'), 'utf8')).not.toContain('_folder')
  })

  it('移动角色：稳定 ID、服装、LoRA 与任务都不变；同名时追加序号、不覆盖', () => {
    const { s, lib, miyo, outfit, chars, plan } = setup()
    const before = plan()
    const outfitPath = lib.entries.get(`outfits:${outfit}`)!.path
    lib.createFolder('', '主角')
    lib.moveCharacter(miyo, '主角')
    expect(existsSync(join(chars, '主角', 'Miyo.md'))).toBe(true)
    expect(existsSync(join(chars, 'Miyo.md'))).toBe(false)
    expect(folderOf(s, miyo)).toBe('主角')
    expect(s.get('characters', miyo)).toMatchObject({ id: miyo, name: 'Miyo', loras: [{ resource_id: 'r1' }] })
    expect(lib.entries.get(`outfits:${outfit}`)!.path).toBe(outfitPath) // 服装文件独立保存，不随角色移动
    expect(s.get('outfits', outfit)?.character_id).toBe(miyo)
    expect(plan()).toEqual(before)
    // 目标文件夹已有同名文件（例如用户手动放入的另一个 Miyo.md）：追加序号，原文件不被覆盖
    const other = s.save('characters', { name: 'Miyo', positive: 'another miyo', loras: [] })
    const otherText = readFileSync(lib.entries.get(`characters:${other}`)!.path, 'utf8')
    lib.moveCharacter(other, '主角')
    expect(basename(lib.entries.get(`characters:${other}`)!.path)).toBe('Miyo (2).md')
    expect(readFileSync(join(chars, '主角', 'Miyo.md'), 'utf8')).toContain('1girl, miyo')
    expect(readFileSync(join(chars, '主角', 'Miyo (2).md'), 'utf8')).toBe(otherText)
    // 移回根目录
    lib.moveCharacter(miyo, '')
    expect(folderOf(s, miyo)).toBe('')
    expect(() => lib.moveCharacter(miyo, '不存在')).toThrow(/文件夹不存在/)
  })

  it('移动前重新扫描：外部修改过的角色内容不会丢失', () => {
    const { lib, miyo } = setup()
    lib.createFolder('', '主角')
    const p = lib.entries.get(`characters:${miyo}`)!.path
    lib.scan()
    writeFileSync(p, readFileSync(p, 'utf8').replace('1girl, miyo', '1girl, miyo, edited'))
    // moveCharacter 会先重新扫描，读取到外部修改后的内容再移动，不会丢失
    lib.moveCharacter(miyo, '主角')
    expect(readFileSync(lib.entries.get(`characters:${miyo}`)!.path, 'utf8')).toContain('edited')
  })

  it('角色改名在所在文件夹内重命名文件；服装文件名跟随', () => {
    const { s, lib, miyo, outfit, chars } = setup()
    lib.createFolder('', '主角')
    lib.moveCharacter(miyo, '主角')
    s.save('characters', { id: miyo, name: '美代' })
    expect(existsSync(join(chars, '主角', '美代.md'))).toBe(true)
    expect(basename(lib.entries.get(`outfits:${outfit}`)!.path)).toBe('美代 - 校服.md')
  })

  it('重命名文件夹：内容与 ID 不变；不覆盖已有文件夹；大小写重命名', () => {
    const { s, lib, miyo, plan } = setup()
    const before = plan()
    lib.createFolder('', 'main')
    lib.createFolder('', '配角')
    lib.moveCharacter(miyo, 'main')
    expect(() => lib.renameFolder('main', '配角')).toThrow(/已存在/)
    expect(lib.renameFolder('main', 'Main')).toBe('Main')
    expect(lib.renameFolder('Main', '主角')).toBe('主角')
    expect(folderOf(s, miyo)).toBe('主角')
    expect(s.get('characters', miyo)?.name).toBe('Miyo')
    expect(plan()).toEqual(before)
    expect(() => lib.renameFolder('', 'x')).toThrow(/根目录/)
  })

  it('只能删除空文件夹，不会递归删除其中的角色', () => {
    const { lib, miyo, chars } = setup()
    lib.createFolder('', '主角')
    lib.createFolder('主角', '子')
    expect(() => lib.removeFolder('主角')).toThrow(/不为空/)
    lib.removeFolder('主角/子')
    lib.moveCharacter(miyo, '主角')
    expect(() => lib.removeFolder('主角')).toThrow(/不为空/)
    expect(existsSync(join(chars, '主角', 'Miyo.md'))).toBe(true)
    // 非 Markdown 文件也算内容，不会被删除
    lib.moveCharacter(miyo, '')
    writeFileSync(join(chars, '主角', 'notes.txt'), 'keep')
    expect(() => lib.removeFolder('主角')).toThrow(/不为空/)
    expect(readFileSync(join(chars, '主角', 'notes.txt'), 'utf8')).toBe('keep')
  })

  it('外部用资源管理器整理文件夹：重新打开 / 刷新后结构一致，关联不变，能检测到变化', () => {
    const { root, s, miyo, outfit, chars, plan } = setup()
    const before = plan()
    s.close()
    mkdirSync(join(chars, '外部', '深层'), { recursive: true })
    mkdirSync(join(chars, '空文件夹'))
    renameSync(join(chars, 'Miyo.md'), join(chars, '外部', '深层', 'Miyo.md'))
    const s2 = openVault(root)
    expect([...s2.files!.folders()].sort()).toEqual(['外部', '外部/深层', '空文件夹'].sort())
    expect(folderOf(s2, miyo)).toBe('外部/深层')
    expect(s2.get('outfits', outfit)?.character_id).toBe(miyo)
    expect(planForTask(s2, s2.get('tasks', s2.list('tasks')[0].id)!).units.map((u) => [u.positive, u.loras])).toEqual(before)
    // 打开后在外部新建空文件夹：能检测到变化，重新扫描后出现在列表中
    expect(s2.files!.changed()).toBe(false)
    mkdirSync(join(chars, '新的'))
    expect(s2.files!.changed()).toBe(true)
    s2.files!.scan()
    expect(s2.files!.folders()).toContain('新的')
    s2.close()
  })

  it('删除角色仍移入回收站（不是永久删除），服装一起移入', () => {
    const { root, s, lib, miyo } = setup()
    lib.createFolder('', '主角')
    lib.moveCharacter(miyo, '主角')
    s.remove('characters', miyo)
    expect(s.get('characters', miyo)).toBeNull()
    expect(readdirSync(join(root, '.comfyengi', 'trash')).length).toBe(2)
  })
})
