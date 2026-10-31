// The panel: one page over the same store the cards are built from. Snapshot building and
// rendering are pure functions, so what the page shows is exactly what a test asserts. The
// page is rendered on the server, ships no script and no external resource, and a number the
// store does not carry is written as 未知 instead of being filled in with a zero.

import { readFile } from 'node:fs/promises'
import { PANEL_PAGE_ROUTE, PANEL_ROUTE } from './constants.js'
import { localClock } from './normalize.js'

export const BODY_MARKER = '<!--panel:body-->'
export const UNKNOWN = '未知'

// One name per source type, so the page, the tests and the missing-source sentence agree.
// The keys are #9's SOURCE_TYPES; `composio:<toolkit>` falls through to its own name.
export const SOURCE_NAMES = {
  gcal: '谷歌日历',
  gmail: '邮件',
  feishu_doc: '云文档',
  feishu_cal: '飞书日历',
  feishu_msg: '飞书消息',
  github: 'GitHub',
}

export function reportKey(memberId, date) {
  return `${memberId}:${date}`
}

export function panelSnapshot({ state, plan = [], today, now = Date.now() } = {}) {
  const members = Object.values(state?.members ?? {}).filter(member => member?.active !== false)
  const submitted = new Set(
    Object.keys(state?.reports ?? {})
      .filter(key => key.endsWith(`:${today}`))
      .map(key => key.slice(0, key.lastIndexOf(':'))),
  )
  const upcoming = plan
    .filter(reminder => Date.parse(reminder.fireAt) >= now)
    .slice(0, 20)
    .map(reminder => ({ id: reminder.id, title: reminder.title, startAt: reminder.startAt, fireAt: reminder.fireAt }))
  const deliveries = (state?.deliveries ?? []).slice(-20).reverse()
  return {
    today,
    members: members.map(member => ({ id: member.id, name: member.name, submitted: submitted.has(member.id) })),
    total: members.length,
    submitted: members.filter(member => submitted.has(member.id)).length,
    missing: members.filter(member => !submitted.has(member.id)).map(member => member.name),
    upcoming,
    deliveries,
  }
}

export function snapshotOf(rt) {
  const state = rt.store.get()
  const today = rt.today()
  return {
    ...panelSnapshot({ state, plan: state.upcoming ?? [], today, now: rt.now().getTime() }),
    sources: state.sources ?? {},
    panel: panelData(state, { today, timeZone: rt.timeZone, sources: state.sources }),
  }
}

const asText = value => (typeof value === 'string' ? value.trim() : '')

const escapeHtml = value => String(value ?? '').replace(/[&<>"]/g, ch => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
}[ch]))

const sourceLabel = type => SOURCE_NAMES[type] ?? type

const sourceType = entry => (typeof entry === 'string'
  ? entry.trim() || null
  : asText(entry?.source) || asText(entry?.type) || null)

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)

// A source record the store never wrote is `null`, not `false`: "connected" is three-valued, so
// "we read it", "it is down" and "we have not heard" stay three different sentences.
function viewSources(raw) {
  const view = {}
  if (!isRecord(raw)) return view
  for (const [type, record] of Object.entries(raw)) {
    if (!isRecord(record)) continue
    view[type] = {
      connected: record.connected === true ? true : record.connected === false ? false : null,
      lastReadAt: asText(record.last_read_at) || null,
      detail: asText(record.detail) || null,
    }
  }
  return view
}

function viewEvent(raw, sources, index) {
  const event = raw ?? {}
  const observations = Array.isArray(event.sources) ? event.sources : []
  const types = [...new Set(observations.map(sourceType).filter(Boolean))]
  const live = types.filter(type => sources[type]?.connected === true)
  const dead = types.filter(type => sources[type]?.connected === false)
  const unread = types.filter(type => sources[type]?.connected !== true && sources[type]?.connected !== false)
  // An event that rests on no live source cannot back its sentence today; it is drawn weaker
  // and says so, never as a normal card.
  const noEvidence = types.length === 0 || live.length === 0
  return {
    id: asText(event.id) || `event-${index + 1}`,
    title: asText(event.title) || UNKNOWN,
    state: asText(event.state) || null,
    dueAt: asText(event.due_at) || null,
    waitingOn: asText(event.who?.waiting_on) || null,
    deferred: event.defer !== null && event.defer !== undefined,
    closureEvidence: asText(event.closure?.evidence_ref) || null,
    sources: types,
    liveSources: live,
    deadSources: dead,
    unreadSources: unread,
    srcless: types.length === 0 || live.length === 0 || dead.length > 0 || unread.length > 0,
    noEvidence,
  }
}

// The view model behind the page: every field the store does not carry is null, never 0.
// `today` is a local day key; `timeZone` is what makes a clock on the page local.
export function panelData(state, { today, timeZone, sources } = {}) {
  const rawDay = today === undefined || today === null ? null : (state?.days?.[today] ?? null)
  const day = isRecord(rawDay) ? rawDay : null
  const sourceView = viewSources(sources ?? state?.sources)
  const events = Array.isArray(day?.events) ? day.events.map((event, index) => viewEvent(event, sourceView, index)) : null
  const conclusion = asText(day?.conclusion) || null
  // A day the aggregate layer has not written — or one with neither a conclusion nor an event —
  // is an unknown day: the page draws the bad state and no number nodes at all.
  const known = day !== null && (conclusion !== null || (events !== null && events.length > 0))
  const knownDay = known ? day : null
  const knownEvents = known ? events : null
  const meetingHours = knownDay !== null && Number.isFinite(knownDay.meeting_hours) ? knownDay.meeting_hours : null
  const upcoming = Array.isArray(state?.upcoming) ? state.upcoming : []
  return {
    today: today ?? null,
    timeZone: timeZone ?? null,
    day: knownDay,
    conclusion,
    events: knownEvents,
    open: knownEvents === null ? null : knownEvents.filter(event => event.state === 'open' && !event.deferred),
    waiting: knownEvents === null ? null : knownEvents.filter(event => event.waitingOn !== null),
    stats: {
      open: knownEvents === null ? null : knownEvents.filter(event => event.state === 'open' && !event.deferred).length,
      waiting: knownEvents === null ? null : knownEvents.filter(event => event.waitingOn !== null).length,
      closed: knownEvents === null ? null : knownEvents.filter(event => event.state === 'closed' && event.closureEvidence !== null).length,
      dropped: knownEvents === null ? null : knownEvents.filter(event => event.deferred).length,
      meetingHours,
    },
    tomorrowTitle: asText(upcoming[0]?.title) || null,
    sources: sourceView,
  }
}

const clockOf = (iso, timeZone) => (iso === null ? null : localClock(iso, timeZone) ?? null)

function describeSources(sources) {
  const entries = Object.entries(sources)
  const read = entries.filter(([, source]) => source.connected === true).map(([type]) => sourceLabel(type))
  const dead = entries.filter(([, source]) => source.connected === false).map(([type]) => sourceLabel(type))
  const unread = entries.filter(([, source]) => source.connected === null).map(([type]) => sourceLabel(type))
  const parts = []
  if (read.length > 0) parts.push(`已读：${read.join('、')}`)
  if (dead.length > 0) parts.push(`未连：${dead.join('、')}`)
  if (unread.length > 0) parts.push(`未读到：${unread.join('、')} 的状态`)
  return parts.length > 0 ? parts.join('；') : '还没读到信源状态'
}

function renderSources(data) {
  const entries = Object.entries(data.sources)
  const rows = entries.map(([type, source]) => {
    const state = source.connected === true
      ? '<span class="pill ok">已连</span>'
      : source.connected === false
        ? '<span class="pill no">未连</span>'
        : `<span class="pill">${UNKNOWN}</span>`
    const readAt = source.lastReadAt ? escapeHtml(source.lastReadAt.slice(0, 16).replace('T', ' ')) : '—'
    return `    <tr><td>${escapeHtml(sourceLabel(type))}</td><td>${state}</td><td>${readAt}</td><td>${escapeHtml(source.detail ?? '—')}</td></tr>`
  }).join('\n')
  const table = entries.length === 0
    ? ''
    : `<table class="src-table">
  <thead><tr><th>信源</th><th>状态</th><th>最后读取</th><th>读到</th></tr></thead>
  <tbody>
${rows}
  </tbody>
</table>
`
  return `<section class="sources" data-section="sources">
  <p class="stamp">${escapeHtml(describeSources(data.sources))}</p>
${table}</section>`
}

function renderHeadline(data) {
  if (data.day === null) {
    const tomorrow = data.tomorrowTitle === null
      ? '明天还没有安排'
      : `明天第一件事：${escapeHtml(data.tomorrowTitle)}`
    return `<section class="headline" data-section="headline">
  <h2 class="concl">今天没有必须今天的事</h2>
  <p class="muted">${tomorrow}</p>
</section>`
  }
  const open = data.stats.open === null ? UNKNOWN : data.stats.open
  const waiting = data.stats.waiting === null ? UNKNOWN : data.stats.waiting
  const meeting = data.stats.meetingHours === null ? UNKNOWN : `${data.stats.meetingHours.toFixed(1)}h`
  const closed = data.stats.closed === null ? UNKNOWN : data.stats.closed
  return `<section class="headline" data-section="headline">
  <h2 class="concl">${escapeHtml(data.conclusion ?? '还没读到今天的结论')}</h2>
  <p class="close-line">今天关掉 ${closed} 件</p>
  <div class="stats" data-numbers>
    <div class="stat"><b>${open}</b><span>件在手</span></div>
    <div class="stat"><b>${meeting}</b><span>会议</span></div>
    <div class="stat"><b>${waiting}</b><span>件在等别人</span></div>
  </div>
</section>`
}

function srclessNote(event) {
  if (!event.srcless) return ''
  if (event.sources.length === 0) return '这条没有依据：没有读到任何来源'
  const dead = event.deadSources.map(sourceLabel).join('、')
  if (event.liveSources.length === 0) {
    return dead === '' ? '没有读到任何来源，这条没有依据' : `${escapeHtml(dead)}没连上，这条没有依据`
  }
  return `${escapeHtml(dead)}没连上，这条只有${escapeHtml(event.liveSources.map(sourceLabel).join('、'))}依据`
}

function renderItemCard(event, timeZone) {
  const classes = ['item']
  if (event.srcless) classes.push('srcless')
  if (event.noEvidence) classes.push('no-evidence')
  const lines = [`<article class="${classes.join(' ')}" id="item-${escapeHtml(event.id)}">`]
  lines.push(`  <h4>${escapeHtml(event.title)}</h4>`)
  const clock = clockOf(event.dueAt, timeZone)
  lines.push(`  <p class="due">${clock === null ? '时刻未知' : `本地 ${escapeHtml(clock)}`}</p>`)
  const note = srclessNote(event)
  if (note) lines.push(`  <p class="src-note">${note}</p>`)
  lines.push('</article>')
  return lines.join('\n')
}

function renderItems(data) {
  if (data.events === null) {
    return `<section class="items" data-section="items">\n  <p class="muted">${UNKNOWN}</p>\n</section>`
  }
  const body = data.open.length === 0
    ? '<p class="muted">今天没有要推的事</p>'
    : data.open.map(event => renderItemCard(event, data.timeZone)).join('\n')
  return `<section class="items" data-section="items">\n${body}\n</section>`
}

function renderWaiting(data) {
  const count = data.stats.waiting === null ? UNKNOWN : data.stats.waiting
  const body = data.waiting === null
    ? `<p class="muted">${UNKNOWN}</p>`
    : data.waiting.length === 0
      ? '<p class="muted">没有在等别人的事</p>'
      : `<ul class="wait-list">\n${data.waiting
        .map(event => `  <li>${escapeHtml(event.title)}<em>在等 ${escapeHtml(event.waitingOn)}</em></li>`)
        .join('\n')}\n</ul>`
  return `<section class="waiting" data-section="waiting">
  <h2>在等别人 · ${count} 件</h2>
${body}
</section>`
}

function renderTeam(snapshot = {}) {
  const total = Number.isFinite(snapshot.total) ? snapshot.total : null
  const submitted = Number.isFinite(snapshot.submitted) ? snapshot.submitted : null
  const missing = Array.isArray(snapshot.missing) ? snapshot.missing : null
  const upcoming = Array.isArray(snapshot.upcoming) ? snapshot.upcoming : null
  const deliveries = Array.isArray(snapshot.deliveries) ? snapshot.deliveries : null

  const rate = total === null || submitted === null ? UNKNOWN : `${submitted}/${total}`
  const rateNote = total === null || submitted === null ? UNKNOWN : `${snapshot.today ?? UNKNOWN} · ${total === 0 ? 0 : Math.round((submitted / total) * 100)}%`
  const missingList = missing === null
    ? `<li class="muted">${UNKNOWN}</li>`
    : missing.length === 0
      ? '<li class="muted">都交了</li>'
      : missing.map(name => `<li>${escapeHtml(name)}</li>`).join('')
  const upcomingList = upcoming === null
    ? `<li class="muted">${UNKNOWN}</li>`
    : upcoming.length === 0
      ? '<li class="muted">没有待提醒的日程</li>'
      : upcoming
        .map(item => `<li>${escapeHtml(String(item.startAt ?? '').slice(11, 16) || '—')} ${escapeHtml(item.title)}<br><span class="muted">提醒 ${escapeHtml(String(item.fireAt ?? '').slice(11, 16) || '—')}</span></li>`)
        .join('')
  const deliveryList = deliveries === null
    ? `<li class="muted">${UNKNOWN}</li>`
    : deliveries.length === 0
      ? '<li class="muted">还没有投递记录</li>'
      : deliveries
        .map(item => `<li>${escapeHtml(String(item.at ?? '').slice(11, 16) || '—')} ${item.ok ? '<span class="ok">已送达</span>' : `<span class="bad">失败</span> ${escapeHtml(item.error ?? '')}`}</li>`)
        .join('')

  return `<section class="team" data-section="team">
  <h2>团队日报</h2>
  <div class="grid">
    <div class="card"><h3>日报提交率</h3><div class="big">${rate}</div><div class="muted">${escapeHtml(rateNote)}</div></div>
    <div class="card"><h3>还没交</h3><ul>${missingList}</ul></div>
    <div class="card"><h3>近期日程</h3><ul>${upcomingList}</ul></div>
    <div class="card"><h3>最近投递</h3><ul>${deliveryList}</ul></div>
  </div>
</section>`
}

// The body is a list of anchored sections: the source header, the first screen (①), the day's
// item cards, who is waiting, and the old four statistics as 团队日报 at the bottom.
export function renderSections(data, snapshot = {}) {
  return [
    renderSources(data),
    renderHeadline(data),
    renderItems(data),
    renderWaiting(data),
    renderTeam(snapshot),
  ].join('\n')
}

export function renderPage(shell, body) {
  const page = String(shell ?? '')
  if (!page.includes(BODY_MARKER)) throw new Error(`panel shell is missing ${BODY_MARKER}`)
  return page.replace(BODY_MARKER, body)
}

// Two routes on the shared /api channel, registered through the same effect ds-bot uses, so
// unloading the plugin unregisters them.
export function installPanel(ctx, rt) {
  const register = ctx?.connection?.fetch?.register
  if (typeof ctx?.effect !== 'function' || typeof register !== 'function') return false
  ctx.effect(() => register({
    path: PANEL_ROUTE,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => new Response(JSON.stringify(snapshotOf(rt)), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    }),
  }), 'opendigitalmate: panel data')

  ctx.effect(() => register({
    path: PANEL_PAGE_ROUTE,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      const shell = await readFile(new URL('../client/panel.html', import.meta.url), 'utf8')
      const state = rt.store.get()
      const data = panelData(state, { today: rt.today(), timeZone: rt.timeZone, sources: state.sources })
      return new Response(renderPage(shell, renderSections(data, snapshotOf(rt))), {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      })
    },
  }), 'opendigitalmate: panel page')
  return true
}
