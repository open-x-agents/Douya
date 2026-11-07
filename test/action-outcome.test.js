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
  assert.match(r.outcome.text, /^✓ Sent · \d{2}:\d{2}/); assert.equal(r.outcome.cardDone, true)
  const s = store.get()
  assert.equal(s.itemStatus[THREAD].status, 'done'); assert.equal(s.itemStatus[THREAD].by, 'action')
  assert.equal(s.cards[0].status, 'done'); assert.equal(s.cards[0].nextAction, '')
  const chat = s.cardChats['gmail:action:gmail:1a1a3f2144f1d300']
  assert.match(chat.at(-1).text, /Sent/); assert.equal(chat.at(-1).system, true)
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
  assert.match(r.outcome.text, /^✗ Send failed: Gmail 401/)
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
  assert.equal(o.marked.length, 1); assert.equal(o.cardDone, false); assert.match(o.text, /Commented.*marked done/)
})

test('reply/comment flips waiting-on-you → waiting-on-them when the card still has open items', () => {
  const gh = {
    id: 'g', type: 'project-cluster', status: 'active', waiting: 'you', nextAction: '催一下 review',
    blocks: [{ type: 'link-list', links: [
      { url: 'https://github.com/o/r/pull/111', title: 'PR 111' },
      { url: 'https://github.com/o/r/pull/7', title: 'PR 7' },
    ] }],
  }
  const st = { cards: [gh], itemStatus: {}, completions: [], cardChats: {} }
  const o = applyActionOutcome(st, {
    id: 'a1', action: 'github_comment', status: 'executed', cardId: 'g',
    summary: '评论 o/r#111', input: { url: 'https://github.com/o/r/pull/111' },
  })
  assert.equal(o.cardDone, false)
  assert.equal(o.marked.length, 1)
  assert.equal(st.cards[0].waiting, 'others')
  assert.equal(st.cards[0].nextAction, '')
  assert.equal(st.itemStatus['https://github.com/o/r/pull/111'].status, 'done')
  assert.equal(st.itemStatus['https://github.com/o/r/pull/7'], undefined)
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
  const html = readFileSync(new URL('../packages/dsh-muse-ui/static/index.html', import.meta.url), 'utf8')
  assert.match(html, /r\.outcome && r\.outcome\.text/)
  assert.match(html, /fresh\.after\(actSysLine/)
  assert.match(html, /r\.outcome\.cardDone/)
  assert.match(html, /loadToday\(\{ force: true \}/)
  assert.match(html, /t\('act\.send_fail'\) : t\('act\.exec_fail'\)/)
  assert.match(readFileSync(new URL('../src/web/api.js', import.meta.url), 'utf8'), /onOutcome: \(st, a, o\) => applyActionOutcome/)
})

test('general chat context: recent sends ride along every turn; undone ones do not', async () => {
  const { recentOutcomesText } = await import('../src/web/action-effects.js')
  const now = Date.parse('2026-11-04T13:10:00Z')
  const st = { cards: [{ ...mailCard(), status: 'done', completedAt: '2026-11-04T12:59:53Z' }, { id: 'c2', type: 'project-cluster', title: '已收掉的 PR 卡', status: 'done', completedAt: '2026-11-04T12:00:00Z' }],
    pendingActions: {
      a1: { id: 'a1', action: 'gmail_reply', status: 'executed', cardId: 'card_m1', summary: '回复邮件给 fledge@example.com', executedAt: '2026-11-04T12:59:53Z' },
      a2: { id: 'a2', action: 'github_comment', status: 'executed', undoneAt: '2026-11-04T13:00:00Z', summary: '评论 o/r#9', executedAt: '2026-11-04T12:50:00Z' },
      a3: { id: 'a3', action: 'gmail_reply', status: 'pending', summary: '回复邮件给 x' },
      a4: { id: 'a4', action: 'gmail_reply', status: 'executed', summary: '很久以前', executedAt: '2026-11-01T12:00:00Z' } } }
  const t = recentOutcomesText(st, { now })
  assert.match(t, /^【刚处理完 · 以此为准】/); assert.match(t, /已发送：回复邮件给 fledge/); assert.match(t, /卡片「Fledge 等你回答」已收掉/)
  assert.match(t, /已收掉卡片：已收掉的 PR 卡/)
  assert.doesNotMatch(t, /o\/r#9|回复邮件给 x|很久以前/)
  assert.equal(recentOutcomesText({ cards: [], pendingActions: {} }, { now }), '')
  const routes = readFileSync(new URL('../src/web/dsh-host-routes.js', import.meta.url), 'utf8')
  assert.match(routes, /doneContext = router\.doneSnapshot\(\)/); assert.match(routes, /doneContext: req\.doneContext/)
  assert.match(readFileSync(new URL('../src/web/muse-chat-core.js', import.meta.url), 'utf8'), /if \(doneText\) outbound = /)
})

test('backfill: pre-existing executed actions go through the outcome path once', async () => {
  const { backfillOutcomes } = await import('../src/web/action-effects.js')
  const now = new Date('2026-11-04T13:10:00Z')
  const gh = { id: 'g', type: 'project-cluster', status: 'active', title: 'r', blocks: [{ type: 'link-list', links: [{ url: 'https://github.com/o/r/pull/111' }, { url: 'https://github.com/o/r/pull/7' }] }] }
  const st = { cards: [gh], itemStatus: {}, completions: [], cardChats: {}, pendingActions: { a: { id: 'a', action: 'github_comment', status: 'executed', cardId: 'g', summary: '评论 o/r#111', input: { url: 'https://github.com/o/r/pull/111' }, executedAt: '2026-11-04T09:12:03Z' } } }
  const r1 = backfillOutcomes(st, { now })
  assert.deepEqual(r1, [{ id: 'a', action: 'github_comment', marked: 1, cardDone: false }])
  assert.equal(st.itemStatus['https://github.com/o/r/pull/111'].by, 'action')
  assert.deepEqual(Object.keys(st.cardChats), [], 'backfill adds no chat spam')
  assert.deepEqual(backfillOutcomes(st, { now }), [], 'idempotent')
})

test('next-step numbers come with matching links on the card (or the next step is dropped)', async () => {
  const { linkCitedNums } = await import('../src/digest/build.js')
  const links = Array.from({ length: 10 }, (_, i) => ({ title: 't' + i, url: `https://github.com/o/FlyBot/issues/${2340 + i}` }))
  const card = { source: 'github', title: 'FlyBot：剩下 6 个 open', nextAction: '从 #2307/#2306/#2305 里挑一个修', blocks: [{ type: 'link-list', links }] }
  const items = [2307, 2306, 2305].map(n => ({ title: 'bug ' + n, url: `https://github.com/o/FlyBot/issues/${n}` }))
  assert.equal(linkCitedNums(card, items), 3)
  const ll = card.blocks[0].links
  assert.equal(ll.length, 10); assert.deepEqual(ll.slice(0, 3).map(l => l.url.split('/').pop()), ['2307', '2306', '2305'])
  assert.equal(card.nextAction, '从 #2307/#2306/#2305 里挑一个修')
  const bad = { source: 'github', title: 'x', nextAction: '先修 #9999', blocks: [{ type: 'link-list', links: [{ url: 'https://github.com/o/FlyBot/issues/1' }] }] }
  linkCitedNums(bad, items); assert.equal(bad.nextAction, '')
})

test('general chat history: a stale 「还没发出去」 is followed by what actually happened', async () => {
  const { annotateHistoryWithOutcomes } = await import('../src/web/action-effects.js')
  const now = Date.parse('2026-11-04T13:10:00Z')
  const msgs = [
    { role: 'user', content: '就按这份草稿准备发' },
    { role: 'assistant', content: '已准备好，**邮件还没发出去**。去豆芽里找到「回复邮件给 fledge@example.com」，点「确认执行」' },
    { role: 'user', content: '今天还有什么' }, { role: 'assistant', content: '还有 #733' }]
  const acts = { a1: { id: 'a1', action: 'gmail_reply', status: 'executed', summary: '回复邮件给 fledge@example.com：「Re: x」', executedAt: '2026-11-04T12:59:53Z' } }
  const out = annotateHistoryWithOutcomes(msgs, acts, { now, lang: 'zh' })
  assert.equal(out.length, 5); assert.match(out[2].content, /^✓ 已发送 · \d{2}:\d{2}　回复邮件给 fledge@example\.com/); assert.equal(out[3].content, '今天还有什么')
  assert.equal(annotateHistoryWithOutcomes(msgs, {}, { now }).length, 4)
  assert.equal(annotateHistoryWithOutcomes(msgs, { a1: { ...acts.a1, status: 'pending' } }, { now }).length, 4, 'still pending → no line')
})
