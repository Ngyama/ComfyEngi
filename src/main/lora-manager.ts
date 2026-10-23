import { randomUUID } from 'node:crypto'
import { open, readdir, stat, readFile, copyFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { atomic } from './file-library'
import type { LoraResource } from '@shared/types'
export class LoraManager {
  constructor(public root:string) {}
  async list():Promise<LoraResource[]> {
    const dir=join(this.root,'loras/metadata')
    const rows:LoraResource[]=[]
    for(const f of await readdir(dir)) if(f.endsWith('.json')) {
      const r=JSON.parse(await readFile(join(dir,f),'utf8')) as LoraResource
      r.missing=!(await stat(r.path).catch(()=>null)); rows.push(r)
    }
    return rows
  }
  async save(r:LoraResource) {
    const old=(await this.list()).find(x=>x.id===r.id)
    if(!old) throw new Error('未知 LoRA')
    const next={...old,category:String(r.category),tags:String(r.tags),note:String(r.note),recommendedWeight:Number(r.recommendedWeight),characterId:r.characterId,comfyName:String(r.comfyName)}
    if(next.characterId !== null && !Number.isSafeInteger(next.characterId)) throw new Error('无效角色 ID')
    if(!Number.isFinite(next.recommendedWeight)) throw new Error('无效权重')
    atomic(join(this.root,'loras/metadata',old.id+'.json'),JSON.stringify(next,null,2))
  }
  async scan(roots:string[]) {
    const rows=await this.list()
    const walk=async(dir:string,base:string):Promise<void>=>{
      for(const e of await readdir(dir,{withFileTypes:true})) {
        const path=join(dir,e.name)
        if(e.isSymbolicLink()) continue
        if(e.isDirectory()) await walk(path,base)
        else if(e.name.toLowerCase().endsWith('.safetensors')) {
          const s=await stat(path); let metadata:Record<string,unknown>={}; let metadataError=''
          try {
            const f=await open(path,'r')
            try {
              const length=Buffer.alloc(8); if((await f.read(length,0,8,0)).bytesRead!==8) throw new Error('无效文件头')
              const n=Number(length.readBigUInt64LE()); if(n<2 || n>16*1024*1024 || n>s.size-8) throw new Error('无效或过大的文件头')
              const buf=Buffer.alloc(n); if((await f.read(buf,0,n,8)).bytesRead!==n) throw new Error('文件头不完整')
              metadata=JSON.parse(buf.toString('utf8')).__metadata__??{}
            } finally {await f.close()}
          } catch(e) {metadataError=(e as Error).message}
          const old=rows.find(r=>r.path===path)
          const row:LoraResource={id:randomUUID(),path,name:e.name,relativePath:relative(base,path).replaceAll('\\','/'),size:s.size,mtime:s.mtimeMs,category:'',tags:'',note:'',recommendedWeight:1,characterId:null,comfyName:'',preview:'',...old,metadata,metadataError,missing:false}
          atomic(join(this.root,'loras/metadata',row.id+'.json'),JSON.stringify(row,null,2))
        }
      }
    }
    const errors:string[]=[]
    for(const root of roots) try {await walk(root,root)} catch(e) {errors.push(`${root}: ${(e as Error).message}`)}
    return errors
  }
  async preview(id:string,source:string) {
    const r=(await this.list()).find(x=>x.id===id); if(!r) throw new Error('未知 LoRA')
    const path=join('loras/previews',id+'.image'); await copyFile(source,join(this.root,path))
    atomic(join(this.root,'loras/metadata',id+'.json'),JSON.stringify({...r,preview:path},null,2))
  }
}
