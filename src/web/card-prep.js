// Ready-made next steps for Today cards, plus the single "next thing" for the hero.
//
// Everything here is pure and computed from the card's *current* data (links, item status, timetable), so a
// prepared action is never stale and never invents a target: every url / id comes from the card itself.
// Kinds:
//   act    → a write action (actions.js). Clicking creates a PENDING action held for 确认执行 — even reversible
//            ones — so nothing is changed or sent without the user's confirmation.
//   ask    → hands a concrete request to 豆芽 (Chief) in the chat; Chief replies with drafts / pending actions.
//   snooze → hide the card until tomorrow morning (reversible from the toast).
//   open   → open the card (zoom).

import { t as tr, resolveLang, DEFAULT_LOCALE } from '../i18n/index.js'

const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s }
const SYSTEM_TYPES = new Set(['hero', 'timetable', 'achievements-tile'])
export const isWorkCard = c => c && !SYSTEM_TYPES.has(c.type) && c.source !== 'system' && c.type !== 'view'

export function cardLinks(card) {
  const ll = (card?.blocks || []).find(b => b && b.type === 'link-list')
  const fromBlocks = (ll && ll.links) || []
  const extra = Array.isArray(card?.links) ? card.links : []
  return [...fromBlocks, ...extra].filter(l => l && typeof l.url === 'string' && /^https?:\/\//.test(l.url))
}
export function linkType(l) {
  const t = String(l?.type || ''), u = String(l?.url || '')
  if (t === 'slack' || /\.slack\.com\//.test(u)) return 'slack'
  if (t.startsWith('email') || /mail\.google\.com/.test(u)) return 'email'
  if (/\/pull\/\d+/.test(u)) return 'pr'
  if (/\/issues\/\d+/.test(u)) return 'issue'
  return 'link'
}
const openLinks = (card, itemStatus = {}) => cardLinks(card).filter(l => !itemStatus[l.url] && !(card.itemStatus || {})[l.url])
// Automated senders (CI, notifications, security alerts): never offer to "reply" to these.
const AUTOMATED = /no-?reply|do-?not-?reply|notifications?@|notify|mailer|bounce|alerts?@|security|github|gitlab|circleci|vercel|actions@|bot\b|\bbot@|(?:^|\s)ci\b|accounts\.google/i
export const isAutomated = l => AUTOMATED.test(`${l?.from || ''} ${l?.fromEmail || ''}`)
const prNum = u => (String(u).match(/\/(?:pull|issues)\/(\d+)/) || [])[1]

/** Up to `max` prepared steps for one card, most specific first; 明天再看 fills the last slot. */
export function prepareCardActions(card, { itemStatus = {}, max = 2 } = {}) {
  if (!isWorkCard(card)) return []
  const out = []
  const open = openLinks(card, itemStatus)
  // Fully processed cards get no CTAs (they should be swept to done); don't offer 明天再看 either.
  if (!open.length && cardLinks(card).length) return []
  const ref = `（卡片「${clip(card.title, 30)}」，id ${card.id}）`
  // A single actionable mail (email-action) gets the same help as the 需要你处理 group: a reply draft first.
  if (card.type === 'email-group' || card.type === 'email-action') {
    const mails = open.filter(l => linkType(l) === 'email')
    // Only the 'action' group (a person asking you something) gets a reply draft; code / security / updates are machine mail.
    const machineGroup = ['code', 'security', 'updates', 'social', 'promo'].includes(card.metadata?.group)
    const human = machineGroup ? null : mails.find(l => !isAutomated(l))
    if (card.waiting === 'you' && !human && mails[0]) {
      out.push({ id: 'check-first', kind: 'ask', label: `看「${clip(mails[0].title, 12)}」要我做什么`, hint: '系统通知，豆芽读完告诉你要不要动',
        prompt: `这封是系统通知：「${clip(mails[0].title, 60)}」，链接 ${mails[0].url} ${ref}。读一下，告诉我要不要处理、怎么处理；不用处理就帮我准备归档。` })
      if (mails.length > 2) out.push({ id: 'archive-all', kind: 'act', label: `归档这 ${mails.length} 封`, hint: '确认后执行，可撤销',
        action: 'gmail_archive_many', input: { items: mails.slice(0, 50).map(l => ({ url: l.url, title: clip(l.title, 80) })) } })
    }
    if (card.waiting === 'you' && human) {
      mails.splice(0, mails.length, human, ...mails.filter(l => l !== human))
    }
    if (card.waiting === 'you' && human && mails[0]) {
      out.push({ id: 'reply-first', kind: 'ask', label: `起草回复「${clip(mails[0].title, 16)}」`, hint: '豆芽起草，你确认后才发',
        prompt: `帮我起草回复这封邮件：「${clip(mails[0].title, 60)}」${mails[0].from ? `（来自 ${clip(mails[0].from, 40)}）` : ''}，链接 ${mails[0].url} ${ref}。先给我看草稿，等我确认再发。` })
    }
    if (card.waiting !== 'you' && mails.length) {
      out.push({ id: 'archive-all', kind: 'act', label: mails.length > 1 ? `归档这 ${mails.length} 封` : '归档这封', hint: '确认后执行，可撤销',
        action: 'gmail_archive_many', input: { items: mails.slice(0, 50).map(l => ({ url: l.url, title: clip(l.title, 80) })) } })
    }
  } else if (card.source === 'github' || open.some(l => linkType(l) === 'pr' || linkType(l) === 'issue')) {
    const mine = open.find(l => linkType(l) === 'pr' && /mine/.test(String(l.type)))
    const review = open.find(l => linkType(l) === 'pr' && !/mine/.test(String(l.type)))
    const issue = open.find(l => linkType(l) === 'issue')
    if (review) {
      out.push({ id: 'review-brief', kind: 'ask', label: `帮我看 #${prNum(review.url)} 改了什么`, hint: '豆芽读改动，给要点和评审意见草稿',
        prompt: `帮我看一下 PR「${clip(review.title, 60)}」${review.url}：先一句话结论（能不能批 / 要不要改），再说改了什么、有没有要我拍板的地方，最后给一段评审意见草稿（先别提交）${ref}。` })
    }
    if (mine && card.waiting !== 'you') {
      const n = prNum(mine.url)
      const title = clip(mine.title, 40)
      out.push({ id: `nudge-${n}`, kind: 'act', label: n ? `催一下 #${n}` : '催一下 review', hint: '中文短评已备好，确认后才发到 GitHub',
        action: 'github_comment', input: { url: mine.url, body: n
          ? `叮一下：#${n}${title ? `「${title}」` : ''} 还等 review，有空帮忙看一眼吗？谢谢！`
          : `叮一下：这个 PR 还等 review，有空帮忙看一眼吗？谢谢！` } })
    }
    if (mine && card.waiting === 'you') {
      out.push({ id: `push-${prNum(mine.url)}`, kind: 'ask', label: `看 #${prNum(mine.url)} 卡在哪`, hint: '豆芽查 CI / review，需要催就备好评论',
        prompt: `帮我看我的 PR「${clip(mine.title, 60)}」${mine.url} 现在卡在哪（CI、review、冲突），能合就告诉我；要催别人就起草一条评论给我确认${ref}。` })
    }
    if (!review && !mine && issue) {
      out.push({ id: 'issue-reply', kind: 'ask', label: `起草回复 #${prNum(issue.url)}`, hint: '豆芽起草，你确认后才发',
        prompt: `帮我起草一条回复给 issue「${clip(issue.title, 60)}」${issue.url}，先给我看，等我确认再发${ref}。` })
    }
  } else if (card.type === 'slack-cluster' || card.source === 'slack') {
    const need = open.find(l => linkType(l) === 'slack' && l.needsYou) || (card.waiting === 'you' ? open.find(l => linkType(l) === 'slack') : null)
    if (need) {
      out.push({ id: 'slack-reply', kind: 'ask', label: `起草回复 ${need.from ? clip(need.from, 10) : '这条消息'}`, hint: '豆芽起草，你确认后才发',
        prompt: `帮我起草一条 Slack 回复：${need.from ? `${clip(need.from, 30)} 说` : ''}「${clip(need.text || need.title, 80)}」，链接 ${need.url} ${ref}。先给我看，确认再发。` })
    }
  } else if (card.type === 'task' || card.source === 'bot' || card.source === 'manual') {
    if (card.nextAction) out.push({ id: 'do-task', kind: 'ask', label: '交给豆芽', hint: clip(card.nextAction, 40),
      prompt: `帮我推进这件事：「${clip(card.title, 40)}」，下一步是「${clip(card.nextAction, 60)}」${ref}。先列一个能马上开始的提纲或草稿。` })
  }
  if (out.length < max) out.push({ id: 'snooze', kind: 'snooze', label: '明天再看', hint: '明早 9 点再出现' })
  return out.slice(0, max)
}

/** Tomorrow 09:00 in the given UTC offset (Asia/Shanghai by default). */
export function tomorrowMorning(now = new Date(), offsetH = 8) {
  const local = new Date(now.getTime() + offsetH * 3600e3)
  const d = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1, 9, 0, 0) - offsetH * 3600e3
  return new Date(d).toISOString()
}

/** Resolve snooze presets used by swipe / sheet: `snooze`|`snooze:1h`|`snooze:tomorrow`|`snooze:week`. */
export function snoozeUntilFor(prepId = 'snooze', now = new Date(), offsetH = 8) {
  const id = String(prepId || 'snooze')
  if (id === 'snooze:1h' || id === '1h') return new Date(now.getTime() + 3600e3).toISOString()
  if (id === 'snooze:week' || id === 'week' || id === 'next-week') {
    const local = new Date(now.getTime() + offsetH * 3600e3)
    const d = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 7, 9, 0, 0) - offsetH * 3600e3
    return new Date(d).toISOString()
  }
  return tomorrowMorning(now, offsetH)
}

const PRI = { urgent: 4, high: 3, medium: 2, low: 1 }
const toMs = (v, now) => {
  if (v == null) return null
  const s = String(v)
  if (/^\d{1,2}:\d{2}$/.test(s)) { const [h, m] = s.split(':').map(Number); const d = new Date(now); d.setHours(h, m, 0, 0); return d.getTime() }
  const t = new Date(s).getTime(); return isNaN(t) ? null : t
}
const hm = ms => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }

/** Score a work card for "what matters now". */
export function cardUrgency(card, { itemStatus = {} } = {}) {
  let s = (PRI[card.priority] || 1) * 10
  if (card.waiting === 'you') s += 12
  if (card.pinned) s += 6
  if (card.type === 'task' || card.source === 'bot' || card.source === 'manual') s += 4
  if (card.waiting === 'fyi') s -= 8
  if (card.waiting === 'others') s -= 14 // quiet strip territory — not the hero
  const open = openLinks(card, itemStatus).length
  if (card.type === 'email-group' && !open) s -= 30
  if (!open && cardLinks(card).length) s -= 40 // fully handled items — about to leave Today
  return s
}

const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
/** Stable per-day key for a timetable block the user marked done (title survives re-planning; times may shift). */
export function blockDoneKey(block, now = new Date()) {
  return `${ymd(now)}|${String(block?.title || '').replace(/\s+/g, ' ').trim()}`
}
/**
 * A suggested block is finished when the user marked it done, or every card it was planned for is no longer open
 * work on Today (done / dismissed / snoozed / merged away, or every linked item handled).
 */
export function blockResolved(block, { cards = [], itemStatus = {}, doneBlocks = [], now = new Date() } = {}) {
  if (!block) return true
  if ((doneBlocks || []).includes(blockDoneKey(block, now))) return true
  const ids = Array.isArray(block.cardIds) ? block.cardIds.filter(Boolean) : []
  if (!ids.length) return false
  const openWork = c => c && isWorkCard(c) && (!c.status || c.status === 'active') && (!cardLinks(c).length || openLinks(c, itemStatus).length > 0)
  return !ids.some(id => openWork(cards.find(c => c && c.id === id)))
}

/**
 * The one thing to do now.
 * { kind:'meeting'|'card'|'block'|'none', title, why, at?, endsAt?, startsInMin?, cardId?, url?, buttons:[…] }
 * Order: a calendar event live now or within 15 min → the top needs-you card → the current timetable block.
 */
export function pickNextThing({ cards = [], itemStatus = {}, doneBlocks = [], now = new Date(), lang = DEFAULT_LOCALE } = {}) {
  const locale = resolveLang(lang)
  const t = now.getTime()
  const tt = cards.find(c => c && c.type === 'timetable')
  const ttb = (tt?.blocks || []).find(b => b.type === 'timetable') || {}
  const events = (ttb.fixedBlocks || []).map(b => ({ ...b, s: toMs(b.start, now), e: toMs(b.end, now) }))
    .filter(b => b.s != null && b.e != null && b.e > t && !/^\d{4}-\d{2}-\d{2}$/.test(String(b.start)))
    .sort((a, b) => a.s - b.s)
  const ev = events[0]
  const work = cards.filter(c => isWorkCard(c) && (!c.status || c.status === 'active'))
  const ranked = [...work].sort((a, b) => cardUrgency(b, { itemStatus }) - cardUrgency(a, { itemStatus }))
  const upcoming = ev && ev.s > t ? { title: clip(ev.title, 40), at: hm(ev.s), startsInMin: Math.round((ev.s - t) / 60000) } : null
  if (ev && ev.s - t <= 15 * 60000) {
    const live = ev.s <= t
    const buttons = []
    if (ev.url) buttons.push({ kind: 'link', label: tr(live ? 'hero.btn_join' : 'hero.btn_open_meet', locale), url: ev.url })
    // Prompt stays Chinese for model quality when owner chats in zh; English UI still shows EN button labels.
    buttons.push({ kind: 'ask', label: tr('hero.btn_ask', locale), hint: locale === 'zh' ? '会前要点' : 'Pre-meeting notes', prompt: `「${clip(ev.title, 40)}」${live ? '已经开始' : `${hm(ev.s)} 开始`}，帮我用三条列出会前要点：相关的 PR / 邮件 / 消息里有什么要我在会上提的。` })
    const why = live
      ? (locale === 'zh' ? `进行中 · ${hm(ev.s)}–${hm(ev.e)}` : `In progress · ${hm(ev.s)}–${hm(ev.e)}`)
      : (locale === 'zh' ? `${Math.max(1, Math.round((ev.s - t) / 60000))} 分钟后开始 · ${hm(ev.s)}–${hm(ev.e)}` : `Starts in ${Math.max(1, Math.round((ev.s - t) / 60000))} min · ${hm(ev.s)}–${hm(ev.e)}`)
    return { kind: 'meeting', title: clip(ev.title, 60), why, at: hm(ev.s), endsAt: hm(ev.e), startsAtMs: ev.s, live, url: ev.url || null, buttons, upcoming: null }
  }
  const top = ranked.find(c => cardUrgency(c, { itemStatus }) >= 30) || null
  if (top) {
    const prep = prepareCardActions(top, { itemStatus, max: 3 })
    const hand = prep.find(p => p.kind === 'ask' || p.kind === 'act')
    const buttons = [{ kind: 'open', label: tr('hero.btn_start', locale), cardId: top.id }]
    buttons.push({ kind: 'snooze', label: tr('hero.btn_snooze', locale), cardId: top.id, hint: locale === 'zh' ? '明早 9 点再出现' : 'Back tomorrow 9:00' })
    if (hand) buttons.push({ ...hand, label: hand.kind === 'ask' ? tr('hero.btn_ask', locale) : hand.label, cardId: top.id })
    else buttons.push({ kind: 'ask', label: tr('hero.btn_ask', locale), cardId: top.id, prompt: `帮我推进「${clip(top.title, 40)}」（卡片 id ${top.id}）：${clip(top.nextAction || '看看下一步该做什么', 60)}。` })
    const shortWhy = String(top.why || '').trim()
    const why = [top.waiting === 'you' ? tr('hero.waiting_you', locale) : '', PRI[top.priority] >= 3 ? tr('hero.priority', locale) : '', shortWhy && shortWhy.length <= 36 && /[\u4e00-\u9fa5]/.test(shortWhy) ? shortWhy : ''].filter(Boolean).join(' · ')
    return { kind: 'card', title: clip(top.title, 60), next: clip(top.nextAction || '', 70), why, cardId: top.id, source: top.source || null, buttons, upcoming }
  }
  const remaining = (ttb.suggestedBlocks || []).map(b => ({ ...b, s: toMs(b.start, now), e: toMs(b.end, now) })).filter(b => b.s != null && b.e > t).sort((a, b) => a.s - b.s)
  // Skip blocks that are already finished (marked done, or their cards are done / merged / snoozed) — advance to the next.
  const blocks = remaining.filter(b => !blockResolved(b, { cards, itemStatus, doneBlocks, now }))
  const blk = blocks.find(b => b.s <= t) || blocks[0]
  if (blk) {
    const live = blk.s <= t
    // The card this block was planned for (still open) — the hero shows its prepared brief inline.
    const blockCard = (blk.cardIds || []).map(id => work.find(c => c.id === id)).find(Boolean) || null
    return { kind: 'block', ...(blockCard ? { cardId: blockCard.id } : {}), title: clip(blk.title, 60), why: `${tr(live ? 'hero.live' : 'hero.upcoming', locale)} ${hm(blk.s)}–${hm(blk.e)}`, at: hm(blk.s), endsAt: hm(blk.e), live, blockKey: blockDoneKey(blk, now),
      buttons: [{ kind: 'blockdone', label: tr('hero.btn_done', locale), blockKey: blockDoneKey(blk, now), title: clip(blk.title, 60) }, { kind: 'timetable', label: tr('hero.btn_timetable', locale) }, { kind: 'ask', label: tr('hero.btn_ask', locale), prompt: `我${live ? '现在' : '接下来'}要做「${clip(blk.title, 40)}」（${hm(blk.s)}–${hm(blk.e)}），帮我列一个马上能开始的三步清单。` }], upcoming }
  }
  if (remaining.length) {
    return { kind: 'none', title: tr('hero.all_done_title', locale), why: work.length ? tr('hero.all_done_why_cards', locale, { n: work.length }) : tr('hero.all_done_why', locale), buttons: [{ kind: 'timetable', label: tr('hero.btn_timetable', locale) }], upcoming }
  }
  return { kind: 'none', title: work.length ? tr('hero.idle_title', locale) : tr('hero.idle_title_empty', locale), why: work.length ? tr('hero.idle_why', locale, { n: work.length }) : tr('hero.idle_why_empty', locale), buttons: [], upcoming }
}

/** One-line summary of the day for the collapsed header. Only counts real data. */
export function daySummaryLine({ cards = [], itemStatus = {}, meetings = 0, now = new Date(), lang = DEFAULT_LOCALE } = {}) {
  const locale = resolveLang(lang)
  const work = cards.filter(c => isWorkCard(c) && (!c.status || c.status === 'active'))
  const needYou = work.filter(c => c.waiting === 'you').length
  const mails = work.filter(c => c.type === 'email-group').reduce((n, c) => n + openLinks(c, itemStatus).filter(l => linkType(l) === 'email').length, 0)
  const prs = work.reduce((n, c) => n + openLinks(c, itemStatus).filter(l => linkType(l) === 'pr').length, 0)
  const parts = []
  parts.push(meetings ? tr('summary.meet_n', locale, { n: meetings }) : tr('summary.no_meet', locale))
  if (needYou) parts.push(tr('summary.wait_n', locale, { n: needYou }))
  if (prs) parts.push(tr('summary.pr_n', locale, { n: prs }))
  if (mails) parts.push(tr('summary.mail_n', locale, { n: mails }))
  if (!needYou && !prs && !mails) parts.push(tr('summary.card_n', locale, { n: work.length }))
  return parts.join(' · ')
}
