// Register Composio / identity / CARD MUTATION tools onto dsh ctx.tools.
// Card writes go through Muse HTTP (same process under dsh). Composio stays read-only.

import { createRequire } from 'node:module'
import { createComposioTools } from './agent-tools.js'
import { fetchIdentityFromSources } from './identity.js'
import { createCardOps } from './card-ops.js'

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

export const CARD_WORK_PROMPT = `你是「豆芽」背后的 Main Bot（Chief）。对话不只是问答——用户要你干活时，必须调用工具改 Today 卡片或查信源，不要只嘴上答应。

## 什么时候必须动工具
- 「标完成 / 做完了 / 勾掉」→ odm_card_complete（先 odm_card_list 或 odm_card_find 找到 id）
- 「删掉 / 不要了 / 去掉促销」→ odm_card_dismiss 或 odm_card_delete（噪音用 dismiss；明确永久删除才 delete）
- 「推迟 / 明天再看」→ odm_card_snooze
- 卡片里的单个条目（某个 PR / issue / 邮件）「这个做完了 / 这条不用管」→ odm_card_item（action=done|dismiss|undo，url 用 odm_card_list 返回的 items[].url）；不要因此把整张卡标完成
- 「改标题 / 改成… / 下一步改成…」→ odm_card_update
- 「加一张 / 记一下 / 待办」→ odm_card_create
- 「刷新今日 / 重新汇聚」→ odm_digest_refresh
- 问邮件/PR/Slack/日历 → odm_github_* / odm_gmail_* / odm_slack_* / odm_calendar_*（只读）
- 「我是谁」→ odm_whoami

## 规矩
1. 改卡前若只有关键词，先 find/list 确认 id；多张匹配时列出请用户选。
2. 改完用工具返回的 success/card 确认（标题+新状态），完成会写入持久 completions。
3. 不编造 id/链接/数量。Composio 保持只读。
4. 用简体中文简短回复。

## 回复格式（会按 Markdown 渲染）
- 用真正的换行，不要把列表挤在一行里用「 - 」隔开。
- 汇总类回答按类别分组：每组一行加粗小标题带数量（如 **要处理（3）**、**可以不管（12）**），下面每条一行「- 标题 — 一句话动作」，有链接就写成 [标题](url)。
- 先给结论一句话，再给分组；噪音类只给数量和一个代表例子，并提出可一键处理（如「要我把这 12 封促销 dismiss 掉吗？」）。
- 不用表格，不用多级标题；最多用 ### 一级小标题。`

export async function registerBotTools(ctx, opts = {}) {
  const {
    composioClient = null,
    getCards = () => [],
    home = '.odm-data',
    museUrl = process.env.ODM_MUSE_URL || 'http://127.0.0.1:7777',
    router = null,
    log = () => {},
  } = opts

  if (!ctx?.tools?.register) {
    log('dsbot-tools: ctx.tools missing — skip')
    return () => {}
  }

  let defineTool
  try {
    defineTool = resolveDefineTool()
  } catch (err) {
    try {
      const mod = await import('/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js')
      defineTool = mod.defineTool
    } catch {
      log(`dsbot-tools: defineTool unavailable (${err.message})`)
      return () => {}
    }
  }

  const cards = createCardOps({ baseUrl: museUrl, router })
  const disposers = []
  const failed = []
  // Takes a thunk so a bad schema in one defineTool() can't abort every later registration.
  const register = (make) => {
    let tool
    try {
      tool = typeof make === 'function' ? make() : make
      const d = ctx.tools.register(tool)
      if (typeof d === 'function') disposers.push(d)
    } catch (err) {
      failed.push(tool?.name || '?')
      log(`dsbot-tools: register ${tool?.name || '(defineTool)'} failed: ${err.message}`)
      console.error(`[odm] dsbot-tools: tool registration failed: ${err.message}`)
    }
  }

  if (typeof ctx.systemPrompt?.section === 'function') {
    try {
      // dsh-system-prompt sections take `text` (string or fn); `content` crashes every turn.
      const d = ctx.systemPrompt.section({
        name: 'opendigitalmate-card-work',
        order: 650,
        interpolate: false,
        text: CARD_WORK_PROMPT,
      })
      if (typeof d === 'function') disposers.push(d)
      log('dsbot-tools: systemPrompt section installed')
    } catch (err) {
      log(`dsbot-tools: systemPrompt failed: ${err.message}`)
    }
  }

  register(() => defineTool({
    name: 'odm_whoami',
    description: 'Lookup user display name from connected sources (GitHub preferred).',
    parameters: {},
    output,
    async execute() {
      try {
        const id = await fetchIdentityFromSources(composioClient, { home, log })
        if (!id || (!id.name && !id.login)) return JSON.stringify({ found: false })
        return JSON.stringify({ found: true, name: id.name || null, login: id.login || null, source: id.source || null })
      } catch (err) {
        return JSON.stringify({ found: false, error: err.message })
      }
    },
  }))

  register(() => defineTool({
    name: 'odm_card_list',
    description: 'List Today cards. status: active|done|snoozed|dismissed|all.',
    parameters: { status: { type: 'string', description: 'active (default) | done | snoozed | dismissed | all' } },
    output,
    async execute(args) {
      try { return JSON.stringify(await cards.list({ status: args?.status || 'active' })) }
      catch (err) { return JSON.stringify({ error: err.message, count: 0, cards: [] }) }
    },
  }))

  register(() => defineTool({
    name: 'odm_card_find',
    description: 'Find active cards by title/body keyword.',
    parameters: { query: { type: 'string', required: true, description: 'Keyword' } },
    output,
    async execute(args) {
      try { return JSON.stringify(await cards.findByTitle(args?.query || '')) }
      catch (err) { return JSON.stringify({ error: err.message, count: 0, cards: [] }) }
    },
  }))

  register(() => defineTool({
    name: 'odm_today_cards',
    description: 'Alias of odm_card_list.',
    parameters: {
      cardId: { type: 'string' },
      status: { type: 'string' },
    },
    output,
    async execute(args) {
      try {
        if (args?.cardId) return JSON.stringify({ card: await cards.get(args.cardId) })
        return JSON.stringify(await cards.list({ status: args?.status || 'active' }))
      } catch (err) {
        return JSON.stringify({ error: err.message })
      }
    },
  }))

  register(() => defineTool({
    name: 'odm_card_create',
    description: 'Create a Today card (task/note/reminder).',
    parameters: {
      title: { type: 'string', required: true },
      body: { type: 'string' },
      type: { type: 'string' },
      priority: { type: 'string' },
      url: { type: 'string' },
      nextAction: { type: 'string' },
    },
    output,
    async execute(args) {
      try { return JSON.stringify(await cards.create(args || {})) }
      catch (err) { return JSON.stringify({ success: false, error: err.message }) }
    },
  }))

  register(() => defineTool({
    name: 'odm_card_update',
    description: 'Update card by id (title/body/priority/status/url/nextAction/links).',
    parameters: {
      id: { type: 'string', required: true },
      title: { type: 'string' },
      body: { type: 'string' },
      priority: { type: 'string' },
      status: { type: 'string' },
      url: { type: 'string' },
      nextAction: { type: 'string' },
      links: { type: 'string', description: 'JSON array of {title,url}' },
    },
    output,
    async execute(args) {
      try {
        const { id, links, ...rest } = args || {}
        const updates = { ...rest }
        if (typeof links === 'string' && links.trim()) {
          try { updates.links = JSON.parse(links) } catch { /* ignore */ }
        }
        return JSON.stringify(await cards.update(id, updates))
      } catch (err) {
        return JSON.stringify({ success: false, error: err.message })
      }
    },
  }))

  register(() => defineTool({
    name: 'odm_card_complete',
    description: 'Mark card done. Writes durable completion record.',
    parameters: { id: { type: 'string', required: true } },
    output,
    async execute(args) {
      try { return JSON.stringify(await cards.complete(args?.id, { by: 'bot' })) }
      catch (err) { return JSON.stringify({ success: false, error: err.message }) }
    },
  }))

  register(() => defineTool({
    name: 'odm_card_dismiss',
    description: 'Dismiss card (not hard-delete). Prefer for noise/promo.',
    parameters: { id: { type: 'string', required: true } },
    output,
    async execute(args) {
      try { return JSON.stringify(await cards.dismiss(args?.id, { by: 'bot' })) }
      catch (err) { return JSON.stringify({ success: false, error: err.message }) }
    },
  }))

  register(() => defineTool({
    name: 'odm_card_snooze',
    description: 'Snooze card. Default 24h.',
    parameters: {
      id: { type: 'string', required: true },
      hours: { type: 'number' },
      until: { type: 'string' },
    },
    output,
    async execute(args) {
      try { return JSON.stringify(await cards.snooze(args?.id, { hours: args?.hours, until: args?.until })) }
      catch (err) { return JSON.stringify({ success: false, error: err.message }) }
    },
  }))

  register(() => defineTool({
    name: 'odm_card_delete',
    description: 'Permanently delete card. Only when user clearly asks.',
    parameters: { id: { type: 'string', required: true } },
    output,
    async execute(args) {
      try { return JSON.stringify(await cards.remove(args?.id)) }
      catch (err) { return JSON.stringify({ success: false, error: err.message }) }
    },
  }))

  register(() => defineTool({
    name: 'odm_card_item',
    description: 'Mark ONE related item (PR / issue / mail link) inside a Today card as done / dismiss, or undo. Persists by item url and survives digests. Does not change the whole card.',
    parameters: {
      id: { type: 'string', required: true, description: 'card id' },
      url: { type: 'string', required: true, description: 'item url from odm_card_list items[].url' },
      action: { type: 'string', description: 'done | dismiss | undo (default done)' },
      title: { type: 'string', description: 'item title for the ledger' },
    },
    output,
    async execute(args) {
      try { return JSON.stringify(await cards.item(args?.id, args?.url, args?.action || 'done', args?.title || '')) }
      catch (err) { return JSON.stringify({ success: false, error: err.message }) }
    },
  }))

  register(() => defineTool({
    name: 'odm_digest_refresh',
    description: 'Regenerate Today digest. Preserves completed cards/history.',
    parameters: {},
    output,
    async execute() {
      try { return JSON.stringify(await cards.refreshDigest()) }
      catch (err) { return JSON.stringify({ success: false, error: err.message }) }
    },
  }))

  register(() => defineTool({
    name: 'odm_completions_list',
    description: 'List durable completion/dismiss history (survives digests and restarts).',
    parameters: {},
    output,
    async execute() {
      try { return JSON.stringify(await cards.listCompletions()) }
      catch (err) { return JSON.stringify({ error: err.message, completions: [] }) }
    },
  }))

  register(() => defineTool({
    name: 'odm_ask_cite',
    description: 'Evidence-first lookup over today cards. Tool only — not chat backend.',
    parameters: {
      question: { type: 'string', required: true },
      cardId: { type: 'string' },
    },
    output,
    async execute(args) {
      try {
        const ask = await import('../host/ask.js')
        const list = getCards() || []
        const evidence = typeof ask.evidenceFromState === 'function' ? ask.evidenceFromState({ cards: list }) : { items: list }
        const result = await ask.askQuestion({ question: String(args?.question || ''), evidence, cardId: args?.cardId || null })
        return JSON.stringify({ status: result?.status || 'unknown', text: result?.text || '', citations: result?.citations || [] })
      } catch (err) {
        return JSON.stringify({ status: 'error', error: err.message })
      }
    },
  }))

  const composioDefs = createComposioTools(composioClient)
  for (const def of composioDefs) {
    register(() => defineTool({
      name: `odm_${def.name}`,
      description: def.description,
      parameters: schemaToParams(def.inputSchema),
      output,
      async execute(args) {
        try { return JSON.stringify(await def.execute(args || {})) }
        catch (err) { return JSON.stringify({ error: err.message }) }
      },
    }))
  }

  log(`dsbot-tools: registered disposers=${disposers.length} failed=${failed.length} composio=${composioDefs.length} cards=${router ? 'in-process' : museUrl}`)
  return () => { for (const d of disposers.splice(0).reverse()) try { d() } catch { /* */ } }
}
