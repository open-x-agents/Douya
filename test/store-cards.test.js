import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore, mergeCards, recordCompletion, TERMINAL_CARD_STATUSES } from '../src/host/store.js'

test('mergeCards keeps done cards when digest brings same sourceId', () => {
  const existing = [
    { id: 'c1', sourceId: 'gh:1', title: 'Old', status: 'done', completedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'c2', sourceId: 'gh:2', title: 'Active', status: 'active', createdAt: '2026-01-01T00:00:00.000Z' },
  ]
  const incoming = [
    { sourceId: 'gh:1', title: 'New from digest', status: 'active' },
    { sourceId: 'gh:2', title: 'Active updated', status: 'active' },
    { sourceId: 'gh:3', title: 'Brand new', status: 'active' },
  ]
  const merged = mergeCards(existing, incoming, { digest: true })
  const bySrc = Object.fromEntries(merged.map(c => [c.sourceId, c]))
  assert.equal(bySrc['gh:1'].status, 'done')
  assert.equal(bySrc['gh:1'].title, 'Old')
  assert.equal(bySrc['gh:2'].title, 'Active updated')
  assert.ok(bySrc['gh:3'])
  assert.ok(TERMINAL_CARD_STATUSES.has('done'))
})

test('recordCompletion appends durable ledger entries', () => {
  const card = { id: 'c1', title: 'Task', source: 'manual', url: 'https://example.com' }
  const list = recordCompletion([], card, { action: 'done', by: 'bot' })
  assert.equal(list.length, 1)
  assert.equal(list[0].cardId, 'c1')
  assert.equal(list[0].by, 'bot')
  assert.equal(list[0].action, 'done')
})

test('store save digest option preserves completions and done cards', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'odm-store-'))
  const path = join(dir, 'state.json')
  const store = createStore(path)
  await store.load()
  await store.save({
    cards: [{ id: 'c1', sourceId: 's1', title: 'T', status: 'active', createdAt: '2026-01-01T00:00:00.000Z' }],
  })
  let state = store.get()
  const card = state.cards[0]
  card.status = 'done'
  card.completedAt = '2026-01-02T00:00:00.000Z'
  card.completedBy = 'user'
  state.completions = recordCompletion(state.completions, card, { action: 'done', by: 'user' })
  await store.save(state)

  await store.save({
    cards: [{ sourceId: 's1', title: 'Digest revive', status: 'active' }],
  }, { digest: true })

  state = store.get()
  assert.equal(state.cards.find(c => c.sourceId === 's1').status, 'done')
  assert.equal(state.completions.length, 1)
  const disk = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(disk.completions.length, 1)
})

import { setItemStatus, clearItemStatus, annotateCards } from '../src/host/store.js'

test('item status persists by url across a re-aggregated card and undo clears it', () => {
  const url = 'https://github.com/o/r/issues/1'
  const day1 = { id: 'c1', sourceId: 'gh:o/r:2026-11-03', title: 'r', blocks: [{ type: 'link-list', links: [{ url, title: 'issue 1' }, { url: 'https://x/2', title: 'two' }] }] }
  const state = { cards: [day1], completions: [], itemStatus: {} }
  setItemStatus(state, { card: day1, url, title: 'issue 1', action: 'done' })
  assert.equal(state.completions.length, 1)
  assert.equal(state.completions[0].kind, 'item')
  // next day's digest: new id + sourceId, same link
  const day2 = { ...day1, id: 'c2', sourceId: 'gh:o/r:2026-11-04' }
  const [a] = annotateCards([day2], state.itemStatus)
  assert.equal(a.itemStatus[url].status, 'done')
  assert.equal(a.itemStatus['https://x/2'], undefined)
  clearItemStatus(state, url)
  assert.equal(state.completions.length, 0)
  assert.equal(annotateCards([day2], state.itemStatus)[0].itemStatus, undefined)
})
