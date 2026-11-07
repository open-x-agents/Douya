import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Agents from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { applyPrivateWithhold, install as installPrivateHook } from '../src/host/route-private-hook.js'
import { bindPrivateHold, privateHold, rememberPrivateHold, routeAck, routePrivate, serializePrivate } from '../src/host/route-private.js'
import { createLine, indexOnly, labelFromText, noteLineLabel } from '../src/host/work-lines.js'

const current = { id: 'line-now', sessionId: 'sess-now', label: 'plan the picnic', busy: true, current: true }
const other = { id: 'line-budget', sessionId: 'sess-budget', label: 'budget review', busy: false, current: false }

function user(id, text) {
  return { id, source: { kind: 'user' }, content: [{ type: 'text', text }] }
}

test('a clear continuation of the busy line steers, and uncertainty asks', () => {
  const steer = routePrivate({ text: 'plan the picnic now', busy: true, lines: [current, other] })
  assert.equal(steer.action, 'steer')
  assert.equal(steer.steer, true)
  assert.equal(steer.workLineId, 'line-now')
  assert.equal(routeAck(steer), undefined)

  const miss = routePrivate({ text: 'what is the weather tomorrow', busy: true, lines: [current, other] })
  assert.equal(miss.action, 'ask')
  const only = routePrivate({ text: 'what is the weather tomorrow', busy: true, lines: [current] })
  assert.equal(only.action, 'ask')
  assert.equal(only.steer, false)
  const busyUnlabeled = routePrivate({ text: '还没好吗', busy: true, lines: [{ id: 'line-now', sessionId: 'sess-now', current: true }] })
  assert.equal(busyUnlabeled.action, 'ask')
  assert.equal(miss.steer, false)
  assert.match(routeAck(miss), /will not read this/)

  const otherHit = routePrivate({ text: 'budget review please', busy: true, lines: [current, other] })
  assert.equal(otherHit.action, 'ask')
  assert.equal(otherHit.highlight, 'line-budget')
  assert.equal(otherHit.steer, false)

  const namedOther = routePrivate({ text: '续：budget review', busy: true, lines: [current, other] })
  assert.equal(namedOther.action, 'ask')
  assert.equal(namedOther.highlight, 'line-budget')
})

test('an idle opening steers, and an explicit new never does', () => {
  const idle = routePrivate({ text: 'hello there', busy: false, lines: [{ id: 'line-now', sessionId: 'sess-now', current: true }] })
  assert.equal(idle.action, 'steer')
  const unrelated = routePrivate({ text: 'hello there', busy: false, lines: [current] })
  assert.equal(unrelated.action, 'ask')
  const opened = routePrivate({ text: '新开 预算', busy: true, lines: [current] })
  assert.equal(opened.action, 'new')
  assert.equal(opened.steer, false)
  assert.match(routeAck(opened), /does not open another chat/)
  const slash = routePrivate({ text: '/new budget', busy: false, lines: [] })
  assert.equal(slash.action, 'new')
})

test('an explicit queue while busy waits on the current line', () => {
  const queued = routePrivate({ text: 'plan the picnic later', busy: true, lines: [current], explicitQueue: true })
  assert.equal(queued.action, 'queue')
  assert.equal(queued.steer, false)
  assert.equal(queued.workLineId, 'line-now')
  assert.match(routeAck(queued), /will not read it/)
})

test('a work-line label is the first line, at most 80 characters, and is not replaced', () => {
  const state = { workLines: {} }
  createLine(state, { id: 'line-now', botId: 'bot', sessionId: 'sess-now' })
  const text = `plan the picnic\nbring the long shopping list ${'x'.repeat(200)}`
  assert.equal(labelFromText(text), 'plan the picnic')
  assert.equal(labelFromText(`新开 ${'y'.repeat(100)}`).length, 80)
  const line = noteLineLabel(state, 'sess-now', text, 5)
  assert.equal(line.label, 'plan the picnic')
  assert.equal(indexOnly(line), true)
  assert.equal(Object.hasOwn(line, 'body'), false)
  assert.equal(Object.hasOwn(line, 'text'), false)
  noteLineLabel(state, 'sess-now', 'budget review', 9)
  assert.equal(line.label, 'plan the picnic')
  assert.equal(line.updatedAt, 5)
})

function savedRt(state, agent, save = async () => {}) {
  return { state, agent, isBotSession: () => true, roomOf: () => undefined, save }
}

test('ask and new, including the new sentence, leave the step after a required save', async () => {
  const state = { workLines: { 'line-now': { id: 'line-now', botId: 'bot', sessionId: 'sess-now', label: 'plan the picnic' } } }
  rememberPrivateHold(state, {
    sessionId: 'sess-now', botId: 'bot', messageId: 'm-ask', action: 'ask', text: 'which one',
    choices: [{ id: 'line-now', label: 'plan the picnic', sessionId: 'sess-now' }], at: 1,
  })
  rememberPrivateHold(state, { sessionId: 'sess-now', messageId: 'm-new', action: 'new', text: '新开 预算', at: 2 })
  const payload = { agent: { id: 'sess-now' }, messages: [user('m-ask', 'which one'), user('m-new', '新开 预算'), user('m-keep', 'plan the picnic')] }
  const saves = []
  await applyPrivateWithhold(savedRt(state, payload.agent, async ({ required }) => { saves.push(required) }), payload)
  assert.deepEqual(saves, [true, true])
  assert.deepEqual(payload.messages.map(message => message.id), ['m-keep'])
  assert.equal(privateHold(state, 'sess-now').items.find(item => item.messageId === 'm-new').text, '新开 预算')
})

test('a queue handoff fails closed without duplicating a partial move', async () => {
  const state = {}
  const rt = { state, isBotSession: () => true, roomOf: () => undefined, save: async () => {} }
  rememberPrivateHold(state, { sessionId: 'sess-now', messageId: 'm-q', action: 'queue', text: 'later', at: 3 })
  const missing = { agent: { id: 'sess-now' }, messages: [user('m-q', 'later'), user('m-keep', 'stay')] }
  const missingResult = await applyPrivateWithhold({ ...rt, agent: missing.agent }, missing)
  assert.deepEqual(missing.messages.map(message => message.id), ['m-keep'])
  assert.equal(missingResult.outcomes[0].outcome, 'queue-failed')
  assert.equal(privateHold(state, 'sess-now').items.find(item => item.messageId === 'm-q').text, 'later')

  rememberPrivateHold(state, { sessionId: 'sess-now', messageId: 'm-a', action: 'queue', text: 'first', at: 4 })
  rememberPrivateHold(state, { sessionId: 'sess-now', messageId: 'm-b', action: 'queue', text: 'second', at: 5 })
  const moved = []
  const partial = {
    agent: {
      id: 'sess-now',
      inbox: {
        nextTurn: [],
        append(target, message) {
          if (message.id === 'm-b') throw new Error('full')
          this.nextTurn.push(message)
          moved.push([target, message.id])
        },
      },
    },
    messages: [user('m-a', 'first'), user('m-b', 'second'), user('m-keep', 'stay')],
  }
  const partialResult = await applyPrivateWithhold(rt, partial)
  assert.deepEqual(moved, [['next-turn', 'm-a']])
  assert.deepEqual(partial.messages.map(message => message.id), ['m-keep'])
  assert.deepEqual(partialResult.outcomes.map(item => item.outcome), ['queued', 'queue-failed'])
  assert.equal(privateHold(state, 'sess-now').items.find(item => item.messageId === 'm-b').outcome, 'queue-failed')
  const again = await applyPrivateWithhold(rt, { agent: partial.agent, messages: [user('m-a', 'first'), user('m-keep', 'stay')] })
  assert.deepEqual(again.outcomes, [])
  assert.deepEqual(moved, [['next-turn', 'm-a']])
})

test('a binding must name an open work line of this bot and is not delivered', () => {
  const state = { workLines: { 'line-now': { id: 'line-now', botId: 'bot', sessionId: 'sess-now', label: 'plan the picnic' } } }
  rememberPrivateHold(state, {
    sessionId: 'sess-now', botId: 'bot', messageId: 'm-ask', action: 'ask', text: 'which one',
    choices: [{ id: 'line-now', label: 'plan the picnic', sessionId: 'sess-now' }], at: 1,
  })
  const before = structuredClone(state.privateHolds)
  const generation = privateHold(state, 'sess-now').generation
  assert.equal(bindPrivateHold(state, 'sess-now', 'missing', generation, 9), undefined)
  assert.deepEqual(state.privateHolds, before)
  state.workLines['line-old'] = { id: 'line-old', botId: 'bot', sessionId: 'sess-old', label: 'old', closedAt: 1 }
  state.privateHolds['sess-now'].choices.push({ id: 'line-old', label: 'old', sessionId: 'sess-old' })
  assert.equal(bindPrivateHold(state, 'sess-now', 'line-old', generation, 9), undefined)
  assert.equal(state.privateHolds['sess-now'].status, 'pending')
  const bound = bindPrivateHold(state, 'sess-now', 'line-now', generation, 9)
  assert.equal(bound.status, 'bound')
  assert.equal(bound.boundTo, 'line-now')
  assert.equal(bound.delivered, false)
  assert.equal(bound.label, 'plan the picnic')
  rememberPrivateHold(state, { sessionId: 'sess-now', botId: 'bot', messageId: 'm-b', action: 'ask', text: 'a different sentence', at: 10 })
  const next = privateHold(state, 'sess-now')
  assert.equal(next.status, 'pending')
  assert.equal(next.boundTo, undefined)
  assert.notEqual(next.generation, generation)
  assert.equal(bindPrivateHold(state, 'sess-now', 'line-now', generation, 11), undefined)
  assert.equal(privateHold(state, 'sess-now').status, 'pending')
})

test('a failed team-file save is unrecoverable and is not called durable', async () => {
  const state = {}
  rememberPrivateHold(state, { sessionId: 'sess-now', botId: 'bot', messageId: 'm-ask', action: 'ask', text: 'which one', at: 1 })
  const payload = { agent: { id: 'sess-now', inbox: { append() { throw new Error('should not queue') } } }, messages: [user('m-ask', 'which one')] }
  const result = await applyPrivateWithhold({
    state,
    isBotSession: () => true,
    roomOf: () => undefined,
    save: async () => { throw new Error('read only') },
    warn: () => {},
  }, payload)
  assert.deepEqual(payload.messages, [])
  assert.equal(result.saved, false)
  assert.equal(result.outcomes[0].outcome, 'unrecoverable')
  assert.equal(privateHold(state, 'sess-now').items[0].text, 'which one')
  assert.equal(privateHold(state, 'sess-now').items[0].outcome, 'unrecoverable')
})

test('a queue outcome that fails to save is taken back out of next-turn', async () => {
  const state = {}
  rememberPrivateHold(state, { sessionId: 'sess-now', messageId: 'm-q', action: 'queue', text: 'later', at: 1 })
  let writes = 0
  const inbox = {
    nextTurn: [],
    append(_target, message) { this.nextTurn.push(message) },
    remove(id) {
      const at = this.nextTurn.findIndex(message => message.id === id)
      if (at === -1) return false
      this.nextTurn.splice(at, 1)
      return true
    },
  }
  const result = await applyPrivateWithhold({
    state,
    isBotSession: () => true,
    roomOf: () => undefined,
    save: async () => {
      writes += 1
      if (writes > 1) throw new Error('outcome write failed')
    },
    warn: () => {},
  }, { agent: { id: 'sess-now', inbox }, messages: [user('m-q', 'later')] })
  assert.deepEqual(result.outcomes.map(item => item.outcome), ['queue-failed'])
  assert.deepEqual(inbox.nextTurn, [])
  assert.equal(privateHold(state, 'sess-now').items[0].outcome, 'queue-failed')
  assert.equal(privateHold(state, 'sess-now').items[0].text, 'later')
})

test('a saved label and hold reload, and a failed save does not keep a binding', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-private-hold-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const ctx = fakeContext()
  const rt = createRuntime(ctx, { home })
  await rt.load()
  createLine(rt.state, { id: 'line-now', botId: 'a', sessionId: 'a-now', label: 'plan the picnic' })
  rememberPrivateHold(rt.state, {
    sessionId: 'a-now', botId: 'a', messageId: 'm-ask', action: 'ask', text: 'which one',
    choices: [{ id: 'line-now', label: 'plan the picnic', sessionId: 'a-now' }], at: 4,
  })
  await rt.save({ required: true })
  await ctx.dispose()
  const ctx2 = fakeContext()
  const again = createRuntime(ctx2, { home })
  t.after(() => ctx2.dispose())
  await again.load()
  assert.equal(again.state.workLines['line-now'].label, 'plan the picnic')
  assert.equal(again.state.privateHolds['a-now'].items[0].text, 'which one')
  assert.equal(Object.hasOwn(again.state.workLines['line-now'], 'text'), false)
  assert.equal(again.state.privateHolds['a-now'].status, 'pending')
})

async function withLoop(t, { save, state }, run) {
  const ctx = new Context()
  for (const plugin of [SessionStore, SessionProjection, LlmRuntime, ToolRuntime, SystemPrompt, Agents, AgentLoop]) {
    await ctx.plugin(plugin)
  }
  t.after(() => ctx.fiber.dispose())
  const seen = []
  let release
  const gate = new Promise(resolve => { release = resolve })
  ctx.llm.registerAdapter(['fake'], {
    providerInfo: (id) => ({ id, name: 'Fake' }),
    providerRetryPolicy: () => undefined,
    async prepareCall() {
      return {
        model: { id: 'fake-model', name: 'Fake', provider: 'fake' },
        stream(options) {
          seen.push(JSON.stringify(options))
          return (async function* () {
            yield { type: 'text-delta', index: 0, text: 'ok' }
            await gate
            yield { type: 'finish', reason: 'stop' }
          })()
        },
      }
    },
  })
  installPrivateHook({ ctx, state, isBotSession: () => true, roomOf: () => undefined, save, warn: () => {} })
  const agent = await ctx.agentLoop.create('sess-loop', { provider: 'fake', model: 'fake-model' }, { cwd: '/tmp' })
  const keep = 'plan the picnic now'
  const secret = 'WEATHER-SECRET-SENTENCE'
  agent.steer(createUserMessage({ content: [{ type: 'text', text: keep }], source: { kind: 'user' } }))
  for (let attempt = 0; attempt < 50 && seen.length === 0; attempt += 1) await new Promise(resolve => setTimeout(resolve, 10))
  await run({ agent, seen, keep, secret, release })
  release()
  await agent.whenIdle()
  const admitted = agent.session.snapshotEvents().filter(event => event.type === 'user/message').map(event => JSON.stringify(event.data))
  return { admitted, seen, keep, secret, state }
}

test('the real agent loop does not admit ask, new, or an unsaved queue', async (t) => {
  const state = {}
  const hidden = createUserMessage({ content: [{ type: 'text', text: 'WEATHER-SECRET-SENTENCE' }], source: { kind: 'user' } })
  rememberPrivateHold(state, { sessionId: 'sess-loop', botId: 'bot', messageId: hidden.id, action: 'ask', text: 'WEATHER-SECRET-SENTENCE', at: 1 })
  const asked = await withLoop(t, { state, save: async () => {} }, async ({ agent }) => { agent.steer(hidden) })
  assert.equal(asked.admitted.some(row => row.includes(asked.secret)), false)
  assert.equal(asked.seen.some(row => row.includes(asked.secret)), false)
  assert.equal(asked.admitted.some(row => row.includes(asked.keep)), true)
  assert.equal(state.privateHolds['sess-loop'].items.find(item => item.messageId === hidden.id).outcome, 'held')

  const queued = {}
  const queueMessage = createUserMessage({ content: [{ type: 'text', text: 'WEATHER-SECRET-SENTENCE' }], source: { kind: 'user' } })
  rememberPrivateHold(queued, { sessionId: 'sess-loop', messageId: queueMessage.id, action: 'queue', text: 'WEATHER-SECRET-SENTENCE', at: 2 })
  const queueResult = await withLoop(t, {
    state: queued,
    save: async () => { throw new Error('read only') },
  }, async ({ agent }) => { agent.steer(queueMessage) })
  assert.equal(queueResult.admitted.some(row => row.includes(queueResult.secret)), false)
  assert.equal(queueResult.seen.some(row => row.includes(queueResult.secret)), false)
  assert.equal(queued.privateHolds['sess-loop'].items.find(item => item.messageId === queueMessage.id).outcome, 'unrecoverable')
  assert.equal(queued.privateHolds['sess-loop'].items.find(item => item.messageId === queueMessage.id).text, 'WEATHER-SECRET-SENTENCE')
})

test('confirm-private keeps one generation and rejects a stale card', { timeout: 8000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-confirm-private-'))
  const ctx = fakeContext()
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  const rt = createRuntime(ctx, { home })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true })
  })
  await rt.load()
  createLine(rt.state, { id: 'line-now', botId: 'a', sessionId: 'a-now', label: 'plan the picnic' })
  createLine(rt.state, { id: 'line-other', botId: 'a', sessionId: 'a-other', label: 'budget review' })
  rememberPrivateHold(rt.state, {
    sessionId: 'a-now', botId: 'a', messageId: 'm-a', action: 'ask', text: 'sentence A',
    choices: [
      { id: 'line-now', label: 'plan the picnic', sessionId: 'a-now' },
      { id: 'line-other', label: 'budget review', sessionId: 'a-other' },
    ],
    at: 1,
  })
  await rt.save({ required: true })
  const call = async (payload) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST',
    body: JSON.stringify({ endpoint: 'confirm-private', payload }),
  }))).json()
  const generation = rt.state.privateHolds['a-now'].generation
  const realSave = rt.save.bind(rt)
  let release
  let started
  const gate = new Promise(resolve => { release = resolve })
  const startedGate = new Promise(resolve => { started = resolve })
  rt.save = async (options) => {
    started()
    await gate
    return realSave(options)
  }
  const first = call({ sessionId: 'a-now', choiceId: 'line-now', generation })
  const second = call({ sessionId: 'a-now', choiceId: 'line-other', generation })
  await startedGate
  const incoming = serializePrivate(rt, 'a-now', async () => {
    rememberPrivateHold(rt.state, {
      sessionId: 'a-now', botId: 'a', messageId: 'm-b', action: 'ask', text: 'sentence B',
      choices: [{ id: 'line-now', label: 'plan the picnic', sessionId: 'a-now' }],
      at: 2,
    })
  })
  release()
  const [left, right] = await Promise.all([first, second])
  await incoming
  const winners = [left, right].filter(result => result.ok === true)
  assert.equal(winners.length, 1)
  assert.equal(winners[0].value.delivered, false)
  const hold = rt.state.privateHolds['a-now']
  assert.equal(hold.status, 'pending')
  assert.equal(hold.items.at(-1).text, 'sentence B')
  assert.equal(hold.boundTo, undefined)
  const replay = await call({ sessionId: 'a-now', choiceId: 'line-now', generation })
  assert.equal(replay.ok, false)
  assert.equal(replay.error.code, 'bot/stale')
  assert.equal(rt.state.privateHolds['a-now'].items.at(-1).text, 'sentence B')
  rt.save = async () => { throw new Error('read only') }
  const failed = await call({ sessionId: 'a-now', choiceId: 'line-now', generation: hold.generation })
  assert.equal(failed.ok, false)
  assert.equal(failed.error.code, 'bot/save')
  assert.equal(rt.state.privateHolds['a-now'].status, 'pending')
  assert.equal(rt.state.privateHolds['a-now'].items.at(-1).text, 'sentence B')
})

test('DSH refuses a second append while a splice is still being published', async (t) => {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  t.after(() => ctx.fiber.dispose())
  const session = ctx.sessions.create('private-route-proof', { meta: { cwd: '/tmp' } })
  let caught
  const stop = ctx.on('session/event', (live, event) => {
    if (live !== session || event.type !== 'turn/start') return
    try {
      live.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    } catch (error) {
      caught = error
    }
  })
  t.after(stop)
  session.append('turn/start', { turn: 1 })
  assert.match(caught.message, /cannot reenter/)
  assert.equal(session.snapshotEvents().filter(event => event.type === 'turn/end').length, 0)
})
