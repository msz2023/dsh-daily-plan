import assert from 'node:assert/strict'
import test from 'node:test'

import { createS3Transport, SyncHttpError } from '../sync.js'

const FIXED = () => new Date('2026-11-25T00:00:00Z')

function recorder() {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init })
    return new Response('', { status: 404 })
  }
  return { calls, fetchImpl }
}

const base = {
  endpoint: 'https://cn-sy1.rains3.com',
  bucket: 'my-bucket',
  key: 'daily-plan/tasks.json',
  region: 'rainyun',
  accessKey: 'AKIDEXAMPLE',
  secretKey: 'SECRETEXAMPLE',
  clock: FIXED,
}

test('S3 transport uses path-style addressing and signs AWS SigV4', async () => {
  const { calls, fetchImpl } = recorder()
  const transport = createS3Transport({ ...base, fetchImpl })
  const result = await transport.read()
  assert.equal(result.found, false)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://cn-sy1.rains3.com/my-bucket/daily-plan/tasks.json')
  assert.equal(calls[0].init.method, 'GET')
  assert.equal(calls[0].init.headers['x-amz-date'], '20261125T000000Z')
  assert.match(
    calls[0].init.headers.authorization,
    /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261125\/rainyun\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
  )
})

test('S3 virtual-host style puts the bucket in the host name', async () => {
  const { calls, fetchImpl } = recorder()
  const transport = createS3Transport({ ...base, style: 'virtual', fetchImpl })
  await transport.read()
  assert.equal(calls[0].url, 'https://my-bucket.cn-sy1.rains3.com/daily-plan/tasks.json')
  assert.match(calls[0].init.headers.authorization, /SignedHeaders=host;x-amz-content-sha256;x-amz-date/)
})

test('S3 write signs the body and reports server failures', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init })
    if (calls.length === 1) return new Response('', { status: 200 })
    return new Response('', { status: 403 })
  }
  const transport = createS3Transport({ ...base, fetchImpl })
  await transport.write({ version: 2, tasks: [], tombstones: {}, updatedAt: 0 })
  assert.match(calls[0].init.headers.authorization, /SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date/)
  assert.equal(calls[0].init.headers['content-type'], 'application/json; charset=utf-8')
  assert.ok(calls[0].init.body.includes('"version": 2'))

  await assert.rejects(
    () => transport.write({ version: 2, tasks: [], tombstones: {}, updatedAt: 0 }),
    error => error instanceof SyncHttpError && error.status === 403,
  )
})

test('the same request and clock produce the same signature', async () => {
  const first = recorder()
  const second = recorder()
  await createS3Transport({ ...base, fetchImpl: first.fetchImpl }).read()
  await createS3Transport({ ...base, fetchImpl: second.fetchImpl }).read()
  assert.equal(first.calls[0].init.headers.authorization, second.calls[0].init.headers.authorization)
})
