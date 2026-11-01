// Gmail 契约（#32 S4）：五成员、只 metadata、只 GET 线程头、没有写方法。
//
// 这里钉死的是「只读边界」是怎么落地的：请求路径只能落在 `/gmail/v1/users/me/threads*`，
// 观测里只有五个邮件头拼出来的 `excerpt`（没有正文、没有 snippet），ref 形如
// `composio:gmail:thread/<id>`。写动作一个方法名都不许出现。

import test from 'node:test'
import assert from 'node:assert/strict'

import { READ_MEMBERS, REF_PATTERN } from '../../src/sources/composio/adapter.js'
import { createGmailAdapter, id, readScope } from '../../src/sources/composio/gmail.js'
import { resolveAccount } from '../../src/sources/composio/accounts.js'
import { accountForOf, accountsOf, loadScenario, transportFor } from './helpers.mjs'

const loaded = loadScenario('all-ok')
const accounts = accountsOf(loaded.scenario)
const activeGmail = accountForOf(accounts, loaded.scenario.userId)('gmail')

function gmailAdapter(calls) {
  return createGmailAdapter({ account: activeGmail, transport: transportFor(loaded, calls) })
}

test('the gmail adapter has only the five read members and no write method', () => {
  const adapter = gmailAdapter()
  for (const member of READ_MEMBERS) assert.ok(member in adapter, `缺成员 ${member}`)
  assert.equal(adapter.id, 'composio:gmail')
  assert.equal(adapter.readScope, 'metadata')
  for (const write of ['send', 'create', 'update', 'delete', 'archive', 'trash', 'markRead', 'label', 'reply']) {
    assert.equal(write in adapter, false, `适配器上不该有写方法 ${write}`)
  }
})

test('list reads the five mail headers only, never a body or a snippet', async () => {
  const calls = []
  const adapter = gmailAdapter(calls)
  const { observations, cursor } = await adapter.list(loaded.scenario.since, undefined)

  assert.equal(observations.length, 3, '三条线程')
  assert.equal(cursor, null)

  for (const observation of observations) {
    for (const field of ['source', 'ref', 'external_id', 'title', 'excerpt', 'at', 'due_at', 'due_kind', 'people', 'state']) {
      assert.ok(field in observation, `观察缺字段 ${field}`)
    }
    assert.equal(observation.source, 'composio:gmail')
    assert.match(observation.ref, REF_PATTERN)
    assert.equal(observation.due_at, null)
    assert.equal(observation.due_kind, null)
  }

  const first = observations[0]
  assert.equal(first.ref, 'composio:gmail:thread/t1')
  assert.equal(first.title, '产品评审会')
  assert.equal(first.at, '2025-10-31T07:30:00.000Z')
  assert.ok(first.people.some(person => person.includes('lina@example.com')), '发件人算这条的参与人')
  assert.ok(first.excerpt.includes('Date:'), 'excerpt 只有邮件头')

  // 只落在线程路径上：没有正文参数、没有附件路径、没有写端点。
  for (const call of calls) {
    assert.equal(call.kind, 'proxyGet')
    assert.match(call.endpoint, /^\/gmail\/v1\/users\/me\/threads/)
    assert.doesNotMatch(call.endpoint, /\/messages\//)
    assert.doesNotMatch(call.endpoint, /attachments|body|parts|snippet/i)
  }
})

test('get returns the observation for a ref and null for anything else', async () => {
  const adapter = gmailAdapter()
  const observation = await adapter.get('composio:gmail:thread/t2')
  assert.equal(observation.ref, 'composio:gmail:thread/t2')
  assert.equal(observation.title, '季度预算对一下')
  assert.equal(await adapter.get('composio:notion:page/p1'), null)
  assert.equal(await adapter.get('composio:gmail:thread/'), null)
})

test('auth is the per-person account state, not a guess', () => {
  const adapter = gmailAdapter()
  assert.deepEqual(adapter.auth(), { ok: true, reason: null })

  const expired = resolveAccount(
    [{ id: 'ca-gmail-old', toolkit: { slug: 'gmail' }, user_id: 'flybot-01', status: 'EXPIRED' }],
    { toolkit: 'gmail', userId: 'flybot-01' },
  )
  const stale = createGmailAdapter({ account: expired, transport: transportFor(loaded) })
  assert.deepEqual(stale.auth(), { ok: false, reason: 'expired' })
})

test('the adapter id and readScope are the registry row, exported once', () => {
  assert.equal(id, 'composio:gmail')
  assert.equal(readScope, 'metadata')
})
