// 我的一天 (My Day) plan edits from chat. The timetable card keeps one block
// { type:'timetable', fixedBlocks, suggestedBlocks, nowTime, userPlan? }. Real calendar events (fixedBlocks)
// never change here; Chief only reads / replaces / patches the suggested blocks. A chat edit stamps
// userPlan { date, by, at }; for that day a re-digest keeps the edited plan (fresh calendar events still land)
// unless the user asked to regenerate (userPlan cleared).

export const PLAN_KINDS = ['focus', 'work', 'review', 'meeting', 'break', 'meal', 'admin', 'exercise', 'learning', 'personal', 'winddown']
const KIND_ALIAS = { lunch: 'meal', dinner: 'meal', breakfast: 'meal', eat: 'meal', rest: 'break', buffer: 'break', task: 'work', chore: 'admin', '专注': 'focus', '休息': 'break', '缓冲': 'break', '用餐': 'meal', '吃饭': 'meal', '杂务': 'admin', '评审': 'review', '会议': 'meeting', '运动': 'exercise' }

export function localDay(now = new Date()) {
  const d = new Date(now)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// "9:5" / "09:05" / "2026-11-04T09:05:00+08:00" -> "09:05" in local time; null when unreadable.
export function hhmm(v) {
  if (v == null) return null
  const s = String(v).trim()
  if (!s) return null
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) { const d = new Date(s); if (isNaN(d)) return null; return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
  const m = s.match(/^(\d{1,2})[:：](\d{1,2})$/)
  if (!m) return null
  const h = +m[1], mi = +m[2]
  if (h > 24 || mi > 59 || (h === 24 && mi)) return null
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`
}
const fmt = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
const toMin = v => { const t = hhmm(v); if (!t) return null; const [h, m] = t.split(':').map(Number); return h * 60 + m }

export function normKind(k) {
  const s = String(k || '').trim().toLowerCase()
  if (!s) return 'focus'
  if (PLAN_KINDS.includes(s)) return s
  return KIND_ALIAS[s] || KIND_ALIAS[String(k).trim()] || 'focus'
}

export function timetableBlock(card) {
  return (card?.blocks || []).find(b => b && b.type === 'timetable') || null
}

/** The live 我的一天 card: the newest non-hidden card of type timetable. */
export function findTimetableCard(cards = []) {
  const live = cards.filter(c => c && c.type === 'timetable' && !['merged', 'dismissed', 'archived'].includes(c.status))
  live.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
  return live[0] || null
}

function cleanBlock(b, i, errors) {
  if (!b || typeof b !== 'object') { errors.push(`blocks[${i}] 不是对象`); return null }
  const start = hhmm(b.start), end = hhmm(b.end)
  const title = String(b.title || '').trim().slice(0, 60)
  if (!start || !end) { errors.push(`blocks[${i}] 时间要 HH:MM（收到 start=${b.start} end=${b.end}）`); return null }
  if (toMin(end) <= toMin(start)) { errors.push(`blocks[${i}] ${start}–${end} 结束要晚于开始`); return null }
  if (!title) { errors.push(`blocks[${i}] 缺 title`); return null }
  const out = { start, end, title, category: normKind(b.kind || b.category) }
  const ids = Array.isArray(b.cardIds) ? b.cardIds : typeof b.cardIds === 'string' && b.cardIds ? b.cardIds.split(/[,\s]+/) : b.cardId ? [b.cardId] : []
  const clean = ids.map(String).map(s => s.trim()).filter(Boolean).slice(0, 6)
  if (clean.length) out.cardIds = clean
  return out
}

const sortBlocks = bs => bs.sort((a, b) => toMin(a.start) - toMin(b.start) || toMin(a.end) - toMin(b.end))

function overlaps(a, b) { return toMin(a.start) < toMin(b.end) && toMin(b.start) < toMin(a.end) }

/** Compact read model for Chief (and tests). */
export function readPlan(card, { now = new Date() } = {}) {
  const tt = timetableBlock(card) || {}
  const nowM = new Date(now).getHours() * 60 + new Date(now).getMinutes()
  const fixed = (tt.fixedBlocks || []).map(b => ({ start: hhmm(b.start), end: hhmm(b.end), title: b.title, fixed: true })).filter(b => b.start && b.end)
  const blocks = (tt.suggestedBlocks || []).map(b => ({ start: hhmm(b.start), end: hhmm(b.end), title: b.title, kind: b.category || 'focus', ...(b.cardIds?.length ? { cardIds: b.cardIds } : {}) })).filter(b => b.start && b.end)
  const all = sortBlocks([...fixed, ...blocks])
  const next = all.find(b => toMin(b.end) > nowM) || null
  return {
    cardId: card?.id || null,
    date: localDay(now),
    now: `${String(Math.floor(nowM / 60)).padStart(2, '0')}:${String(nowM % 60).padStart(2, '0')}`,
    fixedEvents: fixed,
    blocks: sortBlocks(blocks),
    next: next ? { start: next.start, end: next.end, title: next.title } : null,
    userEdited: tt.userPlan?.date === localDay(now) ? tt.userPlan : null,
  }
}

function matchIndex(blocks, match) {
  if (match == null || match === '') return -1
  const t = hhmm(match)
  if (t) { const i = blocks.findIndex(b => hhmm(b.start) === t); if (i >= 0) return i }
  const q = String(match).trim().toLowerCase()
  const hits = blocks.map((b, i) => [b, i]).filter(([b]) => String(b.title || '').toLowerCase().includes(q))
  return hits.length === 1 ? hits[0][1] : hits.length > 1 ? -2 : -1
}

/**
 * Apply a plan edit to the timetable card. Returns { ok, card, plan, changed, warnings, errors }.
 * mode 'replace': blocks = the full new list of suggested blocks (from the given time on, or the whole day when keepBefore is null).
 *   keepBefore 'HH:MM' keeps earlier suggested blocks that end by then (e.g. the morning that already happened).
 * mode 'patch': ops = [{ match: 'HH:MM' start | title words, start?, end?, title?, kind?, cardIds?, remove?: true }] and
 *   ops without match add a block.
 * mode 'reset': drop the chat edit so the next digest regenerates the plan.
 * Suggested blocks that overlap a real calendar event are rejected (warning), never the event.
 */
export function applyPlanEdit(card, edit = {}, { now = new Date(), by = 'chief' } = {}) {
  if (!card) return { ok: false, errors: ['没有「我的一天」卡片（先刷新今日生成一次）'] }
  const tt = timetableBlock(card)
  if (!tt) return { ok: false, errors: ['卡片里没有时间表数据'] }
  const mode = String(edit.mode || (edit.ops ? 'patch' : 'replace')).toLowerCase()
  const errors = [], warnings = []
  const fixed = (tt.fixedBlocks || []).map(b => ({ start: hhmm(b.start), end: hhmm(b.end), title: b.title })).filter(b => b.start && b.end)
  let blocks = (tt.suggestedBlocks || []).map(b => ({ ...b }))
  const before = JSON.stringify(sortBlocks(blocks.map(b => ({ s: hhmm(b.start), e: hhmm(b.end), t: b.title, k: b.category }))))

  if (mode === 'reset') {
    const next = { ...tt }; delete next.userPlan
    const updated = { ...card, blocks: card.blocks.map(b => (b === tt ? next : b)) }
    return { ok: true, card: updated, plan: readPlan(updated, { now }), changed: true, reset: true, warnings, errors }
  }
  if (mode === 'replace') {
    const list = Array.isArray(edit.blocks) ? edit.blocks : []
    const fresh = list.map((b, i) => cleanBlock(b, i, errors)).filter(Boolean)
    if (errors.length) return { ok: false, errors }
    if (!fresh.length) return { ok: false, errors: ['replace 需要至少一个 block（清空请用 reset 或 patch remove）'] }
    const keep = edit.keepBefore != null ? toMin(edit.keepBefore) : null
    const from = keep != null ? keep : Math.min(...fresh.map(b => toMin(b.start)))
    // Blocks the new list doesn't cover: earlier ones stay (unless keepBefore===null and they collide), later ones are replaced.
    blocks = blocks.filter(b => { const e = toMin(b.end); return e != null && e <= from && !fresh.some(f => overlaps(f, b)) })
    blocks.push(...fresh)
  } else if (mode === 'patch') {
    const ops = Array.isArray(edit.ops) ? edit.ops : []
    if (!ops.length) return { ok: false, errors: ['patch 需要 ops'] }
    ops.forEach((op, i) => {
      if (!op || typeof op !== 'object') { errors.push(`ops[${i}] 不是对象`); return }
      if (op.match == null || op.match === '') {
        const b = cleanBlock(op, i, errors); if (b) blocks.push(b); return
      }
      const at = matchIndex(blocks, op.match)
      if (at === -2) { errors.push(`ops[${i}] 「${op.match}」匹配到多段，请用开始时间 HH:MM`); return }
      if (at < 0) { errors.push(`ops[${i}] 找不到「${op.match}」（现有：${sortBlocks([...blocks]).map(b => `${b.start} ${b.title}`).join('；')}）`); return }
      if (op.remove === true || op.remove === 'true') { blocks.splice(at, 1); return }
      const cur = blocks[at]
      const merged = { start: op.start ?? cur.start, end: op.end ?? cur.end, title: op.title ?? cur.title, kind: op.kind ?? cur.category, cardIds: op.cardIds ?? cur.cardIds }
      // Moving only the start keeps the duration.
      if (op.start != null && op.end == null) { const d = toMin(cur.end) - toMin(cur.start); const s = toMin(op.start); if (s != null && d > 0) { const e = s + d; merged.end = `${String(Math.floor(e / 60)).padStart(2, '0')}:${String(e % 60).padStart(2, '0')}` } }
      const b = cleanBlock(merged, i, errors); if (b) blocks[at] = b
    })
    if (errors.length) return { ok: false, errors }
  } else {
    return { ok: false, errors: [`未知 mode=${mode}（replace / patch / reset）`] }
  }

  // Real calendar events win: a block that runs into one is split around it (pieces < 10 min dropped).
  blocks = blocks.flatMap(b => {
    const hits = fixed.filter(f => overlaps(f, b))
    if (!hits.length) return [b]
    let pieces = [[toMin(b.start), toMin(b.end)]]
    for (const f of hits) {
      const fs = toMin(f.start), fe = toMin(f.end)
      pieces = pieces.flatMap(([s, e]) => (fe <= s || fs >= e ? [[s, e]] : [[s, Math.min(e, fs)], [Math.max(s, fe), e]]))
    }
    pieces = pieces.filter(([s, e]) => e - s >= 10)
    warnings.push(pieces.length
      ? `「${b.start}–${b.end} ${b.title}」和日历事件「${hits.map(f => `${f.start}–${f.end} ${f.title}`).join('、')}」冲突，已绕开拆成 ${pieces.map(([s, e]) => `${fmt(s)}–${fmt(e)}`).join('、')}`
      : `「${b.start}–${b.end} ${b.title}」被日历事件「${hits[0].start}–${hits[0].end} ${hits[0].title}」占满，没放进去`)
    return pieces.map(([s, e]) => ({ ...b, start: fmt(s), end: fmt(e) }))
  })
  sortBlocks(blocks)
  for (let i = 1; i < blocks.length; i++) if (overlaps(blocks[i - 1], blocks[i])) warnings.push(`「${blocks[i - 1].start} ${blocks[i - 1].title}」和「${blocks[i].start} ${blocks[i].title}」时间重叠`)

  const after = JSON.stringify(blocks.map(b => ({ s: b.start, e: b.end, t: b.title, k: b.category })))
  const at = new Date(now).toISOString()
  const next = { ...tt, suggestedBlocks: blocks, userPlan: { date: localDay(now), by, at } }
  const updated = { ...card, blocks: card.blocks.map(b => (b === tt ? next : b)), planEditedAt: at }
  return { ok: true, card: updated, plan: readPlan(updated, { now }), changed: before !== after, warnings, errors }
}

/**
 * Re-digest over an edited day: keep today's chat-edited suggested blocks, take fresh calendar events,
 * drop edited blocks that now collide with a new event. Different day / no edit -> incoming as-is.
 */
export function mergeDigestTimetable(oldCard, incCard, { now = new Date() } = {}) {
  const oldTT = timetableBlock(oldCard), incTT = timetableBlock(incCard)
  if (!oldTT?.userPlan || !incTT || incCard?.regenerate) return incCard
  if (oldTT.userPlan.date !== localDay(now)) return incCard
  const fixed = (incTT.fixedBlocks || []).map(b => ({ start: hhmm(b.start), end: hhmm(b.end) })).filter(b => b.start && b.end)
  const kept = (oldTT.suggestedBlocks || []).filter(b => !fixed.some(f => overlaps(f, b)))
  const nextTT = { ...incTT, suggestedBlocks: kept, userPlan: oldTT.userPlan }
  return { ...incCard, blocks: (incCard.blocks || []).map(b => (b === incTT ? nextTT : b)) }
}

/** Today's real calendar events on the timetable (fixed blocks dated today; all-day events count too). */
export function todaysCalendarEvents(card, { now = new Date() } = {}) {
  const tt = timetableBlock(card)
  const day = localDay(now)
  return (tt?.fixedBlocks || []).filter(b => {
    const s = String(b.start || '')
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s === day
    const d = new Date(s)
    return !isNaN(d) && localDay(d) === day
  })
}
