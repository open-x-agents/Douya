import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  CONFIDENCE_LINE,
  hardKey,
  normalizeEvents,
  softKey,
  subtractStats,
  titleKey,
} from '../src/host/normalize.js'

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'))
const multiSource = read('./fixtures/multi-source.json')
const nearMiss = read('./fixtures/near-miss.json')

const idsOf = (events) => events.map((event) => event.id).sort()
const rotate = (list, by) => list.map((_, index) => list[(index + by) % list.length])

test('the three keys are an external id, a normalized name and a name inside its project', () => {
  const mail = { source: 'gmail', external_id: '18f0d1', title: 'Q4 服务器报价单 v2.docx', project: '报价单' }
  assert.equal(hardKey(mail), 'gmail:thread/18f0d1')
  assert.equal(hardKey({ source: 'gcal', external_id: 'evt-9c31' }), 'gcal:event/evt-9c31')
  assert.equal(hardKey({ source: 'doc', external_id: '7f2a9c' }), 'doc:7f2a9c')
  assert.equal(hardKey({ source: 'github', object: 'pr', external_id: '41' }), 'github:pr/41')
  assert.equal(hardKey({ source: 'github', object: 'issue', external_id: '7' }), 'github:issue/7')
  // No external id means no hard key: a title never becomes one.
  assert.equal(hardKey({ source: 'gmail', title: 'Q4 服务器报价单' }), null)
  assert.equal(titleKey(mail), 'q4服务器报价单')
  assert.equal(titleKey({ title: 'Q4 服务器报价单_v3' }), 'q4服务器报价单')
  assert.equal(softKey({ title: '周报', project: '项目甲' }), '周报|项目甲')
})

test('the three real stories from the demo are three events, not six', () => {
  const events = normalizeEvents(multiSource)
  assert.equal(events.length, 3)
  assert.equal(new Set(idsOf(events)).size, 3)
  assert.deepEqual(events.map((event) => event.project), ['合同', '报价单', '需求评审'])
})

test('the quote appears in mail, a doc and a pull request and stays one card with three pieces of evidence', () => {
  const quote = normalizeEvents(multiSource).find((event) => event.project === '报价单')
  assert.ok(quote, 'the quote event is missing')
  assert.equal(quote.sources.length, 3)
  const prefixes = quote.sources.map((source) => source.ref.slice(0, source.ref.indexOf(':') + 1)).sort()
  assert.deepEqual(prefixes, ['doc:', 'github:', 'gmail:'])
  assert.equal(quote.kind, 'document')
  assert.deepEqual(quote.who.people, ['李静', '王工'])
})

test('two weekly reports in different projects are not merged even though the names match', () => {
  const events = normalizeEvents(nearMiss)
  assert.equal(events.length, 2)
  for (const event of events) {
    assert.equal(event.title, '周报')
    assert.equal(event.sources.length, 1)
    assert.equal(event.maybe_same.length, 1)
  }
  assert.equal(events[0].maybe_same[0].id, events[1].id)
  assert.equal(events[1].maybe_same[0].id, events[0].id)
})

test('a soft pair without a shared person stays two events below the confidence line', () => {
  const events = normalizeEvents([
    { source: 'gmail', external_id: 'aa01', ref: 'gmail:thread/aa01', title: '新接口联调', project: '网关', people: ['王工'], at: '2026-10-30T09:00:00+08:00' },
    { source: 'gmail', external_id: 'bb02', ref: 'gmail:thread/bb02', title: '新接口联调', project: '网关', people: ['张敏'], at: '2026-10-30T10:00:00+08:00' },
  ])
  assert.equal(events.length, 2)
  for (const event of events) {
    assert.ok(event.confidence < CONFIDENCE_LINE)
    assert.ok(event.confidence <= 0.5)
    assert.equal(event.maybe_same.length, 1)
  }
})

test('an unknown field is null, never zero', () => {
  const contract = normalizeEvents(multiSource).find((event) => event.project === '合同')
  assert.ok(contract, 'the contract event is missing')
  assert.equal(contract.due_at, null)
  assert.equal(contract.due_kind, null)
  // Two mails disagree on whether the thread is closed, so the event is unknown rather
  // than the later source winning quietly.
  assert.equal(contract.state, 'unknown')
})

test('shuffling the same sources gives the same ids and the same numbers', () => {
  const forward = normalizeEvents(multiSource)
  const backward = normalizeEvents([...multiSource].reverse())
  const rotated = normalizeEvents(rotate(multiSource, 3))
  assert.deepEqual(idsOf(backward), idsOf(forward))
  assert.deepEqual(idsOf(rotated), idsOf(forward))
  assert.deepEqual(subtractStats(backward), subtractStats(forward))
  assert.deepEqual(subtractStats(rotated), subtractStats(forward))
  assert.deepEqual(subtractStats(forward), { closed: 0, dropped: 0, waiting: 1, total: 3 })
})
