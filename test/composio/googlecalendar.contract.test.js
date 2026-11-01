// 谷歌日历契约（#32 S4）：五成员、只 metadata、只 GET 事件、时间记成硬时间（`due_kind: 'hard'`）。
//
// 日历的 `due_kind: 'hard'` 是 S5 冲突裁决的依据：同一个会议被邮件也报一次、时间不一样时，
// 采信谁由这个字段决定。适配器只把事实带上，不做裁决。

import test from 'node:test'
import assert from 'node:assert/strict'

import { READ_MEMBERS, REF_PATTERN } from '../../src/sources/composio/adapter.js'
import { createGoogleCalendarAdapter, id, readScope } from '../../src/sources/composio/googlecalendar.js'
import { accountForOf, accountsOf, loadScenario, transportFor } from './helpers.mjs'

const loaded = loadScenario('all-ok')
const accounts = accountsOf(loaded.scenario)
const account = accountForOf(accounts, loaded.scenario.userId)('googlecalendar')

function calendarAdapter(calls) {
  return createGoogleCalendarAdapter({ account, transport: transportFor(loaded, calls) })
}

test('the calendar adapter has only the five read members and no write method', () => {
  const adapter = calendarAdapter()
  for (const member of READ_MEMBERS) assert.ok(member in adapter, `缺成员 ${member}`)
  assert.equal(adapter.id, 'composio:googlecalendar')
  assert.equal(adapter.readScope, 'metadata')
  for (const write of ['create', 'update', 'delete', 'move', 'insert', 'patch']) {
    assert.equal(write in adapter, false, `适配器上不该有写方法 ${write}`)
  }
})

test('the calendar adapter maps events to event refs with a hard due time', async () => {
  const calls = []
  const adapter = calendarAdapter(calls)
  const { observations, cursor } = await adapter.list(loaded.scenario.since, undefined)

  assert.equal(observations.length, 3)
  assert.equal(cursor, null)

  const review = observations.find(item => item.ref === 'composio:googlecalendar:event/e1')
  assert.ok(review, '有一条 ref 是 composio:googlecalendar:event/e1')
  assert.equal(review.title, '产品评审会')
  assert.equal(review.due_kind, 'hard')
  assert.equal(review.due_at, '2025-11-01T16:00:00+08:00')
  assert.equal(review.at, '2025-11-01T08:00:00.000Z')
  assert.ok(review.people.includes('李娜'), '参与人来自 attendees 的 displayName')

  // 全天事件没有时刻：due_at 记当天零点，不猜一个钟点。
  const allday = observations.find(item => item.ref === 'composio:googlecalendar:event/e3')
  assert.equal(allday.due_at, '2025-10-29T00:00:00')

  for (const observation of observations) {
    for (const field of ['source', 'ref', 'external_id', 'title', 'excerpt', 'at', 'due_at', 'due_kind', 'people', 'state']) {
      assert.ok(field in observation, `观察缺字段 ${field}`)
    }
    assert.equal(observation.source, 'composio:googlecalendar')
    assert.match(observation.ref, REF_PATTERN)
  }

  for (const call of calls) {
    assert.equal(call.kind, 'proxyGet')
    assert.match(call.endpoint, /^\/calendar\/v3\/calendars\/primary\/events/)
    assert.doesNotMatch(call.endpoint, /events\/(insert|patch|update|delete|move)/)
  }
})

test('get returns one event and null for another app ref', async () => {
  const adapter = calendarAdapter()
  const observation = await adapter.get('composio:googlecalendar:event/e2')
  assert.equal(observation.ref, 'composio:googlecalendar:event/e2')
  assert.equal(observation.title, '季度预算对一下')
  assert.equal(await adapter.get('composio:gmail:thread/t1'), null)
})

test('auth mirrors the account state', () => {
  const adapter = calendarAdapter()
  assert.deepEqual(adapter.auth(), { ok: true, reason: null })
})

test('id and readScope are exported for the registry row', () => {
  assert.equal(id, 'composio:googlecalendar')
  assert.equal(readScope, 'metadata')
})
