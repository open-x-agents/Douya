// W1–W8: a work line points at an existing session. No message body is stored.
// Pure modules and a turns.js install fake only — no @deepseek-ai import.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SOURCE_KIND } from '../../vendor/ds-bot/src/host/constants.js'
import { install as installTurns } from '../../vendor/ds-bot/src/host/turns.js'
import {
  createLine,
  ensureLegacy,
  followSegment,
  getFullThread,
  implicitLine,
  indexOnly,
  isBusy,
  lineForMember,
  listByBot,
  noteTurnEnd,
} from '../../vendor/ds-bot/src/host/work-lines.js'

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const source = (path) => readFileSync(join(root, path), 'utf8')

function ids() {
  let n = 0
  return () => `wl-${n++}`
}

function team() {
  return {
    bots: {
      chief: { id: 'chief', name: 'Chief', sessionId: 'dm' },
    },
    rooms: {
      r1: { id: 'r1', name: 'Launch', seq: 4, sessions: { chief: 'ga' }, members: ['chief'] },
    },
    workLines: {},
    workLineCompleted: {},
  }
}

function userEvent(text, seq) {
  return { type: 'user/message', seq, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } }
}

function assistantEvent(text, seq) {
  return { type: 'assistant/message', seq, data: { message: { content: [{ type: 'text', text }] } } }
}

function turnsHost(noteWorkTurnEnd) {
  const handlers = []
  const rt = {
    ctx: { on: (type, fn) => { if (type === 'session/event') handlers.push(fn) } },
    state: { questions: {}, views: {}, exchanges: [], exchangeTurns: {} },
    warn() {},
    save: async () => {},
    dropKickoff() {},
    roomOf: () => undefined,
    botOf: (id) => (id === 'chief' ? { id: 'chief', name: 'Chief' } : undefined),
    isBotSession: (id) => id === 'dm' || id === 'ga',
    groupOwners: new Map(),
    chatOwners: new Map([['dm', 'chief']]),
    selfOf: (id) => (id === 'dm' || id === 'ga' ? 'chief' : undefined),
    switchJobs: () => [],
    roomWaiters: new Map(),
    lateRoomReply() {},
    takeRoomSteps: () => '',
    withRoomSteps: (_held, reply) => reply,
    noteFailure() {},
    deliver: async () => {},
    noteWorkTurnEnd,
  }
  installTurns(rt)
  const emit = (sessionId, event) => {
    for (const fn of handlers) fn({ id: sessionId }, event)
  }
  return { rt, emit }
}

function roomTurn(exchangeId) {
  return {
    type: 'user/message',
    data: {
      source: { kind: SOURCE_KIND, role: 'room', exchangeId, roomId: 'r1' },
      content: [{ type: 'text', text: 'your turn' }],
    },
  }
}

test('W1 getFullThread reads the session log and ignores an index copy', () => {
  const state = team()
  const createId = ids()
  ensureLegacy(state, { now: 1, createId })
  const line = Object.values(state.workLines).find(item => item.sessionId === 'dm')
  line.messages = [{ text: 'INDEX COPY' }]
  line.memory = 'remember this'
  line.label = 'INDEX COPY'
  assert.equal(ensureLegacy(state, { now: 2, createId: () => 'wl-nope' }), true)
  assert.equal(indexOnly(line), true)
  assert.equal(line.label, 'INDEX COPY')
  const messages = getFullThread(state, line.id, {
    logs: { dm: [userEvent('from the log', 1), assistantEvent('the answer', 2)] },
  })
  assert.deepEqual(messages.map(message => message.text), ['from the log', 'the answer'])
  assert.equal(messages.some(message => message.text === 'INDEX COPY'), false)
  assert.equal(JSON.stringify(state.workLines).includes('from the log'), false)
})

test('W2 two lines of one bot keep one MEMORY.md', () => {
  const state = team()
  ensureLegacy(state, { now: 1, createId: ids() })
  const lines = listByBot(state, 'chief')
  assert.equal(lines.length, 2)
  assert.equal(lines[0].botId, 'chief')
  assert.equal(lines[1].botId, 'chief')
  assert.notEqual(lines[0].sessionId, lines[1].sessionId)
  const own = `memory/bots/${lines[0].botId}/MEMORY.md`
  const teamPath = 'memory/team/MEMORY.md'
  assert.equal(`memory/bots/${lines[1].botId}/MEMORY.md`, own)
  assert.equal(teamPath, 'memory/team/MEMORY.md')
  const memory = source('vendor/ds-bot/src/host/memory.js')
  assert.match(memory, /function memorySection\(bot, roomId\)/)
  assert.match(memory, /ownScope\(bot\.id\)/)
  assert.match(memory, /join\(root, 'bots', safeId\(scope\.botId\)\)/)
  assert.match(memory, /join\(root, 'team'\)/)
  assert.doesNotMatch(memory, /workLines/)
})

test('W3 adopt again keeps the same line id for the same session', () => {
  const state = team()
  ensureLegacy(state, { now: 1, createId: ids() })
  const saved = JSON.parse(JSON.stringify(state.workLines))
  const again = JSON.parse(JSON.stringify(state))
  assert.equal(ensureLegacy(again, { now: 9, createId: () => 'wl-fresh' }), false)
  assert.deepEqual(again.workLines, saved)
  const dm = Object.values(again.workLines).find(line => line.sessionId === 'dm')
  assert.equal(dm.id, Object.values(saved).find(line => line.sessionId === 'dm').id)
})

test('W4 an archived segment is part of the full thread and its note stays out of the index', () => {
  const state = team()
  const line = createLine(state, { id: 'wl-room', botId: 'chief', sessionId: 'ga', roomId: 'r1', now: 1, createId: ids() })
  const moved = followSegment(state, {
    fromSessionId: 'ga',
    toSessionId: 'ga-2',
    segment: { sessionId: 'ga', endedAt: 8, note: 'the whole handoff note' },
    now: 8,
  })
  assert.equal(moved.id, line.id)
  assert.equal(moved.sessionId, 'ga-2')
  assert.deepEqual(moved.segments, [{ sessionId: 'ga', endedAt: 8 }])
  assert.equal(JSON.stringify(state.workLines).includes('handoff'), false)
  const messages = getFullThread(state, line.id, {
    logs: {
      ga: [userEvent('archived question', 1), assistantEvent('archived answer', 2)],
      'ga-2': [assistantEvent('continued', 3)],
    },
  })
  assert.deepEqual(messages.map(message => message.text), ['archived question', 'archived answer', 'continued'])

  const legacy = createLine(state, { id: 'wl-dm', botId: 'chief', sessionId: 'dm', now: 1, createId: ids() })
  const earlier = getFullThread(state, legacy.id, {
    parts: [{ sessionId: 'dm-old' }, { sessionId: 'dm' }],
    logs: {
      'dm-old': [userEvent('from the archived part', 1)],
      dm: [assistantEvent('from the current part', 2)],
    },
  })
  assert.deepEqual(earlier.map(message => message.text), ['from the archived part', 'from the current part'])
})

test('W5 a room without work lines still delivers, then gains one line per session', () => {
  const state = team()
  delete state.workLines
  const room = state.rooms.r1
  assert.deepEqual(implicitLine(room, 'chief'), { botId: 'chief', sessionId: 'ga', lastRoomId: 'r1', implicit: true })
  assert.equal(lineForMember(state, room, 'chief').sessionId, 'ga')
  assert.equal(lineForMember(state, room, 'chief').implicit, true)
  ensureLegacy(state, { now: 1, createId: ids() })
  assert.equal(room.sessions.chief, 'ga')
  const lines = Object.values(state.workLines)
  assert.equal(lines.length, 2)
  assert.deepEqual(lines.map(line => line.sessionId).sort(), ['dm', 'ga'])
  const indexed = lineForMember(state, room, 'chief')
  assert.equal(indexed.sessionId, 'ga')
  assert.equal(indexed.implicit, undefined)
  assert.equal(indexed.id, lines.find(line => line.sessionId === 'ga').id)
  const groups = source('vendor/ds-bot/src/host/groups.js')
  const steer = source('vendor/ds-bot/src/host/group-steer.js')
  assert.match(groups, /room\.sessions/)
  assert.doesNotMatch(groups, /workLines/)
  assert.doesNotMatch(steer, /workLines/)
})

test('W6 one bot can be busy in a private chat and a group at the same time', () => {
  const state = team()
  ensureLegacy(state, { now: 1, createId: ids() })
  const live = new Map([['dm', { turn: 1 }], ['ga', { turn: 4 }]])
  const listed = listByBot(state, 'chief', id => live.get(id))
  assert.equal(listed.length, 2)
  assert.equal(listed.every(line => line.busy === true), true)
  assert.equal(JSON.stringify(state.workLines).includes('"busy"'), false)
})

test('W7 one turn end emits one completion and leaves the line open', () => {
  const state = team()
  ensureLegacy(state, { now: 1, createId: ids() })
  const line = Object.values(state.workLines).find(item => item.sessionId === 'dm')
  const events = []
  const { rt, emit } = turnsHost((input) => {
    const result = noteTurnEnd(state, input)
    if (result.event !== undefined) events.push(result.event)
    return result
  })
  emit('dm', { type: 'turn/start', data: { turn: 1 }, time: 1 })
  emit('dm', roomTurn('ex-1'))
  emit('dm', { type: 'turn/end', data: { reason: { kind: 'completed' } }, time: 2 })
  assert.equal(events.length, 1)
  assert.equal(events[0].workLineId, line.id)
  assert.equal(events[0].exchangeId, 'ex-1')
  assert.equal(events[0].completedAt, 2)
  assert.equal(line.closedAt, undefined)
  assert.equal(isBusy(line, id => rt.live.get(id)), false)
  emit('dm', { type: 'turn/start', data: { turn: 2 }, time: 3 })
  emit('dm', roomTurn('ex-1'))
  emit('dm', { type: 'turn/end', data: { reason: { kind: 'completed' } }, time: 4 })
  assert.equal(events.length, 1)
  assert.equal(line.closedAt, undefined)
})

test('W8 a resumed turn stays busy and does not complete again', () => {
  const state = team()
  ensureLegacy(state, { now: 1, createId: ids() })
  const line = Object.values(state.workLines).find(item => item.sessionId === 'ga')
  const events = []
  const { rt, emit } = turnsHost((input) => {
    const result = noteTurnEnd(state, input)
    if (result.event !== undefined) events.push(result.event)
    return result
  })
  emit('ga', { type: 'turn/start', data: { turn: 7 }, time: 1 })
  emit('ga', roomTurn('ex-resume'))
  emit('ga', { type: 'turn/end', data: { reason: { kind: 'interrupted' } }, time: 2 })
  emit('ga', { type: 'turn/start', data: { turn: 8 }, time: 3 })
  assert.equal(events.length, 0)
  assert.equal(isBusy(line, id => rt.live.get(id)), true)
  assert.equal(line.closedAt, undefined)
  emit('ga', { type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'disposed' } } }, time: 4 })
  assert.equal(events.length, 0)
  const pure = noteTurnEnd(state, { sessionId: 'ga', exchangeId: 'ex-resume', reason: { kind: 'completed' }, replay: true, now: 5 })
  assert.equal(pure.event, undefined)
  emit('ga', { type: 'turn/start', data: { turn: 9 }, time: 6 })
  assert.equal(isBusy(line, id => rt.live.get(id)), true)
})

test('work lines are wired beside the session index and do not import DSH', () => {
  const index = source('vendor/ds-bot/index.js')
  const store = source('vendor/ds-bot/src/host/store.js')
  const turns = source('vendor/ds-bot/src/host/turns.js')
  const parts = source('vendor/ds-bot/src/host/parts.js')
  const lines = source('vendor/ds-bot/src/host/work-lines.js')
  assert.match(index, /work-lines\.js/)
  assert.match(store, /ensureWorkLines/)
  assert.match(turns, /noteWorkTurnEnd\?\./)
  assert.match(parts, /followWorkLine\?\./)
  assert.match(lines, /groupOwners\.set/)
  assert.doesNotMatch(lines, /sessions\[botId\]\s*=/)
  assert.doesNotMatch(lines, /@deepseek-ai/)
})
