import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CALLBACK_PATH, MESSAGE_TYPE, requestOrigin, callbackUrlFor, callbackPage } from '../src/web/composio-callback.js'

const req = (url, headers = {}) => ({ url, headers: new Headers(headers) })

test('requestOrigin prefers the browser Origin, then Referer, then Host', () => {
  assert.equal(requestOrigin(req('http://x/api', { origin: 'http://127.0.0.1:8123' })), 'http://127.0.0.1:8123')
  assert.equal(requestOrigin(req('http://x/api', { referer: 'http://localhost:9000/app?x=1' })), 'http://localhost:9000')
  assert.equal(requestOrigin(req('http://x/api', { host: '127.0.0.1:7788', 'x-forwarded-proto': 'https' })), 'https://127.0.0.1:7788')
  assert.equal(requestOrigin(req('http://127.0.0.1:5555/api/composio/connect')), 'http://127.0.0.1:5555')
})

test('callbackUrlFor follows the request origin, with a fallback', () => {
  assert.equal(callbackUrlFor('http://127.0.0.1:8123'), `http://127.0.0.1:8123${CALLBACK_PATH}`)
  assert.equal(callbackUrlFor('http://127.0.0.1:8123/'), `http://127.0.0.1:8123${CALLBACK_PATH}`)
  assert.match(callbackUrlFor(null), /^http:\/\/127\.0\.0\.1:7777\/composio-callback$/)
})

const payloadOf = (html) => JSON.parse(html.match(/var msg = (\{.*?\});/)[1])

test('success page: logo, title, payload to opener, auto-close then 信源 redirect', () => {
  const html = callbackPage({ status: 'success', connectedAccountId: 'ca_X1', toolkit: 'gmail', accountStatus: 'ACTIVE' })
  assert.match(html, /Gmail 已连接/)
  assert.match(html, /<svg/)
  assert.match(html, /window\.opener/)
  assert.match(html, /window\.close\(\)/)
  assert.match(html, /\/api\/opendigitalmate\/app#sources/)
  const p = payloadOf(html)
  assert.deepEqual([p.type, p.status, p.connectedAccountId, p.toolkit], [MESSAGE_TYPE, 'success', 'ca_X1', 'gmail'])
  assert.equal(p.error, null)
})

test('failure page shows the error and a retry hint, escapes HTML', () => {
  const html = callbackPage({ status: 'failed', error: 'access_denied <script>x</script>' })
  assert.match(html, /access_denied &lt;script&gt;/)
  assert.doesNotMatch(html, /<script>x<\/script>/)
  assert.match(html, /再点一次|重试|再试/)
  const p = payloadOf(html)
  assert.equal(p.status, 'failed')
  assert.match(p.error, /access_denied/)
})

test('success claimed but account not ACTIVE is reported honestly', () => {
  const html = callbackPage({ status: 'success', connectedAccountId: 'ca_X1', toolkit: 'gmail', accountStatus: 'FAILED' })
  assert.doesNotMatch(html, /Gmail 已连接/)
})
