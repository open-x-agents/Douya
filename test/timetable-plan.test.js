import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyPlanEdit, readPlan, mergeDigestTimetable, findTimetableCard, hhmm, localDay, snapMin, suggestMeetingBuffers } from '../src/web/timetable-plan.js'
import { reconcileCards } from '../src/host/reconcile.js'

const NOW = new Date('2026-11-04T14:55:00+08:00')
const card = (extra = {}) => ({
  id: 'card_timetable_1', type: 'timetable', sourceId: 'timetable', status: 'active', updatedAt: '2026-11-04T06:00:00Z',
  blocks: [{ type: 'timetable', fixedBlocks: [{ start: '2026-11-04T16:00:00+08:00', end: '2026-11-04T16:30:00+08:00', title: '站会' }],
    suggestedBlocks: [
      { start: '12:45', end: '13:10', title: '回 Fledge', category: 'work' },
      { start: '14:00', end: '15:00', title: '修 tests', category: 'focus' },
      { start: '15:30', end: '16:00', title: '清邮件', category: 'admin' },
    ], ...extra }],
})

test('hhmm normalizes times', () => {
  assert.equal(hhmm('9:5'), '09:05')
  assert.equal(hhmm('25:00'), null)
  assert.equal(hhmm('2026-11-04T07:30:00+08:00'), '07:30')
  assert.equal(hhmm('2026-11-04T00:30:00.000Z'), '08:30')
  assert.equal(hhmm('2026-11-04T16:00:00+08:00'), '16:00')
})

test('readPlan: fixed events, blocks, next follows now', () => {
  const p = readPlan(card(), { now: NOW })
  assert.equal(p.fixedEvents[0].start, '16:00')
  assert.equal(p.blocks.length, 3)
  assert.deepEqual(p.next, { start: '14:00', end: '15:00', title: '修 tests' })
})

test('replace: afternoon replan keeps the morning, drops old later blocks, stamps userPlan, next follows', () => {
  const r = applyPlanEdit(card(), { mode: 'replace', blocks: [
    { start: '14:55', end: '17:30', title: '写立项材料', kind: 'focus', cardIds: ['card_x'] },
    { start: '17:30', end: '18:00', title: '缓冲', kind: 'buffer' },
    { start: '19:00', end: '19:40', title: '吃饭', kind: '吃饭' },
  ] }, { now: NOW })
  assert.equal(r.ok, true)
  // 14:55–17:30 runs into the 16:00 calendar event: the event stays, the focus block is split around it.
  assert.ok(r.warnings.some(w => /站会/.test(w)))
  assert.deepEqual(r.plan.blocks.map(b => `${b.start}-${b.end} ${b.title}`), ['12:45-13:10 回 Fledge', '14:55-16:00 写立项材料', '16:30-17:30 写立项材料', '17:30-18:00 缓冲', '19:00-19:40 吃饭'])
  assert.equal(r.plan.blocks[3].kind, 'break')
  assert.equal(r.plan.blocks[4].kind, 'meal')
  assert.equal(r.plan.userEdited.date, localDay(NOW))
  assert.equal(r.plan.next.title, '写立项材料')
})

test('replace without collision keeps cardIds and becomes 接下来', () => {
  const c = card(); c.blocks[0].fixedBlocks = []
  const r = applyPlanEdit(c, { mode: 'replace', blocks: [{ start: '14:55', end: '17:30', title: '写立项材料', kind: 'focus', cardIds: 'card_x' }] }, { now: NOW })
  assert.equal(r.ok, true)
  assert.deepEqual(r.plan.next, { start: '14:55', end: '17:30', title: '写立项材料' })
  assert.deepEqual(r.plan.blocks.find(b => b.title === '写立项材料').cardIds, ['card_x'])
  assert.equal(r.plan.blocks.some(b => b.title === '修 tests'), false)
})

test('patch: move by start keeps duration; remove; add; bad match lists current blocks', () => {
  let r = applyPlanEdit(card(), { mode: 'patch', ops: [{ match: '14:00', start: '17:00' }, { match: '清邮件', remove: true }, { start: '20:10', end: '20:30', title: '收尾小事', kind: 'winddown' }] }, { now: NOW })
  assert.equal(r.ok, true)
  const moved = r.plan.blocks.find(b => b.title === '修 tests')
  assert.equal(moved.start, '17:00'); assert.equal(moved.end, '18:00')
  assert.equal(r.plan.blocks.some(b => b.title === '清邮件'), false)
  assert.ok(r.plan.blocks.some(b => b.title === '收尾小事' && b.kind === 'winddown'))
  r = applyPlanEdit(card(), { mode: 'patch', ops: [{ match: '11:11', start: '12:00' }] }, { now: NOW })
  assert.equal(r.ok, false); assert.match(r.errors[0], /找不到/)
})

test('invalid blocks are rejected, nothing changes', () => {
  const r = applyPlanEdit(card(), { mode: 'replace', blocks: [{ start: '18:00', end: '17:00', title: 'x' }] }, { now: NOW })
  assert.equal(r.ok, false)
})

test('re-digest keeps today\'s edited plan, takes new calendar events, drops collisions', () => {
  const edited = applyPlanEdit(card(), { mode: 'patch', ops: [{ start: '18:00', end: '18:20', title: '回 Fledge 邮件', kind: 'work' }] }, { now: NOW }).card
  const inc = { type: 'timetable', sourceId: 'timetable:2026-11-04', blocks: [{ type: 'timetable', fixedBlocks: [{ start: '18:10', end: '18:40', title: '新会议' }], suggestedBlocks: [{ start: '09:00', end: '10:00', title: 'LLM 新排', category: 'focus' }] }] }
  const m = mergeDigestTimetable(edited, inc, { now: NOW })
  const tt = m.blocks[0]
  assert.equal(tt.fixedBlocks[0].title, '新会议')
  assert.equal(tt.suggestedBlocks.some(b => b.title === 'LLM 新排'), false)
  assert.equal(tt.suggestedBlocks.some(b => b.title === '回 Fledge 邮件'), false) // collides with 新会议
  assert.ok(tt.suggestedBlocks.some(b => b.title === '修 tests'))
  // a different day / reset -> the digest's plan
  assert.equal(mergeDigestTimetable(edited, inc, { now: new Date('2026-11-05T09:00:00+08:00') }), inc)
  const reset = applyPlanEdit(edited, { mode: 'reset' }, { now: NOW }).card
  assert.equal(mergeDigestTimetable(reset, inc, { now: NOW }), inc)
})

test('reconcileCards keeps the edited plan through a digest', () => {
  const edited = applyPlanEdit(card(), { mode: 'patch', ops: [{ match: '14:00', title: '改过的专注' }] }, { now: new Date() }).card
  const inc = { id: 'card_timetable_2', type: 'timetable', sourceId: 'timetable:2026-11-04', blocks: [{ type: 'timetable', fixedBlocks: [], suggestedBlocks: [{ start: '09:00', end: '10:00', title: 'LLM 新排', category: 'focus' }] }] }
  const { cards } = reconcileCards([edited], [inc])
  const tt = findTimetableCard(cards)
  assert.equal(tt.id, 'card_timetable_1')
  assert.ok(tt.blocks[0].suggestedBlocks.some(b => b.title === '改过的专注'))
  assert.equal(tt.blocks[0].suggestedBlocks.some(b => b.title === 'LLM 新排'), false)
})

test('todaysCalendarEvents counts only today\'s fixed blocks', async () => {
  const { todaysCalendarEvents } = await import('../src/web/timetable-plan.js')
  const c = card(); c.blocks[0].fixedBlocks.push({ start: '2026-11-05T09:00:00+08:00', end: '2026-11-05T10:00:00+08:00', title: '明天' }, { start: '2026-11-04', end: '2026-11-05', title: '全天' })
  assert.deepEqual(todaysCalendarEvents(c, { now: NOW }).map(b => b.title), ['站会', '全天'])
})

test('snapMin rounds to 15', () => {
  assert.equal(snapMin(37), 30)
  assert.equal(snapMin(38), 45)
  assert.equal(snapMin(0), 0)
})

test('suggestMeetingBuffers: free gap after meeting → 会后缓冲', () => {
  const bufs = suggestMeetingBuffers(card())
  assert.equal(bufs.length, 1)
  assert.equal(bufs[0].start, '16:30')
  assert.equal(bufs[0].end, '16:45')
  assert.equal(bufs[0].kind, 'break')
})

test('suggestMeetingBuffers: existing block after meeting → none', () => {
  const c = card()
  c.blocks[0].suggestedBlocks.push({ start: '16:30', end: '16:45', title: '已有缓冲', category: 'break' })
  assert.deepEqual(suggestMeetingBuffers(c), [])
})