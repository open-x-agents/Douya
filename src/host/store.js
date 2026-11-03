// One JSON file for everything the plugin remembers. Written through a temp file
// and a rename, so a crash mid-write leaves the previous file intact.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

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
    lastDigest: null,
  }
}

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

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
    cards: Array.isArray(raw.cards) ? raw.cards : [],
    completions: Array.isArray(raw.completions) ? raw.completions : [],
    lastDigest: raw.lastDigest ?? null,
  }
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
