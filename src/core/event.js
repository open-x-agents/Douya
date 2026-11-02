// The event model and the four invariants every event must satisfy. This module is pure: it
// reads and writes no files, so the source adapters (#10) and the panel (#15) can share one
// definition of what an "event" is. The ledger and the store live in their own modules.

import { createHash } from 'node:crypto'

export const CANONICAL_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export const EVENT_KINDS = Object.freeze(['calendar', 'email', 'doc', 'pr', 'issue', 'message', 'task'])
export const EVENT_STATES = Object.freeze(['open', 'closed', 'waiting_other', 'unknown'])
export const SOURCE_TYPES = Object.freeze(['gcal', 'gmail', 'feishu_doc', 'feishu_cal', 'feishu_msg', 'github'])
export const READ_SCOPES = Object.freeze(['metadata', 'body'])

const COMPOSIO_TYPE = /^composio:[a-z][a-z0-9_]*$/
const EVENT_ID = /^evt_[A-Za-z0-9_-]{1,64}$/
const EXTERNAL_REF = /^[A-Za-z0-9_.@/+~-]+$/
const EXCERPT_HASH = /^sha256:[0-9a-f]{64}$/
const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const EXPLICIT_OFFSET = /(?:Z|[+-]\d{2}:\d{2})$/

export class EventInvariantError extends Error {
  constructor(code, why, path = null) {
    super(path ? `${code}: ${why} (${path})` : `${code}: ${why}`)
    this.name = 'EventInvariantError'
    this.code = code
    this.why = why
    this.path = path
  }
}

function fail(code, why, path = null) {
  throw new EventInvariantError(code, why, path)
}

export function isSourceType(type) {
  return typeof type === 'string' && (SOURCE_TYPES.includes(type) || COMPOSIO_TYPE.test(type))
}

export function excerptHash(text) {
  return `sha256:${createHash('sha256').update(String(text).trim(), 'utf8').digest('hex')}`
}

// Wall clock parts of an instant as seen in a zone.
function zonedParts(instantMs, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const parts = {}
  for (const part of formatter.formatToParts(new Date(instantMs))) {
    if (part.type !== 'literal') parts[part.type] = part.value
  }
  return parts
}

function zoneOffsetMs(instantMs, timeZone) {
  const parts = zonedParts(instantMs, timeZone)
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  )
  return asUtc - instantMs
}

// A wall clock in a named zone is not a single instant until the zone is applied; the second
// pass settles the offset across a DST switch.
function wallClockToUtcInstant(dateTime, timeZone) {
  const match = WALL_CLOCK.exec(dateTime.trim())
  if (!match) fail('E_NOT_UTC', `expected 'YYYY-MM-DD HH:mm[:ss]', got '${dateTime}'`, 'dateTime')
  const [, year, month, day, hour, minute, second = '0'] = match
  const naive = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second))
  let instant = naive - zoneOffsetMs(naive, timeZone)
  instant = naive - zoneOffsetMs(instant, timeZone)
  const back = zonedParts(instant, timeZone)
  const wanted = `${year}-${month}-${day} ${hour}:${minute}`
  const got = `${back.year}-${back.month}-${back.day} ${back.hour}:${back.minute}`
  if (wanted !== got) fail('E_NOT_UTC', `'${dateTime}' does not exist in '${timeZone}'`, 'dateTime')
  return new Date(instant).toISOString()
}

// Canonical UTC storage is the only form this module hands back: 'YYYY-MM-DDTHH:mm:ss.sssZ'.
export function toUtcInstant(value, { timeZone } = {}) {
  if (typeof value === 'string') {
    const text = value.trim()
    if (DATE_ONLY.test(text)) fail('E_NOT_UTC', `a date alone is not an instant: '${text}'`, 'value')
    if (!EXPLICIT_OFFSET.test(text) || !/\d{2}:\d{2}/.test(text)) {
      fail('E_NOT_UTC', `'${text}' carries no offset and no time zone`, 'value')
    }
    const parsed = new Date(text)
    if (Number.isNaN(parsed.getTime())) fail('E_NOT_UTC', `'${text}' is not a valid instant`, 'value')
    return parsed.toISOString()
  }
  if (value !== null && typeof value === 'object' && typeof value.dateTime === 'string') {
    const zone = value.timeZone ?? timeZone
    if (!zone) fail('E_NOT_UTC', 'a wall clock without a time zone cannot be stored', 'value')
    return wallClockToUtcInstant(value.dateTime, zone)
  }
  fail('E_NOT_UTC', `not an instant: ${JSON.stringify(value)}`, 'value')
}

export function localizeInstant(iso, { timeZone } = {}) {
  const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const parsed = typeof iso === 'string' ? new Date(iso) : new Date(Number.NaN)
  if (Number.isNaN(parsed.getTime())) fail('E_NOT_UTC', `not an instant: ${JSON.stringify(iso)}`, 'iso')
  const parts = zonedParts(parsed.getTime(), zone)
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`
}

export function localizeDueAt(event, options = {}) {
  return event.due_at === null ? null : localizeInstant(event.due_at, options)
}

function normalizedSource(source, path) {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    fail('E_BAD_SOURCE', 'a source must be an object', path)
  }
  const type = source.type
  if (!isSourceType(type)) fail('E_BAD_SOURCE', `unknown source type '${String(type)}'`, `${path}.type`)
  if (!READ_SCOPES.includes(source.read_scope)) {
    fail('E_BAD_SOURCE', `read_scope must be one of ${READ_SCOPES.join('/')}`, `${path}.read_scope`)
  }
  let at
  try {
    at = toUtcInstant(source.at)
  } catch (error) {
    fail('E_BAD_SOURCE', error.why ?? 'source.at is not a UTC instant', `${path}.at`)
  }
  const ref = source.ref
  if (typeof ref !== 'string' || !ref.startsWith(`${type}:`)) {
    fail('E_SOURCE_REF_BAD', `ref '${String(ref)}' must start with '${type}:'`, `${path}.ref`)
  }
  const external = ref.slice(type.length + 1)
  if (!EXTERNAL_REF.test(external)) {
    fail('E_SOURCE_REF_BAD', `ref '${ref}' carries an unusable external id`, `${path}.ref`)
  }
  const hasExcerpt = typeof source.excerpt === 'string'
  const hasHash = typeof source.excerpt_hash === 'string'
  if (!hasExcerpt && !hasHash) fail('E_SOURCE_NO_HASH', 'a source needs excerpt or excerpt_hash', path)
  if (hasHash && !EXCERPT_HASH.test(source.excerpt_hash)) {
    fail('E_SOURCE_NO_HASH', `excerpt_hash is not 'sha256:<64 hex>'`, `${path}.excerpt_hash`)
  }
  if (source.raw_hash !== undefined && !EXCERPT_HASH.test(source.raw_hash)) {
    fail('E_SOURCE_NO_HASH', `raw_hash is not 'sha256:<64 hex>'`, `${path}.raw_hash`)
  }
  const normalized = { ...source, at }
  if (hasExcerpt) {
    const computed = excerptHash(source.excerpt)
    if (hasHash && source.excerpt_hash !== computed) {
      fail('E_HASH_MISMATCH', 'excerpt_hash does not match excerpt', `${path}.excerpt_hash`)
    }
    normalized.excerpt_hash = computed
  }
  // Mail bodies must not be stored at all; the hash stays, the text goes (issue #17 §1).
  if (type === 'gmail' && source.read_scope === 'body') delete normalized.excerpt
  return normalized
}

function normalizedClosure(event, path) {
  const closure = event.closure
  if (event.state === 'closed') {
    if (closure === null || typeof closure !== 'object' || typeof closure.evidence_ref !== 'string' || closure.evidence_ref.trim() === '') {
      fail('E_CLOSED_NO_EVIDENCE', 'a closed event needs closure.evidence_ref', `${path}.evidence_ref`)
    }
  }
  if (closure === null || typeof closure !== 'object') return closure
  if (event.state === 'closed') {
    const refs = new Set(event.sources.map((source) => source.ref))
    if (!refs.has(closure.evidence_ref)) {
      fail('E_CLOSED_EVIDENCE_UNKNOWN', `'${closure.evidence_ref}' is not one of this event's sources`, `${path}.evidence_ref`)
    }
    if (typeof closure.by !== 'string' || closure.by.trim() === '') {
      fail('E_BAD_CLOSURE', 'closure.by must name who closed it', `${path}.by`)
    }
    const normalized = { ...closure }
    try {
      normalized.at = toUtcInstant(closure.at)
    } catch (error) {
      fail('E_BAD_CLOSURE', error.why ?? 'closure.at is not a UTC instant', `${path}.at`)
    }
    return normalized
  }
  return { ...closure }
}

// One thing may arrive from several sources, but it stays ONE event: this validates and
// normalizes an event without ever splitting it into several.
export function validateEvent(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail('E_BAD_ID', 'an event must be an object', null)
  }
  if (typeof input.id !== 'string' || !EVENT_ID.test(input.id)) {
    fail('E_BAD_ID', `id must match 'evt_<1-64 of A-Za-z0-9_->'`, 'id')
  }
  if (typeof input.title !== 'string' || input.title.trim() === '') {
    fail('E_NO_TITLE', 'title must not be empty', 'title')
  }
  if (!EVENT_KINDS.includes(input.kind)) {
    fail('E_BAD_KIND', `kind must be one of ${EVENT_KINDS.join('/')}`, 'kind')
  }
  if (!EVENT_STATES.includes(input.state)) {
    fail('E_BAD_STATE', `state must be one of ${EVENT_STATES.join('/')}`, 'state')
  }
  if (!Array.isArray(input.sources) || input.sources.length < 1) {
    fail('E_NO_SOURCE', 'an event needs at least one source', 'sources')
  }
  const sources = input.sources.map((source, index) => normalizedSource(source, `sources[${index}]`))
  const seen = new Set()
  for (const source of sources) {
    if (seen.has(source.ref)) fail('E_SOURCE_DUPLICATE', `ref '${source.ref}' appears twice`, 'sources')
    seen.add(source.ref)
  }
  const normalized = { ...input, sources }
  if (input.due_at !== undefined && input.due_at !== null) normalized.due_at = toUtcInstant(input.due_at)
  normalized.closure = normalizedClosure({ ...normalized, state: input.state }, 'closure')
  return normalized
}

export function createEvent(input) {
  return validateEvent(input)
}

// Merging two versions of one thing keeps the kept version's scalars and unions the sources
// by ref; a ref whose excerpt hash or original moment disagrees is not silently picked.
export function mergeEvent(kept, incoming) {
  const left = validateEvent(kept)
  const right = validateEvent(incoming)
  const leftRefs = new Set(left.sources.map((source) => source.ref))
  const related = left.id === right.id || right.sources.some((source) => leftRefs.has(source.ref))
  if (!related) fail('E_MERGE_UNRELATED', 'the two events share no id and no source ref', null)
  const merged = [...left.sources]
  const byRef = new Map(left.sources.map((source) => [source.ref, source]))
  for (const source of right.sources) {
    const existing = byRef.get(source.ref)
    if (existing === undefined) {
      byRef.set(source.ref, source)
      merged.push(source)
      continue
    }
    if (existing.excerpt_hash !== source.excerpt_hash || existing.at !== source.at) {
      fail('E_SOURCE_CONFLICT', `ref '${source.ref}' disagrees on hash or moment`, 'sources')
    }
  }
  return validateEvent({ ...left, sources: merged })
}
