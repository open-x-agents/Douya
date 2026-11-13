/**
 * Official MCP Memory (`@modelcontextprotocol/server-memory`) adapter.
 * Recall, Chief, and Future read the knowledge-graph JSONL directly
 * (entities + observations + relations). The model writes through MCP tools
 * (`mcp__memory__create_entities`, `add_observations`, `search_nodes`, …).
 * No embeddings, no separate Python service.
 */
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  renameSync, statSync, unlinkSync, writeSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { hostname } from 'node:os'
import { rankMemories } from './memory-rank.js'

export const BACKEND = 'mcp-memory'
export const MEMORY_FILENAME = 'memory.jsonl'
export const MCP_MEMORY_PACKAGE = '@modelcontextprotocol/server-memory'
export const MCP_MEMORY_VERSION = '2.1.1'
export const MCP_MEMORY_SERVER_NAME = 'memory'
export const MCP_MEMORY_PLUGIN_ID = 'odm-mcp-memory'
export const MCP_MEMORY_ENTRY = join('node_modules', '@modelcontextprotocol', 'server-memory', 'dist', 'index.js')

/** Map MCP entity types → Glimpse tags (achievement-first ranking). */
export const TYPE_TAGS = {
  person: ['person'],
  people: ['person'],
  organization: ['project'],
  organisation: ['project'],
  company: ['project'],
  project: ['project'],
  event: ['achievement', 'milestone'],
  achievement: ['achievement'],
  milestone: ['achievement', 'milestone'],
  win: ['achievement'],
  preference: ['preference'],
  decision: ['decision'],
  habit: ['habit'],
  skill: ['habit'],
  tool: ['habit'],
  fact: ['fact'],
  identity: ['fact'],
  profile: ['fact'],
}

const HIGH_TEXT = /\b(?:shipped|launched|won|award|achievement|milestone)\b|发布|上线|获奖|成就/i

export function resolveMemoryFilePath({ env = process.env, dataDir } = {}) {
  const raw = env.MEMORY_FILE_PATH != null ? String(env.MEMORY_FILE_PATH).trim() : ''
  if (raw) return expandHome(raw, env)
  const dir = env.ODM_DATA_DIR || dataDir || ''
  if (!dir) return null
  return join(dir, MEMORY_FILENAME)
}

function expandHome(p, env = process.env) {
  if (p === '~') return env.HOME || env.USERPROFILE || p
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    const home = env.HOME || env.USERPROFILE || ''
    return home ? join(home, p.slice(2)) : p
  }
  return p
}

export function resolveMemoryServerEntry(runtimeRoot, exists = existsSync) {
  if (!runtimeRoot) return null
  const guesses = [
    join(runtimeRoot, 'node_modules', '@modelcontextprotocol', 'server-memory', 'dist', 'index.js'),
    join(runtimeRoot, 'bundled-plugins', 'node_modules', '@modelcontextprotocol', 'server-memory', 'dist', 'index.js'),
  ]
  return guesses.find((p) => exists(p)) || null
}

export function tagsForEntityType(type, observation = '') {
  const tags = new Set(TYPE_TAGS[String(type || '').toLowerCase().trim()] || [])
  if (HIGH_TEXT.test(String(observation || '')) || HIGH_TEXT.test(String(type || ''))) {
    tags.add('achievement')
  }
  if (!tags.size && type) tags.add('fact')
  return [...tags]
}

export function observationId(entityName, observation) {
  return 'obs:' + Buffer.from(JSON.stringify([entityName, observation]), 'utf8').toString('base64url')
}

export function entityId(entityName) {
  return 'ent:' + Buffer.from(JSON.stringify([entityName]), 'utf8').toString('base64url')
}

export function parseMemoryId(id) {
  const s = String(id || '')
  const i = s.indexOf(':')
  if (i < 0) return null
  const kind = s.slice(0, i)
  if (kind !== 'obs' && kind !== 'ent') return null
  try {
    const parts = JSON.parse(Buffer.from(s.slice(i + 1), 'base64url').toString('utf8'))
    if (!Array.isArray(parts) || !parts[0]) return null
    if (kind === 'obs' && parts.length < 2) return null
    return { kind, entityName: parts[0], observation: kind === 'obs' ? parts[1] : undefined }
  } catch {
    return null
  }
}

function displayName(name) {
  return String(name || '').replace(/_/g, ' ').trim() || String(name || '')
}

/**
 * Load the JSONL graph. A missing file is an empty, available library
 * (the MCP server creates the file on the first write). IO errors are
 * unavailable, distinct from empty (#208).
 */
export function loadGraph(file) {
  if (!file) {
    return { ok: false, available: false, error: 'memory file path is not configured', entities: [], relations: [], unreadable: [], file: null }
  }
  if (!existsSync(file)) {
    return { ok: true, available: true, entities: [], relations: [], unreadable: [], file, missing: true }
  }
  try {
    const st = statSync(file)
    if (st.isDirectory()) {
      return { ok: false, available: false, error: 'memory path is a directory', entities: [], relations: [], unreadable: [], file }
    }
    const data = readFileSync(file, 'utf8')
    const entities = []
    const relations = []
    const unreadable = []
    for (const line of data.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let item
      try { item = JSON.parse(trimmed) } catch { unreadable.push(line); continue }
      if (!item || typeof item !== 'object') { unreadable.push(line); continue }
      if (item.type === 'entity' && typeof item.name === 'string' && item.name) {
        const observations = Array.isArray(item.observations) ? item.observations.map((o) => String(o)) : []
        const { type: _t, name: _n, entityType: _e, observations: _o, ...extra } = item
        entities.push({
          name: item.name,
          entityType: String(item.entityType || ''),
          observations,
          extra,
        })
      } else if (item.type === 'relation' && item.from && item.to) {
        const { type: _t, from: _f, to: _to, relationType: _r, ...extra } = item
        relations.push({
          from: String(item.from),
          to: String(item.to),
          relationType: String(item.relationType || ''),
          extra,
        })
      } else {
        unreadable.push(line)
      }
    }
    return { ok: true, available: true, entities, relations, unreadable, file }
  } catch (err) {
    return {
      ok: false,
      available: false,
      error: err?.message || String(err),
      entities: [],
      relations: [],
      unreadable: [],
      file,
    }
  }
}

function graphLines({ entities, relations, unreadable = [] }) {
  const lines = [
    ...entities.map((e) => JSON.stringify({
      type: 'entity',
      name: e.name,
      entityType: e.entityType,
      observations: e.observations,
      ...(e.extra || {}),
    })),
    ...relations.map((r) => JSON.stringify({
      type: 'relation',
      from: r.from,
      to: r.to,
      relationType: r.relationType,
      ...(r.extra || {}),
    })),
    ...unreadable,
  ]
  return lines.join('\n') + (lines.length ? '\n' : '')
}

/** Atomic replace: write a temp file in the same directory, fsync, then rename. */
export function atomicWriteFile(file, contents) {
  if (!file) throw new Error('memory file path is not configured')
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, contents)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(tmp, file)
  } catch (err) {
    // Windows cannot always rename over an existing file.
    const bak = `${file}.bak.${process.pid}`
    try {
      if (existsSync(file)) renameSync(file, bak)
      renameSync(tmp, file)
      try { unlinkSync(bak) } catch { /* leftover bak is harmless */ }
    } catch (err2) {
      try { if (existsSync(bak) && !existsSync(file)) renameSync(bak, file) } catch { /* restore failed */ }
      try { unlinkSync(tmp) } catch { /* */ }
      throw err2
    }
  }
}

function sleep(ms) {
  const buf = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(buf, 0, 0, Math.max(1, ms))
}

/**
 * Exclusive lock compatible with the official server's `<file>.lock` (O_EXCL).
 * Releases in `finally` so a failed forget cannot leave the MCP server wedged.
 */
export function withMemoryLock(file, fn, { timeoutMs = 8_000 } = {}) {
  if (!file) return fn()
  mkdirSync(dirname(file), { recursive: true })
  const lock = `${file}.lock`
  const deadline = Date.now() + timeoutMs
  let fd
  for (;;) {
    try {
      fd = openSync(lock, 'wx')
      writeSync(fd, JSON.stringify({ pid: process.pid, hostname: hostname() }))
      break
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err
      if (Date.now() >= deadline) {
        throw Object.assign(new Error(`timed out waiting for the memory file lock ${lock}`), { code: 'lock_timeout' })
      }
      sleep(15)
    }
  }
  try {
    return fn()
  } finally {
    try { closeSync(fd) } catch { /* */ }
    try { unlinkSync(lock) } catch { /* */ }
  }
}

export function saveGraph(file, graph) {
  atomicWriteFile(file, graphLines(graph))
}

function entityText(entity, observation, relations) {
  const title = displayName(entity.name)
  const body = observation != null && String(observation).trim()
    ? String(observation).trim()
    : (entity.entityType ? `(${entity.entityType})` : '')
  const touching = (relations || []).filter((r) => r.from === entity.name || r.to === entity.name)
  const relLines = touching.map((r) => {
    const kind = (r.relationType || 'related to').replace(/_/g, ' ')
    return r.from === entity.name ? `${kind} ${displayName(r.to)}` : `${displayName(r.from)} ${kind} ${title}`
  })
  const parts = [`# ${title}`]
  if (body) parts.push(body)
  if (relLines.length) parts.push(relLines.join('. ') + (relLines.length ? '.' : ''))
  return parts.join('\n\n')
}

/** Present each observation (or a bare entity) as a human-readable Recall row. */
export function listMcpMemories({ file, limit = 40 } = {}) {
  const g = loadGraph(file)
  if (!g.available) {
    return {
      memories: [],
      total: 0,
      backend: BACKEND,
      available: false,
      path: file || null,
      error: g.error || 'memory file unreadable',
    }
  }
  const rows = []
  for (const e of g.entities) {
    const obs = (e.observations || []).map((o) => String(o)).filter((o) => o.trim())
    if (!obs.length) {
      rows.push({
        id: entityId(e.name),
        text: entityText(e, null, g.relations),
        tags: tagsForEntityType(e.entityType),
        pinned: false,
        createdAt: 0,
        updatedAt: 0,
        source: BACKEND,
        entityName: e.name,
        entityType: e.entityType,
      })
      continue
    }
    for (const o of obs) {
      rows.push({
        id: observationId(e.name, o),
        text: entityText(e, o, g.relations),
        tags: tagsForEntityType(e.entityType, o),
        pinned: false,
        createdAt: 0,
        updatedAt: 0,
        source: BACKEND,
        entityName: e.name,
        entityType: e.entityType,
        observation: o,
      })
    }
  }
  const ranked = rankMemories(rows)
  const cap = Math.max(1, Number(limit) || 40)
  return {
    memories: ranked.slice(0, cap),
    total: ranked.length,
    backend: BACKEND,
    available: true,
    path: file,
  }
}

function applyForget(graph, parsed) {
  const { entityName, kind, observation } = parsed
  const idx = graph.entities.findIndex((e) => e.name === entityName)
  if (idx < 0) return { changed: false, forgotten: false, droppedEntity: false }
  const entity = graph.entities[idx]
  if (kind === 'ent') {
    graph.entities.splice(idx, 1)
    graph.relations = graph.relations.filter((r) => r.from !== entityName && r.to !== entityName)
    return { changed: true, forgotten: true, droppedEntity: true }
  }
  const before = entity.observations.length
  entity.observations = entity.observations.filter((o) => o !== observation)
  if (entity.observations.length === before) return { changed: false, forgotten: false, droppedEntity: false }
  if (!entity.observations.length) {
    graph.entities.splice(idx, 1)
    graph.relations = graph.relations.filter((r) => r.from !== entityName && r.to !== entityName)
    return { changed: true, forgotten: true, droppedEntity: true }
  }
  return { changed: true, forgotten: true, droppedEntity: false }
}

/**
 * Forget one observation, or a whole entity (and its relations).
 * Last observation of an entity also removes the entity. Atomic write under lock.
 */
export function forgetMcpMemory(id, file) {
  const parsed = parseMemoryId(id)
  if (!parsed) {
    return { ok: false, forgotten: false, error: 'invalid memory id', id, backend: BACKEND }
  }
  if (!file) {
    return { ok: false, forgotten: false, error: 'memory file path is not configured', id, backend: BACKEND }
  }
  try {
    return withMemoryLock(file, () => {
      const g = loadGraph(file)
      if (!g.available) {
        return { ok: false, forgotten: false, error: g.error || 'memory file unreadable', id, backend: BACKEND }
      }
      const result = applyForget(g, parsed)
      if (result.changed) saveGraph(file, g)
      return { ok: true, forgotten: result.forgotten, id, backend: BACKEND, droppedEntity: result.droppedEntity }
    })
  } catch (err) {
    return { ok: false, forgotten: false, error: err?.message || String(err), id, backend: BACKEND }
  }
}

const RECALL_HEADER = 'Memories from the knowledge graph (use mcp__memory__search_nodes, mcp__memory__read_graph, or mcp__memory__open_nodes for more):\n'

export function readMcpRecall({ file, maxChars = 2000 } = {}) {
  const listed = listMcpMemories({ file, limit: 12 })
  if (!listed.available || !listed.memories?.length) return ''
  const lines = []
  let used = RECALL_HEADER.length
  for (const row of listed.memories) {
    const tags = row.tags?.length ? ` [${row.tags.join(' ')}]` : ''
    const body = String(row.text || '').replace(/^#\s+/, '').replace(/\n+/g, ' — ').trim()
    const line = `- (${row.entityName || row.id})${tags} ${body}`
    if (used + line.length + 1 > maxChars) break
    lines.push(line)
    used += line.length + 1
  }
  return lines.length ? RECALL_HEADER + lines.join('\n') : ''
}

export { HIGH_TEXT }
