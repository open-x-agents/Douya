// A7/A12 for events.json: one thing stays one event across sources and processes, a damaged
// file is reported instead of emptied, and the revision moves with every write. Every store
// lives in a fresh mkdtemp() directory; nothing here reads the repository's own data/.

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CANONICAL_UTC } from '../src/core/event.js'
import { EventStoreError, createEventStore } from '../src/core/store.js'
import { readTextOrNull } from '../src/core/atomic.js'

const temporary = (name) => mkdtemp(join(tmpdir(), `odm-store-${name}-`))
const WORKER = fileURLToPath(new URL('./fixtures/store-worker.mjs', import.meta.url))

// A source's type is its ref prefix, including the two-part composio:<toolkit> form.
function sourceType(ref) {
  return ref.startsWith('composio:') ? ref.split(':').slice(0, 2).join(':') : ref.slice(0, ref.indexOf(':'))
}

function source(ref, { at = '2026-10-29T13:14:00.000Z', excerpt = '消息原文' } = {}) {
  return { type: sourceType(ref), ref, at, read_scope: 'body', excerpt }
}

function event(overrides = {}) {
  return {
    id: 'evt_demo_quote',
    kind: 'message',
    title: '报价单发给张伟',
    state: 'open',
    sources: [source('feishu_msg:chat/oc_demo/msg_2114')],
    ...overrides,
  }
}

const refsOf = (one) => one.sources.map((entry) => entry.ref)

function runWorker(config) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, JSON.stringify(config)], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`store-worker exited ${code}\n${stderr}`))
    })
  })
}

test('two pieces of evidence for one thing stay one event', async () => {
  const dir = await temporary('one')
  const store = createEventStore({ dir })

  const result = await store.upsertEvent(
    event({
      sources: [source('feishu_msg:chat/oc_demo/msg_2114'), source('feishu_msg:chat/oc_demo/msg_2116', { at: '2026-10-29T13:16:00.000Z' })],
    }),
  )

  assert.equal(result.created, true)
  assert.equal(result.merged, false)

  const events = await store.listEvents()
  assert.equal(events.length, 1, 'two sources for one thing are still one event, not two cards')
  assert.deepEqual(refsOf(events[0]), ['feishu_msg:chat/oc_demo/msg_2114', 'feishu_msg:chat/oc_demo/msg_2116'])
  assert.equal(await store.getEvent('evt_nope'), null)
})

test('the next event sharing a source ref is merged into the first, not added', async () => {
  const dir = await temporary('shared-ref')
  const store = createEventStore({ dir })

  await store.upsertEvent(event({ id: 'evt_first', sources: [source('feishu_msg:chat/oc/msg_1')] }))
  const merged = await store.upsertEvent(
    event({
      id: 'evt_second',
      title: '同一条事的第二段',
      sources: [source('feishu_msg:chat/oc/msg_1'), source('feishu_msg:chat/oc/msg_2')],
    }),
  )

  assert.equal(merged.created, false)
  assert.equal(merged.merged, true)
  assert.equal(merged.event.id, 'evt_first', 'merging keeps the first record and its scalars')
  let events = await store.listEvents()
  assert.equal(events.length, 1)
  assert.deepEqual(refsOf(events[0]), ['feishu_msg:chat/oc/msg_1', 'feishu_msg:chat/oc/msg_2'])

  // An unrelated second event, then one that would have to merge into both at once: no side
  // is the right one to pick, so the store refuses and writes nothing at all.
  await store.upsertEvent(event({ id: 'evt_other', sources: [source('feishu_msg:chat/oc/msg_9')] }))
  const before = await readFile(join(dir, 'events.json'), 'utf8')
  await assert.rejects(
    store.upsertEvent(
      event({
        id: 'evt_joined',
        sources: [source('feishu_msg:chat/oc/msg_1'), source('feishu_msg:chat/oc/msg_9')],
      }),
    ),
    (error) => error instanceof EventStoreError && error.code === 'E_AMBIGUOUS_MERGE',
  )
  assert.equal(await readFile(join(dir, 'events.json'), 'utf8'), before)
  events = await store.listEvents()
  assert.equal(events.length, 2)
})

test('an event with the same id replaces its record and keeps the evidence union', async () => {
  const dir = await temporary('same-id')
  const store = createEventStore({ dir })

  await store.upsertEvent(event({ id: 'evt_same', title: '原标题', sources: [source('feishu_msg:chat/oc/msg_1')] }))
  const result = await store.upsertEvent(
    event({ id: 'evt_same', title: '后来的标题', sources: [source('feishu_msg:chat/oc/msg_2')] }),
  )

  assert.equal(result.merged, true)
  const events = await store.listEvents()
  assert.equal(events.length, 1)
  assert.equal(events[0].id, 'evt_same')
  assert.equal(events[0].title, '原标题', 'the kept version keeps its scalars')
  assert.deepEqual(refsOf(events[0]), ['feishu_msg:chat/oc/msg_1', 'feishu_msg:chat/oc/msg_2'])
})

test('two events with unrelated sources stay two, in insertion order', async () => {
  const dir = await temporary('two')
  const store = createEventStore({ dir })

  await store.upsertEvent(event({ id: 'evt_later', title: '先写的那件', sources: [source('feishu_msg:chat/oc/msg_2')] }))
  await store.upsertEvent(event({ id: 'evt_earlier', title: '后写的那件', sources: [source('feishu_msg:chat/oc/msg_1')] }))

  const events = await store.listEvents()
  assert.deepEqual(
    events.map((entry) => entry.title),
    ['先写的那件', '后写的那件'],
    'same titles never merge; order is insertion order, not sorted',
  )
})

test('every stored due_at in events.json is canonical UTC', async () => {
  const dir = await temporary('utc')
  const store = createEventStore({ dir })

  await store.upsertEvent(
    event({
      id: 'evt_due',
      due_at: '2026-10-30T10:00:00+08:00',
      due_kind: 'hard',
      sources: [source('feishu_msg:chat/oc_demo/msg_2114', { at: '2026-10-29T21:14:00+08:00' })],
    }),
  )
  await store.upsertEvent(
    event({
      id: 'evt_closed',
      title: '已回复的那件',
      state: 'closed',
      sources: [source('gmail:thread/demo-contract', { at: '2026-10-28T14:30:00+08:00' })],
      closure: { evidence_ref: 'gmail:thread/demo-contract', at: '2026-10-30T09:00:00+08:00', by: '我' },
    }),
  )

  const raw = await readFile(join(dir, 'events.json'), 'utf8')
  assert.equal(raw.includes('+08:00'), false, 'no offset survives the write')
  const state = JSON.parse(raw)
  for (const one of state.events) {
    if (one.due_at !== null && one.due_at !== undefined) assert.match(one.due_at, CANONICAL_UTC)
    for (const entry of one.sources) assert.match(entry.at, CANONICAL_UTC)
    if (one.closure) assert.match(one.closure.at, CANONICAL_UTC)
  }
  assert.equal(state.events[0].due_at, '2026-10-30T02:00:00.000Z')
  assert.equal(state.events[0].sources[0].at, '2026-10-29T13:14:00.000Z')
  assert.equal(state.events[1].closure.at, '2026-10-30T01:00:00.000Z')
})

test('a corrupt events.json is reported instead of silently emptied', async () => {
  const dir = await temporary('corrupt')
  const file = join(dir, 'events.json')
  const store = createEventStore({ dir })

  const torn = '{"revision": 1, "events": ['
  await writeFile(file, torn)
  await assert.rejects(
    store.loadEvents(),
    (error) => error instanceof EventStoreError && error.code === 'E_CORRUPT_EVENTS',
  )
  await assert.rejects(
    store.listEvents(),
    (error) => error instanceof EventStoreError && error.code === 'E_CORRUPT_EVENTS',
  )
  // A write must not paper over the damage by replacing it with an empty list.
  await assert.rejects(
    store.upsertEvent(event()),
    (error) => error instanceof EventStoreError && error.code === 'E_CORRUPT_EVENTS',
  )
  assert.equal(await readFile(file, 'utf8'), torn)

  // Parseable JSON whose event no longer satisfies the invariants is damage too.
  await writeFile(file, `${JSON.stringify({ revision: 1, events: [{ id: 'evt_bad' }] }, null, 2)}\n`)
  await assert.rejects(
    store.loadEvents(),
    (error) => error instanceof EventStoreError && error.code === 'E_CORRUPT_EVENTS',
  )
})

test('the record file carries a revision that moves with every write', async () => {
  const dir = await temporary('revision')
  const file = join(dir, 'events.json')
  const store = createEventStore({ dir })

  assert.deepEqual(await store.loadEvents(), { revision: 0, events: [] })

  await store.upsertEvent(event({ id: 'evt_one', sources: [source('feishu_msg:chat/oc/msg_1')] }))
  assert.equal((await store.loadEvents()).revision, 1)

  await store.upsertEvent(event({ id: 'evt_two', sources: [source('feishu_msg:chat/oc/msg_2')] }))
  const state = await store.loadEvents()
  assert.equal(state.revision, 2)

  // Two-space JSON with a trailing newline, same style as the host store.
  const raw = await readFile(file, 'utf8')
  assert.ok(raw.endsWith('\n'))
  assert.equal(raw, `${JSON.stringify(state, null, 2)}\n`)
})

test('two processes upserting one event meet in one record, not two', async () => {
  const dir = await temporary('process')
  const store = createEventStore({ dir })
  const startAt = Date.now() + 250

  const eventsFor = (prefix, count) =>
    Array.from({ length: count }, (_, index) =>
      event({ id: 'evt_race', title: '同一件事', sources: [source(`feishu_msg:chat/oc_race/${prefix}_${index}`)] }),
    )
  const configFor = (prefix) => ({ dir, startAt, events: eventsFor(prefix, 5) })

  const outputs = await Promise.all([runWorker(configFor('a')), runWorker(configFor('b'))])
  const totals = outputs.map((line) => JSON.parse(line.trim()))
  assert.equal(totals.reduce((sum, one) => sum + one.created, 0), 1, 'exactly one process creates the record')
  assert.equal(totals.reduce((sum, one) => sum + one.merged, 0), 9, 'the other nine writes are merges')

  const state = await store.loadEvents()
  assert.equal(state.events.length, 1, 'two processes still make one record')
  assert.equal(state.events[0].sources.length, 10, 'no source was lost to a stale read')
  assert.equal(state.events[0].sources.length, new Set(refsOf(state.events[0])).size, 'no duplicate source refs')
  assert.equal(state.revision, 10, 'ten writes, ten revisions: no gap and no repeated number')

  assert.equal(await readTextOrNull(join(dir, 'store.lock')), null)
  assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith('.tmp')), [])
})
