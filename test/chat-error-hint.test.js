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
