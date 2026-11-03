// D1–D8: same-room completions project by completedAt. The session log stays put.
// No @deepseek-ai import.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SOURCE_KIND } from '../../vendor/ds-bot/src/host/constants.js'
import { install as installTurns } from '../../vendor/ds-bot/src/host/turns.js'
import { effectsOf } from '../../vendor/ds-bot/src/host/route-inbound.js'
import { createLine, indexOnly, install as installWorkLines, isBusy, noteTurnEnd } from '../../vendor/ds-bot/src/host/work-lines.js'
import {
  applyScroll,
  orderedCompletions,
  pinnedToBottom,
  projectRelay,
  quoteSentence,
  scrollAction,
  scrollGroup,
} from '../../vendor/ds-bot/src/shared/work-line-complete.js'

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const source = (path) => readFileSync(join(root, path), 'utf8')

const QUESTION_A = '先问秋天什么时候来'
const QUESTION_B = '再问海边的夜色'
const ANSWER_A = '秋天的答案'
const ANSWER_B = '海边的答案'
const FULL_QUOTE = '请把这一整句原样引用，不要用短标题'

function textsOf(rows) {
  return rows.map(row => row.text)
}

function clone(value) {
  return structuredClone(value)
}

test('D1 two completions in one room show the earlier finish first, each with its question', () => {
  const logs = {
    r1: [
      { seq: 1, who: 'User', text: QUESTION_A },
      { seq: 2, who: 'User', text: QUESTION_B },
    ],
  }
  const events = [
    { exchangeId: 'ex-b', workLineId: 'b', botId: 'chief', roomId: 'r1', completedAt: 20, quote: { roomId: 'r1', seq: 2 }, reply: ANSWER_B, label: '海' },
    { exchangeId: 'ex-a', workLineId: 'a', botId: 'chief', roomId: 'r1', completedAt: 10, quote: { roomId: 'r1', seq: 1 }, reply: ANSWER_A, label: '秋' },
  ]
  const replies = [
    { kind: 'working', botId: 'chief', workLineId: 'a' },
    { kind: 'working', botId: 'chief', workLineId: 'b' },
    { kind: 'user', text: '无关的后话' },
  ]
  const before = clone(replies)
  const logsBefore = clone(logs)
  const projected = projectRelay({ replies, completions: events, roomId: 'r1', logs })
  assert.deepEqual(textsOf(projected.replies), [QUESTION_A, ANSWER_A, QUESTION_B, ANSWER_B, '无关的后话'])
  assert.deepEqual(projected.completions.map(item => item.exchangeId), ['ex-a', 'ex-b'])
  assert.equal(projected.replies.some(row => row.kind === 'working'), false)
  assert.equal(projected.replies.some(row => row.text === '秋' || row.text === '海'), false)
  assert.deepEqual(replies, before)
  assert.deepEqual(logs, logsBefore)
})

test('D2 a finished line drops its working row and does not paint the draft beside the reply', () => {
  const logs = { r1: [{ seq: 1, who: 'User', text: '今天天气怎样' }] }
  const replies = [
    { kind: 'working', botId: 'chief', workLineId: 'a' },
    { botId: 'chief', text: '秋天来了', workLineId: 'a' },
  ]
  const draft = { botId: 'chief', text: '秋天来了', attemptId: 'try-1' }
  const completions = [{
    exchangeId: 'ex-a', workLineId: 'a', botId: 'chief', roomId: 'r1', completedAt: 10,
    quote: { roomId: 'r1', seq: 1 }, reply: '秋天来了',
  }]
  const projected = projectRelay({ replies, draft, completions, roomId: 'r1', logs })
  assert.equal(projected.replies.some(row => row.kind === 'working'), false)
  assert.equal(projected.draft, undefined)
  assert.equal(projected.replies.filter(row => row.text === '秋天来了').length, 1)
  assert.equal(projected.replies.find(row => row.text === '秋天来了').kind, undefined)
  assert.equal(projected.replies[0].text, '今天天气怎样')

  const onlyWorking = [{ kind: 'working', botId: 'chief', workLineId: 'a' }]
  const again = projectRelay({ replies: onlyWorking, draft, completions, roomId: 'r1', logs })
  assert.equal(again.replies.some(row => row.kind === 'working'), false)
  assert.equal(again.draft, undefined)
  assert.equal(again.replies.filter(row => row.text === '秋天来了').length, 1)
  assert.equal(again.replies.find(row => row.text === '秋天来了').kind, 'completion-reply')
})

test('D3 a pinned viewport stays on the first completion', () => {
  const snapshot = { scrollTop: 600, scrollHeight: 800, clientHeight: 200 }
  assert.equal(pinnedToBottom(snapshot), true)
  const action = scrollAction({ pinned: true, roomMatches: true })
  assert.equal(action, 'hold-first')
  const first = applyScroll({ action, scrollTop: 600, clientHeight: 200, firstOffset: 700, firstHeight: 60 })
  assert.equal(first.scrollTop, 600)
  assert.equal(first.lockedTop, 600)
  const later = applyScroll({
    action, scrollTop: 780, clientHeight: 200, firstOffset: 700, firstHeight: 60, lockedTop: first.lockedTop,
  })
  assert.equal(later.scrollTop, 600)
  assert.equal(later.lockedTop, 600)
  assert.ok(700 >= later.scrollTop && 700 < later.scrollTop + 200)

  const appended = applyScroll({ action, scrollTop: 600, clientHeight: 200, firstOffset: 800, firstHeight: 80 })
  assert.equal(appended.scrollTop, 680)
  assert.equal(appended.lockedTop, 680)
  const chased = applyScroll({
    action, scrollTop: 900, clientHeight: 200, firstOffset: 800, firstHeight: 80, lockedTop: appended.lockedTop,
  })
  assert.equal(chased.scrollTop, 680)
})

test('D4 a room the user scrolled up keeps scrollTop while order and placeholders still update', () => {
  const action = scrollAction({ pinned: false, roomMatches: true })
  assert.equal(action, 'leave')
  const applied = applyScroll({ action, scrollTop: 120, clientHeight: 200, firstOffset: 900, firstHeight: 40 })
  assert.equal(applied.scrollTop, 120)
  assert.equal(applied.lockedTop, null)
  const logs = {
    r1: [
      { seq: 1, who: 'User', text: QUESTION_A },
      { seq: 2, who: 'User', text: QUESTION_B },
    ],
  }
  const projected = projectRelay({
    replies: [
      { kind: 'working', botId: 'chief', workLineId: 'a' },
      { kind: 'working', botId: 'chief', workLineId: 'b' },
    ],
    draft: { botId: 'chief', text: ANSWER_B },
    completions: [
      { exchangeId: 'ex-b', workLineId: 'b', botId: 'chief', roomId: 'r1', completedAt: 20, quote: { roomId: 'r1', seq: 2 }, reply: ANSWER_B },
      { exchangeId: 'ex-a', workLineId: 'a', botId: 'chief', roomId: 'r1', completedAt: 10, quote: { roomId: 'r1', seq: 1 }, reply: ANSWER_A },
    ],
    roomId: 'r1',
    logs,
  })
  assert.deepEqual(textsOf(projected.replies), [QUESTION_A, ANSWER_A, QUESTION_B, ANSWER_B])
  assert.equal(projected.replies.some(row => row.kind === 'working'), false)
  assert.equal(projected.draft, undefined)
})

test('D5 one completion stays beside the messages around it', () => {
  const replies = [
    { kind: 'user', text: '先说的闲话' },
    { kind: 'working', botId: 'chief', workLineId: 'only' },
    { botId: 'writer', text: '无关的回复' },
    { botId: 'chief', text: '唯一的答案', exchangeId: 'ex-only' },
    { kind: 'user', text: '后来的闲话' },
  ]
  const before = clone(replies)
  const completions = [{
    exchangeId: 'ex-only', workLineId: 'only', botId: 'chief', roomId: 'r1', completedAt: 8,
    quote: { roomId: 'r1', seq: 1 }, reply: '唯一的答案',
  }]
  const projected = projectRelay({
    replies,
    completions,
    roomId: 'r1',
    logs: { r1: [{ seq: 1, who: 'User', text: '唯一的问题原句' }] },
  })
  assert.deepEqual(textsOf(projected.replies), ['先说的闲话', '无关的回复', '唯一的问题原句', '唯一的答案', '后来的闲话'])
  assert.equal(projected.replies.some(row => row.kind === 'working'), false)
  assert.equal(projected.replies.filter(row => row.kind === 'completion-reply').length, 0)
  const writerAt = projected.replies.findIndex(row => row.text === '无关的回复')
  const answerAt = projected.replies.findIndex(row => row.text === '唯一的答案')
  assert.ok(writerAt >= 0 && writerAt < answerAt)
  assert.equal(projected.replies[answerAt], replies[3])
  assert.equal(scrollGroup({ replies, completions: projected.completions }), false)
  assert.deepEqual(replies, before)
})

test('D6 a completion in another room does not move this room', () => {
  const replies = [
    { kind: 'user', text: '本房间' },
    { kind: 'working', botId: 'chief', workLineId: 'a' },
  ]
  const before = clone(replies)
  const projected = projectRelay({
    replies,
    completions: [{
      exchangeId: 'ex-x', workLineId: 'a', botId: 'chief', roomId: 'r2', completedAt: 3,
      quote: { roomId: 'r2', seq: 1 }, reply: '别处的回复',
    }],
    roomId: 'r1',
    logs: {
      r1: [{ seq: 1, text: '本房间' }],
      r2: [{ seq: 1, text: '另一间的问题' }],
    },
  })
  assert.deepEqual(projected.replies, replies)
  assert.equal(projected.completions.length, 0)
  assert.equal(replies[1].kind, 'working')
  assert.deepEqual(replies, before)
  const action = scrollAction({ pinned: true, roomMatches: false })
  assert.equal(action, 'leave')
  assert.equal(applyScroll({ action, scrollTop: 400, clientHeight: 200, firstOffset: 900, firstHeight: 40 }).scrollTop, 400)
})

test('D7 the same exchangeId projects once and the line stays idle', () => {
  const state = {
    bots: { chief: { id: 'chief', name: 'Chief' } },
    rooms: { r1: { id: 'r1', log: [{ seq: 1, who: 'User', text: '原句' }] } },
    workLines: {},
    workLineCompleted: {},
  }
  const line = createLine(state, {
    id: 'wl-a', botId: 'chief', sessionId: 'sess-a', roomId: 'r1',
    quote: { roomId: 'r1', seq: 1 }, label: '问', now: 1,
  })
  const sessionLog = [{ type: 'user/message', seq: 1, text: '原句' }]
  const sessionBefore = clone(sessionLog)
  const roomBefore = clone(state.rooms.r1.log)
  const first = noteTurnEnd(state, { sessionId: 'sess-a', exchangeId: 'ex-1', turn: 1, reason: { kind: 'completed' }, now: 2 })
  const second = noteTurnEnd(state, { sessionId: 'sess-a', exchangeId: 'ex-1', turn: 2, reason: { kind: 'completed' }, now: 4 })
  assert.equal(first.event.exchangeId, 'ex-1')
  assert.equal(first.event.reply, undefined)
  assert.equal(second.event, undefined)
  assert.equal(line.closedAt, undefined)
  assert.equal(isBusy(line, () => undefined), false)
  assert.equal(line.messages, undefined)
  assert.equal(indexOnly(line), true)
  assert.deepEqual(sessionLog, sessionBefore)
  assert.deepEqual(state.rooms.r1.log, roomBefore)

  const duplicated = projectRelay({
    replies: [{ kind: 'working', botId: 'chief', workLineId: 'wl-a' }],
    completions: [
      { exchangeId: 'ex-1', workLineId: 'wl-a', botId: 'chief', roomId: 'r1', completedAt: 2, quote: { roomId: 'r1', seq: 1 }, reply: '一次' },
      { exchangeId: 'ex-1', workLineId: 'wl-a', botId: 'chief', roomId: 'r1', completedAt: 9, quote: { roomId: 'r1', seq: 1 }, reply: '又一次' },
    ],
    roomId: 'r1',
    logs: { r1: state.rooms.r1.log },
  })
  assert.equal(duplicated.replies.filter(row => row.kind === 'completion-quote').length, 1)
  assert.equal(duplicated.replies.filter(row => row.kind === 'completion-reply').length, 1)
  assert.equal(duplicated.replies.find(row => row.kind === 'completion-reply').text, '一次')
  assert.deepEqual(state.rooms.r1.log, roomBefore)

  const hostState = {
    bots: { chief: { id: 'chief', name: 'Chief' } },
    rooms: { r1: { id: 'r1', log: [{ seq: 1, who: 'User', text: FULL_QUOTE }] } },
    workLines: {},
    workLineCompleted: {},
    questions: {},
    views: {},
    exchanges: [],
    exchangeTurns: {},
  }
  const hostLine = createLine(hostState, {
    id: 'wl-live', botId: 'chief', sessionId: 'sess-a', roomId: 'r1',
    quote: { roomId: 'r1', seq: 1 }, now: 1,
  })
  const hostRoomBefore = clone(hostState.rooms.r1.log)
  const handlers = []
  const rt = {
    ctx: { on: (type, fn) => { if (type === 'session/event') handlers.push(fn) } },
    state: hostState,
    warn() {},
    save: async () => {},
    dropKickoff() {},
    roomOf: (id) => hostState.rooms[id],
    botOf: (id) => hostState.bots[id],
    isBotSession: (id) => id === 'sess-a',
    groupOwners: new Map([['sess-a', { botId: 'chief', roomId: 'r1', workLineId: 'wl-live' }]]),
    chatOwners: new Map(),
    pastOwners: new Map(),
    selfOf: () => 'chief',
    switchJobs: () => [],
    roomWaiters: new Map(),
    lateRoomReply() {},
    takeRoomSteps: () => '',
    withRoomSteps: (_held, reply) => reply,
    noteFailure() {},
    deliver: async () => {},
    chatOf: () => undefined,
    partsOf: () => [],
  }
  installWorkLines(rt)
  installTurns(rt)
  const emit = (sessionId, event) => {
    for (const fn of handlers) fn({ id: sessionId }, event)
  }
  const roomTurn = (exchangeId) => ({
    type: 'user/message',
    data: {
      source: { kind: SOURCE_KIND, role: 'room', exchangeId, roomId: 'r1' },
      content: [{ type: 'text', text: 'your turn' }],
    },
  })
  const say = (text) => ({
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text }] } },
  })
  emit('sess-a', { type: 'turn/start', data: { turn: 1 }, time: 10 })
  emit('sess-a', roomTurn('ex-live'))
  emit('sess-a', say('秋天来了'))
  emit('sess-a', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, time: 12 })
  emit('sess-a', { type: 'turn/start', data: { turn: 2 }, time: 13 })
  emit('sess-a', roomTurn('ex-live'))
  emit('sess-a', say('秋天来了'))
  emit('sess-a', { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } }, time: 14 })
  assert.equal(rt.workCompletions.length, 1)
  assert.equal(rt.workCompletions[0].reply, '秋天来了')
  assert.equal(rt.workCompletions[0].roomId, 'r1')
  assert.equal(hostLine.reply, undefined)
  assert.equal(hostLine.messages, undefined)
  assert.equal(hostLine.closedAt, undefined)
  assert.equal(indexOnly(hostLine), true)
  assert.equal(isBusy(hostLine, (id) => rt.live.get(id)), false)
  assert.deepEqual(hostState.rooms.r1.log, hostRoomBefore)
  assert.equal(JSON.stringify(hostState.workLines).includes('秋天来了'), false)
  const viewed = rt.completionView()
  assert.equal(viewed.r1.length, 1)
  assert.equal(viewed.r1[0].quoteText, FULL_QUOTE)
  assert.equal(viewed.r1[0].replyText, '秋天来了')
  assert.equal(viewed.r1[0].label, undefined)
  const fromView = projectRelay({
    replies: [{ kind: 'working', botId: 'chief', workLineId: 'wl-live' }],
    completions: viewed.r1,
    roomId: 'r1',
  })
  assert.equal(fromView.replies.find(row => row.kind === 'completion-quote').text, FULL_QUOTE)
  assert.equal(fromView.replies.find(row => row.kind === 'completion-reply').text, '秋天来了')
  assert.equal(fromView.replies.some(row => row.kind === 'working'), false)
})

test('D8 the quote is the user sentence the line points at', () => {
  const logs = { r1: [{ seq: 4, who: 'User', text: FULL_QUOTE }] }
  assert.equal(quoteSentence({ roomId: 'r1', seq: 4 }, logs), FULL_QUOTE)
  const projected = projectRelay({
    replies: [{ kind: 'working', botId: 'chief', workLineId: 'q' }],
    completions: [{
      exchangeId: 'ex-q', workLineId: 'q', botId: 'chief', roomId: 'r1', completedAt: 5,
      quote: { roomId: 'r1', seq: 4 }, quoteText: '请把', reply: '好', label: '问',
    }],
    roomId: 'r1',
    logs,
  })
  assert.equal(projected.replies[0].text, FULL_QUOTE)
  assert.equal(projected.replies[0].kind, 'completion-quote')
  assert.equal(projected.completions[0].quoteText, FULL_QUOTE)
  assert.equal(projected.completions[0].label, undefined)
  assert.equal(projected.replies.some(row => row.text === '问' || row.text === '请把'), false)
  const ordered = orderedCompletions([{
    exchangeId: 'ex-q', workLineId: 'q', roomId: 'r1', completedAt: 5,
    quote: { roomId: 'r1', seq: 4 }, label: '问',
  }], { roomId: 'r1', logs })
  assert.equal(ordered[0].quoteText, FULL_QUOTE)
})

test('completion projection is display-only and leaves routing alone', () => {
  const cells = source('vendor/ds-bot/src/client/cells.js')
  const channel = source('vendor/ds-bot/src/host/channel.js')
  const turns = source('vendor/ds-bot/src/host/turns.js')
  const groups = source('vendor/ds-bot/src/host/groups.js')
  const route = source('vendor/ds-bot/src/host/route-inbound.js')
  const memory = source('vendor/ds-bot/src/host/memory.js')
  const complete = source('vendor/ds-bot/src/shared/work-line-complete.js')
  assert.match(cells, /projectRelay/)
  assert.match(cells, /scrollAction/)
  assert.match(cells, /scrollGroup/)
  assert.match(cells, /data-work-complete-first/)
  assert.match(cells, /data-conversation-scroll/)
  assert.match(channel, /completionView/)
  const callAt = turns.indexOf('rt.noteWorkTurnEnd?.(')
  const callEnd = turns.indexOf('})', callAt)
  assert.ok(callAt >= 0 && callEnd > callAt)
  assert.match(turns.slice(callAt, callEnd), /\breply\b/)
  assert.match(groups, /workLineId/)
  assert.doesNotMatch(groups, /workLines/)
  assert.doesNotMatch(route, /work-line-complete/)
  assert.match(route, /deliverAcrossRooms/)
  const localAt = route.indexOf('busy.length === 1 && local.length === 1')
  const remoteAt = route.indexOf('busy.length >= 2 || (busy.length === 1 && local.length === 0)')
  assert.ok(localAt >= 0 && remoteAt > localAt)
  assert.match(memory, /join\(root, 'team'\)/)
  assert.match(memory, /join\(root, 'bots', safeId\(scope\.botId\)\)/)
  assert.doesNotMatch(complete, /MEMORY\.md/)
  assert.doesNotMatch(complete, /writeFile/)
  assert.equal(effectsOf({ action: 'continue' }).writeLog, false)
  assert.equal(effectsOf({ action: 'continue' }).copyTranscript, false)
  assert.equal(effectsOf({ action: 'steer' }).writeLog, false)
  assert.equal(effectsOf({ action: 'steer' }).copyTranscript, false)
  const grouped = scrollGroup({
    replies: [
      { kind: 'working', botId: 'chief', workLineId: 'a' },
      { kind: 'working', botId: 'chief', workLineId: 'b' },
    ],
    completions: [{ exchangeId: 'ex-a', workLineId: 'a', botId: 'chief' }],
  })
  assert.equal(grouped, true)
})
