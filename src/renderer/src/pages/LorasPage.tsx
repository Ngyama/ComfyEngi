import { useEffect, useState } from 'react'
import { api, call } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { TextInput } from '@/components/common'
import { useLib } from '@/lib/stores'
import type { LoraResource } from '@shared/types'
export default function LorasPage() {
 const [rows,setRows]=useState<LoraResource[]>([]), [q,setQ]=useState(''), [selected,setSelected]=useState<LoraResource|null>(null), [image,setImage]=useState<string|null>(null)
 const lib=useLib(s=>s.lib)
 const reload=async()=>{const r=await call(api['loras.list']());if(r)setRows(r)}
 useEffect(()=>{void reload()},[])
 useEffect(()=>{setImage(null);if(selected)void api['loras.image'](selected.id).then(setImage)},[selected?.id,selected?.preview])
 return <div className="h-full overflow-auto p-6 space-y-4">
 <div className="flex gap-3 items-center"><h1>LoRA Manager</h1><Button onClick={async()=>{const errors=await call(api['loras.scan']());if(errors?.length)window.alert(errors.join('\n'));await reload()}}>添加目录 / 重新扫描</Button><Button onClick={()=>void reload()}>刷新</Button></div>
 <TextInput value={q} onChange={setQ} placeholder="搜索文件名、分类或标签" />
 <div className="grid grid-cols-3 gap-4">{rows.filter(r=>`${r.name} ${r.category} ${r.tags}`.toLowerCase().includes(q.toLowerCase())).map(r=><button className="rounded-xl bg-card p-4 text-left ring-1 ring-white/10" key={r.id} onClick={()=>setSelected(r)}><div className="text-3xl mb-3">◇</div><div className="truncate">{r.name}</div><div className="text-xs text-muted-foreground">{r.missing?'文件缺失':`${(r.size/1048576).toFixed(1)} MB`} · {r.category} {r.tags}</div></button>)}</div>
 {selected&&<div className="rounded-xl bg-card p-5 space-y-3 ring-1 ring-white/10"><div className="flex justify-between"><h2>{selected.name}</h2><Button onClick={()=>setSelected(null)}>关闭详情</Button></div>
 {image&&<img className="max-h-64 rounded-lg" src={image}/>}
 <p className="break-all text-xs">{selected.path}</p><p className="text-xs">{selected.size} 字节 · {new Date(selected.mtime).toLocaleString()}</p>
 {(['category','tags','note','comfyName'] as const).map(k=><label className="block text-xs" key={k}>{({category:'分类',tags:'标签',note:'备注',comfyName:'ComfyUI 注册的相对模型名称（须与 Loader 选项一致）'})[k]}<TextInput value={selected[k]} onChange={v=>setSelected({...selected,[k]:v})}/></label>)}
 <label className="block text-xs">推荐权重<input className="ml-3 bg-background p-2" type="number" step="0.05" value={selected.recommendedWeight} onChange={e=>setSelected({...selected,recommendedWeight:Number(e.target.value)})}/></label>
 <select className="bg-background p-2" value={selected.characterId??''} onChange={e=>setSelected({...selected,characterId:e.target.value?Number(e.target.value):null})}><option value="">未关联角色</option>{lib?.characters.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select>
 <div className="flex gap-2"><Button onClick={async()=>{await call(api['loras.save'](selected));await reload()}}>保存</Button><Button onClick={async()=>{await call(api['loras.preview'](selected.id));await reload();setImage(await api['loras.image'](selected.id))}}>设置预览</Button><Button onClick={()=>void call(api['loras.open'](selected.id))}>打开所在目录</Button></div>
 <pre className="text-xs whitespace-pre-wrap">{selected.metadataError || JSON.stringify(selected.metadata,null,2)}</pre>
 </div>}
 </div>
}
