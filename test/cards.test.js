import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OPS, dailyReportCard, readAction, reminderCard } from '../src/host/cards.js'
import { buildDailyReport } from '../src/host/report.js'

const report = buildDailyReport({
  date: '2026-10-30',
  memberId: 'm1',
  memberName: '小王',
  events: [{ id: 'a', summary: '周会', start: '2026-10-30T09:00:00+08:00', end: '2026-10-30T09:30:00+08:00' }],
  done: ['写完了接口'],
  plan: ['明天联调'],
})

const actions = card => card.elements.find(element => element.tag === 'action').actions

test('the report card carries the day, the schedule and both buttons', () => {
  const card = dailyReportCard(report)
  assert.equal(card.header.title.content, '小王 · 2026-10-30')
  assert.equal(card.header.template, 'blue')
  const text = card.elements[0].text.content
  assert.match(text, /09:00 周会/)
  assert.match(text, /写完了接口/)
  assert.match(text, /明天联调/)
  assert.deepEqual(actions(card).map(button => button.value.op), ['report.fill', 'report.view'])
  assert.deepEqual(actions(card)[0].value, { k: 'report', id: 'm1', op: 'report.fill' })
})

test('an empty day is drawn grey, not as an error', () => {
  const card = dailyReportCard(buildDailyReport({ date: '2026-10-30', memberId: 'm1', memberName: '小王' }))
  assert.equal(card.header.template, 'grey')
  assert.match(card.elements[0].text.content, /今天没有日程/)
})

test('the reminder card offers snooze, done and reschedule, all pointing at the same event', () => {
  const card = reminderCard({ id: 'e1', title: '需求评审', startAt: '2026-10-30T14:00:00+08:00', fireAt: '2026-10-30T13:50:00+08:00', leadMinutes: 10, location: '2F' })
  assert.equal(card.header.title.content, '⏰ 需求评审')
  assert.match(card.elements[0].text.content, /14:00 开始/)
  assert.match(card.elements[0].text.content, /2F/)
  assert.deepEqual(actions(card).map(button => button.value.op), ['snooze', 'done', 'reschedule'])
  for (const button of actions(card)) assert.equal(button.value.id, 'e1')
})

test('a snoozed reminder says so', () => {
  const card = reminderCard({ id: 'e1', title: '需求评审', startAt: '2026-10-30T14:00:00+08:00', leadMinutes: 0, snoozed: true })
  assert.equal(card.header.template, 'grey')
  assert.match(card.elements[0].text.content, /已推迟/)
})

test('a button press is read only when it is one of ours', () => {
  const pressed = readAction({ operator: { open_id: 'ou_1' }, action: { value: { k: 'reminder', id: 'e1', op: 'snooze' } } })
  assert.deepEqual(pressed, { ok: true, openId: 'ou_1', kind: 'reminder', id: 'e1', op: 'snooze' })
})

test('presses from outside are refused by name rather than guessed at', () => {
  assert.deepEqual(readAction({}), { ok: false, reason: 'no-operator' })
  assert.deepEqual(readAction({ operator: { open_id: '' } }), { ok: false, reason: 'no-operator' })
  assert.deepEqual(readAction({ operator: { open_id: 'ou_1' } }), { ok: false, reason: 'no-value' })
  assert.deepEqual(readAction({ operator: { open_id: 'ou_1' }, action: { value: 'snooze' } }), { ok: false, reason: 'no-value' })
  assert.deepEqual(readAction({ operator: { open_id: 'ou_1' }, action: { value: { k: 'other', op: 'snooze' } } }), { ok: false, reason: 'unknown-card' })
  assert.deepEqual(readAction({ operator: { open_id: 'ou_1' }, action: { value: { k: 'reminder', op: 'explode' } } }), { ok: false, reason: 'unknown-op' })
})

test('every op a card can carry is one the callback knows', () => {
  const ops = [...actions(dailyReportCard(report)), ...actions(reminderCard({ id: 'e', title: 't', startAt: '2026-10-30T14:00:00+08:00', leadMinutes: 10 }))]
    .map(button => button.value.op)
  for (const op of ops) assert.ok(OPS.includes(op), `${op} is not a known op`)
})
