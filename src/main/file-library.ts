import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'
export const FILE_TABLES = ['templates', 'characters', 'outfits', 'stories', 'workflows']
type Row = Record<string, any>

// Markdown 文件名与显示名称一致（稳定 ID 保存在文件内部，文件名只是可读标签）
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
/** 旧版文件名：数字 ID + 随机 UUID */
export const LEGACY_NAME = /^\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.md$/i
export function safeFileName(name: string): string {
  let s = String(name ?? '').normalize('NFC').replace(ILLEGAL, '_').replace(/\s+/g, ' ').trim()
  s = [...s].slice(0, 80).join('').replace(/[. ]+$/, '').trim()
  if (!s) s = '未命名'
  if (RESERVED.test(s.split('.')[0])) s += '_'
  return s
}
export function atomic(file: string, value: string) {
  const tmp = file + '.' + randomUUID() + '.tmp'
  writeFileSync(tmp, value, { flag: 'wx' }); renameSync(tmp, file)
}
export function encode(row: Row): string {
  return '---\n' + Object.entries(row).filter(([k]) => !k.startsWith('_')).map(([k,v]) => `${k}: ${JSON.stringify(v)}`).join('\n') + '\n---\n'
}
export function decode(text: string): Row {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (!match) throw new Error('无效 Frontmatter')
  const row: Row = {}
  for (const line of match[1].split(/\r?\n/)) {
    const m = /^(\w+): (.+)$/.exec(line)
    if (!m || m[1] in row) throw new Error('字段格式无效或重复')
    row[m[1]] = JSON.parse(m[2])
  }
  if (!Number.isSafeInteger(row.id) || row.id <= 0 || !FILE_TABLES.includes(row.type)) throw new Error('缺失或无效的稳定 ID / type')
  for (const k of ['positive','negative','name']) if (k in row && typeof row[k] !== 'string') throw new Error(`无效 ${k}`)
  if (row.type === 'stories' && !Array.isArray(row.scenes)) throw new Error('无效 scenes')
  return row
}
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isSymbolicLink() ? [] : e.isDirectory() ? files(join(dir,e.name)) : [join(dir,e.name)])
}
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
export class FileLibrary {
  entries = new Map<string, { path: string; row: Row; revision: string }>()
  private revisions = new Map<string, Set<string>>()
  errors: string[] = []
  /** 非致命提示（例如重命名失败、已保留原文件名） */
  notices: string[] = []
  private folderSig = ''
  constructor(public root: string) { this.scan() }

  /** 期望的文件名（不含扩展名与重名序号）。服装带上所属角色名，避免各角色的同名服装难以区分 */
  private baseName(row: Row): string {
    if (row.type === 'outfits') return safeFileName(`${this.entries.get(`characters:${row.character_id}`)?.row.name || '未命名'} - ${row.name || '未命名'}`)
    return safeFileName(row.name)
  }
  private fits(path: string, base: string): boolean {
    const b = basename(path).replace(/\.md$/, '').normalize('NFC')
    return b === base || (b.startsWith(base) && /^ \(\d+\)$/.test(b.slice(base.length)))
  }
  /** 同目录下未被占用的文件名：大小写不敏感比较（Windows），重名时追加 (2)、(3)… */
  private freePath(dir: string, base: string, self?: string): string {
    const taken = new Set(readdirSync(dir).map((f) => f.normalize('NFC').toLowerCase()))
    const own = self ? basename(self).normalize('NFC').toLowerCase() : null
    for (let n = 1; ; n++) {
      const name = `${base}${n > 1 ? ` (${n})` : ''}.md`
      if (!taken.has(name.toLowerCase()) || name.toLowerCase() === own) return join(dir, name)
    }
  }
  /**
   * 把条目的文件改名为 target，绝不覆盖其他文件：优先用硬链接（目标存在时直接失败）再删除旧名；
   * 文件被外部修改过、目标已存在或任何一步失败时保留原文件名，内容不受影响。
   */
  private move(key: string, target: string): boolean {
    const e = this.entries.get(key)
    if (!e || e.path === target) return true
    const from = e.path
    try {
      if (hash(readFileSync(from, 'utf8')) !== e.revision) throw new Error('文件已被外部修改')
      if (from.toLowerCase() === target.toLowerCase()) {
        // 只改大小写：经临时名两步改名，第二步失败时改回
        const tmp = `${from}.${randomUUID()}.renaming`
        renameSync(from, tmp)
        try { renameSync(tmp, target) } catch (err) { renameSync(tmp, from); throw err }
      } else {
        let linked = false
        try { linkSync(from, target); linked = true } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('目标文件已存在')
        }
        if (linked) {
          try { unlinkSync(from) } catch (err) { unlinkSync(target); throw err }
        } else {
          // 文件系统不支持硬链接（如 exFAT）：先确认目标不存在再改名
          if (existsSync(target)) throw new Error('目标文件已存在')
          renameSync(from, target)
        }
      }
      e.path = target
      try {
        mkdirSync(join(this.root, '.comfyengi'), { recursive: true })
        appendFileSync(join(this.root, '.comfyengi', 'rename-log.jsonl'), JSON.stringify({ time: new Date().toISOString(), key, from, to: target }) + '\n')
      } catch { /* 日志写入失败不影响改名 */ }
      return true
    } catch (err) {
      this.notices.push(`未能把 ${from} 重命名为 ${basename(target)}，已保留原文件名：${(err as Error).message}`)
      return false
    }
  }
  /** 让 Markdown 文件名与名称一致（名称未变化时不动） */
  private syncName(key: string): boolean {
    const e = this.entries.get(key)
    if (!e || !e.path.endsWith('.md')) return true
    const base = this.baseName(e.row)
    if (this.fits(e.path, base)) return true
    return this.move(key, this.freePath(dirname(e.path), base, e.path))
  }
  /** 迁移旧版「数字 ID-UUID.md」文件名：只改文件名，内容、稳定 ID 与引用关系不变。返回改名数量 */
  migrateNames(): number {
    let n = 0
    const keys = [...this.entries.entries()].filter(([, e]) => LEGACY_NAME.test(basename(e.path))).sort(([a], [b]) => Number(b.startsWith('characters')) - Number(a.startsWith('characters'))).map(([k]) => k)
    for (const key of keys) if (this.syncName(key)) n++
    return n
  }
  /**
   * 「单人动作」pose 与「行为」act 合并为「状态」：只把 frontmatter 的 kind 改为 state 并记录 legacy_kind，
   * 文件位置、稳定 ID、名称、Prompt 等其他字段不变。改写前把原文件复制到 backupDir（保持相对路径）。
   * 外部修改过（与扫描结果不一致）的文件跳过并提示，下次打开时再迁移；未迁移的文件界面中仍按状态显示。返回迁移数量
   */
  migrateStateKinds(backupDir: string): number {
    const todo = [...this.entries.entries()].filter(([, e]) => e.row.type === 'templates' && (e.row.kind === 'pose' || e.row.kind === 'act'))
    let n = 0
    for (const [key, e] of todo) {
      try {
        const text = readFileSync(e.path, 'utf8')
        if (hash(text) !== e.revision) throw new Error('文件已被外部修改')
        const copy = join(backupDir, relative(this.root, e.path))
        mkdirSync(dirname(copy), { recursive: true })
        writeFileSync(copy, text, { flag: 'wx' })
        const row = { ...e.row, kind: 'state', legacy_kind: e.row.kind }
        const next = encode(row)
        atomic(e.path, next)
        this.entries.set(key, { path: e.path, row, revision: hash(next) })
        n++
      } catch (err) {
        this.notices.push(`未能把 ${e.path} 迁移为「状态」，已保持原样：${(err as Error).message}`)
      }
    }
    if (n) {
      try {
        mkdirSync(join(this.root, '.comfyengi'), { recursive: true })
        appendFileSync(join(this.root, '.comfyengi', 'migration-log.jsonl'), JSON.stringify({ time: new Date().toISOString(), migration: 'state-kinds', count: n, backup: backupDir }) + '\n')
      } catch { /* 日志写入失败不影响迁移 */ }
    }
    return n
  }
  // ---------------- 角色文件夹：与 prompts/characters 下的真实目录一致，只用于组织（不写入角色文件）

  private get charRoot() { return join(this.root, 'prompts', 'characters') }
  /** 解析界面传来的文件夹相对路径（'/' 分隔，'' 为根目录）：不允许 .. 、非法字符或越出角色目录 */
  private folderPath(rel: string, mustExist = true): string {
    const segs = String(rel ?? '').split('/').filter(Boolean)
    for (const s of segs) if (s === '.' || s === '..' || /[<>:"/\\|?*\u0000-\u001f]/.test(s)) throw new Error(`无效的文件夹路径：${rel}`)
    const p = join(this.charRoot, ...segs)
    if (mustExist && !(existsSync(p) && statSync(p).isDirectory())) throw new Error(`文件夹不存在：${rel || '（根目录）'}，可能已在外部被移动，请刷新`)
    return p
  }
  private relFolder(dir: string): string {
    const r = relative(this.charRoot, dir)
    return r && !r.startsWith('..') ? r.split(sep).join('/') : ''
  }
  /** 所有角色文件夹（含空文件夹与子文件夹），跳过以 . 开头的隐藏目录 */
  folders(): string[] {
    const out: string[] = []
    const walk = (dir: string) => {
      if (!existsSync(dir)) return
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name.startsWith('.')) continue
        out.push(this.relFolder(join(dir, e.name)))
        walk(join(dir, e.name))
      }
    }
    walk(this.charRoot)
    return out.sort((a, b) => a.localeCompare(b, 'zh'))
  }
  /** 同一目录下是否已有同名项目（文件或文件夹，大小写不敏感） */
  private taken(dir: string, name: string, self?: string): boolean {
    const n = name.normalize('NFC').toLowerCase()
    return readdirSync(dir).some((f) => f.normalize('NFC').toLowerCase() === n && f !== self)
  }
  createFolder(parent: string, name: string): string {
    const dir = this.folderPath(parent)
    const n = safeFileName(name)
    if (this.taken(dir, n)) throw new Error(`「${n}」已存在`)
    mkdirSync(join(dir, n))
    return this.relFolder(join(dir, n))
  }
  /** 重命名文件夹（只改最后一段名称）：不覆盖已存在的同名项目；文件内容与稳定 ID 不变 */
  renameFolder(rel: string, name: string): string {
    if (!String(rel ?? '').split('/').filter(Boolean).length) throw new Error('不能重命名根目录')
    const from = this.folderPath(rel)
    const n = safeFileName(name)
    const to = join(dirname(from), n)
    if (to === from) return rel
    if (this.taken(dirname(from), n, basename(from))) throw new Error(`「${n}」已存在`)
    if (from.toLowerCase() === to.toLowerCase()) {
      const tmp = `${from}.${randomUUID()}.renaming`
      renameSync(from, tmp)
      try { renameSync(tmp, to) } catch (err) { renameSync(tmp, from); throw err }
    } else {
      if (existsSync(to)) throw new Error(`「${n}」已存在`)
      renameSync(from, to)
    }
    try {
      appendFileSync(join(this.root, '.comfyengi', 'rename-log.jsonl'), JSON.stringify({ time: new Date().toISOString(), folder: true, from, to }) + '\n')
    } catch { /* 日志写入失败不影响改名 */ }
    this.scan()
    return this.relFolder(to)
  }
  /** 只删除空文件夹（非递归）：文件夹里有任何文件或子文件夹时拒绝，不会删除其中的角色 */
  removeFolder(rel: string) {
    if (!String(rel ?? '').split('/').filter(Boolean).length) throw new Error('不能删除根目录')
    const p = this.folderPath(rel)
    const n = readdirSync(p).length
    if (n) throw new Error(`文件夹「${rel}」不为空（包含 ${n} 个项目），请先移出其中的角色或子文件夹`)
    rmdirSync(p)
  }
  /** 把角色文件移到另一个文件夹：只移动该角色的 Markdown（服装文件独立保存、按稳定 ID 关联，不受影响），不覆盖同名文件 */
  moveCharacter(id: number, folder: string) {
    this.scan()
    const key = `characters:${id}`
    const e = this.entries.get(key)
    if (!e) throw new Error('角色已被删除，请刷新')
    const dir = this.folderPath(folder)
    if (dirname(e.path) === dir) return
    if (!this.move(key, this.freePath(dir, this.baseName(e.row)))) throw new Error(this.notices[this.notices.length - 1] ?? '移动失败')
  }

  changed() {
    try {
      const paths=[...files(join(this.root,'prompts')),...files(join(this.root,'workflows'))].filter(p=>/\.(md|json)$/.test(p))
      if(paths.length!==this.entries.size) return true
      if(this.folders().join('\n')!==this.folderSig) return true
      return [...this.entries.values()].some(e=>!existsSync(e.path)||hash(readFileSync(e.path,'utf8'))!==e.revision)
    } catch { return true }
  }
  scan() {
    const next = new Map<string, { path: string; row: Row; revision: string }>(); const errors: string[] = []
    for (const file of [...files(join(this.root,'prompts')), ...files(join(this.root,'workflows'))].filter(p => /\.(md|json)$/.test(p))) {
      try {
        const text = readFileSync(file,'utf8'); const row = file.endsWith('.md') ? decode(text) : JSON.parse(text)
        if (!FILE_TABLES.includes(row.type) || !Number.isSafeInteger(row.id) || row.id <= 0) throw new Error('无效资源')
        const key = `${row.type}:${row.id}`
        if (next.has(key)) throw new Error(`重复 ID ${key}`)
        next.set(key,{path:file,row,revision:hash(text)})
      } catch(e) { errors.push(`${file}: ${(e as Error).message}`) }
    }
    for (const e of next.values()) {
      const r=e.row
      if(r.type==='outfits' && !next.has(`characters:${r.character_id}`)) errors.push(`${e.path}: 角色引用不存在`)
      if(r.type==='characters' && !Array.isArray(r.loras)) errors.push(`${e.path}: 无效 loras`)
      if(r.type==='stories' && (!Array.isArray(r.scenes) || r.scenes.some((s:Row)=>typeof s.positive!=='string'||typeof s.negative!=='string'))) errors.push(`${e.path}: 无效 scenes`)
    }
    this.errors = errors
    if (errors.length) throw new Error(errors.join('\n'))
    for (const [key,e] of next) if (this.entries.get(key)?.revision !== e.revision) this.revisions.delete(key)
    this.entries = next
    this.folderSig = this.folders().join('\n')
  }
  /** 角色额外带上所在文件夹 _folder（由文件位置决定，以 _ 开头，不会写入文件） */
  list(table: string): Row[] { return [...this.entries.values()].filter(e => e.row.type === table).map(e => ({...structuredClone(e.row), _revision:e.revision, ...(table === 'characters' ? {_folder:this.relFolder(dirname(e.path))} : {})})).sort((a:Row,b:Row) => (a.sort??0)-(b.sort??0)||a.id-b.id) }
  /** opts.folder：新建角色时放入的文件夹（已存在的角色保持原位置） */
  save(table: string, rec: Row, opts: { folder?: string } = {}): number {
    this.scan()
    const old = rec.id ? this.entries.get(`${table}:${rec.id}`) : undefined
    if (rec.id && !old) throw new Error('资源已被删除，请刷新')
    if (old && (hash(readFileSync(old.path,'utf8')) !== old.revision || (rec._revision && rec._revision !== old.revision && !this.revisions.get(`${table}:${rec.id}`)?.has(rec._revision)))) throw new Error('外部编辑冲突：未覆盖文件。请复制当前草稿后刷新。')
    const id = rec.id || Math.max(Date.now(), ...this.list(table).map(r => r.id + 1))
    const row: Row = {name:'',positive:'',negative:'',note:'',sort:0,tag:'',category:'',tags:'',loras:[],scenes:[], ...old?.row,...rec,id,type:table}
    delete row._revision
    delete row._folder
    if (table === 'outfits' && !this.entries.has(`characters:${row.character_id}`)) throw new Error('服装角色不存在')
    const dir = table === 'templates' ? `prompts/${({state:'states',pose:'poses',expression:'expressions',camera:'cameras',male:'male',global:'global',scene:'scenes',position:'positions',subposition:'positions',act:'acts'} as Row)[row.kind] || 'global'}` : table === 'workflows' ? 'workflows' : `prompts/${table}`
    mkdirSync(join(this.root,dir),{recursive:true})
    const newDir = table === 'characters' && opts.folder ? this.folderPath(opts.folder) : join(this.root,dir)
    const path = old?.path || (table === 'workflows' ? join(this.root,dir,`${id}-${randomUUID()}.json`) : this.freePath(newDir, this.baseName(row)))
    if (!old && existsSync(path)) throw new Error('目标文件已存在')
    const text = table === 'workflows' ? JSON.stringify(row,null,2) : encode(row)
    const key = `${table}:${id}`
    if (old) { const revs=this.revisions.get(key)??new Set<string>(); revs.add(old.revision); this.revisions.set(key,revs) }
    atomic(path,text); this.entries.set(`${table}:${id}`,{path,row,revision:hash(text)})
    // 先保存内容，再按名称改文件名；改名失败只保留原文件名，不影响已保存的内容
    if (old && old.row.name !== row.name) {
      this.syncName(key)
      if (table === 'characters') for (const [k, e] of this.entries) if (e.row.type === 'outfits' && e.row.character_id === id) this.syncName(k)
    }
    return id
  }
  remove(table:string,id:number) {
    this.scan()
    const old = this.entries.get(`${table}:${id}`); if (!old) return
    if (hash(readFileSync(old.path,'utf8')) !== old.revision) throw new Error('外部编辑冲突，请刷新')
    const trash = join(this.root,'.comfyengi','trash'); mkdirSync(trash,{recursive:true})
    renameSync(old.path,join(trash,`${randomUUID()}-${id}.${table==='workflows'?'json':'md'}`)); this.entries.delete(`${table}:${id}`)
  }
}
