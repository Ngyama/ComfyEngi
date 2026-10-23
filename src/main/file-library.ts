import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
export const FILE_TABLES = ['templates', 'characters', 'outfits', 'stories', 'workflows']
type Row = Record<string, any>
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
  constructor(public root: string) { this.scan() }
  changed() {
    try {
      const paths=[...files(join(this.root,'prompts')),...files(join(this.root,'workflows'))].filter(p=>/\.(md|json)$/.test(p))
      if(paths.length!==this.entries.size) return true
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
  }
  list(table: string): Row[] { return [...this.entries.values()].filter(e => e.row.type === table).map(e => ({...structuredClone(e.row), _revision:e.revision})).sort((a:Row,b:Row) => (a.sort??0)-(b.sort??0)||a.id-b.id) }
  save(table: string, rec: Row): number {
    this.scan()
    const old = rec.id ? this.entries.get(`${table}:${rec.id}`) : undefined
    if (rec.id && !old) throw new Error('资源已被删除，请刷新')
    if (old && (hash(readFileSync(old.path,'utf8')) !== old.revision || (rec._revision && rec._revision !== old.revision && !this.revisions.get(`${table}:${rec.id}`)?.has(rec._revision)))) throw new Error('外部编辑冲突：未覆盖文件。请复制当前草稿后刷新。')
    const id = rec.id || Math.max(Date.now(), ...this.list(table).map(r => r.id + 1))
    const row: Row = {name:'',positive:'',negative:'',note:'',sort:0,tag:'',category:'',tags:'',loras:[],scenes:[], ...old?.row,...rec,id,type:table}
    delete row._revision
    if (table === 'outfits' && !this.entries.has(`characters:${row.character_id}`)) throw new Error('服装角色不存在')
    const dir = table === 'templates' ? `prompts/${({pose:'poses',expression:'expressions',camera:'cameras',male:'male',global:'global',scene:'scenes',position:'positions',subposition:'positions',act:'acts'} as Row)[row.kind] || 'global'}` : table === 'workflows' ? 'workflows' : `prompts/${table}`
    mkdirSync(join(this.root,dir),{recursive:true})
    const path = old?.path || join(this.root,dir,`${id}-${randomUUID()}.${table==='workflows'?'json':'md'}`)
    if (!old && existsSync(path)) throw new Error('目标文件已存在')
    const text = table === 'workflows' ? JSON.stringify(row,null,2) : encode(row)
    const key = `${table}:${id}`
    if (old) { const revs=this.revisions.get(key)??new Set<string>(); revs.add(old.revision); this.revisions.set(key,revs) }
    atomic(path,text); this.entries.set(`${table}:${id}`,{path,row,revision:hash(text)})
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
