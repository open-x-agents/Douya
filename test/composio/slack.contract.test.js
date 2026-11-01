// Slack 契约（#32 S4）：五成员、只 metadata、只调注册表白名单里的两个读动作。
//
// Slack 的读动作走 Composio 的 toolkit 动作口（`SLACK_LIST_CONVERSATIONS` /
// `SLACK_FETCH_CONVERSATION_HISTORY`，快照里都带 `readOnlyHint`）。这条用例的重点是：
// 除这两个读动作之外，一个动作名都不许出现。

import test from 'node:test'
import assert from 'node:assert/strict'

import { READ_MEMBERS, REF_PATTERN } from '../../src/sources/composio/adapter.js'
import { createSlackAdapter, HISTORY_TOOL, LIST_TOOL, id, readScope } from '../../src/sources/composio/slack.js'
import { registry } from '../../src/sources/composio/registry.js'
import { accountForOf, accountsOf, loadScenario, transportFor } from './helpers.mjs'

const loaded = loadScenario('all-ok')
const accounts = accountsOf(loaded.scenario)
const account = accountForOf(accounts, loaded.scenario.userId)('slack')

function slackAdapter(calls) {
  return createSlackAdapter({ account, transport: transportFor(loaded, calls) })
}

test('the slack adapter has only the five read members and no write method', () => {
  const adapter = slackAdapter()
  for (const member of READ_MEMBERS) assert.ok(member in adapter, `缺成员 ${member}`)
  assert.equal(adapter.id, 'composio:slack')
  assert.equal(adapter.readScope, 'metadata')
  for (const write of ['send', 'post', 'create', 'update', 'delete', 'reply', 'react']) {
    assert.equal(write in adapter, false, `适配器上不该有写方法 ${write}`)
  }
})

test('the slack adapter maps channel messages to message refs', async () => {
  const calls = []
  const adapter = slackAdapter(calls)
  const { observations, cursor } = await adapter.list(loaded.scenario.since, undefined)

  assert.equal(observations.length, 4, 'general 里四条消息')
  assert.equal(cursor, null)

  const first = observations[0]
  assert.equal(first.ref, 'composio:slack:message/C0GENERAL/1761900000.000100')
  assert.equal(first.at, '2025-10-31T08:40:00.000Z')
  assert.ok(first.excerpt.includes('#general'))
  assert.equal(first.due_at, null)
  assert.equal(first.due_kind, null)

  for (const observation of observations) {
    assert.equal(observation.source, 'composio:slack')
    assert.match(observation.ref, REF_PATTERN)
  }
})

test('only the two read actions from the registry whitelist are ever called', () => {
  const row = registry.find(item => item.toolkit === 'slack')
  assert.ok(row, '注册表里有 slack 一行')
  for (const slug of [LIST_TOOL, HISTORY_TOOL]) {
    assert.ok(row.actions.includes(slug), `${slug} 必须在注册表白名单里`)
  }

  const calls = []
  const adapter = slackAdapter(calls)
  return adapter.list(loaded.scenario.since, undefined).then(() => {
    const slugs = [...new Set(calls.map(call => call.toolSlug))]
    assert.deepEqual(slugs.sort(), [LIST_TOOL, HISTORY_TOOL].sort())
    for (const call of calls) assert.equal(call.kind, 'executeTool')
  })
})

test('get returns the message for a ref and null for another app ref', async () => {
  const adapter = slackAdapter()
  const observation = await adapter.get('composio:slack:message/C0GENERAL/1761900200.000300')
  assert.equal(observation.ref, 'composio:slack:message/C0GENERAL/1761900200.000300')
  assert.equal(observation.title, '上线检查清单已更新')
  assert.equal(await adapter.get('composio:gmail:thread/t1'), null)
})

test('id and readScope are exported for the registry row', () => {
  assert.equal(id, 'composio:slack')
  assert.equal(readScope, 'metadata')
})
