// events.json: the events themselves, rewritten as a whole on every change. This is not
// src/host/store.js (that one holds the bot's own state.json); the two never import each other.
//
// Two rules shape this file. Every write re-reads the file inside the data lock, so two
// processes never merge against their own stale snapshot and lose the other's source. And a
// file that cannot be parsed or whose events no longer validate is E_CORRUPT_EVENTS, never an
// empty list: silently dropping events would make a closed item quietly reopen (#9).

import path from 'node:path'

import { atomicWriteJson, readTextOrNull, withDataLock } from './atomic.js'
import { createEvent, mergeEvent, validateEvent } from './event.js'

export const DEFAULT_DATA_DIR = 'data'
export const EVENTS_FILE = 'events.json'

export class EventStoreError extends Error {
  constructor(code, why, path = null) {
    super(path ? `${code}: ${why} (${path})` : `${code}: ${why}`)
    this.name = 'EventStoreError'
    this.code = code
    this.why = why
    this.path = path
  }
}

function fail(code, why, path = null) {
  throw new EventStoreError(code, why, path)
}

// The stored shape is exactly { revision, events }. Anything else is damage, not a first run.
function parseState(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    fail('E_CORRUPT_EVENTS', 'events.json is not valid JSON', EVENTS_FILE)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('E_CORRUPT_EVENTS', 'events.json must be an object { revision, events }', EVENTS_FILE)
  }
  if (!Number.isInteger(parsed.revision) || parsed.revision < 0) {
    fail('E_CORRUPT_EVENTS', 'events.json has no non-negative integer revision', `${EVENTS_FILE}#revision`)
  }
  if (!Array.isArray(parsed.events)) {
    fail('E_CORRUPT_EVENTS', 'events.json has no events array', `${EVENTS_FILE}#events`)
  }
  // Every stored event must still satisfy the four invariants; a hand-edited file that does
  // not is reported instead of being rewritten into something the rest of the code trusts.
  parsed.events.forEach((event, index) => {
    try {
      validateEvent(event)
    } catch (error) {
      fail('E_CORRUPT_EVENTS', `events[${index}] fails validation: ${error.code}`, `${EVENTS_FILE}#events[${index}]`)
    }
  })
  return { revision: parsed.revision, events: parsed.events }
}

export function createEventStore({ dir = DEFAULT_DATA_DIR, now = () => new Date() } = {}) {
  const file = path.join(dir, EVENTS_FILE)
  // `now` is accepted for symmetry with the ledger and the host store; events.json itself
  // carries no clock (only the revision), so nothing here needs it yet.

  async function loadEvents() {
    const text = await readTextOrNull(file)
    if (text === null) return { revision: 0, events: [] }
    return parseState(text)
  }

  // A fresh parse on every call, and a copy handed out: a caller poking at a returned event
  // cannot change what the next reader (or the file) sees.
  async function listEvents() {
    const { events } = await loadEvents()
    return structuredClone(events)
  }

  async function getEvent(id) {
    const events = await listEvents()
    return events.find((event) => event.id === id) ?? null
  }

  // Add one thing, or fold it into the one event it already is. "Same id" and "shares a
  // source ref" are the only reasons to merge; a similar title is not one. Hitting two
  // existing events at once cannot be decided here, so it fails loudly instead of picking.
  async function upsertEvent(input) {
    const incoming = createEvent(input)
    const refs = new Set(incoming.sources.map((source) => source.ref))
    return withDataLock(dir, async () => {
      const state = await loadEvents()
      const matches = state.events.filter(
        (event) => event.id === incoming.id || event.sources.some((source) => refs.has(source.ref)),
      )
      if (matches.length > 1) {
        fail(
          'E_AMBIGUOUS_MERGE',
          `'${incoming.id}' shares sources with ${matches.length} existing events (${matches
            .map((event) => event.id)
            .join(', ')}); refusing to pick one`,
          EVENTS_FILE,
        )
      }

      let events = state.events
      let event = incoming
      let created = true
      let merged = false
      if (matches.length === 1) {
        const kept = matches[0]
        event = mergeEvent(kept, incoming)
        events = state.events.map((existing) => (existing === kept ? event : existing))
        created = false
        merged = true
      } else {
        events = [...state.events, event]
      }

      // Revision moves once per successful write; a failed merge throws above and writes
      // nothing, so a reader never sees a revision that did not change the events.
      await atomicWriteJson(file, { revision: state.revision + 1, events })
      return { event, created, merged }
    })
  }

  return { dir, file, loadEvents, listEvents, getEvent, upsertEvent }
}
