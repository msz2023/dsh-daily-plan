/**
 * Daily plan: cloud sync.
 *
 * The local file stays the source of truth for this machine; one JSON document
 * lives in the cloud and is merged with the local list on every sync round.
 *
 * Merge rules, chosen so any number of machines converges to the same bytes:
 *  - a task is identified by its `id`; the record with the newest `updatedAt` wins;
 *  - a delete writes a tombstone (`tombstones[id] = deletedAt`), and a newer edit
 *    of the same task resurrects it;
 *  - canonical serialization sorts tasks and tombstone keys, so "equal" is cheap.
 *
 * Zero dependencies on purpose, like the rest of this bundle: HTTP uses the
 * built-in fetch, and the S3 transport signs AWS Signature V4 with node:crypto.
 */

import { createHash, createHmac } from 'node:crypto'

export const DOC_VERSION = 2

/** Same ceiling the store enforces, so a merge cannot grow the list past it. */
const MAX_TASKS = 500

/** A tombstone older than this is dropped; every machine has seen the delete by then. */
const TOMBSTONE_TTL = 90 * 24 * 60 * 60 * 1000

/** The document shape both sides agree on. */
export function emptyDoc() {
  return { version: DOC_VERSION, updatedAt: 0, tasks: [], tombstones: {} }
}

function positive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

function isBlank(value) {
  return typeof value !== 'string' || value.trim() === ''
}

/**
 * Reads any stored or received document into the canonical shape. Unknown
 * members are dropped; a task needs an id and a title to survive (the local
 * store drops title-less records too, so keeping them here would make every
 * round push them again).
 */
export function normalizeDoc(raw, now = Date.now()) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const taskList = Array.isArray(source) ? source : Array.isArray(source.tasks) ? source.tasks : []
  const seen = new Set()
  const tasks = []
  for (const task of taskList) {
    if (!task || typeof task !== 'object') continue
    const id = typeof task.id === 'string' ? task.id.trim().slice(0, 64) : ''
    if (!id || seen.has(id) || isBlank(task.title)) continue
    seen.add(id)
    tasks.push({ ...task, id, updatedAt: positive(task.updatedAt) || now })
  }
  const tombstones = {}
  const rawTombstones = source.tombstones && typeof source.tombstones === 'object' ? source.tombstones : {}
  for (const [id, at] of Object.entries(rawTombstones)) {
    if (typeof id !== 'string' || id === '') continue
    const time = positive(at)
    if (time === 0) continue
    if (tombstones[id] === undefined || time > tombstones[id]) tombstones[id] = time
  }
  return {
    version: DOC_VERSION,
    updatedAt: positive(source.updatedAt),
    tasks: tasks.slice(0, MAX_TASKS),
    tombstones,
  }
}

/** Stable serialization for equality checks: same content means the same string. */
export function canonicalDoc(raw) {
  const doc = normalizeDoc(raw)
  const tasks = doc.tasks.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const tombstones = {}
  for (const id of Object.keys(doc.tombstones).sort()) tombstones[id] = doc.tombstones[id]
  return JSON.stringify({ version: DOC_VERSION, tasks, tombstones })
}

export function docsEqual(a, b) {
  return canonicalDoc(a) === canonicalDoc(b)
}

/**
 * Merge two documents into the one both machines should store. Deterministic:
 * every replica reaches the same result from the same inputs, ties included.
 */
export function mergeDocs(localRaw, remoteRaw, now = Date.now()) {
  const local = normalizeDoc(localRaw, now)
  const remote = normalizeDoc(remoteRaw, now)

  const chosen = new Map()
  const consider = task => {
    const current = chosen.get(task.id)
    if (current === undefined) {
      chosen.set(task.id, task)
      return
    }
    if (task.updatedAt > current.updatedAt) {
      chosen.set(task.id, task)
      return
    }
    if (task.updatedAt < current.updatedAt) return
    // Same timestamp: pick the same record on every replica.
    if (JSON.stringify(task) < JSON.stringify(current)) chosen.set(task.id, task)
  }
  for (const task of local.tasks) consider(task)
  for (const task of remote.tasks) consider(task)

  const tombstones = {}
  const bury = (id, at) => {
    if (tombstones[id] === undefined || at > tombstones[id]) tombstones[id] = at
  }
  for (const [id, at] of Object.entries(local.tombstones)) bury(id, at)
  for (const [id, at] of Object.entries(remote.tombstones)) bury(id, at)

  const tasks = []
  for (const task of chosen.values()) {
    const deletedAt = tombstones[task.id]
    if (deletedAt !== undefined && deletedAt >= task.updatedAt) continue
    // An edit newer than the delete wins, so the tombstone is no longer needed.
    if (deletedAt !== undefined) delete tombstones[task.id]
    tasks.push(task)
  }
  for (const [id, at] of Object.entries(tombstones)) {
    if (now - at > TOMBSTONE_TTL) delete tombstones[id]
  }

  tasks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const updatedAt = Math.max(
    local.updatedAt,
    remote.updatedAt,
    ...tasks.map(task => task.updatedAt),
    ...Object.values(tombstones),
  )
  return { version: DOC_VERSION, updatedAt, tasks: tasks.slice(0, MAX_TASKS), tombstones }
}

/** An HTTP response the transport rejected, carrying the status for retry logic. */
export class SyncHttpError extends Error {
  constructor(message, status, etag = null) {
    super(message)
    this.name = 'SyncHttpError'
    this.status = status
    this.etag = etag
  }
}

function parseRemote(raw) {
  const text = String(raw || '').trim()
  if (text === '') return emptyDoc()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('云端任务文件不是有效 JSON，已停止覆盖它；请检查云端文件内容')
  }
}

/* ------------------------------------------------------------------ *
 * Transports: WebDAV (Basic auth, one JSON file) and S3 (SigV4, one object)
 * ------------------------------------------------------------------ */

/**
 * WebDAV transport: GET reads the file (404 means "not written yet"), PUT
 * replaces it. Works with Nextcloud, 坚果云, and the second-generation RainYun
 * object storage that exposes WebDAV.
 */
export function createWebDavTransport({ url, username = '', password = '', fetchImpl = globalThis.fetch }) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    throw new Error('WebDAV 地址必须以 http:// 或 https:// 开头')
  }
  const target = new URL(url)
  const baseHeaders = { accept: 'application/json' }
  if (username || password) {
    baseHeaders.authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
  }
  return {
    provider: 'webdav',
    label: target.host,
    async read() {
      const response = await fetchImpl(target, { method: 'GET', headers: baseHeaders, redirect: 'follow', cache: 'no-store' })
      if (response.status === 404) return { found: false, doc: null, etag: null }
      if (!response.ok) throw new SyncHttpError(`WebDAV 读取失败：HTTP ${response.status}`, response.status)
      return { found: true, doc: parseRemote(await response.text()), etag: response.headers.get('etag') }
    },
    async write(doc, options = {}) {
      const headers = { ...baseHeaders, 'content-type': 'application/json; charset=utf-8' }
      if (options.ifMatch) headers['if-match'] = options.ifMatch
      const response = await fetchImpl(target, { method: 'PUT', headers, body: JSON.stringify(doc, null, 2) })
      if (!response.ok) {
        throw new SyncHttpError(
          `WebDAV 写入失败：HTTP ${response.status}`,
          response.status,
          response.headers.get('etag'),
        )
      }
      return { etag: response.headers.get('etag') }
    },
  }
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex')
}

function hmac(key, value) {
  return createHmac('sha256', key).update(value).digest()
}

/** RFC 3986 encoding, which S3 requires for every canonical URI segment. */
function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

function amzDate(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '')
}

/**
 * S3-compatible transport, signed as AWS Signature Version 4. Both addressing
 * styles are available: `path` (`<endpoint>/<bucket>/<key>`, what MinIO and most
 * self-hosted S3 servers want) and `virtual` (`<bucket>.<endpoint>/<key>`, what
 * the AWS SDK uses by default). The connection test in index.js falls back to
 * the other style, so a provider that only speaks one still works.
 *
 * RainYun documents `endpoint: https://cn-sy1.rains3.com` and `region: rainyun`.
 */
export function createS3Transport({
  endpoint,
  bucket,
  key = 'daily-plan/tasks.json',
  region = 'rainyun',
  accessKey,
  secretKey,
  style = 'path',
  fetchImpl = globalThis.fetch,
  clock = () => new Date(),
}) {
  if (/^https?:\/\//i.test(String(endpoint || '')) === false) {
    throw new Error('S3 endpoint 必须以 http:// 或 https:// 开头')
  }
  if (!bucket) throw new Error('S3 同步需要存储桶名 bucket')
  if (!accessKey || !secretKey) throw new Error('S3 同步需要 AccessKey 和 SecretKey')
  const base = String(endpoint).replace(/\/+$/, '')
  const baseUrl = new URL(base)
  const safeBucket = encodeRfc3986(String(bucket))
  const keyPath = String(key || 'daily-plan/tasks.json')
    .replace(/^\/+/, '')
    .split('/')
    .filter(Boolean)
    .map(encodeRfc3986)
    .join('/')
  const virtualStyle = style === 'virtual'
  const target = virtualStyle
    ? new URL(`${baseUrl.protocol}//${safeBucket}.${baseUrl.host}/${keyPath}`)
    : new URL(`${base}/${safeBucket}/${keyPath}`)
  const regionName = String(region || 'rainyun')

  async function signedRequest(method, body) {
    const payload = body === undefined ? '' : body
    const payloadHash = sha256Hex(payload)
    const now = clock()
    const stamp = amzDate(now)
    const dateStamp = stamp.slice(0, 8)
    const contentType = body === undefined ? '' : 'application/json; charset=utf-8'
    const signedHeaderNames = contentType
      ? 'content-type;host;x-amz-content-sha256;x-amz-date'
      : 'host;x-amz-content-sha256;x-amz-date'
    const canonicalHeaders = (contentType ? `content-type:${contentType}\n` : '')
      + `host:${target.host}\n`
      + `x-amz-content-sha256:${payloadHash}\n`
      + `x-amz-date:${stamp}\n`
    const canonicalRequest = [
      method,
      target.pathname,
      target.search.replace(/^\?/, ''),
      canonicalHeaders,
      signedHeaderNames,
      payloadHash,
    ].join('\n')
    const scope = `${dateStamp}/${regionName}/s3/aws4_request`
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      stamp,
      scope,
      sha256Hex(canonicalRequest),
    ].join('\n')
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, dateStamp), regionName), 's3'), 'aws4_request')
    const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex')
    const headers = {
      authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaderNames}, Signature=${signature}`,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': stamp,
      accept: 'application/json',
    }
    if (contentType) headers['content-type'] = contentType
    return fetchImpl(target, { method, headers, body: body === undefined ? undefined : body })
  }

  return {
    provider: 's3',
    style: virtualStyle ? 'virtual' : 'path',
    label: virtualStyle ? `${target.host}/${keyPath}` : `${target.host}/${bucket}`,
    async read() {
      const response = await signedRequest('GET')
      if (response.status === 404) return { found: false, doc: null, etag: response.headers.get('etag') }
      if (!response.ok) {
        throw new SyncHttpError(
          `S3 读取失败：HTTP ${response.status}${response.status === 403 ? '（检查 AccessKey/SecretKey 和桶名）' : ''}`,
          response.status,
        )
      }
      return { found: true, doc: parseRemote(await response.text()), etag: response.headers.get('etag') }
    },
    async write(doc) {
      const response = await signedRequest('PUT', JSON.stringify(doc, null, 2))
      if (!response.ok) {
        throw new SyncHttpError(
          `S3 写入失败：HTTP ${response.status}${response.status === 403 ? '（检查 AccessKey/SecretKey 和桶名）' : ''}`,
          response.status,
        )
      }
      return { etag: response.headers.get('etag') }
    },
  }
}

/* ------------------------------------------------------------------ *
 * Engine: pull, merge, push, apply — serialized, debounced, and observable
 * ------------------------------------------------------------------ */

/**
 * Runs sync rounds against one transport. The caller owns transport creation
 * (config changes rebuild it) and the store's snapshot/applyDoc bridge.
 *
 * @param {object} options
 * @param {{ snapshot: () => object, applyDoc: (doc: object) => Promise<void> | void }} options.store
 * @param {() => object | null} options.getTransport  the current transport, or null when sync is off
 * @param {() => void} [options.onStatus]  called after every status change
 * @param {(message: string) => void} [options.log]
 * @param {number} [options.intervalMs]  background poll period
 * @param {number} [options.debounceMs]  delay after a local mutation before a round
 */
export function createSyncEngine({
  store,
  getTransport,
  onStatus = () => {},
  log = () => {},
  intervalMs = 20_000,
  debounceMs = 1_200,
  now = () => Date.now(),
}) {
  let round = null
  let pollTimer = null
  let debounceTimer = null
  let lastOkAt = 0
  let lastAttemptAt = 0
  let lastError = null
  let lastPushAt = 0
  let lastPullAt = 0
  let rounds = 0

  function transport() {
    return typeof getTransport === 'function' ? getTransport() : null
  }

  function status() {
    const current = transport()
    return {
      enabled: Boolean(current),
      provider: current ? current.provider : null,
      target: current ? current.label : null,
      syncing: round !== null,
      lastOkAt,
      lastAttemptAt,
      lastPushAt,
      lastPullAt,
      lastError,
      rounds,
    }
  }

  function notify() {
    try {
      onStatus()
    } catch {
      // Observers must not break sync.
    }
  }

  async function applyIfChanged(doc) {
    const local = store.snapshot()
    if (docsEqual(local, doc)) return false
    await store.applyDoc(doc)
    return true
  }

  /** One pull-merge-push round. Concurrent callers share the running round. */
  function syncNow() {
    if (round !== null) return round
    const active = transport()
    if (active === null) return Promise.resolve({ skipped: true, reason: 'sync-disabled' })
    round = (async () => {
      lastAttemptAt = now()
      rounds += 1
      try {
        const remote = await active.read()
        const localDoc = store.snapshot()
        const merged = mergeDocs(localDoc, remote.doc, now())
        let pushed = false
        if (!remote.found || !docsEqual(merged, remote.doc)) {
          await active.write(merged)
          pushed = true
          lastPushAt = now()
        }
        const applied = await applyIfChanged(merged)
        if (applied) lastPullAt = now()
        lastOkAt = now()
        lastError = null
        return { skipped: false, pushed, applied, tasks: merged.tasks.length }
      } catch (error) {
        lastError = error && error.message ? error.message : String(error)
        log(`daily-plan sync: ${lastError}`)
        throw error
      } finally {
        round = null
        notify()
      }
    })()
    return round
  }

  function scheduleRound(delay) {
    if (debounceTimer !== null) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      if (transport() === null) return
      syncNow().catch(() => {})
    }, Math.max(0, delay))
    if (typeof debounceTimer.unref === 'function') debounceTimer.unref()
  }

  function start() {
    stop()
    if (transport() === null) {
      notify()
      return
    }
    syncNow().catch(() => {})
    pollTimer = setInterval(() => {
      if (transport() === null) return
      syncNow().catch(() => {})
    }, intervalMs)
    if (typeof pollTimer.unref === 'function') pollTimer.unref()
  }

  function stop() {
    if (pollTimer !== null) clearInterval(pollTimer)
    if (debounceTimer !== null) clearTimeout(debounceTimer)
    pollTimer = null
    debounceTimer = null
  }

  /** A local edit: push soon, coalescing a burst of edits into one round. */
  function requestSync() {
    if (transport() === null) return
    scheduleRound(debounceMs)
  }

  return { start, stop, requestSync, syncNow, status }
}
