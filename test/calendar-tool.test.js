import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createComposioTools, calendarEventsResult, calendarErrorResult } from '../src/web/agent-tools.js'

const tool = (client) => createComposioTools(client).find(t => t.name === 'calendar_list_events')

test('a successful empty read is a verified empty range on a connected account', async () => {
  let args
  const t = tool({ executeAction: async (slug, a) => { args = a; return { successful: true, data: { summary: 'me@x.com', timeZone: 'Asia/Shanghai', items: [] } } } })
  const r = await t.execute({ time_min: '2026-11-04T00:00:00+08:00', time_max: '2026-11-04T23:59:59+08:00' })
  assert.equal(r.ok, true); assert.equal(r.connected, true); assert.equal(r.count, 0)
  assert.match(r.note, /确实没有事件/)
  assert.equal(args.singleEvents, true); assert.equal(args.calendarId, 'primary')
})

test('ConnectedAccountNotFound is reported as not connected, never as 0 events', async () => {
  const t = tool({ executeAction: async () => { throw new Error('Composio API error (404): {"error":{"slug":"ActionExecute_ConnectedAccountNotFound"}}') } })
  const r = await t.execute({})
  assert.equal(r.ok, false); assert.equal(r.reason, 'not_connected'); assert.equal(r.connected, false)
  assert.equal('events' in r, false); assert.equal('count' in r, false)
  assert.equal(r.connect.source, 'googlecalendar')
})

test('HTTP 200 with successful:false is a failure, not an empty calendar', () => {
  const r = calendarEventsResult({ successful: false, error: 'token expired', data: {} })
  assert.equal(r.ok, false); assert.equal(r.reason, 'call_failed'); assert.equal('count' in r, false)
  assert.equal(calendarEventsResult({ successful: true, data: {} }).ok, false)
})

test('events are mapped with start/end/allDay', () => {
  const r = calendarEventsResult({ successful: true, data: { items: [{ id: 'e1', summary: '站会', start: { dateTime: '2026-11-04T10:00:00+08:00' }, end: { dateTime: '2026-11-04T10:15:00+08:00' } }, { id: 'e2', start: { date: '2026-11-05' }, end: { date: '2026-11-06' } }] } })
  assert.equal(r.count, 2); assert.equal(r.events[0].summary, '站会'); assert.equal(r.events[1].allDay, true)
  assert.equal(calendarErrorResult(new Error('boom')).connected, null)
})
