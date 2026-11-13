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

/** Login URL from `<dataDir>/dsh-web.url` (default `<root>/.odm-data`), with the file's mtime. */
export function readLoginUrl(root, { fs = { readFileSync, statSync }, dataDir } = {}) {
  const file = dataDir ? join(dataDir, 'dsh-web.url') : join(root, URL_FILE)
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
  dataDir, read = (dir, opts) => readLoginUrl(dir, opts), portOpen = isPortOpen, isDead = () => false, now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const deadline = now() + timeoutMs
  while (now() < deadline) {
    if (isDead()) throw Object.assign(new Error('server exited'), { code: 'exited' })
    const login = freshLogin(read(root, dataDir ? { dataDir } : {}), since, port)
    if (login && (await portOpen(port))) return login
    await sleep(intervalMs)
  }
  throw Object.assign(new Error('timed out waiting for the login URL'), { code: 'timeout' })
}

/** A repo root is a folder that has scripts/start-dsh.mjs. */
export function isRepoRoot(dir, exists = existsSync) {
  return Boolean(dir) && exists(join(dir, START_SCRIPT))
}

/** Bundled server tree shipped in extraResources (`app-runtime`). */
export const APP_RUNTIME = 'app-runtime'

export function bundledRuntimeRoot(resourcesPath, exists = existsSync) {
  if (!resourcesPath) return null
  const dir = join(resourcesPath, APP_RUNTIME)
  return isRepoRoot(dir, exists) ? dir : null
}

export function bundledDshEntry(runtimeRoot, exists = existsSync) {
  if (!runtimeRoot) return null
  const entry = join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  return exists(entry) ? entry : null
}

/** Vanilla Node binary shipped next to the runtime. dsh refuses Electron's Node. */
export function bundledNodeExe(runtimeRoot, platform = process.platform, exists = existsSync) {
  if (!runtimeRoot) return null
  const candidates = platform === 'win32'
    ? [join(runtimeRoot, 'node', 'node.exe'), join(runtimeRoot, 'node', 'bin', 'node.exe')]
    : [join(runtimeRoot, 'node', 'bin', 'node'), join(runtimeRoot, 'node', 'node')]
  return candidates.find((p) => exists(p)) || null
}

/**
 * First candidate that looks like the repo: env, then a packaged `app-runtime`
 * (before a remembered path, which may be a stale leftover from an older build),
 * then a saved setting, a dev checkout, and the usual clone locations.
 */
export function resolveRepoRoot({ env = process.env, saved, bundledRoot, devRoot, home = env.HOME || env.USERPROFILE || '', exists = existsSync }) {
  const candidates = [
    env.ODM_ROOT,
    bundledRoot,
    saved,
    devRoot,
    home && join(home, 'Documents', 'git', 'openDigitalMate'),
    home && join(home, 'openDigitalMate'),
  ]
  return candidates.find((dir) => isRepoRoot(dir, exists)) || null
}

/** DSH_BIN from env, else a bundled entry, a saved path, or the owner's usual Mac checkout. */
export function resolveDshBin({ env = process.env, saved, bundled, home = env.HOME || '', exists = existsSync }) {
  if (env.DSH_BIN) return env.DSH_BIN
  if (bundled && exists(bundled)) return bundled
  if (saved && exists(saved)) return saved
  const guess = home && join(home, 'Documents', 'git', 'dsh-rc5', 'bin', 'dsh')
  return guess && exists(guess) ? guess : null
}

/**
 * The dsh runtime the server will use: env / bundled / saved / usual Mac layout first, then `dsh` on PATH.
 * null means start-dsh would fall back to a bare `dsh` that is not there and die before it is
 * ready, so the shell should ask for the executable instead of showing a generic crash.
 * A packaged install with a bundled dsh never returns null.
 */
export function locateDsh({ env = process.env, saved, bundled, home = env.HOME || '', exists = existsSync, onPath = () => null } = {}) {
  return resolveDshBin({ env, saved, bundled, home, exists }) || onPath('dsh') || null
}

/**
 * Which Node runs start-dsh (and, through it, dsh). A packaged app always uses
 * Electron's own Node (`ELECTRON_RUN_AS_NODE`) so the user needs no Node install.
 * Dev prefers `node` on PATH and falls back to Electron.
 */
export function resolveNodeExe({ packaged, execPath, bundledNode, onPath = () => null } = {}) {
  // Packaged: prefer the vanilla Node we ship. dsh's native loader rejects Electron 45.2.3.
  if (packaged && bundledNode) return { exe: bundledNode, electronAsNode: false }
  if (packaged) return { exe: execPath, electronAsNode: true }
  const node = onPath('node')
  if (node) return { exe: node, electronAsNode: false }
  return { exe: execPath, electronAsNode: true }
}

/** Writable data dir: userData when packaged, otherwise `<root>/.odm-data`. */
export function resolveOdmDataDir({ packaged, userData, root, env = process.env } = {}) {
  if (env.ODM_DATA_DIR) return env.ODM_DATA_DIR
  if (packaged && userData) return join(userData, 'odm-data')
  return join(root, '.odm-data')
}

/** Writable dsh home: userData when packaged, otherwise `<root>/.dsh-odm`. */
export function resolvePackagedDshHome({ packaged, userData, root, env = process.env } = {}) {
  if (env.DSH_HOME) return env.DSH_HOME
  if (packaged && userData) return join(userData, 'dsh-odm')
  return join(root, '.dsh-odm')
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
    noDsh: 'Could not find the dsh runtime that Douya runs on. Choose the dsh executable (for example …/dsh-rc5/bin/dsh), or set DSH_BIN.',
    pickDsh: 'Choose the dsh executable',
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
    noDsh: '找不到豆芽运行所需的 dsh。请选择 dsh 可执行文件（例如 …/dsh-rc5/bin/dsh），或设置 DSH_BIN。',
    pickDsh: '选择 dsh 可执行文件',
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
