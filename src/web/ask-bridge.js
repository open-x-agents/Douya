// The dashboard's questions go through main's evidence-first ask engine (src/host/ask.js).
//
// The engine is synchronous and its model is a seam, so this bridge does the async part around
// it: gather citable evidence (today's cards, plus a live read of the source the question is
// about), rank it with the engine's own rankSources, let the configured LLM draft claims for
// exactly those candidates, then hand the drafted claims to askQuestion as its model. The engine
// still drops any claim whose ref is not in the evidence or whose times / amounts are not in the
// cited source, and refuses when nothing survives — so the reply can only say what a source says.

import { askQuestion, rankSources, sourceLabel } from '../host/ask.js'
import { createComposioTools } from './agent-tools.js'

const KIND_WORDS = {
  github: 'GitHub 代码 仓库 PR pull request review issue',
  gmail: '邮件 邮箱 email inbox',
  slack: 'Slack 消息 频道 私信 回复',
  googlecalendar: '日历 日程 会议 calendar',
}
const SOURCE_ID = { github: 'github', gmail: 'composio:gmail', slack: 'composio:slack', googlecalendar: 'composio:googlecalendar' }

// Which live reads a question needs. Matching is on what the question names, not on who asks.
const INTENTS = [
  [/邮件|邮箱|inbox|e-?mail|gmail/i, 'gmail_fetch_emails', {}, 'gmail'],
  [/\bPR\b|pull request|合并请求|review|代码审/i, 'github_search_my_prs', {}, 'github'],
  [/\bissue|工单/i, 'github_list_my_issues', {}, 'github'],
  [/slack|频道|私信|channel/i, 'slack_search_messages', {}, 'slack'],
]

// Collapse whitespace, and glue a number to its unit ("3 个" -> "3个") the way the engine's
// anchor check reads it, so a claim quoting the source verbatim is not dropped for a space.
const clean = v => String(v ?? '').replace(/\s+/g, ' ').replace(/(\d)\s+(万|元|%|分钟|小时|人|个|件|点)/g, '$1$2').trim()
const WAITING_ZH = { you: '等你处理', others: '等别人', true: '等你处理', false: '仅供参考', fyi: '仅供参考' }

function linksOfCard(card) {
  const out = []
  const walk = v => {
    if (!v || typeof v !== 'object') return
    if (Array.isArray(v)) return v.forEach(walk)
    if (typeof v.url === 'string' && /^https?:/.test(v.url) && (v.title || v.label)) out.push({ title: clean(v.title || v.label), url: v.url })
    Object.values(v).forEach(walk)
  }
  walk(card.blocks)
  return out.filter((l, i) => out.findIndex(x => x.url === l.url) === i)
}

/** Today's (non-system, still open) cards as evidence: one source per card, one per linked item. */
export function evidenceFromCards(cards = []) {
  const sources = []
  for (const card of cards) {
    if (!card || card.source === 'system' || ['done', 'dismissed'].includes(card.status)) continue
    const kind = card.source
    const links = linksOfCard(card)
    const ref = card.url || links[0]?.url
    if (!ref) continue
    sources.push({
      ref, source: SOURCE_ID[kind] || kind, read_scope: 'card', at: card.updatedAt || card.createdAt || '',
      title: clean(card.title),
      excerpt: clean([KIND_WORDS[kind], card.subtitle, card.body, links.map(l => l.title).join('；')].filter(Boolean).join(' ')).slice(0, 900),
      cardId: card.id, links, summary: clean(card.body).slice(0, 160),
    })
    for (const l of links) sources.push({ ref: l.url, source: SOURCE_ID[kind] || kind, read_scope: 'card', at: card.updatedAt || '', title: clean(l.title), summary: clean(l.title), excerpt: clean(`${KIND_WORDS[kind] || ''} ${card.title} ${l.title}`), cardId: card.id })
  }
  return sources
}

/** A live, pre-aggregated group (from agent-tools) as evidence. Counts are written as "N个" so a claim may quote them. */
export function evidenceFromGroups(groups = [], kind) {
  const sources = []
  for (const g of groups) {
    const links = (g.links || []).filter(l => l?.url)
    const ref = links[0]?.url
    if (!ref) continue
    sources.push({
      ref: `group:${g.key}`, source: SOURCE_ID[kind] || kind, read_scope: 'live', at: new Date().toISOString(),
      title: clean(g.label), url: ref,
      excerpt: clean(`${KIND_WORDS[kind] || ''} ${g.label} 共${g.count}个 ${WAITING_ZH[g.waiting] || ''} ${g.why || ''} 下一步：${g.nextAction || ''} ${links.map(l => l.title).join('；')}`),
      group: g, links, summary: clean(`${g.label}：共${g.count}个${WAITING_ZH[g.waiting] ? '，' + WAITING_ZH[g.waiting] : ''}。${g.why || ''}${g.nextAction ? ' 下一步：' + g.nextAction : ''}`),
    })
    for (const l of links) sources.push({ ref: l.url, source: SOURCE_ID[kind] || kind, read_scope: 'live', at: new Date().toISOString(), title: clean(l.title), summary: clean(l.title), excerpt: clean(`${KIND_WORDS[kind] || ''} ${g.label} ${WAITING_ZH[g.waiting] || ''} ${l.title}`), group: g })
  }
  return sources
}

function claimPrompt(question, candidates) {
  const list = candidates.map(s => `- ref: ${s.ref}\n  来源: ${sourceLabel(s)}\n  标题: ${s.title}\n  内容: ${s.excerpt}`).join('\n')
  return `你是用户的数字同事。只根据下面这些信源回答用户的问题，用简体中文。

规则：
- 输出 2~5 条 claim，每条是一句完整、有用的话（先说结论/该做什么，再说依据），并标注它依据的那一条 ref（必须原样取自下面的列表）。
- 只写信源里确实写了的事实；不要编造数量、时间、人名、标题。提到时间、数字、金额时，必须与该信源里的写法逐字一致（例如信源写「共3个」就写「3个」）。
- 信源回答不了的部分不要写；不要断言「没有/不存在」某类事项，除非信源明确这样写；「等你」「等别人」按信源原文；如果都答不了，返回空数组。
- 不要复述规则，不要输出 Markdown。

用户问题：${question}

信源：
${list}

只输出 JSON：{"claims":[{"text":"...","ref":"..."}]}`
}

async function draftClaims(llm, question, candidates) {
  if (!llm?.stream || !candidates.length) return null
  let text = ''
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      text = ''
      for await (const chunk of llm.stream({ messages: [{ role: 'user', content: claimPrompt(question, candidates) }], maxTokens: 1200, responseFormat: { type: 'json_object' } })) {
        if (chunk.type === 'text' && chunk.text) text += chunk.text
      }
      break
    } catch (e) {
      if (attempt === 2 || !/\b(429|5\d\d)\b|busy|timeout/i.test(e.message)) throw e
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1)))
    }
  }
  const m = text.match(/\{[\s\S]*\}/)
  const parsed = JSON.parse(m ? m[0] : text)
  return Array.isArray(parsed?.claims) ? parsed.claims : []
}

/**
 * Answer a dashboard question with citations.
 * @returns {{text:string,status:string,citations:Array<{ref,url,label,title}>,cards:object[],dropped:number}}
 */
export async function askWithEvidence({ question, cards = [], cardId = null, composioClient = null, llm = null, log = () => {} }) {
  const text = clean(question)
  let pool = evidenceFromCards(cards)
  if (cardId) pool = pool.filter(s => s.cardId === cardId)
  const scopedCard = cardId ? cards.find(c => c.id === cardId) : null
  const unread = []

  // Live reads for what the question names (scoped to the card's source when asking from a card).
  const tools = composioClient ? createComposioTools(composioClient) : []
  const named = new Set()   // source kinds the question names
  const live = []
  for (const [re, name, args, kind] of INTENTS) {
    if (scopedCard && scopedCard.source !== kind) continue
    if (!re.test(text) && !(scopedCard && scopedCard.source === kind)) continue
    const tool = tools.find(t => t.name === name)
    if (!tool) { named.add(kind); unread.push(SOURCE_ID[kind] || kind); continue }
    try {
      const r = await tool.execute(args)
      if (r?.error) { log(`[ask] ${name} failed: ${r.error}`); named.add(kind); unread.push(SOURCE_ID[kind] || kind); continue }
      named.add(kind)
      live.push(...evidenceFromGroups(r?.groups || [], kind))
    } catch (e) { log(`[ask] ${name} threw: ${e.message}`); unread.push(SOURCE_ID[kind] || kind) }
  }

  // When the question names a source, answer from that source only; a fresh live read of a
  // source replaces the digest's older cards for it.
  if (named.size) {
    const liveKinds = new Set(live.map(x => x.source))
    pool = [...pool.filter(x => [...named].some(k => (SOURCE_ID[k] || k) === x.source) && !liveKinds.has(x.source)), ...live]
  }
  const candidates = rankSources(text, pool)
  let drafted = null
  try { drafted = await draftClaims(llm, text, candidates) } catch (e) { log(`[ask] LLM draft failed: ${e.message}`) }
  // Without a usable draft, quote the top candidates' own summaries (never new wording).
  const fallback = () => ({ claims: candidates.slice(0, 3).map(c => ({ text: c.summary || c.title, ref: c.ref })) })
  const result = askQuestion({
    text, sources: pool,
    unread: candidates.length ? [] : unread,
    model: drafted && drafted.length ? () => ({ claims: drafted }) : fallback,
    now: () => Date.now(), budgetMs: 60_000,
  })
  if (result.dropped.length) log(`[ask] dropped: ${JSON.stringify(result.dropped).slice(0, 600)}`)

  const byRef = new Map(pool.map(s => [s.ref, s]))
  const citations = result.citations.map(c => {
    const s = byRef.get(c.ref) || {}
    return { ref: c.ref, url: s.url || (/^https?:/.test(c.ref) ? c.ref : s.links?.[0]?.url || ''), label: c.label, title: s.title || '' }
  })
  // Aggregated group cards for the cited live groups (the UI's group card), deduped by key.
  const seen = new Set()
  const groupCards = []
  for (const c of result.citations) {
    const g = byRef.get(c.ref)?.group
    if (!g || seen.has(g.key)) continue
    seen.add(g.key)
    groupCards.push({ type: 'group', key: g.key, title: g.label, label: g.label, count: g.count, waiting: g.waiting === true ? 'you' : g.waiting, why: g.why, description: g.why, nextAction: g.nextAction, breakdown: g.breakdown, links: (g.links || []).slice(0, 3), url: g.links?.[0]?.url })
  }
  return { text: result.answer, status: result.status, citations, cards: groupCards, dropped: result.dropped.length, candidates: candidates.length }
}
