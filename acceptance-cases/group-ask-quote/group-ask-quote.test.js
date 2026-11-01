// G1–G9: a group ask logs the user sentence, and a quote names that sentence.
// No @deepseek-ai import.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { install as installTurns } from '../../vendor/ds-bot/src/host/turns.js'
import { install as installWorkLines } from '../../vendor/ds-bot/src/host/work-lines.js'
import { install as installRoute } from '../../vendor/ds-bot/src/host/route-inbound.js'
import { effectsOf, routeCard } from '../../vendor/ds-bot/src/host/route-inbound.js'
import { ensureLegacy, indexOnly } from '../../vendor/ds-bot/src/host/work-lines.js'
import {
  anchoredCompletions,
  lateCite,
  orderedCompletions,
  projectRelay,
  quoteSentence,
} from '../../vendor/ds-bot/src/shared/work-line-complete.js'

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const source = (path) => readFileSync(join(root, path), 'utf8')

const ESSAY = '@Chief 其他 bob-bot 完成作文后你来给作文打分'
const POEM = '秋天的诗写给远方'
const BEACH = '海边散步看夜色'
const ALICE_LINE = '评分归 Chief…'
const GREET = '你好！我是 bob-bot…'
const HOLD = '随便说说'
const OLD = '季度周报进度需要补充客户拜访'
const HISTORY = '只属于另一间房'

function userMessage(text) {
  return { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } }
}

async function flush() {
  for (let step = 0; step < 8; step += 1) {
    await new Promise(resolve => setImmediate(resolve))
  }
}

function essayHost() {
  const handlers = []
  const steered = []
  const delivered = []
  const rooms = {
    essay: {
      id: 'essay',
      name: 'Essay',
      admin: 'alice',
      members: ['alice', 'bob', 'chief'],
      sessions: { alice: 'sa', bob: 'sb', chief: 'sc1' },
      seq: 2,
      log: [
        { seq: 1, who: 'User', text: POEM },
        { seq: 2, who: 'User', text: BEACH },
      ],
    },
  }
  const bots = {
    alice: { id: 'alice', name: 'alice-bot' },
    bob: { id: 'bob', name: 'bob-bot' },
    chief: { id: 'chief', name: 'Chief' },
  }
  const sessions = new Set(['sa', 'sb', 'sc1', 'sc2', 'session-new'])
  const rt = {
    ctx: { on: (type, fn) => { if (type === 'session/event') handlers.push(fn) } },
    state: {
      questions: {},
      views: {},
      exchanges: [],
      exchangeTurns: {},
      workLines: {
        poem: {
          id: 'chief-poem',
          botId: 'chief',
          sessionId: 'sc1',
          lastRoomId: 'essay',
          quote: { roomId: 'essay', seq: 1 },
          label: '远方',
          updatedAt: 1,
          segments: [],
        },
        beach: {
          id: 'chief-beach',
          botId: 'chief',
          sessionId: 'sc2',
          lastRoomId: 'essay',
          quote: { roomId: 'essay', seq: 2 },
          label: '夜色',
          updatedAt: 2,
          segments: [],
        },
        alice: {
          id: 'alice-line',
          botId: 'alice',
          sessionId: 'sa',
          lastRoomId: 'essay',
          quote: { roomId: 'essay', seq: 1 },
          label: '爱丽丝',
          updatedAt: 3,
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
      ['sa', { botId: 'alice', roomId: 'essay' }],
      ['sb', { botId: 'bob', roomId: 'essay' }],
      ['sc1', { botId: 'chief', roomId: 'essay', workLineId: 'chief-poem' }],
      ['sc2', { botId: 'chief', roomId: 'essay', workLineId: 'chief-beach' }],
    ]),
    chatOwners: new Map(),
    pastOwners: new Map(),
    selfOf: (id) => (id === 'sa' ? 'alice' : id === 'sb' ? 'bob' : id === 'sc1' || id === 'sc2' ? 'chief' : undefined),
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
  const emit = (sessionId, event) => {
    for (const fn of handlers) fn({ id: sessionId }, event)
  }
  const busy = () => {
    emit('sa', { type: 'turn/start', data: { turn: 1 }, time: 1 })
    emit('sc1', { type: 'turn/start', data: { turn: 2 }, time: 1 })
    emit('sc2', { type: 'turn/start', data: { turn: 3 }, time: 1 })
  }
  return { rt, emit, steered, delivered, rooms, busy }
}

test('G1 @Chief asks with Chief lines and logs the user sentence', async () => {
  assert.equal(effectsOf({ action: 'ask' }).writeLog, false)
  assert.equal(effectsOf({ action: 'ask' }).copyTranscript, false)
  assert.equal(effectsOf({ action: 'continue' }).writeLog, false)
  assert.equal(effectsOf({ action: 'continue' }).copyTranscript, false)
  assert.equal(effectsOf({ action: 'steer' }).writeLog, false)
  assert.equal(effectsOf({ action: 'steer' }).copyTranscript, false)

  const host = essayHost()
  host.busy()
  host.emit('essay', userMessage(ESSAY))
  await flush()
  const pending = host.rt.state.pendingRoutes.essay
  assert.ok(pending)
  assert.equal(pending.timeoutSends, false)
  assert.equal(pending.botId, 'chief')
  assert.equal(pending.text, ESSAY)
  const card = routeCard(pending)
  assert.equal(card.kind, 'route')
  assert.equal(card.text, ESSAY)
  assert.equal(card.timeoutSends, false)
  assert.deepEqual(card.choices.map(choice => choice.id).sort(), ['chief-beach', 'chief-poem'])
  assert.equal(card.choices.every(choice => choice.botId === 'chief'), true)
  assert.equal(card.choices.some(choice => choice.id === 'alice-line'), false)
  assert.equal(host.delivered.length, 0)
  assert.equal(host.steered.length, 0)
  const added = host.rooms.essay.log.slice(2)
  assert.equal(added.length, 1)
  assert.equal(added[0].who, 'User')
  assert.equal(added[0].kind, undefined)
  assert.equal(added[0].text, ESSAY)
})

test('G2 a sentence that is not a choice stays on the card and is logged once', async () => {
  const host = essayHost()
  host.busy()
  host.emit('essay', userMessage(ESSAY))
  await flush()
  const pending = host.rt.state.pendingRoutes.essay
  host.emit('essay', userMessage(HOLD))
  await flush()
  assert.equal(host.rt.state.pendingRoutes.essay, pending)
  assert.equal(pending.text, ESSAY)
  assert.deepEqual(pending.texts, [ESSAY, HOLD])
  assert.equal(host.rooms.essay.log.filter(entry => entry.text === HOLD).length, 1)
  assert.equal(host.delivered.length, 0)
  assert.equal(host.steered.length, 0)
  host.emit('essay', userMessage('chief-beach'))
  await flush()
  assert.equal(host.rt.state.pendingRoutes.essay, undefined)
  assert.deepEqual(host.steered.map(item => item.message.text), [ESSAY, HOLD])
  assert.equal(host.steered.every(item => item.member.sessionId === 'sc2'), true)
  assert.equal(host.delivered.length, 0)
  assert.equal(host.rooms.essay.log.filter(entry => entry.text === HOLD).length, 1)
  assert.equal(host.rooms.essay.log.some(entry => entry.text === 'chief-beach'), false)
})

test('G3 a choice id clears the saved card before steer and is not logged', async () => {
  const host = essayHost()
  const saved = []
  host.rt.save = async () => { saved.push(JSON.parse(JSON.stringify(host.rt.state.pendingRoutes))) }
  const steer = host.rt.acceptRoomSteer
  host.rt.acceptRoomSteer = async (...args) => {
    host.rt.state.pendingRoutes = JSON.parse(JSON.stringify(saved.at(-1) ?? {}))
    return steer(...args)
  }
  host.busy()
  host.emit('essay', userMessage(ESSAY))
  await flush()
  assert.ok(saved.at(-1)?.essay)
  host.emit('essay', userMessage('chief-beach'))
  await flush()
  assert.equal(saved.at(-1)?.essay, undefined)
  assert.equal(host.rt.state.pendingRoutes.essay, undefined)
  assert.equal(host.steered.length, 1)
  assert.equal(host.steered[0].message.text, ESSAY)
  assert.equal(host.delivered.length, 0)
  assert.equal(host.rooms.essay.log.filter(entry => entry.who === 'User' && entry.text === ESSAY).length, 1)
  assert.equal(host.rooms.essay.log.some(entry => entry.text === 'chief-beach'), false)
})

test('G4 create quotes the new user row and a bot seq is not a sentence', async () => {
  const host = essayHost()
  const room = host.rooms.essay
  room.log = [{ seq: 5, who: 'alice-bot', botId: 'alice', text: ALICE_LINE }]
  room.seq = 5
  await host.rt.applyRouteDecision(room, { action: 'create', botId: 'chief', text: '请写一首新诗' }, {})
  const created = Object.values(host.rt.state.workLines).find(line => line.sessionId === 'session-new')
  assert.ok(created)
  assert.equal(indexOnly(created), true)
  assert.deepEqual(created.quote, { roomId: 'essay', seq: 6 })
  assert.equal(room.log.at(-1).who, 'User')
  assert.equal(room.log.at(-1).text, '请写一首新诗')
  assert.equal(room.log.filter(entry => entry.text === ALICE_LINE).length, 1)

  const state = {
    bots: { chief: { id: 'chief', name: 'Chief', sessionId: 'dm' } },
    rooms: {
      r: {
        id: 'r',
        seq: 5,
        sessions: { chief: 'sc' },
        log: [{ seq: 5, who: 'alice-bot', botId: 'alice', text: ALICE_LINE }],
      },
    },
    workLines: {},
    workLineCompleted: {},
  }
  let nextId = 0
  const createId = () => `wl-${nextId++}`
  ensureLegacy(state, { now: 1, createId })
  const stamped = Object.values(state.workLines).find(line => line.sessionId === 'sc')
  assert.equal(stamped.quote, undefined)
  state.workLines.bad = {
    id: 'bad',
    botId: 'chief',
    sessionId: 'other',
    lastRoomId: 'r',
    quote: { roomId: 'r', seq: 5 },
    updatedAt: 1,
    segments: [],
  }
  assert.equal(ensureLegacy(state, { now: 2, createId: () => 'wl-nope' }), true)
  assert.equal(state.workLines.bad.quote, undefined)
  state.rooms.r.log.push({ seq: 6, who: 'User', text: '用户原句' })
  state.workLines.good = {
    id: 'good',
    botId: 'bob',
    sessionId: 'sbx',
    lastRoomId: 'r',
    quote: { roomId: 'r', seq: 6 },
    updatedAt: 1,
    segments: [],
  }
  const kept = JSON.parse(JSON.stringify(state.workLines.good))
  assert.equal(ensureLegacy(state, { now: 3, createId: () => 'wl-nope-2' }), false)
  assert.deepEqual(state.workLines.good, kept)
})

test('G5 continue repairs a bot quote once and leaves a later sentence in place', async () => {
  const host = essayHost()
  const room = host.rooms.essay
  room.log = [
    { seq: 4, who: 'User', text: '更早的一句' },
    { seq: 5, who: 'alice-bot', botId: 'alice', text: ALICE_LINE },
  ]
  room.seq = 5
  const line = host.rt.state.workLines.poem
  line.quote = { roomId: 'essay', seq: 5 }
  await host.rt.applyRouteDecision(room, {
    action: 'continue',
    botId: 'chief',
    sessionId: 'sc1',
    workLineId: 'chief-poem',
    text: '第一句用户',
    crossRoom: false,
  }, {})
  assert.equal(room.log.filter(entry => entry.who === 'User' && entry.text === '第一句用户').length, 1)
  const moved = room.log.at(-1).seq
  assert.equal(line.quote.roomId, 'essay')
  assert.equal(line.quote.seq, moved)
  assert.notEqual(line.quote.seq, 5)
  assert.equal(host.delivered.at(-1)?.text, '第一句用户')
  assert.equal(host.delivered.at(-1)?.quoteText, '第一句用户')
  await host.rt.applyRouteDecision(room, {
    action: 'continue',
    botId: 'chief',
    sessionId: 'sc1',
    workLineId: 'chief-poem',
    text: '第二句用户',
    crossRoom: false,
  }, {})
  assert.equal(line.quote.seq, moved)
  assert.equal(room.log.at(-1).who, 'User')
  assert.equal(room.log.at(-1).text, '第二句用户')
})

test('G6 a bot seq is not the quote row and the user sentence wins', () => {
  const logs = {
    essay: [
      { seq: 4, who: 'User', text: ESSAY },
      { seq: 5, who: 'alice-bot', botId: 'alice', text: ALICE_LINE },
    ],
  }
  assert.equal(quoteSentence({ roomId: 'essay', seq: 5 }, logs), '')
  assert.equal(quoteSentence({ roomId: 'essay', seq: 0 }, logs), '')
  assert.equal(quoteSentence({ roomId: 'essay', seq: 4 }, logs), ESSAY)
  const projected = projectRelay({
    replies: [{ kind: 'working', botId: 'bob', workLineId: 'bob-line' }],
    completions: [{
      exchangeId: 'ex-bob',
      workLineId: 'bob-line',
      botId: 'bob',
      roomId: 'essay',
      completedAt: 9,
      quote: { roomId: 'essay', seq: 5 },
      quoteText: ESSAY,
      reply: GREET,
    }],
    roomId: 'essay',
    logs,
  })
  const quote = projected.replies.find(row => row.kind === 'completion-quote')
  assert.equal(quote.text, ESSAY)
  assert.equal(quote.who, 'User')
  assert.equal(projected.replies.some(row => row.kind === 'completion-quote' && row.text === ALICE_LINE), false)
  assert.equal(projected.replies.find(row => row.kind === 'completion-reply').text, GREET)
  const bare = projectRelay({
    replies: [{ kind: 'working', workLineId: 'bob-line' }],
    completions: [{
      exchangeId: 'ex-bare',
      workLineId: 'bob-line',
      roomId: 'essay',
      completedAt: 9,
      quote: { roomId: 'essay', seq: 5 },
      reply: GREET,
    }],
    roomId: 'essay',
    logs,
  })
  assert.equal(bare.replies.some(row => row.kind === 'completion-quote'), false)
  const full = '请把这首写完'
  const preferred = orderedCompletions([{
    exchangeId: 'ex-q',
    workLineId: 'q',
    roomId: 'r1',
    completedAt: 5,
    quote: { roomId: 'r1', seq: 4 },
    quoteText: '请把',
    reply: '好',
  }], { roomId: 'r1', logs: { r1: [{ seq: 4, who: 'User', text: full }] } })
  assert.equal(preferred[0].quoteText, full)
})

test('G7 a completion stays on the cell that anchors its work line', () => {
  const bob = {
    exchangeId: 'ex-bob',
    workLineId: 'bob-line',
    botId: 'bob',
    roomId: 'essay',
    completedAt: 3,
    quoteText: ESSAY,
    reply: GREET,
  }
  const alice = {
    exchangeId: 'ex-alice',
    workLineId: 'alice-line',
    botId: 'alice',
    roomId: 'essay',
    completedAt: 1,
    quoteText: ESSAY,
    reply: ALICE_LINE,
  }
  assert.deepEqual(anchoredCompletions([{ text: ALICE_LINE, botId: 'alice' }], [bob]), [])
  assert.deepEqual(anchoredCompletions([{ text: GREET, botId: 'bob' }], [bob]), [])
  const kept = anchoredCompletions([{ kind: 'working', workLineId: 'bob-line', botId: 'bob' }], [bob])
  assert.equal(kept.length, 1)
  assert.equal(kept[0].exchangeId, 'ex-bob')
  const replies = [
    { kind: 'working', workLineId: 'alice-line', botId: 'alice' },
    { kind: 'working', workLineId: 'bob-line', botId: 'bob' },
  ]
  const projected = projectRelay({
    replies,
    completions: anchoredCompletions(replies, [bob, alice]),
    roomId: 'essay',
  })
  assert.deepEqual(projected.replies.filter(row => row.kind === 'completion-reply').map(row => row.text), [ALICE_LINE, GREET])
  assert.deepEqual(projected.replies.filter(row => row.kind === 'completion-quote').map(row => row.who), ['User', 'User'])
})

test('G8 a late cite is the user sentence and a bot seq is empty', () => {
  const logs = {
    essay: [
      { seq: 5, who: 'alice-bot', botId: 'alice', text: ALICE_LINE },
      { seq: 4, who: 'User', text: ESSAY },
      { seq: 7, who: 'bob-bot', botId: 'bob', text: GREET, quoteText: ESSAY },
    ],
  }
  assert.equal(quoteSentence({ roomId: 'essay', seq: 4 }, logs), ESSAY)
  assert.equal(quoteSentence({ roomId: 'essay', seq: 5 }, logs), '')
  assert.deepEqual(lateCite({}), {})
  assert.deepEqual(lateCite({ quoteText: ESSAY, quoteSeq: 4, quoteRoomId: 'essay' }), {
    quoteText: ESSAY,
    quoteSeq: 4,
    quoteRoomId: 'essay',
  })
  assert.equal(logs.essay[0].text, ALICE_LINE)
  assert.equal(logs.essay[2].quoteText, ESSAY)
  assert.equal(logs.essay.map(entry => entry.seq).join(','), '5,4,7')

  const groups = source('vendor/ds-bot/src/host/groups.js')
  const delivery = source('vendor/ds-bot/src/host/delivery.js')
  const router = source('vendor/ds-bot/src/host/route-inbound.js')
  assert.match(groups, /lateCite/)
  const steerAt = groups.indexOf('async function acceptRoomSteer')
  const lineAt = groups.indexOf('rt.appendRoomLine')
  assert.ok(steerAt >= 0 && lineAt > steerAt)
  assert.match(groups.slice(steerAt, lineAt), /quoteText/)
  assert.match(delivery, /quoteText/)
  assert.doesNotMatch(router, /ask_user/)
  assert.doesNotMatch(router, /setTimeout|setInterval/)
  assert.doesNotMatch(router, /work-line-complete/)
  assert.doesNotMatch(groups, /workLines/)
})

test('G9 cross-room continue logs one sentence and leaves the other room', async () => {
  const host = essayHost()
  host.rooms.r2 = {
    id: 'r2',
    name: 'Origin',
    admin: 'chief',
    members: ['chief'],
    sessions: { chief: 'remote' },
    seq: 2,
    log: [
      { seq: 1, who: 'User', text: OLD },
      { seq: 2, who: 'Chief', botId: 'chief', text: HISTORY },
    ],
  }
  host.rt.state.workLines.far = {
    id: 'far',
    botId: 'chief',
    sessionId: 'remote',
    lastRoomId: 'r2',
    quote: { roomId: 'r2', seq: 1 },
    label: '周报',
    updatedAt: 1,
    segments: [],
  }
  const origin = JSON.stringify(host.rooms.r2.log)
  const before = host.rooms.essay.log.map(entry => entry.text)
  await host.rt.applyRouteDecision(host.rooms.essay, {
    action: 'continue',
    crossRoom: true,
    botId: 'chief',
    sessionId: 'remote',
    workLineId: 'far',
    text: '周报进度',
  }, {})
  assert.equal(effectsOf({ action: 'continue' }).writeLog, false)
  assert.equal(effectsOf({ action: 'continue' }).copyTranscript, false)
  assert.equal(JSON.stringify(host.rooms.r2.log), origin)
  assert.deepEqual(host.rooms.essay.log.map(entry => entry.text), [...before, '周报进度'])
  assert.equal(host.rooms.essay.log.at(-1).who, 'User')
  assert.equal(host.rooms.essay.log.some(entry => entry.text === OLD), false)
  assert.equal(host.rooms.essay.log.some(entry => entry.text === HISTORY), false)
  assert.deepEqual(host.rt.state.workLines.far.quote, { roomId: 'r2', seq: 1 })
  assert.equal(host.delivered.length, 1)
  assert.equal(host.delivered[0].text, '周报进度')
  assert.equal(host.delivered[0].quoteText, '周报进度')
  assert.equal(host.delivered[0].sessionId, 'remote')
})

test('G10 the Web client shows the route card and does not paint a bot row as the user', () => {
  const channel = source('vendor/ds-bot/src/host/channel.js')
  const index = source('vendor/ds-bot/src/client/index.js')
  const dock = source('vendor/ds-bot/src/client/route-dock.js')
  const cells = source('vendor/ds-bot/src/client/cells.js')
  const client = source('vendor/ds-bot/client.js')
  const router = source('vendor/ds-bot/src/host/route-inbound.js')
  const actions = source('vendor/ds-bot/src/client/team-actions.js')
  assert.match(channel, /pendingRoutes: state\.pendingRoutes/)
  assert.match(index, /id: 'bot-route'/)
  assert.match(index, /RouteDock/)
  assert.match(dock, /pendingRoutes/)
  assert.match(dock, /actions\.send/)
  assert.doesNotMatch(dock, /ask_user|answerQuestion/)
  assert.match(actions, /noteRouteComposerSend/)
  const quoteAt = cells.indexOf("reply.kind === 'completion-quote'")
  const quoteEnd = cells.indexOf("reply.kind === 'completion-reply'", quoteAt)
  assert.ok(quoteAt >= 0 && quoteEnd > quoteAt)
  const quoteBlock = cells.slice(quoteAt, quoteEnd)
  assert.match(quoteBlock, /reply\.who === 'User' \? 'bt-urow'/)
  assert.match(cells, /anchoredCompletions/)
  assert.match(cells, /data-late-cite/)
  assert.match(cells, /Replying to what you wrote earlier/)
  assert.match(client, /bot-route/)
  assert.match(client, /pendingRoutes/)
  assert.match(client, /data-late-cite/)
  assert.doesNotMatch(router, /ask_user/)
  assert.doesNotMatch(router, /setTimeout|setInterval/)
  assert.equal(effectsOf({ action: 'ask' }).writeLog, false)
  assert.equal(effectsOf({ action: 'ask' }).copyTranscript, false)
  assert.equal(effectsOf({ action: 'continue' }).writeLog, false)
  assert.equal(effectsOf({ action: 'continue' }).copyTranscript, false)
  assert.equal(effectsOf({ action: 'steer' }).writeLog, false)
  assert.equal(effectsOf({ action: 'steer' }).copyTranscript, false)
})
