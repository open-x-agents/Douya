// A12/A13 for the write primitives: one-step replacement without leftovers, one process's
// writes running in turn, and the lock file's stale/timeout rules. Every directory is a
// fresh mkdtemp() so a test never touches the repository's own data/.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  LockTimeoutError,
  appendJsonLines,
  atomicWriteJson,
  readTextOrNull,
  withDataLock,
} from '../src/core/atomic.js'

const temporary = (name) => mkdtemp(join(tmpdir(), `odm-atomic-${name}-`))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('a save leaves no temporary file behind and replaces the file in one step', async () => {
  const dir = await temporary('save')
  const file = join(dir, 'nested', 'events.json')

  await atomicWriteJson(file, { revision: 1, events: [] })

  assert.equal(await readFile(file, 'utf8'), `${JSON.stringify({ revision: 1, events: [] }, null, 2)}\n`)
  assert.deepEqual((await readdir(join(dir, 'nested'))).filter((name) => name.endsWith('.tmp')), [])

  // A second save replaces the whole file; the first content is gone in one rename.
  await atomicWriteJson(file, { revision: 2, events: [{ id: 'evt_one' }] })

  assert.equal(
    await readFile(file, 'utf8'),
    `${JSON.stringify({ revision: 2, events: [{ id: 'evt_one' }] }, null, 2)}\n`,
  )
  assert.deepEqual((await readdir(join(dir, 'nested'))).filter((name) => name.endsWith('.tmp')), [])
})

test('writes in one process run one after another', async () => {
  const dir = await temporary('serial')
  const file = join(dir, 'ledger.jsonl')

  // Twenty readers-then-writers started at once: each computes the next seq from the file it
  // just read. Only serialization keeps the sequence unbroken; the sleep widens the window
  // between read and append so an unserialized run interleaves and duplicates seqs.
  const writes = Array.from({ length: 20 }, () =>
    withDataLock(dir, async () => {
      const text = await readTextOrNull(file)
      const taken = text === null ? 0 : text.trim().split('\n').filter(Boolean).length
      await sleep(1)
      await appendJsonLines(file, [{ seq: taken + 1 }])
    }),
  )
  await Promise.all(writes)

  const lines = (await readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(lines.length, 20)
  assert.deepEqual(lines.map((line) => line.seq), Array.from({ length: 20 }, (_, index) => index + 1))
  assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith('.tmp')), [])
  assert.equal(await readTextOrNull(join(dir, 'store.lock')), null)
})

test('a fresh lock that never clears fails with E_LOCK_TIMEOUT', async () => {
  const dir = await temporary('timeout')
  const lock = join(dir, 'store.lock')
  const held = JSON.stringify({ pid: 99999, at: new Date().toISOString(), nonce: 'held' })
  await writeFile(lock, held)

  const started = Date.now()
  await assert.rejects(
    withDataLock(dir, async () => 'never', { timeoutMs: 200 }),
    (error) => error instanceof LockTimeoutError && error.code === 'E_LOCK_TIMEOUT',
  )
  assert.ok(Date.now() - started < 5000, 'the wait is bounded by timeoutMs, not the default')

  // A lock that is still fresh is somebody's turn: it stays exactly where it was.
  assert.equal(await readFile(lock, 'utf8'), held)
})

test('an old lock is broken so the next writer can work', async () => {
  const dir = await temporary('stale')
  const lock = join(dir, 'store.lock')
  const dead = new Date(Date.now() - 60_000)
  await writeFile(lock, JSON.stringify({ pid: 99999, at: dead.toISOString(), nonce: 'dead' }))
  await utimes(lock, dead, dead)

  const result = await withDataLock(dir, async () => 'ran')

  assert.equal(result, 'ran')
  assert.equal(await readTextOrNull(lock), null)
  assert.deepEqual((await readdir(dir)).filter((name) => name.includes('.stale')), [])
})
