// Display projection for work lines that finish in the same room.
// Session logs stay append-only. Callers paint this list; they do not write it back.

import { clearDraftIfPosted } from './room-draft.js'

export { lateCite } from './cite.js'

/** Distance from the bottom, in pixels, that still counts as pinned. */
export const PIN_GAP = 48

/**
 * @param {{ scrollTop?: number, scrollHeight?: number, clientHeight?: number, threshold?: number }} [metrics]
 */
export function pinnedToBottom({ scrollTop = 0, scrollHeight = 0, clientHeight = 0, threshold = PIN_GAP } = {}) {
  return scrollHeight - scrollTop - clientHeight < threshold
}

/**
 * @param {{ pinned?: boolean, roomMatches?: boolean }} [input]
 * @returns {'hold-first' | 'leave'}
 */
export function scrollAction({ pinned, roomMatches } = {}) {
  if (pinned === true && roomMatches === true) return 'hold-first'
  return 'leave'
}

/**
 * `hold-first` keeps the first completed item in view and locks that scrollTop.
 * `leave` returns the same scrollTop the caller passed in.
 * @param {{ action?: 'hold-first' | 'leave', scrollTop?: number, clientHeight?: number, firstOffset?: number, firstHeight?: number, lockedTop?: number | null }} [input]
 */
export function applyScroll({ action, scrollTop = 0, clientHeight = 0, firstOffset, firstHeight = 0, lockedTop = null } = {}) {
  switch (action) {
    case 'hold-first': {
      if (typeof lockedTop === 'number') return { scrollTop: lockedTop, lockedTop }
      let next = scrollTop
      if (typeof firstOffset === 'number') {
        const itemEnd = firstOffset + firstHeight
        const viewEnd = scrollTop + clientHeight
        if (firstOffset < scrollTop) next = firstOffset
        else if (itemEnd > viewEnd) next = Math.max(0, itemEnd - clientHeight)
      }
      return { scrollTop: next, lockedTop: next }
    }
    case 'leave':
    case undefined:
      return { scrollTop, lockedTop: null }
    default: {
      /** @type {never} */
      const unexpected = action
      throw new Error(`Unknown scroll action ${String(unexpected)}`)
    }
  }
}

const hasId = (value) => typeof value === 'string' && value !== ''

/**
 * First event for each exchangeId wins. Events without an id are dropped.
 * @param {unknown[]} [events]
 */
export function dedupeCompletions(events) {
  const seen = new Set()
  const out = []
  const list = Array.isArray(events) ? events : []
  for (const event of list) {
    const id = event?.exchangeId
    if (!hasId(id) || seen.has(id)) continue
    seen.add(id)
    out.push(event)
  }
  return out
}

/**
 * The user sentence a quote pointer names. A label is not a sentence.
 * Seq 0, a missing row, and a bot row are not a sentence.
 * @param {{ roomId?: string, seq?: number } | undefined} quote
 * @param {Record<string, { seq?: number, who?: string, kind?: string, text?: string }[]>} [logs]
 */
export function quoteSentence(quote, logs) {
  if (quote == null || typeof quote !== 'object') return ''
  if (typeof quote.seq !== 'number' || !Number.isFinite(quote.seq) || quote.seq === 0) return ''
  const rows = logs?.[quote.roomId]
  if (!Array.isArray(rows)) return ''
  const row = rows.find(line => line?.seq === quote.seq)
  if (row == null || row.who !== 'User' || row.kind != null) return ''
  return typeof row.text === 'string' && row.text !== '' ? row.text : ''
}

const eventRoom = (event) => {
  if (hasId(event?.roomId)) return event.roomId
  if (hasId(event?.quote?.roomId)) return event.quote.roomId
  return undefined
}

/**
 * Completions for one room, oldest finish first.
 * @param {unknown[]} [events]
 * @param {{ roomId?: string, logs?: Record<string, { seq?: number, text?: string }[]> }} [scope]
 */
export function orderedCompletions(events, { roomId, logs } = {}) {
  const mine = dedupeCompletions(events).filter(event => eventRoom(event) === roomId)
  mine.sort((left, right) => {
    const at = (left.completedAt ?? 0) - (right.completedAt ?? 0)
    if (at !== 0) return at
    return String(left.exchangeId).localeCompare(String(right.exchangeId))
  })
  return mine.map(event => {
    const fromLog = quoteSentence(event.quote, logs)
    const quoteText = fromLog !== '' ? fromLog : (typeof event.quoteText === 'string' ? event.quoteText : '')
    const replyText = typeof event.reply === 'string' ? event.reply
      : (typeof event.replyText === 'string' ? event.replyText : '')
    const quotes = Array.isArray(event.quotes)
      ? event.quotes.filter(item => typeof item?.text === 'string' && item.text !== '').map(item => ({
        text: item.text,
        ...(typeof item.seq === 'number' && Number.isFinite(item.seq) ? { seq: item.seq } : {}),
        ...(typeof item.roomId === 'string' && item.roomId !== '' ? { roomId: item.roomId } : {}),
      }))
      : []
    return {
      exchangeId: event.exchangeId,
      workLineId: event.workLineId,
      ...(hasId(event.botId) ? { botId: event.botId } : {}),
      roomId: eventRoom(event),
      completedAt: event.completedAt,
      quoteText,
      ...(quotes.length > 1 ? { quotes } : {}),
      replyText,
    }
  })
}

const sameId = (left, right) => hasId(left) && left === right

const anchorsCompletion = (reply) => reply != null && (
  reply.kind === 'working' || reply.kind === undefined || reply.kind === 'completion-reply'
)

/**
 * Completions this cell may paint. A row anchors one only by workLineId or
 * exchangeId, and only when that row is the working or posted reply. Text is
 * not an anchor: two identical greetings must not steal each other's cell.
 * Input order is kept.
 * @param {unknown[]} [replies]
 * @param {unknown[]} [completions]
 */
export function anchoredCompletions(replies, completions) {
  const rows = Array.isArray(replies) ? replies : []
  const list = Array.isArray(completions) ? completions : []
  return list.filter(item => rows.some(reply => {
    if (!anchorsCompletion(reply)) return false
    return sameId(reply?.workLineId, item?.workLineId) || sameId(reply?.exchangeId, item?.exchangeId)
  }))
}

const isPostedReply = (reply, item) => {
  if (reply == null || reply.kind !== undefined) return false
  const text = typeof reply.text === 'string' ? reply.text : ''
  if (text === '') return false
  if (sameId(reply.exchangeId, item.exchangeId)) return true
  if (item.replyText === '' || text !== item.replyText) return false
  if (hasId(reply.botId) && hasId(item.botId) && reply.botId !== item.botId) return false
  return true
}

const isWorkingRow = (reply, item, items) => {
  if (reply?.kind !== 'working') return false
  if (hasId(reply.workLineId) || hasId(reply.exchangeId)) {
    return sameId(reply.workLineId, item.workLineId) || sameId(reply.exchangeId, item.exchangeId)
  }
  if (hasId(reply.botId) && hasId(item.botId) && reply.botId !== item.botId) return false
  if (hasId(reply.botId)) {
    const mates = items.filter(other => !hasId(other.botId) || other.botId === reply.botId)
    return mates.length === 1 && mates[0].exchangeId === item.exchangeId
  }
  return items.length === 1
}

/**
 * Hold the viewport only for a completion group: two finished lines, or the
 * first finish while a different line is still showing `working`.
 * @param {{ replies?: unknown[], completions?: { workLineId?: string, exchangeId?: string, botId?: string }[] }} [input]
 */
export function scrollGroup({ replies = [], completions = [] } = {}) {
  if (!Array.isArray(completions) || completions.length === 0) return false
  if (completions.length >= 2) return true
  const item = completions[0]
  return (Array.isArray(replies) ? replies : []).some(row => row?.kind === 'working' && !isWorkingRow(row, item, completions))
}

const quoteTextsOf = (item) => {
  if (Array.isArray(item?.quotes) && item.quotes.length > 1) {
    return item.quotes
      .map(entry => (typeof entry === 'string' ? entry : entry?.text))
      .filter(text => typeof text === 'string' && text !== '')
  }
  return typeof item?.quoteText === 'string' && item.quoteText !== '' ? [item.quoteText] : []
}

const quoteRows = (item) => quoteTextsOf(item).map(text => ({
  kind: 'completion-quote',
  exchangeId: item.exchangeId,
  workLineId: item.workLineId,
  who: 'User',
  text,
  completedAt: item.completedAt,
}))

const replyRow = (item) => {
  if (item.replyText === '') return undefined
  return {
    kind: 'completion-reply',
    exchangeId: item.exchangeId,
    workLineId: item.workLineId,
    ...(item.botId !== undefined ? { botId: item.botId } : {}),
    text: item.replyText,
    completedAt: item.completedAt,
  }
}

const itemRows = (item, anchor) => {
  const rows = []
  const quotes = quoteRows(item)
  const reply = replyRow(item)
  if (quotes.length > 0) rows.push(...quotes)
  if (reply !== undefined) rows.push(reply)
  if (anchor && rows[0] !== undefined) rows[0].first = true
  return rows
}

const repliesForDraft = (rows) => rows.map(row => (
  row?.kind === 'completion-reply' ? { botId: row.botId, text: row.text } : row
))

const pack = (replies, draft, completions) => ({
  replies,
  draft: clearDraftIfPosted(draft, repliesForDraft(replies)),
  completions,
})

const projectSingle = (replies, draft, item) => {
  const kept = []
  let workingAt = -1
  let postedAt = -1
  for (const reply of replies) {
    if (isWorkingRow(reply, item, [item])) {
      if (workingAt < 0) workingAt = kept.length
      continue
    }
    if (postedAt < 0 && isPostedReply(reply, item)) postedAt = kept.length
    kept.push(reply)
  }
  if (postedAt >= 0) {
    const quotes = quoteRows(item)
    if (quotes.length > 0) {
      quotes[0].first = true
      kept.splice(postedAt, 0, ...quotes)
    }
  } else {
    const at = workingAt < 0 ? kept.length : workingAt
    kept.splice(at, 0, ...itemRows(item, true))
  }
  return pack(kept, draft, [item])
}

const projectMany = (replies, draft, ordered) => {
  const kept = []
  let insertAt = -1
  for (const reply of replies) {
    const drop = ordered.some(item => isWorkingRow(reply, item, ordered) || isPostedReply(reply, item))
    if (drop) {
      if (insertAt < 0 && reply?.kind === 'working') insertAt = kept.length
      continue
    }
    kept.push(reply)
  }
  if (insertAt < 0) insertAt = kept.length
  const block = ordered.flatMap((item, index) => itemRows(item, index === 0))
  kept.splice(insertAt, 0, ...block)
  return pack(kept, draft, ordered)
}

/**
 * Project finished lines onto a render list. Input rows and logs are not mutated.
 * One completion stays where its reply was posted. Two or more share one block
 * ordered by completedAt, placed where the first working row sat.
 * @param {{ replies?: unknown[], draft?: { botId?: string, text?: string }, completions?: unknown[], roomId?: string, logs?: Record<string, { seq?: number, text?: string }[]> }} [input]
 */
export function projectRelay({ replies = [], draft, completions = [], roomId, logs } = {}) {
  const source = Array.isArray(replies) ? replies : []
  const ordered = orderedCompletions(completions, { roomId, logs })
  if (ordered.length === 0) {
    return { replies: source.slice(), draft: clearDraftIfPosted(draft, source), completions: [] }
  }
  if (ordered.length === 1) return projectSingle(source, draft, ordered[0])
  return projectMany(source, draft, ordered)
}
