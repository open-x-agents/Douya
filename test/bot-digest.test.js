// Bot digest: source bots per channel -> candidates -> Chief plan -> legacy-shaped cards through the digest merge.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHANNELS, channelOfToolkit, digestRoleForToolkit, BOT_ROUTE } from '../src/digest/channels.js'
import { buildSnapshot } from '../src/digest/snapshot.js'
import { validateCandidates, validatePlan, buildCards, invalidLinks } from '../src/digest/build.js'
import { createBotDigest, createDigestStore, usageOf, SOURCE_TOOLS } from '../src/digest/runner.js'
import { digestMetrics } from '../src/digest/compare.js'
import * as agg from '../src/web/aggregation.js'
import { createStore } from '../src/host/store.js'
import { createApiRouter } from '../src/web/api.js'

const DAY = new Date().toISOString().split('T')[0]
const mail = (id, subject, from, labels = []) => ({ source: 'gmail', type: 'email-unread', sourceId: `gmail:${id}`, title: subject, url: `https://mail.google.com/mail/u/0/#inbox/${id}`, body: `From: ${from}`, createdAt: '2026-11-04T01:00:00.000Z', metadata: { from, snippet: subject, labelIds: labels } })
const pr = (id, repo, title, type = 'pr-review') => ({ source: 'github', type, sourceId: `github:pr:${id}`, title, url: `https://github.com/${repo}/pull/${id}`, body: `#${id} in ${repo}`, metadata: { state: 'open', repository: repo, labels: [] }, timestamp: '2026-11-04T01:00:00.000Z' })
const slackMsg = (ts, ch, text) => ({ source: 'slack', type: 'slack-message', sourceId: `slack:msg:${ch}:${ts}`, title: text, url: `https://x.slack.com/archives/${ch}/p${ts}`, body: text, metadata: { channelId: ch, channelName: 'dev', isDm: false, user: 'Alice', text, ts }, timestamp: '2026-11-04T01:00:00.000Z' })

const gmailItems = () => [
  mail('a1', 'Can you confirm the contract by Friday?', 'Bob <bob@acme.com>', ['IMPORTANT']),
  mail('a2', '50% off everything', 'Shop <deals@shop.com>', ['CATEGORY_PROMOTIONS']),
  mail('a3', 'Weekend sale ends tonight', 'Store <news@store.com>', ['CATEGORY_PROMOTIONS']),
  mail('a4', '[ThinkFlowLab/FlyBot] PR #7 review requested', 'GitHub <notifications@github.com>', ['CATEGORY_UPDATES']),
  mail('a5', 'Already handled', 'Carol <carol@x.com>'),
]

test('channels: one config entry per channel, toolkit lookup', () => {
  assert.deepEqual(Object.keys(CHANNELS), ['gmail', 'github', 'slack'])
  assert.equal(channelOfToolkit('github'), 'github'); assert.equal(channelOfToolkit('googlecalendar'), null)
  for (const c of Object.values(CHANNELS)) assert.ok(c.readTools.length && c.letter && c.guide)
})

test('bot route: source bots vs aux vs ignore', () => {
  assert.equal(BOT_ROUTE.chat, 'chief')
  assert.deepEqual(digestRoleForToolkit('gmail'), { role: 'source-bot', channel: 'gmail' })
  assert.deepEqual(digestRoleForToolkit('googlecalendar'), { role: 'aux-fetch', channel: 'googlecalendar' })
  assert.deepEqual(digestRoleForToolkit('notion'), { role: 'ignore', channel: null })
})


test('snapshot: refs only for real items; completed/dismissed items are skipped', () => {
  const snap = buildSnapshot('gmail', gmailItems(), { 'https://mail.google.com/mail/u/0/#inbox/a5': { status: 'done' } })
  assert.equal(snap.rows.length, 4); assert.equal(snap.skipped, 1)
  assert.ok(snap.rows.every(r => /^m\d+$/.test(r.ref) && !('url' in r)))
  assert.ok(!snap.items.some(i => i.sourceId === 'gmail:a5'))
})

test('candidates: invented refs dropped, unknown category rejected, at most 4 single mail tiles', () => {
  const snap = buildSnapshot('gmail', Array.from({ length: 7 }, (_, i) => mail(`s${i}`, `Question ${i}?`, `P${i} <p${i}@x.com>`)), {})
  const raw = JSON.stringify([
    ...snap.rows.slice(0, 6).map(r => ({ title: r.subject, category: 'single', needsAction: true, items: [r.ref] })),
    { title: 'fake', category: 'promo', items: ['m99', 'https://evil.example/x'] },
    { title: 'bad cat', category: 'whatever', items: [snap.rows[6].ref] },
  ])
  const v = validateCandidates('gmail', raw, snap)
  assert.equal(v.candidates.filter(c => c.category === 'single').length, 4)
  assert.ok(v.droppedRefs.includes('m99') && v.droppedRefs.includes('https://evil.example/x'))
  assert.ok(v.errors.some(e => /whatever/.test(e)))
  assert.equal(validateCandidates('gmail', 'not json', snap).candidates.length, 0)
})

test('build: legacy shapes + sourceIds, bot categories honored, cross-channel merge moves the GitHub mail onto the PR card', () => {
  const gsnap = buildSnapshot('gmail', gmailItems(), {})
  const hsnap = buildSnapshot('github', [pr(7, 'ThinkFlowLab/FlyBot', 'Add digest bots'), pr(8, 'ThinkFlowLab/FlyBot', 'Fix CI', 'pr-mine'), pr(9, 'Birfy/agentdescent', 'Docs', 'pr-mine')], {})
  const ref = (snap, key) => snap.rows.find(r => (r.subject || r.title).includes(key)).ref
  const gm = validateCandidates('gmail', [
    { title: 'Bob 等你确认合同', category: 'single', needsAction: true, priority: 'high', nextStep: '回复 Bob 确认合同', summary: 'Bob 周五前要确认', items: [ref(gsnap, 'contract')] },
    { title: '促销', category: 'promo', needsAction: false, priority: 'low', items: [ref(gsnap, '50%'), ref(gsnap, 'Weekend')] },
    { title: 'FlyBot 通知', category: 'code', needsAction: false, items: [ref(gsnap, 'FlyBot')] },
  ], gsnap).candidates
  const gh = validateCandidates('github', [
    { title: 'FlyBot：先审 #7', category: 'ThinkFlowLab/FlyBot', needsAction: true, priority: 'high', nextStep: '审 #7', summary: '#7 等你 review', items: [ref(hsnap, 'digest'), ref(hsnap, 'Fix CI')] },
    { title: 'agentdescent docs', category: 'Birfy/agentdescent', needsAction: false, priority: 'low', items: [ref(hsnap, 'Docs')] },
  ], hsnap).candidates
  const plan = validatePlan({ headline: '先审 FlyBot #7', narrative: 'x', merges: [{ into: 'github:0', from: ['gmail:2', 'nope:1'], reason: '同一 PR' }], cards: [{ id: 'github:0', priority: 'urgent' }], timeline: [{ start: '14:00', end: '15:00', title: '审 PR', category: 'review' }, { start: '25:00', end: '26:00', title: 'bad' }] }, [...gm, ...gh])
  assert.equal(plan.merges.length, 1); assert.deepEqual(plan.merges[0].from, ['gmail:2']); assert.equal(plan.timeline.length, 1)
  const { cards, stats } = buildCards({ gmail: gsnap, github: hsnap }, { gmail: gm, github: gh }, plan, { today: DAY })
  const by = Object.fromEntries(cards.map(c => [c.sourceId, c]))
  assert.ok(by['gmail:action:gmail:a1'], 'single keeps the legacy sourceId'); assert.equal(by['gmail:action:gmail:a1'].waiting, 'you')
  assert.equal(by[`gmail:group:promo:${DAY}`].metadata.count, 2)
  assert.ok(!by[`gmail:group:code:${DAY}`], 'merged mail leaves the code group (now empty)')
  const fly = by[`github:cluster:ThinkFlowLab/FlyBot:${DAY}`]
  assert.ok(fly, Object.keys(by).join(','))
  assert.equal(fly.priority, 'urgent'); assert.equal(fly.title, 'FlyBot：先审 #7'); assert.equal(fly.nextAction, '审 #7')
  assert.ok(fly.blocks.find(b => b.type === 'link-list').links.some(l => l.url.endsWith('#inbox/a4') && l.mergedFrom === 'gmail'))
  assert.equal(stats.merged, 1)
  const valid = new Set([...gsnap.byUrl.keys(), ...hsnap.byUrl.keys()])
  assert.deepEqual(invalidLinks(cards, valid), [])
  const m = digestMetrics(cards, valid)
  assert.equal(m.invalidLinks, 0); assert.equal(m.dupSourceIds, 0); assert.equal(m.crossChannelMerged, 1); assert.equal(m.singles, 1)
})

test('build: a merge into a mail card from a GitHub card is turned around; a merge with no target card is undone', () => {
  const gsnap = buildSnapshot('gmail', gmailItems(), {})
  const hsnap = buildSnapshot('github', [pr(733, 'Birfy/agentdescent', 'Speed up search')], {})
  const gm = validateCandidates('gmail', [{ title: 'PR #733 review requested', category: 'code', items: [gsnap.rows.find(r => r.subject.includes('FlyBot')).ref] }], gsnap).candidates
  const gh = validateCandidates('github', [{ title: 'agentdescent #733', category: 'Birfy/agentdescent', needsAction: true, items: ['g1'] }], hsnap).candidates
  const plan = validatePlan({ merges: [{ into: 'gmail:0', from: ['github:0'], reason: '同一 PR #733' }] }, [...gm, ...gh])
  assert.deepEqual(plan.merges[0], { into: 'github:0', from: ['gmail:0'], reason: '同一 PR #733' })
  const { cards } = buildCards({ gmail: gsnap, github: hsnap }, { gmail: gm, github: gh }, plan, { today: DAY })
  const ad = cards.find(c => c.sourceId === `github:cluster:Birfy/agentdescent:${DAY}`)
  assert.ok(ad && ad.blocks.find(b => b.type === 'link-list').links.some(l => l.mergedFrom === 'gmail'))
  // target candidate whose items were all invalid -> no card -> merge undone, nothing lost
  const gh2 = [{ ...gh[0], id: 'github:0' }]
  const plan2 = { merges: [{ into: 'github:0', from: ['gmail:0'] }], edits: new Map() }
  const res = buildCards({ gmail: gsnap }, { gmail: validateCandidates('gmail', [{ title: 'x', category: 'code', items: [gsnap.rows.find(r => r.subject.includes('FlyBot')).ref] }], gsnap).candidates, github: gh2 }, plan2, { today: DAY })
  assert.ok(res.cards.find(c => c.sourceId === `gmail:group:code:${DAY}`), 'the mail stays in its group')
  assert.equal(res.stats.undoneMerges, 1)
})

test('usage: sums token usage of the turn from assistant/message records', () => {
  const u = usageOf([{ type: 'assistant/message', time: 1010, data: { usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 50 } } }, { type: 'assistant/message', time: 1, data: { usage: { inputTokens: 999 } } }], 1000)
  assert.deepEqual(u, { input: 100, output: 20, cached: 50, steps: 1 })
})

// A fake dsh: each prompt runs a scripted "bot" that calls the digest tools, then ends the turn.
function fakeDsh(script) {
  const sessions = new Map(); let n = 0
  const ctx = { sessionController: {
    async create() { const id = `sess${++n}`; const recs = []; sessions.set(id, { recs, agent: { status: 'idle', session: { seq: 1 }, ctx: { tools: { allow: null, restrict(o) { this.allow = o.allow } } } } }); return { sessionId: id } },
    async resolveAgent(id) { return sessions.has(id) ? { agent: sessions.get(id).agent } : { error: 'gone' } },
    async prompt({ sessionId, content }) { const s = sessions.get(sessionId); setTimeout(async () => { await script(sessionId, content[0].text); s.recs.push({ type: 'assistant/message', time: Date.now(), data: { usage: { inputTokens: 1000, outputTokens: 100 } } }, { type: 'turn/end', time: Date.now() + 1 }) }, 5) },
    async page({ address }) { return { records: sessions.get(address.sessionId).recs } },
  } }
  return { ctx, sessions }
}

test('runner: empty snapshot skips source bot; zero candidates skip Chief', async () => {
  const home = mkdtempSync(join(tmpdir(), 'odm-bd-skip-'))
  const store = createStore(join(home, 'state.json'))
  let prompts = 0
  const { ctx } = fakeDsh(async () => { prompts++ })
  const runner = createBotDigest({
    ctx, store, home,
    aggregation: {
      ...agg,
      fetchFromSources: async () => ({ gmailItems: [] }),
      normalizeItems: () => [],
      dedupeItems: x => x,
    },
    digestStore: createDigestStore(home),
    client: () => ({ getConnectedAccounts: async () => ({ items: [{ status: 'ACTIVE', toolkit: { slug: 'gmail' } }] }) }),
    commit: async (cards) => { await store.save({ ...store.get(), cards }, { digest: true }); return { success: true } },
  })
  const r = await runner.run()
  assert.equal(r.status, 'done', r.error)
  assert.equal(r.channels.gmail.status, 'skipped')
  assert.match(r.channels.gmail.note || '', /没有新条目/)
  assert.equal(r.chief.status, 'skipped')
  assert.equal(prompts, 0, 'no LLM turns when nothing to propose')
})

test('runner: parallel source bots + Chief commit; a failing channel keeps its old cards; completions survive', async () => {
  const home = mkdtempSync(join(tmpdir(), 'odm-bd-'))
  const store = createStore(join(home, 'state.json'))
  // existing cards: yesterday-style Slack card (its channel will fail) and a done email single
  await store.save({ cards: [
    { id: 'old-slack', type: 'slack-cluster', source: 'slack', sourceId: `slack:cluster:C1:${DAY}`, title: 'old slack', status: 'active', blocks: [] },
    { id: 'done-bob', type: 'email-action', source: 'gmail', sourceId: 'gmail:action:gmail:a1', title: 'Bob', status: 'done', blocks: [{ type: 'link-list', links: [{ url: 'https://mail.google.com/mail/u/0/#inbox/a1' }] }] },
  ], itemStatus: { 'https://mail.google.com/mail/u/0/#inbox/a5': { status: 'done' } } })
  let runner
  const { ctx, sessions } = fakeDsh(async (sid, text) => {
    if (text.includes('Chief')) return runner.toolCommit(sid, JSON.stringify({ headline: '先审 #7', narrative: '今天先审 PR', merges: [], cards: [], timeline: [{ start: '15:00', end: '16:00', title: '审 PR', category: 'review' }] }))
    const snap = await runner.toolSnapshot(sid)
    if (snap.error) return
    const items = snap.items
    const cards = snap.channel === 'gmail'
      ? [{ title: '促销', category: 'promo', items: items.filter(r => /off|sale/i.test(r.subject)).map(r => r.ref) }, { title: 'Bob', category: 'single', needsAction: true, items: items.filter(r => /contract/.test(r.subject)).map(r => r.ref) }]
      : [{ title: 'FlyBot', category: 'ThinkFlowLab/FlyBot', needsAction: true, priority: 'high', items: items.map(r => r.ref) }]
    runner.toolPropose(sid, JSON.stringify(cards))
    runner.toolNote(sid, `${snap.channel}: 促销一律不单独出卡`)
  })
  const committed = []
  const fetchFromSources = async (_c, [acc]) => {
    if (acc.toolkit.slug === 'slack') throw new Error('rate limited')
    return acc.toolkit.slug === 'gmail' ? { gmailItems: gmailItems() } : { githubItems: [pr(7, 'ThinkFlowLab/FlyBot', 'Add digest bots')] }
  }
  const A = { ...agg, fetchFromSources, normalizeItems: d => d.gmailItems || d.githubItems || [] }
  const progress = []
  runner = createBotDigest({
    ctx, store, home, aggregation: A, digestStore: createDigestStore(home),
    client: () => ({ getConnectedAccounts: async () => ({ items: ['gmail', 'github', 'slack'].map(s => ({ status: 'ACTIVE', toolkit: { slug: s } })) }) }),
    commit: async (cards, meta) => { committed.push({ cards, meta }); await store.save({ ...store.get(), cards }, { digest: true }); return { success: true } },
    emit: p => progress.push(JSON.parse(JSON.stringify(p))), chiefMemory: async () => '用户偏好中文',
  })
  const r = await runner.run()
  assert.equal(r.status, 'done', r.error)
  assert.equal(r.channels.slack.status, 'failed'); assert.match(r.channels.slack.error, /rate limited/)
  assert.equal(r.channels.gmail.status, 'done'); assert.equal(r.channels.github.status, 'done')
  assert.ok(progress.some(p => p.channels.gmail?.status === 'thinking') && progress.some(p => p.channels.github?.status === 'done'))
  // tool scoping: a source bot only sees its snapshot/propose/note + its channel's read tools
  const gm = [...sessions.values()].find(s => s.agent.ctx.tools.allow?.includes('odm_gmail_fetch_emails'))
  assert.deepEqual(gm.agent.ctx.tools.allow, [...SOURCE_TOOLS, 'odm_gmail_fetch_emails'])
  const cards = store.get().cards
  assert.equal(cards.find(c => c.id === 'old-slack').title, 'old slack', 'failed channel: old card untouched')
  assert.equal(cards.find(c => c.sourceId === 'gmail:action:gmail:a1').status, 'done', 'completion survives')
  assert.equal(store.get().itemStatus['https://mail.google.com/mail/u/0/#inbox/a5'].status, 'done')
  assert.ok(cards.some(c => c.sourceId === 'github:cluster:ThinkFlowLab/FlyBot'))
  assert.ok(committed[0].cards.some(c => c.type === 'hero') && committed[0].cards.some(c => c.type === 'timetable' && c.blocks[0].suggestedBlocks.length === 1))
  assert.equal(r.tokens.input, 3000)
  const ds = runner.store.get()
  assert.ok(ds.memory.gmail.length && ds.runs[0].status === 'done' && ds.sessions.chief)
  // a second run over the same data: nothing new, no duplicates
  const n1 = store.get().cards.length
  const r2 = await runner.run(); assert.equal(r2.status, 'done', r2.error)
  assert.equal(store.get().lastReconcile.created, 0); assert.equal(store.get().cards.length, n1)
  const { duplicateCount } = await import('../src/host/reconcile.js'); assert.equal(duplicateCount(store.get().cards), 0)
  // tools refuse callers that are not digest sessions
  assert.ok((await runner.toolSnapshot('random')).error); assert.ok(runner.toolCommit('random', '{}').error)
})

test('runner: all channels failing -> run fails (caller falls back to legacy); router falls back', async () => {
  const home = mkdtempSync(join(tmpdir(), 'odm-bd2-'))
  const store = createStore(join(home, 'state.json'))
  const { ctx } = fakeDsh(async () => {})
  const runner = createBotDigest({ ctx, store, home, aggregation: { ...agg, fetchFromSources: async () => { throw new Error('down') } }, digestStore: createDigestStore(home),
    client: () => ({ getConnectedAccounts: async () => ({ items: [{ status: 'ACTIVE', toolkit: { slug: 'gmail' } }] }) }), commit: async () => ({}) })
  const r = await runner.run()
  assert.equal(r.status, 'failed')
  const router = createApiRouter({ store, config: { home, dataDir: home }, configStore: { get: () => ({ composioApiKey: 'test-not-a-key' }), set() {} } })
  router.setBotDigest(runner)
  let legacyCalled = 0
  router.generateLegacyDigest = async () => { legacyCalled++; return { success: true, mode: 'legacy' } }
  assert.equal(router.digestMode(), 'bot')
  const out = await router.generateDigestNow()
  assert.equal(out.mode, 'legacy-fallback'); assert.equal(legacyCalled, 1); assert.match(out.botError, /失败/)
  await router.setDigestMode({ mode: 'legacy' })
  assert.equal((await router.generateDigestNow()).mode, 'legacy'); assert.equal(legacyCalled, 2)
  assert.equal(router.digestStatus().mode, 'legacy')
})

test('digest preferences: stored once, read by later digests', () => {
  const home = mkdtempSync(join(tmpdir(), 'odm-bd3-'))
  const ds = createDigestStore(home)
  const p = ds.addPref('GitHub 通知邮件不用单独出卡', { channel: 'gmail' })
  ds.addPref('GitHub 通知邮件不用单独出卡', { channel: 'gmail' })
  assert.equal(createDigestStore(home).get().prefs.length, 1)
  assert.equal(p.channel, 'gmail')
  assert.ok(ds.removePref(p.id))
})
