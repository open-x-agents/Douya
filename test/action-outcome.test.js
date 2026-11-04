import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createActionService } from '../src/web/actions.js'
import { applyActionOutcome, touchedUrls } from '../src/web/action-effects.js'
import { buildSnapshot } from '../src/digest/snapshot.js'
import { doneToday } from '../src/web/day-pulse.js'
import { cardSnapshotText } from '../src/web/card-snapshot.js'

const THREAD = 'https://mail.google.com/mail/u/0/#inbox/1a1a3f2144f1d300'
const mailCard = () => ({ id: 'card_m1', type: 'email-action', source: 'gmail', sourceId: 'gmail:action:gmail:1a1a3f2144f1d300', status: 'active', title: 'Fledge 等你回答', nextAction: '回信 fledge',
  blocks: [{ type: 'link-list', links: [{ title: '[Fledge] 团队需要你回答：Birfy/jitagent', url: THREAD, type: 'email' }] }] })
const memStore = init => { let s = init; return { get: () => s, save: async n => { s = n } } }
const reply = { recipient_email: 'fledge@example.com', subject: 'Re: [Fledge] 团队需要你回答', thread_id: '1a1a3f2144f1d300', body: '定了：继续在 #15 上修', cardId: 'card_m1' }

test('confirmed reply (mock executor): chat line, item handled, card tucked into 今天搞定了什么', async () => {
  const store = memStore({ cards: [mailCard()], itemStatus: {}, completions: [], cardChats: { 'gmail:action:gmail:1a1a3f2144f1d300': [{ role: 'assistant', text: '已准备好，邮件还没发出去' }] }, pendingActions: {} })
  const calls = []
  const svc = createActionService({ store, getClient: () => ({ executeAction: async (slug, args) => { calls.push(slug); return { successful: true, data: { id: 'm2', labelIds: ['SENT'] } } } }), onOutcome: applyActionOutcome })
  const p = await svc.request('gmail_reply', reply, { cardId: 'card_m1' })
  assert.equal(p.pending, true); assert.equal(calls.length, 0, 'nothing runs before 确认执行')
  const r = await svc.userOp({ op: 'confirm', id: p.actionId })
  assert.equal(r.success, true); assert.deepEqual(calls, ['GMAIL_REPLY_TO_THREAD'])
  assert.match(r.outcome.text, /^✓ 已发送 · \d{2}:\d{2}/); assert.equal(r.outcome.cardDone, true)
  const s = store.get()
  assert.equal(s.itemStatus[THREAD].status, 'done'); assert.equal(s.itemStatus[THREAD].by, 'action')
  assert.equal(s.cards[0].status, 'done'); assert.equal(s.cards[0].nextAction, '')
  const chat = s.cardChats['gmail:action:gmail:1a1a3f2144f1d300']
  assert.match(chat.at(-1).text, /已发送/); assert.equal(chat.at(-1).system, true)
  // 今天搞定了什么 counts the send once (not action + item + card)
  const d = doneToday({ completions: s.completions, itemStatus: s.itemStatus, pendingActions: s.pendingActions })
  assert.equal(d.count, 1)
  // the bot's next turn sees it as sent
  assert.match(cardSnapshotText(s.cards[0], s.itemStatus, { actions: s.pendingActions }), /已经发出\/做完；别再说它还没发/)
})

test('failed send: 发送失败 with reason, action stays pending, item untouched', async () => {
  const store = memStore({ cards: [mailCard()], itemStatus: {}, completions: [], cardChats: {}, pendingActions: {} })
  const svc = createActionService({ store, getClient: () => ({ executeAction: async () => { throw new Error('Gmail 401 token expired') } }), onOutcome: applyActionOutcome })
  const p = await svc.request('gmail_reply', reply, { cardId: 'card_m1' })
  const r = await svc.userOp({ op: 'confirm', id: p.actionId })
  assert.equal(r.success, false); assert.equal(r.action.status, 'pending'); assert.match(r.action.error, /401/)
  assert.match(r.outcome.text, /^✗ 发送失败：Gmail 401/)
  const s = store.get()
  assert.equal(s.itemStatus[THREAD], undefined); assert.equal(s.cards[0].status, 'active')
})

test('touchedUrls: thread id / issue number / slack ts map onto the card own links only', () => {
  const gh = { blocks: [{ type: 'link-list', links: [{ url: 'https://github.com/o/r/pull/111' }, { url: 'https://github.com/o/r/issues/12' }] }] }
  assert.deepEqual(touchedUrls(gh, { input: { number: 12, owner: 'o', repo: 'r' } }), ['https://github.com/o/r/issues/12'])
  const sl = { blocks: [{ type: 'link-list', links: [{ url: 'https://x.slack.com/archives/C1/p1730000000123456' }, { url: 'https://x.slack.com/archives/C1/p1730000000999999' }] }] }
  assert.deepEqual(touchedUrls(sl, { input: { thread_ts: '1730000000.123456', text: 'hi' } }), ['https://x.slack.com/archives/C1/p1730000000123456'])
  // a comment on a PR leaves the other items on the card open → card not cleared
  const st = { cards: [{ id: 'g', type: 'project-cluster', status: 'active', ...gh }], itemStatus: {}, completions: [], cardChats: {} }
  const o = applyActionOutcome(st, { id: 'a1', action: 'github_comment', status: 'executed', cardId: 'g', summary: '评论 o/r#111', input: { url: 'https://github.com/o/r/pull/111' } })
  assert.equal(o.marked.length, 1); assert.equal(o.cardDone, false); assert.match(o.text, /已评论.*这一条已标成处理完/)
})

test('next digest: a replied thread stays out, comes back only when the thread moved on', () => {
  const st = { [THREAD]: { status: 'done', by: 'action', at: '2026-11-04T13:00:00Z' } }
  const before = buildSnapshot('gmail', [{ url: THREAD, title: 'x', createdAt: '2026-11-04T12:59:53Z' }], st)
  assert.equal(before.items.length, 0)
  const later = buildSnapshot('gmail', [{ url: THREAD, title: 'x', createdAt: '2026-11-05T02:00:00Z' }], st)
  assert.equal(later.items.length, 1)
  // a plain user done mark never resurfaces
  assert.equal(buildSnapshot('gmail', [{ url: THREAD, title: 'x', createdAt: '2026-11-05T02:00:00Z' }], { [THREAD]: { status: 'done', by: 'user', at: '2026-11-04T13:00:00Z' } }).items.length, 0)
})

test('client shows the outcome line after 确认执行 and labels a failed pending send', () => {
  const html = readFileSync(new URL('../src/client/index.html', import.meta.url), 'utf8')
  assert.match(html, /r\.outcome && r\.outcome\.text\) fresh\.after\(actSysLine/)
  assert.match(html, /'发送失败' : '执行失败'/)
  assert.match(readFileSync(new URL('../src/web/api.js', import.meta.url), 'utf8'), /onOutcome: \(st, a, o\) => applyActionOutcome/)
})
