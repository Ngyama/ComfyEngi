import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown, ChevronRight, Copy, Minus, Plus, Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useConfirm } from '@/lib/stores'
import { cn } from '@/lib/utils'
import { PRIORITIES, type Priority } from '@shared/types'

export function PageHeader({ title, description, actions, className }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-center gap-4 px-6 pt-5 pb-4', className)}>
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-[15px] font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-0.5 truncate text-xs text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}

export function IconButton({ tip, onClick, children, className, variant = 'ghost', disabled }: { tip: string; onClick?: () => void; children: ReactNode; className?: string; variant?: 'ghost' | 'secondary' | 'outline'; disabled?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant={variant} size="icon-sm" className={cn('text-muted-foreground hover:text-foreground', className)} onClick={onClick} disabled={disabled} aria-label={tip}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  )
}

export function Chip({ active, onClick, children, className, title, order }: { active?: boolean; onClick?: () => void; children: ReactNode; className?: string; title?: string; order?: number }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      data-active={active || undefined}
      className={cn(
        'inline-flex h-7 max-w-full items-center gap-1.5 rounded-full px-3 text-xs text-foreground/80 transition-colors',
        'bg-tint/[0.045] hover:bg-tint/[0.08] hover:text-foreground',
        'data-[active]:bg-primary/15 data-[active]:text-primary data-[active]:ring-1 data-[active]:ring-primary/35',
        className,
      )}
    >
      {order !== undefined && <span className="-ml-1 grid size-4 place-items-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground">{order}</span>}
      <span className="truncate">{children}</span>
    </button>
  )
}

export function FieldLabel({ children, hint, right }: { children: ReactNode; hint?: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-2 flex items-baseline gap-2">
      <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{children}</span>
      {hint && <span className="truncate text-[11px] text-muted-foreground/70">{hint}</span>}
      {right && <span className="ml-auto">{right}</span>}
    </div>
  )
}

export function TextInput({ value, onChange, placeholder, className, autoFocus, mono, onBlur }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string; autoFocus?: boolean; mono?: boolean; onBlur?: () => void }) {
  return (
    <input
      value={value}
      autoFocus={autoFocus}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      spellCheck={false}
      className={cn(
        'h-9 w-full rounded-lg bg-tint/[0.04] px-3 text-[13px] ring-1 ring-tint/[0.112] outline-none placeholder:text-muted-foreground/60 focus:bg-tint/[0.06] focus:ring-primary/50',
        mono && 'font-mono text-[12.5px]',
        className,
      )}
    />
  )
}

/** 原样编辑 Prompt：纯文本、不做任何格式化，高度随内容增长 */
export function PromptField({ label, value, onChange, placeholder, minRows = 3, readOnly, copy, className }: { label?: ReactNode; value: string; onChange?: (v: string) => void; placeholder?: string; minRows?: number; readOnly?: boolean; copy?: boolean; className?: string }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight + 2, 480)}px`
  }, [value])
  return (
    <div className={className}>
      {(label || copy) && <FieldLabel right={copy ? <CopyButton text={value} /> : undefined}>{label}</FieldLabel>}
      <textarea
        ref={ref}
        value={value}
        readOnly={readOnly}
        rows={minRows}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => onChange?.(e.target.value)}
        className={cn(
          'block w-full resize-none rounded-lg bg-tint/[0.035] px-3 py-2.5 font-mono text-[12.5px] leading-relaxed ring-1 ring-tint/[0.112] outline-none placeholder:font-sans placeholder:text-muted-foreground/55 focus:bg-tint/[0.05] focus:ring-primary/50',
          readOnly && 'bg-inset text-foreground/85',
        )}
      />
    </div>
  )
}

export function CopyButton({ text, label = '复制' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-tint/[0.06] hover:text-foreground"
      onClick={() => {
        void navigator.clipboard.writeText(text ?? '')
        setDone(true)
        setTimeout(() => setDone(false), 1200)
      }}
    >
      {done ? <Check className="size-3" /> : <Copy className="size-3" />}
      {done ? '已复制' : label}
    </button>
  )
}

export function SearchBox({ value, onChange, placeholder = '搜索…', className, autoFocus }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string; autoFocus?: boolean }) {
  return (
    <div className={cn('relative', className)}>
      <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground/70" />
      <input
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        className="h-8 w-full rounded-lg bg-tint/[0.045] pr-7 pl-8 text-[13px] ring-1 ring-tint/[0.096] outline-none placeholder:text-muted-foreground/60 focus:ring-primary/50"
      />
      {value && (
        <button type="button" onClick={() => onChange('')} className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
          <X className="size-3.5" />
        </button>
      )}
    </div>
  )
}

export function NumberStepper({ value, onChange, min = 1, max = 9999, step = 1 }: { value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number }) {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  const commit = (v: number) => onChange(Math.max(min, Math.min(max, Math.round(v))))
  return (
    <div className="inline-flex h-9 items-center rounded-lg bg-tint/[0.04] ring-1 ring-tint/[0.112] focus-within:ring-primary/50">
      <button type="button" className="grid h-full w-8 place-items-center text-muted-foreground hover:text-foreground" onClick={() => commit(value - step)}>
        <Minus className="size-3.5" />
      </button>
      <input
        value={text}
        inputMode="numeric"
        onChange={(e) => {
          const t = e.target.value.replace(/[^\d]/g, '')
          setText(t)
          if (t) commit(parseInt(t, 10))
        }}
        onBlur={() => setText(String(value))}
        className="h-full w-14 bg-transparent text-center text-sm font-semibold tabular-nums outline-none"
      />
      <button type="button" className="grid h-full w-8 place-items-center text-muted-foreground hover:text-foreground" onClick={() => commit(value + step)}>
        <Plus className="size-3.5" />
      </button>
    </div>
  )
}

export function Disclosure({ title, summary, open: openProp, defaultOpen = false, right, children }: { title: ReactNode; summary?: ReactNode; open?: boolean; defaultOpen?: boolean; right?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen)
  const isOpen = openProp ?? open
  return (
    <div className="rounded-xl bg-tint/[0.025] ring-1 ring-tint/[0.08]">
      <div className="flex items-center gap-2 px-3">
        <button type="button" className="flex h-10 min-w-0 flex-1 items-center gap-2 text-left text-[13px]" onClick={() => setOpen(!isOpen)}>
          {isOpen ? <ChevronDown className="size-4 text-muted-foreground" /> : <ChevronRight className="size-4 text-muted-foreground" />}
          <span className="font-medium">{title}</span>
          {summary && <span className="truncate text-xs text-muted-foreground">{summary}</span>}
        </button>
        {right}
      </div>
      {isOpen && <div className="px-3 pt-1 pb-3">{children}</div>}
    </div>
  )
}

export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: ReactNode; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      {icon && <div className="grid size-12 place-items-center rounded-2xl bg-tint/[0.04] text-muted-foreground [&_svg]:size-5">{icon}</div>}
      <div>
        <div className="text-sm font-medium">{title}</div>
        {description && <div className="mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">{description}</div>}
      </div>
      {action}
    </div>
  )
}

export function ConfirmHost() {
  const { req, set } = useConfirm()
  const close = (v: boolean) => {
    req?.resolve(v)
    set(null)
  }
  return (
    <Dialog open={!!req} onOpenChange={(o) => !o && close(false)}>
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{req?.title}</DialogTitle>
          {req?.description && <DialogDescription className="whitespace-pre-line">{req.description}</DialogDescription>}
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => close(false)}>
            取消
          </Button>
          <Button variant={req?.destructive ? 'destructive' : 'default'} onClick={() => close(true)} autoFocus>
            {req?.confirmText ?? '确定'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function Avatar({ name, hue, className }: { name: string; hue: number; className?: string }) {
  return (
    <div
      className={cn('grid size-9 shrink-0 place-items-center rounded-xl text-sm font-semibold', className)}
      style={{ background: `oklch(0.92 0.05 ${hue})`, color: `oklch(0.42 0.1 ${hue})` }}
    >
      {[...(name || '?')][0]}
    </div>
  )
}

export function StatusDot({ tone }: { tone: 'ok' | 'warn' | 'error' | 'idle' | 'busy' }) {
  const c = { ok: 'bg-success', warn: 'bg-warning', error: 'bg-destructive', idle: 'bg-muted-foreground/50', busy: 'bg-primary animate-pulse' }[tone]
  return <span className={cn('inline-block size-2 shrink-0 rounded-full', c)} />
}


/** 素材的显示优先级（高 / 普通 / 低）：只影响选择列表中的排列，不影响生成的 Prompt */
export function PriorityToggle({ value, onChange }: { value: Priority | undefined; onChange: (v: Priority) => void }) {
  const cur = value ?? 'normal'
  return (
    <div className="flex items-center gap-2" data-testid="priority-toggle" data-value={cur}>
      <div className="flex rounded-lg bg-tint/[0.045] p-0.5">
        {PRIORITIES.map(([k, label]) => (
          <button
            key={k}
            type="button"
            data-active={cur === k || undefined}
            data-testid={`priority-${k}`}
            onClick={() => cur !== k && onChange(k)}
            className="h-6 rounded-md px-2.5 text-[11.5px] text-muted-foreground data-[active]:bg-tint/[0.1] data-[active]:text-foreground"
          >
            {label}
          </button>
        ))}
      </div>
      <span className="text-[11px] text-muted-foreground">只影响选择列表中的排列顺序</span>
    </div>
  )
}

/** 卡片 / 列表中的优先级标记：普通不显示 */
export function PriorityBadge({ value }: { value: Priority | undefined }) {
  if (value !== 'high' && value !== 'low') return null
  return (
    <span data-testid="priority-badge" data-value={value} className={cn('shrink-0 rounded px-1 text-[10px] leading-4', value === 'high' ? 'bg-primary/12 text-primary' : 'bg-tint/[0.06] text-muted-foreground')}>
      {value === 'high' ? '高' : '低'}
    </span>
  )
}
