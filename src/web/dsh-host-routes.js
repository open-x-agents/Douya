// Register Muse UI + all /api/* routes on the dsh connection (same process as ds-bot).

import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runMuseChatTurn, chatProgress, loadLiveDockHistory } from './muse-chat-core.js'
import { MIME_OF_EXT } from './chat-display.js'
import { createChatLane } from './chat-lane.js'
import { installUiFeed } from './ui-feed.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLIENT_HTML = join(__dirname, '../client/index.html')
const UI_RENDERER = join(__dirname, '../client/ui-renderer.js')

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function hourParam(request) {
  try { const h = new URL(request.url, 'http://x').searchParams.get('hour'); return h !== null && /^\d{1,2}$/.test(h) ? Number(h) : null } catch { return null }
}

async function readJson(request) {
  try { return await request.json() } catch { return {} }
}

/**
 * @param {object} ctx
 * @param {{ router: object, dshHome: string, log?: Function }} opts
 */
export function registerMuseHostRoutes(ctx, { router, dshHome, log = () => {} } = {}) {
  const register = ctx?.connection?.fetch?.register
  if (typeof ctx?.effect !== 'function' || typeof register !== 'function' || !router) {
    log('dsh-host-routes: connection/router missing')
    return false
  }

  const effect = (route, label) => {
    const inner = route.fetch
    const safe = {
      ...route,
      fetch: async (request, ...rest) => {
        try {
          return await inner(request, ...rest)
        } catch (err) {
          log(`${label} error: ${err?.stack || err}`)
          return json({ ok: false, error: String(err?.message || err) }, 500)
        }
      },
    }
    ctx.effect(() => register(safe), label)
  }

  // Live UI feed (SSE): durable view events + this turn's text deltas, tool progress and view skeletons.
  let feed = null
  try { feed = installUiFeed(ctx, { uiService: router.uiServiceRef(), effect, log }) } catch (err) { log(`ui-feed install failed: ${err?.message || err}`) }

  // Primary Muse UI (replaces stock dsh frontend via client redirect).
  effect({
    path: '/api/opendigitalmate/app',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      const html = await readFile(CLIENT_HTML, 'utf8')
      return new Response(html, {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        },
      })
    },
  }, 'opendigitalmate: muse app')

  effect({
    path: '/api/today',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => json(await router.getToday({ hour: hourParam(request) })),
  }, 'opendigitalmate: /api/today')

  effect({
    path: '/api/digest',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => json(await router.getDigest()),
  }, 'opendigitalmate: /api/digest')

  effect({
    path: '/api/digest/generate',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => { const m = new URL(request.url).searchParams.get('mode'); return json(await router.generateDigestNow({ mode: m === 'legacy' || m === 'bot' ? m : null })) },
  }, 'opendigitalmate: /api/digest/generate')

  effect({
    path: '/api/cards',
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      if (request.method === 'GET') return json(await router.listCards())
      return json(await router.createCard(await readJson(request)))
    },
  }, 'opendigitalmate: /api/cards')

  // Note: dsh exact routes don't support :id params — use query or a fixed path with body.id
  effect({
    path: '/api/opendigitalmate/card-update',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readJson(request)
      return json(await router.updateCard(body.id, body))
    },
  }, 'opendigitalmate: card-update')

  effect({
    path: '/api/opendigitalmate/card-delete',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readJson(request)
      return json(await router.deleteCard(body.id))
    },
  }, 'opendigitalmate: card-delete')

  effect({
    path: '/api/opendigitalmate/card-interact',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readJson(request)
      return json(await router.trackCardInteraction(body.id, body.action, Array.isArray(body.items) ? body.items : (body.itemUrl || null), body.itemTitle || ''))
    },
  }, 'opendigitalmate: card-interact')

  // Only the signed-in owner's browser reaches this (dsh owner auth); bot tools have no confirm.
  effect({
    path: '/api/opendigitalmate/actions',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try { return json(await router.actionsOp(await readJson(request))) }
      catch (err) { return json({ success: false, error: err.message }) }
    },
  }, 'opendigitalmate: actions')

  // 豆芽 Intelligent UI: view events for open tabs (long-poll), the owner's own view ops (撤销 / 固定), and the
  // browser's report of what it shows. Bot ops come in through the odm_ui_op tool, never through these.
  effect({
    path: '/api/opendigitalmate/ui-events',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const q = new URL(request.url).searchParams
      return json(await router.uiEvents({ since: q.get('since'), boot: q.get('boot'), wait: q.get('wait') ?? 25000 }))
    },
  }, 'opendigitalmate: ui-events')

  effect({
    path: '/api/opendigitalmate/ui-op',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => json(await router.uiOp(await readJson(request), { by: 'user' })),
  }, 'opendigitalmate: ui-op')

  // 今天 time-of-day order on / off (the user's switch on the page).
  effect({
    path: '/api/opendigitalmate/layout-pref',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => json(await router.setAutoLayout(await readJson(request))),
  }, 'opendigitalmate: layout-pref')

  effect({
    path: '/api/opendigitalmate/digest-status',
    methods: ['GET'],
    fetch: async () => json(router.digestStatus()),
  }, 'opendigitalmate: digest-status')

  effect({
    path: '/api/opendigitalmate/digest-compare',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async () => json(await router.compareDigest()),
  }, 'opendigitalmate: digest-compare')

  effect({
    path: '/api/opendigitalmate/digest-mode',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => json(await router.setDigestMode(await readJson(request))),
  }, 'opendigitalmate: digest-mode')

  effect({
    path: '/api/opendigitalmate/digest-pref',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const b = await readJson(request); const st = router.botDigestRef()?.store
      if (!st) return json({ success: false, error: 'bot digest unavailable' })
      if (b?.remove) return json({ success: st.removePref(String(b.remove)) })
      return json({ success: !!st.addPref(b?.text, { channel: b?.channel || null, by: 'user' }) })
    },
  }, 'opendigitalmate: digest-pref')

  effect({
    path: '/api/opendigitalmate/ui-context',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => json(router.setViewContext(await readJson(request))),
  }, 'opendigitalmate: ui-context')

  // P2 temporary views: the vetted renderer (static file) and the owner's surface ops (get / 保存为卡片 / form submit).
  effect({
    path: '/api/opendigitalmate/ui-renderer.js',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => new Response(await readFile(UI_RENDERER, 'utf8'), { status: 200, headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' } }),
  }, 'opendigitalmate: ui-renderer')

  effect({
    path: '/api/opendigitalmate/surface',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => json(await router.surfaceOp(await readJson(request))),
  }, 'opendigitalmate: surface')

  effect({
    path: '/api/opendigitalmate/card-chat',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try { return json(await router.cardChat(await readJson(request))) }
      catch (err) { return json({ success: false, error: err.message }) }
    },
  }, 'opendigitalmate: card-chat')

  effect({
    path: '/api/completions',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => json(await router.listCompletions()),
  }, 'opendigitalmate: /api/completions')

  effect({
    path: '/api/sources',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => json(await router.getSources()),
  }, 'opendigitalmate: /api/sources')

  effect({
    path: '/api/config/check',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => json(await router.checkConfig()),
  }, 'opendigitalmate: /api/config/check')

  // Thumbnails for images the user attached in chat (saved by content hash in chat-display.js).
  effect({
    path: '/api/opendigitalmate/chat-attachment',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const ref = new URL(request.url).searchParams.get('ref') || ''
      const p = router.chatDisplay().imagePath(ref)
      if (!p) return json({ error: 'not found' }, 404)
      const ext = ref.split('.').pop()
      return new Response(await readFile(p), { status: 200, headers: { 'content-type': MIME_OF_EXT[ext] || 'application/octet-stream', 'cache-control': 'private, max-age=31536000, immutable' } })
    },
  }, 'opendigitalmate: chat attachment')

  effect({
    path: '/api/chat/history',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      // Same session page the stock UI draws. The jsonl fallback misses session.vN logs.
      try {
        const live = await loadLiveDockHistory(ctx, { dshHome, display: router.chatDisplay() })
        if (live) {
          return json({
            sessionId: live.sessionId || 'dsbot-chief',
            messages: router.dockSurfacesFor(live.messages || []),
            botId: live.botId || null,
          })
        }
      } catch (err) { log(`chat history page failed: ${err?.message || err}`) }
      return json(await router.getChatHistory())
    },
  }, 'opendigitalmate: /api/chat/history')

  // One lane per Chief: turns never overlap, and quick follow-ups merge into one turn (see chat-lane.js).
  const chatLane = createChatLane({
    log,
    run: async (req, hooks) => {
      const watched = new Set()
      const watch = (sid) => { watched.add(sid); const t = hooks.primaryTurn(); if (t && feed) feed.turns.watch(sid, t) }
      const turns = new Set([req.turn].filter(Boolean))
      hooks.onPrimaryChange((next) => { if (next.turn) turns.add(next.turn); for (const sid of watched) watch(sid) })
      try {
        return await runMuseChatTurn(ctx, {
          message: req.message,
          cardId: req.cardId,
          cardContext: req.cardContext,
          viewContext: req.viewContext,
          attachments: req.attachments,
          dshHome,
          log,
          timing: req.timing,
          onSession: feed ? watch : null,
          lane: hooks,
          display: router.chatDisplay(),
          displayItems: req.displayItems || null,
        })
      } finally { if (feed) for (const t of turns) feed.turns.unwatch(t) }
    },
  })
  // In-process ds-bot chat (same runtime — no side server).
  effect({
    path: '/api/chat',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const timing = { recvAt: Date.now(), clientSentAt: Number(request.headers.get('x-odm-sent-at')) || null }
      const body = await readJson(request)
      // The open card, read fresh from the store each turn (never the client's stale one-liner).
      let cardContext = body.cardContext
      if (body.cardId) {
        try { cardContext = router.cardSnapshot(body.cardId) || cardContext } catch (err) { log(`cardSnapshot failed: ${err.message}`) }
      }
      // What the user is looking at (page, open card, filter, visible cards) — titles resolved from the store.
      let viewContext = ''
      if (body.viewContext) {
        try { viewContext = router.viewSnapshot(body.viewContext) || '' } catch (err) { log(`viewSnapshot failed: ${err.message}`) }
      }
      timing.contextAt = Date.now()
      // The page names its turn so streamed text / skeletons land in the right bubble.
      const turn = typeof body.turn === 'string' && /^t_[\w-]{4,40}$/.test(body.turn) ? body.turn : null
      const result = await chatLane.submit({
        message: body.message || body.text,
        cardId: body.cardId,
        cardContext,
        viewContext,
        attachments: body.attachments || body.files || null,
        turn,
        timing,
      })
      if (result.status === 'merged') {
        // This message joined a later request's turn; that request carries the one reply.
        return json({ text: '', status: 'merged', mergedInto: result.mergedInto, turn, sessionId: 'dsbot-chief', time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) })
      }
      if (!result.ok) {
        const err = String(result.error || '')
        const noModel = /No model is available|没有可用的模型/i.test(err)
        const text = noModel
          ? '还没有可用的模型。请打开「配置」→ AI 模型，选择 DeepSeek 并保存 API Key（会写入 DEEPSEEK_API_KEY）。若刚保存仍不行，重启 npm start 后再用 .odm-data/dsh-web.url 里的登录链接打开。'
          : `没法完成对话：${err}`
        return json({
          text,
          status: 'error',
          error: err,
          cards: [{ type: 'error', title: 'ds-bot', description: err }],
          time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
        }, 200)
      }
      // Temporary views Chief generated during this turn ride along as rich blocks under the reply.
      let surfaces = []
      try { surfaces = router.surfacesSince(timing.recvAt).map(view => ({ type: 'surface', view })) } catch (err) { log(`surfacesSince failed: ${err.message}`) }
      // Dock replies keep their views across a reload (card chats store theirs with the card chat).
      if (surfaces.length && !body.cardId) { try { await router.recordDockSurfaces(result.text, surfaces.map(s => s.view.id)) } catch (err) { log(`recordDockSurfaces failed: ${err.message}`) } }
      return json({
        text: result.text,
        status: result.status,
        citations: result.citations || [],
        attachments: result.attachments || [],
        cards: [...(result.cards || []), ...surfaces],
        botId: result.botId,
        mergedCount: result.mergedCount || 1,
        sessionId: 'dsbot-chief',
        turn,
        streamed: !!(turn && feed && feed.stats.clients > 0),
        timing: { ...result.timing, clientSentAt: timing.clientSentAt, serverRecvAt: timing.recvAt, serverRespondAt: Date.now() },
        time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
      })
    },
  }, 'opendigitalmate: /api/chat')

  // What Chief is doing right now, for the typing indicator (正在查 GitHub… / 正在写回复…).
  effect({
    path: '/api/opendigitalmate/chat-progress',
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async () => {
      try { return json(await chatProgress(ctx, { dshHome })) }
      catch (err) { return json({ running: null, error: String(err?.message || err) }) }
    },
  }, 'opendigitalmate: chat-progress')

  effect({
    path: '/api/opendigitalmate/muse-chat',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readJson(request)
      const result = await runMuseChatTurn(ctx, {
        message: body.message || body.text,
        cardId: body.cardId,
        cardContext: body.cardContext,
        dshHome,
        log,
      })
      return json(result, result.ok ? 200 : 500)
    },
  }, 'opendigitalmate: muse-chat')

  effect({
    path: '/api/composio/apps',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => json(await router.getComposioApps()),
  }, 'opendigitalmate: composio apps')

  // Fresh probe for the 信源状态 page (the page first paints from the cached status above).
  effect({
    path: '/api/composio/apps/refresh',
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async () => json(await router.getComposioApps({ fresh: true })),
  }, 'opendigitalmate: composio apps refresh')

  effect({
    path: '/api/composio/connect',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => json(await router.connectComposioApp(await readJson(request))),
  }, 'opendigitalmate: composio connect')

  effect({
    path: '/api/composio/config',
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      if (request.method === 'GET') return json(await router.getComposioConfig())
      return json(await router.updateComposioConfig(await readJson(request)))
    },
  }, 'opendigitalmate: composio config')

  effect({
    path: '/api/llm/config',
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      if (request.method === 'GET') return json(await router.getLLMConfig())
      return json(await router.updateLLMConfig(await readJson(request)))
    },
  }, 'opendigitalmate: llm config')


  effect({
    path: '/api/digest/push',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async () => json(await router.pushDigest()),
  }, 'opendigitalmate: /api/digest/push')

  effect({
    path: '/api/llm/test',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async () => json(await router.testLLM()),
  }, 'opendigitalmate: /api/llm/test')

  effect({
    path: '/api/composio/disconnect',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => json(await router.disconnectComposioApp(await readJson(request))),
  }, 'opendigitalmate: composio disconnect')

  log('dsh-host-routes: Muse app + APIs registered')
  return true
}
