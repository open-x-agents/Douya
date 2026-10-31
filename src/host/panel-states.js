// Bad-day states for the daily panel. Four ways a day goes wrong: nothing due at all,
// a source that was never connected, a source that was connected but failed to read, and
// the "too long" preference actually shortening the day. Two more empty-day wordings have
// to stay apart — a weekend is not "nothing due today", and the first day has no baseline
// yet. Everything here is a pure function over a day and a source-health map: no clock,
// no disk, no network.

import { subtractStats } from './normalize.js'

export const SOURCE_LABELS = {
  gcal: '谷歌日历',
  gmail: '邮件',
  feishu_doc: '飞书文档',
  feishu_cal: '飞书日历',
  feishu_msg: '飞书消息',
  github: 'GitHub',
}

// A source that was never connected is amber and dashed; a source that was connected and
// then failed to read is red and solid. Red is the failure, not the absence.
export const SRCLESS_STYLE = 'border:1px dashed #c8862a;'
export const READFAIL_STYLE = 'border-left:3px solid #c0392b;'

const text = (value) => String(value ?? '').trim()

function escapeHtml(value) {
  return text(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

export function sourceLabel(source) {
  const name = text(source)
  if (name.startsWith('composio:')) return name.slice('composio:'.length)
  return SOURCE_LABELS[name] ?? name
}

// `state.sources` as the panel reads it: one record per source with connection, the last
// successful read, and the last error. Anything missing counts as not connected. The tick
// (#46) writes the error as `error`; the older fixture says `last_error` — read both, so a
// failed read never silently turns into a live source.
export function sourceHealth(sources = {}) {
  const out = {}
  for (const [name, raw] of Object.entries(sources ?? {})) {
    out[name] = {
      name,
      connected: raw?.connected === true,
      last_read_at: text(raw?.last_read_at) || null,
      last_error: text(raw?.last_error ?? raw?.error) || null,
    }
  }
  return out
}

function healthOf(health, source) {
  return health?.[source] ?? { name: source, connected: false, last_read_at: null, last_error: null }
}

// The one place a card's sources are split into dead / failed / live, so the card and the
// page banner can never disagree about why an item is bad.
export function sourceStanding(event, health = {}) {
  const sources = Array.isArray(event?.sources) ? event.sources : []
  const dead = []
  const failed = []
  const live = []
  for (const source of sources) {
    const record = healthOf(health, source?.source)
    if (!record.connected) dead.push(source)
    else if (record.last_error !== null) failed.push(source)
    else live.push(source)
  }
  return { sources, dead, failed, live }
}

function weekdayOf(date) {
  const ms = Date.parse(`${text(date)}T00:00:00Z`)
  if (!Number.isFinite(ms)) return null
  return new Date(ms).getUTCDay()
}

// The day's bad-state verdict: which empty wording applies, which cards get a dashed
// amber edge, which get red, how many items were not fetched at all, and whether the
// "too long" preference is already in force.
export function badStates(day = {}, health = {}) {
  const date = text(day?.date)
  const tz = text(day?.tz) || 'UTC'
  const events = Array.isArray(day?.events) ? day.events : []
  const prefs = day?.prefs ?? {}
  const weekday = weekdayOf(date)
  const weekend = weekday === 0 || weekday === 6
  const firstDay = day?.has_baseline === false
  const empty = events.length === 0

  const srcless = []
  const readfail = []
  let lost = 0
  for (const event of events) {
    const standing = sourceStanding(event, health)
    if (standing.sources.length === 0 || standing.live.length === 0) lost += 1
    if (standing.dead.length > 0) {
      srcless.push({
        event_id: event?.id ?? null,
        title: text(event?.title),
        missing: standing.dead.map((source) => sourceLabel(source?.source)),
        live: standing.live.map((source) => sourceLabel(source?.source)),
        refs: standing.dead.map((source) => text(source?.ref)),
      })
    }
    if (standing.failed.length > 0) {
      readfail.push({
        event_id: event?.id ?? null,
        title: text(event?.title),
        failed: standing.failed.map((source) => sourceLabel(source?.source)),
        live: standing.live.map((source) => sourceLabel(source?.source)),
        refs: standing.failed.map((source) => text(source?.ref)),
      })
    }
  }

  const brevity = prefs?.brevity ?? null
  const since = text(brevity?.since_day)
  const brief = since !== '' && date >= since

  const stats = subtractStats(events, { day: date === '' ? null : date, tz })
  const open = events.filter((event) => event?.state === 'open').length
  const meetings = events.filter((event) => event?.kind === 'meeting').length

  return {
    date,
    kind: weekend ? 'weekend' : firstDay ? 'first_day' : empty ? 'empty' : 'normal',
    empty,
    weekend,
    first_day: firstDay,
    srcless,
    readfail,
    lost,
    brief,
    stats: { ...stats, open, meetings },
  }
}

// "N 项未取到" is the page banner. Zero is silence, not "0 项未取到".
export function bannerText(states = {}) {
  const lost = Number(states?.lost ?? 0)
  return lost > 0 ? `${lost} 项未取到` : ''
}

export function renderBanner(states = {}) {
  const message = bannerText(states)
  if (message === '') return ''
  return `<div class="banner" data-banner="partial">${escapeHtml(message)}</div>`
}

function evidenceBlock(event, standing) {
  const rows = standing.sources.map((source) => {
    const label = sourceLabel(source?.source)
    const ref = text(source?.ref)
    const at = text(source?.at) || text(source?.due_at)
    const failed = standing.failed.includes(source)
    const dead = standing.dead.includes(source)
    const note = dead ? '没连上' : failed ? '读失败' : at === '' ? '' : at
    return `<li class="evi-row" data-evidence="${escapeHtml(ref)}"><span class="evi-src">${escapeHtml(label)}</span>`
      + `<code class="evi-ref">${escapeHtml(ref)}</code>`
      + (note === '' ? '' : `<span class="evi-note">${escapeHtml(note)}</span>`)
      + '</li>'
  })
  if (rows.length === 0) return ''
  const id = escapeHtml(text(event?.id))
  return `<details class="evi" id="ev-${id}"><summary>依据 ${rows.length} 条</summary><ul>${rows.join('')}</ul></details>`
}

// One card carries at most one action: the fixture stores a single action object, not an
// array, and this function renders exactly that one or nothing at all.
function actionBlock(event) {
  const action = event?.action
  if (action === null || action === undefined || typeof action !== 'object') return ''
  const kind = text(action.kind)
  const label = text(action.label) || kind
  if (kind === '' && label === '') return ''
  return `<button class="act" data-act="${escapeHtml(kind || label)}">${escapeHtml(label)}</button>`
}

export function renderItemCard(event = {}, health = {}) {
  const standing = sourceStanding(event, health)
  const title = text(event?.title) || '一条没有标题的事'
  const classes = ['item-card']
  let style = ''
  let note = ''

  const deadNames = standing.dead.map((source) => sourceLabel(source?.source))
  const failedNames = standing.failed.map((source) => sourceLabel(source?.source))
  const liveNames = standing.live.map((source) => sourceLabel(source?.source))

  if (standing.sources.length === 0 || standing.live.length === 0) {
    if (standing.failed.length > 0) {
      classes.push('readfail')
      style = ` style="${READFAIL_STYLE}"`
    }
    const missing = [...deadNames, ...failedNames]
    note = `<p class="cannot">这条我答不了，缺的是 ${escapeHtml(missing.join('、') || '任何信源')}。</p>`
  } else if (standing.dead.length > 0) {
    classes.push('srcless')
    style = ` style="${SRCLESS_STYLE}"`
    note = `<p class="srcless-note">${escapeHtml(deadNames.join('、'))}没连上，这条只有${escapeHtml(liveNames.join('、'))}依据。</p>`
  } else if (standing.failed.length > 0) {
    classes.push('readfail')
    style = ` style="${READFAIL_STYLE}"`
    note = `<p class="readfail-note">${escapeHtml(failedNames.join('、'))}连上了但读失败，这条先按${escapeHtml(liveNames.join('、'))}看。</p>`
  }

  return `<article class="${classes.join(' ')}" data-event="${escapeHtml(text(event?.id))}"${style}>`
    + `<h4 class="item-title">${escapeHtml(title)}</h4>`
    + note
    + evidenceBlock(event, standing)
    + actionBlock(event)
    + '</article>'
}

// Three empty wordings that must never collapse into one: nothing due today, a weekend
// that is deliberately quiet, and the first day that has no baseline to compare against.
export function renderEmpty(kind, options = {}) {
  const next = text(options?.next_first?.title)
  const nextLine = next === '' ? '' : `<p class="next-first">明天第一件：${escapeHtml(next)}</p>`
  let lead
  if (kind === 'weekend') lead = options?.prefs?.weekend_send === true ? '周末也照常发。' : '周末不打扰，今天不推。'
  else if (kind === 'first_day') lead = '这是第一天，还没有基线。'
  else lead = '今天没有必须今天的事。'
  return `<section class="empty-day" data-empty="${escapeHtml(kind)}"><p class="empty-lead">${escapeHtml(lead)}</p>${nextLine}</section>`
}

// The three first-screen numbers, each with its own caption. A value that is computed and
// zero is printed as 0 — "未知" is only for a value the day did not produce at all.
export function renderNumbers(stats = {}) {
  const printed = (value) => (Number.isFinite(Number(value)) ? String(Number(value)) : '未知')
  const cells = [
    ['open', '件在手', '开着的，不算已关'],
    ['meetings', '会议', '今天有定时'],
    ['waiting', '件在等别人', '等别人不是你的债'],
  ]
  const body = cells
    .map(([key, label, caption]) => `<span class="number" data-number="${key}" data-caption="${escapeHtml(caption)}"><b>${printed(stats?.[key])}</b>${label}</span>`)
    .join('')
  return `<div class="numbers" data-numbers="3">${body}</div>`
}

// The first-screen conclusion. "0 件" is a fact about the day and is printed as 0; it is
// never dressed up as "未知" just because nothing was closed.
export function renderConclusion(stats = {}) {
  const printed = (value) => (Number.isFinite(Number(value)) ? String(Number(value)) : '未知')
  return `<p class="conclusion" data-conclusion="1">今天关掉 ${printed(stats?.closed)} 件，${printed(stats?.waiting)} 件在等别人。</p>`
}
