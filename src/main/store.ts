import { FileLibrary, FILE_TABLES } from './file-library'
import { isLegacyDefaultOrder } from '@shared/prompt'
// SQLite 存储（Electron 内置 node:sqlite）。表结构与旧版 Python 程序完全相同，
// 旧数据库可直接打开；所有 Prompt 文本以原始字符串写入 TEXT 列，读写不做转换。

import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  DEFAULT_SETTINGS,
  type Character,
  type InputValue,
  type Outfit,
  type Run,
  type RunCounts,
  type RunUnit,
  type Settings,
  type Story,
  type Task,
  type Template,
  type UnitMeta,
  type Workflow,
} from '@shared/types'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS templates (
    id INTEGER PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
    positive TEXT NOT NULL DEFAULT '', negative TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', sort INTEGER NOT NULL DEFAULT 0,
    created_at REAL, updated_at REAL, target TEXT NOT NULL DEFAULT 'any', parent_id INTEGER);
CREATE INDEX IF NOT EXISTS idx_templates_kind ON templates(kind);
CREATE TABLE IF NOT EXISTS characters (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT '', tag TEXT NOT NULL DEFAULT '',
    positive TEXT NOT NULL DEFAULT '', negative TEXT NOT NULL DEFAULT '', loras TEXT NOT NULL DEFAULT '[]',
    note TEXT NOT NULL DEFAULT '', sort INTEGER NOT NULL DEFAULT 0, created_at REAL, updated_at REAL);
CREATE TABLE IF NOT EXISTS outfits (
    id INTEGER PRIMARY KEY, character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    name TEXT NOT NULL DEFAULT '', positive TEXT NOT NULL DEFAULT '', negative TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '', sort INTEGER NOT NULL DEFAULT 0, created_at REAL, updated_at REAL);
CREATE INDEX IF NOT EXISTS idx_outfits_char ON outfits(character_id);
CREATE TABLE IF NOT EXISTS stories (
    id INTEGER PRIMARY KEY, genre TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '', scenes TEXT NOT NULL DEFAULT '[]', sort INTEGER NOT NULL DEFAULT 0,
    created_at REAL, updated_at REAL);
CREATE TABLE IF NOT EXISTS workflows (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT '', api_json TEXT NOT NULL DEFAULT '{}',
    mapping TEXT NOT NULL DEFAULT '[]', note TEXT NOT NULL DEFAULT '', sort INTEGER NOT NULL DEFAULT 0,
    created_at REAL, updated_at REAL);
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT '', data TEXT NOT NULL DEFAULT '{}',
    sort INTEGER NOT NULL DEFAULT 0, created_at REAL, updated_at REAL);
CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY, task_id INTEGER, name TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'queued', workflow_name TEXT NOT NULL DEFAULT '',
    workflow_json TEXT NOT NULL DEFAULT '{}', mapping_json TEXT NOT NULL DEFAULT '[]',
    created_at REAL, finished_at REAL);
CREATE TABLE IF NOT EXISTS run_units (
    id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', section TEXT NOT NULL DEFAULT '',
    item_label TEXT NOT NULL DEFAULT '', meta TEXT NOT NULL DEFAULT '{}', modules TEXT NOT NULL DEFAULT '{}',
    positive TEXT NOT NULL DEFAULT '', negative TEXT NOT NULL DEFAULT '', seed INTEGER,
    inputs TEXT NOT NULL DEFAULT '[]', prompt_id TEXT, client_id TEXT, error TEXT NOT NULL DEFAULT '',
    outputs TEXT NOT NULL DEFAULT '[]', attempts INTEGER NOT NULL DEFAULT 0, submitted_at REAL, finished_at REAL);
CREATE INDEX IF NOT EXISTS idx_units_run ON run_units(run_id, idx);
CREATE INDEX IF NOT EXISTS idx_units_status ON run_units(status);
`

/**
 * 数据库版本（PRAGMA user_version）。
 * 0 = 旧版 Python 程序创建的数据库；1 = Electron 版（表结构相同，仅登记版本）。
 * 将来需要改表结构时在 MIGRATIONS 中追加步骤；每次迁移前都会先自动备份。
 */
export const SCHEMA_VERSION = 2
const MIGRATIONS: Record<number, (db: DatabaseSync) => void> = {
  1: () => {
    /* v0 → v1：结构不变 */
  },
  // v1 → v2：素材增加适用对象与层级（只新增列，不修改已有数据）
  2: (db) => {
    const cols = (db.prepare('PRAGMA table_info(templates)').all() as { name: string }[]).map((c) => c.name)
    if (!cols.includes('target')) db.exec("ALTER TABLE templates ADD COLUMN target TEXT NOT NULL DEFAULT 'any'")
    if (!cols.includes('parent_id')) db.exec('ALTER TABLE templates ADD COLUMN parent_id INTEGER')
  },
}

export const TABLES = {
  templates: { cols: ['kind', 'name', 'positive', 'negative', 'category', 'tags', 'note', 'sort', 'target', 'parent_id'], json: [] as string[] },
  characters: { cols: ['name', 'tag', 'positive', 'negative', 'loras', 'note', 'sort'], json: ['loras'] },
  outfits: { cols: ['character_id', 'name', 'positive', 'negative', 'note', 'sort'], json: [] as string[] },
  stories: { cols: ['genre', 'name', 'note', 'scenes', 'sort'], json: ['scenes'] },
  workflows: { cols: ['name', 'api_json', 'mapping', 'note', 'sort'], json: ['api_json', 'mapping'] },
  tasks: { cols: ['name', 'data', 'sort'], json: ['data'] },
} as const
export type TableName = keyof typeof TABLES
type RowOf = { templates: Template; characters: Character; outfits: Outfit; stories: Story; workflows: Workflow; tasks: Task }

const UNIT_JSON = ['meta', 'modules', 'inputs', 'outputs'] as const
type SqlValue = string | number | null
type Row = Record<string, unknown>

const now = () => Date.now() / 1000
const localDate = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
const toSql = (v: unknown): SqlValue => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : (v as SqlValue))

export interface OpenInfo {
  migratedFrom: number | null
  backup: string | null
}

export class Store {
  files?: FileLibrary
  db: DatabaseSync
  path: string
  openInfo: OpenInfo = { migratedFrom: null, backup: null }

  constructor(path: string, opts: { backupDir?: string } = {}) {
    this.path = path
    const existed = path !== ':memory:' && existsSync(path)
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
    const version = Number((this.db.prepare('PRAGMA user_version').get() as Row).user_version)
    if (existed && version < SCHEMA_VERSION && opts.backupDir) {
      // 迁移前先完整备份旧数据库
      this.openInfo.backup = this.backup(opts.backupDir, `before-v${SCHEMA_VERSION}-from-v${version}`)
    }
    this.db.exec(SCHEMA)
    if (version < SCHEMA_VERSION) {
      this.tx(() => {
        for (let v = version + 1; v <= SCHEMA_VERSION; v++) MIGRATIONS[v]?.(this.db)
        this.db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`)
      })
      if (existed) this.openInfo.migratedFrom = version
    }
    this.upgradeComposeOrder()
  }

  /**
   * Prompt 组合顺序改为「全局 → 场景 → 镜头 → 主角色 → 双人互动 → 第二角色」。
   * 只在设置仍是旧版默认顺序（用户没有自定义过）时升级一次；自定义顺序保持不变，新模块按相邻位置补入。
   */
  private upgradeComposeOrder() {
    if (this.one("SELECT 1 FROM settings WHERE key='compose_order_rev'")) return
    const r = this.one("SELECT value FROM settings WHERE key='compose_order'")
    let order: unknown = null
    try {
      order = r ? JSON.parse(String(r.value)) : null
    } catch {
      order = null
    }
    if (isLegacyDefaultOrder(order)) this.setSetting('compose_order', DEFAULT_SETTINGS.compose_order)
    this.setSetting('compose_order_rev', 3)
  }

  close() {
    this.db.close()
  }

  /** 使用 VACUUM INTO 生成一致的备份（WAL 模式下也安全），返回备份文件路径 */
  backup(dir: string, label: string): string {
    mkdirSync(dir, { recursive: true })
    const d = new Date()
    const stamp = `${localDate(d)}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`
    let file = join(dir, `comfyengi-${stamp}-${label}.db`)
    let n = 1
    while (existsSync(file)) file = join(dir, `comfyengi-${stamp}-${n++}-${label}.db`)
    this.db.prepare('VACUUM INTO ?').run(file)
    return file
  }

  /** 每天首次启动时自动备份，保留最近 keep 份自动备份 */
  dailyBackup(dir: string, keep = 10): string | null {
    mkdirSync(dir, { recursive: true })
    const today = localDate(new Date())
    const auto = readdirSync(dir).filter((f) => f.endsWith('-auto.db')).sort()
    if (auto.some((f) => f.startsWith(`comfyengi-${today}`))) return null
    const file = this.backup(dir, 'auto')
    const all = readdirSync(dir).filter((f) => f.endsWith('-auto.db')).sort()
    for (const f of all.slice(0, Math.max(0, all.length - keep))) rmSync(join(dir, f), { force: true })
    return file
  }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN')
    try {
      const r = fn()
      this.db.exec('COMMIT')
      return r
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  private all(sql: string, ...params: SqlValue[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[]
  }
  private one(sql: string, ...params: SqlValue[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined
  }
  private run(sql: string, ...params: SqlValue[]) {
    return this.db.prepare(sql).run(...params)
  }

  private decode<T extends TableName>(table: T, rec: Row | undefined): RowOf[T] | null {
    if (!rec) return null
    const r: Row = { ...rec }
    for (const c of TABLES[table].json) {
      if (typeof r[c] === 'string') r[c] = r[c] ? JSON.parse(r[c] as string) : null
    }
    return r as unknown as RowOf[T]
  }

  // ---------- 通用增删改查 ----------
  list<T extends TableName>(table: T, where = '', params: SqlValue[] = [], order = 'sort, id'): RowOf[T][] {
    if (this.files && FILE_TABLES.includes(table)) {
      const rows = this.files.list(table)
      return (where === 'character_id=?' ? rows.filter(r => r.character_id === params[0]) : rows) as unknown as RowOf[T][]
    }
    const sql = `SELECT * FROM ${table}${where ? ` WHERE ${where}` : ''} ORDER BY ${order}`
    return this.all(sql, ...params).map((r) => this.decode(table, r)!)
  }

  get<T extends TableName>(table: T, id: number | null | undefined): RowOf[T] | null {
    if (id == null) return null
    if (this.files && FILE_TABLES.includes(table)) return (this.files.list(table).find(r => r.id === id) ?? null) as unknown as RowOf[T] | null
    return this.decode(table, this.one(`SELECT * FROM ${table} WHERE id=?`, id))
  }

  /** 插入或更新一条记录，返回 id。只写入 rec 中出现的列 */
  save(table: TableName, rec: Row): number {
    if (this.files && FILE_TABLES.includes(table)) return this.files.save(table, rec)
    const { cols, json } = TABLES[table]
    const values: [string, SqlValue][] = []
    for (const c of cols) {
      if (c in rec) values.push([c, (json as readonly string[]).includes(c) ? JSON.stringify(rec[c] ?? null) : toSql(rec[c])])
    }
    const id = rec.id as number | undefined
    const t = now()
    if (id) {
      if (values.length) {
        const sets = values.map(([c]) => `${c}=?`).join(', ')
        this.run(`UPDATE ${table} SET ${sets}, updated_at=? WHERE id=?`, ...values.map((v) => v[1]), t, id)
      }
      return id
    }
    if ((cols as readonly string[]).includes('sort') && !values.some(([c]) => c === 'sort')) {
      values.push(['sort', Number((this.one(`SELECT COALESCE(MAX(sort),0)+1 AS s FROM ${table}`) as Row).s)])
    }
    const names = [...values.map(([c]) => c), 'created_at', 'updated_at']
    const r = this.run(
      `INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
      ...values.map((v) => v[1]),
      t,
      t,
    )
    return Number(r.lastInsertRowid)
  }

  /** 主体位的子体位（类似角色的服装：复制、删除主体位时一起处理） */
  private subpositionsOf(table: TableName, id: number): Template[] {
    if (table !== 'templates' || (this.get('templates', id) as Template | null)?.kind !== 'position') return []
    return this.list('templates').filter((t) => t.kind === 'subposition' && t.parent_id === id)
  }

  remove(table: TableName, id: number) {
    const subs = this.subpositionsOf(table, id)
    if (this.files && FILE_TABLES.includes(table)) {
      if (table === 'characters') for (const o of this.listOutfits(id)) this.files.remove('outfits',o.id)
      for (const t of subs) this.files.remove('templates', t.id) // 移入工作区回收站 .comfyengi/trash，可找回
      this.files.remove(table,id); return
    }
    this.tx(() => {
      for (const t of subs) this.run('DELETE FROM templates WHERE id=?', t.id)
      this.run(`DELETE FROM ${table} WHERE id=?`, id)
    })
  }

  setOrder(table: TableName, ids: number[]) {
    if (this.files && FILE_TABLES.includes(table)) { ids.forEach((id,i) => this.save(table,{id,sort:i+1})); return }
    this.tx(() => ids.forEach((id, i) => this.run(`UPDATE ${table} SET sort=? WHERE id=?`, i + 1, id)))
  }

  duplicate(table: TableName, id: number, suffix = ' 副本'): number | null {
    const rec = this.get(table, id) as Row | null
    if (!rec) return null
    delete rec.id
    delete rec.sort
    if (typeof rec.name === 'string') rec.name = rec.name + suffix
    return this.tx(() => {
      const newId = this.save(table, rec)
      if (table === 'characters') {
        for (const o of this.listOutfits(id)) {
          const { id: _old, ...rest } = o
          void _old
          this.save('outfits', { ...rest, character_id: newId })
        }
      }
      for (const t of this.subpositionsOf(table, id)) {
        const { id: _old, _revision: _rev, ...rest } = t
        void _old
        void _rev
        this.save('templates', { ...rest, parent_id: newId })
      }
      return newId
    })
  }

  listOutfits(characterId: number): Outfit[] {
    return this.list('outfits', 'character_id=?', [characterId])
  }

  // ---------- 设置 ----------
  getSetting<K extends keyof Settings>(key: K): Settings[K] {
    const r = this.one('SELECT value FROM settings WHERE key=?', key)
    if (!r) return structuredClone(DEFAULT_SETTINGS[key])
    return JSON.parse(String(r.value)) as Settings[K]
  }

  setSetting(key: string, value: unknown) {
    this.run(
      'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      key,
      JSON.stringify(value ?? null),
    )
  }

  settings(): Settings {
    const out = {} as Record<string, unknown>
    for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) out[k] = this.getSetting(k)
    return out as unknown as Settings
  }

  /** 返回引用某个模板 / 角色 / 剧情的任务名称，用于删除前提示 */
  tasksReferencing(field: string, id: number): string[] {
    const names: string[] = []
    for (const t of this.list('tasks')) {
      const d = (t.data ?? {}) as unknown as Record<string, unknown>
      let hit = d[field] === id
      for (const it of (d.items as Record<string, unknown>[] | undefined) ?? []) {
        const v = it[field]
        if (v === id || (Array.isArray(v) && v.includes(id))) hit = true
      }
      if (hit) names.push(t.name)
    }
    return names
  }

  // ---------- 执行队列 ----------
  createRun(
    taskId: number | null,
    name: string,
    workflowName: string,
    workflowJson: unknown,
    mapping: unknown,
    units: { section: string; item_label: string; meta: UnitMeta; modules: unknown; positive: string; negative: string; seed: number; inputs: InputValue[] }[],
  ): number {
    return this.tx(() => {
      const pos = Number((this.one('SELECT COALESCE(MAX(position),0)+1 AS p FROM runs') as Row).p)
      const runId = Number(
        this.run(
          'INSERT INTO runs(task_id, name, position, status, workflow_name, workflow_json, mapping_json, created_at) VALUES(?,?,?,?,?,?,?,?)',
          taskId,
          name,
          pos,
          'queued',
          workflowName,
          JSON.stringify(workflowJson),
          JSON.stringify(mapping),
          now(),
        ).lastInsertRowid,
      )
      const ins = this.db.prepare(
        'INSERT INTO run_units(run_id, idx, status, section, item_label, meta, modules, positive, negative, seed, inputs) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      )
      units.forEach((u, i) =>
        ins.run(runId, i, 'pending', u.section, u.item_label, JSON.stringify(u.meta), JSON.stringify(u.modules), u.positive, u.negative, u.seed, JSON.stringify(u.inputs)),
      )
      return runId
    })
  }

  getRun(runId: number): (Run & { workflow_json: Record<string, never>; mapping_json: unknown[] }) | null {
    const r = this.one('SELECT * FROM runs WHERE id=?', runId)
    if (!r) return null
    return { ...(r as unknown as Run), workflow_json: JSON.parse(String(r.workflow_json)), mapping_json: JSON.parse(String(r.mapping_json)), counts: this.runCounts(runId) }
  }

  listRuns(includeFinished = true): Run[] {
    const where = includeFinished ? '' : "WHERE status='queued'"
    return this.all(`SELECT id, task_id, name, position, status, workflow_name, created_at, finished_at FROM runs ${where} ORDER BY position, id`).map(
      (r) => ({ ...(r as unknown as Run), counts: this.runCounts(Number(r.id)) }),
    )
  }

  runCounts(runId: number): RunCounts {
    const counts: RunCounts = { total: 0 }
    for (const r of this.all('SELECT status, COUNT(*) AS n FROM run_units WHERE run_id=? GROUP BY status', runId)) {
      counts[r.status as keyof RunCounts] = Number(r.n)
      counts.total += Number(r.n)
    }
    return counts
  }

  setRunStatus(runId: number, status: string) {
    this.run('UPDATE runs SET status=?, finished_at=? WHERE id=?', status, status !== 'queued' ? now() : null, runId)
  }

  moveRun(runId: number, delta: number) {
    const ids = this.all('SELECT id FROM runs ORDER BY position, id').map((r) => Number(r.id))
    const i = ids.indexOf(runId)
    if (i < 0) return
    const j = Math.max(0, Math.min(ids.length - 1, i + delta))
    ids.splice(j, 0, ids.splice(i, 1)[0])
    this.tx(() => ids.forEach((id, p) => this.run('UPDATE runs SET position=? WHERE id=?', p + 1, id)))
  }

  reorderRuns(ordered: number[]) {
    const ids = this.all('SELECT id FROM runs ORDER BY position, id').map((r) => Number(r.id))
    const rest = ids.filter((id) => !ordered.includes(id))
    this.tx(() => [...ordered.filter((id) => ids.includes(id)), ...rest].forEach((id, p) => this.run('UPDATE runs SET position=? WHERE id=?', p + 1, id)))
  }

  /** 移出队列：未执行的单元标记为 skipped，已有记录保留 */
  removeRun(runId: number) {
    this.tx(() => {
      this.run("UPDATE run_units SET status='skipped' WHERE run_id=? AND status='pending'", runId)
      this.run("UPDATE runs SET status='removed', finished_at=? WHERE id=?", now(), runId)
    })
  }

  deleteRun(runId: number) {
    this.run('DELETE FROM runs WHERE id=?', runId)
  }

  retryFailed(runId: number): number {
    return this.tx(() => {
      const n = Number(this.run("UPDATE run_units SET status='pending', error='' WHERE run_id=? AND status='failed'", runId).changes)
      if (n) this.run("UPDATE runs SET status='queued', finished_at=NULL WHERE id=?", runId)
      return n
    })
  }

  private decodeUnit(u: Row | undefined): RunUnit | null {
    if (!u) return null
    const r: Row = { ...u }
    for (const c of UNIT_JSON) r[c] = r[c] ? JSON.parse(String(r[c])) : null
    return r as unknown as RunUnit
  }

  nextPendingUnit(): RunUnit | null {
    return this.decodeUnit(
      this.one(
        "SELECT u.* FROM run_units u JOIN runs r ON r.id=u.run_id WHERE r.status='queued' AND u.status='pending' ORDER BY r.position, r.id, u.idx LIMIT 1",
      ),
    )
  }

  /** 已提交（或正在提交）但尚未得到结果的单元——程序重启后需要核对 */
  inFlightUnits(): RunUnit[] {
    return this.all("SELECT * FROM run_units WHERE status IN ('submitting','submitted') ORDER BY run_id, idx").map((u) => this.decodeUnit(u)!)
  }

  getUnit(unitId: number): RunUnit | null {
    return this.decodeUnit(this.one('SELECT * FROM run_units WHERE id=?', unitId))
  }

  listUnits(runId: number): RunUnit[] {
    return this.all('SELECT * FROM run_units WHERE run_id=? ORDER BY idx', runId).map((u) => this.decodeUnit(u)!)
  }

  updateUnit(unitId: number, fields: Partial<Record<keyof RunUnit, unknown>>) {
    const entries = Object.entries(fields).map(([k, v]) => [k, (UNIT_JSON as readonly string[]).includes(k) ? JSON.stringify(v) : toSql(v)] as [string, SqlValue])
    if (!entries.length) return
    this.run(`UPDATE run_units SET ${entries.map(([k]) => `${k}=?`).join(', ')} WHERE id=?`, ...entries.map((e) => e[1]), unitId)
  }

  finishRunIfComplete(runId: number): boolean {
    const c = this.runCounts(runId)
    const open = (c.pending ?? 0) + (c.submitting ?? 0) + (c.submitted ?? 0)
    const run = this.one('SELECT status FROM runs WHERE id=?', runId)
    if (run && run.status === 'queued' && open === 0) {
      this.setRunStatus(runId, 'done')
      return true
    }
    return false
  }

  history(search = '', status = '', limit = 500): RunUnit[] {
    let sql =
      "SELECT u.*, r.name AS run_name FROM run_units u JOIN runs r ON r.id=u.run_id WHERE u.status IN ('done','failed')"
    const params: SqlValue[] = []
    if (status) {
      sql += ' AND u.status=?'
      params.push(status)
    }
    if (search) {
      const like = `%${search}%`
      sql += ' AND (r.name LIKE ? OR u.item_label LIKE ? OR u.meta LIKE ? OR u.positive LIKE ? OR u.prompt_id LIKE ?)'
      params.push(like, like, like, like, like)
    }
    sql += ' ORDER BY u.finished_at DESC, u.id DESC LIMIT ?'
    params.push(limit)
    return this.all(sql, ...params).map((u) => this.decodeUnit(u)!)
  }
}
