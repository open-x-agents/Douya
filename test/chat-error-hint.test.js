import test from 'node:test'
import assert from 'node:assert/strict'
import { chatErrorHint } from '../src/web/muse-chat-core.js'

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
