// 镜头视角：素材库分类、动作的多选候选、每张图片抽 1 个；旧版单选镜头兼容；入队冻结。

import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { drawCamera } from '@shared/cards'
import { expandTask, itemCameraIds, newCardItem, normalizeTaskData, setItemSizes } from '@shared/planner'
import { byPriority, type PlanUnit, type TaskItem } from '@shared/types'
import { enqueueTask, loadPlanLibrary, planForTask } from '../src/main/plan'
import { seedSamples } from '../src/main/seed'
import { createVault, openVault } from '../src/main/vault'
import { Lib, newStore, tempDir } from './helpers'

function setup() {
  const s = newStore()
  const lib = new Lib(s)
  const T = (kind: string, name: string, positive: string, extra: Record<string, unknown> = {}) => s.save('templates', { kind, name, positive, ...extra })
  const front = T('camera', '正面', 'from front', { negative: 'from behind' })
  const side = T('camera', '侧面', 'from side')
  const top = T('camera', '俯视2', 'high angle')
  const lean = T('state', '前倾', 'leaning_forward')
  const back = T('state', '后仰', 'leaning_back')
  const smile = T('expression', '微笑', 'smile')
  const blush = T('expression', '害羞', 'blush')
  const card = T('position', '鸭子坐', 'wariza', { card: { solo: true, pools: { pose: { fixed: [], random: [lean, back] }, expr: { fixed: [], random: [smile, blush] } } } })
  return { s, lib, front, side, top, card }
}
type Env = ReturnType<typeof setup>

const cardItem = (env: Env, n: number, extra: Partial<TaskItem> = {}): TaskItem => {
  const it = { ...newCardItem(env.card), ...extra }
  setItemSizes(it, { portrait: n })
  return it
}
function expand(env: Env, items: TaskItem[], extra: Record<string, unknown> = {}) {
  const data = env.lib.task(items, { male_base_id: null, combo_seed: 42, ...extra })
  return expandTask(normalizeTaskData(data), loadPlanLibrary(env.s), env.s.settings(), 't')
}
const cameraNames = (units: PlanUnit[]) => units.map((u) => u.meta.camera)
const PROMPTS: Record<string, string> = { 正面: 'from front', 侧面: 'from side', 俯视2: 'high angle' }

describe('镜头候选的生成', () => {
  it('没有选择镜头：不加入任何镜头 Prompt', () => {
    const env = setup()
    const { units, errors } = expand(env, [cardItem(env, 5)])
    expect(errors).toEqual([])
    for (const u of units) {
      expect(u.modules.camera).toEqual(['', ''])
      expect(u.meta.camera).toBe('')
    }
  })

  it('选择 1 个镜头：每张图片都使用它（正面、负面都进入镜头模块）', () => {
    const env = setup()
    const { units, errors } = expand(env, [cardItem(env, 8, { camera_ids: [env.front] })])
    expect(errors).toEqual([])
    for (const u of units) {
      expect(u.modules.camera).toEqual(['from front', 'from behind'])
      expect(u.meta.camera).toBe('正面')
      expect(u.positive).toContain('from front')
      expect(u.negative).toContain('from behind')
    }
  })

  it('选择多个镜头：每张图片恰好使用 1 个，多张图片各自抽取', () => {
    const env = setup()
    const { units, errors } = expand(env, [cardItem(env, 60, { camera_ids: [env.front, env.side, env.top] })])
    expect(errors).toEqual([])
    expect(units).toHaveLength(60)
    for (const u of units) {
      const hits = Object.values(PROMPTS).filter((p) => u.modules.camera[0].includes(p))
      expect(hits).toEqual([PROMPTS[u.meta.camera ?? '']])
      expect(u.modules.camera[0]).toBe(PROMPTS[u.meta.camera ?? ''])
    }
    expect(new Set(cameraNames(units)).size).toBe(3)
  })

  it('抽取大致均匀，与优先级无关', () => {
    const list = ['a', 'b', 'c']
    const counts: Record<string, number> = { a: 0, b: 0, c: 0 }
    for (let n = 0; n < 6000; n++) counts[drawCamera(list, 7, 0, n)!]++
    for (const k of list) expect(Math.abs(counts[k] - 2000)).toBeLessThan(200)
    expect(drawCamera([], 7, 0, 0)).toBeNull()
    expect(drawCamera(['x'], 7, 0, 0)).toBe('x')

    const env = setup()
    const items = [cardItem(env, 30, { camera_ids: [env.front, env.side, env.top] })]
    const before = cameraNames(expand(env, items).units)
    env.s.save('templates', { id: env.top, priority: 'high' })
    env.s.save('templates', { id: env.front, priority: 'low' })
    expect(cameraNames(expand(env, items).units)).toEqual(before)
  })

  it('同样的组合 Seed 复现同样的镜头，换 Seed 结果改变', () => {
    const env = setup()
    const items = [cardItem(env, 30, { camera_ids: [env.front, env.side, env.top] })]
    const a = expand(env, items).units
    const b = expand(env, items).units
    expect(cameraNames(a)).toEqual(cameraNames(b))
    expect(a.map((u) => u.positive)).toEqual(b.map((u) => u.positive))
    expect(cameraNames(expand(env, items, { combo_seed: 43 }).units)).not.toEqual(cameraNames(a))
    expect(a[0].meta.combo_seed).toBe(42)
  })

  it('镜头与素材池互不影响：增删镜头不改变素材池的抽取结果', () => {
    const env = setup()
    const picks = (units: PlanUnit[]) => units.map((u) => u.meta.picks)
    const none = expand(env, [cardItem(env, 30)]).units
    const many = expand(env, [cardItem(env, 30, { camera_ids: [env.front, env.side, env.top] })]).units
    expect(picks(many)).toEqual(picks(none))
    expect(many.map((u) => u.modules.content)).toEqual(none.map((u) => u.modules.content))
    expect(many.map((u) => u.modules.expression)).toEqual(none.map((u) => u.modules.expression))
    expect(many.map((u) => u.seed)).toEqual(none.map((u) => u.seed))
  })

  it('每个动作独立配置：不同动作的候选互不影响，相同候选也各自抽取', () => {
    const env = setup()
    const { units } = expand(env, [cardItem(env, 20, { camera_ids: [env.front] }), cardItem(env, 20, { camera_ids: [env.side, env.top] }), cardItem(env, 20)])
    expect(new Set(cameraNames(units.slice(0, 20)))).toEqual(new Set(['正面']))
    expect(new Set(cameraNames(units.slice(20, 40)))).toEqual(new Set(['侧面', '俯视2']))
    expect(new Set(cameraNames(units.slice(40)))).toEqual(new Set(['']))
    const both = expand(env, [cardItem(env, 30, { camera_ids: [env.front, env.side] }), cardItem(env, 30, { camera_ids: [env.front, env.side] })]).units
    expect(cameraNames(both.slice(0, 30))).not.toEqual(cameraNames(both.slice(30)))
  })

  it('旧方式的动作同样支持多选；只选 1 个时计划结构不变', () => {
    const env = setup()
    const many = expand(env, [env.lib.item('睡觉', null, [], 30, { camera_ids: [env.front, env.side] })]).units
    expect(new Set(cameraNames(many))).toEqual(new Set(['正面', '侧面']))
    for (const u of many) expect(u.modules.camera[0]).toBe(PROMPTS[u.meta.camera ?? ''])
    expect(many[0].meta.combo_seed).toBe(42)
    const one = expand(env, [env.lib.item('睡觉', null, [], 3, { camera_id: env.front })]).units
    expect(cameraNames(one)).toEqual(['正面', '正面', '正面'])
    expect('combo_seed' in one[0].meta).toBe(false)
  })

  it('Prompt 拼接顺序不变：镜头留在原有的镜头模块', () => {
    const env = setup()
    const set = { ...env.s.settings(), compose_order: ['camera', 'global', 'character'] }
    const data = env.lib.task([cardItem(env, 1, { camera_ids: [env.front] })], { male_base_id: null, combo_seed: 42 })
    const [u] = expandTask(normalizeTaskData(data), loadPlanLibrary(env.s), set, 't').units
    expect(u.positive.indexOf('from front')).toBeLessThan(u.positive.indexOf('masterpiece'))
  })
})

describe('旧版单选镜头兼容', () => {
  it('旧的 camera_id 转换为一个元素的候选，原字段保留', () => {
    const env = setup()
    const old = cardItem(env, 3, { camera_id: env.front })
    delete old.camera_ids
    expect(itemCameraIds(old)).toEqual([env.front])
    const [n] = normalizeTaskData(env.lib.task([old])).items
    expect(n.camera_ids).toEqual([env.front])
    expect(n.camera_id).toBe(env.front)
    expect(cameraNames(expand(env, [old]).units)).toEqual(['正面', '正面', '正面'])
  })

  it('旧草稿（没有 camera_ids 字段）保存、重新读取后不丢失镜头', () => {
    const env = setup()
    const id = env.s.save('tasks', { name: '旧草稿', data: env.lib.task([env.lib.item('睡觉', null, [], 2, { camera_id: env.lib.pov })]) })
    const raw = env.s.get('tasks', id)!
    expect(raw.data.items[0].camera_ids).toBeUndefined()
    expect(planForTask(env.s, raw).units[0].meta.camera).toBe('POV')
    env.s.save('tasks', { id, data: normalizeTaskData(raw.data) })
    const again = env.s.get('tasks', id)!
    expect(again.data.items[0].camera_id).toBe(env.lib.pov)
    expect(again.data.items[0].camera_ids).toEqual([env.lib.pov])
    expect(planForTask(env.s, again).units[0].meta.camera).toBe('POV')
  })

  it('camera_ids 优先；清空后（两个字段都为空）不会恢复旧镜头；重复的 ID 不影响抽取概率', () => {
    const env = setup()
    expect(itemCameraIds({ camera_id: env.front, camera_ids: [env.side, env.top] })).toEqual([env.side, env.top])
    expect(itemCameraIds({ camera_id: null, camera_ids: [] })).toEqual([])
    expect(itemCameraIds({})).toEqual([])
    expect(itemCameraIds({ camera_ids: [env.side, env.side, env.top] })).toEqual([env.side, env.top])
  })
})

describe('镜头被删除', () => {
  it('单选的镜头被删除：提示错误（与旧行为相同）', () => {
    const env = setup()
    const item = cardItem(env, 2, { camera_ids: [env.side] })
    env.s.remove('templates', env.side)
    expect(expand(env, [item]).errors.join()).toContain('所选镜头模板已被删除')
    const legacy = env.lib.item('睡觉', null, [], 1, { camera_id: env.side })
    expect(expand(env, [legacy]).errors.join()).toContain('所选镜头模板已被删除')
  })

  it('多选中有镜头被删除：提示并跳过，只从剩余镜头中抽取；全部被删除时报错', () => {
    const env = setup()
    const item = cardItem(env, 20, { camera_ids: [env.front, env.side] })
    env.s.remove('templates', env.side)
    const r = expand(env, [item])
    expect(r.errors).toEqual([])
    expect(r.warnings.join()).toContain('所选镜头中有素材已被删除')
    expect(new Set(cameraNames(r.units))).toEqual(new Set(['正面']))
    env.s.remove('templates', env.front)
    expect(expand(env, [item]).errors.join()).toContain('所选镜头模板已被删除')
  })

  it('任务引用检查同时覆盖旧字段和新字段', () => {
    const env = setup()
    env.s.save('tasks', { name: '多选任务', data: env.lib.task([cardItem(env, 1, { camera_ids: [env.front, env.side] })]) })
    env.s.save('tasks', { name: '旧任务', data: env.lib.task([env.lib.item('睡觉', null, [], 1, { camera_id: env.top })]) })
    expect(env.s.tasksReferencing('camera_ids', env.side)).toEqual(['多选任务'])
    expect(env.s.tasksReferencing('camera_id', env.top)).toEqual(['旧任务'])
  })
})

describe('入队冻结', () => {
  it('入队后修改镜头、候选或删除镜头都不改变已入队的图片；已有的历史数据不变', () => {
    const env = setup()
    env.lib.addWorkflow()
    const task = env.lib.makeTask([cardItem(env, 12, { camera_ids: [env.front, env.side, env.top] })], '冻结', { male_base_id: null, combo_seed: 42 })
    const { runId, plan } = enqueueTask(env.s, task)
    expect(plan.errors).toEqual([])
    const before = structuredClone(env.s.listUnits(runId!))
    expect(new Set(before.map((u) => u.meta.camera)).size).toBeGreaterThan(1)
    env.s.save('templates', { id: env.front, positive: 'CHANGED' })
    env.s.remove('templates', env.side)
    env.s.save('tasks', { id: task.id, data: { ...task.data, combo_seed: 7, items: [{ ...task.data.items[0], camera_ids: [env.top] }] } })
    expect(env.s.listUnits(runId!)).toEqual(before)
    // 新计划使用修改后的配置，已入队的不受影响
    expect(new Set(planForTask(env.s, env.s.get('tasks', task.id)!).units.map((u) => u.meta.camera))).toEqual(new Set(['俯视2']))
  })
})

describe('镜头素材（Vault Markdown）', () => {
  it('新建、编辑名称与正负 Prompt、设置优先级、保存后重新打开、删除', () => {
    const root = join(tempDir(), 'vault')
    createVault(root)
    const s = openVault(root)
    const id = s.save('templates', { kind: 'camera', name: '新镜头' })
    s.save('templates', { id, name: '大特写', positive: 'extreme close-up', negative: 'full body', priority: 'high' })
    const other = s.save('templates', { kind: 'camera', name: '远景', positive: 'wide shot', priority: 'low' })
    const third = s.save('templates', { kind: 'camera', name: '中景', positive: 'medium shot' })
    s.close()

    const s2 = openVault(root)
    const t = s2.get('templates', id)!
    expect([t.kind, t.name, t.positive, t.negative, t.priority]).toEqual(['camera', '大特写', 'extreme close-up', 'full body', 'high'])
    expect(s2.files!.entries.get(`templates:${id}`)?.path.replace(/\\/g, '/')).toContain('prompts/cameras/')
    const cams = s2.list('templates').filter((x) => x.kind === 'camera')
    expect(byPriority(cams).map((x) => x.name)).toEqual(['大特写', '中景', '远景'])
    expect(byPriority(cams).map((x) => x.id)).toEqual([id, third, other])

    // 改名不改变 ID（任务按 ID 引用）
    s2.save('templates', { id, name: '超大特写' })
    expect(s2.get('templates', id)!.positive).toBe('extreme close-up')

    s2.remove('templates', id)
    s2.close()
    const s3 = openVault(root)
    expect(s3.get('templates', id)).toBeFalsy()
    expect(s3.list('templates').filter((x) => x.kind === 'camera').map((x) => x.id).sort()).toEqual([other, third].sort())
    s3.close()
  })

  it('首次启动不再自动创建镜头示例素材', () => {
    const s = newStore()
    seedSamples(s)
    expect(s.list('templates').some((t) => t.kind === 'camera')).toBe(false)
    expect(s.list('templates').length).toBeGreaterThan(0)
  })
})
