// Notion 契约（#32 S4）：五成员、只 metadata、只 GET 子块 / 页面、真用游标。
//
// 没有 `rootId` 时抛 `E_NOTION_ROOT`，让 `brief.js` 把该源记成 `error` + `partial` ——
// 不猜一个根页面，也不把「没配好」伪装成「今天没有页面」。

import test from 'node:test'
import assert from 'node:assert/strict'

import { READ_MEMBERS, REF_PATTERN } from '../../src/sources/composio/adapter.js'
import { createNotionAdapter, id, readScope } from '../../src/sources/composio/notion.js'
import { accountForOf, accountsOf, loadScenario, transportFor } from './helpers.mjs'

const loaded = loadScenario('all-ok')
const accounts = accountsOf(loaded.scenario)
const account = accountForOf(accounts, loaded.scenario.userId)('notion')

function notionAdapter(calls, rootId = loaded.scenario.config.notion.rootId) {
  return createNotionAdapter({ account, transport: transportFor(loaded, calls), rootId })
}

test('the notion adapter has only the five read members and no write method', () => {
  const adapter = notionAdapter()
  for (const member of READ_MEMBERS) assert.ok(member in adapter, `缺成员 ${member}`)
  assert.equal(adapter.id, 'composio:notion')
  assert.equal(adapter.readScope, 'metadata')
  for (const write of ['create', 'update', 'delete', 'insert', 'append', 'archive']) {
    assert.equal(write in adapter, false, `适配器上不该有写方法 ${write}`)
  }
})

test('the notion adapter pages through block children and returns a cursor', async () => {
  const calls = []
  const adapter = notionAdapter(calls)
  const { observations, cursor } = await adapter.list(loaded.scenario.since, 'cursor-2')

  assert.equal(observations.length, 3)
  assert.equal(cursor, null)

  const first = observations[0]
  assert.equal(first.ref, 'composio:notion:page/p1')
  assert.equal(first.title, '周会纪要')
  assert.equal(first.at, '2025-10-31T09:00:00.000Z')
  assert.equal(first.due_at, null)

  for (const observation of observations) {
    assert.equal(observation.source, 'composio:notion')
    assert.match(observation.ref, REF_PATTERN)
  }

  // 游标是请求参数，不是猜的页码。
  assert.ok(calls[0].endpoint.includes('start_cursor=cursor-2'), calls[0].endpoint)
  for (const call of calls) {
    assert.equal(call.kind, 'proxyGet')
    assert.match(call.endpoint, /^\/v1\//)
  }
})

test('get returns a page and null for another app ref', async () => {
  const adapter = notionAdapter()
  const observation = await adapter.get('composio:notion:page/p1')
  assert.equal(observation.ref, 'composio:notion:page/p1')
  assert.equal(observation.title, '周会纪要')
  assert.equal(await adapter.get('composio:gmail:thread/t1'), null)
})

test('a missing root is an error, not an empty list', async () => {
  const adapter = notionAdapter([], null)
  await assert.rejects(() => adapter.list(loaded.scenario.since, undefined), /E_NOTION_ROOT/)
})

test('id and readScope are exported for the registry row', () => {
  assert.equal(id, 'composio:notion')
  assert.equal(readScope, 'metadata')
})
