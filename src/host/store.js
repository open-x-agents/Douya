// One JSON file for everything the plugin remembers: members, the reminders it already sent,
// the reports members filled in, and the last deliveries. Written through a temp file and a
// rename, so a crash mid-write leaves the previous file intact instead of a truncated one.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export function emptyState() {
  return {
    revision: 0,
    members: {},
    reports: {},
    sent: {},
    manual: [],
    deliveries: [],
    upcoming: [],
    // What the aggregate layer (#9) writes: one entry per local day, what each source last
    // read, and the week's subtraction. The panel only reads these; it never produces an event.
    days: {},
    sources: {},
    week: [],
    // The two preferences the panel's bad states read (#15): how long a day may be, and
    // whether a weekend is quiet. Read-only for the panel, like the three keys above.
    prefs: {},
    cards: [], // Today cards: {id, source, type, title, body, url, priority, status, createdAt, updatedAt}
    lastDigest: null, // Last generated digest metadata
  }
}

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

// Older files may miss a key a later version reads; the shape is filled in on load.
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
    lastDigest: raw.lastDigest ?? null,
  }
}

export function createStore(path) {
  let state = emptyState()
  return {
    path,
    async load() {
      try {
        const data = await readFile(path, 'utf8')
        state = normalizeState(JSON.parse(data))
        console.log(`[Store] Loaded ${state.cards?.length || 0} cards from ${path}`)
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
    async save(next) {
      // CRITICAL: Merge with existing state, NEVER replace
      const existing = state
      
      // Merge cards: update existing by sourceId, add new
      const existingCardsMap = new Map((existing.cards || []).map(c => [c.sourceId, c]))
      const incomingCards = next.cards || []
      
      for (const card of incomingCards) {
        if (card.sourceId && existingCardsMap.has(card.sourceId)) {
          // UPDATE existing card: keep id and createdAt, update rest
          const existingCard = existingCardsMap.get(card.sourceId)
          existingCardsMap.set(card.sourceId, {
            ...card,
            id: existingCard.id,
            createdAt: existingCard.createdAt,
            updatedAt: new Date().toISOString(),
          })
        } else {
          // ADD new card
          existingCardsMap.set(card.sourceId || card.id, card)
        }
      }
      
      state = { 
        ...existing,
        ...next, 
        cards: Array.from(existingCardsMap.values()),
        revision: (next?.revision ?? existing.revision ?? 0) + 1 
      }
      
      // Atomic write: tmp file then rename
      await mkdir(dirname(path), { recursive: true })
      const temporary = `${path}.${randomUUID()}.tmp`
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
      await rename(temporary, path)
      
      console.log(`[Store] Saved ${state.cards.length} cards (revision ${state.revision})`)
      return state
    },
  }
}
