// Composio v3 控制面的传输层（#32 S3）。
//
// 这里不联网、不要 key：一个本地假服务器按 `test/fixtures/composio/api/routes.json` 回放，
// 并且把每一次请求（方法 / 路径 / 查询串 / body / 头）记下来。四条用例钉死：
//   - 账号表只用复数参数 `toolkit_slugs` + `user_ids`（单数会被静默忽略 → 回全部 30 条）；
//   - 第三方的读请求永远是 `POST /tools/execute/proxy` + `method: 'GET'`；
//   - 除 `/tools/execute/` 之外一个 POST 都没有；
//   - 限流（429）与服务器错误（5xx）各是各的 kind，不混成一条；key 不进错误消息。

import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { readFileSync } from 'node:fs'

import { callError, createComposioApi } from '../../src/sources/composio/api.js'

const FIXTURE = JSON.parse(
  readFileSync(new URL('../fixtures/composio/api/routes.json', import.meta.url), 'utf8'),
)
const ROUTES = FIXTURE.routes

function matches(route, url) {
  return Object.entries(route.match ?? {}).every(
    ([key, value]) => url.searchParams.get(key) === String(value),
  )
}

async function fakeServer(t) {
  const seen = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let body = null
      if (raw) {
        try {
          body = JSON.parse(raw)
        } catch {
          body = raw
        }
      }
      seen.push({
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body,
        headers: req.headers,
      })

      const route = ROUTES.find(
        item => item.method === req.method && item.path === url.pathname && matches(item, url),
      )
      if (!route) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ message: 'no fixture route' }))
        return
      }
      res.writeHead(route.status ?? 200, {
        'content-type': 'application/json',
        ...(route.headers ?? {}),
      })
      res.end(JSON.stringify(route.body))
    })
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const { port } = server.address()
  return { baseUrl: `http://127.0.0.1:${port}`, seen }
}

test('the account lookup asks with toolkit_slugs and user_ids, never the singular form', async (t) => {
  const srv = await fakeServer(t)
  const api = createComposioApi({ apiKey: 'test-key', baseUrl: srv.baseUrl })

  const page = await api.listAccounts({ toolkitSlugs: 'gmail', userIds: 'default' })
  assert.equal(page.items.length, 5, '复数参数应该只回 5 条（这个人 × 这个 app）')

  const call = srv.seen.at(-1)
  assert.equal(call.query.toolkit_slugs, 'gmail')
  assert.equal(call.query.user_ids, 'default')
  assert.equal(call.query.limit, '100')
  assert.equal('toolkit_slug' in call.query, false)
  assert.equal('user_id' in call.query, false)

  // 这就是那条实测陷阱：单数参数被服务端静默忽略、回全部 30 条（「按人」变「按所有人」）。
  const trap = await (await fetch(`${srv.baseUrl}/connected_accounts?toolkit_slug=gmail&limit=100`)).json()
  assert.equal(trap.items.length, 30)

  const before = srv.seen.length
  // 单数键在发请求之前就拒：不会拿着「所有人的账号」当「这个人的」。
  assert.throws(() => api.listAccounts({ toolkitSlug: 'gmail', userIds: 'default' }), /E_ACCOUNT_QUERY/)
  assert.throws(() => api.listAccounts({ toolkitSlugs: 'gmail', userId: 'default' }), /E_ACCOUNT_QUERY/)
  // 只给 app 不给「人」，等于所有人的账号，也拒。
  assert.throws(() => api.listAccounts({ toolkitSlugs: 'gmail' }), /E_ACCOUNT_QUERY/)
  assert.throws(() => api.listAccounts({ userIds: 'default' }), /E_ACCOUNT_QUERY/)
  // 全是同步抛，一条请求都没发出去。
  assert.equal(srv.seen.length, before)
})

test('the proxy only ever issues a GET', async (t) => {
  const srv = await fakeServer(t)
  const api = createComposioApi({ apiKey: 'test-key', baseUrl: srv.baseUrl })

  const result = await api.proxyGet({
    connectedAccountId: 'ca_gmail_default_1',
    endpoint: '/gmail/v1/users/me/profile?format=metadata',
  })
  assert.deepEqual(result.data, { messagesTotal: 3, threadsTotal: 3 })

  const call = srv.seen.at(-1)
  assert.equal(call.method, 'POST')
  assert.equal(call.path, '/tools/execute/proxy')
  assert.equal(call.body.method, 'GET')
  assert.equal(call.body.connected_account_id, 'ca_gmail_default_1')
  assert.equal(call.body.endpoint, '/gmail/v1/users/me/profile?format=metadata')
  assert.equal(call.headers['x-api-key'], 'test-key')

  // 对第三方发什么方法不由调用方决定。
  assert.throws(
    () => api.proxyGet({ connectedAccountId: 'ca_gmail_default_1', endpoint: '/x', method: 'POST' }),
    /E_PROXY_METHOD/,
  )
  assert.throws(
    () => api.proxyGet({ connectedAccountId: 'ca_gmail_default_1', endpoint: 'gmail/v1/x' }),
    /E_PROXY_ENDPOINT/,
  )
})

test('a POST is only sent to the tools execute endpoint', async (t) => {
  const srv = await fakeServer(t)
  const api = createComposioApi({ apiKey: 'test-key', baseUrl: srv.baseUrl })

  await api.listTools({ toolkitSlug: 'gmail' })
  await api.listAccounts({ toolkitSlugs: 'gmail', userIds: 'default' })
  await api.proxyGet({ connectedAccountId: 'ca_gmail_default_1', endpoint: '/gmail/v1/users/me/profile' })
  await api.executeTool({
    toolSlug: 'GMAIL_FETCH_EMAILS',
    connectedAccountId: 'ca_gmail_default_1',
    arguments: { max_results: 5 },
  })

  const posts = srv.seen.filter(call => call.method !== 'GET')
  assert.equal(posts.length, 2, '四次调用里只有两次 POST')
  for (const call of posts) assert.match(call.path, /^\/tools\/execute\//)
  assert.deepEqual(posts.map(call => call.path).sort(), [
    '/tools/execute/GMAIL_FETCH_EMAILS',
    '/tools/execute/proxy',
  ])

  const reads = srv.seen.filter(call => call.method === 'GET')
  assert.deepEqual(reads.map(call => call.path).sort(), ['/connected_accounts', '/tools'])
  // `/tools` 这个端点的单数参数是真的生效的（陷阱只在 `/connected_accounts`）。
  assert.equal(reads.find(call => call.path === '/tools').query.toolkit_slug, 'gmail')

  const exec = posts.find(call => call.path === '/tools/execute/GMAIL_FETCH_EMAILS')
  assert.deepEqual(exec.body, {
    arguments: { max_results: 5 },
    connected_account_id: 'ca_gmail_default_1',
  })
})

test('a rate limit and a server error are told apart, not collapsed into one error', async (t) => {
  const srv = await fakeServer(t)

  assert.deepEqual(callError({ status: 401 }), { kind: 'auth', status: 401, reason: 'unauthorized' })
  assert.deepEqual(callError({ status: 403, body: { error: { message: 'insufficientPermissions' } } }), {
    kind: 'scope',
    status: 403,
    reason: 'scope',
  })
  assert.deepEqual(callError({ status: 403 }), { kind: 'auth', status: 403, reason: 'forbidden' })
  assert.deepEqual(callError({ status: 404 }), { kind: 'missing', status: 404, reason: 'not-found' })
  assert.deepEqual(callError({ status: 429 }), { kind: 'rate_limit', status: 429, reason: 'rate-limited' })
  assert.deepEqual(callError({ status: 503 }), { kind: 'server', status: 503, reason: 'server-error' })
  assert.deepEqual(callError({}), { kind: 'network', status: null, reason: 'network-error' })

  const api = createComposioApi({ apiKey: 'test-key', baseUrl: srv.baseUrl })
  await assert.rejects(api.listTools({ toolkitSlug: 'limited' }), error => {
    assert.equal(error.code, 'E_COMPOSIO')
    assert.equal(error.kind, 'rate_limit')
    assert.equal(error.status, 429)
    assert.equal(error.retry_after_ms, 2000)
    assert.equal(error.message.includes('test-key'), false, 'key 不进错误消息')
    return true
  })

  // 请求根本没发出去也不能冒充「服务器错误」。
  const offline = createComposioApi({
    apiKey: 'test-key',
    baseUrl: srv.baseUrl,
    fetch: async () => {
      throw new Error('offline')
    },
  })
  await assert.rejects(offline.listTools({ toolkitSlug: 'gmail' }), error => {
    assert.equal(error.kind, 'network')
    assert.equal(error.status, null)
    return true
  })

  // 没有 key 就不建 client：key 只从调用方传，不读环境变量。
  assert.throws(() => createComposioApi({ baseUrl: srv.baseUrl }), /E_COMPOSIO_KEY/)
})
