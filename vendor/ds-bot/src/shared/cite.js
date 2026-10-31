// Sentences a late reply quotes. One sentence keeps the old flat fields.
// Two or more also travel as `quotes`, in the order the user sent them.

/**
 * @param {{ text?: string, seq?: number, roomId?: string, quoteText?: string, quoteSeq?: number, quoteRoomId?: string } | string | undefined} item
 * @returns {{ text: string, seq?: number, roomId?: string } | undefined}
 */
function asCite(item) {
  if (typeof item === 'string') return item === '' ? undefined : { text: item }
  if (item == null || typeof item !== 'object') return undefined
  const text = typeof item.quoteText === 'string' && item.quoteText !== '' ? item.quoteText
    : (typeof item.text === 'string' && item.text !== '' ? item.text : '')
  if (text === '') return undefined
  const seq = typeof item.quoteSeq === 'number' && Number.isFinite(item.quoteSeq) ? item.quoteSeq
    : (typeof item.seq === 'number' && Number.isFinite(item.seq) ? item.seq : undefined)
  const roomId = typeof item.quoteRoomId === 'string' && item.quoteRoomId !== '' ? item.quoteRoomId
    : (typeof item.roomId === 'string' && item.roomId !== '' ? item.roomId : undefined)
  return {
    text,
    ...(seq !== undefined ? { seq } : {}),
    ...(roomId !== undefined ? { roomId } : {}),
  }
}

/** One user sentence from a delivery source or a stored cite. */
export function citeItem(source) {
  return asCite(source)
}

function sameCite(left, right) {
  const leftSeq = typeof left.seq === 'number'
  const rightSeq = typeof right.seq === 'number'
  if (leftSeq && rightSeq) return left.seq === right.seq && (left.roomId ?? '') === (right.roomId ?? '')
  return left.text === right.text
}

/** Append one sentence. Same seq+room, or the same text when a seq is missing, is one sentence. */
export function appendCite(list, item) {
  const cite = asCite(item)
  const base = Array.isArray(list) ? list.filter(other => other != null) : []
  if (cite === undefined) return base.slice()
  if (base.some(other => sameCite(asCite(other) ?? { text: '' }, cite))) return base.slice()
  return [...base, cite]
}

/** Left group stays in front. Later copies of the same sentence drop out. */
export function mergeCites(left, right) {
  let out = []
  for (const item of [...(Array.isArray(left) ? left : []), ...(Array.isArray(right) ? right : [])]) {
    out = appendCite(out, item)
  }
  return out
}

/** Sentences already stored on a trigger: its `quotes` list, then its flat quote. */
export function citesOf(info) {
  if (info == null || typeof info !== 'object') return []
  const listed = Array.isArray(info.quotes) ? info.quotes : []
  const flat = asCite({ quoteText: info.quoteText, quoteSeq: info.quoteSeq, quoteRoomId: info.quoteRoomId })
  return mergeCites(listed, flat === undefined ? [] : [flat])
}

/**
 * Cite carried on a late room reply. Empty when this turn did not log a user sentence.
 * A single sentence stays `{ quoteText, quoteSeq?, quoteRoomId? }`.
 * @param {{ quoteText?: string, quoteSeq?: number, quoteRoomId?: string, quotes?: unknown[] } | undefined} info
 */
export function lateCite(info) {
  const list = citesOf(info)
  if (list.length === 0) return {}
  const first = list[0]
  /** @type {{ quoteText: string, quoteSeq?: number, quoteRoomId?: string, quotes?: { text: string, seq?: number, roomId?: string }[] }} */
  const cite = { quoteText: first.text }
  if (typeof first.seq === 'number') cite.quoteSeq = first.seq
  if (typeof first.roomId === 'string') cite.quoteRoomId = first.roomId
  if (list.length > 1) cite.quotes = list
  return cite
}

/** Sentences to paint, in order. A `quotes` list wins; otherwise the one flat sentence. */
export function citeTexts(source) {
  if (Array.isArray(source?.quotes) && source.quotes.length > 0) {
    return source.quotes
      .map(item => (typeof item === 'string' ? item : item?.text))
      .filter(text => typeof text === 'string' && text !== '')
  }
  return typeof source?.quoteText === 'string' && source.quoteText !== '' ? [source.quoteText] : []
}

/**
 * Pointers to store beside the first quote when a reply names more than one user row.
 * @param {{ quotes?: { seq?: number, roomId?: string }[] } | undefined} named
 * @param {string} [roomId]
 */
export function logQuotes(named, roomId) {
  const list = Array.isArray(named?.quotes) ? named.quotes : []
  if (list.length <= 1) return []
  const fallback = typeof roomId === 'string' && roomId !== '' ? roomId : undefined
  const out = []
  for (const item of list) {
    if (typeof item?.seq !== 'number' || !Number.isFinite(item.seq)) continue
    const where = typeof item.roomId === 'string' && item.roomId !== '' ? item.roomId : fallback
    if (where === undefined) continue
    out.push({ roomId: where, seq: item.seq })
  }
  return out.length > 1 ? out : []
}

/**
 * Room-log pointer for a cite. One sentence is `quote`. Two or more also store `quotes`.
 * @param {{ quoteSeq?: number, quoteRoomId?: string, quotes?: { seq?: number, roomId?: string }[] } | undefined} named
 * @param {string} [roomId]
 */
export function logPointer(named, roomId) {
  const fallback = typeof named?.quoteRoomId === 'string' && named.quoteRoomId !== '' ? named.quoteRoomId
    : (typeof roomId === 'string' && roomId !== '' ? roomId : undefined)
  const pointer = typeof named?.quoteSeq === 'number' && Number.isFinite(named.quoteSeq) && fallback !== undefined
    ? { quote: { roomId: fallback, seq: named.quoteSeq } }
    : {}
  const quotes = logQuotes(named, fallback)
  return quotes.length > 1 ? { ...pointer, quotes } : pointer
}

/**
 * What an in-round post quotes. A cite the caller already has wins.
 * Otherwise the sentences this round is already showing as steering replies.
 * @param {{ quoteText?: string, quoteSeq?: number, quoteRoomId?: string, quotes?: unknown[] } | undefined} cite
 * @param {unknown[] | undefined} steerCites
 */
export function citeForPost(cite, steerCites) {
  if (citesOf(cite).length > 0) return lateCite(cite)
  if (Array.isArray(steerCites) && steerCites.length > 0) return lateCite({ quotes: steerCites })
  return {}
}

/**
 * One steered sentence. `seq` comes from the caller, or from the latest matching user row.
 * @param {{ id?: string, log?: { who?: string, kind?: string, text?: string, seq?: number }[] } | undefined} room
 * @param {{ text?: string, quoteText?: string, quoteSeq?: number, quoteRoomId?: string }} [fields]
 */
export function steerSentence(room, { text = '', quoteText, quoteSeq, quoteRoomId } = {}) {
  const sentence = typeof quoteText === 'string' && quoteText !== '' ? quoteText : (typeof text === 'string' ? text : '')
  if (sentence === '') return undefined
  let seq = typeof quoteSeq === 'number' && Number.isFinite(quoteSeq) ? quoteSeq : undefined
  const where = typeof quoteRoomId === 'string' && quoteRoomId !== '' ? quoteRoomId
    : (typeof room?.id === 'string' && room.id !== '' ? room.id : undefined)
  if (seq === undefined && Array.isArray(room?.log)) {
    for (let index = room.log.length - 1; index >= 0; index -= 1) {
      const row = room.log[index]
      if (row?.who === 'User' && row.kind == null && row.text === sentence && typeof row.seq === 'number' && Number.isFinite(row.seq)) {
        seq = row.seq
        break
      }
    }
  }
  return asCite({
    text: sentence,
    ...(seq !== undefined ? { seq } : {}),
    ...(where !== undefined ? { roomId: where } : {}),
  })
}

/**
 * Point a bot line already in the log at these sentences. Returns that row's index, or -1.
 * A line from before `minSeq` stays as it was.
 * @param {unknown[]} log
 * @param {{ quote?: { roomId: string, seq: number }, quotes?: { roomId: string, seq: number }[] } | undefined} pointer
 * @param {{ minSeq?: number }} [options]
 */
export function applyLogPointer(log, pointer, options = {}) {
  if (pointer == null || pointer.quote == null) return -1
  const rows = Array.isArray(log) ? log : []
  const minSeq = typeof options.minSeq === 'number' && Number.isFinite(options.minSeq) ? options.minSeq : undefined
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]
    if (row == null || typeof row !== 'object') continue
    if (row.botId == null || row.kind != null) continue
    if (typeof row.text !== 'string' || row.text === '') continue
    if (minSeq !== undefined && typeof row.seq === 'number' && row.seq < minSeq) continue
    row.quote = pointer.quote
    if (Array.isArray(pointer.quotes) && pointer.quotes.length > 1) row.quotes = pointer.quotes
    else delete row.quotes
    return index
  }
  return -1
}

/**
 * User sentences a room log's bot rows point at, plus the message ids on those rows.
 * Bot text is not a sentence.
 * @param {{ seq?: number, who?: string, kind?: string, text?: string, messageId?: string, quote?: { seq?: number, roomId?: string }, quotes?: { seq?: number, roomId?: string }[] }[]} [log]
 * @param {string} [roomId]
 */
export function citedFromLog(log, roomId) {
  const rows = Array.isArray(log) ? log : []
  const texts = []
  const ids = []
  const seenText = new Set()
  const seenId = new Set()
  const add = (row) => {
    if (row == null || row.who !== 'User' || row.kind != null) return
    if (typeof row.text === 'string' && row.text !== '' && !seenText.has(row.text)) {
      seenText.add(row.text)
      texts.push(row.text)
    }
    if (typeof row.messageId === 'string' && row.messageId !== '' && !seenId.has(row.messageId)) {
      seenId.add(row.messageId)
      ids.push(row.messageId)
    }
  }
  for (const line of rows) {
    const pointers = []
    if (line?.quote != null && typeof line.quote === 'object') pointers.push(line.quote)
    if (Array.isArray(line?.quotes)) pointers.push(...line.quotes)
    for (const pointer of pointers) {
      if (typeof pointer?.seq !== 'number' || !Number.isFinite(pointer.seq)) continue
      if (typeof roomId === 'string' && roomId !== '' && typeof pointer.roomId === 'string' && pointer.roomId !== '' && pointer.roomId !== roomId) continue
      add(rows.find(row => row?.seq === pointer.seq))
    }
  }
  return { texts, ids }
}

/**
 * Hide the history bubble once a later reply quotes that same send.
 * A later send of the same words, with its own id, stays.
 * @param {{ text?: string, messageId?: string, citedTexts?: string[], citedIds?: string[] }} [input]
 */
export function hideCitedHistory({ text, messageId, citedTexts, citedIds } = {}) {
  const cited = Array.isArray(citedIds) ? citedIds : []
  const sentences = Array.isArray(citedTexts) ? citedTexts : []
  if (typeof messageId === 'string' && messageId !== '' && cited.includes(messageId)) return true
  if (typeof messageId === 'string' && messageId !== '' && cited.length > 0) return false
  return typeof text === 'string' && text !== '' && sentences.includes(text)
}
