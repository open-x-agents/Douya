// Compact, always-fresh snapshot of the card open in a zoom chat. Built server-side from the store on every
// card-chat turn (the client's one-liner was title + summary only, so Chief went cloning repos to find out
// what the card was about). Kept small so it does not slow the model call.

const STATUS_ZH = { done: '已完成', dismissed: '已忽略' }
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
export function cardSnapshotText(card, itemStatus = {}, { maxItems = 12, textChars = 160, maxChars = 2600 } = {}) {
  if (!card) return ''
  const items = cardItems(card, itemStatus)
  const open = items.filter(i => i.status === 'open').length
  const lines = [
    `【当前卡片】id=${card.id} · 来源 ${card.source || '-'} · 类型 ${card.type || '-'}${card.status && card.status !== 'active' ? ` · 状态 ${card.status}` : ''}`,
    `标题：${cut(card.title, 120)}`,
  ]
  if (card.body) lines.push(`摘要：${cut(card.body, 300)}`)
  const nums = cardNumbers(card)
  if (nums.length) lines.push(`数字：${nums.join(' · ')}`)
  if (card.nextAction) lines.push(`下一步：${cut(card.nextAction, 120)}`)
  if (card.url) lines.push(`链接：${card.url}`)
  if (items.length) {
    lines.push(`相关条目（共 ${items.length} 条，${open} 条待处理${items.length > maxItems ? `，下面列前 ${maxItems} 条` : ''}）：`)
    items.slice(0, maxItems).forEach((it, i) => {
      const meta = [it.status === 'open' ? '待处理' : STATUS_ZH[it.status], it.from && `来自 ${cut(it.from, 40)}`, it.at && fmtSh(it.at), it.replies ? `${it.replies} 条回复` : ''].filter(Boolean).join(' · ')
      lines.push(`${i + 1}. ${cut(it.title, 150)} — ${meta}${it.url ? ` — ${it.url}` : ''}`)
      if (it.text && cut(it.text, textChars) !== cut(it.title, textChars)) lines.push(`   内容：${cut(it.text, textChars)}`)
    })
  }
  lines.push('（这是此刻卡片的完整快照；条目详情直接引用这里，需要全文用 odm_current_card。）')
  let text = lines.join('\n')
  if (text.length > maxChars) text = `${text.slice(0, maxChars - 20)}\n…（已截断）`
  return text
}

/** Full card for the odm_current_card tool (bounded). */
export function cardFull(card, itemStatus = {}) {
  if (!card) return null
  return {
    id: card.id, sourceId: card.sourceId, source: card.source, type: card.type, status: card.status || 'active',
    title: card.title, subtitle: card.subtitle || null, body: card.body || null, url: card.url || null,
    nextAction: card.nextAction || null, why: card.why || null, waiting: card.waiting || null,
    numbers: cardNumbers(card),
    actions: (card.actions || []).map(a => ({ label: a.label, url: a.value || a.url || null })),
    items: cardItems(card, itemStatus).slice(0, 60).map(i => ({ ...i, text: i.text ? String(i.text).slice(0, 1500) : null })),
    updatedAt: card.updatedAt || null,
  }
}
