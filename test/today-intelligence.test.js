// Today intelligence + aggregation polish: next-thing ranking, hero CTAs, quieter empty chrome, face i18n wiring.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { pickNextThing, cardUrgency, prepareCardActions } from '../src/web/card-prep.js'
import { hydrateFace, autoFace } from '../src/ui/face.js'
import { t } from '../src/i18n/index.js'

const html = readFileSync(new URL('../packages/dsh-muse-ui/static/index.html', import.meta.url), 'utf8')
const api = readFileSync(new URL('../src/web/api.js', import.meta.url), 'utf8')

test('waiting-on-you beats a high-priority waiting-on-others for the hero', () => {
  const now = new Date('2026-11-04T11:00:00+08:00')
  const you = { id: 'you', type: 'email-action', source: 'gmail', title: 'Reply Alice', priority: 'low', waiting: 'you', status: 'active',
    blocks: [{ type: 'link-list', links: [{ title: 'Hi', url: 'https://mail.google.com/mail/u/0/#inbox/a', type: 'email', from: 'Alice' }] }] }
  const others = { id: 'oth', type: 'project-cluster', source: 'github', title: 'My PR', priority: 'high', waiting: 'others', status: 'active',
    blocks: [{ type: 'link-list', links: [{ title: 'PR', url: 'https://github.com/o/r/pull/9', type: 'pr-mine' }] }] }
  assert.ok(cardUrgency(you) > cardUrgency(others))
  const nx = pickNextThing({ cards: [others, you], now, lang: 'en' })
  assert.equal(nx.kind, 'card')
  assert.equal(nx.cardId, 'you')
  assert.equal(nx.buttons[0].kind, 'ask')
  assert.notEqual(nx.buttons[0].label, t('hero.btn_ask', 'en'), 'keeps the prepared label, not generic Ask')
})

test('Today chrome: quieter none hero, waiting-only glass, face/countdown i18n hooks', () => {
  assert.match(html, /\.nx\.nx-none\{/)
  assert.match(html, /\.tile\.work\.waiting-only\{/)
  assert.match(html, /t\('hero\.countdown_live'\)/)
  assert.match(html, /t\('face\.all_done'\)/)
  assert.match(html, /t\('today\.next_step'\)/)
  assert.match(html, /t\('today\.ready_steps'\)/)
  assert.match(html, /b\.waiting === 'you'/)
  assert.match(api, /lang: locale/)
  assert.match(api, /faceOpts/)
})

test('EN face keys resolve; ZH keeps familiar chrome', () => {
  assert.equal(t('face.waiting_you', 'en'), 'Waiting on you')
  assert.equal(t('face.waiting_you', 'zh'), '在等你')
  assert.equal(t('face.all_done', 'en'), 'All cleared')
  const v = hydrateFace({
    id: 'c', type: 'slack-cluster', source: 'slack', waiting: 'you', status: 'active',
    blocks: [{ type: 'link-list', links: [{ url: 'https://x.slack.com/archives/C1/p1', title: 't', from: 'A', text: 'hi', needsYou: true, at: '2026-11-03T07:00:00.000Z' }] }],
  }, autoFace({
    id: 'c', type: 'slack-cluster', source: 'slack', waiting: 'you', status: 'active',
    blocks: [{ type: 'link-list', links: [{ url: 'https://x.slack.com/archives/C1/p1', title: 't', from: 'A', text: 'hi', needsYou: true, at: '2026-11-03T07:00:00.000Z' }] }],
  }), { now: Date.parse('2026-11-04T08:00:00.000Z'), lang: 'en' })
  assert.equal(v.parts.find(p => p.type === 'people').label, 'Waiting on you')
})

test('EN prepared CTAs follow locale; ZH keeps familiar labels', () => {
  const gh = { id: 'g1', type: 'project-cluster', source: 'github', title: 'jitagent', priority: 'high', waiting: 'others', status: 'active',
    blocks: [{ type: 'link-list', links: [{ title: 'Fix x', url: 'https://github.com/o/r/pull/17', type: 'pr-mine' }] }] }
  assert.match(prepareCardActions(gh, { lang: 'en' })[0].label, /Nudge #17/)
  assert.match(prepareCardActions(gh, { lang: 'zh' })[0].label, /催一下 #17/)
  assert.equal(t('today.offhours', 'en', { n: 3 }), 'After hours · 3 work cards tucked away')
  assert.equal(t('today.wait_n', 'en', { n: 2 }), '2 open')
  assert.equal(t('metric.review_you', 'en'), 'Needs your review')
  assert.equal(t('prep.snooze', 'en'), 'Tomorrow')
  assert.equal(t('chat.wait_you', 'zh'), '等你处理')
})

test('Today aggregation chrome uses locale hooks (no hardcoded ZH in wait/offhours/metrics)', () => {
  assert.match(html, /t\('today\.offhours'/)
  assert.match(html, /t\('today\.wait_n'/)
  assert.match(html, /t\('today\.wait_idle'/)
  assert.match(html, /t\('metric\.review_you'/)
  assert.match(html, /t\('metric\.need_you'/)
  assert.match(html, /t\('src\.calendar'/)
  assert.match(html, /t\('chat\.wait_you'/)
  assert.match(html, /tagLabel/)
  assert.doesNotMatch(html, /🌙 下班时间 · \$\{offCards\.length\} 张工作卡/)
  assert.doesNotMatch(html, /n \+ ' 件'/)
})
