// Pure helpers for the desktop shell. No Electron import here, so the root `npm test`
// can cover them without installing Electron.
import { readFileSync, statSync, existsSync } from 'node:fs'
import { connect } from 'node:net'
import { join, delimiter } from 'node:path'

export const DEFAULT_PORT = 7777
export const URL_FILE = join('.odm-data', 'dsh-web.url')
export const START_SCRIPT = join('scripts', 'start-dsh.mjs')

/** The token login URL dsh prints, or null. Only loopback URLs count. */
export function parseLoginUrl(text) {
  const m = String(text || '').match(/http:\/\/127\.0\.0\.1:(\d+)\/\?token=[^\s]+/)
  if (!m) return null
  return { url: m[0], port: Number(m[1]), origin: `http://127.0.0.1:${m[1]}` }
}

/** Login URL from `<root>/.odm-data/dsh-web.url`, with the file's mtime. */
export function readLoginUrl(root, { fs = { readFileSync, statSync } } = {}) {
  const file = join(root, URL_FILE)
  try {
    const login = parseLoginUrl(fs.readFileSync(file, 'utf8'))
    if (!login) return null
    return { ...login, file, mtimeMs: fs.statSync(file).mtimeMs }
  } catch {
    return null
  }
}

/** True when something accepts TCP on 127.0.0.1:port. */
export function isPortOpen(port, { host = '127.0.0.1', timeoutMs = 800 } = {}) {
  return new Promise((resolve) => {
    const sock = connect({ host, port })
    const done = (ok) => { sock.destroy(); resolve(ok) }
    sock.setTimeout(timeoutMs, () => done(false))
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
  })
}

/** True when the token URL is accepted (dsh answers 401 for a stale token). */
export async function tokenWorks(url, { fetchFn = globalThis.fetch, timeoutMs = 2000 } = {}) {
  try {
    const res = await fetchFn(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
    return res.status < 400
  } catch {
    return false
  }
}

/**
 * What to do at launch:
 * - `reuse`: a server is already on the port and the saved token works → just open it.
 * - `spawn`: nothing on the port → start our own.
 * - `conflict`: the port is taken but we cannot log in (other app, or stale token).
 */
export function decideStartup({ portOpen, login, tokenOk, port = DEFAULT_PORT }) {
  if (!portOpen) return { action: 'spawn' }
  if (login && login.port === Number(port) && tokenOk) return { action: 'reuse', url: login.url }
  return { action: 'conflict' }
}

/** A login URL written after `since` (with 1 s slack for coarse mtimes) whose port is open. */
export function freshLogin(login, since, port) {
  if (!login) return null
  if (login.port !== Number(port)) return null
  if (login.mtimeMs + 1000 < since) return null
  return login
}

/**
 * Poll until start-dsh writes a fresh login URL and the port answers.
 * Resolves the login, or rejects on timeout / when `isDead()` says the child exited.
 */
export async function waitForLogin({ root, port, since, timeoutMs = 120_000, intervalMs = 400,
  read = readLoginUrl, portOpen = isPortOpen, isDead = () => false, now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const deadline = now() + timeoutMs
  while (now() < deadline) {
    if (isDead()) throw Object.assign(new Error('server exited'), { code: 'exited' })
    const login = freshLogin(read(root), since, port)
    if (login && (await portOpen(port))) return login
    await sleep(intervalMs)
  }
  throw Object.assign(new Error('timed out waiting for the login URL'), { code: 'timeout' })
}

/** A repo root is a folder that has scripts/start-dsh.mjs. */
export function isRepoRoot(dir, exists = existsSync) {
  return Boolean(dir) && exists(join(dir, START_SCRIPT))
}

/** First candidate that looks like the repo (env, saved setting, dev checkout, common clones). */
export function resolveRepoRoot({ env = process.env, saved, devRoot, home = env.HOME || env.USERPROFILE || '', exists = existsSync }) {
  const candidates = [
    env.ODM_ROOT,
    saved,
    devRoot,
    home && join(home, 'Documents', 'git', 'openDigitalMate'),
    home && join(home, 'openDigitalMate'),
  ]
  return candidates.find((dir) => isRepoRoot(dir, exists)) || null
}

/** DSH_BIN from env, else the owner's usual Mac checkout if it exists; else leave it to start-dsh. */
export function resolveDshBin({ env = process.env, saved, home = env.HOME || '', exists = existsSync }) {
  if (env.DSH_BIN) return env.DSH_BIN
  if (saved && exists(saved)) return saved
  const guess = home && join(home, 'Documents', 'git', 'dsh-rc5', 'bin', 'dsh')
  return guess && exists(guess) ? guess : null
}

/**
 * A GUI app on macOS starts with PATH=/usr/bin:/bin:… — no Homebrew, no nvm. Merge the login
 * shell's PATH and the usual install dirs, de-duplicated, keeping the current order first.
 */
export function mergePath(current, extra = [], sep = delimiter) {
  const out = []
  for (const part of [...String(current || '').split(sep), ...extra.flatMap((p) => String(p || '').split(sep))]) {
    if (part && !out.includes(part)) out.push(part)
  }
  return out.join(sep)
}

export const COMMON_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']

/** Keep saved window bounds only if they are sane numbers; else defaults. */
export function sanitizeBounds(saved, defaults = { width: 1360, height: 880 }) {
  const ok = (n, min) => Number.isFinite(n) && n >= min && n < 20000
  if (!saved || !ok(saved.width, 640) || !ok(saved.height, 480)) return { ...defaults }
  const out = { width: Math.round(saved.width), height: Math.round(saved.height) }
  if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) { out.x = Math.round(saved.x); out.y = Math.round(saved.y) }
  if (saved.maximized) out.maximized = true
  return out
}

/** Same origin as the Douya server → stays in the window; anything else → system browser. */
export function isInternalUrl(url, origin) {
  try { return new URL(url).origin === origin } catch { return false }
}

export function isExternalOpenable(url) {
  try { return ['http:', 'https:', 'mailto:'].includes(new URL(url).protocol) } catch { return false }
}

const MESSAGES = {
  en: {
    title: 'Douya could not start',
    exited: 'The Douya server stopped before it was ready.',
    timeout: 'The Douya server did not become ready in time.',
    conflict: (port) => `Port ${port} is in use, but Douya could not log in to it. Quit whatever is using it (or a stale npm start) and try again, or set ODM_PORT.`,
    noRepo: 'Could not find the openDigitalMate folder. Choose the folder that contains scripts/start-dsh.mjs.',
    pickRepo: 'Choose the openDigitalMate folder',
    log: 'Log',
    quit: 'Quit',
    retry: 'Retry',
    ok: 'OK',
    ovTitle: 'Douya memory',
    ovModels: 'Long-term memory is running, but this configuration has no embedding model. You can list and forget memories; chat auto-recall needs an embedding model. The desktop installer ships a local Chinese model for new configs (see the README). A VLM / chat model is separate and is not required for recall.',
    ovFailed: (log) => `The bundled OpenViking memory server did not start. Memories will use the local fallback; chat auto-recall is off. See the log: ${log}`,
    ovConflict: 'Port 1933 is in use, but it is not a healthy OpenViking server. Memories will use the local fallback; quit whatever is using that port and try again.',
    ovSkip: 'This build does not include a bundled OpenViking server. Memories will use the local fallback unless you already run one on 127.0.0.1:1933.',
  },
  zh: {
    title: '豆芽没能启动',
    exited: '豆芽服务在就绪之前就退出了。',
    timeout: '豆芽服务没有按时就绪。',
    conflict: (port) => `端口 ${port} 已被占用，但豆芽登录不上。请先关掉占用它的程序（或残留的 npm start）再试，或设置 ODM_PORT。`,
    noRepo: '找不到 openDigitalMate 文件夹。请选择包含 scripts/start-dsh.mjs 的那个文件夹。',
    pickRepo: '选择 openDigitalMate 文件夹',
    log: '日志',
    quit: '退出',
    retry: '重试',
    ok: '好',
    ovTitle: '豆芽记忆',
    ovModels: '长期记忆已经启动，但当前配置里没有向量模型。你仍可以查看和删除记忆；聊天自动回忆需要向量模型。桌面安装包会为新配置附带一个中文本地模型（详见 README）。聊天 / VLM 模型是另一回事，回忆本身不需要它。',
    ovFailed: (log) => `打包的 OpenViking 记忆服务没有启动。回忆页会改用本地备份，聊天不会自动想起以前的事。日志：${log}`,
    ovConflict: '端口 1933 已被占用，但上面不是健康的 OpenViking 服务。回忆页会改用本地备份；请先关掉占用该端口的程序再试。',
    ovSkip: '这个安装包没有附带 OpenViking 服务。除非你已经在 127.0.0.1:1933 跑着一个，否则回忆页会改用本地备份。',
  },
}

/** EN / 中文 strings by OS locale (`zh`, `zh-CN`, `zh-Hans-CN`, … → 中文). */
export function messages(locale) {
  return String(locale || '').toLowerCase().startsWith('zh') ? MESSAGES.zh : MESSAGES.en
}

/** Last n lines of a log text, for the error dialog. */
export function tail(text, n = 12) {
  return String(text || '').trimEnd().split('\n').slice(-n).join('\n')
}
