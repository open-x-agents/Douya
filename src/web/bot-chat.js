// Persistent bot conversation for the standalone dashboard (`npm start`).
//
// Full ds-bot (vendor/ds-bot) needs Cordis + DSH and is started with `npm run start:dsbot`;
// the card UI's `npm start` path has no Cordis runtime. This module gives the same product
// shape there: one long-lived Bot the user talks to, with history and a MEMORY.md that
// survive restarts. Fact answers still go through ask-bridge → ask.js (cite-or-refuse);
// memory never invents work facts — only what the user said about themselves, or what a
// cited source already established.

import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { askWithEvidence, classifyTalk } from './ask-bridge.js'
import { createComposioTools } from './agent-tools.js'
import { groupsToCards } from './chat-groups.js'

export const BOT_SESSION_ID = 'bot-main'
const HISTORY_MAX = 40
const MEMORY_MAX = 4_000

const BOT_SYSTEM = `你是「豆芽」，用户的数字同事。你们是持续对话：记得之前说过的话，用简体中文自然地聊。

规则：
- 闲聊、问候、澄清需求：直接、温暖地回答，不要假装去查信源。
- 涉及邮件 / PR / issue / Slack / 日历 / 今天卡片的事实：只能依据工具或「依据问答」返回的内容说，并附上真实链接；没有依据就老实说不知道，不要编造数量、标题、人名。
- 用户告诉你的偏好、称呼、习惯，可以记入记忆（在最终 JSON 里用 remember 数组，每条一句短事实，要写清「用户…」）。
- 不要编造已经做过的事；不要假装有飞书/微信等未连接的通道。

最终只输出 JSON：
{"text":"给用户看的回复","remember":[],"forget":[]}
有工具结果时，可另附 "cards":[…]（type 为 group/info/action 的卡片）。`

function clean(v) { return String(v ?? '').replace(/\s+/g, ' ').trim() }

export function botDir(home) {
  return join(home || '.odm-data', 'bot')
}

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true })
}

export async function loadMemory(home) {
  const path = join(botDir(home), 'MEMORY.md')
  if (!existsSync(path)) return '# Memory\n\n'
  return readFile(path, 'utf8')
}

export async function saveMemory(home, content) {
  const dir = botDir(home)
  await ensureDir(dir)
  const clipped = String(content || '').slice(0, MEMORY_MAX)
  await writeFile(join(dir, 'MEMORY.md'), clipped.endsWith('\n') ? clipped : clipped + '\n', 'utf8')
}

export function appendMemoryEntries(current, entries = []) {
  let next = current && current.trim() ? current : '# Memory\n\n'
  for (const raw of entries) {
    const text = clean(raw)
    if (!text || text.length > 280) continue
    if (next.includes(text)) continue
    next = next.trimEnd() + `\n- ${text}\n`
  }
  return next.slice(0, MEMORY_MAX)
}

export async function loadHistory(home) {
  const path = join(botDir(home), 'history.json')
  if (!existsSync(path)) return []
  try {
    const data = JSON.parse(await readFile(path, 'utf8'))
    return Array.isArray(data.messages) ? data.messages : []
  } catch { return [] }
}

export async function saveHistory(home, messages) {
  const dir = botDir(home)
  await ensureDir(dir)
  const clipped = (messages || []).slice(-HISTORY_MAX)
  await writeFile(join(dir, 'history.json'), JSON.stringify({ messages: clipped, updatedAt: new Date().toISOString() }, null, 2), 'utf8')
  await appendFile(join(dir, 'journal.jsonl'), JSON.stringify({ at: new Date().toISOString(), n: clipped.length }) + '\n').catch(() => {})
}

function parseBotJson(text) {
  const t = String(text || '').trim()
  try { return JSON.parse(t) } catch {}
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) { try { return JSON.parse(fence[1]) } catch {} }
  const m = t.match(/\{[\s\S]*\}/)
  if (m) { try { return JSON.parse(m[0]) } catch {} }
  return { text: t || '……' }
}

async function streamText(llm, messages, { maxTokens = 1600 } = {}) {
  let out = ''
  for await (const chunk of llm.stream({ messages, maxTokens, responseFormat: { type: 'json_object' } })) {
    if (chunk.type === 'text' && chunk.text) out += chunk.text
  }
  return out
}

/**
 * One turn with the persistent Bot.
 * @returns {{text, status, citations, cards, memoryUpdated:boolean, history:Array}}
 */
export async function chatWithBot({
  message,
  cardId = null,
  cardContext = null,
  home = '.odm-data',
  cards = [],
  composioClient = null,
  llm = null,
  log = () => {},
} = {}) {
  const text = clean(message)
  if (!text) return { text: '想问哪一类？可以说邮件、PR、Slack 或今天的安排。', status: 'answered', citations: [], cards: [], memoryUpdated: false, history: await loadHistory(home) }
  if (!llm?.stream) return { text: '还没配置模型，没法对话。请先在「配置」里设置模型。', status: 'refused', citations: [], cards: [], memoryUpdated: false, history: [] }

  const history = await loadHistory(home)
  let memory = await loadMemory(home)

  // Fact-shaped questions: get a cited draft from ask.js, then let the Bot phrase it in-conversation.
  // Idle chat / memory / preferences must NOT hit ask.js (it would drag in unrelated Slack/mail hits).
  const talk = classifyTalk(text)
  const wantsFacts = !talk && !!(cardId || /邮件|邮箱|inbox|e-?mail|gmail|PR|pull request|合并请求|review|issue|工单|slack|频道|私信|channel|日历|日程|会议|今天.*安排|待办/i.test(text))
  let evidenceNote = ''
  let evidence = { citations: [], cards: [], status: null }
  if (wantsFacts) {
    try {
      evidence = await askWithEvidence({ question: text, cards, cardId, composioClient, llm, log })
      if (evidence.status !== 'refused' && evidence.text) {
        evidenceNote = `\n\n【依据问答 · 只能引用这些，不要加减事实】\n答案：${evidence.text}\n引用：${JSON.stringify(evidence.citations || [])}`
      } else if (evidence.status === 'refused') {
        evidenceNote = `\n\n【依据问答】没有找到能回答它的信源（${evidence.text}）。若这是事实问题，请如实告诉用户；若其实是闲聊，按闲聊回答。`
      }
    } catch (e) {
      log(`[bot] askWithEvidence failed: ${e.message}`)
    }
  }

  // Optional live tool pass for fact intents when ask returned thin results.
  let toolNote = ''
  if (wantsFacts && composioClient && (evidence.status === 'refused' || !(evidence.citations || []).length)) {
    const tools = createComposioTools(composioClient)
    const intents = [
      [/邮件|邮箱|inbox|e-?mail|gmail/i, 'gmail_fetch_emails'],
      [/\bPR\b|pull request|合并请求|review/i, 'github_search_my_prs'],
      [/\bissue/i, 'github_list_my_issues'],
      [/slack|频道|私信|channel/i, 'slack_search_messages'],
    ]
    const pre = []
    for (const [re, name] of intents) {
      if (!re.test(text)) continue
      const tool = tools.find(t => t.name === name)
      if (!tool) continue
      try {
        const result = await tool.execute({})
        if (Array.isArray(result?.groups)) evidence.cards = [...(evidence.cards || []), ...groupsToCards(result.groups)]
        pre.push({ tool: name, result })
      } catch (e) { pre.push({ tool: name, error: e.message }) }
    }
    if (pre.length) toolNote = `\n\n【工具预聚合 · 只能用这里的真实数据】\n${JSON.stringify(pre).slice(0, 12_000)}`
  }

  const memBlock = memory.trim() && memory.trim() !== '# Memory' ? `\n\n## 长期记忆（跨会话，来自用户亲口说过的话）\n${memory.slice(0, MEMORY_MAX)}` : '\n\n## 长期记忆\n（还没有条目）'
  const cardBlock = cardContext ? `\n\n## 当前卡片上下文（仅本轮）\n${clean(cardContext).slice(0, 1500)}` : ''

  const aboutSelf = /喜欢|偏好|记得我|我的名字|我叫什么|我是谁/.test(text)
  const memoryNudge = aboutSelf && memory.trim() && memory.trim() !== '# Memory'
    ? '\n\n（请根据上面的「长期记忆」直接回答，text 里写完整句子，不要空。）'
    : ''
  const messages = [
    { role: 'system', content: BOT_SYSTEM + memBlock + cardBlock },
    ...history.slice(-20).map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: text + evidenceNote + toolNote + memoryNudge },
  ]

  let raw = ''
  try {
    raw = await streamText(llm, messages)
  } catch (e) {
    log(`[bot] LLM failed: ${e.message}`)
    // Fall back to ask result or talk template if LLM is down.
    if (evidence?.text) return { text: evidence.text, status: evidence.status || 'answered', citations: evidence.citations || [], cards: evidence.cards || [], memoryUpdated: false, history }
    throw e
  }

  const parsed = parseBotJson(raw)
  const talkFallback = {
    greeting: '你好！我是豆芽，你的数字同事。可以问我今天的邮件、PR、Slack 或日程——我们会一直聊下去，我也记得你说过的事。',
    thanks: '不客气。有事随时叫我。',
    capability: '我能看已连接信源里的邮件、PR、Slack 和日历，也能记住你告诉我的偏好。问具体事实时我会附上依据。',
    clarify: '想聊哪一类？邮件、PR、Slack，还是今天的安排？',
  }
  const rawReply = clean(parsed.text)
  const usable = rawReply && !/^[….…·\s]+$/.test(rawReply) ? rawReply : ''
  // Prefer the model's phrasing; if it blanked out, fall back to cited evidence, then talk templates.
  let memoryReply = ''
  if (!usable && aboutSelf) {
    const bullets = [...memory.matchAll(/^-\s+(.+)$/gm)].map(m => m[1].trim()).filter(Boolean)
    if (bullets.length) memoryReply = bullets.map(b => b.replace(/^用户/, '你')).join('；') + '。'
  }
  const reply = usable || clean(evidence.text) || memoryReply || (talk && talkFallback[talk]) || (wantsFacts ? '我查过了，但没能组织成句子。请再问一次，或换个说法。' : '我在，接着说就行。')
  const remember = Array.isArray(parsed.remember) ? parsed.remember : []
  let memoryUpdated = false
  if (remember.length) {
    memory = appendMemoryEntries(memory, remember)
    await saveMemory(home, memory)
    memoryUpdated = true
  }

  const nextHistory = [
    ...history,
    { role: 'user', content: text, at: new Date().toISOString() },
    { role: 'assistant', content: reply, at: new Date().toISOString(), citations: evidence.citations || [] },
  ]
  await saveHistory(home, nextHistory)

  const cardsOut = Array.isArray(parsed.cards) && parsed.cards.length ? parsed.cards : (evidence.cards || [])
  return {
    text: reply,
    status: evidence.status === 'refused' && !talk && !evidence.citations?.length && /不知道|没有读到|答不了/.test(reply) ? 'refused' : 'answered',
    citations: evidence.citations || [],
    cards: cardsOut,
    memoryUpdated,
    history: nextHistory,
  }
}
