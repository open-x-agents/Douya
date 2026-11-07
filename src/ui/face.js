// Card faces: a small declarative component set a bot picks per card (Phase B "lively cards").
//
// A bot never writes UI or data. It picks a LAYOUT from FACE_LAYOUTS and, optionally, which of the card's own
// items to feature (by item url / snapshot ref) plus a one-line note. hydrateFace() then builds the components
// from the card's CURRENT data every time /api/today is read, so a face is always live and every link / number
// comes from the store. An invalid spec is dropped (the card falls back to a rule-picked face or the template).

import { t as tr, resolveLang, DEFAULT_LOCALE } from '../i18n/index.js'

export const FACE_COMPONENTS = {
  stage: '进度条：已处理 / 总数，分段显示',
  countdown: '倒计时到一个真实时间（日历 / 截止）',
  people: '谁在等：条目里的真实发件人 / 作者',
  stats: '两三个数字（服务端计数）',
  checklist: '可勾选清单：卡片条目，勾 = 标完成',
  timeline: '迷你时间线：条目按时间',
  compare: '两个条目并排对比',
  quote: '一条消息 / 邮件的原文摘录',
  cta: '豆芽备好的下一步按钮',
  note: '一句话点评',
}
export const FACE_LAYOUTS = {
  waiting: { desc: '有人在等你：谁在等 + 等了多久 + 原话 + 下一步', parts: ['people', 'stats', 'quote', 'cta'] },
  inbox: { desc: '一组邮件 / 通知：数量 + 要处理的清单', parts: ['stats', 'checklist', 'cta'] },
  progress: { desc: '一批条目推进到哪了：进度条 + 剩下的清单', parts: ['stage', 'checklist', 'cta'] },
  checklist: { desc: '几件具体要做的事：可勾选清单', parts: ['checklist', 'cta'] },
  quote: { desc: '一条关键消息：作者行 + 原话/链接卡片', parts: ['quote', 'cta'] },
  timeline: { desc: '一件事在多个渠道的来龙去脉：时间线', parts: ['timeline', 'cta'] },
  compare: { desc: '两个选项 / 两个 PR 对比', parts: ['compare', 'cta'] },
  meeting: { desc: '会议：倒计时 + 会前清单', parts: ['countdown', 'checklist', 'cta'] },
}
const LAYOUT_IDS = Object.keys(FACE_LAYOUTS)
const one = v => String(v ?? '').replace(/\s+/g, ' ').trim()
const cut = (v, n) => { const s = one(v); return s.length > n ? `${s.slice(0, n - 1)}…` : s }
const BAD = /<\s*\/?\s*(script|iframe|img|svg|style|object|embed|link|meta)\b|javascript\s*:|\bon[a-z]+\s*=/i

/** Prefer readable message text; bare URLs become a neat link chip (host + short path), never mid-word cut. */
function quoteBody(raw) {
  let text = String(raw ?? '').replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1').replace(/\s+/g, ' ').trim()
  if (!text) return { text: '', link: null }
  const stripped = text.replace(/[.,;:!?)\]]+$/, '')
  const onlyUrl = /^https?:\/\/\S+$/.test(stripped)
  if (onlyUrl) {
    try {
      const u = new URL(stripped)
      const segs = u.pathname.split('/').filter(Boolean)
      const host = u.host.replace(/^www\./, '')
      let label
      if (/github\.com$/i.test(host) && segs.length >= 2) label = segs.slice(0, 2).join('/')
      else if (segs.length) {
        const path = '/' + segs.join('/')
        label = path.length > 32 ? `${segs[0]}/…/${segs[segs.length - 1]}` : path
      } else label = host
      return { text: '', link: { href: u.href, host, label } }
    } catch { /* fall through */ }
  }
  const withUrl = text.match(/^(.*?)(https?:\/\/\S+)\s*$/)
  if (withUrl && withUrl[1].trim().length >= 4) {
    const rest = quoteBody(withUrl[2])
    return { text: cut(withUrl[1].trim(), 140), link: rest.link }
  }
  return { text: cut(text, 160), link: null }
}


/** Prompt text for bots, generated from the tables above. */
export function facePrompt() {
  return `可选 "face"（卡面布局，让卡片一眼看懂）：{"layout":"${LAYOUT_IDS.join('|')}","focus":["ref",…最多 4 个，要突出的条目],"quote":"ref（要摘原话的那条）","note":"≤24 字一句点评"}。
${LAYOUT_IDS.map(k => `- ${k}：${FACE_LAYOUTS[k].desc}`).join('\n')}
focus / quote 只能填这张卡 items 里的 ref；数字、链接、人名都由豆芽从数据里填，你不要写。不确定就不写 face。`
}

/**
 * Validate a bot's face spec. refs → urls through `resolve(ref) => url|null`. Returns { face, errors }.
 * face: { layout, focus:[url], quote:url|null, note, by }
 */
export function validateFace(raw, { resolve = r => r, allowed = null, by = 'bot' } = {}) {
  const errors = []
  if (raw == null || raw === '') return { face: null, errors }
  let f = raw
  if (typeof f === 'string') { try { f = JSON.parse(f) } catch { return { face: null, errors: ['face 必须是对象'] } } }
  if (!f || typeof f !== 'object' || Array.isArray(f)) return { face: null, errors: ['face 必须是对象'] }
  const layout = String(f.layout || '')
  if (!FACE_LAYOUTS[layout]) return { face: null, errors: [`face.layout「${cut(layout, 20)}」不可用，可用：${LAYOUT_IDS.join('/')}`] }
  const ok = u => u && (!allowed || allowed.has(u))
  const focus = []
  for (const r of (Array.isArray(f.focus) ? f.focus : []).slice(0, 6)) {
    const u = resolve(typeof r === 'string' ? r : r?.ref || r?.url)
    if (ok(u)) { if (!focus.includes(u)) focus.push(u) } else errors.push(`face.focus「${cut(r, 30)}」不是这张卡的条目，已忽略`)
  }
  let quote = null
  if (f.quote) { const u = resolve(f.quote); if (ok(u)) quote = u; else errors.push('face.quote 不是这张卡的条目，已忽略') }
  let note = cut(f.note, 40)
  if (BAD.test(note)) { note = ''; errors.push('face.note 不能有 HTML') }
  return { face: { layout, focus: focus.slice(0, 4), quote, note, by }, errors }
}

// ---------- hydrate: spec + live card → components ----------
const linksOf = c => {
  const ll = (c?.blocks || []).find(b => b && b.type === 'link-list')
  return [...((ll && ll.links) || []), ...(Array.isArray(c?.links) ? c.links : [])].filter(l => l && typeof l.url === 'string' && /^https:\/\//.test(l.url))
}
const kindOf = l => { const t = String(l.type || ''), u = l.url; if (t === 'slack' || /\.slack\.com\//.test(u)) return 'slack'; if (t.startsWith('email') || /mail\.google\.com/.test(u)) return 'email'; if (/\/pull\/\d+/.test(u)) return 'pr'; if (/\/issues\/\d+/.test(u)) return 'issue'; return 'link' }
const KIND_KEYS = { slack: 'face.kind_slack', email: 'face.kind_email', pr: 'face.kind_pr', issue: 'face.kind_issue', link: 'face.kind_link' }
const tsOf = l => { const t = Date.parse(l.at || l.updatedAt || l.createdAt || ''); return Number.isFinite(t) && t > Date.UTC(2000, 0, 1) ? t : null }
const fromOf = l => cut(String(l.from || l.author || l.user || '').replace(/<[^>]*>/g, '').replace(/\s*[（(][^）)]*[）)]\s*$/, ''), 24)
const ago = (ms, now, locale) => {
  const d = Math.max(0, now - ms); const h = d / 3600e3
  if (h < 1) return tr('face.ago_min', locale, { n: Math.max(1, Math.round(d / 60e3)) })
  if (h < 48) return tr('face.ago_hour', locale, { n: Math.round(h) })
  return tr('face.ago_day', locale, { n: Math.round(h / 24) })
}
const shTime = ms => { const d = new Date(ms + 8 * 3600e3); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}` }

/** Rule-picked layout from the card's own data (used when no bot picked one). */
export function autoFace(card) {
  const links = linksOf(card)
  if (!links.length || ['hero', 'timetable', 'view', 'achievements-tile'].includes(card.type) || card.source === 'system') return null
  const kinds = new Set(links.map(kindOf))
  const sources = new Set(links.map(l => l.mergedFrom || kindOf(l)))
  if (sources.size >= 2 && (card.metadata?.mergedFrom || []).length) return { layout: 'timeline', focus: [], quote: null, note: '', by: 'auto' }
  if (card.type === 'slack-cluster' || (kinds.size === 1 && kinds.has('slack'))) return { layout: links.some(l => l.text) ? (card.waiting === 'you' ? 'waiting' : 'quote') : 'checklist', focus: [], quote: null, note: '', by: 'auto' }
  if (card.type === 'email-group' || card.type?.startsWith('email')) return { layout: card.waiting === 'you' && card.metadata?.group === 'action' ? 'waiting' : 'inbox', focus: [], quote: null, note: '', by: 'auto' }
  if (kinds.has('pr') || kinds.has('issue')) return { layout: 'progress', focus: [], quote: null, note: '', by: 'auto' }
  return { layout: 'checklist', focus: [], quote: null, note: '', by: 'auto' }
}

/**
 * Build the face's components from the live card. Never throws; returns null when there is nothing honest to show.
 * @returns {{layout, by, note, parts:[{type,...}]}|null}
 */
export function hydrateFace(card, spec, { itemStatus = {}, now = Date.now(), events = [], lang = DEFAULT_LOCALE } = {}) {
  const locale = resolveLang(lang)
  const f = spec && FACE_LAYOUTS[spec.layout] ? spec : null
  if (!f) return null
  const st = { ...(card.itemStatus || {}), ...itemStatus }
  const all = linksOf(card)
  if (!all.length && f.layout !== 'meeting') return null
  const status = l => (st[l.url]?.status === 'done' ? 'done' : st[l.url]?.status === 'dismissed' ? 'dismissed' : 'open')
  const open = all.filter(l => status(l) === 'open'), handled = all.length - open.length
  const pick = (list, n) => { const fx = (f.focus || []).map(u => list.find(l => l.url === u)).filter(Boolean); return [...fx, ...list.filter(l => !fx.includes(l))].slice(0, n) }
  const kindLabel = k => tr(KIND_KEYS[k] || 'face.kind_link', locale)
  const item = l => ({ title: cut(l.title, 80), url: l.url, src: l.mergedFrom || card.source || null, kind: kindOf(l), kindZh: kindLabel(kindOf(l)), from: fromOf(l) || null, at: tsOf(l), done: status(l) !== 'open', needsYou: !!l.needsYou })
  const parts = []
  for (const p of FACE_LAYOUTS[f.layout].parts) {
    if (p === 'people') {
      const src = (f.layout === 'waiting' ? open.filter(l => l.needsYou).concat(open) : open)
      const seen = new Map()
      for (const l of src) { const n = fromOf(l); if (n && !seen.has(n)) seen.set(n, { name: n }) }
      if (seen.size) parts.push({ type: 'people', label: tr(f.layout === 'waiting' ? 'face.waiting_you' : 'face.who', locale), people: [...seen.values()].slice(0, 5), more: Math.max(0, seen.size - 5) })
    } else if (p === 'stats') {
      const pairs = []
      if (f.layout === 'waiting') {
        const oldest = open.map(tsOf).filter(Boolean).sort((a, b) => a - b)[0]
        if (oldest) pairs.push({ label: tr('face.waited', locale), value: ago(oldest, now, locale), tone: now - oldest > 24 * 3600e3 ? 'hot' : 'warm' })
        pairs.push({ label: tr('face.pending_reply', locale), value: String(open.length), tone: 'warm' })
      } else {
        pairs.push({ label: tr(card.type === 'email-group' ? 'face.mail_open' : 'face.open_count', locale), value: String(open.length), tone: card.waiting === 'you' && open.length ? 'hot' : 'cool' })
        const need = open.filter(l => l.needsYou).length
        if (need) pairs.push({ label: tr('face.need_you', locale), value: String(need), tone: 'hot' })
        if (handled) pairs.push({ label: tr('face.handled', locale), value: String(handled), tone: 'done' })
      }
      parts.push({ type: 'stats', pairs: pairs.slice(0, 3) })
    } else if (p === 'stage') {
      if (all.length >= 2) parts.push({ type: 'stage', done: handled, total: all.length, label: handled ? tr('face.stage_done', locale, { done: handled, total: all.length }) : tr('face.stage_none', locale, { n: all.length }) })
    } else if (p === 'checklist') {
      const rows = f.layout === 'meeting' ? pick(open, 4) : pick(open, 4)
      if (rows.length) parts.push({ type: 'checklist', items: rows.map(item), more: Math.max(0, open.length - rows.length) })
      else if (all.length) parts.push({ type: 'checklist', items: [], done: true, more: 0 })
    } else if (p === 'quote') {
      const q = (f.quote && all.find(l => l.url === f.quote)) || pick(open.filter(l => (l.text || l.title) && kindOf(l) === 'slack'), 1)[0] || open.find(l => l.text || (kindOf(l) === 'slack' && l.title)) || open.find(l => l.text)
      if (q) {
        const body = quoteBody(q.text || q.title || '')
        if (body.text || body.link) parts.push({ type: 'quote', text: body.text || '', link: body.link, from: fromOf(q) || null, at: tsOf(q), url: q.url })
      }
    } else if (p === 'timeline') {
      const rows = all.map(item).filter(x => x.at).sort((a, b) => a.at - b.at)
      const list = rows.length >= 2 ? rows.slice(-5) : pick(all, 4).map(item)
      if (list.length) parts.push({ type: 'timeline', items: list.map(x => ({ ...x, time: x.at ? shTime(x.at) : null })) })
    } else if (p === 'compare') {
      const two = pick(open, 2)
      if (two.length === 2) parts.push({ type: 'compare', items: two.map(item) })
    } else if (p === 'countdown') {
      const ev = (events || []).map(e => ({ ...e, s: Date.parse(e.start) })).filter(e => e.s > now).sort((a, b) => a.s - b.s)[0]
      if (ev) parts.push({ type: 'countdown', label: cut(ev.title, 30), at: ev.s, url: /^https:\/\//.test(ev.url || '') ? ev.url : null })
    } else if (p === 'cta') parts.push({ type: 'cta' })
  }
  const meaningful = parts.filter(x => x.type !== 'cta')
  if (!meaningful.length) return null
  const merged = (card.metadata?.mergedFrom || []).length && f.layout === 'timeline'
  const SRC = { gmail: tr('face.src_mail', locale), github: 'GitHub', slack: 'Slack' }
  const chans = merged ? [...new Set([card.source, ...card.metadata.mergedFrom].map(x => SRC[x] || x).filter(Boolean))] : []
  return { layout: f.layout, by: f.by || 'bot', note: f.note || (chans.length >= 2 ? tr('face.same_thing', locale, { chans: chans.join(' + ') }) : ''), parts }
}
