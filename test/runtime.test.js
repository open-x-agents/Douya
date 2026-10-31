import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRuntime } from '../index.js'

const home = async () => mkdtemp(join(tmpdir(), 'odm-rt-'))

// A hand-driven timer: nothing fires until the test says so, and every pending delay is
// readable, so a wake can be measured instead of waited for.
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
    fire: () => {
      const job = queue.shift()
      if (!job) return false
      job.fn()
      return true
    },
  }
}

// A meeting at 09:22 reminded ten minutes before: fireAt is 09:12, twelve minutes after the
// 09:00 clock these tests start on.
const nineTwentyTwo = [{ id: 'm1', summary: '九点二十二', start: '2026-10-30T09:22:00Z', end: '2026-10-30T09:52:00Z' }]

// A fired wake finishes in its own time (a tick, a store write), so the test waits for the
// effect rather than for a guessed delay.
async function waitFor(predicate, { tries = 200, step = 10 } = {}) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, step))
  }
  return false
}

// The clock is the test's, so a reminder can be watched from planning through delivery
// without waiting ten minutes.
const events = [
  { id: 'e1', summary: '周会', start: '2026-10-30T09:20:00Z', end: '2026-10-30T09:50:00Z' },
  { id: 'e2', summary: '下午的会', start: '2026-10-30T14:00:00Z', end: '2026-10-30T15:00:00Z' },
]

async function runtime(overrides = {}) {
  let clock = Date.parse('2026-10-30T09:00:00Z')
  const sent = []
  const rt = createRuntime({}, {
    home: await home(),
    now: () => new Date(clock),
    ownerOpenId: 'ou_owner',
    calendar: async () => events,
    sendCard: async (args) => {
      sent.push(args)
      return `om_${sent.length}`
    },
    ...overrides,
  })
  await rt.load()
  return { rt, sent, setClock: iso => { clock = Date.parse(iso) } }
}

test('the first tick plans both meetings and sends nothing yet', async () => {
  const { rt, sent } = await runtime()
  const result = await rt.tick()
  assert.deepEqual(result.plan.map(item => item.id), ['e1', 'e2'])
  assert.deepEqual(result.firing, [])
  assert.equal(sent.length, 0)
})

test('when the warning time comes, the card goes out to the owner', async () => {
  const { rt, sent, setClock } = await runtime()
  await rt.tick()
  setClock('2026-10-30T09:12:00Z')
  const result = await rt.tick()
  assert.deepEqual(result.firing.map(item => item.id), ['e1'])
  assert.equal(sent.length, 1)
  assert.equal(sent[0].receiveId, 'ou_owner')
  assert.equal(sent[0].card.header.title.content, '⏰ 周会')
  assert.equal(result.deliveries[0].ok, true)
})

test('the same reminder is not sent twice', async () => {
  const { rt, sent, setClock } = await runtime()
  setClock('2026-10-30T09:12:00Z')
  await rt.tick()
  const again = await rt.tick()
  assert.equal(again.deliveries.length, 0)
  assert.equal(sent.length, 1)
})

test('a Feishu failure is recorded and retried on the next tick', async () => {
  let attempts = 0
  const { rt, setClock } = await runtime({
    sendCard: async () => {
      attempts += 1
      if (attempts === 1) throw new Error('rate limited')
      return 'om_ok'
    },
  })
  setClock('2026-10-30T09:12:00Z')
  const first = await rt.tick()
  assert.equal(first.deliveries[0].ok, false)
  assert.match(first.deliveries[0].error, /rate limited/)
  const second = await rt.tick()
  assert.equal(attempts, 2)
  assert.equal(second.deliveries[0].ok, true)
})

test('a reminder with nowhere to go is skipped and says why', async () => {
  const { rt, sent, setClock } = await runtime({ ownerOpenId: undefined })
  setClock('2026-10-30T09:12:00Z')
  const result = await rt.tick()
  assert.equal(sent.length, 0)
  assert.equal(result.deliveries[0].ok, false)
  assert.equal(result.deliveries[0].error, 'no-target')
})

test('snoozing plans the meeting again later, and it is delivered once more', async () => {
  const { rt, sent, setClock } = await runtime()
  setClock('2026-10-30T09:12:00Z')
  await rt.tick()
  const changed = await rt.onCardAction({ operator: { open_id: 'ou_owner' }, action: { value: { k: 'reminder', id: 'e1', op: 'snooze' } } })
  assert.equal(changed.ok, true)
  assert.equal(sent.length, 1, 'snoozing does not send by itself')
  setClock('2026-10-30T09:23:00Z')
  await rt.tick()
  assert.equal(sent.length, 2)
  assert.match(sent[1].card.header.title.content, /周会/)
})

test('marking a meeting done is remembered, and a foreign press changes nothing', async () => {
  const { rt } = await runtime()
  const done = await rt.onCardAction({ operator: { open_id: 'ou_owner' }, action: { value: { k: 'reminder', id: 'e1', op: 'done' } } })
  assert.equal(done.ok, true)
  assert.ok(rt.store.get().done.e1)
  const refused = await rt.onCardAction({ operator: { open_id: 'ou_x' }, action: { value: { k: 'reminder', op: 'explode' } } })
  assert.deepEqual(refused, { ok: false, reason: 'unknown-op' })
})

test('a recorded report is stored and becomes the card sent back', async () => {
  const { rt, sent } = await runtime()
  const report = await rt.recordReport({ memberId: 'm1', memberName: '小王', events, done: ['写完了接口'], plan: ['联调'] })
  assert.equal(report.date, '2026-10-30')
  await rt.sendReportCard({ receiveId: 'ou_owner', report })
  assert.equal(sent.length, 1)
  assert.equal(sent[0].card.header.title.content, '小王 · 2026-10-30')
  assert.deepEqual(rt.store.get().reports['m1:2026-10-30'].plan, ['联调'])
})

// ---- the timer (issue #14, first slice) --------------------------------------------------

test('the timer is armed for the reminder fireAt, not on a one-minute grid', async () => {
  const timers = manualTimers()
  const { rt } = await runtime({ calendar: async () => nineTwentyTwo, schedule: timers.schedule, cancel: timers.cancel })
  const result = await rt.tick()
  assert.deepEqual(result.firing, [])
  const delay = rt.arm()
  assert.equal(delay, 720_000, '09:12 minus 09:00 is twelve minutes, not a sixty-second grid')
  assert.deepEqual(timers.pending(), [720_000])
})

test('after the reminder fires, the timer moves on to the next one', async () => {
  const timers = manualTimers()
  const { rt, setClock } = await runtime({
    calendar: async () => [
      ...nineTwentyTwo,
      { id: 'm2', summary: '两点十分', start: '2026-10-30T14:10:00Z', end: '2026-10-30T15:00:00Z' },
    ],
    schedule: timers.schedule,
    cancel: timers.cancel,
  })
  await rt.tick()
  assert.equal(rt.arm(), 720_000)
  setClock('2026-10-30T09:12:00Z')
  await rt.tick()
  const next = Date.parse('2026-10-30T14:00:00Z') - Date.parse('2026-10-30T09:12:00Z')
  assert.equal(rt.arm(), next)
  assert.deepEqual(timers.pending(), [next], 'one timer, replaced rather than stacked')
})

test('a reminder fired thirty seconds late is still inside the budget', async () => {
  const { rt, sent, setClock } = await runtime({ calendar: async () => nineTwentyTwo })
  await rt.tick()
  setClock('2026-10-30T09:12:30Z')
  const result = await rt.tick()
  assert.equal(sent.length, 1, 'a late warning still goes out')
  assert.equal(result.deliveries[0].latency_ms, 30_000)
  assert.equal(result.deliveries[0].deadline_ms, 30_000)
  assert.equal(result.deliveries[0].over_budget, false)
})

test('a reminder fired thirty-one seconds late is recorded over budget', async () => {
  const { rt, sent, setClock } = await runtime({ calendar: async () => nineTwentyTwo })
  await rt.tick()
  setClock('2026-10-30T09:12:31Z')
  const result = await rt.tick()
  assert.equal(sent.length, 1)
  assert.equal(result.deliveries[0].latency_ms, 31_000)
  assert.equal(result.deliveries[0].deadline_ms, 30_000)
  assert.equal(result.deliveries[0].over_budget, true)
})

test('a calendar that fails three times still runs the tick and says what failed', async () => {
  let calls = 0
  const { rt } = await runtime({
    calendar: async () => {
      calls += 1
      throw new Error('calendar down')
    },
  })
  const result = await rt.tick()
  assert.equal(calls, 3, 'three attempts, not one')
  assert.deepEqual(result.failures.map(failure => [failure.source, failure.reason, failure.attempt]), [
    ['calendar', 'error', 1],
    ['calendar', 'error', 2],
    ['calendar', 'error', 3],
  ])
  assert.deepEqual(result.plan, [], 'a failed calendar costs the pass nothing it did not already lack')
})

test('a wake whose calendar failed still arms the refresh floor', async () => {
  const timers = manualTimers()
  const { rt } = await runtime({
    calendar: async () => {
      throw new Error('calendar down')
    },
    schedule: timers.schedule,
    cancel: timers.cancel,
  })
  await rt.run()
  assert.deepEqual(timers.pending(), [300_000], 'no reminder pending, so the next wake is the refresh floor')
})

test('a wake fires the pass and re-arms itself', async () => {
  const timers = manualTimers()
  const { rt, sent, setClock } = await runtime({
    calendar: async () => nineTwentyTwo,
    schedule: timers.schedule,
    cancel: timers.cancel,
  })
  await rt.start()
  assert.deepEqual(timers.pending(), [720_000])
  setClock('2026-10-30T09:12:00Z')
  timers.fire()
  const done = await waitFor(() => sent.length === 1 && timers.pending().length === 1)
  assert.ok(done, 'the fired wake sent the card and armed the next one again')
  rt.stop()
})

test('a start reads the state file before the first pass, so a wake cannot save it empty', async () => {
  const dir = await home()
  await writeFile(
    join(dir, 'state.json'),
    `${JSON.stringify({ members: { m1: { id: 'm1', name: '小王', active: true } }, reports: {} })}\n`,
    'utf8',
  )
  const rt = createRuntime({}, { home: dir, now: () => new Date('2026-10-30T09:00:00Z'), calendar: async () => [] })
  assert.deepEqual(rt.store.get().members, {}, 'the fresh runtime starts without the file')
  await rt.start()
  assert.equal(rt.store.get().members.m1.name, '小王', 'the member written by an earlier run survived the first pass')
  rt.stop()
})
