// Phase C: time-aware 今天 (after hours, greeting, 今天搞定了什么), user drag order, merged-card timeline, client motion hooks.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { isAfterHours, isWorkish, doneToday, greetingLine, shHour } from '../src/web/day-pulse.js'
import { validateUiOp, applyUiOp, cardKey } from '../src/ui/ops.js'
import { hydrateFace, autoFace } from '../src/ui/face.js'

const WED = Date.parse('2026-11-04T02:00:00Z') // Wed 10:00 Shanghai
const SAT = Date.parse('2026-11-07T02:00:00Z')

test('after hours: before 07, from 19, weekends (Shanghai); hour override', () => {
  assert.equal(shHour(WED), 10)
  assert.equal(isAfterHours({ now: WED }), false)
  assert.equal(isAfterHours({ now: WED, hour: 20 }), true)
  assert.equal(isAfterHours({ now: WED, hour: 6 }), true)
  assert.equal(isAfterHours({ now: SAT }), true)
  assert.equal(isWorkish({ type: 'project-cluster', source: 'github' }), true)
  assert.equal(isWorkish({ type: 'email-group', source: 'gmail', metadata: { group: 'code' } }), true)
  assert.equal(isWorkish({ type: 'email-action', source: 'gmail' }), false)
  assert.equal(isWorkish({ type: 'timetable', source: 'system' }), false)
})

test('doneToday: only real completions of today; system marks, undone actions and item duplicates excluded', () => {
  const at = '2026-11-04T03:00:00Z', y = '2026-11-03T03:00:00Z'
  const d = doneToday({
    now: WED + 4 * 3600e3,
    completions: [
      { cardId: 'c1', title: '合同确认', action: 'done', at, url: 'https://mail.google.com/x' },
      { cardId: 'c2', title: '昨天的', action: 'done', at: y },
      { cardId: 'c3', title: '不要了', action: 'dismissed', at },
      { kind: 'item', cardId: 'c4', title: 'item dup', action: 'done', at },
    ],
    itemStatus: {
      'https://github.com/a/b/pull/1': { status: 'done', at, by: 'user', title: '审完 #1' },
      'https://github.com/a/b/pull/2': { status: 'done', at, by: 'system' },
    },
    pendingActions: {
      a1: { status: 'executed', executedAt: at, summary: '归档 12 封促销' },
      a2: { status: 'executed', executedAt: at, undoneAt: at, summary: 'undone' },
      a3: { status: 'pending', createdAt: at, summary: 'pending' },
    },
  })
  assert.equal(d.count, 3); assert.equal(d.cards, 1); assert.equal(d.items, 1); assert.equal(d.actions, 1)
  assert.deepEqual(d.highlights.map(h => h.text), ['归档 12 封促销', '合同确认', '审完 #1'])
  assert.deepEqual(d.cardIds, ['c1'])
  assert.equal(doneToday({ now: WED }), null)
})

test('greeting line is built from live counts and stays honest when empty', () => {
  const cards = [{ type: 'project-cluster', source: 'github', waiting: 'you', status: 'active' }, { type: 'email-action', source: 'gmail' }]
  assert.equal(greetingLine({ hour: 9, cards, next: { kind: 'card', title: '审 PR #12' }, lang: 'zh' }), '早安。今天 2 件在手，1 件有人在等你——先从「审 PR #12」开始吧。')
  assert.match(greetingLine({ hour: 15, cards, done: { count: 4 }, lang: 'zh' }), /已经搞定 4 件/)
  assert.match(greetingLine({ hour: 21, cards: [], done: { count: 2 }, lang: 'zh' }), /今天搞定了 2 件.*收工/)
  assert.match(greetingLine({ hour: 9, cards: [], lang: 'zh' }), /没有待办/)
  assert.doesNotMatch(greetingLine({ hour: 9, cards: [], lang: 'zh' }), /\d/)
})

test('a user drag order is kept by stable key and a bot reorder cannot override it', () => {
  const state = { cards: [
    { id: 'a', type: 'x', source: 'github', sourceId: 'github:cluster:a:2026-11-04', title: 'A', status: 'active' },
    { id: 'b', type: 'x', source: 'github', sourceId: 'github:cluster:b:2026-11-04', title: 'B', status: 'active' },
  ], itemStatus: {}, ui: { layout: { pins: [], order: null }, filter: null, highlights: [] }, uiLog: [] }
  const apply = (input, by) => { const v = validateUiOp(input, state, { now: WED }); assert.ok(v.ok, v.error); const r = applyUiOp(state, v.op, { by, now: WED }); state.ui = r.ui; state.uiLog = r.log; return r }
  apply({ op: 'arrange', order: ['b', 'a'], reason: '你拖动调整了顺序' }, 'user')
  assert.deepEqual(state.ui.layout.order.keys, [cardKey(state.cards[1]), cardKey(state.cards[0])])
  assert.ok(!state.ui.layout.order.keys[0].includes('2026'), 'stable key, survives tomorrow')
  const r = apply({ op: 'arrange', order: ['a', 'b'], reason: '豆芽觉得 A 更急' }, 'bot')
  assert.equal(state.ui.layout.order.by, 'user'); assert.ok(r.skipped.length); assert.doesNotMatch(r.message, /调整了/)
})

test('cross-source merged card: timeline face across channels, one row per item, labelled', () => {
  const card = { id: 'm', type: 'project-cluster', source: 'github', metadata: { mergedFrom: ['gmail'] }, blocks: [{ type: 'link-list', links: [
    { title: 'PR #7', url: 'https://github.com/a/b/pull/7', at: '2026-11-04T01:00:00Z' },
    { title: 'Review requested', url: 'https://mail.google.com/mail/u/0/#inbox/x', type: 'email', mergedFrom: 'gmail', at: '2026-11-04T01:05:00Z' },
  ] }] }
  const spec = autoFace(card); assert.equal(spec.layout, 'timeline')
  const v = hydrateFace(card, spec, { now: WED })
  const tl = v.parts.find(p => p.type === 'timeline')
  assert.deepEqual(tl.items.map(i => i.kind), ['pr', 'email']); assert.deepEqual(tl.items.map(i => i.time), ['09:00', '09:05'])
  assert.equal(v.note, '同一件事 · GitHub + 邮件')
})

test('client: Phase C motion is textContent/escaped, reduced-motion aware, and uses the user arrange op', () => {
  const html = readFileSync(new URL('../src/client/index.html', import.meta.url), 'utf8')
  const c = html.slice(html.indexOf('Live & motion (Phase C)'), html.indexOf('Focus & actions (Phase A)'))
  assert.ok(c.length > 1000)
  assert.doesNotMatch(c, /innerHTML|insertAdjacentHTML/)
  assert.match(c, /op: 'arrange', order: ids/)
  assert.match(c, /reducedMotion\(\)/)
  assert.match(html, /prefers-reduced-motion:reduce\)[\s\S]*?\.tile\.work\.leaving-done/)
  assert.match(html, /if \(!opts\.force && sig === lastTodaySig\) return/)
})

test('motion polish: soft ease tokens, zoom close reverse, sheet easing, now-line pulse', () => {
  const html = readFileSync(new URL('../src/client/index.html', import.meta.url), 'utf8')
  assert.match(html, /--ease-sheet:cubic-bezier/)
  assert.match(html, /--dur-sheet:420ms/)
  assert.match(html, /@keyframes zoomToTile/)
  assert.match(html, /@keyframes nowPulse/)
  assert.match(html, /cardAppearStagger/)
  assert.match(html, /modal\.classList\.add\('zoom-out'\)/)
  assert.match(html, /prefers-reduced-motion:reduce/)
})
