// 首次启动时写入的少量中性示例（与旧版相同，名称带「示例」，可直接删除或修改）。

import type { Store } from './store'

const SAMPLES: [string, string, string, string, string][] = [
  ['global', '画质（示例）', 'masterpiece, best quality, amazing quality', 'worst quality, low quality, lowres, bad anatomy, bad hands', ''],
  ['state', '站立（示例）', 'standing', '', '单人'],
  ['expression', '微笑（示例）', 'smile', '', ''],
  ['camera', '正面（示例）', 'from front, looking at viewer', '', ''],
  ['camera', 'POV（示例）', 'pov', '', ''],
  ['male', '男性基础（示例）', '1boy', '', '基础'],
]

export function seedSamples(store: Store) {
  const seeded = store.db.prepare("SELECT value FROM settings WHERE key='seeded'").get()
  if (seeded) return
  if (!store.list('templates').length && !store.list('characters').length) {
    for (const [kind, name, positive, negative, category] of SAMPLES) store.save('templates', { kind, name, positive, negative, category })
  }
  store.setSetting('seeded', true)
}
