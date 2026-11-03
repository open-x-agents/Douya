// Register Composio / today / identity tools onto a real dsh `ctx.tools` so the
// ds-bot Chief (and every Bot) can call them. ask-bridge is not the chat backend.

import { createRequire } from 'node:module'
import { createComposioTools } from './agent-tools.js'
import { fetchIdentityFromSources } from './identity.js'

const output = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
}

function resolveDefineTool() {
  const candidates = [
    '/Users/danyangchen/.dsh/profiles/package.json',
    '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/package.json',
  ]
  let last
  for (const anchor of candidates) {
    try {
      const r = createRequire(anchor)
      const mod = r('@deepseek-ai/dsh-tools')
      if (mod?.defineTool) return mod.defineTool
    } catch (e) { last = e }
  }
  throw last || new Error('defineTool not found')
}

function summarizeCard(c) {
  return {
    id: c.id,
    title: c.title,
    body: (c.body || '').slice(0, 400),
    source: c.source,
    url: c.url || null,
    status: c.status,
  }
}

function schemaToParams(inputSchema) {
  if (!inputSchema || typeof inputSchema !== 'object') return {}
  const props = inputSchema.properties || {}
  const required = new Set(inputSchema.required || [])
  const out = {}
  for (const [key, schema] of Object.entries(props)) {
    out[key] = {
      type: schema.type || 'string',
      description: schema.description || key,
      ...(schema.enum ? { enum: schema.enum } : {}),
      ...(required.has(key) ? { required: true } : {}),
      ...(schema.default !== undefined ? { default: schema.default } : {}),
    }
  }
  return out
}

/**
 * Register ODM tools on the live dsh tool registry (ds-bot Bots can call them).
 * @returns {Promise<() => void>} dispose
 */
export async function registerBotTools(ctx, opts = {}) {
  const { composioClient = null, getCards = () => [], home = '.odm-data', log = () => {} } = opts
  if (!ctx?.tools?.register) {
    log('dsbot-tools: ctx.tools missing — skip registration')
    return () => {}
  }

  let defineTool
  try {
    defineTool = resolveDefineTool()
  } catch (err) {
    try {
      const mod = await import('/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js')
      defineTool = mod.defineTool
    } catch (e2) {
      log(`dsbot-tools: defineTool unavailable (${err.message})`)
      return () => {}
    }
  }

  const disposers = []
  const register = (tool) => {
    try {
      const dispose = ctx.tools.register(tool)
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (err) {
      log(`dsbot-tools: register ${tool.name} failed: ${err.message}`)
    }
  }

  register(defineTool({
    name: 'odm_whoami',
    description: 'Lookup the user display name and identity from connected sources (GitHub preferred). Use when the user asks who they are, their name, or GitHub login.',
    parameters: {},
    output,
    async execute() {
      try {
        const id = await fetchIdentityFromSources(composioClient, { home, log })
        if (!id || (!id.name && !id.login && !id.email)) {
          return JSON.stringify({ found: false, message: 'No identity found from connected sources. Connect GitHub first.' })
        }
        return JSON.stringify({ found: true, name: id.name || null, login: id.login || null, email: id.email || null, source: id.source || null })
      } catch (err) {
        return JSON.stringify({ found: false, error: err.message })
      }
    },
  }))

  register(defineTool({
    name: 'odm_today_cards',
    description: 'List cards on the Today dashboard. Use for questions about today digest or a specific card.',
    parameters: {
      cardId: { type: 'string', description: 'Optional card id' },
    },
    output,
    async execute(args) {
      const cards = getCards() || []
      if (args?.cardId) {
        const one = cards.find(c => c.id === args.cardId)
        return JSON.stringify(one ? { card: summarizeCard(one) } : { error: 'card not found' })
      }
      return JSON.stringify({ count: cards.length, cards: cards.slice(0, 30).map(summarizeCard) })
    },
  }))

  register(defineTool({
    name: 'odm_ask_cite',
    description: 'Evidence-first lookup over today cards. Returns a short answer with citations, or says nothing was found. Use for fact questions that need citations. This is a tool for the Bot — not the chat backend.',
    parameters: {
      question: { type: 'string', required: true, description: 'The factual question' },
      cardId: { type: 'string', description: 'Optional card id' },
    },
    output,
    async execute(args) {
      try {
        const ask = await import('../host/ask.js')
        const cards = getCards() || []
        const evidence = typeof ask.evidenceFromState === 'function'
          ? ask.evidenceFromState({ cards })
          : { items: cards }
        const result = await ask.askQuestion({
          question: String(args?.question || ''),
          evidence,
          cardId: args?.cardId || null,
        })
        return JSON.stringify({
          status: result?.status || 'unknown',
          text: result?.text || '',
          citations: result?.citations || [],
        })
      } catch (err) {
        return JSON.stringify({ status: 'error', error: err.message })
      }
    },
  }))

  const composioDefs = createComposioTools(composioClient)
  for (const def of composioDefs) {
    register(defineTool({
      name: `odm_${def.name}`,
      description: def.description,
      parameters: schemaToParams(def.inputSchema),
      output,
      async execute(args) {
        try {
          return JSON.stringify(await def.execute(args || {}))
        } catch (err) {
          return JSON.stringify({ error: err.message })
        }
      },
    }))
  }

  log(`dsbot-tools: registered ${disposers.length} tools (composio=${composioDefs.length})`)
  return () => { for (const d of disposers.splice(0).reverse()) try { d() } catch { /* ignore */ } }
}
