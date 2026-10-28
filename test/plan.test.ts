import { describe, expect, it } from 'vitest'
import { expandTask, pickRandomStory, PlanLibrary } from '@shared/planner'
import { compose } from '@shared/prompt'
import { Lib, newStore } from './helpers'
import { loadPlanLibrary } from '../src/main/plan'

const RAW_SAMPLES = [
  '(masterpiece:1.2), [[bad]], \\(artist\\), <lora:foo_v2:0.75>, {red|blue} hair',
  '自然语言：她在窗边看书，阳光洒在脸上。\nBREAK\n  1girl,   solo  ,',
  '  前后空格 \t\r\nwindows 换行\r\n',
  'emoji 🌸 ／ 全角，符号「」　 ((((weight)))) :3 ^_^ \\n literal',
  '',
]

describe('模板与 Prompt', () => {
  it('原始 Prompt 保存后重新加载不发生变化', () => {
    const s = newStore()
    RAW_SAMPLES.forEach((text, i) => {
      const id = s.save('templates', { kind: 'pose', name: `t${i}`, positive: text, negative: [...text].reverse().join('') })
      const t = s.get('templates', id)!
      expect(t.positive).toBe(text)
      expect(t.negative).toBe([...text].reverse().join(''))
    })
    const cid = s.save('characters', { name: 'c', positive: RAW_SAMPLES[0], negative: RAW_SAMPLES[1], loras: [{ name: 'x (1).safetensors', strength: 0.65 }] })
    const c = s.get('characters', cid)!
    expect([c.positive, c.negative]).toEqual([RAW_SAMPLES[0], RAW_SAMPLES[1]])
    expect(c.loras).toEqual([{ name: 'x (1).safetensors', strength: 0.65 }])
    const oid = s.save('outfits', { character_id: cid, name: 'o', positive: RAW_SAMPLES[2] })
    expect(s.get('outfits', oid)!.positive).toBe(RAW_SAMPLES[2])
    const scenes = RAW_SAMPLES.map((t) => ({ name: 's', positive: t, negative: '', count: 3, with_male: false }))
    const sid = s.save('stories', { genre: '纯爱', name: 'st', scenes })
    expect(s.get('stories', sid)!.scenes).toEqual(scenes)
    s.save('templates', { id: 1, positive: RAW_SAMPLES[3] })
    expect(s.get('templates', 1)!.positive).toBe(RAW_SAMPLES[3])
  })

  it('组合只按顺序与连接符拼接，保留原文', () => {
    const s = newStore()
    const set = s.settings()
    const mods = { global: ['(best:1.2)', ''], character: ['<lora:x:0.8>, {a|b}', ''], content: ['', ''], camera: ['pov', ''] } as Record<string, [string, string]>
    // 默认：全局 → 场景 → 镜头 → 主角色；模块之间空一行，模块内容原样
    expect(compose(mods, set)[0]).toBe('(best:1.2),\n\npov,\n\n<lora:x:0.8>, {a|b}')
    set.compose_order = ['camera', 'character', 'global']
    set.pos_module_separator = '\\nBREAK\\n'
    expect(compose(mods, set)[0]).toBe('pov\nBREAK\n<lora:x:0.8>, {a|b}\nBREAK\n(best:1.2)')
  })

  it('不同角色读取自己的服装模板', () => {
    const s = newStore()
    const lib = new Lib(s)
    expect(s.listOutfits(lib.charA).map((o) => o.name)).toEqual(['A服装1', 'A服装2', 'A服装3', 'A服装4', 'A服装5'])
    expect(s.listOutfits(lib.charB).map((o) => o.name)).toEqual(['B服装1', 'B服装2', 'B服装3'])
    const L = loadPlanLibrary(s)
    expect(expandTask(lib.task([lib.item('睡觉', lib.outfitsB[0], [], 1)]), L, s.settings()).errors.some((e) => e.includes('不属于角色'))).toBe(true)
    const r = expandTask(lib.task([lib.item('睡觉', lib.outfitsA[1], [], 1)]), L, s.settings())
    expect(r.errors).toEqual([])
    expect(r.units[0].positive).toContain('outfit_a2')
  })
})

describe('任务展开', () => {
  it('姿态执行顺序与用户设置完全一致，每张 Seed 不同', () => {
    const s = newStore()
    const lib = new Lib(s)
    const order = ['动作C', '睡觉', '动作A', '鸭子坐', '动作B']
    const { units, errors } = expandTask(lib.task(order.map((n) => lib.item(n, null, [], 2))), loadPlanLibrary(s), s.settings())
    expect(errors).toEqual([])
    const seen: string[] = []
    for (const u of units) if (seen[seen.length - 1] !== u.item_label) seen.push(u.item_label)
    expect(seen).toEqual(order)
    expect(units.map((u) => u.index)).toEqual([...Array(10).keys()])
    expect(new Set(units.map((u) => u.seed)).size).toBe(10)
    expect(units[0].seed).toBe(1000)
  })

  it('剧情场景先于姿态，按模板顺序；占位符替换', () => {
    const s = newStore()
    const lib = new Lib(s)
    const scenes = [1, 2, 3].map((i) => ({ name: `场景${i}`, positive: `scene${i} {角色名}`, negative: '', count: 1, with_male: false }))
    const sid = s.save('stories', { genre: '纯爱', name: '剧情1', scenes })
    const { units, errors } = expandTask(lib.task([lib.item('睡觉', null, [], 1)], { story_id: sid }), loadPlanLibrary(s), s.settings())
    expect(errors).toEqual([])
    expect(units.map((u) => u.item_label)).toEqual(['场景1', '场景2', '场景3', '睡觉'])
    expect(units[0].positive).toContain('scene1 角色A')
  })

  it('随机剧情选的是整套模板', () => {
    const s = newStore()
    new Lib(s)
    const s1 = s.save('stories', { genre: 'NTR', name: 'x', scenes: [{ name: 'a', count: 1 }, { name: 'b', count: 1 }] })
    s.save('stories', { genre: '纯爱', name: 'y', scenes: [] })
    const L = loadPlanLibrary(s)
    for (let i = 0; i < 5; i++) {
      const st = pickRandomStory(L, 'NTR', () => i / 5)!
      expect(st.id).toBe(s1)
      expect(st.scenes.map((x) => x.name)).toEqual(['a', 'b'])
    }
    expect(pickRandomStory(L, '不存在')).toBeNull()
  })

  it('多表情按规定平均分配数量', () => {
    const s = newStore()
    const lib = new Lib(s)
    const e = lib.exprs
    const { units, errors } = expandTask(lib.task([lib.item('动作A', lib.outfitsA[1], [e[2], e[6], e[8]], 30)]), loadPlanLibrary(s), s.settings())
    expect(errors).toEqual([])
    expect(units.map((u) => u.meta.expression)).toEqual([...Array(10).fill('表情3'), ...Array(10).fill('表情7'), ...Array(10).fill('表情9')])
    for (const u of units) expect(u.positive.split(/,\s*/).filter((t) => /^expr\d$/.test(t)).length).toBe(1)
  })

  it('不能整除时报错，未选表情使用空表情', () => {
    const s = newStore()
    const lib = new Lib(s)
    const r = expandTask(lib.task([lib.item('动作A', null, lib.exprs.slice(0, 4), 30)]), loadPlanLibrary(s), s.settings())
    expect(r.units).toEqual([])
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]).toContain('不能被 4 个表情平均分配')
    const r2 = expandTask(lib.task([lib.item('睡觉', null, [], 3)]), loadPlanLibrary(s), s.settings())
    expect(r2.units).toHaveLength(3)
    expect(r2.units.every((u) => u.modules.expression[0] === '' && u.meta.expression === '')).toBe(true)
  })

  it('单人画面不会被意外加入男性 Prompt（包括 POV）', () => {
    const s = newStore()
    const lib = new Lib(s)
    const { units, errors } = expandTask(
      lib.task([
        lib.item('睡觉', null, [], 1),
        lib.item('鸭子坐', null, [], 1, { camera_id: lib.pov }),
        lib.item('动作A', null, [], 1, { male_enabled: true, male_ids: [lib.maleAct], male_extra: 'hand on head' }),
        lib.item('动作B', null, [], 1, { male_enabled: false, male_ids: [lib.maleAct], male_extra: 'SHOULD_NOT_APPEAR' }),
      ]),
      loadPlanLibrary(s),
      s.settings(),
    )
    expect(errors).toEqual([])
    const [solo, pov, duo, off] = units
    for (const u of [solo, pov, off]) {
      expect(u.positive + u.negative).not.toContain('MALE')
      expect(u.positive).not.toContain('SHOULD_NOT_APPEAR')
      expect(u.meta.male).toBe(false)
    }
    expect(pov.positive).toContain('pov')
    expect(duo.positive).toContain('1boy, MALE_BASE_TAG, MALE_ACTION, hand on head')
    expect(duo.negative).toContain('MALE_NEG')
  })

  it('剧情场景只有勾选男性出场时才加入男性', () => {
    const s = newStore()
    const lib = new Lib(s)
    const sid = s.save('stories', { genre: 'g', name: 's', scenes: [
      { name: '单人', positive: 'alone', negative: '', count: 1, with_male: false },
      { name: '双人', positive: 'together', negative: '', count: 1, with_male: true },
    ] })
    const { units } = expandTask(lib.task([], { story_id: sid }), loadPlanLibrary(s), s.settings())
    expect(units[0].positive).not.toContain('MALE_BASE_TAG')
    expect(units[1].positive).toContain('MALE_BASE_TAG')
  })

  it('镜头配置按组合顺序加入最终 Prompt', () => {
    const s = newStore()
    const lib = new Lib(s)
    const set = s.settings()
    const data = lib.task([lib.item('睡觉', lib.outfitsA[0], [lib.exprs[0]], 1, { camera_id: lib.above })])
    let { units } = expandTask(data, loadPlanLibrary(s), set)
    expect(units[0].positive).toBe('masterpiece, best quality,\n\nfrom above,\n\n1girl, char_a, red hair,\n\noutfit_a1,\n\nsleeping, lying,\n\nexpr1')
    set.compose_order = ['camera', 'global', 'character', 'outfit', 'content', 'expression', 'male', 'extra']
    ;({ units } = expandTask(data, loadPlanLibrary(s), set))
    expect(units[0].positive.startsWith('from above,\n\nmasterpiece')).toBe(true)
    expect(units[0].meta.camera).toBe('俯视')
  })

  it('引用已删除的模板时给出提示', () => {
    const s = newStore()
    const lib = new Lib(s)
    const data = lib.task([lib.item('睡觉', null, [], 1, { camera_id: lib.pov })])
    s.remove('templates', lib.pov)
    expect(expandTask(data, loadPlanLibrary(s), s.settings()).errors.some((e) => e.includes('镜头模板已被删除'))).toBe(true)
  })

  it('PlanLibrary 可以在界面中直接构造（与主进程结果一致）', () => {
    const s = newStore()
    const lib = new Lib(s)
    const data = lib.task([lib.item('睡觉', lib.outfitsA[0], [lib.exprs[1], lib.exprs[2]], 4)])
    const L2 = new PlanLibrary(s.list('templates'), s.list('characters'), s.list('outfits'), s.list('stories'))
    expect(expandTask(data, L2, s.settings())).toEqual(expandTask(data, loadPlanLibrary(s), s.settings()))
  })
})
