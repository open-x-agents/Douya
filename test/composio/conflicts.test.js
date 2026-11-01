// 两个 app 对同一件事给出不同的时间（#32 S5 / 验收 A10）：一条事、两条 source、两个时间都印在卡片上，
// 并写明采信哪条、为什么。
//
// 数据来自 S4 已合入的 `test/fixtures/composio/multi/same-page`：同一场「产品评审会」被
// googlecalendar（16:00）与 gmail（15:30）各报一次。两条观察是真适配器从 fixture 回放出来的，
// 不是手写的字面量 —— 所以「16:00 / 15:30」这两个时间确实来自输入，而不是测试自己编的。
//
// 邮件这一条：Gmail 适配器把 `Date` 头放进了 `at`（15:30 +0800），`due_at` 留空 —— 邮件不是在
// 声明截止时间。这里把该邮件「自己说的那个时刻」当作它的 `due_at`（`due_kind` 仍为空，即软时间），
// 正是「两个 app 各说一个时间、日历那条是硬时间」的场景。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { sourceLabel } from '../../src/host/ask.js'
import { conflictsOf, WHY_EARLIER, WHY_HARD, WHY_REF } from '../../src/host/conflicts.js'
import { localClock } from '../../src/host/normalize.js'
import { panelData, renderSections } from '../../src/host/panel.js'
import { createGmailAdapter } from '../../src/sources/composio/gmail.js'
import { createGoogleCalendarAdapter } from '../../src/sources/composio/googlecalendar.js'
import { accountForOf, accountsOf, loadScenario, transportFor } from './helpers.mjs'

const ZONE = 'Asia/Shanghai'

// 从 same-page fixture 里取两条真观察：googlecalendar 的会议事件与 gmail 的评审线程。
async function samePageSources() {
  const loaded = loadScenario('same-page')
  const accountFor = accountForOf(accountsOf(loaded.scenario), loaded.scenario.userId)
  const transport = transportFor(loaded)
  const calendar = createGoogleCalendarAdapter({ account: accountFor('googlecalendar'), transport })
  const gmail = createGmailAdapter({ account: accountFor('gmail'), transport })

  const calendarList = await calendar.list(loaded.scenario.since)
  const gmailList = await gmail.list(loaded.scenario.since)
  assert.equal(calendarList.observations.length, 1)
  assert.equal(gmailList.observations.length, 1)

  const event = calendarList.observations[0]
  const thread = gmailList.observations[0]
  // 邮件自己说的时刻在它的 `at`（Date 头 15:30 +0800）里，也在它的 excerpt 里。
  assert.match(thread.excerpt, /15:30/)
  return [
    { ...thread, due_at: thread.at, due_kind: null },
    event,
  ]
}

// 一条事、两条 source：`due_at` 各说各的，所以事件本身的一致性值是 null（`buildEvent()` 的行为），
// 并列由 `conflictsOf()` 在渲染时补上。
async function samePageEvent() {
  const sources = await samePageSources()
  return {
    id: 'evt_same_page',
    kind: 'meeting',
    title: '产品评审会',
    state: 'open',
    due_at: null,
    due_kind: null,
    who: { people: ['李娜'], waiting_on: null },
    project: null,
    sources,
  }
}

function dayOf(event) {
  return {
    days: {
      '2025-11-01': {
        day: '2025-11-01',
        time_zone: ZONE,
        conclusion: '今天有一场评审。',
        meeting_hours: 1,
        events: [event],
      },
    },
  }
}

test('two apps disagree on the time and the thing keeps both values', async () => {
  const event = await samePageEvent()
  assert.equal(event.sources.length, 2)
  assert.deepEqual(event.sources.map(source => source.source).sort(), [
    'composio:gmail',
    'composio:googlecalendar',
  ])

  const conflicts = conflictsOf(event)
  assert.equal(conflicts.length, 1)
  const [due] = conflicts
  assert.equal(due.field, 'due_at')
  assert.equal(due.values.length, 2)
  assert.deepEqual(due.values.map(value => value.value), [
    event.sources[1].due_at,
    event.sources[0].due_at,
  ])
  assert.equal(localClock(due.values[0].value, ZONE), '16:00')
  assert.equal(localClock(due.values[1].value, ZONE), '15:30')
  assert.equal(due.chosen.source, 'composio:googlecalendar')
  assert.equal(localClock(due.chosen.value, ZONE), '16:00')
  assert.equal(due.chosen.why, WHY_HARD)

  // 一条事：面板上一个 item 卡片，不是两条。
  const data = panelData(dayOf(event), { today: '2025-11-01', timeZone: ZONE, sources: {} })
  assert.equal(data.events.length, 1)
  assert.equal(data.events[0].conflicts[0].field, 'due_at')
})

test('the card prints both times and says which one it trusts', async () => {
  const event = await samePageEvent()
  const data = panelData(dayOf(event), {
    today: '2025-11-01',
    timeZone: ZONE,
    sources: { 'composio:gmail': { connected: true }, 'composio:googlecalendar': { connected: true } },
  })
  const html = renderSections(data)

  // 两个时间都在，不只写被采信的那个。
  assert.match(html, /16:00/)
  assert.match(html, /15:30/)
  assert.match(html, /本地 16:00（谷歌日历） \/ 15:30（邮件）/)
  assert.match(html, /采信 16:00（谷歌日历）：日程是硬时间/)
})

test('two apps say opposite states and the conflict keeps no winner', () => {
  const conflicts = conflictsOf({
    sources: [
      { source: 'composio:gmail', ref: 'composio:gmail:thread/t-1', state: 'open', at: '2025-10-31T07:30:00.000Z' },
      { source: 'composio:slack', ref: 'composio:slack:message/C1/1761900000.0001', state: 'done', at: '2025-10-31T08:00:00.000Z' },
    ],
  })
  assert.equal(conflicts.length, 1)
  const [state] = conflicts
  assert.equal(state.field, 'state')
  assert.equal(state.values.length, 2)
  // 说法相反就记未知，不投票。
  assert.equal(state.chosen, null)
})

test('an earlier time wins when neither source is a hard time', () => {
  const [due] = conflictsOf({
    sources: [
      { source: 'composio:gmail', ref: 'composio:gmail:thread/t-2', due_at: '2025-11-01T08:00:00Z', due_kind: null, at: '2025-10-31T07:30:00.000Z' },
      { source: 'composio:slack', ref: 'composio:slack:message/C1/2', due_at: '2025-11-01T07:00:00Z', due_kind: null, at: '2025-10-31T08:00:00.000Z' },
    ],
  })
  assert.equal(due.values.length, 2)
  // `at` 是这条证据被看见的时刻（不是它说的时间）：先看见的那条赢。
  assert.equal(due.chosen.ref, 'composio:gmail:thread/t-2')
  assert.equal(due.chosen.why, WHY_EARLIER)
})

test('two times at the same moment are ordered by ref and say so', () => {
  const [due] = conflictsOf({
    sources: [
      { source: 'composio:slack', ref: 'composio:slack:message/C1/9', due_at: '2025-11-01T07:00:00Z', due_kind: null, at: '2025-10-31T08:00:00.000Z' },
      { source: 'composio:gmail', ref: 'composio:gmail:thread/t-3', due_at: '2025-11-01T08:00:00+01:00', due_kind: null, at: '2025-10-31T08:00:00.000Z' },
    ],
  })
  // 同一时刻（07:00Z）的两种写法是两个不同的字符串，按 ref 取小者。
  assert.equal(due.values.length, 2)
  assert.equal(due.chosen.ref, 'composio:gmail:thread/t-3')
  assert.equal(due.chosen.why, WHY_REF)
})

test('a single voice is not a conflict', () => {
  assert.deepEqual(conflictsOf({ sources: [{ source: 'composio:gmail', ref: 'a', due_at: '2025-11-01T07:00:00Z', state: 'open' }] }), [])
  assert.deepEqual(conflictsOf({ sources: [] }), [])
  assert.deepEqual(conflictsOf({}), [])
  // 两条源说同一件事，也不是冲突。
  assert.deepEqual(conflictsOf({
    sources: [
      { source: 'composio:gmail', ref: 'a', due_at: '2025-11-01T07:00:00Z', state: 'open' },
      { source: 'composio:googlecalendar', ref: 'b', due_at: '2025-11-01T07:00:00Z', state: 'open' },
    ],
  }), [])
})

test('a source id shows its registry label, not the raw prefix', () => {
  const data = panelData({}, {
    today: null,
    timeZone: ZONE,
    sources: { 'composio:notion': { connected: true }, 'composio:slack': { connected: null } },
  })
  const html = renderSections(data)
  assert.match(html, /已读：Notion/)
  assert.match(html, /未读到：Slack 的状态/)
  assert.equal(html.includes('composio:notion'), false)
})

test('the ask bubble names a composio source with its registry label', () => {
  assert.equal(sourceLabel('composio:googlecalendar'), '谷歌日历')
  assert.equal(sourceLabel('composio:gmail'), '邮件')
  assert.equal(sourceLabel('composio:notion'), 'Notion')
  assert.equal(sourceLabel({ ref: 'composio:slack:message/C1/1' }), 'Slack')
  // 注册表不认识的 toolkit 仍然回落 slug，不吞成空串。
  assert.equal(sourceLabel('composio:unknown_app'), 'unknown_app')
})
