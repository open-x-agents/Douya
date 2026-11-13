// Apply the Muse LLM config into process.env for dsh / ds-bot.
// Chat goes through Chief, which resolves models via agent-default-model + provider apiKeyEnv
// (DeepSeek → DEEPSEEK_API_KEY). Saving keys only into .odm-data/config.json left a fresh install
// with a filled 配置 page but "No model is available" / no reply until restart — and even then
// start-dsh used to export only OPENAI_API_KEY.
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs'
import { join, dirname } from 'node:path'

// DeepSeek's API serves `deepseek-flash` (display name DeepSeek-V4.1-Flash, input text+image) and
// `deepseek-v4-pro` (text). `deepseek-chat` is a legacy alias (non-thinking flash). dsh's llm-pi-ai
// only lets images through when the catalog entry declares `input: [text, image]`, otherwise
// sessionController.prompt refuses with MODEL_DOES_NOT_SUPPORT_IMAGES and chat degrades to a note.
export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-flash'
export const DEEPSEEK_VISION_MODELS = new Set(['deepseek-flash'])
export const DEEPSEEK_LEGACY_MODELS = new Set(['deepseek-chat'])

/** The llm-pi-ai catalog entry (YAML, at `indent` spaces) for deepseek-flash. */
export function deepseekFlashModelYaml(indent = 10) {
  const pad = ' '.repeat(indent)
  return [
    '- id: deepseek-flash',
    '  name: DeepSeek-V4.1-Flash',
    '  input: [text, image]',
    '  contextWindow: 1048576',
    '  maxTokens: 32768',
    '  reasoningEfforts:',
    '    off:',
    '    low: low',
    '    high: high',
    '    max: max',
    '  compat:',
    '    thinkingFormat: deepseek',
    '    requiresReasoningContentOnAssistantMessages: true',
    '    supportsDeveloperRole: false',
    '    supportsStore: false',
    '    maxTokensField: max_tokens',
  ].map(l => pad + l).join('\n') + '\n'
}

/**
 * Make the dsh profile patch's llm-pi-ai `deepseek` route serve deepseek-flash with image input.
 * Text edit (no YAML dep): inserts the model under the route's `models:` list when missing, or appends
 * a whole llm-pi-ai entry when the patch has none. Returns true when the file changed.
 */
export function ensureProfileDeepseekCatalog(patchFile, { defaultModel = null } = {}) {
  if (!patchFile) return false
  let text = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : ''
  const before = text
  if (!/^- id: llm-pi-ai\b/m.test(text)) {
    text = (text && !text.endsWith('\n') ? text + '\n' : text) + [
      '- id: llm-pi-ai',
      '  name: "@deepseek-ai/dsh-llm-pi-ai"',
      '  config:',
      '    providers:',
      '      deepseek:',
      '        displayName: DeepSeek',
      '        apiKeyEnv: OPENAI_API_KEY',
      '        api: openai-completions',
      '        baseURL: https://api.deepseek.com',
      '        models:',
    ].join('\n') + '\n' + deepseekFlashModelYaml(10)
  } else if (!/^\s*- id: deepseek-flash\s*$/m.test(text)) {
    const m = text.match(/^( *)deepseek:\s*\n(?:\1 .*\n)*?(\1 +)models:\s*\n/m)
    if (!m) return false
    const at = m.index + m[0].length
    const indent = m[2].length + 2
    text = text.slice(0, at) + deepseekFlashModelYaml(indent) + text.slice(at)
  }
  if (defaultModel) {
    text = text.replace(/(^- id: agent-default-model[ \t]*\n(?: .*\n)*? +model:[ \t]*)deepseek-chat[ \t]*$/m, `$1${defaultModel}`)
  }
  if (text === before) return false
  mkdirSync(dirname(patchFile), { recursive: true })
  writeFileSync(patchFile, text)
  return true
}

const stripV1 = u => String(u || '').replace(/\/v1\/?$/, '')

/** @returns {{ openai: boolean, deepseek: boolean, baseURL: string|null }} which env vars were set */
export function applyLlmEnv(llm = {}, env = process.env) {
  const key = llm.apiKey || env.OPENAI_API_KEY || env.DEEPSEEK_API_KEY
  const provider = String(llm.provider || '').toLowerCase()
  const base = llm.baseURL ? stripV1(llm.baseURL) : null
  const out = { openai: false, deepseek: false, baseURL: null }
  if (!key) return out
  if (!env.OPENAI_API_KEY) { env.OPENAI_API_KEY = key; out.openai = true }
  else if (llm.apiKey) { env.OPENAI_API_KEY = llm.apiKey; out.openai = true }
  const wantsDeepseek = provider === 'deepseek' || /deepseek/.test(String(llm.baseURL || env.OPENAI_BASE_URL || ''))
  if (wantsDeepseek) {
    env.DEEPSEEK_API_KEY = llm.apiKey || env.DEEPSEEK_API_KEY || key
    out.deepseek = true
  }
  if (base) { env.OPENAI_BASE_URL = base; out.baseURL = base }
  else if (!env.OPENAI_BASE_URL && wantsDeepseek) { env.OPENAI_BASE_URL = 'https://api.deepseek.com'; out.baseURL = env.OPENAI_BASE_URL }
  return out
}

/** Ensure DSH_HOME/settings.yaml has agent-default-model so Chief has a route on first boot. */
export function ensureAgentDefaultModel(dshHome, llm = {}) {
  if (!dshHome) return false
  mkdirSync(dshHome, { recursive: true })
  const file = join(dshHome, 'settings.yaml')
  const provider = String(llm.provider || 'deepseek').toLowerCase() || 'deepseek'
  const model = llm.model || (provider === 'deepseek' ? DEEPSEEK_DEFAULT_MODEL : 'gpt-4o')
  const block = `agent-default-model:\n  provider: ${provider}\n  model: ${model}\n`
  if (!existsSync(file)) { writeFileSync(file, block); return true }
  let text = readFileSync(file, 'utf8')
  if (/^agent-default-model\s*:/m.test(text)) {
    // Keep an existing block, but refresh provider/model when the user saved a new one.
    if (llm.provider || llm.model) {
      text = text.replace(/^agent-default-model:\n(?:  .*\n)*/m, block)
      writeFileSync(file, text)
      return true
    }
    return false
  }
  writeFileSync(file, text.endsWith('\n') ? text + block : text + '\n' + block)
  return true
}

const CREDENTIALS_FILE = '.credentials.yaml'
// Catalog routes that already declare a protocol and models. A wizard "custom"
// provider (or moonshot / zhipu, which are not catalog ids) must be declared.
const PI_AI_CATALOG = new Set([
  'amazon-bedrock', 'ant-ling', 'anthropic', 'azure', 'baseten', 'cerebras',
  'cloudflare-ai-gateway', 'cloudflare-workers-ai', 'deepseek', 'fireworks',
  'github-copilot', 'google', 'google-vertex', 'groq', 'huggingface',
  'kimi-coding', 'meta', 'minimax', 'minimax-cn', 'mistral', 'moonshotai',
  'moonshotai-cn', 'nvidia', 'openai', 'openai-codex', 'openrouter',
  'qwen-token-plan', 'qwen-token-plan-cn', 'qwen-token-plan-individual',
  'radius', 'together', 'vercel-ai-gateway', 'xai', 'xiaomi',
  'xiaomi-token-plan-ams', 'xiaomi-token-plan-cn', 'xiaomi-token-plan-sgp',
  'zai', 'zai-coding-cn',
])

const PROVIDER_KEY_ENV = {
  deepseek: 'DEEPSEEK_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  moonshot: 'MOONSHOT_API_KEY',
  moonshotai: 'MOONSHOT_API_KEY',
  'moonshotai-cn': 'MOONSHOT_API_KEY',
  google: 'GEMINI_API_KEY',
  groq: 'GROQ_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  zhipu: 'ZAI_API_KEY',
  zai: 'ZAI_API_KEY',
}

/** Env refs the odm DeepSeek profile and OpenAI-compatible routes resolve. Never log these values. */
export function llmCredentialRefs(llm = {}) {
  const key = typeof llm.apiKey === 'string' ? llm.apiKey.trim() : ''
  if (!key || key.includes('...')) return {}
  const provider = String(llm.provider || '').toLowerCase()
  const refs = { OPENAI_API_KEY: key }
  const named = PROVIDER_KEY_ENV[provider]
  if (named) refs[named] = key
  else if (/deepseek/.test(String(llm.baseURL || ''))) refs.DEEPSEEK_API_KEY = key
  return refs
}

function yamlScalar(value) {
  return JSON.stringify(String(value))
}

/**
 * Insert or replace `refs` entries in a version-1 `$DSH_HOME/.credentials.yaml`.
 * The rest of the document (especially `records`, which holds the browser login
 * grant) is kept byte-for-byte. Returns null when the existing text is a layout
 * we must not rewrite.
 */
export function upsertCredentialRefs(text, updates) {
  const entries = Object.entries(updates || {}).filter(([k, v]) =>
    /^[A-Z][A-Z0-9_]*$/.test(k) && typeof v === 'string' && v.length > 0)
  if (!entries.length) return text == null ? '' : text
  const block = entries.map(([k, v]) => `  ${k}: ${yamlScalar(v)}`).join('\n') + '\n'
  const src = text == null ? '' : String(text).replace(/\r\n/g, '\n')
  if (!src.trim()) return `version: 1\nrefs:\n${block}`
  if (!/^version:\s*1[ \t]*$/m.test(src)) return null
  let next = src.endsWith('\n') ? src : src + '\n'
  if (!/^refs:/m.test(next)) {
    return next.replace(/^(version:\s*1[ \t]*\n)/m, `$1refs:\n${block}`)
  }
  for (const [k, v] of entries) {
    const line = `  ${k}: ${yamlScalar(v)}`
    const re = new RegExp(`^  ${k}:[^\\n]*\\n`, 'm')
    if (re.test(next)) next = next.replace(re, line + '\n')
    else next = next.replace(/^refs:[ \t]*\n/m, `refs:\n${line}\n`)
  }
  return next
}

function ownerOnly(file) {
  try { chmodSync(file, 0o600) } catch { /* Windows has no POSIX mode */ }
}

/**
 * Persist the Muse model key into dsh's credentials file so llm-pi-ai can
 * resolve it after launch. process.env is snapshotted at boot and later
 * writes are invisible; this file is watched and hot-reloaded. Never log the key.
 * @returns {boolean} whether the file was written
 */
export function syncLlmCredentials(dshHome, llm = {}) {
  const refs = llmCredentialRefs(llm)
  if (!dshHome || !Object.keys(refs).length) return false
  mkdirSync(dshHome, { recursive: true })
  const file = join(dshHome, CREDENTIALS_FILE)
  let current = ''
  if (existsSync(file)) {
    ownerOnly(file)
    current = readFileSync(file, 'utf8')
  }
  const next = upsertCredentialRefs(current, refs)
  if (next == null || next === current) return false
  writeFileSync(file, next, { mode: 0o600 })
  ownerOnly(file)
  return true
}

function safeIdent(value, fallback) {
  const s = String(value || '').trim()
  return /^[A-Za-z0-9._-]+$/.test(s) ? s : fallback
}

function providerRouteBlock(llm = {}) {
  const provider = safeIdent(String(llm.provider || '').toLowerCase(), '')
  if (!provider) return ''
  const apiKeyEnv = provider === 'deepseek' ? 'OPENAI_API_KEY' : (PROVIDER_KEY_ENV[provider] || 'OPENAI_API_KEY')
  const rawBase = llm.baseURL ? String(llm.baseURL).trim() : ''
  const baseURL = rawBase
    ? (provider === 'deepseek' ? stripV1(rawBase) : rawBase.replace(/\/$/, ''))
    : ''
  // Official DeepSeek is already declared in the odm profile (apiKeyEnv + models).
  const officialDeepseek = provider === 'deepseek' && (!baseURL || /api\.deepseek\.com$/.test(baseURL))
  if (officialDeepseek) return ''
  const lines = [
    'llm-pi-ai:',
    '  providers:',
    `    ${provider}:`,
    `      apiKeyEnv: ${apiKeyEnv}`,
  ]
  if (baseURL) lines.push(`      baseURL: ${yamlScalar(baseURL)}`)
  if (!PI_AI_CATALOG.has(provider)) {
    const model = safeIdent(llm.model, 'default')
    lines.push('      api: openai-completions')
    lines.push('      models:')
    lines.push(`        - id: ${model}`)
  }
  return lines.join('\n') + '\n'
}

/** Write a user-settings llm-pi-ai route for a custom baseURL or non-catalog provider. */
export function ensureProviderRoute(dshHome, llm = {}) {
  if (!dshHome) return false
  const block = providerRouteBlock(llm)
  if (!block) return false
  mkdirSync(dshHome, { recursive: true })
  const file = join(dshHome, 'settings.yaml')
  if (!existsSync(file)) { writeFileSync(file, block); return true }
  let text = readFileSync(file, 'utf8')
  if (/^llm-pi-ai\s*:/m.test(text)) {
    const next = text.replace(/^llm-pi-ai:\n(?:  .*\n)*/m, block)
    if (next === text) return false
    writeFileSync(file, next)
    return true
  }
  writeFileSync(file, text.endsWith('\n') ? text + block : text + '\n' + block)
  return true
}

/** Apply the saved Muse LLM config to DSH_HOME (settings + credentials). */
export function syncLlmToDsh(dshHome, llm = {}) {
  if (!dshHome) return { defaultModel: false, credentials: false, provider: false }
  return {
    defaultModel: ensureAgentDefaultModel(dshHome, llm),
    credentials: syncLlmCredentials(dshHome, llm),
    provider: ensureProviderRoute(dshHome, llm),
  }
}
