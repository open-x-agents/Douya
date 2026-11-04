// Apply the Muse LLM config into process.env for dsh / ds-bot.
// Chat goes through Chief, which resolves models via agent-default-model + provider apiKeyEnv
// (DeepSeek → DEEPSEEK_API_KEY). Saving keys only into .odm-data/config.json left a fresh install
// with a filled 配置 page but "No model is available" / no reply until restart — and even then
// start-dsh used to export only OPENAI_API_KEY.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

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
  const model = llm.model || (provider === 'deepseek' ? 'deepseek-chat' : 'gpt-4o')
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
