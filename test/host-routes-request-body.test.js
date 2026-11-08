import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerMuseHostRoutes } from '../src/web/dsh-host-routes.js'

// dsh answers 400 to a route registered without requestBody; digest-status did that, so the page's
// digest progress poll and the Settings digest-mode read always failed.
test('every Muse host route declares requestBody', () => {
  const routes = []
  const ctx = {
    effect: dispose => { dispose(); return () => {} },
    sessionController: { async resolveAgent() { return null }, async page() { return { records: [] } } },
    connection: { fetch: { register: route => { routes.push(route); return () => {} } } },
  }
  const router = new Proxy({}, { get: () => () => ({}) })
  registerMuseHostRoutes(ctx, { router, dshHome: '/nonexistent' })
  assert.ok(routes.some(r => r.path === '/api/opendigitalmate/digest-status'))
  assert.deepEqual(routes.filter(r => !r.requestBody).map(r => r.path), [])
})
