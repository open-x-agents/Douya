// Work-line index: one stable id pointing at a DSH session that already exists.
// The index holds metadata only. Message text stays in the session log, and a
// Bot's MEMORY.md stays one file per bot. Busy is live.turn, not a stored status.
import { randomUUID } from 'node:crypto'
import { orderedCompletions } from '../shared/work-line-complete.js'
import { HISTORY_TIMEOUT_MS } from './constants.js'
import { splitRef, textOf } from './text.js'

/** Keys a saved line may carry. Anything else is a body and is not stored. */
export const INDEX_FIELDS = Object.freeze(['id', 'botId', 'sessionId', 'lastRoomId', 'quote', 'label', 'updatedAt', 'closedAt', 'segments'])

const own = (table, key) => (table != null && Object.hasOwn(table, key) ? table[key] : undefined)

const linesOf = (state) => {
  if (state.workLines == null || typeof state.workLines !== 'object' || Array.isArray(state.workLines)) state.workLines = {}
  return state.workLines
}

const completedOf = (state) => {
  if (state.workLineCompleted == null || typeof state.workLineCompleted !== 'object' || Array.isArray(state.workLineCompleted)) state.workLineCompleted = {}
  return state.workLineCompleted
}

const cleanLabel = (label) => {
  if (typeof label !== 'string') return undefined
  const line = label.split('\n')[0].trim().slice(0, 80)
  return line === '' ? undefined : line
}

const cleanQuote = (quote) => {
  if (quote == null || typeof quote !== 'object' || Array.isArray(quote)) return undefined
  /** @type {{ roomId?: string, seq?: number }} */
  const next = {}
  if (typeof quote.roomId === 'string' && quote.roomId !== '') next.roomId = quote.roomId
  if (typeof quote.seq === 'number' && Number.isFinite(quote.seq)) next.seq = quote.seq
  return next.roomId !== undefined || next.seq !== undefined ? next : undefined
}

const cleanSegments = (segments) => {
  if (!Array.isArray(segments)) return []
  const out = []
  for (const segment of segments) {
    if (typeof segment?.sessionId !== 'string' || segment.sessionId === '') continue
    out.push({
      sessionId: segment.sessionId,
      ...(typeof segment.endedAt === 'number' ? { endedAt: segment.endedAt } : {}),
    })
  }
  return out
}

const allocate = (lines, createId) => {
  const nextId = typeof createId === 'function' ? createId : () => randomUUID()
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = nextId()
    if (typeof id === 'string' && id !== '' && !Object.hasOwn(lines, id)) return id
  }
  throw new Error('Could not allocate a work-line id')
}

/** @param {Record<string, any>} line */
export function indexOnly(line) {
  return line != null && typeof line === 'object' && Object.keys(line).every(key => INDEX_FIELDS.includes(key))
}

/**
 * Busy while that session's turn is open, including a slot already marked working.
 * @param {{ sessionId?: string } | undefined} line
 * @param {(sessionId: string) => { turn?: unknown } | undefined} [liveOf]
 */
export function isBusy(line, liveOf) {
  if (line?.sessionId == null || typeof liveOf !== 'function') return false
  const turn = liveOf(line.sessionId)?.turn
  return turn !== undefined && turn !== null
}

/**
 * The session delivery already uses when this room has no index row yet.
 * @param {{ id?: string, sessions?: Record<string, string> } | undefined} room
 * @param {string} botId
 */
export function implicitLine(room, botId) {
  const sessionId = room?.sessions?.[botId]
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  return { botId, sessionId, lastRoomId: room.id, implicit: true }
}

/** Indexed line for this member session, or the implicit room session when none is stored. */
export function lineForMember(state, room, botId) {
  const sessionId = room?.sessions?.[botId]
  const indexed = sessionId === undefined ? undefined : lineBySession(state, sessionId)
  if (indexed !== undefined) return indexed
  return implicitLine(room, botId)
}

export function lineBySession(state, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  return Object.values(linesOf(state)).find(line => line?.sessionId === sessionId)
}

/**
 * One new line, or the line that already points at this session.
 * `messages`, `memory`, `status`, and note text are dropped.
 */
export function createLine(state, input = {}) {
  const lines = linesOf(state)
  const sessionId = input.sessionId
  const botId = input.botId
  if (typeof sessionId !== 'string' || sessionId === '') throw new Error('A work line needs a session')
  if (typeof botId !== 'string' || botId === '') throw new Error('A work line needs a bot')
  const existing = lineBySession(state, sessionId)
  if (existing !== undefined) return existing
  const id = typeof input.id === 'string' && input.id !== '' && !Object.hasOwn(lines, input.id) ? input.id : allocate(lines, input.createId)
  /** @type {Record<string, any>} */
  const line = {
    id,
    botId,
    sessionId,
    updatedAt: typeof input.now === 'number' ? input.now : Date.now(),
    segments: cleanSegments(input.segments),
  }
  const roomId = input.roomId ?? input.lastRoomId
  if (typeof roomId === 'string' && roomId !== '') line.lastRoomId = roomId
  const quote = cleanQuote(input.quote)
  if (quote !== undefined) line.quote = quote
  const label = cleanLabel(input.label)
  if (label !== undefined) line.label = label
  if (typeof input.closedAt === 'number') line.closedAt = input.closedAt
  lines[id] = line
  return line
}

/**
 * One line for each private chat and each `room.sessions[botId]`.
 * A session that already has a line keeps that id.
 * @returns {boolean} true when a line was added
 */
export function ensureLegacy(state, { now = Date.now(), createId, chatOf } = {}) {
  const before = Object.keys(linesOf(state)).length
  const sessionFor = (bot) => (typeof chatOf === 'function' ? chatOf(bot.id) : undefined) ?? bot?.sessionId ?? bot?.id
  for (const bot of Object.values(state?.bots ?? {})) {
    const sessionId = sessionFor(bot)
    if (typeof bot?.id !== 'string' || typeof sessionId !== 'string' || sessionId === '') continue
    if (lineBySession(state, sessionId) !== undefined) continue
    createLine(state, { botId: bot.id, sessionId, now, createId })
  }
  for (const room of Object.values(state?.rooms ?? {})) {
    for (const [botId, sessionId] of Object.entries(room?.sessions ?? {})) {
      if (typeof sessionId !== 'string' || sessionId === '' || lineBySession(state, sessionId) !== undefined) continue
      const seq = typeof room.seq === 'number' ? room.seq : 0
      createLine(state, {
        botId,
        sessionId,
        roomId: room.id,
        quote: { roomId: room.id, seq },
        now,
        createId,
      })
    }
  }
  let stripped = false
  for (const line of Object.values(linesOf(state))) {
    for (const key of ['messages', 'memory', 'text', 'status', 'body']) {
      if (Object.hasOwn(line, key)) {
        delete line[key]
        stripped = true
      }
    }
    const segments = cleanSegments(line.segments)
    if (JSON.stringify(segments) !== JSON.stringify(line.segments ?? [])) {
      line.segments = segments
      stripped = true
    }
  }
  return Object.keys(linesOf(state)).length !== before || stripped
}

/**
 * The line was just delivered in `roomId`. The session id stays. No transcript is stored.
 * @param {Record<string, any>} state
 * @param {{ workLineId?: string, sessionId?: string, roomId?: string, now?: number }} [input]
 */
export function noteLineRoom(state, { workLineId, sessionId, roomId, now = Date.now() } = {}) {
  const lines = linesOf(state)
  const line = (typeof workLineId === 'string' && lines[workLineId] != null)
    ? lines[workLineId]
    : (typeof sessionId === 'string' ? Object.values(lines).find(item => item?.sessionId === sessionId) : undefined)
  if (line == null || typeof roomId !== 'string' || roomId === '') return undefined
  line.lastRoomId = roomId
  line.updatedAt = now
  return line
}

/**
 * The only lines an arrival room may show for one cross-room exchange.
 * Callers pass the new user sentence and, later, the reply. History is not an input.
 * @param {{ userText?: string, replyText?: string, replyWho?: string, replyBotId?: string }} [input]
 */
export function projectExchange({ userText, replyText, replyWho, replyBotId } = {}) {
  /** @type {{ who: string, text: string, botId?: string }[]} */
  const lines = []
  if (typeof userText === 'string' && userText !== '') lines.push({ who: 'User', text: userText })
  if (typeof replyText === 'string' && replyText !== '') {
    lines.push({
      who: typeof replyWho === 'string' && replyWho !== '' ? replyWho : 'Bot',
      text: replyText,
      ...(typeof replyBotId === 'string' && replyBotId !== '' ? { botId: replyBotId } : {}),
    })
  }
  return lines
}

/** Lines of one bot. `busy` is computed and is not written back. */
export function listByBot(state, botId, liveOf) {
  return Object.values(linesOf(state))
    .filter(line => line?.botId === botId)
    .map(line => ({
      id: line.id,
      botId: line.botId,
      sessionId: line.sessionId,
      ...(line.lastRoomId !== undefined ? { lastRoomId: line.lastRoomId } : {}),
      ...(line.quote !== undefined ? { quote: line.quote } : {}),
      ...(line.label !== undefined ? { label: line.label } : {}),
      updatedAt: line.updatedAt,
      ...(line.closedAt !== undefined ? { closedAt: line.closedAt } : {}),
      segments: cleanSegments(line.segments),
      busy: isBusy(line, liveOf),
    }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
}

/**
 * A shutdown, an interrupted turn, or a part switch is not a completion.
 * The resumed session keeps running and emits once when that turn really ends.
 */
export function skipsCompletion(reason, { replay = false, switched = false } = {}) {
  if (replay === true || switched === true) return true
  if (reason == null) return true
  if (reason.kind === 'interrupted' || reason.kind === 'blocked') return true
  if (reason.kind === 'aborted' && reason.reason?.kind === 'disposed') return true
  return false
}

/**
 * Mark the turn finished for projection. The line stays open (`closedAt` is
 * only a user close). The same exchange emits at most one event.
 */
export function noteTurnEnd(state, { sessionId, exchangeId, turn, reason, replay = false, switched = false, now = Date.now() } = {}) {
  const line = lineBySession(state, sessionId)
  if (line === undefined) return { line: undefined, event: undefined }
  if (skipsCompletion(reason, { replay, switched })) return { line, event: undefined }
  const key = typeof exchangeId === 'string' && exchangeId !== '' ? exchangeId
    : turn !== undefined && turn !== null ? `turn:${sessionId}:${turn}` : undefined
  if (key === undefined || key === '__proto__' || key === 'constructor' || key === 'prototype') return { line, event: undefined }
  const seen = completedOf(state)
  if (seen[key] === true) return { line, event: undefined }
  seen[key] = true
  line.updatedAt = now
  const event = {
    workLineId: line.id,
    completedAt: now,
    ...(line.quote !== undefined ? { quote: line.quote } : {}),
    exchangeId: key,
  }
  return { line, event }
}

/**
 * The current session moved to a fresh part. Keep this line's id and remember
 * the archived session id, not the handoff note.
 */
export function followSegment(state, { fromSessionId, toSessionId, segment, now = Date.now() } = {}) {
  if (typeof fromSessionId !== 'string' || typeof toSessionId !== 'string' || fromSessionId === toSessionId) return undefined
  const line = lineBySession(state, fromSessionId)
  if (line === undefined) return undefined
  const occupant = lineBySession(state, toSessionId)
  if (occupant !== undefined && occupant.id !== line.id) return undefined
  const archived = { sessionId: fromSessionId, ...(typeof segment?.endedAt === 'number' ? { endedAt: segment.endedAt } : {}) }
  line.segments = [...cleanSegments(line.segments), archived]
  line.sessionId = toSessionId
  line.updatedAt = now
  return line
}

const messageFromEvent = (event, sessionId) => {
  if (event?.type === 'user/message') {
    const text = textOf(event.data?.content)
    if (text === '') return undefined
    return { role: 'user', text, sessionId, ...(event.seq !== undefined ? { seq: event.seq } : {}) }
  }
  if (event?.type === 'assistant/message') {
    const text = textOf(event.data?.message?.content)
    if (text === '') return undefined
    return { role: 'assistant', text, sessionId, ...(event.seq !== undefined ? { seq: event.seq } : {}) }
  }
  return undefined
}

const pushSession = (ids, sessionId) => {
  if (typeof sessionId === 'string' && sessionId !== '' && !ids.includes(sessionId)) ids.push(sessionId)
}

/**
 * Messages of this line, oldest part first, from session events.
 * `parts` is the legacy `partsOf` list (bot.segments / room.segments plus current).
 * `line.segments` covers a line whose archive is not on the bot or the room.
 * A `messages` array on the line is ignored.
 */
export function getFullThread(state, id, { parts = [], logs = {} } = {}) {
  const line = own(linesOf(state), id)
  if (line === undefined) return []
  const ids = []
  for (const part of parts) pushSession(ids, part?.sessionId ?? part)
  for (const segment of line.segments ?? []) pushSession(ids, segment?.sessionId)
  pushSession(ids, line.sessionId)
  const messages = []
  for (const sessionId of ids) {
    for (const event of logs[sessionId] ?? []) {
      const message = messageFromEvent(event, sessionId)
      if (message !== undefined) messages.push(message)
    }
  }
  return messages
}

const sessionIdsOf = (line, parts) => {
  const ids = []
  for (const part of parts) pushSession(ids, part?.sessionId)
  for (const segment of line.segments ?? []) pushSession(ids, segment?.sessionId)
  pushSession(ids, line.sessionId)
  return ids
}

export function install(rt) {
  const { state } = rt
  linesOf(state)
  completedOf(state)

  // Register sessions that are not the member's primary `room.sessions` slot,
  // and stamp the primary slot with its line id. indexSessions clears the maps
  // first, then calls this.
  rt.ensureWorkLines = () => {
    const added = ensureLegacy(state, { createId: () => randomUUID() })
    for (const line of Object.values(linesOf(state))) {
      if (typeof line.sessionId !== 'string' || line.sessionId === '') continue
      if (typeof line.lastRoomId === 'string') {
        if (!rt.groupOwners.has(line.sessionId)) {
          rt.groupOwners.set(line.sessionId, { botId: line.botId, roomId: line.lastRoomId, workLineId: line.id })
        } else {
          const owner = rt.groupOwners.get(line.sessionId)
          if (owner && owner.workLineId === undefined) owner.workLineId = line.id
        }
      } else if (!rt.chatOwners.has(line.sessionId)) {
        rt.chatOwners.set(line.sessionId, line.botId)
      }
      for (const segment of line.segments ?? []) {
        if (typeof segment?.sessionId !== 'string' || rt.pastOwners.has(segment.sessionId)) continue
        rt.pastOwners.set(segment.sessionId, {
          botId: line.botId,
          ...(typeof line.lastRoomId === 'string' ? { roomId: line.lastRoomId } : {}),
          workLineId: line.id,
        })
      }
    }
    return added
  }

  // A brand-new line session has to carry the bot's model before followup, or the
  // user text stays out of the session file and the line never becomes busy.
  const prepareWorkSession = async (bot, sessionId, room) => {
    if (typeof rt.desiredModel === 'function' && typeof rt.selectSessionModel === 'function') {
      const ref = await rt.desiredModel(bot).catch(error => {
        rt.warn?.('ds-bot: model for a new work line of %s not chosen: %s', bot?.name, error)
        return undefined
      })
      const route = splitRef(ref)
      if (route !== undefined) {
        await rt.selectSessionModel(sessionId, route)
          .catch(error => rt.warn?.('ds-bot: model for a new work line of %s not applied: %s', bot?.name, error))
      }
    }
    if (typeof rt.applyPermission === 'function') {
      await rt.applyPermission(bot, sessionId, room)
        .catch(error => rt.warn?.('ds-bot: permission for a new work line of %s not applied: %s', bot?.name, error))
    }
    if (typeof rt.resolveAgent === 'function') {
      await rt.resolveAgent(sessionId)
        .catch(error => rt.warn?.('ds-bot: work line session %s not resolved: %s', sessionId, error))
    }
  }

  rt.createWorkLine = async ({ botId, roomId, sessionId, quote, label } = {}) => {
    const bot = rt.botOf(botId)
    if (bot === undefined) throw new Error(`Unknown Bot ${botId}`)
    const room = typeof roomId === 'string' ? rt.roomOf(roomId) : undefined
    let target = sessionId
    let created = false
    if (target === undefined) {
      const dir = rt.workDirOf?.({ botId, roomId })
      target = await rt.createSession(
        room ? `${bot.name} · ${room.name}` : bot.name,
        typeof dir === 'string' && dir !== '' ? { dir } : {},
      )
      created = true
    }
    const line = createLine(state, { botId, sessionId: target, roomId, quote, label, createId: () => randomUUID() })
    const primary = room?.sessions?.[botId]
    if (typeof roomId === 'string' && target !== primary) {
      rt.groupOwners.set(target, { botId, roomId, workLineId: line.id })
    }
    if (created) await prepareWorkSession(bot, target, room)
    await rt.save?.()
    if (created && typeof rt.ensureCapabilities === 'function') await rt.ensureCapabilities(target)
    return line
  }

  rt.followWorkLine = (input) => followSegment(state, input)

  rt.workCompletions = []
  rt.noteWorkTurnEnd = (input) => {
    const result = noteTurnEnd(state, input)
    if (result.event !== undefined) {
      const line = result.line
      const reply = typeof input?.reply === 'string' && input.reply !== '' ? input.reply : undefined
      const stored = {
        ...result.event,
        ...(typeof line?.lastRoomId === 'string' ? { roomId: line.lastRoomId } : {}),
        ...(typeof line?.botId === 'string' ? { botId: line.botId } : {}),
        ...(reply !== undefined ? { reply } : {}),
      }
      rt.workCompletions = [...rt.workCompletions, stored].slice(-100)
    }
    return result
  }

  // In-memory projection for the open room. Reply text stays off the line and
  // out of state.json; the room log is only read.
  rt.completionView = () => {
    const logs = {}
    const rooms = state.rooms
    if (rooms != null && typeof rooms === 'object') {
      for (const [id, room] of Object.entries(rooms)) {
        if (Array.isArray(room?.log)) logs[id] = room.log
      }
    }
    const grouped = new Map()
    for (const event of rt.workCompletions) {
      const roomId = typeof event?.roomId === 'string' && event.roomId !== ''
        ? event.roomId
        : (typeof event?.quote?.roomId === 'string' ? event.quote.roomId : undefined)
      if (typeof roomId !== 'string' || roomId === '') continue
      const list = grouped.get(roomId)
      if (list === undefined) grouped.set(roomId, [event])
      else list.push(event)
    }
    const view = {}
    for (const [roomId, events] of grouped) view[roomId] = orderedCompletions(events, { roomId, logs })
    return view
  }

  const legacyParts = (line) => {
    if (typeof rt.partsOf !== 'function') return []
    if (line.lastRoomId === undefined) {
      const bot = rt.botOf(line.botId)
      const archived = (bot?.segments ?? []).some(segment => segment.sessionId === line.sessionId)
      if (rt.chatOf(line.botId) === line.sessionId || archived) return rt.partsOf(line.botId) ?? []
      return []
    }
    const room = rt.roomOf(line.lastRoomId)
    const archived = (room?.segments?.[line.botId] ?? []).some(segment => segment.sessionId === line.sessionId)
    if (room?.sessions?.[line.botId] === line.sessionId || archived) return rt.partsOf(line.botId, line.lastRoomId) ?? []
    return []
  }

  const readLog = async (sessionId) => {
    if (typeof rt.eventsBackwards !== 'function') return []
    const events = []
    for await (const event of rt.eventsBackwards(sessionId, AbortSignal.timeout(HISTORY_TIMEOUT_MS), Infinity)) events.push(event)
    events.reverse()
    return events
  }

  rt.getFullThread = async (id) => {
    const line = own(linesOf(state), id)
    if (line === undefined) return []
    const parts = legacyParts(line)
    const logs = {}
    for (const sessionId of sessionIdsOf(line, parts)) {
      try {
        logs[sessionId] = await readLog(sessionId)
      } catch (error) {
        rt.warn('ds-bot: work line %s could not read %s: %s', id, sessionId, error)
        logs[sessionId] = []
      }
    }
    return getFullThread(state, id, { parts, logs })
  }
}
