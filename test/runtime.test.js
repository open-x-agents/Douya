import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRuntime } from '../index.js'

const home = async () => mkdtemp(join(tmpdir(), 'odm-rt-'))

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

// The 60 second interval is gone: the wake is the distance to the reminder's own fireAt, so a
// warning is not rounded onto a minute grid and the test can see the exact delay.
test("the timer is armed for the reminder's fireAt, not on a one-minute grid", async () => {
  const delays = []
  const { rt } = await runtime({
    calendar: async () => [{ id: 'e1', summary: '周会', start: '2026-10-30T09:22:00Z', end: '2026-10-30T09:52:00Z' }],
    schedule: (fn, delay) => {
      delays.push(delay)
      return { unref() {} }
    },
    cancel: () => {},
  })
  await rt.tick()
  assert.deepEqual(delays, [720000])
})

const meetingAt0922 = [{ id: 'e1', summary: '周会', start: '2026-10-30T09:22:00Z', end: '2026-10-30T09:52:00Z' }]

test('a reminder fired thirty seconds late is still inside the budget', async () => {
  const { rt, setClock } = await runtime({ calendar: async () => meetingAt0922 })
  setClock('2026-10-30T09:12:30Z')
  const result = await rt.tick()
  assert.equal(result.deliveries[0].latency_ms, 30_000)
  assert.equal(result.deliveries[0].deadline_ms, 30_000)
  assert.equal(result.deliveries[0].over_budget, false)
})

test('a reminder fired thirty-one seconds late is recorded over budget', async () => {
  const { rt, setClock } = await runtime({ calendar: async () => meetingAt0922 })
  setClock('2026-10-30T09:12:31Z')
  const result = await rt.tick()
  assert.equal(result.deliveries[0].latency_ms, 31_000)
  assert.equal(result.deliveries[0].deadline_ms, 30_000)
  assert.equal(result.deliveries[0].over_budget, true)
})

test('a calendar that throws does not break the pass, and every attempt is recorded', async () => {
  const { rt } = await runtime({
    calendar: async () => {
      throw new Error('calendar down')
    },
  })
  const result = await rt.tick()
  assert.deepEqual(result.plan, [])
  assert.deepEqual(result.failures.map(failure => [failure.source, failure.reason, failure.attempt]), [
    ['calendar', 'error', 1],
    ['calendar', 'error', 2],
    ['calendar', 'error', 3],
  ])
})

// The timer arms at load time, so the first pass can run before the store file is read. Reading
// first is what keeps that pass from saving an empty state over the previous run's members.
test('start reads the store before the first pass, so a wake cannot save it empty', async () => {
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
  assert.equal(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')).members.m1.name, '小王')
  rt.stop()
})

// #95: 先「推迟」再「已完成」，原来到点还会再发一张。`state.done` 只写没人读，`due()` 只看
// 已投递的 key，于是被推迟的那份副本在 09:22 照样发出去。
test('a meeting snoozed and then ticked off sends nothing at the snoozed moment', async () => {
  const { rt, sent, setClock } = await runtime()
  const press = (op, id) => rt.onCardAction({ operator: { open_id: 'ou_owner' }, action: { value: { k: 'reminder', id, op } } })

  setClock('2026-10-30T09:12:00Z')
  await rt.tick()
  assert.equal(sent.length, 1, 'the 09:10 warning for the 09:20 meeting went out')

  assert.deepEqual(await press('snooze', 'e1'), { ok: true, op: 'snooze', id: 'e1', openId: 'ou_owner' })
  setClock('2026-10-30T09:13:00Z')
  assert.deepEqual(await press('done', 'e1'), { ok: true, op: 'done', id: 'e1', openId: 'ou_owner' })

  setClock('2026-10-30T09:22:00Z')
  const after = await rt.tick()
  assert.deepEqual(after.firing, [], 'a finished meeting is not due again at the snoozed moment')
  assert.equal(sent.length, 1, 'no second card')
})

test('ticking a meeting off before its warning keeps it from firing at all', async () => {
  const { rt, sent, setClock } = await runtime()
  setClock('2026-10-30T09:05:00Z')
  await rt.tick()
  const press = (op, id) => rt.onCardAction({ operator: { open_id: 'ou_owner' }, action: { value: { k: 'reminder', id, op } } })
  assert.equal((await press('done', 'e2')).ok, true)

  setClock('2026-10-30T13:52:00Z')
  const result = await rt.tick()
  assert.deepEqual(result.firing.map(item => item.id), [], 'the 14:00 meeting was already handled')
  assert.equal(sent.length, 0)
})

test('a finished meeting cannot be snoozed back to life', async () => {
  const { rt } = await runtime()
  const press = (op, id) => rt.onCardAction({ operator: { open_id: 'ou_owner' }, action: { value: { k: 'reminder', id, op } } })
  await press('done', 'e1')
  assert.deepEqual(await press('snooze', 'e1'), { ok: false, reason: 'already-done' })
  assert.deepEqual(rt.store.get().manual ?? [], [])
})

test('pressing done twice keeps the first moment', async () => {
  const { rt, setClock } = await runtime()
  const press = op => rt.onCardAction({ operator: { open_id: 'ou_owner' }, action: { value: { k: 'reminder', id: 'e1', op } } })
  setClock('2026-10-30T09:10:00Z')
  await press('done')
  const first = rt.store.get().done.e1
  setClock('2026-10-30T09:20:00Z')
  await press('done')
  assert.equal(rt.store.get().done.e1, first)
})

// #96 的 Verdict: INC 抓到的第二个问题：`due()` 过滤了 done，但 `nextWake()` 还在看没过滤的
// plan。会前点过「已完成」的日程一旦过了自己的 fireAt，每次唤醒都算出 `delayMs: 0`，
// `arm(0)` 立刻再 tick 再算 0 —— 0ms 热循环，每次都打日历源并落盘，一直到会议开始。
test('a ticked-off meeting does not arm a 0ms wake loop', async () => {
  const { rt, setClock } = await runtime()
  await rt.onCardAction({ operator: { open_id: 'ou_owner' }, action: { value: { k: 'reminder', id: 'e1', op: 'done' } } })

  setClock('2026-10-30T09:11:00Z')
  const result = await rt.tick()
  assert.deepEqual(result.firing, [], 'the finished meeting is not due')
  assert.ok(result.nextWake.delayMs > 0, `a finished meeting must not ask to wake now (got ${result.nextWake.delayMs}ms)`)
  assert.equal(result.nextWake.id, 'e2', 'the next wake belongs to the afternoon meeting, not the finished one')
})
