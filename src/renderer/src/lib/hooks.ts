import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 本地草稿 + 防抖自动保存。切换记录（key 变化）或卸载组件时立即保存未提交的修改。
 */
export function useDraft<T extends object>(source: T | null, key: unknown, save: (v: T) => Promise<unknown> | void, delay = 400) {
  const [draft, setDraft] = useState<T | null>(source)
  const pending = useRef<T | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveRef = useRef(save)
  saveRef.current = save

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const v = pending.current
    pending.current = null
    if (v) void saveRef.current(v)
  }, [])

  // 切换记录：先保存上一条，再载入新记录
  useEffect(() => {
    setDraft(source)
    return () => flush()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const patch = useCallback(
    (p: Partial<T>) => {
      setDraft((d) => {
        if (!d) return d
        const next = { ...d, ...p }
        pending.current = next
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(flush, delay)
        return next
      })
    },
    [delay, flush],
  )

  return { draft, patch, flush }
}

/** 简单的 Promise 数据加载 */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): [T | undefined, () => void] {
  const [v, setV] = useState<T>()
  const [n, setN] = useState(0)
  useEffect(() => {
    let alive = true
    fn().then((r) => alive && setV(r)).catch(() => {})
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n])
  return [v, () => setN((x) => x + 1)]
}

export function matches(rec: Record<string, unknown>, search: string): boolean {
  const hay = ['name', 'category', 'tags', 'positive', 'negative', 'note', 'genre', 'tag'].map((k) => String(rec[k] ?? '')).join(' ').toLowerCase()
  return search.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w))
}

/** 素材搜索：只按名称匹配（空格分隔的多个词需全部包含） */
export function matchesName(rec: { name?: string }, search: string): boolean {
  const hay = String(rec.name ?? '').toLowerCase()
  return search.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w))
}

/** 根据名称生成稳定的柔和色相（用于角色头像等） */
export function hueOf(s: string): number {
  let h = 0
  for (const ch of s) h = (h * 31 + ch.codePointAt(0)!) % 360
  return h
}
