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

function sameOpening(item, opening) {
  if (item == null || opening == null || typeof opening !== 'object') return false
  const seq = typeof opening.seq === 'number' && Number.isFinite(opening.seq) ? opening.seq
    : (typeof opening.quoteSeq === 'number' && Number.isFinite(opening.quoteSeq) ? opening.quoteSeq : undefined)
  const roomId = typeof opening.roomId === 'string' && opening.roomId !== '' ? opening.roomId
    : (typeof opening.quoteRoomId === 'string' && opening.quoteRoomId !== '' ? opening.quoteRoomId : undefined)
  if (seq === undefined || roomId === undefined) return false
  return item.seq === seq && (item.roomId ?? '') === roomId
}

/**
 * Sentences a late reply may show. Steered follow-ups stay in send order.
 * The work line's opening sentence is the prompt already on screen, so it is not
 * repeated in the cite once a follow-up has been steered in.
 * With no follow-up, the trigger's own cite is unchanged.
 * @param {unknown} info
 * @param {unknown[] | undefined} steers
 * @param {{ seq?: number, roomId?: string, quoteSeq?: number, quoteRoomId?: string } | undefined} opening
 */
export function visibleRoomCites(info, steers, opening) {
  const follow = []
  for (const item of Array.isArray(steers) ? steers : []) {
    const cite = asCite(item)
    if (cite !== undefined) follow.push(cite)
  }
  if (follow.length === 0) return citesOf(info)
  const trigger = citesOf(info).filter(item => !sameOpening(item, opening))
  return mergeCites(trigger, follow)
}

/**
 * Cite fields for a late reply. Flat quote fields are removed so a prompt
 * still sitting on the trigger cannot leak back in beside `quotes`.
 * @param {Record<string, unknown> | undefined} info
 * @param {unknown[] | undefined} quotes
 */
export function citeCarrier(info, quotes) {
  const list = []
  for (const item of Array.isArray(quotes) ? quotes : []) {
    const cite = asCite(item)
    if (cite !== undefined) list.push(cite)
  }
  if (list.length === 0) return info
  const next = { ...(info ?? {}) }
  delete next.quoteText
  delete next.quoteSeq
  delete next.quoteRoomId
  next.quotes = list
  return next
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

/** Sentences a late-cite row paints, in order. A list wins; otherwise the one flat sentence. */
export function lateCiteSentences(text, texts) {
  if (Array.isArray(texts) && texts.length > 0) {
    return texts.filter(sentence => typeof sentence === 'string' && sentence !== '')
  }
  return typeof text === 'string' && text !== '' ? [text] : []
}

function escapeCiteText(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttr(text) {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * The late-cite row as HTML: one marker, then the user's bubbles in send order.
 * The painter and the acceptance check share this shape.
 * @param {unknown[] | undefined} texts
 */
export function lateCiteHtml(texts) {
  const sentences = lateCiteSentences(undefined, texts)
  const bubbles = sentences.map(sentence => `<div class="bt-urow"><div class="bt-ububble">${escapeCiteText(sentence)}</div></div>`).join('')
  const marked = sentences.length > 0 ? ` data-cite-texts="${escapeAttr(JSON.stringify(sentences))}"` : ''
  return `<div class="bt-route-cite" data-late-cite=""${marked}>${bubbles}</div>`
}

/**
 * Two or more completion quotes of one exchange become one late cite.
 * A single quote stays a completion quote. Other rows are unchanged.
 * @param {unknown[] | undefined} replies
 */
export function groupCitedQuotes(replies) {
  const rows = Array.isArray(replies) ? replies : []
  /** @type {unknown[]} */
  const out = []
  /** @type {any[]} */
  let batch = []
  const flush = () => {
    if (batch.length === 0) return
    if (batch.length === 1) out.push(batch[0])
    else {
      const first = batch[0]
      out.push({
        kind: 'completion-cite',
        ...(first.exchangeId !== undefined ? { exchangeId: first.exchangeId } : {}),
        ...(first.workLineId !== undefined ? { workLineId: first.workLineId } : {}),
        texts: batch.map(row => row.text).filter(text => typeof text === 'string' && text !== ''),
        ...(batch.some(row => row.first === true) ? { first: true } : {}),
        ...(first.completedAt !== undefined ? { completedAt: first.completedAt } : {}),
      })
    }
    batch = []
  }
  for (const reply of rows) {
    if (reply?.kind === 'completion-quote' && reply.who === 'User') batch.push(reply)
    else {
      flush()
      out.push(reply)
    }
  }
  flush()
  return out
}

/**
 * Flags for a steered reply posted after the round has returned.
 * Two or more sentences are one late cite. A later remainder of the same turn
 * does not add a second cite. A post that does not @mention anyone stays quiet
 * so it does not call a member.
 * @param {{ cites?: unknown[], shown?: boolean, calls?: boolean }} [input]
 */
export function steeredReplyPost({ cites = [], shown = false, calls = false } = {}) {
  const list = []
  for (const item of Array.isArray(cites) ? cites : []) {
    const cite = asCite(item)
    if (cite !== undefined) list.push(cite)
  }
  const late = shown !== true && list.length > 1
  return {
    quiet: calls !== true,
    ...(late ? { late: true, ...lateCite({ quotes: list }) } : {}),
  }
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
 * Mark the user row a steering reply is already showing. No bot line is required.
 * @param {unknown[]} log
 * @param {{ seq?: number, messageId?: string, text?: string }} [fields]
 * @returns {{ changed: boolean, messageId?: string }}
 */
export function markSteeredRow(log, { seq, messageId, text } = {}) {
  const rows = Array.isArray(log) ? log : []
  let row
  if (typeof seq === 'number' && Number.isFinite(seq)) {
    row = rows.find(item => item?.seq === seq && item?.who === 'User' && item.kind == null)
  }
  if (row == null && typeof messageId === 'string' && messageId !== '') {
    row = rows.find(item => item?.messageId === messageId && item?.who === 'User' && item.kind == null)
  }
  if (row == null && typeof text === 'string' && text !== '') {
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const item = rows[index]
      if (item?.who === 'User' && item.kind == null && item.text === text) {
        row = item
        break
      }
    }
  }
  const passedId = typeof messageId === 'string' && messageId !== '' ? messageId : undefined
  if (row == null) return { changed: false, ...(passedId !== undefined ? { messageId: passedId } : {}) }
  let changed = row.steered !== true
  if (changed) row.steered = true
  // The later user/message uses this inbox id. Stamp it when the row was logged without one.
  if (passedId !== undefined && row.messageId !== passedId && (typeof row.messageId !== 'string' || row.messageId === '')) {
    row.messageId = passedId
    changed = true
  }
  const id = typeof row.messageId === 'string' && row.messageId !== '' ? row.messageId : passedId
  return { changed, ...(id !== undefined ? { messageId: id } : {}) }
}

/** Pending host bubble text, without the unread label the stylesheet paints after it. */
export function steerCopyText(raw) {
  return String(raw ?? '').replace(/\u00a0/g, ' ').replace(/\s*(?:未读|Not read yet)\s*$/u, '').trim()
}

/** True when this pending bubble repeats a sentence the round is already showing. */
export function isPendingSteerCopy(raw, steeringTexts) {
  const text = steerCopyText(raw)
  const list = (Array.isArray(steeringTexts) ? steeringTexts : []).filter(item => typeof item === 'string' && item !== '')
  if (text === '' || list.length === 0) return false
  if (list.includes(text)) return true
  // A clock or the unread label can sit on its own line under the sentence.
  return text.split(/\n+/).map(line => steerCopyText(line)).some(line => line !== '' && list.includes(line))
}

/**
 * User sentences a room log's bot rows point at, plus rows already shown as steering
 * replies, and the message ids on those rows. Bot text is not a sentence.
 * @param {{ seq?: number, who?: string, kind?: string, text?: string, messageId?: string, steered?: boolean, quote?: { seq?: number, roomId?: string }, quotes?: { seq?: number, roomId?: string }[] }[]} [log]
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
  for (const row of rows) {
    if (row?.steered === true) add(row)
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

const CLOCK_LINE = /^(?:\d{1,2}:\d{2}(?:\s*[AP]M)?|未读|Not read yet)$/i
const GLUED_TAIL = /(?:\s*(?:\d{1,2}:\d{2}(?:\s*[AP]M)?|未读|Not read yet))+$/i

// Sentences the cite itself names. Markdown inside the bubble can add a control
// such as a copy label; that text is not the sentence.
function citeSentences(cite) {
  const raw = cite.getAttribute?.('data-cite-texts')
  if (typeof raw === 'string' && raw !== '') {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsed.filter(item => typeof item === 'string' && item !== '')
    } catch { /* the bubble text is the fallback */ }
  }
  const out = []
  for (const bubble of cite.querySelectorAll('.bt-ububble')) {
    const text = String(bubble.textContent ?? '').replace(/\u00a0/g, ' ').trim()
    if (text !== '' && !out.includes(text)) out.push(text)
  }
  return out
}

// Ways this host node can be the same sentence. The desktop glues a clock or
// the unread label onto the bubble, sometimes with no newline between them.
function candidateTexts(node) {
  const raw = String(node?.textContent ?? '').replace(/\u00a0/g, ' ').trim()
  if (raw === '') return []
  const out = []
  const add = (value) => {
    const text = String(value ?? '').replace(/[ \t]+/g, ' ').trim()
    if (text !== '' && !out.includes(text)) out.push(text)
  }
  add(raw)
  const lines = raw.split(/\n+/).map(line => line.trim()).filter(line => line !== '' && !CLOCK_LINE.test(line))
  if (lines.length === 1) add(lines[0])
  add(raw.replace(GLUED_TAIL, ''))
  return out
}

function isBefore(node, other) {
  if (node == null || other == null || typeof node.compareDocumentPosition !== 'function') return false
  const following = node.DOCUMENT_POSITION_FOLLOWING ?? 4
  return (node.compareDocumentPosition(other) & following) !== 0
}

function userRow(node) {
  return node.closest?.('[data-chat-flow-kind="user"]')
    ?? node.closest?.('.bt-umsg')
    ?? node.closest?.('[data-pending-steering]')
    ?? node.closest?.('[class*="_userRow"]')
    ?? null
}

function hideRow(node) {
  return node.closest?.('[class*="_flowItem"]')
    ?? node.closest?.('[data-chat-flow-kind="user"]')
    ?? node.closest?.('.bt-umsg')
    ?? node.closest?.('[data-pending-steering]')
    ?? node
}

function skippedCopy(node) {
  return node.closest?.('[data-late-cite]') != null
    || node.closest?.('.bt-route-dock') != null
    || node.closest?.('[data-route-dock]') != null
}

/**
 * Hide the desktop's own history bubbles once a late cite has painted those
 * sentences. The cite's bubbles, the ask card, and a later send of the same
 * words stay. Returns how many rows were hidden.
 * The host draws the history bubble itself. UserMessageCell is not mounted
 * when the desktop has no text projection, so this walks the document.
 * @param {ParentNode | undefined} doc
 */
export function hideCitedHostBubbles(doc = globalThis.document) {
  if (doc == null || typeof doc.querySelectorAll !== 'function') return 0
  const cites = [...doc.querySelectorAll('[data-late-cite]')]
  /** @type {Map<string, Element[]>} */
  const byText = new Map()
  for (const cite of cites) {
    for (const text of citeSentences(cite)) {
      const list = byText.get(text) ?? []
      list.push(cite)
      byText.set(text, list)
    }
  }
  const roots = new Set()
  for (const cite of cites) roots.add(cite.closest?.('[data-conversation-scroll]') ?? doc.body ?? doc)
  if (roots.size === 0) roots.add(doc.body ?? doc)
  const hide = new Set()
  for (const root of roots) {
    if (root == null || typeof root.querySelectorAll !== 'function') continue
    for (const node of root.querySelectorAll('*')) {
      if (skippedCopy(node)) continue
      const row = userRow(node)
      if (row == null) continue
      const candidates = candidateTexts(node)
      const text = candidates.find(item => byText.has(item))
      const owners = text === undefined ? undefined : byText.get(text)
      if (owners == null || owners.length === 0) continue
      // A child with the same sentence is the tighter match. Hide that row once.
      const tighter = [...node.querySelectorAll('*')].some(child => {
        if (skippedCopy(child) || userRow(child) == null) return false
        return candidateTexts(child).includes(text)
      })
      if (tighter) continue
      // Hide the copy that sits above the cite. A send that follows the cite stays,
      // including one that repeats the same words.
      const citedAfter = owners.some(cite => isBefore(node, cite))
      const citedBefore = owners.some(cite => isBefore(cite, node))
      if (!citedAfter || citedBefore) continue
      hide.add(hideRow(node))
    }
  }
  for (const root of roots) {
    if (root == null || typeof root.querySelectorAll !== 'function') continue
    for (const node of root.querySelectorAll('[data-cited-history]')) {
      if (!hide.has(node)) node.removeAttribute('data-cited-history')
    }
  }
  for (const node of hide) {
    if (node.getAttribute?.('data-cited-history') !== '1') node.setAttribute('data-cited-history', '1')
  }
  return hide.size
}

let citedWatchers = 0
let citedObserver
let citedFrame = 0

// One observer for every late cite on the page. History bubbles can land
// after the cite's first paint; the observer hides those too.
export function watchCitedHostBubbles(doc = globalThis.document) {
  if (doc == null || typeof doc.querySelectorAll !== 'function') return () => {}
  citedWatchers += 1
  hideCitedHostBubbles(doc)
  if (citedWatchers === 1 && typeof MutationObserver === 'function') {
    const root = (typeof doc.querySelector === 'function' ? doc.querySelector('[data-conversation-scroll]') : null) ?? doc.body
    if (root != null) {
      const schedule = () => {
        if (citedFrame !== 0) return
        const raf = doc.defaultView?.requestAnimationFrame ?? globalThis.requestAnimationFrame
        if (typeof raf !== 'function') {
          hideCitedHostBubbles(doc)
          return
        }
        citedFrame = raf(() => {
          citedFrame = 0
          hideCitedHostBubbles(doc)
        })
      }
      citedObserver = new MutationObserver(schedule)
      citedObserver.observe(root, { childList: true, subtree: true, characterData: true })
    }
  }
  return () => {
    citedWatchers = Math.max(0, citedWatchers - 1)
    if (citedWatchers > 0) {
      hideCitedHostBubbles(doc)
      return
    }
    citedObserver?.disconnect()
    citedObserver = undefined
    const cancel = doc.defaultView?.cancelAnimationFrame ?? globalThis.cancelAnimationFrame
    if (citedFrame !== 0 && typeof cancel === 'function') cancel(citedFrame)
    citedFrame = 0
    if (typeof doc.querySelectorAll === 'function') {
      for (const node of doc.querySelectorAll('[data-cited-history]')) node.removeAttribute('data-cited-history')
    }
  }
}
