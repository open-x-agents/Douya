// Card faces (Phase B): bot-picked layout specs validated against the card's own items, hydrated live.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateFace, hydrateFace, autoFace, facePrompt, FACE_LAYOUTS } from '../src/ui/face.js'
import { buildSnapshot } from '../src/digest/snapshot.js'
import { validateCandidates } from '../src/digest/build.js'
import { liveCard } from '../src/ui/hydrate.js'

const NOW = Date.parse('2026-11-04T08:00:00.000Z')
const U = n => `https://x.slack.com/archives/C1/p${n}`
const slackCard = () => ({
  id: 'c1', type: 'slack-cluster', source: 'slack', waiting: 'you', status: 'active',
  blocks: [{ type: 'link-list', links: [
    { url: U(1), title: '合同什么时候能签？', from: '王小明', text: '合同什么时候能签？今天能给答复吗', needsYou: true, at: '2026-11-03T07:00:00.000Z' },
    { url: U(2), title: 'PR 帮忙看下', from: 'bkp.yuan (dev)', text: '帮忙看下 #12', at: '2026-11-04T06:00:00.000Z' },
    { url: 'http://insecure.example/x', title: 'dropped' },
  ] }],
})

test('validateFace: unknown layout rejected, foreign refs dropped, html note stripped', () => {
  assert.equal(validateFace({ layout: 'nope' }).face, null)
  assert.equal(validateFace('not json').face, null)
  assert.equal(validateFace(null).face, null)
  const allowed = new Set([U(1)])
  const { face, errors } = validateFace({ layout: 'waiting', focus: [U(1), 'https://evil.example', U(1)], quote: 'https://evil.example', note: '<script>x</script>' }, { allowed })
  assert.deepEqual(face.focus, [U(1)]); assert.equal(face.quote, null); assert.equal(face.note, '')
  assert.ok(errors.length >= 3)
  for (const k of Object.keys(FACE_LAYOUTS)) assert.ok(facePrompt().includes(k))
})

test('waiting face: real people, how long, the original words', () => {
  const v = hydrateFace(slackCard(), autoFace(slackCard()), { now: NOW, lang: 'zh' })
  assert.equal(v.layout, 'waiting')
  const people = v.parts.find(p => p.type === 'people').people.map(p => p.name)
  assert.deepEqual(people, ['王小明', 'bkp.yuan'])
  const stats = v.parts.find(p => p.type === 'stats').pairs
  assert.equal(stats[0].value, '25 小时'); assert.equal(stats[0].tone, 'hot')
  assert.match(v.parts.find(p => p.type === 'quote').text, /合同什么时候能签/)
  assert.ok(v.parts.some(p => p.type === 'cta'))
})

test('progress + checklist follow live item status; focus orders rows', () => {
  const card = slackCard()
  const spec = { layout: 'progress', focus: [U(2)], by: 'bot' }
  let v = hydrateFace(card, spec, { now: NOW, lang: 'zh' })
  assert.equal(v.parts.find(p => p.type === 'stage').done, 0)
  assert.equal(v.parts.find(p => p.type === 'checklist').items[0].url, U(2), 'focused item first')
  v = hydrateFace(card, spec, { now: NOW, lang: 'zh', itemStatus: { [U(2)]: { status: 'done' } } })
  assert.equal(v.parts.find(p => p.type === 'stage').label, '已处理 1 / 2')
  assert.deepEqual(v.parts.find(p => p.type === 'checklist').items.map(i => i.url), [U(1)])
  v = hydrateFace(card, spec, { now: NOW, lang: 'zh', itemStatus: { [U(1)]: { status: 'done' }, [U(2)]: { status: 'dismissed' } } })
  assert.equal(v.parts.find(p => p.type === 'checklist').done, true)
})

test('honest empty: no links → no face; meeting without a future event → no face', () => {
  assert.equal(hydrateFace({ id: 'x', type: 'task' }, { layout: 'checklist' }), null)
  assert.equal(autoFace({ id: 'x', type: 'hero', blocks: [] }), null)
  assert.equal(hydrateFace({ id: 'm', type: 'task' }, { layout: 'meeting' }, { now: NOW, lang: 'zh', events: [{ title: 'old', start: '2026-11-04T07:00:00.000Z' }] }), null)
  const m = hydrateFace({ id: 'm', type: 'task' }, { layout: 'meeting' }, { now: NOW, lang: 'zh', events: [{ title: '周会', start: '2026-11-04T08:10:00.000Z', url: 'https://meet.google.com/abc' }] })
  assert.equal(m.parts[0].type, 'countdown'); assert.equal(m.parts[0].url, 'https://meet.google.com/abc')
})

test('validateCandidates: face refs resolve only to the candidate own items', () => {
  const mail = (id, s) => ({ source: 'gmail', type: 'email-unread', sourceId: `gmail:${id}`, title: s, url: `https://mail.google.com/mail/u/0/#inbox/${id}`, body: 'From: A <a@x.com>', createdAt: '2026-11-04T01:00:00.000Z', metadata: { from: 'A <a@x.com>', snippet: s, labelIds: [] } })
  const snap = buildSnapshot('gmail', [mail('a1', 'one?'), mail('a2', 'two?')], {})
  const [r1, r2] = snap.rows.map(r => r.ref)
  const v = validateCandidates('gmail', [
    { title: 'one', category: 'single', needsAction: true, items: [r1], face: { layout: 'waiting', focus: [r1, r2], quote: r1, note: '对方在等' } },
    { title: 'two', category: 'single', needsAction: true, items: [r2], face: { layout: 'bogus' } },
  ], snap)
  const [a, b] = v.candidates
  assert.equal(a.face.layout, 'waiting'); assert.deepEqual(a.face.focus, ['https://mail.google.com/mail/u/0/#inbox/a1'])
  assert.equal(a.face.quote, 'https://mail.google.com/mail/u/0/#inbox/a1')
  assert.equal(b.face, undefined)
  assert.ok(v.errors.some(e => /bogus/.test(e)) && v.errors.some(e => /focus/.test(e)))
})

test('liveCard: saved views follow merges and re-created daily ids', () => {
  const state = { cards: [
    { id: 'old_2026-11-03', sourceId: 'gmail:group:fyi', status: 'merged', mergedInto: 'new1' },
    { id: 'new1', sourceId: 'gmail:group:fyi', status: 'active', updatedAt: '2026-11-04' },
    { id: 'gh_2026-11-03', sourceId: 'github:repo:a', status: 'archived' },
    { id: 'gh_2026-11-04', sourceId: 'github:repo:a', status: 'active', updatedAt: '2026-11-04' },
  ] }
  assert.equal(liveCard(state, 'old_2026-11-03').id, 'new1')
  assert.equal(liveCard(state, 'gh_2026-11-03').id, 'gh_2026-11-04')
  assert.equal(liveCard(state, 'missing'), null)
})

test('quote face: author in quote part, link chip for bare URL, no 谁说的 people row', () => {
  const card = {
    id: 'c2', type: 'slack-cluster', source: 'slack', status: 'active',
    blocks: [{ type: 'link-list', links: [{
      url: U(9), title: 'repo', from: 'bkp.yuan',
      text: 'https://github.com/D4Vinci/Scrapling', at: '2026-11-04T01:51:00.000Z',
    }] }],
  }
  const v = hydrateFace(card, { layout: 'quote', by: 'auto' }, { now: NOW, lang: 'zh' })
  assert.equal(v.layout, 'quote')
  assert.equal(v.parts.some(p => p.type === 'people'), false)
  const q = v.parts.find(p => p.type === 'quote')
  assert.equal(q.from, 'bkp.yuan')
  assert.equal(q.text, '')
  assert.equal(q.link.host, 'github.com')
  assert.equal(q.link.label, 'D4Vinci/Scrapling')
  assert.ok(v.parts.some(p => p.type === 'cta'))
})

test('quote face: prose kept, trailing URL becomes chip', () => {
  const card = {
    id: 'c3', type: 'slack-cluster', source: 'slack', status: 'active',
    blocks: [{ type: 'link-list', links: [{
      url: U(8), title: 't', from: '王小明',
      text: '合同看一下 https://github.com/acme/repo/pull/12', at: '2026-11-04T02:00:00.000Z',
    }] }],
  }
  const q = hydrateFace(card, { layout: 'quote' }, { now: NOW }).parts.find(p => p.type === 'quote')
  assert.match(q.text, /合同看一下/)
  assert.equal(q.link.label, 'acme/repo')
})


test('face chrome localizes to English when lang=en', () => {
  const v = hydrateFace(slackCard(), autoFace(slackCard()), { now: NOW, lang: 'en' })
  assert.equal(v.layout, 'waiting')
  assert.equal(v.parts.find(p => p.type === 'people').label, 'Waiting on you')
  const stats = v.parts.find(p => p.type === 'stats').pairs
  assert.equal(stats[0].label, 'Waiting')
  assert.equal(stats[0].value, '25h')
  assert.equal(stats[1].label, 'To reply')
})
