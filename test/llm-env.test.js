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
