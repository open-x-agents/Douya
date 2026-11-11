import { t, resolveLang, DEFAULT_LOCALE } from '../i18n/index.js'
/**
 * Email → category cluster cards for the Today grid.
 *
 * One tile per category (需要你处理 / CI与代码通知 / 账号与安全通知 / 促销与订阅 / 社交通知 / 服务与通知),
 * derived only from the fetched mail (labels, sender, subject). Only a few genuinely actionable
 * mails from real people get their own tile (capped). Nothing here is specific to one user.
 */

const MAX_SINGLES = 4
const MAX_GROUP_LINKS = 60

export const GROUPS = {
  action: { labelKey: 'mail.group.action', icon: 'person', order: 0 },
  code: { labelKey: 'mail.group.code', icon: 'code', order: 1 },
  security: { labelKey: 'mail.group.security', icon: 'shield', order: 2 },
  updates: { labelKey: 'mail.group.updates', icon: 'bell', order: 3 },
  social: { labelKey: 'mail.group.social', icon: 'chat', order: 4 },
  promo: { labelKey: 'mail.group.promo', icon: 'tag', order: 5 },
}
/** Display label for a mail group in the page language. */
export function groupLabel(key, lang = DEFAULT_LOCALE) {
  const g = GROUPS[key]
  return g ? t(g.labelKey, resolveLang(lang)) : key
}

const BOT_SENDER = /no-?reply|do-?not-?reply|notifications?@|notify@|alerts?@|mailer|news(letter)?@|info@|hello@|marketing|promo|offers?@|deals?@|updates?@|support@|team@|account(s)?@|billing@|digest|bounce|@e\.|@em\.|@email\.|@mail\.|@m\.|@mg\.|@send\.|@reply\./i
const PROMO_TEXT = /\d+\s?% ?off|% off|sale\b|deal(s)?\b|discount|coupon|promo|offer|early access|limited time|last chance|ends (today|tonight|soon)|free shipping|clearance|black friday|cyber monday|11\.11|save\b|savings|shop now|new arrivals|优惠|折|促销|特价|限时|买一送一|满减|领券|会员日|答谢日|上新|秒杀|dernière chance|soldes|réduction/i
const SECURITY_TEXT = /security|安全|verify|verification|验证码|验证|password|密码|sign[- ]?in|log[- ]?in|登录|2fa|two-factor|one-time|otp|suspicious|unusual|new device|账号|帐号|account (alert|update|change)|privacy|隐私|access (has been|was) (granted|changed)|访问方式/i
const SOCIAL_SENDER = /facebook|facebookmail|messenger|instagram|linkedin|twitter|x\.com|discord|reddit|wechat|weixin|whatsapp|telegram|tiktok|snapchat|pinterest|quora|nextdoor|meetup|strava/i
const CI_TEXT = /(run|build|workflow|check|checks|job|pipeline|deploy(ment)?)s? (failed|failing|errored|broken)|failed:|ci failed|build failed|tests? (failed|failing)/i
const CODE_SENDER = /github\.com|gitlab|bitbucket|circleci|travis|vercel|netlify|sentry|buildkite|jenkins|dependabot|renovate/i
const ACTION_TEXT = /\?|？|deadline|due\b|截止|到期|请(你|您)?|麻烦|能否|是否可以|could you|can you|would you|please|review|reply|回复|确认|confirm|approve|批准|sign\b|签字|签署|rsvp|invitation|邀请|meeting|会议|tomorrow|明天|today|今天|by (mon|tue|wed|thu|fri|sat|sun)/i

const nameOf = from => {
  const s = String(from || '').trim()
  const m = s.match(/^"?([^"<]+?)"?\s*</)
  const n = (m ? m[1] : s.replace(/<.*>/, '')).replace(/^From:\s*/i, '').trim()
  return n || (s.match(/<([^>]+)>/) || [])[1] || s || 'unknown'
}
const addrOf = from => ((String(from || '').match(/<([^>]+)>/) || [])[1] || String(from || '')).toLowerCase()
const clean = s => String(s || '').replace(/^(re|fwd?|回复|转发)\s*[:：]\s*/i, '').replace(/^\[[\w.-]+\/[\w.-]+\]\s*/, '').trim()
const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s }

/** Classify one normalized email item ({title, url, metadata:{from, labelIds, snippet}}). */
export function classifyEmail(item) {
  const md = item.metadata || {}
  const from = md.from || String(item.body || '').replace(/^From:\s*/i, '')
  const subject = item.title || ''
  const text = `${subject} ${md.snippet?.body || md.snippet || ''}`
  const labels = md.labelIds || []
  const bot = BOT_SENDER.test(addrOf(from)) || /\[bot\]/i.test(from)
  if (CI_TEXT.test(subject) || CODE_SENDER.test(addrOf(from)) || /\[[\w.-]+\/[\w.-]+\]/.test(subject)) return 'code'
  if (labels.includes('CATEGORY_SOCIAL') || SOCIAL_SENDER.test(addrOf(from))) return 'social'
  if (SECURITY_TEXT.test(subject) && (bot || labels.includes('CATEGORY_UPDATES'))) return 'security'
  if (labels.includes('CATEGORY_PROMOTIONS') || (bot && PROMO_TEXT.test(subject))) return 'promo'
  if (!bot && !labels.includes('CATEGORY_UPDATES') && !labels.includes('CATEGORY_FORUMS')) return 'action'
  if (PROMO_TEXT.test(text)) return 'promo'
  return 'updates'
}

function isActionableSingle(item) {
  const md = item.metadata || {}
  const text = `${item.title || ''} ${md.snippet?.body || md.snippet || ''}`
  return (md.labelIds || []).includes('IMPORTANT') || ACTION_TEXT.test(text)
}

const repoOf = t => (String(t || '').match(/\[([\w.-]+\/[\w.-]+)\]/) || [])[1] || null

// Code mail from GitHub & co. carries the actor's name as sender, so name the repos instead.
function topSenders(list, n = 3, key = null) {
  const count = new Map()
  for (const it of list) {
    const k = (key === 'code' && repoOf(it.title)) || nameOf(it.metadata?.from || it.body)
    count.set(k, (count.get(k) || 0) + 1)
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, c]) => ({ name, count: c }))
}

function groupCopy(key, list, senders, lang = DEFAULT_LOCALE) {
  const locale = resolveLang(lang)
  const n = list.length
  const who = senders.map(s => s.name).join(locale === 'zh' ? '、' : ', ')
  const more = n > senders.length ? (locale === 'zh' ? ' 等' : '…') : ''
  const unread = list.filter(i => (i.metadata?.labelIds || []).includes('UNREAD') || i.type === 'email-unread').length
  const unreadTxt = unread ? (locale === 'zh' ? `，${unread} 封未读` : `, ${unread} unread`) : ''
  switch (key) {
    case 'action': {
      const first = list[0]
      const w = nameOf(first.metadata?.from || first.body)
      return {
        body: t('mail.copy.action', locale, { n, unread: unreadTxt, who, more }),
        nextAction: t('mail.copy.action_next', locale, { who: w, title: clip(clean(first.title), 28) }),
        waiting: 'you', priority: 'high',
      }
    }
    case 'code': {
      const failed = list.filter(i => CI_TEXT.test(i.title || ''))
      const repos = [...new Set(list.map(i => ((i.title || '').match(/\[([\w.-]+\/[\w.-]+)\]/) || [])[1]).filter(Boolean))]
      const reposTxt = repos.length ? t('mail.copy.code_repos', locale, { repos: repos.slice(0, 3).join(locale === 'zh' ? '、' : ', ') }) : t('mail.copy.code_from', locale, { who })
      const failedTxt = failed.length === 1 ? t('mail.copy.code_failed_one', locale) : (failed.length ? t('mail.copy.code_failed', locale, { n: failed.length }) : '')
      return {
        body: t('mail.copy.code', locale, { n, repos: reposTxt, failed: failedTxt }),
        nextAction: failed.length
          ? t('mail.copy.code_next_fail', locale, { title: clip(clean(failed[0].title), 30) })
          : t('mail.copy.code_next_ok', locale, { n }),
        waiting: failed.length ? 'you' : 'fyi', priority: failed.length ? 'medium' : 'low',
      }
    }
    case 'security':
      return {
        body: t('mail.copy.security', locale, { n, who, more }),
        nextAction: t('mail.copy.security_next', locale, { n }),
        waiting: 'you', priority: 'medium',
      }
    case 'social':
      return {
        body: t('mail.copy.social', locale, { n, who, more }),
        nextAction: t('mail.copy.social_next', locale, { n }),
        waiting: 'fyi', priority: 'low',
      }
    case 'promo':
      return {
        body: t('mail.copy.promo', locale, { n, who, more }),
        nextAction: t('mail.copy.promo_next', locale, { n }),
        waiting: 'fyi', priority: 'low',
      }
    default:
      return {
        body: t('mail.copy.updates', locale, { n, who, more }),
        nextAction: t('mail.copy.updates_next', locale, { n }),
        waiting: 'fyi', priority: 'low',
      }
  }
}

function copyFor(key, list, senders, lang = DEFAULT_LOCALE) {
  const copy = groupCopy(key, list, senders, lang)
  if (list.length === 1 && key !== 'action' && copy.waiting !== 'you') {
    copy.nextAction = t('mail.copy.single_fyi', resolveLang(lang), { title: clip(clean(list[0].title), 24) })
  }
  return copy
}

/** Rebuild a group card's counts and copy from its link-list (after migration folded mail in). */
function refreshGroupCard(g) {
  const ll = g.blocks.find(b => b.type === 'link-list')
  const lang = g.metadata?.lang || DEFAULT_LOCALE
  const pseudo = ll.links.map(l => ({ title: l.title, url: l.url, body: `From: ${l.from || ''}`, metadata: { from: l.from || '' } }))
  const senders = topSenders(pseudo, 3, g.metadata?.group)
  const copy = copyFor(g.metadata?.group, pseudo, senders, lang)
  const n = pseudo.length
  Object.assign(g, { body: copy.body, why: copy.body, nextAction: copy.nextAction, clusterSize: n, subtitle: resolveLang(lang) === 'zh' ? `共 ${n} 封` : `${n} emails`, title: groupLabel(g.metadata?.group, lang) })
  const stat = g.blocks.find(b => b.type === 'stat'); if (stat) stat.value = pseudo.length
  const tags = g.blocks.find(b => b.type === 'tags'); if (tags) tags.tags = senders.map(x => ({ text: x.count > 1 ? `${x.name} ×${x.count}` : x.name, color: tags.tags[0]?.color || 'gray' }))
  if (g.metadata) Object.assign(g.metadata, { count: pseudo.length, senders })
}

/** Repo from a GitHub notification subject: "[owner/repo] …". */
export function githubNotifRepo(title, from = '') {
  const m = String(title || '').match(/\[([\w.-]+\/[\w.-]+)\]/)
  if (m) return m[1]
  if (/notifications@github\.com/i.test(String(from))) return null
  return null
}

/** Canonical PR URL from a GitHub notification subject: "[owner/repo] … (PR #N)" or "PR #N". */
export function githubNotifPr(title, from = '') {
  const repo = githubNotifRepo(title, from)
  if (!repo) return null
  const t = String(title || '')
  const m = t.match(/\((?:PR|Pull [Rr]equest) #(\d+)\)/) || t.match(/\bPR #(\d+)\b/)
  if (!m) return null
  return { repo, number: Number(m[1]), url: `https://github.com/${repo}/pull/${m[1]}` }
}

/** Repo key of a project-cluster card (sourceId github:cluster:owner/repo or its github.com URL). */
export function repoKeyOfCard(card) {
  const sid = String(card?.sourceId || '')
  const m = sid.match(/^github:cluster:([^:]+)/)
  if (m) return m[1]
  const u = String(card?.url || '')
  return (u.match(/github\.com\/([^/]+\/[^/#?]+)/) || [])[1] || null
}

/**
 * Fold GitHub notification emails out of the "CI与代码通知" (code) mail group into the matching
 * repo project-cluster card. Leaves mail that has no matching repo card in the group.
 * Mutates `cards` in place; returns { folded, droppedFromCode }.
 */
export function foldGithubNotifsIntoRepos(cards = []) {
  const list = Array.isArray(cards) ? cards : []
  const byRepo = new Map()
  for (const c of list) {
    if (c?.type !== 'project-cluster' || c.source !== 'github') continue
    const repo = repoKeyOfCard(c)
    if (repo) byRepo.set(repo, c)
  }
  if (!byRepo.size) return { folded: 0, droppedFromCode: 0 }
  let folded = 0
  for (const g of list) {
    if (g?.type !== 'email-group' || g.metadata?.group !== 'code') continue
    const items = Array.isArray(g.items) ? g.items : []
    const keep = [], move = []
    for (const it of items) {
      const repo = githubNotifRepo(it.title, it.metadata?.from || it.body)
      if (repo && byRepo.has(repo)) move.push({ it, repo })
      else keep.push(it)
    }
    if (!move.length) continue
    for (const { it, repo } of move) {
      const card = byRepo.get(repo)
      let ll = (card.blocks || []).find(b => b.type === 'link-list')
      if (!ll) { ll = { type: 'link-list', links: [] }; (card.blocks ||= []).push(ll) }
      const pr = githubNotifPr(it.title, it.metadata?.from || it.body)
      const hasPr = pr && (ll.links || []).some(l => l.url === pr.url || (String(l.url || '').match(/\/pull\/(\d+)/) || [])[1] === String(pr.number))
      if (pr && pr.repo === repo && !hasPr) {
        ll.links = [...(ll.links || []), { title: clip(clean(it.title), 90), url: pr.url, type: 'pr', from: nameOf(it.metadata?.from || it.body), at: it.createdAt || null, mergedFrom: 'gmail' }].slice(0, MAX_GROUP_LINKS)
      }
      if (!(ll.links || []).some(l => l.url === it.url)) {
        ll.links = [...(ll.links || []), { ...emailLink(it), mergedFrom: 'gmail' }].slice(0, MAX_GROUP_LINKS)
      }
      card.items = [...(card.items || []), it]
      card.clusterSize = (card.clusterSize || 0) + 1
      card.metadata = { ...(card.metadata || {}), emailCount: (card.metadata?.emailCount || 0) + 1, mergedFrom: [...new Set([...(card.metadata?.mergedFrom || []), 'gmail'])] }
      folded++
    }
    if (!keep.length) {
      const i = list.indexOf(g)
      if (i >= 0) list.splice(i, 1)
    } else {
      g.items = keep
      g.topItems = keep.slice(0, 3)
      let ll = (g.blocks || []).find(b => b.type === 'link-list')
      if (!ll) { ll = { type: 'link-list', links: [] }; (g.blocks ||= []).push(ll) }
      ll.links = keep.slice(0, MAX_GROUP_LINKS).map(it => emailLink(it, g.metadata?.lang || DEFAULT_LOCALE))
      refreshGroupCard(g)
    }
  }
  return { folded, droppedFromCode: folded }
}

export function emailLink(it, lang = DEFAULT_LOCALE) {
  const locale = resolveLang(lang)
  return {
    title: clip(clean(it.title) || t('mail.no_subject', locale), 90),
    url: it.url,
    type: 'email',
    from: nameOf(it.metadata?.from || it.body),
    at: it.createdAt || null,
  }
}

/**
 * @param {object[]} emailItems normalized gmail items not already merged into repo clusters
 * @returns {object[]} clusters of type 'email-group' (one per non-empty category) and
 *   'email-action' (≤ MAX_SINGLES actionable mails from real people)
 */
export function buildEmailClusters(emailItems, { today = new Date().toISOString().split('T')[0], now = Date.now(), assign = null, lang = DEFAULT_LOCALE } = {}) {
  const locale = resolveLang(lang)
  // assign (bot digest): Map sourceId -> 'single' | group key, decided by the Gmail source bot. Unassigned mail
  // falls back to the rule classifier; singles stay capped at MAX_SINGLES (overflow goes to 需要你处理).
  const buckets = new Map()
  const wantSingle = new Set()
  for (const it of emailItems) {
    if (!it?.url) continue
    const a = assign?.get(it.sourceId)
    if (a === 'single') wantSingle.add(it)
    const k = a && GROUPS[a] ? a : a === 'single' ? 'action' : classifyEmail(it)
    if (!buckets.has(k)) buckets.set(k, [])
    buckets.get(k).push(it)
  }
  const out = []

  // Actionable singles: from real people, with a reply/deadline signal; capped.
  const action = buckets.get('action') || []
  const singles = action.filter(assign ? (i => wantSingle.has(i)) : isActionableSingle)
    .sort((a, b) => ((b.metadata?.labelIds || []).includes('IMPORTANT') - (a.metadata?.labelIds || []).includes('IMPORTANT')) || String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, MAX_SINGLES)
  for (const it of singles) {
    const who = nameOf(it.metadata?.from || it.body)
    out.push({
      id: `email_action_${it.sourceId}`,
      type: 'email-action',
      source: 'gmail',
      sourceId: `gmail:action:${it.sourceId}`,
      title: clip(clean(it.title), 80),
      subtitle: who,
      body: t('mail.single_body', locale, { who, snippet: it.metadata?.snippet ? t('mail.single_body_snip', locale, { text: clip(String(it.metadata.snippet?.body || it.metadata.snippet), 90) }) : '' }),
      url: it.url,
      priority: 'high',
      status: 'active',
      clusterSize: 1,
      items: [it],
      topItems: [it],
      nextAction: t('mail.single_next', locale, { who, title: clip(clean(it.title), 28) }),
      waiting: 'you',
      blocks: [{ type: 'link-list', links: [emailLink(it, locale)] }],
      actions: [{ label: t('mail.reply_who', locale, { who }), value: it.url, primary: true }],
      metadata: { group: 'action', from: it.metadata?.from, lang: locale },
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    })
  }
  if (singles.length) buckets.set('action', action.filter(i => !singles.includes(i)))

  for (const [key, list] of [...buckets.entries()].sort((a, b) => GROUPS[a[0]].order - GROUPS[b[0]].order)) {
    if (!list.length) continue
    const sorted = [...list].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    const senders = topSenders(sorted, 3, key)
    const copy = copyFor(key, sorted, senders, locale)
    out.push({
      id: `email_group_${key}_${today}`,
      type: 'email-group',
      source: 'gmail',
      sourceId: `gmail:group:${key}:${today}`,
      title: groupLabel(key, locale),
      subtitle: locale === 'zh' ? `共 ${sorted.length} 封` : `${sorted.length} emails`,
      body: copy.body,
      why: copy.body,
      url: sorted.length === 1 ? sorted[0].url : 'https://mail.google.com/mail/u/0/#inbox',
      priority: copy.priority,
      status: 'active',
      clusterSize: sorted.length,
      items: sorted,
      topItems: sorted.slice(0, 3),
      nextAction: copy.nextAction,
      waiting: copy.waiting,
      blocks: [
        { type: 'stat', value: sorted.length, label: t('mail.stat_label', locale) },
        { type: 'tags', tags: senders.map(s => ({ text: s.count > 1 ? `${s.name} ×${s.count}` : s.name, color: key === 'action' ? 'orange' : 'gray' })) },
        { type: 'link-list', links: sorted.slice(0, MAX_GROUP_LINKS).map(it => emailLink(it, locale)) },
      ],
      actions: [{ label: t('mail.open_first', locale, { title: clip(clean(sorted[0].title), 24) }), value: sorted[0].url, primary: true }],
      metadata: { group: key, count: sorted.length, senders, needsAction: copy.waiting === 'you', lang: locale },
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    })
  }
  return out
}

const LEGACY_EMAIL_TYPES = new Set(['single-item', 'email-cluster', 'newsletter-cluster', 'email-categories', 'email-group', 'email-action'])

/**
 * Migrate persisted per-email / per-sender cards into today's category groups.
 * Never deletes: active legacy cards become status 'merged' (hidden, still stored) and their mail
 * links are folded into the matching group; done/dismissed ones keep their status and records and
 * their url is carried into itemStatus so the group shows it as handled.
 *
 * @returns {{ cards: object[], itemStatus: object, merged: number }} cards = incoming + updated legacy
 */
export function migrateEmailCards(existingCards = [], incomingCards = [], itemStatus = {}) {
  const groups = incomingCards.filter(c => c?.type === 'email-group')
  if (!groups.length) return { cards: incomingCards, itemStatus, merged: 0 }
  const incomingKeys = new Set(incomingCards.flatMap(c => [c.id, c.sourceId]).filter(Boolean))
  const byKey = new Map(groups.map(g => [g.metadata?.group, g]))
  const linkSet = new Set(incomingCards.flatMap(c => (c.blocks || []).filter(b => b.type === 'link-list').flatMap(b => (b.links || []).map(l => l.url))))
  const nextStatus = { ...itemStatus }
  const grown = new Set()
  const updates = []
  let merged = 0
  const at = new Date().toISOString()

  // Same-day re-digest: keep mail already in today's group (e.g. folded-in legacy tiles) even if
  // the fresh fetch no longer returns it, so counts never silently shrink within a day.
  for (const g of groups) {
    const prev = existingCards.find(c => c && c.type === 'email-group' && (c.id === g.id || c.sourceId === g.sourceId))
    const prevLinks = (prev?.blocks || []).find(b => b.type === 'link-list')?.links || []
    const ll = g.blocks.find(b => b.type === 'link-list')
    for (const l of prevLinks) if (l?.url && !linkSet.has(l.url)) { ll.links.push(l); linkSet.add(l.url); grown.add(g) }
  }

  for (const c of existingCards) {
    if (!c || c.source !== 'gmail' || !LEGACY_EMAIL_TYPES.has(c.type)) continue
    if (incomingKeys.has(c.id) || incomingKeys.has(c.sourceId)) continue
    const isSingleMail = c.type === 'single-item' && /mail\.google\.com/.test(c.url || '')
    const terminal = c.status === 'done' || c.status === 'dismissed'
    if (terminal) {
      if (isSingleMail && c.url && !nextStatus[c.url]) {
        nextStatus[c.url] = { status: c.status, at: c.completedAt || c.dismissedAt || c.updatedAt || at, by: c.completedBy || c.dismissedBy || 'user', cardId: c.id, title: c.title || '', migrated: true }
      }
      continue
    }
    if (c.status === 'merged') {
      const g = groups.find(x => x.id === c.mergedInto)
      if (g && isSingleMail && c.url && !linkSet.has(c.url)) {
        g.blocks.find(b => b.type === 'link-list').links.push({ title: clip(clean(c.title), 90), url: c.url, type: 'email', from: nameOf(c.body), at: c.createdAt || null })
        linkSet.add(c.url); grown.add(g)
      }
      continue
    }
    let into = null
    if (isSingleMail && c.url) {
      const key = classifyEmail({ title: c.title, body: c.body, metadata: c.metadata || {} })
      into = byKey.get(key === 'action' ? 'action' : key) || null
      if (!into && key === 'action') into = byKey.get('updates') || null
      if (into && !linkSet.has(c.url)) {
        const ll = into.blocks.find(b => b.type === 'link-list')
        ll.links.push({ title: clip(clean(c.title), 90), url: c.url, type: 'email', from: nameOf(c.body), at: c.createdAt || null })
        linkSet.add(c.url)
        grown.add(into)
      }
    }
    updates.push({ ...c, status: 'merged', mergedAt: at, mergedInto: into?.id || null })
    merged++
  }
  for (const g of grown) refreshGroupCard(g)
  return { cards: [...incomingCards, ...updates], itemStatus: nextStatus, merged }
}
