import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDailyReport, clockOf, dayOf, eventLine, isEmptyReport, minutesOf } from '../src/host/report.js'

const events = [
  { id: 'a', summary: '周会', start: '2026-10-30T09:00:00+08:00', end: '2026-10-30T09:30:00+08:00', location: '3F' },
  { id: 'b', summary: '需求评审', start: '2026-10-30T14:00:00+08:00', end: '2026-10-30T15:00:00+08:00' },
  { id: 'c', summary: '明天的事', start: '2026-10-31T10:00:00+08:00', end: '2026-10-31T11:00:00+08:00' },
]

test('the day comes from the string, not from a re-parse in another zone', () => {
  assert.equal(dayOf(events[0]), '2026-10-30')
  assert.equal(dayOf({}), '')
  assert.equal(clockOf('2026-10-30T09:05:00+08:00'), '09:05')
  assert.equal(clockOf(''), '全天')
})

test('a meeting without an end costs no minutes instead of a negative number', () => {
  assert.equal(minutesOf(events[0]), 30)
  assert.equal(minutesOf({ start: '2026-10-30T09:00:00Z' }), 0)
  assert.equal(minutesOf({ start: '2026-10-30T09:00:00Z', end: '2026-10-30T09:00:00Z' }), 0)
})

test('an event line carries the clock, the title and the place', () => {
  assert.equal(eventLine(events[0]), '09:00 周会·3F')
  assert.equal(eventLine({ start: '2026-10-30T14:00:00+08:00' }), '14:00 未命名日程')
})

test('the report keeps only the day it is for, and counts what it kept', () => {
  const report = buildDailyReport({ memberId: 'm1', memberName: '小王', events, done: ['写完了接口', ' '], plan: ['明天联调'], notes: ' 顺 ' })
  assert.equal(report.date, '2026-10-30')
  assert.deepEqual(report.schedule, ['09:00 周会·3F', '14:00 需求评审'])
  assert.deepEqual(report.done, ['写完了接口'])
  assert.deepEqual(report.plan, ['明天联调'])
  assert.equal(report.notes, '顺')
  assert.deepEqual(report.stats, { meetings: 2, meetingMinutes: 90, done: 1, planned: 1 })
})

test('an explicit date wins over the first event', () => {
  const report = buildDailyReport({ date: '2026-10-31', memberId: 'm1', events })
  assert.deepEqual(report.schedule, ['10:00 明天的事'])
  assert.equal(report.stats.meetingMinutes, 60)
})

test('an empty day is reported as empty, not as a failure', () => {
  const report = buildDailyReport({ date: '2026-10-30', memberId: 'm1', events: [] })
  assert.equal(isEmptyReport(report), true)
  assert.equal(isEmptyReport(buildDailyReport({ date: '2026-10-30', memberId: 'm1', events, done: ['x'] })), false)
})
