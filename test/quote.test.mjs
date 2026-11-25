import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createQuoteCache, dayKey, dayOfYear, kindFor, QUOTE_KINDS } from '../quote.js'

function fakeFetch(items) {
  const calls = []
  const fetchImpl = async () => {
    calls.push(Date.now())
    const next = items[Math.min(calls.length - 1, items.length - 1)]
    if (next instanceof Error) throw next
    return {
      ok: true,
      async json() {
        return next.payload
      },
    }
  }
  return { fetchImpl, calls }
}

test('fetches one quote per calendar day and caches it', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'daily-plan-quote-'))
  try {
    let clock = Date.parse('2026-11-25T02:00:00Z')
    const { fetchImpl, calls } = fakeFetch([{ payload: { hitokoto: '路漫漫其修远兮', from: '离骚', from_who: '屈原' } }])
    const cache = createQuoteCache({ file: path.join(dir, 'quote.json'), fetchImpl, now: () => clock })

    const first = await cache.get()
    assert.equal(first.text, '路漫漫其修远兮')
    assert.equal(first.from, '离骚 · 屈原')
    assert.equal(first.date, dayKey(clock))
    assert.equal(first.kind, 'poetry', 'the rotation starts with poetry on this day')

    const second = await cache.get()
    assert.equal(second.text, '路漫漫其修远兮')
    assert.equal(calls.length, 1, 'same day uses the cache')

    // A mounted file cache also survives a fresh process.
    const reopened = createQuoteCache({ file: path.join(dir, 'quote.json'), fetchImpl, now: () => clock })
    assert.equal((await reopened.get()).text, '路漫漫其修远兮')
    assert.equal(calls.length, 1)

    clock += 24 * 60 * 60 * 1000
    const { fetchImpl: dayTwoFetch, calls: dayTwoCalls } = fakeFetch([{ payload: { hitokoto: '青山遮不住', from: '菩萨蛮' } }])
    const dayTwo = createQuoteCache({ file: path.join(dir, 'quote.json'), fetchImpl: dayTwoFetch, now: () => clock })
    assert.equal((await dayTwo.get()).text, '青山遮不住')
    assert.equal(dayTwoCalls.length, 1, 'a new day fetches again')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the four kinds rotate daily and include an English source', async () => {
  const start = new Date(2026, 0, 1).getTime()
  const kinds = new Set()
  for (let offset = 0; offset < 4; offset += 1) {
    const day = new Date(2026, 0, 1 + offset)
    kinds.add(kindFor(day.getTime()).id)
    assert.equal(dayOfYear(day.getTime()), offset)
  }
  assert.deepEqual([...kinds].sort(), ['english', 'movie', 'poetry', 'sentence'])

  const dir = await mkdtemp(path.join(tmpdir(), 'daily-plan-quote-'))
  try {
    const clock = start + 3 * 86400000 // fourth rotation slot -> English
    const { fetchImpl } = fakeFetch([{ payload: [{ q: 'A path is made by walking on it.', a: 'Zhuangzi' }] }])
    const cache = createQuoteCache({ file: path.join(dir, 'quote.json'), fetchImpl, now: () => clock })
    const result = await cache.get()
    assert.equal(result.kind, 'english')
    assert.equal(result.source, 'zenquotes')
    assert.equal(result.text, 'A path is made by walking on it.')
    assert.equal(result.from, 'Zhuangzi')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a failed fetch degrades gracefully and backs off', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'daily-plan-quote-'))
  try {
    const clock = Date.parse('2026-11-25T02:00:00Z')
    const { fetchImpl, calls } = fakeFetch([new Error('network down')])
    const cache = createQuoteCache({ file: path.join(dir, 'quote.json'), fetchImpl, now: () => clock })
    const first = await cache.get()
    assert.equal(first.text, null)
    assert.match(first.error, /network down/)
    assert.equal(calls.length, 1)

    await cache.get()
    assert.equal(calls.length, 1, 'a recent failure is not retried immediately')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("yesterday's cache is served when today's fetch fails", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'daily-plan-quote-'))
  try {
    const file = path.join(dir, 'quote.json')
    await writeFile(file, JSON.stringify({ text: '昨日之句', from: '旧书', kind: 'sentence', source: 'hitokoto', date: '2026-11-24' }))
    const clock = Date.parse('2026-11-25T02:00:00Z')
    const { fetchImpl, calls } = fakeFetch([new Error('offline')])
    const cache = createQuoteCache({ file, fetchImpl, now: () => clock })
    const result = await cache.get()
    assert.equal(result.text, '昨日之句')
    assert.equal(result.stale, true)
    assert.equal(calls.length, 1)
    assert.equal(JSON.parse(await readFile(file, 'utf8')).date, '2026-11-24', 'no rewrite happens on failure')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an unknown payload shape is reported as a failure, not a blank quote', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'daily-plan-quote-'))
  try {
    const clock = Date.parse('2026-11-25T02:00:00Z')
    const { fetchImpl } = fakeFetch([{ payload: { nothing: true } }])
    const cache = createQuoteCache({ file: path.join(dir, 'quote.json'), fetchImpl, now: () => clock })
    const result = await cache.get()
    assert.equal(result.text, null)
    assert.match(result.error, /empty quote/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('force refresh fetches a new quote and keeps the old one when it fails', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'daily-plan-quote-'))
  try {
    const clock = Date.parse('2026-11-25T02:00:00Z')
    const { fetchImpl, calls } = fakeFetch([
      { payload: { hitokoto: '第一句', from: '甲' } },
      { payload: { hitokoto: '第二句', from: '乙' } },
      new Error('offline'),
    ])
    const cache = createQuoteCache({ file: path.join(dir, 'quote.json'), fetchImpl, now: () => clock })
    assert.equal((await cache.get()).text, '第一句')
    assert.equal(calls.length, 1)
    assert.equal((await cache.get(true)).text, '第二句', 'refresh bypasses the same-day cache')
    assert.equal(calls.length, 2)
    const fallback = await cache.get(true)
    assert.equal(fallback.text, '第二句', 'a failed refresh keeps the last quote')
    assert.equal(fallback.stale, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
