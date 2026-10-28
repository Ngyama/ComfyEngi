// 在 worker 线程中运行组合挖掘；新的分析开始时终止上一次，超时则终止并报错。
import createMiningWorker from './mining-worker?nodeWorker'
import type { MiningImage, MiningParams, MiningResult } from '@shared/mining'

let current: { terminate: () => Promise<number> } | null = null

export function analyzeInWorker(images: MiningImage[], params: Partial<MiningParams>, dictPath: string | null, timeoutMs = 120_000): Promise<MiningResult> {
  void current?.terminate()
  return new Promise((resolve, reject) => {
    const w = createMiningWorker({ workerData: { images, params, dictPath } })
    current = w
    let settled = false
    const done = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (current === w) current = null
      void w.terminate()
      fn()
    }
    const timer = setTimeout(() => done(() => reject(new Error('分析超时：请提高「最小共同出现图片数」或减少图片后重试'))), timeoutMs)
    w.on('message', (m: { ok: boolean; result?: MiningResult; error?: string }) => done(() => (m.ok ? resolve(m.result!) : reject(new Error(m.error)))))
    w.on('error', (e) => done(() => reject(e)))
    w.on('exit', () => done(() => reject(new Error('分析已取消'))))
  })
}

export function cancelAnalysis() {
  void current?.terminate()
  current = null
}
