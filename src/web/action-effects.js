/**
 * What a write action changes besides the outside world. When the user confirms an action
 * (a reply, a comment, an archive) and it runs, everything else in 豆芽 must know at once:
 * the card chat gets a 「已发送 · HH:MM」 line (so the bot's earlier 「还没发出去」 is superseded,
 * also for the bot's own context on the next turn), the item it handled is marked done (so the
 * hero, the checklist and the next digest stop treating it as needing a reply), and a card with
 * nothing left is tucked into 今天搞定了什么. A failed send keeps the action pending with its reason.
 */
import { setItemStatus, cardItemUrls } from '../host/store.js'
import { cardClearance, completeClearedCard } from './card-clearance.js'
import { chatKeysOf, stripDay } from '../host/reconcile.js'
import { doneVerb, doneVerbMap, formatOutcomeText, formatHistoryOutcome, hhmmFor, resolveLang, DEFAULT_LOCALE } from '../i18n/index.js'

/** @deprecated prefer doneVerb(action, lang); kept as zh map for older callers/tests. */
export const DONE_VERB = doneVerbMap('zh')
/** Actions that finish the user's part of the item they touch. */
const HANDLES = new Set(Object.keys(DONE_VERB))
const CLOSED = new Set(['done', 'dismissed'])

export const hhmm = (d = new Date(), lang = 'zh') => hhmmFor(lang, d)

/** The card's own item URLs this action touched (never invents one outside the card, except an explicit url). */
export function touchedUrls(card, a) {
  const inp = a?.input || {}
  const links = [...cardItemUrls(card || {})]
  const out = new Set()
  for (const it of Array.isArray(inp.items) ? inp.items : []) if (it?.url) out.add(it.url)
  if (inp.url) out.add(inp.url)
  const tid = String(inp.thread_id || inp.thread_ts || inp.message_id || '')
  if (tid) for (const u of links) if (u.includes(tid) || u.includes('p' + tid.replace('.', ''))) out.add(u)
  if (inp.number) for (const u of links) if (new RegExp(`/(pull|issues)/${Number(inp.number)}(?:$|[/?#])`).test(u)) out.add(u)
  if (!out.size && links.length === 1) out.add(links[0])
  return [...out]
}

/** The zoom-chat key the client uses for this card (an existing transcript wins). */
export function chatKeyOf(card, cardChats = {}) {
  const keys = chatKeysOf(card)
  return keys.find(k => cardChats?.[k]?.length)
    || keys.find(k => /^(repo|mail):|^timetable$/.test(k))
    || (card.sourceId ? stripDay(card.sourceId) : card.id)
}

/**
 * Mutates state after an action settled. Returns { text, key, marked, cardDone }.
 * @param {object} state
 * @param {object} a the action record (status executed | failed)
 * @param {{ now?: Date, chat?: boolean }} opts chat=false skips the chat line (bot-run direct actions report themselves)
 */
export function applyActionOutcome(state, a, { now = new Date(), chat = true, lang = DEFAULT_LOCALE } = {}) {
  const locale = resolveLang(lang)
  const card = (state.cards || []).find(c => c.id === a.cardId) || null
  const ok = a.status === 'executed'
  const marked = []
  let cardDone = false
  if (ok && card && HANDLES.has(a.action)) {
    for (const url of touchedUrls(card, a)) {
      if (CLOSED.has(state.itemStatus?.[url]?.status)) continue
      const ll = (card.blocks || []).find(b => b?.type === 'link-list')
      const title = ll?.links?.find(l => l?.url === url)?.title || a.summary || ''
      setItemStatus(state, { card, url, title, action: 'done', by: 'action' })
      state.itemStatus[url] = { ...state.itemStatus[url], via: a.id, verb: doneVerb(a.action, locale) }
      marked.push(url)
    }
    if (marked.length && cardClearance(card, state.itemStatus || {}).kind === 'cleared') {
      cardDone = completeClearedCard(state, card, { by: 'action', at: now.toISOString() })
    }
  }
  const text = formatOutcomeText({
    ok, action: a.action, summary: a.summary, error: a.error,
    time: hhmm(now, locale), cardDone, marked: marked.length, lang: locale,
  })
  let key = null
  if (chat && card) {
    key = chatKeyOf(card, state.cardChats)
    const prior = state.cardChats?.[key] || []
    state.cardChats = { ...(state.cardChats || {}), [key]: [...prior, { role: 'assistant', text, at: now.toISOString(), system: true, actionId: a.id, lang: locale }].slice(-40) }
  }
  return { text, key, marked, cardDone, ok, lang: locale }
}

const clip = (t, n) => { t = String(t || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t }

/**
 * For every chat turn (the general Today chat too): what the user already finished recently, so
 * Chief never lists a sent reply as still open. Invisible context, not a chat message.
 */
export function recentOutcomesText(state, { now = Date.now(), hours = 24, max = 8 } = {}) {
  const since = now - hours * 3600e3
  const recent = at => { const t = Date.parse(at || ''); return Number.isFinite(t) && t >= since && t <= now + 60e3 }
  const acts = Object.values(state?.pendingActions || {})
    .filter(a => a && a.status === 'executed' && !a.undoneAt && recent(a.executedAt))
    .sort((x, y) => String(y.executedAt).localeCompare(String(x.executedAt))).slice(0, max)
  const actCards = new Set(acts.map(a => a.cardId).filter(Boolean))
  const cards = (state?.cards || [])
    .filter(c => c && c.status === 'done' && recent(c.completedAt) && !actCards.has(c.id) && c.type !== 'hero' && c.type !== 'timetable')
    .sort((x, y) => String(y.completedAt).localeCompare(String(x.completedAt))).slice(0, 6)
  if (!acts.length && !cards.length) return ''
  const lines = ['【刚处理完 · 以此为准】下面这些用户已经做完（邮件/评论已发出），回答「还有什么没做」时不要再列它们，也别说「还没发/待确认」：']
  for (const a of acts) {
    const card = (state.cards || []).find(c => c.id === a.cardId)
    lines.push(`- ${hhmm(a.executedAt)} ${DONE_VERB[a.action] || '已执行'}：${clip(a.summary || a.action, 80)}${card ? `（卡片「${clip(card.title, 30)}」${card.status === 'done' ? '已收掉' : ''}）` : ''}`)
  }
  for (const c of cards) lines.push(`- ${hhmm(c.completedAt)} 已收掉卡片：${clip(c.title, 60)}`)
  return lines.join('\n')
}

/** One-time, idempotent: run executed actions that predate the outcome path through it (marks a.outcomeAt). */
export function backfillOutcomes(state, { now = new Date(), hours = 48 } = {}) {
  const since = now.getTime() - hours * 3600e3
  const done = []
  for (const a of Object.values(state?.pendingActions || {})) {
    if (!a || a.status !== 'executed' || a.undoneAt || a.outcomeAt) continue
    if (!(Date.parse(a.executedAt || '') >= since)) continue
    const o = applyActionOutcome(state, a, { now: new Date(a.executedAt), chat: false })
    a.outcomeAt = now.toISOString()
    done.push({ id: a.id, action: a.action, marked: o.marked.length, cardDone: o.cardDone })
  }
  return done
}

/**
 * General (Today) chat history: after the bot message that prepared an action (「已准备好…点确认执行」),
 * show what became of it — 「✓ 已发送 · HH:MM」 — so the transcript never ends on a stale 「还没发出去」.
 * Matches by the action's label (e.g. 「回复邮件给 x@y」) in that message; pure, adds no stored message.
 */
export function annotateHistoryWithOutcomes(messages = [], actions = {}, { now = Date.now(), hours = 48, lang = DEFAULT_LOCALE } = {}) {
  const locale = resolveLang(lang)
  const settled = Object.values(actions || {}).filter(a => a && (a.status === 'executed' || a.status === 'undone') && Date.parse(a.executedAt || '') >= now - hours * 3600e3)
  if (!settled.length || !Array.isArray(messages)) return messages
  const textOf = m => String(m?.content ?? m?.text ?? '')
  const out = [], used = new Set()
  for (const m of messages) {
    out.push(m)
    if (m?.role !== 'assistant') continue
    const t = textOf(m)
    // Match Chinese or English pending-confirm phrasing in the preparing message.
    if (!/确认执行|待确认|还没发|未发送|没发出|confirm|not sent|awaiting confirm|pending confirm/i.test(t)) continue
    for (const a of settled) {
      if (used.has(a.id)) continue
      const label = String(a.summary || '').split(/[：:]/)[0].trim()
      if (label.length < 6 || !t.includes(label)) continue
      used.add(a.id)
      const text = formatHistoryOutcome({
        status: a.status, action: a.action, summary: a.summary,
        time: hhmm(a.status === 'undone' ? (a.undoneAt || now) : a.executedAt, locale),
        lang: locale,
      })
      out.push({ role: 'assistant', content: text, outcome: { actionId: a.id, status: a.status } })
    }
  }
  return out
}
