// Bot digest: validate source-bot candidates, apply Chief's merge plan, and build cards in the legacy shapes
// (same sourceIds as the legacy pipeline, so existing cards are updated in place, never duplicated).
import { CHANNELS } from './channels.js'
import { buildEmailClusters, emailLink } from '../web/email-groups.js'
import { clusterByProjectTheme, classifyClusters, groupAndRank, generateClusterCards } from '../web/aggregation.js'

const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s }
const PRI = new Set(['urgent', 'high', 'medium', 'low'])
const RANK = { github: 0, slack: 1, gmail: 2 }
const parse = v => { if (typeof v !== 'string') return v; try { return JSON.parse(v) } catch { return null } }

/**
 * Validate a source bot's proposal against its snapshot. Unknown refs (invented links) and items the user already
 * completed are dropped; candidates left with no real item are rejected.
 * @returns {{candidates: object[], errors: string[], droppedRefs: string[]}}
 */
export function validateCandidates(channel, raw, snapshot) {
  const c = CHANNELS[channel]
  const errors = [], droppedRefs = [], used = new Set(), out = []
  let list = parse(raw)
  if (list && !Array.isArray(list)) list = list.cards || list.candidates
  if (!Array.isArray(list)) return { candidates: [], errors: ['cards 必须是 JSON 数组'], droppedRefs }
  for (const [i, x] of list.entries()) {
    if (!x || typeof x !== 'object') { errors.push(`#${i} 不是对象`); continue }
    let category = clip(x.category, 80)
    if (c?.categories && !c.categories.includes(category)) { errors.push(`#${i} category "${category}" 不在 ${c.categories.join('/')}`); category = null }
    const refs = []
    for (const r of Array.isArray(x.items) ? x.items : []) {
      const ref = typeof r === 'string' ? r : r?.ref
      const item = snapshot.byRef.get(ref)
      if (!item) { droppedRefs.push(String(ref)); continue }
      if (used.has(ref)) continue
      used.add(ref); refs.push({ ref, status: ['needs-you', 'waiting', 'fyi'].includes(r?.status) ? r.status : undefined })
    }
    if (!refs.length) { errors.push(`#${i}「${clip(x.title, 30)}」没有有效条目（只能引用快照里的 ref）`); continue }
    out.push({
      id: `${channel}:${out.length}`, channel, category,
      title: clip(x.title, 60), summary: clip(x.summary, 160), nextStep: clip(x.nextStep, 90),
      needsAction: !!x.needsAction, priority: PRI.has(x.priority) ? x.priority : (x.needsAction ? 'high' : 'low'),
      items: refs,
    })
  }
  if (channel === 'gmail') { // at most 4 single mail tiles; extra singles fall back into 需要你处理
    let n = 0
    for (const cand of out) if (cand.category === 'single' && cand.items.length === 1 && ++n > 4) { cand.category = 'action'; errors.push(`单独邮件卡超过 4 张，「${cand.title}」并入 需要你处理`) }
    for (const cand of out) if (cand.category === 'single' && cand.items.length > 1) cand.category = 'action'
  }
  return { candidates: out, errors, droppedRefs }
}

/**
 * Validate Chief's plan. Merges may only reference known candidate ids; at most 8 timeline blocks.
 */
export function validatePlan(raw, candidates) {
  const p = parse(raw) || {}
  const ids = new Set(candidates.map(c => c.id))
  const errors = []
  const merges = []
  const taken = new Set()
  for (const m of Array.isArray(p.merges) ? p.merges : []) {
    const into = String(m?.into || '')
    if (!ids.has(into)) { errors.push(`merge.into ${into} 不存在`); continue }
    let from = (Array.isArray(m.from) ? m.from : [m.from]).map(String).filter(f => ids.has(f) && f !== into && !taken.has(f) && f !== 'undefined')
    if (!from.length) continue
    // The work card absorbs the notification: GitHub > Slack > Gmail. A merge "into" a mail card from a
    // GitHub/Slack card is turned around, so the PR card keeps its items and gains the mail links.
    let target = into
    const best = [into, ...from].sort((a, b) => (RANK[a.split(':')[0]] ?? 9) - (RANK[b.split(':')[0]] ?? 9))[0]
    if (best !== into) { target = best; from = [into, ...from.filter(f => f !== best)]; errors.push(`merge 方向已调整：${best} 吸收 ${from.join(',')}`) }
    if (taken.has(target)) continue
    from.forEach(f => taken.add(f))
    merges.push({ into: target, from, reason: clip(m.reason, 80) })
  }
  const edits = new Map()
  for (const e of Array.isArray(p.cards) ? p.cards : []) if (ids.has(String(e?.id))) edits.set(String(e.id), { priority: PRI.has(e.priority) ? e.priority : undefined, nextStep: e.nextStep ? clip(e.nextStep, 90) : undefined, title: e.title ? clip(e.title, 60) : undefined, rank: edits.size })
  const hhmm = s => /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(s || '')) ? String(s).padStart(5, '0') : null
  const timeline = (Array.isArray(p.timeline) ? p.timeline : []).map(b => ({ start: hhmm(b?.start), end: hhmm(b?.end), title: clip(b?.title, 40), category: ['focus', 'work', 'break', 'meeting', 'personal', 'review', 'admin'].includes(b?.category) ? b.category : 'work' }))
    .filter(b => b.start && b.end && b.title && b.start < b.end).slice(0, 8)
  return { headline: clip(p.headline, 60), narrative: clip(p.narrative, 220), merges, edits, timeline, errors }
}

const linkOf = it => it.source === 'gmail' ? emailLink(it) : { title: clip(it.title, 90), url: it.url, type: it.source === 'slack' ? 'slack' : 'pr-activity', at: it.timestamp || it.createdAt || null }
const keyOf = (channel, it) => channel === 'github' ? (it.metadata?.repository || (String(it.url).match(/github\.com\/([^/]+\/[^/]+)/) || [])[1] || 'other') : channel === 'slack' ? (it.metadata?.channelId || 'unknown') : it.sourceId

function overlay(card, cand, edit) {
  if (!card || !cand) return card
  const needs = cand.needsAction
  if (cand.summary) { card.body = cand.summary; card.why = cand.summary }
  const next = edit?.nextStep || cand.nextStep
  if (next) card.nextAction = next
  card.priority = edit?.priority || cand.priority || card.priority
  card.waiting = needs ? 'you' : (card.waiting === 'you' ? 'fyi' : card.waiting || 'fyi')
  card.metadata = { ...(card.metadata || {}), needsAction: needs, digest: 'bot', candidate: cand.id, rank: edit?.rank }
  if (card.type !== 'email-group' && (edit?.title || cand.title)) card.title = edit?.title || cand.title
  return card
}

/**
 * Build legacy-shaped cards from validated candidates + Chief's plan.
 * @param {object} snaps channel -> snapshot (only channels whose bot succeeded)
 * @param {object} candidatesBy channel -> candidates
 * @param {object} plan validatePlan() result
 * @returns {{cards: object[], stats: object}}
 */
export function buildCards(snaps, candidatesBy, plan, opts = {}) {
  let res = buildOnce(snaps, candidatesBy, plan, opts)
  // A merge whose target produced no card would lose the merged items: undo those merges and rebuild.
  if (res.missingInto.length) {
    const keep = (plan.merges || []).filter(m => !res.missingInto.includes(m.into))
    for (const c of Object.values(candidatesBy).flat()) delete c.mergedInto
    res = buildOnce(snaps, candidatesBy, { ...plan, merges: keep }, opts)
    res.stats.undoneMerges = (plan.merges || []).length - keep.length
  }
  return { cards: res.cards, stats: res.stats }
}

function buildOnce(snaps, candidatesBy, plan, { today, now = Date.now() } = {}) {
  const all = Object.values(candidatesBy).flat()
  const byId = new Map(all.map(c => [c.id, c]))
  const itemOf = (cand, r) => snaps[cand.channel]?.byRef.get(r.ref)
  // Cross-channel (or same-channel) merges: the items of `from` move as links onto the card of `into`.
  const away = new Set(), extra = new Map()
  for (const m of plan.merges || []) for (const f of m.from) {
    const fc = byId.get(f); if (!fc) continue
    for (const r of fc.items) { const it = itemOf(fc, r); if (it) { away.add(it.sourceId); if (!extra.has(m.into)) extra.set(m.into, []); extra.get(m.into).push({ it, reason: m.reason }) } }
    fc.mergedInto = m.into
  }
  const cards = [], candCard = new Map()
  for (const [channel, snap] of Object.entries(snaps)) {
    const cands = (candidatesBy[channel] || []).filter(c => !c.mergedInto)
    const refCand = new Map()
    for (const c of cands) for (const r of c.items) { const it = snap.byRef.get(r.ref); if (it) refCand.set(it.sourceId, c) }
    const kind = CHANNELS[channel]?.kind
    if (kind === 'email') {
      const assign = new Map()
      for (const [sid, c] of refCand) assign.set(sid, c.category)
      // Every live mail lands in a group (unseen / unassigned ones by the rule classifier), so counts stay true.
      const mail = (snap.all || snap.items).filter(it => !away.has(it.sourceId))
      for (const card of buildEmailClusters(mail, { today, now, assign })) {
        const sid = card.items?.[0]?.sourceId
        const cand = card.type === 'email-action' ? refCand.get(sid) : cands.filter(c => c.category === card.metadata?.group).sort((a, b) => b.items.length - a.items.length)[0] || null
        cards.push(overlay(card, cand, cand && plan.edits?.get(cand.id))); if (cand) candCard.set(cand.id, card)
      }
    } else {
      // One card per repo / channel: items picked by any candidate, re-bucketed by their real repo/channel key.
      const buckets = new Map()
      for (const it of snap.items) { const c = refCand.get(it.sourceId); if (!c || away.has(it.sourceId)) continue; const k = keyOf(channel, it); if (!buckets.has(k)) buckets.set(k, { items: [], votes: new Map() }); const b = buckets.get(k); b.items.push(it); b.votes.set(c.id, (b.votes.get(c.id) || 0) + 1) }
      for (const [, b] of buckets) {
        const grouped = groupAndRank(classifyClusters(clusterByProjectTheme(b.items)))
        const built = generateClusterCards(grouped).filter(cd => cd.source === channel)
        const candId = [...b.votes.entries()].sort((x, y) => y[1] - x[1])[0]?.[0]
        const cand = byId.get(candId)
        for (const card of built) { cards.push(overlay(card, built.length === 1 ? cand : null, cand && plan.edits?.get(cand.id))); if (built.length === 1 && cand && !candCard.has(cand.id)) candCard.set(cand.id, card) }
      }
    }
  }
  const missingInto = [...extra.keys()].filter(into => !candCard.has(into))
  if (missingInto.length) return { cards, stats: {}, missingInto }
  for (const [into, list] of extra) {
    const card = candCard.get(into); if (!card) continue
    let ll = (card.blocks || []).find(b => b.type === 'link-list')
    if (!ll) { ll = { type: 'link-list', links: [] }; (card.blocks ||= []).push(ll) }
    const seen = new Set((ll.links || []).map(l => l.url))
    for (const { it } of list) if (!seen.has(it.url)) { seen.add(it.url); ll.links.push({ ...linkOf(it), mergedFrom: it.source }) }
    card.metadata = { ...(card.metadata || {}), mergedFrom: [...new Set(list.map(x => x.it.source))], mergeReason: list[0]?.reason || '' }
  }
  return { cards, missingInto, stats: { candidates: all.length, merged: [...byId.values()].filter(c => c.mergedInto).length, mergedItems: away.size } }
}

/** Every link on the given cards must be one of the snapshot URLs (or a known card/app URL). */
export function invalidLinks(cards, validUrls) {
  const bad = []
  for (const c of cards) for (const b of c.blocks || []) for (const l of b.links || []) if (l?.url && !validUrls.has(l.url)) bad.push({ card: c.sourceId, url: l.url })
  return bad
}
