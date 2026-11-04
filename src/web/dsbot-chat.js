// Muse UI → real ds-bot Chief via DSH `/api/bot` send + session log read.
// (FlyBot ds-bot has `send` but no `chat` page endpoint.)

import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dockMessagesFromRecords, resolveChief } from './muse-chat-core.js'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

export const BOT_SESSION_ID = 'dsbot-chief'
const DEFAULT_BASE = process.env.DSBOT_URL || 'http://127.0.0.1:7788'
const QUIET_MS = 2_000
const STEP_TIMEOUT_MS = 120_000

function clean(v) { return String(v ?? '').replace(/\s+/g, ' ').trim() }
function authPath(home) { return join(home || '.odm-data', 'dsbot-auth.json') }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function loadAuth(home) {
  const path = authPath(home)
  if (!existsSync(path)) return null
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { return null }
}

async function saveAuth(home, auth) {
  await mkdir(home || '.odm-data', { recursive: true })
  await writeFile(authPath(home), JSON.stringify(auth, null, 2), 'utf8')
}

export async function ensureDsbotSession({ baseUrl = DEFAULT_BASE, home = '.odm-data', token = process.env.DSBOT_TOKEN } = {}) {
  let auth = await loadAuth(home)
  if (auth?.cookie && auth?.baseUrl === baseUrl) {
    if (await probe(baseUrl, auth.cookie)) return auth
  }
  if (!token) {
    const logPath = join(home, 'dsh-web.url')
    if (existsSync(logPath)) {
      const text = await readFile(logPath, 'utf8')
      const m = text.match(/[?&]token=([^\s&]+)/)
      if (m) token = m[1]
      const u = text.match(/https?:\/\/[^\s]+/)
      if (u) baseUrl = u[0].replace(/\/\?token=.*/, '')
    }
  }
  if (!token) throw new Error('ds-bot 未就绪：缺少 DSBOT_TOKEN（请用 npm start 启动）')
  const loginUrl = `${baseUrl.replace(/\/$/, '')}/?token=${encodeURIComponent(token)}`
  const res = await fetch(loginUrl, { redirect: 'manual' })
  const setCookie = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : [])
  const cookie = setCookie.map(c => c.split(';')[0]).filter(Boolean).join('; ')
  if (!cookie) throw new Error(`ds-bot 登录失败（HTTP ${res.status}）`)
  auth = { baseUrl: baseUrl.replace(/\/$/, ''), cookie, token, at: new Date().toISOString() }
  await saveAuth(home, auth)
  return auth
}

async function probe(baseUrl, cookie) {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/bot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ endpoint: 'state', payload: {} }),
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) return false
    return !!(await res.json())?.ok
  } catch { return false }
}

async function api(auth, endpoint, payload = {}) {
  const res = await fetch(`${auth.baseUrl}/api/bot`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: auth.cookie },
    body: JSON.stringify({ endpoint, payload }),
    signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
  })
  const body = await res.json().catch(() => ({}))
  if (!body?.ok) throw new Error(body?.error?.message || body?.error || `HTTP ${res.status}`)
  return body.value
}

async function waitQuiet(auth) {
  const deadline = Date.now() + STEP_TIMEOUT_MS
  let since = Date.now()
  // Give the turn a moment to start.
  await sleep(600)
  while (Date.now() < deadline) {
    const state = await api(auth, 'state', {})
    const busy = state?.activity && Object.keys(state.activity).length > 0
    if (busy) since = Date.now()
    else if (Date.now() - since >= QUIET_MS) return state
    await sleep(400)
  }
  throw new Error('ds-bot 超时：Bot 一直没有安静下来')
}

// dsh names the current generation `session.vN.jsonl` (often zstd) and leaves older
// generations beside it. Generation 0 is the legacy `session.jsonl`. Higher wins;
// zstd is the default write of that generation.
export function sessionLogRank(name) {
  const base = String(name).split(/[\\/]/).pop()
  const m = base.match(/^session(?:\.v(\d+))?\.jsonl(?:\.zstd)?$/)
  if (!m) return -1
  const gen = m[1] ? Number(m[1]) : 0
  return gen * 2 + (base.endsWith('.zstd') ? 1 : 0)
}

function bestSessionLog(dir) {
  let best = null
  let rank = -1
  let names
  try { names = readdirSync(dir) } catch { return null }
  for (const name of names) {
    const r = sessionLogRank(name)
    if (r > rank) { rank = r; best = join(dir, name) }
  }
  return rank >= 0 ? best : null
}

export function locateSessionLog(dshHome, botId) {
  const root = join(dshHome, 'sessions')
  if (!existsSync(root)) return null
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const ent of entries) {
      const p = join(dir, ent.name)
      if (ent.isDirectory()) {
        if (ent.name === botId || ent.name.includes(botId)) {
          const hit = bestSessionLog(p)
          if (hit) return hit
        }
        stack.push(p)
      }
    }
  }
  return null
}

function readLog(logPath) {
  if (!logPath) return ''
  if (logPath.endsWith('.zstd')) {
    const r = spawnSync('zstd', ['-dc', logPath], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 })
    if (r.status !== 0) return ''
    return r.stdout || ''
  }
  try { return readFileSync(logPath, 'utf8') } catch { return '' }
}

function readLastAssistant(logPath) {
  const msgs = historyMessages(readLog(logPath))
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'assistant' && msgs[i].content) return msgs[i].content
  }
  return ''
}

/**
 * Move bots whose model is one of `from` (e.g. legacy text-only `deepseek/deepseek-chat`) to `to`.
 * Bots the user pinned to anything else are left alone.
 */
export async function syncBotModels({ home = '.odm-data', baseUrl = DEFAULT_BASE, token = process.env.DSBOT_TOKEN, to, from = [], auth = null, call = api } = {}) {
  if (!to) return { updated: [] }
  auth ||= await ensureDsbotSession({ baseUrl, home, token })
  const state = await call(auth, 'state', {})
  const bots = Array.isArray(state?.bots) ? state.bots : Object.values(state?.bots || {})
  const updated = []
  for (const bot of bots) {
    const cur = bot?.model ?? bot?.appliedModel
    if (!bot?.id || cur === to || !from.includes(cur)) continue
    await call(auth, 'update-bot', { id: bot.id, model: to })
    updated.push(bot.id)
  }
  return { updated }
}

async function ensureModel(auth, botId) {
  try {
    const state = await api(auth, 'state', {})
    const bot = (state.bots || []).find(b => b.id === botId) || state.bots?.[0]
    if (bot && !bot.model && !bot.appliedModel) {
      await api(auth, 'update-bot', { id: botId, model: `deepseek/${process.env.ODM_CHAT_MODEL || 'deepseek-flash'}` })
    }
  } catch { /* non-fatal */ }
}

export async function chatWithDsBot({
  message,
  cardId = null,
  cardContext = null,
  home = '.odm-data',
  baseUrl = DEFAULT_BASE,
  token = process.env.DSBOT_TOKEN,
  dshHome = process.env.DSH_HOME || join(process.cwd(), '.dsh-odm'),
  log = () => {},
} = {}) {
  const text = clean(message)
  if (!text) {
    return { text: '想问哪一类？可以说邮件、PR、Slack 或今天的安排。', status: 'answered', citations: [], cards: [], sessionId: BOT_SESSION_ID }
  }

  const auth = await ensureDsbotSession({ baseUrl, home, token })
  const state = await api(auth, 'state', {})
  const mainId = state.mainBotId || state.mainBotIds?.[0]
  if (!mainId) throw new Error('ds-bot 没有 Main Bot（Chief）')
  await ensureModel(auth, mainId)

  let outbound = text
  if (cardContext) outbound = `【当前卡片】${clean(cardContext).slice(0, 1200)}\n\n${text}`
  else if (cardId) outbound = `【cardId=${cardId}】\n${text}`

  const before = readLastAssistant(locateSessionLog(dshHome, mainId))
  log(`[dsbot] send → ${mainId}: ${outbound.slice(0, 80)}`)
  await api(auth, 'send', { sessionId: mainId, text: outbound })
  await waitQuiet(auth)

  // Poll the log briefly for a new assistant message.
  let reply = ''
  for (let i = 0; i < 20; i++) {
    const logPath = locateSessionLog(dshHome, mainId)
    reply = readLastAssistant(logPath)
    if (reply && reply !== before) break
    await sleep(300)
  }
  if (!reply) reply = '（Bot 已处理，但没有读到文本回复）'
  log(`[dsbot] reply: ${reply.slice(0, 120)}`)

  return {
    text: reply,
    status: 'answered',
    citations: [],
    cards: [],
    sessionId: BOT_SESSION_ID,
    botId: mainId,
  }
}

// Turn a session log into dock bubbles. A user/message has no `role` field: the person
// is `source.kind === 'user'`, and assistant text may sit on `data.content` (v4) or
// `data.message.content`. Treating "no role" as assistant emptied the dock's user side
// and, with the wrong log filename, the whole list.
export function historyMessages(raw, { display = null } = {}) {
  const records = []
  for (const line of String(raw || '').split('\n')) {
    if (!line.trim()) continue
    try { records.push(JSON.parse(line)) } catch { /* torn line */ }
  }
  return dockMessagesFromRecords(records, { display })
}

export async function loadDsBotHistory({ display = null, home = '.odm-data', baseUrl = DEFAULT_BASE, token = process.env.DSBOT_TOKEN, dshHome = process.env.DSH_HOME || join(process.cwd(), '.dsh-odm'), limit = 40 } = {}) {
  try {
    const auth = await ensureDsbotSession({ baseUrl, home, token })
    const state = await api(auth, 'state', {})
    const mainId = state.mainBotId || state.mainBotIds?.[0]
    if (!mainId) return { sessionId: BOT_SESSION_ID, messages: [], botId: null }
    // ds-bot moves a long conversation on to fresh "part" Sessions; read the last parts, oldest first.
    const { parts } = await resolveChief(dshHome, mainId)
    const messages = []
    for (const part of (parts.length ? parts : [mainId]).slice(-2)) {
      const logPath = locateSessionLog(dshHome, part)
      if (!logPath) continue
      messages.push(...historyMessages(readLog(logPath), { display }))
    }
    if (!messages.length) return { sessionId: BOT_SESSION_ID, messages: [], botId: mainId }
    return { sessionId: BOT_SESSION_ID, messages: messages.slice(-limit), botId: mainId }
  } catch (err) {
    return { sessionId: BOT_SESSION_ID, messages: [], botId: null, error: err.message }
  }
}
