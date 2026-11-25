/**
 * End-to-end host test: two plugin instances ("machines") share one WebDAV
 * document. Their local files are separate temp files; the plugin module is
 * loaded once, exactly as in the host, and driven through its tools.
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import { apply, fetchDailyQuote, nextDue } from '../index.js'

const BASIC = `Basic ${Buffer.from('demo:pw').toString('base64')}`

/** A minimal WebDAV endpoint storing one JSON file, with Basic auth and ETag checks. */
async function startWebDav() {
  let body = null
  let etag = null
  const requests = []
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`)
    if (request.headers.authorization !== BASIC) {
      response.writeHead(401)
      response.end()
      return
    }
    if (request.method === 'GET') {
      if (body === null) {
        response.writeHead(404)
        response.end()
        return
      }
      response.writeHead(200, { 'content-type': 'application/json', ...(etag ? { etag } : {}) })
      response.end(body)
      return
    }
    if (request.method === 'PUT') {
      const chunks = []
      request.on('data', chunk => chunks.push(chunk))
      request.on('end', () => {
        if (request.headers['if-match'] && etag && request.headers['if-match'] !== etag) {
          response.writeHead(412)
          response.end()
          return
        }
        body = Buffer.concat(chunks).toString('utf8')
        etag = `"${Date.now()}"`
        response.writeHead(200, { etag })
        response.end()
      })
      return
    }
    response.writeHead(405)
    response.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}/daily-plan/tasks.json`,
    get body() {
      return body
    },
    get doc() {
      return body === null ? null : JSON.parse(body)
    },
    requests,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

function makeCredentials(secret = null) {
  const values = new Map()
  if (secret) values.set('DAILY_PLAN_SYNC_SECRET', secret)
  return {
    values,
    async resolve(key) {
      return values.has(key) ? { value: values.get(key) } : null
    },
    async set(key, value) {
      values.set(key, value)
    },
    async unset(key) {
      values.delete(key)
    },
  }
}

function makeContext(secret = null) {
  const tools = new Map()
  const effects = []
  const routes = []
  const credentials = makeCredentials(secret)
  const ctx = {
    get: name => (name === 'credentials' ? credentials : undefined),
    tools: { register: tool => tools.set(tool.name, tool) },
    webServer: {
      register: ({ handler }) => {
        routes.push(handler)
        return () => {}
      },
    },
    effect: fn => {
      const dispose = fn()
      if (typeof dispose === 'function') effects.push(dispose)
    },
    logger: { warn: () => {}, info: () => {}, debug: () => {} },
  }
  return { ctx, tools, effects, credentials, routes }
}

/** Calls one panel API route through the registered handler. */
function apiCall(handler, routePath, body = null, method = 'POST') {
  assert.ok(handler, 'an API route is registered')
  const request = Readable.from(method === 'POST' ? [Buffer.from(JSON.stringify(body ?? {}))] : [])
  request.method = method
  request.url = `/daily-plan-api${routePath}`
  return new Promise((resolve, reject) => {
    let status = 200
    let headers = {}
    const chunks = []
    const response = {
      headersSent: false,
      writeHead(code, nextHeaders = {}) {
        status = code
        headers = nextHeaders
        this.headersSent = true
      },
      end(chunk) {
        if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
        const buffer = Buffer.concat(chunks)
        const text = buffer.toString('utf8')
        let json = null
        try {
          json = text ? JSON.parse(text) : null
        } catch {
          json = null
        }
        resolve({ status, headers, buffer, text, json })
      },
    }
    try {
      handler(request, response)
    } catch (error) {
      reject(error)
    }
  })
}

/** Boots one machine with its own task and settings files. */
async function startMachine(name, root, webdavUrl) {
  const dir = path.join(root, name)
  const previousFile = process.env.DSH_DAILY_PLAN_FILE
  const previousSync = process.env.DSH_DAILY_PLAN_SYNC_FILE
  process.env.DSH_DAILY_PLAN_FILE = path.join(dir, 'tasks.json')
  process.env.DSH_DAILY_PLAN_SYNC_FILE = path.join(dir, 'sync.json')
  const { ctx, tools, effects, routes } = makeContext()
  try {
    await apply(ctx)
  } finally {
    if (previousFile === undefined) delete process.env.DSH_DAILY_PLAN_FILE
    else process.env.DSH_DAILY_PLAN_FILE = previousFile
    if (previousSync === undefined) delete process.env.DSH_DAILY_PLAN_SYNC_FILE
    else process.env.DSH_DAILY_PLAN_SYNC_FILE = previousSync
  }

  const call = async (name, args) => {
    const tool = tools.get(name)
    assert.ok(tool, `tool ${name} is registered`)
    return tool.execute(args)
  }

  return {
    dir,
    tools,
    effects,
    call,
    api: (routePath, body = null, method = 'POST') => apiCall(routes[0], routePath, body, method),
    setup: () => call('daily_sync', {
      action: 'setup',
      provider: 'webdav',
      url: webdavUrl,
      username: 'demo',
      secret: 'pw',
    }),
    syncNow: () => call('daily_sync', { action: 'now' }),
    list: () => call('daily_tasks', { action: 'list' }),
    stop: () => {
      for (const dispose of effects.reverse()) {
        try {
          dispose()
        } catch {
          // already stopped
        }
      }
    },
  }
}

test('two machines converge through one WebDAV document', async () => {
  const webdav = await startWebDav()
  const root = await mkdtemp(path.join(tmpdir(), 'daily-plan-sync-'))
  const machineA = await startMachine('a', root, webdav.url)
  const machineB = await startMachine('b', root, webdav.url)
  try {
    const setupA = await machineA.setup()
    assert.equal(setupA.connected, true)
    await machineA.syncNow()

    const created = await machineA.call('daily_tasks', {
      action: 'add',
      title: '来自 A 的任务',
      due: '2026-11-25T09:30:00+08:00',
    })
    const taskA = created.tasks[0]
    assert.ok(taskA)

    await machineA.syncNow()
    assert.deepEqual(webdav.doc.tasks.map(item => item.title), ['来自 A 的任务'])

    // Machine B pulls A's task on its first sync.
    await machineB.setup()
    await machineB.syncNow()
    let listB = await machineB.list()
    assert.deepEqual(listB.tasks.map(item => item.title), ['来自 A 的任务'])

    // B adds one, A receives it.
    await machineB.call('daily_tasks', { action: 'add', title: '来自 B 的任务' })
    await machineB.syncNow()
    await machineA.syncNow()
    const listA = await machineA.list()
    assert.deepEqual(listA.tasks.map(item => item.title).sort(), ['来自 A 的任务', '来自 B 的任务'])

    // A deletes its task, and the delete reaches B instead of being re-added.
    await machineA.call('daily_tasks', { action: 'delete', id: taskA.id })
    await machineA.syncNow()
    await machineB.syncNow()
    const afterDelete = await machineB.list()
    assert.deepEqual(afterDelete.tasks.map(item => item.title), ['来自 B 的任务'])

    // A pulls once more: the deleted task must not come back from the cloud copy.
    await machineA.syncNow()
    const listAgain = await machineA.list()
    assert.deepEqual(listAgain.tasks.map(item => item.title), ['来自 B 的任务'])
  } finally {
    machineA.stop()
    machineB.stop()
    await webdav.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('the newest edit wins when two machines edit the same task', async () => {
  const webdav = await startWebDav()
  const root = await mkdtemp(path.join(tmpdir(), 'daily-plan-conflict-'))
  const machineA = await startMachine('a', root, webdav.url)
  const machineB = await startMachine('b', root, webdav.url)
  try {
    await machineA.setup()
    await machineB.setup()
    await machineA.syncNow()
    await machineB.syncNow()
    const created = await machineA.call('daily_tasks', { action: 'add', title: '冲突演练' })
    const id = created.tasks[0].id
    await machineA.syncNow()
    await machineB.syncNow()

    await machineA.call('daily_tasks', { action: 'update', id, note: 'A 的修改' })
    await machineB.call('daily_tasks', { action: 'update', id, note: 'B 的修改' })
    await machineA.syncNow()
    await machineB.syncNow()
    await machineA.syncNow()

    const listA = await machineA.list()
    const listB = await machineB.list()
    assert.deepEqual(listA.tasks.map(item => item.note), listB.tasks.map(item => item.note))
    assert.deepEqual(listA.tasks.map(item => item.note), ['B 的修改'])
  } finally {
    machineA.stop()
    machineB.stop()
    await webdav.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('daily_sync reports status without leaking the secret, and off stops syncing', async () => {
  const webdav = await startWebDav()
  const root = await mkdtemp(path.join(tmpdir(), 'daily-plan-status-'))
  const machine = await startMachine('a', root, webdav.url)
  try {
    const before = await machine.call('daily_sync', { action: 'status' })
    assert.equal(before.enabled, false)

    await machine.setup()
    await machine.syncNow()
    const status = await machine.call('daily_sync', { action: 'status' })
    assert.equal(status.enabled, true)
    assert.equal(status.provider, 'webdav')
    assert.equal(status.target, new URL(webdav.url).host)
    assert.ok(!JSON.stringify(status).includes('pw'), 'the secret must not be echoed')

    const config = JSON.parse(await readFile(path.join(machine.dir, 'sync.json'), 'utf8'))
    assert.equal(config.provider, 'webdav')
    assert.equal(config.secret, undefined, 'the secret belongs in the credential store')

    const off = await machine.call('daily_sync', { action: 'off' })
    assert.equal(off.enabled, false)
    const docBefore = webdav.doc
    await machine.call('daily_tasks', { action: 'add', title: '离线添加' })
    await machine.call('daily_sync', { action: 'now' })
    assert.deepEqual(webdav.doc, docBefore, 'a disabled sync leaves the cloud document untouched')
  } finally {
    machine.stop()
    await webdav.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('a delete can be undone, and a scoped clearDone only removes the given ids', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'daily-plan-ops-'))
  const machine = await startMachine('ops', root, 'http://127.0.0.1:1/unused')
  try {
    const created = await machine.call('daily_tasks', { action: 'add', title: '要删的任务' })
    const task = created.tasks[0]

    const deleted = await machine.api('/mutate', { op: 'delete', id: task.id })
    assert.equal(deleted.status, 200)
    assert.deepEqual(deleted.json.tasks, [])

    const restored = await machine.api('/mutate', { op: 'restore', task })
    assert.equal(restored.status, 200)
    assert.deepEqual(restored.json.tasks.map(item => item.title), ['要删的任务'])
    assert.equal(restored.json.tasks[0].id, task.id, 'undo keeps the original id')
    assert.ok(restored.json.tasks[0].updatedAt > task.updatedAt, 'undo bumps updatedAt so sync resurrects it')

    const a = (await machine.call('daily_tasks', { action: 'add', title: 'A' })).tasks.find(item => item.title === 'A')
    const b = (await machine.call('daily_tasks', { action: 'add', title: 'B' })).tasks.find(item => item.title === 'B')
    await machine.call('daily_tasks', { action: 'complete', id: a.id })
    await machine.call('daily_tasks', { action: 'complete', id: b.id })

    const cleared = await machine.api('/mutate', { op: 'clearDone', ids: [a.id] })
    assert.equal(cleared.status, 200)
    assert.deepEqual(cleared.json.tasks.map(item => item.title).sort(), ['B', '要删的任务'])
  } finally {
    machine.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('/version reports the package version', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'daily-plan-version-'))
  const machine = await startMachine('ver', root, 'http://127.0.0.1:1/unused')
  try {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    const reported = await machine.api('/version', null, 'GET')
    assert.equal(reported.status, 200)
    assert.equal(reported.json.version, pkg.version)
  } finally {
    machine.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('/export serves the completed history as Markdown and as an .xlsx download', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'daily-plan-export-'))
  const machine = await startMachine('export', root, 'http://127.0.0.1:1/unused')
  try {
    const created = await machine.call('daily_tasks', { action: 'add', title: '导出的任务', note: '备注内容' })
    await machine.call('daily_tasks', { action: 'complete', id: created.tasks[0].id })

    const markdown = await machine.api('/export?format=markdown&lang=zh', null, 'GET')
    assert.equal(markdown.status, 200)
    assert.match(markdown.headers['content-type'], /text\/markdown/)
    assert.match(markdown.headers['content-disposition'], /attachment; filename="daily-plan-completed-.*\.md"/)
    assert.match(markdown.text, /# 每日任务 · 已完成记录/)
    assert.match(markdown.text, /导出的任务/)

    // The from/to window passed by the custom-range filter is honoured.
    const future = await machine.api(`/export?format=markdown&lang=zh&from=${Date.now() + 86_400_000}`, null, 'GET')
    assert.equal(future.status, 200)
    assert.match(future.text, /共 0 条/)
    const recent = await machine.api(`/export?format=markdown&lang=zh&from=${Date.now() - 60_000}`, null, 'GET')
    assert.match(recent.text, /共 1 条/)

    const workbook = await machine.api('/export?format=xlsx&lang=en', null, 'GET')
    assert.equal(workbook.status, 200)
    assert.match(workbook.headers['content-type'], /spreadsheetml\.sheet/)
    assert.match(workbook.headers['content-disposition'], /\.xlsx"/)
    assert.equal(workbook.buffer.subarray(0, 2).toString('ascii'), 'PK')
    assert.ok(workbook.buffer.length > 500)
  } finally {
    machine.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('nextDue steps every repetition rule and skips occurrences already past', () => {  const now = Date.parse('2026-11-25T14:00:00Z')
  const base = '2026-11-25T15:59:00.000Z' // Wednesday 23:59 +08:00
  assert.equal(nextDue(base, 'daily', now), '2026-11-26T15:59:00.000Z')
  assert.equal(nextDue(base, 'weekly', now), '2026-12-02T15:59:00.000Z')
  assert.equal(nextDue(base, 'weekdays', now), '2026-11-26T15:59:00.000Z')
  assert.equal(nextDue(base, 'none', now), null)
  // A monthly rule on the 31st clamps to the last day of a shorter month.
  assert.equal(nextDue('2026-01-31T15:59:00.000Z', 'monthly', Date.parse('2026-01-31T14:00:00Z')), '2026-02-28T15:59:00.000Z')
  // Friday + weekdays lands on Monday.
  assert.equal(nextDue('2026-11-27T15:59:00.000Z', 'weekdays', Date.parse('2026-11-27T14:00:00Z')), '2026-11-30T15:59:00.000Z')
  // Missed daily occurrences are skipped up to the first future one.
  assert.equal(nextDue('2026-11-01T15:59:00.000Z', 'daily', now), '2026-11-25T15:59:00.000Z')
})

test('completing a repeating task spawns the next occurrence', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'daily-plan-repeat-'))
  const machine = await startMachine('repeat', root, 'http://127.0.0.1:1/unused')
  try {
    const created = await machine.call('daily_tasks', {
      action: 'add',
      title: '每日站会',
      due: '2099-01-01T09:00:00+08:00',
      repeat: 'daily',
    })
    const task = created.tasks[0]
    assert.equal(task.repeat, 'daily')

    const done = await machine.call('daily_tasks', { action: 'complete', id: task.id })
    assert.equal(done.task.done, true)
    assert.equal(done.spawned.title, '每日站会')
    assert.equal(done.spawned.done, false)
    assert.notEqual(done.spawned.id, task.id)
    assert.equal(
      new Date(done.spawned.due).getTime(),
      new Date('2099-01-02T09:00:00+08:00').getTime(),
    )

    // Un-completing does not spawn another copy.
    const undone = await machine.call('daily_tasks', { action: 'complete', id: task.id, done: false })
    assert.equal(undone.spawned || null, null)
    assert.equal((await machine.list()).tasks.length, 2)
  } finally {
    machine.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('fetchDailyQuote bypasses provider caches and rotates kinds', async () => {
  const original = globalThis.fetch
  try {
    const calls = []
    globalThis.fetch = async url => {
      calls.push(String(url))
      return {
        ok: true,
        async json() {
          return { hitokoto: '测试诗句', from: '测试集', from_who: '测试集' }
        },
      }
    }
    const poetry = await fetchDailyQuote(new Date(2026, 10, 25, 12, 0, 0).getTime())
    assert.equal(poetry.text, '测试诗句')
    assert.equal(poetry.from, '测试集', 'a repeated source/author is de-duplicated')
    assert.equal(poetry.kind, 'poetry')
    assert.equal(poetry.date, '2026-11-25')
    assert.ok(calls[0].includes('_='), 'the request carries a cache-busting timestamp')

    // The fourth rotation slot (Jan 4) is the English source.
    globalThis.fetch = async () => ({
      ok: true,
      async json() {
        return [{ q: 'Test quote', a: 'Tester' }]
      },
    })
    const english = await fetchDailyQuote(new Date(2026, 0, 4, 12, 0, 0).getTime())
    assert.equal(english.kind, 'english')
    assert.equal(english.text, 'Test quote')
    assert.equal(english.from, 'Tester')
  } finally {
    globalThis.fetch = original
  }
})
