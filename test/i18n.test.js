import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  t, resolveLang, normalizeLang, doneVerb, doneVerbMap, formatOutcomeText,
  browserScript, messages, DEFAULT_LOCALE, LOCALES,
} from '../src/i18n/index.js'
import { applyActionOutcome, annotateHistoryWithOutcomes } from '../src/web/action-effects.js'
import { greetingLine, doneToday } from '../src/web/day-pulse.js'
import { pickNextThing, daySummaryLine } from '../src/web/card-prep.js'

test('en and zh catalogs share the same keys', () => {
  const en = Object.keys(messages.en).sort()
  const zh = Object.keys(messages.zh).sort()
  assert.deepEqual(en, zh)
  assert.ok(en.includes('nav.today'))
  assert.ok(en.includes('act.confirm'))
  assert.ok(en.includes('verb.sent'))
})

test('default locale is English; resolveLang reads headers and zh*', () => {
  assert.equal(DEFAULT_LOCALE, 'en')
  assert.deepEqual(LOCALES, ['en', 'zh'])
  assert.equal(resolveLang(undefined), 'en')
  assert.equal(resolveLang('zh-CN'), 'zh')
  assert.equal(normalizeLang('EN-us'), 'en')
  assert.equal(resolveLang({ 'x-odm-lang': 'zh' }), 'zh')
  assert.equal(resolveLang({ get: k => (k.toLowerCase() === 'x-odm-lang' ? 'en' : null) }), 'en')
})

test('t interpolates and falls back', () => {
  assert.equal(t('nav.today', 'en'), 'Today')
  assert.equal(t('nav.today', 'zh'), '今天')
  assert.match(t('today.done_count', 'en', { n: 3 }), /3/)
  assert.equal(t('does.not.exist', 'en'), 'does.not.exist')
})

test('done verbs and outcome lines localize', () => {
  assert.equal(doneVerb('gmail_reply', 'en'), 'Sent')
  assert.equal(doneVerb('gmail_reply', 'zh'), '已发送')
  assert.equal(doneVerbMap('en').slack_reply, 'Posted to Slack')
  const ok = formatOutcomeText({ ok: true, action: 'gmail_reply', summary: 'Reply to a@b', time: '20:59', lang: 'en' })
  assert.match(ok, /^✓ Sent · 20:59/)
  const fail = formatOutcomeText({ ok: false, action: 'gmail_reply', error: '401', lang: 'en' })
  assert.match(fail, /Send failed/)
})

test('applyActionOutcome defaults to English chrome', () => {
  const THREAD = 'https://mail.google.com/mail/u/0/#inbox/abc'
  const st = {
    cards: [{ id: 'c1', type: 'email-action', status: 'active', title: 'Mail',
      blocks: [{ type: 'link-list', links: [{ title: 't', url: THREAD, type: 'email' }] }] }],
    itemStatus: {}, completions: [], cardChats: {}, pendingActions: {},
  }
  const o = applyActionOutcome(st, {
    id: 'a1', action: 'gmail_reply', status: 'executed', cardId: 'c1', summary: 'Reply to x',
    input: { url: THREAD },
  }, { now: new Date('2026-11-04T12:59:00Z') })
  assert.match(o.text, /Sent/)
  assert.equal(o.lang, 'en')
})

test('applyActionOutcome still supports zh when asked', () => {
  const st = { cards: [], itemStatus: {}, completions: [], cardChats: {}, pendingActions: {} }
  const o = applyActionOutcome(st, {
    id: 'a1', action: 'gmail_reply', status: 'failed', error: 'boom', cardId: null, summary: 'Reply',
  }, { lang: 'zh' })
  assert.match(o.text, /发送失败/)
})

test('greeting / summary / hero chrome follow lang', () => {
  assert.match(greetingLine({ hour: 9, cards: [], lang: 'en' }), /Good morning|nothing/i)
  assert.match(greetingLine({ hour: 9, cards: [], lang: 'zh' }), /早安|待办/)
  assert.match(daySummaryLine({ cards: [], meetings: 0, lang: 'en' }), /No meetings|0 cards/i)
  const next = pickNextThing({ cards: [], lang: 'en' })
  assert.equal(next.kind, 'none')
  assert.match(next.title, /No todos|Nothing urgent/i)
})

test('browserScript exposes ODMi18n with locale switch helper', () => {
  const js = browserScript()
  assert.match(js, /ODMi18n/)
  assert.match(js, /setLocale/)
  assert.match(js, /odm\.lang/)
  assert.match(js, /"nav\.today"/)
})

test('client HTML loads i18n and marks static chrome', () => {
  const html = readFileSync(new URL('../src/client/index.html', import.meta.url), 'utf8')
  assert.match(html, /\/api\/opendigitalmate\/i18n\.js/)
  assert.match(html, /data-i18n="nav\.today"/)
  assert.match(html, /id="langSwitchSettings"/)
  assert.match(html, /id="langSwitchSide"/)
  assert.match(html, /window\.ODMi18n/)
  assert.match(html, /html lang="en"/)
  assert.match(html, /keep text input from collapsing/)
})

test('annotateHistoryWithOutcomes English line', () => {
  const msgs = [{ role: 'assistant', content: 'Draft ready — awaiting confirm to send Reply to x@y.com' }]
  const acts = { a1: { id: 'a1', status: 'executed', action: 'gmail_reply', summary: 'Reply to x@y.com', executedAt: new Date().toISOString() } }
  const out = annotateHistoryWithOutcomes(msgs, acts, { lang: 'en' })
  assert.ok(out.some(m => /Sent/.test(m.content || '')))
})

test('doneToday line localizes', () => {
  const now = Date.parse('2026-11-04T12:00:00+08:00')
  const d = doneToday({
    now,
    completions: [{ action: 'done', title: 'Card', at: '2026-11-04T03:00:00Z', cardId: 'c1' }],
    lang: 'en',
  })
  assert.ok(d)
  assert.match(d.line, /Cleared/)
})
