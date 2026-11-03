import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  defaultZone,
  localParts,
  nextWakeAt,
  pendingPushes,
  pushKey,
  runWithBudget,
  slotDueAt,
  slotsForDay,
  todayIn,
  tomorrowIn,
  zonedTimeToUtc,
} from '../src/host/schedule.js'
import { REPORT_SLOTS } from '../src/host/constants.js'

const morning = REPORT_SLOTS.find(slot => slot.id === 'morning')
const evening = REPORT_SLOTS.find(slot => slot.id === 'evening')

test('the two report slots are 08:45 and 18:30 local time', () => {
  assert.deepEqual(REPORT_SLOTS.map(slot => [slot.id, slot.hour, slot.minute]), [['morning', 8, 45], ['evening', 18, 30]])
})

// The same wall clock is two different instants east and west of UTC. Both are asserted by name,
// because a format change that quietly drops the zone would still print 08:45.
test('the morning report is 00:45Z in Asia/Shanghai and 08:45Z in UTC', () => {
  assert.equal(slotDueAt(morning, '2026-10-30', 'Asia/Shanghai'), '2026-10-30T00:45:00.000Z')
  assert.equal(slotDueAt(morning, '2026-10-30', 'UTC'), '2026-10-30T08:45:00.000Z')
})

test('the evening report is 10:30Z in Asia/Shanghai and 18:30Z in UTC', () => {
  assert.equal(slotDueAt(evening, '2026-10-30', 'Asia/Shanghai'), '2026-10-30T10:30:00.000Z')
  assert.equal(slotDueAt(evening, '2026-10-30', 'UTC'), '2026-10-30T18:30:00.000Z')
})

test('the default zone follows TZ, so the same slot moves between the two runs', () => {
  const zone = defaultZone()
  const due = slotDueAt(morning, '2026-10-30', zone)
  if (zone === 'Asia/Shanghai') assert.equal(due, '2026-10-30T00:45:00.000Z')
  else assert.equal(due, '2026-10-30T08:45:00.000Z')
})

test('an empty TZ falls back to UTC', () => {
  assert.equal(defaultZone({ env: {} }), 'UTC')
  assert.equal(defaultZone({ env: { TZ: '  ' } }), 'UTC')
  assert.equal(defaultZone({ env: { TZ: 'Asia/Shanghai' } }), 'Asia/Shanghai')
})

test('a wall clock time becomes the instant the member means', () => {
  assert.equal(zonedTimeToUtc('2026-10-30', 9, 30, 'Asia/Shanghai'), Date.parse('2026-10-30T01:30:00Z'))
  assert.equal(zonedTimeToUtc('2026-10-30', 9, 30, 'UTC'), Date.parse('2026-10-30T09:30:00Z'))
  assert.deepEqual(localParts(Date.parse('2026-10-30T01:30:00Z'), 'Asia/Shanghai'), { date: '2026-10-30', hour: 9, minute: 30 })
})

test('the local day is the instant local to the zone, and rolls over at local midnight', () => {
  const beforeMidnight = Date.parse('2026-10-30T15:30:00Z')
  assert.equal(todayIn('Asia/Shanghai', beforeMidnight), '2026-10-30')
  assert.equal(todayIn('UTC', beforeMidnight), '2026-10-30')
  const afterMidnight = Date.parse('2026-10-30T16:30:00Z')
  assert.equal(todayIn('Asia/Shanghai', afterMidnight), '2026-10-31')
  assert.equal(todayIn('UTC', afterMidnight), '2026-10-30')
  assert.equal(tomorrowIn('UTC', beforeMidnight), '2026-10-31')
})

test('a day carries two slots, a degraded day only the morning one', () => {
  assert.deepEqual(slotsForDay('2026-10-30', 'UTC').map(slot => slot.id), ['morning', 'evening'])
  assert.deepEqual(slotsForDay('2026-10-30', 'UTC', { degraded: true }).map(slot => slot.id), ['morning'])
})

test('a report one minute early waits for its slot instead of firing early', () => {
  const now = Date.parse('2026-10-30T08:44:00Z')
  const pending = pendingPushes({ now, timeZone: 'UTC', pushes: {} })
  assert.deepEqual(pending.map(item => [item.id, item.state]), [['morning', 'not-yet'], ['evening', 'not-yet']])
})

test('a slot that is due is due once, and a slot already recorded is not offered again', () => {
  const now = Date.parse('2026-10-30T08:45:10Z')
  const pending = pendingPushes({ now, timeZone: 'UTC', pushes: {} })
  assert.deepEqual(pending.map(item => [item.id, item.state]), [['morning', 'due'], ['evening', 'not-yet']])
  const recorded = pendingPushes({ now, timeZone: 'UTC', pushes: { [pushKey('2026-10-30', 'morning')]: { status: 'sent' } } })
  assert.deepEqual(recorded.map(item => item.id), ['evening'])
})

test('a slot missed by more than an hour is missed for good, not late', () => {
  const now = Date.parse('2026-10-30T09:46:00Z')
  const pending = pendingPushes({ now, timeZone: 'UTC', pushes: {} })
  assert.deepEqual(pending.map(item => [item.id, item.state]), [['morning', 'missed'], ['evening', 'not-yet']])
})

test('the next wake is the reminder, and an overdue one fires at once', () => {
  const plan = [{ id: 'e1', fireAt: '2026-10-30T09:12:00.000Z' }]
  const early = nextWakeAt({ now: Date.parse('2026-10-30T09:00:00Z'), plan })
  assert.equal(early.delayMs, 720_000)
  assert.equal(early.why, 'reminder')
  assert.equal(early.id, 'e1')
  const overdue = nextWakeAt({ now: Date.parse('2026-10-30T09:13:00Z'), plan })
  assert.equal(overdue.delayMs, 0)
  const delivered = nextWakeAt({ now: Date.parse('2026-10-30T09:00:00Z'), plan, sent: ['e1@2026-10-30T09:12:00.000Z'] })
  assert.equal(delivered.why, 'idle')
  assert.equal(delivered.delayMs, null)
})

test('runWithBudget retries a failing source and keeps one failure per attempt', async () => {
  let calls = 0
  const result = await runWithBudget(async () => {
    calls += 1
    throw new Error('calendar down')
  }, { attempts: 3, source: 'calendar' })
  assert.equal(calls, 3)
  assert.equal(result.ok, false)
  assert.deepEqual(result.failures.map(failure => [failure.source, failure.reason, failure.attempt]), [
    ['calendar', 'error', 1],
    ['calendar', 'error', 2],
    ['calendar', 'error', 3],
  ])
})

test('runWithBudget returns the first good value and stops trying', async () => {
  let calls = 0
  const result = await runWithBudget(async () => {
    calls += 1
    return [{ id: 'e1' }]
  }, { attempts: 3, source: 'calendar' })
  assert.equal(calls, 1)
  assert.equal(result.ok, true)
  assert.deepEqual(result.value, [{ id: 'e1' }])
  assert.deepEqual(result.failures, [])
})

test('runWithBudget records a timeout as a timeout and leaves the caller alive', async () => {
  const timers = []
  const schedule = timer => {
    timers.push(timer)
    return { unref() {} }
  }
  const pending = runWithBudget(() => new Promise(() => {}), {
    attempts: 1,
    timeoutMs: 8_000,
    schedule,
    cancel: () => {},
    source: 'calendar',
  })
  timers[0]()
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.failures[0].reason, 'timeout')
  assert.equal(result.failures[0].attempt, 1)
})
