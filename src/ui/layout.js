// 豆芽 time-of-day ordering for 今天 (Intelligent UI P4). Pure functions; the page applies the result under
// the user's pins, 豆芽's pins and any order Chief set with arrange (those always win).
// score = 需要你处理 + 截止临近度 + 时段权重（类型 × 当前时段）+ 个人亲和度（打开 / 完成多的加分，常忽略的减分）− 陈旧度
// Restraint: the order is frozen per (day, period) and only recomputed when the period changes or new cards
// arrive with a digest; every card that moves up says why in one short line; it can be undone or turned off.

import { needsYou, cardKey, isActive, isWork, shDay } from './ops.js'

export const PERIODS = {
  morning: { label: '早上', why: '先定当天安排：要回的邮件和今天到期的事在前' },
  work: { label: '工作时段', why: '协作阻塞优先：等你 review 的 PR 和 @你的消息在前' },
  evening: { label: '傍晚', why: '收尾与准备：今天做完的和明天要到期的在前' },
}
const MIN_INTERACTIONS = 20 // below this, no personal calibration (the page says so)

const shHour = (ms) => new Date(ms + 8 * 3600e3).getUTCHours()

/** When the user's day starts, from profile activeHours (earliest hour 6–11 with activity), else 7. */
export function dayStartHour(activeHours = {}) {
  const hours = Object.entries(activeHours || {}).filter(([, n]) => Number(n) > 0).map(([h]) => Number(h)).filter(h => h >= 6 && h <= 11)
  return hours.length ? Math.min(...hours) : 7
}
export function periodOf(hour, activeHours = {}) {
  const start = dayStartHour(activeHours)
  if (hour >= start && hour < Math.max(start + 3, 10)) return 'morning'
  if (hour >= 10 && hour < 18 && hour >= start) return 'work'
  return 'evening'
}

/** Per-card-key affinity from profile counts: opened +, completed ++, dismissed −−. Range about [-1.5, 1.5]. */
export function affinityOf(profile) {
  const ci = profile?.preferences?.cardInteractions || {}
  const total = Number(profile?.stats?.totalInteractions) || 0
  const byKey = new Map()
  const add = (field, w) => { for (const [sid, n] of Object.entries(ci[field] || {})) { const k = sid.replace(/:\d{4}-\d{2}-\d{2}$/, ''); byKey.set(k, (byKey.get(k) || 0) + w * (Number(n) || 0)) } }
  add('opened', 1); add('completed', 2); add('dismissed', -2)
  const score = new Map()
  for (const [k, v] of byKey) score.set(k, Math.max(-1.5, Math.min(1.5, v >= 0 ? Math.log2(1 + v) * 0.5 : -Math.log2(1 - v) * 0.6)))
  return { enough: total >= MIN_INTERACTIONS, total, score }
}

function kindOf(card) {
  if (card.source === 'gmail') return card.type === 'email-action' || card.waiting === 'you' ? 'reply' : 'mail-fyi'
  if (card.source === 'github') return 'pr'
  if (card.source === 'slack') return card.waiting === 'you' ? 'mention' : 'slack-fyi'
  if (card.type === 'view') return 'view'
  return 'other'
}
const WEIGHTS = {
  morning: { reply: 3, 'mail-fyi': -1, pr: 1, mention: 1.5, 'slack-fyi': -0.5, view: 0, other: 0 },
  work: { reply: 1, 'mail-fyi': -1, pr: 3, mention: 3, 'slack-fyi': 0, view: 0, other: 0 },
  evening: { reply: 1, 'mail-fyi': -0.5, pr: 0.5, mention: 0.5, 'slack-fyi': -0.5, view: 0, other: 0 },
}
const KIND_WHY = {
  morning: { reply: '早上先回邮件' },
  work: { pr: '工作时段 PR 优先', mention: '工作时段先回 @你的消息' },
  evening: {},
}
function dueOf(card) { const d = Date.parse(card.dueAt || card.due || ''); return Number.isFinite(d) ? d : null }
function doneTodayCount(card, itemStatus = {}, now) {
  const day = shDay(now)
  let n = 0
  for (const v of Object.values(itemStatus || {})) if (v?.cardId === card.id && v.status === 'done' && shDay(Date.parse(v.at) || 0) === day) n++
  return n
}

/** Score + reason for each work card. */
export function scoreCards(cards, { now = Date.now(), period, itemStatus = {}, affinity = null } = {}) {
  const out = []
  for (const c of cards) {
    if (!isActive(c) || !isWork(c)) continue
    const parts = [] // [points, why]
    if (needsYou(c, itemStatus)) parts.push([3, '需要你处理'])
    if (c.priority === 'high' || c.priority === 'urgent') parts.push([1.5, null])
    const due = dueOf(c)
    if (due != null) {
      const h = (due - now) / 3600e3
      if (h < 0) parts.push([2.5, '已过截止'])
      else if (h < 24) parts.push([period === 'evening' ? 2.5 : 2, h < 12 ? '今天到期' : '明天到期'])
      else if (h < 48 && period === 'evening') parts.push([2, '明天到期'])
    }
    const kind = kindOf(c)
    const w = WEIGHTS[period][kind] || 0
    if (w) parts.push([w, KIND_WHY[period][kind] || null])
    if (period === 'evening') { const d = doneTodayCount(c, itemStatus, now); if (d) parts.push([2.5, `今天完成了 ${d} 条`]) }
    if (affinity?.enough) {
      const a = affinity.score.get(cardKey(c)) || 0
      if (a) parts.push([a, a >= 0.75 ? '你常打开' : a <= -0.6 ? '你常忽略' : null])
    }
    const upd = Date.parse(c.updatedAt || c.createdAt || '')
    if (Number.isFinite(upd) && now - upd > 48 * 3600e3) parts.push([-1, null])
    const score = parts.reduce((s, [p]) => s + p, 0)
    const why = parts.filter(([p, t]) => t && p > 0).sort((a, b) => b[0] - a[0]).map(([, t]) => t)
    out.push({ id: c.id, score, why })
  }
  return out
}

/** The existing default: high priority first, otherwise store order (what the page did before P4). */
export function baselineOrder(cards) {
  const work = cards.filter(c => isActive(c) && isWork(c))
  return [...work].sort((a, b) => (b.priority === 'high') - (a.priority === 'high')).map(c => c.id)
}

/**
 * Compute (or keep) today's time-of-day order.
 * prev = state.ui.auto from the last computation; kept while day + period match and no new cards arrived.
 */
export function computeAutoLayout(cards, { now = Date.now(), profile = null, itemStatus = {}, prev = null, enabled = true, hour = null } = {}) {
  const activeHours = profile?.preferences?.activeHours || {}
  const h = Number.isInteger(hour) ? hour : shHour(now)
  const period = periodOf(h, activeHours)
  const key = `${shDay(now)}|${period}`
  const affinity = affinityOf(profile)
  const base = baselineOrder(cards)
  const note = affinity.enough ? `按${PERIODS[period].label}排序，并参考你打开 / 完成过的卡（${affinity.total} 次记录）` : `按${PERIODS[period].label}排序；还没有足够的使用记录（${affinity.total} 次），暂不按你的习惯调整`
  const meta = { enabled, period, periodLabel: PERIODS[period].label, rationale: PERIODS[period].why, key, dayStart: dayStartHour(activeHours), enough: affinity.enough, interactions: affinity.total, note }
  if (!enabled) return { ...meta, order: [], reasons: {}, kept: false }
  const live = new Set(base)
  if (prev && prev.key === key && Array.isArray(prev.order) && base.every(id => prev.order.includes(id))) {
    return { ...meta, order: prev.order.filter(id => live.has(id)), reasons: prev.reasons || {}, computedAt: prev.computedAt, kept: true }
  }
  const scored = scoreCards(cards, { now, period, itemStatus, affinity })
  const s = new Map(scored.map(x => [x.id, x]))
  const basePos = new Map(base.map((id, i) => [id, i]))
  const order = [...base].sort((a, b) => (s.get(b)?.score ?? 0) - (s.get(a)?.score ?? 0) || basePos.get(a) - basePos.get(b))
  // Only cards that moved up get a "why it's here" line, so the page doesn't shout.
  const reasons = {}
  order.forEach((id, i) => {
    if (i < basePos.get(id) && (s.get(id)?.why || []).length) reasons[id] = s.get(id).why.slice(0, 2).join(' · ')
  })
  return { ...meta, order, reasons, computedAt: new Date(now).toISOString(), kept: false }
}
