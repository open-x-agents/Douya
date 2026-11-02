// ledger.jsonl: one line per piece of evidence behind one assertion. Append only.
//
// The ledger answers "which sources, at which original moment, backed this claim?" and never
// "what did they say?" — only a hash of the quote is stored (#17 §1: a mail body is never
// kept). There is deliberately no way to change or drop a record: this module exports the five
// functions below and nothing else, and its one write goes through atomic.js' line appender.
//
// Two moments live in every record. `at` is when the source itself said it; `recorded_at` is
// when the ledger took it down. Keeping both is what lets the panel say "he asked at 21:14 and
// nobody has answered since" without trusting the file's mtime.

import path from 'node:path'

import { appendJsonLines, readTextOrNull, withDataLock } from './atomic.js'
import { CANONICAL_UTC, createEvent, toUtcInstant } from './event.js'

const LEDGER_FILE = 'ledger.jsonl'
const FIELD = /^[a-z][a-z0-9_]{0,31}$/
const EXCERPT_HASH = /^sha256:[0-9a-f]{64}$/
const KEYS = ['seq', 'event_id', 'field', 'source_ref', 'at', 'excerpt_hash', 'recorded_at']
const SORTED_KEYS = [...KEYS].sort().join(',')

class LedgerError extends Error {
  constructor(code, why, line = null) {
    super(`${code}: ${why}${line === null ? '' : ` (${LEDGER_FILE}:${line})`}`)
    this.name = 'LedgerError'
    this.code = code
    this.why = why
    this.line = line
  }
}

function corrupt(why, line = null) {
  throw new LedgerError('E_CORRUPT_LEDGER', why, line)
}

// The id rule and the source rules belong to the event model; a throwaway event exercises them
// so the ledger reports the same codes as createEvent() instead of growing a second opinion.
const PROBE_SOURCE = Object.freeze({
  type: 'feishu_msg',
  ref: 'feishu_msg:chat/ledger/probe',
  at: '1970-01-01T00:00:00.000Z',
  read_scope: 'metadata',
  excerpt: 'probe',
})

function probeEvent(eventId, sources) {
  return createEvent({ id: eventId, kind: 'message', title: 'ledger record', state: 'open', sources })
}

// validateEvent() checks id before sources, so a bad id reads as E_BAD_ID and a bad source as
// one of the E_BAD_SOURCE / E_SOURCE_* codes — the same codes an event carries.
function checkedEventId(eventId) {
  return probeEvent(eventId, [PROBE_SOURCE]).id
}

function checkedSources(eventId, sources) {
  return probeEvent(eventId, sources).sources
}

function checkedField(field) {
  if (typeof field !== 'string' || !FIELD.test(field)) {
    throw new LedgerError(
      'E_BAD_FIELD',
      `field must match '^[a-z][a-z0-9_]{0,31}$', got ${JSON.stringify(field)}`,
    )
  }
  return field
}

function instantOf(now) {
  const value = typeof now === 'function' ? now() : now
  return value instanceof Date ? value.toISOString() : value
}

// The identity of one piece of evidence: the same source saying the same thing about the same
// assertion is the same record, however many times an ingest run asks for it.
function identity(record) {
  return [record.event_id, record.field, record.source_ref, record.excerpt_hash].join('\u0000')
}

function copyRecord(record) {
  return {
    seq: record.seq,
    event_id: record.event_id,
    field: record.field,
    source_ref: record.source_ref,
    at: record.at,
    excerpt_hash: record.excerpt_hash,
    recorded_at: record.recorded_at,
  }
}

function checkedRecord(record, line) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    corrupt('a record must be an object', line)
  }
  if (Object.keys(record).sort().join(',') !== SORTED_KEYS) {
    corrupt(`a record must carry exactly ${KEYS.join('/')}, got ${Object.keys(record).join('/')}`, line)
  }
  if (!Number.isInteger(record.seq) || record.seq < 1) corrupt('seq must be a positive integer', line)
  for (const key of ['event_id', 'field', 'source_ref']) {
    if (typeof record[key] !== 'string' || record[key] === '') corrupt(`${key} must be a non-empty string`, line)
  }
  if (!FIELD.test(record.field)) corrupt(`field '${record.field}' is not a usable assertion name`, line)
  for (const key of ['at', 'recorded_at']) {
    if (typeof record[key] !== 'string' || !CANONICAL_UTC.test(record[key])) {
      corrupt(`${key} must be canonical UTC ('YYYY-MM-DDTHH:mm:ss.sssZ')`, line)
    }
  }
  if (typeof record.excerpt_hash !== 'string' || !EXCERPT_HASH.test(record.excerpt_hash)) {
    corrupt('excerpt_hash must be sha256:<64 lowercase hex>', line)
  }
  return record
}

// One record per source, six keys each (appendEvidence adds seq). The sources are normalized by
// the event model first, so `at` is canonical UTC and `excerpt_hash` matches the quote even when
// the caller only passed the text.
export function assertionRecords(eventId, field, sources, { now = () => new Date() } = {}) {
  const id = checkedEventId(eventId)
  checkedField(field)
  const normalized = checkedSources(id, sources)
  const recordedAt = toUtcInstant(instantOf(now))
  return normalized.map((source) => ({
    event_id: id,
    field,
    source_ref: source.ref,
    at: source.at,
    excerpt_hash: source.excerpt_hash,
    recorded_at: recordedAt,
  }))
}

// A half line at the very end is what a writer leaves when it dies mid-append: it is counted and
// skipped, because the records above it are still true. A broken line anywhere else means the
// file itself is damaged, and a ledger that quietly drops evidence would let a closed item
// reopen — so that is E_CORRUPT_LEDGER with the line number.
export function parseLedger(text) {
  if (typeof text !== 'string' || text === '') return { records: [], skippedTail: 0 }

  const terminated = text.endsWith('\n')
  const lines = text.split('\n')
  if (terminated) lines.pop()

  let skippedTail = 0
  if (!terminated) {
    const last = lines[lines.length - 1]
    lines.pop()
    if (last.trim() !== '') skippedTail = 1
  }

  const records = []
  const seen = new Set()
  lines.forEach((raw, index) => {
    if (raw.trim() === '') return
    const line = index + 1
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      corrupt('the line is not valid JSON', line)
    }
    checkedRecord(parsed, line)
    if (seen.has(parsed.seq)) corrupt(`seq ${parsed.seq} appears more than once`, line)
    seen.add(parsed.seq)
    records.push(copyRecord(parsed))
  })
  return { records, skippedTail }
}

// Newest evidence last: seq is the order the ledger was written in, which is the order an
// explanation reads in. An unknown event explains nothing rather than inventing evidence.
export function explainFrom(records, eventId) {
  return records
    .filter((record) => record.event_id === eventId)
    .sort((left, right) => left.seq - right.seq)
    .map((record) => copyRecord(record))
}

// Append the evidence behind one assertion on one event. Inside the lock the whole ledger is
// read so seq continues the file instead of guessing, a record already there is skipped (an
// ingest rerun must not double the evidence), and the new lines go down in one write.
export async function appendEvidence({ dir, eventId, field, sources, now = () => new Date() }) {
  const file = path.join(dir, LEDGER_FILE)
  const wanted = assertionRecords(eventId, field, sources, { now })
  return withDataLock(dir, async () => {
    const text = await readTextOrNull(file)
    const { records, skippedTail } = parseLedger(text)
    if (skippedTail === 1) {
      const line = (text.match(/\n/g) ?? []).length + 1
      corrupt('the last line has no newline (a writer died mid-append); appending would fuse two records', line)
    }

    const seen = new Set(records.map((record) => identity(record)))
    let seq = records.reduce((highest, record) => Math.max(highest, record.seq), 0)
    const appended = []
    let skipped = 0
    for (const record of wanted) {
      const key = identity(record)
      if (seen.has(key)) {
        skipped += 1
        continue
      }
      seen.add(key)
      seq += 1
      appended.push({ seq, ...record })
    }
    if (appended.length > 0) await appendJsonLines(file, appended)
    return { appended: appended.length, skipped }
  })
}

// Reading takes no lock: a reader that waited for the writer would stall the panel, and the
// parse already tolerates the half line a writer may be adding right now.
export async function explain({ dir, eventId }) {
  const text = await readTextOrNull(path.join(dir, LEDGER_FILE))
  const { records } = parseLedger(text)
  return explainFrom(records, eventId).map((record) => ({
    seq: record.seq,
    field: record.field,
    source_ref: record.source_ref,
    at: record.at,
    excerpt_hash: record.excerpt_hash,
    recorded_at: record.recorded_at,
  }))
}
