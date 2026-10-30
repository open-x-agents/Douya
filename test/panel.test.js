import { test } from 'node:test'
import assert from 'node:assert/strict'
import { panelSnapshot, reportKey } from '../src/host/panel.js'

const state = {
  members: {
    m1: { id: 'm1', name: '小王' },
    m2: { id: 'm2', name: '小李' },
    m3: { id: 'm3', name: '已经离职', active: false },
  },
  reports: {
    [reportKey('m1', '2026-10-30')]: { memberId: 'm1', date: '2026-10-30' },
    [reportKey('m2', '2026-10-29')]: { memberId: 'm2', date: '2026-10-29' },
  },
  deliveries: [
    { kind: 'reminder', id: 'a', ok: true },
    { kind: 'reminder', id: 'b', ok: false, error: 'rate limited' },
  ],
}

const plan = [
  { id: 'a', title: '周会', startAt: '2026-10-30T09:00:00Z', fireAt: '2026-10-30T08:50:00Z' },
  { id: 'b', title: '昨天开过的会', startAt: '2026-10-29T09:00:00Z', fireAt: '2026-10-29T08:50:00Z' },
]

test('the snapshot counts today\'s reports and names who is missing', () => {
  const snapshot = panelSnapshot({ state, plan, today: '2026-10-30', now: Date.parse('2026-10-30T08:00:00Z') })
  assert.equal(snapshot.total, 2)
  assert.equal(snapshot.submitted, 1)
  assert.deepEqual(snapshot.missing, ['小李'])
  assert.equal(snapshot.today, '2026-10-30')
  assert.deepEqual(snapshot.members.map(member => member.submitted), [true, false])
})

test('an inactive member is not counted, and nobody is missing when nobody is there', () => {
  const snapshot = panelSnapshot({ state: { members: { m3: { id: 'm3', name: '已经离职', active: false } } }, today: '2026-10-30' })
  assert.equal(snapshot.total, 0)
  assert.deepEqual(snapshot.missing, [])
})

test('only reminders still ahead show up, oldest delivery first', () => {
  const snapshot = panelSnapshot({ state, plan, today: '2026-10-30', now: Date.parse('2026-10-30T08:00:00Z') })
  assert.deepEqual(snapshot.upcoming.map(item => item.id), ['a'])
  assert.deepEqual(snapshot.deliveries.map(item => item.id), ['b', 'a'])
})

test('a missing store still produces a page instead of a crash', () => {
  assert.deepEqual(panelSnapshot({}), { today: undefined, members: [], total: 0, submitted: 0, missing: [], upcoming: [], deliveries: [] })
})

import { PANEL_PAGE_ROUTE, PANEL_ROUTE } from '../src/host/constants.js'

test('PANEL_PAGE_ROUTE and PANEL_ROUTE both live under /api/', () => {
  assert.equal(PANEL_ROUTE.startsWith('/api/'), true)
  assert.equal(PANEL_PAGE_ROUTE.startsWith('/api/'), true)
  assert.equal(PANEL_ROUTE, '/api/opendigitalmate')
  assert.equal(PANEL_PAGE_ROUTE, '/api/opendigitalmate/page')
})

import { installPanel } from '../src/host/panel.js'

test('installPanel registers both routes under /api/ with buffered bodies', () => {
  const registered = []
  const ctx = {
    effect: (fn) => { fn(); return undefined },
    connection: { fetch: { register: (route) => { registered.push(route); return () => {} } } },
  }
  const rt = {
    store: { get: () => ({}) },
    today: () => '2026-10-30',
    now: () => new Date('2026-10-30T08:00:00Z'),
  }
  assert.equal(installPanel(ctx, rt), true)
  assert.deepEqual(registered.map(route => route.path).sort(), ['/api/opendigitalmate', '/api/opendigitalmate/page'].sort())
  for (const route of registered) {
    assert.equal(route.requestBody, 'buffered')
    assert.deepEqual(route.methods, ['GET'])
    assert.equal(route.path.startsWith('/api/'), true)
  }
})
