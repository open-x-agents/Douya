import { t, resolveLang, DEFAULT_LOCALE } from '../i18n/index.js'
// Bot digest: validate source-bot candidates, apply Chief's merge plan, and build cards in the legacy shapes
// (same sourceIds as the legacy pipeline, so existing cards are updated in place, never duplicated).
import { CHANNELS } from './channels.js'
import { validateFace } from '../ui/face.js'
import { buildEmailClusters, emailLink, foldGithubNotifsIntoRepos } from '../web/email-groups.js'
import { clusterByProjectTheme, classifyClusters, groupAndRank, generateClusterCards } from '../web/aggregation.js'

const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s }
const PRI = new Set(['urgent', 'high', 'medium', 'low'])
const RANK = { github: 0, slack: 1, gmail: 2 }
const parse = v => { if (typeof v !== 'string') return v; try { return JSON.parse(v) } catch { return null } }

// ===== Grounding: every #123 a card mentions must be one of its own items (url number or a number in its title) =====
const NUM_RE = /#(\d{1,6})\b/g
export const numsIn = text => [...String(text || '').matchAll(NUM_RE)].map(m => m[1])
/** Numbers a card may cite: PR/issue numbers from its item urls, plus #N written in item titles / snippets. */
export function allowedNums(items = []) {
  const out = new Set()
  for (const it of items) {
    if (!it) continue
    const n = (String(it.url || '').match(/\/(?:pull|issues)\/(\d+)/) || [])[1]; if (n) out.add(n)
    for (const x of numsIn(`${it.title || ''} ${it.body || ''} ${it.metadata?.snippet?.body || it.metadata?.snippet || ''} ${it.metadata?.text || ''}`)) out.add(x)
  }
  return out
}
/** #N in `text` that are not in `allowed` (invented / misremembered numbers). */
export const ungroundedNums = (text, allowed) => [...new Set(numsIn(text))].filter(n => !allowed.has(n))
// Next steps that tell the user nothing ("查看详情", "处理一下", "忽略或归档" …) — must be verb + concrete object.
const VAGUE_NEXT = /^(?:请|先|再)?(?:查看(?:详情|一下)?|看(?:一下|一眼|看)|处理(?:一下)?|跟进(?:一下)?|关注(?:一下)?|了解(?:一下)?|忽略(?:或归档)?|归档|知悉|无需处理|待定)[。.！!]?$/
export const isVagueNext = s => { const t = String(s || '').replace(/\s+/g, ''); return !t || t.length < 5 || VAGUE_NEXT.test(t) }

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
    // Card face (layout picked by the bot): refs → this card's own item urls; anything else is dropped.
    const mine = new Set(refs.map(r => r.ref))
    const fv = validateFace(x.face, { resolve: r => (mine.has(String(r)) && snapshot.byRef.get(String(r)) ? linkOf(snapshot.byRef.get(String(r))).url : null), by: 'bot' })
    fv.errors.forEach(e => errors.push(`#${i} ${e}`))
    const allowed = allowedNums(refs.map(r => snapshot.byRef.get(r.ref)))
    let title = clip(x.title, 60), summary = clip(x.summary, 160), nextStep = clip(x.nextStep, 90)
    const bad = ungroundedNums(`${title} ${summary} ${nextStep}`, allowed)
    if (bad.length) {
      errors.push(`#${i}「${clip(x.title, 30)}」写了 ${bad.map(n => '#' + n).join('/')}，但它的条目里只有 ${[...allowed].map(n => '#' + n).join('/') || '（无编号）'}——编号只能抄快照的 num，不要凭记忆写`)
      // Never ship a wrong number: drop the text that carries it (the card falls back to text built from real items).
      if (ungroundedNums(title, allowed).length) title = ''
      if (ungroundedNums(summary, allowed).length) summary = ''
      if (ungroundedNums(nextStep, allowed).length) nextStep = ''
    }
    if (nextStep && isVagueNext(nextStep)) errors.push(`#${i}「${clip(x.title, 30)}」nextStep「${nextStep}」太空泛，要写动词+具体对象（如「回复 X：确认 Y」「先审 #N：看 Z」）`)
    out.push({
      id: `${channel}:${out.length}`, channel, category,
      title, summary, nextStep, nums: [...allowed],
      needsAction: !!x.needsAction, priority: PRI.has(x.priority) ? x.priority : (x.needsAction ? 'high' : 'low'),
      items: refs,
      target: /^update:\S+$/.test(String(x.target || '')) ? String(x.target) : 'new',
      ...(fv.face ? { face: fv.face } : {}),
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
  const candOf = new Map(candidates.map(c => [c.id, c]))
  for (const e of Array.isArray(p.cards) ? p.cards : []) {
    if (!ids.has(String(e?.id))) continue
    const allowed = new Set(candOf.get(String(e.id))?.nums || [])
    let nextStep = e.nextStep ? clip(e.nextStep, 90) : undefined, title = e.title ? clip(e.title, 60) : undefined
    for (const [k, v] of [['nextStep', nextStep], ['title', title]]) {
      const bad = v ? ungroundedNums(v, allowed) : []
      if (bad.length) { errors.push(`cards ${e.id} 的 ${k} 写了 ${bad.map(n => '#' + n).join('/')}，不在该卡条目里，已忽略`); if (k === 'nextStep') nextStep = undefined; else title = undefined }
    }
    edits.set(String(e.id), { priority: PRI.has(e.priority) ? e.priority : undefined, nextStep, title, rank: edits.size })
  }
  const hhmm = s => /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(s || '')) ? String(s).padStart(5, '0') : null
  const timeline = (Array.isArray(p.timeline) ? p.timeline : []).map(b => ({ start: hhmm(b?.start), end: hhmm(b?.end), title: clip(b?.title, 40), category: ['focus', 'work', 'break', 'meeting', 'personal', 'review', 'admin'].includes(b?.category) ? b.category : 'work' }))
    .filter(b => b.start && b.end && b.title && b.start < b.end).slice(0, 8)
  return { headline: clip(p.headline, 60), narrative: clip(p.narrative, 220), merges, edits, timeline, errors }
}

const linkOf = it => {
  if (it.source === 'gmail') return emailLink(it)
  const md = it.metadata || {}
  const from = it.source === 'slack'
    ? (md.user || md.from || null)
    : (md.author || md.user?.login || md.user || null)
  return {
    title: clip(it.title, 90), url: it.url,
    type: it.source === 'slack' ? 'slack' : (/issue/i.test(it.type || '') ? 'issue' : /pr|pull/i.test(it.type || '') ? 'pr-activity' : 'pr-activity'),
    at: it.timestamp || it.updatedAt || it.createdAt || null,
    ...(from ? { from: clip(from, 40) } : {}),
    ...(it.type ? { itemType: it.type } : {}),
  }
}
const keyOf = (channel, it) => channel === 'github' ? (it.metadata?.repository || (String(it.url).match(/github\.com\/([^/]+\/[^/]+)/) || [])[1] || 'other') : channel === 'slack' ? (it.metadata?.channelId || 'unknown') : it.sourceId

function overlay(card, cand, edit) {
  if (!card || !cand) return card
  const needs = cand.needsAction
  // email-group body/nextAction are authored in the page locale by buildEmailClusters.
  // Source-bot candidate summary/nextStep is often Chinese; do not overwrite the localized copy.
  // Chief edits (edit.nextStep / edit.title) may still refine nextAction; title stays group-localized.
  if (card.type !== 'email-group') {
    if (cand.summary) { card.body = cand.summary; card.why = cand.summary }
    const next = edit?.nextStep || cand.nextStep
    if (next) card.nextAction = next
    if (edit?.title || cand.title) card.title = edit?.title || cand.title
  } else if (edit?.nextStep) {
    card.nextAction = edit.nextStep
  }
  card.priority = edit?.priority || cand.priority || card.priority
  const waitingOthers = !needs && (cand.items || []).some(r => r.status === 'waiting')
  card.waiting = needs ? 'you' : waitingOthers ? 'others' : (card.waiting === 'you' ? 'fyi' : card.waiting || 'fyi')
  card.metadata = { ...(card.metadata || {}), needsAction: needs, digest: 'bot', candidate: cand.id, rank: edit?.rank, target: cand.target, lang: card.metadata?.lang }
  if (cand.face) card.face = { ...cand.face, at: new Date().toISOString() }
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

function buildOnce(snaps, candidatesBy, plan, { today, now = Date.now(), lang = 'en' } = {}) {
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
      for (const card of buildEmailClusters(mail, { today, now, assign, lang })) {
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
  const fold = foldGithubNotifsIntoRepos(cards)
  const gh = snaps.github?.all || snaps.github?.items || []
  let cited = 0
  if (gh.length) for (const card of cards) if (card.source === 'github') {
    cited += attachHarvestLinks(card, gh, linkOf)
    cited += linkCitedNums(card, gh, linkOf)
    if (!card.nextAction) card.nextAction = t('card.open_repo', resolveLang(lang))
  }
  return { cards, missingInto, stats: { citedLinks: cited, candidates: all.length, merged: [...byId.values()].filter(c => c.mergedInto).length, mergedItems: away.size, foldedGithubMail: fold.folded } }
}

const repoIn = u => (String(u || '').match(/github\.com\/([^/]+\/[^/#?]+)/) || [])[1] || null
const numIn = u => (String(u || '').match(/\/(?:pull|issues)\/(\d+)/) || [])[1] || null
const cardRepo = (card, links = []) => repoIn(card?.url) || links.map(l => repoIn(l?.url)).find(Boolean) || null
/**
 * Persist canonical GitHub PR/issue URLs from harvested github:pr:* (and issue) items onto the
 * repo card. Notification mail often lands first as a Gmail link; without this the card keeps
 * only those plus a stale face.focus, and Chief never sees https://github.com/OWNER/REPO/pull/N.
 * Mutates card; returns how many links it added.
 */
export function attachHarvestLinks(card, items = [], toLink = it => ({ title: it.title, url: it.url, type: it.type })) {
  const ll = (card.blocks || []).find(b => b?.type === 'link-list')
  const links = ll?.links || []
  const repo = cardRepo(card, links)
  if (!repo) return 0
  const haveUrl = new Set(links.map(l => l.url).filter(Boolean))
  const haveNum = new Set(links.map(l => numIn(l.url)).filter(Boolean))
  const rank = (it) => {
    const t = String(it.type || '')
    if (/pr-review|pr-assigned/.test(t)) return 0
    if (/\/pull\//.test(String(it.url || '')) || /pr/i.test(t)) return 1
    return 2
  }
  const add = []
  for (const it of [...items].filter(x => repoIn(x.url) === repo && numIn(x.url)).sort((a, b) => rank(a) - rank(b))) {
    const n = numIn(it.url)
    if (haveUrl.has(it.url) || haveNum.has(n)) continue
    haveUrl.add(it.url); haveNum.add(n)
    const link = toLink(it)
    if (link?.url) add.push(link)
  }
  if (!add.length) return 0
  const block = ll || ((card.blocks ||= []).push({ type: 'link-list', links: [] }), card.blocks.at(-1))
  block.links = [...add, ...(block.links || [])].slice(0, Math.max((block.links || []).length, 40))
  return add.length
}

/**
 * A #N in a card's next step / title must be a link the user can see on that card. Cited items
 * that the card's link list dropped (it is capped) are moved to the front; a number with no item
 * in the snapshot blanks the next step rather than sending the user to something they cannot open.
 * Mutates card; returns how many links it added.
 */
export function linkCitedNums(card, items = [], toLink = it => ({ title: it.title, url: it.url })) {
  const ll = (card.blocks || []).find(b => b?.type === 'link-list')
  const links = ll?.links || []
  const repo = cardRepo(card, links)
  if (!repo) return 0
  const have = new Set(links.map(l => numIn(l.url)).filter(Boolean))
  const want = [...new Set([...numsIn(card.nextAction), ...numsIn(card.title)])].filter(n => !have.has(n))
  if (!want.length) return 0
  const add = [], missing = []
  for (const n of want) {
    const it = items.find(x => repoIn(x.url) === repo && numIn(x.url) === n)
    if (it) add.push(toLink(it)); else missing.push(n)
  }
  if (add.length) {
    const cap = Math.max(links.length, 10)
    const block = ll || ((card.blocks ||= []).push({ type: 'link-list', links: [] }), card.blocks.at(-1))
    block.links = [...add, ...links].slice(0, cap)
  }
  if (missing.some(n => numsIn(card.nextAction).includes(n))) { card.nextAction = ''; if (Array.isArray(card.actions)) card.actions = card.actions.filter(a => !missing.some(n => String(a.label || '').includes('#' + n))) }
  return add.length
}

/** Every link on the given cards must be one of the snapshot URLs (or a known card/app URL). */
export function invalidLinks(cards, validUrls) {
  const bad = []
  for (const c of cards) for (const b of c.blocks || []) for (const l of b.links || []) if (l?.url && !validUrls.has(l.url)) bad.push({ card: c.sourceId, url: l.url })
  return bad
}

/** Entities (stable key -> item URLs) a source bot saw this run: lets the store archive stale cards it skipped. */
export function seenEntities(channel, snap) {
  const out = new Map()
  for (const it of snap.all || snap.items) {
    const k = channel === 'github' ? `github:cluster:${keyOf('github', it)}` : channel === 'slack' ? `slack:cluster:${keyOf('slack', it)}` : null
    if (!k) continue
    if (!out.has(k)) out.set(k, new Set())
    out.get(k).add(it.url)
  }
  return out
}
