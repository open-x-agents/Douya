// Day pulse (Phase C): time-aware bits of 今天 computed from live data only — after-hours collapse, the warm
// greeting line, and the end-of-day "今天搞定了什么" card. Nothing here is hardcoded content: every count, title
// and link comes from the store (cards, itemStatus, completions, executed actions). Times are Asia/Shanghai.
import { isWorkCard } from './card-prep.js'

const SH = 8 * 3600e3
const clip = (v, n) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s }
const shDay = ms => new Date(ms + SH).toISOString().slice(0, 10)
export const shHour = (now = Date.now()) => new Date(now + SH).getUTCHours()
const shWeekday = (now = Date.now()) => new Date(now + SH).getUTCDay()
const https = u => (typeof u === 'string' && /^https:\/\//.test(u) ? u : null)

/** Work-ish cards collapse after hours: code, chat and machine mail. Personal mail / tasks / views stay. */
const WORK_GROUPS = new Set(['code', 'security', 'updates'])
export function isWorkish(card) {
  if (!isWorkCard(card)) return false
  if (card.source === 'github' || card.source === 'slack') return true
  return card.type === 'email-group' && WORK_GROUPS.has(card.metadata?.group)
}

/** After hours = before 07:00, from 19:00, or a weekend (Shanghai). `hour` overrides the clock (tests / ?hour=). */
export function isAfterHours({ now = Date.now(), hour = null } = {}) {
  const h = Number.isInteger(hour) ? hour : shHour(now)
  const wd = shWeekday(now)
  return h < 7 || h >= 19 || wd === 0 || wd === 6
}

/** What got done today: cards finished, items ticked, actions 豆芽 executed (not undone). null when nothing. */
export function doneToday({ completions = [], itemStatus = {}, pendingActions = {}, now = Date.now() } = {}) {
  const day = shDay(now)
  const today = at => { const t = Date.parse(at || ''); return Number.isFinite(t) && shDay(t) === day }
  const cards = (completions || []).filter(c => c && c.action === 'done' && c.kind !== 'item' && c.by !== 'action' && today(c.at))
  const items = Object.entries(itemStatus || {}).filter(([, v]) => v && v.status === 'done' && v.by !== 'system' && v.by !== 'action' && today(v.at))
  const acts = Object.values(pendingActions || {}).filter(a => a && a.status === 'executed' && !a.undoneAt && today(a.executedAt))
  const count = cards.length + items.length + acts.length
  if (!count) return null
  const hi = []
  for (const a of acts.sort((x, y) => String(y.executedAt).localeCompare(String(x.executedAt)))) hi.push({ kind: 'action', text: clip(a.summary || a.action, 60), url: null, at: a.executedAt })
  for (const c of cards.sort((x, y) => String(y.at).localeCompare(String(x.at)))) hi.push({ kind: 'card', text: clip(c.title, 60), url: https(c.url), at: c.at })
  for (const [u, v] of items.sort((x, y) => String(y[1].at).localeCompare(String(x[1].at)))) hi.push({ kind: 'item', text: clip(v.title || u, 60), url: https(u), at: v.at })
  const seen = new Set()
  const highlights = hi.filter(h => h.text && !seen.has(h.text) && seen.add(h.text)).slice(0, 5)
  const parts = []
  if (cards.length) parts.push(`收掉 ${cards.length} 张卡`)
  if (items.length) parts.push(`处理 ${items.length} 条`)
  if (acts.length) parts.push(`豆芽替你做了 ${acts.length} 件`)
  return { count, cards: cards.length, items: items.length, actions: acts.length, line: parts.join(' · '), highlights, cardIds: [...new Set(cards.map(c => c.cardId).filter(Boolean))].slice(-40) }
}

/** One warm line under the greeting, from live counts. Never invents: empty data → a plain honest line. */
export function greetingLine({ hour = null, now = Date.now(), cards = [], next = null, meetingsLeft = 0, done = null } = {}) {
  const h = Number.isInteger(hour) ? hour : shHour(now)
  const work = cards.filter(c => isWorkCard(c) && (!c.status || c.status === 'active'))
  const waiting = work.filter(c => c.waiting === 'you').length
  const d = done?.count || 0
  const first = next && next.kind === 'card' && next.title ? `先从「${clip(next.title, 18)}」开始吧` : next && next.kind === 'meeting' ? `「${clip(next.title, 16)}」${next.live ? '正在进行' : '马上开始'}` : ''
  if (!work.length && !d) return h < 11 ? '早安，今天还很清爽，没有待办。' : '眼下没有待办，难得清闲。'
  const left = work.length ? `今天 ${work.length} 件在手${waiting ? `，${waiting} 件有人在等你` : ''}` : '手上的都清空了'
  const meet = meetingsLeft ? `，还有 ${meetingsLeft} 个会` : ''
  if (h >= 5 && h < 11) return `早安。${left}${meet}${first ? `——${first}` : ''}。`
  if (h >= 11 && h < 14) return `中午好${d ? `，上午已经搞定 ${d} 件` : ''}。${left}${meet}${first ? `，${first}` : ''}。`
  if (h >= 14 && h < 19) return `下午好${d ? `，已经搞定 ${d} 件` : ''}。${left}${meet}${first ? `，${first}` : ''}。`
  return d ? `辛苦了，今天搞定了 ${d} 件。${work.length ? '剩下的明早再说。' : '收工！'}` : `下班时间了。${work.length ? `还有 ${work.length} 件，明早再说也不迟。` : '好好休息。'}`
}
