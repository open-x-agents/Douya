// L0 tests for the event model: the four invariants, UTC normalization, the one localization
// exit, and mergeEvent. No files, no network, no keys.

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import {
  CANONICAL_UTC,
  EVENT_KINDS,
  EVENT_STATES,
  SOURCE_TYPES,
  EventInvariantError,
  createEvent,
  excerptHash,
  isSourceType,
  localizeDueAt,
  localizeInstant,
  mergeEvent,
  toUtcInstant,
  validateEvent,
} from '../src/core/event.js'

const QUOTE = '报价单今天能给吗？能给的话我下午就签。'

function quoteEvent(overrides = {}) {
  return {
    id: 'evt_demo_quote',
    kind: 'message',
    title: '报价单发给张伟',
    state: 'open',
    sources: [
      {
        type: 'feishu_msg',
        ref: 'feishu_msg:chat/oc_demo/msg_2114',
        at: '2026-10-29T21:14:00+08:00',
        read_scope: 'body',
        excerpt: QUOTE,
      },
    ],
    ...overrides,
  }
}

function closedEvent(overrides = {}) {
  return {
    id: 'evt_demo_quote',
    kind: 'message',
    title: '报价单发给张伟',
    state: 'closed',
    sources: [
      {
        type: 'feishu_msg',
        ref: 'feishu_msg:chat/oc_demo/msg_2116',
        at: '2026-10-29T21:16:00+08:00',
        read_scope: 'body',
        excerpt: '签好了，合同下午寄出。',
      },
    ],
    closure: {
      evidence_ref: 'feishu_msg:chat/oc_demo/msg_2116',
      at: '2026-10-30T01:00:00+08:00',
      by: '张伟',
    },
    ...overrides,
  }
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof EventInvariantError, `expected EventInvariantError, got ${error}`)
    assert.equal(error.code, code)
    return true
  })
}

function expectedInZone(iso, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
  const parts = {}
  for (const part of formatter.formatToParts(new Date(iso))) {
    if (part.type !== 'literal') parts[part.type] = part.value
  }
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`
}

test('one thing with two sources is one event, and the sources keep their order', () => {
  const event = createEvent(
    quoteEvent({
      sources: [
        { type: 'feishu_msg', ref: 'feishu_msg:chat/oc_demo/msg_2114', at: '2026-10-29T13:14:00.000Z', read_scope: 'body', excerpt: QUOTE },
        { type: 'feishu_msg', ref: 'feishu_msg:chat/oc_demo/msg_2116', at: '2026-10-29T13:16:00.000Z', read_scope: 'body', excerpt: '签好了，合同下午寄出。' },
      ],
    }),
  )
  assert.equal(event.sources.length, 2)
  assert.deepEqual(event.sources.map((source) => source.ref), [
    'feishu_msg:chat/oc_demo/msg_2114',
    'feishu_msg:chat/oc_demo/msg_2116',
  ])
  for (const source of event.sources) assert.match(source.at, CANONICAL_UTC)

  // The enum plus the composio pattern is the only vocabulary; a real toolkit name is legal.
  assert.ok(isSourceType('feishu_msg'))
  assert.ok(isSourceType('composio:gcal'))
  assert.equal(isSourceType('composio:GCal'), false)
  assert.equal(isSourceType('doc'), false)
  const composio = createEvent(
    quoteEvent({
      sources: [
        { type: 'composio:gcal', ref: 'composio:gcal:event/ext-1', at: '2026-10-29T02:00:00Z', read_scope: 'metadata', excerpt: '周会' },
      ],
    }),
  )
  assert.equal(composio.sources[0].type, 'composio:gcal')
  assert.ok(EVENT_KINDS.includes('message'))
  assert.ok(EVENT_STATES.includes('waiting_other'))
  assert.deepEqual([...SOURCE_TYPES], ['gcal', 'gmail', 'feishu_doc', 'feishu_cal', 'feishu_msg', 'github'])
})

test('an event without any source is refused', () => {
  expectCode(() => createEvent(quoteEvent({ sources: [] })), 'E_NO_SOURCE')
  const withoutSources = quoteEvent()
  delete withoutSources.sources
  expectCode(() => createEvent(withoutSources), 'E_NO_SOURCE')
})

test('two copies of one source ref inside one event are refused', () => {
  const duplicate = { type: 'feishu_msg', ref: 'feishu_msg:chat/oc_demo/msg_2114', at: '2026-10-29T13:14:00.000Z', read_scope: 'body', excerpt: QUOTE }
  expectCode(
    () => createEvent(quoteEvent({ sources: [{ ...duplicate }, { ...duplicate }] })),
    'E_SOURCE_DUPLICATE',
  )
})

test('a source whose ref prefix does not match its type is refused', () => {
  expectCode(
    () => createEvent(
      quoteEvent({
        sources: [
          { type: 'gcal', ref: 'gmail:thread/demo-contract', at: '2026-10-29T13:14:00.000Z', read_scope: 'metadata', excerpt: '主题' },
        ],
      }),
    ),
    'E_SOURCE_REF_BAD',
  )
})

test('a closed event with the reply that closed it validates', () => {
  const event = createEvent(closedEvent())
  assert.equal(event.state, 'closed')
  assert.equal(event.closure.evidence_ref, 'feishu_msg:chat/oc_demo/msg_2116')
  assert.match(event.closure.at, CANONICAL_UTC)
  assert.equal(event.closure.by, '张伟')
})

test('a closed event with no closing evidence is refused', () => {
  expectCode(() => createEvent(closedEvent({ closure: null })), 'E_CLOSED_NO_EVIDENCE')
  const noRef = closedEvent()
  noRef.closure = { at: '2026-10-30T01:00:00+08:00', by: '张伟' }
  expectCode(() => createEvent(noRef), 'E_CLOSED_NO_EVIDENCE')
  expectCode(() => validateEvent(closedEvent({ closure: null })), 'E_CLOSED_NO_EVIDENCE')
})

test('a closed event whose evidence is not among its sources is refused', () => {
  expectCode(
    () => createEvent(closedEvent({ closure: { evidence_ref: 'feishu_msg:chat/oc_demo/msg_9999', at: '2026-10-30T01:00:00+08:00', by: '张伟' } })),
    'E_CLOSED_EVIDENCE_UNKNOWN',
  )
})

test('a due_at with an offset becomes UTC, and a date alone is refused', () => {
  const event = createEvent(quoteEvent({ due_at: '2026-10-30T10:00:00+08:00' }))
  assert.equal(event.due_at, '2026-10-30T02:00:00.000Z')
  assert.match(event.due_at, CANONICAL_UTC)
  const wallClock = createEvent(quoteEvent({ due_at: { dateTime: '2026-10-30 10:00', timeZone: 'Asia/Shanghai' } }))
  assert.equal(wallClock.due_at, '2026-10-30T02:00:00.000Z')
  expectCode(() => createEvent(quoteEvent({ due_at: '2026-10-30' })), 'E_NOT_UTC')
  expectCode(() => createEvent(quoteEvent({ due_at: '2026-10-30T16:00' })), 'E_NOT_UTC')
  expectCode(() => toUtcInstant('2026-10-30T16:00'), 'E_NOT_UTC')
  expectCode(() => toUtcInstant({ dateTime: '2026-10-30 16:00' }), 'E_NOT_UTC')
  assert.equal(toUtcInstant('2026-10-29T21:14:00+08:00'), '2026-10-29T13:14:00.000Z')
})

test('a wall clock in a named zone becomes the right instant, including across a DST edge', () => {
  assert.equal(toUtcInstant({ dateTime: '2026-10-30 16:00', timeZone: 'Asia/Shanghai' }), '2026-10-30T08:00:00.000Z')
  // America/New_York switches from EST to EDT at 02:00 local on 2026-03-08.
  assert.equal(toUtcInstant({ dateTime: '2026-03-08 01:30', timeZone: 'America/New_York' }), '2026-03-08T06:30:00.000Z')
  assert.equal(toUtcInstant({ dateTime: '2026-03-08 03:30', timeZone: 'America/New_York' }), '2026-03-08T07:30:00.000Z')
  const event = createEvent(quoteEvent({ due_at: { dateTime: '2026-10-30 16:00:00', timeZone: 'Asia/Shanghai' } }))
  assert.equal(event.due_at, '2026-10-30T08:00:00.000Z')
})

test('the same instant reads as 08:00 in UTC and 16:00 in Shanghai', () => {
  const iso = '2026-10-30T08:00:00.000Z'
  assert.equal(localizeInstant(iso, { timeZone: 'UTC' }), '2026-10-30 08:00')
  assert.equal(localizeInstant(iso, { timeZone: 'Asia/Shanghai' }), '2026-10-30 16:00')
  const event = createEvent(quoteEvent({ due_at: iso }))
  assert.equal(localizeDueAt(event, { timeZone: 'UTC' }), '2026-10-30 08:00')
  assert.equal(localizeDueAt(event, { timeZone: 'Asia/Shanghai' }), '2026-10-30 16:00')
  const allDay = createEvent(quoteEvent({ due_at: null }))
  assert.equal(localizeDueAt(allDay, { timeZone: 'Asia/Shanghai' }), null)
})

test('with no zone given, rendering uses the process zone that TZ selects', () => {
  const iso = '2026-10-30T08:00:00.000Z'
  const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone
  assert.equal(localizeInstant(iso), expectedInZone(iso, resolved))
  if (process.env.TZ === 'UTC') assert.equal(localizeInstant(iso), '2026-10-30 08:00')
  if (process.env.TZ === 'Asia/Shanghai') assert.equal(localizeInstant(iso), '2026-10-30 16:00')
})

test('the only place that turns an instant into a readable time is event.js', () => {
  const anchors = /Intl\.DateTimeFormat|\.toLocale(String|DateString|TimeString)\b|\.getHours\(|\.getMinutes\(|\.getTimezoneOffset\(/
  const offenders = []
  for (const dir of ['src/core', 'src/host']) {
    for (const name of readdirSync(join(import.meta.dirname, '..', dir), { recursive: true })) {
      if (!name.endsWith('.js')) continue
      const relative = join(dir, name)
      if (anchors.test(readFileSync(join(import.meta.dirname, '..', relative), 'utf8'))) offenders.push(relative)
    }
  }
  assert.deepEqual(offenders, [join('src', 'core', 'event.js')])
})

test('two unrelated events are not merged even when their titles match', () => {
  const first = createEvent(quoteEvent())
  const second = createEvent(quoteEvent({
    id: 'evt_other_quote',
    sources: [
      { type: 'gmail', ref: 'gmail:thread/other-quote', at: '2026-10-29T13:14:00.000Z', read_scope: 'body', excerpt: '另一个报价' },
    ],
  }))
  expectCode(() => mergeEvent(first, second), 'E_MERGE_UNRELATED')
})

test('merging two versions of one source with different excerpts is refused', () => {
  const kept = createEvent(quoteEvent())
  const changed = createEvent(quoteEvent({
    sources: [
      { type: 'feishu_msg', ref: 'feishu_msg:chat/oc_demo/msg_2114', at: '2026-10-29T13:14:00.000Z', read_scope: 'body', excerpt: '报价单改到明天给。' },
    ],
  }))
  expectCode(() => mergeEvent(kept, changed), 'E_SOURCE_CONFLICT')
  const merged = mergeEvent(kept, createEvent(quoteEvent({
    sources: [
      { type: 'feishu_msg', ref: 'feishu_msg:chat/oc_demo/msg_2114', at: '2026-10-29T13:14:00.000Z', read_scope: 'body', excerpt: QUOTE },
      { type: 'feishu_msg', ref: 'feishu_msg:chat/oc_demo/msg_2116', at: '2026-10-29T13:16:00.000Z', read_scope: 'body', excerpt: '签好了。' },
    ],
  })))
  assert.equal(merged.id, 'evt_demo_quote')
  assert.equal(merged.sources.length, 2)
  assert.equal(merged.sources[1].ref, 'feishu_msg:chat/oc_demo/msg_2116')
})

test('a mail body excerpt is hashed and dropped, while a subject survives', () => {
  const body = '正文内容不该落盘，只留 hash。'
  const mail = createEvent(quoteEvent({
    id: 'evt_demo_contract',
    kind: 'email',
    title: '回李静那封邮件',
    sources: [
      { type: 'gmail', ref: 'gmail:thread/demo-contract', at: '2026-10-28T14:30:00+08:00', read_scope: 'body', excerpt: body },
    ],
  }))
  assert.equal(mail.sources[0].excerpt, undefined)
  assert.equal(mail.sources[0].excerpt_hash, excerptHash(body))
  assert.ok(!JSON.stringify(mail).includes(body))

  const subject = createEvent(quoteEvent({
    id: 'evt_demo_contract',
    kind: 'email',
    title: '回李静那封邮件',
    sources: [
      { type: 'gmail', ref: 'gmail:thread/demo-contract', at: '2026-10-28T14:30:00+08:00', read_scope: 'metadata', excerpt: '合同条款确认' },
    ],
  }))
  assert.equal(subject.sources[0].excerpt, '合同条款确认')
  assert.equal(subject.sources[0].excerpt_hash, excerptHash('合同条款确认'))
})

test('the hash of an excerpt ignores surrounding whitespace and changes with the text', () => {
  assert.equal(excerptHash('  同一条证据  '), excerptHash('同一条证据'))
  assert.match(excerptHash('同一条证据'), /^sha256:[0-9a-f]{64}$/)
  assert.notEqual(excerptHash('同一条证据'), excerptHash('另一条证据'))
})
