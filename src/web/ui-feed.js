// 豆芽 UI event feed (Intelligent UI P3): one Server-Sent Events stream per open tab, on the dsh connection.
// Modeled on vendor/ds-bot/src/host/feed.js.
//   hello     { bootId, seq, resync }        — then every durable event after ?since=seq is replayed
//   ui        durable view events (op / surface / suggest / cards), each with its seq — lossless across reconnects
//   ui (ephemeral) the reply being written: { kind:'stream', turn, attemptId, phase|text },
//             tool progress { kind:'progress', turn, label }, and a skeleton { kind:'skeleton', turn, title }
//             the moment Chief calls odm_ui_render. Ephemeral events are never replayed: the final reply still
//             comes from the session record (/api/chat), so a dropped delta never loses text.
// In standard-server mode there is no feed; the page keeps the long-poll on /api/opendigitalmate/ui-events.

import { progressLabel } from './muse-chat-core.js'

export const UI_FEED_ROUTE = '/api/opendigitalmate/ui-feed'
const KEEPALIVE_MS = 20_000
const MAX_QUEUED = 512
const DELTA_FLUSH_MS = 40 // coalesce token deltas a little; still well under one frame of reading time
const clip = (v, n) => String(v ?? '').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n)

/** Which Chief Sessions belong to which in-flight dock / card-chat turn. */
export function createTurnWatch() {
  const bySession = new Map() // sessionId → turn
  return {
    watch(sessionId, turn) { if (sessionId && turn) bySession.set(sessionId, turn) },
    unwatch(turn) { for (const [s, t] of bySession) if (t === turn) bySession.delete(s) },
    turnOf(sessionId) { return bySession.get(sessionId) || null },
    get size() { return bySession.size },
  }
}

/** Pure mapping from host events to ephemeral UI events (unit-tested). */
export function streamEvent(turn, frame) {
  if (!turn || !frame) return null
  if (frame.type === 'start') return { kind: 'stream', turn, attemptId: frame.attemptId, phase: 'start' }
  if (frame.type === 'chunk' && frame.chunk?.type === 'text-delta' && frame.chunk.text) return { kind: 'stream', turn, attemptId: frame.attemptId, text: String(frame.chunk.text) }
  if (frame.type === 'end') return { kind: 'stream', turn, attemptId: frame.attemptId, phase: 'end' }
  return null
}
export function sessionEvent(turn, event) {
  if (!turn || !event) return []
  if (event.type === 'tool/call') {
    const name = event.data?.name
    const out = [{ kind: 'progress', turn, label: name === 'odm_ui_render' ? '正在生成视图…' : progressLabel(name) }]
    if (name === 'odm_ui_render') {
      const args = event.data?.arguments || event.data?.input || {}
      out.push({ kind: 'skeleton', turn, title: clip(args.title, 60) || '视图', placement: args.placement === 'panel' ? 'panel' : 'chat' })
    }
    return out
  }
  if (event.type === 'tool/result') return [{ kind: 'progress', turn, label: '豆芽正在想…' }]
  if (event.type === 'llm/retry') return [{ kind: 'progress', turn, label: '模型响应慢，正在重试…' }]
  return []
}

export function installUiFeed(ctx, { uiService, effect, log = () => {} }) {
  const turns = createTurnWatch()
  const encoder = new TextEncoder()
  const stats = { deltas: 0, starts: 0, tools: 0, clients: 0 }

  // Coalesced text deltas per attempt.
  const pending = new Map() // attemptId → { ev, timer }
  const flush = (id) => { const p = pending.get(id); if (!p) return; pending.delete(id); clearTimeout(p.timer); uiService.pulse(p.ev) }
  const onStream = ({ agent, frame } = {}) => {
    const turn = turns.turnOf(agent?.id)
    const ev = streamEvent(turn, frame)
    if (!ev) return
    if (ev.text) {
      stats.deltas++
      const p = pending.get(ev.attemptId)
      if (p) { p.ev.text += ev.text; return }
      pending.set(ev.attemptId, { ev, timer: setTimeout(() => flush(ev.attemptId), DELTA_FLUSH_MS) })
      return
    }
    flush(ev.attemptId)
    if (ev.phase === 'start') stats.starts++
    uiService.pulse(ev)
  }
  const onSession = (session, event) => {
    const turn = turns.turnOf(session?.id)
    if (!turn) return
    for (const ev of sessionEvent(turn, event)) { if (ev.kind === 'progress') stats.tools++; uiService.pulse(ev) }
  }
  if (typeof ctx?.on === 'function') {
    ctx.on('agent/assistant-stream', onStream)
    ctx.on('session/event', onSession)
  } else log('ui-feed: ctx.on missing — no streaming (the page falls back to whole replies)')

  effect({
    path: UI_FEED_ROUTE,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const url = new URL(request.url, 'http://x')
      const since = Number(url.searchParams.get('since')) || 0
      const boot = url.searchParams.get('boot') || null
      let controller, off = () => {}
      let open = true
      const leave = () => { if (!open) return; open = false; off(); stats.clients--; try { controller.close() } catch {} }
      const send = (event, data) => {
        if (!open) return
        if ((controller.desiredSize ?? 0) < -MAX_QUEUED) return leave()
        try { controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)) } catch { leave() }
      }
      const body = new ReadableStream({
        start(own) {
          controller = own
          stats.clients++
          const b = uiService.backlog({ since, boot })
          send('hello', { bootId: b.bootId, seq: b.seq, resync: b.resync })
          for (const e of b.events) send('ui', e)
          off = uiService.subscribe(e => send('ui', e))
        },
        cancel() { leave() },
      })
      request.signal?.addEventListener?.('abort', leave, { once: true })
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } })
    },
  }, 'opendigitalmate: ui-feed')

  const keepalive = setInterval(() => uiService.pulse({ kind: 'keepalive' }), KEEPALIVE_MS)
  keepalive.unref?.()
  log('ui-feed: installed (SSE + assistant-stream)')
  return { turns, stats }
}
