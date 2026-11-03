import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApiRouter } from '../src/web/api.js'
import { createConfigStore } from '../src/web/config-store.js'

const LLM_KEY = 'sk-test-llm-0123456789abcdef'
const CP_KEY = 'ak_test_composio_0123456789'

async function makeRouter({ client, flat = true, injectProxy = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'odm-cfg-'))
  writeFileSync(join(home, 'config.json'), JSON.stringify(flat
    ? { composioApiKey: CP_KEY, composioEntityId: 'default', digestSchedule: '08:00', llm: { provider: 'deepseek', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: LLM_KEY } }
    : {}))
  const configStore = createConfigStore(join(home, 'config.json'))
  await configStore.load()
  const state = { cards: [], completions: [] }
  const store = { get: () => state, save: async s => Object.assign(state, s), load: async () => state }
  // dsh's plugin ctx is an inject-only proxy: reading an unknown property throws.
  const proxy = new Proxy({}, { get: (_, k) => { throw new Error(`cannot get property "${String(k)}" without inject`) } })
  const ctx = { store, config: { home, dataDir: home }, configStore, ...(injectProxy ? { ctx: proxy } : {}) }
  if (client) ctx.composioClient = client
  return { router: createApiRouter(ctx), home }
}

test('every router method the dsh host routes call exists (no silent `?.() ?? {}` fallbacks)', async () => {
  const src = readFileSync(new URL('../src/web/dsh-host-routes.js', import.meta.url), 'utf8')
  const called = [...new Set([...src.matchAll(/router\.([A-Za-z_]\w*)/g)].map(m => m[1]))]
  assert.ok(called.length > 10)
  const { router } = await makeRouter()
  const missing = called.filter(m => typeof router[m] !== 'function' && !['requestAction', 'actionsOp'].includes(m))
  assert.deepEqual(missing, [])
  assert.doesNotMatch(src, /router\.\w+\?\.\(/, 'optional-call fallbacks hide renamed router methods')
})

test('配置 page reads the saved model + Composio config (flat keys), never the raw keys', async () => {
  const { router } = await makeRouter({ client: { getConnectedAccounts: async () => ({ items: [] }) }, injectProxy: true })
  const llm = await router.getLLMConfig()
  assert.equal(llm.configured, true)
  assert.equal(llm.provider, 'deepseek')
  assert.equal(llm.model, 'deepseek-chat')
  assert.match(llm.apiKey, /\.\.\./)
  const cp = await router.getComposioConfig()
  assert.equal(cp.configured, true)
  assert.equal(cp.apiKeyPresent, true)
  assert.match(cp.apiKeyMasked, /\.\.\./)
  assert.equal(cp.entityId, 'default')
  const chk = await router.checkConfig() // used to throw: cannot get property "llm" without inject
  assert.equal(chk.llmConfigured, true)
  assert.equal(chk.composioApiKey, true)
  const all = JSON.stringify({ llm, cp, chk })
  assert.ok(!all.includes(LLM_KEY) && !all.includes(CP_KEY), 'full keys must never reach the client')
})

test('信源状态: a hung Composio call is cut off and marked, not left loading forever', async () => {
  process.env.ODM_SOURCES_TIMEOUT_MS = '150'
  const { router } = await makeRouter({ client: { getConnectedAccounts: () => new Promise(() => {}) } })
  const t0 = Date.now()
  const r = await router.getComposioApps()
  assert.ok(Date.now() - t0 < 1000)
  assert.equal(r.status.unknown, true)
  assert.match(r.status.error, /没响应/)
  assert.ok(r.apps.length > 0)
  delete process.env.ODM_SOURCES_TIMEOUT_MS
})

test('信源状态: last-known status answers at once while a slow probe refreshes in the background', async () => {
  let calls = 0, slow = false
  const client = { getConnectedAccounts: async () => { calls++; if (slow) await new Promise(r => setTimeout(r, 400)); return { items: [{ id: 'c1', status: 'ACTIVE', toolkit: { slug: 'github' } }] } } }
  const { router, home } = await makeRouter({ client })
  const first = await router.getComposioApps()
  assert.equal(first.apps.find(a => a.key === 'github').connected, true)
  assert.ok(existsSync(join(home, 'sources-cache.json')), 'last-known status is kept on disk for the next restart')
  const cached = await router.getComposioApps()
  assert.equal(cached.status.cached, true)
  assert.equal(calls, 1)
  // after a restart: the disk cache paints instantly (stale) while the live probe runs
  slow = true
  const cache = JSON.parse(readFileSync(join(home, 'sources-cache.json'), 'utf8'))
  writeFileSync(join(home, 'sources-cache.json'), JSON.stringify({ ...cache, at: new Date(Date.now() - 3600e3).toISOString() }))
  const store = { get: () => ({ cards: [] }), save: async () => {}, load: async () => {} }
  const cs = createConfigStore(join(home, 'config.json')); await cs.load()
  const r3 = createApiRouter({ store, config: { home, dataDir: home }, configStore: cs, composioClient: client })
  const t0 = Date.now()
  const stale = await r3.getComposioApps()
  assert.ok(Date.now() - t0 < 200, 'stale status must not wait for the probe')
  assert.equal(stale.status.stale, true)
  assert.equal(stale.apps.find(a => a.key === 'github').connected, true)
  const fresh = await r3.getComposioApps({ fresh: true })
  assert.equal(fresh.status.stale, false)
  assert.equal(fresh.status.error, null)
})
