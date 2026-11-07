// Shared Muse static reads — used by the dsh host half and by optional standalone importers.
// Assets live only under ./static; hosts must not hardcode packages/ paths.
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const STATIC = join(dirname(fileURLToPath(import.meta.url)), 'static')

export const STATIC_DIR = STATIC
export const MUSE_APP_PATH = '/api/opendigitalmate/app'
export const MUSE_UI_RENDERER_PATH = '/api/opendigitalmate/ui-renderer.js'
export const MUSE_LOGO_PATH = '/api/opendigitalmate/logo'

export async function readIndexHtml() {
  const [html, css, js] = await Promise.all(['index.html', 'future.css', 'future.js'].map(file => readFile(join(STATIC, file), 'utf8')))
  return html.replace('</head>', `<style>${css}</style></head>`).replace('</body>', `<script>${js}</script></body>`)
}

export async function readUiRendererJs() {
  return readFile(join(STATIC, 'ui-renderer.js'), 'utf8')
}

/** @returns {Promise<Buffer|null>} */
export async function readLogoSvg(app) {
  const key = String(app || '').toLowerCase()
  if (!/^[a-z0-9_]{1,40}$/.test(key)) return null
  try {
    return await readFile(join(STATIC, 'logos', `${key}.svg`))
  } catch {
    return null
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** Fetch-API Response for GET /api/opendigitalmate/app */
export async function museAppResponse() {
  const html = await readIndexHtml()
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/** Fetch-API Response for GET /api/opendigitalmate/ui-renderer.js */
export async function museUiRendererResponse() {
  const js = await readUiRendererJs()
  return new Response(js, {
    status: 200,
    headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** Fetch-API Response for GET /api/opendigitalmate/logo?app=… */
export async function museLogoResponse(request) {
  const app = (new URL(request.url).searchParams.get('app') || '').toLowerCase()
  if (!/^[a-z0-9_]{1,40}$/.test(app)) return json({ error: 'bad app' }, 400)
  const body = await readLogoSvg(app)
  if (!body) return json({ error: 'not found' }, 404)
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'image/svg+xml; charset=utf-8',
      'cache-control': 'public, max-age=604800, immutable',
    },
  })
}
