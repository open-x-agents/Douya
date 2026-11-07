import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prepareCardActions, pickNextThing, daySummaryLine, tomorrowMorning, snoozeUntilFor } from '../src/web/card-prep.js'
import { createActionService, ACTIONS } from '../src/web/actions.js'

const mail = (over = {}) => ({ id: 'm1', type: 'email-group', source: 'gmail', title: '服务与通知', waiting: 'fyi', priority: 'low', status: 'active',
  blocks: [{ type: 'link-list', links: [
    { title: 'A', url: 'https://mail.google.com/mail/u/0/#inbox/aaa111', type: 'email' },
    { title: 'B', url: 'https://mail.google.com/mail/u/0/#inbox/bbb222', type: 'email' }] }], ...over })
const gh = (over = {}) => ({ id: 'g1', type: 'project-cluster', source: 'github', title: 'jitagent', priority: 'high', waiting: 'others', status: 'active',
  blocks: [{ type: 'link-list', links: [{ title: 'Fix x', url: 'https://github.com/o/r/pull/17', type: 'pr-mine' }] }], ...over })

test('fyi mail group: archive-all with only the open items, then 明天再看', () => {
  const steps = prepareCardActions(mail(), { itemStatus: { 'https://mail.google.com/mail/u/0/#inbox/bbb222': { status: 'done' } }, lang: 'zh' })
  assert.deepEqual(steps.map(s => s.id), ['archive-all', 'snooze'])
  assert.equal(steps[0].label, '归档这封')
  assert.equal(prepareCardActions(mail(), { itemStatus: { 'https://mail.google.com/mail/u/0/#inbox/bbb222': { status: 'done' } }, lang: 'en' })[0].label, 'Archive this')
  assert.deepEqual(steps[0].input.items.map(i => i.url), ['https://mail.google.com/mail/u/0/#inbox/aaa111'])
})

test('needs-you mail: a reply draft request naming the real mail; no archive offered', () => {
  const steps = prepareCardActions(mail({ waiting: 'you' }))
  assert.equal(steps[0].kind, 'ask')
  assert.match(steps[0].prompt, /inbox\/aaa111/)
  assert.ok(!steps.some(s => s.id === 'archive-all'))
})

test('my PR waiting on others: nudge comment prepared; waiting on me: ask where it is stuck', () => {
  const a = prepareCardActions(gh(), { lang: 'zh' })
  assert.equal(a[0].action, 'github_comment'); assert.equal(a[0].input.url, 'https://github.com/o/r/pull/17')
  assert.match(a[0].label, /催一下 #17/)
  assert.match(prepareCardActions(gh(), { lang: 'en' })[0].label, /Nudge #17/)
  assert.match(a[0].input.body, /叮一下：#17/)
  assert.match(a[0].input.body, /[一-龥]/) // Chinese, not the old English template
  const b = prepareCardActions(gh({ waiting: 'you' }), { lang: 'zh' })
  assert.equal(b[0].kind, 'ask'); assert.match(b[0].label, /#17/)
})

test('system tiles get nothing; links never invented', () => {
  assert.deepEqual(prepareCardActions({ id: 'h', type: 'hero', source: 'system' }), [])
  for (const s of prepareCardActions(gh())) if (s.input?.url) assert.match(s.input.url, /^https:\/\/github\.com\/o\/r\//)
})

test('next thing: meeting within 15 min wins; else top needs-you card; else none', () => {
  const now = new Date('2026-11-04T10:00:00+08:00')
  const tt = { id: 't', type: 'timetable', blocks: [{ type: 'timetable', fixedBlocks: [{ start: '2026-11-04T10:10:00+08:00', end: '2026-11-04T10:40:00+08:00', title: '周会', url: 'https://meet.google.com/x' }], suggestedBlocks: [] }] }
  const m = pickNextThing({ cards: [tt, gh({ waiting: 'you' })], now, lang: 'zh' })
  assert.equal(m.kind, 'meeting'); assert.equal(m.buttons[0].url, 'https://meet.google.com/x'); assert.match(m.why, /10 分钟后/)
  const later = pickNextThing({ cards: [tt, gh({ waiting: 'you' })], now: new Date('2026-11-04T09:00:00+08:00'), lang: 'zh' })
  assert.equal(later.kind, 'card')
  // Ready CTA first (keeps prepared label), then Start, then Snooze — not a generic Ask overwrite.
  assert.equal(later.buttons[0].kind, 'ask')
  assert.match(later.buttons[0].label, /#17/)
  assert.deepEqual(later.buttons.slice(1).map(b => b.label), ['开始', '推迟'])
  assert.equal(later.upcoming.title, '周会')
  assert.equal(pickNextThing({ cards: [], now, lang: 'zh' }).kind, 'none')
})

test('summary line counts only real data', () => {
  assert.equal(daySummaryLine({ lang: 'zh',  cards: [mail(), gh({ waiting: 'you' })], meetings: 0 }), '没有会 · 1 件等你 · 1 个 PR · 2 封邮件')
})

test('tomorrowMorning is 09:00 Asia/Shanghai', () => {
  assert.equal(tomorrowMorning(new Date('2026-11-04T23:30:00+08:00')), '2026-11-05T01:00:00.000Z')
})

test('prepared reversible action is still held for 确认执行 (hold), batch archive undoes every mail', async () => {
  let state = { pendingActions: {} }
  const store = { get: () => state, save: async s => { state = { ...state, ...s } } }
  const calls = []
  const client = { executeAction: async (slug, args) => { calls.push([slug, args]); return slug === 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID' ? { data: { labelIds: ['INBOX'] } } : { successful: true, data: {} } } }
  const svc = createActionService({ store, getClient: () => client })
  const r = await svc.request('gmail_archive_many', { items: [{ url: 'https://mail.google.com/mail/u/0/#inbox/aaa111' }, { url: 'https://mail.google.com/mail/u/0/#inbox/bbb222' }] }, { cardId: 'm1', hold: true, prepId: 'archive-all' })
  assert.equal(r.pending, true); assert.equal(calls.length, 0, 'nothing runs before confirm')
  const done = await svc.userOp({ op: 'confirm', id: r.actionId })
  assert.equal(done.success, true); assert.equal(done.action.canUndo, true)
  assert.equal(calls.filter(c => c[0] === 'GMAIL_ADD_LABEL_TO_EMAIL').length, 2)
  await svc.userOp({ op: 'undo', id: r.actionId })
  assert.equal(calls.filter(c => c[0] === 'GMAIL_ADD_LABEL_TO_EMAIL').length, 4)
  assert.ok(ACTIONS.gmail_archive_many.preview({ items: [{ title: 'x' }] }).body.includes('x'))
})

test('automated mail that "needs you": check it, never draft a reply to a robot', () => {
  const c = mail({ waiting: 'you', blocks: [{ type: 'link-list', links: [
    { title: '安全提醒', url: 'https://mail.google.com/mail/u/0/#inbox/sec1', type: 'email', from: 'Google <no-reply@accounts.google.com>' },
    { title: 'CI failed', url: 'https://mail.google.com/mail/u/0/#inbox/ci2', type: 'email', from: 'notifications@github.com' },
    { title: 'Build', url: 'https://mail.google.com/mail/u/0/#inbox/ci3', type: 'email', from: 'GitHub Actions' }] }] })
  const steps = prepareCardActions(c)
  assert.equal(steps[0].id, 'check-first'); assert.equal(steps[1].id, 'archive-all')
  const h = prepareCardActions(mail({ waiting: 'you', blocks: [{ type: 'link-list', links: [
    { title: 'CI', url: 'https://mail.google.com/mail/u/0/#inbox/ci2', type: 'email', from: 'notifications@github.com' },
    { title: '周五见？', url: 'https://mail.google.com/mail/u/0/#inbox/hum', type: 'email', from: '王小明' }] }] }))
  assert.equal(h[0].id, 'reply-first'); assert.match(h[0].prompt, /inbox\/hum/)
})

test('machine mail groups (code / security) never get a reply draft', () => {
  const c = mail({ waiting: 'you', metadata: { group: 'security' }, blocks: [{ type: 'link-list', links: [{ title: '安全提醒', url: 'https://mail.google.com/mail/u/0/#inbox/s1', type: 'email', from: 'Google' }] }] })
  assert.equal(prepareCardActions(c)[0].id, 'check-first')
})

test('snoozeUntilFor: 1h / tomorrow / week presets', () => {
  const now = new Date('2026-11-04T10:00:00+08:00')
  const h1 = new Date(snoozeUntilFor('snooze:1h', now)).getTime()
  assert.equal(h1 - now.getTime(), 3600e3)
  const tm = snoozeUntilFor('snooze:tomorrow', now)
  assert.equal(tm, tomorrowMorning(now))
  assert.equal(snoozeUntilFor('snooze', now), tomorrowMorning(now))
  const wk = new Date(snoozeUntilFor('snooze:week', now))
  // +7 days at 09:00 Shanghai
  assert.equal(wk.toISOString(), snoozeUntilFor('snooze:week', now))
  const local = new Date(now.getTime() + 8 * 3600e3)
  assert.equal(wk.getUTCHours() + 8 === 9 || ((wk.getUTCHours() + 8) % 24) === 9, true)
  assert.ok(wk.getTime() > now.getTime() + 6 * 86400e3)
})


test('low-priority waiting-on-you still becomes the next thing', () => {
  const now = new Date('2026-11-04T10:00:00+08:00')
  const mail = { id: 'm', type: 'email-action', source: 'gmail', title: 'Please reply', priority: 'low', waiting: 'you', status: 'active',
    why: 'Alice needs an answer today',
    blocks: [{ type: 'link-list', links: [{ title: 'Hello', url: 'https://mail.google.com/mail/u/0/#inbox/x1', type: 'email', from: 'Alice' }] }] }
  const nx = pickNextThing({ cards: [mail], now, lang: 'en' })
  assert.equal(nx.kind, 'card')
  assert.equal(nx.title, 'Please reply')
  assert.match(nx.why, /Waiting on you/)
  assert.match(nx.why, /Alice needs/)
  assert.equal(nx.buttons[0].kind, 'ask')
  assert.match(nx.buttons[0].label, /起草回复|Alice|Hello|reply/i)
  assert.equal(nx.buttons[1].label, 'Start')
  assert.equal(nx.buttons[2].label, 'Snooze')
})

test('idle none state offers Start on the top ranked card when work remains', () => {
  const now = new Date('2026-11-04T10:00:00+08:00')
  const fy = { id: 'f', type: 'email-group', source: 'gmail', title: 'FYI digests', priority: 'low', waiting: 'fyi', status: 'active',
    blocks: [{ type: 'link-list', links: [{ title: 'A', url: 'https://mail.google.com/mail/u/0/#inbox/a', type: 'email' }] }] }
  const nx = pickNextThing({ cards: [fy], now, lang: 'en' })
  assert.equal(nx.kind, 'none')
  assert.ok(nx.buttons.some(b => b.kind === 'open' && b.cardId === 'f'))
})
