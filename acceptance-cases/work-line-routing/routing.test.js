// R1–R16: inbound room routing. Pure decision plus a turns install fake.
// No @deepseek-ai import.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { install as installTurns } from '../../vendor/ds-bot/src/host/turns.js'
import { install as installWorkLines } from '../../vendor/ds-bot/src/host/work-lines.js'
import { install as installRoute } from '../../vendor/ds-bot/src/host/route-inbound.js'
import {
  addressedBot,
  answerChoice,
  effectsOf,
  explicitIntent,
  routeCard,
  routeInbound,
} from '../../vendor/ds-bot/src/host/route-inbound.js'

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const source = (path) => readFileSync(join(root, path), 'utf8')
const PROBE = 'DEMO_STEER_OK'
const POEM = '秋天的诗写给远方'
const BEACH = '海边散步看夜色'
const REPORT = '周报进度同步一下客户'
const OLD = '季度周报进度需要补充客户拜访'

function line(partial) {
  return {
    id: partial.id,
    botId: partial.botId ?? 'chief',
    sessionId: partial.sessionId ?? partial.id,
    lastRoomId: partial.lastRoomId ?? 'r1',
    ...(partial.label !== undefined ? { label: partial.label } : {}),
    updatedAt: partial.updatedAt ?? 1,
    busy: partial.busy === true,
    doc: partial.doc ?? '',
  }
}

function decide(text, lines, extra = {}) {
  return routeInbound({ text, roomId: extra.roomId ?? 'r1', botId: extra.botId ?? 'chief', lines, explicitQueue: extra.explicitQueue === true })
}

function stored(partial) {
  return {
    id: partial.id,
    botId: partial.botId ?? 'chief',
    sessionId: partial.sessionId ?? 'ga',
    lastRoomId: partial.lastRoomId ?? 'r1',
    ...(partial.label !== undefined ? { label: partial.label } : {}),
    ...(partial.quote !== undefined ? { quote: partial.quote } : {}),
    updatedAt: partial.updatedAt ?? 1,
    segments: [],
  }
}

function userMessage(text, messageSource = { kind: 'user' }) {
  return { type: 'user/message', data: { source: messageSource, content: [{ type: 'text', text }] } }
}

function spliced(text, target = 'next-step', messageSource = { kind: 'user' }) {
  return {
    type: 'agent/inbox/spliced',
    data: {
      target,
      inserted: [{ id: 'm1', role: 'user', source: messageSource, content: [{ type: 'text', text }] }],
    },
  }
}

async function flush() {
  for (let step = 0; step < 6; step += 1) {
    await new Promise(resolve => setImmediate(resolve))
  }
}

function wireHost({ workLines = {}, logs = {} } = {}) {
  const handlers = []
  const steered = []
  const delivered = []
  const rooms = {
    r1: {
      id: 'r1',
      name: 'Launch',
      admin: 'chief',
      members: ['chief', 'writer'],
      sessions: { chief: 'ga', writer: 'gb' },
      seq: (logs.r1 ?? [{ seq: 1, who: 'User', text: '本地问候' }]).length,
      log: logs.r1 ?? [{ seq: 1, who: 'User', text: '本地问候' }],
    },
    r2: {
      id: 'r2',
      name: 'Other',
      admin: 'chief',
      members: ['chief'],
      sessions: { chief: 'remote' },
      seq: (logs.r2 ?? []).length,
      log: logs.r2 ?? [],
    },
  }
  const bots = {
    chief: { id: 'chief', name: 'Chief' },
    writer: { id: 'writer', name: 'Writer' },
  }
  const sessions = new Set(['ga', 'gb', 'ga2', 'remote', 'session-new'])
  const rt = {
    ctx: { on: (type, fn) => { if (type === 'session/event') handlers.push(fn) } },
    state: {
      questions: {},
      views: {},
      exchanges: [],
      exchangeTurns: {},
      workLines,
      workLineCompleted: {},
      pendingRoutes: {},
    },
    warn() {},
    save: async () => {},
    dropKickoff() {},
    roomOf: (id) => rooms[id],
    botOf: (id) => bots[id],
    isBotSession: (id) => sessions.has(id),
    groupOwners: new Map([['ga', { botId: 'chief', roomId: 'r1' }], ['gb', { botId: 'writer', roomId: 'r1' }]]),
    chatOwners: new Map(),
    selfOf: (id) => id,
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
  return { rt, emit, steered, delivered, rooms }
}

test('R1 one local busy line steers DEMO_STEER_OK, including the composer splice', () => {
  const decision = decide(PROBE, [line({ id: 'poem', busy: true, doc: POEM, sessionId: 'ga' })])
  assert.equal(decision.action, 'steer')
  assert.equal(decision.steer, true)
  assert.equal(decision.workLineId, 'poem')

  const indexed = wireHost({
    workLines: { poem: stored({ id: 'poem', quote: { roomId: 'r1', seq: 1 } }) },
    logs: { r1: [{ seq: 1, who: 'User', text: POEM }] },
  })
  indexed.emit('ga', { type: 'turn/start', data: { turn: 1 }, time: 1 })
  indexed.emit('r1', spliced(PROBE))
  indexed.emit('r1', userMessage(PROBE))
  assert.equal(indexed.steered.length, 1)
  assert.equal(indexed.steered[0].member.sessionId, 'ga')
  assert.equal(indexed.steered[0].message.text, PROBE)
  assert.equal(indexed.rt.roomInbox.get('r1'), undefined)

  const implicit = wireHost()
  implicit.emit('ga', { type: 'turn/start', data: { turn: 1 }, time: 1 })
  implicit.emit('r1', userMessage(PROBE))
  assert.equal(implicit.steered.length, 1)
  assert.equal(implicit.steered[0].member.sessionId, 'ga')
  assert.equal(implicit.rt.roomInbox.get('r1'), undefined)

  const both = wireHost()
  both.emit('ga', { type: 'turn/start', data: { turn: 1 }, time: 1 })
  both.emit('gb', { type: 'turn/start', data: { turn: 2 }, time: 1 })
  both.emit('r1', userMessage(PROBE))
  assert.equal(both.steered.length, 0)
  assert.equal(both.rt.roomInbox.get('r1')?.[0]?.text, PROBE)
})

test('R2 a hitting idle line wins when the one local busy line misses', () => {
  const decision = decide('周报进度', [
    line({ id: 'busy', busy: true, doc: POEM, sessionId: 'ga' }),
    line({ id: 'old', busy: false, doc: REPORT, label: '周报', sessionId: 'old' }),
  ])
  assert.equal(decision.action, 'continue')
  assert.equal(decision.steer, false)
  assert.equal(decision.workLineId, 'old')

  const host = wireHost({
    workLines: {
      busy: stored({ id: 'busy', sessionId: 'ga', quote: { roomId: 'r1', seq: 1 } }),
      old: stored({ id: 'old', sessionId: 'old', label: '周报', quote: { roomId: 'r1', seq: 2 } }),
    },
    logs: { r1: [{ seq: 1, who: 'User', text: POEM }, { seq: 2, who: 'User', text: REPORT }] },
  })
  host.emit('ga', { type: 'turn/start', data: { turn: 1 }, time: 1 })
  host.emit('r1', userMessage('周报进度'))
  assert.equal(host.steered.length, 0)
  assert.equal(host.delivered[0].sessionId, 'old')
  assert.equal(host.delivered[0].steer, false)
  assert.equal(host.rt.roomInbox.get('r1'), undefined)
})

test('R3 新开 and /new create while a line is busy', async () => {
  for (const text of ['新开一首', '/new poem', '/NEW poem']) {
    const decision = decide(text, [line({ id: 'busy', busy: true, doc: POEM })])
    assert.equal(decision.action, 'create', text)
    assert.equal(decision.steer, false, text)
    assert.equal(decision.workLineId, undefined, text)
  }
  const still = decide('请新开', [line({ id: 'busy', busy: true, doc: POEM })])
  assert.equal(still.action, 'steer')
  assert.equal(explicitIntent('新开').kind, 'new')
  assert.equal(explicitIntent('/new').kind, 'new')
  assert.equal(explicitIntent('继续').kind, 'auto')

  const host = wireHost({
    workLines: { poem: stored({ id: 'poem', quote: { roomId: 'r1', seq: 1 } }) },
    logs: { r1: [{ seq: 1, who: 'User', text: POEM }] },
  })
  const before = host.rooms.r1.log.map(entry => entry.text)
  host.emit('ga', { type: 'turn/start', data: { turn: 1 }, time: 1 })
  host.emit('r1', userMessage('新开一首'))
  await flush()
  assert.equal(host.steered.length, 0)
  assert.equal(host.delivered.at(-1)?.sessionId, 'session-new')
  assert.equal(host.delivered.at(-1)?.steer, false)
  assert.deepEqual(host.rooms.r1.log.map(entry => entry.text), [...before, '新开一首'])
  assert.equal(host.rooms.r1.log.at(-1).who, 'User')
  assert.equal(host.rooms.r1.log.at(-1).kind, undefined)
})

test('R4 续： and a card id select that line', () => {
  const busy = decide('续：周报', [
    line({ id: 'a', busy: true, label: '周报', doc: POEM, sessionId: 'ga' }),
    line({ id: 'b', busy: false, label: '海边', doc: BEACH, sessionId: 'gb' }),
  ])
  assert.equal(busy.action, 'steer')
  assert.equal(busy.workLineId, 'a')
  const idle = decide('续:周报', [line({ id: 'a', busy: false, label: '周报', doc: POEM })])
  assert.equal(idle.action, 'continue')
  assert.equal(idle.steer, false)
  assert.equal(idle.workLineId, 'a')
  const card = decide('wl-9', [line({ id: 'wl-9', busy: true, label: '其他', doc: POEM })])
  assert.equal(card.action, 'steer')
  assert.equal(card.workLineId, 'wl-9')
})

test('R5 explicit queue is a follow-up and does not steer', () => {
  const decision = decide(PROBE, [line({ id: 'busy', busy: true, doc: POEM, sessionId: 'ga' })], { explicitQueue: true })
  assert.equal(decision.action, 'queue')
  assert.equal(decision.steer, false)
  assert.equal(decision.workLineId, 'busy')
  const overNew = decide('新开一首', [line({ id: 'busy', busy: true, doc: POEM, sessionId: 'ga' })], { explicitQueue: true })
  assert.equal(overNew.action, 'queue')
  assert.equal(overNew.steer, false)

  const host = wireHost({
    workLines: { busy: stored({ id: 'busy', quote: { roomId: 'r1', seq: 1 } }) },
    logs: { r1: [{ seq: 1, who: 'User', text: POEM }] },
  })
  host.emit('ga', { type: 'turn/start', data: { turn: 1 }, time: 1 })
  host.emit('r1', userMessage(PROBE, { kind: 'user', mode: 'queue' }))
  assert.equal(host.steered.length, 0)
  assert.equal(host.delivered[0].steer, false)
  assert.equal(host.delivered[0].sessionId, 'ga')
})

test('R6 no busy line and one history hit continues', () => {
  const decision = decide('周报进度', [line({ id: 'old', busy: false, doc: REPORT, label: '周报' })])
  assert.equal(decision.action, 'continue')
  assert.equal(decision.steer, false)
  assert.equal(decision.workLineId, 'old')
})

test('R7 no busy line and no hit creates', () => {
  const decision = decide(PROBE, [line({ id: 'old', busy: false, doc: POEM })])
  assert.equal(decision.action, 'create')
  assert.equal(decision.steer, false)
  assert.equal(decide('hello', []).action, 'create')
})

test('R8 two busy lines steer only the one whose opening and draft hit', () => {
  const decision = decide('周报进度要更新', [
    line({ id: 'a', busy: true, doc: '周报进度要更新今天下午', updatedAt: 1 }),
    line({ id: 'b', busy: true, doc: BEACH, updatedAt: 2 }),
  ])
  assert.equal(decision.action, 'steer')
  assert.equal(decision.workLineId, 'a')
  assert.equal(decision.steer, true)

  const host = wireHost({
    workLines: {
      a: stored({ id: 'a', sessionId: 'ga', label: '周报', quote: { roomId: 'r1', seq: 1 }, updatedAt: 1 }),
      b: stored({ id: 'b', sessionId: 'ga2', label: '海边', quote: { roomId: 'r1', seq: 2 }, updatedAt: 2 }),
    },
    logs: { r1: [{ seq: 1, who: 'User', text: POEM }, { seq: 2, who: 'User', text: BEACH }] },
  })
  host.emit('ga', { type: 'turn/start', data: { turn: 1 }, time: 1 })
  host.emit('ga2', { type: 'turn/start', data: { turn: 2 }, time: 1 })
  host.rt.roomProgress.set('round', { roomId: 'r1', draft: { botId: 'chief', text: '周报进度要更新今天下午' } })
  host.emit('r1', userMessage('周报进度要更新'))
  assert.equal(host.steered.length, 1)
  assert.equal(host.steered[0].member.sessionId, 'ga')
  assert.equal(host.delivered.length, 0)
})

test('R9 two busy lines ask when both miss or both hit', () => {
  const missed = decide(PROBE, [
    line({ id: 'a', busy: true, doc: POEM, updatedAt: 1 }),
    line({ id: 'b', busy: true, doc: BEACH, updatedAt: 4 }),
  ])
  assert.equal(missed.action, 'ask')
  assert.equal(missed.steer, false)
  assert.equal(missed.workLineId, undefined)
  assert.equal(missed.highlight, 'b')
  const hit = decide('周报进度要更新', [
    line({ id: 'a', busy: true, doc: '周报进度要更新今天下午' }),
    line({ id: 'b', busy: true, doc: '周报进度要更新明天早上' }),
  ])
  assert.equal(hit.action, 'ask')
  assert.equal(hit.steer, false)
  const mixed = decide('周报进度客户拜访', [
    line({ id: 'a', busy: true, doc: '周报进度客户拜访补充说明' }),
    line({ id: 'b', busy: true, doc: '周报进度海边夜色' }),
  ])
  assert.equal(mixed.action, 'ask')
  const idleHit = decide('周报进度', [
    line({ id: 'a', busy: true, doc: POEM }),
    line({ id: 'b', busy: true, doc: BEACH }),
    line({ id: 'c', busy: false, doc: REPORT }),
  ])
  assert.equal(idleHit.action, 'continue')
  assert.equal(idleHit.workLineId, 'c')
})

test('R10 an ask card logs the sentence once and does not deliver or time out', async () => {
  const host = wireHost({
    workLines: {
      a: stored({ id: 'a', sessionId: 'ga', label: '甲', quote: { roomId: 'r1', seq: 1 }, updatedAt: 1 }),
      b: stored({ id: 'b', sessionId: 'ga2', label: '乙', quote: { roomId: 'r1', seq: 2 }, updatedAt: 9 }),
    },
    logs: { r1: [{ seq: 1, who: 'User', text: POEM }, { seq: 2, who: 'User', text: BEACH }] },
  })
  const before = host.rooms.r1.log.length
  host.emit('ga', { type: 'turn/start', data: { turn: 1 }, time: 1 })
  host.emit('ga2', { type: 'turn/start', data: { turn: 2 }, time: 1 })
  host.emit('r1', userMessage(PROBE))
  await flush()
  const pending = host.rt.state.pendingRoutes.r1
  assert.ok(pending)
  assert.equal(pending.timeoutSends, false)
  assert.equal(pending.highlight, 'b')
  assert.equal(pending.seq, host.rooms.r1.seq)
  assert.equal(routeCard(pending).kind, 'route')
  assert.equal(routeCard(pending).timeoutSends, false)
  assert.equal(routeCard(pending).text, PROBE)
  assert.equal(effectsOf({ action: 'ask' }).modelTurn, false)
  assert.equal(effectsOf({ action: 'ask' }).writeLog, false)
  assert.equal(effectsOf({ action: 'ask' }).deliver, false)
  assert.equal(effectsOf({ action: 'ask' }).copyTranscript, false)
  assert.equal(host.steered.length, 0)
  assert.equal(host.delivered.length, 0)
  assert.equal(host.rt.roomInbox.get('r1'), undefined)
  assert.equal(host.rooms.r1.log.length, before + 1)
  assert.equal(host.rooms.r1.log.at(-1).who, 'User')
  assert.equal(host.rooms.r1.log.at(-1).text, PROBE)
  assert.equal(host.rooms.r1.log.at(-1).kind, undefined)

  host.emit('r1', userMessage('随便说说'))
  await flush()
  assert.equal(host.steered.length, 0)
  assert.equal(host.delivered.length, 0)
  assert.equal(host.rt.state.pendingRoutes.r1, pending)
  assert.equal(pending.text, PROBE)
  assert.deepEqual(pending.texts, [PROBE, '随便说说'])
  assert.equal(host.rooms.r1.log.filter(entry => entry.text === '随便说说').length, 1)

  host.emit('r1', userMessage('续：乙'))
  await flush()
  assert.equal(host.rt.state.pendingRoutes.r1, undefined)
  assert.deepEqual(host.steered.map(item => item.message.text), [PROBE, '随便说说'])
  assert.equal(host.steered.every(item => item.member.sessionId === 'ga2'), true)
  assert.equal(host.rooms.r1.log.filter(entry => entry.text === '随便说说').length, 1)
  assert.equal(host.rooms.r1.log.some(entry => entry.text === '续：乙'), false)
})

test('confirm by choice id clears the saved card before delivery and keeps the held text', async () => {
  const pending = {
    choices: [
      { id: 'line-aaaa', sessionId: 'ga', label: '甲', busy: true },
      { id: 'line-bbbb', sessionId: 'session-line-b', label: '乙', busy: false },
    ],
  }
  assert.equal(answerChoice('line-bbbb', pending).id, 'line-bbbb')
  assert.equal(answerChoice('session-line-b', pending).sessionId, 'session-line-b')
  assert.equal(answerChoice('use line-bbbb please', pending).id, 'line-bbbb')
  assert.equal(answerChoice(PROBE, pending), undefined)

  const host = wireHost({
    workLines: {
      a: stored({ id: 'line-a', sessionId: 'ga', label: '甲', quote: { roomId: 'r1', seq: 1 }, updatedAt: 1 }),
      b: stored({ id: 'line-b', sessionId: 'ga2', label: '乙', quote: { roomId: 'r1', seq: 2 }, updatedAt: 9 }),
    },
    logs: { r1: [{ seq: 1, who: 'User', text: POEM }, { seq: 2, who: 'User', text: BEACH }] },
  })
  const suppressed = []
  const saved = []
  host.rt.suppressRelayText = (roomId, text) => { suppressed.push({ roomId, text }) }
  host.rt.holdRoomRoute = () => {}
  host.rt.save = async () => { saved.push(JSON.parse(JSON.stringify(host.rt.state.pendingRoutes))) }
  const steer = host.rt.acceptRoomSteer
  host.rt.acceptRoomSteer = async (...args) => {
    host.rt.state.pendingRoutes = JSON.parse(JSON.stringify(saved.at(-1) ?? {}))
    return steer(...args)
  }
  host.emit('ga', { type: 'turn/start', data: { turn: 1 }, time: 1 })
  host.emit('ga2', { type: 'turn/start', data: { turn: 2 }, time: 1 })
  host.emit('r1', userMessage(PROBE))
  await flush()
  assert.equal(suppressed.at(-1)?.text, PROBE)
  assert.ok(saved.at(-1)?.r1)
  assert.equal(host.rt.state.pendingRoutes.r1.timeoutSends, false)

  host.emit('r1', userMessage('line-b'))
  await flush()
  assert.equal(host.rt.state.pendingRoutes.r1, undefined)
  assert.equal(saved.at(-1)?.r1, undefined)
  assert.equal(host.steered.length, 1)
  assert.equal(host.steered[0].message.text, PROBE)
  assert.equal(host.steered[0].member.sessionId, 'ga2')
  assert.equal(host.delivered.length, 0)
  assert.equal(host.rooms.r1.log.filter(entry => entry.who === 'User' && entry.text === PROBE).length, 1)
  assert.equal(host.rooms.r1.log.some(entry => entry.text === 'line-b'), false)
})

test('create selects the new session model and delivers the user text', async () => {
  const host = wireHost({
    // A label keeps this line a task. The unlabeled primary session is the group
    // round, and a miss on only that round stays on the relay.
    workLines: { poem: stored({ id: 'poem', label: '秋天的诗', quote: { roomId: 'r1', seq: 1 } }) },
    logs: { r1: [{ seq: 1, who: 'User', text: POEM }] },
  })
  let disk = {}
  const selected = []
  host.rt.desiredModel = async () => 'prov/model'
  host.rt.selectSessionModel = async (sessionId, route) => { selected.push({ sessionId, route }) }
  host.rt.applyPermission = async () => {}
  host.rt.save = async () => { disk = JSON.parse(JSON.stringify(host.rt.state.workLines)) }
  host.rt.ensureCapabilities = async () => {
    host.rt.state.workLines = JSON.parse(JSON.stringify(disk))
  }
  host.emit('r1', userMessage(PROBE))
  await flush()
  assert.deepEqual(selected, [{ sessionId: 'session-new', route: { provider: 'prov', model: 'model' } }])
  assert.equal(host.delivered.at(-1)?.text, PROBE)
  assert.equal(host.delivered.at(-1)?.sessionId, 'session-new')
  assert.equal(host.delivered.at(-1)?.steer, false)
  assert.equal(Object.values(host.rt.state.workLines).some(item => item.sessionId === 'session-new'), true)
})

test('R11 the card highlights the newest busy line, else the newest line', () => {
  const busy = decide('zzz', [
    line({ id: 'idle', busy: false, updatedAt: 100, doc: '完全不同的话题啊' }),
    line({ id: 'busy-old', busy: true, updatedAt: 10, doc: POEM }),
    line({ id: 'busy-new', busy: true, updatedAt: 20, doc: BEACH }),
  ])
  assert.equal(busy.action, 'ask')
  assert.equal(busy.highlight, 'busy-new')
  const idle = decide('周报进度', [
    line({ id: 'a', busy: false, updatedAt: 3, doc: REPORT }),
    line({ id: 'b', busy: false, updatedAt: 8, doc: `${REPORT}补充` }),
  ])
  assert.equal(idle.action, 'ask')
  assert.equal(idle.highlight, 'b')
})

test('R12 @Name only picks the bot, and message_bot does not use the router', () => {
  const mention = addressedBot('@Writer 周报进度', [{ id: 'chief', name: 'Chief' }, { id: 'writer', name: 'Writer' }])
  assert.equal(mention.kind, 'one')
  assert.equal(mention.bot.id, 'writer')
  const host = wireHost({
    workLines: {
      poem: stored({ id: 'poem', botId: 'chief', sessionId: 'ga', quote: { roomId: 'r1', seq: 1 } }),
      report: stored({ id: 'report', botId: 'writer', sessionId: 'gb', label: '周报', quote: { roomId: 'r1', seq: 2 } }),
    },
    logs: { r1: [{ seq: 1, who: 'User', text: POEM }, { seq: 2, who: 'User', text: REPORT }] },
  })
  host.emit('ga', { type: 'turn/start', data: { turn: 1 }, time: 1 })
  host.emit('r1', userMessage('@Writer 周报进度'))
  assert.equal(host.steered.length, 0)
  assert.equal(host.delivered[0].sessionId, 'gb')
  assert.equal(host.delivered[0].steer, false)
  const tools = source('vendor/ds-bot/src/host/tools.js')
  assert.match(tools, /const steer = \(args\.when !== 'queue' && !toUser\)/)
  assert.doesNotMatch(tools, /route-inbound|routeRoomUser|routeInbound/)
})

test('R13 继续 and 这段改短 still steer the one local busy line', () => {
  for (const text of ['继续', '这段改短']) {
    const decision = decide(text, [line({ id: 'busy', busy: true, doc: POEM, sessionId: 'ga' })])
    assert.equal(decision.action, 'steer', text)
    assert.equal(decision.workLineId, 'busy', text)
  }
  const host = wireHost({
    workLines: { poem: stored({ id: 'poem', quote: { roomId: 'r1', seq: 1 } }) },
    logs: { r1: [{ seq: 1, who: 'User', text: POEM }] },
  })
  host.emit('ga', { type: 'turn/start', data: { turn: 1 }, time: 1 })
  host.emit('r1', userMessage('继续'))
  host.emit('r1', userMessage('这段改短'))
  assert.equal(host.steered.length, 2)
  assert.equal(host.steered[0].message.text, '继续')
  assert.equal(host.steered[1].message.text, '这段改短')
})

test('R14 a strong match in another room continues that line and does not copy its log', () => {
  const decision = decide('周报进度', [line({ id: 'far', busy: false, lastRoomId: 'r2', doc: OLD, sessionId: 'remote' })])
  assert.equal(decision.action, 'continue')
  assert.equal(decision.workLineId, 'far')
  assert.equal(decision.crossRoom, true)
  assert.equal(effectsOf(decision).copyTranscript, false)
  assert.equal(effectsOf(decision).writeLog, false)

  const host = wireHost({
    workLines: {
      far: stored({ id: 'far', sessionId: 'remote', lastRoomId: 'r2', quote: { roomId: 'r2', seq: 1 }, label: '周报' }),
    },
    logs: {
      r1: [{ seq: 1, who: 'User', text: '本地问候' }],
      r2: [{ seq: 1, who: 'User', text: OLD }],
    },
  })
  const other = JSON.stringify(host.rooms.r2.log)
  host.emit('r1', userMessage('周报进度'))
  assert.equal(host.steered.length, 0)
  assert.equal(host.delivered.length, 1)
  assert.equal(host.delivered[0].sessionId, 'remote')
  assert.equal(host.delivered[0].roomId, 'r1')
  assert.equal(host.delivered[0].steer, false)
  assert.equal(host.delivered[0].text, '周报进度')
  assert.equal(JSON.stringify(host.rooms.r2.log), other)
  assert.equal(host.rooms.r1.log.some(line => line.text === OLD), false)
  assert.equal(host.rooms.r1.log.filter(line => line.who === 'User' && line.text === '周报进度').length, 1)
  assert.equal(host.rt.state.workLines.far.lastRoomId, 'r1')
  assert.equal(host.rt.state.workLines.far.messages, undefined)
})

test('R15 the composer, drainRoomInbox, and channel.send share one decision', () => {
  const turns = source('vendor/ds-bot/src/host/turns.js')
  const groups = source('vendor/ds-bot/src/host/groups.js')
  const channel = source('vendor/ds-bot/src/host/channel.js')
  const admit = turns.slice(turns.indexOf('const admitRoomUser'), turns.indexOf('const noteTurnFailure'))
  const drain = groups.slice(groups.indexOf('function drainRoomInbox'), groups.indexOf('async function runRound'))
  const send = channel.slice(channel.indexOf("case 'send'"), channel.indexOf("case 'btw-delete'"))
  assert.match(admit, /routeRoomUser\?\.\(/)
  assert.match(admit, /suppressRelayText\?\.\(/)
  assert.match(admit, /holdRoomRoute\?\.\(/)
  assert.match(drain, /routeRoomUser\?\.\(/)
  assert.match(send, /routeRoomUser\?\.\(/)
  assert.match(groups, /consumeRouteHold/)
  assert.match(channel, /pendingRoutes: state\.pendingRoutes/)
  assert.match(turns, /decideRoomSteer\(/)
  assert.match(channel, /decideRoomSteer\(/)
  assert.match(channel, /acceptRoomSteer\(/)
  assert.match(source('vendor/ds-bot/index.js'), /route-inbound\.js/)
  const router = source('vendor/ds-bot/src/host/route-inbound.js')
  assert.match(router, /export function routeInbound/)
  assert.doesNotMatch(router, /@deepseek-ai/)
  assert.doesNotMatch(router, /matchThread|scoreThread|titleOf/)
  assert.doesNotMatch(router, /ask_user|concludeTurn/)
  assert.doesNotMatch(router, /setTimeout|setInterval/)
  assert.doesNotMatch(router, /threads\.js/)
})

test('R16 a busy line in another room does not steer on its own', async () => {
  const remote = line({ id: 'far', busy: true, lastRoomId: 'r2', doc: POEM, sessionId: 'remote' })
  const missed = decide(PROBE, [remote])
  assert.equal(missed.action, 'create')
  assert.equal(missed.steer, false)
  const hit = decide('周报进度', [line({ id: 'far', busy: true, lastRoomId: 'r2', doc: REPORT, sessionId: 'remote' })])
  assert.equal(hit.action, 'steer')
  assert.equal(hit.workLineId, 'far')
  const unsure = decide('周报进度客户拜访', [line({ id: 'far', busy: true, lastRoomId: 'r2', doc: '周报进度海边夜色', sessionId: 'remote' })])
  assert.equal(unsure.action, 'ask')
  assert.equal(unsure.steer, false)

  const host = wireHost({
    workLines: {
      far: stored({ id: 'far', sessionId: 'remote', lastRoomId: 'r2', quote: { roomId: 'r2', seq: 1 } }),
    },
    logs: {
      r1: [{ seq: 1, who: 'User', text: '本地问候' }],
      r2: [{ seq: 1, who: 'User', text: OLD }],
    },
  })
  const before = host.rooms.r1.log.map(entry => entry.text)
  host.emit('remote', { type: 'turn/start', data: { turn: 3 }, time: 1 })
  host.emit('r1', userMessage(PROBE))
  await flush()
  assert.equal(host.steered.length, 0)
  assert.equal(host.delivered.at(-1)?.sessionId, 'session-new')
  assert.equal(host.delivered.at(-1)?.text, PROBE)
  assert.equal(host.delivered.at(-1)?.steer, false)
  assert.deepEqual(host.rooms.r1.log.map(entry => entry.text), [...before, PROBE])
  assert.equal(host.rooms.r1.log.at(-1).who, 'User')
  assert.equal(JSON.stringify(host.rooms.r1.log).includes(OLD), false)
  assert.notEqual(host.rt.state.workLines.far, undefined)
  assert.equal(Object.values(host.rt.state.workLines).some(item => item.sessionId === 'session-new'), true)
})

test('idle lines in other rooms do not ask or swallow the opening sentence', async () => {
  const host = wireHost({
    workLines: {
      a: stored({ id: 'a', sessionId: 'remote-a', lastRoomId: 'r2', quote: { roomId: 'r2', seq: 1 } }),
      b: stored({ id: 'b', sessionId: 'remote-b', lastRoomId: 'r2', quote: { roomId: 'r2', seq: 2 } }),
      c: stored({ id: 'c', sessionId: 'remote-c', lastRoomId: 'r2', quote: { roomId: 'r2', seq: 3 }, label: '秋水' }),
    },
    logs: {
      r1: [],
      r2: [
        { seq: 1, who: 'User', text: 'hi' },
        { seq: 2, who: 'User', text: '你们是谁' },
        { seq: 3, who: 'User', text: '在干嘛' },
      ],
    },
  })
  host.emit('r1', userMessage('hi'))
  host.emit('r1', userMessage('你们是谁'))
  await flush()
  assert.equal(host.rt.state.pendingRoutes.r1, undefined)
  assert.equal(host.steered.length, 0)
  assert.equal(host.delivered.length, 0)
  assert.deepEqual(host.rt.roomInbox.get('r1').map(item => item.text), ['hi', '你们是谁'])
})

test('one other member\'s leftover line does not take the opening off the group', async () => {
  const host = wireHost({
    workLines: {
      a: stored({ id: 'a', sessionId: 'remote-a', lastRoomId: 'r2', quote: { roomId: 'r2', seq: 1 } }),
      b: stored({ id: 'b', sessionId: 'remote-b', lastRoomId: 'r2', quote: { roomId: 'r2', seq: 2 } }),
      quiet: stored({ id: 'quiet', botId: 'writer', sessionId: 'gb', lastRoomId: 'r3', quote: { roomId: 'r3', seq: 1 } }),
    },
    logs: {
      r1: [],
      r2: [
        { seq: 1, who: 'User', text: 'hi' },
        { seq: 2, who: 'User', text: '你们是谁' },
        { seq: 3, who: 'User', text: '在干嘛' },
      ],
    },
  })
  host.rooms.r3 = {
    id: 'r3',
    name: 'Quiet',
    admin: 'writer',
    members: ['writer'],
    sessions: { writer: 'gb' },
    seq: 1,
    log: [{ seq: 1, who: 'User', text: '在干嘛' }],
  }
  host.emit('r1', userMessage('你们是谁'))
  host.emit('r1', userMessage('在干嘛'))
  await flush()
  assert.equal(host.rt.state.pendingRoutes.r1, undefined)
  assert.equal(host.steered.length, 0)
  assert.equal(host.delivered.length, 0)
  assert.deepEqual(host.rt.roomInbox.get('r1').map(item => item.text), ['你们是谁', '在干嘛'])
})

test('wired host keeps #18 queue, named, and mode-new on the relay path when there is no index', () => {
  const host = wireHost()
  host.emit('r1', userMessage(PROBE))
  assert.equal(host.steered.length, 0)
  assert.equal(host.rt.roomInbox.get('r1')?.[0]?.text, PROBE)
  host.emit('ga', { type: 'turn/start', data: { turn: 1 }, time: 1 })
  host.emit('r1', userMessage(PROBE, { kind: 'user', mode: 'queue' }))
  host.emit('r1', userMessage('@Writer look'))
  host.emit('r1', userMessage('fresh', { kind: 'user', mode: 'new' }))
  assert.equal(host.steered.length, 0)
  assert.deepEqual(host.rt.roomInbox.get('r1').map(item => item.text), [PROBE, PROBE, '@Writer look', 'fresh'])

  const queued = wireHost()
  queued.emit('r1', { type: 'turn/start', data: { turn: 1 }, time: 1 })
  queued.emit('ga', { type: 'turn/start', data: { turn: 4 }, time: 1 })
  queued.emit('r1', spliced(PROBE, 'next-turn'))
  queued.emit('r1', userMessage(PROBE))
  assert.equal(queued.steered.length, 0)
  assert.deepEqual(queued.rt.roomInbox.get('r1').map(item => item.text), [PROBE])
})
