// Done-dismiss: all items done → card leaves Today; waiting-only → quiet strip, no CTAs; re-digest keeps done.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { cardClearance, applyClearance, sweepClearedCards, completeClearedCard } from '../src/web/card-clearance.js'
import { prepareCardActions } from '../src/web/card-prep.js'
import { skipClosedNextAction } from '../src/host/store.js'
import { reconcileCards } from '../src/host/reconcile.js'

const links = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({
  url: `https://github.com/a/b/pull/${i + 1}`, title: `PR ${i + 1}`, type: 'pr', ...extra,
}))
const card = (over = {}) => ({
  id: 'c1', type: 'project-cluster', source: 'github', status: 'active', waiting: 'others',
  title: '1 个 PR 待推进', nextAction: '审 FlyBot PR #1',
  blocks: [{ type: 'link-list', links: links(3) }, { type: 'tags', tags: [{ text: 'In Progress', color: 'blue' }] }],
  actions: [{ label: '看 #1', value: 'https://github.com/a/b/pull/1', primary: true }],
  ...over,
})
const allDone = Object.fromEntries(links(3).map(l => [l.url, { status: 'done', at: '2026-11-04T08:00:00Z', by: 'user' }]))

test('clearance: all items done → cleared; open waiting-on-others → waiting; needsYou stays active', () => {
  assert.equal(cardClearance(card(), allDone).kind, 'cleared')
  assert.equal(cardClearance(card({ waiting: 'others' }), {}).kind, 'waiting')
  assert.equal(cardClearance(card({ waiting: 'fyi', type: 'email-group', source: 'gmail' }), {}).kind, 'active', 'fyi mail stays a full card')
  assert.equal(cardClearance(card({ waiting: 'you', blocks: [{ type: 'link-list', links: links(1, { needsYou: true }) }] }), {}).kind, 'active')
  assert.equal(cardClearance({ id: 't', type: 'task', source: 'bot', status: 'active' }, {}).kind, 'empty')
})

test('applyClearance strips 下一步 on cleared and waiting-only cards', () => {
  const c = applyClearance(card(), allDone)
  assert.equal(c.clearance, 'cleared')
  assert.equal(c.nextAction, '')
  assert.deepEqual(c.prepared, [])
  const w = applyClearance(card({ waiting: 'others' }), {})
  assert.equal(w.waitingOnly, true)
  assert.equal(w.waitingCount, 3)
  assert.equal(w.nextAction, '')
  // prepared kept for zoom; the tile hides CTAs via waitingOnly
  assert.equal(w.prepared, undefined)
})

test('prepareCardActions returns [] when every link is already done', () => {
  assert.deepEqual(prepareCardActions(card(), { itemStatus: allDone }), [])
  assert.ok(prepareCardActions(card(), { itemStatus: {} }).length >= 1)
})

test('skipClosedNextAction blanks nextAction when every url is closed', () => {
  const out = skipClosedNextAction(card(), allDone)
  assert.equal(out.nextAction, '')
  assert.deepEqual(out.actions, [])
})

test('sweepClearedCards marks done + records completion; idempotent', () => {
  const state = { cards: [card()], itemStatus: allDone, completions: [] }
  const ids = sweepClearedCards(state, { by: 'system', now: '2026-11-04T09:00:00Z' })
  assert.deepEqual(ids, ['c1'])
  assert.equal(state.cards[0].status, 'done')
  assert.equal(state.cards[0].nextAction, '')
  assert.equal(state.completions.length, 1)
  assert.deepEqual(sweepClearedCards(state), [])
})

test('re-digest keeps a finished card done unless genuinely new urls appear', () => {
  const done = { ...card(), status: 'done', completedAt: '2026-11-04T09:00:00Z', completedBy: 'system', sourceId: 'github:cluster:a/b:2026-11-04' }
  const same = { ...card(), id: 'new', sourceId: 'github:cluster:a/b:2026-11-04', status: 'active' }
  const r1 = reconcileCards([done], [same], { itemStatus: { ...allDone } })
  assert.equal(r1.cards.find(c => c.id === 'c1').status, 'done')
  assert.equal(r1.stats.keptDone, 1)
  const fresh = { ...same, blocks: [{ type: 'link-list', links: [...links(3), { url: 'https://github.com/a/b/pull/99', title: 'PR 99', type: 'pr' }] }] }
  const r2 = reconcileCards([done], [fresh], { itemStatus: { ...allDone } })
  const live = r2.cards.find(c => c.id === 'c1')
  assert.equal(live.status, 'active')
  assert.equal(r2.stats.reopened, 1)
})

test('client: dock stays closed unless byUser; cardDone leave path present', () => {
  const html = readFileSync(new URL('../src/client/index.html', import.meta.url), 'utf8')
  assert.match(html, /chatDockWanted/)
  assert.match(html, /openTodayChat\(\{ byUser: true \}\)/)
  assert.match(html, /dockGesture/)
  assert.match(html, /dockWantedBeforeZoom/)
  assert.match(html, /chatInZoom/)
  assert.match(html, /Typing \/ sending beside a card/)
  assert.match(html, /r\.cardDone/)
  assert.match(html, /renderWaitStrip/)
  assert.match(html, /odm\.chatDock\.open/)
  // programmatic loadToday re-focus must not expand a closed dock
  assert.match(html, /hadFocus && chatDockWanted/)
  assert.match(html, /w-more/) // secondary CTAs collapsed
  assert.match(html, /item\.mark_local|在豆芽里标完成/)
  assert.match(html, /today\.empty_quiet_eyebrow|today\.empty_done_eyebrow|Quiet morning|今天还很清静|今天的事都收好了/)
  assert.match(html, /today\.wait_strip|Waiting on others|等别人回音/)
  // zoom close restores snapshot — never openTodayChat from teardown
  const close = html.slice(html.indexOf('function closeTileZoom'), html.indexOf('function closeTileZoom') + 600)
  assert.match(close, /setChatDockWanted\(dockWantedBeforeZoom\)/)
  assert.doesNotMatch(close, /openTodayChat\s*\(/)
})
