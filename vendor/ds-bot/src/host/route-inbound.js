// Which work line an inbound room message belongs to.
// One decision for the composer, drainRoomInbox, and channel.send.
// Bigrams are copied here so a title match from another module cannot decide.
import { randomUUID } from 'node:crypto'
import { mentionSpans } from '../shared/mentions.js'
import { roomMembers } from './group-steer.js'
import { implicitLine, isBusy, listByBot, noteLineRoom, projectExchange } from './work-lines.js'

const HIT = 0.45
const MISS = 0.15

/** @typedef {'steer' | 'continue' | 'create' | 'ask' | 'queue' | 'hold' | 'legacy'} RouteAction */

function tokens(text) {
  const lowered = String(text ?? '').toLowerCase()
  const words = lowered.match(/[a-z0-9_]{2,}/g) ?? []
  const han = lowered.match(/[\u4e00-\u9fa5]/g) ?? []
  const grams = []
  for (let index = 0; index + 1 < han.length; index += 1) grams.push(han[index] + han[index + 1])
  return new Set([...words, ...grams])
}

function overlap(left, right) {
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const token of left) if (right.has(token)) shared += 1
  return shared / Math.min(left.size, right.size)
}

/** @param {number} score @returns {'hit' | 'miss' | 'unsure'} */
function band(score) {
  if (score >= HIT) return 'hit'
  if (score <= MISS) return 'miss'
  return 'unsure'
}

/**
 * @param {string} text
 * @returns {{ kind: 'new' } | { kind: 'name', label: string } | { kind: 'auto' }}
 */
export function explicitIntent(text) {
  const trimmed = String(text ?? '').trim()
  if (/^(?:新开|\/new\b)/i.test(trimmed)) return { kind: 'new' }
  const named = /^(?:续[:：])\s*(\S(?:.*\S)?)\s*$/.exec(trimmed)
  if (named?.[1]) return { kind: 'name', label: named[1].trim() }
  return { kind: 'auto' }
}

/** @param {string} text @param {{ id?: string, name?: string }[]} [members] */
export function addressedBot(text, members = []) {
  const spans = mentionSpans(String(text ?? ''), members)
  if (spans.some(span => span.all === true)) return { kind: 'all' }
  /** @type {string[]} */
  const ids = []
  /** @type {{ id?: string, name?: string }[]} */
  const bots = []
  for (const span of spans) {
    if (span.bot?.id == null || ids.includes(span.bot.id)) continue
    ids.push(span.bot.id)
    bots.push(span.bot)
  }
  if (ids.length > 1) return { kind: 'many' }
  if (ids.length === 1) return { kind: 'one', bot: bots[0] }
  return { kind: 'none' }
}

function lineText(line) {
  if (typeof line?.doc === 'string') return line.doc
  const opening = typeof line?.opening === 'string' ? line.opening : ''
  const extra = line?.busy === true
    ? (line?.draft ?? line?.recent ?? '')
    : (line?.recent ?? '')
  return [opening, extra].filter(part => part !== '').join('\n')
}

function score(text, line) {
  return overlap(tokens(text), tokens(lineText(line)))
}

function newest(lines) {
  /** @type {any} */
  let best
  for (const line of lines) {
    if (best === undefined || (line?.updatedAt ?? 0) > (best.updatedAt ?? 0)) best = line
  }
  return best
}

function createDecision(botId) {
  return { action: 'create', steer: false, botId, crossRoom: false }
}

function lineChoice(line, roomId) {
  const action = line?.busy === true ? 'steer' : 'continue'
  const lastRoomId = line?.lastRoomId
  return {
    action,
    steer: action === 'steer',
    workLineId: line?.id,
    sessionId: line?.sessionId,
    botId: line?.botId,
    lastRoomId,
    label: line?.label,
    updatedAt: line?.updatedAt ?? 0,
    crossRoom: typeof lastRoomId === 'string' && lastRoomId !== roomId,
  }
}

function ask(lines) {
  const open = lines.filter(line => line?.closedAt == null)
  const pool = open.length > 0 ? open : lines
  const busy = pool.filter(line => line?.busy === true)
  const highlight = newest(busy.length > 0 ? busy : pool)
  return {
    action: 'ask',
    steer: false,
    highlight: highlight?.id,
    updatedAt: highlight?.updatedAt ?? 0,
    crossRoom: false,
    choices: pool.map(line => ({
      id: line.id,
      label: line.label,
      busy: line.busy === true,
      lastRoomId: line.lastRoomId,
      sessionId: line.sessionId,
      updatedAt: line.updatedAt ?? 0,
      botId: line.botId,
    })),
  }
}

function findNamed(lines, label) {
  const byId = lines.filter(line => line.id === label)
  if (byId.length === 1) return byId[0]
  const byLabel = lines.filter(line => line.label === label)
  if (byLabel.length === 1) return byLabel[0]
  return undefined
}

function finish(decision, queued) {
  if (queued !== true) return decision
  let sessionId = decision.sessionId
  let workLineId = decision.workLineId
  if (sessionId == null && decision.highlight != null) {
    const choice = (decision.choices ?? []).find(item => item.id === decision.highlight)
    if (choice?.sessionId != null) {
      sessionId = choice.sessionId
      workLineId = choice.id ?? workLineId
    }
  }
  return {
    ...decision,
    action: 'queue',
    steer: false,
    sessionId,
    workLineId,
    relay: sessionId == null,
  }
}

function legacyDecision(botId) {
  return { action: 'legacy', steer: false, botId }
}

function scored(text, lines) {
  return {
    hits: lines.filter(line => band(score(text, line)) === 'hit'),
    unsures: lines.filter(line => band(score(text, line)) === 'unsure'),
  }
}

// Lines in this room decide an ask or a new task. Lines in other rooms do not.
// Several of them matching the same sentence is how a new group's opening was
// pulled onto a card and never became a user bubble. A single strong match in
// another room still continues that line. No local task and no such match
// stays on the group relay.
function matchIdle(text, idle, roomId, botId) {
  const here = idle.filter(line => line.lastRoomId === roomId)
  const away = idle.filter(line => line.lastRoomId !== roomId)
  const local = scored(text, here)
  const remote = scored(text, away)
  if (local.hits.length === 1 && local.unsures.length === 0) return lineChoice(local.hits[0], roomId)
  if (local.hits.length > 1 || local.unsures.length > 0) return ask(here)
  if (remote.hits.length === 1 && remote.unsures.length === 0) return lineChoice(remote.hits[0], roomId)
  // Other rooms matched, but not as one line. Asking would list them and the
  // send would never become a bubble. A total miss still opens a task.
  if (remote.hits.length > 0 || remote.unsures.length > 0) return legacyDecision(botId)
  if (here.some(isTaskLine) || here.length === 0) return createDecision(botId)
  return legacyDecision(botId)
}

function isRoundLine(line) {
  return line?.implicit === true || line?.round === true
}

function isTaskLine(line) {
  return line != null && !isRoundLine(line)
}

// The primary group session is the round, not a second task. One local work
// line still takes a follow-up while that session is also busy. Leftover lines
// in other rooms do not raise a card during that round, and they do not steal
// a follow-up from the one local busy task. Once nothing here is busy, those
// other rooms still do not raise a card; matchIdle leaves the sentence on the
// relay unless one of them is the only strong match. An idle line in this room
// still can.
function routePool(open, roomId) {
  const localTaskBusy = open.some(line => line.busy === true && isTaskLine(line) && line.lastRoomId === roomId)
  const roundBusy = open.some(line => line.busy === true && isRoundLine(line) && (line.lastRoomId === roomId || line.lastRoomId == null))
  if (localTaskBusy) {
    return open.filter(line => isTaskLine(line) && (line.lastRoomId === roomId || (line.busy === true && typeof line.lastRoomId === 'string' && line.lastRoomId !== '')))
  }
  if (roundBusy) return open.filter(line => line.lastRoomId === roomId || isRoundLine(line))
  return open
}

function autoRoute(text, lines, roomId, botId) {
  const open = lines.filter(line => line?.closedAt == null)
  if (open.length === 0) return createDecision(botId)
  const pool = routePool(open, roomId)
  const busy = pool.filter(line => line.busy === true)
  const local = busy.filter(line => line.lastRoomId === roomId)
  const idle = pool.filter(line => line.busy !== true)
  if (busy.length === 1 && local.length === 1) {
    const current = local[0]
    const busyBand = band(score(text, current))
    const idleHits = idle.filter(line => band(score(text, line)) === 'hit')
    const idleUnsure = idle.filter(line => band(score(text, line)) === 'unsure')
    if (busyBand === 'miss' && idleHits.length === 1 && idleUnsure.length === 0) return lineChoice(idleHits[0], roomId)
    if (busyBand === 'miss' && (idleHits.length > 1 || (idleHits.length > 0 && idleUnsure.length > 0))) return ask(pool)
    return lineChoice(current, roomId)
  }
  if (busy.length >= 2 || (busy.length === 1 && local.length === 0)) {
    const hits = busy.filter(line => band(score(text, line)) === 'hit')
    const unsures = busy.filter(line => band(score(text, line)) === 'unsure')
    if (hits.length === 1 && unsures.length === 0) return lineChoice(hits[0], roomId)
    if (hits.length >= 2 || unsures.length > 0) return ask(pool)
    const idleDecision = matchIdle(text, idle, roomId, botId)
    if (busy.length >= 2 && idleDecision.action === 'create') return ask(pool)
    return idleDecision
  }
  return matchIdle(text, idle, roomId, botId)
}

/**
 * Decide where one bot's inbound line goes. `lines` is that bot's whole index.
 * `doc` is the opening plus the draft (busy) or the latest round (idle).
 * @param {{ text?: string, roomId?: string, botId?: string, lines?: any[], explicitQueue?: boolean }} [input]
 */
export function routeInbound({ text = '', roomId, botId, lines = [], explicitQueue = false } = {}) {
  const queued = explicitQueue === true
  const mine = lines.filter(line => line != null && (botId === undefined || line.botId === undefined || line.botId === botId))
  const intent = explicitIntent(text)
  switch (intent.kind) {
    case 'new':
      if (!queued) return createDecision(botId)
      return finish(autoRoute(text, mine, roomId, botId), true)
    case 'name': {
      const named = findNamed(mine, intent.label)
      if (named !== undefined) return finish(lineChoice(named, roomId), queued)
      const open = mine.filter(line => line?.closedAt == null)
      return finish(open.length > 0 ? ask(open) : createDecision(botId), queued)
    }
    case 'auto': {
      const bare = mine.filter(line => line.id === String(text).trim())
      if (bare.length === 1) return finish(lineChoice(bare[0], roomId), queued)
      return finish(autoRoute(text, mine, roomId, botId), queued)
    }
    default: {
      /** @type {never} */
      const unexpected = intent.kind
      throw new Error(`Unknown inbound intent ${String(unexpected)}`)
    }
  }
}

function mentionsId(text, id) {
  return typeof id === 'string' && id.length >= 8 && text.includes(id.toLowerCase())
}

/** @param {string} text @param {{ choices?: { id?: string, label?: string, sessionId?: string }[] }} pending */
export function answerChoice(text, pending) {
  const choices = pending?.choices ?? []
  const intent = explicitIntent(text)
  if (intent.kind === 'name') {
    const byId = choices.find(choice => choice.id === intent.label || choice.sessionId === intent.label)
    if (byId !== undefined) return byId
    const byLabel = choices.filter(choice => choice.label === intent.label)
    return byLabel.length === 1 ? byLabel[0] : undefined
  }
  const trimmed = String(text ?? '').trim()
  const exact = choices.find(choice => choice.id === trimmed || choice.sessionId === trimmed)
  if (exact !== undefined) return exact
  const lower = trimmed.toLowerCase()
  const loose = choices.filter(choice => mentionsId(lower, choice.id) || mentionsId(lower, choice.sessionId))
  return loose.length === 1 ? loose[0] : undefined
}

/** The ask card. It lives on `pendingRoutes`, and a timeout does not send it. */
export function routeCard(pending) {
  if (pending == null) return undefined
  return {
    kind: 'route',
    botId: pending.botId,
    text: pending.text,
    highlight: pending.highlight,
    choices: pending.choices ?? [],
    timeoutSends: false,
    ...(typeof pending.seq === 'number' ? { seq: pending.seq } : {}),
  }
}

/** What applying a decision is allowed to write. Old transcripts stay where they are. */
export function effectsOf(decision) {
  const action = decision?.action
  switch (action) {
    case 'ask':
    case 'hold':
      return { writeLog: false, deliver: false, modelTurn: false, copyTranscript: false }
    case 'steer':
    case 'continue':
    case 'create':
      return { writeLog: false, deliver: true, modelTurn: true, copyTranscript: false }
    case 'queue':
      return { writeLog: decision.relay === true, deliver: true, modelTurn: true, copyTranscript: false, steer: false }
    case 'legacy':
      return { writeLog: true, deliver: true, modelTurn: true, copyTranscript: false }
    default: {
      /** @type {never} */
      const unexpected = action
      throw new Error(`Unknown inbound route ${String(unexpected)}`)
    }
  }
}

/** @param {{ action?: RouteAction, relay?: boolean } | undefined} decision */
export function routeTakesEffect(decision) {
  switch (decision?.action) {
    case 'steer':
    case 'continue':
    case 'create':
    case 'ask':
    case 'hold':
      return true
    case 'queue':
      return decision.relay !== true
    case 'legacy':
    case undefined:
      return false
    default: {
      /** @type {never} */
      const unexpected = decision.action
      throw new Error(`Unknown inbound route ${String(unexpected)}`)
    }
  }
}

function logOf(room) {
  return Array.isArray(room?.log) ? room.log : []
}

function quotedText(rt, line) {
  const quote = line?.quote
  if (typeof quote?.roomId !== 'string' || typeof quote.seq !== 'number') return ''
  const entry = logOf(rt.roomOf?.(quote.roomId)).find(item => item?.seq === quote.seq)
  return typeof entry?.text === 'string' ? entry.text : ''
}

function recentText(rt, line) {
  if (typeof line?.lastRoomId !== 'string') return ''
  return logOf(rt.roomOf?.(line.lastRoomId)).slice(-6)
    .map(entry => (typeof entry?.text === 'string' ? entry.text : ''))
    .filter(part => part !== '')
    .join('\n')
}

function assistantText(rt, line) {
  const texts = rt.live?.get(line?.sessionId)?.texts
  if (Array.isArray(texts)) {
    for (let index = texts.length - 1; index >= 0; index -= 1) {
      if (typeof texts[index] === 'string' && texts[index] !== '') return texts[index]
    }
  }
  const room = rt.roomOf?.(line?.lastRoomId)
  if (room?.sessions?.[line?.botId] !== line?.sessionId) return ''
  for (const round of rt.roomProgress?.values?.() ?? []) {
    if (round?.roomId !== line?.lastRoomId || round?.draft?.botId !== line?.botId) continue
    if (typeof round.draft?.text === 'string' && round.draft.text !== '') return round.draft.text
  }
  return ''
}

/** Opening plus the current draft (busy) or the latest round (idle). Read only. */
export function lineDocument(rt, line) {
  const opening = quotedText(rt, line)
  if (line?.busy === true) return [opening, assistantText(rt, line)].filter(part => part !== '').join('\n')
  return [opening, recentText(rt, line)].filter(part => part !== '').join('\n')
}

function pendingTable(state) {
  if (state.pendingRoutes == null || typeof state.pendingRoutes !== 'object' || Array.isArray(state.pendingRoutes)) state.pendingRoutes = {}
  return state.pendingRoutes
}

function labelFrom(text) {
  const stripped = String(text ?? '').trim().replace(/^(?:新开|\/new)\b\s*/i, '')
  const line = (stripped === '' ? String(text ?? '') : stripped).split('\n')[0].trim().slice(0, 80)
  return line === '' ? undefined : line
}

function attachMember(decision, members) {
  if (decision?.sessionId == null || decision?.botId == null) return decision
  const known = (members ?? []).find(member => member.id === decision.botId)
  return {
    ...decision,
    member: {
      id: decision.botId,
      sessionId: decision.sessionId,
      ...(typeof known?.name === 'string' ? { name: known.name } : {}),
    },
  }
}

function emit(rt, room, members, decision, text, pending) {
  const next = attachMember(decision.text === undefined ? { ...decision, text } : decision, members)
  if (pending && next.action !== 'hold') {
    next.clearPending = true
    delete pendingTable(rt.state)[room.id]
  }
  return next
}

function linesFor(rt, botId, room) {
  const liveOf = sessionId => rt.live?.get(sessionId)
  const primary = room?.sessions?.[botId]
  const indexed = listByBot(rt.state, botId, liveOf).map(line => ({
    ...line,
    doc: lineDocument(rt, line),
    // The indexed primary session is the round unless this line was opened as its
    // own task (it has a label). ensureLegacy does not set a label.
    ...(typeof primary === 'string' && primary !== '' && line.sessionId === primary && (typeof line.label !== 'string' || line.label === '') ? { round: true } : {}),
  }))
  if (typeof primary === 'string' && primary !== '' && !indexed.some(line => line.sessionId === primary)) {
    const implicit = implicitLine(room, botId)
    if (implicit !== undefined) {
      const busy = isBusy(implicit, liveOf)
      indexed.push({ ...implicit, id: `implicit:${room.id}:${botId}`, busy, doc: '', updatedAt: 0, implicit: true })
    }
  }
  return indexed
}

function indexedBotIds(rt, members) {
  const ids = []
  for (const member of members) {
    if (listByBot(rt.state, member.id, () => undefined).length > 0) ids.push(member.id)
  }
  return ids
}

function selectRouteBot(text, members, indexedIds) {
  const addressed = addressedBot(text, members)
  switch (addressed.kind) {
    case 'all':
    case 'many':
      return { kind: 'legacy' }
    case 'one':
      return { kind: 'bot', botId: addressed.bot.id }
    case 'none':
      break
    default: {
      /** @type {never} */
      const unexpected = addressed.kind
      throw new Error(`Unknown address ${String(unexpected)}`)
    }
  }
  const busy = members.filter(member => member.sessionId && member.live?.turn !== undefined && member.live?.turn !== null)
  if (busy.length === 1) return { kind: 'bot', botId: busy[0].id }
  if (busy.length > 1) return { kind: 'legacy' }
  if (indexedIds.length === 0) return { kind: 'legacy' }
  return { kind: 'idle' }
}

function routeIdle(rt, room, members, text, explicitQueue) {
  const rows = []
  for (const member of members) {
    const lines = linesFor(rt, member.id, room).filter(line => line.implicit !== true)
    if (lines.length === 0) continue
    rows.push({ member, decision: routeInbound({ text, roomId: room.id, botId: member.id, lines, explicitQueue }) })
  }
  if (rows.length === 0) return { action: 'legacy' }
  const asking = rows.find(row => row.decision.action === 'ask')
  if (asking !== undefined) return { ...asking.decision, botId: asking.member.id }
  const picked = rows.filter(row => row.decision.action === 'steer' || row.decision.action === 'continue' || (row.decision.action === 'queue' && row.decision.relay !== true))
  if (picked.length === 1) {
    const only = picked[0]
    const lastRoomId = only.decision.lastRoomId
    const crossRoom = typeof lastRoomId === 'string' && lastRoomId !== '' && lastRoomId !== room.id
    // Another member already left this sentence on the relay. One leftover line
    // in a different room must not take the opening off the group.
    const relayed = rows.some(row => row !== only && row.decision.action === 'legacy')
    if (!(crossRoom && relayed)) return { ...only.decision, botId: only.member.id }
  }
  if (picked.length > 1) {
    return ask(picked.map(row => ({
      id: row.decision.workLineId,
      label: row.decision.label,
      busy: row.decision.steer === true,
      lastRoomId: row.decision.lastRoomId,
      sessionId: row.decision.sessionId,
      updatedAt: row.decision.updatedAt,
      botId: row.member.id,
    })))
  }
  const admin = members.find(member => rt.isAdminOf?.(room, member.id) === true) ?? members[0]
  const lines = linesFor(rt, admin.id, room).filter(line => line.implicit !== true)
  return { ...routeInbound({ text, roomId: room.id, botId: admin.id, lines, explicitQueue }), botId: admin.id }
}

/**
 * @param {any} rt
 * @param {{ room?: any, text?: string, explicitQueue?: boolean, explicitNew?: boolean, plain?: boolean }} [input]
 */
export function routeRoomUser(rt, input = {}) {
  const room = input.room
  const text = String(input.text ?? '')
  if (rt?.state == null || room == null) return { action: 'legacy' }
  const members = roomMembers(room, id => rt.live?.get(id), id => rt.botOf?.(id))
  const pending = pendingTable(rt.state)[room.id]
  const queued = input.explicitQueue === true
  const intent = explicitIntent(text)
  if (input.plain === false) return emit(rt, room, members, { action: 'legacy' }, text, pending)
  if (input.explicitNew === true && intent.kind !== 'new') return emit(rt, room, members, { action: 'legacy' }, text, pending)
  if (pending && !queued && intent.kind !== 'new') {
    const choice = answerChoice(text, pending)
    if (choice === undefined) return { action: 'hold', steer: false, botId: pending.botId, text, clearPending: false }
    const held = Array.isArray(pending.held) ? pending.held.map(item => ({ ...item })) : undefined
    const first = typeof pending.text === 'string' ? pending.text : text
    return emit(rt, room, members, {
      action: choice.busy === true ? 'steer' : 'continue',
      steer: choice.busy === true,
      workLineId: choice.id,
      sessionId: choice.sessionId,
      botId: pending.botId ?? choice.botId,
      lastRoomId: choice.lastRoomId,
      label: choice.label,
      updatedAt: choice.updatedAt ?? 0,
      crossRoom: typeof choice.lastRoomId === 'string' && choice.lastRoomId !== room.id,
      text: first,
      logged: true,
      ...(held !== undefined && held.length > 0 ? { held } : {}),
    }, first, pending)
  }
  const selected = selectRouteBot(text, members, indexedBotIds(rt, members))
  switch (selected.kind) {
    case 'legacy':
      return emit(rt, room, members, { action: 'legacy' }, text, pending)
    case 'idle':
      return emit(rt, room, members, routeIdle(rt, room, members, text, queued), text, pending)
    case 'bot':
      break
    default: {
      /** @type {never} */
      const unexpected = selected.kind
      throw new Error(`Unknown route selection ${String(unexpected)}`)
    }
  }
  const lines = linesFor(rt, selected.botId, room)
  const decision = routeInbound({ text, roomId: room.id, botId: selected.botId, lines, explicitQueue: queued })
  const implicitOnly = lines.length > 0 && lines.every(line => line.implicit === true)
  if (implicitOnly && decision.action !== 'steer' && !(decision.action === 'create' && intent.kind === 'new')) {
    return emit(rt, room, members, { action: 'legacy' }, text, pending)
  }
  return emit(rt, room, members, { ...decision, botId: decision.botId ?? selected.botId }, text, pending)
}

function memberFrom(room, decision) {
  if (decision?.member?.sessionId) return decision.member
  if (typeof decision?.sessionId === 'string' && decision.sessionId !== '' && decision?.botId != null) {
    return { id: decision.botId, sessionId: decision.sessionId }
  }
  const sessionId = room?.sessions?.[decision?.botId]
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  return { id: decision.botId, sessionId }
}

/**
 * Apply a decision. Ask stores a card and does not deliver. Continue does not
 * copy another room's log into this one.
 * @param {any} rt
 * @param {any} room
 * @param {any} decision
 * @param {{ text?: string, files?: any[], inboxId?: string }} [message] `inboxId` is the
 *   group Session inbox row this sentence came from, which keeps one line per row.
 */
async function persistRoute(rt) {
  if (typeof rt.save !== 'function') return
  await rt.save()
}

function appendPlain(room, line) {
  if (room == null || line == null || typeof line.text !== 'string' || line.text === '') return
  const seq = (typeof room.seq === 'number' ? room.seq : (Array.isArray(room.log) ? room.log.length : 0)) + 1
  room.seq = seq
  room.log = [...(Array.isArray(room.log) ? room.log : []), { ...line, seq }]
}

function writeProjected(rt, room, lines) {
  for (const line of lines) {
    if (typeof rt.appendRoomLine === 'function') rt.appendRoomLine(room, line)
    else appendPlain(room, line)
  }
}

// A primary member session keeps posting in its home room. Any other session
// follows the line into the room that just received it.
function retargetWorkOwner(rt, sessionId, roomId) {
  const owners = rt.groupOwners
  if (owners == null || typeof owners.get !== 'function') return
  const owner = owners.get(sessionId)
  if (owner == null || owner.roomId === roomId) return
  const home = rt.roomOf?.(owner.roomId)
  if (home?.sessions?.[owner.botId] === sessionId) return
  owner.roomId = roomId
}

function postArrivalReply(rt, room, botId, raw) {
  const body = typeof raw === 'string' ? raw.trim() : ''
  if (body === '') return
  const bot = rt.botOf?.(botId)
  writeProjected(rt, room, projectExchange({
    replyText: body,
    replyWho: bot?.name,
    replyBotId: botId,
  }))
  // The user line was saved before the model ran. The reply lands later.
  if (typeof rt.save === 'function') void rt.save()
}

function armArrivalReply(rt, room, decision, exchangeId) {
  if (rt.roomWaiters == null || typeof rt.roomWaiters.set !== 'function') return
  const botId = decision.botId
  rt.roomWaiters.set(exchangeId, {
    sessionId: decision.sessionId,
    botId,
    roomId: room.id,
    resolve(reply) {
      postArrivalReply(rt, room, botId, reply)
    },
    fail() {},
    // A step already shown is omitted from the turn's final text, so it has to land here.
    say(raw) {
      postArrivalReply(rt, room, botId, raw)
    },
    touch() {},
    work() {},
    approval() {},
  })
}

// The model turn stays on the line's session. The arrival room already logged this
// sentence once. The other room's transcript is not copied.
async function deliverAcrossRooms(rt, room, decision, text, files, cite = {}) {
  noteLineRoom(rt.state, { workLineId: decision.workLineId, sessionId: decision.sessionId, roomId: room.id })
  retargetWorkOwner(rt, decision.sessionId, room.id)
  if (typeof rt.save === 'function') void rt.save()
  const exchangeId = randomUUID()
  armArrivalReply(rt, room, decision, exchangeId)
  const steer = decision.action === 'steer'
  if (steer && typeof rt.suppressRelayText === 'function') rt.suppressRelayText(room.id, text)
  if (decision.sessionId == null || typeof rt.deliver !== 'function') return
  await rt.deliver({
    toId: decision.botId,
    sessionId: decision.sessionId,
    role: 'room',
    roomId: room.id,
    note: 'the user said',
    text,
    files,
    exchangeId,
    steer,
    ...(steer ? { userSteer: true } : {}),
    ...cite,
  })
}

function isUserLogRow(row) {
  return row != null
    && row.who === 'User'
    && row.kind == null
    && typeof row.text === 'string'
    && row.text !== ''
    && typeof row.seq === 'number'
    && Number.isFinite(row.seq)
}

// A route body may already be a line of this room: the same message can reach the
// route twice (a replay, a stop, the composer's deferred copy). Its inbox id finds
// that line, so the sentence keeps the seq it has instead of being written again.
function logInboundSentence(rt, room, text, inboxId) {
  if (room == null || typeof text !== 'string' || text === '') return undefined
  const log = Array.isArray(room.log) ? room.log : []
  const id = typeof inboxId === 'string' && inboxId !== '' ? inboxId : undefined
  if (id !== undefined) {
    const known = log.find(row => isUserLogRow(row) && row.inboxId === id)
    if (known !== undefined) return known.seq
  }
  const last = log.at(-1)
  if (isUserLogRow(last) && last.text === text) return last.seq
  const line = { who: 'User', text, ...(id === undefined ? {} : { inboxId: id }) }
  if (typeof rt.appendRoomLine === 'function') rt.appendRoomLine(room, line)
  else appendPlain(room, line)
  return typeof room.seq === 'number' ? room.seq : undefined
}

// The cite painter hides a host bubble by this send id. A route that only saw
// `message.id` records that field and does not invent an inbox id.
function rememberSendId(room, seq, messageId) {
  if (typeof messageId !== 'string' || messageId === '' || typeof seq !== 'number' || !Number.isFinite(seq)) return
  const row = (Array.isArray(room?.log) ? room.log : []).find(item => item?.seq === seq)
  if (!isUserLogRow(row)) return
  if (typeof row.messageId !== 'string' || row.messageId === '') row.messageId = messageId
}

function citeSendId(messageId, inboxId) {
  if (typeof messageId === 'string' && messageId !== '') return messageId
  if (typeof inboxId === 'string' && inboxId !== '') return inboxId
  return undefined
}

function pointsAtUser(rt, quote) {
  if (quote == null || typeof quote !== 'object') return false
  if (typeof quote.seq !== 'number' || !Number.isFinite(quote.seq) || quote.seq === 0) return false
  if (typeof quote.roomId !== 'string' || quote.roomId === '') return false
  const room = rt.roomOf?.(quote.roomId)
  const row = (Array.isArray(room?.log) ? room.log : []).find(item => item?.seq === quote.seq)
  return isUserLogRow(row)
}

function lineForDecision(rt, decision) {
  const lines = rt.state?.workLines
  if (lines == null || typeof lines !== 'object' || Array.isArray(lines)) return undefined
  if (typeof decision?.workLineId === 'string' && lines[decision.workLineId] != null) return lines[decision.workLineId]
  if (typeof decision?.sessionId === 'string' && decision.sessionId !== '') {
    return Object.values(lines).find(line => line?.sessionId === decision.sessionId)
  }
  return undefined
}

function repairQuote(rt, room, decision, seq) {
  if (room == null || typeof seq !== 'number' || !Number.isFinite(seq) || seq === 0) return
  const line = lineForDecision(rt, decision)
  if (line == null || pointsAtUser(rt, line.quote)) return
  line.quote = { roomId: room.id, seq }
}

function quoteDelivery(room, text, seq) {
  if (room == null || typeof text !== 'string' || text === '') return {}
  if (typeof seq !== 'number' || !Number.isFinite(seq)) return {}
  return { quoteText: text, quoteSeq: seq, quoteRoomId: room.id }
}

function quoteForLogged(room, text) {
  const log = Array.isArray(room?.log) ? room.log : []
  for (let index = log.length - 1; index >= 0; index -= 1) {
    const row = log[index]
    if (isUserLogRow(row) && row.text === text) return quoteDelivery(room, text, row.seq)
  }
  return {}
}

function citeOfHeld(item) {
  if (item == null || typeof item !== 'object') return {}
  return {
    ...(typeof item.quoteText === 'string' && item.quoteText !== '' ? { quoteText: item.quoteText } : {}),
    ...(typeof item.quoteSeq === 'number' && Number.isFinite(item.quoteSeq) ? { quoteSeq: item.quoteSeq } : {}),
    ...(typeof item.quoteRoomId === 'string' && item.quoteRoomId !== '' ? { quoteRoomId: item.quoteRoomId } : {}),
  }
}

function steerBatch(decision, text, cite, messageId, files, room) {
  if (Array.isArray(decision?.held) && decision.held.length > 0) {
    return decision.held
      .filter(item => typeof item?.text === 'string' && item.text !== '')
      .map(item => ({
        text: item.text,
        files: [],
        cite: citeOfHeld(item),
        messageId: typeof item.messageId === 'string' && item.messageId !== '' ? item.messageId : undefined,
      }))
  }
  const resolved = typeof cite?.quoteText === 'string' && cite.quoteText !== '' ? cite : { ...cite, ...quoteForLogged(room, text) }
  return [{ text, files, cite: resolved, messageId }]
}

function logsThisAction(action) {
  return action === 'ask' || action === 'steer' || action === 'continue' || action === 'create' || action === 'queue'
}

function keepHeld(rt, room, text, messageId, inboxId) {
  const card = pendingTable(rt.state)[room.id]
  if (card == null || typeof text !== 'string' || text === '') return false
  const known = Array.isArray(card.texts) ? card.texts : (typeof card.text === 'string' && card.text !== '' ? [card.text] : [])
  if (known.includes(text)) return true
  const heldSeq = logInboundSentence(rt, room, text, inboxId)
  const citeId = citeSendId(messageId, inboxId)
  rememberSendId(room, heldSeq, citeId)
  const heldCite = quoteDelivery(room, text, heldSeq)
  card.texts = [...known, text]
  card.held = [...(Array.isArray(card.held) ? card.held : []), {
    text,
    ...heldCite,
    ...(citeId !== undefined ? { messageId: citeId } : {}),
  }]
  return true
}

export async function applyRouteDecision(rt, room, decision, message = {}) {
  const text = typeof decision?.text === 'string' ? decision.text : String(message.text ?? '')
  const files = message.files ?? []
  const action = decision?.action
  const messageId = typeof message?.id === 'string' && message.id !== '' ? message.id : undefined
  const inboxId = typeof message?.inboxId === 'string' && message.inboxId !== '' ? message.inboxId : undefined
  const citeId = citeSendId(messageId, inboxId)
  // A second ask that loses the race keeps the card, and keeps this sentence on it.
  if (action === 'ask' && pendingTable(rt.state)[room.id] != null) {
    if (keepHeld(rt, room, text, messageId, inboxId)) await persistRoute(rt)
    return decision
  }
  // Ask, steer, continue, create, and a non-relay queue log this sentence once.
  // A sentence that arrives while the card is open is logged by keepHeld, and kept
  // on the card. Confirm already logged every sentence, so it does not append again.
  // effectsOf still reports writeLog false: the relay must not write a second
  // row or copy another room.
  const seq = logsThisAction(action) && decision?.logged !== true ? logInboundSentence(rt, room, text, message.inboxId) : undefined
  rememberSendId(room, seq, citeId)
  const cite = quoteDelivery(room, text, seq)
  // Every leaving action must hit disk before deliver, because a later load
  // would put the card back.
  if (decision?.clearPending === true && action !== 'ask') {
    delete pendingTable(rt.state)[room.id]
    await persistRoute(rt)
  }
  switch (action) {
    case 'hold': {
      if (keepHeld(rt, room, text, messageId, inboxId)) await persistRoute(rt)
      return decision
    }
    case 'legacy':
      return decision
    case 'ask': {
      pendingTable(rt.state)[room.id] = {
        botId: decision.botId,
        text,
        texts: [text],
        held: [{ text, ...cite, ...(citeId !== undefined ? { messageId: citeId } : {}) }],
        highlight: decision.highlight,
        choices: decision.choices ?? [],
        at: Date.now(),
        timeoutSends: false,
        ...(typeof seq === 'number' ? { seq } : {}),
      }
      await persistRoute(rt)
      return decision
    }
    case 'steer': {
      const batch = steerBatch(decision, text, cite, citeId, files, room)
      if (decision.crossRoom === true) {
        for (const item of batch) {
          repairQuote(rt, room, decision, item.cite.quoteSeq)
          await deliverAcrossRooms(rt, room, decision, item.text, item.files, item.cite)
        }
        return decision
      }
      const member = memberFrom(room, decision)
      if (member != null && typeof rt.acceptRoomSteer === 'function') {
        for (const item of batch) {
          repairQuote(rt, room, decision, item.cite.quoteSeq)
          const itemId = item.messageId
          await rt.acceptRoomSteer(room, member, {
            text: item.text,
            files: item.files,
            ...item.cite,
            ...(itemId !== undefined ? { messageId: itemId } : {}),
          })
        }
        return decision
      }
      if (decision.sessionId != null && typeof rt.deliver === 'function') {
        for (const item of batch) {
          repairQuote(rt, room, decision, item.cite.quoteSeq)
          await rt.deliver({
            toId: decision.botId,
            sessionId: decision.sessionId,
            role: 'room',
            roomId: room.id,
            note: 'the user said',
            text: item.text,
            files: item.files,
            steer: true,
            userSteer: true,
            ...item.cite,
          })
        }
      }
      return decision
    }
    case 'continue':
    case 'queue': {
      const batch = action === 'continue' ? steerBatch(decision, text, cite, citeId, files, room) : [{ text, files, cite, messageId: citeId }]
      if (action === 'continue' && decision.crossRoom === true) {
        for (const item of batch) {
          repairQuote(rt, room, decision, item.cite?.quoteSeq)
          await deliverAcrossRooms(rt, room, decision, item.text, item.files, item.cite)
        }
        return decision
      }
      if (decision.sessionId == null || typeof rt.deliver !== 'function') return decision
      for (const item of batch) {
        repairQuote(rt, room, decision, item.cite?.quoteSeq ?? seq)
        await rt.deliver({
          toId: decision.botId,
          sessionId: decision.sessionId,
          role: 'room',
          roomId: room.id,
          note: 'the user said',
          text: item.text,
          files: item.files,
          steer: false,
          ...item.cite,
        })
      }
      return decision
    }
    case 'create': {
      if (typeof rt.createWorkLine !== 'function') return decision
      const label = labelFrom(text)
      const quote = typeof seq === 'number' && seq !== 0 ? { roomId: room.id, seq } : undefined
      const line = await rt.createWorkLine({
        botId: decision.botId,
        roomId: room.id,
        ...(quote !== undefined ? { quote } : {}),
        ...(label !== undefined ? { label } : {}),
      })
      const created = { ...decision, workLineId: line?.id ?? decision.workLineId, sessionId: line?.sessionId ?? decision.sessionId }
      repairQuote(rt, room, created, seq)
      if (line?.sessionId != null && typeof rt.deliver === 'function') {
        await rt.deliver({
          toId: decision.botId,
          sessionId: line.sessionId,
          role: 'room',
          roomId: room.id,
          note: 'the user said',
          text,
          files,
          steer: false,
          ...cite,
        })
      }
      return created
    }
    default: {
      /** @type {never} */
      const unexpected = action
      throw new Error(`Unknown inbound route ${String(unexpected)}`)
    }
  }
}

export function install(rt) {
  if (rt.state) pendingTable(rt.state)
  rt.routeRoomUser = input => routeRoomUser(rt, input)
  rt.applyRouteDecision = (room, decision, message) => applyRouteDecision(rt, room, decision, message)
}
