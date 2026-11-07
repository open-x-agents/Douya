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
import { HOLD_RECORD, applyPrivateWithhold, install as installPrivateHook } from '../src/host/route-private-hook.js'
import { bindPrivateHold, privateHold, rememberPrivateHold, routeAck, routePrivate } from '../src/host/route-private.js'
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
  assert.equal(bindPrivateHold(state, 'sess-now', 'missing', 9), undefined)
  assert.equal(bindPrivateHold(state, 'sess-now', 'line-now-closed', 9), undefined)
  assert.deepEqual(state.privateHolds, before)
  state.workLines['line-old'] = { id: 'line-old', botId: 'bot', sessionId: 'sess-old', label: 'old', closedAt: 1 }
  state.privateHolds['sess-now'].choices.push({ id: 'line-old', label: 'old', sessionId: 'sess-old' })
  assert.equal(bindPrivateHold(state, 'sess-now', 'line-old', 9), undefined)
  assert.equal(state.privateHolds['sess-now'].status, 'pending')
  const bound = bindPrivateHold(state, 'sess-now', 'line-now', 9)
  assert.equal(bound.status, 'bound')
  assert.equal(bound.boundTo, 'line-now')
  assert.equal(bound.delivered, false)
  assert.equal(bound.label, 'plan the picnic')
})

test('a failed team-file save still keeps the sentence out and recoverable on the session', async (t) => {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  t.after(() => ctx.fiber.dispose())
  const session = ctx.sessions.create('sess-now', { meta: { cwd: '/tmp' } })
  const state = {}
  rememberPrivateHold(state, { sessionId: 'sess-now', botId: 'bot', messageId: 'm-ask', action: 'ask', text: 'which one', at: 1 })
  const payload = { agent: { id: 'sess-now', session }, messages: [user('m-ask', 'which one')] }
  const result = await applyPrivateWithhold({
    state,
    isBotSession: () => true,
    roomOf: () => undefined,
    save: async () => { throw new Error('read only') },
    warn: () => {},
  }, payload)
  assert.deepEqual(payload.messages, [])
  assert.equal(result.saved, false)
  assert.equal(result.outcomes[0].outcome, 'held-unsaved')
  const record = session.snapshotEvents().find(event => event.type === HOLD_RECORD)
  assert.equal(record.ignorable, true)
  assert.equal(record.data.text, 'which one')
  assert.equal(privateHold(state, 'sess-now').items[0].text, 'which one')
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
  const before = structuredClone(again.state.privateHolds)
  assert.equal(bindPrivateHold(again.state, 'a-now', 'not-a-line', 9), undefined)
  assert.deepEqual(again.state.privateHolds, before)
  const snapshot = structuredClone(again.state.privateHolds)
  const bound = bindPrivateHold(again.state, 'a-now', 'line-now', 9)
  assert.equal(bound.delivered, false)
  again.save = async () => { throw new Error('read only') }
  try {
    await again.save({ required: true })
  } catch {
    again.state.privateHolds = snapshot
  }
  assert.equal(again.state.privateHolds['a-now'].status, 'pending')
  assert.equal(again.state.privateHolds['a-now'].boundTo, undefined)
})

test('the real agent loop does not admit or send a held sentence', async (t) => {
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
  const state = {}
  installPrivateHook({ ctx, state, isBotSession: () => true, roomOf: () => undefined, save: async () => {}, warn: () => {} })
  const agent = await ctx.agentLoop.create('sess-loop', { provider: 'fake', model: 'fake-model' }, { cwd: '/tmp' })
  const keep = 'plan the picnic now'
  const secret = 'WEATHER-SECRET-SENTENCE'
  const hidden = createUserMessage({ content: [{ type: 'text', text: secret }], source: { kind: 'user' } })
  rememberPrivateHold(state, { sessionId: 'sess-loop', botId: 'bot', messageId: hidden.id, action: 'new', text: secret, at: 1 })
  agent.steer(createUserMessage({ content: [{ type: 'text', text: keep }], source: { kind: 'user' } }))
  for (let attempt = 0; attempt < 50 && seen.length === 0; attempt += 1) await new Promise(resolve => setTimeout(resolve, 10))
  agent.steer(hidden)
  release()
  await agent.whenIdle()
  const admitted = agent.session.snapshotEvents().filter(event => event.type === 'user/message').map(event => JSON.stringify(event.data))
  assert.equal(admitted.some(row => row.includes(keep)), true)
  assert.equal(admitted.some(row => row.includes(secret)), false)
  assert.equal(seen.some(row => row.includes(keep)), true)
  assert.equal(seen.some(row => row.includes(secret)), false)
  assert.equal(state.privateHolds['sess-loop'].items[0].text, secret)
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
