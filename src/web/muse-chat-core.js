// In-process turn against ds-bot Chief via sessionController (same dsh process).

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

function clean(v) { return String(v ?? '').replace(/\s+/g, ' ').trim() }
// Keep line structure (lists, paragraphs) — the client renders Markdown.
function cleanBlock(v) {
  return String(v ?? '').replace(/\r\n?/g, '\n').split('\n').map(l => l.replace(/[ \t]+$/g, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

function flattenContent(content) {
  if (typeof content === 'string') return cleanBlock(content)
  if (!Array.isArray(content)) return ''
  return cleanBlock(content.map(p => (typeof p === 'string' ? p : (p?.type && p.type !== 'text') ? '' : p?.text || '')).join(''))
}

/**
 * Chief's bot id and the Session that currently holds its conversation. ds-bot moves a long conversation on to
 * a fresh "part" Session (bots[id].sessionId); prompts to the bot id are routed there, but replies have to be
 * read from the current part. parts = earlier part Sessions, oldest first, then the current one.
 */
export async function resolveChief(dshHome, botId = null) {
  try {
    const state = JSON.parse(await readFile(join(dshHome, 'bot', 'state.json'), 'utf8'))
    const id = botId || state.mainBotId || state.mainBotIds?.[0] || Object.keys(state.bots || {})[0] || null
    const bot = id ? state.bots?.[id] : null
    const current = bot?.sessionId || id
    const earlier = (Array.isArray(bot?.segments) ? bot.segments : []).map(s => s?.sessionId).filter(x => x && x !== current)
    return { botId: id, sessionId: current, parts: [...earlier, current].filter(Boolean) }
  } catch {
    return { botId: botId || null, sessionId: botId || null, parts: botId ? [botId] : [] }
  }
}

export async function loadMainBotId(dshHome) {
  try {
    const state = JSON.parse(await readFile(join(dshHome, 'bot', 'state.json'), 'utf8'))
    return state.mainBotId || state.mainBotIds?.[0] || Object.keys(state.bots || {})[0] || null
  } catch {
    return null
  }
}

function lastAssistantText(records = []) {
  for (let i = records.length - 1; i >= 0; i--) {
    const rec = records[i]
    const ev = rec?.event || rec
    // dsh page records look like { type: 'assistant/message', data: { message: {...} } }
    const msg = ev?.data?.message || ev?.message || ev
    const role = msg?.role || msg?.info?.role
    if (role === 'assistant' || role === 'model') {
      const text = flattenContent(msg.content || msg.parts || msg.text)
      if (text) return text
    }
  }
  return ''
}

// Same call shape ds-bot uses: a live session must be paged through its current seq.
// sessionController.resolveAgent resolves to { agent } or { error }, not the agent itself.
async function liveAgent(ctx, sessionId) {
  const resolved = await ctx.sessionController.resolveAgent(sessionId).catch(() => undefined)
  return resolved && !('error' in resolved) ? (resolved.agent ?? resolved) : undefined
}

async function readLastReply(ctx, sessionId, log) {
  const agent = await liveAgent(ctx, sessionId)
  const seq = Number(agent?.session?.seq)
  const page = await ctx.sessionController.page({
    address: { kind: 'session', sessionId },
    ...(Number.isFinite(seq) && seq > 0 ? { throughSeq: seq - 1 } : { throughSeq: -1 }),
    maxMessages: 40,
  }, AbortSignal.timeout(15_000))
  const records = page?.records || page?.items || []
  // Only read a reply once its turn ended; mid-turn text ("我先查卡片…") is not the answer.
  const types = records.map(r => (r?.event || r)?.type)
  if (types.lastIndexOf('turn/start') > types.lastIndexOf('turn/end')) return ''
  return lastAssistantText(records)
}

/**
 * ds-bot 0.2.x condenses a Bot's long conversation (checkpoint in place, or a handoff to a fresh Session) and
 * passes `toolHistory: session.toolHistory()` to the model call. dsh 0.1.2-rc.1's Session has no toolHistory(),
 * so every checkpoint/handoff threw "session.toolHistory is not a function" and Chief's one Session just kept
 * growing (≈280k chars, near the 128k-token window): first-token latency went from ~2s to 10-20s, with timeouts
 * and retries. Supply the missing method (no tool history = what this dsh already sends) on the Session
 * prototype, only when it is absent. Idempotent.
 */
export function ensureSessionCompat(session, log = () => {}) {
  if (!session || typeof session !== 'object') return false
  if (typeof session.toolHistory === 'function') return false
  const proto = Object.getPrototypeOf(session)
  const target = proto && proto !== Object.prototype ? proto : session
  if (typeof target.toolHistory === 'function') return false
  Object.defineProperty(target, 'toolHistory', { value: function toolHistory() { return undefined }, configurable: true, writable: true })
  log('[muse-chat] compat: added Session.toolHistory() so ds-bot can condense long Bot conversations')
  return true
}

/**
 * Prompt Chief and wait for a new assistant reply.
 */
export async function runMuseChatTurn(ctx, {
  message,
  cardId = null,
  cardContext = null,
  viewContext = '',
  dshHome,
  botId = null,
  log = () => {},
  timing = null,
} = {}) {
  const text = clean(message)
  if (!text) return { ok: true, text: '想问哪一类？可以说邮件、PR、或改一张 Today 卡片。', status: 'answered', botId: null }

  const T = timing || {}
  T.turnCallAt = Date.now()
  let outbound = text
  // Server-built snapshots already start with 【当前卡片】 and keep their line structure.
  const ctxText = cardContext ? cleanBlock(cardContext).slice(0, 3200) : ''
  if (ctxText) outbound = `${ctxText.startsWith('【当前卡片】') ? ctxText : `【当前卡片】${ctxText}`}\n\n${text}`
  else if (cardId) outbound = `【cardId=${cardId}】\n${text}`
  // 【当前视图】 goes first (page / filter / open card / visible cards), then 【当前卡片】, then the user's words.
  const viewText = viewContext ? cleanBlock(viewContext).slice(0, 900) : ''
  if (viewText) outbound = `${viewText.startsWith('【当前视图】') ? viewText : `【当前视图】${viewText}`}\n\n${outbound}`
  T.viewChars = viewText.length
  T.contextChars = ctxText.length
  T.outboundChars = outbound.length

  const chief = await resolveChief(dshHome, botId)
  const promptTo = chief.botId
  let sessionId = chief.sessionId // where replies land; re-resolved while waiting (a handoff can happen mid-turn)
  if (!promptTo || !sessionId) return { ok: false, error: 'no Main Bot' }
  if (!ctx?.sessionController?.prompt) return { ok: false, error: 'sessionController missing' }

  try { ensureSessionCompat((await liveAgent(ctx, sessionId))?.session, log) } catch {}
  // Snapshot previous assistant text if page works.
  let before = ''
  try {
    before = await readLastReply(ctx, sessionId, log)
  } catch (err) { log(`[muse-chat] page(before) failed: ${err?.message || err}`) }

  T.beforeReadMs = Date.now() - T.turnCallAt
  log(`[muse-chat] prompt → ${sessionId}: ${outbound.slice(0, 80)}`)
  T.promptAt = Date.now()
  await ctx.sessionController.prompt({
    requestId: randomUUID(),
    sessionId: promptTo,
    mode: 'queue',
    content: [{ type: 'text', text: outbound }],
  }, AbortSignal.timeout(30_000))

  T.promptAckMs = Date.now() - T.promptAt
  const deadline = Date.now() + 180_000
  let reply = ''
  let pageErrLogged = false
  while (Date.now() < deadline) {
    const now = (await resolveChief(dshHome, promptTo)).sessionId
    if (now && now !== sessionId) { log(`[muse-chat] Chief moved on to a new part: ${now}`); sessionId = now; T.handoff = true }
    const agent = await liveAgent(ctx, sessionId)
    if (agent?.status === 'running' && typeof agent.whenIdle === 'function') {
      await Promise.race([agent.whenIdle(), new Promise(r => setTimeout(r, 8_000))])
    } else if (agent?.status === 'running') {
      await new Promise(r => setTimeout(r, 500))
      continue
    }
    try {
      T.polls = (T.polls || 0) + 1
      reply = await readLastReply(ctx, sessionId, log)
      if (reply && reply !== before) break
    } catch (err) {
      if (!pageErrLogged) { pageErrLogged = true; log(`[muse-chat] page failed: ${err?.message || err}`) }
    }
    await new Promise(r => setTimeout(r, 400))
  }

  if (!reply || reply === before) {
    return { ok: false, error: 'Bot 没有产生新回复', botId: sessionId, sessionId }
  }
  T.detectedAt = Date.now()
  try { Object.assign(T, await turnBreakdown(ctx, sessionId, T.promptAt)) } catch (err) { T.breakdownError = String(err?.message || err) }
  log(`[odm-chat-timing] ${JSON.stringify(summarizeTiming(T))}`)
  log(`[muse-chat] reply: ${reply.slice(0, 120)}`)
  return {
    ok: true,
    text: reply,
    status: 'answered',
    botId: sessionId,
    sessionId,
    citations: [],
    cards: [],
    timing: summarizeTiming(T),
  }
}

const recOf = (r) => { const ev = r?.event || r; return { type: ev?.type, time: Number(ev?.time ?? r?.time), data: ev?.data || {} } }

async function tailRecords(ctx, sessionId, maxMessages = 30) {
  const agent = await liveAgent(ctx, sessionId)
  const seq = Number(agent?.session?.seq)
  const page = await ctx.sessionController.page({
    address: { kind: 'session', sessionId },
    ...(Number.isFinite(seq) && seq > 0 ? { throughSeq: seq - 1 } : { throughSeq: -1 }),
    maxMessages,
  }, AbortSignal.timeout(10_000))
  return { agent, records: (page?.records || page?.items || []).map(recOf) }
}

/** Per-step timing of the Chief turn that started after `sinceMs`, from the session's own records. */
export function breakdownFromRecords(records, sinceMs = 0) {
  const startIdx = records.findIndex(r => r.type === 'turn/start' && r.time >= sinceMs - 50)
  if (startIdx < 0) return { turnFound: false }
  const out = { turnFound: true, turnStartAt: records[startIdx].time, steps: [], tools: [], retries: 0 }
  let step = null
  for (const r of records.slice(startIdx + 1)) {
    if (r.type === 'step/start') { step = { startAt: r.time, firstAt: null, endAt: null }; out.steps.push(step) }
    else if (/chunk/.test(r.type || '') && step && step.firstAt == null) step.firstAt = r.time
    else if (r.type === 'assistant/message' && step && step.firstAt == null) step.firstAt = r.time
    else if (r.type === 'step/end' && step) step.endAt = r.time
    else if (r.type === 'tool/call') out.tools.push({ name: r.data?.name, startAt: r.time, endAt: null })
    else if (r.type === 'tool/result') { const t = out.tools.find(x => x.endAt == null); if (t) t.endAt = r.time }
    else if (r.type === 'llm/retry') out.retries++
    else if (r.type === 'request/header') { out.systemChars = String(r.data?.header?.system || '').length; out.toolCount = (r.data?.header?.tools || []).length; out.toolSchemaChars = JSON.stringify(r.data?.header?.tools || []).length }
    else if (r.type === 'turn/end') { out.turnEndAt = r.time; break }
  }
  return out
}

async function turnBreakdown(ctx, sessionId, sinceMs) {
  const { records } = await tailRecords(ctx, sessionId, 60)
  return breakdownFromRecords(records, sinceMs)
}

export function summarizeTiming(T) {
  const ms = (a, b) => (Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, Math.round(b - a)) : null)
  const steps = (T.steps || []).map(s => ({ ttftMs: ms(s.startAt, s.firstAt ?? s.endAt), stepMs: ms(s.startAt, s.endAt) }))
  const tools = (T.tools || []).map(t => ({ name: t.name, ms: ms(t.startAt, t.endAt) }))
  const toolMs = tools.reduce((a, t) => a + (t.ms || 0), 0)
  const stepMs = steps.reduce((a, s) => a + (s.stepMs || 0), 0)
  return {
    serverRecvToContextMs: ms(T.recvAt, T.contextAt),
    contextChars: T.contextChars ?? null,
    outboundChars: T.outboundChars ?? null,
    viewChars: T.viewChars ?? null,
    beforeReadMs: T.beforeReadMs ?? null,
    promptAckMs: T.promptAckMs ?? null,
    queueToTurnStartMs: ms(T.promptAt, T.turnStartAt),
    firstTokenMs: steps[0]?.ttftMs ?? null,
    modelCalls: steps.length,
    modelMs: Math.max(0, stepMs - toolMs),
    toolCalls: tools.length,
    toolMs,
    tools,
    steps,
    retries: T.retries ?? 0,
    turnMs: ms(T.turnStartAt, T.turnEndAt),
    turnEndToDetectMs: ms(T.turnEndAt, T.detectedAt),
    polls: T.polls ?? 0,
    handoff: !!T.handoff,
    serverTotalMs: ms(T.recvAt ?? T.turnCallAt, T.detectedAt),
    systemChars: T.systemChars ?? null, toolCount: T.toolCount ?? null, toolSchemaChars: T.toolSchemaChars ?? null,
  }
}

const TOOL_LABEL = [
  [/^odm_github_|^odm_act_github_/, '正在查 GitHub…'],
  [/^odm_gmail_|^odm_act_gmail_/, '正在查邮件…'],
  [/^odm_slack_|^odm_act_slack_/, '正在查 Slack…'],
  [/^odm_(card|current_card|today|completions)/, '正在看卡片…'],
  [/^odm_digest/, '正在重新汇聚…'],
  [/^bash$/, '正在跑命令…'],
  [/^web_fetch|^web_search/, '正在查网页…'],
]
export function progressLabel(name) {
  for (const [re, label] of TOOL_LABEL) if (re.test(name || '')) return label
  return name ? `正在调用 ${String(name).replace(/^odm_/, '')}…` : '豆芽正在想…'
}

/** What Chief is doing right now (for the 豆芽正在想… indicator). */
export async function chatProgress(ctx, { dshHome, botId = null } = {}) {
  const { sessionId } = await resolveChief(dshHome, botId)
  if (!sessionId || !ctx?.sessionController?.page) return { running: false }
  const { agent, records } = await tailRecords(ctx, sessionId, 8)
  const types = records.map(r => r.type)
  const running = agent?.status === 'running' || types.lastIndexOf('turn/start') > types.lastIndexOf('turn/end')
  if (!running) return { running: false }
  let label = '豆芽正在想…', tools = 0
  const lastStart = types.lastIndexOf('turn/start')
  for (const r of records.slice(Math.max(0, lastStart))) {
    if (r.type === 'tool/call') { tools++; label = progressLabel(r.data?.name) }
    else if (r.type === 'tool/result') label = '豆芽正在想…'
    else if (r.type === 'llm/retry') label = '模型响应慢，正在重试…'
    else if (/text-chunks|assistant\/chunk/.test(r.type || '') && label === '豆芽正在想…') label = '正在写回复…'
  }
  return { running: true, label, tools }
}
