import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { anchorsOf, askQuestion, evidenceFromState, refusalText, supportedClaim } from '../src/host/ask.js'

const fixture = JSON.parse(await readFile(new URL('./fixtures/ask-day.json', import.meta.url), 'utf8'))
const byRef = new Map(fixture.sources.map((source) => [source.ref, source]))
const evidenceFor = (refs) => refs.map((ref) => byRef.get(ref)).filter(Boolean)

test('an answer about a meeting in the calendar carries at least one source ref and its clock', () => {
  const question = fixture.questions.calendar
  const result = askQuestion({
    text: question.text,
    sources: evidenceFor(question.refs),
    unread: question.unread,
  })
  assert.equal(result.status, 'answered')
  assert.ok(result.citations.length >= 1)
  assert.equal(result.citations[0].ref, 'gcal:event/evt-77')
  assert.equal(result.citations[0].clock, '14:00')
  assert.match(result.answer, /14:00/)
})

test('a mail-thread answer stops at the subject and says the body was not read', () => {
  const question = fixture.questions.mail
  const sources = evidenceFor(question.refs)
  assert.equal(
    JSON.stringify(sources).includes(fixture.mail_body_sentinel),
    false,
    'the evidence never carries the body',
  )
  const result = askQuestion({ text: question.text, sources, unread: question.unread })
  assert.match(result.answer, /供应商报价 v3/)
  assert.match(result.answer, /没读正文/)
  assert.equal(result.citations[0].ref, 'gmail:thread/9a1')
  assert.equal(result.status, 'partial')
  assert.ok(result.limits.includes('gmail:body'))
  assert.equal(JSON.stringify(result).includes(fixture.mail_body_sentinel), false)
})

test('a question whose source is not connected is refused and names the missing source', () => {
  const question = fixture.questions.missing
  const model = { calls: 0 }
  const result = askQuestion({
    text: question.text,
    sources: evidenceFor(question.refs),
    unread: question.unread,
    model: () => {
      model.calls += 1
      return { claims: [] }
    },
  })
  assert.equal(result.status, 'refused')
  assert.match(result.answer, /这条我答不了/)
  assert.match(result.answer, /飞书日历/)
  assert.deepEqual(result.unread_sources, ['gcal'])
  assert.equal(model.calls, 0)
  assert.deepEqual(result.citations, [])
})

test('ten questions drawn from one fixture all resolve their citations inside the same evidence', () => {
  const results = fixture.ten_questions.map((question) => {
    const allowed = new Set(question.refs)
    const result = askQuestion({
      text: question.text,
      sources: evidenceFor(question.refs),
      unread: question.unread,
    })
    if (result.status === 'refused') {
      assert.ok(result.unread_sources.length >= 1, `${question.text} must name what it lacks`)
    } else {
      assert.ok(result.citations.length >= 1, `${question.text} must carry a citation`)
      for (const citation of result.citations) {
        assert.ok(allowed.has(citation.ref), `${question.text} cites ${citation.ref} outside its evidence`)
      }
    }
    return result
  })
  assert.equal(results.length, 10)
})

test('a stub model that says Friday when the source never does is refused and the answer never says Friday', () => {
  const question = fixture.questions.calendar
  const sources = evidenceFor(question.refs)
  assert.equal(JSON.stringify(sources).includes('周五'), false, 'the question's evidence never says Friday')
  const result = askQuestion({
    text: question.text,
    sources,
    unread: [],
    model: () => ({ claims: [{ text: '周五下午三点评审', ref: 'gcal:event/evt-77' }] }),
  })
  assert.equal(result.status, 'refused')
  assert.equal(result.dropped[0].code, 'E_UNSUPPORTED')
  assert.equal(result.answer.includes('周五'), false)
})

test('a claim that cites a ref outside the evidence is dropped instead of shown', () => {
  const question = fixture.questions.calendar
  const claim = { text: '会议改到 16:00', ref: 'gcal:event/not-in-evidence' }
  const result = askQuestion({
    text: question.text,
    sources: evidenceFor(question.refs),
    unread: [],
    model: () => ({ claims: [claim] }),
  })
  assert.equal(result.status, 'refused')
  assert.equal(result.dropped[0].code, 'E_NO_REF')
  assert.equal(result.answer.includes(claim.text), false)
  assert.equal(result.citations.some((citation) => citation.ref === claim.ref), false)
})

test('the ask engine never calls the network and never writes outside the store', async () => {
  const engine = await readFile(new URL('../src/host/ask.js', import.meta.url), 'utf8')
  for (const forbidden of ['fetch(', 'http://', 'https://', 'writeFile', 'appendFile', 'spawn', 'exec(']) {
    assert.equal(engine.includes(forbidden), false, `${forbidden} must not appear in the engine`)
  }
  const result = askQuestion({ text: '产品评审几点开始？', sources: evidenceFor(['gcal:event/evt-77']) })
  assert.equal(typeof result, 'object')
})

test('an anchor has to appear in the cited source, not just in the claim', () => {
  const source = byRef.get('gcal:event/evt-77')
  assert.deepEqual(anchorsOf('周五下午三点评审').sort(), ['三点', '周五'].sort())
  assert.equal(supportedClaim({ text: '产品评审 14:00', ref: source.ref }, source).ok, true)
  assert.equal(supportedClaim({ text: '产品评审 16:00', ref: source.ref }, source).code, 'E_UNSUPPORTED')
  assert.equal(supportedClaim({ text: '', ref: source.ref }, source).code, 'E_EMPTY_CLAIM')
  assert.equal(supportedClaim({ text: '产品评审', ref: 'gcal:event/not-there' }, undefined).code, 'E_NO_REF')
})

test('the default evidence provider turns upcoming events into calendar sources', () => {
  const state = {
    upcoming: [{ id: 'evt-77', title: '产品评审', startAt: '2026-10-31T14:00:00Z', fireAt: '2026-10-31T13:50:00Z' }],
    unread_sources: ['gmail'],
  }
  const evidence = evidenceFromState(state)
  assert.equal(evidence.sources[0].ref, 'gcal:event/evt-77')
  assert.equal(evidence.sources[0].clock, '14:00')
  assert.deepEqual(evidence.unread, ['gmail'])
  assert.equal(refusalText({ sources: [], unread: ['gcal'] }), '这条我答不了：飞书日历 没连上。')
})
