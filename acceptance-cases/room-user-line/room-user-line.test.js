// U1–U11 (first slice of #60): a user line already in the room log leaves the group
// Session's inbox and is never written a second time.
//
// Pure module, a real turns.js install with a fake host, and the real
// applyRouteDecision. No @deepseek-ai import, no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { install as installTurns } from '../../vendor/ds-bot/src/host/turns.js'
import { applyRouteDecision } from '../../vendor/ds-bot/src/host/route-inbound.js'
import {
  dropUserRows,
  isUserAbort,
  isUserLineLogged,
  loggedUserIds,
  userLineFor,
  userRowsToDrop,
} from '../../vendor/ds-bot/src/host/room-user-line.js'

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const source = path => readFileSync(join(root, path), 'utf8')

// The six user lines of the issue's room, in order.
const SIX = ['你们是谁', '先自我介绍一下', '今天把方案发我', '方案要中文', '预算写清楚', '明天上午再看']

const userRow = (id, text) => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })

// A Session inbox: two lists DSH keeps, and the `remove` it offers.
function sessionInbox({ nextStep = [], nextTurn = [] } = {}) {
  const inbox = { nextStep: [...nextStep], nextTurn: [...nextTurn], removed: [] }
  inbox.remove = (id) => {
    for (const list of ['nextStep', 'nextTurn']) {
      const index = inbox[list].findIndex(row => row?.id === id)
      if (index !== -1) {
        inbox[list].splice(index, 1)
        inbox.removed.push(id)
        return true
      }
    }
    return false
  }
  return inbox
}

const logged = (ids, texts) => ids.map((id, index) => ({ seq: index + 1, who: 'User', text: texts[index], inboxId: id }))

const tick = () => new Promise(resolve => setImmediate(resolve))

// A host for a real turns.js install: one room (r1) with two members, a fake agent
// whose inbox records what `remove` receives, and fakes for the routing seams.
function host({ log = [], rows = [] } = {}) {
  const handlers = []
  const steered = []
  const delivered = []
  const routed = []
  const applied = []
  const removed = []
  const room = {
    id: 'r1',
    name: 'Launch',
    members: ['chief', 'writer'],
    sessions: { chief: 'ga', writer: 'gb' },
    log: [...log],
    seq: log.at(-1)?.seq ?? 0,
  }
  const bots = { chief: { id: 'chief', name: 'Chief' }, writer: { id: 'writer', name: 'Writer' } }
  const inbox = sessionInbox({ nextStep: rows })
  const rt = {
    ctx: { on: (type, fn) => { if (type === 'session/event') handlers.push(fn) } },
    state: { questions: {}, views: {}, exchanges: [] },
    warn() {},
    save: async () => {},
    dropKickoff() {},
    roomOf: (id) => (id === 'r1' ? room : undefined),
    botOf: (id) => bots[id],
    isBotSession: (id) => id === 'ga' || id === 'gb',
    groupOwners: new Set(['ga', 'gb']),
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
    resolveAgent: async () => ({ inbox: { remove: (id) => { removed.push(id); return true } } }),
    // Nothing routes by default: legacy takes no effect and writes no line.
    routeRoomUser: (input) => { routed.push(input); return { action: 'legacy' } },
  }
  installTurns(rt)
  const emit = (sessionId, event) => {
    for (const fn of handlers) fn({ id: sessionId }, event)
  }
  return { rt, room, inbox, emit, steered, delivered, routed, applied, removed }
}

const spliced = (text, id = 'm1', target = 'next-step') => ({
  type: 'agent/inbox/spliced',
  time: 3250,
  data: {
    target,
    inserted: [{ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }],
  },
})

const userMessage = (text, id = 'm1') => ({
  type: 'user/message',
  data: { id, source: { kind: 'user' }, content: [{ type: 'text', text }] },
})

test('U1 userLineFor keeps the inbox id only for a real id', () => {
  assert.deepEqual(userLineFor('m1', '在吗'), { who: 'User', text: '在吗', inboxId: 'm1' })
  assert.deepEqual(userLineFor(undefined, '在吗'), { who: 'User', text: '在吗' })
  assert.deepEqual(userLineFor('', '在吗'), { who: 'User', text: '在吗' })
  assert.deepEqual(
    userLineFor('m1', '在吗', { files: [{ name: 'a.txt' }] }),
    { who: 'User', text: '在吗', files: [{ name: 'a.txt' }], inboxId: 'm1' },
  )
})

test('U2 loggedUserIds reads only user lines', () => {
  const log = [
    { seq: 1, who: 'User', text: '一', inboxId: 'm1' },
    { seq: 2, who: 'Chief', text: '在', botId: 'chief' },
    { seq: 3, who: 'DS Bot', kind: 'notice', text: '暂停了', inboxId: 'm2' },
    { seq: 4, who: 'User', text: '旧行没有 id' },
    { seq: 5, who: 'User', text: '二', inboxId: 'm3' },
  ]
  assert.deepEqual([...loggedUserIds(log)], ['m1', 'm3'])
  assert.equal(isUserLineLogged(log, 'm3'), true)
  // A notice row and a line written before ids existed are not matches.
  assert.equal(isUserLineLogged(log, 'm2'), false)
  assert.equal(isUserLineLogged(log, 'nope'), false)
  assert.equal(isUserLineLogged(log, undefined), false)
  assert.equal(loggedUserIds(undefined).size, 0)
})

test('U3 six pending rows the log already has are all dropped', () => {
  const ids = ['s1', 's2', 's3', 's4', 's5', 's6']
  const inbox = sessionInbox({ nextStep: ids.map((id, index) => userRow(id, SIX[index])) })
  const log = [...logged(ids, SIX), { seq: 7, who: 'Chief', text: '你们好，我在', botId: 'chief' }]
  assert.deepEqual(userRowsToDrop(inbox, log), ids)
})

test('U4 a composer row the log does not have stays', () => {
  const inbox = sessionInbox({ nextStep: [userRow('m9', '还没进日志的一句')] })
  const log = [{ seq: 1, who: 'User', text: '另一句', inboxId: 'm1' }]
  assert.deepEqual(userRowsToDrop(inbox, log), [])
  assert.equal(dropUserRows(inbox, []), 0)
  assert.equal(dropUserRows(inbox, userRowsToDrop(inbox, log)), 0)
  assert.deepEqual(inbox.nextStep.map(row => row.id), ['m9'])
})

test('U5 the same sentence typed twice drops only the logged one', () => {
  const inbox = sessionInbox({ nextStep: [userRow('m1', '再说一遍'), userRow('m2', '再说一遍')] })
  const log = [{ seq: 1, who: 'User', text: '再说一遍', inboxId: 'm2' }]
  assert.deepEqual(userRowsToDrop(inbox, log), ['m2'])
  assert.equal(dropUserRows(inbox, userRowsToDrop(inbox, log)), 1)
  assert.deepEqual(inbox.nextStep.map(row => row.id), ['m1'])
})

test('U6 dropUserRows removes exactly those rows and reports the count', () => {
  const inbox = sessionInbox({
    nextStep: [userRow('a', '一'), userRow('b', '二')],
    nextTurn: [userRow('c', '三'), userRow('d', '四')],
  })
  const log = [
    { seq: 1, who: 'User', text: '一', inboxId: 'a' },
    { seq: 2, who: 'User', text: '三', inboxId: 'c' },
    { seq: 3, who: 'User', text: '四', inboxId: 'd' },
  ]
  const ids = userRowsToDrop(inbox, log)
  // next-step first, then next-turn, each in inbox order.
  assert.deepEqual(ids, ['a', 'c', 'd'])
  assert.equal(dropUserRows(inbox, ids), 3)
  assert.deepEqual(inbox.nextStep.map(row => row.id), ['b'])
  assert.deepEqual(inbox.nextTurn, [])
  // An inbox without remove, or no ids, drops nothing and does not throw.
  assert.equal(dropUserRows({ nextStep: [] }, ['a']), 0)
  assert.equal(dropUserRows(undefined, ['a']), 0)
  assert.equal(dropUserRows(inbox, ['gone']), 0)
})

test('U7 a spliced line already in the room log leaves the session inbox', async () => {
  const h = host({ log: [{ seq: 1, who: 'User', text: '在吗', inboxId: 'm1' }] })
  h.emit('r1', spliced('在吗'))
  await tick()
  // Without the gate the row stays in the inbox and will be posted again.
  assert.deepEqual(h.removed, ['m1'])
  assert.equal(h.rt.roomInbox.get('r1'), undefined)
  assert.deepEqual(h.routed, [])
})

test('U8 a replayed user message already in the room log opens no round', async () => {
  const h = host({ log: [{ seq: 1, who: 'User', text: '把作文发过来', inboxId: 'm1' }] })
  h.emit('r1', spliced('把作文发过来'))
  h.emit('r1', userMessage('把作文发过来'))
  await tick()
  // Before the fix the replay queues the text and the relay writes a second line.
  assert.equal(h.rt.roomInbox.get('r1'), undefined)
  assert.deepEqual(h.steered, [])
  assert.deepEqual(h.delivered, [])
  assert.deepEqual(h.routed, [])
  assert.deepEqual(h.removed, ['m1', 'm1'])
})

test('U9 the route branch drops the inbox row only after the line is in the log', async () => {
  const h = host()
  h.rt.routeRoomUser = () => ({ action: 'steer', botId: 'chief', sessionId: 'ga' })
  h.rt.applyRouteDecision = async (room, decision, message) => {
    h.applied.push(message)
    room.seq += 1
    room.log = [...room.log, { seq: room.seq, who: 'User', text: message.text, inboxId: message.inboxId }]
    return decision
  }
  h.emit('r1', userMessage('在吗'))
  await tick()
  // The route got the row's id and wrote that line, so the row leaves the inbox.
  assert.equal(h.applied.length, 1)
  assert.equal(h.applied[0].inboxId, 'm1')
  assert.deepEqual(h.removed, ['m1'])

  // Hold takes effect but writes no line: the row must stay, or input is lost.
  const held = host()
  held.rt.routeRoomUser = () => ({ action: 'hold' })
  held.rt.applyRouteDecision = async (_room, decision, message) => {
    held.applied.push(message)
    return decision
  }
  held.emit('r1', userMessage('在吗'))
  await tick()
  assert.equal(held.applied.length, 1)
  assert.deepEqual(held.removed, [])
})

test('U10 the route path writes one line per inbox id', async () => {
  const room = { id: 'r1', seq: 0, log: [] }
  const rt = {
    state: {},
    warn() {},
    save: async () => {},
    appendRoomLine(_room, line) {
      room.seq += 1
      room.log = [...room.log, { ...line, seq: room.seq }]
    },
  }
  const decision = { action: 'queue', botId: 'chief', text: '在吗' }
  await applyRouteDecision(rt, room, decision, { text: '在吗', inboxId: 'm1' })
  assert.equal(room.log.length, 1)
  assert.equal(room.log[0].who, 'User')
  assert.equal(room.log[0].text, '在吗')
  assert.equal(room.log[0].inboxId, 'm1')

  // Same id, another sentence: the line it already is keeps its seq.
  await applyRouteDecision(rt, room, { ...decision, text: '另外一句' }, { text: '另外一句', inboxId: 'm1' })
  assert.equal(room.log.length, 1)
  assert.equal(room.log[0].text, '在吗')

  // The id still wins when the last row is a Bot line (the last-row text check cannot).
  room.seq += 1
  room.log = [...room.log, { seq: room.seq, who: 'Chief', text: '收到', botId: 'chief' }]
  await applyRouteDecision(rt, room, { ...decision, text: '第三条' }, { text: '第三条', inboxId: 'm1' })
  assert.equal(room.log.length, 2)
})

test('U11 the write sites and the admit gate carry the inbox id', () => {
  const groups = source('vendor/ds-bot/src/host/groups.js')
  const turns = source('vendor/ds-bot/src/host/turns.js')
  const router = source('vendor/ds-bot/src/host/route-inbound.js')
  const module = source('vendor/ds-bot/src/host/room-user-line.js')

  // The relay's user line, and the one write line every route goes through.
  assert.match(groups, /: userLineFor\(post\.inboxId, text, files\)\)/)
  const lineAt = groups.indexOf('rt.appendRoomLine')
  assert.ok(lineAt >= 0)
  assert.match(groups.slice(lineAt, lineAt + 600), /line\.inboxId/)
  // The drain hands the row it just removed to the route.
  const drainAt = groups.indexOf('function drainRoomInbox')
  assert.ok(drainAt >= 0)
  assert.match(groups.slice(drainAt, drainAt + 3000), /inboxId: line\.id/)

  // The queued post, the admit gate, and the route call all keep the message id.
  const admitAt = turns.indexOf('const admitRoomUser')
  assert.ok(admitAt >= 0)
  const admit = turns.slice(admitAt, admitAt + 4000)
  assert.match(admit, /\.\.\.inboxId \}/)
  assert.match(admit, /inboxId: data\.id/)
  assert.match(admit, /isUserLineLogged\(room\.log, data\.id\)/)

  // One line per inbox row, and the id reaches the line writer.
  assert.match(router, /function logInboundSentence\(rt, room, text, inboxId\)/)
  assert.match(router, /logInboundSentence\(rt, room, text, message\.inboxId\)/)

  // The module stays pure: no DSH import and no #59 halt flag.
  assert.doesNotMatch(module, /@deepseek-ai/)
  assert.doesNotMatch(module, /room-halt|haltDelivery|createRoomHalt/)
})
