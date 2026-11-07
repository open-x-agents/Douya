import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore, emptyState, normalizeState, recordCompletion, DUTY_MAX } from '../src/host/store.js'
import { setDuty, doneDuty, restoreDuty } from '../src/web/duty.js'
import { doneToday } from '../src/web/day-pulse.js'

async function makeRouter(path) {
  const { createApiRouter } = await import('../src/web/api.js')
  const { createConfigStore } = await import('../src/web/config-store.js')
  const home = mkdtempSync(join(tmpdir(), 'odm-duty-'))
  writeFileSync(join(home, 'config.json'), '{}')
  const configStore = createConfigStore(join(home, 'config.json'))
  await configStore.load()
  const store = createStore(path)
  await store.load()
  const router = createApiRouter({ store, config: { home, dataDir: home }, configStore })
  return { router, store }
}

test('duty: one line, clipped at 120, survives a state round-trip', () => {
  const state = emptyState()
  const r = setDuty(state, { text: '  跟进 #111 review  ' })
  assert.equal(r.ok, true)
  assert.deepEqual(Object.keys(state.duty).sort(), ['at', 'by', 'text'])
  assert.equal(state.duty.text, '跟进 #111 review')
  assert.equal(state.duty.by, 'user')
  assert.match(state.duty.at, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/)

  assert.equal(setDuty(state, { text: '   ' }).ok, false)
  assert.equal(state.duty.text, '跟进 #111 review', 'an empty line never clears the pinned one')

  setDuty(state, { text: 'x'.repeat(200) })
  assert.equal(state.duty.text.length, DUTY_MAX)
  assert.equal(DUTY_MAX, 120)
  const clipped = state.duty.text
  const round = normalizeState(JSON.parse(JSON.stringify(state)))
  assert.equal(round.duty.text, clipped)
})

test('duty: only one line — a second set replaces the first', () => {
  const state = emptyState()
  setDuty(state, { text: 'first line' })
  setDuty(state, { text: 'second line' })
  assert.equal(Array.isArray(state.duty), false)
  assert.equal(state.duty.text, 'second line')
  assert.equal(Object.keys(state).filter(k => k.startsWith('duty')).length, 1)
})

test('duty: done clears the line and lands exactly once in 今天搞定了什么', () => {
  const state = emptyState()
  const text = '跟进 #111 review'
  setDuty(state, { text })
  const r = doneDuty(state, { by: 'user' })
  assert.equal(r.ok, true)
  assert.equal(state.duty, null)
  assert.equal(state.completions.filter(c => c.cardId === 'duty').length, 1)
  const done = doneToday({ completions: state.completions })
  assert.equal(done.count, 1)
  assert.equal(done.highlights[0].text, text)

  assert.equal(doneDuty(state, { by: 'user' }).ok, false, 'nothing left to finish')
  assert.equal(state.completions.filter(c => c.cardId === 'duty').length, 1, 'the ledger keeps one entry')
})

test('duty: restore puts the note back and removes the completion', () => {
  const state = emptyState()
  setDuty(state, { text: '跟进 #111 review' })
  doneDuty(state, { by: 'user' })
  assert.ok(doneToday({ completions: state.completions }))

  const r = restoreDuty(state, { text: '跟进 #111 review' })
  assert.equal(r.ok, true)
  assert.equal(state.duty.text, '跟进 #111 review')
  assert.equal(state.completions.some(c => c.cardId === 'duty'), false)
  assert.equal(doneToday({ completions: state.completions }), null)
})

test('duty: /api/today carries the line and a reload keeps it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'odm-duty-'))
  const path = join(dir, 'state.json')
  const first = await makeRouter(path)
  const set = await first.router.dutyOp({ op: 'set', text: '跟进 #111 review' }, { by: 'user' })
  assert.equal(set.success, true)

  const today = await first.router.getToday()
  assert.equal(today.duty.text, '跟进 #111 review')
  assert.equal(today.duty.by, 'user')
  assert.equal(today.duty.days, 0)

  // Same file, a fresh store + router: a page reload / process restart.
  const again = await makeRouter(path)
  const reloaded = await again.router.getToday()
  assert.equal(reloaded.duty.text, '跟进 #111 review')
})

test('duty: a re-digest leaves the line and the ledger alone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'odm-duty-'))
  const store = createStore(join(dir, 'state.json'))
  await store.load()
  const state = store.get()
  setDuty(state, { text: '跟进 #111 review' })
  state.completions = recordCompletion(state.completions, { id: 'c0', title: 'Another thing' }, { action: 'done' })
  await store.save({ duty: state.duty, completions: state.completions })
  const before = store.get().completions.length
  const card = { id: 'c1', sourceId: 's1', title: 'Digest card', status: 'active', createdAt: new Date().toISOString() }

  await store.save({ ...store.get(), cards: [card] }, { digest: true })
  await store.save({ ...store.get(), cards: [card] }, { digest: true })

  const after = store.get()
  assert.equal(after.duty.text, '跟进 #111 review')
  assert.equal(after.completions.length, before)
})

test('duty: Chief writes as bot and /api/today says so', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'odm-duty-'))
  const { router } = await makeRouter(join(dir, 'state.json'))
  const r = await router.dutyOp({ op: 'set', text: '跟进 #111 review' }, { by: 'bot' })
  assert.equal(r.success, true)
  const today = await router.getToday()
  assert.equal(today.duty.by, 'bot')
  assert.equal(today.duty.text, '跟进 #111 review')
  const bad = await router.dutyOp({ op: 'shout', text: 'nope' }, { by: 'user' })
  assert.equal(bad.success, false)
})
