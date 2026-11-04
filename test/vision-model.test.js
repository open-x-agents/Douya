import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureProfileDeepseekCatalog, ensureAgentDefaultModel, DEEPSEEK_DEFAULT_MODEL } from '../src/web/llm-env.js'
import { visionChatModel, isModelNoImageError } from '../src/web/muse-chat-core.js'
import { syncBotModels } from '../src/web/dsbot-chat.js'

const LEGACY = `- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      deepseek:
        displayName: DeepSeek
        apiKeyEnv: OPENAI_API_KEY
        api: openai-completions
        baseURL: https://api.deepseek.com
        models:
          - id: deepseek-chat
            name: deepseek-chat
            contextWindow: 128000
            maxTokens: 8192
- id: agent-default-model
  config:
    provider: deepseek
    model: deepseek-chat
`

test('default DeepSeek model is the vision-capable deepseek-flash', () => {
  assert.equal(DEEPSEEK_DEFAULT_MODEL, 'deepseek-flash')
  const d = mkdtempSync(join(tmpdir(), 'odm-vis-'))
  ensureAgentDefaultModel(d, {})
  assert.match(readFileSync(join(d, 'settings.yaml'), 'utf8'), /model: deepseek-flash/)
})

test('profile patch gains deepseek-flash with image input, keeps deepseek-chat, idempotent', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'odm-vis-')), 'cordis.patch.yml')
  writeFileSync(f, LEGACY)
  assert.equal(ensureProfileDeepseekCatalog(f, { defaultModel: 'deepseek-flash' }), true)
  const t = readFileSync(f, 'utf8')
  assert.match(t, /^ {10}- id: deepseek-flash\n {12}name: DeepSeek-V4\.1-Flash\n {12}input: \[text, image\]/m)
  assert.match(t, /- id: deepseek-chat/)
  assert.match(t, /thinkingFormat: deepseek/)
  assert.match(t, /- id: agent-default-model\n  config:\n    provider: deepseek\n    model: deepseek-flash\n/)
  assert.equal(ensureProfileDeepseekCatalog(f, { defaultModel: 'deepseek-flash' }), false)
})

test('profile patch without llm-pi-ai gets a whole DeepSeek route', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'odm-vis-')), 'cordis.patch.yml')
  writeFileSync(f, '- id: locale\n  config:\n    preference: zh-CN\n')
  assert.equal(ensureProfileDeepseekCatalog(f), true)
  const t = readFileSync(f, 'utf8')
  assert.match(t, /- id: llm-pi-ai/)
  assert.match(t, /models:\n {10}- id: deepseek-flash/)
  assert.match(t, /preference: zh-CN/)
})

test('vision chat model only for known vision ids; text models keep text fallback', () => {
  assert.deepEqual(visionChatModel({ ODM_CHAT_MODEL: 'deepseek-flash' }), { provider: 'deepseek', model: 'deepseek-flash' })
  assert.equal(visionChatModel({ ODM_CHAT_MODEL: 'deepseek-chat' }), null)
  assert.equal(visionChatModel({}), null)
  assert.equal(isModelNoImageError(Object.assign(new Error('Model "deepseek-chat" does not support image input.'), { data: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' } })), true)
  assert.equal(isModelNoImageError(new Error('File was not uploaded')), false)
})

test('syncBotModels moves only bots on legacy refs', async () => {
  const calls = []
  const call = async (auth, ep, p) => {
    calls.push([ep, p])
    if (ep === 'state') return { bots: { a: { id: 'a', model: 'deepseek/deepseek-chat' }, b: { id: 'b', model: 'deepseek/deepseek-v4-pro' }, c: { id: 'c', model: 'deepseek/deepseek-flash' } } }
    return {}
  }
  const r = await syncBotModels({ auth: {}, call, to: 'deepseek/deepseek-flash', from: ['deepseek/deepseek-chat'] })
  assert.deepEqual(r.updated, ['a'])
  assert.deepEqual(calls.filter(c => c[0] === 'update-bot'), [['update-bot', { id: 'a', model: 'deepseek/deepseek-flash' }]])
})
