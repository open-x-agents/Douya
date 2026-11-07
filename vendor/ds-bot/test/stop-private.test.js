// A private-chat stop cancels only that Bot's current own-chat turn. The same Bot's
// group Session keeps running, and a chat with no live turn is left alone.
//
// Runs where the harness is installed: `npm --prefix vendor/ds-bot run harness` (or
// DSH_HARNESS=<checkout>), then
// `cd vendor/ds-bot && node --import ./test/harness-resolve.mjs --test test/stop-private.test.js`
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const seed = () => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: {
      id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a-now', createdAt: 1,
      segments: [{ sessionId: 'a-old' }],
    },
  },
  rooms: {
    r1: {
      id: 'r1', name: 'Ops', members: ['a'], mode: 'admin', admin: 'a', named: true,
      sessions: { a: 'ga' },
      segments: { a: [{ sessionId: 'ga-old' }] },
      log: [], seq: 0, seen: {},
    },
  },
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
})

async function start(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-stop-private-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed()))
  const ctx = fakeContext()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const cancelled = []
      agents.set(sessionId, {
        session: { id: sessionId },
        cancelled,
        cancel(reason) { cancelled.push(reason) },
      })
    }
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 's1' }), resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }), selectModel: async () => {} },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  apply(ctx, { home })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  let seq = 0
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data, time: 1_000 + seq })
    }
  }
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  const state = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  // Session indexes are built on load. A turn event before that is ignored.
  await call('stop-private', { sessionId: 'not-a-session' })
  return { agentOf, emit, call, state }
}

const cancelled = (host, id) => host.agentOf(id).cancelled

test('stop-private cancels the current private turn and not the same Bot in a room', async (t) => {
  const host = await start(t)
  host.emit('a-now', 'turn/start', { turn: 3 })
  host.emit('ga', 'turn/start', { turn: 7 })
  const stopped = await host.call('stop-private', { sessionId: 'a-now' })
  assert.deepEqual([stopped.ok, stopped.value], [true, true])
  assert.deepEqual(cancelled(host, 'a-now'), [{ kind: 'user' }])
  assert.deepEqual(cancelled(host, 'ga'), [])
  assert.deepEqual(cancelled(host, 'r1'), [])
  assert.deepEqual(host.state().rooms.r1.log, [])
})

test('a Bot id or an earlier private part stops the current private turn only', async (t) => {
  const host = await start(t)
  host.emit('a-now', 'turn/start', { turn: 1 })
  host.emit('ga', 'turn/start', { turn: 1 })
  const byBot = await host.call('stop-private', { sessionId: 'a' })
  assert.deepEqual([byBot.ok, byBot.value], [true, true])
  assert.deepEqual(cancelled(host, 'a-now'), [{ kind: 'user' }])
  assert.deepEqual(cancelled(host, 'ga'), [])
  host.agentOf('a-now').cancelled.length = 0
  host.emit('a-now', 'turn/start', { turn: 2 })
  const byPast = await host.call('stop-private', { sessionId: 'a-old' })
  assert.deepEqual([byPast.ok, byPast.value], [true, true])
  assert.deepEqual(cancelled(host, 'a-now'), [{ kind: 'user' }])
  assert.deepEqual(cancelled(host, 'ga'), [])
})

test('stop-private does nothing when the private chat has no live turn', async (t) => {
  const host = await start(t)
  host.emit('ga', 'turn/start', { turn: 4 })
  const stopped = await host.call('stop-private', { sessionId: 'a-now' })
  assert.deepEqual([stopped.ok, stopped.value], [true, false])
  assert.deepEqual(cancelled(host, 'a-now'), [])
  assert.deepEqual(cancelled(host, 'ga'), [])
})

test('a room id or a group Session is not a private stop', async (t) => {
  const host = await start(t)
  host.emit('a-now', 'turn/start', { turn: 1 })
  host.emit('ga', 'turn/start', { turn: 2 })
  host.emit('r1', 'turn/start', { turn: 3 })
  for (const sessionId of ['r1', 'ga', 'ga-old']) {
    const stopped = await host.call('stop-private', { sessionId })
    assert.deepEqual([stopped.ok, stopped.value], [true, false], sessionId)
  }
  assert.deepEqual(cancelled(host, 'a-now'), [])
  assert.deepEqual(cancelled(host, 'ga'), [])
  assert.deepEqual(cancelled(host, 'r1'), [])
  assert.deepEqual(host.state().rooms.r1.log, [])
})

test('stop-private refuses an empty session id', async (t) => {
  const host = await start(t)
  const stopped = await host.call('stop-private', { sessionId: '' })
  assert.equal(stopped.ok, false)
  assert.equal(stopped.error?.code, 'bot/invalid')
})

