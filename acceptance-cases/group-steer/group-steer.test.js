// G1–G6: one busy member session in this room joins the current turn.
// Pure modules and a turns.js install fake only — no @deepseek-ai import.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SOURCE_KIND } from '../../vendor/ds-bot/src/host/constants.js'
import { install as installTurns } from '../../vendor/ds-bot/src/host/turns.js'
import {
  decideRoomSteer,
  groupUserBubble,
  isJoinedFollowUp,
  keepDraftOnSlotEnd,
  opensGroupRelay,
  roundForStream,
  steerTarget,
  stepRoute,
  takeSteeredLine,
} from '../../vendor/ds-bot/src/host/group-steer.js'
import { applyRoomStreamFrame, clearDraftIfPosted } from '../../vendor/ds-bot/src/shared/room-draft.js'
import { resolveSendMode } from '../../vendor/ds-bot/src/shared/send-mode.js'

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const source = (path) => readFileSync(join(root, path), 'utf8')

const PROBE = 'DEMO_STEER_OK'

function busyLive(turn = 1) {
  return { turn }
}

function members({ chief = busyLive(), writer = undefined } = {}) {
  return [
    { id: 'chief', name: 'Chief', sessionId: 'ga', live: chief },
    { id: 'writer', name: 'Writer', sessionId: 'gb', live: writer },
  ]
}

function host() {
  const handlers = []
  const steered = []
  const delivered = []
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
    deliver: async (payload) => { delivered.push(payload) },
    acceptRoomSteer: async (target, member, message) => { steered.push({ target, member, message }) },
    noteSteeredRoomLine() {},
    takeRelayIntent: () => false,
    allowRelayText() {},
  }
  installTurns(rt)
  const emit = (sessionId, event) => {
    for (const fn of handlers) fn({ id: sessionId }, event)
  }
  return { rt, emit, steered, delivered, room }
}

function userMessage(text, source = { kind: 'user' }) {
  return { type: 'user/message', data: { source, content: [{ type: 'text', text }] } }
}

test('G1 composer DEMO_STEER_OK while the only member is generating steers into that turn', () => {
  const decision = decideRoomSteer({ members: members(), explicitQueue: false, explicitNew: false, named: false, plain: true })
  assert.equal(decision.action, 'steer')
  assert.equal(decision.member.sessionId, 'ga')
  assert.equal(steerTarget({ memberLive: decision.member.live, explicitQueue: false }), 'steer')
  assert.equal(opensGroupRelay({ suppressed: true }), false)
  assert.equal(isJoinedFollowUp({ role: 'room', userSteer: true }), false)
  assert.deepEqual(takeSteeredLine([PROBE, 'later'], PROBE), { action: 'drop', lines: ['later'] })
  assert.equal(groupUserBubble({ kind: 'steering', text: PROBE }).steering, true)

  const { rt, emit, steered } = host()
  emit('ga', { type: 'turn/start', data: { turn: 4 }, time: 1 })
  emit('r1', userMessage(PROBE))
  assert.equal(steered.length, 1)
  assert.equal(steered[0].member.sessionId, 'ga')
  assert.equal(steered[0].message.text, PROBE)
  assert.equal(rt.roomInbox.get('r1'), undefined)
})

test('G1 does not schedule the steered interjection as a joined follow-up', () => {
  const { rt, emit, delivered } = host()
  emit('ga', { type: 'turn/start', data: { turn: 4 }, time: 1 })
  emit('ga', userMessage('the round prompt', { kind: SOURCE_KIND, role: 'room', exchangeId: 'e0', roomId: 'r1' }))
  emit('ga', userMessage(PROBE, { kind: SOURCE_KIND, role: 'room', userSteer: true, exchangeId: 'e1', roomId: 'r1' }))
  emit('ga', { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  assert.equal(delivered.some(item => item.exchangeId === 'e1' || item.deferred === true), false)
  assert.equal(rt.live.get('ga').turn, undefined)
})

test('G1 two busy members stay on relay (routing is a later PR)', () => {
  const decision = decideRoomSteer({
    members: members({ writer: busyLive(2) }),
    explicitQueue: false,
    plain: true,
  })
  assert.equal(decision.action, 'relay')
  assert.equal(decision.member, undefined)
  const { rt, emit, steered } = host()
  emit('ga', { type: 'turn/start', data: { turn: 1 }, time: 1 })
  emit('gb', { type: 'turn/start', data: { turn: 2 }, time: 1 })
  emit('r1', userMessage(PROBE))
  assert.equal(steered.length, 0)
  assert.equal(rt.roomInbox.get('r1')?.[0]?.text, PROBE)
})

test('G2 a working slot keeps the draft and does not open another relay', () => {
  const live = busyLive(9)
  assert.equal(decideRoomSteer({ members: members({ chief: live }) }).action, 'steer')
  const draft = { botId: 'chief', text: '秋', attemptId: 'a1' }
  assert.equal(keepDraftOnSlotEnd({ draft, memberLive: live }), draft)
  assert.equal(keepDraftOnSlotEnd({ draft, memberLive: { turn: undefined } }), undefined)
  const round = {
    speaking: null,
    draft,
    slots: [{ id: 'chief', status: 'working' }],
    replies: [],
  }
  const found = roundForStream({ rounds: [round], botId: 'chief', memberLive: live })
  assert.equal(found, round)
  const grown = applyRoomStreamFrame(found.draft, { type: 'chunk', attemptId: 'a1', chunk: { type: 'text-delta', text: '天' } }, { botId: 'chief' })
  assert.equal(grown.text, '秋天')
  assert.equal(stepRoute({ userSteered: true, calls: false, hasRound: true }), 'same')
  assert.equal(stepRoute({ userSteered: true, calls: false, hasRound: false }), 'same')
  assert.equal(opensGroupRelay({ suppressed: true }), false)
})

test('G3 explicit queue, explicit new, a named member, or a non-plain message relays', () => {
  const live = busyLive()
  assert.equal(steerTarget({ memberLive: live, explicitQueue: true }), 'relay')
  assert.equal(decideRoomSteer({ members: members(), explicitQueue: true }).action, 'relay')
  assert.equal(decideRoomSteer({ members: members(), explicitNew: true }).action, 'relay')
  assert.equal(decideRoomSteer({ members: members(), named: true }).action, 'relay')
  assert.equal(decideRoomSteer({ members: members(), plain: false }).action, 'relay')
  assert.equal(stepRoute({ userSteered: false, calls: false, hasRound: false }), 'post')
  const { rt, emit, steered } = host()
  emit('r1', userMessage(PROBE))
  assert.equal(steered.length, 0)
  assert.equal(rt.roomInbox.get('r1')?.[0]?.text, PROBE)
  emit('ga', { type: 'turn/start', data: { turn: 1 }, time: 1 })
  emit('r1', userMessage(PROBE, { kind: 'user', mode: 'queue' }))
  emit('r1', userMessage('@Writer look'))
  emit('r1', userMessage('fresh', { kind: 'user', mode: 'new' }))
  assert.equal(steered.length, 0)
  assert.deepEqual(rt.roomInbox.get('r1').map(item => item.text), [PROBE, PROBE, '@Writer look', 'fresh'])
})

test('G4 private busy steer stays on UserMessageCell and does not enter the group path', () => {
  assert.equal(resolveSendMode({ running: true }), 'steer')
  assert.equal(resolveSendMode({ requested: 'queue', running: true }), 'queue')
  const cell = source('vendor/ds-bot/src/client/user-message.js')
  assert.match(cell, /node\.kind === 'steering'/)
  const { emit, steered } = host()
  emit('priv', { type: 'turn/start', data: { turn: 3 }, time: 1 })
  emit('priv', userMessage(PROBE))
  assert.equal(steered.length, 0)
})

test('G5 group draft text-deltas stay one bubble and clear once the reply is posted', () => {
  let draft = applyRoomStreamFrame(undefined, { type: 'start', attemptId: 'a1' }, { botId: 'chief' })
  draft = applyRoomStreamFrame(draft, { type: 'chunk', attemptId: 'a1', chunk: { type: 'text-delta', text: '秋' } }, { botId: 'chief' })
  draft = applyRoomStreamFrame(draft, { type: 'chunk', attemptId: 'a1', chunk: { type: 'text-delta', text: '天' } }, { botId: 'chief' })
  assert.equal(draft.text, '秋天')
  assert.equal(clearDraftIfPosted(draft, []), draft)
  assert.equal(clearDraftIfPosted(draft, [{ kind: 'steering', text: PROBE }]), draft)
  assert.equal(clearDraftIfPosted(draft, [{ kind: 'user', text: '秋天' }]), draft)
  assert.equal(clearDraftIfPosted(draft, [{ botId: 'chief', text: '秋天' }]), undefined)
  assert.equal(groupUserBubble({ kind: 'user', text: 'hi' }).steering, false)
})

test('G6 channel.send and the composer both call steerTarget', () => {
  const list = members()
  const composer = decideRoomSteer({ members: list, explicitQueue: false, explicitNew: false, named: false, plain: true })
  const channel = decideRoomSteer({ members: list, explicitQueue: false, explicitNew: false, named: false, plain: true })
  assert.deepEqual(channel, composer)
  assert.equal(composer.action, steerTarget({ memberLive: list[0].live, explicitQueue: false }))
  const turns = source('vendor/ds-bot/src/host/turns.js')
  const channelSource = source('vendor/ds-bot/src/host/channel.js')
  const steer = source('vendor/ds-bot/src/host/group-steer.js')
  const groups = source('vendor/ds-bot/src/host/groups.js')
  const cells = source('vendor/ds-bot/src/client/cells.js')
  const delivery = source('vendor/ds-bot/src/host/delivery.js')
  assert.match(turns, /decideRoomSteer\(/)
  assert.match(channelSource, /decideRoomSteer\(/)
  assert.match(steer, /export function steerTarget/)
  assert.match(groups, /keepDraftOnSlotEnd/)
  assert.match(groups, /roundForStream/)
  assert.match(groups, /stepRoute/)
  assert.match(groups, /opensGroupRelay/)
  assert.match(groups, /takeSteeredLine/)
  assert.match(cells, /groupUserBubble/)
  assert.match(delivery, /userSteer/)
  assert.doesNotMatch(steer, /@deepseek-ai/)
})
