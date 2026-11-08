import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
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
import { install as installTurns } from '../src/host/turns.js'
import { bindPrivateHold, noteHoldOutcome, privateHold, rememberPrivateHold, routeAck, routePrivate, serializePrivate } from '../src/host/route-private.js'
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
  assert.deepEqual(saves, [true])
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

test('a queue is not appended when the queued flag cannot be saved', async () => {
  const state = {}
  rememberPrivateHold(state, { sessionId: 'sess-now', messageId: 'm-q', action: 'queue', text: 'later', at: 1 })
  let appended = 0
  const inbox = {
    nextTurn: [],
    append() { appended += 1 },
  }
  const payload = { agent: { id: 'sess-now', inbox }, step: 1, messages: [user('m-q', 'later')] }
  const result = await applyPrivateWithhold({
    state,
    isBotSession: () => true,
    roomOf: () => undefined,
    save: async () => { throw new Error('outcome write failed') },
    warn: () => {},
  }, payload)
  assert.deepEqual(result.outcomes.map(item => item.outcome), ['queue-failed'])
  assert.equal(appended, 0)
  assert.deepEqual(inbox.nextTurn, [])
  assert.deepEqual(payload.messages, [])
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

  const fresh = {}
  const opened = createUserMessage({ content: [{ type: 'text', text: 'WEATHER-SECRET-SENTENCE' }], source: { kind: 'user' } })
  rememberPrivateHold(fresh, { sessionId: 'sess-loop', botId: 'bot', messageId: opened.id, action: 'new', text: 'WEATHER-SECRET-SENTENCE', at: 3 })
  const openedResult = await withLoop(t, { state: fresh, save: async () => {} }, async ({ agent }) => { agent.steer(opened) })
  assert.equal(openedResult.admitted.some(row => row.includes('WEATHER-SECRET-SENTENCE')), false)
  assert.equal(openedResult.seen.some(row => row.includes('WEATHER-SECRET-SENTENCE')), false)
  assert.equal(fresh.privateHolds['sess-loop'].items.find(item => item.messageId === opened.id).action, 'new')

  const queued = {}
  const queueMessage = createUserMessage({ content: [{ type: 'text', text: 'WEATHER-SECRET-SENTENCE' }], source: { kind: 'user' } })
  rememberPrivateHold(queued, { sessionId: 'sess-loop', messageId: queueMessage.id, action: 'queue', text: 'WEATHER-SECRET-SENTENCE', at: 2 })
  const queueResult = await withLoop(t, {
    state: queued,
    save: async () => { throw new Error('read only') },
  }, async ({ agent }) => { agent.steer(queueMessage) })
  assert.equal(queueResult.admitted.some(row => row.includes(queueResult.secret)), false)
  assert.equal(queueResult.seen.some(row => row.includes(queueResult.secret)), false)
  assert.equal(queued.privateHolds['sess-loop'].items.find(item => item.messageId === queueMessage.id).outcome, 'queue-failed')
  assert.equal(queued.privateHolds['sess-loop'].items.find(item => item.messageId === queueMessage.id).text, 'WEATHER-SECRET-SENTENCE')
})

test('the first claim admits only a committed queue id', async (t) => {
  const ctx = new Context()
  for (const plugin of [SessionStore, SessionProjection, LlmRuntime, ToolRuntime, SystemPrompt, Agents, AgentLoop]) {
    await ctx.plugin(plugin)
  }
  t.after(() => ctx.fiber.dispose())
  const seen = []
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
            yield { type: 'finish', reason: 'stop' }
          })()
        },
      }
    },
  })
  const sentence = 'SAME-SENTENCE'
  const state = {}
  const ask = createUserMessage({ content: [{ type: 'text', text: sentence }], source: { kind: 'user', dsBotQueue: true } })
  const opened = createUserMessage({ content: [{ type: 'text', text: sentence }], source: { kind: 'user', dsBotQueue: true } })
  const handed = createUserMessage({ content: [{ type: 'text', text: sentence }], source: { kind: 'user' } })
  const pending = createUserMessage({ content: [{ type: 'text', text: sentence }], source: { kind: 'user' } })
  rememberPrivateHold(state, { sessionId: 'sess-loop', messageId: ask.id, action: 'ask', text: sentence, at: 1 })
  rememberPrivateHold(state, { sessionId: 'sess-loop', messageId: opened.id, action: 'new', text: sentence, at: 2 })
  rememberPrivateHold(state, { sessionId: 'sess-loop', messageId: handed.id, action: 'queue', text: sentence, at: 3 })
  noteHoldOutcome(state, 'sess-loop', handed.id, 'queued')
  rememberPrivateHold(state, { sessionId: 'sess-loop', messageId: pending.id, action: 'queue', text: sentence, at: 4 })
  installPrivateHook({ ctx, state, isBotSession: () => true, roomOf: () => undefined, save: async () => { throw new Error('pending queue was not saved') }, warn: () => {} })
  const agent = await ctx.agentLoop.create('sess-loop', { provider: 'fake', model: 'fake-model' }, { cwd: '/tmp' })
  agent.inbox.append('next-step', ask)
  agent.inbox.append('next-step', opened)
  agent.inbox.append('next-step', pending)
  agent.inbox.append('next-turn', handed)
  agent.wakeDriver()
  await agent.whenIdle()
  const admitted = agent.session.snapshotEvents().filter(event => event.type === 'user/message')
  assert.equal(admitted.filter(event => event.data?.id === handed.id).length, 1)
  assert.equal(admitted.some(event => event.data?.id === ask.id || event.data?.id === opened.id || event.data?.id === pending.id), false)
  assert.equal(seen.filter(row => row.includes(sentence)).length, 1)
  assert.equal(agent.inbox.nextTurn.some(message => message.id === pending.id), false)
  assert.equal(state.privateHolds['sess-loop'].items.find(item => item.messageId === pending.id).outcome, 'queue-failed')
  assert.equal(state.privateHolds['sess-loop'].items.find(item => item.messageId === ask.id).outcome === 'queued', false)
  assert.equal(state.privateHolds['sess-loop'].items.find(item => item.messageId === opened.id).action, 'new')
})

test('a fully held turn records no model payload, including after the later save', async (t) => {
  const secret = 'FAIL3_141 unrelated pending confirmation only'
  const bundle = join(process.env.DSH_HARNESS, 'packages/bundle/web-app/package.json')
  const { apply: nativeClock } = await import(pathToFileURL(createRequire(bundle).resolve('@deepseek-ai/dsh-time-context')).href)
  const boot = async (save, { clockOuter }) => {
    const ctx = new Context()
    for (const plugin of [SessionStore, SessionProjection, LlmRuntime, ToolRuntime, SystemPrompt, Agents, AgentLoop]) {
      await ctx.plugin(plugin)
    }
    const calls = []
    ctx.llm.registerAdapter(['fake'], {
      providerInfo: (id) => ({ id, name: 'Fake' }),
      providerRetryPolicy: () => undefined,
      async prepareCall() {
        return {
          model: { id: 'fake-model', name: 'Fake', provider: 'fake' },
          stream(options) {
            calls.push(JSON.stringify(options))
            return (async function* () {
              yield { type: 'text-delta', index: 0, text: 'ok' }
              yield { type: 'finish', reason: 'stop' }
            })()
          },
        }
      },
    })
    const state = {}
    const rt = {
      ctx,
      state,
      config: { timeZone: 'Asia/Shanghai' },
      isBotSession: () => true,
      roomOf: () => undefined,
      load: async () => {},
      save,
      warn: () => {},
      async* eventsBackwards() {},
    }
    // clockOuter matches a profile that registers the native clock after this hook.
    if (clockOuter) { installPrivateHook(rt); nativeClock(ctx, { timeZone: 'Asia/Shanghai' }) }
    else { nativeClock(ctx, { timeZone: 'Asia/Shanghai' }); installPrivateHook(rt) }
    const agent = await ctx.agentLoop.create('sess-loop', { provider: 'fake', model: 'fake-model' }, { cwd: '/tmp' })
    const trace = (phase, messageId) => ({
      phase,
      calls: calls.map(body => ({
        heldId: messageId !== undefined && body.includes(messageId),
        heldText: body.includes(secret),
        timeContext: body.includes('Time sampled while preparing'),
      })),
      admitted: agent.session.snapshotEvents().filter(event => event.type === 'user/message').map(event => ({
        id: event.data?.id,
        kind: event.data?.source?.kind,
      })),
    })
    return { ctx, state, calls, agent, save, trace }
  }
  for (const clockOuter of [false, true]) {
    const held = await boot(async () => { throw new Error('read only') }, { clockOuter })
    t.after(() => held.ctx.fiber.dispose())
    const hidden = createUserMessage({ content: [{ type: 'text', text: secret }], source: { kind: 'user' } })
    const heldId = hidden.id
    rememberPrivateHold(held.state, { sessionId: 'sess-loop', messageId: heldId, action: 'ask', text: secret, at: 1 })
    held.agent.steer(hidden)
    await held.agent.whenIdle()
    const beforeRetry = held.trace('held-send', heldId)
    assert.deepEqual(beforeRetry.calls, [], beforeRetry)
    assert.equal(beforeRetry.admitted.some(entry => entry.kind === 'time-context' || entry.id === heldId), false, beforeRetry)
    assert.equal(held.agent.session.snapshotEvents().some(event => event.type === 'assistant/message'), false)
    assert.equal(held.state.privateHolds['sess-loop'].items[0].outcome, 'unrecoverable')
    const eventsBeforeRetry = held.agent.session.snapshotEvents().length
    await held.save({ required: true }).catch(() => {})
    await new Promise(resolve => setTimeout(resolve, 30))
    await held.agent.whenIdle()
    const afterRetry = held.trace('after-retry', heldId)
    assert.deepEqual(afterRetry.calls, [], afterRetry)
    assert.equal(held.agent.session.snapshotEvents().length, eventsBeforeRetry)
    assert.equal(afterRetry.admitted.some(entry => entry.kind === 'time-context' || entry.id === heldId), false)
  }

  const queued = await boot(async () => {}, { clockOuter: true })
  t.after(() => queued.ctx.fiber.dispose())
  const parked = createUserMessage({ content: [{ type: 'text', text: secret }], source: { kind: 'user' } })
  rememberPrivateHold(queued.state, { sessionId: 'sess-loop', messageId: parked.id, action: 'queue', text: secret, at: 2 })
  queued.agent.steer(parked)
  await queued.agent.whenIdle()
  const continued = queued.trace('queue-continuation', parked.id)
  assert.equal(continued.calls.length, 1, continued)
  assert.equal(continued.calls[0].heldText, true)
  assert.equal(continued.admitted.filter(entry => entry.id === parked.id).length, 1)
})

test('a tool step continues and the queued next turn is admitted once', async (t) => {
  const ctx = new Context()
  for (const plugin of [SessionStore, SessionProjection, LlmRuntime, ToolRuntime, SystemPrompt, Agents, AgentLoop]) {
    await ctx.plugin(plugin)
  }
  t.after(() => ctx.fiber.dispose())
  const calls = []
  let round = 0
  ctx.llm.registerAdapter(['fake'], {
    providerInfo: (id) => ({ id, name: 'Fake' }),
    providerRetryPolicy: () => undefined,
    async prepareCall() {
      return {
        model: { id: 'fake-model', name: 'Fake', provider: 'fake' },
        stream(options) {
          const body = JSON.stringify(options)
          calls.push(body)
          round += 1
          const current = round
          return (async function* () {
            if (current === 1) {
              yield { type: 'tool-call-delta', index: 0, id: 'qtool-1', name: 'qtool', argumentsDelta: '{}' }
              yield { type: 'finish', reason: { kind: 'tool-calls' } }
              return
            }
            const text = body.includes('QUEUE_CONT_141') ? 'QUEUE_ACK_141' : 'TOOLONLY_POST'
            yield { type: 'text-delta', index: 0, text }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        },
      }
    },
  })
  const bundle = join(process.env.DSH_HARNESS, 'packages/bundle/web-app/package.json')
  const { apply: nativeClock } = await import(pathToFileURL(createRequire(bundle).resolve('@deepseek-ai/dsh-time-context')).href)
  const state = {}
  const rt = {
    ctx,
    state,
    config: { timeZone: 'Asia/Shanghai' },
    isBotSession: () => true,
    roomOf: () => undefined,
    load: async () => {},
    save: async () => {},
    warn: () => {},
    async* eventsBackwards() {},
  }
  installPrivateHook(rt)
  nativeClock(ctx, { timeZone: 'Asia/Shanghai' })
  const agent = await ctx.agentLoop.create('sess-loop', { provider: 'fake', model: 'fake-model' }, { cwd: '/tmp' })
  const ask = createUserMessage({ content: [{ type: 'text', text: 'ASK_SECRET_141' }], source: { kind: 'user' } })
  const queued = createUserMessage({ content: [{ type: 'text', text: 'QUEUE_CONT_141 please reply QUEUE_ACK_141' }], source: { kind: 'user' } })
  rememberPrivateHold(state, { sessionId: 'sess-loop', messageId: ask.id, action: 'ask', text: 'ASK_SECRET_141', at: 1 })
  ctx.tools.register({
    name: 'qtool',
    description: 'Finish the tool step',
    parameters: {},
    async execute() {
      agent.inbox.append('next-step', ask)
      agent.inbox.append('next-turn', queued)
      return 'QTOOL_DONE'
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
  })
  agent.steer(createUserMessage({ content: [{ type: 'text', text: 'TOOLONLY call the tool' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  const events = agent.session.snapshotEvents()
  const ends = events.filter(event => event.type === 'turn/end').map(event => event.data?.reason?.kind)
  const admitted = events.filter(event => event.type === 'user/message').map(event => ({
    id: event.data?.id,
    kind: event.data?.source?.kind,
    text: JSON.stringify(event.data?.content ?? ''),
  }))
  assert.equal(events.some(event => event.type === 'tool/result' && JSON.stringify(event.data).includes('QTOOL_DONE')), true)
  assert.equal(ends.includes('blocked'), false, ends)
  assert.equal(calls.some(body => body.includes('QTOOL_DONE')), true)
  assert.equal(calls.some(body => body.includes('ASK_SECRET_141')), false)
  assert.equal(admitted.some(entry => entry.id === ask.id), false)
  assert.equal(calls.filter(body => body.includes('QUEUE_CONT_141')).length, 1)
  assert.equal(admitted.filter(entry => entry.id === queued.id).length, 1)
  assert.equal(events.some(event => event.type === 'assistant/message' && JSON.stringify(event.data).includes('QUEUE_ACK_141')), true)
  assert.equal(events.some(event => event.type === 'assistant/message' && JSON.stringify(event.data).includes('TOOLONLY_POST')), true)
})

test('a team file and a flushed session continue a committed queue without new input', { timeout: 20000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-queue-log-'))
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-queue-team-'))
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  })
  const secret = 'PARKED-QUEUE-SENTENCE'
  const parkedId = 'queued-before-append'
  const waitingId = 'queued-after-append'
  const claimedId = 'queued-after-claim'
  const seedTeam = async () => {
    const teamCtx = fakeContext()
    const rt = createRuntime(teamCtx, { home })
    await rt.load()
    for (const messageId of [parkedId, waitingId, claimedId]) {
      rememberPrivateHold(rt.state, { sessionId: messageId, messageId, action: 'queue', text: secret, at: 1 })
      noteHoldOutcome(rt.state, messageId, messageId, 'queued')
    }
    await rt.save({ required: true })
    await teamCtx.dispose()
  }
  await seedTeam()
  const boot = async () => {
    const teamCtx = fakeContext()
    const rt = createRuntime(teamCtx, { home })
    await rt.load()
    const ctx = new Context()
    await ctx.plugin(JsonlPersistence, { root, compression: 'none' })
    for (const plugin of [SessionStore, SessionProjection, LlmRuntime, ToolRuntime, SystemPrompt, Agents, AgentLoop]) {
      await ctx.plugin(plugin)
    }
    ctx.llm.registerAdapter(['fake'], {
      providerInfo: (id) => ({ id, name: 'Fake' }),
      providerRetryPolicy: () => undefined,
      async prepareCall() {
        return {
          model: { id: 'fake-model', name: 'Fake', provider: 'fake' },
          stream() {
            return (async function* () {
              yield { type: 'text-delta', index: 0, text: 'ok' }
              yield { type: 'finish', reason: 'stop' }
            })()
          },
        }
      },
    })
    installPrivateHook({
      ctx,
      state: rt.state,
      isBotSession: () => true,
      roomOf: () => undefined,
      save: (options) => rt.save(options),
      warn: () => {},
    })
    return {
      ctx,
      rt,
      close: async () => {
        await ctx.fiber.dispose()
        await teamCtx.dispose()
      },
    }
  }
  // Dispose cancels a live inbox. A crash does not, so the durable session
  // prefix is the flushed log copied before that cancel is written.
  const freeze = () => {
    const snap = mkdtempSync(join(tmpdir(), 'ds-bot-queue-snap-'))
    cpSync(root, snap, { recursive: true })
    return snap
  }
  const thaw = (snap) => {
    rmSync(root, { recursive: true, force: true })
    cpSync(snap, root, { recursive: true })
    rmSync(snap, { recursive: true, force: true })
  }
  const settle = async (agent) => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await agent.whenIdle()
      await new Promise(resolve => setTimeout(resolve, 15))
      if (agent.phase?.kind === 'idle' && agent.inbox?.hasPending !== true) return
    }
    await agent.whenIdle()
  }
  const users = (agent, messageId) => agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data?.id === messageId)
  const inserts = (agent, messageId) => agent.session.snapshotEvents().filter(event => event.type === 'agent/inbox/spliced' && (event.data?.inserted ?? []).some(message => message?.id === messageId))
  const held = (session, messageId) => session.rt.state.privateHolds[messageId].items.find(item => item.messageId === messageId)
  const onDisk = (messageId) => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).privateHolds[messageId].items.find(item => item.messageId === messageId)

  let session = await boot()
  assert.equal(held(session, parkedId).outcome, 'queued')
  assert.equal(onDisk(parkedId).outcome, 'queued')
  let agent = await session.ctx.agentLoop.create(parkedId, { provider: 'fake', model: 'fake-model' }, { cwd: '/tmp' })
  assert.equal(await session.ctx.sessions.flush(agent.session), true)
  await session.close()
  session = await boot()
  assert.equal(onDisk(parkedId).outcome, 'queued')
  assert.equal(held(session, parkedId).outcome, 'queued')
  agent = (await session.ctx.agentLoop.resume(session.ctx, { resumeSessionId: parkedId, agentOptions: { provider: 'fake', model: 'fake-model' } })).agent
  await settle(agent)
  assert.equal(users(agent, parkedId).length, 1)
  assert.equal(inserts(agent, parkedId).length, 1)
  const parkedUsers = users(agent, parkedId).length
  const parkedInserts = inserts(agent, parkedId).length
  assert.equal(await session.ctx.sessions.flush(agent.session), true)
  await session.close()
  session = await boot()
  agent = (await session.ctx.agentLoop.resume(session.ctx, { resumeSessionId: parkedId, agentOptions: { provider: 'fake', model: 'fake-model' } })).agent
  await settle(agent)
  assert.equal(users(agent, parkedId).length, parkedUsers)
  assert.equal(inserts(agent, parkedId).length, parkedInserts)
  await session.close()

  session = await boot()
  agent = await session.ctx.agentLoop.create(waitingId, { provider: 'fake', model: 'fake-model' }, { cwd: '/tmp' })
  agent.inbox.append('next-turn', { id: waitingId, role: 'user', source: { kind: 'user', dsBotQueue: true }, content: [{ type: 'text', text: secret }] })
  assert.equal(await session.ctx.sessions.flush(agent.session), true)
  assert.equal(users(agent, waitingId).length, 0)
  assert.equal(inserts(agent, waitingId).length, 1)
  assert.equal(onDisk(waitingId).outcome, 'queued')
  const waitingSnap = freeze()
  await session.close()
  thaw(waitingSnap)
  session = await boot()
  assert.equal(held(session, waitingId).outcome, 'queued')
  agent = (await session.ctx.agentLoop.resume(session.ctx, { resumeSessionId: waitingId, agentOptions: { provider: 'fake', model: 'fake-model' } })).agent
  assert.equal(agent.inbox.nextTurn.some(message => message.id === waitingId), true)
  await settle(agent)
  assert.equal(users(agent, waitingId).length, 1)
  assert.equal(inserts(agent, waitingId).length, 1)
  await session.close()

  session = await boot()
  agent = await session.ctx.agentLoop.create(claimedId, { provider: 'fake', model: 'fake-model' }, { cwd: '/tmp' })
  agent.inbox.append('next-turn', { id: claimedId, role: 'user', source: { kind: 'user', dsBotQueue: true }, content: [{ type: 'text', text: secret }] })
  assert.equal(await session.ctx.sessions.flush(agent.session), true)
  assert.equal(onDisk(claimedId).outcome, 'queued')
  const claimedSnap = freeze()
  await session.close()
  thaw(claimedSnap)
  session = await boot()
  session.ctx.on('agent/pre-step', async (payload, next) => {
    if (payload.messages?.some(message => message?.id === claimedId)) {
      await session.ctx.sessions.flush(payload.agent.session)
      return { kind: 'reject' }
    }
    return next()
  }, { prepend: true })
  agent = (await session.ctx.agentLoop.resume(session.ctx, { resumeSessionId: claimedId, agentOptions: { provider: 'fake', model: 'fake-model' } })).agent
  await settle(agent)
  assert.equal(users(agent, claimedId).length, 0)
  assert.equal(await session.ctx.sessions.flush(agent.session), true)
  const claimedCut = freeze()
  await session.close()
  thaw(claimedCut)
  session = await boot()
  assert.equal(held(session, claimedId).outcome, 'queued')
  agent = (await session.ctx.agentLoop.resume(session.ctx, { resumeSessionId: claimedId, agentOptions: { provider: 'fake', model: 'fake-model' } })).agent
  await settle(agent)
  assert.equal(users(agent, claimedId).length, 1)
  assert.equal(inserts(agent, claimedId).length, 2)
  await session.close()
})

test('a live splice is classified before the step can admit it', async (t) => {
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
  const state = { questions: {}, views: {} }
  createLine(state, { id: 'line-loop', botId: 'bot', sessionId: 'sess-loop', label: 'plan the picnic' })
  const rt = {
    ctx,
    state,
    chatOwners: new Map([['sess-loop', 'bot']]),
    groupOwners: new Set(),
    isBotSession: () => true,
    roomOf: () => undefined,
    botOf: () => ({ name: 'Bot' }),
    selfOf: (id) => id,
    dropKickoff: () => {},
    save: async () => true,
    warn: () => {},
  }
  installTurns(rt)
  installPrivateHook(rt)
  const agent = await ctx.agentLoop.create('sess-loop', { provider: 'fake', model: 'fake-model' }, { cwd: '/tmp' })
  agent.steer(createUserMessage({ content: [{ type: 'text', text: 'plan the picnic now' }], source: { kind: 'user' } }))
  for (let attempt = 0; attempt < 50 && seen.length === 0; attempt += 1) await new Promise(resolve => setTimeout(resolve, 10))
  const secret = createUserMessage({ content: [{ type: 'text', text: 'WEATHER-SECRET-SENTENCE' }], source: { kind: 'user' } })
  agent.steer(secret)
  release()
  await agent.whenIdle()
  const admitted = agent.session.snapshotEvents().filter(event => event.type === 'user/message').map(event => JSON.stringify(event.data))
  assert.equal(admitted.some(row => row.includes('WEATHER-SECRET-SENTENCE')), false)
  assert.equal(seen.some(row => row.includes('WEATHER-SECRET-SENTENCE')), false)
  assert.equal(state.privateHolds['sess-loop'].items.find(item => item.messageId === secret.id).action, 'ask')
  assert.equal(state.privateHolds['sess-loop'].items.find(item => item.messageId === secret.id).outcome, 'held')
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

test('a failed confirm does not stay bound when another session saves', { timeout: 8000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-confirm-two-'))
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
  createLine(rt.state, { id: 'line-a', botId: 'a', sessionId: 'a-now', label: 'plan the picnic' })
  createLine(rt.state, { id: 'line-b', botId: 'b', sessionId: 'b-now', label: 'budget review' })
  rememberPrivateHold(rt.state, {
    sessionId: 'a-now', botId: 'a', messageId: 'm-a', action: 'ask', text: 'sentence A',
    choices: [{ id: 'line-a', label: 'plan the picnic', sessionId: 'a-now' }], at: 1,
  })
  rememberPrivateHold(rt.state, {
    sessionId: 'b-now', botId: 'b', messageId: 'm-b', action: 'ask', text: 'sentence B',
    choices: [{ id: 'line-b', label: 'budget review', sessionId: 'b-now' }], at: 2,
  })
  await rt.save({ required: true })
  const call = async (payload) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST',
    body: JSON.stringify({ endpoint: 'confirm-private', payload }),
  }))).json()
  const generationA = rt.state.privateHolds['a-now'].generation
  const generationB = rt.state.privateHolds['b-now'].generation
  const realSave = rt.save.bind(rt)
  let release
  let started
  const gate = new Promise(resolve => { release = resolve })
  const startedGate = new Promise(resolve => { started = resolve })
  const shots = []
  rt.save = async (options) => {
    const a = rt.state.privateHolds['a-now']?.status
    const b = rt.state.privateHolds['b-now']?.status
    shots.push({ a, b })
    if (a === 'bound' && b !== 'bound') {
      started()
      await gate
      throw new Error('session A could not be saved')
    }
    return realSave(options)
  }
  const failed = call({ sessionId: 'a-now', choiceId: 'line-a', generation: generationA })
  await startedGate
  const saved = call({ sessionId: 'b-now', choiceId: 'line-b', generation: generationB })
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(rt.state.privateHolds['b-now'].status, 'pending')
  assert.equal(shots.some(shot => shot.a === 'bound' && shot.b === 'bound'), false)
  release()
  const [resultA, resultB] = await Promise.all([failed, saved])
  assert.equal(resultA.ok, false)
  assert.equal(resultA.error.code, 'bot/save')
  assert.equal(resultB.ok, true)
  assert.equal(resultB.value.delivered, false)
  assert.equal(shots.some(shot => shot.a === 'bound' && shot.b === 'bound'), false)
  noteHoldOutcome(rt.state, 'a-now', 'm-a', 'unrecoverable')
  const retried = await (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST',
    body: JSON.stringify({ endpoint: 'retry-private-save', payload: { sessionId: 'a-now' } }),
  }))).json()
  assert.equal(retried.ok, true)
  assert.equal(retried.value.delivered, false)
  assert.equal(rt.state.privateHolds['a-now'].items.find(item => item.messageId === 'm-a').outcome, 'held')
  assert.equal(rt.state.privateHolds['a-now'].status, 'pending')
  await ctx.dispose()
  const ctx2 = fakeContext()
  const loaded = createRuntime(ctx2, { home })
  t.after(() => ctx2.dispose())
  await loaded.load()
  assert.equal(loaded.state.privateHolds['a-now'].status, 'pending')
  assert.equal(loaded.state.privateHolds['a-now'].boundTo, undefined)
  assert.equal(loaded.state.privateHolds['a-now'].items.find(item => item.messageId === 'm-a').outcome, 'held')
  assert.equal(loaded.state.privateHolds['b-now'].status, 'bound')
  assert.equal(loaded.state.privateHolds['b-now'].boundTo, 'line-b')
  assert.equal(loaded.state.privateHolds['b-now'].delivered, false)
})

test('a failed confirm or retry is not published by dismissing a question', { timeout: 8000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-confirm-dismiss-'))
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
  createLine(rt.state, { id: 'line-a', botId: 'a', sessionId: 'a-now', label: 'plan the picnic' })
  rememberPrivateHold(rt.state, {
    sessionId: 'a-now', botId: 'a', messageId: 'm-a', action: 'ask', text: 'sentence A',
    choices: [{ id: 'line-a', label: 'plan the picnic', sessionId: 'a-now' }], at: 1,
  })
  rt.state.questions['a-now'] = { prompt: 'which line' }
  await rt.save({ required: true })
  const post = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST',
    body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const generation = rt.state.privateHolds['a-now'].generation
  const guarded = rt.save.bind(rt)
  let release
  let started
  const gate = new Promise(resolve => { release = resolve })
  const startedGate = new Promise(resolve => { started = resolve })
  let failingConfirm = false
  rt.save = (options) => {
    const privileged = options?.privateCommit !== undefined && options.privateCommit === rt.privateCommitToken
    if (privileged && !failingConfirm && rt.state.privateHolds['a-now']?.status === 'bound') {
      failingConfirm = true
      rt.privateCommitToken = undefined
      started()
      return gate.then(() => Promise.reject(new Error('session A could not be saved')))
    }
    return guarded(options)
  }
  const failed = post('confirm-private', { sessionId: 'a-now', choiceId: 'line-a', generation })
  await startedGate
  const dismissed = post('dismiss-question', { sessionId: 'a-now' })
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(rt.state.privateHolds['a-now'].status, 'bound')
  release()
  const [result, cleared] = await Promise.all([failed, dismissed])
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'bot/save')
  assert.equal(cleared.ok, true)
  assert.equal(rt.state.privateHolds['a-now'].status, 'pending')
  assert.equal(rt.state.privateHolds['a-now'].boundTo, undefined)
  assert.equal(rt.state.questions['a-now'], undefined)
  await ctx.dispose()
  const ctx2 = fakeContext()
  let route2
  const register2 = ctx2.connection.fetch.register
  ctx2.connection.fetch.register = (options) => { route2 = options; return register2(options) }
  const loaded = createRuntime(ctx2, { home })
  t.after(() => ctx2.dispose())
  await loaded.load()
  assert.equal(loaded.state.privateHolds['a-now'].status, 'pending')
  assert.equal(loaded.state.privateHolds['a-now'].boundTo, undefined)
  assert.equal(loaded.state.questions['a-now'], undefined)

  noteHoldOutcome(loaded.state, 'a-now', 'm-a', 'unrecoverable')
  loaded.state.questions['a-now'] = { prompt: 'still here' }
  await loaded.save({ required: true })
  const post2 = async (endpoint, payload) => (await route2.fetch(new Request('http://localhost/api/bot', {
    method: 'POST',
    body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const guardedRetry = loaded.save.bind(loaded)
  let releaseRetry
  let startedRetry
  const retryGate = new Promise(resolve => { releaseRetry = resolve })
  const retryStarted = new Promise(resolve => { startedRetry = resolve })
  let failingRetry = false
  loaded.save = (options) => {
    const outcome = loaded.state.privateHolds['a-now']?.items?.find(item => item.messageId === 'm-a')?.outcome
    const privileged = options?.privateCommit !== undefined && options.privateCommit === loaded.privateCommitToken
    if (privileged && !failingRetry && outcome === 'held') {
      failingRetry = true
      loaded.privateCommitToken = undefined
      startedRetry()
      return retryGate.then(() => Promise.reject(new Error('retry was not saved')))
    }
    return guardedRetry(options)
  }
  const retry = post2('retry-private-save', { sessionId: 'a-now' })
  await retryStarted
  const dismissedRetry = post2('dismiss-question', { sessionId: 'a-now' })
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(loaded.state.privateHolds['a-now'].items.find(item => item.messageId === 'm-a').outcome, 'held')
  releaseRetry()
  const [retryResult, clearedRetry] = await Promise.all([retry, dismissedRetry])
  assert.equal(retryResult.ok, false)
  assert.equal(retryResult.error.code, 'bot/save')
  assert.equal(clearedRetry.ok, true)
  assert.equal(loaded.state.privateHolds['a-now'].items.find(item => item.messageId === 'm-a').outcome, 'unrecoverable')
  await ctx2.dispose()
  const ctx3 = fakeContext()
  const again = createRuntime(ctx3, { home })
  t.after(() => ctx3.dispose())
  await again.load()
  assert.equal(again.state.privateHolds['a-now'].status, 'pending')
  assert.equal(again.state.privateHolds['a-now'].items.find(item => item.messageId === 'm-a').outcome, 'unrecoverable')
  assert.equal(again.state.questions['a-now'], undefined)
})

test('a failed confirm or retry is not published by a queue ack or a label save', { timeout: 8000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-confirm-ack-'))
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
  rt.state.bots.b = { id: 'b', name: 'Bee', sessionId: 'b-queue' }
  rt.state.bots.c = { id: 'c', name: 'Cee', sessionId: 'c-label' }
  createLine(rt.state, { id: 'line-a', botId: 'a', sessionId: 'a-now', label: 'plan the picnic' })
  createLine(rt.state, { id: 'line-b', botId: 'b', sessionId: 'b-queue', label: 'plan the picnic' })
  createLine(rt.state, { id: 'line-c', botId: 'c', sessionId: 'c-label' })
  rememberPrivateHold(rt.state, {
    sessionId: 'a-now', botId: 'a', messageId: 'm-a', action: 'ask', text: 'sentence A',
    choices: [{ id: 'line-a', label: 'plan the picnic', sessionId: 'a-now' }], at: 1,
  })
  await rt.save({ required: true })
  const post = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST',
    body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const fire = (sessionId, event) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) listener({ id: sessionId }, event)
  }
  const generation = rt.state.privateHolds['a-now'].generation
  const guarded = rt.save.bind(rt)
  let release
  let started
  const gate = new Promise(resolve => { release = resolve })
  const startedGate = new Promise(resolve => { started = resolve })
  let privilegedWhileBound = 0
  rt.save = (options) => {
    const privileged = options?.privateCommit !== undefined && options.privateCommit === rt.privateCommitToken
    if (privileged && rt.state.privateHolds['a-now']?.status === 'bound') {
      privilegedWhileBound += 1
      if (privilegedWhileBound === 1) {
        rt.privateCommitToken = undefined
        started()
        return gate.then(() => Promise.reject(new Error('session A could not be saved')))
      }
    }
    return guarded(options)
  }
  const failed = post('confirm-private', { sessionId: 'a-now', choiceId: 'line-a', generation })
  await startedGate
  fire('b-queue', { type: 'turn/start', data: { turn: 1 }, time: 1 })
  fire('b-queue', {
    type: 'agent/inbox/spliced',
    time: 2,
    data: {
      target: 'next-turn',
      inserted: [{ id: 'm-q', source: { kind: 'user' }, content: [{ type: 'text', text: 'plan the picnic now' }] }],
    },
  })
  const acked = rt.privateHoldPersist ?? Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(rt.state.privateHolds['a-now'].status, 'bound')
  assert.equal(privilegedWhileBound, 1)
  release()
  const result = await failed
  await acked
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'bot/save')
  assert.equal(rt.state.privateHolds['a-now'].status, 'pending')
  assert.equal(rt.privateCommitToken, undefined)
  assert.equal(rt.routeNoteView()['b-queue']?.action, 'queue')
  assert.equal(rt.routeNoteView()['b-queue']?.saved, true)
  await ctx.dispose()
  const ctx2 = fakeContext()
  let route2
  const register2 = ctx2.connection.fetch.register
  ctx2.connection.fetch.register = (options) => { route2 = options; return register2(options) }
  const loaded = createRuntime(ctx2, { home })
  t.after(() => ctx2.dispose())
  await loaded.load()
  assert.equal(loaded.state.privateHolds['a-now'].status, 'pending')
  assert.equal(loaded.state.privateHolds['a-now'].boundTo, undefined)
  const disk = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  assert.equal(disk.privateHolds['a-now'].status, 'pending')
  assert.equal(disk.privateHolds['a-now'].boundTo, undefined)

  noteHoldOutcome(loaded.state, 'a-now', 'm-a', 'unrecoverable')
  await loaded.save({ required: true })
  const post2 = async (endpoint, payload) => (await route2.fetch(new Request('http://localhost/api/bot', {
    method: 'POST',
    body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const fire2 = (sessionId, event) => {
    for (const listener of ctx2.listeners.get('session/event') ?? []) listener({ id: sessionId }, event)
  }
  const guardedRetry = loaded.save.bind(loaded)
  let releaseRetry
  let startedRetry
  const retryGate = new Promise(resolve => { releaseRetry = resolve })
  const retryStarted = new Promise(resolve => { startedRetry = resolve })
  let privilegedWhileHeld = 0
  loaded.save = (options) => {
    const outcome = loaded.state.privateHolds['a-now']?.items?.find(item => item.messageId === 'm-a')?.outcome
    const privileged = options?.privateCommit !== undefined && options.privateCommit === loaded.privateCommitToken
    if (privileged && outcome === 'held') {
      privilegedWhileHeld += 1
      if (privilegedWhileHeld === 1) {
        loaded.privateCommitToken = undefined
        startedRetry()
        return retryGate.then(() => Promise.reject(new Error('retry was not saved')))
      }
    }
    return guardedRetry(options)
  }
  const retry = post2('retry-private-save', { sessionId: 'a-now' })
  await retryStarted
  fire2('c-label', {
    type: 'agent/inbox/spliced',
    time: 3,
    data: {
      target: 'next-step',
      inserted: [{ id: 'm-label', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello there' }] }],
    },
  })
  const labeled = loaded.privateHoldPersist ?? Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(loaded.state.privateHolds['a-now'].items.find(item => item.messageId === 'm-a').outcome, 'held')
  assert.equal(privilegedWhileHeld, 1)
  releaseRetry()
  const retryResult = await retry
  await labeled
  assert.equal(retryResult.ok, false)
  assert.equal(retryResult.error.code, 'bot/save')
  assert.equal(loaded.state.privateHolds['a-now'].items.find(item => item.messageId === 'm-a').outcome, 'unrecoverable')
  assert.equal(loaded.privateCommitToken, undefined)
  assert.equal(loaded.state.workLines['line-c'].label, 'hello there')
  await ctx2.dispose()
  const ctx3 = fakeContext()
  const again = createRuntime(ctx3, { home })
  t.after(() => ctx3.dispose())
  await again.load()
  assert.equal(again.state.privateHolds['a-now'].items.find(item => item.messageId === 'm-a').outcome, 'unrecoverable')
  assert.equal(again.state.privateHolds['a-now'].status, 'pending')
  assert.equal(again.state.workLines['line-c'].label, 'hello there')
  const diskRetry = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  assert.equal(diskRetry.privateHolds['a-now'].items.find(item => item.messageId === 'm-a').outcome, 'unrecoverable')
  assert.equal(diskRetry.workLines['line-c'].label, 'hello there')
})

test('confirm delivers the held sentence on the bound line and a later choice does not rewrite it', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-deliver-'))
  const team = fakeContext()
  let route
  const register = team.connection.fetch.register
  team.connection.fetch.register = (options) => { route = options; return register(options) }
  const rt = createRuntime(team, { home })
  const ctx = new Context()
  for (const plugin of [SessionStore, SessionProjection, LlmRuntime, ToolRuntime, SystemPrompt, Agents, AgentLoop]) {
    await ctx.plugin(plugin)
  }
  t.after(async () => {
    await ctx.fiber.dispose()
    await team.dispose()
    rmSync(home, { recursive: true, force: true })
  })
  const calls = []
  ctx.llm.registerAdapter(['fake'], {
    providerInfo: (id) => ({ id, name: 'Fake' }),
    providerRetryPolicy: () => undefined,
    async prepareCall() {
      return {
        model: { id: 'fake-model', name: 'Fake', provider: 'fake' },
        stream(options) {
          calls.push(JSON.stringify(options))
          return (async function* () {
            yield { type: 'text-delta', index: 0, text: 'ack' }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        },
      }
    },
  })
  installPrivateHook({
    ctx,
    state: rt.state,
    isBotSession: () => true,
    roomOf: () => undefined,
    save: (options) => rt.save(options),
    warn: () => {},
  })
  const sessionId = 'sess-deliver'
  const routeRt = {
    ctx,
    state: rt.state,
    chatOwners: new Map([[sessionId, 'a']]),
    groupOwners: new Set(),
    isBotSession: () => true,
    roomOf: () => undefined,
    botOf: () => ({ name: 'Bot' }),
    selfOf: (id) => id,
    dropKickoff: () => {},
    save: (options) => rt.save(options),
    warn: () => {},
  }
  installTurns(routeRt)
  const agent = await ctx.agentLoop.create(sessionId, { provider: 'fake', model: 'fake-model' }, { cwd: '/tmp' })
  rt.resolveAgent = async (id) => {
    if (id !== sessionId) throw new Error(`unexpected session ${id}`)
    return agent
  }
  await rt.load()
  createLine(rt.state, { id: 'line-a', botId: 'a', sessionId, label: 'plan the picnic' })
  rt.state.workLines['line-b'] = { id: 'line-b', botId: 'a', sessionId, label: 'budget review', updatedAt: 2, segments: [] }
  const first = createUserMessage({ content: [{ type: 'text', text: 'BIND_SENTENCE_141' }], source: { kind: 'user' } })
  rememberPrivateHold(rt.state, {
    sessionId, botId: 'a', messageId: first.id, action: 'ask', text: 'BIND_SENTENCE_141',
    choices: [
      { id: 'line-a', label: 'plan the picnic', sessionId },
      { id: 'line-b', label: 'budget review', sessionId },
    ],
    at: 1,
  })
  await rt.save({ required: true })
  agent.steer(first)
  await agent.whenIdle()
  assert.equal(calls.length, 0)
  assert.equal(agent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data?.id === first.id), false)
  const post = async (payload) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST',
    body: JSON.stringify({ endpoint: 'confirm-private', payload }),
  }))).json()
  const generation = rt.state.privateHolds[sessionId].generation
  const confirmed = await post({ sessionId, choiceId: 'line-a', generation })
  assert.equal(confirmed.ok, true)
  assert.equal(confirmed.value.bound, true)
  assert.equal(confirmed.value.delivered, true)
  await routeRt.privateHoldPersist
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(rt.state.privateHolds[sessionId].generation, generation)
  assert.equal(rt.state.privateHolds[sessionId].status, 'bound')
  assert.equal(rt.state.privateHolds[sessionId].delivered, true)
  await agent.whenIdle()
  assert.equal(calls.filter(body => body.includes('BIND_SENTENCE_141')).length, 1)
  assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data?.id === first.id).length, 1)
  assert.equal(rt.state.privateHolds[sessionId].delivered, true)
  assert.equal(rt.state.privateHolds[sessionId].label, 'plan the picnic')
  const firstText = agent.session.snapshotEvents().find(event => event.type === 'user/message' && event.data?.id === first.id)
  const opened = createUserMessage({ content: [{ type: 'text', text: '新开 另一件事' }], source: { kind: 'user' } })
  rememberPrivateHold(rt.state, {
    sessionId, botId: 'a', messageId: opened.id, action: 'new', text: '新开 另一件事',
    choices: [
      { id: 'line-a', label: 'plan the picnic', sessionId },
      { id: 'line-b', label: 'budget review', sessionId },
    ],
    at: 2,
  })
  const reboundGeneration = rt.state.privateHolds[sessionId].generation
  const rebound = await post({ sessionId, choiceId: 'line-b', generation: reboundGeneration })
  assert.equal(rebound.ok, true)
  assert.equal(rebound.value.delivered, true)
  await routeRt.privateHoldPersist
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(rt.state.privateHolds[sessionId].generation, reboundGeneration)
  assert.equal(rt.state.privateHolds[sessionId].status, 'bound')
  await agent.whenIdle()
  assert.equal(calls.filter(body => body.includes('新开 另一件事')).length, 1)
  assert.equal(JSON.stringify(agent.session.snapshotEvents().find(event => event.type === 'user/message' && event.data?.id === first.id)), JSON.stringify(firstText))
  assert.equal(rt.state.privateHolds[sessionId].label, 'budget review')
  assert.equal(rt.state.workLines['line-a'].sessionId, sessionId)
  assert.equal(rt.state.workLines['line-b'].sessionId, sessionId)
  await team.dispose()
  const again = fakeContext()
  const loaded = createRuntime(again, { home })
  t.after(() => again.dispose())
  await loaded.load()
  assert.equal(loaded.state.privateHolds[sessionId].status, 'bound')
  assert.equal(loaded.state.privateHolds[sessionId].boundTo, 'line-b')
  assert.equal(loaded.state.privateHolds[sessionId].delivered, true)
  assert.equal(loaded.state.privateHolds[sessionId].label, 'budget review')
  const plainGeneration = rt.state.privateHolds[sessionId].generation
  agent.followup({
    id: 'plain-user',
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: 'BIND_SENTENCE_141' }],
  })
  await routeRt.privateHoldPersist
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(rt.state.privateHolds[sessionId].generation, plainGeneration + 1)
  assert.equal(rt.state.privateHolds[sessionId].status, 'pending')
})

test('a bind during a tool step waits for the next turn and is admitted once', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-busy-bind-'))
  const team = fakeContext()
  let route
  const register = team.connection.fetch.register
  team.connection.fetch.register = (options) => { route = options; return register(options) }
  const rt = createRuntime(team, { home })
  const ctx = new Context()
  for (const plugin of [SessionStore, SessionProjection, LlmRuntime, ToolRuntime, SystemPrompt, Agents, AgentLoop]) {
    await ctx.plugin(plugin)
  }
  t.after(async () => {
    await ctx.fiber.dispose()
    await team.dispose()
    rmSync(home, { recursive: true, force: true })
  })
  const calls = []
  let round = 0
  ctx.llm.registerAdapter(['fake'], {
    providerInfo: (id) => ({ id, name: 'Fake' }),
    providerRetryPolicy: () => undefined,
    async prepareCall() {
      return {
        model: { id: 'fake-model', name: 'Fake', provider: 'fake' },
        stream(options) {
          const body = JSON.stringify(options)
          calls.push(body)
          round += 1
          const current = round
          return (async function* () {
            if (current === 1) {
              yield { type: 'tool-call-delta', index: 0, id: 'busytool-1', name: 'busytool', argumentsDelta: '{}' }
              yield { type: 'finish', reason: { kind: 'tool-calls' } }
              return
            }
            const text = body.includes('BUSY_BIND_141') ? 'BUSY_BIND_ACK' : 'BUSY_POST'
            yield { type: 'text-delta', index: 0, text }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        },
      }
    },
  })
  const sessionId = 'sess-busy'
  installPrivateHook({
    ctx,
    state: rt.state,
    isBotSession: () => true,
    roomOf: () => undefined,
    save: (options) => rt.save(options),
    warn: () => {},
  })
  const routeRt = {
    ctx,
    state: rt.state,
    chatOwners: new Map([[sessionId, 'a']]),
    groupOwners: new Set(),
    isBotSession: () => true,
    roomOf: () => undefined,
    botOf: () => ({ name: 'Bot' }),
    selfOf: (id) => id,
    dropKickoff: () => {},
    save: (options) => rt.save(options),
    warn: () => {},
  }
  installTurns(routeRt)
  const agent = await ctx.agentLoop.create(sessionId, { provider: 'fake', model: 'fake-model' }, { cwd: '/tmp' })
  rt.resolveAgent = async (id) => {
    if (id !== sessionId) throw new Error(`unexpected session ${id}`)
    return agent
  }
  await rt.load()
  const sentence = 'BUSY_BIND_141 please only reply BUSY_BIND_ACK'
  const ask = createUserMessage({ content: [{ type: 'text', text: sentence }], source: { kind: 'user' } })
  const post = async (payload) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST',
    body: JSON.stringify({ endpoint: 'confirm-private', payload }),
  }))).json()
  ctx.tools.register({
    name: 'busytool',
    description: 'Finish the tool step',
    parameters: {},
    async execute() {
      createLine(rt.state, { id: 'line-a', botId: 'a', sessionId, label: 'plan the picnic' })
      agent.steer(ask)
      await routeRt.privateHoldPersist
      const generation = rt.state.privateHolds[sessionId].generation
      const confirmed = await post({ sessionId, choiceId: 'line-a', generation })
      assert.equal(confirmed.ok, true)
      assert.equal(confirmed.value.bound, true)
      assert.equal(confirmed.value.delivered, true)
      assert.equal(confirmed.value.generation, generation)
      assert.equal(agent.inbox.nextStep.some(message => message?.id === ask.id), false)
      assert.equal(agent.inbox.nextTurn.some(message => message?.id === ask.id), true)
      assert.equal(agent.inbox.nextTurn.find(message => message?.id === ask.id)?.source?.dsBotDeliver, true)
      assert.equal(rt.state.privateHolds[sessionId].status, 'bound')
      assert.equal(rt.state.privateHolds[sessionId].delivered, true)
      assert.equal(rt.state.privateHolds[sessionId].generation, generation)
      return 'BUSY_DONE'
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
  })
  agent.steer(createUserMessage({ content: [{ type: 'text', text: 'call the tool' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  await routeRt.privateHoldPersist
  const events = agent.session.snapshotEvents()
  const ends = events.filter(event => event.type === 'turn/end').map(event => event.data?.reason?.kind)
  const admitted = events.filter(event => event.type === 'user/message' && event.data?.id === ask.id)
  assert.equal(ends.includes('blocked'), false, ends)
  assert.equal(ends.includes('aborted'), false, ends)
  assert.equal(calls.length, 3, calls.map(body => body.includes('BUSY_BIND_141')))
  assert.equal(calls[0].includes('BUSY_BIND_141'), false)
  assert.equal(calls[1].includes('BUSY_BIND_141'), false)
  assert.equal(calls[1].includes('BUSY_DONE'), true)
  assert.equal(calls[2].includes('BUSY_BIND_141'), true)
  assert.equal(calls.filter(body => body.includes('BUSY_BIND_141')).length, 1)
  assert.equal(admitted.length, 1)
  assert.equal(admitted[0].data?.source?.dsBotDeliver, true)
  assert.equal(events.some(event => event.type === 'assistant/message' && JSON.stringify(event.data).includes('BUSY_POST')), true)
  assert.equal(events.some(event => event.type === 'assistant/message' && JSON.stringify(event.data).includes('BUSY_BIND_ACK')), true)
  assert.equal(rt.state.privateHolds[sessionId].status, 'bound')
  assert.equal(rt.state.privateHolds[sessionId].delivered, true)
  assert.equal(rt.state.privateHolds[sessionId].generation, 1)
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
