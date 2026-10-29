import { isDeepStrictEqual } from 'node:util'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { FileLibrary, FILE_TABLES, atomic, encode } from './file-library'
import { Store, TABLES, type TableName } from './store'
import { planForTask } from './plan'
export function createVault(root:string, legacy?:string) {
  if (legacy && !existsSync(legacy)) throw new Error('旧版数据库不存在，请创建空工作区或检查旧数据目录')
  mkdirSync(root,{recursive:true})
  const dirs = ['prompts','loras','workflows','output','data','logs','.comfyengi']
  if (dirs.some(d => existsSync(join(root,d)))) throw new Error('请选择空目录，已有工作区请使用打开')
  const stage = join(root,`.comfyengi-import-${Date.now()}`); mkdirSync(stage)
  const published: string[] = []
  let store: Store | undefined
  try {
    for (const d of ['prompts/characters','prompts/outfits','prompts/poses','prompts/expressions','prompts/cameras','prompts/male','prompts/global','prompts/stories','loras/metadata','loras/previews','workflows','output','data','logs','.comfyengi']) mkdirSync(join(stage,d),{recursive:true})
    if (legacy && existsSync(legacy)) {
      const source = new DatabaseSync(legacy,{readOnly:true})
      try { source.prepare('VACUUM INTO ?').run(join(stage,'data','comfyengi.db')) } finally { source.close() }
    }
    store = new Store(join(stage,'data','comfyengi.db'),{backupDir:join(stage,'data','backups')})
    store.backup(join(stage,'data','backups'),'before-markdown')
    const before = store.list('tasks').map(t => planForTask(store!,t,undefined,'2000-01-01'))
    const library = new FileLibrary(stage)
    for (const table of FILE_TABLES as TableName[]) for (const row of store.list(table)) {
      const copy = {...row} as Record<string,any>; delete copy.id
      const created = library.save(table,copy)
      const entry = library.entries.get(`${table}:${created}`)!
      entry.row.id = row.id
      atomic(entry.path,table === 'workflows' ? JSON.stringify(entry.row,null,2) : encode(entry.row))
      library.scan()
    }
    for (const table of FILE_TABLES as TableName[]) {
      const originals = store.list(table)
      for (const row of originals) {
        const migrated = library.list(table).find(r => r.id === row.id)
        for (const key of [...TABLES[table].cols,'id']) if (JSON.stringify((row as any)[key]) !== JSON.stringify(migrated?.[key])) throw new Error(`迁移校验失败 ${table}:${row.id}:${key}`)
      }
      if (originals.length !== library.list(table).length) throw new Error('迁移数量不匹配')
    }
    store.files = library
    const after = store.list('tasks').map(t => planForTask(store!,t,undefined,'2000-01-01'))
    // 输出目录由是否在工作区中决定（迁移后才有工作区），不属于迁移比较的内容
    const noOut = (p: (typeof before)[number]) => p.units.map((u) => { const { output_dir: _o, ...meta } = u.meta; void _o; return { ...u, meta } })
    const comparable = (plans: typeof before) => plans.map(p=>({...p,units:noOut(p),workflow:p.workflow ? {id:p.workflow.id,name:p.workflow.name,api_json:p.workflow.api_json,mapping:p.workflow.mapping} : null}))
    if (!isDeepStrictEqual(comparable(before),comparable(after))) throw new Error('迁移前后任务计划不同')
    store.tx(() => { for (const t of ['outfits','characters','templates','stories','workflows']) store!.db.exec(`DELETE FROM ${t}`) })
    store.close(); store=undefined
    atomic(join(stage,'.comfyengi','vault.json'),JSON.stringify({version:1, migrated:!!legacy, validated:true}))
    for (const d of dirs) { renameSync(join(stage,d),join(root,d)); published.push(d) }
  } catch(e) {
    for (const d of published.reverse()) renameSync(join(root,d),join(stage,d))
    throw e
  } finally { store?.close(); rmSync(stage,{recursive:true,force:true}) }
}
export function openVault(root:string) {
  const config = JSON.parse(readFileSync(join(root,'.comfyengi','vault.json'),'utf8'))
  if (config.version !== 1) throw new Error('不支持的工作区版本')
  const library = new FileLibrary(root)
  // 旧版「数字 ID-UUID.md」文件名迁移为可读名称（只改文件名，失败时保留原名，记录在 .comfyengi/rename-log.jsonl）
  library.migrateNames()
  // 「单人动作」与「行为」合并为「状态」：原文件先备份到 data/backups/state-merge-时间/
  if ([...library.entries.values()].some((e) => e.row.type === 'templates' && (e.row.kind === 'pose' || e.row.kind === 'act'))) {
    library.migrateStateKinds(join(root, 'data', 'backups', `state-merge-${new Date().toISOString().replace(/[:.]/g, '-')}`))
  }
  const store = new Store(join(root,'data','comfyengi.db'),{backupDir:join(root,'data','backups')})
  store.files=library; return store
}
