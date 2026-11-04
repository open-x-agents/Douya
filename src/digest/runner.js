// Bot digest runner: one dsh session per channel (source bots) in parallel, then a separate Chief digest session
// that merges / prioritizes and commits. Cards are written through the same store.save({digest:true}) merge the
// legacy pipeline uses (update-or-add, completions and itemStatus kept, done cards never overwritten).
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { CHANNELS, channelOfToolkit } from './channels.js'
import { buildSnapshot } from './snapshot.js'
import { validateCandidates, validatePlan, buildCards, invalidLinks } from './build.js'

const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s }
const shNow = (t = Date.now()) => new Date(t + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')
export const SOURCE_TOOLS = ['odm_digest_snapshot', 'odm_digest_propose', 'odm_digest_note']
export const CHIEF_TOOLS = ['odm_digest_commit', 'odm_digest_pref_add']

/** Persistent digest state (session ids, per-channel memory, digest preferences, last runs): .odm-data/digest.json */
export function createDigestStore(home) {
  const file = join(home, 'digest.json')
  let cache = null
  const get = () => { if (cache) return cache; try { cache = JSON.parse(readFileSync(file, 'utf8')) } catch { cache = {} } cache.sessions ||= {}; cache.memory ||= {}; cache.prefs ||= []; cache.runs ||= []; return cache }
  const save = () => { mkdirSync(home, { recursive: true }); const tmp = `${file}.tmp`; writeFileSync(tmp, JSON.stringify(cache, null, 2)); renameSync(tmp, file) }
  return {
    get, save,
    addPref(text, { channel = null, by = 'chief' } = {}) {
      const s = get(); const t = clip(String(text || '').trim(), 160); if (!t) return null
      if (s.prefs.some(p => p.text === t)) return s.prefs.find(p => p.text === t)
      const p = { id: `p${Date.now().toString(36)}`, text: t, channel: CHANNELS[channel] ? channel : null, by, at: new Date().toISOString() }
      s.prefs.push(p); while (s.prefs.length > 40) s.prefs.shift(); save(); return p
    },
    removePref(id) { const s = get(); const n = s.prefs.length; s.prefs = s.prefs.filter(p => p.id !== id); save(); return n !== s.prefs.length },
    addNote(channel, note) { const s = get(); const t = clip(String(note || '').trim(), 160); if (!t || !CHANNELS[channel]) return false; (s.memory[channel] ||= []); if (!s.memory[channel].includes(t)) s.memory[channel].push(t); while (s.memory[channel].length > 20) s.memory[channel].shift(); save(); return true },
    recordRun(run) { const s = get(); s.runs.unshift(run); s.runs = s.runs.slice(0, 10); save() },
  }
}

const recOf = r => { const ev = r?.event || r; return { type: ev?.type, time: Number(ev?.time ?? r?.time), data: ev?.data || {} } }
async function liveAgent(ctx, sessionId) {
  const res = await ctx.sessionController.resolveAgent(sessionId).catch(() => undefined)
  return res && !('error' in res) ? (res.agent ?? res) : undefined
}
async function records(ctx, sessionId, maxMessages = 80) {
  const agent = await liveAgent(ctx, sessionId)
  const seq = Number(agent?.session?.seq)
  const page = await ctx.sessionController.page({ address: { kind: 'session', sessionId }, ...(Number.isFinite(seq) && seq > 0 ? { throughSeq: seq - 1 } : { throughSeq: -1 }), maxMessages }, AbortSignal.timeout(10_000))
  return (page?.records || page?.items || []).map(recOf)
}
/** Sum token usage of assistant/message records after `since` (field names differ by provider). */
export function usageOf(recs, since = 0) {
  const u = { input: 0, output: 0, cached: 0, steps: 0 }
  for (const r of recs) {
    if (r.type !== 'assistant/message' || !(r.time >= since - 50)) continue
    const x = r.data?.usage || r.data?.message?.usage; if (!x) continue
    u.steps++
    u.input += Number(x.inputTokens ?? x.input_tokens ?? x.promptTokens ?? x.prompt_tokens ?? x.input ?? 0) || 0
    u.output += Number(x.outputTokens ?? x.output_tokens ?? x.completionTokens ?? x.completion_tokens ?? x.output ?? 0) || 0
    u.cached += Number(x.cachedInputTokens ?? x.cacheReadTokens ?? x.cache_read_input_tokens ?? x.prompt_cache_hit_tokens ?? x.inputTokenDetails?.cacheReadTokens ?? 0) || 0
  }
  return u
}

/** Prompt a session and wait for its turn to end. */
export async function runTurn(ctx, sessionId, text, { timeoutMs = 150_000, signal = null } = {}) {
  const startedAt = Date.now()
  await ctx.sessionController.prompt({ requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text }] }, AbortSignal.timeout(30_000))
  const deadline = startedAt + timeoutMs
  await new Promise(r => setTimeout(r, 600))
  while (Date.now() < deadline) {
    if (signal?.done) break
    const agent = await liveAgent(ctx, sessionId)
    if (agent?.status === 'running' && typeof agent.whenIdle === 'function') await Promise.race([agent.whenIdle(), new Promise(r => setTimeout(r, 3_000))])
    try {
      const recs = await records(ctx, sessionId)
      const ends = recs.filter(r => r.type === 'turn/end' && r.time >= startedAt - 50)
      const running = (await liveAgent(ctx, sessionId))?.status === 'running'
      if (ends.length && !running) return { ok: true, ms: Date.now() - startedAt, usage: usageOf(recs, startedAt), recs }
    } catch { /* page can fail while a step is writing */ }
    await new Promise(r => setTimeout(r, 700))
  }
  if (signal?.done) return { ok: true, ms: Date.now() - startedAt, usage: usageOf(await records(ctx, sessionId).catch(() => []), startedAt), early: true }
  try { (await liveAgent(ctx, sessionId))?.abort?.() } catch {}
  return { ok: false, timeout: true, ms: Date.now() - startedAt, usage: usageOf(await records(ctx, sessionId).catch(() => []), startedAt) }
}

function sourcePrompt(channel, { prefs, memory, now }) {
  const c = CHANNELS[channel]
  return `【汇聚 · ${c.label} 信源 Bot】现在 ${shNow(now)}（Asia/Shanghai）。你只负责 ${c.label} 这一个渠道，为「今天」页准备候选卡。
步骤：
1. 调 odm_digest_snapshot 拿本渠道快照（已去掉用户完成/忽略的条目）。每条有 ref（如 ${c.letter}3）。
2. 需要细节时可以用本渠道只读工具（${c.readTools.join('、')}）；不要做任何写操作、不要发消息。
3. 调 odm_digest_propose，cards 是 JSON 数组，每张：{"title","category","needsAction":bool,"priority":"high|medium|low","nextStep","summary","items":["${c.letter}1",{"ref":"${c.letter}2","status":"needs-you|waiting|fyi"}]}
   - items 只能填快照里的 ref，不能编链接；同一个 ref 只出现一次；没人需要看的条目可以不放。
   - title ≤ 30 字，summary 一两句具体说明（谁、什么事、为什么现在），nextStep 是可直接做的下一步。
   - 工具返回 errors 时按提示修正后重新调用一次。
4. 发现用户处理这个渠道的稳定习惯时（如「某类通知总是直接忽略」），调 odm_digest_note 记一句。
5. 最后只回复一行：完成 N 张。
${c.guide}
${prefs.length ? `\n用户的汇聚偏好（必须遵守）：\n${prefs.map(p => `- ${p.text}`).join('\n')}` : ''}
${memory.length ? `\n你记得的该渠道习惯：\n${memory.map(m => `- ${m}`).join('\n')}` : ''}`
}

function chiefPrompt({ candidates, statuses, prefs, chiefMemory, now, existing }) {
  const rows = candidates.map(c => ({ id: c.id, ch: c.channel, cat: c.category, title: c.title, needs: c.needsAction, pri: c.priority, next: c.nextStep, summary: c.summary, n: c.items.length, items: c.itemTitles }))
  return `【汇聚 · Chief】现在 ${shNow(now)}（Asia/Shanghai）。各渠道信源 Bot 已给出候选卡，你来合并成今天页。
渠道状态：${statuses}
候选卡（JSON）：
${JSON.stringify(rows)}
${existing ? `\n今天页上已有、用户关注过的卡（参考，不必重复）：${existing}` : ''}
${prefs.length ? `\n用户的汇聚偏好（必须遵守）：\n${prefs.map(p => `- ${p.text}${p.channel ? `（${p.channel}）` : ''}`).join('\n')}` : ''}
${chiefMemory ? `\n你的长期记忆（关于用户）：\n${clip(chiefMemory, 3000)}` : ''}

要做的：
1. 去重 / 跨渠道合并：同一件事在多个渠道（GitHub 通知邮件 + 对应 PR 卡；Slack 里讨论某个 PR）→ merges:[{"into":"github:0","from":["gmail:3"],"reason":"同一 PR"}]。只合并确实是同一件事的。
2. 排优先级：cards:[{"id","priority":"urgent|high|medium|low","nextStep"?,"title"?}]，按重要性从高到低列出（不列的保持原样）。促销/社交类保持 low。
3. 今天的标题 headline（≤20 字）和 narrative（一两句：今天最该先做什么，基于真实候选卡）。
4. timeline：今天剩余时间的建议安排 3~6 段 [{"start":"HH:MM","end":"HH:MM","title","category":"focus|work|review|meeting|break|admin|personal"}]，从现在之后开始。
然后调用一次 odm_digest_commit，参数 plan 是上述 JSON 对象（字符串）。返回 errors 时修正后重试一次。最后回复一行：已提交。`
}

/**
 * @param {object} deps
 *   ctx: dsh plugin ctx (sessionController), store: odm store, client: () => composio client,
 *   aggregation: { fetchFromSources, normalizeItems, dedupeItems, generateHeroCard, generateTimetable, generateAchievementsTile },
 *   commit: async (cards, meta) => result  (same save path as the legacy digest)
 *   emit: (progress) => void, digestStore, chiefMemory: () => string, home, log
 */
export function createBotDigest(deps) {
  const { ctx, store, aggregation: A, commit, digestStore, log = () => {} } = deps
  const emit = deps.emit || (() => {})
  const bySession = new Map() // sessionId -> { role: channel|'chief', run }
  const restricted = new WeakSet()
  let running = null
  let liveRun = null
  let lastRun = null // { sourceData, validUrls, cards } of the last successful run (for the legacy comparison)

  async function ensureSession(role, allow) {
    const s = digestStore.get()
    let sid = s.sessions[role]
    let agent = sid ? await liveAgent(ctx, sid) : null
    if (!agent) {
      const cwd = join(deps.home, 'digest-bots', role)
      mkdirSync(cwd, { recursive: true })
      const created = await ctx.sessionController.create({ cwd }, AbortSignal.timeout(30_000))
      sid = created?.sessionId || created?.id
      if (!sid) throw new Error(`create session failed for ${role}`)
      s.sessions[role] = sid; digestStore.save()
      agent = await liveAgent(ctx, sid)
      log(`[bot-digest] created ${role} session ${sid}`)
    }
    if (agent && !restricted.has(agent)) {
      const tools = agent.ctx?.tools
      if (typeof tools?.restrict === 'function') {
        try { tools.restrict({ allow }); restricted.add(agent) }
        catch (err) {
          const known = (deps.knownTools?.() || [])
          const ok = allow.filter(n => known.includes(n))
          try { tools.restrict({ allow: ok }); restricted.add(agent); log(`[bot-digest] ${role}: restricted to ${ok.length}/${allow.length} tools (${err.message})`) } catch (e2) { log(`[bot-digest] ${role}: tool restrict failed: ${e2.message}`) }
        }
      }
    }
    return sid
  }

  function progress(run) {
    const p = { runId: run.id, mode: 'bot', status: run.status, startedAt: run.startedAt, channels: Object.fromEntries(Object.entries(run.channels).map(([k, v]) => [k, { label: CHANNELS[k].label, status: v.status, cards: v.cards ?? null, error: v.error || null, ms: v.ms ?? null }])), chief: { status: run.chief.status, error: run.chief.error || null } }
    run.progress = p
    try { emit(p) } catch {}
    return p
  }

  // ---- tool handlers (called from dsbot-tools with the calling session id) ----
  const roleOf = sid => bySession.get(sid)
  async function toolSnapshot(sid) {
    const r = roleOf(sid)
    if (!r || r.role === 'chief') return { error: '只有汇聚信源 Bot 能调用' }
    const ch = r.run.channels[r.role]
    const snap = await ch.snapshotP
    if (!snap) return { error: `${CHANNELS[r.role].label} 数据获取失败：${ch.error || 'unknown'}` }
    return { channel: r.role, total: snap.rows.length, skippedDone: snap.skipped, truncated: snap.truncated, items: snap.rows }
  }
  function toolPropose(sid, cards) {
    const r = roleOf(sid)
    if (!r || r.role === 'chief') return { error: '只有汇聚信源 Bot 能调用' }
    const ch = r.run.channels[r.role]
    if (!ch.snapshot) return { error: '先调 odm_digest_snapshot' }
    const v = validateCandidates(r.role, cards, ch.snapshot)
    ch.candidates = v.candidates; ch.proposeErrors = v.errors; ch.droppedRefs = (ch.droppedRefs || 0) + v.droppedRefs.length
    ch.proposals = (ch.proposals || 0) + 1
    return { ok: v.candidates.length > 0 || !v.errors.length, accepted: v.candidates.length, errors: v.errors.slice(0, 8), droppedRefs: v.droppedRefs.slice(0, 10) }
  }
  function toolNote(sid, note) {
    const r = roleOf(sid)
    if (!r || r.role === 'chief') return { error: '只有汇聚信源 Bot 能调用' }
    return { ok: digestStore.addNote(r.role, note) }
  }
  function toolCommit(sid, plan) {
    const r = roleOf(sid)
    if (!r || r.role !== 'chief') return { error: '只有汇聚中的 Chief 会话能提交' }
    const v = validatePlan(plan, r.run.allCandidates)
    r.run.plan = v; r.run.chief.commits = (r.run.chief.commits || 0) + 1
    return { ok: true, merges: v.merges.length, edits: v.edits.size, timeline: v.timeline.length, errors: v.errors.slice(0, 8) }
  }

  async function runSource(run, channel, account, itemStatus) {
    const ch = run.channels[channel]
    const t0 = Date.now()
    ch.status = 'fetching'; progress(run)
    ch.snapshotP = (async () => {
      const data = await A.fetchFromSources(deps.client(), [account])
      ch.sourceData = data
      const items = A.dedupeItems(A.normalizeItems(data)).filter(i => i.source === channel)
      ch.snapshot = buildSnapshot(channel, items, itemStatus)
      ch.fetchMs = Date.now() - t0
      return ch.snapshot
    })().catch(err => { ch.error = `fetch: ${err.message}`; return null })
    const snap = await ch.snapshotP
    if (!snap) { ch.status = 'failed'; ch.ms = Date.now() - t0; progress(run); return }
    ch.status = 'thinking'; progress(run)
    try {
      const sid = await ensureSession(channel, [...SOURCE_TOOLS, ...CHANNELS[channel].readTools])
      bySession.set(sid, { role: channel, run }); ch.sessionId = sid
      const s = digestStore.get()
      const prefs = s.prefs.filter(p => !p.channel || p.channel === channel)
      const turn = await runTurn(ctx, sid, sourcePrompt(channel, { prefs, memory: s.memory[channel] || [], now: Date.now() }), { timeoutMs: deps.sourceTimeoutMs || 150_000 })
      ch.usage = turn.usage; ch.turnMs = turn.ms
      if (!ch.candidates) { ch.status = turn.timeout ? 'timeout' : 'failed'; ch.error = turn.timeout ? '超时，没有提交候选卡' : '没有提交候选卡' }
      else { ch.status = 'done'; ch.cards = ch.candidates.length }
    } catch (err) { ch.status = 'failed'; ch.error = err.message }
    ch.ms = Date.now() - t0
    progress(run)
  }

  async function run({ only = null } = {}) {
    if (running) return running
    running = (async () => {
      const t0 = Date.now()
      const runRec = { id: `d${t0.toString(36)}`, startedAt: new Date(t0).toISOString(), status: 'running', channels: {}, chief: { status: 'queued' } }
      liveRun = runRec
      try {
        const res = await deps.client().getConnectedAccounts()
        const accounts = (res?.items || []).filter(a => a.status === 'ACTIVE' && a.toolkit?.slug)
        const chans = []
        for (const a of accounts) { const ch = channelOfToolkit(a.toolkit.slug); if (ch && (!only || only.includes(ch)) && !chans.find(x => x.ch === ch)) chans.push({ ch, a }) }
        const extra = accounts.filter(a => !channelOfToolkit(a.toolkit.slug)) // e.g. calendar: fetched for the timeline only
        if (!chans.length) throw new Error('没有可用的信源渠道')
        for (const { ch } of chans) runRec.channels[ch] = { status: 'queued' }
        progress(runRec)
        const itemStatus = store.get()?.itemStatus || {}
        const extraData = extra.length ? A.fetchFromSources(deps.client(), extra).catch(() => ({})) : Promise.resolve({})
        await Promise.all(chans.map(({ ch, a }) => runSource(runRec, ch, a, itemStatus)))
        const ok = Object.entries(runRec.channels).filter(([, v]) => v.status === 'done')
        if (!ok.length) throw new Error(`所有信源都失败：${Object.entries(runRec.channels).map(([k, v]) => `${k} ${v.error || v.status}`).join('；')}`)

        // ---- Chief digest session ----
        runRec.chief.status = 'thinking'; progress(runRec)
        const all = ok.flatMap(([, v]) => v.candidates)
        for (const c of all) c.itemTitles = c.items.slice(0, 5).map(r => clip(runRec.channels[c.channel].snapshot.byRef.get(r.ref)?.title, 50))
        runRec.allCandidates = all
        const statuses = Object.entries(runRec.channels).map(([k, v]) => `${CHANNELS[k].label} ${v.status === 'done' ? `完成 ${v.cards} 张` : `失败（${v.error || v.status}，这个渠道的旧卡保持不变）`}`).join('；')
        const chiefSid = await ensureSession('chief', CHIEF_TOOLS)
        bySession.set(chiefSid, { role: 'chief', run: runRec }); runRec.chief.sessionId = chiefSid
        const s = digestStore.get()
        const pinned = (store.get()?.cards || []).filter(c => c.pinned && c.status === 'active').slice(0, 6).map(c => clip(c.title, 30)).join('、')
        const turn = await runTurn(ctx, chiefSid, chiefPrompt({ candidates: all, statuses, prefs: s.prefs, chiefMemory: (await deps.chiefMemory?.()) || '', now: Date.now(), existing: pinned }), { timeoutMs: deps.chiefTimeoutMs || 150_000 })
        runRec.chief.usage = turn.usage; runRec.chief.ms = turn.ms
        if (!runRec.plan) throw new Error(turn.timeout ? 'Chief 汇聚超时，没有提交' : 'Chief 没有提交汇聚计划')
        runRec.chief.status = 'done'; progress(runRec)

        // ---- build + validate + commit ----
        const snaps = Object.fromEntries(ok.map(([k, v]) => [k, v.snapshot]))
        const cands = Object.fromEntries(ok.map(([k, v]) => [k, v.candidates]))
        const today = new Date().toISOString().split('T')[0]
        const built = buildCards(snaps, cands, runRec.plan, { today })
        const valid = new Set(Object.values(snaps).flatMap(s => [...s.byUrl.keys()]))
        const bad = invalidLinks(built.cards, valid)
        for (const c of built.cards) for (const b of c.blocks || []) if (b.links) b.links = b.links.filter(l => !l?.url || valid.has(l.url))
        const sourceData = Object.assign({}, await extraData, ...ok.map(([, v]) => v.sourceData))
        const items = A.dedupeItems(A.normalizeItems(sourceData))
        const fake = obj => ({ async *stream() { yield { type: 'text', text: JSON.stringify(obj) } } })
        const grouped = { urgent: [], action: [], fyi: [] }
        const hero = await A.generateHeroCard(grouped, sourceData, fake({ narrative: [runRec.plan.headline, runRec.plan.narrative].filter(Boolean).join('：') }), deps.profileContext?.() || {})
        const timetable = await A.generateTimetable(grouped, sourceData, fake({ suggestedBlocks: runRec.plan.timeline }), deps.profileContext?.() || {})
        const ach = A.generateAchievementsTile(sourceData, items)
        const cards = [hero, timetable, ...built.cards, ...(ach ? [ach] : [])]
        const saved = await commit(cards, { summary: runRec.plan.headline || runRec.plan.narrative || '', sources: ok.map(([k]) => k), mode: 'bot' })
        lastRun = { sourceData, validUrls: valid, cards, at: Date.now() }
        runRec.status = 'done'
        runRec.result = { cards: built.cards.length, total: cards.length, stats: built.stats, invalidLinks: bad.length, needsAction: built.cards.filter(c => c.waiting === 'you').length, saved }
      } catch (err) {
        runRec.status = 'failed'; runRec.error = err.message
        log(`[bot-digest] failed: ${err.message}`)
      }
      runRec.ms = Date.now() - t0
      const tok = [...Object.values(runRec.channels).map(v => v.usage), runRec.chief.usage].filter(Boolean)
      runRec.tokens = tok.reduce((a, u) => ({ input: a.input + u.input, output: a.output + u.output, cached: a.cached + u.cached }), { input: 0, output: 0, cached: 0 })
      progress(runRec)
      for (const sid of [...bySession.keys()]) if (bySession.get(sid).run === runRec) bySession.delete(sid)
      digestStore.recordRun(summarize(runRec))
      return runRec
    })()
    try { return await running } finally { running = null }
  }

  function summarize(r) {
    return { id: r.id, startedAt: r.startedAt, status: r.status, error: r.error || null, ms: r.ms, tokens: r.tokens, result: r.result || null,
      channels: Object.fromEntries(Object.entries(r.channels).map(([k, v]) => [k, { status: v.status, error: v.error || null, cards: v.cards ?? null, items: v.snapshot?.rows.length ?? null, skippedDone: v.snapshot?.skipped ?? null, droppedRefs: v.droppedRefs || 0, proposeErrors: (v.proposeErrors || []).slice(0, 5), fetchMs: v.fetchMs ?? null, ms: v.ms ?? null, usage: v.usage || null }])),
      chief: { status: r.chief.status, error: r.chief.error || null, ms: r.chief.ms ?? null, usage: r.chief.usage || null, merges: r.plan?.merges || [], planErrors: r.plan?.errors || [] } }
  }

  return { store: digestStore, lastRun: () => lastRun, live: () => (liveRun?.status === 'running' ? liveRun.progress : null), run, toolSnapshot, toolPropose, toolNote, toolCommit, get running() { return !!running }, current: () => running, summarize, roleOf }
}

export async function readChiefMemory(dshHome) {
  try {
    const { loadMainBotId } = await import('../web/muse-chat-core.js')
    const id = await loadMainBotId(dshHome)
    const f = join(dshHome, 'bot', 'memory', 'bots', id, 'MEMORY.md')
    return existsSync(f) ? readFileSync(f, 'utf8') : ''
  } catch { return '' }
}
