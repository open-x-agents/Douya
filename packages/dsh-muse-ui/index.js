// Muse Today UI host half: serve the static Muse page + assets.
// All /api/opendigitalmate/* data routes stay on the opendigitalmate host plugin.
import {
  MUSE_APP_PATH,
  MUSE_UI_RENDERER_PATH,
  MUSE_LOGO_PATH,
  MUSE_MEMORY_PRESENT_PATH,
  museAppResponse,
  museMemoryPresentResponse,
  museUiRendererResponse,
  museLogoResponse,
} from './static-serve.js'

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

export const name = 'dsh-muse-ui'
export const inject = ['connection']

export function apply(ctx, _config = {}) {
  const register = ctx?.connection?.fetch?.register
  if (typeof ctx?.effect !== 'function' || typeof register !== 'function') {
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
          return json({ ok: false, error: String(err?.message || err) }, 500)
        }
      },
    }
    ctx.effect(() => register(safe), label)
  }

  effect({
    path: MUSE_APP_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => museAppResponse(),
  }, 'dsh-muse-ui: app')

  effect({
    path: MUSE_UI_RENDERER_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => museUiRendererResponse(),
  }, 'dsh-muse-ui: ui-renderer')

  effect({
    path: MUSE_LOGO_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => museLogoResponse(request),
  }, 'dsh-muse-ui: source logo')

  effect({
    path: MUSE_MEMORY_PRESENT_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => museMemoryPresentResponse(),
  }, 'dsh-muse-ui: memory-present')

  return true
}
