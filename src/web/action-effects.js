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

export const DONE_VERB = {
  gmail_reply: '已发送', gmail_send_email: '已发送', slack_reply: '已发到 Slack',
  github_comment: '已评论', github_review: '已提交评审', github_close_issue: '已关闭', github_merge: '已合并',
  gmail_archive: '已归档', gmail_archive_many: '已归档', gmail_trash: '已删除',
}
/** Actions that finish the user's part of the item they touch. */
const HANDLES = new Set(Object.keys(DONE_VERB))
const CLOSED = new Set(['done', 'dismissed'])

export const hhmm = (d = new Date()) => new Date(d).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })

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
export function applyActionOutcome(state, a, { now = new Date(), chat = true } = {}) {
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
      state.itemStatus[url] = { ...state.itemStatus[url], via: a.id, verb: DONE_VERB[a.action] }
      marked.push(url)
    }
    if (marked.length && cardClearance(card, state.itemStatus || {}).kind === 'cleared') {
      cardDone = completeClearedCard(state, card, { by: 'action', at: now.toISOString() })
    }
  }
  const text = ok
    ? `✓ ${DONE_VERB[a.action] || '已执行'} · ${hhmm(now)}　${a.summary || a.action}${cardDone ? '。这张卡没有别的事了，已收进「今天搞定了什么」' : marked.length ? '。这一条已标成处理完' : ''}`
    : `✗ ${/reply|send/.test(a.action) ? '发送失败' : '执行失败'}：${a.error || '未知原因'}。操作还在，确认无误可以再点「确认执行」。`
  let key = null
  if (chat && card) {
    key = chatKeyOf(card, state.cardChats)
    const prior = state.cardChats?.[key] || []
    state.cardChats = { ...(state.cardChats || {}), [key]: [...prior, { role: 'assistant', text, at: now.toISOString(), system: true, actionId: a.id }].slice(-40) }
  }
  return { text, key, marked, cardDone, ok }
}
