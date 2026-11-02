// A8/A9/A10/A11 for the evidence ledger: one line per piece of evidence, the hash instead of
// the quote, idempotent appends, and nothing in the module that can change or drop a record.
// Every directory is a fresh mkdtemp(), so the repository's own data/ledger.jsonl is never read
// or written; the demo moments come from test/fixtures/demo-events.json (§3.9).

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { readTextOrNull } from '../src/core/atomic.js'
import { CANONICAL_UTC, excerptHash, localizeDueAt, localizeInstant } from '../src/core/event.js'
import * as ledger from '../src/core/ledger.js'
import { appendEvidence, assertionRecords, explain, explainFrom, parseLedger } from '../src/core/ledger.js'

const LEDGER_SOURCE = fileURLToPath(new URL('../src/core/ledger.js', import.meta.url))
const LEDGER_URL = new URL('../src/core/ledger.js', import.meta.url).href
const FIXTURE = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/demo-events.json', import.meta.url)), 'utf8'),
)

const demos = FIXTURE.events
const temporary = (name) => mkdtemp(join(tmpdir(), `odm-ledger-${name}-`))
const now = () => new Date(RECORDED_AT)
const RECORDED_AT = '2026-10-30T09:00:00.000Z'

// §3.9, row by row: the stored instant and the same instant as the demo shows it in Shanghai.
const EVIDENCE = [
  { eventId: 'evt_demo_quote', ref: 'feishu_msg:chat/oc_demo/msg_2114', at: '2026-10-29T13:14:00.000Z', local: '2026-10-29 21:14' },
  { eventId: 'evt_demo_quote', ref: 'feishu_msg:chat/oc_demo/msg_2116', at: '2026-10-29T13:16:00.000Z', local: '2026-10-29 21:16' },
  { eventId: 'evt_demo_review', ref: 'gcal:event/evt_demo_review', at: '2026-10-29T10:02:00.000Z', local: '2026-10-29 18:02' },
  { eventId: 'evt_demo_review', ref: 'feishu_msg:chat/oc_demo/msg_1028', at: '2026-10-28T04:00:00.000Z', local: '2026-10-28 12:00' },
  { eventId: 'evt_demo_contract', ref: 'gmail:thread/demo-contract', at: '2026-10-28T06:30:00.000Z', local: '2026-10-28 14:30' },
]

const demo = (id) => demos.find((event) => event.id === id)
const ledgerLines = (text) => text.trim().split('\n').filter(Boolean)

// One ingest of one event's whole evidence list, the way a source adapter will call it.
const ingest = (dir, eventId) => {
  const event = demo(eventId)
  return appendEvidence({ dir, eventId, field: 'title', sources: event.sources, now })
}

async function ingestAll(dir) {
  for (const event of demos) await ingest(dir, event.id)
}

test('explain returns every piece of evidence behind a demo event', async () => {
  const dir = await temporary('explain')
  await ingestAll(dir)

  const byEvent = new Map()
  for (const event of demos) byEvent.set(event.id, await explain({ dir, eventId: event.id }))

  // 2 + 2 + 1 pieces of evidence, one event each: the three things in the demo do not split.
  assert.deepEqual([...byEvent.values()].map((records) => records.length), [2, 2, 1])

  const all = [...byEvent.values()].flat()
  assert.equal(all.length, 5)
  assert.deepEqual(all.map((record) => record.seq), [1, 2, 3, 4, 5])

  // Every one of the five rows in §3.9, in the order the demo tells them: the original moment
  // stored as canonical UTC, the same instant as Shanghai reads it, and the source it came from.
  const rows = [...EVIDENCE]
  for (const [eventId, records] of byEvent) {
    const expected = rows.filter((row) => row.eventId === eventId)
    assert.equal(records.length, expected.length, `${eventId} evidence count`)
    records.forEach((record, index) => {
      assert.equal(record.field, 'title')
      assert.equal(record.source_ref, expected[index].ref)
      assert.equal(record.at, expected[index].at)
      assert.match(record.at, CANONICAL_UTC)
      assert.equal(localizeInstant(record.at, { timeZone: 'Asia/Shanghai' }), expected[index].local)
      assert.equal(record.recorded_at, RECORDED_AT)
      assert.match(record.excerpt_hash, /^sha256:[0-9a-f]{64}$/)
    })
  }

  // The three due moments of §3.9: stored as UTC, read as the local clock, and null stays null.
  const quote = demo('evt_demo_quote')
  const review = demo('evt_demo_review')
  const contract = demo('evt_demo_contract')
  assert.equal(quote.due_at, '2026-10-30T02:00:00.000Z')
  assert.equal(review.due_at, '2026-10-30T08:00:00.000Z')
  assert.equal(contract.due_at, null)
  assert.equal(localizeDueAt(quote, { timeZone: 'Asia/Shanghai' }), '2026-10-30 10:00')
  assert.equal(localizeDueAt(review, { timeZone: 'Asia/Shanghai' }), '2026-10-30 16:00')
  assert.equal(localizeDueAt(contract, { timeZone: 'Asia/Shanghai' }), null)
})

test('one evidence record is written per source, with its own ref and original moment', () => {
  const records = assertionRecords('evt_demo_quote', 'title', demo('evt_demo_quote').sources, { now })

  assert.equal(records.length, 2)
  assert.deepEqual(Object.keys(records[0]).sort(), [
    'at',
    'event_id',
    'excerpt_hash',
    'field',
    'recorded_at',
    'source_ref',
  ])
  assert.deepEqual(records, [
    {
      event_id: 'evt_demo_quote',
      field: 'title',
      source_ref: 'feishu_msg:chat/oc_demo/msg_2114',
      at: '2026-10-29T13:14:00.000Z',
      excerpt_hash: excerptHash('报价单今天能给吗？能给的话我下午就签。'),
      recorded_at: RECORDED_AT,
    },
    {
      event_id: 'evt_demo_quote',
      field: 'title',
      source_ref: 'feishu_msg:chat/oc_demo/msg_2116',
      at: '2026-10-29T13:16:00.000Z',
      excerpt_hash: excerptHash('能给，我下午就签。'),
      recorded_at: RECORDED_AT,
    },
  ])

  // A record is worth nothing if it cannot say which event and which assertion it supports.
  assert.throws(
    () => assertionRecords('demo-quote', 'title', demo('evt_demo_quote').sources, { now }),
    (error) => error.code === 'E_BAD_ID',
  )
  assert.throws(
    () => assertionRecords('evt_demo_quote', 'Due At', demo('evt_demo_quote').sources, { now }),
    (error) => error.code === 'E_BAD_FIELD',
  )
  // A source that the event model would refuse is refused here with the same code.
  assert.throws(
    () => assertionRecords('evt_demo_quote', 'title', [{ type: 'gcal', ref: 'feishu_msg:x', at: RECORDED_AT, read_scope: 'body', excerpt: 'x' }], { now }),
    (error) => error.code === 'E_SOURCE_REF_BAD',
  )
})

test('the ledger keeps the hash, never the quote', async () => {
  const dir = await temporary('hash-only')
  await ingestAll(dir)

  const text = await readFile(join(dir, 'ledger.jsonl'), 'utf8')

  assert.ok(!text.includes('报价单今天能给吗'), 'the quote itself is not in the ledger')
  assert.ok(!text.includes('合同附件'), 'the mail subject is hashed too, not kept')
  assert.ok(!text.includes('材料周三定'))
  assert.match(text, /"excerpt_hash":"sha256:[0-9a-f]{64}"/)
  assert.ok(!text.includes('"excerpt"'), 'no record carries the source text')
})

test('appending the same evidence twice does not double the ledger', async () => {
  const dir = await temporary('idempotent')

  const first = []
  for (const event of demos) first.push(await ingest(dir, event.id))
  assert.deepEqual(first.map((result) => result.appended), [2, 2, 1])
  assert.deepEqual(first.map((result) => result.skipped), [0, 0, 0])

  const text = await readFile(join(dir, 'ledger.jsonl'), 'utf8')
  assert.equal(ledgerLines(text).length, 5)

  // A rerun of the same ingest is a no-op: five records skipped, none appended, the file intact.
  const second = []
  for (const event of demos) second.push(await ingest(dir, event.id))
  assert.equal(second.reduce((total, result) => total + result.appended, 0), 0)
  assert.equal(second.reduce((total, result) => total + result.skipped, 0), 5)
  assert.deepEqual(second.map((result) => result.skipped), [2, 2, 1])

  const after = await readFile(join(dir, 'ledger.jsonl'), 'utf8')
  assert.equal(after, text, 'the second run leaves the file byte for byte as it was')
  assert.equal(await readTextOrNull(join(dir, 'store.lock')), null)
})

test('the hash of an excerpt ignores surrounding whitespace and changes with the text', async () => {
  const dir = await temporary('hash')
  const sources = [
    { type: 'feishu_msg', ref: 'feishu_msg:chat/oc_demo/msg_2001', at: '2026-10-29T13:14:00.000Z', read_scope: 'body', excerpt: '  材料周三定 \n' },
    { type: 'feishu_msg', ref: 'feishu_msg:chat/oc_demo/msg_2002', at: '2026-10-29T13:14:00.000Z', read_scope: 'body', excerpt: '材料周四定' },
  ]

  const records = assertionRecords('evt_demo_quote', 'title', sources, { now })
  assert.equal(records[0].excerpt_hash, excerptHash('材料周三定'))
  assert.notEqual(records[0].excerpt_hash, records[1].excerpt_hash)

  const result = await appendEvidence({ dir, eventId: 'evt_demo_quote', field: 'title', sources, now })
  assert.deepEqual(result, { appended: 2, skipped: 0 })

  const text = await readFile(join(dir, 'ledger.jsonl'), 'utf8')
  assert.ok(!text.includes('材料周三定'))
  assert.ok(!text.includes('材料周四定'))
})

test('explain of an unknown event returns nothing instead of inventing evidence', async () => {
  const dir = await temporary('unknown')
  await ingestAll(dir)

  const text = await readFile(join(dir, 'ledger.jsonl'), 'utf8')
  assert.deepEqual(explainFrom(parseLedger(text).records, 'evt_nope'), [])
  assert.deepEqual(await explain({ dir, eventId: 'evt_nope' }), [])

  // A directory with no ledger at all is an empty explanation, not an error.
  assert.deepEqual(await explain({ dir: await temporary('empty'), eventId: 'evt_demo_quote' }), [])
  assert.deepEqual(parseLedger(''), { records: [], skippedTail: 0 })
})

test('the ledger module can only add records', () => {
  // Five exports, and the set is the contract: no update, no delete, no rewrite.
  assert.deepEqual(Object.keys(ledger).sort(), [
    'appendEvidence',
    'assertionRecords',
    'explain',
    'explainFrom',
    'parseLedger',
  ])

  // Reading the module's own text keeps the source honest: a module that never mentions these
  // words cannot grow a delete or a rewrite behind the export list.
  const source = readFileSync(LEDGER_SOURCE, 'utf8')
  assert.doesNotMatch(source, /writeFile|rename|unlink|truncate|rm\(/)
})

test('a changed excerpt adds a second record instead of rewriting the first', async () => {
  const dir = await temporary('changed')
  const before = {
    type: 'feishu_msg',
    ref: 'feishu_msg:chat/oc_demo/msg_2114',
    at: '2026-10-29T13:14:00.000Z',
    read_scope: 'body',
    excerpt: '报价单今天能给吗？',
  }
  const after = { ...before, excerpt: '报价单今天能给吗？能给的话我下午就签。' }

  assert.deepEqual(await appendEvidence({ dir, eventId: 'evt_demo_quote', field: 'title', sources: [before], now }), {
    appended: 1,
    skipped: 0,
  })
  const original = await readFile(join(dir, 'ledger.jsonl'), 'utf8')

  assert.deepEqual(await appendEvidence({ dir, eventId: 'evt_demo_quote', field: 'title', sources: [after], now }), {
    appended: 1,
    skipped: 0,
  })
  const grown = await readFile(join(dir, 'ledger.jsonl'), 'utf8')

  // The first record is still there, byte for byte: the change is new evidence, not an edit.
  assert.ok(grown.startsWith(original), 'the old line is unchanged')
  const records = parseLedger(grown).records
  assert.equal(records.length, 2)
  assert.deepEqual(records.map((record) => record.seq), [1, 2])
  assert.notEqual(records[0].excerpt_hash, records[1].excerpt_hash)
  assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith('.tmp')), [])
})

test('a torn last line is skipped while a broken line in the middle is reported', async () => {
  const good = (seq) => ({
    seq,
    event_id: 'evt_demo_quote',
    field: 'title',
    source_ref: `feishu_msg:chat/oc_demo/msg_${2100 + seq}`,
    at: '2026-10-29T13:14:00.000Z',
    excerpt_hash: excerptHash(`证据 ${seq}`),
    recorded_at: RECORDED_AT,
  })

  // A writer died mid-append: the last line has no newline and no closing brace.
  const torn = `${JSON.stringify(good(1))}\n${JSON.stringify(good(2))}\n{"seq":3,"event_id":"evt_demo_qu`
  const parsed = parseLedger(torn)
  assert.equal(parsed.records.length, 2)
  assert.equal(parsed.skippedTail, 1)

  // Appending on top of that half line would fuse two records, so the writer refuses instead.
  const dir = await temporary('torn')
  await writeFile(join(dir, 'ledger.jsonl'), torn)
  await assert.rejects(
    appendEvidence({ dir, eventId: 'evt_demo_quote', field: 'title', sources: demo('evt_demo_quote').sources, now }),
    (error) => error.code === 'E_CORRUPT_LEDGER' && error.line === 3,
  )

  // A damaged line above the tail is not a crash: it is the file lying about the evidence.
  const middle = `${JSON.stringify(good(1))}\nnot a record\n${JSON.stringify(good(2))}\n`
  assert.throws(
    () => parseLedger(middle),
    (error) => error.code === 'E_CORRUPT_LEDGER' && error.line === 2,
  )

  // Two records claiming the same position in the sequence cannot both be true.
  assert.throws(
    () => parseLedger(`${JSON.stringify(good(1))}\n${JSON.stringify({ ...good(1), source_ref: 'feishu_msg:chat/oc_demo/msg_9' })}\n`),
    (error) => error.code === 'E_CORRUPT_LEDGER' && error.line === 2,
  )

  // Blank lines are not damage; a record missing a key is.
  assert.equal(parseLedger(`${JSON.stringify(good(1))}\n\n${JSON.stringify(good(2))}\n`).records.length, 2)
  const { excerpt_hash: _dropped, ...missingHash } = good(1)
  assert.throws(
    () => parseLedger(`${JSON.stringify(missingHash)}\n`),
    (error) => error.code === 'E_CORRUPT_LEDGER' && error.line === 1,
  )
})

// Two real processes, both ready before the first append: only the store lock keeps their
// read-the-whole-ledger-then-append steps from handing out the same seq twice.
function appendInChild(dir, refs, startAt) {
  const script = `
import { appendEvidence } from ${JSON.stringify(LEDGER_URL)}
const config = ${JSON.stringify({ dir, refs, startAt })}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
while (Date.now() < config.startAt) await sleep(2)
let appended = 0
let skipped = 0
for (const ref of config.refs) {
  const result = await appendEvidence({
    dir: config.dir,
    eventId: 'evt_demo_quote',
    field: 'title',
    sources: [{ type: 'feishu_msg', ref, at: '2026-10-29T13:14:00.000Z', read_scope: 'body', excerpt: '证据 ' + ref }],
    now: () => new Date(${JSON.stringify(RECORDED_AT)}),
  })
  appended += result.appended
  skipped += result.skipped
}
process.stdout.write(JSON.stringify({ appended, skipped }) + '\\n')
`
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(JSON.parse(stdout))
      else reject(new Error(`ledger child exited ${code}\n${stderr}`))
    })
  })
}

test('two processes appending at once produce one unbroken sequence', async () => {
  const dir = await temporary('two-processes')
  const startAt = Date.now() + 150
  const refsFor = (index) =>
    Array.from({ length: 20 }, (_, step) => `feishu_msg:chat/oc_demo/w${index}/msg_${step + 1}`)

  const results = await Promise.all([
    appendInChild(dir, refsFor(1), startAt),
    appendInChild(dir, refsFor(2), startAt),
  ])

  assert.deepEqual(results.map((result) => result.appended), [20, 20])
  assert.deepEqual(results.map((result) => result.skipped), [0, 0])

  const records = parseLedger(await readFile(join(dir, 'ledger.jsonl'), 'utf8')).records
  assert.equal(records.length, 40)
  assert.deepEqual(records.map((record) => record.seq), Array.from({ length: 40 }, (_, index) => index + 1))
  assert.equal(new Set(records.map((record) => record.source_ref)).size, 40)
  assert.equal(await readTextOrNull(join(dir, 'store.lock')), null)
})
