import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultZone, nextWakeAt, runWithBudget } from '../src/host/schedule.js'

const MINUTE = 60_000
const CALENDAR_REFRESH_MS = 300_000
const T0 = Date.parse('2026-10-30T09:00:00Z')

// A plan entry as the runtime stores it: the fireAt is the instant the card must go out.
const reminder = (id, fireAt) => ({ id, title: id, fireAt: new Date(fireAt).toISOString() })
const key = entry => `${entry.id}@${entry.fireAt}`

// A hand-driven timer: nothing fires until the test says so, and every pending deadline is
// readable, so a budget can be measured instead of waited for.
function manualTimers() {
  const queue = []
  let sequence = 0
  const schedule = (fn, ms) => {
    const job = { id: (sequence += 1), fn, ms }
    queue.push(job)
    return job
  }
  const cancel = job => {
    const at = queue.indexOf(job)
    if (at >= 0) queue.splice(at, 1)
  }
  return {
    schedule,
    cancel,
    pending: () => queue.map(job => job.ms),
    size: () => queue.length,
    fire: () => {
      const job = queue.shift()
      if (!job) return false
      job.fn()
      return true
    },
  }
}

const settle = () => new Promise(resolve => setImmediate(resolve))

test('an empty TZ falls back to UTC', () => {
  assert.equal(defaultZone({ env: {} }), 'UTC')
  assert.equal(defaultZone({ env: { TZ: '  ' } }), 'UTC')
  assert.equal(defaultZone({ env: { TZ: '' } }), 'UTC')
  assert.equal(defaultZone({ env: { TZ: 'Asia/Shanghai' } }), 'Asia/Shanghai')
  assert.equal(defaultZone({ env: { TZ: ' Asia/Shanghai ' } }), 'Asia/Shanghai')
})

test('the default zone is whatever TZ says, and UTC when TZ is unset', () => {
  const expected = String(process.env.TZ ?? '').trim() || 'UTC'
  assert.equal(defaultZone(), expected)
})

test('the next wake is the reminder fireAt, not the next minute on the grid', () => {
  const plan = [reminder('e1', '2026-10-30T09:12:00Z'), reminder('e2', '2026-10-30T13:50:00Z')]
  const wake = nextWakeAt({ now: T0, plan, sent: [] })
  assert.deepEqual(wake, { at: Date.parse('2026-10-30T09:12:00Z'), why: 'reminder' })
  assert.equal(wake.at - T0, 12 * MINUTE)
})

test('a pending reminder wins over the refresh floor, so the wake stays on its fireAt', () => {
  const plan = [reminder('e1', '2026-10-30T09:12:00Z')]
  const wake = nextWakeAt({ now: T0, plan, sent: [], calendarAt: T0 + CALENDAR_REFRESH_MS })
  assert.equal(wake.at, Date.parse('2026-10-30T09:12:00Z'))
  assert.equal(wake.why, 'reminder')
})

test('a reminder already due and unsent wakes now', () => {
  const plan = [reminder('e1', '2026-10-30T09:12:00Z')]
  const wake = nextWakeAt({ now: Date.parse('2026-10-30T09:13:00Z'), plan, sent: [] })
  assert.deepEqual(wake, { at: 0, why: 'reminder' })
})

test('a delivered reminder does not arm a wake of its own', () => {
  const plan = [reminder('e1', '2026-10-30T09:12:00Z'), reminder('e2', '2026-10-30T13:50:00Z')]
  const wake = nextWakeAt({ now: Date.parse('2026-10-30T09:13:00Z'), plan, sent: [key(plan[0])] })
  assert.deepEqual(wake, { at: Date.parse('2026-10-30T13:50:00Z'), why: 'reminder' })
})

test('with nothing planned the wake is the calendar refresh floor', () => {
  const calendarAt = T0 + CALENDAR_REFRESH_MS
  assert.deepEqual(nextWakeAt({ now: T0, plan: [], sent: [], calendarAt }), { at: calendarAt, why: 'calendar' })
  assert.deepEqual(nextWakeAt({ now: T0, plan: [], sent: [] }), { at: null, why: 'none' })
})

test('a source that times out three times records one failure per attempt', async () => {
  const timers = manualTimers()
  const pending = runWithBudget(() => new Promise(() => {}), {
    attempts: 3,
    timeoutMs: 8_000,
    schedule: timers.schedule,
    cancel: timers.cancel,
    source: 'calendar',
  })
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await settle()
    assert.deepEqual(timers.pending(), [8_000])
    timers.fire()
  }
  const result = await pending
  assert.equal(result.ok, false)
  assert.deepEqual(result.failures, [
    { source: 'calendar', reason: 'timeout', attempt: 1 },
    { source: 'calendar', reason: 'timeout', attempt: 2 },
    { source: 'calendar', reason: 'timeout', attempt: 3 },
  ])
})

test('a source that throws is retried on the next attempt', async () => {
  const attempts = []
  const result = await runWithBudget(async ({ attempt }) => {
    attempts.push(attempt)
    if (attempt < 3) throw new Error('boom')
    return ['event']
  }, { attempts: 3, source: 'calendar' })
  assert.deepEqual(attempts, [1, 2, 3])
  assert.equal(result.ok, true)
  assert.deepEqual(result.value, ['event'])
  assert.deepEqual(result.failures.map(failure => failure.reason), ['error', 'error'])
})

test('a fast source leaves no pending timeout behind', async () => {
  const timers = manualTimers()
  const result = await runWithBudget(async () => ['event'], {
    attempts: 3,
    timeoutMs: 8_000,
    schedule: timers.schedule,
    cancel: timers.cancel,
    source: 'calendar',
  })
  assert.deepEqual(result, { ok: true, value: ['event'], failures: [] })
  assert.equal(timers.size(), 0)
})
