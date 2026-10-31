// The panel: one page over the same store the cards are built from. Snapshot building and
// rendering are pure functions, so what the page shows is exactly what a test asserts. The
// page ships no script and no external resource — the server renders the whole body — and a
// number the store does not carry is written as 未知 instead of being filled in with a zero.

import { readFile } from 'node:fs/promises'
import { PANEL_PAGE_ROUTE, PANEL_ROUTE } from './constants.js'

export const BODY_MARKER = '<!--panel:body-->'
export const UNKNOWN = '未知'

// One name per source type, so the page, the tests and the missing-source sentence agree.
export const SOURCE_NAMES = {
  feishu: '飞书消息',
  calendar: '飞书日历',
  mail: '邮箱',
  doc: '云文档',
  github: 'GitHub',
}

const ITEM_STATES = ['open', 'closed', 'waiting', 'dropped']

export function reportKey(memberId, date) {
  return `${memberId}:${date}`
}

// The day key is the date the person lives in, not the UTC date: at 00:30 in Shanghai the
// UTC date is still yesterday, and a panel keyed on UTC would draw yesterday as today.
export function dayKey(when = new Date(), timeZone) {
  const at = when instanceof Date ? when : new Date(when)
  if (Number.isNaN(at.getTime())) return null
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at)
  const part = type => parts.find(entry => entry.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

export function panelSnapshot({ state, plan = [], today, now = Date.now() } = {}) {
  const members = Object.values(state?.members ?? {}).filter(member => member?.active !== false)
  const submitted = new Set(
    Object.keys(state?.reports ?? {})
      .filter(key => key.endsWith(`:${today}`))
      .map(key => key.slice(0, key.lastIndexOf(':')))
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

const sourceType = source => (typeof source === 'string' ? source.trim() || null : asText(source?.type) || null)

function viewSources(raw) {
  const view = {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return view
  for (const [type, record] of Object.entries(raw)) {
    if (record === null || typeof record !== 'object') continue
    view[type] = {
      // A source the store never spoke about stays unknown: not connected, not broken.
      connected: record.connected === true ? true : record.connected === false ? false : null,
      lastReadAt: asText(record.last_read_at) || null,
      detail: asText(record.detail) || null,
    }
  }
  return view
}

function viewItem(raw, sources, index) {
  const item = raw ?? {}
  const types = Array.isArray(item.sources) ? item.sources.map(sourceType).filter(Boolean) : []
  const dead = types.filter(type => sources[type]?.connected === false)
  const live = types.filter(type => sources[type]?.connected !== false)
  return {
    id: asText(item.id) || `item-${index + 1}`,
    title: asText(item.title) || UNKNOWN,
    state: ITEM_STATES.includes(item.state) ? item.state : null,
    why: asText(item.why),
    advice: asText(item.advice),
    note: asText(item.note),
    dueAt: asText(item.dueAt) || null,
    sources: types,
    deadSources: dead,
    liveSources: live,
    // An item that rests on a dead source — or on no source at all — is drawn weaker, because
    // the sentence behind it cannot be backed today. A source the store never mentioned does
    // not make an item weaker: that would be inventing a gap.
    srcless: types.length === 0 || dead.length > 0,
    evidence: Array.isArray(item.evidence)
      ? item.evidence
        .map(entry => ({ ref: asText(entry?.ref) || null, at: asText(entry?.at) || null }))
        .filter(entry => entry.ref || entry.at)
      : [],
  }
}

function meetingMinutes(meetings) {
  if (!Array.isArray(meetings)) return null
  let minutes = 0
  for (const meeting of meetings) {
    const start = Date.parse(asText(meeting?.startAt))
    const end = Date.parse(asText(meeting?.endAt))
    // A meeting without readable times makes the whole sum unknown: a partial sum is a lie.
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null
    minutes += (end - start) / 60000
  }
  return minutes
}

// The view model behind the page: every field the store does not carry is null, never 0.
export function panelData(state, { today, sources } = {}) {
  const day = today === undefined ? null : (state?.days?.[today] ?? null)
  const sourceView = viewSources(sources ?? state?.sources)
  const items = Array.isArray(day?.items) ? day.items.map((item, index) => viewItem(item, sourceView, index)) : null
  return {
    today: today ?? null,
    day,
    conclusion: asText(day?.conclusion) || null,
    items,
    stats: {
      open: items ? items.filter(item => item.state === 'open').length : null,
      waiting: items ? items.filter(item => item.state === 'waiting').length : null,
      meetingMinutes: meetingMinutes(day?.meetings),
    },
    sources: sourceView,
  }
}

function renderHeadline(data) {
  if (data.day === null) {
    return `<section class="headline" data-section="headline">
  <h2 class="concl">今天没有必须今天的事</h2>
</section>`
  }
  const open = data.stats.open === null ? UNKNOWN : data.stats.open
  const waiting = data.stats.waiting === null ? UNKNOWN : data.stats.waiting
  const meetings = data.stats.meetingMinutes === null ? UNKNOWN : `${(data.stats.meetingMinutes / 60).toFixed(1)}h`
  return `<section class="headline" data-section="headline">
  <h2 class="concl">${escapeHtml(data.conclusion ?? '还没读到')}</h2>
  <div class="stats">
    <div class="stat"><b>${open}</b><span>件在手</span></div>
    <div class="stat"><b>${meetings}</b><span>会议</span></div>
    <div class="stat"><b>${waiting}</b><span>件在等别人</span></div>
  </div>
</section>`
}

function srclessNote(item) {
  if (!item.srcless) return ''
  if (item.sources.length === 0) return '这条没有依据'
  const dead = item.deadSources.map(sourceLabel).join('、')
  if (dead === '') return '这条没有依据'
  if (item.liveSources.length === 0) return `${escapeHtml(dead)}没连上，这条没有依据`
  return `${escapeHtml(dead)}没连上，这条只有${escapeHtml(item.liveSources.map(sourceLabel).join('、'))}依据`
}

function renderItemCard(item) {
  const lines = [`<article class="item${item.srcless ? ' srcless' : ''}" id="item-${escapeHtml(item.id)}">`]
  lines.push(`  <h4>${escapeHtml(item.title)}</h4>`)
  if (item.why) lines.push(`  <p class="why">${escapeHtml(item.why)}</p>`)
  const note = srclessNote(item)
  if (note) lines.push(`  <p class="src-note">${note}</p>`)
  if (item.advice) lines.push(`  <p class="advice">${escapeHtml(item.advice)}</p>`)
  lines.push('</article>')
  return lines.join('\n')
}

function renderItems(data) {
  if (data.items === null) return `<section class="items" data-section="items">\n  <p class="muted">${UNKNOWN}</p>\n</section>`
  const open = data.items.filter(item => item.state === 'open')
  const body = open.length === 0 ? '<p class="muted">今天没有要推的事</p>' : open.map(renderItemCard).join('\n')
  return `<section class="items" data-section="items">\n${body}\n</section>`
}

function renderWaiting(data) {
  const waiting = (data.items ?? []).filter(item => item.state === 'waiting')
  const count = data.stats.waiting === null ? UNKNOWN : data.stats.waiting
  const body = data.items === null
    ? `<p class="muted">${UNKNOWN}</p>`
    : waiting.length === 0
      ? '<p class="muted">没有在等别人的事</p>'
      : `<ul class="wait-list">\n${waiting
        .map(item => `  <li>${escapeHtml(item.title)}${item.note ? `<em>${escapeHtml(item.note)}</em>` : ''}</li>`)
        .join('\n')}\n</ul>`
  return `<section class="waiting" data-section="waiting">
  <h2>在等别人 · ${count} 件</h2>
${body}
</section>`
}

function describeSources(sources) {
  const entries = Object.entries(sources)
  const read = entries.filter(([, source]) => source.connected === true).map(([type]) => sourceLabel(type))
  const dead = entries.filter(([, source]) => source.connected === false).map(([type]) => sourceLabel(type))
  const parts = []
  if (read.length > 0) parts.push(`${read.join('、')}已读`)
  if (dead.length > 0) parts.push(`${dead.join('、')}未接入`)
  return parts.length > 0 ? parts.join('；') : '信源状态未知：还没读到任何信源'
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

const clock = iso => asText(iso).slice(11, 16) || '—'

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
        .map(item => `<li>${escapeHtml(clock(item.startAt))} ${escapeHtml(item.title)}<br><span class="muted">提醒 ${escapeHtml(clock(item.fireAt))}</span></li>`)
        .join('')
  const deliveryList = deliveries === null
    ? `<li class="muted">${UNKNOWN}</li>`
    : deliveries.length === 0
      ? '<li class="muted">还没有投递记录</li>'
      : deliveries
        .map(item => `<li>${escapeHtml(clock(item.at))} ${item.ok ? '<span class="ok">已送达</span>' : `<span class="bad">失败</span> ${escapeHtml(item.error ?? '')}`}</li>`)
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

// The body is a list of anchored sections: the first screen (①) and the missing-source state
// (⑥) live at the top, the old four statistics stay at the bottom as 团队日报.
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
      const data = panelData(state, { today: rt.today(), sources: state.sources })
      return new Response(renderPage(shell, renderSections(data, snapshotOf(rt))), {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      })
    },
  }), 'opendigitalmate: panel page')
  return true
}
