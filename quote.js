/**
 * Daily plan: quote of the day.
 *
 * One short item per calendar day, rotating through four kinds so the header
 * shows a mix across days: 诗词 (Hitokoto poetry), 句子 (Hitokoto literature /
 * philosophy), 电影台词 (Hitokoto movie lines), and English (ZenQuotes).
 *
 * The result is cached next to the task file, so the panel never waits on the
 * network except for the first request of the day. Everything is best-effort:
 * a failed fetch falls back to the previous cached item, and the page falls back
 * to its built-in local lines.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

const MAX_LENGTH = 90
const RETRY_AFTER_MS = 10 * 60 * 1000

export function dayKey(now = Date.now()) {
  const date = new Date(now)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** 0-based day of the local year; used to rotate the quote kinds. */
export function dayOfYear(now = Date.now()) {
  const date = new Date(now)
  const start = new Date(date.getFullYear(), 0, 1)
  const today = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  return Math.floor((today.getTime() - start.getTime()) / 86400000)
}

function parseHitokoto(data) {
  const text = typeof data?.hitokoto === 'string' ? data.hitokoto.trim() : ''
  if (!text) throw new Error('empty quote')
  const parts = [data?.from, data?.from_who]
    .filter(value => typeof value === 'string' && value.trim())
    .map(value => value.trim())
  const from = parts.filter((value, index) => parts.indexOf(value) === index).join(' · ')
  return { text: text.slice(0, MAX_LENGTH), from: from.slice(0, 50) }
}

function parseZenquotes(data) {
  const item = Array.isArray(data) ? data[0] : data
  const text = typeof item?.q === 'string' ? item.q.trim() : ''
  if (!text) throw new Error('empty quote')
  return { text: text.slice(0, MAX_LENGTH), from: typeof item?.a === 'string' ? item.a.trim().slice(0, 50) : '' }
}

/** The four rotating kinds; the day number picks one. */
export const QUOTE_KINDS = [
  { id: 'poetry', url: 'https://v1.hitokoto.cn/?encode=json&c=i', parse: parseHitokoto, source: 'hitokoto' },
  { id: 'sentence', url: 'https://v1.hitokoto.cn/?encode=json&c=d&c=k', parse: parseHitokoto, source: 'hitokoto' },
  { id: 'movie', url: 'https://v1.hitokoto.cn/?encode=json&c=h', parse: parseHitokoto, source: 'hitokoto' },
  { id: 'english', url: 'https://zenquotes.io/api/random', parse: parseZenquotes, source: 'zenquotes' },
]

export function kindFor(now = Date.now()) {
  return QUOTE_KINDS[dayOfYear(now) % QUOTE_KINDS.length]
}

/**
 * One quote per day with a file cache.
 *
 * @param {object} options
 * @param {string} options.file  cache path (`$DSH_HOME/daily-plan/quote.json`)
 * @param {Function} [options.fetchImpl]  fetch implementation, for tests
 * @param {() => number} [options.now]
 * @param {() => object} [options.pickKind]  override the daily rotation, for tests
 */
export function createQuoteCache({
  file,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  pickKind = kindFor,
  timeoutMs = 7000,
}) {
  let memory = null
  let loading = null
  let lastFailureAt = 0

  async function readCache() {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'))
      if (parsed && typeof parsed.text === 'string' && parsed.text) return parsed
    } catch {
      // A missing or unreadable cache just means "fetch once".
    }
    return null
  }

  async function saveCache(entry) {
    await mkdir(path.dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    await writeFile(temp, `${JSON.stringify(entry, null, 2)}\n`, 'utf8')
    await rename(temp, file)
  }

  async function fetchQuote(kind) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      // A unique query parameter keeps the provider's CDN from returning the
      // same cached item for every request of the day.
      const url = new URL(kind.url)
      url.searchParams.set('_', String(now()))
      const response = await fetchImpl(url, {
        signal: controller.signal,
        headers: { accept: 'application/json', 'cache-control': 'no-cache', 'user-agent': 'dsh-daily-plan' },
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const parsed = kind.parse(await response.json())
      return {
        ...parsed,
        kind: kind.id,
        source: kind.source,
        date: dayKey(now()),
        fetchedAt: now(),
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /** Today's quote: from cache when fresh, otherwise fetched (bounded retries). */
  function get(force = false) {
    if (loading !== null) return loading
    loading = (async () => {
      try {
        if (!force && memory === null) memory = await readCache()
        const today = dayKey(now())
        if (!force && memory && memory.date === today) {
          // A cache written by an older version may lack the kind label.
          if (!memory.kind) {
            const kind = typeof pickKind === 'function' ? pickKind(now()) : QUOTE_KINDS[0]
            memory = { ...memory, kind: kind.id }
          }
          return memory
        }
        if (!force && lastFailureAt !== 0 && now() - lastFailureAt < RETRY_AFTER_MS) {
          return memory ? { ...memory, stale: true } : { text: null, from: '', kind: null, source: null, date: today }
        }
        const kind = typeof pickKind === 'function' ? pickKind(now()) : QUOTE_KINDS[0]
        try {
          const fresh = await fetchQuote(kind)
          memory = fresh
          try {
            await saveCache(fresh)
          } catch {
            // The cache is an optimisation; serving the quote still works.
          }
          return fresh
        } catch (error) {
          lastFailureAt = now()
          if (memory === null) memory = await readCache()
          return memory
            ? { ...memory, stale: true, error: error.message }
            : { text: null, from: '', kind: null, source: null, date: today, error: error.message }
        }
      } finally {
        loading = null
      }
    })()
    return loading
  }

  return { get, file }
}
