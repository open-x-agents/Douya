import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyLlmEnv, ensureAgentDefaultModel } from '../src/web/llm-env.js'

test('DeepSeek config exports both OPENAI_API_KEY and DEEPSEEK_API_KEY (fresh install)', () => {
  const env = {}
  const r = applyLlmEnv({ provider: 'deepseek', apiKey: 'sk-test', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' }, env)
  assert.equal(env.DEEPSEEK_API_KEY, 'sk-test')
  assert.equal(env.OPENAI_API_KEY, 'sk-test')
  assert.equal(env.OPENAI_BASE_URL, 'https://api.deepseek.com')
  assert.equal(r.deepseek, true)
})

test('saving a new key overwrites a stale OPENAI_API_KEY so UI edits take effect without restart', () => {
  const env = { OPENAI_API_KEY: 'sk-old', DEEPSEEK_API_KEY: 'sk-old' }
  applyLlmEnv({ provider: 'deepseek', apiKey: 'sk-new', baseURL: 'https://api.deepseek.com/v1' }, env)
  assert.equal(env.DEEPSEEK_API_KEY, 'sk-new')
  assert.equal(env.OPENAI_API_KEY, 'sk-new')
})

test('ensureAgentDefaultModel creates settings.yaml on a blank DSH_HOME', () => {
  const d = mkdtempSync(join(tmpdir(), 'odm-adm-'))
  assert.equal(ensureAgentDefaultModel(d, { provider: 'deepseek', model: 'deepseek-chat' }), true)
  assert.match(readFileSync(join(d, 'settings.yaml'), 'utf8'), /provider: deepseek/)
  assert.match(readFileSync(join(d, 'settings.yaml'), 'utf8'), /model: deepseek-chat/)
})

test('ensureAgentDefaultModel refreshes provider/model when the user re-saves', () => {
  const d = mkdtempSync(join(tmpdir(), 'odm-adm2-'))
  writeFileSync(join(d, 'settings.yaml'), 'agent-default-model:\n  provider: openai\n  model: gpt-4o\nother: 1\n')
  ensureAgentDefaultModel(d, { provider: 'deepseek', model: 'deepseek-chat' })
  const t = readFileSync(join(d, 'settings.yaml'), 'utf8')
  assert.match(t, /provider: deepseek/)
  assert.match(t, /model: deepseek-chat/)
  assert.match(t, /other: 1/)
})

import { chmodSync, existsSync, statSync } from 'node:fs'
import {
  llmCredentialRefs, upsertCredentialRefs, syncLlmCredentials, syncLlmToDsh,
  ensureProviderRoute,
} from '../src/web/llm-env.js'

const FAKE = 'sk-test-fake-not-a-real-key'

test('llmCredentialRefs writes OPENAI_API_KEY (odm DeepSeek profile) and DEEPSEEK_API_KEY', () => {
  const r = llmCredentialRefs({ provider: 'deepseek', apiKey: FAKE })
  assert.equal(r.OPENAI_API_KEY, FAKE)
  assert.equal(r.DEEPSEEK_API_KEY, FAKE)
  assert.deepEqual(llmCredentialRefs({ provider: 'deepseek', apiKey: 'sk-ab...wxyz' }), {})
  assert.deepEqual(llmCredentialRefs({ provider: 'deepseek', apiKey: '' }), {})
})

test('upsertCredentialRefs creates a version-1 document and keeps an existing login grant', () => {
  const fresh = upsertCredentialRefs('', { OPENAI_API_KEY: FAKE, DEEPSEEK_API_KEY: FAKE })
  assert.match(fresh, /^version: 1\nrefs:\n/)
  assert.match(fresh, /OPENAI_API_KEY: "sk-test-fake-not-a-real-key"/)
  assert.match(fresh, /DEEPSEEK_API_KEY: "sk-test-fake-not-a-real-key"/)

  const existing = [
    'version: 1',
    'records:',
    '  client-connection/browser-session:',
    '    kind: grant',
    '    payload:',
    '      secret: keep-this-grant',
    '',
  ].join('\n')
  const merged = upsertCredentialRefs(existing, { OPENAI_API_KEY: FAKE })
  assert.match(merged, /version: 1\nrefs:\n  OPENAI_API_KEY: "sk-test-fake-not-a-real-key"\nrecords:/)
  assert.match(merged, /secret: keep-this-grant/)
  const updated = upsertCredentialRefs(merged, { OPENAI_API_KEY: 'sk-new-fake' })
  assert.match(updated, /OPENAI_API_KEY: "sk-new-fake"/)
  assert.doesNotMatch(updated, /sk-test-fake-not-a-real-key/)
  assert.match(updated, /secret: keep-this-grant/)
})

test('upsertCredentialRefs refuses an unknown document layout', () => {
  assert.equal(upsertCredentialRefs('not: valid\nfor: us\n', { OPENAI_API_KEY: FAKE }), null)
})

test('syncLlmCredentials writes .credentials.yaml at mode 0600 and never needs a restart to be on disk', () => {
  const d = mkdtempSync(join(tmpdir(), 'odm-cred-'))
  assert.equal(syncLlmCredentials(d, { provider: 'deepseek', apiKey: FAKE }), true)
  const file = join(d, '.credentials.yaml')
  const text = readFileSync(file, 'utf8')
  assert.match(text, /OPENAI_API_KEY: "sk-test-fake-not-a-real-key"/)
  assert.match(text, /DEEPSEEK_API_KEY/)
  if (process.platform !== 'win32') {
    assert.equal(statSync(file).mode & 0o777, 0o600)
  }
  // A later save overwrites the key and keeps a grant that appeared meanwhile.
  writeFileSync(file, text.replace(/\n$/, '\n') + 'records:\n  client-connection/browser-session:\n    kind: grant\n    payload:\n      secret: session\n')
  chmodSync(file, 0o600)
  assert.equal(syncLlmCredentials(d, { provider: 'deepseek', apiKey: 'sk-second-fake' }), true)
  const after = readFileSync(file, 'utf8')
  assert.match(after, /OPENAI_API_KEY: "sk-second-fake"/)
  assert.match(after, /secret: session/)
  assert.equal(syncLlmCredentials(d, { provider: 'deepseek', apiKey: 'ab...yz' }), false)
})

test('syncLlmToDsh writes agent-default-model and credentials together', () => {
  const d = mkdtempSync(join(tmpdir(), 'odm-sync-'))
  const r = syncLlmToDsh(d, {
    provider: 'deepseek',
    model: 'deepseek-flash',
    apiKey: FAKE,
    baseURL: 'https://api.deepseek.com/v1',
  })
  assert.equal(r.defaultModel, true)
  assert.equal(r.credentials, true)
  assert.equal(r.provider, false) // official DeepSeek is already in the odm profile
  const settings = readFileSync(join(d, 'settings.yaml'), 'utf8')
  assert.match(settings, /provider: deepseek/)
  assert.match(settings, /model: deepseek-flash/)
  assert.doesNotMatch(settings, /llm-pi-ai/)
})

test('ensureProviderRoute writes a custom OpenAI-compatible baseURL into settings.yaml', () => {
  const d = mkdtempSync(join(tmpdir(), 'odm-prov-'))
  writeFileSync(join(d, 'settings.yaml'), 'agent-default-model:\n  provider: openai\n  model: gpt-4o\n')
  assert.equal(ensureProviderRoute(d, {
    provider: 'openai',
    model: 'gpt-4o',
    baseURL: 'https://gateway.example.com/v1',
    apiKey: FAKE,
  }), true)
  const t = readFileSync(join(d, 'settings.yaml'), 'utf8')
  assert.match(t, /agent-default-model:\n  provider: openai/)
  assert.match(t, /llm-pi-ai:\n  providers:\n    openai:\n      apiKeyEnv: OPENAI_API_KEY\n      baseURL: "https:\/\/gateway.example.com\/v1"/)
})

test('ensureProviderRoute declares a non-catalog custom provider with models', () => {
  const d = mkdtempSync(join(tmpdir(), 'odm-custom-'))
  assert.equal(ensureProviderRoute(d, {
    provider: 'custom',
    model: 'my-local-model',
    baseURL: 'http://127.0.0.1:8000/v1',
    apiKey: FAKE,
  }), true)
  const t = readFileSync(join(d, 'settings.yaml'), 'utf8')
  assert.match(t, /custom:\n      apiKeyEnv: OPENAI_API_KEY\n      baseURL: "http:\/\/127.0.0.1:8000\/v1"\n      api: openai-completions\n      models:\n        - id: my-local-model/)
})

test('start-dsh and the LLM save path both sync credentials into DSH_HOME', async () => {
  const { readFile } = await import('node:fs/promises')
  const start = await readFile(new URL('../scripts/start-dsh.mjs', import.meta.url), 'utf8')
  assert.match(start, /syncLlmToDsh\(DSH_HOME/)
  const api = await readFile(new URL('../src/web/api.js', import.meta.url), 'utf8')
  assert.match(api, /syncLlmToDsh\(dshHome, updates\.llm\)/)
})
