/**
 * First-run setup wizard helpers (model API + Composio only).
 *
 * Composio does not offer a third-party OAuth / "Connect with Composio"
 * flow that hands a project API key to another app. Official docs:
 *   https://docs.composio.dev/reference/authenticating-to-composio
 *   https://docs.composio.dev/docs/cli
 * `composio login` is a CLI browser flow that stores a *user* API key
 * (`uak_…`, header `x-user-api-key`) in ~/.composio. Douya talks to
 * Composio with a *project* API key (`x-api-key`); sending a user key
 * as `x-api-key` is rejected (401). So the supported UI is: open the
 * official dashboard, paste a project key, live-validate.
 */

/** Where the user copies a project API key (Platform → Settings → API Keys). */
export const COMPOSIO_DASHBOARD_URL = 'https://platform.composio.dev'

export const COMPOSIO_AUTH_DOCS_URL = 'https://docs.composio.dev/reference/authenticating-to-composio'
export const COMPOSIO_CLI_DOCS_URL = 'https://docs.composio.dev/docs/cli'
export const COMPOSIO_API_BASE = 'https://backend.composio.dev/api/v3'

/** Same presets the Settings page already uses. */
export const PROVIDER_PRESETS = {
  openai: { baseURL: 'https://api.openai.com/v1', model: 'gpt-4o' },
  deepseek: { baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-flash' },
  moonshot: { baseURL: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  zhipu: { baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4' },
  anthropic: { baseURL: 'https://api.anthropic.com/v1', model: 'claude-3-5-sonnet-20241022' },
}

export const WIZARD_STEPS = ['model', 'composio']

export function isUserApiKey(key) {
  return /^uak_/i.test(String(key || '').trim())
}

/** True when config.json already holds user-saved data (not a fresh default). */
export function hasSavedConfig(cfg = {}) {
  return !!(cfg.updatedAt || cfg.llm?.apiKey || cfg.composioApiKey || cfg.setupWizardCompletedAt)
}

/**
 * Whether the wizard should auto-open.
 * - Never after the user finished or skipped.
 * - Always when the chat model isn't configured.
 * - If the model is already ready, only on a genuine first run
 *   (nothing saved yet) when Composio is also missing. Existing
 *   installs that already used Settings are left alone.
 */
export function needsSetup({
  llmConfigured = false,
  composioConfigured = false,
  wizardCompleted = false,
  hasSavedConfig: saved = false,
} = {}) {
  if (wizardCompleted) return false
  if (!llmConfigured) return true
  if (!composioConfigured && !saved) return true
  return false
}

export function setupStatus({
  llmConfigured = false,
  composioConfigured = false,
  wizardCompleted = false,
  hasSavedConfig: saved = false,
} = {}) {
  return {
    llmConfigured: !!llmConfigured,
    composioConfigured: !!composioConfigured,
    wizardCompleted: !!wizardCompleted,
    hasSavedConfig: !!saved,
    needsSetup: needsSetup({
      llmConfigured,
      composioConfigured,
      wizardCompleted,
      hasSavedConfig: saved,
    }),
  }
}

/** Redact a secret if it slipped into an error string. */
export function redactSecret(text, secret) {
  const raw = String(text || '')
  const key = String(secret || '')
  if (!key || key.length < 4) return raw
  return raw.includes(key) ? raw.split(key).join('[redacted]') : raw
}

/**
 * Live-validate a Composio *project* API key.
 * `fetchImpl` is injectable so tests never touch the network.
 * Never logs or returns the key.
 */
export async function testComposioKey(apiKey, {
  fetchImpl = globalThis.fetch,
  baseURL = COMPOSIO_API_BASE,
  timeoutMs = 8000,
} = {}) {
  const key = String(apiKey || '').trim()
  if (!key) return { ok: false, error: 'missing_key' }
  if (key.includes('...')) return { ok: false, error: 'masked_key' }
  if (isUserApiKey(key)) return { ok: false, error: 'user_api_key' }
  if (typeof fetchImpl !== 'function') return { ok: false, error: 'no_fetch' }

  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null
  try {
    const res = await fetchImpl(`${String(baseURL).replace(/\/$/, '')}/connected_accounts?limit=1`, {
      method: 'GET',
      headers: { 'x-api-key': key, 'content-type': 'application/json' },
      ...(ctrl ? { signal: ctrl.signal } : {}),
    })
    const status = Number(res?.status) || 0
    if (res && res.ok) return { ok: true, status }
    let detail = ''
    try { detail = redactSecret(await res.text(), key).slice(0, 200) } catch { /* ignore */ }
    if (status === 401 || status === 403) return { ok: false, error: 'unauthorized', status }
    return { ok: false, error: 'http', status, detail: detail || undefined }
  } catch (err) {
    if (err?.name === 'AbortError') return { ok: false, error: 'timeout' }
    return { ok: false, error: 'network' }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
