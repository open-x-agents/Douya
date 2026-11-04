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
  if (card.type === 'email-group') {
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
        prompt: `帮我看一下 PR「${clip(review.title, 60)}」${review.url} 改了什么、有没有要我拍板的地方，最后给一段评审意见草稿（先别提交）${ref}。` })
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

/**
 * The one thing to do now.
 * { kind:'meeting'|'card'|'block'|'none', title, why, at?, endsAt?, startsInMin?, cardId?, url?, buttons:[…] }
 * Order: a calendar event live now or within 15 min → the top needs-you card → the current timetable block.
 */
export function pickNextThing({ cards = [], itemStatus = {}, now = new Date() } = {}) {
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
    if (ev.url) buttons.push({ kind: 'link', label: live ? '进入会议' : '打开会议', url: ev.url })
    buttons.push({ kind: 'ask', label: '交给豆芽', hint: '会前要点', prompt: `「${clip(ev.title, 40)}」${live ? '已经开始' : `${hm(ev.s)} 开始`}，帮我用三条列出会前要点：相关的 PR / 邮件 / 消息里有什么要我在会上提的。` })
    return { kind: 'meeting', title: clip(ev.title, 60), why: live ? `进行中 · ${hm(ev.s)}–${hm(ev.e)}` : `${Math.max(1, Math.round((ev.s - t) / 60000))} 分钟后开始 · ${hm(ev.s)}–${hm(ev.e)}`, at: hm(ev.s), endsAt: hm(ev.e), startsAtMs: ev.s, live, url: ev.url || null, buttons, upcoming: null }
  }
  const top = ranked.find(c => cardUrgency(c, { itemStatus }) >= 30) || null
  if (top) {
    const prep = prepareCardActions(top, { itemStatus, max: 3 })
    const hand = prep.find(p => p.kind === 'ask' || p.kind === 'act')
    const buttons = [{ kind: 'open', label: '开始', cardId: top.id }]
    buttons.push({ kind: 'snooze', label: '推迟', cardId: top.id, hint: '明早 9 点再出现' })
    if (hand) buttons.push({ ...hand, label: hand.kind === 'ask' ? '交给豆芽' : hand.label, cardId: top.id })
    else buttons.push({ kind: 'ask', label: '交给豆芽', cardId: top.id, prompt: `帮我推进「${clip(top.title, 40)}」（卡片 id ${top.id}）：${clip(top.nextAction || '看看下一步该做什么', 60)}。` })
    const shortWhy = String(top.why || '').trim()
    const why = [top.waiting === 'you' ? '在等你' : '', PRI[top.priority] >= 3 ? '优先' : '', shortWhy && shortWhy.length <= 36 && /[\u4e00-\u9fa5]/.test(shortWhy) ? shortWhy : ''].filter(Boolean).join(' · ')
    return { kind: 'card', title: clip(top.title, 60), next: clip(top.nextAction || '', 70), why, cardId: top.id, source: top.source || null, buttons, upcoming }
  }
  const blocks = (ttb.suggestedBlocks || []).map(b => ({ ...b, s: toMs(b.start, now), e: toMs(b.end, now) })).filter(b => b.s != null && b.e > t).sort((a, b) => a.s - b.s)
  const blk = blocks.find(b => b.s <= t) || blocks[0]
  if (blk) {
    return { kind: 'block', title: clip(blk.title, 60), why: `${blk.s <= t ? '现在' : '接下来'} ${hm(blk.s)}–${hm(blk.e)}`, at: hm(blk.s), endsAt: hm(blk.e),
      buttons: [{ kind: 'timetable', label: '看安排' }, { kind: 'ask', label: '交给豆芽', prompt: `我${blk.s <= t ? '现在' : '接下来'}要做「${clip(blk.title, 40)}」（${hm(blk.s)}–${hm(blk.e)}），帮我列一个马上能开始的三步清单。` }], upcoming }
  }
  return { kind: 'none', title: work.length ? '眼下没有特别急的事' : '今天还没有待办', why: work.length ? `${work.length} 张卡都不算急，挑一张顺手的处理就好` : '点「立即汇聚」拉取已连接信源的最新动态', buttons: [], upcoming }
}

/** One-line summary of the day for the collapsed header. Only counts real data. */
export function daySummaryLine({ cards = [], itemStatus = {}, meetings = 0, now = new Date() } = {}) {
  const work = cards.filter(c => isWorkCard(c) && (!c.status || c.status === 'active'))
  const needYou = work.filter(c => c.waiting === 'you').length
  const mails = work.filter(c => c.type === 'email-group').reduce((n, c) => n + openLinks(c, itemStatus).filter(l => linkType(l) === 'email').length, 0)
  const prs = work.reduce((n, c) => n + openLinks(c, itemStatus).filter(l => linkType(l) === 'pr').length, 0)
  const parts = []
  parts.push(meetings ? `${meetings} 个会` : '没有会')
  if (needYou) parts.push(`${needYou} 件等你`)
  if (prs) parts.push(`${prs} 个 PR`)
  if (mails) parts.push(`${mails} 封邮件`)
  if (!needYou && !prs && !mails) parts.push(`${work.length} 张卡`)
  return parts.join(' · ')
}
