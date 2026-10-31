import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { normalizeState } from '../src/host/store.js'
import {
  READFAIL_STYLE,
  SRCLESS_STYLE,
  badStates,
  bannerText,
  renderBanner,
  renderEmpty,
  renderItemCard,
  renderConclusion,
  renderNumbers,
  sourceHealth,
} from '../src/host/panel-states.js'

const fixture = JSON.parse(await readFile(new URL('./fixtures/panel-five.json', import.meta.url), 'utf8'))
const STATES = ['normal', 'empty', 'srcless', 'partial', 'weekend']

const eventById = (id) => fixture.base_events.find(event => event.id === id)

function dayOf(name) {
  const scenario = fixture.scenarios[name]
  if (scenario === undefined) throw new Error(`no scenario ${name}`)
  return {
    date: scenario.date,
    tz: fixture.timezone,
    events: scenario.event_ids.map(eventById),
    prefs: scenario.prefs ?? {},
    has_baseline: scenario.has_baseline !== false,
    next_first: scenario.next_first,
  }
}

function healthOf(name) {
  return sourceHealth(fixture.scenarios[name].sources)
}

test('the five states come from one fixture and one base event set', () => {
  assert.equal(fixture.base_events.length, 8)
  assert.equal(new Set(fixture.base_events.map(event => event.id)).size, 8)

  assert.deepEqual([...Object.keys(fixture.scenarios)].sort(), [...STATES].sort())
  const baseIds = fixture.base_events.map(event => event.id)
  for (const name of STATES) {
    const scenario = fixture.scenarios[name]
    assert.ok(Array.isArray(scenario.event_ids), `${name} lists event ids`)
    for (const id of scenario.event_ids) {
      assert.ok(baseIds.includes(id), `${name} takes ${id} from base_events`)
    }
  }

  // The base set has to cover the four shapes the panel must draw.
  assert.ok(fixture.base_events.some(event => event.state === 'open'))
  assert.ok(fixture.base_events.some(event => event.state === 'waiting_other'))
  assert.ok(fixture.base_events.some(event => event.state === 'closed'))
  assert.ok(fixture.base_events.some(event => event.moved_from?.at === '11:00'))
  assert.ok(fixture.brevity?.after_day, 'a brevity comparison day')
})

test("an empty day says nothing is due today and names tomorrow's first item", () => {
  const day = dayOf('empty')
  const states = badStates(day, healthOf('empty'))
  assert.equal(states.kind, 'empty')

  const html = renderEmpty(states.kind, { next_first: day.next_first })
  assert.match(html, /今天没有必须今天的事/)
  assert.ok(html.includes(day.next_first.title))
  assert.equal((html.match(/data-numbers/g) ?? []).length, 0)
})

test('a day that exists but has nothing closed still shows zero', () => {
  const day = dayOf('normal')
  const states = badStates(day, healthOf('normal'))
  assert.equal(states.kind, 'normal', 'the day itself exists')
  assert.equal(states.stats.closed, 0, 'nothing was closed, and that is a number')

  const conclusion = renderConclusion(states.stats)
  assert.match(conclusion, /关掉 0 件/)
  assert.doesNotMatch(conclusion, /未知/)

  const html = renderNumbers(states.stats)
  assert.doesNotMatch(html, /未知/)
  assert.equal((html.match(/data-number=/g) ?? []).length, 3)
})

test('a weekend day says the weekend is not disturbed and a first day says there is no baseline', () => {
  const weekend = fixture.scenarios.weekend
  const weekendStates = badStates(dayOf('weekend'), healthOf('weekend'))
  assert.equal(weekendStates.kind, 'weekend')
  const weekendHtml = renderEmpty('weekend', { next_first: weekend.next_first })
  assert.match(weekendHtml, /周末/)
  assert.doesNotMatch(weekendHtml, /今天没有必须今天的事/)
  assert.ok(weekendHtml.includes(weekend.next_first.title))

  const firstDay = {
    date: '2026-10-29',
    tz: fixture.timezone,
    events: [],
    has_baseline: false,
    next_first: weekend.next_first,
  }
  assert.equal(badStates(firstDay, {}).kind, 'first_day')
  const firstHtml = renderEmpty('first_day', { next_first: firstDay.next_first })
  assert.match(firstHtml, /还没有基线/)
  assert.ok(firstHtml.includes(firstDay.next_first.title))
})

test('a planned item with only a timed-out source puts "1 项未取到" on the first screen', () => {
  const day = dayOf('partial')
  const health = healthOf('partial')
  const states = badStates(day, health)
  assert.equal(states.lost, 1)
  assert.equal(bannerText(states), '1 项未取到')
  assert.match(renderBanner(states), /1 项未取到/)

  const cards = day.events.map(event => renderItemCard(event, health))
  assert.equal(cards.length, 3, 'the other two items are still on the page')
  for (const event of day.events) {
    assert.ok(renderItemCard(event, health).includes(event.title), `${event.title} keeps its title`)
  }
})

test('a card with one dead source gets a dashed amber edge and names what is missing', () => {
  assert.match(SRCLESS_STYLE, /border:1px dashed/)
  assert.ok(SRCLESS_STYLE.includes('#c8862a'))

  const health = healthOf('srcless')
  const card = renderItemCard(eventById('evt_moved_meeting'), health)
  assert.match(card, /srcless/)
  assert.ok(card.includes(SRCLESS_STYLE))
  assert.match(card, /飞书日历没连上，这条只有邮件依据/)

  for (const id of ['evt_report_doc', 'evt_waiting_review']) {
    assert.doesNotMatch(renderItemCard(eventById(id), health), /srcless/)
  }
})

test('a connected source that failed to read is red, not amber', () => {
  assert.ok(READFAIL_STYLE.includes('#c0392b'))
  assert.doesNotMatch(READFAIL_STYLE, /dashed/)

  const health = healthOf('partial')
  const card = renderItemCard(eventById('evt_waiting_review'), health)
  assert.match(card, /readfail/)
  assert.ok(card.includes(READFAIL_STYLE))
})

test('a card with no live source says it cannot answer and names what is missing', () => {
  const health = healthOf('partial')
  const card = renderItemCard(eventById('evt_waiting_review'), health)
  assert.match(card, /这条我答不了，缺的是/)
  assert.ok(card.includes('飞书消息'))
})

test('no card carries more than one action', () => {
  let actions = 0
  for (const name of STATES) {
    const day = dayOf(name)
    const health = healthOf(name)
    for (const event of day.events) {
      const count = (renderItemCard(event, health).match(/data-act=/g) ?? []).length
      assert.ok(count <= 1, `${name}/${event.id} carries ${count} actions`)
      actions += count
    }
  }
  assert.ok(actions >= 1, 'the fixture draws at least one single action')
})

test('normalizeState keeps days, sources and prefs', () => {
  const kept = normalizeState({
    revision: 3,
    days: { '2026-10-30': { events: ['evt_report_doc'] } },
    sources: { gmail: { connected: true } },
    prefs: { brevity: { level: 'short', since_day: '2026-10-30' } },
  })
  assert.equal(kept.revision, 3)
  assert.deepEqual(kept.days['2026-10-30'], { events: ['evt_report_doc'] })
  assert.equal(kept.sources.gmail.connected, true)
  assert.equal(kept.prefs.brevity.since_day, '2026-10-30')

  const fresh = normalizeState({})
  assert.deepEqual(fresh.days, {})
  assert.deepEqual(fresh.sources, {})
  assert.deepEqual(fresh.prefs, {})
})
