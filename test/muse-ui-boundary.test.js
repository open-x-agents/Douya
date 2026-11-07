import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { apply } from '../packages/dsh-muse-ui/index.js'
import {
  MUSE_APP_PATH,
  MUSE_UI_RENDERER_PATH,
  MUSE_LOGO_PATH,
  readIndexHtml,
} from '../packages/dsh-muse-ui/static-serve.js'

const hostRoutes = readFileSync(new URL('../src/web/dsh-host-routes.js', import.meta.url), 'utf8')
const hostApi = readFileSync(new URL('../src/web/api.js', import.meta.url), 'utf8')
const hostPkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const hostCordis = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

test('host publishable surface has no Muse client / dsh.client', () => {
  assert.equal(hostPkg.dsh?.client, undefined)
  assert.ok(!hostPkg.exports?.['./client'])
  assert.ok(!(hostPkg.files || []).includes('client.js'))
  assert.ok(!(hostPkg.files || []).some(f => f.includes('packages/dsh-muse-ui')))
})

test('host cordis does not disable stock ui-* (that is the Muse plugin)', () => {
  assert.doesNotMatch(hostCordis, /ui-layout/)
  assert.doesNotMatch(hostCordis, /ui-sidebar/)
  assert.doesNotMatch(hostCordis, /ui-conversation/)
})

test('negative: host dsh routes do not register Muse static paths', () => {
  assert.ok(!hostRoutes.includes(`path: '${MUSE_APP_PATH}'`))
  assert.ok(!hostRoutes.includes(`path: '${MUSE_UI_RENDERER_PATH}'`))
  assert.ok(!hostRoutes.includes(`path: '${MUSE_LOGO_PATH}'`))
})

test('host api.js does not hardcode packages/dsh-muse-ui asset paths', () => {
  assert.doesNotMatch(hostApi, /packages\/dsh-muse-ui\/static/)
  assert.match(hostApi, /dsh-muse-ui\/static-serve/)
})

test('positive: muse plugin serves app + ui-renderer + logo; HTML is Douya', async () => {
  const handlers = {}
  apply({
    effect(fn) { fn(); return () => {} },
    connection: { fetch: { register(route) { handlers[route.path] = route.fetch } } },
  })
  assert.deepEqual(Object.keys(handlers).sort(), [MUSE_APP_PATH, MUSE_LOGO_PATH, MUSE_UI_RENDERER_PATH].sort())

  const app = await handlers[MUSE_APP_PATH]()
  const html = await app.text()
  assert.equal(app.status, 200)
  assert.match(app.headers.get('content-type') || '', /text\/html/)
  assert.match(html, /Douya|豆芽|Open Digital Mate/)

  const ui = await handlers[MUSE_UI_RENDERER_PATH]()
  assert.equal(ui.status, 200)
  assert.match(await ui.text(), /renderSurface|function/)

  const logo = await handlers[MUSE_LOGO_PATH](new Request(`http://x${MUSE_LOGO_PATH}?app=github`))
  assert.equal(logo.status, 200)
  assert.match(logo.headers.get('content-type') || '', /svg/)

  const direct = await readIndexHtml()
  assert.equal(direct, html)
})
