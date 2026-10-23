import { useEffect, useState } from 'react'
import { api, call } from '@/lib/api'
import { Button } from '@/components/ui/button'
export function VaultPanel() {
 const [error,setError]=useState('')
 const choose=(create:boolean,migrate:boolean)=>{setError('');void call(api['vault.choose'](create,migrate),setError)}
 const [info,setInfo]=useState<{root:string|null;errors:string[]}|null>(null)
 useEffect(()=>{void api['vault.info']().then(setInfo)},[])
 return <div className="rounded-2xl bg-card p-6 space-y-4"><h1 className="text-lg">ComfyEngi 工作区</h1><p className="text-sm break-all">{info?.root||'选择本地目录，开始管理你的创作资料。'}</p>
 <div className="flex flex-wrap gap-3"><Button onClick={()=>choose(true,false)}>创建新工作区</Button><Button onClick={()=>choose(false,false)}>打开 / 切换工作区</Button><Button onClick={()=>choose(true,true)}>从旧版数据库迁移到新工作区</Button>{info?.root&&<Button onClick={()=>void call(api['app.openDataDir']())}>打开工作区文件夹</Button>}<Button onClick={()=>window.location.reload()}>刷新外部文件</Button></div>
 {error&&<p className="text-destructive whitespace-pre-wrap text-sm">{error}</p>}
 {info?.errors.map(e=><p key={e} className="text-destructive text-xs">{e}</p>)}
 <p className="text-xs text-muted-foreground">切换将重启应用；队列执行期间禁止切换。刷新前请保存并复制未提交草稿。</p></div>
}
