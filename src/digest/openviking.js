/**
 * OpenViking HTTP adapter for Muse Memory Glimpse + Chief recall.
 * Credentials: OPENVIKING_* env, then ~/.openviking/ovcli.conf (same chain as the dsh plugin).
 * No custom vector platform — talks to a real OpenViking server only.
 */
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { rankMemories } from './memory-rank.js'

const DEFAULT_URL = 'http://127.0.0.1:1933'
const MEMORIES_URI = 'viking://~/memories/'

/** Map OpenViking memory folders → Glimpse tags (achievement-first ranking). */
const CATEGORY_TAGS = {
  experiences: ['achievement'],
  events: ['achievement', 'milestone'],
  entities: ['person'],
  preferences: ['preference'],
  cases: ['project'],
  trajectories: ['project'],
  tools: ['habit'],
  skills: ['habit'],
  rules: ['decision'],
  profile: ['fact'],
  identity: ['fact'],
  soul: ['fact'],
}

function readOvcliConf() {
  const path = join(homedir(), '.openviking', 'ovcli.conf')
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    // Flat { url, api_key } or { active, connections: { name: { url, api_key } } }
    if (raw?.url || raw?.endpoint || raw?.api_key || raw?.apiKey) return raw
    const name = raw?.active || raw?.current || raw?.default
    const conn = (name && raw?.connections?.[name]) || raw?.connection || null
    if (conn && typeof conn === 'object') return { ...raw, ...conn }
    const first = raw?.connections && Object.values(raw.connections)[0]
    if (first && typeof first === 'object') return { ...raw, ...first }
    return raw
  } catch {
    return null
  }
}

/** Resolve OpenViking connection the same way the dsh plugin does. */
export function resolveOpenVikingConfig(env = process.env) {
  const file = readOvcliConf() || {}
  const url = String(
    env.OPENVIKING_URL
    || env.OPENVIKING_BASE_URL
    || file.url
    || file.endpoint
    || file.base_url
    || DEFAULT_URL,
  ).replace(/\/+$/, '')
  const apiKey = env.OPENVIKING_API_KEY
    || env.OPENVIKING_BEARER_TOKEN
    || file.api_key
    || file.apiKey
    || file.token
    || ''
  const account = env.OPENVIKING_ACCOUNT || file.account || ''
  const user = env.OPENVIKING_USER || file.user || ''
  return { url, apiKey: String(apiKey || ''), account: String(account || ''), user: String(user || '') }
}

function authHeaders(cfg) {
  const h = { Accept: 'application/json' }
  if (cfg.apiKey) {
    h.Authorization = `Bearer ${cfg.apiKey}`
    h['X-API-Key'] = cfg.apiKey
  }
  if (cfg.account) h['X-OpenViking-Account'] = cfg.account
  if (cfg.user) h['X-OpenViking-User'] = cfg.user
  return h
}

async function ovFetch(cfg, path, { method = 'GET', body, query, timeoutMs = 8_000 } = {}) {
  const u = new URL(cfg.url + path)
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue
      u.searchParams.set(k, String(v))
    }
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(u, {
      method,
      headers: {
        ...authHeaders(cfg),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    })
    const text = await res.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch { json = { raw: text } }
    if (!res.ok) {
      const err = new Error(json?.message || json?.error || `OpenViking HTTP ${res.status}`)
      err.status = res.status
      err.body = json
      throw err
    }
    return json
  } finally {
    clearTimeout(timer)
  }
}

export async function openVikingHealth(cfg = resolveOpenVikingConfig()) {
  try {
    const j = await ovFetch(cfg, '/health', { timeoutMs: 3_000 })
    const ok = j?.healthy === true || j?.status === 'ok' || j?.status === 'healthy'
    return { ok: !!ok, url: cfg.url, raw: j }
  } catch (err) {
    return { ok: false, url: cfg.url, error: err?.message || String(err) }
  }
}

function categoryFromUri(uri) {
  const m = String(uri || '').match(/\/memories\/([^/?#]+)/i)
  if (!m) return ''
  const part = m[1].replace(/\.md$/i, '').toLowerCase()
  return part
}

function tagsForEntry(entry) {
  const tags = new Set()
  const cat = categoryFromUri(entry?.uri || entry?.rel_path || entry?.name)
  for (const t of CATEGORY_TAGS[cat] || []) tags.add(t)
  const extra = entry?.tags || entry?.meta?.tags || entry?.attrs?.tags || []
  for (const t of Array.isArray(extra) ? extra : String(extra).split(/[\s,]+/)) {
    const s = String(t).replace(/^memory\./, '').toLowerCase().trim()
    if (s) tags.add(s)
  }
  const memType = entry?.attrs?.memory?.memory_type || entry?.meta?.memory_type
  if (memType && CATEGORY_TAGS[String(memType).toLowerCase()]) {
    for (const t of CATEGORY_TAGS[String(memType).toLowerCase()]) tags.add(t)
  }
  return [...tags]
}

function textFromEntry(entry) {
  const abs = String(entry?.abstract || entry?.Abstract || entry?.meta?.abstract || '').trim()
  // Directory placeholders like "# experiences" are not useful card text.
  if (abs && !/^#\s*[\w-]+\s*$/i.test(abs)) return abs
  const overview = String(entry?.overview || entry?.meta?.overview || '').trim()
  if (overview) return overview.slice(0, 400)
  // Empty → caller may fill via content/read; keep name only as last resort later.
  return ''
}

function fallbackName(entry) {
  const name = String(entry?.name || '').replace(/\.md$/i, '').replace(/[-_]/g, ' ').trim()
  return name || String(entry?.uri || '')
}

function mtimeMs(entry) {
  const raw = entry?.modTime || entry?.mtime || entry?.updated_at || entry?.updatedAt
  if (!raw) return 0
  const n = Date.parse(raw)
  return Number.isFinite(n) ? n : (Number(raw) || 0)
}

function isMemoryFile(entry) {
  if (!entry || entry.isDir || entry.access === 'denied') return false
  const uri = String(entry.uri || entry.rel_path || '')
  if (!/\/memories\//i.test(uri)) return false
  // Skip L0/L1 sidecar files
  if (/\.(abstract|overview)\.md$/i.test(uri)) return false
  if (/\/(abstract|overview)\.md$/i.test(uri)) return false
  return true
}

function toRow(entry) {
  const uri = String(entry.uri || '')
  const tags = tagsForEntry(entry)
  const updatedAt = mtimeMs(entry)
  return {
    id: uri,
    uri,
    text: textFromEntry(entry),
    tags,
    pinned: false,
    createdAt: updatedAt,
    updatedAt,
    source: 'openviking',
  }
}

/** List memories under viking://~/memories/ (recursive). */
export async function listOpenVikingMemories({ limit = 40, cfg = resolveOpenVikingConfig() } = {}) {
  const health = await openVikingHealth(cfg)
  if (!health.ok) {
    return {
      memories: [],
      total: 0,
      backend: 'openviking',
      available: false,
      url: cfg.url,
      error: health.error || 'OpenViking server unreachable',
    }
  }
  const json = await ovFetch(cfg, '/api/v1/fs/ls', {
    query: {
      uri: MEMORIES_URI,
      recursive: true,
      include_abstract: true,
      include_tags: true,
      sort_by: 'mtime',
      sort_order: 'desc',
      limit: Math.max(50, Number(limit) * 4 || 160),
      output: 'original',
    },
    timeoutMs: 12_000,
  })
  const entries = Array.isArray(json?.result) ? json.result : (Array.isArray(json) ? json : [])
  const files = entries.filter(isMemoryFile).map(toRow)
  // Prefer real file bodies when L0 abstract is empty (common right after write).
  const needBody = files.filter(r => !r.text).slice(0, Math.max(12, Number(limit) || 40))
  await Promise.all(needBody.map(async (row) => {
    try {
      const body = await readOpenVikingContent(row.uri, cfg)
      if (body) row.text = body.slice(0, 600).trim()
    } catch { /* ignore */ }
    if (!row.text) row.text = fallbackName({ name: row.uri.split('/').pop(), uri: row.uri })
  }))
  for (const row of files) {
    if (!row.text) row.text = fallbackName({ name: String(row.uri).split('/').pop(), uri: row.uri })
  }
  const ranked = rankMemories(files)
  const capped = ranked.slice(0, Math.max(1, Number(limit) || 40))
  return {
    memories: capped,
    total: files.length,
    backend: 'openviking',
    available: true,
    url: cfg.url,
    path: MEMORIES_URI,
  }
}

export async function readOpenVikingContent(uri, cfg = resolveOpenVikingConfig()) {
  const json = await ovFetch(cfg, '/api/v1/content/read', {
    query: { uri, offset: 0, limit: 4000 },
    timeoutMs: 8_000,
  })
  if (typeof json?.result === 'string') return json.result
  if (typeof json?.result?.content === 'string') return json.result.content
  if (typeof json?.content === 'string') return json.content
  if (typeof json === 'string') return json
  return ''
}

/** Permanent delete (MCP forget ≡ DELETE /api/v1/fs). */
export async function forgetOpenVikingMemory(idOrUri, cfg = resolveOpenVikingConfig()) {
  const uri = String(idOrUri || '').trim()
  if (!uri.startsWith('viking://')) {
    return { ok: false, forgotten: false, error: 'invalid openviking uri' }
  }
  try {
    await ovFetch(cfg, '/api/v1/fs', {
      method: 'DELETE',
      query: { uri, recursive: false },
      timeoutMs: 10_000,
    })
    return { ok: true, forgotten: true, id: uri, uri, backend: 'openviking' }
  } catch (err) {
    return { ok: false, forgotten: false, error: err?.message || String(err), id: uri, backend: 'openviking' }
  }
}

/** Chief recall block from OpenViking context search (falls back to listed highlights). */
export async function readOpenVikingRecall({ query = 'important achievements decisions preferences', maxChars = 2000, cfg = resolveOpenVikingConfig() } = {}) {
  const health = await openVikingHealth(cfg)
  if (!health.ok) return ''
  try {
    const json = await ovFetch(cfg, '/api/v1/search/search', {
      method: 'POST',
      body: {
        query,
        mode: 'context',
        purpose: 'coding',
        target_uri: MEMORIES_URI,
      },
      timeoutMs: 12_000,
    })
    const rendered = json?.result?.rendered
      || json?.result?.context
      || json?.result?.text
      || (typeof json?.result === 'string' ? json.result : '')
    if (rendered && String(rendered).trim()) {
      const body = String(rendered).trim().slice(0, maxChars)
      return `Memories from OpenViking (use mcp__openviking__search for more):\n${body}`
    }
  } catch { /* fall through to list */ }
  const listed = await listOpenVikingMemories({ limit: 12, cfg })
  if (!listed.memories?.length) return ''
  const header = 'Memories from OpenViking (use mcp__openviking__search for more):\n'
  const lines = []
  let used = header.length
  for (const row of listed.memories) {
    const tags = row.tags?.length ? ` [${row.tags.join(' ')}]` : ''
    const line = `- (${row.uri})${tags} ${row.text}`
    if (used + line.length + 1 > maxChars) break
    lines.push(line)
    used += line.length + 1
  }
  return lines.length ? header + lines.join('\n') : ''
}

export { MEMORIES_URI, CATEGORY_TAGS }
