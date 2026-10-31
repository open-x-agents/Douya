// L1–L7: busy-time live receive and one-bubble finalize (#3).
// Pure modules, a turns.js install, and a feed.js install — no @deepseek-ai.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SOURCE_KIND } from '../../vendor/ds-bot/src/host/constants.js'
import { FEED_ROUTE, install as installFeed } from '../../vendor/ds-bot/src/host/feed.js'
import { install as installTurns } from '../../vendor/ds-bot/src/host/turns.js'
import { roundForStream } from '../../vendor/ds-bot/src/host/group-steer.js'
import { effectsOf, routeTakesEffect } from '../../vendor/ds-bot/src/host/route-inbound.js'
import { isHiddenTurn } from '../../vendor/ds-bot/src/client/text.js'
import { applyRoomStreamFrame, clearDraftIfPosted, draftForDisplay } from '../../vendor/ds-bot/src/shared/room-draft.js'
import { resolveSendMode } from '../../vendor/ds-bot/src/shared/send-mode.js'

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const source = (path) => readFileSync(join(root, path), 'utf8')

function host() {
  const handlers = []
  const steered = []
  const room = {
    id: 'r1',
    name: 'Launch',
    members: ['chief', 'writer'],
    sessions: { chief: 'ga', writer: 'gb' },
  }
  const bots = {
    chief: { id: 'chief', name: 'Chief' },
    writer: { id: 'writer', name: 'Writer' },
  }
  const rt = {
    ctx: { on: (type, fn) => { if (type === 'session/event') handlers.push(fn) } },
    state: { questions: {}, views: {}, exchanges: [] },
    warn() {},
    save: async () => {},
    dropKickoff() {},
    roomOf: (id) => (id === 'r1' ? room : undefined),
    botOf: (id) => bots[id],
    isBotSession: (id) => id === 'ga' || id === 'gb' || id === 'priv',
    groupOwners: new Set(['ga', 'gb']),
    chatOwners: new Map(),
    selfOf: (id) => id,
    switchJobs: () => [],
    roomWaiters: new Map(),
    lateRoomReply() {},
    takeRoomSteps: () => '',
    withRoomSteps: (_held, reply) => reply,
    noteFailure() {},
    deliver: async () => {},
    acceptRoomSteer: async (target, member, message) => { steered.push({ target, member, message }) },
    noteSteeredRoomLine() {},
    takeRelayIntent: () => false,
    allowRelayText() {},
  }
  installTurns(rt)
  const emit = (sessionId, event) => {
    for (const fn of handlers) fn({ id: sessionId }, event)
  }
  return { rt, emit, steered, room }
}

function spliced(text, target = 'next-step', source = { kind: 'user' }) {
  return {
    type: 'agent/inbox/spliced',
    time: 3250,
    data: {
      target,
      inserted: [{ id: 'm1', role: 'user', source, content: [{ type: 'text', text }] }],
    },
  }
}

function userMessage(text, source = { kind: 'user' }) {
  return { type: 'user/message', data: { source, content: [{ type: 'text', text }] } }
}

function speak(attemptId, pieces) {
  let draft = applyRoomStreamFrame(undefined, { type: 'start', attemptId }, { botId: 'chief' })
  for (const piece of pieces) {
    draft = applyRoomStreamFrame(draft, {
      type: 'chunk',
      attemptId,
      chunk: { type: 'text-delta', text: piece },
    }, { botId: 'chief' })
  }
  return applyRoomStreamFrame(draft, { type: 'end', attemptId }, { botId: 'chief' })
}

function openFeed() {
  const listeners = new Map()
  const routes = {}
  const disposers = []
  const ctx = {
    on(type, fn) {
      const list = listeners.get(type) ?? []
      list.push(fn)
      listeners.set(type, list)
    },
    effect(run) {
      const dispose = run()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    connection: { fetch: { register(options) { routes[options.path] = options } } },
  }
  const state = { revision: 3, exchangeTurns: { m1c: [7] } }
  const rt = {
    ctx,
    state,
    chatOwners: new Map([['m1c', 'm1']]),
    selfOf: (id) => (id === 'm1c' ? 'm1' : undefined),
    displayItems: () => [],
  }
  installFeed(rt)
  return {
    routes,
    emit(type, payload) {
      for (const fn of listeners.get(type) ?? []) fn(payload)
    },
    stop() {
      for (const dispose of disposers.splice(0)) dispose()
    },
  }
}

function reader(response) {
  const source = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  return async function next() {
    for (;;) {
      const end = buffer.indexOf('\n\n')
      if (end >= 0) {
        const block = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        if (block.startsWith(':')) continue
        const field = (name) => block.split('\n').find(line => line.startsWith(`${name}: `))?.slice(name.length + 2)
        return { event: field('event'), data: JSON.parse(field('data')) }
      }
      const { value, done } = await source.read()
      if (done) return undefined
      buffer += decoder.decode(value, { stream: true })
    }
  }
}

test('L1 an idle private chat queues, and an idle group message waits in the room inbox', () => {
  assert.equal(resolveSendMode({ running: false }), 'queue')
  assert.equal(resolveSendMode({}), 'queue')
  const quiet = { speaking: null, slots: [{ id: 'chief', status: 'done' }], replies: [] }
  assert.equal(roundForStream({ rounds: [quiet], botId: 'chief', memberLive: undefined }), undefined)
  assert.equal(roundForStream({ rounds: [quiet], botId: 'chief', memberLive: { turn: undefined } }), undefined)

  const { rt, emit, steered } = host()
  emit('priv', userMessage('私聊空闲'))
  assert.equal(steered.length, 0)
  assert.equal(rt.roomInbox.get('r1'), undefined)
  emit('r1', userMessage('群里空闲'))
  assert.equal(steered.length, 0)
  assert.deepEqual(rt.roomInbox.get('r1').map(item => item.text), ['群里空闲'])
})

test('L2 two different next-step splices while the member is generating both steer, and the echo does not', () => {
  const { rt, emit, steered } = host()
  emit('ga', { type: 'turn/start', data: { turn: 4 }, time: 1 })
  emit('r1', spliced('先看进度'))
  emit('r1', spliced('再补一句'))
  assert.equal(steered.length, 2)
  assert.deepEqual(steered.map(item => item.message.text), ['先看进度', '再补一句'])
  assert.equal(steered.every(item => item.member.sessionId === 'ga'), true)
  assert.equal(rt.roomInbox.get('r1'), undefined)
  emit('r1', userMessage('再补一句'))
  assert.equal(steered.length, 2)
  assert.equal(rt.roomInbox.get('r1'), undefined)
})

test('L3 explicit queue still queues while busy, and idle stays queue', () => {
  assert.equal(resolveSendMode({ requested: 'queue', running: true }), 'queue')
  assert.equal(resolveSendMode({ requested: 'queue', running: false }), 'queue')
  assert.equal(resolveSendMode({ running: false }), 'queue')
  const { rt, emit, steered } = host()
  emit('r1', userMessage('空闲仍排队'))
  emit('ga', { type: 'turn/start', data: { turn: 4 }, time: 1 })
  emit('r1', userMessage('这句排队', { kind: 'user', mode: 'queue' }))
  assert.equal(steered.length, 0)
  assert.deepEqual(rt.roomInbox.get('r1').map(item => item.text), ['空闲仍排队', '这句排队'])
})

test('L4 channel send uses resolveSendMode and the composer busyEnter is steer', () => {
  assert.equal(resolveSendMode({ running: true }), 'steer')
  assert.equal(resolveSendMode({ requested: 'queue', running: true }), 'queue')
  assert.equal(resolveSendMode({ requested: 'steer', running: false }), 'steer')
  assert.equal(resolveSendMode({ requested: 'followup', running: true }), 'steer')
  const channel = source('vendor/ds-bot/src/host/channel.js')
  const sendAt = channel.indexOf("case 'send':")
  const routeAt = channel.indexOf('routeRoomUser?.(', sendAt)
  const modeAt = channel.indexOf('resolveSendMode({ requested, running })', sendAt)
  assert.ok(sendAt >= 0 && routeAt > sendAt && modeAt > routeAt)
  assert.match(channel, /prompt\(\{/)
  assert.doesNotMatch(channel, /mode:\s*['"]queue['"]/)
  const patch = source('vendor/ds-bot/cordis.patch.yml')
  assert.match(patch, /busyEnter:\s*steer/)
  assert.doesNotMatch(patch, /busyEnter:\s*queue/)
})

test('L5 a hidden Bot-to-Bot turn stays off the private feed', async (t) => {
  const roster = { exchangeTurns: { m1c: [7] } }
  assert.equal(isHiddenTurn(roster, 'm1c', 7), true)
  assert.equal(isHiddenTurn(roster, 'm1c', 8), false)
  const quiet = { speaking: null, slots: [{ id: 'chief', status: 'done' }], replies: [] }
  assert.equal(roundForStream({ rounds: [quiet], botId: 'chief', memberLive: { turn: undefined } }), undefined)

  const feed = openFeed()
  const abort = new AbortController()
  t.after(() => {
    abort.abort()
    feed.stop()
  })
  const response = await feed.routes[FEED_ROUTE].fetch(new Request('http://localhost/api/bot/feed', { signal: abort.signal }))
  const next = reader(response)
  assert.equal((await next()).event, 'hello')

  const hidden = { id: 'm1c' }
  feed.emit('agent/assistant-stream', { agent: hidden, frame: { type: 'start', attemptId: 'a7', turn: 7 } })
  feed.emit('agent/assistant-stream', { agent: hidden, frame: { type: 'chunk', attemptId: 'a7', chunk: { type: 'text-delta', text: '隐藏句' } } })
  feed.emit('agent/assistant-stream', { agent: hidden, frame: { type: 'end', attemptId: 'a7' } })
  feed.emit('agent/assistant-stream', { agent: { id: 'ga' }, frame: { type: 'start', attemptId: 'room', turn: 1 } })
  feed.emit('agent/assistant-stream', { agent: { id: 'ga' }, frame: { type: 'chunk', attemptId: 'room', chunk: { type: 'text-delta', text: '群里的字' } } })
  feed.emit('agent/assistant-stream', { agent: hidden, frame: { type: 'start', attemptId: 'a8', turn: 8 } })
  feed.emit('agent/assistant-stream', { agent: hidden, frame: { type: 'chunk', attemptId: 'a8', chunk: { type: 'text-delta', text: '可见' } } })
  feed.emit('agent/assistant-stream', { agent: hidden, frame: { type: 'chunk', attemptId: 'a8', chunk: { type: 'text-delta', text: '尾巴' } } })
  feed.emit('agent/assistant-stream', { agent: hidden, frame: { type: 'end', attemptId: 'a8' } })

  const target = { botId: 'm1', sessionId: 'm1c', attemptId: 'a8' }
  assert.deepEqual(await next(), { event: 'stream', data: { ...target, phase: 'start' } })
  assert.deepEqual(await next(), { event: 'stream', data: { ...target, text: '可见' } })
  assert.deepEqual(await next(), { event: 'stream', data: { ...target, text: '尾巴' } })
  assert.deepEqual(await next(), { event: 'stream', data: { ...target, phase: 'end' } })
})

test('L6 one attempt finalizes to a single line and keeps the tail on that line', () => {
  const seed = applyRoomStreamFrame(undefined, { type: 'start', attemptId: 'a0' }, { botId: 'chief' })
  assert.equal(clearDraftIfPosted(seed, []), seed)
  assert.equal(draftForDisplay(seed, []), undefined)

  const draft = speak('a1', ['先说一句', '这是结尾'])
  assert.equal(draft.text, '先说一句这是结尾')
  assert.equal(draft.ended, true)
  assert.equal(draftForDisplay(draft, [])?.text, '先说一句这是结尾')
  assert.equal(clearDraftIfPosted(draft, [{ kind: 'steering', text: '先说一句这是结尾' }]), draft)
  assert.equal(clearDraftIfPosted(draft, [{ kind: 'user', text: '先说一句这是结尾' }]), draft)

  const same = '先说一句这是结尾'
  assert.equal(clearDraftIfPosted(draft, [{ botId: 'chief', text: same }]), undefined)
  assert.equal(draftForDisplay(draft, [{ botId: 'chief', text: same }]), undefined)

  const longer = '先说一句这是结尾，还有一笔'
  assert.equal(longer.startsWith(draft.text), true)
  assert.equal(clearDraftIfPosted(draft, [{ botId: 'chief', text: longer }]), undefined)
  assert.equal(draftForDisplay(draft, [{ botId: 'chief', text: longer }]), undefined)
  assert.match(longer, /这是结尾/)

  const first = speak('a1', ['第一句', '的尾巴'])
  const second = speak('a2', ['第二句', '的尾巴'])
  assert.equal(first.text, '第一句的尾巴')
  assert.equal(second.text, '第二句的尾巴')
  const firstLine = { botId: 'chief', text: first.text }
  const secondLine = { botId: 'chief', text: second.text }
  assert.equal(clearDraftIfPosted(first, [firstLine]), undefined)
  assert.equal(clearDraftIfPosted(second, [firstLine, secondLine]), undefined)
  assert.equal(draftForDisplay(first, [firstLine]), undefined)
  assert.equal(draftForDisplay(second, [firstLine, secondLine]), undefined)
  const isolated = applyRoomStreamFrame(second, {
    type: 'chunk',
    attemptId: 'a1',
    chunk: { type: 'text-delta', text: '串了' },
  }, { botId: 'chief' })
  assert.equal(isolated.text, '第二句的尾巴')
})

test('L6 a shorter posted prefix keeps the unposted tail on the same attempt', () => {
  let draft = applyRoomStreamFrame(undefined, { type: 'start', attemptId: 'a1' }, { botId: 'chief' })
  draft = applyRoomStreamFrame(draft, { type: 'chunk', attemptId: 'a1', chunk: { type: 'text-delta', text: '先说一句' } }, { botId: 'chief' })
  draft = applyRoomStreamFrame(draft, { type: 'chunk', attemptId: 'a1', chunk: { type: 'text-delta', text: '这是结尾' } }, { botId: 'chief' })
  const kept = clearDraftIfPosted(draft, [{ botId: 'chief', text: '先说一句' }])
  assert.equal(kept, draft)
  assert.equal(draftForDisplay(kept, [{ botId: 'chief', text: '先说一句' }])?.text, '先说一句这是结尾')
  const grown = applyRoomStreamFrame(kept, {
    type: 'chunk',
    attemptId: 'a1',
    chunk: { type: 'text-delta', text: '又来' },
  }, { botId: 'chief' })
  assert.equal(grown.text, '先说一句这是结尾又来')
  assert.equal(clearDraftIfPosted(draft, [{ botId: 'chief', text: '这是结尾' }]), draft)
})

test('L6 joined same-attempt lines and a trimmed name cover the draft', () => {
  const draft = speak('a1', ['先说一句', '这是结尾'])
  const parts = [
    { botId: 'chief', text: '先说一句' },
    { botId: 'chief', text: '这是结尾' },
  ]
  assert.equal(clearDraftIfPosted(draft, parts), undefined)
  assert.equal(draftForDisplay(draft, parts), undefined)
  assert.equal(clearDraftIfPosted(draft, [...parts, { botId: 'chief', text: '另一轮' }]), undefined)
  assert.equal(clearDraftIfPosted(draft, [{ botId: 'chief', text: draft.text }, { botId: 'chief', text: '另一轮' }]), undefined)
  assert.equal(clearDraftIfPosted(draft, [{ botId: 'chief', text: `  ${draft.text}  ` }]), undefined)
  assert.equal(clearDraftIfPosted(draft, [{ botId: 'chief', name: 'Chief', text: 'Chief：先说一句这是结尾' }]), undefined)
  assert.equal(clearDraftIfPosted(draft, [{ botId: 'chief', name: 'Chief', text: '**Chief**：先说一句这是结尾' }]), undefined)
  assert.equal(clearDraftIfPosted(draft, [{ botId: 'chief', name: 'Chief', text: 'Chief：先说一句这是结尾，补了一笔' }]), undefined)
  assert.equal(clearDraftIfPosted(draft, [{ botId: 'chief', name: 'Chief', text: 'Chief：先说一句\n\n这是结尾' }]), undefined)
  assert.equal(clearDraftIfPosted(draft, [{ botId: 'writer', name: 'Chief', text: 'Chief：先说一句这是结尾' }]), draft)
})

test('L5 a Bot-to-Bot request is not a user-visible group turn', () => {
  const roomSource = (role, exchangeId) => ({ kind: SOURCE_KIND, role, exchangeId, roomId: 'r1' })
  const visible = host()
  visible.emit('ga', { type: 'turn/start', data: { turn: 4 }, time: 1 })
  assert.equal(visible.rt.turnVisibleInGroup('ga'), true)
  visible.emit('ga', { type: 'user/message', data: { source: roomSource('room', 'room-1'), content: [{ type: 'text', text: '房间回合' }] } })
  assert.equal(visible.rt.turnVisibleInGroup('ga'), true)

  const hidden = host()
  hidden.emit('ga', { type: 'turn/start', data: { turn: 5 }, time: 2 })
  hidden.emit('ga', { type: 'user/message', data: { source: roomSource('request', 'req-1'), content: [{ type: 'text', text: '请另一位回答' }] } })
  assert.equal(hidden.rt.turnVisibleInGroup('ga'), false)
  hidden.emit('ga', { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  hidden.emit('ga', { type: 'turn/start', data: { turn: 6 }, time: 3 })
  hidden.emit('ga', { type: 'user/message', data: { source: roomSource('stopped', 'stop-1'), content: [{ type: 'text', text: '停一下' }] } })
  assert.equal(hidden.rt.turnVisibleInGroup('ga'), false)

  const priv = host()
  priv.emit('priv', { type: 'turn/start', data: { turn: 1 }, time: 4 })
  assert.equal(priv.rt.turnVisibleInGroup('priv'), false)

  const groups = source('vendor/ds-bot/src/host/groups.js')
  const streamAt = groups.indexOf("ctx.on('agent/assistant-stream'")
  const visibleAt = groups.indexOf('turnVisibleInGroup', streamAt)
  const applyAt = groups.indexOf('applyRoomStreamFrame', streamAt)
  assert.ok(streamAt >= 0 && visibleAt > streamAt && applyAt > visibleAt)
  const turns = source('vendor/ds-bot/src/host/turns.js')
  assert.match(turns, /rt\.turnVisibleInGroup = \(sessionId\) => speaksInGroup\(sessionId, live\.get\(sessionId\)\?\.info\)/)
})

test('L7 work-line routing still owns the room decision, and send mode stays behind it', () => {
  assert.equal(routeTakesEffect(undefined), false)
  assert.equal(effectsOf({ action: 'continue' }).writeLog, false)
  assert.equal(effectsOf({ action: 'continue' }).copyTranscript, false)
  assert.equal(effectsOf({ action: 'steer' }).writeLog, false)
  assert.equal(effectsOf({ action: 'steer' }).copyTranscript, false)

  const absent = host()
  absent.emit('ga', { type: 'turn/start', data: { turn: 4 }, time: 1 })
  absent.emit('r1', spliced('甲'))
  absent.emit('r1', spliced('乙'))
  assert.equal(absent.steered.length, 2)
  assert.equal(absent.rt.roomInbox.get('r1'), undefined)

  const routed = host()
  const applied = []
  routed.rt.routeRoomUser = () => ({ action: 'steer', sessionId: 'ga', text: '丙' })
  routed.rt.applyRouteDecision = async (room, decision, message) => {
    applied.push({ roomId: room.id, action: decision.action, text: message.text })
  }
  routed.emit('ga', { type: 'turn/start', data: { turn: 4 }, time: 1 })
  routed.emit('r1', spliced('丙'))
  assert.equal(routeTakesEffect({ action: 'steer' }), true)
  assert.deepEqual(applied, [{ roomId: 'r1', action: 'steer', text: '丙' }])
  assert.equal(routed.steered.length, 0)
  assert.equal(routed.rt.roomInbox.get('r1'), undefined)

  const channel = source('vendor/ds-bot/src/host/channel.js')
  const sendAt = channel.indexOf("case 'send':")
  assert.ok(channel.indexOf('routeRoomUser?.(', sendAt) < channel.indexOf('resolveSendMode(', sendAt))
  const turns = source('vendor/ds-bot/src/host/turns.js')
  const admitAt = turns.indexOf('const admitRoomUser')
  assert.ok(turns.indexOf('routeRoomUser?.(', admitAt) < turns.indexOf('decideRoomSteer(', admitAt))
  const inbound = source('vendor/ds-bot/src/host/route-inbound.js')
  const single = inbound.indexOf('busy.length === 1 && local.length === 1')
  const multi = inbound.indexOf('busy.length >= 2 || (busy.length === 1 && local.length === 0)')
  assert.ok(single >= 0 && multi > single)
  assert.match(inbound, /function deliverAcrossRooms/)
  assert.doesNotMatch(inbound, /work-line-complete/)
})
