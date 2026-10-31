import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createStore, emptyState, normalizeState } from '../src/host/store.js'

const fresh = async () => join(await mkdtemp(join(tmpdir(), 'odm-store-')), 'state.json')

test('a saved state comes back the same, with a revision that moved', async () => {
  const path = await fresh()
  const store = createStore(path)
  await store.load()
  await store.save({ ...emptyState(), members: { m1: { id: 'm1', name: '小王' } } })
  const again = createStore(path)
  const loaded = await again.load()
  assert.equal(loaded.members.m1.name, '小王')
  assert.equal(loaded.revision, 1)
  const text = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(text.revision, 1)
})

test('a file that is not there, or is garbage, starts empty instead of throwing', async () => {
  const missing = createStore(await fresh())
  assert.deepEqual(await missing.load(), emptyState())

  const path = await fresh()
  await writeFile(path, 'not json at all', 'utf8')
  const broken = createStore(path)
  assert.deepEqual(await broken.load(), emptyState())
})

test('a file written by an older version gains the keys this one reads', () => {
  const old = normalizeState({ revision: 3, members: { m1: { id: 'm1', name: '小王' } } })
  assert.equal(old.revision, 3)
  assert.deepEqual(old.reports, {})
  assert.deepEqual(old.sent, {})
  assert.deepEqual(old.manual, [])
  assert.deepEqual(old.deliveries, [])
  assert.deepEqual(old.upcoming, [])
  assert.deepEqual(old.days, {})
  assert.deepEqual(old.sources, {})
})

test('normalizeState keeps days and sources', () => {
  const days = { '2026-10-30': { conclusion: '一句话', items: [] } }
  const sources = { calendar: { connected: false, last_read_at: null, detail: '没有接入' } }
  const normalized = normalizeState({ revision: 1, days, sources })
  assert.deepEqual(normalized.days, days)
  assert.deepEqual(normalized.sources, sources)
  // A corrupt or absent key becomes an empty record, never an array or a string.
  assert.deepEqual(normalizeState({ days: null, sources: 'no' }).days, {})
  assert.deepEqual(normalizeState({ days: [], sources: 7 }).sources, {})
})

test('a write replaces the file rather than appending to it', async () => {
  const path = await fresh()
  const store = createStore(path)
  await store.load()
  await store.save({ ...emptyState(), members: { m1: { id: 'm1', name: '小王' } } })
  await store.save({ ...store.get(), members: {} })
  const loaded = await createStore(path).load()
  assert.deepEqual(loaded.members, {})
  assert.equal(loaded.revision, 2)
})
