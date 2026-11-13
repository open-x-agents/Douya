import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApiRouter } from '../src/web/api.js'
import { createConfigStore } from '../src/web/config-store.js'
import {
  needsSetup,
  setupStatus,
  hasSavedConfig,
  isUserApiKey,
  testComposioKey,
  redactSecret,
  PROVIDER_PRESETS,
  COMPOSIO_DASHBOARD_URL,
  COMPOSIO_AUTH_DOCS_URL,
  WIZARD_STEPS,
} from '../src/web/setup-wizard.js'
import { messages } from '../src/i18n/messages.js'
import { t } from '../src/i18n/index.js'
import { readIndexHtml } from '../packages/dsh-muse-ui/static-serve.js'

const LLM_KEY = 'sk-test-llm-0123456789abcdef'
const CP_KEY = 'ak_test_composio_0123456789'

async function makeRouter(config = {}) {
  const home = mkdtempSync(join(tmpdir(), 'odm-wiz-'))
  writeFileSync(join(home, 'config.json'), JSON.stringify(config))
  const configStore = createConfigStore(join(home, 'config.json'))
  await configStore.load()
  const state = { cards: [], completions: [] }
  const store = { get: () => state, save: async s => Object.assign(state, s), load: async () => state }
  const ctx = { store, config: { home, dataDir: home }, configStore }
  return { router: createApiRouter(ctx), home, configStore }
}

test('needsSetup: first run with nothing configured opens the wizard', () => {
  assert.equal(needsSetup({}), true)
  assert.equal(needsSetup({ llmConfigured: false, composioConfigured: false, wizardCompleted: false }), true)
})

test('needsSetup: missing model always opens, even if Composio is set', () => {
  assert.equal(needsSetup({ llmConfigured: false, composioConfigured: true, hasSavedConfig: true }), true)
})

test('needsSetup: finished or skipped wizard does not auto-open', () => {
  assert.equal(needsSetup({ llmConfigured: false, wizardCompleted: true }), false)
  assert.equal(needsSetup({ llmConfigured: true, composioConfigured: false, wizardCompleted: true }), false)
})

test('needsSetup: existing install with a saved model is not interrupted just because Composio is empty', () => {
  assert.equal(needsSetup({
    llmConfigured: true,
    composioConfigured: false,
    wizardCompleted: false,
    hasSavedConfig: true,
  }), false)
})

test('needsSetup: genuine first run with a host/env model still offers the Composio step', () => {
  assert.equal(needsSetup({
    llmConfigured: true,
    composioConfigured: false,
    wizardCompleted: false,
    hasSavedConfig: false,
  }), true)
})

test('needsSetup: fully configured is quiet', () => {
  assert.equal(needsSetup({
    llmConfigured: true,
    composioConfigured: true,
    hasSavedConfig: true,
  }), false)
})

test('setupStatus and hasSavedConfig reflect the config file, not env secrets', () => {
  assert.equal(hasSavedConfig({}), false)
  assert.equal(hasSavedConfig({ composioEntityId: 'default', digestSchedule: '08:00' }), false)
  assert.equal(hasSavedConfig({ updatedAt: '2026-11-13T00:00:00Z' }), true)
  assert.equal(hasSavedConfig({ llm: { apiKey: 'sk-x' } }), true)
  const s = setupStatus({ llmConfigured: true, composioConfigured: false, hasSavedConfig: true })
  assert.equal(s.needsSetup, false)
  assert.equal(s.wizardCompleted, false)
})

test('wizard is exactly two steps: model, then Composio', () => {
  assert.deepEqual(WIZARD_STEPS, ['model', 'composio'])
  assert.ok(PROVIDER_PRESETS.deepseek.model)
  assert.equal(PROVIDER_PRESETS.deepseek.baseURL, 'https://api.deepseek.com/v1')
  assert.match(COMPOSIO_DASHBOARD_URL, /^https:\/\/platform\.composio\.dev/)
  assert.match(COMPOSIO_AUTH_DOCS_URL, /docs\.composio\.dev/)
})

test('isUserApiKey detects uak_ keys that cannot be used as x-api-key', () => {
  assert.equal(isUserApiKey('uak_abc123'), true)
  assert.equal(isUserApiKey('  UAK_xyz  '), true)
  assert.equal(isUserApiKey(CP_KEY), false)
  assert.equal(isUserApiKey(''), false)
})

test('redactSecret never leaves the raw key in an error string', () => {
  assert.equal(redactSecret(`bad key ${CP_KEY} end`, CP_KEY), 'bad key [redacted] end')
  assert.equal(redactSecret('nothing here', CP_KEY), 'nothing here')
})

test('testComposioKey: missing / masked / user keys fail without calling fetch', async () => {
  let calls = 0
  const fetchImpl = async () => { calls += 1; return { ok: true, status: 200, text: async () => '' } }
  assert.equal((await testComposioKey('', { fetchImpl })).error, 'missing_key')
  assert.equal((await testComposioKey('ak_12...89', { fetchImpl })).error, 'masked_key')
  assert.equal((await testComposioKey('uak_not_a_project_key', { fetchImpl })).error, 'user_api_key')
  assert.equal(calls, 0)
})

test('testComposioKey: mocked success, 401, timeout; key never appears in the result', async () => {
  const ok = await testComposioKey(CP_KEY, {
    fetchImpl: async (url, opts) => {
      assert.match(url, /connected_accounts/)
      assert.equal(opts.headers['x-api-key'], CP_KEY)
      return { ok: true, status: 200, text: async () => '{}' }
    },
  })
  assert.equal(ok.ok, true)
  assert.equal(ok.status, 200)
  assert.ok(!JSON.stringify(ok).includes(CP_KEY))

  const bad = await testComposioKey(CP_KEY, {
    fetchImpl: async () => ({ ok: false, status: 401, text: async () => `invalid ${CP_KEY}` }),
  })
  assert.equal(bad.ok, false)
  assert.equal(bad.error, 'unauthorized')
  assert.ok(!JSON.stringify(bad).includes(CP_KEY))

  const boom = await testComposioKey(CP_KEY, {
    fetchImpl: async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e },
  })
  assert.equal(boom.error, 'timeout')
})

test('checkConfig reports needsSetup and never leaks keys', async () => {
  const empty = await makeRouter({})
  const fresh = await empty.router.checkConfig()
  assert.equal(fresh.llmConfigured, false)
  assert.equal(fresh.composioApiKey, false)
  assert.equal(fresh.wizardCompleted, false)
  assert.equal(fresh.needsSetup, true)
  assert.equal(fresh.composioDashboardUrl, COMPOSIO_DASHBOARD_URL)

  const full = await makeRouter({
    composioApiKey: CP_KEY,
    composioEntityId: 'default',
    updatedAt: '2026-11-13T00:00:00Z',
    llm: { provider: 'deepseek', apiKey: LLM_KEY, model: 'deepseek-flash', baseURL: 'https://api.deepseek.com/v1' },
  })
  const ready = await full.router.checkConfig()
  assert.equal(ready.needsSetup, false)
  assert.equal(ready.llmConfigured, true)
  assert.equal(ready.composioApiKey, true)
  const dumped = JSON.stringify(ready)
  assert.ok(!dumped.includes(LLM_KEY) && !dumped.includes(CP_KEY))
})

test('completeSetup marks the wizard done so it does not auto-open again', async () => {
  const { router, configStore } = await makeRouter({})
  assert.equal((await router.checkConfig()).needsSetup, true)
  const r = await router.completeSetup({ skippedComposio: true })
  assert.equal(r.success, true)
  assert.equal(r.skippedComposio, true)
  assert.equal(r.needsSetup, false)
  assert.equal(r.wizardCompleted, true)
  const cfg = configStore.get()
  assert.ok(cfg.setupWizardCompletedAt)
  assert.equal(cfg.setupWizardSkippedComposio, true)
  assert.equal((await router.checkConfig()).needsSetup, false)
})

test('update LLM + Composio through existing store paths; testComposio uses the mock, not the network', async () => {
  const prev = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  }
  const { router, configStore } = await makeRouter({})
  const saved = await router.updateLLMConfig({
    provider: 'deepseek',
    baseURL: 'https://api.deepseek.com/v1',
    apiKey: LLM_KEY,
    model: 'deepseek-flash',
  })
  assert.equal(saved.success, true)
  assert.match(saved.masked, /\.\.\./)
  assert.ok(!JSON.stringify(saved).includes(LLM_KEY))
  assert.equal(configStore.get().llm.apiKey, LLM_KEY)

  const fakeFetch = async () => ({ ok: true, status: 200, text: async () => '{"items":[]}' })
  const tested = await router.testComposio({ apiKey: CP_KEY }, { fetchImpl: fakeFetch })
  assert.equal(tested.ok, true)
  assert.ok(!JSON.stringify(tested).includes(CP_KEY))
  // Validation does not write the key by itself.
  assert.equal(configStore.get().composioApiKey, undefined)

  const cp = await router.updateComposioConfig({ apiKey: CP_KEY, entityId: 'default' })
  assert.equal(cp.success, true)
  assert.match(cp.apiKeyMasked, /\.\.\./)
  assert.ok(!JSON.stringify(cp).includes(CP_KEY))
  assert.equal(configStore.get().composioApiKey, CP_KEY)

  const rejected = await router.testComposio({ apiKey: 'uak_from_cli_login' }, {
    fetchImpl: async () => { throw new Error('should not be called') },
  })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.error, 'user_api_key')
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

test('saving Composio without retyping the key keeps the saved key (#217)', async () => {
  const { router, configStore } = await makeRouter({})
  await router.updateComposioConfig({ apiKey: CP_KEY, entityId: 'default' })
  assert.equal(configStore.get().composioApiKey, CP_KEY)

  // Wizard Test / Settings Save with only the masked placeholder send no apiKey.
  const onlyEntity = await router.updateComposioConfig({ entityId: 'me' })
  assert.equal(onlyEntity.success, true)
  assert.equal(configStore.get().composioApiKey, CP_KEY)
  assert.equal(configStore.get().composioEntityId, 'me')
  assert.match(onlyEntity.apiKeyMasked, /\.\.\./)

  for (const apiKey of ['', '   ', configStore.getMaskedKey()]) {
    await router.updateComposioConfig({ apiKey, entityId: 'me' })
    assert.equal(configStore.get().composioApiKey, CP_KEY)
  }

  // A real new key still replaces it.
  await router.updateComposioConfig({ apiKey: ' ' + CP_KEY + '_new ', entityId: 'me' })
  assert.equal(configStore.get().composioApiKey, CP_KEY + '_new')
})

test('existing install with a saved model does not auto-open just for a missing Composio key', async () => {
  const { router } = await makeRouter({
    updatedAt: '2026-11-12T00:00:00Z',
    llm: { provider: 'deepseek', apiKey: LLM_KEY, model: 'deepseek-flash' },
  })
  const chk = await router.checkConfig()
  assert.equal(chk.llmConfigured, true)
  assert.equal(chk.composioApiKey, false)
  assert.equal(chk.hasSavedConfig, true)
  assert.equal(chk.needsSetup, false)
})

test('bilingual wizard copy: en/zh catalogs and HTML data-i18n keys line up', async () => {
  const keys = Object.keys(messages.en).filter((k) => k.startsWith('wizard.'))
  assert.ok(keys.length >= 20)
  for (const k of keys) {
    assert.ok(messages.zh[k], `missing zh ${k}`)
    if (messages.en[k] !== 'Composio') {
      assert.notEqual(messages.en[k], messages.zh[k], `${k} should differ across locales`)
    }
    assert.doesNotMatch(messages.en[k], /lorem|TODO|xxx/i)
    assert.doesNotMatch(messages.zh[k], /lorem|TODO|xxx/i)
  }
  assert.match(t('wizard.title', 'en'), /Welcome to Douya/)
  assert.match(t('wizard.title', 'zh'), /欢迎使用豆芽/)
  assert.match(t('wizard.composio_no_oneclick', 'en'), /doesn’t offer a one-click login/)
  assert.match(t('wizard.composio_no_oneclick', 'zh'), /没有给其他应用提供一键登录/)
  assert.match(t('wizard.err_user_key', 'en'), /uak_/)
  assert.match(t('wizard.skip', 'zh'), /跳过/)

  const html = await readIndexHtml()
  assert.match(html, /id="setupWizard"/)
  assert.match(html, /id="openSetupWizardBtn"/)
  assert.match(html, /id="wizLlmProvider"/)
  assert.match(html, /id="wizComposioKey"/)
  assert.match(html, /id="wizSkip"/)
  assert.match(html, /id="wizFinish"/)
  assert.match(html, /id="langSwitchWizard"/)
  assert.match(html, /data-i18n="wizard\.title"/)
  assert.match(html, /data-i18n="wizard\.composio_no_oneclick"/)
  assert.match(html, /href="https:\/\/platform\.composio\.dev"/)
  // Injected assets from static-serve.
  assert.match(html, /\.setup-wiz\{/)
  assert.match(html, /odmOpenSetupWizard/)
  // Every wizard data-i18n key exists in the catalog.
  const used = [...html.matchAll(/data-i18n="(wizard\.[^"]+)"/g)].map((m) => m[1])
  assert.ok(used.length > 8)
  for (const k of used) assert.ok(messages.en[k] && messages.zh[k], `HTML key missing from catalog: ${k}`)
  // Host routes are registered (requestBody included).
  const routes = readFileSync(new URL('../src/web/dsh-host-routes.js', import.meta.url), 'utf8')
  assert.match(routes, /path: '\/api\/composio\/test'/)
  assert.match(routes, /path: '\/api\/setup\/complete'/)
  assert.match(routes, /requestBody: 'buffered'/)
})

test('wizard client talks only to existing save/test paths plus the two new routes; no secrets in source', () => {
  const js = readFileSync(new URL('../packages/dsh-muse-ui/static/setup-wizard.js', import.meta.url), 'utf8')
  const css = readFileSync(new URL('../packages/dsh-muse-ui/static/setup-wizard.css', import.meta.url), 'utf8')
  assert.match(js, /\/api\/llm\/config/)
  assert.match(js, /\/api\/llm\/test/)
  assert.match(js, /\/api\/composio\/config/)
  assert.match(js, /\/api\/composio\/test/)
  assert.match(js, /\/api\/setup\/complete/)
  assert.match(js, /\/api\/config\/check/)
  assert.doesNotMatch(js, /sk-[a-zA-Z0-9]{10,}/)
  assert.doesNotMatch(js, /COMPOSIO_API_KEY\s*=\s*['"][^'"]+['"]/)
  assert.match(css, /backdrop-filter/)
  assert.match(css, /#f4f2ee|#fff|rgba\(255,255,255/)
})

test('wizard Next saves edits to an already-configured model instead of dropping them (#215)', async () => {
  const { runInNewContext } = await import('node:vm')
  const js = readFileSync(new URL('../packages/dsh-muse-ui/static/setup-wizard.js', import.meta.url), 'utf8')
  const window = {}
  runInNewContext(js, {
    window,
    document: { readyState: 'complete', getElementById: () => null, addEventListener() {}, querySelectorAll: () => [] },
    location: { hash: '', pathname: '/', search: '' },
    history: { replaceState() {} },
    fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
    console,
  })
  const changed = window.odmWizardModelChanged
  assert.equal(typeof changed, 'function')
  const saved = { provider: 'deepseek', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-flash' }
  // Untouched form: Next may skip saving.
  assert.equal(changed(saved, { ...saved, apiKey: '' }), false)
  assert.equal(changed(saved, { ...saved, model: ' deepseek-flash ', apiKey: '  ' }), false)
  // Any edit must be saved.
  assert.equal(changed(saved, { ...saved, apiKey: 'new-key' }), true)
  assert.equal(changed(saved, { ...saved, provider: 'openai' }), true)
  assert.equal(changed(saved, { ...saved, baseURL: 'https://example.test/v1' }), true)
  assert.equal(changed(saved, { ...saved, model: 'other-model' }), true)
  // onNext gates the save on this check, not only on modelReady.
  assert.match(js, /!modelReady \|\| modelFormChanged\(loadedModel, readModelForm\(\)\)/)
})

test('updateLLMConfig syncs the key into DSH_HOME/.credentials.yaml (packaged-app path)', async () => {
  const prev = process.env.DSH_HOME
  const dshHome = mkdtempSync(join(tmpdir(), 'odm-dshhome-'))
  // A packaged install already has a login grant in this file; the sync must keep it.
  writeFileSync(join(dshHome, '.credentials.yaml'), [
    'version: 1',
    'records:',
    '  client-connection/browser-session:',
    '    kind: grant',
    '    payload:',
    '      secret: keep-login',
    '',
  ].join('\n'), { mode: 0o600 })
  process.env.DSH_HOME = dshHome
  try {
    const { router } = await makeRouter({})
    const saved = await router.updateLLMConfig({
      provider: 'deepseek',
      baseURL: 'https://api.deepseek.com/v1',
      apiKey: LLM_KEY,
      model: 'deepseek-flash',
    })
    assert.equal(saved.success, true)
    const creds = readFileSync(join(dshHome, '.credentials.yaml'), 'utf8')
    assert.match(creds, /OPENAI_API_KEY: "sk-test-llm-0123456789abcdef"/)
    assert.match(creds, /DEEPSEEK_API_KEY: "sk-test-llm-0123456789abcdef"/)
    assert.match(creds, /secret: keep-login/)
    const settings = readFileSync(join(dshHome, 'settings.yaml'), 'utf8')
    assert.match(settings, /provider: deepseek/)
    assert.match(settings, /model: deepseek-flash/)
    assert.ok(!JSON.stringify(saved).includes(LLM_KEY))
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
  }
})
