import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_LEAD_MINUTES, due, planFor, reminderKey, snooze } from '../src/host/reminders.js'

const at = iso => Date.parse(iso)
const now = at('2026-10-30T09:00:00Z')

const events = [
  { id: 'past', summary: '已经开始的会', start: '2026-10-30T08:50:00Z', end: '2026-10-30T09:10:00Z' },
  { id: 'soon', summary: '马上要开', start: '2026-10-30T09:30:00Z', end: '2026-10-30T10:00:00Z', location: 'B2' },
  { id: 'later', summary: '下午的会', start: '2026-10-30T14:00:00Z', end: '2026-10-30T15:00:00Z' },
  { id: 'far', summary: '后天的会', start: '2026-11-05T14:00:00Z', end: '2026-11-05T15:00:00Z' },
  { summary: '没有 id 的日程', start: '2026-10-30T11:00:00Z' },
]

test('a reminder is planned a lead time before the meeting', () => {
  const plan = planFor(events, { now, leadMinutes: DEFAULT_LEAD_MINUTES })
  const soon = plan.find(item => item.id === 'soon')
  assert.equal(soon.fireAt, '2026-10-30T09:20:00.000Z')
  assert.equal(soon.startAt, '2026-10-30T09:30:00.000Z')
  assert.equal(soon.title, '马上要开')
  assert.equal(soon.location, 'B2')
})

test('a meeting already under way, a meeting past the horizon and one without an id are left out', () => {
  const plan = planFor(events, { now, leadMinutes: 10 })
  assert.deepEqual(plan.map(item => item.id), ['soon', 'later'])
  assert.equal(plan.find(item => item.id === 'past'), undefined)
  assert.equal(plan.find(item => item.id === 'far'), undefined)
})

test('a tick that arrives late still warns, because the meeting has not started', () => {
  const late = planFor(events, { now: at('2026-10-30T09:25:00Z'), leadMinutes: 10 })
  const soon = late.find(item => item.id === 'soon')
  assert.ok(soon, 'the 09:30 meeting is still ahead and must still be warned about')
  assert.equal(soon.fireAt, '2026-10-30T09:20:00.000Z', 'the planned moment stays stable so it is sent once')
  assert.deepEqual(due(late, { now: at('2026-10-30T09:25:00Z') }).map(item => item.id), ['soon'])
})

test('the horizon keeps tomorrow out of a today plan', () => {
  const plan = planFor(events, { now, leadMinutes: 10, horizonMinutes: 12 * 60 })
  assert.deepEqual(plan.map(item => item.id), ['soon', 'later'])
})

test('a plan is ordered by when it fires, not by when the meeting starts', () => {
  const plan = planFor([
    { id: 'b', start: '2026-10-30T12:00:00Z', end: '2026-10-30T13:00:00Z' },
    { id: 'a', start: '2026-10-30T11:00:00Z', end: '2026-10-30T11:30:00Z' },
  ], { now, leadMinutes: 10 })
  assert.deepEqual(plan.map(item => item.id), ['a', 'b'])
})

test('due returns what already fired and skips what was delivered', () => {
  const plan = planFor(events, { now, leadMinutes: 10 })
  const later = at('2026-10-30T09:25:00Z')
  const firing = due(plan, { now: later })
  assert.deepEqual(firing.map(item => item.id), ['soon'])
  assert.deepEqual(due(plan, { now: later, sent: [reminderKey(firing[0])] }), [])
})

test('snoozing keeps the event and moves only the moment, so it is a new delivery', () => {
  const plan = planFor(events, { now, leadMinutes: 10 })
  const soon = plan.find(item => item.id === 'soon')
  const pushed = snooze(soon, { now: at('2026-10-30T09:20:00Z'), minutes: 10 })
  assert.equal(pushed.fireAt, '2026-10-30T09:30:00.000Z')
  assert.equal(pushed.snoozed, true)
  assert.notEqual(reminderKey(pushed), reminderKey(soon))
  assert.equal(soon.fireAt, '2026-10-30T09:20:00.000Z')
})

test('the card keeps the wall clock the member was given, not the UTC one', () => {
  const plan = planFor([{ id: 'e', summary: '站会', start: '2026-10-30T09:30:00+08:00', end: '2026-10-30T09:45:00+08:00' }], { now: at('2026-10-30T00:00:00Z'), leadMinutes: 10 })
  assert.equal(plan[0].startAt, '2026-10-30T01:30:00.000Z')
  assert.equal(plan[0].startLocal, '2026-10-30T09:30:00+08:00')
})

test('a finished meeting is not due, even through a snoozed copy', () => {
  const plan = planFor(events, { now, leadMinutes: 10 })
  const soon = plan.find(item => item.id === 'soon')
  const pushed = snooze(soon, { now: at('2026-10-30T09:20:00Z'), minutes: 10 })
  const all = [...plan, pushed]
  // 没有 done 的时候，同一场会以自己的时刻和被推迟的时刻各出现一次 —— 这就是多发的来源。
  assert.deepEqual(due(all, { now: at('2026-10-30T09:40:00Z') }).map(item => item.id), ['soon', 'soon'])
  assert.deepEqual(due(all, { now: at('2026-10-30T09:40:00Z'), done: ['soon'] }), [])
})
