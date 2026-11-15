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

test('card zoom related-items list goes through i18n', () => {
  const html = readFileSync(new URL('../packages/dsh-muse-ui/static/index.html', import.meta.url), 'utf8')
  for (const s of [
    '条回复`',
    '需要你回应${',
    "'已完成' : '已忽略'",
    'type="button">展开</button>',
    'rel="noopener">打开</a>',
    '${data}>完成</button>',
    '${data}>忽略</button>',
    '一键全部忽略 ${',
    "'这组邮件' :",
    '这张卡的条目都处理完了',
    '<summary>已处理 ·',
    "? '展开' : '收起'",
  ]) {
    assert.ok(!html.includes(s), `hardcoded zh copy left in card zoom items: ${s}`)
  }
  assert.match(html, /t\('zoom\.dismiss_all', \{ n: open\.length \}\)/)
  assert.equal(t('zoom.replies', 'en', { n: 3 }), '3 replies')
  assert.equal(t('zoom.replies', 'zh', { n: 3 }), '3 条回复')
  assert.equal(t('zoom.dismiss_all', 'en', { n: 4 }), 'Dismiss all 4 emails')
  assert.equal(t('zoom.of_total', 'zh', { n: 5 }), '/ 共 5')
  assert.match(t('zoom.all_handled', 'en'), /handled/)
  for (const k of ['zoom.needs_you', 'zoom.status_done', 'zoom.status_dismissed', 'zoom.expand', 'zoom.collapse', 'zoom.head_mail', 'zoom.head_slack', 'zoom.head_items', 'zoom.handled']) {
    assert.ok(messages.en[k] && messages.zh[k], `missing ${k}`)
  }
})

test('card zoom header, deep links and link-kind labels go through i18n', () => {
  const html = readFileSync(new URL('../packages/dsh-muse-ui/static/index.html', import.meta.url), 'utf8')
  for (const s of [
    "zh: '消息'",
    "zh: '邮件'",
    "zh: '链接'",
    "zh: '仓库'",
    '个待处理 PR`',
    ": '全部 PR'",
    "title: '打开仓库'",
    '原始摘要：${',
    '<span>待推进 PR</span>',
    '<span>待处理 issue</span></div>` :',
    "'打开第一封 ↗'",
    "'去处理 ↗'",
  ]) {
    assert.ok(!html.includes(s), `hardcoded zh copy left in card zoom: ${s}`)
  }
  assert.equal(t('zoom.all_prs_n', 'en', { n: 3 }), 'All 3 open PRs')
  assert.equal(t('zoom.all_prs_n', 'zh', { n: 3 }), '全部 3 个待处理 PR')
  assert.equal(t('zoom.orig_summary', 'en', { title: 'x' }), 'Original summary: x')
  assert.equal(t('kind.link', 'en'), 'Link')
  assert.equal(t('kind.link', 'zh'), '链接')
  for (const k of ['kind.slack', 'kind.mail', 'kind.issue', 'kind.pr', 'kind.repo', 'zoom.all_prs', 'zoom.kpi_prs', 'zoom.kpi_issues', 'zoom.open_first_mail', 'zoom.go_handle', 'card.open_repo']) {
    assert.ok(messages.en[k] && messages.zh[k], `missing ${k}`)
  }
})

test('timetable categories, zoom section and chat context name go through i18n', () => {
  const html = readFileSync(new URL('../packages/dsh-muse-ui/static/index.html', import.meta.url), 'utf8')
  for (const s of ['CAT_ZH', '<h4>时间表</h4>', '暂无日程', "'今天的安排'", "? '会议' : '建议'", "'建议' : '日程'"]) {
    assert.ok(!html.includes(s), `hardcoded zh copy left in timetable: ${s}`)
  }
  assert.equal(t('tt.cat.admin', 'en'), 'Chores')
  assert.equal(t('tt.cat.admin', 'zh'), '杂务')
  assert.equal(t('tt.zoom_head', 'en'), 'Timetable')
  assert.equal(t('tt.ctx_name', 'zh'), '今天的安排')
  for (const k of ['meal', 'focus', 'work', 'break', 'exercise', 'meeting', 'review', 'admin', 'learning', 'personal', 'winddown']) {
    assert.ok(messages.en['tt.cat.' + k] && messages.zh['tt.cat.' + k], `missing tt.cat.${k}`)
  }
  for (const k of ['tt.cat_suggested', 'tt.cat_event', 'tt.zoom_head', 'tt.zoom_empty', 'tt.ctx_name']) {
    assert.ok(messages.en[k] && messages.zh[k], `missing ${k}`)
  }
})

test('chat attachment tips and dock reply toasts go through i18n', () => {
  const html = readFileSync(new URL('../packages/dsh-muse-ui/static/index.html', import.meta.url), 'utf8')
  for (const s of ["new Error('读取失败')", '超过 10MB`', '超过 20MB`', '张图`', '个文件`', "'该图片类型'", "? '图片' : '文件'", '`豆芽回复了：', "'豆芽回复了，点输入框查看'"]) {
    assert.ok(!html.includes(s), `hardcoded zh copy left in chat attach/dock: ${s}`)
  }
  assert.equal(t('attach.too_big', 'en', { name: 'a.pdf', max: '20MB' }), 'a.pdf is over 20MB')
  assert.equal(t('attach.max_images', 'zh', { n: 4 }), '一次最多 4 张图')
  assert.equal(t('attach.bad_ext', 'en', { ext: 'exe' }), '.exe files aren’t supported')
  assert.equal(t('dock.replied', 'en', { text: 'hi' }), 'Douya replied: hi')
  for (const k of ['attach.read_failed', 'attach.this_image_type', 'attach.bad_image', 'attach.max_files', 'attach.image', 'attach.file', 'dock.replied_tap', 'dock.view', 'dock.open']) {
    assert.ok(messages.en[k] && messages.zh[k], `missing ${k}`)
  }
})

test('AI model and Composio key settings status lines go through i18n', () => {
  const html = readFileSync(new URL('../packages/dsh-muse-ui/static/index.html', import.meta.url), 'utf8')
  for (const s of ["'输入模型名称'", '请选择提供商</span>', '请输入 API Key</span>', '保存中...</span>', '✓ 保存成功', '保存失败: ', '测试中...</span>', '✓ 连接成功！', '测试失败: ']) {
    assert.ok(!html.includes(s), `hardcoded zh copy left in settings status: ${s}`)
  }
  assert.equal(t('settings.save_failed', 'en', { error: 'boom' }), 'Could not save: boom')
  assert.equal(t('settings.test_reply', 'zh', { text: 'hi' }), '回复：hi')
  for (const k of ['settings.model_ph', 'settings.pick_provider', 'settings.need_key', 'settings.saving', 'settings.model_saved', 'settings.key_saved', 'settings.testing', 'settings.test_ok', 'settings.test_failed']) {
    assert.ok(messages.en[k] && messages.zh[k], `missing ${k}`)
  }
})

test('Composio app connect and disconnect prompts go through i18n', () => {
  const html = readFileSync(new URL('../packages/dsh-muse-ui/static/index.html', import.meta.url), 'utf8')
  for (const s of ['确定要断开 ${appKey}', "alert('已断开连接')", "'断开失败: '", "'连接失败: '", "'未知错误'"]) {
    assert.ok(!html.includes(s), `hardcoded zh copy left in Composio app actions: ${s}`)
  }
  assert.equal(t('settings.app_disconnect_confirm', 'en', { app: 'gmail' }), 'Disconnect gmail?')
  assert.equal(t('settings.app_connect_failed', 'zh', { error: 'x' }), '连接失败：x')
  for (const k of ['settings.app_disconnected', 'settings.app_disconnect_failed', 'settings.unknown_error']) {
    assert.ok(messages.en[k] && messages.zh[k], `missing ${k}`)
  }
})

test('Settings config check statuses go through i18n', () => {
  const html = readFileSync(new URL('../packages/dsh-muse-ui/static/index.html', import.meta.url), 'utf8')
  for (const s of ['✓ 已配置', '⚠ 未配置或配置不完整', '✗ 未配置（聊天功能受限）', '检查失败']) {
    assert.ok(!html.includes(s), `hardcoded zh copy left in checkConfig: ${s}`)
  }
  assert.equal(t('status.configured', 'en'), 'Configured')
  assert.equal(t('status.incomplete', 'zh'), '未配置或配置不完整')
  assert.equal(t('status.llm_missing', 'en'), 'Not configured (chat limited)')
  assert.equal(t('status.check_failed', 'zh'), '检查失败')
  for (const k of ['status.configured', 'status.incomplete', 'status.llm_missing', 'status.check_failed']) {
    assert.ok(messages.en[k] && messages.zh[k], `missing ${k}`)
  }
})

test('switching language on Settings repaints the config status lines', () => {
  const html = readFileSync(new URL('../packages/dsh-muse-ui/static/index.html', import.meta.url), 'utf8')
  const start = html.indexOf('function setAppLocale')
  const body = html.slice(start, html.indexOf("document.querySelectorAll('.lang-switch')", start))
  assert.ok(start > 0)
  assert.match(body, /\$\('v-settings'\)\?\.classList\.contains\('on'\)\) checkConfig\(\)/, 'setAppLocale re-runs checkConfig() while Settings is open')
})

test('Today refresh button and status go through i18n', () => {
  const html = readFileSync(new URL('../packages/dsh-muse-ui/static/index.html', import.meta.url), 'utf8')
  for (const s of ["btn.textContent = '汇聚中...'", "status.textContent = '正在获取数据...'", "'汇聚失败'", "'⚡ 重新汇聚'", "status.textContent = '⚠️ 生成失败'", "'✓ 已汇聚（Bot 失败，已用旧流水线）'", '`✓ Bot 汇聚完成']) {
    assert.ok(!html.includes(s), `hardcoded zh copy left in generateDigest: ${s}`)
  }
  assert.equal(t('today.digest_running', 'en'), 'Refreshing…')
  assert.equal(t('today.digest_fetching', 'zh'), '正在获取数据...')
  assert.equal(t('today.digest_bot_partial', 'en', { channels: 'gmail, slack' }), 'Bot refresh complete (gmail, slack not updated)')
  assert.equal(t('today.digest_legacy_fallback', 'zh'), '已汇聚（Bot 失败，已用旧流水线）')
  assert.equal(t('today.digest_again_bolt', 'en'), 'Refresh again')
  for (const k of ['today.digest_running', 'today.digest_fetching', 'today.digest_failed', 'today.digest_generate_failed', 'today.digest_again_bolt', 'today.digest_bot_done', 'today.digest_bot_partial', 'today.digest_legacy_fallback']) {
    assert.ok(messages.en[k] && messages.zh[k], `missing ${k}`)
  }
})

test('Today live digest progress goes through i18n', () => {
  const html = readFileSync(new URL('../packages/dsh-muse-ui/static/index.html', import.meta.url), 'utf8')
  for (const s of ["const DP_ZH = { queued: '排队'", "head.textContent = '汇聚中'", '${c.cards} 张', "chip('Chief 合并'"]) {
    assert.ok(!html.includes(s), `hardcoded zh copy left in renderDigestProgress: ${s}`)
  }
  assert.equal(t('today.dp_heading', 'en'), 'Refreshing')
  assert.equal(t('today.dp_thinking', 'zh'), '整理中…')
  assert.equal(t('today.dp_cards', 'en', { n: 3 }), '3 cards')
  assert.equal(t('today.dp_cards', 'zh', { n: 3 }), '3 张')
  assert.equal(t('today.dp_chief', 'en'), 'Chief merge')
  for (const k of ['today.dp_heading', 'today.dp_queued', 'today.dp_fetching', 'today.dp_thinking', 'today.dp_done', 'today.dp_failed', 'today.dp_timeout', 'today.dp_skipped', 'today.dp_cards', 'today.dp_chief']) {
    assert.ok(messages.en[k] && messages.zh[k], `missing ${k}`)
  }
})

test('Sources last-run box goes through i18n and no longer shadows t()', () => {
  const html = readFileSync(new URL('../packages/dsh-muse-ui/static/index.html', import.meta.url), 'utf8')
  const fn = html.slice(html.indexOf('async function loadDigestRun()'), html.indexOf('window.loadDigestRun = loadDigestRun;'))
  assert.ok(fn.length > 0)
  assert.ok(!/const t = new Date/.test(fn), 'loadDigestRun must not shadow the i18n t()')
  for (const s of ['上次汇聚', '旧流水线', '<th>信源 Bot</th>', '旧卡保持不变', '次合并', '汇聚偏好', '还没有运行过']) {
    assert.ok(!fn.includes(s), `hardcoded zh copy left in loadDigestRun: ${s}`)
  }
  assert.equal(t('sources.run_heading', 'en', { mode: 'Source bots', time: 'now', result: 'Succeeded', secs: 12 }), 'Last refresh (Source bots · now · Succeeded · 12s)')
  assert.equal(t('sources.run_heading', 'zh', { mode: '信源 Bot', time: 'x', result: '成功', secs: 3 }), '上次汇聚（信源 Bot · x · 成功 · 3s）')
  assert.equal(t('sources.run_merges', 'en', { n: 2 }), '2 merges')
  assert.equal(t('sources.run_merges_one', 'en'), '1 merge')
  assert.equal(t('sources.run_merges_one', 'zh'), '1 次合并')
  for (const k of ['run_never', 'run_heading', 'run_mode_bot', 'run_mode_legacy', 'run_ok', 'run_failed', 'run_col_bot', 'run_col_status', 'run_col_cards', 'run_col_items', 'run_col_time', 'run_col_note', 'run_kept', 'run_merges', 'run_merges_one', 'run_prefs']) {
    assert.ok(messages.en['sources.' + k] && messages.zh['sources.' + k], `missing sources.${k}`)
  }
})

test('Today pin badge, highlight chip and filter bar go through i18n without shadowing t()', () => {
  const html = readFileSync(new URL('../packages/dsh-muse-ui/static/index.html', import.meta.url), 'utf8')
  const fn = html.slice(html.indexOf('function decorateTiles(container, cards)'), html.indexOf('async function sendUserOp(body)'))
  assert.ok(fn.length > 0)
  assert.ok(!/const t = document\.createElement/.test(fn), 'decorateTiles must not shadow the i18n t()')
  for (const s of ['你固定的', '豆芽置顶', '豆芽标出', '已筛选', '豆芽筛选', '显示全部']) {
    assert.ok(!fn.includes(s), `hardcoded zh copy left in decorateTiles: ${s}`)
  }
  assert.equal(t('today.pinned_bot_reason', 'en', { reason: 'due today' }), '📌 Pinned by Douya · due today')
  assert.equal(t('today.hl_reason', 'zh', { reason: '要回' }), '豆芽标出：要回')
  assert.equal(t('today.filter_bot', 'en', { label: 'PRs', shown: 2, total: 5 }), 'Douya filter: PRs · showing 2/5')
  assert.equal(t('today.filter_user', 'zh', { label: 'PR', shown: 1, total: 3 }), '已筛选：PR · 显示 1/3 张')
  for (const k of ['pinned_user', 'pinned_bot', 'pinned_bot_reason', 'hl', 'hl_reason', 'filter_user', 'filter_bot', 'filter_clear']) {
    assert.ok(messages.en['today.' + k] && messages.zh['today.' + k], `missing today.${k}`)
  }
})

test('Draft confirmed button and reply fold summary go through i18n', () => {
  const html = readFileSync(new URL('../packages/dsh-muse-ui/static/index.html', import.meta.url), 'utf8')
  for (const s of ["textContent = '已确认'", '展开细节（', "'收起细节'"]) {
    assert.ok(!html.includes(s), `hardcoded zh copy left: ${s}`)
  }
  assert.equal(t('draft.confirmed', 'en'), 'Confirmed')
  assert.equal(t('draft.confirmed', 'zh'), '已确认')
  assert.equal(t('reply.more', 'en', { n: 3 }), 'Show details (3)')
  assert.equal(t('reply.more', 'zh', { n: 3 }), '展开细节（3 段）')
  assert.equal(t('reply.less', 'en'), 'Hide details')
  assert.equal(t('reply.less', 'zh'), '收起细节')
})

test('View card toasts, suggestion bar and view skeleton go through i18n', () => {
  const html = readFileSync(new URL('../packages/dsh-muse-ui/static/index.html', import.meta.url), 'utf8')
  for (const s of ["textContent = '应用'", "textContent = '忽略'", "textContent = '已保存'", '· 生成中…`', '豆芽有个布局建议', '已保存为今天页上的卡片', '引用的卡片已经不在了', '视图组件没加载出来']) {
    assert.ok(!html.includes(s), `hardcoded zh copy left: ${s}`)
  }
  assert.ok(html.includes("const msg = document.createElement('span'); msg.textContent = e.message || t('suggest.default')"), 'suggestion bar must not shadow t()')
  assert.equal(t('suggest.apply', 'en'), 'Apply')
  assert.equal(t('suggest.ignore', 'zh'), '忽略')
  assert.equal(t('view.generating', 'en', { title: 'Inbox' }), 'Inbox · generating…')
  assert.equal(t('view.pinned_toast', 'zh', { title: 'X' }), '已把「X」放到今天页顶部')
  for (const k of ['load_failed', 'pinned_toast', 'save_failed', 'saved', 'saved_toast', 'removed_toast', 'missing', 'generating']) {
    assert.ok(messages.en['view.' + k] && messages.zh['view.' + k], `missing view.${k}`)
  }
})

test('Dead manual digest push handler (no #pushDigestBtn in the page) is gone', () => {
  const html = readFileSync(new URL('../packages/dsh-muse-ui/static/index.html', import.meta.url), 'utf8')
  assert.ok(!html.includes('id="pushDigestBtn"'), 'no push button in markup')
  for (const s of ["$('pushDigestBtn')", '推送中...', '手动推送汇聚', '推送成功！已发送']) {
    assert.ok(!html.includes(s), `dead zh push code left: ${s}`)
  }
})

test('Quote face time, link fallback and quick done/useless failure toast are localized', () => {
  const html = readFileSync(new URL('../packages/dsh-muse-ui/static/index.html', import.meta.url), 'utf8')
  for (const s of ['} 分钟前`', '} 小时前`', '} 天前`', "r.error || '没标上'", "p.link.host || '链接'"]) {
    assert.ok(!html.includes(s), `hardcoded zh left: ${s}`)
  }
  assert.ok(html.includes("t('face.rel_min'"), 'faceRelTime uses face.rel_* keys')
  for (const k of ['face.rel_min', 'face.rel_hour', 'face.rel_day', 'face.link']) {
    for (const loc of ['en', 'zh']) assert.ok(messages[loc][k], `${loc} has ${k}`)
  }
})

test('Today workload tile is localized and describes log scaling', () => {
  const html = readFileSync(new URL('../packages/dsh-muse-ui/static/index.html', import.meta.url), 'utf8')
  for (const s of ['工作负载 · 按项目</div>', '长度按平方根缩放', '待推进 PR</span>', '待处理 issue</span>', '>长度按对数缩放</span>']) {
    assert.ok(!html.includes(s), `hardcoded zh left: ${s}`)
  }
  for (const k of ['today.load_heading', 'today.load_desc', 'today.load_pr', 'today.load_issue', 'today.load_scale']) {
    for (const loc of ['en', 'zh']) assert.ok(messages[loc][k], `${loc} has ${k}`)
  }
  assert.ok(/log/i.test(messages.en['today.load_desc']) && messages.zh['today.load_desc'].includes('对数'), 'desc says log scaling')
})

test('Today headline, next-step fallbacks and zhBody follow the locale', () => {
  const html = readFileSync(new URL('../packages/dsh-muse-ui/static/index.html', import.meta.url), 'utf8')
  for (const s of [
    ' · ${open} 封',
    ' · 已全部处理',
    '这组邮件都处理完了，不用再看',
    '先推进 PR「',
    '打开 PR 列表，推进',
    '先回复 issue「',
    '挑出今天要回复的 1–2 个',
    '先回复邮件「',
    '逐个推进 ${pr} 个 PR',
    '看一下是否需要跟进',
  ]) {
    assert.ok(!html.includes(s), `hardcoded zh left: ${s}`)
  }
  assert.ok(html.includes("if (odmLang() !== 'zh') return b"), 'zhBody must leave English digest bodies as produced')
  const keys = [
    'today.head_mail', 'today.head_mail_done', 'today.next_mail_done',
    'today.next_push_pr_named', 'today.next_push_pr_n', 'today.next_reply_issue',
    'today.next_triage_issues', 'today.next_review_named', 'today.next_reply_mail',
    'today.next_push_named', 'today.next_push_prs', 'today.next_check_named', 'today.next_check',
  ]
  for (const k of keys) {
    for (const loc of ['en', 'zh']) assert.ok(messages[loc][k], `${loc} has ${k}`)
  }
  assert.equal(t('today.head_mail', 'en', { title: 'Inbox', n: 3 }), 'Inbox · 3 open')
  assert.equal(t('today.head_mail_done', 'zh', { title: '收件箱' }), '收件箱 · 已全部处理')
  assert.equal(t('today.next_mail_done', 'en'), 'This batch of mail is all handled — nothing left to do')
  assert.equal(t('today.next_push_pr_named', 'zh', { title: 'fix ci' }), '先推进 PR「fix ci」，催 review 或合并')
})

test('Today card chat chips and quick-ask prompts follow the locale', () => {
  const html = readFileSync(new URL('../packages/dsh-muse-ui/static/index.html', import.meta.url), 'utf8')
  for (const s of [
    '帮我处理「',
    "dockPrompt('今天想先做什么？')",
    '往后挪半小时',
    '帮我把今晚剩下的时间排一下',
    '明天上午留两小时专注，放哪里？',
    '这组都处理完了，还有别的要看吗？',
    '封里哪封最急？',
    '要我怎么回？',
    '封里有要我回的吗？',
    '个 PR 先推哪个？',
    '个 issue 里哪个今天必须回？',
    '条在等我回，怎么回？',
    '这里有我需要知道的吗？',
    '今天不做的话会怎样？',
    '这张可以先放着吗？',
  ]) {
    assert.ok(!html.includes(s), `hardcoded zh left: ${s}`)
  }
  const keys = [
    'chip.shift_block', 'chip.plan_evening', 'chip.focus_tomorrow',
    'chip.mail_done', 'chip.mail_which_urgent', 'chip.mail_how_reply', 'chip.mail_any_reply',
    'chip.pr_which', 'chip.pr_stuck', 'chip.issue_must',
    'chip.slack_how_reply', 'chip.slack_need_know',
    'chip.how_start', 'chip.if_skip', 'chip.can_wait',
    'chip.ask_handle', 'chip.empty_prompt',
  ]
  for (const k of keys) {
    for (const loc of ['en', 'zh']) assert.ok(messages[loc][k], `${loc} has ${k}`)
  }
  assert.ok(html.includes("t('chip.ask_handle'"), 'runQuickAsk uses chip.ask_handle')
  assert.ok(html.includes("t('chip.empty_prompt')"), 'empty CTA uses chip.empty_prompt')
  assert.ok(html.includes("t('chip.shift_block'"), 'chipsForCard uses chip.shift_block')
  assert.equal(t('chip.mail_done', 'en'), 'This batch is all handled — anything else to look at?')
  assert.equal(t('chip.mail_which_urgent', 'zh', { n: 3 }), '这 3 封里哪封最急？')
  assert.equal(t('chip.pr_stuck', 'en', { n: 42 }), "What's blocking #42?")
  assert.equal(t('chip.ask_handle', 'zh', { title: 'Inbox' }), '帮我处理「Inbox」')
  assert.equal(t('chip.empty_prompt', 'en'), 'What should I start with today?')
})

test('GitHub PR brief chrome and ask prompts follow the locale', () => {
  const html = readFileSync(new URL('../packages/dsh-muse-ui/static/index.html', import.meta.url), 'utf8')
  for (const s of [
    '豆芽已备好 ·',
    '来自 GitHub ·',
    "b.mine ? '让豆芽推进'",
    "'起草评审意见'",
    '我的 PR #${b.number}',
    '帮我审 PR #${b.number}',
  ]) {
    assert.ok(!html.includes(s), `hardcoded zh left: ${s}`)
  }
  const keys = [
    'brief.ready', 'brief.from_github', 'brief.act_mine', 'brief.act_review',
    'brief.ask_mine', 'brief.ask_review',
    'brief.k_diff', 'brief.k_status', 'brief.k_watch', 'brief.k_author',
    'brief.diff', 'brief.ci_ok', 'brief.risk_migrate', 'brief.next_fix_ci',
    'brief.next_review', 'brief.next_area_fallback', 'brief.next_focus',
  ]
  for (const k of keys) {
    for (const loc of ['en', 'zh']) assert.ok(messages[loc][k], `${loc} has ${k}`)
  }
  assert.ok(html.includes("t('brief.ready')"), 'mountBrief uses brief.ready')
  assert.ok(html.includes("t('brief.from_github')"), 'mountBrief uses brief.from_github')
  assert.ok(html.includes("t('brief.act_mine')"), 'mountBrief uses brief.act_mine')
  assert.ok(html.includes("t(b.mine ? 'brief.ask_mine' : 'brief.ask_review'"), 'briefAskPrompt uses brief.ask_* keys')
  assert.equal(t('brief.ready', 'en'), 'Douya is ready')
  assert.equal(t('brief.act_review', 'zh'), '起草评审意见')
  assert.equal(
    t('brief.ask_mine', 'zh', { number: 12, title: 'fix ci', url: 'https://example/12', facts: '改动：+2', cardId: 'c1' }),
    '我的 PR #12「fix ci」https://example/12。已知：改动：+2。先一句话告诉我结论（能不能合 / 卡在哪），再给我下一步；需要催人或回复就起草好给我确认，别直接发（卡片 id c1）。',
  )
  assert.match(
    t('brief.ask_review', 'en', { number: 12, title: 'fix ci', url: 'https://example/12', facts: 'size: +2', cardId: 'c1' }),
    /Help me review PR #12 “fix ci” https:\/\/example\/12/,
  )
  assert.equal(t('brief.k_diff', 'en'), 'Changes')
  assert.equal(t('brief.k_author', 'zh'), '作者说')
  assert.equal(t('brief.ci_ok', 'en'), 'All CI passed')
  assert.equal(t('brief.next_fix_ci', 'zh', { name: 'unit' }), '先修 CI：unit')
  assert.equal(t('brief.err_gone', 'en'), 'This card is gone')
  assert.equal(t('brief.err_no_github', 'zh'), 'GitHub 还没连上')
  assert.equal(t('brief.err_unavailable', 'en'), "Can't get this PR")
  const briefSrc = readFileSync(new URL('../src/web/card-brief.js', import.meta.url), 'utf8')
  for (const s of ["k: '改动'", "'CI 全部通过'", "'先修 CI：", "'还是草稿，等作者标 ready", "'拿不到这个 PR'"]) {
    assert.ok(!briefSrc.includes(s), `hardcoded zh left in card-brief.js: ${s}`)
  }
  assert.ok(briefSrc.includes("tx('brief.k_diff')"), 'buildPrBrief uses brief.k_diff')
  assert.ok(briefSrc.includes("tx('brief.next_review'"), 'buildPrBrief uses brief.next_review')
  assert.ok(briefSrc.includes("t('brief.err_unavailable'"), 'fetchPrBrief uses brief.err_unavailable')
  const apiSrc = readFileSync(new URL('../src/web/api.js', import.meta.url), 'utf8')
  const cardBriefFn = (apiSrc.match(/async cardBrief\([\s\S]*?\n    \},/) || [])[0] || ''
  assert.ok(cardBriefFn.includes('async cardBrief'), 'found cardBrief in api.js')
  for (const s of ['这张卡已经不在了', 'GitHub 还没连上', '拿不到这个 PR']) {
    assert.ok(!cardBriefFn.includes(s), `hardcoded zh left in cardBrief: ${s}`)
  }
  assert.ok(cardBriefFn.includes("i18nT('brief.err_gone'"), 'cardBrief uses brief.err_gone')
  assert.ok(cardBriefFn.includes("i18nT('brief.err_no_github'"), 'cardBrief uses brief.err_no_github')
  assert.ok(cardBriefFn.includes('target.url}#${locale}'), 'cardBriefs cache is keyed per language')
})


test('card prep and timetable-done errors follow the UI locale', () => {
  assert.equal(t('prep.err_gone', 'en'), 'This card is gone')
  assert.equal(t('prep.err_stale', 'zh'), '这一步已经过时了，刷新一下')
  assert.equal(t('prep.err_in_chat', 'en'), 'Do this step in the chat with Douya')
  assert.equal(t('prep.err_failed', 'en'), "Couldn't get this action ready")
  assert.equal(t('timetable.err_missing', 'zh'), '这段安排找不到了，刷新一下')
  assert.equal(t('timetable.err_missing', 'en'), "Can't find this block — refresh")
  const apiSrc = readFileSync(new URL('../src/web/api.js', import.meta.url), 'utf8')
  const cardPrepFn = (apiSrc.match(/async cardPrepRun\([\s\S]*?\n    \},/) || [])[0] || ''
  const timetableFn = (apiSrc.match(/async timetableBlockDone\([\s\S]*?\n    \},/) || [])[0] || ''
  assert.ok(cardPrepFn.includes('async cardPrepRun'), 'found cardPrepRun in api.js')
  assert.ok(timetableFn.includes('async timetableBlockDone'), 'found timetableBlockDone in api.js')
  for (const s of ['这张卡已经不在了', '这一步已经过时了', '这一步要在对话里交给豆芽', '没能准备好这个操作']) {
    assert.ok(!cardPrepFn.includes(s), `hardcoded zh left in cardPrepRun: ${s}`)
  }
  assert.ok(!timetableFn.includes('这段安排找不到了'), 'hardcoded zh left in timetableBlockDone')
  assert.ok(cardPrepFn.includes("i18nT('prep.err_gone'"), 'cardPrepRun uses prep.err_gone')
  assert.ok(cardPrepFn.includes("i18nT('prep.err_stale'"), 'cardPrepRun uses prep.err_stale')
  assert.ok(cardPrepFn.includes("i18nT('prep.err_in_chat'"), 'cardPrepRun uses prep.err_in_chat')
  assert.ok(cardPrepFn.includes("i18nT('prep.err_failed'"), 'cardPrepRun uses prep.err_failed')
  assert.ok(timetableFn.includes("i18nT('timetable.err_missing'"), 'timetableBlockDone uses timetable.err_missing')
  const routes = readFileSync(new URL('../src/web/dsh-host-routes.js', import.meta.url), 'utf8')
  assert.ok(routes.includes('router.cardPrepRun({ ...body, lang: body.lang || langParam(request) })'), 'card-prep route passes lang')
  assert.ok(routes.includes('router.timetableBlockDone({ ...body, lang: body.lang || langParam(request) })'), 'timetable-block route passes lang')
  const html = readFileSync(new URL('../packages/dsh-muse-ui/static/index.html', import.meta.url), 'utf8')
  assert.ok(!html.includes("fetch('/api/opendigitalmate/card-prep', { method: 'POST', headers: { 'Content-Type'"), 'card-prep posts use odmHeaders')
  assert.ok(!html.includes("fetch('/api/opendigitalmate/timetable-block', { method: 'POST', headers: { 'Content-Type'"), 'timetable-block posts use odmHeaders')
  const prepPosts = html.split('/api/opendigitalmate/card-prep').length - 1
  const blockPosts = html.split('/api/opendigitalmate/timetable-block').length - 1
  assert.equal(prepPosts, 4, 'four card-prep POSTs in the UI')
  assert.equal(blockPosts, 1, 'one timetable-block POST in the UI')
  assert.equal((html.match(/prepId: 'unsnooze', lang: odmLang\(\)/g) || []).length, 2, 'unsnooze posts send lang')
  assert.ok(html.includes('prepId, lang: odmLang()'), 'runQuickSnooze sends lang')
  assert.ok(html.includes("step.kind === 'snooze' ? 'snooze' : step.id, lang: odmLang()"), 'runStep sends lang')
  assert.ok(html.includes('blockKey: step.blockKey, done, lang: odmLang()'), 'markBlockDone sends lang')
})

test('card CRUD errors follow the UI locale', () => {
  assert.equal(t('card.err_no_title', 'en'), "Title can't be empty")
  assert.equal(t('card.err_no_title', 'zh'), '标题不能为空')
  assert.equal(t('card.err_missing', 'en'), "This card doesn't exist")
  assert.equal(t('card.err_missing', 'zh'), '卡片不存在')
  assert.equal(t('card.err_no_item', 'en'), "This item isn't on this card")
  assert.equal(t('card.err_no_item', 'zh'), '这张卡片里没有这个条目')
  assert.equal(t('card.err_unknown_action', 'en', { action: 'flip' }), 'Unknown action: flip')
  assert.equal(t('card.err_unknown_action', 'zh', { action: 'flip' }), '未知操作: flip')
  const apiSrc = readFileSync(new URL('../src/web/api.js', import.meta.url), 'utf8')
  const createFn = (apiSrc.match(/async createCard\([\s\S]*?\n    \},/) || [])[0] || ''
  const updateFn = (apiSrc.match(/async updateCard\([\s\S]*?\n    \},/) || [])[0] || ''
  const deleteFn = (apiSrc.match(/async deleteCard\([\s\S]*?\n    \},/) || [])[0] || ''
  const interactFn = (apiSrc.match(/async trackCardInteraction\([\s\S]*?\n    \},/) || [])[0] || ''
  assert.ok(createFn.includes('async createCard'), 'found createCard in api.js')
  assert.ok(updateFn.includes('async updateCard'), 'found updateCard in api.js')
  assert.ok(deleteFn.includes('async deleteCard'), 'found deleteCard in api.js')
  assert.ok(interactFn.includes('async trackCardInteraction'), 'found trackCardInteraction in api.js')
  assert.ok(!createFn.includes('标题不能为空'), 'hardcoded zh left in createCard')
  for (const fn of [updateFn, deleteFn, interactFn]) {
    assert.ok(!fn.includes('卡片不存在'), 'hardcoded zh left in card CRUD handler')
  }
  assert.ok(!interactFn.includes('这张卡片里没有这个条目'), 'hardcoded zh left in trackCardInteraction item error')
  assert.ok(!interactFn.includes('未知操作:'), 'hardcoded zh left in trackCardInteraction unknown action')
  assert.ok(createFn.includes("i18nT('card.err_no_title'"), 'createCard uses card.err_no_title')
  assert.ok(updateFn.includes("i18nT('card.err_missing'"), 'updateCard uses card.err_missing')
  assert.ok(deleteFn.includes("i18nT('card.err_missing'"), 'deleteCard uses card.err_missing')
  assert.ok(interactFn.includes("i18nT('card.err_missing'"), 'trackCardInteraction uses card.err_missing')
  assert.ok(interactFn.includes("i18nT('card.err_no_item'"), 'trackCardInteraction uses card.err_no_item')
  assert.ok(interactFn.includes("i18nT('card.err_unknown_action'"), 'trackCardInteraction uses card.err_unknown_action')
  const routes = readFileSync(new URL('../src/web/dsh-host-routes.js', import.meta.url), 'utf8')
  assert.ok(routes.includes("router.createCard({ ...body, lang: body.lang || langParam(request) })"), 'cards POST passes lang')
  assert.ok(routes.includes("router.updateCard(body.id, { ...body, lang: body.lang || langParam(request) })"), 'card-update route passes lang')
  assert.ok(routes.includes("router.deleteCard(body.id, { lang: body.lang || langParam(request) })"), 'card-delete route passes lang')
  assert.ok(routes.includes("body.itemTitle || '', 'user', body.lang || langParam(request)"), 'card-interact route passes lang')
  const html = readFileSync(new URL('../packages/dsh-muse-ui/static/index.html', import.meta.url), 'utf8')
  const interactPosts = html.split('/api/opendigitalmate/card-interact').length - 1
  const updatePosts = html.split('/api/opendigitalmate/card-update').length - 1
  const deletePosts = html.split('/api/opendigitalmate/card-delete').length - 1
  assert.equal(interactPosts, 7, 'seven card-interact POSTs in the UI')
  assert.equal(updatePosts, 1, 'one card-update POST in the UI')
  assert.equal(deletePosts, 1, 'one card-delete POST in the UI')
  assert.equal((html.match(/card-interact[\s\S]{0,350}odmLang\(\)/g) || []).length, interactPosts, 'every card-interact POST sends lang')
  assert.ok(html.includes("status: 'active', lang: odmLang()"), 'card-update sends lang')
  assert.ok(html.includes('{ id, lang: odmLang() }'), 'card-delete sends lang')
})

test('keyboard shortcuts help follows the UI locale', () => {
  assert.equal(t('kb.title', 'en'), 'Keyboard shortcuts')
  assert.equal(t('kb.title', 'zh'), '键盘快捷键')
  assert.equal(t('kb.nav', 'en'), 'Move focus between cards')
  assert.equal(t('kb.nav', 'zh'), '在卡片间移动焦点')
  assert.equal(t('kb.open', 'en'), 'Open the focused card (details + conversation)')
  assert.equal(t('kb.open', 'zh'), '打开当前卡（详情 + 对话）')
  assert.equal(t('kb.done', 'en'), 'Complete focused card (undoable)')
  assert.equal(t('kb.done', 'zh'), '完成当前卡（可撤销）')
  assert.equal(t('kb.snooze', 'en'), 'Snooze focused card')
  assert.equal(t('kb.snooze', 'zh'), '推迟当前卡')
  assert.equal(t('kb.enter', 'en'), 'Open the collapsed conversation dock')
  assert.equal(t('kb.enter', 'zh'), '打开已收起的对话栏')
  assert.equal(t('kb.send', 'en'), 'Send a message (when typing in the box)')
  assert.equal(t('kb.send', 'zh'), '发送消息（输入框内）')
  assert.equal(t('kb.esc', 'en'), 'Close an overlay, dismiss a suggestion, or collapse the conversation')
  assert.equal(t('kb.esc', 'zh'), '关闭浮层 / 收起建议 / 收起对话')
  assert.equal(t('kb.help', 'en'), 'This help')
  assert.equal(t('kb.help', 'zh'), '打开本说明')
  assert.equal(t('kb.close', 'en'), 'Got it')
  assert.equal(t('kb.close', 'zh'), '知道了')
  assert.match(t('kb.note', 'en'), /IME/)
  assert.match(t('kb.note', 'zh'), /IME 组字/)
  const html = readFileSync(new URL('../packages/dsh-muse-ui/static/index.html', import.meta.url), 'utf8')
  const helpFn = (html.match(/function openKbHelp\(\) \{[\s\S]*?\n  \}\n/) || [])[0] || ''
  assert.ok(helpFn.includes('function openKbHelp'), 'found openKbHelp in index.html')
  for (const s of ['在工作卡之间移动焦点', '打开当前卡（详情 + 对话）', '完成当前卡（可撤销）', '推迟当前卡', '打开已收起的对话栏', '发送消息（输入框内）', '关闭浮层 / 收起建议 / 收起对话', '打开本说明', '避免打断中文输入', '知道了']) {
    assert.ok(!helpFn.includes(s), `hardcoded zh left in openKbHelp: ${s}`)
  }
  for (const key of ['kb.title', 'kb.nav', 'kb.open', 'kb.done', 'kb.snooze', 'kb.enter', 'kb.send', 'kb.esc', 'kb.help', 'kb.note', 'kb.close']) {
    assert.ok(helpFn.includes(`t('${key}')`), `openKbHelp uses ${key}`)
  }
})


test('card-side chat header follows the UI locale', () => {
  assert.equal(t('zoom.chat_title', 'en', { name: 'Inbox' }), 'Chat with Douya about “Inbox”')
  assert.equal(t('zoom.chat_title', 'zh', { name: '收件箱' }), '和豆芽聊「收件箱」')
  assert.equal(t('zoom.chat_sub', 'en'), 'Same conversation · what you say here is saved on this card')
  assert.equal(t('zoom.chat_sub', 'zh'), '同一个对话 · 这里说的会记在这张卡上')
  assert.equal(t('zoom.chat_hist', 'en', { n: 3 }), 'Earlier conversation on this card · 3')
  assert.equal(t('zoom.chat_hist', 'zh', { n: 3 }), '之前在这张卡上的对话 · 3 条')
  const html = readFileSync(new URL('../packages/dsh-muse-ui/static/index.html', import.meta.url), 'utf8')
  const zoomFn = (html.match(/function openTileZoom\(card\) \{[\s\S]*?\n  \}\n/) || [])[0] || ''
  assert.ok(zoomFn.includes('function openTileZoom'), 'found openTileZoom in index.html')
  for (const s of ['和豆芽聊「', '同一个对话 · 这里说的会记在这张卡上', '之前在这张卡上的对话 ·']) {
    assert.ok(!zoomFn.includes(s), `hardcoded zh left in openTileZoom: ${s}`)
  }
  assert.ok(zoomFn.includes("t('zoom.chat_title', { name })"), 'openTileZoom uses zoom.chat_title')
  assert.ok(zoomFn.includes("t('zoom.chat_sub')"), 'openTileZoom uses zoom.chat_sub')
  assert.ok(zoomFn.includes("t('zoom.chat_hist', { n: d.messages.length })"), 'openTileZoom uses zoom.chat_hist')
})
