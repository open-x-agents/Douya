// Muse Today UI host half: serve the static Muse page + assets.
// All /api/opendigitalmate/* data routes stay on the opendigitalmate host plugin.
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const STATIC = join(__dirname, 'static')

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
    path: '/api/opendigitalmate/app',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      const html = await readFile(join(STATIC, 'index.html'), 'utf8')
      return new Response(html, {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        },
      })
    },
  }, 'dsh-muse-ui: app')

  effect({
    path: '/api/opendigitalmate/ui-renderer.js',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => new Response(await readFile(join(STATIC, 'ui-renderer.js'), 'utf8'), {
      status: 200,
      headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' },
    }),
  }, 'dsh-muse-ui: ui-renderer')

  effect({
    path: '/api/opendigitalmate/logo',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const app = (new URL(request.url).searchParams.get('app') || '').toLowerCase()
      if (!/^[a-z0-9_]{1,40}$/.test(app)) return json({ error: 'bad app' }, 400)
      const file = join(STATIC, 'logos', `${app}.svg`)
      try {
        const body = await readFile(file)
        return new Response(body, {
          status: 200,
          headers: {
            'content-type': 'image/svg+xml; charset=utf-8',
            'cache-control': 'public, max-age=604800, immutable',
          },
        })
      } catch {
        return json({ error: 'not found' }, 404)
      }
    },
  }, 'dsh-muse-ui: source logo')

  return true
}
