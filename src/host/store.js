// One JSON file for everything the plugin remembers. Written through a temp file
// and a rename, so a crash mid-write leaves the previous file intact.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fixRepoCard } from '../web/repo-copy.js'
import { reconcileCards, dedupe } from './reconcile.js'

/** Statuses a digest must not overwrite with a fresh "active" copy. */
export const TERMINAL_CARD_STATUSES = new Set(['done', 'dismissed'])

export function emptyState() {
  return {
    revision: 0,
    members: {},
    reports: {},
    sent: {},
    manual: [],
    deliveries: [],
    upcoming: [],
    days: {},
    sources: {},
    week: [],
    prefs: {},
    cards: [],
    // Durable completion / dismiss ledger — digests never clear this.
    completions: [],
    // Per-item (link) status keyed by item url — survives digests, new card ids, restarts.
    itemStatus: {},
    // Layout the user / bot set on 今天 (pins, order, filter, highlights) and the log of view ops (with undo).
    ui: { layout: { pins: [], order: null }, filter: null, highlights: [] },
    uiLog: [],
    // Temporary views Chief generated (odm_ui_render), by id; expire at day end unless saved as a card.
    surfaces: {},
    lastDigest: null,
  }
}

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

// One ledger entry per item url (the latest wins); card-level entries are kept as-is.
function dedupeItemCompletions(list) {
  const lastIdx = new Map()
  list.forEach((c, i) => { if (c?.kind === 'item' && c.itemUrl) lastIdx.set(c.itemUrl, i) })
  return list.filter((c, i) => !(c?.kind === 'item' && c.itemUrl) || lastIdx.get(c.itemUrl) === i)
}

export function normalizeState(raw) {
  const base = emptyState()
  if (raw === null || typeof raw !== 'object') return base
  return {
    ...base,
    ...raw,
    members: raw.members ?? {},
    reports: raw.reports ?? {},
    sent: raw.sent ?? {},
    manual: Array.isArray(raw.manual) ? raw.manual : [],
    deliveries: Array.isArray(raw.deliveries) ? raw.deliveries : [],
    upcoming: Array.isArray(raw.upcoming) ? raw.upcoming : [],
    days: isRecord(raw.days) ? raw.days : {},
    sources: isRecord(raw.sources) ? raw.sources : {},
    week: Array.isArray(raw.week) ? raw.week : [],
    prefs: isRecord(raw.prefs) ? raw.prefs : {},
    cards: Array.isArray(raw.cards) ? cleanupCards(raw.cards.map(fixRepoCard), raw) : [],
    completions: Array.isArray(raw.completions) ? dedupeItemCompletions(raw.completions) : [],
    itemStatus: isRecord(raw.itemStatus) ? raw.itemStatus : {},
    cardChats: isRecord(raw.cardChats) ? stableChatKeys(raw.cardChats) : {},
    pendingActions: isRecord(raw.pendingActions) ? raw.pendingActions : {},
    ui: isRecord(raw.ui) ? raw.ui : base.ui,
    uiLog: Array.isArray(raw.uiLog) ? raw.uiLog.slice(-200) : [],
    surfaces: isRecord(raw.surfaces) ? raw.surfaces : {},
    lastDigest: raw.lastDigest ?? null,
  }
}

/** Chat keys follow the card's stable key (no day): 'src:cluster:C1:2026-11-03' -> 'src:cluster:C1'. */
function stableChatKeys(chats) {
  const out = {}
  for (const [k, v] of Object.entries(chats)) {
    const nk = k.replace(/:\d{4}-\d{2}-\d{2}$/, '')
    out[nk] = out[nk] ? [...out[nk], ...(v || [])].sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(-40) : v
  }
  return out
}

/** Load-time cleanup: one card per entity (duplicates folded, chats moved). In place on the copies. */
function cleanupCards(cards, raw) {
  const list = cards.map(c => (c && typeof c === 'object' ? { ...c } : c)).filter(Boolean)
  if (isRecord(raw.cardChats)) dedupe(list, { itemStatus: raw.itemStatus || {}, cardChats: raw.cardChats })
  else dedupe(list, {})
  return list
}

function cardKey(card) {
  if (!card || typeof card !== 'object') return null
  if (card.id) return `id:${card.id}`
  if (card.sourceId) return `src:${card.sourceId}`
  return null
}

/**
 * Merge card lists for save().
 * - Identity: prefer id; fall back to sourceId for digest upserts.
 * - Digest refresh must NOT revive or wipe terminal cards (done/dismissed).
 * - User fields on terminal cards stay put; active cards accept incoming updates.
 */
export function mergeCards(existingCards = [], incomingCards = [], { digest = false } = {}) {
  const byId = new Map()
  const bySource = new Map()

  for (const card of existingCards) {
    if (!card || typeof card !== 'object') continue
    if (card.id) byId.set(card.id, card)
    if (card.sourceId) bySource.set(card.sourceId, card.id || card.sourceId)
  }

  for (const incoming of incomingCards) {
    if (!incoming || typeof incoming !== 'object') continue

    let existing = incoming.id ? byId.get(incoming.id) : undefined
    if (!existing && incoming.sourceId) {
      const mapped = bySource.get(incoming.sourceId)
      if (mapped) existing = byId.get(mapped) || [...byId.values()].find(c => c.sourceId === incoming.sourceId)
    }

    if (!existing) {
      const id = incoming.id || `card_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
      const next = { ...incoming, id, createdAt: incoming.createdAt || new Date().toISOString(), updatedAt: incoming.updatedAt || new Date().toISOString() }
      byId.set(id, next)
      if (next.sourceId) bySource.set(next.sourceId, id)
      continue
    }

    // Digest must not overwrite completed/dismissed cards.
    if (digest && TERMINAL_CARD_STATUSES.has(existing.status)) {
      continue
    }

    const merged = {
      ...existing,
      ...incoming,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    }
    // Preserve completion metadata even if incoming omits it.
    if (existing.completedAt && !incoming.completedAt) merged.completedAt = existing.completedAt
    if (existing.completedBy && !incoming.completedBy) merged.completedBy = existing.completedBy
    if (existing.dismissedAt && !incoming.dismissedAt) merged.dismissedAt = existing.dismissedAt
    if (existing.status === 'done' || existing.status === 'dismissed') {
      // Never let a partial update silently clear terminal status unless explicitly set.
      if (incoming.status === undefined) merged.status = existing.status
    }
    byId.set(existing.id, merged)
    if (merged.sourceId) bySource.set(merged.sourceId, existing.id)
  }

  return Array.from(byId.values())
}

/**
 * Digest cards carry day-scoped sourceIds ("github:cluster:owner/repo:2026-11-04"). When a newer day's card
 * exists for the same thing, the older still-active card is folded into it (status 'merged' + mergedInto) —
 * never deleted, so its record, item statuses (url-keyed) and card chat (repo-keyed) carry over. Cards with no
 * newer successor stay active; done/dismissed/snoozed are never touched. Idempotent.
 */
const DAY_SCOPED = /^(.+):(\d{4}-\d{2}-\d{2})$/
export function supersedeOlderDays(cards = []) {
  const latest = new Map() // prefix -> { day, id }
  for (const c of cards) {
    const m = typeof c?.sourceId === 'string' && c.sourceId.match(DAY_SCOPED)
    if (!m) continue
    const cur = latest.get(m[1])
    if (!cur || m[2] > cur.day) latest.set(m[1], { day: m[2], id: c.id })
  }
  let changed = 0
  const out = cards.map(c => {
    const m = typeof c?.sourceId === 'string' && c.sourceId.match(DAY_SCOPED)
    if (!m) return c
    const top = latest.get(m[1])
    if (!top || m[2] >= top.day || top.id === c.id) return c
    if (c.status && c.status !== 'active') return c
    changed++
    return { ...c, status: 'merged', mergedInto: top.id, supersededAt: new Date().toISOString(), supersededBy: 'newer-day' }
  })
  return changed ? out : cards
}

/**
 * Append a durable completion/dismiss record (capped).
 */
export function recordCompletion(completions = [], card, { action = 'done', by = 'user' } = {}) {
  if (!card?.id) return completions || []
  const entry = {
    id: `cmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    cardId: card.id,
    sourceId: card.sourceId || null,
    title: card.title || '',
    body: (card.body || '').slice(0, 500),
    source: card.source || null,
    url: card.url || null,
    links: Array.isArray(card.links) ? card.links.slice(0, 5) : null,
    action, // done | dismissed
    by, // user | bot | system
    at: new Date().toISOString(),
  }
  const next = [...(completions || []).filter(c => !(c.cardId === card.id && c.action === action)), entry]
  // Keep last 500
  return next.slice(-500)
}

export function createStore(path) {
  let state = emptyState()
  return {
    path,
    async load() {
      try {
        const data = await readFile(path, 'utf8')
        state = normalizeState(JSON.parse(data))
        console.log(`[Store] Loaded ${state.cards?.length || 0} cards, ${state.completions?.length || 0} completions from ${path}`)
      } catch (err) {
        if (err.code !== 'ENOENT') {
          console.warn(`[Store] Failed to load ${path}:`, err.message)
        }
        state = emptyState()
      }
      return state
    },
    get() {
      return state
    },
    /**
     * @param {object} next
     * @param {{ digest?: boolean, replaceCards?: boolean }} [opts]
     *   digest: preserve terminal cards when merging by sourceId
     *   replaceCards: rare; replace the whole card list (still keeps completions)
     */
    async save(next, opts = {}) {
      const existing = state
      const digest = opts.digest === true
      const replaceCards = opts.replaceCards === true

      let cards
      if (replaceCards && Array.isArray(next.cards)) {
        cards = next.cards
      } else if (Array.isArray(next.cards) && digest) {
        // Digest: reconcile against the stored cards — update the card for the same entity in place, create only
        // when nothing matches, fold duplicates. Never deletes; done cards reopen only for genuinely new items.
        const r = reconcileCards(existing.cards || [], next.cards, { itemStatus: next.itemStatus ?? existing.itemStatus, cardChats: { ...(next.cardChats ?? existing.cardChats ?? {}) }, seen: opts.seen, channels: opts.channels })
        cards = r.cards
        next = { ...next, itemStatus: r.itemStatus, cardChats: r.cardChats, lastReconcile: { at: new Date().toISOString(), ...r.stats } }
      } else if (Array.isArray(next.cards)) {
        cards = mergeCards(existing.cards || [], next.cards, { digest })
      } else {
        cards = existing.cards || []
      }

      const completions = Array.isArray(next.completions)
        ? next.completions
        : (existing.completions || [])

      state = {
        ...existing,
        ...next,
        cards,
        completions,
        revision: (next?.revision ?? existing.revision ?? 0) + 1,
      }

      await mkdir(dirname(path), { recursive: true })
      const temporary = `${path}.${randomUUID()}.tmp`
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
      await rename(temporary, path)

      console.log(`[Store] Saved ${state.cards.length} cards, ${state.completions.length} completions (revision ${state.revision})`)
      return state
    },
  }
}


// ---- Per-item (related link) status -------------------------------------------------
// Items are the links inside a card (PRs, issues, mails). Their status is keyed by url
// at the state top level, so re-aggregation (new card ids, day-scoped sourceIds) keeps it.

export function cardItemUrls(card) {
  const urls = new Set()
  for (const b of card?.blocks || []) {
    if (b?.type === 'link-list') for (const l of b.links || []) if (l?.url) urls.add(l.url)
  }
  for (const l of Array.isArray(card?.links) ? card.links : []) if (l?.url) urls.add(l.url)
  return urls
}

export function setItemStatus(state, { card, url, title = '', action = 'done', by = 'user' }) {
  const status = action === 'done' ? 'done' : 'dismissed'
  const at = new Date().toISOString()
  state.itemStatus = { ...(state.itemStatus || {}), [url]: { status, at, by, cardId: card?.id || null, title } }
  const entry = {
    id: `cmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    kind: 'item',
    cardId: card?.id || null,
    sourceId: card?.sourceId || null,
    cardTitle: card?.title || '',
    title,
    itemUrl: url,
    url,
    source: card?.source || null,
    action: status, // done | dismissed
    by,
    at,
  }
  const prior = (state.completions || []).filter(c => !(c.kind === 'item' && c.itemUrl === url))
  state.completions = [...prior, entry].slice(-500)
  return state.itemStatus[url]
}

export function clearItemStatus(state, url) {
  const next = { ...(state.itemStatus || {}) }
  delete next[url]
  state.itemStatus = next
  // Undo removes the item's ledger entry: an undone completion was not a completion.
  state.completions = (state.completions || []).filter(c => !(c.kind === 'item' && c.itemUrl === url))
}

export function annotateCards(cards = [], itemStatus = {}) {
  if (!itemStatus || !Object.keys(itemStatus).length) return cards
  return cards.map(card => {
    const mine = {}
    for (const url of cardItemUrls(card)) if (itemStatus[url]) mine[url] = itemStatus[url]
    return Object.keys(mine).length ? skipClosedNextAction({ ...card, itemStatus: mine }, mine) : card
  })
}

const CLOSED = new Set(['done', 'dismissed'])
const baseUrl = (u = '') => String(u).replace(/\/files\/?$/, '').replace(/\/$/, '')

// A new day's card inherits yesterday's done/dismissed marks, but its next step was picked without them.
// Never point the user (or the hero focus list) at something they already closed: drop those buttons and
// move the next step to the first remaining button or still-open linked item.
export function skipClosedNextAction(card, mine = card.itemStatus || {}) {
  const closed = new Set(Object.entries(mine).filter(([, v]) => CLOSED.has(v?.status)).map(([u]) => baseUrl(u)))
  if (!closed.size || !Array.isArray(card.actions)) return card
  const isClosed = a => a?.value && closed.has(baseUrl(a.value))
  const removed = card.actions.filter(isClosed)
  if (!removed.length) return card
  const actions = card.actions.filter(a => !isClosed(a))
  let nextAction = card.nextAction
  if (removed.some(a => nextAction && String(nextAction).startsWith(a.label))) {
    if (actions.length) nextAction = actions[0].label
    else {
      const ll = (card.blocks || []).find(b => b?.type === 'link-list')
      const open = ll?.links?.find(l => l?.url && !closed.has(baseUrl(l.url)))
      if (open) {
        const num = open.url.match(/\/(?:pull|issues)\/(\d+)/)?.[1]
        actions.push({ label: num ? `看 #${num} 的最新进展` : '看最新一条', value: open.url, primary: true })
        nextAction = `先看「${String(open.title || '').replace(/^(Re:\s*)?\[[^\]]+\]\s*/i, '').slice(0, 40)}」的最新进展`
      } else nextAction = ''
    }
  }
  return { ...card, actions, nextAction }
}
