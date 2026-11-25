/**
 * Daily plan: host half.
 *
 * Owns the task records in one JSON file, serves the panel's JSON API under
 * /daily-plan-api/*, and registers the `daily_tasks` model-facing tool so the
 * agent and the panel operate on the same data.
 *
 * Cloud sync lives in `sync.js`: a merge document (tasks + deletion tombstones)
 * is pulled, merged with this machine's list, and pushed back, so several
 * machines converge on one list. Configuration and credentials are managed
 * through the `daily_sync` tool; the panel shows the sync state.
 *
 * Deliberately dependency-free: this file imports no DSH package, so the bundle
 * installs from npm or a Git checkout without any peer package to resolve. The
 * tool definition below is the plain shape the tool registry accepts, and the
 * routes are raw `ServerResponse` handlers (the resource-route form only answers
 * GET/HEAD, which would 405 the panel's POST writes).
 */

import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import {
  createS3Transport,
  createSyncEngine,
  createWebDavTransport,
  emptyDoc,
} from './sync.js'
import { completedTasks, renderMarkdown, renderXlsx } from './export.js'
import { createQuoteCache } from './quote.js'

export const name = 'daily-plan'

/** Host services this plugin consumes. */
export const inject = ['tools', 'webServer']

/** Canonical API prefix, then fallbacks for a route orphaned by a reload. */
const API_PATHS = ['/daily-plan-api', '/daily-tasks-api']

const MAX_TASKS = 500
const MAX_TITLE = 200
const MAX_NOTE = 1000
const MAX_BODY = 256 * 1024
const VERSION = '1.6.6'

const PRIORITIES = ['normal', 'high', 'low']

/** Repetition rules a task can carry; `none` is the default. */
export const REPEAT_RULES = ['none', 'daily', 'weekdays', 'weekly', 'monthly']

/**
 * The next due time of a repeating task, always strictly after `now`.
 * Days/months are stepped in UTC so a local wall-clock time survives (China has
 * no DST); a monthly step clamps to the last day of a shorter month.
 */
export function nextDue(dueIso, repeat, now = Date.now()) {
  if (!REPEAT_RULES.includes(repeat) || repeat === 'none') return null
  const start = new Date(dueIso)
  if (!Number.isFinite(start.getTime())) return null
  const next = new Date(start.getTime())
  const advance = () => {
    if (repeat === 'daily') next.setUTCDate(next.getUTCDate() + 1)
    else if (repeat === 'weekdays') {
      do {
        next.setUTCDate(next.getUTCDate() + 1)
      } while (next.getUTCDay() === 0 || next.getUTCDay() === 6)
    } else if (repeat === 'weekly') next.setUTCDate(next.getUTCDate() + 7)
    else {
      const day = next.getUTCDate()
      next.setUTCDate(1)
      next.setUTCMonth(next.getUTCMonth() + 1)
      const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate()
      next.setUTCDate(Math.min(day, lastDay))
    }
  }
  // Skip occurrences that already passed while the app was closed.
  for (let guard = 0; guard < 5000; guard += 1) {
    advance()
    if (next.getTime() > now) return next.toISOString()
  }
  return null
}

const SYNC_PROVIDERS = ['s3', 'webdav']
const SYNC_SECRET_KEY = 'DAILY_PLAN_SYNC_SECRET'
const SYNC_ENV_KEY = 'DSH_DAILY_PLAN_SYNC_SECRET'
const SYNC_DEFAULT_KEY = 'daily-plan/tasks.json'
const SYNC_DEFAULT_REGION = 'rainyun'

/**
 * Where the tasks live: `DSH_DAILY_PLAN_FILE` when set, otherwise
 * `$DSH_HOME/daily-plan/tasks.json`.
 */
export function resolveFile() {
  const custom = typeof process.env.DSH_DAILY_PLAN_FILE === 'string' ? process.env.DSH_DAILY_PLAN_FILE.trim() : ''
  if (custom) return path.resolve(custom)
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'daily-plan', 'tasks.json')
}

/** Where the sync settings live: next to the task file, named `sync.json`. */
export function resolveSyncFile() {
  const custom = typeof process.env.DSH_DAILY_PLAN_SYNC_FILE === 'string' ? process.env.DSH_DAILY_PLAN_SYNC_FILE.trim() : ''
  if (custom) return path.resolve(custom)
  return path.join(path.dirname(resolveFile()), 'sync.json')
}

/** Where the daily-quote cache lives: next to the task file. */
export function resolveQuoteFile() {
  return path.join(path.dirname(resolveFile()), 'quote.json')
}

/**
 * Fetch one fresh quote right now, rotating kinds by local day. Lives in this
 * file (not in quote.js) so a hot plugin reload applies it immediately, and it
 * adds a timestamp to every request so the provider's CDN cannot replay the
 * same cached item for the manual "another one" action.
 */
const QUOTE_ROTATION = [
  { id: 'poetry', url: 'https://v1.hitokoto.cn/?encode=json&c=i', source: 'hitokoto' },
  { id: 'sentence', url: 'https://v1.hitokoto.cn/?encode=json&c=d&c=k', source: 'hitokoto' },
  { id: 'movie', url: 'https://v1.hitokoto.cn/?encode=json&c=h', source: 'hitokoto' },
  { id: 'english', url: 'https://zenquotes.io/api/random', source: 'zenquotes' },
]

function quoteKindFor(now) {
  const date = new Date(now)
  const start = new Date(date.getFullYear(), 0, 1)
  const today = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const dayOfYear = Math.floor((today.getTime() - start.getTime()) / 86400000)
  return QUOTE_ROTATION[dayOfYear % QUOTE_ROTATION.length]
}

function localDayKey(now) {
  const date = new Date(now)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** Fetch and normalize one quote; throws when the provider gives nothing usable. */
export async function fetchDailyQuote(now = Date.now()) {
  const kind = quoteKindFor(now)
  const url = new URL(kind.url)
  url.searchParams.set('_', String(now))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 7000)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json', 'cache-control': 'no-cache', 'user-agent': 'dsh-daily-plan' },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = await response.json()
    let text = ''
    let from = ''
    if (kind.source === 'zenquotes') {
      const item = Array.isArray(data) ? data[0] : data
      text = typeof item?.q === 'string' ? item.q.trim() : ''
      from = typeof item?.a === 'string' ? item.a.trim() : ''
    } else {
      text = typeof data?.hitokoto === 'string' ? data.hitokoto.trim() : ''
      const parts = [data?.from, data?.from_who]
        .filter(value => typeof value === 'string' && value.trim())
        .map(value => value.trim())
      from = parts.filter((value, index) => parts.indexOf(value) === index).join(' · ')
    }
    if (!text) throw new Error('empty quote')
    return {
      text: text.slice(0, 90),
      from: from.slice(0, 50),
      kind: kind.id,
      source: kind.source,
      date: localDayKey(now),
      fetchedAt: now,
    }
  } finally {
    clearTimeout(timer)
  }
}

async function saveQuoteSnapshot(file, entry) {
  const directory = path.dirname(file)
  await mkdir(directory, { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(entry, null, 2)}\n`, 'utf8')
  await rename(temp, file)
}

function nextId() {
  return randomUUID()
}

function asText(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function asDue(value) {
  if (typeof value !== 'string' || value === '') return null
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toISOString() : null
}

function asPositive(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0
}

/** Deletion records: `{ [taskId]: deletedAtMs }`, used so deletes reach every machine. */
function sanitizeTombstones(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const tombstones = {}
  for (const [id, at] of Object.entries(source)) {
    const time = asPositive(at)
    if (typeof id !== 'string' || id === '' || time === 0) continue
    tombstones[id] = time
  }
  return tombstones
}

/** One task record with every field normalized; `title` may end up empty. */
function sanitizeTask(raw, now = Date.now()) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const done = source.done === true
  const completedAt = asPositive(source.completedAt)
  return {
    id: typeof source.id === 'string' && source.id ? source.id.slice(0, 64) : nextId(),
    title: asText(source.title, MAX_TITLE),
    note: asText(source.note, MAX_NOTE),
    due: asDue(source.due),
    allDay: source.allDay === true,
    done,
    priority: PRIORITIES.includes(source.priority) ? source.priority : 'normal',
    repeat: REPEAT_RULES.includes(source.repeat) ? source.repeat : 'none',
    createdAt: asPositive(source.createdAt) || now,
    updatedAt: asPositive(source.updatedAt) || now,
    completedAt: done ? completedAt || now : null,
    focusSeconds: asPositive(source.focusSeconds),
    focusCount: asPositive(source.focusCount),
  }
}

/**
 * Loads the task file once, keeps the list in memory, and serializes atomic
 * writes so two panel requests can never interleave a file replacement.
 *
 * The stored document is `{ version, updatedAt, tasks, tombstones }`; a file
 * written by 1.0 (a bare array or `{ tasks }`) still loads, with empty
 * tombstones. `onLocalChange` runs after a local mutation is on disk, which is
 * what asks the sync engine for a push.
 */
function createStore(file) {
  let tasks = null
  let tombstones = {}
  let docUpdatedAt = 0
  let loading = null
  let chain = Promise.resolve()
  let warning = null
  let revision = 0
  let onLocalChange = null

  async function load() {
    if (tasks !== null) return tasks
    if (loading === null) {
      loading = (async () => {
        try {
          const raw = await readFile(file, 'utf8')
          const parsed = JSON.parse(raw)
          const items = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.tasks) ? parsed.tasks : []
          const now = Date.now()
          tasks = items.map(item => sanitizeTask(item, now)).filter(item => item.title).slice(0, MAX_TASKS)
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            docUpdatedAt = asPositive(parsed.updatedAt)
            tombstones = sanitizeTombstones(parsed.tombstones)
          }
        } catch (error) {
          tasks = []
          if (!error || error.code !== 'ENOENT') {
            // Never overwrite data we could not parse: keep a copy for recovery.
            warning = `任务文件读取失败：${error && error.message ? error.message : String(error)}`
            try {
              await copyFile(file, `${file}.corrupt-${Date.now()}`)
            } catch {
              // The backup is best effort; the message above still reports it.
            }
          }
        }
        return tasks
      })()
    }
    return loading
  }

  function document() {
    return { version: 2, updatedAt: docUpdatedAt, tasks: tasks.map(task => ({ ...task })), tombstones: { ...tombstones } }
  }

  function writeSnapshot(snapshot, notifyLocal) {
    const text = JSON.stringify(snapshot, null, 2)
    const directory = path.dirname(file)
    chain = chain.then(async () => {
      await mkdir(directory, { recursive: true })
      const temp = `${file}.${process.pid}.tmp`
      await writeFile(temp, text, 'utf8')
      await rename(temp, file)
    }).then(() => {
      if (notifyLocal && typeof onLocalChange === 'function') {
        try {
          onLocalChange()
        } catch {
          // A sync request must never undo a saved edit.
        }
      }
    })
    return chain
  }

  /** Saves a local mutation and asks the sync engine to push it. */
  function persistLocal() {
    revision += 1
    docUpdatedAt = Math.max(docUpdatedAt, Date.now())
    return writeSnapshot(document(), true)
  }

  /** Adopts a document merged from the cloud; no push is requested. */
  function applyDoc(doc) {
    const normalized = doc && typeof doc === 'object' ? doc : emptyDoc()
    revision += 1
    tasks = (Array.isArray(normalized.tasks) ? normalized.tasks : [])
      .map(item => sanitizeTask(item))
      .filter(item => item.title)
      .slice(0, MAX_TASKS)
    tombstones = sanitizeTombstones(normalized.tombstones)
    docUpdatedAt = Math.max(docUpdatedAt, asPositive(normalized.updatedAt))
    return writeSnapshot(document(), false)
  }

  /** The document the sync engine merges: no I/O, straight from memory. */
  function snapshot() {
    return document()
  }

  /** Records a deletion so it survives the next merge with another machine. */
  function bury(id, at) {
    if (typeof id !== 'string' || id === '') return
    const time = asPositive(at) || Date.now()
    if (tombstones[id] === undefined || time > tombstones[id]) tombstones[id] = time
  }

  /** Drops a deletion record, used when a delete is undone. */
  function unbury(id) {
    if (typeof id === 'string' && tombstones[id] !== undefined) delete tombstones[id]
  }

  async function view() {
    await load()
    return { revision, tasks: tasks.slice(), warning }
  }

  function clearWarning() {
    warning = null
  }

  return {
    file,
    load,
    view,
    snapshot,
    applyDoc,
    persistLocal,
    bury,
    unbury,
    clearWarning,
    get warning() {
      return warning
    },
    set onLocalChange(handler) {
      onLocalChange = handler
    },
  }
}

function isBlank(value) {
  return typeof value !== 'string' || value.trim() === ''
}

/** Applies one mutation; returns the changed task (or null) and its op name. */
function mutate(store, body) {
  const tasks = store.load()
  return tasks.then(list => {
    const op = typeof body.op === 'string' ? body.op : ''
    const now = Date.now()
    const find = id => list.find(item => item.id === id)
    /** Strictly increasing per task, so two machines can order edits by time. */
    const stamp = task => {
      task.updatedAt = Math.max(now, (task.updatedAt || 0) + 1)
      return task.updatedAt
    }

    if (op === 'create') {
      if (isBlank(body.title)) throw new Error('任务标题不能为空')
      if (list.length >= MAX_TASKS) throw new Error(`最多保存 ${MAX_TASKS} 条任务，请先清理已完成的任务`)
      const task = sanitizeTask({
        title: body.title,
        note: body.note,
        due: body.due,
        allDay: body.allDay,
        priority: body.priority,
        repeat: body.repeat,
        createdAt: now,
        updatedAt: now,
      }, now)
      list.push(task)
      return { op, task }
    }

    if (op === 'update') {
      const task = find(body.id)
      if (!task) throw new Error('找不到这条任务，可能已被删除')
      if (body.title !== undefined) {
        if (isBlank(body.title)) throw new Error('任务标题不能为空')
        task.title = asText(body.title, MAX_TITLE)
      }
      if (body.note !== undefined) task.note = asText(body.note, MAX_NOTE)
      if (body.due !== undefined) task.due = asDue(body.due)
      if (body.allDay !== undefined) task.allDay = body.allDay === true
      if (body.priority !== undefined && PRIORITIES.includes(body.priority)) task.priority = body.priority
      if (body.repeat !== undefined && REPEAT_RULES.includes(body.repeat)) task.repeat = body.repeat
      if (body.done !== undefined) {
        task.done = body.done === true
        task.completedAt = task.done ? now : null
      }
      stamp(task)
      return { op, task }
    }

    if (op === 'complete') {
      const task = find(body.id)
      if (!task) throw new Error('找不到这条任务，可能已被删除')
      const wasDone = task.done
      task.done = body.done !== false
      task.completedAt = task.done ? now : null
      stamp(task)
      // Finishing a repeating task spawns its next occurrence, so the recurring
      // item keeps living while this occurrence stays in the finished history.
      let spawned = null
      if (task.done && !wasDone && task.repeat !== 'none' && task.due) {
        const due = nextDue(task.due, task.repeat, now)
        if (due !== null && list.length < MAX_TASKS) {
          spawned = sanitizeTask({
            ...task,
            id: undefined,
            due,
            done: false,
            completedAt: null,
            focusSeconds: 0,
            focusCount: 0,
            createdAt: now,
            updatedAt: now,
          }, now)
          list.push(spawned)
        }
      }
      return { op, task, spawned }
    }

    if (op === 'delete') {
      const index = list.findIndex(item => item.id === body.id)
      if (index < 0) throw new Error('找不到这条任务，可能已被删除')
      const [task] = list.splice(index, 1)
      store.bury(task.id, Math.max(now, (task.updatedAt || 0) + 1))
      return { op, task }
    }

    if (op === 'restore') {
      // Undoing a delete: re-create the exact record under its old id, with a
      // fresh updatedAt so the cloud merge resurrects it instead of applying the
      // tombstone again.
      const source = body.task && typeof body.task === 'object' ? body.task : {}
      const id = typeof source.id === 'string' ? source.id.slice(0, 64) : ''
      if (id === '') throw new Error('撤销失败：缺少任务 id')
      if (isBlank(source.title)) throw new Error('任务标题不能为空')
      if (!list.some(item => item.id === id) && list.length >= MAX_TASKS) {
        throw new Error(`最多保存 ${MAX_TASKS} 条任务，请先清理已完成的任务`)
      }
      const task = sanitizeTask({
        ...source,
        id,
        updatedAt: Math.max(now, (asPositive(source.updatedAt) || 0) + 1),
      }, now)
      const index = list.findIndex(item => item.id === id)
      if (index >= 0) list[index] = task
      else list.push(task)
      store.unbury(id)
      return { op, task }
    }

    if (op === 'focus') {
      const task = find(body.id)
      if (!task) throw new Error('找不到这条任务，可能已被删除')
      const seconds = Math.min(asPositive(body.seconds), 12 * 60 * 60)
      if (seconds > 0) {
        task.focusSeconds += seconds
        task.focusCount += 1
        stamp(task)
      }
      return { op, task }
    }

    if (op === 'clearDone') {
      // `ids` scopes the clear to what the panel is showing (one day); without
      // it the tool keeps the historical "clear every finished task" behaviour.
      const scoped = Array.isArray(body.ids) ? body.ids.filter(id => typeof id === 'string') : null
      let removed = 0
      for (let index = list.length - 1; index >= 0; index -= 1) {
        const task = list[index]
        if (!task.done) continue
        if (scoped !== null && !scoped.includes(task.id)) continue
        list.splice(index, 1)
        store.bury(task.id, Math.max(now, (task.updatedAt || 0) + 1))
        removed += 1
      }
      return { op, task: null, removed }
    }

    throw new Error(`未知操作：${op || '(空)'}`)
  })
}

/** Write one JSON response on a raw ServerResponse. */
function sendJson(response, value, status = 200) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

/** Read a bounded request body as UTF-8 text. */
function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

function handleRequest(store, sync, quotes, request, response) {
  const url = new URL(request.url || '/', 'http://127.0.0.1')
  const matched = API_PATHS.find(item => url.pathname === item || url.pathname.startsWith(`${item}/`))
  const route = matched === undefined ? '/' : url.pathname.slice(matched.length) || '/'
  const done = (value, status = 200) => {
    if (!response.headersSent) sendJson(response, value, status)
  }
  const fail = error => done({ error: error && error.message ? error.message : String(error) }, 400)
  const syncView = () => describeSync(sync)

  if (request.method === 'GET' || request.method === 'HEAD') {
    if (route === '/version') return done({ name: 'daily-plan', version: VERSION, api: API_PATHS })
    if (route === '/state') {
      return store.view().then(
        value => done({ ...value, storage: store.file, storageWarning: store.warning, sync: syncView() }),
        fail,
      )
    }
    if (route === '/sync') return done(syncView())
    if (route === '/quote') {
      if (url.searchParams.get('refresh') === '1') {
        return fetchDailyQuote()
          .then(async fresh => {
            try {
              await saveQuoteSnapshot(resolveQuoteFile(), fresh)
            } catch {
              // Serving the fresh quote does not depend on the cache write.
            }
            done(fresh)
          })
          .catch(() => quotes.get().then(value => done({ ...value, stale: true }), fail))
      }
      return quotes.get().then(value => done(value), fail)
    }
    if (route === '/export') {
      const format = url.searchParams.get('format') === 'xlsx' ? 'xlsx' : 'markdown'
      const from = Number(url.searchParams.get('from')) || 0
      const to = Number(url.searchParams.get('to')) || Number.MAX_SAFE_INTEGER
      const lang = url.searchParams.get('lang') || 'zh'
      const stamp = new Date().toISOString().slice(0, 10)
      return store.view().then(value => {
        const items = completedTasks(value.tasks, from, to)
        if (format === 'xlsx') {
          const buffer = renderXlsx(items, { lang })
          response.writeHead(200, {
            'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'content-disposition': `attachment; filename="daily-plan-completed-${stamp}.xlsx"`,
            'content-length': buffer.length,
            'cache-control': 'no-store',
          })
          response.end(buffer)
          return
        }
        const markdown = renderMarkdown(items, { lang })
        const body = Buffer.from(markdown, 'utf8')
        response.writeHead(200, {
          'content-type': 'text/markdown; charset=utf-8',
          'content-disposition': `attachment; filename="daily-plan-completed-${stamp}.md"`,
          'content-length': body.length,
          'cache-control': 'no-store',
        })
        response.end(body)
      }, fail)
    }
    return done({ error: 'not found' }, 404)
  }

  if (request.method === 'POST') {
    if (route === '/sync/now') {
      return sync.engine.syncNow()
        .then(() => store.view())
        .then(value => done({ ...value, storage: store.file, storageWarning: store.warning, sync: syncView() }))
        .catch(fail)
    }
    if (route !== '/mutate') return done({ error: 'not found' }, 404)
    return readBody(request)
      .then(raw => {
        let body = {}
        try {
          body = raw ? JSON.parse(raw) : {}
        } catch {
          done({ error: '请求体必须是 JSON' }, 400)
          return undefined
        }
        return mutate(store, body)
          .then(async changed => {
            await store.persistLocal()
            const value = await store.view()
            store.clearWarning()
            return done({
              ...value,
              storage: store.file,
              changed: changed.task,
              op: changed.op,
              spawned: changed.spawned || null,
              sync: syncView(),
            })
          })
          .catch(fail)
      })
      .catch(fail)
  }

  return done({ error: 'method not allowed' }, 405)
}

function registerRoute(ctx, handler) {
  const attempted = []
  for (const path of API_PATHS) {
    try {
      return ctx.webServer.register({ kind: 'prefix', path, handler })
    } catch (error) {
      attempted.push(path)
      if (!/duplicate/i.test(String(error && error.message))) throw error
    }
  }
  ctx.logger?.warn?.(`daily-plan: no API route could be registered (${attempted.join(', ')} are taken)`)
  return undefined
}

function renderJson(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/** Drop `undefined` members so the tool result survives a JSON round trip. */
function toJsonSafe(value) {
  return value === undefined ? null : JSON.parse(JSON.stringify(value))
}

/**
 * The `daily_tasks` tool, written as the plain definition the registry accepts
 * (`register()` only requires `output.render`), so the plugin needs no package
 * import for it.
 */
const TOOL_DEFINITION = {
  name: 'daily_tasks',
  description: 'Read and edit the user\'s daily plan (the 每日任务 panel): a memo/to-do list whose tasks are '
    + 'grouped by the time they are due. Use action "list" before changing anything, "add" with a due time '
    + 'for a new task, "complete" to tick one off, "update" to move it to another time or edit its note, and '
    + '"delete" to remove it. Set "repeat" on a task (daily, weekdays, weekly, monthly) and completing it '
    + 'spawns the next occurrence. Due times are ISO 8601 strings in the user\'s local offset '
    + '(for example "2026-11-24T14:30:00+08:00"); omit "due" for an unscheduled task. '
    + 'Every response returns the complete task list.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'add', 'update', 'complete', 'delete', 'clearDone'],
        description: 'Operation to perform.',
      },
      id: { type: 'string', description: 'Task id from "list"; required by update, complete, and delete.' },
      title: { type: 'string', description: 'Task title (required by add; editable by update).' },
      due: { type: 'string', description: 'ISO 8601 due time; pass "" to clear it.' },
      note: { type: 'string', description: 'Optional free-form note.' },
      priority: { type: 'string', enum: PRIORITIES, description: 'Priority marker; defaults to normal.' },
      repeat: {
        type: 'string',
        enum: REPEAT_RULES,
        description: 'Repeat rule: daily, weekdays, weekly, or monthly; completing the task spawns the next occurrence. Defaults to none.',
      },
      allDay: { type: 'boolean', description: 'True when the task is due sometime that day rather than at a time.' },
      done: { type: 'boolean', description: 'Target state for complete; defaults to true.' },
    },
    required: ['action'],
    additionalProperties: false,
  },
  output: {
    schema: { type: 'object', additionalProperties: true },
    render: renderJson,
  },
  isConcurrencySafe: () => false,
  presentCall(args) {
    const titles = {
      list: '读取每日任务',
      add: '新增任务',
      update: '修改任务',
      complete: '完成任务',
      delete: '删除任务',
      clearDone: '清理已完成任务',
    }
    return {
      card: 'generic',
      title: titles[args && args.action] || '每日任务',
      kind: args && args.action === 'list' ? 'read' : 'write',
      rawInput: (args && (args.title || args.id)) || undefined,
    }
  },
}

function registerTool(ctx, store, sync) {
  ctx.tools.register({
    ...TOOL_DEFINITION,
    execute: args => executeTool(store, sync, args),
  })
}

async function executeTool(store, sync, args) {
  const input = args && typeof args === 'object' ? args : {}
  const action = input.action
  if (action === 'list') {
    const value = await store.view()
    return toJsonSafe({ storage: store.file, sync: describeSync(sync), ...value })
  }
  const body = { op: action, id: input.id }
  if (action === 'add') body.op = 'create'
  if (action === 'add' || action === 'update') {
    if (input.title !== undefined) body.title = input.title
    if (input.note !== undefined) body.note = input.note
    if (input.due !== undefined) body.due = input.due
    if (input.allDay !== undefined) body.allDay = input.allDay
    if (input.priority !== undefined) body.priority = input.priority
    if (input.repeat !== undefined) body.repeat = input.repeat
  }
  if (action === 'complete' && input.done !== undefined) body.done = input.done
  if (action === 'add') delete body.id
  const changed = await mutate(store, body)
  await store.persistLocal()
  const value = await store.view()
  return toJsonSafe({
    op: changed.op,
    task: changed.task,
    spawned: changed.spawned || null,
    storage: store.file,
    sync: describeSync(sync),
    ...value,
  })
}

/* ------------------------------------------------------------------ *
 * Cloud sync: settings, credentials, connection test
 * ------------------------------------------------------------------ */

/** Settings file (no secret in it when the credential store works). */
async function readSyncConfig(file) {
  const raw = await readFile(file, 'utf8')
  const parsed = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('同步配置必须是 JSON 对象')
  return parsed
}

async function saveSyncConfig(file, config) {
  const directory = path.dirname(file)
  await mkdir(directory, { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temp, file)
}

/** The secret from the credential store, then the environment, then the settings file. */
async function resolveSyncSecret(ctx, config) {
  const credentials = ctx.get('credentials')
  if (credentials && typeof credentials.resolve === 'function') {
    try {
      const hit = await credentials.resolve(SYNC_SECRET_KEY)
      const value = typeof hit?.value === 'string' ? hit.value.trim() : typeof hit === 'string' ? hit.trim() : ''
      if (value) return { secret: value, source: 'credentials' }
    } catch {
      // A profile without a usable credential store falls through to the next source.
    }
  }
  const fromEnv = typeof process.env[SYNC_ENV_KEY] === 'string' ? process.env[SYNC_ENV_KEY].trim() : ''
  if (fromEnv) return { secret: fromEnv, source: 'env' }
  if (config && typeof config.secret === 'string' && config.secret) {
    return { secret: config.secret, source: 'file' }
  }
  return { secret: null, source: null }
}

/** Saves the secret; falls back to the 0600 settings file when no store exists. */
async function storeSyncSecret(ctx, sync, config, secret) {
  const credentials = ctx.get('credentials')
  if (credentials && typeof credentials.set === 'function') {
    try {
      await credentials.set(SYNC_SECRET_KEY, secret)
      if (config.secret) {
        delete config.secret
        await saveSyncConfig(sync.file, config)
      }
      return 'credentials'
    } catch {
      // Fall back to the local file so a profile without a writable store still works.
    }
  }
  config.secret = secret
  return 'file'
}

async function clearSyncSecret(ctx, config) {
  const credentials = ctx.get('credentials')
  if (credentials && typeof credentials.unset === 'function') {
    try {
      await credentials.unset(SYNC_SECRET_KEY)
    } catch {
      // Nothing stored there; the file cleanup below still runs.
    }
  }
  if (config.secret) {
    delete config.secret
  }
}

function buildTransport(config, secret) {
  if (!config || !SYNC_PROVIDERS.includes(config.provider)) return null
  if (config.provider === 's3') {
    return createS3Transport({
      endpoint: config.endpoint,
      bucket: config.bucket,
      key: config.key || SYNC_DEFAULT_KEY,
      region: config.region || SYNC_DEFAULT_REGION,
      accessKey: config.accessKey,
      secretKey: secret,
      style: config.style === 'virtual' ? 'virtual' : 'path',
    })
  }
  return createWebDavTransport({ url: config.url, username: config.username || '', password: secret })
}

/** What the agent, the panel, and the settings file may see: never the secret. */
function publicConfig(config) {
  if (!config || typeof config !== 'object') return null
  return {
    provider: config.provider || null,
    enabled: config.enabled !== false,
    endpoint: config.endpoint || null,
    bucket: config.bucket || null,
    key: config.key || null,
    region: config.region || null,
    style: config.style || (config.provider === 's3' ? 'path' : null),
    url: config.url || null,
    username: config.username || null,
    accessKey: config.accessKey || null,
    secretStored: config.secret !== undefined,
  }
}

function describeSync(sync) {
  const status = sync.engine.status()
  return {
    ...status,
    provider: status.provider || (sync.config && sync.config.provider) || null,
    target: status.target || null,
    configured: Boolean(sync.config && sync.config.provider),
    config: publicConfig(sync.config),
    configError: sync.configError || null,
    secretSource: sync.secretSource || null,
  }
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`缺少 ${field}`)
  return value.trim()
}

/** Applies one `daily_sync` action. */
async function executeSyncTool(ctx, store, sync, args) {
  const input = args && typeof args === 'object' ? args : {}
  const action = input.action
  const engine = sync.engine

  if (action === 'status') {
    const view = await store.view()
    return toJsonSafe({ ...describeSync(sync), storage: store.file, revision: view.revision, tasks: view.tasks.length })
  }

  if (action === 'now') {
    try {
      const outcome = await engine.syncNow()
      const view = await store.view()
      return toJsonSafe({ ...describeSync(sync), outcome, revision: view.revision, tasks: view.tasks.length })
    } catch (error) {
      return toJsonSafe({
        ...describeSync(sync),
        error: error && error.message ? error.message : String(error),
      })
    }
  }

  if (action === 'off') {
    const config = sync.config || {}
    await clearSyncSecret(ctx, config)
    const next = { ...config, enabled: false }
    await saveSyncConfig(sync.file, next)
    sync.config = next
    sync.transport = null
    sync.configError = null
    sync.secretSource = null
    engine.stop()
    return toJsonSafe({ ...describeSync(sync), disabled: true })
  }

  if (action === 'setup') {
    const provider = input.provider
    if (!SYNC_PROVIDERS.includes(provider)) throw new Error('provider 必须是 s3 或 webdav')
    const existing = sync.config || {}
    const config = { ...existing, provider, enabled: true }
    if (provider === 's3') {
      config.endpoint = requireText(input.endpoint ?? existing.endpoint, 'endpoint（例如 https://cn-sy1.rains3.com）')
      config.bucket = requireText(input.bucket ?? existing.bucket, 'bucket（存储桶名）')
      config.accessKey = requireText(input.accessKey ?? existing.accessKey, 'accessKey')
      config.key = typeof input.key === 'string' && input.key.trim() ? input.key.trim() : existing.key || SYNC_DEFAULT_KEY
      config.region = typeof input.region === 'string' && input.region.trim() ? input.region.trim() : existing.region || SYNC_DEFAULT_REGION
      config.style = input.style === 'virtual' || input.style === 'path' ? input.style : existing.style || 'path'
      delete config.url
      delete config.username
    } else {
      config.url = requireText(input.url ?? existing.url, 'url（WebDAV 文件地址）')
      config.username = typeof input.username === 'string' ? input.username.trim() : existing.username || ''
      delete config.endpoint
      delete config.bucket
      delete config.key
      delete config.region
      delete config.accessKey
    }

    let secretSource = null
    let secret = typeof input.secret === 'string' && input.secret.trim() ? input.secret.trim() : null
    if (secret === null) {
      const resolved = await resolveSyncSecret(ctx, config)
      secret = resolved.secret
      secretSource = resolved.source
    }
    if (!secret) throw new Error(provider === 's3' ? '缺少 SecretKey' : '缺少 WebDAV 密码')

    let transport = buildTransport(config, secret)
    try {
      await transport.read()
    } catch (error) {
      const status = error && error.status
      const alternate = provider === 's3' ? (config.style === 'virtual' ? 'path' : 'virtual') : null
      if (alternate === null || (status !== 400 && status !== 403)) {
        throw new Error(`连接测试失败：${error && error.message ? error.message : String(error)}`)
      }
      // Only one addressing style may be served; try the other before giving up.
      const retryConfig = { ...config, style: alternate }
      let retryTransport
      try {
        retryTransport = buildTransport(retryConfig, secret)
        await retryTransport.read()
      } catch (retryError) {
        throw new Error(
          `连接测试失败：${error.message}（也尝试了 ${alternate} 寻址：`
          + `${retryError && retryError.message ? retryError.message : retryError}）`,
        )
      }
      transport = retryTransport
      config.style = alternate
    }

    secretSource = (await storeSyncSecret(ctx, sync, config, secret)) || secretSource || 'credentials'
    await saveSyncConfig(sync.file, config)
    sync.config = config
    sync.transport = transport
    sync.configError = null
    sync.secretSource = secretSource
    engine.start()
    const view = await store.view()
    return toJsonSafe({
      ...describeSync(sync),
      connected: true,
      storage: store.file,
      revision: view.revision,
      tasks: view.tasks.length,
    })
  }

  throw new Error(`未知操作：${action || '(空)'}，可用 action：status / setup / now / off`)
}

const SYNC_TOOL_DEFINITION = {
  name: 'daily_sync',
  description: 'Show or change the cloud sync of the daily plan (the 每日任务 panel). The task list is merged with one '
    + 'JSON document in a cloud store so several computers share one list; deletes and edits are merged per task by '
    + 'their last change. Supported providers: "s3" (any S3-compatible object storage, e.g. RainYun object storage '
    + 'with endpoint https://cn-sy1.rains3.com, region rainyun, one bucket) and "webdav" (Nextcloud, 坚果云, or an '
    + 'object storage that exposes WebDAV). Actions: "status" reports the current state, "setup" saves settings and '
    + 'tests the connection, "now" syncs immediately, "off" disables sync. Never prints the secret back.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['status', 'setup', 'now', 'off'],
        description: 'Operation to perform.',
      },
      provider: { type: 'string', enum: SYNC_PROVIDERS, description: 'Storage protocol; required by setup.' },
      endpoint: { type: 'string', description: 'S3 endpoint, e.g. https://cn-sy1.rains3.com' },
      bucket: { type: 'string', description: 'S3 bucket name.' },
      key: { type: 'string', description: 'Object key inside the bucket; defaults to daily-plan/tasks.json.' },
      region: { type: 'string', description: 'S3 signing region; RainYun uses "rainyun".' },
      accessKey: { type: 'string', description: 'S3 access key id.' },
      style: { type: 'string', enum: ['path', 'virtual'], description: 'S3 addressing style; omit to try path-style and fall back automatically.' },
      url: { type: 'string', description: 'WebDAV file URL (the JSON document itself).' },
      username: { type: 'string', description: 'WebDAV user name.' },
      secret: { type: 'string', description: 'S3 secret key or WebDAV password; omit to keep the stored one.' },
    },
    required: ['action'],
    additionalProperties: false,
  },
  output: {
    schema: { type: 'object', additionalProperties: true },
    render: renderJson,
  },
  isConcurrencySafe: () => false,
  presentCall(args) {
    const titles = {
      status: '查看云同步状态',
      setup: '配置云同步',
      now: '立即同步每日任务',
      off: '关闭云同步',
    }
    return {
      card: 'generic',
      title: titles[args && args.action] || '每日任务云同步',
      kind: args && (args.action === 'status' || args.action === 'now') ? 'read' : 'write',
      rawInput: (args && (args.endpoint || args.url)) || undefined,
    }
  },
}

function registerSyncTool(ctx, store, sync) {
  ctx.tools.register({
    ...SYNC_TOOL_DEFINITION,
    execute: args => executeSyncTool(ctx, store, sync, args),
  })
}

export async function apply(ctx) {
  const store = createStore(resolveFile())
  const quotes = createQuoteCache({ file: resolveQuoteFile() })
  const sync = {
    file: resolveSyncFile(),
    config: null,
    transport: null,
    configError: null,
    secretSource: null,
    engine: null,
  }
  const engine = createSyncEngine({
    store,
    getTransport: () => sync.transport,
    log: message => ctx.logger?.warn?.(message),
  })
  sync.engine = engine
  store.onLocalChange = () => engine.requestSync()

  await store.load()
  try {
    const config = await readSyncConfig(sync.file)
    sync.config = config
    if (config.enabled !== false && SYNC_PROVIDERS.includes(config.provider)) {
      const resolved = await resolveSyncSecret(ctx, config)
      sync.secretSource = resolved.source
      if (resolved.secret) sync.transport = buildTransport(config, resolved.secret)
      else sync.configError = '尚未保存同步密钥，请用 daily_sync 重新配置'
    }
  } catch (error) {
    if (!error || error.code !== 'ENOENT') {
      sync.configError = `同步配置读取失败：${error && error.message ? error.message : String(error)}`
      ctx.logger?.warn?.(`daily-plan: ${sync.configError}`)
    }
  }

  registerTool(ctx, store, sync)
  registerSyncTool(ctx, store, sync)
  ctx.effect(() => {
    const dispose = registerRoute(ctx, (request, response) => handleRequest(store, sync, quotes, request, response))
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  }, 'daily-plan: panel api route')
  ctx.effect(() => () => engine.stop(), 'daily-plan: sync timer')
  engine.start()
  // Warm the daily quote in the background so the first panel load has it.
  quotes.get().catch(error => ctx.logger?.warn?.(`daily-plan: quote fetch failed: ${error && error.message}`))
}
