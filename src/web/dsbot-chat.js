// Muse UI → real ds-bot Chief via DSH `/api/bot` send + session log read.
// (FlyBot ds-bot has `send` but no `chat` page endpoint.)

import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

export const BOT_SESSION_ID = 'dsbot-chief'
const DEFAULT_BASE = process.env.DSBOT_URL || 'http://127.0.0.1:7788'
const QUIET_MS = 2_000
const STEP_TIMEOUT_MS = 120_000

function clean(v) { return String(v ?? '').replace(/\s+/g, ' ').trim() }
// Keep line structure (lists, paragraphs) — the client renders Markdown.
function cleanBlock(v) {
  return String(v ?? '').replace(/\r\n?/g, '\n').split('\n').map(l => l.replace(/[ \t]+$/g, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim()
}
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

import { readdirSync, readFileSync } from 'node:fs'

function locateSessionLog(dshHome, botId) {
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
          for (const name of ['session.jsonl.zstd', 'session.jsonl']) {
            const c = join(p, name)
            if (existsSync(c)) return c
          }
        }
        stack.push(p)
      }
    }
  }
  return null
}

function readLastAssistant(logPath) {
  if (!logPath) return ''
  let raw = ''
  if (logPath.endsWith('.zstd')) {
    const r = spawnSync('zstd', ['-dc', logPath], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 })
    if (r.status !== 0) return ''
    raw = r.stdout || ''
  } else {
    try { raw = readFileSync(logPath, 'utf8') } catch { return '' }
  }
  let last = ''
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let o
    try { o = JSON.parse(line) } catch { continue }
    if (o.type === 'assistant/message') {
      const content = o.data?.message?.content
      const text = Array.isArray(content)
        ? content.map(p => p?.text || '').join('')
        : (typeof content === 'string' ? content : '')
      if (clean(text)) last = cleanBlock(text)
    }
  }
  return last
}

async function ensureModel(auth, botId) {
  try {
    const state = await api(auth, 'state', {})
    const bot = (state.bots || []).find(b => b.id === botId) || state.bots?.[0]
    if (bot && !bot.model && !bot.appliedModel) {
      await api(auth, 'update-bot', { id: botId, model: 'deepseek/deepseek-chat' })
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

export async function loadDsBotHistory({ home = '.odm-data', baseUrl = DEFAULT_BASE, token = process.env.DSBOT_TOKEN, dshHome = process.env.DSH_HOME || join(process.cwd(), '.dsh-odm'), limit = 40 } = {}) {
  try {
    const auth = await ensureDsbotSession({ baseUrl, home, token })
    const state = await api(auth, 'state', {})
    const mainId = state.mainBotId || state.mainBotIds?.[0]
    if (!mainId) return { sessionId: BOT_SESSION_ID, messages: [], botId: null }
    const logPath = locateSessionLog(dshHome, mainId)
    if (!logPath) return { sessionId: BOT_SESSION_ID, messages: [], botId: mainId }
    let raw = ''
    if (logPath.endsWith('.zstd')) {
      const r = spawnSync('zstd', ['-dc', logPath], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 })
      raw = r.stdout || ''
    } else {
      raw = await readFile(logPath, 'utf8')
    }
    const messages = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      let o
      try { o = JSON.parse(line) } catch { continue }
      if (o.type === 'user/message' || o.type === 'assistant/message') {
        const msg = o.data?.message
        const role = msg?.role === 'user' ? 'user' : 'assistant'
        const content = Array.isArray(msg?.content) ? msg.content.map(p => p?.text || '').join('') : (msg?.content || '')
        if (clean(content)) messages.push({ role, content: cleanBlock(content) })
      }
    }
    return { sessionId: BOT_SESSION_ID, messages: messages.slice(-limit), botId: mainId }
  } catch (err) {
    return { sessionId: BOT_SESSION_ID, messages: [], botId: null, error: err.message }
  }
}
