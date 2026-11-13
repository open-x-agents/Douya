import test from 'node:test'
import assert from 'node:assert/strict'
import { chatErrorHint, isCredentialOrModelError, resolveTurnError } from '../src/web/muse-chat-core.js'

test('stale or unreadable Chief sessions get an actionable hint', () => {
  assert.match(chatErrorHint('session "session-9b67" not found'), /state\.json/)
  assert.match(chatErrorHint('resume failed: cannot safely transform unclassified message source; source v0 artifact'), /新建一个 Chief/)
  assert.match(chatErrorHint('no Main Bot'), /Chief/)
  assert.match(chatErrorHint('The Bot team file x could not be read (saved by a newer DS Bot; update DS Bot).'), /只读/)
  assert.equal(chatErrorHint('rate limited'), '')
})

test('chat error hints localize to English', () => {
  assert.match(chatErrorHint('no Main Bot', 'en'), /Restart Douya/)
  assert.match(chatErrorHint('session "s-1" not found', 'en'), /state\.json/)
})

test('bootstrapMainBot asks ds-bot state with the user cookie, and fails closed', async () => {
  const { bootstrapMainBot } = await import('../src/web/muse-chat-core.js')
  const calls = []
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => ({ ok: true }) } }
  assert.equal(await bootstrapMainBot({ origin: 'http://127.0.0.1:7777/', cookie: 'c=1', fetchImpl }), true)
  assert.equal(calls[0].url, 'http://127.0.0.1:7777/api/bot')
  assert.equal(calls[0].init.headers.cookie, 'c=1')
  assert.deepEqual(JSON.parse(calls[0].init.body), { endpoint: 'state', payload: {} })
  assert.equal(await bootstrapMainBot({ origin: 'http://x', cookie: '', fetchImpl }), false)
  assert.equal(await bootstrapMainBot({ origin: 'http://x', cookie: 'c', fetchImpl: async () => { throw new Error('down') } }), false)
  assert.equal(await bootstrapMainBot({ origin: 'http://x', cookie: 'c', fetchImpl: async () => ({ ok: true, json: async () => ({ ok: false }) }) }), false)
})

test('a silent turn reports the logged reason (e.g. missing model key)', async () => {
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { lastTurnError } = await import('../src/web/muse-chat-core.js')
  const home = await mkdtemp(join(tmpdir(), 'odm-diag-'))
  await mkdir(join(home, 'bot', 'logs'), { recursive: true })
  await writeFile(join(home, 'bot', 'logs', 'diagnostics.jsonl'), [
    JSON.stringify({ time: 100, level: 'error', sessionId: 's1', text: 'old' }),
    JSON.stringify({ time: 200, level: 'warn', sessionId: 's1', text: 'memory review failed' }),
    JSON.stringify({ time: 300, level: 'error', sessionId: 's2', text: 'other bot' }),
    JSON.stringify({ time: 400, level: 'error', sessionId: 's1', code: 'MISSING_CREDENTIAL', text: 'llm-deepseek: no API key for provider route' }),
  ].join('\n') + '\n')
  assert.match(await lastTurnError(home, 's1', 150), /no API key/)
  assert.equal(await lastTurnError(home, 's1', 500), '')
  assert.equal(await lastTurnError(join(home, 'missing'), 's1', 0), '')
  // An earlier TIMEOUT on the same session must not be reused for a later turn.
  await writeFile(join(home, 'bot', 'logs', 'diagnostics.jsonl'), [
    JSON.stringify({ time: 1_000, level: 'error', sessionId: 's1', code: 'TIMEOUT', text: 'TIMEOUT' }),
    JSON.stringify({ time: 2_000, level: 'error', sessionId: 's1', text: 'this turn failed' }),
  ].join('\n') + '\n')
  assert.equal(await lastTurnError(home, 's1', 1_500), 'this turn failed')
  assert.notEqual(await lastTurnError(home, 's1', 1_500), 'TIMEOUT')
  assert.equal(await lastTurnError(home, 's1', 3_000), '')
})

test('the chat client keeps waiting while chat-progress is running instead of aborting at 4 minutes', async () => {
  const { readFile } = await import('node:fs/promises')
  const html = await readFile(new URL('../packages/dsh-muse-ui/static/index.html', import.meta.url), 'utf8')
  assert.match(html, /Only abort after 4 minutes with no in-progress signal from chat-progress/)
  assert.match(html, /if \(r && r\.running\) lastWork = Date\.now\(\)/)
  assert.doesNotMatch(html, /setTimeout\(\(\) => ctl\.abort\(\), 240000\)/)
  assert.match(html, /t\('chat\.wait_too_long'\)/)
  assert.match(html, /t\('chat\.still_working'\)|chat-progress/)
})

test('credential and missing-model errors get a bilingual hint with a #setup link', () => {
  const long = 'llm-pi-ai: no credential for provider route "deepseek"; its profile resolves OPENAI_API_KEY, which is not set — store OPENAI_API_KEY through the credentials service'
  assert.equal(isCredentialOrModelError(long), true)
  assert.equal(isCredentialOrModelError('MISSING_CREDENTIAL'), true)
  assert.equal(isCredentialOrModelError('No model is available. Add one in Harness settings.'), true)
  assert.equal(isCredentialOrModelError('rate limited'), false)
  assert.equal(chatErrorHint(long, 'zh'), '模型 Key 没配好，[去设置](#setup)')
  assert.equal(chatErrorHint(long, 'en'), 'Model key isn’t set up — [open Settings](#setup)')
  assert.equal(chatErrorHint('MISSING_CREDENTIAL', 'en'), 'Model key isn’t set up — [open Settings](#setup)')
})

test('a bare "error" turn reason yields to the diagnostics MISSING_CREDENTIAL text', () => {
  const diag = 'llm-pi-ai: no credential for provider route "deepseek"; its profile resolves OPENAI_API_KEY, which is not set'
  assert.equal(resolveTurnError('error', diag), diag)
  assert.equal(resolveTurnError('failed', diag), diag)
  assert.equal(resolveTurnError('timeout', 'later'), 'later')
  assert.equal(resolveTurnError('session "s-1" not found', 'other'), 'session "s-1" not found')
  assert.equal(resolveTurnError('', diag), diag)
  assert.equal(resolveTurnError('error', ''), 'error')
})

test('the chat UI turns the #setup markdown into a same-page link', async () => {
  const { readFile } = await import('node:fs/promises')
  const html = await readFile(new URL('../packages/dsh-muse-ui/static/index.html', import.meta.url), 'utf8')
  assert.ok(html.includes("u === '#setup'"), 'mdInline recognizes a #setup href')
  assert.ok(html.includes('href="#setup"'), 'chat bubbles render a #setup link')
  assert.equal((html.match(/href="#setup"/g) || []).length >= 2, true)
})
