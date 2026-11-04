// In-process turn against ds-bot Chief via sessionController (same dsh process).

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { buildChatContent, isImageModelError } from './chat-media.js'
import { DEEPSEEK_VISION_MODELS } from './llm-env.js'

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
  attachments = null, // [{kind:'image'|'file', mediaType?, name, data: base64}]
  dshHome,
  botId = null,
  log = () => {},
  timing = null,
  onSession = null, // (sessionId) → the UI feed streams this turn's text / tool progress
} = {}) {
  const text = clean(message)
  const hasAttach = Array.isArray(attachments) && attachments.length > 0
  if (!text && !hasAttach) return { ok: true, text: '想问哪一类？可以说邮件、PR、或改一张 Today 卡片；也可以贴图 / 传文件 / 按住麦克风说话。', status: 'answered', botId: null }

  const T = timing || {}
  T.turnCallAt = Date.now()
  let outbound = text || (hasAttach ? '请看我附上的内容。' : '')
  // Server-built snapshots already start with 【当前卡片】 and keep their line structure.
  const ctxText = cardContext ? cleanBlock(cardContext).slice(0, 3200) : ''
  if (ctxText) outbound = `${ctxText.startsWith('【当前卡片】') ? ctxText : `【当前卡片】${ctxText}`}\n\n${outbound}`
  else if (cardId) outbound = `【cardId=${cardId}】\n${outbound}`
  // 【当前视图】 goes first (page / filter / open card / visible cards), then 【当前卡片】, then the user's words.
  const viewText = viewContext ? cleanBlock(viewContext).slice(0, 900) : ''
  if (viewText) outbound = `${viewText.startsWith('【当前视图】') ? viewText : `【当前视图】${viewText}`}\n\n${outbound}`
  T.viewChars = viewText.length
  T.contextChars = ctxText.length
  T.outboundChars = outbound.length

  let built
  const chief = await resolveChief(dshHome, botId)
  const promptTo = chief.botId
  let sessionId = chief.sessionId // where replies land; re-resolved while waiting (a handoff can happen mid-turn)
  if (!promptTo || !sessionId) return { ok: false, error: 'no Main Bot' }
  if (!ctx?.sessionController?.prompt) return { ok: false, error: 'sessionController missing' }
  try { onSession?.(sessionId); if (promptTo !== sessionId) onSession?.(promptTo) } catch {}

  let agent = null
  try { agent = await liveAgent(ctx, sessionId); ensureSessionCompat(agent?.session, log) } catch {}
  try {
    built = await buildChatContent(ctx, { text: outbound, attachments: hasAttach ? attachments : [], agent, log }, { preferNative: true })
  } catch (err) {
    return { ok: false, error: err.message || String(err) }
  }
  T.attachCount = built.meta.length
  T.attachMode = built.mode
  // Snapshot previous assistant text if page works.
  let before = ''
  try {
    before = await readLastReply(ctx, sessionId, log)
  } catch (err) { log(`[muse-chat] page(before) failed: ${err?.message || err}`) }

  T.beforeReadMs = Date.now() - T.turnCallAt
  const preview = built.content.find(p => p.type === 'text')?.text || ''
  log(`[muse-chat] prompt → ${sessionId}: ${preview.slice(0, 80)} attach=${built.meta.length}/${built.mode}`)
  T.promptAt = Date.now()
  const sendPrompt = async (content) => ctx.sessionController.prompt({
    requestId: randomUUID(),
    sessionId: promptTo,
    mode: 'queue',
    content,
  }, AbortSignal.timeout(30_000))
  try {
    try {
      await sendPrompt(built.content)
    } catch (err) {
      // The prompt target can still carry an older text-only selection (e.g. deepseek-chat) after the
      // bot moved to a vision model. Re-select the configured vision model on it once, then retry native.
      const vision = visionChatModel()
      if (built.mode !== 'native' || !vision || !isModelNoImageError(err) || !ctx.sessionController.selectModel) throw err
      log(`[muse-chat] ${promptTo} refused images (${err.message}); selecting ${vision.provider}/${vision.model}`)
      try {
        await ctx.sessionController.selectModel({ sessionId: promptTo, provider: vision.provider, model: vision.model }, AbortSignal.timeout(15_000))
      } catch (selErr) {
        log(`[muse-chat] selectModel ${vision.model} failed: ${selErr?.message || selErr}`)
        throw err
      }
      T.modelReselected = `${vision.provider}/${vision.model}`
      await sendPrompt(built.content)
    }
  } catch (err) {
    if (built.mode === 'native' && isImageModelError(err) && hasAttach) {
      log(`[muse-chat] native attach refused (${err.message}); retrying as text`)
      built = await buildChatContent(ctx, { text: outbound, attachments, agent, log }, { preferNative: false })
      T.attachMode = 'text-fallback'
      T.attachFallbackReason = [err?.data?.reason || err?.reason || err?.code, err?.message].filter(Boolean).join(': ').slice(0, 240)
      await sendPrompt(built.content)
    } else {
      return { ok: false, error: err.message || String(err) }
    }
  }

  T.promptAckMs = Date.now() - T.promptAt
  const deadline = Date.now() + 180_000
  let reply = ''
  let pageErrLogged = false
  while (Date.now() < deadline) {
    const now = (await resolveChief(dshHome, promptTo)).sessionId
    if (now && now !== sessionId) { log(`[muse-chat] Chief moved on to a new part: ${now}`); sessionId = now; T.handoff = true; try { onSession?.(now) } catch {} }
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
    attachments: built?.meta || [],
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

/** The configured chat model when it reads images (provider route `deepseek` on llm-pi-ai). */
export function visionChatModel(env = process.env) {
  const model = String(env.ODM_CHAT_MODEL || '')
  return DEEPSEEK_VISION_MODELS.has(model) ? { provider: 'deepseek', model } : null
}

/** dsh's model-capability refusal (not a staging/attachment-shape error). */
export function isModelNoImageError(err) {
  const s = `${err?.data?.reason || err?.reason || ''} ${err?.message || err || ''}`
  return /MODEL_DOES_NOT_SUPPORT_IMAGES|does not support image input/i.test(s)
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
    attachCount: T.attachCount ?? 0,
    attachMode: T.attachMode ?? null,
    attachFallbackReason: T.attachFallbackReason ?? null,
    modelReselected: T.modelReselected ?? null,
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
