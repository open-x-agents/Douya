// In-process turn against ds-bot Chief via sessionController (same dsh process).

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

function clean(v) { return String(v ?? '').replace(/\s+/g, ' ').trim() }

function flattenContent(content) {
  if (typeof content === 'string') return clean(content)
  if (!Array.isArray(content)) return ''
  return clean(content.map(p => (typeof p === 'string' ? p : (p?.type && p.type !== 'text') ? '' : p?.text || '')).join(''))
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
  return lastAssistantText(page?.records || page?.items || [])
}

/**
 * Prompt Chief and wait for a new assistant reply.
 */
export async function runMuseChatTurn(ctx, {
  message,
  cardId = null,
  cardContext = null,
  dshHome,
  botId = null,
  log = () => {},
} = {}) {
  const text = clean(message)
  if (!text) return { ok: true, text: '想问哪一类？可以说邮件、PR、或改一张 Today 卡片。', status: 'answered', botId: null }

  let outbound = text
  if (cardContext) outbound = `【当前卡片】${clean(cardContext).slice(0, 1200)}\n\n${text}`
  else if (cardId) outbound = `【cardId=${cardId}】\n${text}`

  const sessionId = botId || await loadMainBotId(dshHome)
  if (!sessionId) return { ok: false, error: 'no Main Bot' }
  if (!ctx?.sessionController?.prompt) return { ok: false, error: 'sessionController missing' }

  // Snapshot previous assistant text if page works.
  let before = ''
  try {
    before = await readLastReply(ctx, sessionId, log)
  } catch (err) { log(`[muse-chat] page(before) failed: ${err?.message || err}`) }

  log(`[muse-chat] prompt → ${sessionId}: ${outbound.slice(0, 80)}`)
  await ctx.sessionController.prompt({
    requestId: randomUUID(),
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: outbound }],
  }, AbortSignal.timeout(30_000))

  const deadline = Date.now() + 120_000
  let reply = ''
  let pageErrLogged = false
  while (Date.now() < deadline) {
    const agent = await liveAgent(ctx, sessionId)
    if (agent?.status === 'running' && typeof agent.whenIdle === 'function') {
      await Promise.race([agent.whenIdle(), new Promise(r => setTimeout(r, 8_000))])
    } else if (agent?.status === 'running') {
      await new Promise(r => setTimeout(r, 500))
      continue
    }
    try {
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
  log(`[muse-chat] reply: ${reply.slice(0, 120)}`)
  return {
    ok: true,
    text: reply,
    status: 'answered',
    botId: sessionId,
    sessionId,
    citations: [],
    cards: [],
  }
}
