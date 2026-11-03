import { test } from 'node:test'
import assert from 'node:assert/strict'
import { askWithEvidence, evidenceFromCards, evidenceFromGroups, classifyTalk } from '../src/web/ask-bridge.js'

const cards = [{
  id: 'c1', source: 'github', status: 'active', title: 'acme/widgets', url: 'https://github.com/acme/widgets',
  body: 'acme/widgets 有 2 个 PR 等你 review。',
  blocks: [{ type: 'link-list', items: [{ title: '#7 Fix login', url: 'https://github.com/acme/widgets/pull/7' }] }],
}]
const fakeLlm = claims => ({ async *stream() { yield { type: 'text', text: JSON.stringify({ claims }) } } })

test('cards become citable sources, numbers glued to units', () => {
  const s = evidenceFromCards(cards)
  assert.equal(s[0].ref, 'https://github.com/acme/widgets')
  assert.match(s[0].excerpt, /2个 PR/)
  assert.ok(s.some(x => x.ref === 'https://github.com/acme/widgets/pull/7'))
})

test('a drafted claim with a ref from the evidence is answered with a citation', async () => {
  const r = await askWithEvidence({ question: '有哪些 PR 等我 review？', cards, llm: fakeLlm([{ text: 'acme/widgets 有 2个 PR 等你 review。', ref: 'https://github.com/acme/widgets' }]) })
  assert.equal(r.status, 'answered')
  assert.equal(r.citations[0].url, 'https://github.com/acme/widgets')
})

test('an invented number is dropped by the engine, and nothing left means refusal', async () => {
  const r = await askWithEvidence({ question: '有哪些 PR 等我 review？', cards, llm: fakeLlm([{ text: '有 9个 PR 等你。', ref: 'https://github.com/acme/widgets' }]) })
  assert.equal(r.status, 'refused')
  assert.equal(r.citations.length, 0)
})

test('no evidence at all refuses without calling the model', async () => {
  let called = false
  const llm = { async *stream() { called = true; yield { type: 'text', text: '{"claims":[]}' } } }
  const r = await askWithEvidence({ question: '明天天气怎么样？', cards: [], llm })
  assert.equal(r.status, 'refused')
  assert.equal(called, false)
})

test('live groups carry their counts and link to their items', () => {
  const s = evidenceFromGroups([{ key: 'pr:review', label: '等你 review', count: 3, waiting: 'you', why: 'x', links: [{ title: '#1 a', url: 'https://example.test/1' }] }], 'github')
  assert.equal(s[0].ref, 'group:pr:review')
  assert.match(s[0].excerpt, /共3个/)
  assert.equal(s[0].url, 'https://example.test/1')
})

test('greetings and capability questions are talk, not cite-or-refuse', () => {
  assert.equal(classifyTalk('你好'), 'greeting')
  assert.equal(classifyTalk('Hello!'), 'greeting')
  assert.equal(classifyTalk('谢谢'), 'thanks')
  assert.equal(classifyTalk('你是谁'), 'capability')
  assert.equal(classifyTalk('你能做什么？'), 'capability')
  assert.equal(classifyTalk('?'), 'clarify')
  assert.equal(classifyTalk('？？'), 'clarify')
  assert.equal(classifyTalk(''), 'clarify')
  assert.equal(classifyTalk('有哪些 PR 等我 review？'), null)
  assert.equal(classifyTalk('今天 Slack 上有什么需要我回的？'), null)
})

test('你好 answers warmly with no citations and never calls the model', async () => {
  let called = false
  const llm = { async *stream() { called = true; yield { type: 'text', text: '{}' } } }
  const r = await askWithEvidence({ question: '你好', cards, llm })
  assert.equal(r.status, 'answered')
  assert.equal(r.talk, 'greeting')
  assert.equal(r.citations.length, 0)
  assert.match(r.text, /豆芽/)
  assert.equal(called, false)
})

test('? asks a clarifying follow-up instead of refusing for lack of sources', async () => {
  const r = await askWithEvidence({ question: '?', cards: [] })
  assert.equal(r.status, 'answered')
  assert.equal(r.talk, 'clarify')
  assert.match(r.text, /邮件|PR|Slack/)
  assert.equal(r.citations.length, 0)
})
