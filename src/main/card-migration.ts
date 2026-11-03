// 旧版素材池动作卡一次性转换为模板动作卡。转换前把动作卡与子体位文件复制到备份目录；
// 原子体位文件保留（不再显示），已入队、已完成的运行是冻结快照，不受影响。

import { appendFileSync, copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { normalizeCard } from '@shared/cards'
import { legacyCardTemplates, MIGRATED_CATEGORY } from '@shared/card-templates'
import type { Template } from '@shared/types'
import type { Store } from './store'

export const needsTemplateMigration = (store: Store) => store.list('templates').some((t) => t.kind === 'position' && !t.card?.templates)

/** 返回转换的动作卡数量与新建的模板数量；单张卡失败时跳过并记录，不影响其他卡 */
export function migrateTemplateCards(store: Store, backupDir?: string): { cards: number; templates: number; failed: string[] } {
  const all = store.list('templates')
  const todo = all.filter((t) => t.kind === 'position' && !t.card?.templates)
  const out = { cards: 0, templates: 0, failed: [] as string[] }
  if (!todo.length) return out
  const byId = new Map(all.map((t) => [t.id, t]))
  if (backupDir && store.files) {
    for (const t of all.filter((x) => x.kind === 'position' || x.kind === 'subposition')) {
      const e = store.files.entries.get(`templates:${t.id}`)
      if (!e) continue
      const copy = join(backupDir, relative(store.files.root, e.path))
      mkdirSync(dirname(copy), { recursive: true })
      copyFileSync(e.path, copy)
    }
  }
  for (const card of todo) {
    try {
      const subs = all.filter((s) => s.kind === 'subposition' && s.parent_id === card.id)
      const { templates, note } = legacyCardTemplates(card, subs, (id) => byId.get(id))
      templates.forEach((t, i) => store.save('templates', { kind: 'card_tpl', parent_id: card.id, name: t.name, positive: t.positive, negative: '', category: MIGRATED_CATEGORY, tags: '', note: '', sort: i + 1 } as Partial<Template>))
      const next = { ...normalizeCard(card.card), templates: true, categories: [MIGRATED_CATEGORY] }
      store.save('templates', { id: card.id, card: next, ...(note ? { note: [card.note, note].filter((x) => x?.trim()).join('\n\n') } : {}) } as Partial<Template>)
      out.cards++
      out.templates += templates.length
    } catch (e) {
      out.failed.push(`${card.name}：${(e as Error).message}`)
    }
  }
  if (store.files) {
    try {
      mkdirSync(join(store.files.root, '.comfyengi'), { recursive: true })
      appendFileSync(join(store.files.root, '.comfyengi', 'migration-log.jsonl'), JSON.stringify({ time: new Date().toISOString(), migration: 'card-templates', ...out, backup: backupDir ?? null }) + '\n')
    } catch { /* 日志写入失败不影响迁移 */ }
    for (const f of out.failed) store.files.notices.push(`未能把动作卡转换为模板，已保持原样：${f}`)
  }
  return out
}
