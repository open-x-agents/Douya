// A group-wide stop must leave no relay in the group Session's inbox: the UI reads that
// queue, so a relay left behind keeps the group shown as queued/waiting after the user
// stopped it. The stop notices still reach the log, and a post whose line never got
// there is logged before it is dropped.
//
// Runs where the harness is installed: `npm --prefix vendor/ds-bot run harness` (or
// DSH_HARNESS=<checkout>), then
// `cd vendor/ds-bot && node --import ./test/harness-resolve.mjs --test test/group-stop.test.js`
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// Chief, the admin of group 'r1', speaks there from 'ga'; Writer from 'gb'; Tester from 'gc'.
const seed = (room = {}) => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
    c: { id: 'c', name: 'Tester', role: 'Test', sessionId: 'c', createdAt: 3 },
  },
  rooms: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b', 'c'], mode: 'admin', admin: 'a', named: true, sessions: { a: 'ga', b: 'gb', c: 'gc' }, log: [], seq: 0, seen: {}, ...room } },
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
})

async function start(t, room, services) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-stop-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed(room)))
  const ctx = fakeContext({ services })
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      const cancelled = []
      const held = []
      const nextStep = []
      const inbox = {
        nextStep,
        nextTurn: held,
        remove(id) {
          for (const list of [nextStep, held]) {
            const at = list.findIndex(message => message.id === id)
            if (at !== -1) { list.splice(at, 1); return true }
          }
          return false
        },
      }
      const keep = list => message => { calls.push(message); list.push(message) }
      agents.set(sessionId, { session: { id: sessionId }, calls, cancelled, inbox, followup: keep(held), steer: keep(nextStep), cancel(reason) { cancelled.push(reason) } })
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
  const turns = new Map()
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  const tool = (name, args, sessionId, exec = {}) => ctx.registeredTools.get(name).execute(args, { agent: { id: sessionId }, ...exec })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  const begin = (sessionId) => {
    const message = agentOf(sessionId).calls.at(-1)
    agentOf(sessionId).inbox.nextTurn.length = 0
    agentOf(sessionId).inbox.nextStep.length = 0
    const turn = (turns.get(sessionId) ?? 0) + 1
    turns.set(sessionId, turn)
    emit(sessionId, 'turn/start', { turn })
    emit(sessionId, 'user/message', { content: message.content, source: message.source })
    return message
  }
  const finish = (sessionId, reply) => {
    emit(sessionId, 'assistant/message', { message: { content: [{ type: 'text', text: reply }] } })
    emit(sessionId, 'turn/end', { turn: turns.get(sessionId), reason: { kind: 'completed' } })
  }
  const round = (callId, message) => {
    emit('r1', 'user/message', message)
    let result
    const stop = new AbortController()
    t.after(() => stop.abort())
    void tool('group_relay', {}, 'r1', { callId, signal: stop.signal }).then((value) => { result = JSON.parse(value) })
    return () => result
  }
  const say = text => ({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  await tool('list_bots', {}, 'a')
  return { home, ctx, agentOf, emit, tool, call, begin, finish, round, say }
}

const settle = async (check) => {
  const until = Date.now() + 3000
  while (!check() && Date.now() < until) await new Promise(resolve => setImmediate(resolve))
  assert.ok(check(), 'condition not reached')
}
const relays = messages => messages.filter(message => message.source?.form === 'relay')
const logLines = host => JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).rooms.r1.log

// The user stops the group while a round runs and Chief and Writer are both at work.
const stopWhileBusy = async (t) => {
  const host = await start(t)
  host.emit('gb', 'turn/start', { turn: 1 })
  const first = host.round('c1', host.say('@Chief 看看进度'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.emit('c', 'turn/start', { turn: 1 })
  const stopped = await host.call('stop-room-work', { roomId: 'r1' })
  assert.deepEqual([stopped.ok, stopped.value], [true, true])
  return { host, first }
}

test('stop-all leaves no relay in the group Session inbox', async (t) => {
  const { host } = await stopWhileBusy(t)
  for (const list of [host.agentOf('r1').inbox.nextTurn, host.agentOf('r1').inbox.nextStep]) assert.deepEqual(relays(list), [])
})

test('stop-all leaves the user\'s own queued message alone', async (t) => {
  const host = await start(t)
  host.emit('gb', 'turn/start', { turn: 1 })
  host.round('c1', host.say('@Chief 看看进度'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  const waiting = { id: 'user-1', content: [{ type: 'text', text: '等我一下' }], source: { kind: 'user' } }
  host.agentOf('r1').inbox.nextTurn.push(waiting)
  await host.call('stop-room-work', { roomId: 'r1' })
  assert.deepEqual(host.agentOf('r1').inbox.nextTurn, [waiting])
})

test('a relay already queued when the user stops is logged once, then dropped', async (t) => {
  const host = await start(t)
  // Writer is at work here, so the stop has something to stop and its notice is queued.
  host.emit('gb', 'turn/start', { turn: 1 })
  // A member's post with no round running queues its line without logging it.
  await host.tool('post_to_group', { group: 'Ops', message: '补充：文档在 docs/ 下。' }, 'gc')
  assert.equal(host.agentOf('r1').calls.length, 1)
  assert.deepEqual(relays(host.agentOf('r1').inbox.nextTurn).map(message => message.source.logged), [undefined])
  const stopped = await host.call('stop-room-work', { roomId: 'r1' })
  assert.deepEqual([stopped.ok, stopped.value], [true, true])
  const log = logLines(host)
  // Order is not this test's business; each body appears exactly once, and no blank line.
  assert.deepEqual(log.filter(line => line.who === 'Tester').map(line => [line.who, line.text]), [['Tester', '补充：文档在 docs/ 下。']])
  assert.deepEqual(log.filter(line => line.who === 'Writer').map(line => [line.who, line.kind]), [['Writer', 'stopped']])
  assert.equal(log.length, 2)
  for (const list of [host.agentOf('r1').inbox.nextTurn, host.agentOf('r1').inbox.nextStep]) assert.deepEqual(relays(list), [])
})
