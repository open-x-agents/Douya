import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import { applyPrivateWithhold } from '../src/host/route-private-hook.js'
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
  assert.equal(only.action, 'steer')
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
  const idle = routePrivate({ text: 'hello there', busy: false, lines: [current] })
  assert.equal(idle.action, 'steer')
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

test('ask and new leave the step payload, and a failed queue move leaves the sentence there', () => {
  const state = {}
  rememberPrivateHold(state, {
    sessionId: 'sess-now',
    messageId: 'm-ask',
    action: 'ask',
    text: 'which one',
    choices: [{ id: 'line-now', label: 'plan the picnic' }],
    at: 1,
  })
  rememberPrivateHold(state, {
    sessionId: 'sess-now',
    messageId: 'm-new',
    action: 'new',
    text: '新开 预算',
    at: 2,
  })
  const askPayload = { agent: { id: 'sess-now' }, messages: [user('m-ask', 'which one'), user('m-keep', 'plan the picnic')] }
  const rt = { state, isBotSession: () => true, roomOf: () => undefined }
  applyPrivateWithhold(rt, askPayload)
  assert.deepEqual(askPayload.messages.map(message => message.id), ['m-keep'])

  const queued = { agent: { id: 'sess-now', inbox: { append() { throw new Error('full') } } }, messages: [user('m-q', 'later')] }
  rememberPrivateHold(state, { sessionId: 'sess-now', messageId: 'm-q', action: 'queue', text: 'later', at: 3 })
  const warnings = []
  applyPrivateWithhold({ ...rt, warn: (...args) => warnings.push(args.join(' ')) }, queued)
  assert.deepEqual(queued.messages.map(message => message.id), ['m-q'])
  assert.equal(warnings.length, 1)

  const moved = []
  const ok = { agent: { id: 'sess-now', inbox: { append(target, message) { moved.push([target, message.id]) } } }, messages: [user('m-q', 'later'), user('m-keep', 'stay')] }
  applyPrivateWithhold(rt, ok)
  assert.deepEqual(moved, [['next-turn', 'm-q']])
  assert.deepEqual(ok.messages.map(message => message.id), ['m-keep'])
  assert.equal((privateHold(state, 'sess-now').items ?? []).some(item => item.messageId === 'm-q'), false)

  const bound = bindPrivateHold(state, 'sess-now', 'line-now', 9)
  assert.equal(bound.status, 'bound')
  assert.equal(bound.boundTo, 'line-now')
  assert.equal(bound.label, 'plan the picnic')
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
