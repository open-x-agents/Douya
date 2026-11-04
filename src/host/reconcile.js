// One card per thing on 今天. Every digest (bot or legacy) reconciles against the existing cards: each incoming
// card updates the card for the same entity in place (same id: chat, completions, itemStatus, pins, order kept)
// or, only if nothing matches, becomes a new card. A cleanup pass folds any duplicates into one canonical card.
// Nothing is hard-deleted: duplicates get status 'merged' (+ mergedInto), stale noise gets status 'archived'.

const DATED = /:(\d{4}-\d{2}-\d{2})$/
const SINGLETON = { hero: 'hero', timetable: 'timetable', 'achievements-tile': 'achievements', achievements: 'achievements' }
const HIDDEN = new Set(['merged'])
const TERMINAL = new Set(['done', 'dismissed', 'archived'])
const MAX_LINKS = 80
// Statuses 今天 shows; anything unknown from a builder (e.g. an old 'needs-review') is treated as active.
const KNOWN = new Set(['active', 'snoozed', 'waiting', 'done', 'dismissed', 'archived', 'merged'])
const liveStatus = s => (!s || !KNOWN.has(s) ? 'active' : s)

const dayOf = c => (String(c?.sourceId || '').match(DATED) || [])[1] || ''
export const stripDay = s => String(s || '').replace(DATED, '')
const repoOfUrl = u => (String(u || '').match(/github\.com\/([^/]+\/[^/#?]+)/) || [])[1] || null

/** Stable identity of a card, independent of the day. null = no natural key (manual tasks etc.). */
export function stableKey(card) {
  if (!card || typeof card !== 'object') return null
  if (SINGLETON[card.type]) return SINGLETON[card.type]
  const sid = typeof card.sourceId === 'string' ? card.sourceId : ''
  for (const p of ['hero', 'timetable', 'achievements']) if (sid === p || sid.startsWith(`${p}:`)) return p
  if (sid) {
    const k = stripDay(sid)
    const m = k.match(/^github:cluster:(.+)$/)
    return m ? `github:cluster:${m[1]}` : k
  }
  if (card.type === 'project-cluster') { const r = repoOfUrl(linkUrls(card)[0]); if (r) return `github:cluster:${r}` }
  return null
}

export function linkUrls(card) {
  const out = []
  for (const b of card?.blocks || []) for (const l of b?.links || []) if (l?.url) out.push(l.url)
  return out
}
const normTitle = t => String(t || '').toLowerCase().replace(/[\s\p{P}\p{S}\d]+/gu, '')
function bigrams(s) { const g = new Set(); for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2)); return g }
export function titleSim(a, b) {
  const x = normTitle(a), y = normTitle(b)
  if (!x || !y) return 0
  if (x === y) return 1
  const A = bigrams(x), B = bigrams(y); if (!A.size || !B.size) return 0
  let n = 0; for (const g of A) if (B.has(g)) n++
  return (2 * n) / (A.size + B.size)
}
const familyOf = c => c?.source || (String(c?.sourceId || '').split(':')[0]) || c?.type
const rank = c => (liveStatus(c.status) === 'active' ? 3 : c.status === 'snoozed' || c.status === 'waiting' ? 2 : TERMINAL.has(c.status) ? 1 : 0)

/**
 * Find the existing card for an incoming one: id, then stable key, then the bot's update:<id> hint, then fuzzy
 * (overlapping item URLs, or same type + very similar title).
 */
export function findMatch(incoming, existing, { byId, byKey } = {}) {
  const follow = c => { let x = c, hops = 0; while (x && HIDDEN.has(x.status) && x.mergedInto && hops++ < 5) x = byId.get(x.mergedInto) || null; return x && !HIDDEN.has(x.status) ? x : null }
  if (incoming.id && byId.has(incoming.id)) { const m = follow(byId.get(incoming.id)); if (m) return { card: m, how: 'id' } }
  const key = stableKey(incoming)
  if (key && byKey.has(key)) return { card: byKey.get(key), how: 'key' }
  const hint = String(incoming.metadata?.target || '').match(/^update:(.+)$/)?.[1]
  if (hint && byId.has(hint)) { const m = follow(byId.get(hint)); if (m && familyOf(m) === familyOf(incoming) && !SINGLETON[m.type]) return { card: m, how: 'hint' } }
  if (SINGLETON[incoming.type]) return null
  const urls = new Set(linkUrls(incoming))
  let best = null
  for (const c of existing) {
    if (HIDDEN.has(c.status) || SINGLETON[c.type]) continue
    const ck = stableKey(c)
    if (key && ck && ck !== key && c.type === incoming.type) continue // same kind, different entity
    const cu = linkUrls(c)
    let shared = 0; for (const u of cu) if (urls.has(u)) shared++
    const small = Math.min(urls.size, cu.length)
    const overlap = small >= 2 ? shared / small : 0
    const sim = c.type === incoming.type ? titleSim(c.title, incoming.title) : 0
    const score = overlap >= 0.6 ? 1 + overlap : (sim >= 0.9 && familyOf(c) === familyOf(incoming) ? sim : 0)
    if (score && (!best || score > best.score || (score === best.score && rank(c) > rank(best.card)))) best = { card: c, score, how: overlap >= 0.6 ? 'urls' : 'title' }
  }
  return best ? { card: best.card, how: best.how } : null
}

function unionLinks(newCard, oldCard) {
  const oldLL = (oldCard.blocks || []).find(b => b?.type === 'link-list')
  const ll = (newCard.blocks || []).find(b => b?.type === 'link-list')
  if (!oldLL?.links?.length) return
  if (!ll) { newCard.blocks = [...(newCard.blocks || []), { ...oldLL, links: oldLL.links.slice(0, MAX_LINKS) }]; return }
  const seen = new Set((ll.links || []).map(l => l?.url))
  ll.links = [...(ll.links || []), ...oldLL.links.filter(l => l?.url && !seen.has(l.url))].slice(0, MAX_LINKS)
}

/** Key the client uses for a card's zoom chat (see index.html chatKey). */
export function chatKeysOf(card) {
  const keys = new Set()
  const r = card.type === 'project-cluster' ? repoOfUrl(linkUrls(card)[0]) || (stableKey(card) || '').replace(/^github:cluster:/, '') : null
  if (card.type === 'timetable') keys.add('timetable')
  if (r && r.includes('/')) keys.add(`repo:${r}`)
  if (/^email-(group|cluster)/.test(card.type || '') && card.metadata?.group) keys.add(`mail:${card.metadata.group}`)
  if (card.sourceId) { keys.add(card.sourceId); keys.add(stripDay(card.sourceId)) }
  if (card.id) keys.add(card.id)
  return [...keys]
}
function moveChats(cardChats, from, to) {
  if (!cardChats) return 0
  const dst = stableKey(to) && to.sourceId ? stripDay(to.sourceId) : to.id
  const target = chatKeysOf(to).find(k => cardChats[k]?.length) || chatKeysOf(to).find(k => /^(repo|mail):|^timetable$/.test(k)) || dst
  let moved = 0
  for (const k of chatKeysOf(from)) {
    if (k === target || !cardChats[k]?.length) continue
    cardChats[target] = [...(cardChats[target] || []), ...cardChats[k]].sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(-40)
    delete cardChats[k]; moved++
  }
  return moved
}

/**
 * Reconcile a digest's cards against the stored cards.
 * @param {object[]} existing stored cards
 * @param {object[]} incoming digest cards (any shape; sourceIds may be day-scoped, they are made stable)
 * @param {object} opts { itemStatus, cardChats, seen?: Map(stableKey -> Set(url)) entities the source bots saw this
 *   run (to archive stale cards they judged noise), channels?: Set(source) whose bot succeeded, now }
 * @returns {{ cards, itemStatus, cardChats, stats }}
 */
export function reconcileCards(existing = [], incoming = [], opts = {}) {
  const now = opts.now || new Date().toISOString()
  const itemStatus = { ...(opts.itemStatus || {}) }
  const cardChats = opts.cardChats ? { ...opts.cardChats } : null
  const cards = existing.filter(c => c && typeof c === 'object').map(c => ({ ...c }))
  const stats = { created: 0, updated: 0, reopened: 0, keptDone: 0, hintUsed: 0, newBecameUpdate: 0, fuzzy: 0, archived: 0, merged: 0, createdKeys: [], updatedIds: [] }
  const index = () => {
    const byId = new Map(cards.map(c => [c.id, c]))
    const byKey = new Map()
    for (const c of cards) { if (HIDDEN.has(c.status)) continue; const k = stableKey(c); if (!k) continue; const cur = byKey.get(k); if (!cur || rank(c) > rank(cur) || (rank(c) === rank(cur) && String(c.updatedAt) > String(cur.updatedAt))) byKey.set(k, c) }
    return { byId, byKey }
  }
  // Clean up first, so incoming cards land on the one canonical card.
  for (const c of cards) if (!KNOWN.has(c.status || 'active')) c.status = 'active'
  stats.merged += dedupe(cards, { itemStatus, cardChats, now })
  let idx = index()
  const touched = new Set()
  for (const raw of incoming) {
    if (!raw || typeof raw !== 'object') continue
    const key = stableKey(raw)
    const inc = { ...raw, sourceId: key && raw.sourceId ? (SINGLETON[raw.type] || key === 'hero' || key === 'timetable' || key === 'achievements' ? key : key) : raw.sourceId }
    const m = findMatch(inc, cards, idx)
    if (m && touched.has(m.card.id) && m.how !== 'id') {
      // two incoming cards for one existing card: fold the second into the first's update
      unionLinks(m.card, inc); continue
    }
    if (!m) {
      const id = inc.id && !idx.byId.has(inc.id) ? inc.id : `card_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
      const c = { ...inc, id, status: liveStatus(inc.status), createdAt: inc.createdAt || now, updatedAt: now }
      cards.push(c); touched.add(id); stats.created++; stats.createdKeys.push(key || c.title)
      idx = index(); continue
    }
    const old = m.card
    if (m.how === 'hint') stats.hintUsed++
    if (m.how === 'urls' || m.how === 'title') stats.fuzzy++
    if (String(raw.metadata?.target || '') === 'new') stats.newBecameUpdate++
    const oldUrls = new Set(linkUrls(old))
    const doneUrl = u => ['done', 'dismissed'].includes(itemStatus[u]?.status)
    if (TERMINAL.has(old.status)) {
      const fresh = linkUrls(inc).filter(u => !oldUrls.has(u) && !doneUrl(u))
      if (!fresh.length) { stats.keptDone++; touched.add(old.id); continue }
      // Genuinely new items: reopen with only those pending; the old items count as handled. Completion record kept.
      for (const u of oldUrls) if (!itemStatus[u]) itemStatus[u] = { status: 'done', at: now, by: 'system', cardId: old.id, reason: 'card-was-done' }
      stats.reopened++
    }
    inc.status = inc.status && KNOWN.has(inc.status) ? inc.status : 'active'
    const next = { ...old, ...inc, id: old.id, sourceId: key || old.sourceId, createdAt: old.createdAt || now, updatedAt: now,
      status: TERMINAL.has(old.status) ? 'active' : (inc.status && inc.status !== 'active' ? inc.status : old.status === 'snoozed' ? 'snoozed' : 'active') }
    for (const f of ['pinned', 'completedAt', 'completedBy', 'dismissedAt', 'snoozedUntil', 'userTitle']) if (old[f] !== undefined && inc[f] === undefined) next[f] = old[f]
    if (TERMINAL.has(old.status)) { next.reopenedAt = now; next.previousStatus = old.status; delete next.archivedAt; delete next.archivedReason }
    unionLinks(next, old)
    if (cardChats && m.how !== 'id') moveChats(cardChats, old, next)
    cards[cards.indexOf(old)] = next
    touched.add(old.id); stats.updated++; stats.updatedIds.push(old.id)
    idx = index()
  }
  // Stale noise: an active card of a channel whose bot ran OK, not produced this run, with nothing new -> archived.
  if (opts.seen && opts.channels) {
    for (const c of cards) {
      if (touched.has(c.id) || !(c.status === 'active' || !c.status) || SINGLETON[c.type] || c.pinned) continue
      if (!opts.channels.has(c.source) || !(/-cluster$/.test(c.type || '') && !/^email/.test(c.type))) continue
      const k = stableKey(c); if (!k) continue
      const have = new Set(linkUrls(c))
      const fresh = [...(opts.seen.get(k) || [])].filter(u => !have.has(u))
      if (fresh.length) continue
      c.status = 'archived'; c.archivedAt = now; c.archivedReason = 'digest: no new activity, not picked by the source bot'
      stats.archived++
    }
  }
  stats.merged += dedupe(cards, { itemStatus, cardChats, now })
  return { cards, itemStatus, cardChats, stats }
}

/**
 * Fold duplicates (same stable key, or keyless cards of the same type with the same title, or heavy URL overlap)
 * into one canonical card: links united, chats moved; others become status 'merged' + mergedInto. In place.
 * @returns {number} cards merged
 */
export function dedupe(cards, { itemStatus = {}, cardChats = null, now = new Date().toISOString() } = {}) {
  const groups = new Map()
  for (const c of cards) {
    if (!c || HIDDEN.has(c.status)) continue
    const k = stableKey(c) || (c.title ? `t:${c.type}:${normTitle(c.title)}` : null)
    if (!k) continue
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(c)
  }
  let merged = 0
  for (const [, list] of groups) {
    if (list.length < 2) continue
    const live = list.filter(c => rank(c) >= 2)
    if (!live.length) continue // only done/archived copies: leave their records alone
    // canonical: pinned, else the one with chat history, else most recently updated
    const hasChat = c => !!cardChats && chatKeysOf(c).some(k => cardChats[k]?.length)
    const canon = [...live].sort((a, b) => (!!b.pinned - !!a.pinned) || (hasChat(b) - hasChat(a)) || dayOf(b).localeCompare(dayOf(a)) || String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)))[0]
    for (const c of list) {
      if (c === canon) continue
      if (TERMINAL.has(c.status)) { c.mergedInto = canon.id; continue } // keep done/dismissed status + completion
      unionLinks(canon, c)
      if (cardChats) moveChats(cardChats, c, canon)
      c.status = 'merged'; c.mergedInto = canon.id; c.mergedAt = now; c.mergedReason = 'duplicate'
      if (c.pinned && !canon.pinned) canon.pinned = c.pinned
      merged++
    }
    const k = stableKey(canon); if (k && canon.sourceId && canon.sourceId !== k) canon.sourceId = k
  }
  // URL-overlap duplicates across different keys (e.g. a legacy per-repo copy under another id scheme)
  const live = cards.filter(c => liveStatus(c.status) === 'active' && !SINGLETON[c.type])
  for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
    const a = live[i], b = live[j]
    if (a.status === 'merged' || b.status === 'merged' || a.type !== b.type) continue
    const ka = stableKey(a), kb = stableKey(b); if (ka && kb && ka !== kb) continue
    const ua = linkUrls(a), ub = new Set(linkUrls(b)); const small = Math.min(ua.length, ub.size)
    if (small < 2) continue
    let s = 0; for (const u of ua) if (ub.has(u)) s++
    if (s / small < 0.8) continue
    const [canon, dup] = String(a.updatedAt) >= String(b.updatedAt) ? [a, b] : [b, a]
    unionLinks(canon, dup); if (cardChats) moveChats(cardChats, dup, canon)
    dup.status = 'merged'; dup.mergedInto = canon.id; dup.mergedAt = now; dup.mergedReason = 'duplicate-items'; merged++
  }
  return merged
}

/** Active cards that still share a stable key (should be 0). */
export function duplicateCount(cards = []) {
  const seen = new Map(); let d = 0
  for (const c of cards) { if (liveStatus(c.status) !== 'active') continue; const k = stableKey(c) || `t:${c.type}:${normTitle(c.title)}`; if (seen.has(k)) d++; else seen.set(k, 1) }
  return d
}
