// Register Muse UI + all /api/* routes on the dsh connection (same process as ds-bot).

import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runMuseChatTurn } from './muse-chat-core.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLIENT_HTML = join(__dirname, '../client/index.html')

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
      const body = await readJson(request)
      const result = await runMuseChatTurn(ctx, {
        message: body.message || body.text,
        cardId: body.cardId,
        cardContext: body.cardContext,
        dshHome,
        log,
      })
      if (!result.ok) {
        return json({
          text: `没法完成对话：${result.error}`,
          status: 'error',
          cards: [{ type: 'error', title: 'ds-bot', description: result.error }],
          time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
        }, 200)
      }
      return json({
        text: result.text,
        status: result.status,
        citations: result.citations || [],
        cards: result.cards || [],
        botId: result.botId,
        sessionId: 'dsbot-chief',
        time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
      })
    },
  }, 'opendigitalmate: /api/chat')

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
