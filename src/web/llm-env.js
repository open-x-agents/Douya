// Apply the Muse LLM config into process.env for dsh / ds-bot.
// Chat goes through Chief, which resolves models via agent-default-model + provider apiKeyEnv
// (DeepSeek → DEEPSEEK_API_KEY). Saving keys only into .odm-data/config.json left a fresh install
// with a filled 配置 page but "No model is available" / no reply until restart — and even then
// start-dsh used to export only OPENAI_API_KEY.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
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
