import { t, resolveLang, DEFAULT_LOCALE } from '../i18n/index.js'
import { SOURCE_RECIPES, sourceCluster, UNSCANNED_REASONS } from '../web/source-recipes.js'
import { youtubeItems, youtubeCluster } from '../web/youtube.js'
// Bot digest runner: one dsh session per channel (source bots) in parallel, then a separate Chief digest session
// that merges / prioritizes and commits. Cards are written through the same store.save({digest:true}) merge the
// legacy pipeline uses (update-or-add, completions and itemStatus kept, done cards never overwritten).
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { facePrompt } from '../ui/face.js'
import { CHANNELS, channelOfToolkit } from './channels.js'
import { buildSnapshot } from './snapshot.js'
import { validateCandidates, validatePlan, buildCards, invalidLinks, seenEntities } from './build.js'
import { stableKey, linkUrls } from '../host/reconcile.js'
import { rankMemories } from './memory-rank.js'
import {
  listOpenVikingMemories,
  forgetOpenVikingMemory,
  readOpenVikingRecall,
  openVikingHealth,
  resolveOpenVikingConfig,
} from './openviking.js'
export { rankMemories, isMemoryHighlight, isRoutinePreference, partitionMemories, memorySignal } from './memory-rank.js'

const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s }
const shNow = (t = Date.now()) => new Date(t + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')
export const SOURCE_TOOLS = ['odm_digest_snapshot', 'odm_digest_propose', 'odm_digest_note']
export const CHIEF_TOOLS = ['odm_digest_commit', 'odm_digest_pref_add']
/** Standing preferences are a short list a person can still read, not an ever-growing history. */
export const MAX_PREFS = 20

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
      const p = { id: `p${randomUUID()}`, text: t, channel: CHANNELS[channel] ? channel : null, by, at: new Date().toISOString() }
      s.prefs.push(p); while (s.prefs.length > MAX_PREFS) s.prefs.shift(); save(); return p
    },
    removePref(id) { const s = get(); const n = s.prefs.length; s.prefs = s.prefs.filter(p => p.id !== id); save(); return n !== s.prefs.length },
    /** Rewrite one pref in place. `null` means refused (unknown id, empty text, or another pref already says it) and nothing is written. */
    editPref(id, text) {
      const s = get(); const p = s.prefs.find(x => x.id === String(id)); if (!p) return null
      const t = clip(String(text ?? '').trim(), 160); if (!t) return null
      if (s.prefs.some(x => x.id !== p.id && x.text === t)) return null
      p.text = t; p.at = new Date().toISOString(); save(); return p
    },
    clearPrefs() { const s = get(); const n = s.prefs.length; s.prefs = []; save(); return n },
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

/** Existing cards the bots must reconcile with (one card per thing: update it, or say new). */
export function existingCardsFor(cards, channel = null) {
  return (cards || []).filter(c => ['active', 'done', 'snoozed', 'waiting', 'archived', undefined].includes(c.status) && c.source !== 'system' && (!channel || c.source === channel))
    .slice(0, 40).map(c => ({ id: c.id, key: stableKey(c), title: clip(c.title, 40), status: c.status || 'active', items: linkUrls(c).length }))
}

function sourcePrompt(channel, { prefs, memory, now, existing = [] }) {
  const c = CHANNELS[channel]
  return `【汇聚 · ${c.label} 信源 Bot】现在 ${shNow(now)}（Asia/Shanghai）。你只负责 ${c.label} 这一个渠道，为「今天」页准备候选卡。
步骤：
1. 调 odm_digest_snapshot 拿本渠道快照（已去掉用户完成/忽略的条目）。每条有 ref（如 ${c.letter}3）。
2. 需要细节时可以用本渠道只读工具（${c.readTools.join('、')}）；不要做任何写操作、不要发消息。
3. 调 odm_digest_propose，cards 是 JSON 数组，每张：{"title","category","needsAction":bool,"priority":"high|medium|low","nextStep","summary","items":["${c.letter}1",{"ref":"${c.letter}2","status":"needs-you|waiting|fyi"}]}
   - items 只能填快照里的 ref，不能编链接；同一个 ref 只出现一次；没人需要看的条目可以不放。
   - title ≤ 30 字，summary 一两句：谁、什么事、为什么是现在（截止/有人卡在等你/CI 挂了），以及是等你还是等别人。
   - nextStep 是一个可直接做的动作：动词 + 具体对象（「回复 张三：确认周五上线」「先审 #123：看 auth 改动」）；禁止「查看详情」「处理一下」「看一眼」「忽略或归档」这类空话。
   - PR/issue 编号只能抄快照里的 num 字段，绝不凭记忆写编号；快照里没有的数字（条数、分数、日期）不要写。
   - 已合并 / 已关闭 / 已回复、没有新进展的条目不要放进卡里；纯通知、没人等你的，needsAction=false。
   - 你的 PR 在等别人 review、你在等对方回复的条目，status 填 "waiting"（卡会归到「等别人」）；要你动手的填 "needs-you"。
   - 每张必须带 "target"：今天页已有同一件事的卡就填 "update:<卡片id>"（在原卡上更新），确实是新的事才填 "new"。不要为已有的仓库/频道/邮件类别再开新卡。
   - 工具返回 errors 时按提示修正后重新调用一次。
   - ${facePrompt().split('\n').join('\n     ')}
4. 发现用户处理这个渠道的稳定习惯时（如「某类通知总是直接忽略」），调 odm_digest_note 记一句。
5. 最后只回复一行：完成 N 张。
${c.guide}
${existing.length ? `\n今天页已有的 ${c.label} 卡（id / key / 标题 / 状态 / 条目数）：\n${existing.map(e => `- ${e.id} | ${e.key || '-'} | ${e.title} | ${e.status} | ${e.items}`).join('\n')}` : ''}
${prefs.length ? `\n用户的汇聚偏好（必须遵守）：\n${prefs.map(p => `- ${p.text}`).join('\n')}` : ''}
${memory.length ? `\n你记得的该渠道习惯：\n${memory.map(m => `- ${m}`).join('\n')}` : ''}`
}

const AUX = { googlecalendar: '日历', youtube: 'YouTube', ...Object.fromEntries(Object.keys(SOURCE_RECIPES).map(s => [s, s])) }
const KNOWN_SOURCES = { gmail: 'Gmail', github: 'GitHub', slack: 'Slack', googlecalendar: '日历' }

/** Calendar-like sources for one run: the ACTIVE account to read, or why a connected source is not read. */
export function auxSources(items = [], { only = null } = {}) {
  const out = {}
  for (const [slug, label] of Object.entries(AUX)) {
    if (only && !only.includes(slug) && !(slug === 'googlecalendar' && only.includes('calendar'))) continue
    const mine = items.filter(a => a?.toolkit?.slug === slug)
    if (!mine.length) continue
    const active = mine.filter(a => a.status === 'ACTIVE').sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')))
    out[slug] = active.length
      ? { label, status: 'queued', account: active[0] }
      : { label, status: 'failed', error: `连接状态 ${mine.map(a => a.status).filter(Boolean).join('/') || '未知'}，需要在信源状态里重新连接` }
  }
  // A known channel whose only accounts are expired / pending would otherwise vanish from the strip.
  for (const [slug, label] of Object.entries(KNOWN_SOURCES)) {
    if (AUX[slug] || (only && !only.includes(slug))) continue
    const mine = items.filter(a => a?.toolkit?.slug === slug)
    if (mine.length && !mine.some(a => a.status === 'ACTIVE')) out[slug] = { label, status: 'failed', error: `连接状态 ${mine.map(a => a.status).filter(Boolean).join('/')}，需要重新连接` }
  }
  for (const a of items) {
    const slug = a?.toolkit?.slug
    if (!slug || AUX[slug] || KNOWN_SOURCES[slug] || (only && !only.includes(slug))) continue
    if (!out[slug] || a.status === 'ACTIVE') out[slug] = a.status === 'ACTIVE'
      ? { label: a.toolkit.name || slug, status: 'not-scanned', note: UNSCANNED_REASONS[slug] || 'No read recipe available' }
      : { label: a.toolkit.name || slug, status: 'failed', error: `Connection ${a.status || 'unknown'}; reconnect in Sources` }
  }
  return out
}

function calendarLines(data) {
  const ev = data?.googlecalendar?.today
  if (!Array.isArray(ev) || !ev.length) return ''
  const t = v => { const d = new Date(v); return isNaN(d) ? '全天' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
  return `\n今天日历里的真实日程（timeline 不能和它们重叠）：${ev.slice(0, 12).map(e => `${t(e.start?.dateTime || e.start?.date)}–${t(e.end?.dateTime || e.end?.date)} ${clip(e.summary || '日程', 24)}`).join('；')}`
}

function chiefPrompt({ candidates, statuses, prefs, chiefMemory, now, existing, lang = DEFAULT_LOCALE }) {
  const locale = resolveLang(lang)
  const langNote = t('digest.chief_lang', locale)
  const rows = candidates.map(c => ({ id: c.id, target: c.target, ch: c.channel, cat: c.category, title: c.title, needs: c.needsAction, pri: c.priority, next: c.nextStep, summary: c.summary, n: c.items.length, items: c.itemTitles }))
  return `【汇聚 · Chief】现在 ${shNow(now)}（Asia/Shanghai）。各渠道信源 Bot 已给出候选卡，你来合并成今天页。
渠道状态：${statuses}
候选卡（JSON）：
${JSON.stringify(rows)}
${existing ? `\n今天页上已有、用户关注过的卡（参考，不必重复）：${existing}` : ''}
${prefs.length ? `\n用户的汇聚偏好（必须遵守）：\n${prefs.map(p => `- ${p.text}${p.channel ? `（${p.channel}）` : ''}`).join('\n')}` : ''}
${chiefMemory ? `\n你的长期记忆（关于用户）：\n${clip(chiefMemory, 3000)}` : ''}

角色：你是汇聚 Chief。信源 Bot（Gmail/GitHub/Slack）已经各自出完候选；日历没有信源 Bot，只提供真实日程。不要回头再拉信源。
要做的：
0. 规则：今天页不能有两张讲同一件事的卡。target=update:<id> 的候选会更新那张原卡；target=new 的才会新建。
1. 去重 / 跨渠道合并：同一件事在多个渠道（GitHub 通知邮件 + 对应 PR 卡；Slack 里讨论某个 PR）→ merges:[{"into":"github:0","from":["gmail:3"],"reason":"同一 PR"}]。只合并确实是同一件事的；into 填工作本身那张（GitHub/Slack 卡），from 填通知邮件。不确定就别合并。
2. 排优先级：cards:[{"id","priority":"urgent|high|medium|low","nextStep"?,"title"?}]，按重要性从高到低列出（不列的保持原样）。先排「有人卡在等你 / 有截止 / CI 挂了」的，再排普通待办；促销/社交类保持 low。改写 nextStep 时只能用候选卡里出现过的编号，必须是动词+具体对象。
3. 今天的标题 headline（≤20 字）和 narrative（一两句：今天最该先做什么，基于真实候选卡）。
${langNote}
4. timeline：今天剩余时间的建议安排 3~6 段 [{"start":"HH:MM","end":"HH:MM","title","category":"focus|work|review|meeting|break|admin|personal"}]，从现在之后开始；不要和真实日历冲突。
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
    const p = { runId: run.id, mode: 'bot', status: run.status, startedAt: run.startedAt, channels: Object.fromEntries([
      ...Object.entries(run.channels).map(([k, v]) => [k, { label: CHANNELS[k].label, status: v.status, cards: v.cards ?? null, note: v.note || null, error: v.error || null, ms: v.ms ?? null }]),
      // Calendar and other connected sources without a source bot: fetched directly, still shown (with failures).
      ...Object.entries(run.aux || {}).map(([k, v]) => [k, { label: v.label, status: v.status, cards: null, note: v.note || null, error: v.error || null, ms: v.ms ?? null }]),
    ]), chief: { status: run.chief.status, error: run.chief.error || null } }
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
    // Empty live queue: skip the source-bot LLM turn (nothing to propose).
    if (!snap.rows.length) {
      ch.status = 'skipped'
      ch.candidates = []
      ch.cards = 0
      ch.note = snap.skipped ? `没有新条目（已处理 ${snap.skipped}）` : '没有新条目'
      ch.ms = Date.now() - t0
      progress(run)
      return
    }
    ch.status = 'thinking'; progress(run)
    try {
      const sid = await ensureSession(channel, [...SOURCE_TOOLS, ...CHANNELS[channel].readTools])
      bySession.set(sid, { role: channel, run }); ch.sessionId = sid
      const s = digestStore.get()
      const prefs = s.prefs.filter(p => !p.channel || p.channel === channel)
      const turn = await runTurn(ctx, sid, sourcePrompt(channel, { prefs, memory: s.memory[channel] || [], now: Date.now(), existing: existingCardsFor(store.get()?.cards, channel) }), { timeoutMs: deps.sourceTimeoutMs || 150_000 })
      ch.usage = turn.usage; ch.turnMs = turn.ms
      if (!ch.candidates) { ch.status = turn.timeout ? 'timeout' : 'failed'; ch.error = turn.timeout ? '超时，没有提交候选卡' : '没有提交候选卡' }
      else { ch.status = 'done'; ch.cards = ch.candidates.length }
    } catch (err) { ch.status = 'failed'; ch.error = err.message }
    ch.ms = Date.now() - t0
    progress(run)
  }

  // ---- calendar (and any other connected source without a source bot) ----
  async function fetchAux(runRec, accounts) {
    if (!accounts.length) return {}
    const t0 = Date.now()
    for (const v of Object.values(runRec.aux)) if (v.account) v.status = 'fetching'
    progress(runRec)
    let data = {}
    try {
      // Bound cross-toolkit fanout while keeping one slow toolkit from blocking all others.
      for (let i = 0; i < accounts.length; i += 3) {
        const parts = await Promise.all(accounts.slice(i, i + 3).map(a => A.fetchFromSources(deps.client(), [a])))
        for (const part of parts) { Object.assign(data, part); if (part.errors) data.errors = { ...data.errors, ...part.errors } }
      }
    }
    catch (err) { data = {}; for (const v of Object.values(runRec.aux)) if (v.account) v.error = err.message }
    for (const [slug, v] of Object.entries(runRec.aux)) {
      if (!v.account) continue
      v.ms = Date.now() - t0
      const err = data.errors?.[slug] || v.error
      if (slug === 'googlecalendar' && data.googlecalendar && !err) {
        const today = data.googlecalendar.today || []
        v.status = 'done'; v.events = today.length
        const tomorrow = data.googlecalendar.tomorrow || []
        v.note = today.length ? `今天 ${today.length} 个日程` : `今天没有日程${tomorrow.length ? `（明天 ${tomorrow.length} 个）` : ''}`
      } else if (slug === 'youtube' && data.youtube && !err) {
        v.status = 'done'; v.note = `${data.youtube.videos.length} new videos${data.youtube.truncated ? ' (limited scan)' : ''}`
      } else if (SOURCE_RECIPES[slug] && data[slug] && !err) {
        v.status = 'done'; v.note = `${data[slug].items.length} recent items${data[slug].truncated ? ' (limited scan)' : ''}`
      } else if (err) { v.status = 'failed'; v.error = String(err).slice(0, 120) }
      else { v.status = 'failed'; v.error = '没有读到数据' }
    }
    progress(runRec)
    return data
  }

  async function run({ only = null } = {}) {
    if (running) return running
    running = (async () => {
      const t0 = Date.now()
      const runRec = { id: `d${t0.toString(36)}`, startedAt: new Date(t0).toISOString(), status: 'running', channels: {}, chief: { status: 'queued' } }
      liveRun = runRec
      const lang = resolveLang(store.get()?.prefs?.lang || deps.profileContext?.()?.lang || DEFAULT_LOCALE)
      try {
        const res = await deps.client().getConnectedAccounts()
        const accounts = (res?.items || []).filter(a => a.status === 'ACTIVE' && a.toolkit?.slug)
        const chans = []
        for (const a of accounts) { const ch = channelOfToolkit(a.toolkit.slug); if (ch && (!only || only.includes(ch)) && !chans.find(x => x.ch === ch)) chans.push({ ch, a }) }
        // Connected sources without a source bot (calendar): fetched directly for the timeline / hero, shown in the strip.
        runRec.aux = auxSources(res?.items || [], { only })
        const extra = Object.values(runRec.aux).filter(v => v.account).map(v => v.account)
        if (!chans.length && !extra.length) throw new Error('没有可用的信源渠道')
        for (const { ch } of chans) runRec.channels[ch] = { status: 'queued' }
        progress(runRec)
        const itemStatus = store.get()?.itemStatus || {}
        const extraData = fetchAux(runRec, extra)
        await Promise.all(chans.map(({ ch, a }) => runSource(runRec, ch, a, itemStatus)))
        const ok = Object.entries(runRec.channels).filter(([, v]) => v.status === 'done' || v.status === 'skipped')
        const failedOnly = Object.entries(runRec.channels).every(([, v]) => v.status === 'failed' || v.status === 'timeout')
        if (chans.length && (!ok.length || failedOnly)) throw new Error(`所有信源都失败：${Object.entries(runRec.channels).map(([k, v]) => `${k} ${v.error || v.status}`).join('；')}`)

        // ---- Chief digest session (skip LLM when no candidates) ----
        const doneChans = ok.filter(([, v]) => v.status === 'done')
        const all = doneChans.flatMap(([, v]) => v.candidates || [])
        for (const c of all) c.itemTitles = c.items.slice(0, 5).map(r => clip(runRec.channels[c.channel].snapshot.byRef.get(r.ref)?.title, 50))
        runRec.allCandidates = all
        const auxData = await extraData
        if (!chans.length && !Object.keys(auxData).some(k => k !== 'errors')) throw new Error('No connected source could be scanned')
        const statuses = [
          ...Object.entries(runRec.channels).map(([k, v]) => {
            if (v.status === 'done') return `${CHANNELS[k].label} 完成 ${v.cards} 张`
            if (v.status === 'skipped') return `${CHANNELS[k].label} 跳过（${v.note || '没有新条目'}）`
            return `${CHANNELS[k].label} 失败（${v.error || v.status}，这个渠道的旧卡保持不变）`
          }),
          ...Object.values(runRec.aux).map(v => `${v.label} ${v.status === 'done' ? `完成 · ${v.note}` : `${v.status === 'skipped' ? '跳过' : '失败'}（${v.error || v.status}）`}`),
        ].join('；') + calendarLines(auxData)
        if (!all.length) {
          runRec.plan = { headline: t('digest.empty_headline', lang), narrative: t('digest.empty_narrative', lang), merges: [], edits: new Map(), timeline: [], errors: [] }
          runRec.chief.status = 'skipped'
          runRec.chief.note = 'zero candidates'
          progress(runRec)
        } else {
          runRec.chief.status = 'thinking'; progress(runRec)
          const chiefSid = await ensureSession('chief', CHIEF_TOOLS)
          bySession.set(chiefSid, { role: 'chief', run: runRec }); runRec.chief.sessionId = chiefSid
          const s = digestStore.get()
          const pinned = (store.get()?.cards || []).filter(c => c.pinned && c.status === 'active').slice(0, 6).map(c => clip(c.title, 30)).join('、')
          const turn = await runTurn(ctx, chiefSid, chiefPrompt({ candidates: all, statuses, prefs: s.prefs, chiefMemory: (await deps.chiefMemory?.()) || '', now: Date.now(), existing: pinned, lang }), { timeoutMs: deps.chiefTimeoutMs || 150_000 })
          runRec.chief.usage = turn.usage; runRec.chief.ms = turn.ms
          if (!runRec.plan) throw new Error(turn.timeout ? 'Chief 汇聚超时，没有提交' : 'Chief 没有提交汇聚计划')
          runRec.chief.status = 'done'; progress(runRec)
        }

        // ---- build + validate + commit ----
        const snaps = Object.fromEntries(ok.map(([k, v]) => [k, v.snapshot]))
        const cands = Object.fromEntries(ok.map(([k, v]) => [k, v.candidates]))
        const today = new Date().toISOString().split('T')[0]
        const built = buildCards(snaps, cands, runRec.plan, { today, lang })
        const valid = new Set(Object.values(snaps).flatMap(s => [...s.byUrl.keys()]))
        const bad = invalidLinks(built.cards, valid)
        for (const c of built.cards) for (const b of c.blocks || []) if (b.links) b.links = b.links.filter(l => !l?.url || valid.has(l.url))
        const sourceData = Object.assign({}, auxData, ...ok.map(([, v]) => v.sourceData))
        const items = A.dedupeItems(A.normalizeItems(sourceData))
        const fake = obj => ({ async *stream() { yield { type: 'text', text: JSON.stringify(obj) } } })
        const grouped = { urgent: [], action: [], fyi: [] }
        const profile = { ...(deps.profileContext?.() || {}), lang }
        const hero = await A.generateHeroCard(grouped, sourceData, fake({ narrative: [runRec.plan.headline, runRec.plan.narrative].filter(Boolean).join('：') }), profile)
        const timetable = await A.generateTimetable(grouped, sourceData, fake({ suggestedBlocks: runRec.plan.timeline }), profile)
        const ach = A.generateAchievementsTile(sourceData, items)
        const yt = youtubeCluster(youtubeItems(auxData.youtube), lang)
        const youtubeCards = yt ? A.generateClusterCards({ urgent: [], action: [], fyi: [yt] }) : []
        const genericCards = Object.keys(SOURCE_RECIPES).flatMap(slug => {
          const c = sourceCluster(auxData[slug]?.items || [], lang)
          return c ? A.generateClusterCards({ urgent: [], action: [], fyi: [c] }) : []
        })
        const cards = [hero, timetable, ...youtubeCards, ...genericCards, ...built.cards, ...(ach ? [ach] : [])]
        lastRun = { sourceData, validUrls: new Set([...valid, ...A.normalizeItems(sourceData).map(i => i.url).filter(Boolean)]), cards: [...built.cards, ...youtubeCards, ...genericCards].map(c => JSON.parse(JSON.stringify(c))).concat([hero, timetable]), at: Date.now() }
        const seen = new Map(); for (const [k, v] of doneChans) for (const [key, urls] of seenEntities(k, v.snapshot)) seen.set(key, urls)
        const saved = await commit(cards, { summary: runRec.plan.headline || runRec.plan.narrative || '', sources: [...ok.map(([k]) => k), ...Object.keys(auxData)], mode: 'bot', seen, channels: new Set([...ok.map(([k]) => k), ...Object.keys(auxData)]) })
        runRec.reconcile = saved?.reconcile || null
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
    return { id: r.id, startedAt: r.startedAt, status: r.status, error: r.error || null, ms: r.ms, tokens: r.tokens, result: r.result || null, reconcile: r.reconcile || null,
      channels: Object.fromEntries(Object.entries(r.channels).map(([k, v]) => [k, { status: v.status, note: v.note || null, error: v.error || null, cards: v.cards ?? null, items: v.snapshot?.rows.length ?? null, truncated: v.snapshot?.truncated ?? null, skippedDone: v.snapshot?.skipped ?? null, droppedRefs: v.droppedRefs || 0, proposeErrors: (v.proposeErrors || []).slice(0, 5), fetchMs: v.fetchMs ?? null, ms: v.ms ?? null, usage: v.usage || null }])),
      aux: Object.fromEntries(Object.entries(r.aux || {}).map(([k, v]) => [k, { status: v.status, note: v.note || null, error: v.error || null, events: v.events ?? null, ms: v.ms ?? null }])),
      candidates: (r.allCandidates || []).map(c => ({ id: c.id, target: c.target, cat: c.category, title: c.title, needs: c.needsAction, pri: c.priority, n: c.items.length, mergedInto: c.mergedInto || undefined })),
      chief: { status: r.chief.status, note: r.chief.note || null, error: r.chief.error || null, ms: r.chief.ms ?? null, usage: r.chief.usage || null, merges: r.plan?.merges || [], planErrors: r.plan?.errors || [] } }
  }

  return { store: digestStore, lastRun: () => lastRun, live: () => (liveRun?.status === 'running' ? liveRun.progress : null), run, toolSnapshot, toolPropose, toolNote, toolCommit, get running() { return !!running }, current: () => running, summarize, roleOf }
}

/** Legacy dsh-memory SQLite recall (fallback while OpenViking is offline). */
export function readDshMemoryRecall(dshHome, { recentCount = 10, maxChars = 2000 } = {}) {
  const dbPath = join(dshHome || '', 'memory', 'memory.db')
  if (!dbPath || !existsSync(dbPath)) return ''
  let db
  try {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
    db = new DatabaseSync(dbPath, { readOnly: true })
    const pinned = db.prepare('SELECT id, text, tags, pinned FROM memories WHERE pinned = 1 ORDER BY updated_at DESC, id DESC').all()
    const recent = db.prepare('SELECT id, text, tags, pinned FROM memories WHERE pinned = 0 ORDER BY updated_at DESC, id DESC LIMIT ?').all(recentCount)
    const rows = rankMemories([...pinned, ...recent].map(r => ({
      id: r.id, text: r.text, tags: r.tags, pinned: r.pinned,
      updatedAt: r.updated_at, updated_at: r.updated_at,
    })))
    if (!rows.length) return ''
    const header = 'Memories you previously stored (use memory_search for anything not listed):\n'
    const lines = []
    let used = header.length
    let dropped = 0
    for (const row of rows) {
      const tags = row.tags ? ` [${row.tags}]` : ''
      const line = `- (#${row.id}${row.pinned ? ', pinned' : ''})${tags} ${row.text}`
      if (used + line.length + 1 > maxChars) { dropped++; continue }
      lines.push(line)
      used += line.length + 1
    }
    if (!lines.length) return ''
    const tail = dropped > 0 ? `\n(${dropped} more memories not shown; use memory_search)` : ''
    return header + lines.join('\n') + tail
  } catch {
    return ''
  } finally {
    try { db?.close() } catch {}
  }
}

/** Legacy SQLite rows for Memory 一瞥 (fallback). Prefer listMemories(). */
export function listDshMemories(dshHome, { limit = 40 } = {}) {
  const dbPath = join(dshHome || '', 'memory', 'memory.db')
  if (!dbPath || !existsSync(dbPath)) return { memories: [], total: 0, path: dbPath || null }
  let db
  try {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
    db = new DatabaseSync(dbPath, { readOnly: true })
    const total = db.prepare('SELECT COUNT(*) AS n FROM memories').get()?.n || 0
    const pinned = db.prepare('SELECT id, text, tags, pinned, created_at, updated_at FROM memories WHERE pinned = 1 ORDER BY updated_at DESC, id DESC').all()
    const recentLimit = Math.max(0, Number(limit) || 40)
    const recent = db.prepare('SELECT id, text, tags, pinned, created_at, updated_at FROM memories WHERE pinned = 0 ORDER BY updated_at DESC, id DESC LIMIT ?').all(recentLimit)
    const toRow = (r) => ({
      id: r.id,
      text: r.text,
      tags: r.tags ? String(r.tags).split(/\s+/).filter(Boolean) : [],
      pinned: !!r.pinned,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })
    const seen = new Set()
    const memories = []
    for (const r of [...pinned, ...recent]) {
      if (seen.has(r.id)) continue
      seen.add(r.id)
      memories.push(toRow(r))
    }
    // Achievements / high-signal first; routine prefs (timezone, UI) sink.
    return { memories: rankMemories(memories), total, path: dbPath }
  } catch {
    return { memories: [], total: 0, path: dbPath }
  } finally {
    try { db?.close() } catch {}
  }
}

/** Legacy SQLite forget by numeric id. Prefer forgetMemory(). */
export function forgetDshMemory(dshHome, id) {
  const n = Number(id)
  if (!Number.isInteger(n) || n < 1) return { ok: false, forgotten: false, error: 'invalid id' }
  const dbPath = join(dshHome || '', 'memory', 'memory.db')
  if (!dbPath || !existsSync(dbPath)) return { ok: false, forgotten: false, error: 'no memory store' }
  let db
  try {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
    db = new DatabaseSync(dbPath)
    const forgotten = db.prepare('DELETE FROM memories WHERE id = ?').run(n).changes > 0
    return { ok: true, forgotten, id: n }
  } catch (err) {
    return { ok: false, forgotten: false, error: err?.message || String(err) }
  } finally {
    try { db?.close() } catch {}
  }
}

/** Unified Memory 一瞥: OpenViking first, SQLite dsh-memory fallback while migrating. */
export async function listMemories(dshHome, { limit = 40 } = {}) {
  try {
    const ov = await listOpenVikingMemories({ limit })
    if (ov.available) return { ...ov, home: dshHome || null }
    // Server missing / unhealthy → keep old SQLite glimpse so UI is not blank mid-migrate.
    const sqlite = listDshMemories(dshHome, { limit })
    return {
      ...sqlite,
      backend: sqlite.total ? 'dsh-memory' : 'openviking',
      available: ov.available,
      openviking: { url: ov.url, error: ov.error },
      home: dshHome || null,
    }
  } catch (err) {
    const sqlite = listDshMemories(dshHome, { limit })
    return {
      ...sqlite,
      backend: sqlite.total ? 'dsh-memory' : 'openviking',
      available: false,
      openviking: { error: err?.message || String(err) },
      home: dshHome || null,
    }
  }
}

/** Forget by viking:// URI (OpenViking) or numeric id (legacy SQLite). */
export async function forgetMemory(dshHome, id) {
  const key = id == null ? '' : String(id).trim()
  if (key.startsWith('viking://')) return forgetOpenVikingMemory(key)
  return forgetDshMemory(dshHome, key)
}

/** Chief brief memory: OpenViking recall first, then legacy dsh-memory, then MEMORY.md. */
export async function readChiefMemory(dshHome) {
  const parts = []
  try {
    const ov = await readOpenVikingRecall()
    if (ov) parts.push(ov)
  } catch {}
  if (!parts.length) {
    try {
      const recall = readDshMemoryRecall(dshHome)
      if (recall) parts.push(recall)
    } catch {}
  }
  try {
    const { loadMainBotId } = await import('../web/muse-chat-core.js')
    const id = await loadMainBotId(dshHome)
    const f = join(dshHome, 'bot', 'memory', 'bots', id, 'MEMORY.md')
    if (existsSync(f)) {
      const md = readFileSync(f, 'utf8').trim()
      if (md) parts.push(md)
    }
  } catch {}
  return parts.join('\n\n')
}

export { openVikingHealth, resolveOpenVikingConfig }
