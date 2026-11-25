import assert from 'node:assert/strict'
import test from 'node:test'
import { inflateRawSync } from 'node:zlib'

import { completedTasks, formatStamp, renderMarkdown, renderXlsx, rowsOf, labelsFor } from '../export.js'

const T1 = Date.parse('2026-11-25T04:30:00Z')
const T2 = Date.parse('2026-11-24T09:00:00Z')

const tasks = [
  {
    id: 'a',
    title: '写周报',
    note: '含 | 竖线\n第二行',
    due: '2026-11-25T09:00:00.000Z',
    priority: 'high',
    repeat: 'daily',
    done: true,
    completedAt: T1,
  },
  { id: 'b', title: '买菜', note: '', due: null, priority: 'normal', repeat: 'none', done: false, completedAt: null },
  { id: 'c', title: '整理桌面', note: '', due: null, priority: 'low', repeat: 'none', done: true, completedAt: T2 },
]

test('completedTasks keeps finished tasks, newest first, inside a range', () => {
  const all = completedTasks(tasks)
  assert.deepEqual(all.map(task => task.id), ['a', 'c'])
  const recent = completedTasks(tasks, T1)
  assert.deepEqual(recent.map(task => task.id), ['a'])
  const before = completedTasks(tasks, 0, T1)
  assert.deepEqual(before.map(task => task.id), ['c'])
})

test('rowsOf renders the shared row shape', () => {
  const labels = labelsFor('zh')
  const rows = rowsOf(completedTasks(tasks), labels)
  assert.equal(rows.length, 2)
  assert.equal(rows[0][1], '写周报')
  assert.equal(rows[0][4], '重要')
  assert.equal(rows[0][5], '每天')
  assert.match(rows[0][0], /^2026-11-25 \d{2}:\d{2}$/)
  assert.equal(formatStamp(0), '')
})

test('renderMarkdown writes a table and escapes pipes and newlines', () => {
  const markdown = renderMarkdown(tasks, { lang: 'zh', now: T1 })
  assert.match(markdown, /^# 每日任务 · 已完成记录/)
  assert.match(markdown, /\| 完成时间 \| 任务 \| 备注 \|/)
  assert.match(markdown, /写周报/)
  assert.match(markdown, /含 \\\| 竖线 第二行/)
  assert.match(markdown, /共 2 条/)
  const english = renderMarkdown(tasks, { lang: 'en' })
  assert.match(english, /^# Daily plan · completed tasks/)
  assert.match(english, /Completed at/)
})

function readZip(buffer) {
  const entries = {}
  let offset = 0
  while (offset + 4 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8)
    const compressed = buffer.readUInt32LE(offset + 18)
    const nameLength = buffer.readUInt16LE(offset + 26)
    const extraLength = buffer.readUInt16LE(offset + 28)
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString('utf8')
    const start = offset + 30 + nameLength + extraLength
    const data = buffer.subarray(start, start + compressed)
    entries[name] = (method === 8 ? inflateRawSync(data) : data).toString('utf8')
    offset = start + compressed
  }
  return entries
}

test('renderXlsx produces a readable OOXML package with the expected rows', () => {
  const workbook = renderXlsx(tasks, { lang: 'zh' })
  assert.ok(Buffer.isBuffer(workbook))
  const entries = readZip(workbook)
  assert.deepEqual(
    Object.keys(entries).sort(),
    ['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml'],
  )
  assert.match(entries['[Content_Types].xml'], /spreadsheetml\.sheet\.main\+xml/)
  assert.match(entries['xl/workbook.xml'], /name="已完成记录"/)
  const sheet = entries['xl/worksheets/sheet1.xml']
  assert.match(sheet, /<t xml:space="preserve">完成时间<\/t>/)
  assert.match(sheet, /<t xml:space="preserve">写周报<\/t>/)
  assert.match(sheet, /<t xml:space="preserve">每天<\/t>/)
  assert.ok(sheet.includes('含 | 竖线\n第二行'), 'a multi-line note stays a text cell')
  assert.match(sheet, /<row r="2">/)
})
