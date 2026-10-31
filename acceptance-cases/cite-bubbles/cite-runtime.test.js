// Drives the group host the desktop runs: confirm a busy essay, post the reply
// after the round has returned, and check the session a reload would paint.
// No @deepseek-ai package: those two modules are stubbed before the host loads.
import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { install as installTurns } from '../../vendor/ds-bot/src/host/turns.js'
import { install as installRoute } from '../../vendor/ds-bot/src/host/route-inbound.js'
import {
  citeTexts,
  citedFromLog,
  hideCitedHistory,
  lateCiteHtml,
} from '../../vendor/ds-bot/src/shared/cite.js'

const stubs = {
  '@deepseek-ai/dsh-llm': new URL('./sdk-stub/dsh-llm.js', import.meta.url),
  '@deepseek-ai/dsh-tools': new URL('./sdk-stub/dsh-tools.js', import.meta.url),
}
registerHooks({
  resolve(specifier, context, nextResolve) {
    const stub = stubs[specifier]
    if (stub !== undefined) return { url: stub.href, shortCircuit: true }
    return nextResolve(specifier, context)
  },
})

const { install: installGroups } = await import('../../vendor/ds-bot/src/host/groups.js')

const FIRST = '你们是谁'
const FOLLOW = '在干嘛'
const IDIOM = '秋高气爽'
const PROMPT = '新开 请写一篇约900字散文《秋水》'
const ESSAY = '秋水正文'
const ROOM = 'r1'

function desk() {
  const handlers = []
  const followups = []
  const delivered = []
  const tools = new Map()
  const room = {
    id: ROOM,
    name: 'F2A',
    mode: 'admin',
    admin: 'chief',
    members: ['chief'],
    sessions: { chief: 'ga' },
    seq: 5,
    seen: {},
    log: [
      { seq: 1, who: 'User', text: '新开 帮我列3个秋天的成语', messageId: 'm-old' },
      { seq: 2, who: 'Chief', botId: 'chief', text: IDIOM },
      { seq: 3, who: 'User', text: PROMPT, messageId: 'm-essay' },
      { seq: 4, who: 'User', text: FIRST, messageId: 'm-who' },
      { seq: 5, who: 'User', text: FOLLOW, messageId: 'm-do' },
    ],
  }
  const rt = {
    ctx: {
      on(type, fn) { handlers.push({ type, fn }) },
      effect() {},
      tools: { register(tool) { tools.set(tool.name, tool) } },
      sessions: { flush: async () => {} },
    },
    state: { questions: {}, views: {}, exchanges: [], pendingRoutes: {}, workLines: {} },
    home: '/tmp/ds-bot-cite-runtime',
    readOnly: () => 'test',
    warn() {},
    load: async () => {},
    save: async () => {},
    dropKickoff() {},
    roomOf: (id) => (id === ROOM ? room : undefined),
    botOf: (id) => (id === 'chief' ? { id: 'chief', name: 'Chief', color: 'blue' } : undefined),
    isBotSession: (id) => id === 'work' || id === 'ga',
    groupOwners: new Map([['work', { botId: 'chief', roomId: ROOM, workLineId: 'essay' }]]),
    chatOwners: new Map(),
    selfOf: (id) => id,
    switchJobs: () => [],
    noteFailure() {},
    isAdminOf: (_room, botId) => botId === 'chief',
    deliver: async (payload) => { delivered.push(payload) },
    suppressRelayText() {},
    holdRoomRoute() {},
    releaseRoomRoute() {},
    takeRelayIntent: () => false,
    allowRelayText() {},
    consumeRouteHold: () => false,
    resolveAgent: async () => ({
      followup(message) { followups.push(message) },
      session: {},
      inbox: { nextStep: [], nextTurn: [], remove() { return false } },
      cancel() {},
    }),
  }
  installTurns(rt)
  installGroups(rt)
  const emit = (sessionId, event) => {
    for (const handler of handlers) {
      if (handler.type === 'session/event') handler.fn({ id: sessionId }, event)
    }
  }
  return { rt, room, tools, followups, delivered, emit }
}

// A finished round whose start is the idiom, so a stamp from the round's start
// would land on that earlier answer.
async function finishedRound(deskState) {
  deskState.rt.roomInbox.set(ROOM, [{ text: '', quiet: true, logged: 1, botId: 'chief' }])
  await deskState.tools.get('group_relay').execute({}, {
    callId: 'seed',
    agent: {
      id: ROOM,
      inbox: { nextStep: [], nextTurn: [], remove() { return false } },
    },
  })
}

async function confirmEssay(deskState) {
  const member = { id: 'chief', sessionId: 'work', name: 'Chief', color: 'blue' }
  await deskState.rt.acceptRoomSteer(deskState.room, member, {
    text: FIRST, quoteText: FIRST, quoteSeq: 4, quoteRoomId: ROOM, messageId: 'm-who',
  })
  await deskState.rt.acceptRoomSteer(deskState.room, member, {
    text: FOLLOW, quoteText: FOLLOW, quoteSeq: 5, quoteRoomId: ROOM, messageId: 'm-do',
  })
}

// The room session takes the post, then the relay writes the log line a reload reads.
async function relayPost(deskState) {
  const message = deskState.followups.shift()
  assert.ok(message, 'the reply was posted into the room session')
  deskState.emit(ROOM, { type: 'user/message', data: message })
  await deskState.tools.get('group_relay').execute({}, {
    callId: `relay-${deskState.room.seq}`,
    agent: {
      id: ROOM,
      inbox: { nextStep: [], nextTurn: [], remove() { return false } },
    },
  })
  return message
}

function bubbles(html) {
  return [...html.matchAll(/<div class="bt-ububble">([^<]*)<\/div>/g)].map(match => match[1])
}

function idiomRow(room) {
  return room.log.find(row => row.seq === 2)
}

test('after the round returns, confirming the essay leaves one late cite a reload can paint', async () => {
  const deskState = desk()
  await finishedRound(deskState)
  await confirmEssay(deskState)
  assert.equal(idiomRow(deskState.room).quote, undefined)
  assert.equal(idiomRow(deskState.room).quotes, undefined)
  const before = deskState.delivered.length
  await deskState.rt.lateRoomReply('work', {
    role: 'room',
    roomId: ROOM,
    quoteText: PROMPT,
    quoteSeq: 3,
    quoteRoomId: ROOM,
  }, ESSAY)
  assert.equal(deskState.delivered.length, before)
  const message = await relayPost(deskState)
  const source = message.source
  assert.equal(source.late, true)
  assert.equal(source.quiet, true)
  assert.equal(source.logged, undefined)
  assert.deepEqual(citeTexts(source), [FIRST, FOLLOW])
  assert.equal(citeTexts(source).includes(PROMPT), false)
  assert.equal(citeTexts(source).includes(IDIOM), false)
  const html = lateCiteHtml(citeTexts(source))
  assert.equal(html.split('data-late-cite=').length - 1, 1)
  assert.deepEqual(bubbles(html), [FIRST, FOLLOW])
  const essay = deskState.room.log.find(row => row.text === ESSAY)
  assert.ok(essay)
  assert.deepEqual(essay.quotes.map(item => item.seq), [4, 5])
  assert.equal(idiomRow(deskState.room).quote, undefined)
  assert.equal(idiomRow(deskState.room).quotes, undefined)
  const cited = citedFromLog(deskState.room.log, ROOM)
  assert.equal(hideCitedHistory({ text: FIRST, messageId: 'm-who', ...cited, citedTexts: cited.texts, citedIds: cited.ids }), true)
  assert.equal(hideCitedHistory({ text: FOLLOW, messageId: 'm-do', citedTexts: cited.texts, citedIds: cited.ids }), true)
  assert.equal(hideCitedHistory({ text: PROMPT, messageId: 'm-essay', citedTexts: cited.texts, citedIds: cited.ids }), false)
  assert.equal(hideCitedHistory({ text: '新开 帮我列3个秋天的成语', messageId: 'm-old', citedTexts: cited.texts, citedIds: cited.ids }), false)
  assert.equal(deskState.room.log.filter(row => row.who === 'User' && (row.text === FIRST || row.text === FOLLOW)).length, 2)
})

test('a later chunk of the same essay does not add a second cite or call a member', async () => {
  const deskState = desk()
  await finishedRound(deskState)
  await confirmEssay(deskState)
  await deskState.rt.roomStepText('work', { role: 'room', roomId: ROOM }, ESSAY, true)
  const first = await relayPost(deskState)
  assert.equal(first.source.late, true)
  assert.equal(first.source.quiet, true)
  assert.deepEqual(citeTexts(first.source), [FIRST, FOLLOW])
  await deskState.rt.lateRoomReply('work', {
    role: 'room',
    roomId: ROOM,
    quoteText: PROMPT,
    quoteSeq: 3,
    quoteRoomId: ROOM,
  }, '刚写完了')
  const second = await relayPost(deskState)
  assert.equal(second.source.late, undefined)
  assert.equal(second.source.quiet, true)
  assert.deepEqual(citeTexts(second.source), [])
  assert.equal(second.source.text ?? citeTexts(second.source).join(''), '')
  const html = lateCiteHtml(citeTexts(first.source))
  assert.equal(html.split('data-late-cite=').length - 1, 1)
  assert.equal(idiomRow(deskState.room).quotes, undefined)
  const chiefs = deskState.room.log.filter(row => row.botId === 'chief' && row.kind == null && row.seq > 2)
  assert.deepEqual(chiefs.map(row => row.text), [ESSAY, '刚写完了'])
  assert.equal(chiefs.filter(row => Array.isArray(row.quotes)).length, 1)
})

test('while the round is still running the essay reply carries the late cite in the tool result', async () => {
  const deskState = desk()
  const round = { roomId: ROOM, startSeq: 1, replies: [], slots: [], speaking: null }
  deskState.rt.roomProgress.set('live', round)
  await confirmEssay(deskState)
  assert.equal(idiomRow(deskState.room).quote, undefined)
  await deskState.rt.lateRoomReply('work', {
    role: 'room',
    roomId: ROOM,
    quoteText: PROMPT,
    quoteSeq: 3,
    quoteRoomId: ROOM,
  }, ESSAY)
  assert.equal(deskState.followups.length, 0)
  const saved = JSON.parse(JSON.stringify({ replies: round.replies }))
  const steering = saved.replies.filter(reply => reply.kind === 'steering')
  const posted = saved.replies.filter(reply => reply.kind == null)
  assert.deepEqual(steering.map(reply => reply.text), [FIRST, FOLLOW])
  assert.equal(posted.length, 1)
  assert.equal(posted[0].late, true)
  assert.equal(posted[0].text, ESSAY)
  assert.deepEqual(citeTexts(posted[0]), [FIRST, FOLLOW])
  // The painter hides a steering row when a late reply in the same result quotes it.
  assert.equal(steering.every(reply => citeTexts(posted[0]).includes(reply.text)), true)
  const html = lateCiteHtml(citeTexts(posted[0]))
  assert.equal(html.split('data-late-cite=').length - 1, 1)
  assert.deepEqual(bubbles(html), [FIRST, FOLLOW])
  assert.equal(idiomRow(deskState.room).quote, undefined)
  assert.equal(idiomRow(deskState.room).quotes, undefined)
  const essay = deskState.room.log.find(row => row.text === ESSAY)
  assert.deepEqual(essay.quotes.map(item => item.seq), [4, 5])
  const cited = citedFromLog(deskState.room.log, ROOM)
  assert.equal(hideCitedHistory({ text: FIRST, messageId: 'm-who', citedTexts: cited.texts, citedIds: cited.ids }), true)
  assert.equal(hideCitedHistory({ text: FOLLOW, messageId: 'm-do', citedTexts: cited.texts, citedIds: cited.ids }), true)
  assert.equal(hideCitedHistory({ text: IDIOM, messageId: 'm-idiom', citedTexts: cited.texts, citedIds: cited.ids }), false)
})

test('an open ask card confirms onto the essay and the live host posts one late cite', async () => {
  const deskState = desk()
  installRoute(deskState.rt)
  deskState.rt.live = new Map([
    ['work', { turn: 1 }],
    ['work-b', { turn: 2 }],
  ])
  deskState.room.log = [
    { seq: 1, who: 'User', text: '新开 帮我列3个秋天的成语', messageId: 'm-old' },
    { seq: 2, who: 'Chief', botId: 'chief', text: IDIOM },
    { seq: 3, who: 'User', text: PROMPT, messageId: 'm-essay' },
    { seq: 8, who: 'User', text: '海边散步看夜色', messageId: 'm-beach' },
  ]
  deskState.room.seq = 8
  deskState.rt.state.workLines = {
    essay: {
      id: 'essay', botId: 'chief', sessionId: 'work', lastRoomId: ROOM,
      quote: { roomId: ROOM, seq: 3 }, label: '秋水', updatedAt: 2, segments: [],
    },
    beach: {
      id: 'beach', botId: 'chief', sessionId: 'work-b', lastRoomId: ROOM,
      quote: { roomId: ROOM, seq: 8 }, label: '海边', updatedAt: 1, segments: [],
    },
  }
  await finishedRound(deskState)
  const ask = deskState.rt.routeRoomUser({ room: deskState.room, text: FIRST, plain: true })
  assert.equal(ask.action, 'ask')
  assert.deepEqual(ask.choices.map(choice => choice.id).sort(), ['beach', 'essay'])
  await deskState.rt.applyRouteDecision(deskState.room, ask, { text: FIRST, id: 'm-who' })
  const held = deskState.rt.routeRoomUser({ room: deskState.room, text: FOLLOW, plain: true })
  assert.equal(held.action, 'hold')
  await deskState.rt.applyRouteDecision(deskState.room, held, { text: FOLLOW, id: 'm-do' })
  assert.deepEqual(deskState.rt.state.pendingRoutes[ROOM].texts, [FIRST, FOLLOW])
  const choice = deskState.rt.routeRoomUser({ room: deskState.room, text: 'essay', plain: true })
  assert.equal(choice.action, 'steer')
  assert.equal(choice.sessionId, 'work')
  await deskState.rt.applyRouteDecision(deskState.room, choice, { text: 'essay', id: 'm-choice' })
  assert.equal(deskState.rt.state.pendingRoutes[ROOM], undefined)
  assert.equal(idiomRow(deskState.room).quote, undefined)
  await deskState.rt.lateRoomReply('work', {
    role: 'room',
    roomId: ROOM,
    quoteText: PROMPT,
    quoteSeq: 3,
    quoteRoomId: ROOM,
  }, ESSAY)
  const message = await relayPost(deskState)
  assert.equal(message.source.late, true)
  assert.equal(message.source.quiet, true)
  assert.deepEqual(citeTexts(message.source), [FIRST, FOLLOW])
  assert.equal(citeTexts(message.source).includes(PROMPT), false)
  assert.equal(idiomRow(deskState.room).quote, undefined)
  assert.equal(idiomRow(deskState.room).quotes, undefined)
  const essay = deskState.room.log.find(row => row.text === ESSAY)
  const who = deskState.room.log.find(row => row.who === 'User' && row.text === FIRST)
  const follow = deskState.room.log.find(row => row.who === 'User' && row.text === FOLLOW)
  assert.deepEqual(essay.quotes.map(item => item.seq), [who.seq, follow.seq])
  assert.ok(who.seq < follow.seq)
})

test('a restarted host still cites the follow-ups the turn already recorded', async () => {
  const deskState = desk()
  const member = { id: 'chief', sessionId: 'work', name: 'Chief', color: 'blue' }
  await deskState.rt.acceptRoomSteer(deskState.room, member, {
    text: FIRST, quoteText: FIRST, quoteSeq: 4, quoteRoomId: ROOM, messageId: 'm-who',
  })
  await deskState.rt.lateRoomReply('work', {
    role: 'room',
    roomId: ROOM,
    quotes: [
      { text: FIRST, seq: 4, roomId: ROOM },
      { text: FOLLOW, seq: 5, roomId: ROOM },
    ],
  }, ESSAY)
  const message = deskState.followups[0]
  assert.equal(message.source.late, true)
  assert.equal(message.source.quiet, true)
  assert.deepEqual(citeTexts(message.source), [FIRST, FOLLOW])
})
