// 组合挖掘在独立线程中运行，避免大批量分析阻塞主进程（窗口与 IPC 保持响应）。
import { existsSync, readFileSync } from 'node:fs'
import { parentPort, workerData } from 'node:worker_threads'
import { minePrompts } from '@shared/mining'
import { buildDictionary } from '@shared/tags'

const { images, params, dictPath } = workerData as { images: { id: string; positive: string }[]; params: Record<string, number>; dictPath: string | null }
try {
  const dict = dictPath && existsSync(dictPath) ? buildDictionary(JSON.parse(readFileSync(dictPath, 'utf8'))) : null
  parentPort!.postMessage({ ok: true, result: minePrompts(images, params, dict) })
} catch (e) {
  parentPort!.postMessage({ ok: false, error: (e as Error).message || String(e) })
}
