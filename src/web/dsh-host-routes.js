// Register Muse UI + all /api/* routes on the dsh connection (same process as ds-bot).

import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runMuseChatTurn, chatProgress } from './muse-chat-core.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLIENT_HTML = join(__dirname, '../client/index.html')
const UI_RENDERER = join(__dirname, '../client/ui-renderer.js')

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
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
    fetch: async () => json(await router.getToday()),
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
    fetch: async () => json(await router.generateDigestNow()),
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

  effect({
    path: '/api/chat/history',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => json(await router.getChatHistory()),
  }, 'opendigitalmate: /api/chat/history')

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
      const result = await runMuseChatTurn(ctx, {
        message: body.message || body.text,
        cardId: body.cardId,
        cardContext,
        viewContext,
        dshHome,
        log,
        timing,
      })
      if (!result.ok) {
        return json({
          text: `没法完成对话：${result.error}`,
          status: 'error',
          cards: [{ type: 'error', title: 'ds-bot', description: result.error }],
          time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
        }, 200)
      }
      // Temporary views Chief generated during this turn ride along as rich blocks under the reply.
      let surfaces = []
      try { surfaces = router.surfacesSince(timing.recvAt).map(view => ({ type: 'surface', view })) } catch (err) { log(`surfacesSince failed: ${err.message}`) }
      return json({
        text: result.text,
        status: result.status,
        citations: result.citations || [],
        cards: [...(result.cards || []), ...surfaces],
        botId: result.botId,
        sessionId: 'dsbot-chief',
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
