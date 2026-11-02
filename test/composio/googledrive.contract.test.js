// Google Drive 契约（#32 S6）：五成员、只 metadata、只 GET 文件元数据、没有写方法。
//
// 这里钉死的是「只读边界」是怎么落地的：请求路径只能落在 `/drive/v3/files*`，`fields` 里
// 只有名字 / 类型 / 修改时间 / 属主（没有 content、没有 permissions、没有 export / alt=media），
// 观测里只有元数据拼出来的 `excerpt`，ref 形如 `composio:googledrive:file/<id>`。
// 写动作一个方法名都不许出现。

import test from 'node:test'
import assert from 'node:assert/strict'

import { READ_MEMBERS, REF_PATTERN } from '../../src/sources/composio/adapter.js'
import { createGoogledriveAdapter, id, readScope } from '../../src/sources/composio/googledrive.js'
import { resolveAccount } from '../../src/sources/composio/accounts.js'

const FILE = {
  id: 'f1',
  name: '季度计划.docx',
  mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  modifiedTime: '2025-10-31T07:30:00.000Z',
  owners: [{ displayName: '李娜', emailAddress: 'lina@example.com' }],
}

const SECOND = {
  id: 'f2',
  name: '预算表',
  mimeType: 'application/vnd.google-apps.spreadsheet',
  modifiedTime: '2025-10-30T09:00:00.000Z',
  owners: [],
}

const ACTIVE = { state: 'ok', reason: null, account_id: 'ca-drive-1' }

// 假 transport：列表回两条、单条回 FILE，并把每次请求原样记下来给断言看。
function driveTransport(calls = []) {
  return {
    async proxyGet({ connectedAccountId, endpoint }) {
      calls.push({ connectedAccountId, endpoint })
      if (/^\/drive\/v3\/files\?/.test(endpoint)) {
        return { files: [FILE, SECOND], nextPageToken: 'p2' }
      }
      if (/^\/drive\/v3\/files\/f1\?/.test(endpoint)) return structuredClone(FILE)
      if (/^\/drive\/v3\/files\/f2\?/.test(endpoint)) return structuredClone(SECOND)
      throw new Error(`E_TEST_ROUTE: ${endpoint}`)
    },
  }
}

function driveAdapter(calls) {
  return createGoogledriveAdapter({ account: ACTIVE, transport: driveTransport(calls) })
}

test('the googledrive adapter has only the five read members and no write method', () => {
  const adapter = driveAdapter()
  for (const member of READ_MEMBERS) assert.ok(member in adapter, `缺成员 ${member}`)
  assert.equal(adapter.id, 'composio:googledrive')
  assert.equal(adapter.readScope, 'metadata')
  for (const write of ['send', 'create', 'update', 'delete', 'share', 'move', 'copy', 'upload', 'trash', 'rename']) {
    assert.equal(write in adapter, false, `适配器上不该有写方法 ${write}`)
  }
})

test('list reads file metadata from /drive/v3/files only, never export or write endpoints', async () => {
  const calls = []
  const adapter = driveAdapter(calls)
  const { observations, cursor } = await adapter.list('2025-10-30T00:00:00.000Z', undefined)

  assert.equal(observations.length, 2, '两条文件')
  assert.equal(cursor, 'p2')

  for (const observation of observations) {
    for (const field of ['source', 'ref', 'external_id', 'title', 'excerpt', 'at', 'due_at', 'due_kind', 'people', 'state']) {
      assert.ok(field in observation, `观察缺字段 ${field}`)
    }
    assert.equal(observation.source, 'composio:googledrive')
    assert.match(observation.ref, REF_PATTERN)
    assert.equal(observation.due_at, null)
    assert.equal(observation.due_kind, null)
  }

  const first = observations[0]
  assert.equal(first.ref, 'composio:googledrive:file/f1')
  assert.equal(first.title, '季度计划.docx')
  assert.equal(first.at, '2025-10-31T07:30:00.000Z')
  assert.deepEqual(first.people, ['李娜'])
  assert.match(first.excerpt, /wordprocessingml\.document/)
  assert.match(first.excerpt, /2025-10-31T07:30:00\.000Z/)

  // 只落在文件元数据路径上：没有内容下载、没有导出、没有权限、没有写端点。
  assert.equal(calls.length, 1)
  for (const call of calls) {
    assert.equal(call.connectedAccountId, 'ca-drive-1')
    assert.match(call.endpoint, /^\/drive\/v3\/files\?/)
    assert.match(call.endpoint, /fields=/)
    assert.match(call.endpoint, /modifiedTime/, 'since 折成 modifiedTime 查询')
    assert.doesNotMatch(call.endpoint, /export|alt=media|content|upload|permissions|copy|trash|delete/i)
  }
})

test('get returns the observation for a ref and null for anything else', async () => {
  const calls = []
  const adapter = driveAdapter(calls)
  const observation = await adapter.get('composio:googledrive:file/f2')
  assert.equal(observation.ref, 'composio:googledrive:file/f2')
  assert.equal(observation.title, '预算表')
  assert.deepEqual(observation.people, [])
  assert.equal(await adapter.get('composio:gmail:thread/t1'), null)
  assert.equal(await adapter.get('composio:googledrive:file/'), null)

  for (const call of calls) {
    assert.match(call.endpoint, /^\/drive\/v3\/files\/f2\?fields=/)
    assert.doesNotMatch(call.endpoint, /export|alt=media|content|upload|permissions|copy|trash|delete/i)
  }
})

test('auth is the per-person account state, not a guess', () => {
  const adapter = driveAdapter()
  assert.deepEqual(adapter.auth(), { ok: true, reason: null })

  const expired = resolveAccount(
    [{ id: 'ca-drive-old', toolkit: { slug: 'googledrive' }, user_id: 'flybot-01', status: 'EXPIRED' }],
    { toolkit: 'googledrive', userId: 'flybot-01' },
  )
  const stale = createGoogledriveAdapter({ account: expired, transport: driveTransport() })
  assert.deepEqual(stale.auth(), { ok: false, reason: 'expired' })
})

test('the adapter id and readScope are the registry row, exported once', () => {
  assert.equal(id, 'composio:googledrive')
  assert.equal(readScope, 'metadata')
})
