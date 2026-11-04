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

## 用户正在看的卡片（【当前卡片】）
- 在卡片对话里，每条用户消息前面都带着这张卡片此刻的快照：id、标题、来源、摘要、数字、下一步、链接，以及「相关条目」（标题、URL、待处理/已完成/已忽略、发件人、时间、消息内容）。
- 问「这张卡片里有什么 / 有哪几条 / 先处理哪个」→ 直接按快照回答，**不要**再调 GitHub / Gmail / Slack，也不要 git clone 或用 bash 去翻仓库。
- 需要快照之外的细节（完整正文、全部条目）→ 先调 odm_current_card；确实需要信源最新内容时才调 odm_github_* / odm_gmail_* / odm_slack_*，不要用 bash 克隆仓库代替。
- 改这张卡片时直接用快照里的 id，不必先 odm_card_list。

## 用户眼前的面板（【当前视图】与 odm_ui_op）
- 每条消息前面带着【当前视图】：用户在哪一页、有没有筛选、放大了哪张卡、置顶了什么、屏幕上能看到哪些卡（括号里是卡片 id）。问「我现在在看什么 / 这个 / 这张」时先按它回答，不要调别的工具。
- 用户这轮**明确要求**改面板时，调 odm_ui_op 立刻做，不要只回文字：
  - 「打开 / 放大 / 看看 X 那张卡」→ op=openCard, card=<id>；「关掉 / 返回」→ op=closeCard
  - 「只看需要我处理的 / 只看邮件 / 只看 GitHub」→ op=filter（needsYou=true 或 sources=gmail,github,slack 或 status=needs-you|waiting-others|priority|fyi）；「显示全部 / 取消筛选」→ op=clearFilter
  - 「把 X 置顶 / 放最前 / 排到前面」→ op=arrange, pin=<id>, reason=一句理由；「取消置顶」→ arrange, unpin=<id>
  - 「标出 / 高亮 X（里的某条）」→ op=highlight, card=<id>, item=<条目 url>, reason
  - 「去信源状态 / 去配置 / 回今天」→ op=navigate, page=sources|settings|today
  - 「撤销刚才的调整」→ op=undo（可带 id）
- card 只能填卡片 id（来自【当前视图】或 odm_ui_state 的 cards 列表），item 只能填卡片里的条目 url；id 不确定先调 odm_ui_state，不要猜。工具报错会给候选，按候选改了再调。
- 用户没要求、但你觉得调整布局有帮助时，调 odm_ui_op 并填 requested=false：面板不变，只显示「豆芽建议 · 应用 / 忽略」，由用户决定。用户手动固定的卡永远在最前，你不能取消。
- reason 写给用户看：15 字以内，说为什么（如「在等你回答」），不要重复卡片标题。
- 【当前视图】是此刻的真实状态，以它为准（之前的置顶 / 筛选可能已被用户撤销）。回答时说卡片标题，不要把卡片 id、撤销 id 这类内部编号念给用户。
- 做完用一句话说明改了什么（工具返回的 message），布局改动提醒用户面板上可以点「撤销」。odm_ui_op 只改视图，不发送任何东西；发邮件 / 评论等仍然只能走 odm_act_* 生成待确认卡。

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

## 操作邮箱 / GitHub / Slack（odm_act_*）
- 可直接做、可撤销：odm_act_gmail_archive / gmail_mark_read / gmail_mark_unread / gmail_label / gmail_create_draft / slack_add_reaction。做完照实说做了什么，并提示可在卡片里撤销。
- 对外发出或不可逆：odm_act_gmail_send_email / gmail_reply / gmail_trash / slack_reply / github_comment / github_close_issue / github_reopen_issue / github_review / github_merge。这些只会生成「待确认」卡片；你必须告诉用户「已准备好，请在下方卡片点 确认执行」，绝不能说已经发出/已合并。
- 目标优先用 odm_card_list 返回的 items[].url（Gmail / Slack permalink / GitHub 链接），不要编 id。发信前把收件人、主题、正文写清楚给用户看。
- 批量操作（如归档 20 封促销）逐封调用；超过 10 封先问用户。

## 信源工具出错时
- 先真的调用一次对应工具（如「看看邮件」→ odm_gmail_fetch_emails），不要凭印象说工具不在。
- 工具返回 error 时，照实说是哪个信源（Gmail / GitHub / Slack / 日历）出了什么错，并建议到豆芽左侧的「信源状态」页重新连接该信源；可同时用已有卡片里的内容先顶上，并说明那是上次汇聚的数据。
- 这里的产品叫「豆芽」。不要让用户去 FlyBot、Composio 控制台或其他产品里操作。

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
    getComposioClient = null,
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
  const registered = []
  // Takes a thunk so a bad schema in one defineTool() can't abort every later registration.
  const register = (make) => {
    let tool
    try {
      tool = typeof make === 'function' ? make() : make
      const d = ctx.tools.register(tool)
      if (typeof d === 'function') disposers.push(d)
      registered.push(tool.name)
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
      const { catalogPrompt } = await import('../ui/catalog.js')
      const d2 = ctx.systemPrompt.section({ name: 'opendigitalmate-ui-catalog', order: 651, interpolate: false, text: catalogPrompt() })
      if (typeof d2 === 'function') disposers.push(d2)
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
    name: 'odm_current_card',
    description: 'The Today card the user has open in 豆芽 right now (or by cardId): id, title, source, summary, numbers, next step, actions, and every related item (title, url, status open/done/dismissed, sender, time, message text). Use before calling GitHub/Gmail/Slack about "this card".',
    parameters: { cardId: { type: 'string', description: 'Optional card id; default = the card whose chat is open' } },
    output,
    async execute(args) {
      try {
        if (router?.currentCard) return JSON.stringify(router.currentCard({ cardId: args?.cardId || null }))
        if (args?.cardId) return JSON.stringify({ found: true, card: await cards.get(args.cardId) })
        return JSON.stringify({ found: false, error: 'no current card' })
      } catch (err) { return JSON.stringify({ found: false, error: err.message }) }
    },
  }))

  // 豆芽 Intelligent UI (P1): view operations on the panel the user has open. Ids only, validated by the server.
  if (router?.uiOp) {
    register(() => defineTool({
      name: 'odm_ui_op',
      description: '操作用户眼前的豆芽面板（只改视图，不发送任何东西）：openCard 打开卡片放大页、closeCard 关闭、highlight 高亮卡片或其中一条、filter 筛选今天页、clearFilter 清除筛选、arrange 置顶/取消置顶/重排（必须写 reason）、navigate 切页（today/sources/settings）、undo 撤销最近的布局改动。card 必须是卡片 id，item 必须是该卡条目的 url。只在用户这轮明确要求时调用。',
      parameters: {
        op: { type: 'string', enum: ['openCard', 'closeCard', 'highlight', 'filter', 'clearFilter', 'arrange', 'navigate', 'undo'], required: true, description: '操作' },
        card: { type: 'string', description: 'openCard / highlight：卡片 id' },
        item: { type: 'string', description: 'highlight：卡片里某个条目的 url（可选）' },
        sources: { type: 'string', description: 'filter：来源，逗号分隔 github,gmail,slack' },
        needsYou: { type: 'boolean', description: 'filter：只看需要用户处理的' },
        priority: { type: 'boolean', description: 'filter：只看优先的' },
        status: { type: 'string', enum: ['needs-you', 'waiting-others', 'priority', 'fyi'], description: 'filter：按状态' },
        pin: { type: 'string', description: 'arrange：要置顶的卡片 id，逗号分隔' },
        unpin: { type: 'string', description: 'arrange：取消置顶的卡片 id，逗号分隔' },
        order: { type: 'string', description: 'arrange：希望的顺序（卡片 id，逗号分隔）' },
        reason: { type: 'string', description: '给用户看的一句理由（arrange 必填，highlight 建议填）' },
        ttl: { type: 'string', description: 'highlight 持续时间，如 10m、1h（默认 10m）' },
        page: { type: 'string', enum: ['today', 'sources', 'settings'], description: 'navigate：目标页' },
        id: { type: 'string', description: 'undo：要撤销的操作 id（默认最近一次）' },
        requested: { type: 'boolean', description: '用户这轮明确要求了这个改动吗？没要求、是你主动想调整布局时填 false：面板不会变，只给用户显示「豆芽建议 · 应用 / 忽略」' },
      },
      output,
      async execute(args) {
        try { return JSON.stringify(await router.uiOp(args || {}, { by: 'bot' })) }
        catch (err) { return JSON.stringify({ success: false, error: err.message }) }
      },
    }))
    if (router.uiRender) {
      register(() => defineTool({
        name: 'odm_ui_render',
        description: '生成一个临时视图（表格 / 列表 / 对比 / 键值 / 时间线 / 图表 / 表单 / 提示 / 按钮），显示在回复下方。数据只能引用卡片和条目（source），链接和数字由服务端从 store 填，不能自己写。表单提交只会发一句话或生成待你确认卡。规格见系统提示「临时视图」。',
        parameters: {
          title: { type: 'string', required: true, description: '视图标题（≤60 字）' },
          components: { type: 'string', required: true, description: 'JSON 数组：[{"id":"root","type":"Table","source":{...},"columns":[...]}, ...]' },
          dataModel: { type: 'string', description: '可选 JSON 对象：表单默认值、说明文字等，组件用 {"$data":"key"} 引用' },
          placement: { type: 'string', enum: ['chat', 'panel'], description: 'chat（默认，回复下方）| panel（同时放到今天页顶部）' },
          cardId: { type: 'string', description: '相关卡片 id（卡片对话里填当前卡片）' },
        },
        output,
        async execute(args) {
          try { return JSON.stringify(await router.uiRender(args || {}, { cardId: args?.cardId || null })) }
          catch (err) { return JSON.stringify({ success: false, error: err.message }) }
        },
      }))
      register(() => defineTool({
        name: 'odm_ui_update',
        description: '更新已生成视图的 dataModel（合并；值为 null 删除该 key），例如改表单默认正文、说明文字。也可改 title。',
        parameters: {
          surfaceId: { type: 'string', required: true, description: 'odm_ui_render 返回的 surfaceId' },
          dataModel: { type: 'string', required: true, description: 'JSON 对象补丁' },
          title: { type: 'string', description: '新标题（可选）' },
        },
        output,
        async execute(args) {
          try { return JSON.stringify(await router.uiUpdate(args || {})) }
          catch (err) { return JSON.stringify({ success: false, error: err.message }) }
        },
      }))
    }
    register(() => defineTool({
      name: 'odm_ui_state',
      description: '用户此刻的豆芽面板完整状态：所在页、放大中的卡片和选中条目、筛选、置顶（用户固定/豆芽置顶）、高亮、屏幕上可见的卡片、最近的视图操作，以及今天页所有卡片（id、标题、来源、是否需要用户处理、是否被筛掉）。找卡片 id 或回答「我在看什么」时用。',
      parameters: {},
      output,
      async execute() {
        try { return JSON.stringify(router.uiState()) }
        catch (err) { return JSON.stringify({ error: err.message }) }
      },
    }))
  }

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

  // The client can be built after plugin setup (config loads async, or is saved later from
  // 信源状态/配置). Register the tools against a lazy proxy so they always exist for Chief.
  const resolveClient = () => (typeof getComposioClient === 'function' ? getComposioClient() : null) || composioClient
  const lazyClient = new Proxy({}, {
    get(_t, key) {
      const c = resolveClient()
      if (!c) return () => { throw new Error('Composio 未配置：请到豆芽「配置」页填写 API Key，并在「信源状态」页连接信源') }
      const v = c[key]
      return typeof v === 'function' ? v.bind(c) : v
    },
  })
  // Composio write actions. Reversible ones execute; outgoing ones only create a pending action
  // the user confirms in 豆芽. There is deliberately no confirm tool.
  if (router?.requestAction) {
    const { ACTIONS } = await import('./actions.js')
    for (const [name, def] of Object.entries(ACTIONS)) {
      register(() => defineTool({
        name: `odm_act_${name}`,
        description: `${def.desc}${def.risk === 'confirm' ? ' — 只生成待确认卡片，用户点确认后才执行' : ' — 立即执行，可撤销'}。可带 cardId 关联卡片，title 用于展示。`,
        parameters: { ...def.params, cardId: { type: 'string', description: '相关卡片 id' }, title: { type: 'string', description: '条目标题（展示用）' } },
        output,
        async execute(args) {
          try { return JSON.stringify(await router.requestAction(name, args || {}, { cardId: args?.cardId || null })) }
          catch (err) { return JSON.stringify({ success: false, error: err.message }) }
        },
      }))
    }
  }

  const composioDefs = createComposioTools(lazyClient)
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

  const summary = `dsbot-tools: registered ${registered.length} tools (failed=${failed.length}${failed.length ? ': ' + failed.join(',') : ''}; composio=${resolveClient() ? 'ready' : 'lazy'}; cards=${router ? 'in-process' : museUrl}): ${registered.join(' ')}`
  log(summary)
  console.log(`[odm] ${summary}`)
  return () => { for (const d of disposers.splice(0).reverse()) try { d() } catch { /* */ } }
}
