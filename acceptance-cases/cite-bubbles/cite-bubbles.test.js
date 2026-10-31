// A late reply quotes the user's own sentences once, including a follow-up
// that was steered into the same turn. No @deepseek-ai import.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SOURCE_KIND } from '../../vendor/ds-bot/src/host/constants.js'
import { install as installTurns } from '../../vendor/ds-bot/src/host/turns.js'
import { applyRouteDecision } from '../../vendor/ds-bot/src/host/route-inbound.js'
import { createLine, indexOnly, noteTurnEnd } from '../../vendor/ds-bot/src/host/work-lines.js'
import { isJoinedFollowUp } from '../../vendor/ds-bot/src/host/group-steer.js'
import { lateCite, projectRelay } from '../../vendor/ds-bot/src/shared/work-line-complete.js'
import {
  appendCite,
  applyLogPointer,
  citeForPost,
  citeTexts,
  citedFromLog,
  hideCitedHistory,
  isPendingSteerCopy,
  logPointer,
  logQuotes,
  markSteeredRow,
  steerSentence,
} from '../../vendor/ds-bot/src/shared/cite.js'

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const source = (path) => readFileSync(join(root, path), 'utf8')

const FIRST = '你们是谁'
const FOLLOW = '在干嘛'

function host() {
  const handlers = []
  const delivered = []
  const rt = {
    ctx: { on: (type, fn) => { if (type === 'session/event') handlers.push(fn) } },
    state: { questions: {}, views: {}, exchanges: [] },
    warn() {},
    save: async () => {},
    dropKickoff() {},
    roomOf: () => undefined,
    botOf: () => undefined,
    isBotSession: (id) => id === 'ga',
    groupOwners: new Set(['ga']),
    chatOwners: new Map(),
    selfOf: (id) => id,
    switchJobs: () => [],
    roomWaiters: new Map(),
    lateRoomReply() {},
    takeRoomSteps: () => '',
    withRoomSteps: (_held, reply) => reply,
    noteFailure() {},
    deliver: async (payload) => { delivered.push(payload) },
  }
  installTurns(rt)
  const cited = []
  rt.lateRoomReply = (_sessionId, info) => { cited.push(info) }
  const emit = (sessionId, event) => {
    for (const fn of handlers) fn({ id: sessionId }, event)
  }
  return { rt, emit, delivered, cited }
}

function roomSource(text, extra) {
  return {
    kind: SOURCE_KIND,
    role: 'room',
    roomId: 'room',
    quoteText: text,
    quoteRoomId: 'room',
    ...extra,
  }
}

function userMessage(text, extra) {
  return {
    type: 'user/message',
    data: {
      source: roomSource(text, extra),
      content: [{ type: 'text', text: `[Group chat "You" · the user said]\n${text}` }],
    },
  }
}

test('one quoted sentence keeps the flat cite', () => {
  assert.deepEqual(lateCite({}), {})
  assert.deepEqual(lateCite({ quoteText: FIRST, quoteSeq: 2, quoteRoomId: 'room' }), {
    quoteText: FIRST,
    quoteSeq: 2,
    quoteRoomId: 'room',
  })
  assert.equal(Object.hasOwn(lateCite({ quoteText: FIRST, quoteSeq: 2, quoteRoomId: 'room' }), 'quotes'), false)
  assert.deepEqual(citeTexts({ quoteText: FIRST, late: true }), [FIRST])
})

test('two quotes keep the first sentence flat and list both in order', () => {
  const cite = lateCite({
    quoteText: FIRST,
    quoteSeq: 2,
    quoteRoomId: 'room',
    quotes: [
      { text: FIRST, seq: 2, roomId: 'room' },
      { text: FOLLOW, seq: 3, roomId: 'room' },
      { text: FOLLOW, seq: 3, roomId: 'room' },
    ],
  })
  assert.equal(cite.quoteText, FIRST)
  assert.equal(cite.quoteSeq, 2)
  assert.deepEqual(cite.quotes.map(item => item.text), [FIRST, FOLLOW])
  assert.equal(cite.quotes[1].seq, 3)
  assert.deepEqual(citeTexts(cite), [FIRST, FOLLOW])
  assert.deepEqual(logQuotes(cite, 'room'), [
    { roomId: 'room', seq: 2 },
    { roomId: 'room', seq: 3 },
  ])
})

test('a bot row that quotes two user seqs names those sentences and their message ids', () => {
  const log = [
    { seq: 2, who: 'User', text: FIRST, messageId: 'm1' },
    { seq: 3, who: 'User', text: FOLLOW, messageId: 'm2' },
    {
      seq: 4,
      who: 'Chief',
      botId: 'chief',
      text: '我是 Chief',
      quote: { roomId: 'room', seq: 2 },
      quotes: [{ roomId: 'room', seq: 2 }, { roomId: 'room', seq: 3 }],
    },
  ]
  assert.deepEqual(citedFromLog(log, 'room'), { texts: [FIRST, FOLLOW], ids: ['m1', 'm2'] })
  assert.deepEqual(citedFromLog(log, 'other'), { texts: [], ids: [] })
  assert.equal(citedFromLog(log).texts.includes('我是 Chief'), false)
  assert.deepEqual(citedFromLog([{ seq: 2, who: 'User', text: FIRST }]), { texts: [], ids: [] })
})

test('a cited send is hidden, and a later send of the same words stays', () => {
  const cited = { citedTexts: [FIRST, FOLLOW], citedIds: ['m1', 'm2'] }
  assert.equal(hideCitedHistory({ text: FIRST, messageId: 'm1', ...cited }), true)
  assert.equal(hideCitedHistory({ text: FIRST, messageId: 'm9', ...cited }), false)
  assert.equal(hideCitedHistory({ text: FIRST, citedTexts: [FIRST], citedIds: [] }), true)
  assert.equal(hideCitedHistory({ text: '还没被引用', messageId: 'm3', ...cited }), false)
})

test('the user log row records the send id when the route saw one', async () => {
  const room = { id: 'room', log: [], seq: 0 }
  await applyRouteDecision({}, room, { action: 'steer', botId: 'chief', text: FIRST }, { id: 'm1', text: FIRST })
  assert.deepEqual(room.log.at(-1), { who: 'User', text: FIRST, seq: 1, messageId: 'm1' })
  const plain = { id: 'room', log: [], seq: 0 }
  await applyRouteDecision({}, plain, { action: 'steer', botId: 'chief', text: FOLLOW }, { text: FOLLOW })
  assert.equal(plain.log.at(-1).messageId, undefined)
  assert.equal(plain.log.at(-1).text, FOLLOW)
})

test('a steered follow-up is cited with the opening sentence and does not open another reply', () => {
  assert.equal(isJoinedFollowUp({ role: 'room', userSteer: true }), false)
  const { emit, delivered, cited } = host()
  emit('ga', { type: 'turn/start', data: { turn: 4 }, time: 1 })
  emit('ga', userMessage(FIRST, { exchangeId: 'e1', quoteSeq: 2 }))
  emit('ga', userMessage(FOLLOW, { exchangeId: 'e2', quoteSeq: 3, userSteer: true }))
  emit('ga', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '我是 Chief' }] } } })
  emit('ga', { type: 'turn/end', data: { reason: { kind: 'completed' } }, time: 5 })
  assert.equal(cited.length, 1)
  const cite = lateCite(cited[0])
  assert.deepEqual(citeTexts(cite), [FIRST, FOLLOW])
  assert.equal(cite.quoteText, FIRST)
  assert.equal(cite.quotes[1].seq, 3)
  assert.equal(delivered.some(item => item.deferred === true || item.exchangeId === 'e2'), false)
})

test('a next-step splice of the follow-up is the same cite, once', () => {
  const { emit, delivered, cited } = host()
  emit('ga', { type: 'turn/start', data: { turn: 4 }, time: 1 })
  emit('ga', userMessage(FIRST, { exchangeId: 'e1', quoteSeq: 2 }))
  emit('ga', {
    type: 'agent/inbox/spliced',
    time: 2,
    data: {
      target: 'next-step',
      inserted: [{
        id: 'm2',
        source: roomSource(FOLLOW, { exchangeId: 'e2', quoteSeq: 3, userSteer: true }),
        content: [{ type: 'text', text: FOLLOW }],
      }],
    },
  })
  emit('ga', userMessage(FOLLOW, { exchangeId: 'e2', quoteSeq: 3, userSteer: true }))
  emit('ga', { type: 'turn/end', data: { reason: { kind: 'completed' } }, time: 5 })
  assert.deepEqual(citeTexts(lateCite(cited[0])), [FIRST, FOLLOW])
  assert.equal(delivered.some(item => item.exchangeId === 'e2'), false)
})

test('a follow-up that is not steered stays out of this reply cite', () => {
  const { emit, delivered, cited } = host()
  emit('ga', { type: 'turn/start', data: { turn: 4 }, time: 1 })
  emit('ga', userMessage(FIRST, { exchangeId: 'e1', quoteSeq: 2 }))
  emit('ga', userMessage('另一句', { exchangeId: 'e3', quoteSeq: 9 }))
  emit('ga', { type: 'turn/end', data: { reason: { kind: 'completed' } }, time: 5 })
  assert.equal(Object.hasOwn(lateCite(cited[0]), 'quotes'), false)
  assert.equal(lateCite(cited[0]).quoteText, FIRST)
  assert.equal(delivered.some(item => item.exchangeId === 'e3' && item.deferred === true), true)
})

test('a completion lists both sentences and does not store them on the work line', () => {
  const state = {
    bots: {},
    rooms: { room: { id: 'room', log: [{ seq: 2, who: 'User', text: FIRST }] } },
    workLines: {},
    workLineCompleted: {},
  }
  const line = createLine(state, {
    id: 'wl', botId: 'chief', sessionId: 'ga', roomId: 'room',
    quote: { roomId: 'room', seq: 2 }, now: 1,
  })
  const ended = noteTurnEnd(state, {
    sessionId: 'ga',
    exchangeId: 'e1',
    turn: 4,
    reason: { kind: 'completed' },
    now: 5,
    quotes: [
      { text: FIRST, seq: 2, roomId: 'room' },
      { text: FOLLOW, seq: 3, roomId: 'room' },
    ],
  })
  assert.equal(line.quotes, undefined)
  assert.equal(indexOnly(line), true)
  assert.equal(JSON.stringify(state.workLines).includes(FOLLOW), false)
  assert.equal(ended.event.quoteText, FIRST)
  assert.deepEqual(ended.event.quotes.map(item => item.text), [FIRST, FOLLOW])
  const logs = { room: state.rooms.room.log }
  const projected = projectRelay({
    replies: [{ kind: 'working', botId: 'chief', workLineId: 'wl' }],
    completions: [{ ...ended.event, botId: 'chief', roomId: 'room', reply: '我是 Chief' }],
    roomId: 'room',
    logs,
  })
  assert.deepEqual(
    projected.replies.filter(row => row.kind === 'completion-quote').map(row => row.text),
    [FIRST, FOLLOW],
  )
  assert.deepEqual(
    projected.replies.filter(row => row.kind === 'completion-reply').map(row => row.text),
    ['我是 Chief'],
  )
  const alone = projectRelay({
    replies: [{ kind: 'working', botId: 'chief', workLineId: 'wl' }],
    completions: [{
      exchangeId: 'e1', workLineId: 'wl', botId: 'chief', roomId: 'room', completedAt: 5,
      quote: { roomId: 'room', seq: 2 }, reply: '我是 Chief',
    }],
    roomId: 'room',
    logs,
  })
  assert.equal(Object.hasOwn(alone.completions[0], 'quotes'), false)
  assert.deepEqual(alone.replies.filter(row => row.kind === 'completion-quote').map(row => row.text), [FIRST])
})

test('an in-round reply points at both steered sentences so each history bubble hides', () => {
  const HI = 'hi'
  const WHO = '你们是谁'
  const hiId = 'c14b3022-a326-45ab-a79e-70841f4dba42'
  const whoId = 'a444b74d-c4c0-4395-832f-8369c3468df7'
  const room = {
    id: 'room',
    log: [
      { seq: 1, who: 'User', text: HI, messageId: hiId },
      { seq: 2, who: 'User', text: WHO, messageId: whoId },
    ],
  }
  const hi = steerSentence(room, { text: HI, quoteText: HI, quoteSeq: 1, quoteRoomId: 'room' })
  const who = steerSentence(room, { text: WHO, quoteSeq: 2 })
  assert.equal(who.seq, 2)
  assert.equal(who.roomId, 'room')
  const steerCites = appendCite(appendCite([], hi), who)
  const named = citeForPost({}, steerCites)
  assert.equal(named.quoteText, HI)
  assert.equal(named.quoteSeq, 1)
  assert.equal(Object.hasOwn(named, 'late'), false)
  assert.deepEqual(citeTexts(named), [HI, WHO])
  const log = [
    ...room.log,
    { seq: 3, who: 'Chief', botId: 'chief', text: '你好', ...logPointer(named, 'room') },
    { seq: 4, who: 'Chief', botId: 'chief', text: '介绍' },
  ]
  // The first member line is enough. A later line does not have to repeat it.
  const cited = citedFromLog(log, 'room')
  assert.deepEqual(cited.texts, [HI, WHO])
  assert.deepEqual(cited.ids, [hiId, whoId])
  assert.equal(hideCitedHistory({ text: HI, messageId: hiId, citedTexts: cited.texts, citedIds: cited.ids }), true)
  assert.equal(hideCitedHistory({ text: WHO, messageId: whoId, citedTexts: cited.texts, citedIds: cited.ids }), true)
  assert.equal(hideCitedHistory({ text: HI, messageId: 'later-send', citedTexts: cited.texts, citedIds: cited.ids }), false)
  // One sentence stays the flat pointer.
  const alone = citeForPost({}, [hi])
  assert.equal(Object.hasOwn(alone, 'quotes'), false)
  assert.deepEqual(logPointer(alone, 'room'), { quote: { roomId: 'room', seq: 1 } })
  // A line posted after the first steer picks up the follow-up when it arrives.
  const partial = [
    { seq: 1, who: 'User', text: HI, messageId: hiId },
    { seq: 2, who: 'Chief', botId: 'chief', text: '你好', ...logPointer(citeForPost({}, [hi]), 'room') },
    { seq: 3, who: 'User', text: WHO, messageId: whoId },
  ]
  const partialNamed = citeForPost({}, appendCite([hi], { text: WHO, seq: 3, roomId: 'room' }))
  assert.equal(applyLogPointer(partial, logPointer(partialNamed, 'room'), { minSeq: 1 }), 1)
  assert.deepEqual(citedFromLog(partial, 'room').ids, [hiId, whoId])
  const older = [{ seq: 1, who: 'Chief', botId: 'chief', text: '旧的' }]
  assert.equal(applyLogPointer(older, logPointer(alone, 'room'), { minSeq: 4 }), -1)
  assert.equal(older[0].quote, undefined)
  // The busy follow-up cite still wins when the turn already has one.
  const late = citeForPost({
    quoteText: FIRST,
    quoteSeq: 2,
    quoteRoomId: 'room',
    quotes: [
      { text: FIRST, seq: 2, roomId: 'room' },
      { text: FOLLOW, seq: 3, roomId: 'room' },
    ],
  }, steerCites)
  assert.deepEqual(citeTexts(late), [FIRST, FOLLOW])
})

test('an opening relay still running shows hi and 你们是谁 once each before anyone posts', () => {
  const HI = 'hi'
  const WHO = '你们是谁'
  const hiId = 'bd93af0a-e491-4566-8bae-c72afc96f41d'
  const whoId = 'd9d1524b-d566-4abc-9593-041f873387c9'
  // Room log from the 21:14 accept: both user rows, no Chief line (still typing, then TIMEOUT).
  const log = [
    { seq: 1, who: 'User', text: HI, messageId: hiId },
    { seq: 2, who: 'User', text: WHO, messageId: whoId },
  ]
  assert.deepEqual(citedFromLog(log, 'room'), { texts: [], ids: [] })
  const hi = markSteeredRow(log, { seq: 1, messageId: hiId, text: HI })
  const who = markSteeredRow(log, { seq: 2, messageId: whoId, text: WHO })
  assert.equal(hi.changed, true)
  assert.equal(hi.messageId, hiId)
  assert.equal(who.changed, true)
  assert.equal(who.messageId, whoId)
  assert.equal(log[0].steered, true)
  assert.equal(log[1].steered, true)
  assert.equal(markSteeredRow(log, { seq: 1, messageId: hiId, text: HI }).changed, false)
  const cited = citedFromLog(log, 'room')
  assert.deepEqual(cited, { texts: [HI, WHO], ids: [hiId, whoId] })
  assert.equal(hideCitedHistory({ text: HI, messageId: hiId, citedTexts: cited.texts, citedIds: cited.ids }), true)
  assert.equal(hideCitedHistory({ text: WHO, messageId: whoId, citedTexts: cited.texts, citedIds: cited.ids }), true)
  // A later send of the same words, with its own id, stays.
  assert.equal(hideCitedHistory({ text: HI, messageId: 'later-hi', citedTexts: cited.texts, citedIds: cited.ids }), false)
  const bare = [{ seq: 1, who: 'User', text: HI }]
  const filled = markSteeredRow(bare, { seq: 1, messageId: hiId, text: HI })
  assert.equal(filled.changed, true)
  assert.equal(bare[0].messageId, hiId)
  assert.deepEqual(citedFromLog(bare).ids, [hiId])
  assert.deepEqual(markSteeredRow([], { messageId: hiId, text: HI }), { changed: false, messageId: hiId })
  const botOnly = [{ seq: 1, who: 'Chief', botId: 'chief', text: HI }]
  assert.equal(markSteeredRow(botOnly, { seq: 1, messageId: hiId, text: HI }).changed, false)
  assert.equal(botOnly[0].steered, undefined)
  const repeated = [
    { seq: 1, who: 'User', text: HI, messageId: 'old' },
    { seq: 3, who: 'User', text: HI, messageId: 'new' },
  ]
  assert.equal(markSteeredRow(repeated, { text: HI }).messageId, 'new')
  assert.equal(repeated[0].steered, undefined)
  assert.equal(repeated[1].steered, true)
  assert.equal(isPendingSteerCopy('hi', [HI, WHO]), true)
  assert.equal(isPendingSteerCopy('hi\u00a0未读', [HI, WHO]), true)
  assert.equal(isPendingSteerCopy('你们是谁\n未读', [HI, WHO]), true)
  assert.equal(isPendingSteerCopy('hi\n21:14', [HI, WHO]), true)
  assert.equal(isPendingSteerCopy('Not read yet', [HI, WHO]), false)
  assert.equal(isPendingSteerCopy('在干嘛', [HI, WHO]), false)
  assert.equal(isPendingSteerCopy('hi', []), false)

  const groups = source('vendor/ds-bot/src/host/groups.js')
  const showAt = groups.indexOf('const showSteer = ')
  const showEnd = groups.indexOf('const running = [...rt.roomProgress.values()]', showAt)
  assert.ok(showAt >= 0 && showEnd > showAt)
  const show = groups.slice(showAt, showEnd)
  assert.ok(show.indexOf('replies.push(reply)') < show.indexOf('markSteeredRow'))
  assert.ok(show.indexOf('markSteeredRow') < show.indexOf('dropSteeredInbox'))
  assert.match(groups, /inbox\?\.remove\?\.\(messageId\)/)
  const router = source('vendor/ds-bot/src/host/route-inbound.js')
  const steerCase = router.slice(router.indexOf("case 'steer': {"), router.indexOf("case 'continue':", router.indexOf("case 'steer': {")))
  assert.match(steerCase, /acceptRoomSteer\(room, member, \{ text, files, \.\.\.cite, \.\.\.\(messageId/)
  const turns = source('vendor/ds-bot/src/host/turns.js')
  assert.match(turns, /acceptRoomSteer\(room, decision\.member, \{ text, files, \.\.\.\(messageId/)
  const cells = source('vendor/ds-bot/src/client/cells.js')
  assert.match(cells, /useLayoutEffect\(\(\) => hidePendingSteerCopies/)
  assert.match(cells, /data-steer-copy/)
  assert.match(cells, /isPendingSteerCopy/)
  const styles = source('vendor/ds-bot/src/client/styles.js')
  assert.match(styles, /\[data-pending-steering\]\[data-steer-copy\]\{display:none!important\}/)
  assert.match(styles, /_flowItem"\]:has\(\[data-pending-steering\]\[data-steer-copy\]\)/)
})

test('the late cite paints user bubbles and history hides a sentence that cite already shows', () => {
  const cells = source('vendor/ds-bot/src/client/cells.js')
  const user = source('vendor/ds-bot/src/client/user-message.js')
  const router = source('vendor/ds-bot/src/host/route-inbound.js')
  const lateAt = cells.indexOf('function LateCite')
  const lateEnd = cells.indexOf('function GroupEvent', lateAt)
  assert.ok(lateAt >= 0 && lateEnd > lateAt)
  const late = cells.slice(lateAt, lateEnd)
  assert.match(late, /data-late-cite/)
  assert.match(late, /Replying to what you wrote earlier/)
  assert.match(late, /bt-ububble/)
  assert.match(late, /bt-urow/)
  assert.doesNotMatch(late, /bt-route-cite-text/)
  assert.match(user, /hideCitedHistory/)
  assert.doesNotMatch(router, /work-line-complete/)
  const quoteAt = cells.indexOf("reply.kind === 'completion-quote'")
  const quoteEnd = cells.indexOf("reply.kind === 'completion-reply'", quoteAt)
  assert.match(cells.slice(quoteAt, quoteEnd), /reply\.who === 'User' \? 'bt-urow'/)
  const bubbleAt = cells.indexOf('const userBubble = groupUserBubble(reply)')
  const bubbleEnd = cells.indexOf("if (reply.kind === 'failed')", bubbleAt)
  assert.ok(bubbleAt >= 0 && bubbleEnd > bubbleAt)
  assert.match(cells.slice(bubbleAt, bubbleEnd), /userBubble\.steering && coveredByLateCite/)
  const groups = source('vendor/ds-bot/src/host/groups.js')
  const postAt = groups.indexOf('const postInRound = ')
  const postEnd = groups.indexOf('async function roomTurn', postAt)
  assert.ok(postAt >= 0 && postEnd > postAt)
  const post = groups.slice(postAt, postEnd)
  assert.match(post, /citeForPost\(cite, round\?\.steerCites\)/)
  assert.match(post, /explicit \? named/)
  const steerAt = groups.indexOf('async function acceptRoomSteer')
  const steerEnd = groups.indexOf('rt.appendRoomLine', steerAt)
  assert.match(groups.slice(steerAt, steerEnd), /steerCites/)
  assert.match(groups.slice(steerAt, steerEnd), /steerSentence/)
  assert.match(groups.slice(steerAt, steerEnd), /quoteText/)
})
