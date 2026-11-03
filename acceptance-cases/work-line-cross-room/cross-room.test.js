// C1–C5: continuing a work line from another room.
// The model turn stays on that line's session. The arrival room records only this exchange.
// No @deepseek-ai import.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SOURCE_KIND } from '../../vendor/ds-bot/src/host/constants.js'
import { install as installTurns } from '../../vendor/ds-bot/src/host/turns.js'
import { install as installWorkLines } from '../../vendor/ds-bot/src/host/work-lines.js'
import { install as installRoute } from '../../vendor/ds-bot/src/host/route-inbound.js'
import { effectsOf, routeInbound } from '../../vendor/ds-bot/src/host/route-inbound.js'
import { getFullThread, indexOnly, listByBot, projectExchange } from '../../vendor/ds-bot/src/host/work-lines.js'

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const source = (path) => readFileSync(join(root, path), 'utf8')

const ASK = '周报进度'
const REPLY = '这是回复'
const STEP = '先说一句'
const OLD = '季度周报进度需要补充客户拜访'
const HISTORY = '只属于房间A的旧句子'
const LOCAL = '本地问候'
const BEACH = '海边散步看夜色'
const PROBE = 'DEMO_STEER_OK'
const OWN_MEMORY = 'chief remembers the client name'
const TEAM_MEMORY = 'team remembers the launch date'

function userMessage(text) {
  return { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } }
}

function userEvent(text, seq) {
  return { type: 'user/message', seq, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } }
}

function assistantEvent(text, seq) {
  return { type: 'assistant/message', seq, data: { message: { content: [{ type: 'text', text }] } } }
}

async function flush() {
  for (let step = 0; step < 8; step += 1) {
    await new Promise(resolve => setImmediate(resolve))
  }
}

function sliceFn(text, startMark, endMark) {
  const start = text.indexOf(startMark)
  const end = text.indexOf(endMark, start + startMark.length)
  assert.ok(start >= 0 && end > start, startMark)
  return text.slice(start, end)
}

function wireHost() {
  const handlers = []
  const steered = []
  const delivered = []
  const rooms = {
    r1: {
      id: 'r1',
      name: 'Arrival',
      admin: 'chief',
      members: ['chief', 'writer'],
      sessions: { chief: 'ga', writer: 'gb' },
      seq: 1,
      log: [{ seq: 1, who: 'User', text: LOCAL }],
    },
    r2: {
      id: 'r2',
      name: 'Origin',
      admin: 'chief',
      members: ['chief'],
      sessions: { chief: 'home-a' },
      seq: 2,
      log: [
        { seq: 1, who: 'User', text: OLD },
        { seq: 2, who: 'Chief', text: HISTORY, botId: 'chief' },
      ],
    },
  }
  const bots = {
    chief: { id: 'chief', name: 'Chief' },
    writer: { id: 'writer', name: 'Writer' },
  }
  const sessions = new Set(['ga', 'gb', 'home-a', 'remote', 'session-new'])
  const rt = {
    ctx: { on: (type, fn) => { if (type === 'session/event') handlers.push(fn) } },
    state: {
      questions: {},
      views: {},
      exchanges: [],
      exchangeTurns: {},
      workLines: {
        s1: {
          id: 's1',
          botId: 'chief',
          sessionId: 'remote',
          lastRoomId: 'r2',
          quote: { roomId: 'r2', seq: 1 },
          label: '周报',
          updatedAt: 1,
          segments: [],
        },
        w1: {
          id: 'w1',
          botId: 'writer',
          sessionId: 'gb',
          lastRoomId: 'r1',
          quote: { roomId: 'r1', seq: 1 },
          updatedAt: 1,
          segments: [],
        },
      },
      workLineCompleted: {},
      pendingRoutes: {},
    },
    warn() {},
    save: async () => {},
    dropKickoff() {},
    roomOf: (id) => rooms[id],
    botOf: (id) => bots[id],
    isBotSession: (id) => sessions.has(id),
    groupOwners: new Map([
      ['ga', { botId: 'chief', roomId: 'r1' }],
      ['gb', { botId: 'writer', roomId: 'r1' }],
      ['remote', { botId: 'chief', roomId: 'r2', workLineId: 's1' }],
    ]),
    chatOwners: new Map(),
    pastOwners: new Map(),
    selfOf: (id) => (id === 'remote' || id === 'ga' || id === 'home-a' ? 'chief' : id === 'gb' ? 'writer' : undefined),
    switchJobs: () => [],
    roomWaiters: new Map(),
    lateRoomReply() {},
    takeRoomSteps: () => '',
    withRoomSteps: (_held, reply) => reply,
    noteFailure() {},
    deliver: async (payload) => { delivered.push(payload) },
    acceptRoomSteer: async (target, member, message) => { steered.push({ target, member, message }) },
    noteSteeredRoomLine() {},
    takeRelayIntent: () => false,
    allowRelayText() {},
    createSession: async () => 'session-new',
    isAdminOf: (room, botId) => room?.admin === botId,
    roomProgress: new Map(),
  }
  installTurns(rt)
  installWorkLines(rt)
  installRoute(rt)
  // Production posts a step through the waiter. The last sentence waits for turn/end.
  rt.roomStepText = (_sessionId, info, text) => {
    rt.roomWaiters.get(info?.exchangeId)?.say(text)
  }
  const emit = (sessionId, event) => {
    for (const fn of handlers) fn({ id: sessionId }, event)
  }
  return { rt, emit, steered, delivered, rooms }
}

function trigger(exchangeId) {
  return {
    type: 'user/message',
    data: {
      source: { kind: SOURCE_KIND, role: 'room', exchangeId, roomId: 'r1' },
      content: [{ type: 'text', text: `[Group chat]\n${ASK}` }],
    },
  }
}

function finishTurn(host, exchangeId, reply, { busy = false } = {}) {
  if (!busy) host.emit('remote', trigger(exchangeId))
  host.emit('remote', { type: 'turn/start', data: { turn: busy ? 2 : 1 }, time: 2 })
  if (busy) host.emit('remote', trigger(exchangeId))
  host.emit('remote', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: STEP }] } } })
  host.emit('remote', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: reply }] } } })
  host.emit('remote', { type: 'turn/end', data: { turn: busy ? 2 : 1, reason: { kind: 'completed' } }, time: 3 })
}

function texts(room) {
  return room.log.map(line => line.text)
}

test('C1 continue S1 from room B on its session and show only this exchange', () => {
  const decision = routeInbound({
    text: ASK,
    roomId: 'r1',
    botId: 'chief',
    lines: [{ id: 's1', botId: 'chief', sessionId: 'remote', lastRoomId: 'r2', doc: OLD, label: '周报', busy: false, updatedAt: 1 }],
  })
  assert.equal(decision.action, 'continue')
  assert.equal(decision.sessionId, 'remote')
  assert.equal(decision.crossRoom, true)
  assert.equal(effectsOf(decision).copyTranscript, false)
  assert.equal(effectsOf(decision).writeLog, false)
  assert.deepEqual(projectExchange({ userText: ASK, replyText: REPLY, replyWho: 'Chief', replyBotId: 'chief' }).map(line => line.text), [ASK, REPLY])

  const host = wireHost()
  const origin = JSON.stringify(host.rooms.r2.log)
  const memoryPath = `memory/bots/${host.rt.state.workLines.s1.botId}/MEMORY.md`
  host.emit('r1', userMessage(ASK))
  assert.equal(host.steered.length, 0)
  assert.equal(host.delivered.length, 1)
  assert.equal(host.delivered[0].sessionId, 'remote')
  assert.equal(host.delivered[0].roomId, 'r1')
  assert.equal(host.delivered[0].steer, false)
  assert.equal(host.delivered[0].text, ASK)
  const exchangeId = host.delivered[0].exchangeId
  assert.equal(typeof exchangeId, 'string')
  finishTurn(host, exchangeId, REPLY)

  const line = host.rt.state.workLines.s1
  assert.equal(line.sessionId, 'remote')
  assert.equal(line.lastRoomId, 'r1')
  assert.deepEqual(line.quote, { roomId: 'r2', seq: 1 })
  assert.equal(line.messages, undefined)
  assert.equal(indexOnly(line), true)
  assert.equal(JSON.stringify(host.rooms.r2.log), origin)
  assert.equal(texts(host.rooms.r1).includes(OLD), false)
  assert.equal(texts(host.rooms.r1).includes(HISTORY), false)
  assert.deepEqual(texts(host.rooms.r1), [LOCAL, ASK, STEP, REPLY])
  assert.equal(host.rt.groupOwners.get('remote').roomId, 'r1')
  assert.equal(memoryPath, 'memory/bots/chief/MEMORY.md')
  assert.equal(`memory/bots/${listByBot(host.rt.state, 'chief')[0].botId}/MEMORY.md`, memoryPath)
  assert.equal(line.closedAt, undefined)

  const busy = wireHost()
  busy.emit('remote', { type: 'turn/start', data: { turn: 1 }, time: 1 })
  busy.emit('r1', userMessage(ASK))
  assert.equal(busy.steered.length, 0)
  assert.equal(busy.delivered.length, 1)
  assert.equal(busy.delivered[0].sessionId, 'remote')
  assert.equal(busy.delivered[0].roomId, 'r1')
  assert.equal(busy.delivered[0].steer, true)
  assert.equal(busy.delivered[0].userSteer, true)
  assert.equal(busy.delivered[0].text, ASK)
  finishTurn(busy, busy.delivered[0].exchangeId, REPLY, { busy: true })
  assert.equal(busy.rt.state.workLines.s1.sessionId, 'remote')
  assert.equal(busy.rt.state.workLines.s1.lastRoomId, 'r1')
  assert.equal(texts(busy.rooms.r1).includes(OLD), false)
  assert.equal(texts(busy.rooms.r1).includes(HISTORY), false)
  assert.equal(texts(busy.rooms.r1).filter(text => text === ASK).length, 1)
  assert.equal(texts(busy.rooms.r1).includes(STEP), true)
  assert.equal(texts(busy.rooms.r1).includes(REPLY), true)
})

test('C2 a new topic in room B does not append or steer into S1', async () => {
  const router = source('vendor/ds-bot/src/host/route-inbound.js')
  const auto = sliceFn(router, 'function autoRoute', 'export function routeInbound')
  const local = auto.indexOf('busy.length === 1 && local.length === 1')
  const remote = auto.indexOf('busy.length >= 2 || (busy.length === 1 && local.length === 0)')
  assert.ok(local >= 0 && remote > local)

  const missed = routeInbound({
    text: BEACH,
    roomId: 'r1',
    botId: 'chief',
    lines: [{ id: 's1', botId: 'chief', sessionId: 'remote', lastRoomId: 'r2', doc: `${OLD}\n${HISTORY}`, busy: false, updatedAt: 1 }],
  })
  assert.equal(missed.action, 'create')
  assert.equal(missed.steer, false)
  assert.equal(missed.sessionId, undefined)
  const stillSteers = routeInbound({
    text: PROBE,
    roomId: 'r1',
    botId: 'chief',
    lines: [{ id: 'local', botId: 'chief', sessionId: 'ga', lastRoomId: 'r1', doc: '秋天的诗', busy: true, updatedAt: 2 }],
  })
  assert.equal(stillSteers.action, 'steer')
  assert.equal(stillSteers.workLineId, 'local')

  const host = wireHost()
  host.emit('r1', userMessage(BEACH))
  await flush()
  assert.equal(host.steered.length, 0)
  assert.equal(host.delivered.some(item => item.sessionId === 'remote'), false)
  assert.equal(host.delivered.at(-1)?.sessionId, 'session-new')
  assert.equal(host.delivered.at(-1)?.steer, false)
  assert.equal(host.delivered.at(-1)?.text, BEACH)
  assert.equal(host.rt.state.workLines.s1.sessionId, 'remote')
  assert.equal(host.rt.state.workLines.s1.lastRoomId, 'r2')
  assert.deepEqual(texts(host.rooms.r1), [LOCAL, BEACH])
  assert.equal(host.rooms.r1.log.at(-1).who, 'User')
  assert.equal(texts(host.rooms.r1).includes(OLD), false)
  assert.equal(texts(host.rooms.r1).includes(HISTORY), false)
})

test('C3 another bot cannot see S1 through listByBot or getFullThread', () => {
  const host = wireHost()
  host.emit('r1', userMessage(ASK))
  finishTurn(host, host.delivered[0].exchangeId, REPLY)
  const writerLines = listByBot(host.rt.state, 'writer')
  assert.equal(writerLines.some(line => line.id === 's1' || line.sessionId === 'remote'), false)
  assert.equal(JSON.stringify(writerLines).includes(ASK), false)
  assert.equal(JSON.stringify(writerLines).includes(OLD), false)
  assert.equal(JSON.stringify(writerLines).includes(REPLY), false)
  const writerThread = getFullThread(host.rt.state, 'w1', {
    logs: {
      remote: [userEvent(OLD, 1), assistantEvent(HISTORY, 2), userEvent(ASK, 3), assistantEvent(REPLY, 4)],
      gb: [userEvent('writer only', 1)],
      r1: [userEvent(ASK, 9)],
    },
  })
  assert.deepEqual(writerThread.map(message => message.text), ['writer only'])
  const chiefThread = getFullThread(host.rt.state, 's1', {
    logs: {
      remote: [userEvent(OLD, 1), assistantEvent(HISTORY, 2)],
    },
  })
  assert.deepEqual(chiefThread.map(message => message.text), [OLD, HISTORY])
  assert.equal(chiefThread.some(message => message.text === ASK || message.text === REPLY), false)
  assert.equal(JSON.stringify(host.rt.state.workLines).includes(REPLY), false)
})

test('C4 other members of room B see this exchange and not S1 history', () => {
  const host = wireHost()
  host.emit('r1', userMessage(ASK))
  finishTurn(host, host.delivered[0].exchangeId, REPLY)
  const room = host.rooms.r1
  const since = room.seen?.writer
  const visible = (since === undefined ? room.log.slice(-12) : room.log.filter(line => line.seq > since && line.botId !== 'writer').slice(-24))
  const prompt = visible.map(line => line.text).join('\n')
  assert.equal(prompt.includes(OLD), false)
  assert.equal(prompt.includes(HISTORY), false)
  assert.equal(prompt.includes(ASK), true)
  assert.equal(prompt.includes(STEP), true)
  assert.equal(prompt.includes(REPLY), true)
  assert.equal(JSON.stringify(room.log).includes(OLD), false)
  assert.equal(JSON.stringify(room.log).includes(HISTORY), false)
  assert.equal(JSON.stringify(host.rooms.r2.log).includes(OLD), true)
  assert.equal(JSON.stringify(host.rooms.r2.log).includes(HISTORY), true)

  const groups = source('vendor/ds-bot/src/host/groups.js')
  const promptFn = sliceFn(groups, 'function roomPrompt(', 'const workingIn')
  assert.match(promptFn, /unseenLines\(room, member\.id\)/)
  assert.doesNotMatch(promptFn, /getFullThread|workLines|lastRoomId/)
  const unseen = sliceFn(groups, 'const unseenLines', 'const noticeText')
  assert.match(unseen, /room\.log/)
  assert.doesNotMatch(unseen, /getFullThread|workLines/)
})

test('C5 team MEMORY.md stays in place and is not rewritten', () => {
  const home = mkdtempSync(join(tmpdir(), 'odm-c5-'))
  const teamFile = join(home, 'memory', 'team', 'MEMORY.md')
  const ownFile = join(home, 'memory', 'bots', 'chief', 'MEMORY.md')
  mkdirSync(dirname(teamFile), { recursive: true })
  mkdirSync(dirname(ownFile), { recursive: true })
  writeFileSync(teamFile, TEAM_MEMORY)
  writeFileSync(ownFile, OWN_MEMORY)
  const teamBefore = readFileSync(teamFile)
  const ownBefore = readFileSync(ownFile)

  const host = wireHost()
  host.emit('r1', userMessage(ASK))
  finishTurn(host, host.delivered[0].exchangeId, REPLY)

  assert.equal(readFileSync(teamFile).equals(teamBefore), true)
  assert.equal(readFileSync(ownFile).equals(ownBefore), true)
  assert.equal(readFileSync(teamFile, 'utf8'), TEAM_MEMORY)
  assert.equal(readFileSync(ownFile, 'utf8'), OWN_MEMORY)

  const router = source('vendor/ds-bot/src/host/route-inbound.js')
  const lines = source('vendor/ds-bot/src/host/work-lines.js')
  const delivery = [
    sliceFn(router, 'async function deliverAcrossRooms', 'export async function applyRouteDecision'),
    sliceFn(lines, 'export function noteLineRoom', 'export function listByBot'),
  ].join('\n')
  assert.doesNotMatch(delivery, /MEMORY\.md|memory\/team|writeFile|appendFile/)
  assert.doesNotMatch(router, /from '\.\/memory\.js'/)
  assert.doesNotMatch(lines, /from '\.\/memory\.js'/)
  const memory = source('vendor/ds-bot/src/host/memory.js')
  assert.match(memory, /join\(root, 'team'\)/)
  assert.match(memory, /join\(root, 'bots', safeId\(scope\.botId\)\)/)
  assert.doesNotMatch(memory, /workLines/)
})
