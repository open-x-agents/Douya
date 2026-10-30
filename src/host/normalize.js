// Normalization: one thing that shows up in three sources is still one thing, one card,
// with three pieces of evidence. Every merge is decided by a rule — no model, no vector
// clustering — and the same observations in any order give the same ids and the same
// numbers. Nothing here writes, fetches or reads the environment.

import { createHash } from 'node:crypto'

export const HARD_CONFIDENCE = 0.95
export const SOFT_CONFIDENCE = 0.8
export const LONE_CONFIDENCE = 0.5
// Below this line two observations are kept apart, never merged: a wrong merge loses
// evidence, an extra card only costs a glance.
export const CONFIDENCE_LINE = 0.6
export const SOFT_WINDOW_MS = 48 * 60 * 60 * 1000

const EXTENSIONS = /\.(?:docx?|xlsx?|pptx?|pdf|md|txt)$/
const VERSION = /(?:_v|\s+v)\d+/g

const text = (value) => String(value ?? '').trim()

function projectOf(raw) {
  return text(raw?.project).toLowerCase()
}

function peopleOf(raw) {
  const list = Array.isArray(raw?.people) ? raw.people : []
  return list.map(text).filter((name) => name !== '')
}

function sorted(list) {
  return [...new Set(list)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

// The hard key is an external id the source owns: the same object keeps it across
// sources. No external id means no hard key — never a title dressed up as one.
export function hardKey(raw) {
  const id = text(raw?.external_id)
  if (id === '') return null
  switch (text(raw?.source)) {
    case 'gcal': return `gcal:event/${id}`
    case 'gmail': return `gmail:thread/${id}`
    case 'doc': return `doc:${id}`
    case 'github': return `github:${text(raw?.object) === 'issue' ? 'issue' : 'pr'}/${id}`
    default: return null
  }
}

// The name with the noise a person did not mean as part of it: the file extension, a
// draft number (_v2 / v2), case, spacing and punctuation.
export function titleKey(raw) {
  return text(raw?.title)
    .toLowerCase()
    .replace(EXTENSIONS, '')
    .replace(VERSION, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
}

// The strong-soft bucket: one name inside one project. The person overlap and the 48 h
// window cannot live in a per-observation key, so they gate the merge pairwise below.
export function softKey(raw) {
  const name = titleKey(raw)
  if (name === '') return null
  return `${name}|${projectOf(raw)}`
}

function atOf(raw) {
  const ms = Date.parse(text(raw?.at))
  return Number.isFinite(ms) ? ms : null
}

function refOf(raw, hard, name) {
  const ref = text(raw?.ref)
  if (ref !== '') return ref
  if (hard !== null) return hard
  return `${text(raw?.source)}:${name}`
}

function compareObservations(a, b) {
  const left = a.at === null ? Number.POSITIVE_INFINITY : a.at
  const right = b.at === null ? Number.POSITIVE_INFINITY : b.at
  if (left !== right) return left === right ? 0 : left < right ? -1 : 1
  if (a.ref !== b.ref) return a.ref < b.ref ? -1 : 1
  return 0
}

function overlaps(people, other) {
  return people.some((name) => other.includes(name))
}

function agreedValue(sources, field) {
  const values = sources.map((source) => source[field]).filter((value) => value !== null && value !== undefined)
  if (values.length === 0) return null
  return values.every((value) => value === values[0]) ? values[0] : null
}

// The id is taken from the earliest hard key in the group (a hard key cannot change),
// else from the group's weakest identity: name + project. The name alone would give two
// same-named docs in different projects one id, which is a real defect.
function eventId(members) {
  const earliestHard = members.find((member) => member.hard !== null)
  const basis = earliestHard !== undefined
    ? earliestHard.hard
    : `${members[0].name}|${members[0].project}|${members[0].ref}|${members[0].at ?? ''}`
  return `evt_${createHash('sha1').update(basis).digest('hex').slice(0, 10)}`
}

function sourceOf(member) {
  const raw = member.raw
  return {
    ref: member.ref,
    source: member.source,
    at: text(raw?.at) || null,
    due_at: text(raw?.due_at) || null,
    due_kind: text(raw?.due_kind) || null,
    amount: typeof raw?.amount === 'number' ? raw.amount : null,
    state: text(raw?.state) || null,
    excerpt: text(raw?.excerpt) || null,
  }
}

function kindOf(members) {
  if (members.some((member) => member.source === 'gcal')) return 'meeting'
  if (members.some((member) => member.source === 'doc')) return 'document'
  return 'thread'
}

function buildEvent(members) {
  const sources = members.map(sourceOf)
  return {
    id: eventId(members),
    kind: kindOf(members),
    title: text(members[0].raw?.title) || members[0].ref,
    // A field every source agrees on keeps its value; a disagreement is unknown here —
    // both values stay on the sources, and the conflict layer carries them side by side.
    state: agreedValue(sources, 'state') ?? 'unknown',
    due_at: agreedValue(sources, 'due_at'),
    due_kind: agreedValue(sources, 'due_kind'),
    who: {
      people: sorted(members.flatMap((member) => member.people)),
      waiting_on: members.map((member) => text(member.raw?.waiting_on)).find((name) => name !== '') ?? null,
    },
    project: text(members[0].raw?.project) || null,
    sources,
    confidence: LONE_CONFIDENCE,
    maybe_same: [],
  }
}

export function normalizeEvents(rawEvents = []) {
  const observations = (Array.isArray(rawEvents) ? rawEvents : [])
    .filter((raw) => raw !== null && typeof raw === 'object')
    .map((raw) => {
      const hard = hardKey(raw)
      const name = titleKey(raw)
      return {
        raw,
        hard,
        name,
        soft: softKey(raw),
        source: text(raw?.source),
        ref: refOf(raw, hard, name),
        project: projectOf(raw),
        people: peopleOf(raw),
        at: atOf(raw),
      }
    })
    // Sorting first makes the grouping, and so the ids, independent of input order.
    .sort(compareObservations)

  const parent = observations.map((_, index) => index)
  const find = (index) => {
    let cursor = index
    while (parent[cursor] !== cursor) {
      parent[cursor] = parent[parent[cursor]]
      cursor = parent[cursor]
    }
    return cursor
  }
  const union = (a, b) => {
    const left = find(a)
    const right = find(b)
    if (left === right) return
    if (left < right) parent[right] = left
    else parent[left] = right
  }

  const links = []
  for (let i = 0; i < observations.length; i += 1) {
    for (let j = i + 1; j < observations.length; j += 1) {
      const a = observations[i]
      const b = observations[j]
      if (a.hard !== null && a.hard === b.hard) {
        union(i, j)
        links.push({ i, kind: 'hard' })
        continue
      }
      const sameBucket = a.soft !== null && a.soft === b.soft
      const samePeople = overlaps(a.people, b.people)
      const withinWindow = a.at !== null && b.at !== null && Math.abs(a.at - b.at) <= SOFT_WINDOW_MS
      if (sameBucket && samePeople && withinWindow) {
        union(i, j)
        links.push({ i, kind: 'soft' })
      }
    }
  }

  const groups = new Map()
  observations.forEach((_, index) => {
    const root = find(index)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root).push(index)
  })
  const groupLink = new Map()
  for (const link of links) {
    const root = find(link.i)
    if (!groupLink.has(root)) groupLink.set(root, new Set())
    groupLink.get(root).add(link.kind)
  }

  const built = []
  for (const [root, indexes] of groups) {
    const members = indexes.map((index) => observations[index])
    const event = buildEvent(members)
    const kinds = groupLink.get(root) ?? new Set()
    if (kinds.has('hard')) event.confidence = HARD_CONFIDENCE
    else if (kinds.has('soft')) event.confidence = SOFT_CONFIDENCE
    built.push({ event, names: new Set(members.map((member) => member.name)), earliest: members[0].at })
  }

  for (const entry of built) {
    entry.event.maybe_same = built
      .filter((other) => other !== entry && [...entry.names].some((name) => other.names.has(name)))
      .map((other) => ({ id: other.event.id, title: other.event.title }))
      .sort((a, b) => (a.id < b.id ? -1 : 1))
  }

  return built
    .sort((a, b) => {
      if (a.earliest !== b.earliest) return a.earliest === b.earliest ? 0 : a.earliest < b.earliest ? -1 : 1
      return a.event.id < b.event.id ? -1 : 1
    })
    .map((entry) => entry.event)
}

function localDay(iso, timeZone) {
  const ms = Date.parse(text(iso))
  if (!Number.isFinite(ms)) return null
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms))
}

function eventDay(event, timeZone) {
  const first = Array.isArray(event?.sources) ? event.sources[0] : null
  return localDay(event?.due_at ?? first?.at ?? null, timeZone)
}

// The subtraction numbers are derived from the events, never kept in a counter: rerun on
// the same events says the same thing. `day` is the local day in `tz`, explicit, so the
// process TZ cannot move it.
export function subtractStats(events = [], { day = null, tz = 'UTC' } = {}) {
  const list = Array.isArray(events) ? events : []
  const scoped = day === null ? list : list.filter((event) => eventDay(event, tz) === day)
  return {
    closed: scoped.filter((event) => event?.state === 'closed').length,
    dropped: scoped.filter((event) => event?.defer != null).length,
    waiting: scoped.filter((event) => event?.who?.waiting_on != null).length,
    total: scoped.length,
  }
}
