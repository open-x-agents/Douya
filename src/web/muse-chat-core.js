// In-process turn against ds-bot Chief via sessionController (same dsh process).

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { buildChatContent, isImageModelError } from './chat-media.js'
import { stripAttachNote, legacyAttachments } from './chat-display.js'
import { DEEPSEEK_VISION_MODELS } from './llm-env.js'
import { STEER_NOTE } from './chat-lane.js'

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
// Turn ds-bot failures that mean "the Chief's saved session is gone or unreadable" into a next step.
const HINTS = {
  newer: {
    zh: '豆芽的 Bot 团队文件（.dsh-odm/bot/state.json）是更新版本的 DS Bot 写的，当前只能只读。请先备份并移走这个文件再重启，Chief 会被重新创建。',
    en: 'Douya’s Bot team file (.dsh-odm/bot/state.json) was saved by a newer DS Bot and is read-only here. Back it up, move it aside and restart — a new Chief will be created.',
  },
  noMain: {
    zh: '还没能创建 Chief。请重启豆芽；如果还不行，检查 .dsh-odm/bot/state.json 能否被读取。',
    en: 'Douya couldn’t set up its Chief yet. Restart Douya; if that doesn’t help, check that .dsh-odm/bot/state.json is readable.',
  },
  stale: {
    zh: 'Chief 的旧对话找不到或格式太旧，无法继续。请备份并移走 .dsh-odm/bot/state.json 后重启，会新建一个 Chief。',
    en: 'The Chief’s earlier conversation is missing or too old to resume. Back up and move aside .dsh-odm/bot/state.json, then restart — a new Chief will be created.',
  },
  credential: {
    zh: '模型 Key 没配好，[去设置](#setup)',
    en: 'Model key isn’t set up — [open Settings](#setup)',
  },
}
export function isCredentialOrModelError(err) {
  return /No model is available|没有可用的模型|MISSING_CREDENTIAL|no credential for provider|no API key for provider|Add one in Harness settings|UNSTORABLE_PROVIDER_ID/i.test(String(err || ''))
}
export function chatErrorHint(err, lang = 'zh') {
  const s = String(err || '')
  const pick = k => HINTS[k][lang === 'en' ? 'en' : 'zh']
  if (isCredentialOrModelError(s)) return pick('credential')
  if (/could not be read \(saved by a newer DS Bot/i.test(s)) return pick('newer')
  if (/no Main Bot/i.test(s)) return pick('noMain')
  if (/session "[^"]+" not found|v0 artifact|cannot safely transform/i.test(s)) return pick('stale')
  return ''
}

// A turn/end reason of kind "error" becomes the bare string "error", which hid the
// real MISSING_CREDENTIAL text already in diagnostics.jsonl. Prefer a specific diagnostic.
const GENERIC_TURN_ERROR = /^(error|fail|failed|failure|timeout|abort|aborted)$/i
export function resolveTurnError(turnError, diagnostic) {
  const a = String(turnError || '').trim()
  const b = String(diagnostic || '').trim()
  if (a && !GENERIC_TURN_ERROR.test(a)) return a
  return b || a
}

// A fresh team has no Chief until ds-bot's own 'state' endpoint bootstraps one; the Muse page never calls it,
// so the first chat on a new install failed with "no Main Bot". Ask ds-bot once, with the user's own session cookie.
// When a turn ends with no reply, ds-bot logged why (e.g. MISSING_CREDENTIAL) in bot/logs/diagnostics.jsonl.
export async function lastTurnError(dshHome, sessionId, sinceMs = 0) {
  try {
    const raw = await readFile(join(dshHome, 'bot', 'logs', 'diagnostics.jsonl'), 'utf8')
    const lines = raw.slice(-65536).split('\n').reverse()
    for (const line of lines) {
      let e; try { e = JSON.parse(line) } catch { continue }
      if (e?.level === 'error' && e.sessionId === sessionId && Number(e.time) >= sinceMs) return String(e.text || e.code || '')
    }
  } catch {}
  return ''
}

export async function bootstrapMainBot({ origin, cookie, fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  if (!origin || !cookie) return false
  try {
    const res = await fetchImpl(`${String(origin).replace(/\/$/, '')}/api/bot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ endpoint: 'state', payload: {} }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return false
    return !!(await res.json().catch(() => null))?.ok
  } catch { return false }
}

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

// Same call shape ds-bot uses: a live session must be paged through its current seq.
// sessionController.resolveAgent resolves to { agent } or { error }, not the agent itself.
async function liveAgent(ctx, sessionId) {
  const resolved = await ctx.sessionController.resolveAgent(sessionId).catch(() => undefined)
  return resolved && !('error' in resolved) ? (resolved.agent ?? resolved) : undefined
}

// session.seq is the next seq to assign; events already on the log are strictly older.
async function cursorSeq(ctx, sessionId) {
  try {
    const seq = Number((await liveAgent(ctx, sessionId))?.session?.seq)
    if (Number.isInteger(seq)) return seq - 1
  } catch { /* the prompt's request id still identifies its user message */ }
  return -1
}

const REPLY_PAGE = 80
// A turn's record count has no useful upper bound: dsh writes one `assistant/chunk` record per streamed
// delta (ui-feed.js), so one long reply is thousands of them. The reply wait therefore reads the whole
// turn — from the newest page back to the cursor taken before the prompt — instead of a fixed window.
// Pages and time bound one poll only; hitting either ends that poll, and the caller asks again.
const REPLY_TAIL_PAGES = 2
const REPLY_TURN_PAGES = 600
const REPLY_TURN_MS = 8000

function eventOf(record) {
  if (record?.event && typeof record.event === 'object') return record.event
  return record && typeof record === 'object' ? record : {}
}

function eventSeq(record) {
  const seq = eventOf(record).seq ?? record?.seq
  return Number.isInteger(seq) ? seq : null
}

function messageSource(ev) {
  const data = ev?.data || {}
  return data.source || data.message?.source || null
}

function messageText(ev) {
  const data = ev?.data || {}
  const msg = data.message || data
  return flattenContent(msg?.content ?? msg?.parts ?? data.content ?? msg?.text)
}

function messageParts(ev) {
  const data = ev?.data || {}
  const msg = data.message || data
  const content = msg?.content ?? msg?.parts ?? data.content
  return Array.isArray(content) ? content : []
}

// afterSeq < 0 keeps every record (a fresh part after a handoff). A known seq excludes the log from before this prompt.
function inWindow(record, afterSeq) {
  const seq = eventSeq(record)
  if (seq == null || afterSeq < 0) return true
  return seq > afterSeq
}

// An interrupted or blocked turn is resumed; its turn/end is not the answer. A disposed abort is the same.
function endsReply(reason) {
  if (reason == null || typeof reason !== 'object') return true
  if (reason.kind === 'interrupted' || reason.kind === 'blocked') return false
  if (reason.kind === 'aborted' && reason.reason?.kind === 'disposed') return false
  return true
}

function isForeignUser(ev, requestId, ownIds) {
  if (ev?.type !== 'user/message') return false
  const source = messageSource(ev)
  if (source?.kind !== 'user') return false
  if (requestId && source.rpcId === requestId) return false
  if (ownIds && source.rpcId && ownIds.has(source.rpcId)) return false
  return true
}

function indexByRpc(records, requestId, afterSeq) {
  for (let i = 0; i < records.length; i++) {
    if (!inWindow(records[i], afterSeq)) continue
    const ev = eventOf(records[i])
    if (ev.type === 'user/message' && messageSource(ev)?.rpcId === requestId) return i
  }
  return -1
}

function findPromptUser(records, { afterSeq, requestId, outbound, handoff }) {
  const wantId = String(requestId || '')
  if (wantId) {
    const hit = indexByRpc(records, wantId, afterSeq)
    if (hit >= 0) return hit
    // A handoff moves the same prompt onto a new part whose seq space starts over.
    if (handoff) {
      const any = indexByRpc(records, wantId, -1)
      if (any >= 0) return any
    }
  }
  const wantText = cleanBlock(outbound)
  if (!wantText) return -1
  for (let i = 0; i < records.length; i++) {
    if (!inWindow(records[i], afterSeq)) continue
    const ev = eventOf(records[i])
    if (ev.type !== 'user/message') continue
    const source = messageSource(ev)
    if (source?.kind && source.kind !== 'user') continue
    if (cleanBlock(messageText(ev)) === wantText) return i
  }
  return -1
}

/**
 * Assistant text for this prompt, once that turn has finished.
 * `afterSeq` is the last session seq before prompt(). `requestId` is that prompt's id
 * (ds-bot keeps it on the user message as source.rpcId). A later queued turn stays out of this result:
 * two rapid sends each keep the reply that followed their own user message.
 * `{ settled: false }` while the user message is still queued or its turn is open.
 * `{ settled: true, text }` when the turn finished (`text` empty when it finished without one).
 */
export function ownReplyFromRecords(records, { afterSeq = -1, requestId = '', outbound = '', handoff = false, ownIds = null } = {}) {
  const list = Array.isArray(records) ? records : []
  const userIdx = findPromptUser(list, { afterSeq, requestId, outbound, handoff })
  if (userIdx < 0) return { settled: false }
  // Steers admitted into this turn (chat lane) are not the next send. A steer that shows up only after
  // this turn already ended does not pull that later turn's text into this reply.
  const pending = ownIds && ownIds.size ? new Set(ownIds) : null
  let text = ''
  let closed = null
  for (let i = userIdx + 1; i < list.length; i++) {
    const ev = eventOf(list[i])
    const rpcId = messageSource(ev)?.rpcId
    if (pending && ev.type === 'user/message' && rpcId && pending.has(rpcId)) {
      if (closed != null) return { settled: true, text: closed }
      pending.delete(rpcId)
    }
    if (isForeignUser(ev, requestId, ownIds)) return { settled: true, text: closed != null ? closed : cleanBlock(text) }
    if (closed == null && ev.type === 'assistant/message') {
      const next = messageText(ev)
      if (next) text = next
    } else if (ev.type === 'turn/end' && endsReply(ev.data?.reason)) {
      if (pending && pending.size > 0) { closed = cleanBlock(text); continue }
      return { settled: true, text: cleanBlock(text) }
    }
  }
  return { settled: false }
}

/** Session / tool / assistant events that mean this turn is still doing work. */
export const TURN_ACTIVITY_RE = /^(turn\/start|assistant\/message|assistant\/chunk|text-chunks|tool\/call|tool\/result|llm\/retry|llm\/error|step\/start|step\/end)$/

export function sessionTurnOpen(records = []) {
  const types = records.map(r => eventOf(r).type)
  return types.lastIndexOf('turn/start') > types.lastIndexOf('turn/end')
}

function eventTimeOf(record) {
  const ev = eventOf(record)
  const t = Number(ev?.time ?? record?.time)
  return Number.isFinite(t) && t > 0 ? t : null
}

/**
 * Whether this prompt's turn (or the open turn it is queued behind) is still working.
 * Intermediate assistant / tool events count as activity. A stale diagnostics lastTurnError
 * from an earlier turn is not consulted here.
 */
export function turnWorkFromRecords(records, { afterSeq = -1, requestId = '', outbound = '', handoff = false, ownIds = null, agent = null } = {}) {
  const list = Array.isArray(records) ? records : []
  const reply = ownReplyFromRecords(list, { afterSeq, requestId, outbound, handoff, ownIds })
  const userIdx = findPromptUser(list, { afterSeq, requestId, outbound, handoff })
  let lastActivityAt = null, lastActivityType = null, ended = !!reply.settled, turnError = null
  const start = userIdx >= 0 ? userIdx : 0
  for (let i = start; i < list.length; i++) {
    const ev = eventOf(list[i])
    if (userIdx >= 0 && i > userIdx && isForeignUser(ev, requestId, ownIds)) { ended = true; break }
    if (TURN_ACTIVITY_RE.test(ev.type || '') || ev.type === 'user/message') {
      lastActivityAt = eventTimeOf(list[i]) ?? lastActivityAt
      lastActivityType = ev.type
    }
    if (userIdx >= 0 && i > userIdx) {
      if (ev.type === 'llm/error' || ev.type === 'error') {
        const msg = ev.data?.error || ev.data?.message || ev.data?.text
        if (msg) turnError = String(msg)
      }
      if (ev.type === 'turn/end' && endsReply(ev.data?.reason)) {
        const reason = ev.data?.reason
        if (reason && /timeout|error|fail/i.test(JSON.stringify(reason))) {
          turnError = turnError || reason.message || (reason.kind && reason.kind !== 'completed' ? String(reason.kind) : null)
        }
        ended = true
        break
      }
    }
  }
  const open = userIdx >= 0 && !reply.settled && !ended
  const queuedBehind = userIdx < 0 && !reply.settled && (agent?.status === 'running' || sessionTurnOpen(list))
  const working = !reply.settled && (open || queuedBehind || agent?.status === 'running' || sessionTurnOpen(list))
  return {
    settled: !!reply.settled, text: reply.text, found: userIdx >= 0, open, ended, working,
    lastActivityAt, lastActivityType, turnError,
  }
}

export const NO_REPLY_ERROR = 'Bot 没有产生新回复'
export const SILENT_TURN_ERROR = '这次对话没有新的动静，也没有完成的回复'

// Newest page first, then older pages until this prompt's cursor is on the page. One huge tool turn
// or one long streamed reply would otherwise push the user message out of the tail the reply is read from.
// `afterSeq < 0` is an unread cursor (a fresh part after a handoff): read that tail only.
async function pageEvents(ctx, sessionId, afterSeq) {
  const live = Number((await liveAgent(ctx, sessionId))?.session?.seq)
  const throughSeq = Number.isInteger(live) && live > 0 ? live - 1 : -1
  const chunks = []
  const startedAt = Date.now()
  let beforeSeq
  const cap = afterSeq >= 0 ? REPLY_TURN_PAGES : REPLY_TAIL_PAGES
  for (let n = 0; n < cap; n++) {
    const page = await ctx.sessionController.page({
      address: { kind: 'session', sessionId },
      throughSeq,
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
      maxMessages: REPLY_PAGE,
    }, AbortSignal.timeout(15_000))
    const records = page?.records || page?.items || []
    chunks.unshift(records)
    if (!page?.hasMore || records.length === 0) break
    const oldest = eventSeq(records[0])
    if (oldest == null || oldest === beforeSeq) break
    if (afterSeq >= 0 && oldest <= afterSeq) break
    if (Date.now() - startedAt >= REPLY_TURN_MS) break
    beforeSeq = oldest
  }
  return chunks.flat()
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
 * Prompt Chief and wait for the assistant reply that belongs to this prompt.
 * A second send queued during this turn is its own turn; this call returns when this turn
 * finishes, with this turn's text, while that later turn is still running.
 */
export async function runMuseChatTurn(ctx, {
  message,
  cardId = null,
  cardContext = null,
  viewContext = '',
  hiddenContext = '', // model-only instructions (not shown in the user's bubble)
  doneContext = '', // 【刚处理完】 recent sent replies / closed cards (server-built)
  attachments = null, // [{kind:'image'|'file', mediaType?, name, data: base64}]
  dshHome,
  botId = null,
  log = () => {},
  timing = null,
  onSession = null, // (sessionId) → the UI feed streams this turn's text / tool progress
  lane = null, // chat-lane hooks: lets a follow-up message steer into this turn while it is unanswered
  display = null, // chat-display store: what the user's bubbles show for this prompt (history rehydrate)
  displayItems = null, // [{ text, attachments }] — one per user bubble (a merged turn stands for several)
  waitMs = 180_000,
} = {}) {
  const text = clean(message)
  const hasAttach = Array.isArray(attachments) && attachments.length > 0
  if (!text && !hasAttach) return { ok: true, text: '想问哪一类？可以说邮件、PR、或改一张 Today 卡片；也可以贴图 / 传文件 / 按住麦克风说话。', status: 'answered', botId: null }

  const T = timing || {}
  T.turnCallAt = Date.now()
  let outbound = text || (hasAttach ? '请看我附上的内容。' : '')
  const hiddenText = hiddenContext ? cleanBlock(hiddenContext).slice(0, 3200) : ''
  if (hiddenText) outbound = `${hiddenText}\n\n${outbound}`
  // Server-built snapshots already start with 【当前卡片】 and keep their line structure.
  const ctxText = cardContext ? cleanBlock(cardContext).slice(0, 3200) : ''
  if (ctxText) outbound = `${ctxText.startsWith('【当前卡片】') ? ctxText : `【当前卡片】${ctxText}`}\n\n${outbound}`
  else if (cardId) outbound = `【cardId=${cardId}】\n${outbound}`
  // 【当前视图】 goes first (page / filter / open card / visible cards), then 【当前卡片】, then the user's words.
  const viewText = viewContext ? cleanBlock(viewContext).slice(0, 900) : ''
  if (viewText) outbound = `${viewText.startsWith('【当前视图】') ? viewText : `【当前视图】${viewText}`}\n\n${outbound}`
  const doneText = doneContext ? cleanBlock(doneContext).slice(0, 1200) : ''
  if (doneText) outbound = `${doneText}\n\n${outbound}`
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
  const requestId = randomUUID()
  try { display?.record(requestId, displayItems || [{ text: message, attachments: hasAttach ? attachments : [] }]) } catch (err) { log(`[muse-chat] display record failed: ${err.message}`) }
  // Cursor before prompt, so this call only claims a user message it caused.
  let afterSeq = await cursorSeq(ctx, sessionId)
  T.beforeReadMs = Date.now() - T.turnCallAt
  const preview = built.content.find(p => p.type === 'text')?.text || ''
  log(`[muse-chat] prompt → ${sessionId}: ${preview.slice(0, 80)} attach=${built.meta.length}/${built.mode}`)
  T.promptAt = Date.now()
  // One request id for the send and a text-fallback retry, so the wait still finds this prompt.
  const sendPrompt = async (content) => ctx.sessionController.prompt({
    requestId,
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
  // A steered follow-up joins this turn. Accept the reply only from a poll that started after the last
  // steer was admitted, and key that reply to this prompt — not to whichever assistant text is newest.
  const steerIds = new Set()
  let steeredAt = 0
  let pendingSteers = 0
  if (lane?.setSteer) {
    lane.setSteer(async (more) => {
      const steerId = randomUUID()
      steerIds.add(steerId)
      try { display?.record(steerId, [{ text: more }]) } catch {}
      steeredAt = Date.now()
      pendingSteers++
      try {
        await ctx.sessionController.prompt({
          requestId: steerId,
          sessionId: promptTo,
          mode: 'steer',
          content: [{ type: 'text', text: `${STEER_NOTE}\n${more}` }],
        }, AbortSignal.timeout(30_000))
        T.steered = (T.steered || 0) + 1
        steeredAt = Date.now()
      } finally { pendingSteers-- }
    })
  }
  // waitMs is a silence budget, not a wall-clock cap. While the turn is open, the agent is
  // running, or intermediate assistant / tool events keep arriving, keep waiting.
  const budget = Number.isFinite(waitMs) && waitMs > 0 ? waitMs : 180_000
  let reply = ''
  let endedEmpty = false
  let turnError = null
  let lastWorkAt = Date.now()
  let pageErrLogged = false
  for (;;) {
    const checkAt = Date.now()
    const now = (await resolveChief(dshHome, promptTo)).sessionId
    if (now && now !== sessionId) {
      log(`[muse-chat] Chief moved on to a new part: ${now}`)
      sessionId = now
      T.handoff = true
      afterSeq = await cursorSeq(ctx, sessionId)
      try { onSession?.(now) } catch {}
    }
    let work = { working: false, settled: false }
    let agent = null
    try {
      T.polls = (T.polls || 0) + 1
      const records = await pageEvents(ctx, sessionId, afterSeq)
      agent = await liveAgent(ctx, sessionId)
      // Read this prompt's turn even while a later queued turn is still running.
      // whenIdle stays pending until that later turn finishes, so it is only a wake-up.
      work = turnWorkFromRecords(records, { afterSeq, requestId, outbound, handoff: T.handoff === true, ownIds: steerIds, agent })
      if (work.working) lastWorkAt = Date.now()
      else if (work.lastActivityAt) lastWorkAt = Math.max(lastWorkAt, work.lastActivityAt)
      if (work.turnError) turnError = work.turnError
      if (work.settled && pendingSteers === 0 && (!steeredAt || checkAt > steeredAt)) {
        reply = work.text || ''
        endedEmpty = !reply
        if (work.turnError) turnError = work.turnError
        lane?.closeSteer?.()
        break
      }
    } catch (err) {
      if (!pageErrLogged) { pageErrLogged = true; log(`[muse-chat] page failed: ${err?.message || err}`) }
    }
    if (!work.working && Date.now() - lastWorkAt >= budget) break
    if (!agent) try { agent = await liveAgent(ctx, sessionId) } catch {}
    if (agent?.status === 'running' && typeof agent.whenIdle === 'function') {
      await Promise.race([agent.whenIdle(), new Promise(r => setTimeout(r, 400))])
    } else {
      await new Promise(r => setTimeout(r, 400))
    }
  }

  lane?.closeSteer?.()
  if (!reply) {
    // Only a diagnostic logged after this turn started, and only once the turn has ended
    // (or this-turn records already named an error). Never reuse an earlier lastTurnError
    // while the bot is still working, and never present a still-open turn as "no reply".
    const why = endedEmpty || turnError
      ? resolveTurnError(turnError, await lastTurnError(dshHome, sessionId, T.turnCallAt || T.promptAt || 0))
      : ''
    const code = endedEmpty ? 'no_reply' : (why ? 'turn_error' : 'silent')
    const error = endedEmpty ? (why || NO_REPLY_ERROR) : (why || SILENT_TURN_ERROR)
    return { ok: false, error, code, botId: sessionId, sessionId }
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
    steered: T.steered ?? 0,
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
  [/^odm_github_|^odm_act_github_/, { zh: '正在查 GitHub…', en: 'Checking GitHub…' }],
  [/^odm_gmail_|^odm_act_gmail_/, { zh: '正在查邮件…', en: 'Checking mail…' }],
  [/^odm_slack_|^odm_act_slack_/, { zh: '正在查 Slack…', en: 'Checking Slack…' }],
  [/^odm_(card|current_card|today|completions)/, { zh: '正在看卡片…', en: 'Looking at the card…' }],
  [/^odm_digest/, { zh: '正在重新汇聚…', en: 'Refreshing Today…' }],
  [/^bash$/, { zh: '正在跑命令…', en: 'Running a command…' }],
  [/^web_fetch|^web_search/, { zh: '正在查网页…', en: 'Checking the web…' }],
]
const locOf = (lang) => (String(lang || '').startsWith('en') ? 'en' : 'zh')
export function progressLabel(name, lang = 'zh') {
  const loc = locOf(lang)
  for (const [re, label] of TOOL_LABEL) if (re.test(name || '')) return label[loc] || label.zh
  if (!name) return loc === 'en' ? 'Douya is still working…' : '豆芽正在想…'
  return loc === 'en' ? `Calling ${String(name).replace(/^odm_/, '')}…` : `正在调用 ${String(name).replace(/^odm_/, '')}…`
}

/** What Chief is doing right now (for the 豆芽正在想… / still-working indicator). */
export async function chatProgress(ctx, { dshHome, botId = null, lang = 'zh' } = {}) {
  const { sessionId } = await resolveChief(dshHome, botId)
  if (!sessionId || !ctx?.sessionController?.page) return { running: false }
  const { agent, records } = await tailRecords(ctx, sessionId, 8)
  const types = records.map(r => r.type)
  const running = agent?.status === 'running' || types.lastIndexOf('turn/start') > types.lastIndexOf('turn/end')
  if (!running) return { running: false }
  const loc = locOf(lang)
  const thinking = loc === 'en' ? 'Douya is still working…' : '豆芽正在想…'
  let label = thinking, tools = 0
  const lastStart = types.lastIndexOf('turn/start')
  for (const r of records.slice(Math.max(0, lastStart))) {
    if (r.type === 'tool/call') { tools++; label = progressLabel(r.data?.name, lang) }
    else if (r.type === 'tool/result') label = thinking
    else if (r.type === 'llm/retry') label = loc === 'en' ? 'The model is slow; retrying…' : '模型响应慢，正在重试…'
    else if (/text-chunks|assistant\/chunk/.test(r.type || '') && label === thinking) label = loc === 'en' ? 'Writing a reply…' : '正在写回复…'
  }
  return { running: true, label, tools }
}

// ---- Dock transcript after a reload (issue #109) -------------------------------------------
// The Muse dock used to rebuild its transcript from the session log file (dsbot-chat.js), which
// only knows the pre-v4 file name. Read the same records the turn reads, in process.

const HISTORY_INJECTED = /^(\[Handoff · part \d+\]|Current runtime context\.|<system-reminder>|Current time: \d{4}-)/
const HISTORY_CTX = /^【(当前视图|当前卡片|刚处理完|cardId=)/
// A follow-up steered into an open turn is stored with the lane's note in front of the user's sentence.
const STEER_PREFIX = /^（(?:补充一条|我连续发了几条消息)[^）]*）\s*/
const ATTACH_PLACEHOLDER = '请看我附上的内容。'

/**
 * The owner's own words: peel off the model-only context the turn prepends (view / card / done),
 * the steer note a merged follow-up carries, and the attachment note after the words. Keep the rest whole.
 */
function ownerText(raw) {
  const text = String(raw || '').trim().replace(STEER_PREFIX, '')
  if (!HISTORY_CTX.test(text)) return cleanBlock(stripAttachNote(text))
  const paras = text.split(/\n\s*\n/)
  while (paras.length > 1 && HISTORY_CTX.test(paras[0].trim())) paras.shift()
  if (paras.length === 1 && HISTORY_CTX.test(paras[0].trim())) return ''
  return cleanBlock(stripAttachNote(paras.join('\n\n')))
}

/**
 * Session records → the transcript the dock shows: one bubble per owner prompt, and one per turn's
 * last assistant text (what the live bubble showed). Team relays, runtime context and clock
 * injections are not the owner's words, so they stay out.
 */
export function historyFromRecords(records, { limit = 40, display = null } = {}) {
  const out = []
  let open = false     // the owner prompt whose turn is still the current one
  let replyIdx = -1    // index in `out` of this turn's assistant bubble
  for (const record of Array.isArray(records) ? records : []) {
    const ev = eventOf(record)
    if (ev.type === 'user/message') {
      const source = messageSource(ev)
      const text = messageText(ev)
      // ds-bot and plugins append model-only context (runtime-context, skill-catalog, time-context,
      // plugin:openviking-memory, …) as user/message records around the owner's prompt. Only an owner prompt
      // or a Bot relay starts a new turn; anything else must not close the reply.
      if (source?.kind !== 'user' && source?.kind !== 'bot') continue
      open = false; replyIdx = -1
      if (source?.kind !== 'user') continue
      const at = Number.isFinite(ev.time) ? { at: new Date(ev.time).toISOString() } : {}
      // What the user saw when they sent it: their words plus attachment chips, never the prompt's
      // model-only context. ds-bot keeps the prompt request id on the message as source.rpcId.
      const shown = typeof display?.lookup === 'function' ? display.lookup(source.rpcId) : null
      if (Array.isArray(shown) && shown.length) {
        const bubbles = shown
          .map(it => ({ text: cleanBlock(it?.text), attachments: Array.isArray(it?.attachments) ? it.attachments : [] }))
          .filter(b => b.text || b.attachments.length)
        for (const b of bubbles) out.push({ role: 'user', content: b.text, ...(b.attachments.length ? { attachments: b.attachments } : {}), ...at })
        open = bubbles.length > 0
        continue
      }
      // No display record (a Session from before it, or a relayed prompt): rebuild from the record.
      const attachments = legacyAttachments(messageParts(ev), text)
      const peeled = ownerText(text)
      const words = clean(peeled) === ATTACH_PLACEHOLDER && attachments.length ? '' : peeled
      if (HISTORY_INJECTED.test(clean(words))) continue
      if (!clean(words) && !attachments.length) continue
      out.push({ role: 'user', content: words, ...(attachments.length ? { attachments } : {}), ...at })
      open = true
      continue
    }
    if (ev.type === 'assistant/message' && open) {
      const text = messageText(ev)
      if (!clean(text)) continue
      const at = Number.isFinite(ev.time) ? { at: new Date(ev.time).toISOString() } : {}
      if (replyIdx >= 0) out[replyIdx] = { role: 'assistant', content: text, ...at }
      else { out.push({ role: 'assistant', content: text, ...at }); replyIdx = out.length - 1 }
    }
    // A completed turn closes the bubble; an interrupted / blocked one is resumed, so its later
    // assistant text is still this turn's answer (the same rule ownReplyFromRecords uses).
    if (ev.type === 'turn/end' && endsReply(ev.data?.reason)) { open = false; replyIdx = -1 }
  }
  return out.slice(-limit)
}

/** The tail of one Session's records, newest page first, oldest-first when returned. */
async function pageTail(ctx, sessionId, { maxMessages = 80, pages = 2 } = {}) {
  const chunks = []
  let beforeSeq
  for (let n = 0; n < pages; n++) {
    let throughSeq = -1
    try {
      const seq = Number((await liveAgent(ctx, sessionId))?.session?.seq)
      if (Number.isInteger(seq) && seq > 0) throughSeq = seq - 1
    } catch { /* fall back to the tail */ }
    const page = await ctx.sessionController.page({
      address: { kind: 'session', sessionId },
      throughSeq,
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
      maxMessages,
    }, AbortSignal.timeout(10_000))
    const records = page?.records || page?.items || []
    chunks.unshift(records)
    if (!page?.hasMore || records.length === 0) break
    const oldest = eventSeq(records[0])
    if (oldest == null || oldest === beforeSeq) break
    beforeSeq = oldest
  }
  return chunks.flat()
}

/** GET /api/chat/history for the Muse host: the Chief's transcript, read in this process. */
export async function loadMuseHistory(ctx, { dshHome, botId = null, limit = 40, display = null } = {}) {
  const chief = await resolveChief(dshHome, botId)
  const parts = (chief.parts?.length ? chief.parts : [chief.botId]).filter(Boolean)
  if (!parts.length || !ctx?.sessionController?.page) return { sessionId: chief.sessionId || null, botId: chief.botId || null, messages: [] }
  const messages = []
  for (const part of parts.slice(-2)) {
    try {
      messages.push(...historyFromRecords(await pageTail(ctx, part), { limit, display }))
    } catch { /* one unreadable part (a retired Session) must not empty the transcript */ }
  }
  return { sessionId: chief.sessionId || null, botId: chief.botId || null, messages: messages.slice(-limit) }
}
