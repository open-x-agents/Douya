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
  const html = readFileSync(new URL('../packages/dsh-muse-ui/static/index.html', import.meta.url), 'utf8')
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

test('greeting heading / from-line / dock chrome keys localize', () => {
  assert.equal(t('greet.word_morning', 'en'), 'Good morning')
  assert.equal(t('greet.word_morning', 'zh'), '早上好')
  assert.equal(t('greet.hello_named', 'en', { hello: 'Good morning', name: 'Danyang' }), 'Good morning, Danyang')
  assert.equal(t('greet.hello_named', 'zh', { hello: '早上好', name: 'Danyang' }), '早上好，Danyang')
  assert.match(t('stamp.from', 'en', { sources: 'Gmail, Calendar' }), /From Gmail, Calendar/)
  assert.match(t('stamp.from', 'zh', { sources: 'Gmail、日历' }), /来自 Gmail、日历/)
  assert.match(t('dock.head_sub', 'en'), /long-term memory/i)
  assert.match(t('dock.head_sub', 'zh'), /长期记忆/)
  assert.match(t('chip.day_most', 'en'), /most important/i)
  assert.match(t('chip.day_most', 'zh'), /最重要/)
  assert.equal(t('source.calendar', 'en'), 'Calendar')
  assert.equal(t('source.calendar', 'zh'), '日历')
})

test('client chrome uses ODMi18n for greeting/from/dock/chips', () => {
  const html = readFileSync(new URL('../packages/dsh-muse-ui/static/index.html', import.meta.url), 'utf8')
  assert.match(html, /greet\.word_morning/)
  assert.match(html, /stamp\.from/)
  assert.match(html, /data-i18n="dock\.head"/)
  assert.match(html, /data-i18n="dock\.head_sub"/)
  assert.match(html, /chip\.day_most/)
  assert.doesNotMatch(html, /function greetingWord\(\)[\s\S]{0,120}早上好/)
  assert.doesNotMatch(html, / · 来自 ' \+ data\.sources/)
  assert.match(html, /tile\.empty\.first-run/)
  assert.match(html, /min-width:4\.5rem/)
})

test('Sources catalog + chrome localize; catalog uses i18n keys not ZH literals', () => {
  assert.equal(t('sources.cat.dev', 'en'), 'Dev & collaboration')
  assert.equal(t('sources.cat.dev', 'zh'), '开发协作')
  assert.equal(t('sources.connect', 'en'), 'Connect')
  assert.equal(t('sources.connect', 'zh'), '连接')
  assert.equal(t('app.github.desc', 'en').includes('PR'), true)
  assert.equal(t('app.googlecalendar.name', 'zh'), 'Google 日历')
  assert.match(t('sources.group_on', 'en', { n: 2, total: 5 }), /2\/5 connected/)
  const html = readFileSync(new URL('../packages/dsh-muse-ui/static/index.html', import.meta.url), 'utf8')
  assert.match(html, /sources\.cat\./)
  assert.match(html, /srcCatLabel|srcAppDesc/)
  assert.match(html, /sources\.status_on/)
  assert.doesNotMatch(html, /groups\[a\.category \|\| '其他'\]/)
  assert.doesNotMatch(html, /authZh/)
  const api = readFileSync(new URL('../src/web/api.js', import.meta.url), 'utf8')
  assert.match(api, /category: 'dev'/)
  assert.match(api, /description: 'app\.github\.desc'/)
  assert.doesNotMatch(api, /category: '开发协作'/)
  assert.doesNotMatch(api, /description: 'PR、issue/)
})

test('Today hero, headline counts and time-of-day strip have EN copy (no hardcoded Chinese)', () => {
  const html = readFileSync(new URL('../packages/dsh-muse-ui/static/index.html', import.meta.url), 'utf8')
  for (const s of ['今日焦点 · 豆芽建议', '<span>PR 待推进</span>', '个 issue 待处理`', "'恢复原顺序'", "'时段排序已关闭，按优先级排列'"]) {
    assert.ok(!html.includes(s), `hardcoded zh copy left in Today: ${s}`)
  }
  assert.equal(t('today.hero_eyebrow', 'en'), 'Today’s focus · Douya suggests')
  assert.match(t('today.head_pr', 'en', { n: 2 }), /^2 PRs/)
  assert.match(t('today.hero_lead', 'zh', { n: 3, u: 1 }), /3 个项目.*1 个/)
})

test('thinking indicator and time-of-day note are bilingual (no zh-only server strings in EN)', () => {
  const html = readFileSync(new URL('../packages/dsh-muse-ui/static/index.html', import.meta.url), 'utf8')
  assert.ok(!html.includes("label || '豆芽正在想'"), 'thinking fallback must go through i18n')
  assert.ok(!html.includes('${a.note} · ${a.rationale}'), 'tod note must be composed from i18n keys')
  assert.equal(t('chat.thinking', 'en'), 'Douya is thinking')
  assert.match(t('today.tod_note_new', 'en', { p: t('today.tod_period_evening', 'en'), n: 0 }), /^Sorted for the evening/)
  assert.match(t('today.tod_note_new', 'zh', { p: t('today.tod_period_evening', 'zh'), n: 0 }), /^按傍晚排序/)
  for (const p of ['morning', 'work', 'evening']) assert.notEqual(t(`today.tod_why_${p}`, 'en'), `today.tod_why_${p}`)
})

test('chat errors and the Composio key hint go through i18n (no zh-only literals in EN chrome)', () => {
  const html = readFileSync(new URL('../packages/dsh-muse-ui/static/index.html', import.meta.url), 'utf8')
  for (const s of ['登录已失效或未登录', '收到了，但模型没有返回内容', '获取你的 API 密钥</p>']) {
    assert.ok(!html.includes(s), `hardcoded zh copy left: ${s}`)
  }
  assert.match(html, /addBotMessage\(t\('chat\.auth_expired'\)/)
  assert.match(html, /new ChatFail\(t\('chat\.auth_expired'\)\)/)
  assert.match(html, /addBotMessage\(t\('chat\.empty_reply'\)/)
  assert.match(html, /data-i18n="settings\.composio_key_help"/)
  assert.match(t('chat.auth_expired', 'en'), /sign-in/i)
  assert.match(t('chat.auth_expired', 'zh'), /登录已失效/)
  assert.match(t('chat.empty_reply', 'en'), /returned nothing/)
  assert.match(t('chat.empty_reply', 'zh'), /没有返回内容/)
  assert.match(t('settings.composio_key_help', 'en'), /Composio Dashboard/)
})

test('My Day timetable empty states, actions and lock chrome go through i18n', () => {
  const html = readFileSync(new URL('../packages/dsh-muse-ui/static/index.html', import.meta.url), 'utf8')
  for (const s of [
    '今天还没有安排 · 豆芽会按精力曲线帮你填上专注与缓冲',
    '今天还很轻 🌱',
    '今天的安排都已过去，剩余约',
    '日历原时区不是北京时间，已按 Asia/Shanghai 显示',
    'content:"锁"',
    ' · 日历锁定',
    '>开始</button>',
    '>延后 30 分</button>',
    "title: '会后缓冲'",
    "showUiToast('日历会议已锁定，不能拖动')",
  ]) {
    assert.ok(!html.includes(s), `hardcoded zh copy left in timetable: ${s}`)
  }
  assert.match(html, /t\('tt\.empty_note'\)/)
  assert.match(html, /t\('tt\.past_note'/)
  assert.match(html, /t\('tt\.empty_title'\)/)
  assert.match(html, /t\('tt\.empty_body'\)/)
  assert.match(html, /t\('tile\.tt\.tz_note'\)/)
  assert.match(html, /t\('tt\.act_start'\)/)
  assert.match(html, /t\('tt\.act_delay'\)/)
  assert.match(html, /t\('tt\.lock_toast'\)/)
  assert.match(html, /content:attr\(data-lock-mark\)/)
  assert.match(t('tt.empty_title', 'en'), /light day/i)
  assert.match(t('tt.empty_title', 'zh'), /今天还很轻/)
  assert.match(t('tt.empty_note', 'en'), /No plan yet/)
  assert.match(t('tt.past_note', 'en', { h: '1.5' }), /1\.5h/)
  assert.match(t('tt.past_note', 'zh', { h: '1.5' }), /1\.5/)
  assert.equal(t('tt.act_start', 'en'), 'Start')
  assert.equal(t('tt.act_start', 'zh'), '开始')
  assert.match(t('tt.lock_toast', 'en'), /locked/i)
  assert.match(t('tile.tt.tz_note', 'en'), /Asia\/Shanghai/)
})

test('snooze sheet, snooze toasts and the done badge go through i18n', () => {
  const html = readFileSync(new URL('../packages/dsh-muse-ui/static/index.html', import.meta.url), 'utf8')
  for (const s of [
    "'推迟到…'",
    '<h4>推迟「',
    '>1 小时后<small>',
    '>明天<small>明早 9 点再出现',
    '>下周<small>七天后再看',
    'class="ss-cancel">取消<',
    "'明早 9 点再提醒你'",
    "'没推迟成'",
    "'✓ 搞定了'",
  ]) {
    assert.ok(!html.includes(s), `hardcoded zh copy left in snooze chrome: ${s}`)
  }
  assert.match(html, /t\('snooze\.sheet_title'/)
  assert.match(html, /t\('snooze\.cancel'\)/)
  assert.match(html, /t\(SNOOZE_LABEL_KEY\[prepId\]/)
  assert.match(t('snooze.sheet_title', 'en', { title: 'Reply' }), /Snooze “Reply”/)
  assert.equal(t('snooze.sheet_title', 'zh', { title: '回复' }), '推迟「回复」')
  assert.equal(t('snooze.opt_week', 'en'), 'Next week')
  assert.equal(t('snooze.toast_tomorrow', 'zh'), '明早 9 点再提醒你')
  assert.match(t('snooze.toast_1h', 'en'), /hour/)
  assert.equal(t('snooze.done_badge', 'en'), '✓ Done')
  for (const k of ['snooze.sheet_aria', 'snooze.opt_1h', 'snooze.opt_1h_hint', 'snooze.opt_tomorrow', 'snooze.opt_tomorrow_hint', 'snooze.opt_week_hint', 'snooze.cancel', 'snooze.toast_week', 'snooze.failed']) {
    assert.ok(messages.en[k] && messages.zh[k], `missing ${k}`)
  }
})
