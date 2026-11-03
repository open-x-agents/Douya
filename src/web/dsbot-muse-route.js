// In-process Muse ↔ ds-bot bridge registered on the dsh connection.
// FlyBot's ds-bot build has `send` but no `chat` page endpoint, so we prompt
// through sessionController and read the reply from the session page.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

function clean(v) { return String(v ?? '').replace(/\s+/g, ' ').trim() }

function flattenContent(content) {
  if (typeof content === 'string') return clean(content)
  if (!Array.isArray(content)) return ''
  return clean(content.map(p => (typeof p === 'string' ? p : p?.text || '')).join(''))
}

async function loadMainBotId(dshHome) {
  const path = join(dshHome, 'bot', 'state.json')
  try {
    const state = JSON.parse(await readFile(path, 'utf8'))
    return state.mainBotId || state.mainBotIds?.[0] || Object.keys(state.bots || {})[0] || null
  } catch {
    return null
  }
}

function lastAssistantText(records = []) {
  for (let i = records.length - 1; i >= 0; i--) {
    const ev = records[i]?.event || records[i]
    const msg = ev?.message || ev
    const role = msg?.role || msg?.info?.role
    if (role === 'assistant' || role === 'model') {
      const text = flattenContent(msg.content || msg.parts || msg.text)
      if (text) return text
    }
    // Some event shapes nest differently
    if (ev?.type === 'message' && (ev.role === 'assistant' || ev.message?.role === 'assistant')) {
      const text = flattenContent(ev.message?.content || ev.content)
      if (text) return text
    }
  }
  return ''
}

/**
 * Register POST /api/opendigitalmate/muse-chat on the dsh connection.
 */
export function installMuseChatRoute(ctx, { dshHome, log = () => {} } = {}) {
  const register = ctx?.connection?.fetch?.register
  if (typeof ctx?.effect !== 'function' || typeof register !== 'function') return false
  if (!ctx.sessionController?.prompt || !ctx.sessionController?.resolveAgent) {
    log('muse-chat: sessionController missing')
    return false
  }

  ctx.effect(() => register({
    path: '/api/opendigitalmate/muse-chat',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const body = await request.json().catch(() => ({}))
        const text = clean(body.message || body.text)
        if (!text) {
          return Response.json({ ok: false, error: 'empty message' }, { status: 400 })
        }
        let outbound = text
        if (body.cardContext) outbound = `【当前卡片】${clean(body.cardContext).slice(0, 1200)}\n\n${text}`
        else if (body.cardId) outbound = `【cardId=${body.cardId}】\n${text}`

        const botId = body.botId || await loadMainBotId(dshHome)
        if (!botId) {
          return Response.json({ ok: false, error: 'no Main Bot' }, { status: 503 })
        }

        // Bot id is also the chat session id for the current part in ds-bot.
        const sessionId = botId
        log(`[muse-chat] prompt → ${sessionId}: ${outbound.slice(0, 80)}`)

        await ctx.sessionController.prompt({
          requestId: randomUUID(),
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: outbound }],
        }, AbortSignal.timeout(30_000))

        // Wait until the agent is idle.
        const deadline = Date.now() + 120_000
        let agent
        while (Date.now() < deadline) {
          agent = await ctx.sessionController.resolveAgent(sessionId).catch(() => undefined)
          if (!agent) break
          if (agent.status !== 'running') break
          if (typeof agent.whenIdle === 'function') {
            await Promise.race([
              agent.whenIdle(),
              new Promise(r => setTimeout(r, 5_000)),
            ])
            break
          }
          await new Promise(r => setTimeout(r, 400))
        }

        // Read recent messages from the session page.
        let reply = ''
        try {
          const page = await ctx.sessionController.page({
            address: { kind: 'session', sessionId },
            maxMessages: 30,
          }, AbortSignal.timeout(15_000))
          const records = page?.records || page?.items || []
          reply = lastAssistantText(records)
          if (!reply && Array.isArray(page?.messages)) {
            for (let i = page.messages.length - 1; i >= 0; i--) {
              const m = page.messages[i]
              if (m.role === 'assistant' || m.role === 'model') {
                reply = flattenContent(m.content)
                if (reply) break
              }
            }
          }
        } catch (err) {
          log(`[muse-chat] page failed: ${err.message}`)
        }

        if (!reply) reply = '（Bot 已处理，但没有读到文本回复）'
        log(`[muse-chat] reply: ${reply.slice(0, 120)}`)
        return Response.json({
          ok: true,
          text: reply,
          status: 'answered',
          botId,
          sessionId,
          citations: [],
          cards: [],
        })
      } catch (err) {
        log(`[muse-chat] error: ${err.message}`)
        return Response.json({ ok: false, error: err.message }, { status: 500 })
      }
    },
  }), 'opendigitalmate: muse-chat')

  return true
}
