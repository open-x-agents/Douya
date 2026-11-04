// 豆芽 Intelligent UI, phase 1: declarative view operations + the 【当前视图】 context.
//
// Chief never writes UI. It calls odm_ui_op with an op from a fixed list; the server validates every card / item
// reference against the store, applies layout changes to state.ui (persisted, undoable, logged in state.uiLog)
// and pushes an event to the open 豆芽 tabs, which apply it with the existing components. Nothing here carries
// HTML or code — only ids, enums and short plain-text reasons.
//
// Everything in this file is pure (state in, state out) so it can be unit-tested without the host.

import { cardItemUrls } from '../host/store.js'

export const UI_OPS = ['openCard', 'closeCard', 'highlight', 'filter', 'clearFilter', 'arrange', 'navigate', 'undo']
export const LAYOUT_OPS = new Set(['filter', 'clearFilter', 'arrange'])
export const PAGES = { today: '今天', sources: '信源状态', settings: '配置' }
export const FILTER_STATUSES = { 'needs-you': '需要你处理', 'waiting-others': '在等别人', priority: '优先', fyi: '仅供参考' }
const SOURCE_ZH = { github: 'GitHub', gmail: 'Gmail', slack: 'Slack', googlecalendar: '日历', manual: '手动', 'bot-test': 'bot-test' }
const SOURCE_ALIAS = {
  github: 'github', gh: 'github', git: 'github', pr: 'github', 代码: 'github',
  gmail: 'gmail', email: 'gmail', mail: 'gmail', 邮件: 'gmail', 邮箱: 'gmail',
  slack: 'slack', 消息: 'slack',
  calendar: 'googlecalendar', googlecalendar: 'googlecalendar', 日历: 'googlecalendar', 日程: 'googlecalendar',
  manual: 'manual', 待办: 'manual',
}
const SYSTEM_TYPES = new Set(['hero', 'timetable'])
const MAX_REASON = 40
const MAX_PINS = 12
const LOG_MAX = 200

const one = (v) => String(v ?? '').replace(/\s+/g, ' ').trim()
const cut = (v, n) => { const s = one(v); return s.length > n ? `${s.slice(0, n - 1)}…` : s }
const list = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,，、\s]+/) : v == null ? [] : [v]).map(one).filter(Boolean)
const bool = (v) => v === true || v === 'true' || v === 1 || v === '1' || v === 'yes'
export const shDay = (ms = Date.now()) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10) // Asia/Shanghai

export function emptyUi() {
  return { layout: { pins: [], order: null }, filter: null, highlights: [] }
}
export function normalizeUi(raw) {
  const base = emptyUi()
  if (!raw || typeof raw !== 'object') return base
  return {
    layout: {
      pins: Array.isArray(raw.layout?.pins) ? raw.layout.pins.filter(p => p && p.key) : [],
      order: raw.layout?.order && Array.isArray(raw.layout.order.keys) ? raw.layout.order : null,
    },
    filter: raw.filter && typeof raw.filter === 'object' ? raw.filter : null,
    highlights: Array.isArray(raw.highlights) ? raw.highlights : [],
  }
}

/** Stable identity across daily digests: the sourceId without its day, else the card id. */
export function cardKey(card) {
  const sid = typeof card?.sourceId === 'string' ? card.sourceId : ''
  return sid ? sid.replace(/:\d{4}-\d{2}-\d{2}$/, '') : String(card?.id || '')
}

export const isActive = (c) => c && (!c.status || c.status === 'active' || c.status === 'waiting')
export const isWork = (c) => c && !SYSTEM_TYPES.has(c.type) && c.source !== 'system'
const activeCards = (state) => (state?.cards || []).filter(isActive)

function statValue(card, re) {
  for (const b of card?.blocks || []) if (b?.type === 'stat-row') for (const s of b.stats || []) if (re.test(String(s?.label || ''))) return Number(s.value) || 0
  return 0
}
function openItems(card, itemStatus = {}) {
  return [...cardItemUrls(card)].filter(u => !['done', 'dismissed'].includes(itemStatus?.[u]?.status)).length
}
/** Same meaning as the tile's 需要你处理 pill, plus review requests and single action mails. */
export function needsYou(card, itemStatus = {}) {
  if (!isWork(card)) return false
  if (card.type === 'email-action') return true
  if (statValue(card, /待你审|审/) > 0) return true
  if (card.waiting === 'you') return cardItemUrls(card).size === 0 || openItems(card, itemStatus) > 0
  return false
}
function waitingOthers(card) {
  if (card.waiting === 'others') return true
  return (card.blocks || []).some(b => b?.type === 'tags' && (b.tags || []).some(t => /等别人/.test(String(t?.text || ''))))
}
export function matchesFilter(card, filter, itemStatus = {}) {
  if (!filter) return true
  if (filter.sources?.length && !filter.sources.includes(card.source)) return false
  if (filter.needsYou && !needsYou(card, itemStatus)) return false
  if (filter.priority && !(card.priority === 'high' || card.priority === 'urgent')) return false
  if (filter.status === 'needs-you' && !needsYou(card, itemStatus)) return false
  if (filter.status === 'waiting-others' && !waitingOthers(card)) return false
  if (filter.status === 'priority' && !(card.priority === 'high' || card.priority === 'urgent')) return false
  if (filter.status === 'fyi' && !(card.waiting === 'fyi' || card.priority === 'low')) return false
  return true
}
export function filterLabel(f) {
  if (!f) return ''
  const parts = []
  if (f.needsYou || f.status === 'needs-you') parts.push('需要你处理')
  if (f.status && f.status !== 'needs-you') parts.push(FILTER_STATUSES[f.status] || f.status)
  if (f.priority && f.status !== 'priority') parts.push('优先')
  if (f.sources?.length) parts.push(f.sources.map(s => SOURCE_ZH[s] || s).join(' / '))
  return parts.join(' · ') || '全部'
}

const cardTitle = (c) => cut(c?.title || c?.subtitle || c?.id, 40)
function findCard(state, id) {
  const all = state?.cards || []
  const card = all.find(c => c.id === id)
  if (card && isActive(card)) return { card }
  if (card) return { error: `卡片 ${id} 已${card.status === 'done' ? '完成' : card.status === 'dismissed' ? '忽略' : `是 ${card.status} 状态`}，不在今天页上` }
  const q = one(id).toLowerCase()
  const cands = q.length >= 2 ? activeCards(state).filter(c => `${c.title} ${c.sourceId} ${c.subtitle || ''}`.toLowerCase().includes(q)).slice(0, 5) : []
  return {
    error: `找不到 id 为「${cut(id, 60)}」的卡片。card 必须是卡片 id（见【当前视图】或 odm_ui_state）。`,
    candidates: cands.map(c => ({ id: c.id, title: cardTitle(c) })),
  }
}

/** Resolve stored key-based layout to today's active card ids (newest day wins for a key). */
function keyIndex(state) {
  const idx = new Map()
  for (const c of activeCards(state)) {
    const k = cardKey(c)
    const prev = idx.get(k)
    if (!prev || String(c.sourceId || '') > String(prev.sourceId || '')) idx.set(k, c)
  }
  return idx
}

/**
 * Validate a raw op (from the bot tool or the owner's browser) against the store.
 * Returns { ok: true, op } with a normalized op, or { ok: false, error, candidates? }.
 */
export function validateUiOp(input, state, { now = Date.now() } = {}) {
  const raw = input && typeof input === 'object' ? input : {}
  const op = one(raw.op)
  if (!UI_OPS.includes(op)) return { ok: false, error: `op 必须是 ${UI_OPS.join(' / ')} 之一` }
  const reason = raw.reason ? cut(raw.reason, MAX_REASON) : ''
  switch (op) {
    case 'openCard': {
      const r = findCard(state, one(raw.card))
      if (r.error) return { ok: false, ...r }
      return { ok: true, op: { op, card: r.card.id, reason } }
    }
    case 'closeCard': return { ok: true, op: { op } }
    case 'highlight': {
      const r = findCard(state, one(raw.card))
      if (r.error) return { ok: false, ...r }
      let item = raw.item ? one(raw.item) : null
      if (item) {
        const urls = [...cardItemUrls(r.card)]
        if (!urls.includes(item)) return { ok: false, error: `条目「${cut(item, 80)}」不在这张卡里；item 必须是卡片条目的 url`, items: urls.slice(0, 8) }
      }
      const m = String(raw.ttl || '10m').match(/^(\d+)\s*(s|m|h)?$/)
      const ttlMs = Math.min(Math.max((m ? Number(m[1]) * ({ s: 1e3, m: 6e4, h: 36e5 }[m[2] || 'm']) : 6e5), 1e4), 8 * 36e5)
      return { ok: true, op: { op, card: r.card.id, item, reason, ttlMs } }
    }
    case 'filter': {
      const present = new Set(activeCards(state).filter(isWork).map(c => c.source).filter(Boolean))
      const sources = []
      for (const s of list(raw.sources)) {
        const v = SOURCE_ALIAS[s.toLowerCase()] || s.toLowerCase()
        if (!present.has(v)) return { ok: false, error: `今天页上没有来源「${s}」的卡片；可用：${[...present].join(', ')}` }
        if (!sources.includes(v)) sources.push(v)
      }
      const status = raw.status ? one(raw.status) : null
      if (status && !FILTER_STATUSES[status]) return { ok: false, error: `status 必须是 ${Object.keys(FILTER_STATUSES).join(' / ')} 之一` }
      const f = { sources, needsYou: bool(raw.needsYou), priority: bool(raw.priority), status }
      if (!f.sources.length && !f.needsYou && !f.priority && !f.status) return { ok: false, error: 'filter 至少要给 sources / needsYou / priority / status 中的一个' }
      return { ok: true, op: { op, filter: f, reason } }
    }
    case 'clearFilter': return { ok: true, op: { op } }
    case 'arrange': {
      const pin = list(raw.pin), unpin = list(raw.unpin), order = list(raw.order)
      if (!pin.length && !unpin.length && !order.length) return { ok: false, error: 'arrange 至少要给 pin / unpin / order 中的一个（卡片 id 列表）' }
      if ((pin.length || order.length) && !reason) return { ok: false, error: '置顶 / 重排必须写 reason（一句话说明为什么，会显示给用户）' }
      const check = (ids) => { for (const id of ids) { const r = findCard(state, id); if (r.error) return r } return null }
      const bad = check([...pin, ...unpin, ...order])
      if (bad) return { ok: false, ...bad }
      if (pin.length > MAX_PINS) return { ok: false, error: `一次最多置顶 ${MAX_PINS} 张` }
      return { ok: true, op: { op, pin, unpin, order, reason } }
    }
    case 'navigate': {
      const page = one(raw.page).toLowerCase()
      const key = PAGES[page] ? page : Object.keys(PAGES).find(k => PAGES[k] === one(raw.page))
      if (!key) return { ok: false, error: `page 必须是 ${Object.entries(PAGES).map(([k, v]) => `${k}（${v}）`).join(' / ')}` }
      return { ok: true, op: { op, page: key } }
    }
    case 'undo': {
      const log = state?.uiLog || []
      const id = one(raw.id || raw.undoId)
      const entry = id ? log.find(e => e.id === id) : [...log].reverse().find(e => e.undo && !e.undone)
      if (!entry) return { ok: false, error: id ? `找不到操作 ${id}` : '没有可以撤销的布局操作' }
      if (!entry.undo) return { ok: false, error: '这个操作不需要撤销（打开 / 高亮 / 切页是临时的）' }
      if (entry.undone) return { ok: false, error: '这个操作已经撤销过了' }
      return { ok: true, op: { op, id: entry.id } }
    }
  }
  return { ok: false, error: 'unknown op' }
}

/**
 * Apply a validated op. Returns { ui, log, entry, message, skipped } — new state slices (inputs untouched).
 * by: 'bot' | 'user'. A user's manual pin always wins: the bot cannot unpin it or move a card above it.
 */
export function applyUiOp(state, op, { by = 'bot', now = Date.now(), id = null } = {}) {
  const ui = normalizeUi(state?.ui)
  let log = Array.isArray(state?.uiLog) ? [...state.uiLog] : []
  const at = new Date(now).toISOString()
  const byId = new Map((state?.cards || []).map(c => [c.id, c]))
  const title = (cid) => cardTitle(byId.get(cid))
  const who = by === 'user' ? '你' : '豆芽'
  const entry = { id: id || `ui_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`, op: op.op, by, at }
  const skipped = []
  let message = ''

  switch (op.op) {
    case 'openCard': message = `${who === '豆芽' ? '豆芽按你的要求打开了' : '打开了'}「${title(op.card)}」`; entry.card = op.card; break
    case 'closeCard': message = `${who}关掉了放大视图`; break
    case 'navigate': message = `${who === '豆芽' ? '豆芽帮你切到了' : '切到了'}「${PAGES[op.page]}」`; entry.page = op.page; break
    case 'highlight': {
      const card = byId.get(op.card)
      const h = { cardKey: cardKey(card), card: op.card, item: op.item || null, reason: op.reason, by, at, expiresAt: new Date(now + op.ttlMs).toISOString() }
      ui.highlights = [...ui.highlights.filter(x => Date.parse(x.expiresAt) > now && !(x.card === h.card && x.item === h.item)), h].slice(-10)
      message = `${who}标出了「${title(op.card)}」${op.reason ? `：${op.reason}` : ''}`
      entry.card = op.card
      break
    }
    case 'filter': {
      entry.undo = { slice: 'filter', prev: ui.filter }
      ui.filter = { ...op.filter, by, reason: op.reason, at, day: shDay(now) }
      const n = (state?.cards || []).filter(c => isActive(c) && isWork(c) && matchesFilter(c, ui.filter, state?.itemStatus)).length
      message = `${who === '豆芽' ? '豆芽按你的要求只显示' : '只显示'}「${filterLabel(ui.filter)}」的 ${n} 张卡`
      break
    }
    case 'clearFilter': {
      entry.undo = { slice: 'filter', prev: ui.filter }
      ui.filter = null
      message = `${who}清除了筛选，显示全部卡片`
      break
    }
    case 'arrange': {
      entry.undo = { slice: 'layout', prev: JSON.parse(JSON.stringify(ui.layout)) }
      let pins = [...ui.layout.pins]
      for (const cid of op.unpin || []) {
        const k = cardKey(byId.get(cid))
        const p = pins.find(x => x.key === k)
        if (!p) continue
        if (p.by === 'user' && by !== 'user') { skipped.push({ card: cid, why: '用户手动固定的卡，豆芽不能取消' }); continue }
        pins = pins.filter(x => x.key !== k)
      }
      const added = []
      for (const cid of op.pin || []) {
        const k = cardKey(byId.get(cid))
        const p = pins.find(x => x.key === k)
        if (p && p.by === 'user' && by !== 'user') { skipped.push({ card: cid, why: '已经是你手动固定的' }); continue }
        pins = pins.filter(x => x.key !== k)
        pins.push({ key: k, cardId: cid, by, reason: op.reason, at })
        added.push(cid)
      }
      // A user's pins always sit above the bot's, in the order the user set them.
      pins = [...pins.filter(p => p.by === 'user'), ...pins.filter(p => p.by !== 'user')].slice(-MAX_PINS)
      ui.layout = { ...ui.layout, pins }
      // A user's drag order (stable keys, survives digests) is never overwritten by a bot's reorder.
      let reordered = false
      if (op.order?.length && ui.layout.order?.by === 'user' && by !== 'user') skipped.push({ card: op.order[0], why: '顺序是你手动拖的，豆芽不改' })
      else if (op.order?.length) { ui.layout.order = { keys: op.order.map(cid => cardKey(byId.get(cid))), by, reason: op.reason, at }; reordered = true }
      const parts = []
      if (added.length) parts.push(`把「${added.map(title).join('」「')}」置顶`)
      if (op.unpin?.length && op.unpin.length > skipped.filter(s => op.unpin.includes(s.card)).length) parts.push(`取消了 ${op.unpin.length - skipped.filter(s => op.unpin.includes(s.card)).length} 张的置顶`)
      if (reordered) parts.push(`调整了 ${op.order.length} 张卡的顺序`)
      message = parts.length ? `${who}${parts.join('，')}${op.reason ? `：${op.reason}` : ''}` : `${who}没有改动布局（${skipped.map(s => s.why).join('；') || '无变化'}）`
      if (!parts.length) delete entry.undo
      break
    }
    case 'undo': {
      const target = log.find(e => e.id === op.id)
      if (target?.undo?.slice === 'filter') ui.filter = target.undo.prev || null
      if (target?.undo?.slice === 'layout') ui.layout = normalizeUi({ layout: target.undo.prev }).layout
      log = log.map(e => (e.id === op.id ? { ...e, undone: true, undoneAt: at, undoneBy: by } : e))
      message = `已撤销：${target?.message || target?.op || ''}`
      entry.target = op.id
      break
    }
  }
  entry.message = message
  if (op.reason) entry.reason = op.reason
  log = [...log, entry].slice(-LOG_MAX)
  return { ui, log, entry, message, skipped }
}

/** What the client renders: today's card ids for pins / order / filter / highlights, plus the latest undo. */
export function uiView(state, { now = Date.now() } = {}) {
  const ui = normalizeUi(state?.ui)
  const idx = keyIndex(state)
  const pins = ui.layout.pins.map(p => { const c = idx.get(p.key); return c ? { cardId: c.id, by: p.by, reason: p.reason || '', at: p.at } : null }).filter(Boolean)
  const order = (ui.layout.order?.keys || []).map(k => idx.get(k)?.id).filter(Boolean)
  const filter = ui.filter && ui.filter.day === shDay(now) ? ui.filter : null // a filter lasts for the day it was set
  const work = activeCards(state).filter(isWork)
  const highlights = ui.highlights.filter(h => Date.parse(h.expiresAt) > now)
    .map(h => ({ cardId: idx.get(h.cardKey)?.id || h.card, item: h.item, reason: h.reason, by: h.by, expiresAt: h.expiresAt }))
    .filter(h => work.some(c => c.id === h.cardId))
  const lastUndoable = [...(state?.uiLog || [])].reverse().find(e => e.undo && !e.undone)
  return {
    pins, order,
    filter: filter ? { ...filter, label: filterLabel(filter), matchIds: work.filter(c => matchesFilter(c, filter, state?.itemStatus)).map(c => c.id), total: work.length } : null,
    highlights,
    lastUndo: lastUndoable ? { id: lastUndoable.id, message: lastUndoable.message, by: lastUndoable.by, at: lastUndoable.at } : null,
  }
}

// ---- UI → bot: the 当前视图 the client sends with every chat turn ------------------------------------------

/** Keep only well-formed fields; ids are checked against the store when the text is built. */
export function sanitizeViewContext(v) {
  if (!v || typeof v !== 'object') return null
  const ids = (a, n) => (Array.isArray(a) ? a : []).map(one).filter(x => x && x.length < 200).slice(0, n)
  return {
    route: PAGES[v.route] ? v.route : 'today',
    zoom: v.zoom && typeof v.zoom === 'object' && v.zoom.cardId ? { cardId: one(v.zoom.cardId).slice(0, 200), selectedItem: v.zoom.selectedItem ? one(v.zoom.selectedItem).slice(0, 400) : null } : null,
    visibleCards: ids(v.visibleCards, 24),
    scrollFocus: v.scrollFocus ? one(v.scrollFocus).slice(0, 200) : null,
    chat: v.chat === 'card' ? 'card' : 'dock',
    localTime: v.localTime ? one(v.localTime).slice(0, 40) : null,
    at: Date.now(),
  }
}

/** 【当前视图】 block (≤ maxChars) — titles come from the store, never from the client. */
export function viewSnapshotText(view, state, { maxChars = 800, now = Date.now() } = {}) {
  if (!view) return ''
  const byId = new Map((state?.cards || []).filter(isActive).map(c => [c.id, c]))
  const t = (id, n = 22) => { const c = byId.get(id); return c ? `${cut(c.title || c.subtitle || id, n)}（${id}）` : null }
  const v = uiView(state, { now })
  const parts = [`【当前视图】${PAGES[view.route] || '今天'}页`]
  if (view.route === 'today' || !view.route) {
    if (v.filter) parts.push(`已筛选：${v.filter.label}（显示 ${v.filter.matchIds.length}/${v.filter.total} 张）`)
    else parts.push('未筛选')
    if (!v.pins.length) parts.push('没有置顶')
  }
  const lines = [parts.join(' · ')]
  if (view.zoom?.cardId) {
    const z = t(view.zoom.cardId, 40)
    if (z) lines.push(`放大中：${z}${view.zoom.selectedItem ? ` · 选中条目：${cut(view.zoom.selectedItem, 120)}` : ''}`)
  }
  if (v.pins.length) lines.push(`置顶：${v.pins.map(p => `${t(p.cardId, 16) || p.cardId}${p.by === 'user' ? '[用户固定]' : '[豆芽置顶]'}`).join('，')}`)
  if (view.route === 'today') {
    const vis = view.visibleCards.map(id => t(id, 16)).filter(Boolean)
    if (vis.length) lines.push(`屏幕上可见（从上到下）：${vis.slice(0, 8).join('，')}${vis.length > 8 ? ` 等 ${vis.length} 张` : ''}`)
    const focus = view.scrollFocus && t(view.scrollFocus, 30)
    if (focus) lines.push(`滚动焦点：${focus}`)
  }
  if (v.highlights.length) lines.push(`高亮中：${v.highlights.map(h => t(h.cardId, 16)).filter(Boolean).join('，')}`)
  // Say what was just undone, so Chief doesn't describe a reverted pin from chat memory. Ids stay out of this
  // block (odm_ui_op undo defaults to the latest change; odm_ui_state has the ids).
  const last = (state?.uiLog || []).at(-1)
  if (last?.op === 'undo') lines.push(`刚刚撤销了：${cut(String(last.message || '').replace(/^已撤销：/, ''), 70)}（已不再生效）`)
  if (v.lastUndo) lines.push(`可撤销的最近一次布局改动：${cut(v.lastUndo.message, 60)}（${v.lastUndo.by === 'user' ? '用户' : '豆芽'}做的）`)
  let text = lines.join('\n')
  if (text.length > maxChars) text = `${text.slice(0, maxChars - 2)}…`
  return text
}

/** Full view for odm_ui_state: the context above plus every card on the page with its flags. */
export function uiStateFull(view, state, { now = Date.now() } = {}) {
  const v = uiView(state, { now })
  const work = activeCards(state).filter(isWork)
  const pinned = new Map(v.pins.map(p => [p.cardId, p]))
  return {
    route: view?.route || null, routeName: view?.route ? PAGES[view.route] : null,
    viewKnown: !!view, viewAgeSec: view?.at ? Math.round((now - view.at) / 1000) : null,
    zoom: view?.zoom || null,
    visibleCards: view?.visibleCards || [],
    scrollFocus: view?.scrollFocus || null,
    filter: v.filter ? { label: v.filter.label, sources: v.filter.sources, needsYou: v.filter.needsYou, priority: v.filter.priority, status: v.filter.status, showing: v.filter.matchIds.length, total: v.filter.total } : null,
    pins: v.pins, highlights: v.highlights, lastUndo: v.lastUndo,
    recent: (state?.uiLog || []).slice(-5).map(e => ({ id: e.id, op: e.op, by: e.by, at: e.at, message: e.message, undone: !!e.undone })),
    cards: work.slice(0, 60).map(c => ({
      id: c.id, title: cut(c.title, 60), source: c.source, type: c.type, priority: c.priority || null,
      needsYou: needsYou(c, state?.itemStatus), pinned: pinned.get(c.id)?.by || null,
      hiddenByFilter: v.filter ? !v.filter.matchIds.includes(c.id) : false,
      items: [...cardItemUrls(c)].length,
    })),
  }
}
