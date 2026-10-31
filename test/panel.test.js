import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRuntime } from '../index.js'
import { PANEL_PAGE_ROUTE, PANEL_ROUTE } from '../src/host/constants.js'
import {
  dayKey,
  installPanel,
  panelData,
  panelSnapshot,
  renderPage,
  renderSections,
  reportKey,
  snapshotOf,
} from '../src/host/panel.js'

const state = {
  members: {
    m1: { id: 'm1', name: '小王' },
    m2: { id: 'm2', name: '小李' },
    m3: { id: 'm3', name: '已经离职', active: false },
  },
  reports: {
    [reportKey('m1', '2026-10-30')]: { memberId: 'm1', date: '2026-10-30' },
    [reportKey('m2', '2026-10-29')]: { memberId: 'm2', date: '2026-10-29' },
  },
  deliveries: [
    { kind: 'reminder', id: 'a', ok: true },
    { kind: 'reminder', id: 'b', ok: false, error: 'rate limited' },
  ],
}

const plan = [
  { id: 'a', title: '周会', startAt: '2026-10-30T09:00:00Z', fireAt: '2026-10-30T08:50:00Z' },
  { id: 'b', title: '昨天开过的会', startAt: '2026-10-29T09:00:00Z', fireAt: '2026-10-29T08:50:00Z' },
]

test('the snapshot counts today\'s reports and names who is missing', () => {
  const snapshot = panelSnapshot({ state, plan, today: '2026-10-30', now: Date.parse('2026-10-30T08:00:00Z') })
  assert.equal(snapshot.total, 2)
  assert.equal(snapshot.submitted, 1)
  assert.deepEqual(snapshot.missing, ['小李'])
  assert.equal(snapshot.today, '2026-10-30')
  assert.deepEqual(snapshot.members.map(member => member.submitted), [true, false])
})

test('an inactive member is not counted, and nobody is missing when nobody is there', () => {
  const snapshot = panelSnapshot({ state: { members: { m3: { id: 'm3', name: '已经离职', active: false } } }, today: '2026-10-30' })
  assert.equal(snapshot.total, 0)
  assert.deepEqual(snapshot.missing, [])
})

test('only reminders still ahead show up, oldest delivery first', () => {
  const snapshot = panelSnapshot({ state, plan, today: '2026-10-30', now: Date.parse('2026-10-30T08:00:00Z') })
  assert.deepEqual(snapshot.upcoming.map(item => item.id), ['a'])
  assert.deepEqual(snapshot.deliveries.map(item => item.id), ['b', 'a'])
})

test('a missing store still produces a page instead of a crash', () => {
  assert.deepEqual(panelSnapshot({}), { today: undefined, members: [], total: 0, submitted: 0, missing: [], upcoming: [], deliveries: [] })
})

test('PANEL_PAGE_ROUTE and PANEL_ROUTE both live under /api/', () => {
  assert.equal(PANEL_ROUTE.startsWith('/api/'), true)
  assert.equal(PANEL_PAGE_ROUTE.startsWith('/api/'), true)
  assert.equal(PANEL_ROUTE, '/api/opendigitalmate')
  assert.equal(PANEL_PAGE_ROUTE, '/api/opendigitalmate/page')
})

test('installPanel registers both routes under /api/ with buffered bodies', () => {
  const registered = []
  const ctx = {
    effect: (fn) => { fn(); return undefined },
    connection: { fetch: { register: (route) => { registered.push(route); return () => {} } } },
  }
  const rt = {
    store: { get: () => ({}) },
    today: () => '2026-10-30',
    now: () => new Date('2026-10-30T08:00:00Z'),
  }
  assert.equal(installPanel(ctx, rt), true)
  assert.deepEqual(registered.map(route => route.path).sort(), ['/api/opendigitalmate', '/api/opendigitalmate/page'].sort())
  for (const route of registered) {
    assert.equal(route.requestBody, 'buffered')
    assert.deepEqual(route.methods, ['GET'])
    assert.equal(route.path.startsWith('/api/'), true)
  }
})

// ---- the seven scenes: this slice carries ① (the first screen) and ⑥ (the missing source) ----

const fixture = JSON.parse(readFileSync(new URL('./fixtures/panel-day.json', import.meta.url), 'utf8'))
const shell = readFileSync(new URL('../src/client/panel.html', import.meta.url), 'utf8')
const TODAY = '2026-10-30'
const FIXTURE_CONCLUSION = '今天 3 个会，只有 1 件必须今天推完。'

const clone = value => JSON.parse(JSON.stringify(value))

// Exactly the page the plugin serves: the shell's body marker filled with the rendered sections.
function pageOf(source, { today = TODAY, sources } = {}) {
  const data = panelData(source, { today, sources })
  return renderPage(shell, renderSections(data, panelSnapshot({ state: source, plan: source.upcoming ?? [], today })))
}

const section = (html, name) => {
  const match = html.match(new RegExp(`<section[^>]*data-section="${name}"[^>]*>([\\s\\S]*?)</section>`))
  return match ? match[1] : ''
}

const cardTag = (html, id) => {
  const match = html.match(new RegExp(`<article[^>]*id="item-${id}"[^>]*>`))
  return match ? match[0] : ''
}

const deadCalendar = () => {
  const copy = clone(fixture)
  copy.sources.calendar.connected = false
  copy.sources.calendar.last_read_at = null
  return copy
}

test('scene ① the first screen is one conclusion, three numbers and three item titles', () => {
  const page = pageOf(fixture)
  const headline = section(page, 'headline')
  assert.match(headline, new RegExp(FIXTURE_CONCLUSION))
  assert.match(headline, /<b>3<\/b><span>件在手<\/span>/)
  assert.match(headline, /<b>3\.0h<\/b><span>会议<\/span>/)
  assert.match(headline, /<b>2<\/b><span>件在等别人<\/span>/)
  const items = section(page, 'items')
  for (const title of ['报价单发给张伟', '评审会材料定稿', '回李静那封邮件']) assert.match(items, new RegExp(title))
  // Three titles sit on the first screen; waiting and the report scroll below them.
  assert.ok(page.indexOf('回李静那封邮件') < page.indexOf('data-section="waiting"'))
})

test('the first screen says the conclusion has not been read yet instead of inventing one', () => {
  const copy = clone(fixture)
  delete copy.days[TODAY].conclusion
  const headline = section(pageOf(copy), 'headline')
  assert.match(headline, /还没读到/)
  assert.doesNotMatch(headline, /必须今天推完/)
})

test('scene ⑥ an item left with one dead source gets the dashed amber edge and names the source', () => {
  const page = pageOf(deadCalendar())
  assert.match(cardTag(page, 'evt_2'), /class="item srcless"/)
  assert.match(page, /飞书日历没连上，这条只有飞书消息依据/)
  // The other cards rest on sources that are connected: they stay plain.
  assert.match(cardTag(page, 'evt_1'), /class="item"/)
  assert.doesNotMatch(cardTag(page, 'evt_1'), /srcless/)
  assert.equal((section(page, 'items').match(/class="item srcless"/g) ?? []).length, 1)
  // The missing source is also written into the 抬头, not only onto the card.
  assert.match(section(page, 'sources'), /飞书日历、云文档未接入/)
})

test('an item with no source at all, or with every source dead, says it has no evidence', () => {
  const copy = deadCalendar()
  copy.sources.mail.connected = false
  copy.days[TODAY].items[2].sources = []
  const page = pageOf(copy)
  assert.match(cardTag(page, 'evt_3'), /class="item srcless"/)
  assert.match(section(page, 'items'), /这条没有依据/)
})

test('an unknown day renders the bad state instead of zeros', () => {
  const copy = clone(fixture)
  copy.days = {}
  const headline = section(pageOf(copy), 'headline')
  assert.match(headline, /今天没有必须今天的事/)
  assert.doesNotMatch(headline, /class="stat"/)
  assert.doesNotMatch(headline, /件在手|会议|件在等别人/)
  assert.doesNotMatch(headline, /<b>/)
})

test('a known day with nothing on it prints a real zero', () => {
  const copy = clone(fixture)
  copy.days[TODAY].items = []
  const headline = section(pageOf(copy), 'headline')
  assert.match(headline, /<b>0<\/b><span>件在手<\/span>/)
  assert.match(headline, /<b>0<\/b><span>件在等别人<\/span>/)
})

test('page ships no external resource', () => {
  for (const page of [pageOf(fixture), pageOf(deadCalendar())]) {
    for (const needle of ['http://', 'https://', '<link rel=', '<script src=', '@import', 'url(http', "fetch('http", 'fetch("http']) {
      assert.equal(page.includes(needle), false, `page must not carry ${needle}`)
    }
  }
})

test('the day key is the local date, not the UTC date', () => {
  assert.equal(dayKey('2026-10-30T23:30:00Z', 'UTC'), '2026-10-30')
  assert.equal(dayKey('2026-10-30T23:30:00Z', 'Asia/Shanghai'), '2026-10-31')
  assert.equal(dayKey('2026-10-31T00:30:00+08:00', 'Asia/Shanghai'), '2026-10-31')
  assert.equal(dayKey('2026-10-31T00:30:00+08:00', 'UTC'), '2026-10-30')
})

test('the runtime keys its day on the configured zone', async () => {
  const rt = createRuntime({}, {
    home: await mkdtemp(join(tmpdir(), 'odm-panel-')),
    timeZone: 'Asia/Shanghai',
    now: () => new Date('2026-10-30T23:30:00Z'),
  })
  await rt.load()
  assert.equal(rt.today(), '2026-10-31')
})

test('a null calendar still renders a page', async () => {
  const rt = createRuntime({}, {
    home: await mkdtemp(join(tmpdir(), 'odm-panel-')),
    now: () => new Date('2026-10-30T08:45:00+08:00'),
    calendar: async () => null,
  })
  await rt.load()
  await rt.store.save(fixture)
  const result = await rt.tick()
  assert.deepEqual(result.plan, [])
  const stored = rt.store.get()
  assert.equal(snapshotOf(rt).sources.calendar.connected, false)
  assert.match(snapshotOf(rt).sources.calendar.detail, /日历没有返回数据/)
  const page = pageOf(stored, { sources: stored.sources })
  assert.match(section(page, 'headline'), /今天 3 个会/)
  assert.match(page, /飞书日历没连上/)
  assert.match(section(page, 'sources'), /飞书日历、云文档未接入/)
})
