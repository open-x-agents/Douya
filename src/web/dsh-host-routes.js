// Register /api/* data routes on the dsh connection (same process as ds-bot).
// Muse static UI (app HTML / ui-renderer / logos) lives in the dsh-muse-ui plugin.

import { CALLBACK_PATH, requestOrigin } from './composio-callback.js'
import { readFile } from 'node:fs/promises'
import { runMuseChatTurn, chatProgress } from './muse-chat-core.js'
import { createChatLane } from './chat-lane.js'
import { installUiFeed } from './ui-feed.js'
import { browserScript, resolveLang, DEFAULT_LOCALE } from '../i18n/index.js'


function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function hourParam(request) {
  try { const h = new URL(request.url, 'http://x').searchParams.get('hour'); return h !== null && /^\d{1,2}$/.test(h) ? Number(h) : null } catch { return null }
}

function langParam(request) {
  try {
    const u = new URL(request.url, 'http://x')
    const q = u.searchParams.get('lang')
    if (q) return resolveLang(q)
    return resolveLang(request.headers)
  } catch { return DEFAULT_LOCALE }
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

  effect({
    path: '/api/today',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => json(await router.getToday({ hour: hourParam(request), lang: langParam(request) })),
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

  effect({
    path: '/api/opendigitalmate/timetable',
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      if (request.method === 'GET') return json(router.timetableGet())
      try { return json(await router.timetableApply(await readJson(request), { by: 'user' })) }
      catch (err) { return json({ success: false, error: err.message }) }
    },
  }, 'opendigitalmate: timetable')

  effect({
    path: '/api/opendigitalmate/future', methods: ['GET', 'POST'], requestBody: 'buffered',
    fetch: async request => {
      if (request.method === 'GET') return json(await router.futureGet())
      try { return json(await router.futureApply(await readJson(request), { by: 'user' })) }
      catch (err) { return json({ ok: false, error: err.message }, 400) }
    },
  }, 'opendigitalmate: future')

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

  // The one standing line on 今天 (browser writes are always the user; 豆芽 goes through its own tool later).
  effect({
    path: '/api/opendigitalmate/duty',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => json(await router.dutyOp(await readJson(request), { by: 'user' })),
  }, 'opendigitalmate: duty')

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
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      if (request.method === 'GET') return json(router.digestPrefs())
      const b = await readJson(request)
      try {
        if (b?.edit) return json(router.editDigestPref(b.edit))
        if (b?.clear) return json(router.clearDigestPrefs())
        if (b?.remove) return json(router.removeDigestPref(String(b.remove)))
        return json(router.addDigestPref({ text: b?.text, channel: b?.channel }))
      } catch (err) { return json({ success: false, error: err.message }) }
    },
  }, 'opendigitalmate: digest-pref')

  effect({
    path: '/api/opendigitalmate/ui-context',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => json(router.setViewContext(await readJson(request))),
  }, 'opendigitalmate: ui-context')

  // P2 temporary views: owner surface ops (get / 保存为卡片 / form submit).
  // ui-renderer.js is served by the dsh-muse-ui plugin.
  effect({
    path: '/api/opendigitalmate/i18n.js',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => new Response(browserScript(), { status: 200, headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' } }),
  }, 'opendigitalmate: i18n')

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
    path: '/api/opendigitalmate/memories',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const lim = Number(new URL(request.url).searchParams.get('limit') || 40)
      return json(await router.listMemories({ limit: Number.isFinite(lim) ? lim : 40 }))
    },
  }, 'opendigitalmate: memories')

  effect({
    path: '/api/opendigitalmate/memories/forget',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => json(await router.forgetMemory(await readJson(request))),
  }, 'opendigitalmate: memories forget')


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
      const { MIME_OF_EXT } = await import('./chat-display.js')
      return new Response(await readFile(p), { status: 200, headers: { 'content-type': MIME_OF_EXT[ext] || 'application/octet-stream', 'cache-control': 'private, max-age=31536000, immutable' } })
    },
  }, 'opendigitalmate: chat attachment')

  // Brand logos: served by the dsh-muse-ui plugin (/api/opendigitalmate/logo).

  effect({
    path: '/api/chat/history',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => json(await router.getChatHistory()),
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
          doneContext: req.doneContext,
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
      // Sent replies / closed cards since Chief last looked: the general chat must not list them as open.
      let doneContext = ''
      try { doneContext = router.doneSnapshot() || '' } catch (err) { log(`doneSnapshot failed: ${err.message}`) }
      timing.contextAt = Date.now()
      // The page names its turn so streamed text / skeletons land in the right bubble.
      const turn = typeof body.turn === 'string' && /^t_[\w-]{4,40}$/.test(body.turn) ? body.turn : null
      const result = await chatLane.submit({
        message: body.message || body.text,
        cardId: body.cardId,
        cardContext,
        viewContext,
        doneContext,
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

  // Composio OAuth popup lands here. It must be a public exact route on the web server, not under /api:
  // the /api fence wants the SameSite=Strict session cookie, which a cross-site OAuth redirect never carries.
  // The page only renders status + notifies the opener; nothing secret is returned.
  if (ctx.webServer?.register) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: CALLBACK_PATH,
      handler: async (req, res) => {
        try {
          const q = new URL(req.url || '/', 'http://local').searchParams
          const { html } = await router.composioCallback({
            status: (q.get('status') || '').slice(0, 40),
            connectedAccountId: (q.get('connected_account_id') || q.get('connectedAccountId') || '').slice(0, 120),
            error: (q.get('error') || q.get('message') || '').slice(0, 300),
          })
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' })
          res.end(html)
        } catch (err) {
          log(`composio callback failed: ${err.message}`)
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }); res.end('composio callback error')
        }
      },
    }), 'opendigitalmate: composio callback')
  } else {
    log('composio callback: webServer unavailable, /composio-callback not mounted')
  }

  // A card's prepared step (pending action held for 确认执行, or 明天再看). Owner auth via the /api fence.
  effect({
    path: '/api/opendigitalmate/card-prep',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => json(await router.cardPrepRun(await readJson(request))),
  }, 'opendigitalmate: card prepared step')

  // Prepared brief for a card (PR size / CI / review / risk from GitHub). Read-only.
  effect({
    path: '/api/opendigitalmate/card-brief',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => json(await router.cardBrief(await readJson(request))),
  }, 'opendigitalmate: card brief')

  // Hero 「完成了」 on a timetable block (owner only, behind the /api fence).
  effect({
    path: '/api/opendigitalmate/timetable-block',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => json(await router.timetableBlockDone(await readJson(request))),
  }, 'opendigitalmate: timetable block done')

  effect({
    path: '/api/composio/connect',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => json(await router.connectComposioApp(await readJson(request), { origin: requestOrigin(request) })),
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
