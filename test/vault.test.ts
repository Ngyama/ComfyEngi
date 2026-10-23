import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, writeFileSync, renameSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { createVault, openVault } from '../src/main/vault'
import { encode, decode } from '../src/main/file-library'
import { LoraManager } from '../src/main/lora-manager'
import { tempDir, Lib, SAMPLE_MAPPING, SAMPLE_WORKFLOW } from './helpers'
import { planForTask, enqueueTask } from '../src/main/plan'
import { newItem, newTaskData } from '@shared/planner'
import { Store } from '../src/main/store'

describe('Vault files',()=>{
 it('creates, reopens and preserves exact prompt text, IDs and conflicts',()=>{
  const root=tempDir(); createVault(root);const s=openVault(root)
  expect(existsSync(join(root,'loras/previews'))).toBe(true)
  const positive='  # tag\r\n---\n```\n(tag:1.25), {a|b}\n\t尾部  '
  const id=s.save('templates',{kind:'pose',name:'姿态',positive,negative:'\n'})
  const row=s.get('templates',id)!;const e=s.files!.entries.get(`templates:${id}`)!
  expect(decode(encode({...row,type:'templates'})).positive).toBe(positive)
  renameSync(e.path,join(root,'prompts','renamed.md'));s.files!.scan()
  expect(s.get('templates',id)?.positive).toBe(positive)
  const renamed=s.files!.entries.get(`templates:${id}`)!
  writeFileSync(renamed.path,encode({...row,type:'templates',positive:'external'}))
  expect(()=>s.save('templates',{...row,positive:'unsaved'})).toThrow('冲突')
  s.files!.scan(); expect(s.get('templates',id)?.positive).toBe('external')
  expect(()=>s.save('templates',{...row,positive:'stale'})).toThrow('冲突')
  copyFileSync(renamed.path,join(root,'prompts','duplicate.md'))
  expect(()=>s.files!.scan()).toThrow('重复 ID');s.close()
 })
 it('rejects corrupt frontmatter',()=>{expect(()=>decode('---\nid: nope\n---\n')).toThrow()})
 it('migrates legacy fixture without changing source or queue/history',()=>{
  const source=join(tempDir(),'legacy.db');copyFileSync(join(import.meta.dirname,'fixtures/legacy-v0.db'),source);const bytes=readFileSync(source)
  const root=tempDir();createVault(root,source);const s=openVault(root)
  expect(s.files!.list('characters').length).toBeGreaterThan(0)
  expect(s.list('tasks').length).toBeGreaterThan(0)
  expect(s.db.prepare('SELECT count(*) AS n FROM characters').get()?.n).toBe(0)
  expect(readFileSync(source)).toEqual(bytes)
  expect(()=>createVault(root,source)).toThrow();s.close()
 })
 it('keeps associations, scene order, inputs and frozen queue after file edits',()=>{
  const source=join(tempDir(),'old.db');const old=new Store(source);const lib=new Lib(old)
  const wf=old.save('workflows',{name:'wf',api_json:SAMPLE_WORKFLOW,mapping:SAMPLE_MAPPING})
  const data={...newTaskData(),character_id:lib.charA,workflow_id:wf,items:[newItem(Object.values(lib.poses)[0],lib.outfitsA[0])]}
  const tid=old.save('tasks',{name:'task',data});const before=planForTask(old,old.get('tasks',tid)!,undefined,'2000-01-01');old.close()
  const root=tempDir();createVault(root,source);const s=openVault(root)
  expect(planForTask(s,s.get('tasks',tid)!,undefined,'2000-01-01').units).toEqual(before.units)
  const run=enqueueTask(s,s.get('tasks',tid)!).runId!;expect(run).toBeTruthy()
  const snapshot=s.listUnits(run);s.save('characters',{id:lib.charA,positive:'changed'})
  expect(s.listUnits(run)).toEqual(snapshot);expect(s.listOutfits(lib.charA)).toHaveLength(5);s.close()
 })
 it('scans bounded headers, preserves model bytes, retains missing records and user metadata',async()=>{
  const root=tempDir();createVault(root);const models=tempDir();const path=join(models,'test.safetensors')
  const header=Buffer.from(JSON.stringify({__metadata__:{author:'test'}}));const n=Buffer.alloc(8);n.writeBigUInt64LE(BigInt(header.length));const bytes=Buffer.concat([n,header,Buffer.alloc(32)])
  writeFileSync(path,bytes);writeFileSync(join(models,'broken.safetensors'),'bad')
  const manager=new LoraManager(root);expect(await manager.scan([models])).toEqual([])
  let rows=await manager.list();expect(rows).toHaveLength(2);expect(rows.find(r=>r.name==='broken.safetensors')?.metadataError).toBeTruthy()
  const row=rows.find(r=>r.name==='test.safetensors')!;await manager.save({...row,tags:'favorite',comfyName:'test.safetensors'});await manager.scan([models]);rows=await manager.list()
  expect(rows.find(r=>r.id===row.id)?.tags).toBe('favorite');expect(readFileSync(path)).toEqual(bytes)
  renameSync(path,path+'.moved');expect((await manager.list()).find(r=>r.id===row.id)?.missing).toBe(true)
 })
})

it('resolves managed LoRA relative names and blocks empty character slots',async()=>{
 const root=tempDir();createVault(root);const s=openVault(root);const lib=new Lib(s)
 const models=tempDir();writeFileSync(join(models,'managed.safetensors'),'invalid header is manageable')
 const manager=new LoraManager(root);await manager.scan([models]);const r=(await manager.list())[0]
 await manager.save({...r,comfyName:'sub/managed.safetensors'})
 s.save('characters',{id:lib.charA,loras:[{resource_id:r.id,name:r.name,strength:0.7}]})
 const wf=s.save('workflows',{name:'mapped',api_json:SAMPLE_WORKFLOW,mapping:SAMPLE_MAPPING})
 const tid=s.save('tasks',{name:'managed',data:{...newTaskData(),character_id:lib.charA,workflow_id:wf,items:[newItem(Object.values(lib.poses)[0])]}})
 const plan=planForTask(s,s.get('tasks',tid)!)
 expect(plan.errors).toEqual([]);expect(plan.units[0].inputs?.find(x=>x.source==='lora1_name')?.value).toBe('sub/managed.safetensors')
 s.save('characters',{id:lib.charA,loras:[]})
 expect(enqueueTask(s,s.get('tasks',tid)!).runId).toBeNull()
 s.close()
})
it('rolls back failed imports and never overwrites existing user folders',()=>{
 const root=tempDir();expect(()=>createVault(root,join(root,'missing.db'))).toThrow()
 expect(existsSync(join(root,'.comfyengi/vault.json'))).toBe(false)
 createVault(root);const s=openVault(root);const id=s.save('templates',{kind:'pose',positive:'user content'})
 expect(()=>createVault(root)).toThrow();expect(s.get('templates',id)?.positive).toBe('user content');s.close()
})
it('own repeated saves succeed but external changes invalidate the editing baseline',()=>{
 const root=tempDir();createVault(root);const s=openVault(root);const id=s.save('templates',{kind:'pose',positive:'one'})
 const row=s.get('templates',id)!
 s.save('templates',{...row,positive:'two'});s.save('templates',{...row,positive:'three'})
 const e=s.files!.entries.get(`templates:${id}`)!;writeFileSync(e.path,encode({...e.row,positive:'external'}))
 expect(s.files!.changed()).toBe(true);expect(()=>s.save('templates',{...row,positive:'four'})).toThrow('冲突')
 expect(decode(readFileSync(e.path,'utf8')).positive).toBe('external');s.close()
})
