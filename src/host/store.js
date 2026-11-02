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
  }
}

export function createStore(path) {
  let state = emptyState()
  return {
    path,
    async load() {
      try {
        state = normalizeState(JSON.parse(await readFile(path, 'utf8')))
      } catch {
        state = emptyState()
      }
      return state
    },
    get() {
      return state
    },
    async save(next) {
      state = { ...normalizeState(next), revision: (next?.revision ?? state.revision ?? 0) + 1 }
      await mkdir(dirname(path), { recursive: true })
      const temporary = `${path}.${randomUUID()}.tmp`
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
      await rename(temporary, path)
      return state
    },
  }
}
