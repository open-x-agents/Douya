// Compact, always-fresh snapshot of the card open in a zoom chat. Built server-side from the store on every
// card-chat turn (the client's one-liner was title + summary only, so Chief went cloning repos to find out
// what the card was about). Kept small so it does not slow the model call.

const STATUS_ZH = { done: '已完成', dismissed: '已忽略', commented: '已评论' }
const one = (v) => String(v ?? '').replace(/\s+/g, ' ').trim()
const cut = (v, n) => { const s = one(v); return s.length > n ? `${s.slice(0, n - 1)}…` : s }
const fmtSh = (iso) => {
  if (!iso) return ''
  try { return new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) } catch { return '' }
}

export function cardItems(card, itemStatus = {}) {
  const out = []
  for (const b of card?.blocks || []) {
    if (b?.type !== 'link-list' || !Array.isArray(b.links)) continue
    for (const l of b.links) {
      if (!l?.url && !l?.title) continue
      const st = itemStatus?.[l.url]?.status
      out.push({
        title: one(l.title), url: l.url || null, type: l.type || null,
        status: st === 'done' || st === 'dismissed' ? st : 'open',
        from: l.from || null, at: l.at || null, replies: l.replies || 0,
        text: l.text ? String(l.text) : null,
      })
    }
  }
  return out
}

export function cardNumbers(card) {
  const nums = []
  for (const b of card?.blocks || []) {
    if (b?.type === 'stat-row') for (const s of b.stats || []) if (s?.label != null && s?.value != null) nums.push(`${s.label} ${s.value}`)
    if (b?.type === 'tags') for (const t of b.tags || []) if (t?.text) nums.push(t.text)
  }
  return [...new Set(nums)]
}

/** Text block prepended to the user's message in a card chat. */
const ACTION_ZH = { pending: '待用户确认（还没执行）', executed: '已执行', cancelled: '已取消', undone: '已撤销', failed: '执行失败', running: '执行中' }
/** Write actions on this card (by cardId, or naming its repo) in the last 24h, newest first. */
export function relatedActions(card, actions = {}, { max = 5, sinceMs = 24 * 3600e3 } = {}) {
  const repo = String(card?.url || '').match(/github\.com\/([^/]+\/[^/?#]+)/)?.[1]
  const now = Date.now()
  return Object.values(actions || {})
    .filter(a => a && (a.cardId === card.id || (repo && String(a.summary || '').includes(repo))))
    .filter(a => now - Date.parse(a.createdAt || 0) < sinceMs)
    .sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt)))
    .slice(0, max)
}

const prNumOf = (url, title = '', summary = '') => {
  const fromUrl = (String(url || '').match(/\/(?:pull|issues)\/(\d+)/) || [])[1]
  if (fromUrl) return fromUrl
  const t = `${title || ''} ${summary || ''}`
  return (t.match(/\b(?:PR|Issue) #(\d+)\b/i) || t.match(/\(PR #(\d+)\)/) || [])[1] || null
}

function collectHandles(card, actions = {}, kinds, sinceMs = 48 * 3600e3) {
  const out = new Set()
  for (const a of relatedActions(card, actions, { max: 40, sinceMs })) {
    if (!a || a.status !== 'executed' || a.undoneAt) continue
    if (!kinds.test(a.action || '')) continue
    const url = a.input?.url
    const n = a.input?.number != null && a.input.number !== '' ? String(a.input.number) : prNumOf(url, a.summary)
    if (url) out.add(url)
    if (n) out.add(String(n))
  }
  return out
}

const isReviewRequest = (it) => /pr-review|pr-assigned/.test(String(it?.type || ''))
const isPending = (it) => it && (it.status === 'open' || (it.status === 'commented' && isReviewRequest(it)))

/** Mark executed review/merge/close as done; a comment alone is 已评论 and does not complete a still-requested review. */
export function decorateCardItems(items = [], card, itemStatus = {}, actions = {}) {
  const completed = collectHandles(card, actions, /^(github_review|github_merge|github_close_issue)$/)
  const commented = collectHandles(card, actions, /^github_comment$/)
  const decorated = items.map((it) => {
    const n = prNumOf(it.url, it.title)
    const canonical = n && card ? [...(card.blocks || []).flatMap(b => b?.type === 'link-list' ? (b.links || []) : [])].find(l => prNumOf(l.url) === n && /\/pull\/|\/issues\//.test(l.url || '')) : null
    const closed = (s) => s === 'done' || s === 'dismissed'
    const st = closed(it.status)
      ? it.status
      : closed(itemStatus?.[it.url]?.status)
        ? itemStatus[it.url].status
        : (canonical && closed(itemStatus?.[canonical.url]?.status))
          ? itemStatus[canonical.url].status
          : (completed.has(it.url) || (n && completed.has(n)) ? 'done'
            : (commented.has(it.url) || (n && commented.has(n)) ? 'commented' : 'open'))
    return st === it.status ? it : { ...it, status: st }
  })
  const rank = (it) => {
    if (it.status === 'done' || it.status === 'dismissed') return 4
    if (it.status === 'commented' && !isReviewRequest(it)) return 3
    if (it.status === 'commented' && isReviewRequest(it)) return 1
    const typ = String(it.type || '')
    if (/pr-review|pr-assigned/.test(typ)) return 0
    if (/\/pull\//.test(String(it.url || '')) || /\bpr/i.test(typ)) return 0
    return 2
  }
  return [...decorated].sort((a, b) => rank(a) - rank(b))
}

/** Same decorated, ranked item list used by the snapshot text and odm_current_card. */
export function liveCardItems(card, itemStatus = {}, actions = {}) {
  return decorateCardItems(cardItems(card, itemStatus), card, itemStatus, actions)
}

function cardLinkLine(card, items = []) {
  const u = card?.url
  if (!u) return null
  if (!/github\.com\/[^/]+\/[^/]+\/(pull|issues)\/\d+/.test(u)) return u
  const n = prNumOf(u)
  const it = items.find(i => i.url === u || prNumOf(i.url, i.title) === n)
  if (isPending(it)) return u
  const repo = (u.match(/github\.com\/([^/]+\/[^/]+)/) || [])[1]
  return repo ? `https://github.com/${repo}` : u
}

export function cardSnapshotText(card, itemStatus = {}, { maxItems = 12, textChars = 160, maxChars = 2600, actions = {} } = {}) {
  if (!card) return ''
  const items = liveCardItems(card, itemStatus, actions)
  const open = items.filter(i => i.status === 'open' || i.status === 'commented').length
  const lines = [
    `【当前卡片】id=${card.id} · 来源 ${card.source || '-'} · 类型 ${card.type || '-'}${card.status && card.status !== 'active' ? ` · 状态 ${card.status}` : ''}`,
    `标题：${cut(card.title, 120)}`,
  ]
  if (card.body) lines.push(`摘要：${cut(card.body, 300)}`)
  const nums = cardNumbers(card)
  if (nums.length) lines.push(`数字：${nums.join(' · ')}`)
  if (card.nextAction) lines.push(`下一步：${cut(card.nextAction, 120)}`)
  const link = cardLinkLine(card, items)
  if (link) lines.push(`链接：${link}`)
  if (items.length) {
    lines.push(`相关条目（共 ${items.length} 条，${open} 条待处理${items.length > maxItems ? `，下面列前 ${maxItems} 条` : ''}）：`)
    items.slice(0, maxItems).forEach((it, i) => {
      const meta = [it.status === 'open' ? '待处理' : STATUS_ZH[it.status], it.from && `来自 ${cut(it.from, 40)}`, it.at && fmtSh(it.at), it.replies ? `${it.replies} 条回复` : ''].filter(Boolean).join(' · ')
      lines.push(`${i + 1}. ${cut(it.title, 150)} — ${meta}${it.url ? ` — ${it.url}` : ''}`)
      if (it.text && cut(it.text, textChars) !== cut(it.title, textChars)) lines.push(`   内容：${cut(it.text, textChars)}`)
    })
  }
  const acts = relatedActions(card, actions)
  if (acts.length) {
    lines.push('与这张卡相关的操作（以此为准）：')
    for (const a of acts) lines.push(`- ${cut(a.summary || a.action, 90)} — ${ACTION_ZH[a.status] || a.status}${a.executedAt ? `（${fmtSh(a.executedAt)}）` : ''}${a.status === 'executed' && !a.undoneAt ? '——用户已确认、已经发出/做完；别再说它还没发或待确认' : a.status === 'pending' && a.error ? `——上次执行失败：${cut(a.error, 80)}，仍待用户重新确认` : ''}`)
  }
  lines.push('（这是此刻卡片的完整快照；条目详情直接引用这里，需要全文用 odm_current_card。）')
  let text = lines.join('\n')
  if (text.length > maxChars) text = `${text.slice(0, maxChars - 20)}\n…（已截断）`
  return text
}

/** Full card for the odm_current_card tool (bounded). */
export function cardFull(card, itemStatus = {}, actions = {}) {
  if (!card) return null
  return {
    id: card.id, sourceId: card.sourceId, source: card.source, type: card.type, status: card.status || 'active',
    title: card.title, subtitle: card.subtitle || null, body: card.body || null, url: card.url || null,
    nextAction: card.nextAction || null, why: card.why || null, waiting: card.waiting || null,
    numbers: cardNumbers(card),
    actions: (card.actions || []).map(a => ({ label: a.label, url: a.value || a.url || null })),
    items: liveCardItems(card, itemStatus, actions).slice(0, 60).map(i => ({ ...i, text: i.text ? String(i.text).slice(0, 1500) : null })),
    updatedAt: card.updatedAt || null,
  }
}
