// S1–S8: a user abort drops relays the room log already has, and does not
// follow them up while that abort is unwinding. No @deepseek-ai import.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createRoomHalt,
  dropLoggedRelays,
  haltDelivery,
  isLoggedRelay,
  isUserAbort,
} from '../../vendor/ds-bot/src/host/room-halt.js'

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const source = (path) => readFileSync(join(root, path), 'utf8')

const ROOM = 'session-7c02d810-2a19-4cf4-8414-fef0ca25574a'
const CHIEF = '收到，作文打分这事归我了 📝\n\n把作文发过来就行。如果方便的话，顺带说一句是什么水平的作文（小学/初中/高中/考试类），没有的话我会自己判断。\n\n我会给：分数 + 各维度点评（立意、结构、语言、亮点与问题）+ 修改建议。'
const ASK = '@Chief 你负责给作文打分'

function chiefRelay(extra = {}) {
  return {
    role: 'user',
    id: 'e39523f3-aba1-486e-8f51-0eb5985de0fd',
    content: [{ type: 'text', text: `[Group post from Chief]\n${CHIEF}` }],
    source: {
      kind: 'bot',
      form: 'relay',
      role: 'post',
      exchangeId: 'b9eeb624-45cd-4d18-b7e2-0868fa245413',
      senderName: 'Chief',
      senderSessionId: 'session-a70c2ab4-36a2-438b-af95-e47fd943a36a',
      roomId: ROOM,
      late: true,
      quoteText: ASK,
      quoteSeq: 11,
      quoteRoomId: ROOM,
      logged: 13,
      ...extra,
    },
  }
}

function row(id, source) {
  return { id, role: 'user', source }
}

function fakeInbox(nextTurn = [], nextStep = []) {
  const inbox = { nextTurn: [...nextTurn], nextStep: [...nextStep] }
  inbox.remove = (id) => {
    const before = inbox.nextTurn.length + inbox.nextStep.length
    inbox.nextTurn = inbox.nextTurn.filter(message => message.id !== id)
    inbox.nextStep = inbox.nextStep.filter(message => message.id !== id)
    return inbox.nextTurn.length + inbox.nextStep.length < before
  }
  return inbox
}

function userAbort() {
  return { type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } }
}

function userMessage() {
  return { type: 'user/message', data: { source: { kind: 'user' } } }
}

// The postToRoom branch: a running round already wrote the line (`logged` set).
// `log` appends only when this call has not written it yet. `followup` is the
// only branch that queues another group_relay.
function settlePost({ halted, roundRunning, logged, text, log, followups, inbox }) {
  const delivery = haltDelivery(halted, roundRunning)
  switch (delivery) {
    case 'followup':
      followups.push({ text, logged })
      return delivery
    case 'skip':
      if (inbox !== undefined) dropLoggedRelays(inbox)
      return delivery
    case 'log':
      if (logged === undefined && text !== '') log.push(text)
      if (inbox !== undefined) dropLoggedRelays(inbox)
      return delivery
    default: {
      const unexpected = delivery
      throw new Error(`Unknown halt delivery ${String(unexpected)}`)
    }
  }
}

test('S1 a logged late ack leaves the group inbox when the user stops', () => {
  const halt = createRoomHalt()
  const composer = row('composer', { kind: 'user' })
  const inbox = fakeInbox([chiefRelay(), composer])
  const log = [CHIEF]
  const followups = []
  halt.halt(ROOM)
  assert.equal(halt.observe(ROOM, userAbort()), 'drop')
  assert.equal(halt.has(ROOM), true)
  assert.equal(isLoggedRelay(chiefRelay()), true)
  assert.equal(dropLoggedRelays(inbox), 1)
  assert.deepEqual(inbox.nextTurn.map(message => message.id), ['composer'])
  assert.equal(settlePost({
    halted: halt.has(ROOM),
    roundRunning: true,
    logged: 13,
    text: CHIEF,
    log,
    followups,
    inbox,
  }), 'skip')
  assert.deepEqual(log, [CHIEF])
  assert.deepEqual(followups, [])
  assert.equal(inbox.nextTurn.length, 1)
})

test('S2 a late reply that names the asker is logged once and does not start them', () => {
  const text = `${CHIEF}\n\n@alice 你先看结构`
  const relay = chiefRelay({ askedBy: 'alice', text })
  const inbox = fakeInbox([relay])
  const log = [text]
  const followups = []
  assert.equal(settlePost({
    halted: true,
    roundRunning: true,
    logged: 13,
    text,
    log,
    followups,
    inbox,
  }), 'skip')
  assert.deepEqual(log, [text])
  assert.deepEqual(followups, [])
  assert.equal(inbox.nextTurn.length, 0)
  assert.equal(isLoggedRelay(relay), true)
})

test('S3 a followup after cancel and before idle logs once and does not queue', () => {
  const halt = createRoomHalt()
  halt.halt(ROOM)
  const inbox = fakeInbox([chiefRelay()])
  assert.equal(halt.observe(ROOM, userAbort()), 'drop')
  assert.equal(dropLoggedRelays(inbox), 1)
  assert.equal(inbox.nextTurn.length, 0)
  assert.equal(halt.has(ROOM), true)
  const log = []
  const followups = []
  assert.equal(settlePost({
    halted: true,
    roundRunning: false,
    logged: undefined,
    text: CHIEF,
    log,
    followups,
  }), 'log')
  assert.equal(settlePost({
    halted: true,
    roundRunning: false,
    logged: 14,
    text: CHIEF,
    log,
    followups,
  }), 'log')
  assert.deepEqual(log, [CHIEF])
  assert.deepEqual(followups, [])
})

test('S4 a composer line survives Stop', () => {
  const composer = row('composer-queued', { kind: 'user', text: 'next line from me' })
  const inbox = fakeInbox([
    composer,
    chiefRelay(),
    row('user-logged', { kind: 'user', form: 'relay', role: 'post', logged: 13 }),
  ])
  assert.equal(dropLoggedRelays(inbox), 1)
  assert.deepEqual(inbox.nextTurn.map(message => message.id), ['composer-queued', 'user-logged'])
  assert.equal(isLoggedRelay(composer), false)
})

test('S5 Stop all logs a member who finishes during unwind once', () => {
  const inbox = fakeInbox([chiefRelay()])
  const followups = []
  const runningLog = [CHIEF]
  assert.equal(settlePost({
    halted: true,
    roundRunning: true,
    logged: 13,
    text: CHIEF,
    log: runningLog,
    followups,
    inbox,
  }), 'skip')
  assert.deepEqual(runningLog, [CHIEF])
  assert.equal(inbox.nextTurn.length, 0)

  const after = []
  assert.equal(settlePost({
    halted: true,
    roundRunning: false,
    logged: undefined,
    text: 'Could not finish: its model call failed (SERVER).',
    log: after,
    followups,
  }), 'log')
  assert.deepEqual(after, ['Could not finish: its model call failed (SERVER).'])
  assert.deepEqual(followups, [])
})

test('S6 with no Stop the line is not duplicated and the asker still gets a turn', () => {
  const log = [CHIEF]
  const followups = []
  assert.equal(settlePost({
    halted: false,
    roundRunning: true,
    logged: 13,
    text: CHIEF,
    log,
    followups,
  }), 'followup')
  assert.equal(settlePost({
    halted: false,
    roundRunning: false,
    logged: undefined,
    text: CHIEF,
    log,
    followups,
  }), 'followup')
  assert.deepEqual(log, [CHIEF])
  assert.equal(followups.length, 2)
  assert.equal(haltDelivery(false, true), 'followup')
  assert.equal(haltDelivery(false, false), 'followup')
})

test('S7 bob private ask_user is left in place', () => {
  const questions = {
    'session-1d2ad8e6-5c68-4f72-98af-26726d18b93d': {
      id: 'ca816c77-0dc5-4918-8c7c-6813efcd5fa4',
      question: '你想让我先重点做点什么？',
    },
  }
  const before = structuredClone(questions)
  const ask = row('ask', { kind: 'bot', form: 'question', role: 'ask' })
  const inbox = fakeInbox([chiefRelay(), ask])
  assert.equal(dropLoggedRelays(inbox), 1)
  assert.deepEqual(inbox.nextTurn.map(message => message.id), ['ask'])
  assert.deepEqual(questions, before)
  assert.equal(isLoggedRelay(ask), false)
})

test('S8 mid-round user lines are still the only inbox rows a round drains', () => {
  const groups = source('vendor/ds-bot/src/host/groups.js')
  const waiting = groups.slice(groups.indexOf('const waitingLines'), groups.indexOf('function drainRoomInbox'))
  assert.match(waiting, /message\.source\?\.kind !== 'user'/)
  const relay = chiefRelay()
  assert.equal(relay.source.kind === 'user', false)
  assert.equal(isLoggedRelay(row('plain', { kind: 'user' })), false)
})

test('logged failure relays go; kickoff, resume, and unlogged posts stay', () => {
  const failure = row('failed', { kind: 'bot', form: 'relay', role: 'post', logged: true, late: true })
  const unlogged = row('fresh', { kind: 'bot', form: 'relay', role: 'post', late: true })
  const kickoff = row('greet', { kind: 'bot', form: 'relay', role: 'kickoff', logged: 1 })
  const resume = row('cont', { kind: 'bot', form: 'relay', role: 'resume', logged: 2 })
  const missing = { role: 'user', source: { kind: 'bot', form: 'relay', role: 'post', logged: 4 } }
  const step = row('step-logged', { kind: 'bot', form: 'relay', role: 'post', logged: 9 })
  const inbox = fakeInbox([failure, unlogged, kickoff, resume, missing], [step])
  assert.equal(dropLoggedRelays(inbox), 2)
  assert.deepEqual(inbox.nextTurn.map(message => message.id), ['fresh', 'greet', 'cont', undefined])
  assert.deepEqual(inbox.nextStep.map(message => message.id), [])
  assert.equal(dropLoggedRelays(null), 0)
  assert.equal(dropLoggedRelays(undefined), 0)
  assert.equal(isLoggedRelay(unlogged), false)
  assert.equal(isLoggedRelay(kickoff), false)
})

test('halt stays through the user abort and clears on the next real user message', () => {
  const halt = createRoomHalt()
  assert.equal(halt.observe('', userAbort()), 'none')
  assert.equal(halt.halt(''), undefined)
  assert.equal(halt.has(''), false)
  const listeners = new Set()
  const signal = {
    aborted: false,
    addEventListener(_type, fn) { listeners.add(fn) },
    removeEventListener(_type, fn) { listeners.delete(fn) },
    abort() {
      this.aborted = true
      for (const fn of listeners) fn()
    },
  }
  const onAbort = () => halt.halt(ROOM)
  if (signal.aborted) onAbort()
  else signal.addEventListener('abort', onAbort)
  signal.abort()
  signal.removeEventListener('abort', onAbort)
  assert.equal(halt.has(ROOM), true)
  assert.equal(haltDelivery(true, true), 'skip')
  assert.equal(haltDelivery(true, false), 'log')
  assert.equal(halt.observe(ROOM, userAbort()), 'drop')
  assert.equal(halt.has(ROOM), true)
  assert.equal(halt.observe(ROOM, {
    type: 'turn/end',
    data: { reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'ds-bot/stopped' } } },
  }), 'none')
  assert.equal(halt.observe(ROOM, { type: 'turn/end', data: { reason: { kind: 'aborted' } } }), 'none')
  assert.equal(halt.has(ROOM), true)
  assert.equal(isUserAbort({ kind: 'aborted', reason: { kind: 'user' } }), true)
  assert.equal(isUserAbort({ kind: 'aborted' }), false)
  assert.equal(halt.observe(ROOM, {
    type: 'user/message',
    data: { source: { kind: 'bot', form: 'relay', role: 'post', logged: 13 } },
  }), 'none')
  assert.equal(halt.has(ROOM), true)
  assert.equal(halt.observe(ROOM, userMessage()), 'clear')
  assert.equal(halt.has(ROOM), false)
  assert.equal(haltDelivery(halt.has(ROOM), false), 'followup')
})

test('group_relay arms the halt flag and postToRoom uses one inbox helper', () => {
  const groups = source('vendor/ds-bot/src/host/groups.js')
  const halt = source('vendor/ds-bot/src/host/room-halt.js')
  assert.doesNotMatch(groups, /keepInbox/)
  assert.doesNotMatch(halt, /keepInbox/)
  assert.match(groups, /from '\.\/room-halt\.js'/)
  assert.match(groups, /dropLoggedRelays/)
  assert.match(groups, /roomHalt\.observe/)
  assert.match(groups, /\.cancel\(\{ kind: 'user' \}\)/)

  const tool = groups.slice(groups.indexOf("name: 'group_relay'"), groups.indexOf("name: 'read_own_chat'"))
  const listenAt = tool.indexOf("addEventListener('abort', halt")
  const ensureAt = tool.indexOf('ensureRoomLog(room)')
  assert.ok(listenAt >= 0 && ensureAt > listenAt)
  assert.match(tool, /roomHalt\.halt\(room\.id\)/)
  assert.match(tool, /removeEventListener\('abort', halt\)/)

  const post = groups.slice(groups.indexOf('async function postToRoom'), groups.indexOf('rt.postToRoom = postToRoom'))
  const resolveAt = post.indexOf('await rt.resolveAgent(room.id)')
  const deliveryAt = post.indexOf('haltDelivery(roomHalt.has(room.id), running !== undefined)')
  const followAt = post.indexOf('agent.followup')
  const skipAt = post.indexOf("case 'skip'")
  const logAt = post.indexOf("case 'log'")
  assert.ok(resolveAt >= 0 && deliveryAt > resolveAt && followAt > deliveryAt && followAt < skipAt && skipAt < logAt)
  assert.match(post.slice(skipAt, logAt), /dropLoggedRelays\(agent\?\.inbox\)/)
  assert.match(post.slice(logAt), /if \(logged === undefined\)/)
  assert.match(post.slice(logAt), /logHaltedPost/)
  assert.match(post.slice(logAt), /dropLoggedRelays\(agent\?\.inbox\)/)
  assert.equal(post.indexOf('agent.followup', followAt + 1), -1)

  const haltedLog = groups.slice(groups.indexOf('function logHaltedPost'), groups.indexOf('async function postToRoom'))
  assert.match(haltedLog, /if \(line === ''\) return undefined/)
  assert.match(haltedLog, /extra\.stopped === true/)
  assert.doesNotMatch(haltedLog, /extra\.failed/)
  assert.match(groups, /if \(opener\.late\) return found\.length > 0 \? found : members\.filter\(bot => bot\.id === opener\.askedBy\)/)
})
