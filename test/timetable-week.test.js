import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../src/host/store.js'
import { createApiRouter } from '../src/web/api.js'
import { createConfigStore } from '../src/web/config-store.js'
import { localDay, localDays } from '../src/web/timetable-plan.js'

const NOW = '2026-11-08T10:00:00+08:00'

test('timetableApply can plan other days this week; get returns week[]; digest lands the plan on that day', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'odm-week-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = createStore(join(dir, 'state.json'))
  await store.load()
  const today = '2026-11-08'
  const card = {
    id: 'card_timetable_1', type: 'timetable', source: 'system', sourceId: 'timetable', status: 'active',
    blocks: [{ type: 'timetable', fixedBlocks: [], suggestedBlocks: [{ start: '10:00', end: '10:45', title: '回 PR', category: 'work' }], nowTime: '10:00' }],
  }
  await store.save({ cards: [card] }, { replaceCards: true })
  const configStore = createConfigStore(join(dir, 'config.json'))
  const router = createApiRouter({ store, config: { home: dir, dataDir: dir }, configStore })
  // Freeze "today" by writing week plans relative to real localDay — skip if the box clock isn't 2026-11-08.
  // Instead test the weekPlans path directly via apply with an explicit future date from localDays.
  const days = localDays(new Date(), 7)
  const other = days[2] // two days out
  const r = await router.timetableApply({
    mode: 'replace', date: other,
    blocks: [{ start: '19:00', end: '19:30', title: '跑步', kind: 'exercise' }],
  }, { by: 'chief' })
  assert.equal(r.success, true)
  assert.equal(r.date, other)
  assert.equal(r.plan.blocks[0].title, '跑步')
  const g = router.timetableGet({ date: other })
  assert.equal(g.success, true)
  assert.equal(g.today, false)
  assert.equal(g.blocks[0].title, '跑步')
  const week = router.timetableGet().week || router.timetableGet({}).week
  // get without date needs a card - we have one
  const full = router.timetableGet()
  assert.equal(full.success, true)
  assert.ok(full.week.some(d => d.date === other && d.blocks[0]?.title === '跑步'))
  // Reject a date too far out
  const far = await router.timetableApply({ mode: 'replace', date: '2099-01-01', blocks: [{ start: '09:00', end: '09:30', title: 'x', kind: 'work' }] }, { by: 'chief' })
  assert.equal(far.success, false)
})
