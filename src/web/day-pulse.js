// Day pulse (Phase C): time-aware bits of 今天 computed from live data only — after-hours collapse, the warm
// greeting line, and the end-of-day "今天搞定了什么" card. Nothing here is hardcoded content: every count, title
// and link comes from the store (cards, itemStatus, completions, executed actions). Times are Asia/Shanghai.
import { isWorkCard } from './card-prep.js'
import { t, resolveLang, DEFAULT_LOCALE } from '../i18n/index.js'

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
export function doneToday({ completions = [], itemStatus = {}, pendingActions = {}, now = Date.now(), lang = DEFAULT_LOCALE } = {}) {
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
  const locale = resolveLang(lang)
  const parts = []
  if (cards.length) parts.push(t('done.line_cards', locale, { n: cards.length }))
  if (items.length) parts.push(t('done.line_items', locale, { n: items.length }))
  if (acts.length) parts.push(t('done.line_acts', locale, { n: acts.length }))
  return { count, cards: cards.length, items: items.length, actions: acts.length, line: parts.join(' · '), highlights, cardIds: [...new Set(cards.map(c => c.cardId).filter(Boolean))].slice(-40) }
}

/** One warm line under the greeting, from live counts. Never invents: empty data → a plain honest line. */
export function greetingLine({ hour = null, now = Date.now(), cards = [], next = null, meetingsLeft = 0, done = null, lang = DEFAULT_LOCALE } = {}) {
  const locale = resolveLang(lang)
  const h = Number.isInteger(hour) ? hour : shHour(now)
  const work = cards.filter(c => isWorkCard(c) && (!c.status || c.status === 'active'))
  const waiting = work.filter(c => c.waiting === 'you').length
  const d = done?.count || 0
  let firstBit = ''
  if (next && next.kind === 'card' && next.title) firstBit = t('greet.start_card', locale, { title: clip(next.title, 18) })
  else if (next && next.kind === 'meeting') firstBit = t(next.live ? 'greet.meet_live' : 'greet.meet_soon', locale, { title: clip(next.title, 16) })
  if (!work.length && !d) return h < 11 ? t('greet.morning_empty', locale) : t('greet.idle_empty', locale)
  const left = work.length
    ? t('greet.hands_n', locale, { n: work.length }) + (waiting ? t('greet.waiting_n', locale, { n: waiting }) : '')
    : t('greet.hands_clear', locale)
  const meet = meetingsLeft ? t('greet.meet_n', locale, { n: meetingsLeft }) : ''
  const firstMorning = firstBit ? (locale === 'zh' ? `——${firstBit}` : ` — ${firstBit}`) : ''
  const firstOther = firstBit ? (locale === 'zh' ? `，${firstBit}` : `, ${firstBit}`) : ''
  if (h >= 5 && h < 11) return t('greet.morning', locale, { left, meet, first: firstMorning })
  if (h >= 11 && h < 14) return t('greet.noon', locale, { done: d ? t('greet.noon_done', locale, { n: d }) : '', left, meet, first: firstOther })
  if (h >= 14 && h < 19) return t('greet.afternoon', locale, { done: d ? t('greet.afternoon_done', locale, { n: d }) : '', left, meet, first: firstOther })
  if (d) return t('greet.evening_done', locale, { n: d, rest: work.length ? t('greet.evening_rest_open', locale) : t('greet.evening_rest_clear', locale) })
  return t('greet.evening_empty', locale, { rest: work.length ? t('greet.evening_empty_open', locale, { n: work.length }) : t('greet.evening_empty_clear', locale) })
}
