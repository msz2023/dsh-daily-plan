import assert from 'node:assert/strict'
import test from 'node:test'

import {
  canonicalDoc,
  docsEqual,
  emptyDoc,
  mergeDocs,
  normalizeDoc,
} from '../sync.js'

const T0 = 1_700_000_000_000
const task = (id, updatedAt, extra = {}) => ({
  id,
  title: `task ${id}`,
  note: '',
  due: null,
  allDay: false,
  done: false,
  priority: 'normal',
  createdAt: updatedAt,
  updatedAt,
  completedAt: null,
  focusSeconds: 0,
  focusCount: 0,
  ...extra,
})

test('normalizeDoc reads the 1.0 file shape and drops unusable tasks', () => {
  const doc = normalizeDoc({ tasks: [task('a', T0), { id: 'b', title: '  ' }, { title: 'no id' }, task('a', T0 + 1)] }, T0)
  assert.deepEqual(doc.tasks.map(item => item.id), ['a'])
  assert.equal(doc.tasks[0].updatedAt, T0)
  assert.deepEqual(doc.tombstones, {})
  assert.equal(doc.version, 2)

  const legacy = normalizeDoc([task('x', T0)], T0)
  assert.deepEqual(legacy.tasks.map(item => item.id), ['x'])
})

test('mergeDocs takes the newest record per task id', () => {
  const local = { tasks: [task('a', T0), task('b', T0)] }
  const remote = { tasks: [task('a', T0 + 10, { note: 'from remote' }), task('c', T0)] }
  const merged = mergeDocs(local, remote, T0 + 20)
  const byId = Object.fromEntries(merged.tasks.map(item => [item.id, item]))
  assert.deepEqual(Object.keys(byId).sort(), ['a', 'b', 'c'])
  assert.equal(byId.a.note, 'from remote')
  assert.equal(byId.b.title, 'task b')
})

test('a delete tombstones the task on every replica', () => {
  const local = { tasks: [task('a', T0)], tombstones: { a: T0 + 5 } }
  const merged = mergeDocs(local, { tasks: [task('a', T0)] }, T0 + 10)
  assert.deepEqual(merged.tasks, [])
  assert.equal(merged.tombstones.a, T0 + 5)

  const again = mergeDocs(merged, { tasks: [task('a', T0)] }, T0 + 20)
  assert.deepEqual(again.tasks, [])
})

test('an edit newer than the delete resurrects the task', () => {
  const local = { tasks: [task('a', T0 + 10, { note: 'edited' })], tombstones: { a: T0 + 5 } }
  const merged = mergeDocs(local, emptyDoc(), T0 + 20)
  assert.equal(merged.tasks.length, 1)
  assert.equal(merged.tasks[0].note, 'edited')
  assert.equal(merged.tombstones.a, undefined)
})

test('equal timestamps merge deterministically and symmetrically', () => {
  const left = { tasks: [task('a', T0, { note: 'left' })] }
  const right = { tasks: [task('a', T0, { note: 'right' })] }
  const ab = mergeDocs(left, right, T0 + 1)
  const ba = mergeDocs(right, left, T0 + 1)
  assert.equal(canonicalDoc(ab), canonicalDoc(ba))
  assert.equal(ab.tasks.length, 1)
})

test('docsEqual ignores task order but not content', () => {
  const one = { tasks: [task('a', T0), task('b', T0)] }
  const two = { tasks: [task('b', T0), task('a', T0)] }
  assert.ok(docsEqual(one, two))
  const changed = { tasks: [task('a', T0 + 1), task('b', T0)] }
  assert.ok(!docsEqual(one, changed))
})

test('merging is idempotent and keeps tombstones until they expire', () => {
  const doc = { tasks: [task('a', T0)], tombstones: { gone: T0 } }
  const once = mergeDocs(doc, doc, T0 + 1)
  const twice = mergeDocs(once, once, T0 + 2)
  assert.equal(canonicalDoc(once), canonicalDoc(twice))

  const expired = mergeDocs(doc, doc, T0 + 91 * 24 * 60 * 60 * 1000)
  assert.equal(expired.tombstones.gone, undefined)
})

test('normalizeDoc keeps only positive tombstone timestamps', () => {
  const doc = normalizeDoc({ tombstones: { a: T0, b: 0, c: -1, d: 'nope' } }, T0)
  assert.deepEqual(Object.keys(doc.tombstones), ['a'])
})
