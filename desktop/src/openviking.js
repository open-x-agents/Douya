// Pure helpers for the bundled OpenViking memory server. No Electron import,
// so the root `npm test` can cover them without installing Electron.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const OV_PORT = 1933
export const OV_ORIGIN = `http://127.0.0.1:${OV_PORT}`
export const OV_HEALTH_URL = `${OV_ORIGIN}/health`
export const OV_VERSION = '0.5.4'

/** True when GET /health says the process is up (does not require embedding / VLM). */
export function isOpenVikingHealthy(status, body) {
  if (Number(status) >= 400 || status == null) return false
  try {
    const json = typeof body === 'string' ? JSON.parse(body) : body
    if (json && (json.healthy === true || json.status === 'ok' || json.status === 'healthy')) return true
  } catch { /* not JSON */ }
  return false
}

/**
 * What to do at launch for memory:
 * - `reuse`: 127.0.0.1:1933 already answers healthy (leave it alone).
 * - `spawn`: port is free and we have a bundled runtime.
 * - `conflict`: something else is on the port but is not OpenViking / not healthy.
 * - `skip`: port is free but there is no bundle.
 */
export function decideOpenViking({ portOpen, healthy, bundled }) {
  if (healthy) return { action: 'reuse' }
  if (portOpen) return { action: 'conflict' }
  if (bundled) return { action: 'spawn' }
  return { action: 'skip' }
}

export function minimalOvConf({ workspace, host = '127.0.0.1', port = OV_PORT }) {
  return {
    server: { host, port },
    storage: {
      workspace,
      agfs: { backend: 'local' },
      vectordb: { backend: 'local' },
    },
  }
}

export function minimalOvcliConf({ url = OV_ORIGIN } = {}) {
  return { url }
}

/** Embedding / VLM count as configured only when the file names an explicit provider or model. */
export function modelsConfigured(conf) {
  const dense = conf?.embedding?.dense || {}
  const vlm = conf?.vlm || {}
  const embedding = Boolean(dense.provider || dense.model || dense.api_key)
  const hasVlm = Boolean(vlm.provider || vlm.model || vlm.api_key)
  return { embedding, vlm: hasVlm, ok: embedding }
}

/**
 * Prefer an existing ~/.openviking/ov.conf (the owner's own server). Otherwise write a
 * minimal config under the app userData, and write ~/.openviking/ovcli.conf if missing
 * so the dsh-memory-plugin and `ov` point at 127.0.0.1:1933. Never overwrites existing files.
 */
export function ensureOpenVikingConfig({
  homeDir, userDataDir,
  exists = existsSync,
  read = (p) => readFileSync(p, 'utf8'),
  write = (p, s) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s) },
  mkdir = (p) => mkdirSync(p, { recursive: true }),
} = {}) {
  const homeOv = join(homeDir || '', '.openviking')
  const homeConf = join(homeOv, 'ov.conf')
  const homeCli = join(homeOv, 'ovcli.conf')
  const appDir = join(userDataDir || '', 'openviking')
  const appConf = join(appDir, 'ov.conf')
  const workspace = join(appDir, 'data')

  let confPath = appConf
  let wroteConf = false
  let usedExisting = false
  let conf = null

  if (homeDir && exists(homeConf)) {
    confPath = homeConf
    usedExisting = true
    try { conf = JSON.parse(read(homeConf)) } catch { conf = null }
  } else {
    mkdir(workspace)
    conf = minimalOvConf({ workspace })
    write(appConf, JSON.stringify(conf, null, 2) + '\n')
    wroteConf = true
  }

  let wroteCli = false
  if (homeDir && !exists(homeCli)) {
    write(homeCli, JSON.stringify(minimalOvcliConf(), null, 2) + '\n')
    wroteCli = true
  }

  return { confPath, cliPath: homeCli, workspace, wroteConf, wroteCli, usedExisting, models: modelsConfigured(conf || {}) }
}

/** A relocatable runtime is a folder with a standalone CPython and site-packages (`py/` + `lib/`). */
export function resolveBundledRuntime(root, exists = existsSync) {
  if (!root) return null
  const python = join(root, 'py', process.platform === 'win32' ? 'python.exe' : join('bin', 'python3'))
  // allow either short names (py/lib) or extract defaults (python/site-packages)
  const alts = [
    { python, site: join(root, 'lib') },
    { python: join(root, 'python', process.platform === 'win32' ? 'python.exe' : join('bin', 'python3')), site: join(root, 'site-packages') },
  ]
  for (const c of alts) {
    if (exists(c.python) && exists(c.site)) return { root, python: c.python, site: c.site }
  }
  return null
}

/** Command + env to start the bundled server with a given ov.conf. */
export function bundledCommand(runtime, { confPath, platform = process.platform } = {}) {
  if (!runtime) return null
  const env = {
    PYTHONPATH: runtime.site,
    PYTHONNOUSERSITE: '1',
    PYTHONUTF8: '1',
    PYTHONUNBUFFERED: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    OPENVIKING_CONFIG_FILE: confPath,
  }
  // Windows needs PYTHONPATH with its own path separator if we ever compose more than one
  // entry; a single site dir is fine on both.
  if (platform === 'win32') env.PYTHONIOENCODING = 'utf-8'
  return {
    exe: runtime.python,
    args: ['-m', 'openviking_cli.server_bootstrap', '--config', confPath],
    env,
    cwd: dirname(confPath),
  }
}

/**
 * Poll GET /health until it is healthy, or reject on timeout / when `isDead()` says the child exited.
 */
export async function waitForHealth({
  url = OV_HEALTH_URL, timeoutMs = 90_000, intervalMs = 400,
  fetchFn = globalThis.fetch, isDead = () => false, now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const deadline = now() + timeoutMs
  let lastErr = null
  while (now() < deadline) {
    if (isDead()) throw Object.assign(new Error('openviking exited'), { code: 'exited' })
    try {
      const res = await fetchFn(url, { signal: AbortSignal.timeout(Math.min(2000, intervalMs * 4)) })
      const body = await res.text()
      if (isOpenVikingHealthy(res.status, body)) return { url, body }
      lastErr = `HTTP ${res.status}`
    } catch (err) {
      lastErr = err?.message || String(err)
    }
    await sleep(intervalMs)
  }
  throw Object.assign(new Error(`timed out waiting for OpenViking health (${lastErr || 'no response'})`), { code: 'timeout' })
}

export async function probeOpenVikingHealth({
  url = OV_HEALTH_URL, fetchFn = globalThis.fetch, timeoutMs = 2000,
} = {}) {
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) })
    const body = await res.text()
    return isOpenVikingHealthy(res.status, body)
  } catch {
    return false
  }
}

/** Drop duplicate Windows PATH/Path keys; keep a single `PATH`. */
export function sanitizeSpawnEnv(env, { path, platform = process.platform } = {}) {
  const out = { ...env }
  if (platform === 'win32') {
    for (const k of Object.keys(out)) {
      if (k !== 'PATH' && k.toUpperCase() === 'PATH') delete out[k]
    }
  }
  if (path != null) out.PATH = path
  return out
}
