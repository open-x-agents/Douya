// 豆芽 Intelligent UI P3 (live feed: streamed text, progress, skeletons) and P4 (time-of-day order on 今天).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { periodOf, dayStartHour, affinityOf, computeAutoLayout, scoreCards, baselineOrder } from '../src/ui/layout.js'
import { createUiService } from '../src/ui/service.js'
import { installUiFeed, streamEvent, sessionEvent, createTurnWatch } from '../src/web/ui-feed.js'
import { runMuseChatTurn } from '../src/web/muse-chat-core.js'
import { dockKey } from '../src/web/api.js'

const at = (hourSh, day = '2026-11-04') => Date.parse(`${day}T${String(hourSh).padStart(2, '0')}:30:00+08:00`)
const DAY = '2026-11-04'
const cards = () => ([
  { id: 'promo', type: 'email-group', source: 'gmail', waiting: 'fyi', priority: 'low', status: 'active', sourceId: `gmail:group:promo:${DAY}`, updatedAt: `${DAY}T00:00:00Z` },
  { id: 'fly', type: 'project-cluster', source: 'github', priority: 'high', status: 'active', sourceId: `github:cluster:ThinkFlowLab/FlyBot:${DAY}`, updatedAt: `${DAY}T00:00:00Z`,
    blocks: [{ type: 'stat-row', stats: [{ label: '待你审', value: 2 }] }, { type: 'link-list', links: [{ title: 'PR', url: 'https://github.com/ThinkFlowLab/FlyBot/pull/1' }] }] },
  { id: 'fledge', type: 'email-action', source: 'gmail', waiting: 'you', priority: 'medium', status: 'active', sourceId: 'gmail:action:x', updatedAt: `${DAY}T00:00:00Z`,
    blocks: [{ type: 'link-list', links: [{ title: 'Fledge', url: 'https://mail.google.com/mail/u/0/#inbox/a' }] }] },
  { id: 'slack', type: 'slack-cluster', source: 'slack', waiting: 'you', priority: 'medium', status: 'active', sourceId: `slack:cluster:x:${DAY}`, updatedAt: `${DAY}T00:00:00Z` },
  { id: 'ad', type: 'project-cluster', source: 'github', priority: 'medium', status: 'active', sourceId: `github:cluster:Birfy/agentdescent:${DAY}`, updatedAt: `${DAY}T00:00:00Z`,
    blocks: [{ type: 'link-list', links: [{ title: 'issue', url: 'https://github.com/Birfy/agentdescent/issues/384' }] }] },
  { id: 'hero', type: 'hero', source: 'system', status: 'active' },
])
const profile = (n = 46) => ({ preferences: { activeHours: { 9: 2, 16: 4, 22: 8 }, cardInteractions: { opened: { 'github:cluster:Birfy/agentdescent:2026-11-03': 15, 'gmail:group:promo:2026-11-03': 1 }, completed: {}, dismissed: { 'slack:cluster:x:2026-11-02': 3 } } }, stats: { totalInteractions: n } })

test('periods follow the day start from activeHours; defaults when there is no record', () => {
  assert.equal(dayStartHour({}), 7)
  assert.equal(dayStartHour({ 9: 2, 16: 4, 22: 8 }), 9)
  assert.equal(periodOf(8, {}), 'morning'); assert.equal(periodOf(10, {}), 'work'); assert.equal(periodOf(18, {}), 'evening'); assert.equal(periodOf(3, {}), 'evening')
  assert.equal(periodOf(8, { 9: 1 }), 'evening', 'before the user\'s day starts')
  assert.equal(periodOf(11, { 9: 1 }), 'morning'); assert.equal(periodOf(12, { 9: 1 }), 'work')
})

test('morning: mail that needs a reply first; work hours: PR reviews and @mentions first; evening: done today', () => {
  const st = { itemStatus: { 'https://github.com/Birfy/agentdescent/issues/384': { status: 'done', cardId: 'ad', at: `${DAY}T09:00:00Z` } } }
  const m = computeAutoLayout(cards(), { now: at(9), profile: profile(0), itemStatus: st.itemStatus })
  assert.equal(m.period, 'morning'); assert.equal(m.order[0], 'fledge')
  assert.match(m.reasons.fledge, /需要你处理/); assert.match(m.reasons.fledge, /早上先回邮件/)
  assert.ok(!m.order.includes('hero'), 'system tiles are not ordered')
  assert.equal(m.order.at(-1), 'promo')
  const w = computeAutoLayout(cards(), { now: at(14), profile: profile(0), itemStatus: st.itemStatus })
  assert.equal(w.period, 'work'); assert.deepEqual(w.order.slice(0, 2).sort(), ['fly', 'slack'])
  assert.match(w.reasons.slack, /工作时段先回 @你的消息/)
  assert.equal(w.reasons.fly, undefined, 'fly was already first by priority: no line for a card that did not move up')
  const e = computeAutoLayout(cards(), { now: at(20), profile: profile(0), itemStatus: st.itemStatus })
  assert.equal(e.period, 'evening'); assert.match(e.reasons.ad, /今天完成了 1 条/)
  assert.ok(e.order.indexOf('ad') < baselineOrder(cards()).indexOf('ad'))
})

test('affinity only with enough records, and the page says so when there are too few', () => {
  const few = computeAutoLayout(cards(), { now: at(14), profile: profile(5) })
  assert.equal(few.enough, false); assert.match(few.note, /还没有足够的使用记录（5 次）/)
  const many = computeAutoLayout(cards(), { now: at(14), profile: profile(46) })
  assert.equal(many.enough, true); assert.match(many.note, /46 次记录/)
  const a = affinityOf(profile(46))
  assert.ok(a.score.get('github:cluster:Birfy/agentdescent') > 1); assert.ok(a.score.get('slack:cluster:x') < 0)
  const s = new Map(scoreCards(cards(), { now: at(14), period: 'work', affinity: a }).map(x => [x.id, x]))
  assert.equal(s.get('ad').habitWhy, '你常打开'); assert.ok(s.get('slack').habit < 0)
})

test('stable: kept within a period, recomputed on a new period or new cards, off when disabled', () => {
  const first = computeAutoLayout(cards(), { now: at(14), profile: profile() })
  const prev = { key: first.key, order: ['promo', ...first.order.filter(x => x !== 'promo')], reasons: { promo: 'x' }, computedAt: first.computedAt }
  const again = computeAutoLayout(cards(), { now: at(16), profile: profile(), prev })
  assert.equal(again.kept, true); assert.deepEqual(again.order, prev.order, 'positions never jump within a period')
  const fewer = computeAutoLayout(cards().filter(c => c.id !== 'slack'), { now: at(16), profile: profile(), prev })
  assert.equal(fewer.kept, true); assert.ok(!fewer.order.includes('slack'))
  const more = computeAutoLayout([...cards(), { id: 'new', type: 'email-action', source: 'gmail', waiting: 'you', status: 'active' }], { now: at(16), profile: profile(), prev })
  assert.equal(more.kept, false)
  const evening = computeAutoLayout(cards(), { now: at(19), profile: profile(), prev })
  assert.equal(evening.kept, false); assert.notEqual(evening.key, prev.key)
  const hourOverride = computeAutoLayout(cards(), { now: at(9), profile: profile(), hour: 20 })
  assert.equal(hourOverride.period, 'evening')
  const off = computeAutoLayout(cards(), { now: at(14), profile: profile(), enabled: false })
  assert.deepEqual(off.order, []); assert.equal(off.enabled, false)
})

test('page: your pins first, then 豆芽 pins, then Chief order, then the time-of-day order; why-line + undo + off', () => {
  const html = readFileSync(new URL('../src/client/index.html', import.meta.url), 'utf8')
  assert.match(html, /sort\(\(a, b\) => \(b\.by === 'user'\) - \(a\.by === 'user'\)\)/)
  const arrange = html.slice(html.indexOf('function arrangeWork'), html.indexOf('function filterHidden'))
  assert.ok(arrange.indexOf('pinIdx') < arrange.indexOf('ordIdx') && arrange.includes('autoActive()'))
  assert.match(html, /为什么在这里：\$\{why\}/)
  assert.match(html, /恢复原顺序/); assert.match(html, /layout-pref/)
  assert.match(html, /豆芽建议：已到\$\{a\.periodLabel\}/, 'a new period is offered, not applied under the user')
  const p4 = html.slice(html.indexOf('Intelligent UI (P4)'), html.indexOf('// Hold layout changes'))
  assert.doesNotMatch(p4, /innerHTML/)
})

test('ui service: ephemeral pulses reach live listeners only; backlog replays durable events after since', () => {
  let t = 1000
  const ui = createUiService({ store: { get: () => ({}), save: async () => {} }, now: () => t++ })
  const got = []
  ui.pulse({ kind: 'stream', text: 'nobody listening' })
  const off = ui.subscribe(e => got.push(e))
  ui.emit({ kind: 'surface', phase: 'create' })
  ui.pulse({ kind: 'stream', turn: 't_x', text: '你' })
  ui.emit({ kind: 'cards' })
  off(); ui.pulse({ kind: 'stream', text: 'after off' })
  assert.deepEqual(got.map(e => [e.kind, e.seq ?? null, !!e.ephemeral]), [['surface', 1, false], ['stream', null, true], ['cards', 2, false]])
  assert.deepEqual(ui.backlog({ since: 1, boot: ui.bootId }).events.map(e => e.seq), [2])
  const r = ui.backlog({ since: 0, boot: 'old-boot' }); assert.equal(r.resync, true); assert.equal(r.events.length, 0)
})

test('feed mapping: text deltas, tool progress, and a sanitized skeleton the moment odm_ui_render is called', () => {
  assert.deepEqual(streamEvent('t_1', { type: 'chunk', attemptId: 'a', chunk: { type: 'text-delta', text: '好' } }), { kind: 'stream', turn: 't_1', attemptId: 'a', text: '好' })
  assert.equal(streamEvent(null, { type: 'start' }), null)
  assert.equal(streamEvent('t_1', { type: 'chunk', chunk: { type: 'reasoning-delta', text: 'x' } }), null)
  const ev = sessionEvent('t_1', { type: 'tool/call', data: { name: 'odm_ui_render', arguments: { title: '<script>alert(1)</script>需要你处理', placement: 'evil' } } })
  assert.equal(ev[0].label, '正在生成视图…'); assert.equal(ev[1].kind, 'skeleton'); assert.equal(ev[1].placement, 'chat')
  assert.doesNotMatch(ev[1].title, /[<>]/)
  assert.equal(sessionEvent('t_1', { type: 'tool/call', data: { name: 'odm_github_list_prs' } })[0].label, '正在查 GitHub…')
  const w = createTurnWatch(); w.watch('s1', 't_1'); w.watch('s2', 't_1'); assert.equal(w.turnOf('s2'), 't_1'); w.unwatch('t_1'); assert.equal(w.size, 0)
})

test('SSE feed: hello + replay after ?since, live durable + ephemeral events; deltas coalesced per attempt', async () => {
  const handlers = {}; const routes = []
  const ctx = { on: (name, fn) => { handlers[name] = fn } }
  const ui = createUiService({ store: { get: () => ({}), save: async () => {} } })
  ui.emit({ kind: 'cards' }); ui.emit({ kind: 'suggest', message: 'm' })
  const feed = installUiFeed(ctx, { uiService: ui, effect: (r) => routes.push(r) })
  assert.equal(routes[0].path, '/api/opendigitalmate/ui-feed')
  const ac = new AbortController()
  const res = await routes[0].fetch(new Request(`http://x/api/opendigitalmate/ui-feed?since=1&boot=${ui.bootId}`, { signal: ac.signal }))
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8')
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = ''
  const readUntil = async (re) => { while (!re.test(buf)) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value) } return buf }
  await readUntil(/"seq":2/)
  assert.match(buf, /^event: hello\ndata: \{"bootId":"[^"]+","seq":2,"resync":false\}/)
  assert.doesNotMatch(buf, /"seq":1[,}]/, 'events up to since are not replayed')
  feed.turns.watch('sess-chief', 't_abc1')
  handlers['session/event']({ id: 'sess-chief' }, { type: 'tool/call', data: { name: 'odm_ui_render', arguments: { title: '表格' } } })
  handlers['agent/assistant-stream']({ agent: { id: 'sess-chief' }, frame: { type: 'start', attemptId: 'a1' } })
  for (const ch of ['表格', '已经', '好了']) handlers['agent/assistant-stream']({ agent: { id: 'sess-chief' }, frame: { type: 'chunk', attemptId: 'a1', chunk: { type: 'text-delta', text: ch } } })
  handlers['agent/assistant-stream']({ agent: { id: 'other' }, frame: { type: 'chunk', attemptId: 'zz', chunk: { type: 'text-delta', text: 'NOT MINE' } } })
  handlers['agent/assistant-stream']({ agent: { id: 'sess-chief' }, frame: { type: 'end', attemptId: 'a1' } })
  await readUntil(/"phase":"end"/)
  // dsh 0.1.x: the stream arrives as session assistant/chunk events
  for (const ch of ['第二', '步']) handlers['session/event']({ id: 'sess-chief' }, { type: 'assistant/chunk', data: { turn: 4, step: 1, chunk: { type: 'text-delta', index: 0, text: ch } } })
  handlers['session/event']({ id: 'sess-chief' }, { type: 'assistant/chunk', data: { turn: 4, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'HIDDEN' } } })
  await readUntil(/"text":"第二步"/)
  assert.match(buf, /"attemptId":"s4\.1","text":"第二步"/)
  assert.doesNotMatch(buf, /HIDDEN/, 'reasoning is never streamed')
  assert.match(buf, /"kind":"skeleton","turn":"t_abc1","title":"表格"/)
  assert.match(buf, /"text":"表格已经好了"/, 'three deltas coalesced into one event')
  assert.doesNotMatch(buf, /NOT MINE/)
  ui.emit({ kind: 'surface', phase: 'create' })
  await readUntil(/"seq":3/)
  ac.abort(); await reader.cancel().catch(() => {})
  assert.ok(feed.stats.deltas >= 3)
})

test('chat turn tells the feed which Session to stream (and the new part after a handoff)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'odm-dsh-')); mkdirSync(join(home, 'bot'))
  writeFileSync(join(home, 'bot', 'state.json'), JSON.stringify({ mainBotId: 'chief', bots: { chief: { sessionId: 'sess-1' } } }))
  let prompted = false
  const ctx = { sessionController: {
    resolveAgent: async () => ({ agent: { status: 'idle', session: { seq: 3 } } }),
    prompt: async () => { prompted = true },
    page: async () => ({ records: prompted ? [
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] } },
      { type: 'turn/start', time: Date.now() },
      { type: 'assistant/message', data: { message: { role: 'assistant', content: '好的' } } },
      { type: 'turn/end', time: Date.now() },
    ] : [] }),
  } }
  const seen = []
  const r = await runMuseChatTurn(ctx, { message: '你好', dshHome: home, onSession: (sid) => seen.push(sid) })
  assert.equal(r.ok, true); assert.equal(r.text, '好的')
  assert.deepEqual([...new Set(seen)], ['sess-1', 'chief'])
})

test('routes + page wiring: feed installed, turn ids validated, dock views persisted for reload, fallback to long-poll', () => {
  const routes = readFileSync(new URL('../src/web/dsh-host-routes.js', import.meta.url), 'utf8')
  assert.match(routes, /installUiFeed\(ctx/)
  assert.match(routes, /\/\^t_\[\\w-\]\{4,40\}\$\/\.test\(body\.turn\)/)
  assert.match(routes, /feed\.turns\.unwatch\(t\)/) // every turn of a (possibly merged) batch is unwatched when it ends
  assert.match(routes, /recordDockSurfaces\(result\.text/)
  const html = readFileSync(new URL('../src/client/index.html', import.meta.url), 'utf8')
  assert.match(html, /new EventSource\(`\/api\/opendigitalmate\/ui-feed\?\$\{q\}`\)/)
  assert.match(html, /feedState\.fails >= 3\) \{ feedState\.mode = 'poll'/)
  assert.match(html, /\(m\.surfaces \|\| \[\]\)\.forEach\(v => frag\.appendChild\(renderSurface/)
  const p3 = html.slice(html.indexOf('Intelligent UI (P3)'), html.indexOf('Intelligent UI (P4)'))
  assert.doesNotMatch(p3, /innerHTML/, 'streamed text only ever goes through textContent')
  assert.equal(dockKey('  表格已经\n放到   下方 '), '表格已经 放到 下方')
})

test('router: /api/today carries the time-of-day order (frozen, hour override not stored); dock views come back with history', async () => {
  const { createApiRouter } = await import('../src/web/api.js')
  const home = mkdtempSync(join(tmpdir(), 'odm-p4-'))
  const state = { cards: cards(), completions: [], itemStatus: {}, surfaces: {}, prefs: {} }
  const store = { get: () => state, save: async s => Object.assign(state, s), load: async () => state }
  const router = createApiRouter({ store, config: { home, dataDir: home }, composioClient: { getConnectedAccounts: async () => ({ items: [] }) } })
  const a = await router.autoLayout(state.cards, { hour: 9 })
  assert.equal(a.override, true); assert.equal(state.uiAuto, undefined, 'a test hour is never stored')
  const b = await router.autoLayout(state.cards)
  assert.ok(b.order.length >= 5); assert.equal(state.uiAuto.key, b.key)
  const c = await router.autoLayout(state.cards)
  assert.equal(c.kept, true)
  await router.setAutoLayout({ enabled: false })
  assert.equal((await router.autoLayout(state.cards)).enabled, false)
  await router.setAutoLayout({ enabled: true })
  // dock views
  state.surfaces.sf_t1 = { id: 'sf_t1', by: 'bot', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600e3).toISOString(), spec: { title: 't', placement: 'chat', root: 'x', components: { x: { type: 'Text', text: 'hi' } }, dataModel: {} } }
  await router.recordDockSurfaces('表格已经放到\n下方', ['sf_t1', 'bad id'])
  const msgs = router.dockSurfacesFor([{ role: 'user', content: 'q' }, { role: 'assistant', content: '表格已经放到 下方' }, { role: 'assistant', content: 'other' }])
  assert.equal(msgs[1].surfaces?.[0]?.id, 'sf_t1'); assert.equal(msgs[2].surfaces, undefined); assert.equal(msgs[0].surfaces, undefined)
})

test('habit only reorders within the same priority level: an often-opened 促销与订阅 never climbs over work', () => {
  const p = profile(46); p.preferences.cardInteractions.opened['gmail:group:promo:2026-11-03'] = 40; p.preferences.cardInteractions.opened['gmail:group:social:2026-11-03'] = 30
  const list = [...cards(), { id: 'social', type: 'email-group', source: 'gmail', waiting: 'fyi', priority: 'low', status: 'active', sourceId: `gmail:group:social:${DAY}`, updatedAt: `${DAY}T00:00:00Z` },
    { id: 'quiet', type: 'project-cluster', source: 'github', priority: 'medium', status: 'active', sourceId: `github:cluster:o/quiet:${DAY}`, updatedAt: `${DAY}T00:00:00Z` }]
  for (const h of [9, 14, 20]) {
    const r = computeAutoLayout(list, { now: at(h), profile: p })
    const lowest = Math.min(r.order.indexOf('promo'), r.order.indexOf('social'))
    assert.ok(lowest > r.order.indexOf('quiet'), `hour ${h}: low-value groups stay below medium work (${r.order.join(',')})`)
    assert.ok(!/你常打开/.test(r.reasons.promo || ''), 'no habit reason that lifts promo over other levels')
  }
  // inside one level habit still decides: agentdescent (opened 15×) above the other medium GitHub card
  const r = computeAutoLayout(list, { now: at(14), profile: p })
  assert.ok(r.order.indexOf('ad') < r.order.indexOf('quiet'))
})
