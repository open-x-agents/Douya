// One card per thing: digests update the existing card in place; only new things create cards.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore, normalizeState } from '../src/host/store.js'
import { reconcileCards, stableKey, duplicateCount, dedupe } from '../src/host/reconcile.js'

const L = (...urls) => [{ type: 'link-list', links: urls.map(url => ({ url, title: url.slice(-6) })) }]
const gh = (repo, day, n = [1, 2], extra = {}) => ({ id: `cluster_github_${repo.replace('/', '_')}_${day}`, type: 'project-cluster', source: 'github', sourceId: `github:cluster:${repo}:${day}`, title: `${repo} work`, blocks: L(...n.map(i => `https://github.com/${repo}/pull/${i}`)), ...extra })
const digest = (day, more = []) => [
  { id: `card_hero_${day}`, type: 'hero', source: 'system', sourceId: `hero:${day}`, title: day, blocks: [] },
  { id: `card_timetable_${day}`, type: 'timetable', source: 'system', sourceId: `timetable:${day}`, title: '我的一天', blocks: [] },
  gh('o/a', day), gh('o/b', day, [5]),
  { id: `email_group_promo_${day}`, type: 'email-group', source: 'gmail', sourceId: `gmail:group:promo:${day}`, title: '促销与订阅', metadata: { group: 'promo' }, blocks: L('https://mail.google.com/mail/u/0/#inbox/p1', 'https://mail.google.com/mail/u/0/#inbox/p2') },
  ...more,
]
const active = cards => cards.filter(c => c.status === 'active' || !c.status)

test('stable keys ignore the day; singletons for the day header and timeline', () => {
  assert.equal(stableKey(gh('o/a', '2026-11-03')), 'github:cluster:o/a')
  assert.equal(stableKey({ type: 'hero', sourceId: 'hero:2026-11-04' }), 'hero')
  assert.equal(stableKey({ type: 'timetable', sourceId: 'timetable:2026-11-03' }), 'timetable')
  assert.equal(stableKey({ type: 'email-group', sourceId: 'gmail:group:code:2026-11-04' }), 'gmail:group:code')
  assert.equal(stableKey({ type: 'task', title: 'x' }), null)
})

test('two consecutive digests over the same data: zero new cards, zero duplicates; next day updates the same ids', async () => {
  const store = createStore(join(mkdtempSync(join(tmpdir(), 'odm-rc-')), 'state.json'))
  await store.save({ cards: digest('2026-11-04') }, { digest: true })
  const first = active(store.get().cards).map(c => c.id).sort()
  assert.equal(store.get().lastReconcile.created, 5)
  await store.save({ cards: digest('2026-11-04') }, { digest: true })
  assert.equal(store.get().lastReconcile.created, 0); assert.equal(store.get().lastReconcile.updated, 5)
  assert.equal(duplicateCount(store.get().cards), 0)
  // the next day: same ids, nothing folded, nothing new
  await store.save({ cards: digest('2026-11-05') }, { digest: true })
  assert.equal(store.get().lastReconcile.created, 0)
  assert.deepEqual(active(store.get().cards).map(c => c.id).sort(), first)
  assert.equal(store.get().cards.length, 5, 'no per-day copies at all')
  assert.equal(store.get().cards.find(c => c.type === 'hero').title, '2026-11-05', 'content refreshed in place')
})

test('new data creates exactly one new card; new items join the existing card', async () => {
  const store = createStore(join(mkdtempSync(join(tmpdir(), 'odm-rc2-')), 'state.json'))
  await store.save({ cards: digest('2026-11-04') }, { digest: true })
  const n = store.get().cards.length
  await store.save({ cards: digest('2026-11-04', [gh('o/new', '2026-11-04', [9])]).map(c => c.sourceId?.startsWith('github:cluster:o/a') ? gh('o/a', '2026-11-04', [1, 2, 3]) : c) }, { digest: true })
  assert.equal(store.get().lastReconcile.created, 1)
  assert.equal(store.get().cards.length, n + 1)
  const a = store.get().cards.find(c => stableKey(c) === 'github:cluster:o/a')
  assert.equal(a.blocks[0].links.length, 3)
  assert.equal(duplicateCount(store.get().cards), 0)
})

test('a done card stays done on the same data; reopens with only the new items pending, completion kept', async () => {
  const store = createStore(join(mkdtempSync(join(tmpdir(), 'odm-rc3-')), 'state.json'))
  await store.save({ cards: digest('2026-11-04') }, { digest: true })
  const s = store.get(); const a = s.cards.find(c => stableKey(c) === 'github:cluster:o/a')
  await store.save({ ...s, cards: s.cards.map(c => c.id === a.id ? { ...c, status: 'done', completedAt: 'T1' } : c), completions: [{ cardId: a.id, action: 'done' }] }, { replaceCards: true })
  await store.save({ cards: digest('2026-11-05') }, { digest: true })
  assert.equal(store.get().cards.find(c => c.id === a.id).status, 'done'); assert.equal(store.get().lastReconcile.keptDone, 1)
  await store.save({ cards: digest('2026-11-05').map(c => stableKey(c) === 'github:cluster:o/a' ? gh('o/a', '2026-11-05', [1, 2, 7]) : c) }, { digest: true })
  const re = store.get().cards.find(c => c.id === a.id)
  assert.equal(re.status, 'active'); assert.equal(re.previousStatus, 'done'); assert.equal(re.completedAt, 'T1')
  const st = store.get().itemStatus
  assert.equal(st['https://github.com/o/a/pull/1'].status, 'done'); assert.equal(st['https://github.com/o/a/pull/2'].status, 'done')
  assert.equal(st['https://github.com/o/a/pull/7'], undefined, 'only the new item is pending')
  assert.equal(store.get().completions.length, 1)
})

test('cleanup on load: duplicates across days and id schemes fold into one card; chats, pins and links united', () => {
  const raw = { cards: [
    gh('o/a', '2026-11-03', [1], { status: 'active', updatedAt: '2026-11-03T01:00:00Z' }),
    gh('o/a', '2026-11-04', [2], { status: 'active', updatedAt: '2026-11-04T01:00:00Z', id: 'a4' }),
    { id: 'h3', type: 'hero', sourceId: 'hero:2026-11-03', status: 'active' }, { id: 'h4', type: 'hero', sourceId: 'hero:2026-11-04', status: 'active' },
    { id: 't1', type: 'task', title: '对话改卡验收-临时', status: 'active' }, { id: 't2', type: 'task', title: '对话改卡验收-临时', status: 'active' },
    { id: 'd1', type: 'project-cluster', source: 'github', sourceId: 'github:cluster:o/a:2026-11-01', status: 'done', blocks: L('https://github.com/o/a/pull/0') },
  ], cardChats: { 'github:cluster:o/a:2026-11-03': [{ role: 'user', text: 'hi', at: '1' }] } }
  const st = normalizeState(raw)
  const live = active(st.cards)
  assert.equal(live.filter(c => stableKey(c) === 'github:cluster:o/a').length, 1)
  assert.equal(live.filter(c => c.type === 'hero').length, 1)
  assert.equal(live.filter(c => c.type === 'task').length, 1)
  assert.equal(duplicateCount(st.cards), 0)
  const canon = live.find(c => stableKey(c) === 'github:cluster:o/a')
  assert.ok(canon.blocks[0].links.some(l => l.url.endsWith('/1')) && canon.blocks[0].links.some(l => l.url.endsWith('/2')))
  assert.equal(st.cards.find(c => c.id === 'd1').status, 'done', 'done copy keeps its status and record')
  assert.equal(st.cards.length, raw.cards.length, 'nothing deleted')
  assert.ok(Object.values(st.cardChats).flat().some(m => m.text === 'hi'), 'chat history kept')
})

test('bot digest: a "new" candidate that matches an existing key becomes an update; update:<id> hint wins over a renamed key; stale noise archived', () => {
  const existing = [gh('o/a', '2026-11-04', [1, 2], { status: 'active' }), gh('o/noise', '2026-11-04', [4], { status: 'active' }), gh('o/quiet', '2026-11-04', [6], { status: 'active' }),
    { id: 'old-legacy', type: 'slack-cluster', source: 'slack', sourceId: 'slack:cluster:C9:2026-11-03', title: '#dev', status: 'active', blocks: L('https://x.slack.com/archives/C9/p1') }]
  const incoming = [
    { ...gh('o/a', '2026-11-05', [1, 2]), id: 'fresh-id', metadata: { target: 'new' } },
    { id: 'z', type: 'slack-cluster', source: 'slack', sourceId: 'slack:cluster:C9-thread:2026-11-05', title: '#dev 讨论', metadata: { target: 'update:old-legacy' }, blocks: L('https://x.slack.com/archives/C9/p2') },
  ]
  const seen = new Map([['github:cluster:o/a', new Set(['https://github.com/o/a/pull/1'])], ['github:cluster:o/noise', new Set(['https://github.com/o/noise/pull/4'])], ['github:cluster:o/quiet', new Set(['https://github.com/o/quiet/pull/6', 'https://github.com/o/quiet/pull/8'])]])
  const r = reconcileCards(existing, incoming, { seen, channels: new Set(['github', 'slack']) })
  assert.equal(r.stats.created, 0); assert.equal(r.stats.newBecameUpdate, 1); assert.equal(r.stats.hintUsed, 1)
  assert.equal(r.cards.find(c => c.id === 'cluster_github_o_a_2026-11-04').sourceId, 'github:cluster:o/a')
  assert.equal(r.cards.find(c => c.id === 'cluster_github_o_noise_2026-11-04').status, 'archived', 'skipped by the bot, nothing new')
  assert.equal(r.cards.find(c => c.id === 'cluster_github_o_quiet_2026-11-04').status, 'active', 'has a new item: kept')
  assert.equal(r.cards.find(c => c.id === 'old-legacy').blocks[0].links.length, 2)
  assert.equal(duplicateCount(r.cards), 0)
})

test('an unknown builder status (old needs-review) never hides a card from 今天', () => {
  const r = reconcileCards([gh('o/a', '2026-11-04', [1], { status: 'needs-review' })], [{ ...gh('o/a', '2026-11-05', [1, 2]), status: 'needs-review' }])
  assert.equal(r.cards.length, 1); assert.equal(r.cards[0].status, 'active')
})

test('dated chat keys load under the stable key', () => {
  const st = normalizeState({ cards: [], cardChats: { 'slack:cluster:C1:2026-11-03': [{ role: 'user', text: 'a', at: '1' }], 'slack:cluster:C1': [{ role: 'user', text: 'b', at: '2' }] } })
  assert.deepEqual(st.cardChats['slack:cluster:C1'].map(m => m.text), ['a', 'b'])
})
