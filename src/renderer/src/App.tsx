import { toast } from 'sonner'
import LorasPage from '@/pages/LorasPage'
import { VaultPanel } from '@/components/VaultPanel'
import { api } from '@/lib/api'
import { useEffect, useState, type ComponentType } from 'react'
import { BookOpen, History, Layers, ListOrdered, Settings, Shapes, Users } from 'lucide-react'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmHost, StatusDot } from '@/components/common'
import { useLib, useNav, usePlan, useRunner, type Page } from '@/lib/stores'
import { cn } from '@/lib/utils'
import PlanPage from '@/pages/plan/PlanPage'
import QueuePage from '@/pages/QueuePage'
import HistoryPage from '@/pages/HistoryPage'
import LibraryPage from '@/pages/LibraryPage'
import CharactersPage from '@/pages/CharactersPage'
import StoriesPage from '@/pages/StoriesPage'
import SettingsPage from '@/pages/settings/SettingsPage'

const NAV: { key: Page; label: string; icon: ComponentType<{ className?: string }> }[] = [
  { key: 'loras', label: 'LoRA 管理', icon: Shapes },
  { key: 'plan', label: '套图任务', icon: Layers },
  { key: 'queue', label: '执行队列', icon: ListOrdered },
  { key: 'history', label: '运行记录', icon: History },
  { key: 'library', label: '素材库', icon: Shapes },
  { key: 'characters', label: '角色库', icon: Users },
  { key: 'stories', label: '剧情库', icon: BookOpen },
  { key: 'settings', label: '设置', icon: Settings },
]

const PAGES: Record<Page, ComponentType> = {
  loras: LorasPage,
  plan: PlanPage,
  queue: QueuePage,
  history: HistoryPage,
  library: LibraryPage,
  characters: CharactersPage,
  stories: StoriesPage,
  settings: SettingsPage,
}

function RunnerMini() {
  const { status } = useRunner()
  const go = useNav((s) => s.go)
  const s = status.state
  const tone = s === 'running' ? 'busy' : s === 'waiting' || s === 'paused' || s === 'pausing' ? 'warn' : s === 'finished' ? 'ok' : 'idle'
  const label = { idle: '空闲', running: '生成中', waiting: '等待 ComfyUI', pausing: '即将暂停', paused: '已暂停', stopping: '正在停止', stopped: '已停止', finished: '已完成' }[s]
  const p = status.progress
  return (
    <button type="button" onClick={() => go('queue')} className="w-full rounded-xl bg-tint/[0.03] p-3 text-left ring-1 ring-tint/[0.08] hover:bg-tint/[0.05]">
      <div className="flex items-center gap-2 text-xs">
        <StatusDot tone={tone} />
        <span className="font-medium">{label}</span>
      </div>
      {status.current ? (
        <>
          <div className="mt-1.5 truncate text-[11px] text-muted-foreground">
            {status.current.run_name} · {status.current.item_label}
          </div>
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-tint/[0.06]">
            <div className="h-full rounded-full bg-primary transition-all" style={{ width: p.max ? `${(p.value / p.max) * 100}%` : '8%' }} />
          </div>
        </>
      ) : (
        <div className="mt-1.5 truncate text-[11px] text-muted-foreground">{status.message || '执行队列'}</div>
      )}
    </button>
  )
}

export default function App() {
  const { page, go } = useNav()
  const [vault,setVault]=useState<boolean|null>(null)
  const [error,setError]=useState('')
  const [ready, setReady] = useState(false)
  useEffect(() => {
    void (async () => {
      const info=await api['vault.info'](); setVault(!!info.root)
      if(!info.root) return
      await useLib.getState().reload()
      await useRunner.getState().init()
      const lib = useLib.getState().lib
      await usePlan.getState().load(lib?.settings.last_task_id ?? null)
      setReady(true)
    })().catch(e=>setError(String(e)))
  }, [])
  useEffect(()=>api.onRunnerEvent(e=>{if(e.kind==='log'&&e.text.startsWith('[Vault]'))toast.info(e.text,{duration:15000})}),[])
  if(vault===false) return <div className="p-12"><VaultPanel /></div>
  if(error) return <div className="p-8 space-y-4"><p className="whitespace-pre-wrap">{error}</p><VaultPanel /></div>
  const switchTo = (p: Page) => {
    void usePlan.getState().flush()
    go(p)
  }
  const Current = PAGES[page]
  return (
    <TooltipProvider delayDuration={350}>
      <div className="flex h-full flex-col bg-shell">
        {/* 标题栏：可拖动区域，右侧为系统窗口按钮预留空间 */}
        <div className="flex h-10 shrink-0 items-center gap-2 pr-[150px] pl-4 [-webkit-app-region:drag]">
          <div className="grid size-5 place-items-center rounded-md bg-primary/90 text-[10px] font-black text-primary-foreground">C</div>
          <span className="text-[12px] font-semibold tracking-wide text-foreground/80">ComfyEngi</span>
        </div>
        <div className="flex min-h-0 flex-1">
          <nav className="flex w-[188px] shrink-0 flex-col gap-0.5 px-3 pb-3">
            {NAV.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                type="button"
                onClick={() => switchTo(key)}
                data-active={page === key || undefined}
                className={cn(
                  'flex h-9 items-center gap-3 rounded-lg px-3 text-[13px] text-muted-foreground transition-colors',
                  'hover:bg-tint/[0.05] hover:text-foreground',
                  'data-[active]:bg-card data-[active]:font-medium data-[active]:text-foreground data-[active]:shadow-[var(--panel-shadow)] data-[active]:[&>svg]:text-primary',
                )}
              >
                <Icon className="size-4" />
                {label}
              </button>
            ))}
            <div className="flex-1" />
            <RunnerMini />
          </nav>
          <main className="min-w-0 flex-1 pr-2 pb-2">
            <div className="relative h-full overflow-hidden rounded-2xl bg-background shadow-[var(--panel-shadow)]">
              {ready && <Current />}
            </div>
          </main>
        </div>
      </div>
      <ConfirmHost />
      <Toaster position="bottom-right" />
    </TooltipProvider>
  )
}
