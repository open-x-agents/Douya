// 豆芽 Intelligent UI P1: view ops are validated against the store, persisted with undo, user pins win,
// and the 当前视图 text uses store titles only.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  validateUiOp, applyUiOp, uiView, viewSnapshotText, sanitizeViewContext, uiStateFull, cardKey, needsYou, shDay, UI_OPS,
} from '../src/ui/ops.js'
import { createUiService } from '../src/ui/service.js'
import { normalizeState } from '../src/host/store.js'

const DAY = '2026-11-04'
const NOW = Date.parse(`${DAY}T02:00:00Z`) // 10:00 Asia/Shanghai
const ll = (...urls) => ({ type: 'link-list', links: urls.map((u, i) => ({ title: `item ${i}`, url: u })) })
function fixture() {
  return {
    cards: [
      { id: 'hero', type: 'hero', source: 'system', sourceId: `hero:${DAY}`, title: '11月4日', status: 'active' },
      { id: 'fly', type: 'project-cluster', source: 'github', sourceId: `github:cluster:ThinkFlowLab/FlyBot:${DAY}`, title: 'FlyBot gate and panel fixes', priority: 'high', status: 'active',
        blocks: [{ type: 'tags', tags: [{ text: '2 件等别人' }] }, ll('https://github.com/ThinkFlowLab/FlyBot/pull/2320', 'https://github.com/ThinkFlowLab/FlyBot/pull/2318')] },
      { id: 'fledge', type: 'email-action', source: 'gmail', sourceId: 'gmail:action:gmail:abc', title: '[Fledge] 团队需要你回答：Birfy/jitagent', priority: 'high', waiting: 'you', status: 'active',
        blocks: [ll('https://mail.google.com/mail/u/0/#inbox/abc')] },
      { id: 'promo', type: 'email-group', source: 'gmail', sourceId: `gmail:group:promo:${DAY}`, title: '促销与订阅', priority: 'low', waiting: 'fyi', status: 'active', blocks: [ll('https://mail.google.com/mail/u/0/#inbox/p1')] },
      { id: 'slack', type: 'slack-cluster', source: 'slack', sourceId: `slack:cluster:C1:${DAY}`, title: '#competitor-products', priority: 'low', waiting: 'fyi', status: 'active' },
      { id: 'old', type: 'project-cluster', source: 'github', sourceId: 'github:cluster:x/y:2026-11-03', title: 'old', status: 'merged' },
    ],
    itemStatus: {},
    ui: { layout: { pins: [], order: null }, filter: null, highlights: [] },
    uiLog: [],
  }
}
const run = (state, input, by = 'bot', now = NOW) => {
  const v = validateUiOp(input, state, { now })
  assert.equal(v.ok, true, v.error)
  const r = applyUiOp(state, v.op, { by, now })
  return { ...r, state: { ...state, ui: r.ui, uiLog: r.log } }
}

test('ops only reference real, active cards and their own items', () => {
  const s = fixture()
  assert.equal(validateUiOp({ op: 'openCard', card: 'fly' }, s).ok, true)
  const miss = validateUiOp({ op: 'openCard', card: 'FlyBot' }, s)
  assert.equal(miss.ok, false)
  assert.deepEqual(miss.candidates.map(c => c.id), ['fly'], 'a name instead of an id gets candidates to self-correct')
  assert.match(validateUiOp({ op: 'openCard', card: 'old' }, s).error, /merged|不在今天页/)
  assert.equal(validateUiOp({ op: 'highlight', card: 'fly', item: 'https://github.com/ThinkFlowLab/FlyBot/pull/2320' }, s).ok, true)
  const badItem = validateUiOp({ op: 'highlight', card: 'fly', item: 'https://evil.example/x' }, s)
  assert.equal(badItem.ok, false)
  assert.equal(badItem.items.length, 2)
  assert.equal(validateUiOp({ op: 'deleteEverything' }, s).ok, false)
  assert.equal(validateUiOp({ op: 'navigate', page: 'sources' }, s).op.page, 'sources')
  assert.equal(validateUiOp({ op: 'navigate', page: '信源状态' }, s).op.page, 'sources')
  assert.equal(validateUiOp({ op: 'navigate', page: 'http://x' }, s).ok, false)
  assert.equal(validateUiOp({ op: 'filter', sources: 'jira' }, s).ok, false)
  assert.equal(validateUiOp({ op: 'filter' }, s).ok, false)
  assert.match(validateUiOp({ op: 'arrange', pin: 'fledge' }, s).error, /reason/)
})

test('no op can confirm, send or execute anything', () => {
  for (const op of UI_OPS) assert.doesNotMatch(op, /confirm|send|execute|reply|merge|comment|action/i)
  const tools = readFileSync(new URL('../src/web/dsbot-tools.js', import.meta.url), 'utf8')
  const uiTool = tools.slice(tools.indexOf("name: 'odm_ui_op'"), tools.indexOf("name: 'odm_ui_state'"))
  assert.doesNotMatch(uiTool, /requestAction|actionsOp|confirm\(/)
  const client = readFileSync(new URL('../src/client/index.html', import.meta.url), 'utf8')
  const block = client.slice(client.indexOf('Intelligent UI (P1)'), client.indexOf('// Tile zoom modal functions'))
  assert.doesNotMatch(block, /innerHTML|确认执行|insertAdjacentHTML/, 'bot-driven UI uses textContent only and never shows a confirm button')
})

test('needs-you filter: matches the tile pill, persists for the day, undo restores', () => {
  let s = fixture()
  assert.equal(needsYou(s.cards[2]), true)
  assert.equal(needsYou(s.cards[1]), false)
  const r = run(s, { op: 'filter', needsYou: true })
  assert.match(r.message, /只显示「需要你处理」的 1 张卡/)
  assert.ok(r.entry.undo)
  s = r.state
  const v = uiView(s, { now: NOW })
  assert.deepEqual(v.filter.matchIds, ['fledge'])
  assert.equal(v.filter.total, 4)
  assert.equal(v.lastUndo.id, r.entry.id)
  assert.equal(uiView(s, { now: NOW + 86400e3 }).filter, null, 'a filter lasts for the day it was set')
  const u = run(s, { op: 'undo', id: r.entry.id }, 'user')
  assert.match(viewSnapshotText(sanitizeViewContext({ route: 'today' }), u.state, { now: NOW }), /刚刚撤销了：豆芽按你的要求只显示「需要你处理」的 1 张卡（已不再生效）/)
  assert.equal(uiView(u.state, { now: NOW }).filter, null)
  assert.equal(u.state.uiLog.find(e => e.id === r.entry.id).undone, true)
  assert.equal(validateUiOp({ op: 'undo', id: r.entry.id }, u.state).ok, false, 'cannot undo twice')
  const srcOnly = run(fixture(), { op: 'filter', sources: '邮件' })
  assert.deepEqual(uiView(srcOnly.state, { now: NOW }).filter.matchIds.sort(), ['fledge', 'promo'])
})

test('pins: bot pins need a reason, the user\'s pins always win, undo restores', () => {
  let s = fixture()
  const user = run(s, { op: 'arrange', pin: 'slack', reason: '你手动固定' }, 'user'); s = user.state
  const bot = run(s, { op: 'arrange', pin: 'fledge', reason: 'Fledge 在等你回答' }); s = bot.state
  assert.match(bot.message, /把「\[Fledge\] 团队需要你回答：Birfy\/jitagent」置顶：Fledge 在等你回答/)
  let v = uiView(s, { now: NOW })
  assert.deepEqual(v.pins.map(p => [p.cardId, p.by]), [['slack', 'user'], ['fledge', 'bot']], 'user pin stays above the bot pin')
  const unpin = run(s, { op: 'arrange', unpin: 'slack' })
  assert.equal(unpin.skipped.length, 1)
  assert.equal(unpin.entry.undo, undefined, 'nothing changed → nothing to undo')
  assert.deepEqual(uiView(unpin.state, { now: NOW }).pins.map(p => p.cardId), ['slack', 'fledge'])
  const undo = run(s, { op: 'undo', id: bot.entry.id }, 'user')
  assert.deepEqual(uiView(undo.state, { now: NOW }).pins.map(p => p.cardId), ['slack'])
})

test('a pin follows the card to the next day\'s digest (stable key, not the day-scoped id)', () => {
  let s = fixture()
  s = run(s, { op: 'arrange', pin: 'fly', reason: '要发版' }).state
  assert.equal(s.ui.layout.pins[0].key, 'github:cluster:ThinkFlowLab/FlyBot')
  s.cards = s.cards.map(c => (c.id === 'fly' ? { ...c, status: 'merged' } : c))
  s.cards.push({ id: 'fly2', type: 'project-cluster', source: 'github', sourceId: 'github:cluster:ThinkFlowLab/FlyBot:2026-11-05', title: 'FlyBot', status: 'active' })
  assert.deepEqual(uiView(s, { now: NOW }).pins.map(p => p.cardId), ['fly2'])
  assert.equal(cardKey({ id: 'x' }), 'x')
})

test('highlight expires; transient ops do not touch the layout', () => {
  let s = fixture()
  const h = run(s, { op: 'highlight', card: 'fly', item: 'https://github.com/ThinkFlowLab/FlyBot/pull/2320', reason: '先审这个', ttl: '5m' })
  s = h.state
  assert.equal(uiView(s, { now: NOW + 60e3 }).highlights[0].cardId, 'fly')
  assert.equal(uiView(s, { now: NOW + 6 * 60e3 }).highlights.length, 0)
  const o = run(s, { op: 'openCard', card: 'fly' })
  assert.match(o.message, /豆芽按你的要求打开了「FlyBot gate and panel fixes」/)
  assert.equal(o.entry.undo, undefined)
  assert.deepEqual(o.ui.layout, s.ui.layout)
})

test('当前视图: compact, titles from the store, unknown ids from the client ignored', () => {
  let s = run(fixture(), { op: 'filter', needsYou: true }).state
  const view = sanitizeViewContext({ route: 'today', zoom: { cardId: 'fly', selectedItem: 'https://github.com/ThinkFlowLab/FlyBot/pull/2320' }, visibleCards: ['fledge', 'ghost<script>', 'promo'], scrollFocus: 'fledge', extra: 'x' })
  assert.equal(view.extra, undefined)
  const t = viewSnapshotText(view, s, { now: NOW })
  assert.match(t, /^【当前视图】今天页 · 已筛选：需要你处理（显示 1\/4 张） · 没有置顶/)
  assert.match(t, /放大中：FlyBot gate and panel fixes（fly） · 选中条目：https:\/\/github.com\/ThinkFlowLab\/FlyBot\/pull\/2320/)
  assert.match(t, /屏幕上可见（从上到下）：\[Fledge\]/)
  assert.doesNotMatch(t, /ghost|script/)
  assert.match(t, /可撤销的最近一次布局改动：豆芽按你的要求只显示/)
  assert.doesNotMatch(t, /id=ui_/, 'internal ids stay out of the view block')
  assert.ok(t.length <= 800)
  const big = sanitizeViewContext({ route: 'today', visibleCards: Array.from({ length: 40 }, () => 'fledge') })
  assert.ok(viewSnapshotText(big, s, { now: NOW, maxChars: 300 }).length <= 300)
  assert.equal(sanitizeViewContext({ route: 'evil' }).route, 'today')
  const full = uiStateFull(view, s, { now: NOW })
  assert.equal(full.cards.find(c => c.id === 'promo').hiddenByFilter, true)
  assert.equal(full.cards.find(c => c.id === 'fledge').needsYou, true)
  assert.equal(full.filter.showing, 1)
})

test('store keeps ui + uiLog through normalize (older state files get defaults)', () => {
  const a = normalizeState({ cards: [] })
  assert.deepEqual(a.ui.layout.pins, [])
  assert.deepEqual(a.uiLog, [])
  const b = normalizeState({ cards: [], ui: { layout: { pins: [{ key: 'k', by: 'user' }] } }, uiLog: Array.from({ length: 250 }, (_, i) => ({ id: i })) })
  assert.equal(b.ui.layout.pins.length, 1)
  assert.equal(b.uiLog.length, 200)
})

test('service: op persists, wakes a waiting tab, and a restart makes tabs resync', async () => {
  const state = fixture()
  let saves = 0
  const store = { get: () => state, save: async (n) => { saves++; Object.assign(state, n); return state } }
  let t = NOW
  const svc = createUiService({ store, now: () => t })
  const waiting = svc.poll({ since: 0, waitMs: 5000 })
  const r = await svc.op({ op: 'filter', needsYou: true })
  assert.equal(r.success, true)
  assert.ok(r.undoId)
  const got = await waiting
  assert.equal(got.events.length, 1)
  assert.equal(got.events[0].op.op, 'filter')
  assert.deepEqual(got.events[0].ui.filter.matchIds, ['fledge'])
  assert.equal(typeof got.events[0].message, 'string')
  assert.equal(saves, 1)
  assert.equal(state.uiLog.length, 1)
  const bad = await svc.op({ op: 'openCard', card: 'nope' })
  assert.equal(bad.success, false)
  assert.equal(saves, 1, 'rejected ops change nothing')
  const nothing = await svc.poll({ since: got.seq, waitMs: 10 })
  assert.equal(nothing.events.length, 0)
  const stale = await svc.poll({ since: 99, boot: 'old-boot', waitMs: 10 })
  assert.equal(stale.resync, true)
  svc.setView({ route: 'today', visibleCards: ['fledge'] })
  assert.match(svc.viewText(), /【当前视图】今天页/)
  assert.equal(svc.state().visibleCards[0], 'fledge')
})

test('router + dsh routes: ui routes registered, /api/today carries the layout, chat sends 当前视图', async () => {
  const src = readFileSync(new URL('../src/web/dsh-host-routes.js', import.meta.url), 'utf8')
  for (const p of ['/api/opendigitalmate/ui-events', '/api/opendigitalmate/ui-op', '/api/opendigitalmate/ui-context']) assert.ok(src.includes(`'${p}'`), p)
  assert.match(src, /router\.uiOp\(await readJson\(request\), \{ by: 'user' \}\)/, 'the browser route is always by=user')
  assert.match(src, /viewContext,\n/)
  const { createApiRouter } = await import('../src/web/api.js')
  const { createConfigStore } = await import('../src/web/config-store.js')
  const home = mkdtempSync(join(tmpdir(), 'odm-ui-'))
  writeFileSync(join(home, 'config.json'), '{}')
  const configStore = createConfigStore(join(home, 'config.json')); await configStore.load()
  const state = fixture()
  const store = { get: () => state, save: async s => Object.assign(state, s), load: async () => state }
  const router = createApiRouter({ store, config: { home, dataDir: home }, configStore })
  const r = await router.uiOp({ op: 'arrange', pin: 'fledge', reason: '你手动固定' }, { by: 'user' })
  assert.equal(r.success, true)
  const today = await router.getToday()
  assert.deepEqual(today.ui.pins.map(p => [p.cardId, p.by]), [['fledge', 'user']])
  assert.ok(today.ui.bootId)
  assert.match(router.viewSnapshot({ route: 'today', visibleCards: ['fledge'] }), /置顶：\[Fledge\].*\[用户固定\]/)
  assert.equal(router.uiState().pins[0].cardId, 'fledge')
})
