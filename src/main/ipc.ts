import { LoraManager, pathKey } from './lora-manager'
// IPC 处理：只响应白名单方法，并对每个参数做类型校验；Renderer 无法直接访问文件系统或数据库。

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { BrowserWindow, dialog, ipcMain, nativeImage, shell, app } from 'electron'
import { API_METHODS, INVOKE_CHANNEL, type Api, type ApiMethod } from '@shared/api'
import { checkAgainstObjectInfo, ComfyError, loadApiWorkflow, mappingValues, validateMapping } from '@shared/mapping'
import { normalizeTaskData } from '@shared/planner'
import { DEFAULT_SETTINGS, TEMPLATE_KINDS, type Library, type OutputFile, type RunUnit, type Settings } from '@shared/types'
import { ComfyClient } from './comfy-client'
import { enqueueTask, finalWorkflow, planForTask } from './plan'
import type { Runner } from './runner'
import { TABLES, type Store, type TableName } from './store'

class BadArg extends Error {}

const int = (v: unknown, name = '参数'): number => {
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new BadArg(`${name} 必须是整数`)
  return v
}
const str = (v: unknown, name = '参数'): string => {
  if (typeof v !== 'string') throw new BadArg(`${name} 必须是文本`)
  return v
}
const intArray = (v: unknown, name = '参数'): number[] => {
  if (!Array.isArray(v)) throw new BadArg(`${name} 必须是数组`)
  return v.map((x) => int(x, name))
}
const plain = (v: unknown, name = '参数'): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new BadArg(`${name} 必须是对象`)
  return v as Record<string, unknown>
}

const TEXT_COLS = new Set(['kind', 'name', 'positive', 'negative', 'category', 'tags', 'note', 'tag', 'genre'])
const INT_COLS = new Set(['sort', 'character_id'])

/** 只保留表中允许的列，并检查字段类型 */
function record(table: TableName, v: unknown): Record<string, unknown> {
  const src = plain(v, '记录')
  const out: Record<string, unknown> = {}
  if (src._revision) out._revision = str(src._revision)
  if (src.id !== undefined && src.id !== null) out.id = int(src.id, 'id')
  for (const c of TABLES[table].cols as readonly string[]) {
    if (!(c in src)) continue
    const val = src[c]
    if (c === 'target') {
      if (val !== 'any' && val !== 'female' && val !== 'male') throw new BadArg('无效的适用对象')
      out[c] = val
    } else if (c === 'parent_id') out[c] = val === null ? null : int(val, 'parent_id')
    else if (TEXT_COLS.has(c)) out[c] = str(val, c)
    else if (INT_COLS.has(c)) out[c] = int(val, c)
    else if (c === 'loras') {
      if (!Array.isArray(val)) throw new BadArg('loras 必须是数组')
      const words = (v: unknown, name: string) => (v == null ? undefined : Array.isArray(v) ? v.map((w) => str(w, name)) : (() => { throw new BadArg(`${name} 必须是数组`) })())
      out[c] = val.map((l) => ({ resource_id: plain(l).resource_id == null ? undefined : str(plain(l).resource_id), name: str(plain(l).name, 'LoRA 名称'), strength: Number(plain(l).strength ?? 1), trigger_words: words(plain(l).trigger_words, '触发词'), custom_triggers: words(plain(l).custom_triggers, '自定义触发词') }))
    } else if (c === 'scenes') {
      if (!Array.isArray(val)) throw new BadArg('scenes 必须是数组')
      out[c] = val.map((x) => {
        const s = plain(x, '场景')
        return { name: str(s.name ?? ''), positive: str(s.positive ?? ''), negative: str(s.negative ?? ''), count: Math.max(0, Math.trunc(Number(s.count) || 0)), with_male: !!s.with_male }
      })
    } else if (c === 'mapping') {
      if (!Array.isArray(val)) throw new BadArg('mapping 必须是数组')
      out[c] = val.map((x) => {
        const e = plain(x, '映射')
        return { source: str(e.source), node: String(e.node ?? ''), input: str(e.input ?? ''), modules: Array.isArray(e.modules) ? e.modules.map((m) => str(m)) : [], template: str(e.template ?? '') }
      })
    } else if (c === 'api_json' || c === 'data') {
      out[c] = c === 'data' ? normalizeTaskData(plain(val, 'data') as never) : plain(val, c)
    }
  }
  if ('kind' in out && !(out.kind as string in TEMPLATE_KINDS)) throw new BadArg(`未知的模板类型 ${out.kind}`)
  return out
}

export interface IpcContext {
  chooseVault: (create:boolean, migrate:boolean) => Promise<void>
  store: Store
  runner: Runner
  dataDir: string
  backupDir: string
  logs: string[]
  window: () => BrowserWindow | null
}

function settingValue(key: string, value: unknown): unknown {
  if (!(key in DEFAULT_SETTINGS)) throw new BadArg(`未知的设置项 ${key}`)
  const def = DEFAULT_SETTINGS[key as keyof Settings]
  if (key === 'default_workflow_id' || key === 'last_task_id') return value === null ? null : int(value, key)
  if (key === 'lora_display_name') { if (value !== 'model' && value !== 'file') throw new BadArg('无效的显示名称选项'); return value }
  if (Array.isArray(def)) {
    if (!Array.isArray(value)) throw new BadArg(`${key} 必须是数组`)
    return value.map((x) => str(x))
  }
  if (typeof def === 'number') {
    const n = Number(value)
    if (!Number.isFinite(n) || n < 0) throw new BadArg(`${key} 必须是非负数`)
    return n
  }
  if (typeof def === 'boolean') return !!value
  return str(value, key)
}

function libraryOf(store: Store): Library {
  return {
    templates: store.list('templates'),
    characters: store.list('characters'),
    outfits: store.list('outfits'),
    stories: store.list('stories'),
    workflows: store.list('workflows').map((w) => ({
      id: w.id,
      name: w.name,
      note: w.note,
      nodes: Object.keys(w.api_json ?? {}).length,
      mapping: (w.mapping ?? []).length,
      errors: validateMapping(w.api_json ?? {}, w.mapping ?? []).filter(([l]) => l === 'error').length,
    })),
    tasks: store.list('tasks').map((t) => ({ id: t.id, name: t.name })),
    characterFolders: store.files?.folders() ?? [],
    settings: store.settings(),
  }
}

function localOutput(store: Store, o: OutputFile | undefined): string {
  if (!o) return ''
  if (o.path && existsSync(o.path)) return o.path
  const base = store.getSetting('comfy_output_dir')
  if (base && o.type === 'output') {
    const p = join(base, o.subfolder ?? '', o.filename)
    if (existsSync(p)) return p
  }
  return ''
}

const firstOutput = (u: RunUnit | null) => {
  const outs = u?.outputs ?? []
  return outs.find((o) => o.type === 'output') ?? outs[0]
}

export function registerIpc(ctx: IpcContext) {
  const { store, runner } = ctx
  const vault = () => { if (!store.files) throw new Error('角色文件夹需要先打开工作区'); return store.files }
  const loras = () => { if (!store.files) throw new Error('请先打开工作区'); return new LoraManager(store.files.root) }
  const handlers: { [K in ApiMethod]: (...args: unknown[]) => unknown } = {
    'vault.info': () => ({root:store.files?.root??null,errors:store.files?.errors??[]}),
    'vault.choose': (create,migrate) => { if(runner.isAlive()) throw new Error('请先安全停止队列，等待当前任务完成'); return ctx.chooseVault(!!create,!!migrate) },
    'loras.list': () => loras().list(),
    'loras.save': (r) => loras().save(plain(r) as never),
    'loras.roots': () => store.getSetting('lora_roots') ?? [],
    'loras.addRoot': async () => {
      const result=await dialog.showOpenDialog(ctx.window()!,{title:'添加 LoRA 目录（可多选；扫描只读取，不会修改或移动模型）',properties:['openDirectory','multiSelections']})
      if(result.canceled || !result.filePaths.length) return null
      const roots=[...(store.getSetting('lora_roots') ?? [])]
      for(const p of result.filePaths) if(!roots.some(r=>pathKey(r)===pathKey(p))) roots.push(p)
      store.setSetting('lora_roots',roots)
      return { roots, errors: await loras().scan(roots) }
    },
    'loras.removeRoot': (root) => {
      const roots=(store.getSetting('lora_roots') ?? []).filter(r=>pathKey(r)!==pathKey(str(root)))
      store.setSetting('lora_roots',roots); return roots
    },
    'loras.scan': () => loras().scan(store.getSetting('lora_roots') ?? []),
    'loras.preview': async (id) => {
      const result=await dialog.showOpenDialog(ctx.window()!,{title:'选择封面图片（会复制到工作区，不修改模型目录）',properties:['openFile'],filters:[{name:'图片',extensions:['png','jpg','jpeg','webp']}]})
      if(!result.canceled && result.filePaths[0]) await loras().preview(str(id),result.filePaths[0])
    },
    'loras.clearPreview': (id) => loras().clearPreview(str(id)),
    'loras.image': async(id, width) => {
      const w=Math.max(64,Math.min(1600,width==null?400:int(width,'width')))
      const src=await loras().imageSource(str(id),w)
      if(!src) return null
      // 视频封面：只返回页面抽帧后缓存的静态帧；完整视频通过 comfyengi-media:// 协议按需读取，不经过 IPC
      if(src.video) return existsSync(src.cache) ? `data:image/jpeg;base64,${(await readFile(src.cache)).toString('base64')}` : null
      // 缩略图缓存在工作区 .comfyengi/cache 中；源图片变化（修改时间 / 大小）后自动失效
      if(existsSync(src.cache)) return `data:image/jpeg;base64,${(await readFile(src.cache)).toString('base64')}`
      const img=nativeImage.createFromPath(src.source)
      if(!img.isEmpty()) {
        const out=img.getSize().width>w ? img.resize({width:w,quality:'good'}) : img
        const jpg=out.toJPEG(85)
        try { await mkdir(dirname(src.cache),{recursive:true}); await writeFile(src.cache,jpg) } catch { /* 缓存失败不影响显示 */ }
        return `data:image/jpeg;base64,${jpg.toString('base64')}`
      }
      // nativeImage 不能解码的格式（如 WebP）直接交给页面渲染
      if(src.size>12*1024*1024) return null
      const ext=extname(src.source).toLowerCase().replace('.','')
      const mime=ext==='webp'?'image/webp':ext==='png'?'image/png':'image/jpeg'
      return `data:${mime};base64,${(await readFile(src.source)).toString('base64')}`
    },
    'loras.saveFrame': async(id, data) => {
      const m=/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(str(data,'data'))
      if(!m) throw new BadArg('封面帧必须是 JPEG')
      await loras().saveFrame(str(id),Buffer.from(m[1],'base64'))
    },
    'loras.open': async(id) => { const r=(await loras().list()).find(r=>r.id===str(id)); if(r) shell.showItemInFolder(r.path) },
    'library.load':  () => { store.files?.scan(); return libraryOf(store) },
    'settings.set': (key, value) => store.setSetting(str(key), settingValue(str(key), value)),

    'templates.save': (rec) => ({ id: store.save('templates', record('templates', rec)) }),
    'templates.remove': (id) => store.remove('templates', int(id)),
    'templates.duplicate': (id) => ({ id: store.duplicate('templates', int(id)) }),
    'templates.reorder': (ids) => store.setOrder('templates', intArray(ids)),
    'characters.save': (rec) => ({ id: store.save('characters', record('characters', rec)) }),
    'characters.remove': (id) => store.remove('characters', int(id)),
    'characters.duplicate': (id) => ({ id: store.duplicate('characters', int(id)) }),
    'characters.create': (name, folder) => ({ id: vault().save('characters', { name: str(name, '名称') }, { folder: str(folder, '文件夹') }) }),
    'characters.move': (id, folder) => vault().moveCharacter(int(id), str(folder, '文件夹')),
    'folders.create': (parent, name) => vault().createFolder(str(parent, '文件夹'), str(name, '名称')),
    'folders.rename': (folder, name) => vault().renameFolder(str(folder, '文件夹'), str(name, '名称')),
    'folders.remove': (folder) => vault().removeFolder(str(folder, '文件夹')),
    'outfits.save': (rec) => ({ id: store.save('outfits', record('outfits', rec)) }),
    'outfits.remove': (id) => store.remove('outfits', int(id)),
    'outfits.duplicate': (id) => ({ id: store.duplicate('outfits', int(id)) }),
    'outfits.reorder': (ids) => store.setOrder('outfits', intArray(ids)),
    'stories.save': (rec) => ({ id: store.save('stories', record('stories', rec)) }),
    'stories.remove': (id) => store.remove('stories', int(id)),
    'stories.duplicate': (id) => ({ id: store.duplicate('stories', int(id)) }),
    references: (field, id) => store.tasksReferencing(str(field), int(id)),

    'workflows.get': (id) => store.get('workflows', int(id)),
    'workflows.import': async () => {
      const win = ctx.window()
      const r = await dialog.showOpenDialog(win!, { title: '选择 ComfyUI API 格式工作流', filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['openFile'] })
      if (r.canceled || !r.filePaths[0]) return null
      const fn = r.filePaths[0]
      try {
        const api = loadApiWorkflow(await readFile(fn, 'utf8'))
        const name = fn.replace(/^.*[\\/]/, '').replace(/\.json$/i, '')
        const id = store.save('workflows', { name, api_json: api, mapping: [], note: `导入自 ${fn}` })
        const def = store.getSetting('default_workflow_id')
        if (!def || !store.get('workflows', def)) store.setSetting('default_workflow_id', id)
        return { id }
      } catch (e) {
        return { error: (e as Error).message }
      }
    },
    'workflows.reimport': async (id) => {
      const wid = int(id)
      const r = await dialog.showOpenDialog(ctx.window()!, { title: '选择新导出的 API 工作流', filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['openFile'] })
      if (r.canceled || !r.filePaths[0]) return null
      try {
        const api = loadApiWorkflow(await readFile(r.filePaths[0], 'utf8'))
        store.save('workflows', { id: wid, api_json: api, note: `导入自 ${r.filePaths[0]}` })
        return { ok: true }
      } catch (e) {
        return { error: (e as Error).message }
      }
    },
    'workflows.save': (rec) => ({ id: store.save('workflows', record('workflows', rec)) }),
    'workflows.remove': (id) => {
      const wid = int(id)
      store.remove('workflows', wid)
      if (store.getSetting('default_workflow_id') === wid) store.setSetting('default_workflow_id', store.list('workflows')[0]?.id ?? null)
    },
    'workflows.onlineCheck': async (id) => {
      const wf = store.get('workflows', int(id))
      if (!wf) return [['error', '工作流不存在']]
      const s = store.settings()
      try {
        const obj = await new ComfyClient(s.comfy_url).objectInfo()
        const inputsList = store.list('characters').map((c) =>
          mappingValues({ loras: (c.loras ?? []).filter((l) => l.name), modules: {}, positive: '', negative: '', seed: 0, meta: {}, index: 0 }, wf.mapping, s, undefined, wf.api_json),
        )
        return [...validateMapping(wf.api_json, wf.mapping), ...checkAgainstObjectInfo(wf.api_json, inputsList, obj as never)]
      } catch (e) {
        return [['error', (e as Error).message]]
      }
    },

    'tasks.get': (id) => {
      const t = store.get('tasks', int(id))
      return t ? { ...t, data: normalizeTaskData(t.data) } : null
    },
    'tasks.create': (name, data) => ({ id: store.save('tasks', record('tasks', { name: str(name), data })) }),
    'tasks.save': (rec) => ({ id: store.save('tasks', record('tasks', rec)) }),
    'tasks.remove': (id) => store.remove('tasks', int(id)),
    'tasks.duplicate': (id) => ({ id: store.duplicate('tasks', int(id)) }),

    'plan.forTask': (taskId) => {
      const t = store.get('tasks', int(taskId))
      if (!t) throw new BadArg('任务不存在')
      const p = planForTask(store, t)
      return { ...p, workflow: p.workflow ? { id: p.workflow.id, name: p.workflow.name } : null }
    },
    'plan.finalWorkflow': (taskId, index) => {
      const t = store.get('tasks', int(taskId))
      if (!t) throw new BadArg('任务不存在')
      return finalWorkflow(store, t, int(index))
    },
    'plan.exportWorkflow': async (taskId, index) => {
      const t = store.get('tasks', int(taskId))
      if (!t) throw new BadArg('任务不存在')
      const f = finalWorkflow(store, t, int(index))
      const safe = `${t.name || 'task'}_${String(f.index + 1).padStart(4, '0')}`.replace(/[<>:"/|?*]/g, '_')
      const r = await dialog.showSaveDialog(ctx.window()!, { title: '导出最终工作流 JSON（API 格式）', defaultPath: `${safe}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] })
      if (r.canceled || !r.filePath) return null
      await writeFile(r.filePath, JSON.stringify(f.json, null, 2), 'utf8')
      return r.filePath
    },
    'queue.enqueue': (ids) => {
      const ok: { name: string; runId: number; count: number }[] = []
      const failed: { name: string; errors: string[] }[] = []
      for (const id of intArray(ids)) {
        const t = store.get('tasks', id)
        if (!t) continue
        const { runId, plan } = enqueueTask(store, t)
        if (runId) ok.push({ name: t.name, runId, count: plan.units.length })
        else failed.push({ name: t.name, errors: plan.errors.length ? plan.errors : plan.warnings })
      }
      return { ok, failed }
    },
    'queue.list': (inc) => store.listRuns(!!inc),
    'queue.units': (runId) => store.listUnits(int(runId)),
    'queue.reorder': (ids) => store.reorderRuns(intArray(ids)),
    'queue.remove': (runId) => {
      if (runner.current?.run_id === int(runId)) throw new BadArg('该队列项正在执行当前图片，请先暂停或停止')
      store.removeRun(int(runId))
    },
    'queue.delete': (runId) => {
      const rid = int(runId)
      if (runner.current?.run_id === rid || (runner.isAlive() && store.getRun(rid)?.status === 'queued'))
        throw new BadArg('执行中的队列项不能删除，请先停止或将其移出队列')
      store.deleteRun(rid)
    },
    'queue.retry': (runId) => store.retryFailed(int(runId)),
    'queue.pendingSummary': () => ({
      pending: store.listRuns(false).reduce((a, r) => a + (r.counts.pending ?? 0), 0),
      inFlight: store.inFlightUnits().length,
    }),

    'runner.status': () => runner.status(),
    'runner.precheck': async () => {
      const s = store.settings()
      try {
        const obj = await new ComfyClient(s.comfy_url).objectInfo()
        const msgs = new Set<string>()
        for (const r of store.listRuns(false)) {
          const run = store.getRun(r.id)!
          const units = store.listUnits(r.id).filter((u) => u.status === 'pending')
          if (!units.length) continue
          for (const [, m] of checkAgainstObjectInfo(run.workflow_json, units.map((u) => u.inputs ?? []), obj as never)) msgs.add(`[${r.name}] ${m}`)
        }
        return { error: null, messages: [...msgs] }
      } catch (e) {
        return { error: (e as Error).message, messages: [] }
      }
    },
    'runner.start': () => (runner.start(), runner.status()),
    'runner.pause': () => (runner.pause(), runner.status()),
    'runner.stop': () => (runner.stop(), runner.status()),
    'runner.interrupt': () => (runner.interrupt(), runner.status()),
    'runner.logs': () => ctx.logs.slice(-500),

    'history.list': (search, status, limit) => store.history(str(search), str(status), Math.min(5000, int(limit))),
    'history.image': async (unitId, size) => {
      const u = store.getUnit(int(unitId))
      const o = firstOutput(u)
      if (!o) return null
      const width = Math.max(64, Math.min(2048, int(size)))
      const local = localOutput(store, o)
      let img = local ? nativeImage.createFromPath(local) : null
      if (!img || img.isEmpty()) {
        try {
          img = nativeImage.createFromBuffer(await new ComfyClient(store.getSetting('comfy_url'), 10000).fetchImage(o))
        } catch {
          return null
        }
      }
      if (img.isEmpty()) return null
      const { width: w } = img.getSize()
      const out = w > width ? img.resize({ width, quality: 'good' }) : img
      return `data:image/jpeg;base64,${out.toJPEG(88).toString('base64')}`
    },
    'history.openImage': async (unitId) => {
      const u = store.getUnit(int(unitId))
      const o = firstOutput(u)
      const local = localOutput(store, o)
      if (local) return (await shell.openPath(local)) || null
      if (o) {
        await shell.openExternal(new ComfyClient(store.getSetting('comfy_url')).viewUrl(o))
        return null
      }
      return '这条记录没有输出文件信息'
    },
    'history.showInFolder': (unitId) => {
      const local = localOutput(store, firstOutput(store.getUnit(int(unitId))))
      if (!local) return '找不到本地文件：请在设置中填写 ComfyUI 输出目录（ComfyUI/output）'
      shell.showItemInFolder(local)
      return null
    },

    'comfy.test': async (url) => {
      try {
        const res = (await new ComfyClient(str(url)).systemStats()) as { system?: { comfyui_version?: string }; devices?: { name?: string }[] }
        const devs = (res?.devices ?? []).map((d) => d.name).filter(Boolean).join(', ')
        return { ok: true, info: `ComfyUI ${res?.system?.comfyui_version ?? ''}${devs ? ` · ${devs}` : ''}`.trim() }
      } catch (e) {
        return { ok: false, error: e instanceof ComfyError ? e.message : String(e) }
      }
    },
    'app.info': () => ({
      version: app.getVersion(),
      dataDir: ctx.dataDir,
      dbPath: store.path,
      backupDir: ctx.backupDir,
      migratedFrom: store.openInfo.migratedFrom,
      backup: store.openInfo.backup,
    }),
    'app.openDataDir': () => void shell.openPath(ctx.dataDir),
    'app.backupNow': () => store.backup(ctx.backupDir, 'manual'),
    'app.chooseOutputDir': async () => {
      const r = await dialog.showOpenDialog(ctx.window()!, { title: '选择 ComfyUI 输出目录', properties: ['openDirectory'] })
      return r.canceled ? null : (r.filePaths[0] ?? null)
    },
  }

  const allowed = new Set<string>(API_METHODS)
  ipcMain.handle(INVOKE_CHANNEL, async (event, method: unknown, args: unknown) => {
    // 只接受来自本应用窗口的调用
    const win = ctx.window()
    if (!win || event.sender !== win.webContents) throw new Error('拒绝的调用来源')
    if (typeof method !== 'string' || !allowed.has(method)) throw new Error(`未知的方法 ${String(method)}`)
    if (!Array.isArray(args)) throw new Error('参数格式错误')
    try {
      return { ok: true, value: await handlers[method as ApiMethod](...args) }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
  return handlers as unknown as { [K in ApiMethod]: (...a: Parameters<Api[K]>) => unknown }
}
