// Fill a validated view spec with real data from the store. Every row, link and number shown in a temporary view
// comes from here: links are item / card URLs already in the store, numbers are counts of store rows, card titles
// are store titles. References that don't resolve are errors returned to Chief (with a path), never placeholders.
// The output is plain data the client renders with textContent; nothing in it is HTML.

import { cardItems } from '../web/card-snapshot.js'
import { needsYou, isActive, isWork, validateUiOp } from './ops.js'
import { LIMITS } from './catalog.js'

const STATUS_ZH = { open: '待处理', done: '已完成', dismissed: '已忽略' }
const TYPE_ZH = { pr: 'PR', issue: 'issue', email: '邮件', slack: 'Slack', other: '链接' }
const SOURCE_ZH = { github: 'GitHub', gmail: 'Gmail', slack: 'Slack', googlecalendar: '日历', manual: '手动', bot: '豆芽' }
const PRIO_ZH = { urgent: '紧急', high: '高', medium: '中', low: '低' }
const one = (v) => String(v ?? '').replace(/\s+/g, ' ').trim()
const cut = (v, n) => { const s = one(v); return s.length > n ? `${s.slice(0, n - 1)}…` : s }
const fmtSh = (iso) => { if (!iso) return ''; const d = new Date(iso); if (Number.isNaN(+d)) return ''; return d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) }
const dayOf = (iso) => { const d = new Date(iso); return Number.isNaN(+d) ? '' : new Date(+d + 8 * 3600e3).toISOString().slice(5, 10) }
export const SAFE_LINK = /^https:\/\/([a-z0-9-]+\.)*(github\.com|google\.com|slack\.com)(\/|$)/i
class RefError extends Error { constructor(path, msg) { super(msg); this.path = path } }
const fail = (path, msg) => { throw new RefError(path, msg) }

export function itemType(l) {
  const u = String(l?.url || '')
  if (/github\.com\/[^/]+\/[^/]+\/pull\//.test(u) || l?.type === 'pr') return 'pr'
  if (/github\.com\/[^/]+\/[^/]+\/issues\//.test(u) || l?.type === 'issue') return 'issue'
  if (/mail\.google\.com/.test(u) || l?.type === 'email') return 'email'
  if (/slack\.com/.test(u) || l?.type === 'slack') return 'slack'
  return 'other'
}
const gmailThread = (u) => (String(u || '').match(/mail\.google\.com\/mail\/u\/\d+\/#[a-z]+\/([A-Za-z0-9]+)/) || [])[1] || null

/** Every link the store knows (active cards' items + card urls). A view can only point at these. */
export function storeLinks(state) {
  const set = new Set()
  for (const c of (state?.cards || []).filter(isActive)) {
    if (typeof c.url === 'string' && c.url.startsWith('https://')) set.add(c.url)
    for (const it of cardItems(c, {})) if (it.url) set.add(it.url)
  }
  return set
}
function getCard(state, id, path) {
  const c = (state?.cards || []).find(x => x.id === id)
  if (!c) {
    const q = one(id).toLowerCase()
    const cands = (state?.cards || []).filter(isActive).filter(x => `${x.title} ${x.sourceId}`.toLowerCase().includes(q)).slice(0, 4).map(x => `${x.id}（${cut(x.title, 24)}）`)
    fail(path, `找不到卡片「${cut(id, 60)}」；card 必须是卡片 id${cands.length ? `，可能是：${cands.join('，')}` : '（见【当前视图】或 odm_ui_state）'}`)
  }
  if (!isActive(c)) fail(path, `卡片 ${id} 不在今天页上（${c.status}）`)
  return c
}

/** Resolve a source to rows: [{ key, url?, cardId, fields:{…display}, sort:{…raw} }]. */
export function resolveRows(src, state, path = 'source') {
  const st = state?.itemStatus || {}
  let cards
  if (src.card) cards = [getCard(state, src.card, `${path}.card`)]
  else if (src.cards === 'needs-you') cards = (state.cards || []).filter(c => isActive(c) && needsYou(c, st))
  else if (src.cards === 'all') cards = (state.cards || []).filter(c => isActive(c) && isWork(c))
  else cards = src.cards.map((id, i) => getCard(state, id, `${path}.cards[${i}]`))
  if (src.where?.source) cards = cards.filter(c => c.source === src.where.source)
  const rows = []
  if (src.rows === 'cards') {
    for (const c of cards) {
      const items = cardItems(c, st)
      const open = items.filter(i => i.status === 'open').length
      const ny = needsYou(c, st)
      rows.push({
        key: c.id, cardId: c.id, url: typeof c.url === 'string' && c.url.startsWith('https://') ? c.url : (items.find(i => i.url)?.url || null),
        fields: { title: cut(c.title, 120), source: SOURCE_ZH[c.source] || c.source || '', type: c.type || '', priority: PRIO_ZH[c.priority] || c.priority || '', needsYou: ny ? '是' : '否', next: cut(c.nextAction, 120), openItems: String(open), items: String(items.length) },
        sort: { priority: { urgent: 4, high: 3, medium: 2, low: 1 }[c.priority] || 0, openItems: open, items: items.length, needsYou: ny ? 1 : 0 },
      })
    }
  } else {
    const want = src.where?.status || 'all'
    for (const c of cards) {
      for (const it of cardItems(c, st)) {
        if (want !== 'all' && it.status !== want) continue
        const t = itemType(it)
        if (src.where?.type && t !== src.where.type) continue
        rows.push({
          key: it.url || `${c.id}:${it.title}`, cardId: c.id, url: it.url, from: it.from || null, threadId: t === 'email' ? gmailThread(it.url) : null,
          fields: { title: cut(it.title, 160), from: cut(it.from, 60), at: fmtSh(it.at), status: STATUS_ZH[it.status], type: TYPE_ZH[t], replies: it.replies ? String(it.replies) : '', text: cut(it.text, 200), cardTitle: cut(c.title, 60), source: SOURCE_ZH[c.source] || c.source || '' },
          sort: { at: it.at ? Date.parse(it.at) || 0 : 0, replies: it.replies || 0 },
          group: { status: STATUS_ZH[it.status], from: cut(it.from, 30) || '（未知）', type: TYPE_ZH[t], source: SOURCE_ZH[c.source] || c.source, cardTitle: cut(c.title, 30), day: dayOf(it.at) || '（无日期）', priority: PRIO_ZH[c.priority] || '—' },
        })
      }
    }
  }
  return rows.slice(0, src.limit || LIMITS.rows)
}

function resolveDo(d, state, links, path, row = null) {
  if (d.openLink) {
    const url = d.openLink === '$row.url' ? row?.url : d.openLink
    if (!url) fail(path, '这一行没有链接')
    if (!links.has(url) || !SAFE_LINK.test(url)) fail(`${path}.openLink`, '链接必须是卡片里已有的条目链接（不能自己写 URL）')
    return { openLink: url }
  }
  if (d.openCard) { const id = d.openCard === '$row.cardId' ? row?.cardId : d.openCard; getCard(state, id, `${path}.openCard`); return { openCard: id } }
  if (d.prompt) return { prompt: row ? d.prompt.replace(/(?:\{\{|\[\[)\s*(\w+)\s*(?:\}\}|\]\])/g, (_, k) => row.fields?.[k] ?? '') : d.prompt }
  if (d.uiOp) { const v = validateUiOp(d.uiOp, state); if (!v.ok) fail(`${path}.uiOp`, v.error); return { uiOp: d.uiOp } }
  fail(path, '不支持的按钮动作')
}
const dataVal = (v, dm) => (v && typeof v === 'object' && '$data' in v ? (dm[v.$data] ?? '') : v)

/** Hydrate a stored surface → client view. Throws RefError on a bad reference (caught by hydrateSurface). */
function hydrateComponents(spec, state) {
  const links = storeLinks(state)
  const dm = spec.dataModel || {}
  const refs = new Map()
  const ref = (cardId) => { const c = (state.cards || []).find(x => x.id === cardId); if (c) refs.set(c.id, cut(c.title, 40)) }
  const out = {}
  for (const [id, c] of Object.entries(spec.components)) {
    const p = `components.${id}`
    const h = { type: c.type }
    if (c.title) h.title = c.title
    if (c.children) h.children = c.children
    if (c.text !== undefined) h.text = String(dataVal(c.text, dm) ?? '')
    if (c.tone) h.tone = c.tone
    if (c.source) {
      const rows = resolveRows(c.source, state, `${p}.source`)
      rows.forEach(r => ref(r.cardId))
      if (c.annotations) for (const k of Object.keys(c.annotations)) if (!rows.some(r => r.key === k)) fail(`${p}.annotations`, `「${cut(k, 60)}」不是这个 source 里的行（用条目 url 或卡片 id）`)
      const note = (r) => c.annotations?.[r.key] || ''
      if (c.type === 'Table' || c.type === 'List' || c.type === 'Comparison') {
        const cols = (c.columns || c.fields || [])
        h.columns = cols.map(f => ({ key: f.key, label: f.label }))
        h.rows = rows.map(r => ({
          key: r.key, cardId: r.cardId, url: r.url && links.has(r.url) && SAFE_LINK.test(r.url) ? r.url : null,
          title: r.fields.title, cells: Object.fromEntries(cols.map(f => [f.key, f.key === 'note' ? note(r) : (r.fields[f.key] ?? '')])),
          sort: Object.fromEntries(cols.map(f => [f.key, r.sort?.[f.key] ?? (f.key === 'note' ? note(r) : (r.fields[f.key] ?? ''))])),
          actions: (c.rowActions || []).map((b, i) => ({ label: b.label, do: resolveDo(b.do, state, links, `${p}.rowActions[${i}].do`, r) })),
        }))
        if (c.sortable) h.sortable = true
        h.total = rows.length
      } else if (c.type === 'Timeline') {
        h.rows = rows.filter(r => r.sort?.at).sort((a, b) => a.sort.at - b.sort.at).map(r => ({ key: r.key, at: r.fields.at, title: r.fields.title, from: r.fields.from, url: r.url && links.has(r.url) ? r.url : null, cardId: r.cardId }))
        h.undated = rows.length - h.rows.length
      } else if (c.type === 'Chart') {
        const counts = new Map()
        for (const r of rows) { const g = (r.group || { status: r.fields.needsYou, source: r.fields.source, priority: r.fields.priority })[c.groupBy] || '—'; counts.set(g, (counts.get(g) || 0) + 1) }
        let data = [...counts].map(([label, value]) => ({ label, value }))
        data = c.groupBy === 'day' ? data.sort((a, b) => a.label.localeCompare(b.label)) : data.sort((a, b) => b.value - a.value)
        h.kind = c.kind; h.groupBy = c.groupBy; h.data = data.slice(0, 24); h.total = rows.length
      }
    }
    if (c.type === 'KeyValue') {
      h.pairs = c.pairs.map((pr, i) => {
        const v = pr.value
        if (v && typeof v === 'object' && v.$count) { const rows = resolveRows(v.$count, state, `${p}.pairs[${i}].value.$count`); rows.forEach(r => ref(r.cardId)); return { label: pr.label, value: String(rows.length), counted: true } }
        if (v && typeof v === 'object' && v.$card) {
          const card = getCard(state, v.$card.card, `${p}.pairs[${i}].value.$card.card`); ref(card.id)
          const map = { title: card.title, next: card.nextAction, priority: PRIO_ZH[card.priority] || card.priority, source: SOURCE_ZH[card.source] || card.source, status: card.status || 'active' }
          return { label: pr.label, value: cut(map[v.$card.field], 200) }
        }
        return { label: pr.label, value: String(dataVal(v, dm) ?? '') }
      })
    }
    if (c.type === 'Buttons') h.buttons = c.buttons.map((b, i) => ({ label: b.label, do: resolveDo(b.do, state, links, `${p}.buttons[${i}].do`) }))
    if (c.type === 'Form') {
      h.fields = c.fields.map(f => ({ ...f, value: dataVal(f.value, dm) ?? (f.kind === 'checkbox' ? false : '') }))
      const d = c.submit.do
      if (d.draft) {
        // Check item references now so a broken form never reaches the user; args stay server-side.
        for (const [k, v] of Object.entries(d.draft.args)) {
          if (v && typeof v === 'object' && v.$item) { getCard(state, v.$item.card, `${p}.submit.do.draft.args.${k}.$item.card`); if (!links.has(v.$item.item)) fail(`${p}.submit.do.draft.args.${k}.$item.item`, '不是这张卡里的条目链接'); ref(v.$item.card) }
          if (typeof v === 'string' && /https?:\/\//.test(v)) for (const u of v.match(/https?:\/\/\S+/g)) if (!links.has(u)) fail(`${p}.submit.do.draft.args.${k}`, '参数里的链接必须是卡片里已有的条目链接')
        }
      }
      h.submit = { label: c.submit.label, kind: d.draft ? 'draft' : 'prompt' }
    }
    out[id] = h
  }
  return { components: out, refs: [...refs].map(([id, title]) => ({ id, title })) }
}

/** { ok, view } | { ok:false, error, path } */
export function hydrateSurface(surface, state, { now = Date.now() } = {}) {
  try {
    const { components, refs } = hydrateComponents(surface.spec, state)
    return {
      ok: true,
      view: {
        id: surface.id, title: surface.spec.title, placement: surface.spec.placement, root: surface.spec.root, components,
        dataModel: surface.spec.dataModel || {}, refs, createdAt: surface.createdAt, updatedAt: surface.updatedAt || surface.createdAt,
        expiresAt: surface.expiresAt || null, expired: !!(surface.expiresAt && Date.parse(surface.expiresAt) < now), savedCardId: surface.savedCardId || null,
        generatedBy: '豆芽生成',
      },
    }
  } catch (e) {
    if (e instanceof RefError) return { ok: false, error: e.message, path: e.path }
    throw e
  }
}

/** Resolve a form submission's args with the user's values (server-side; the client never sees args). */
export function resolveSubmitArgs(args, values, state) {
  const links = storeLinks(state)
  const out = {}
  for (const [k, v] of Object.entries(args || {})) {
    if (typeof v === 'string') out[k] = v.replace(/(?:\{\{|\[\[)\s*([\w-]+)\s*(?:\}\}|\]\])/g, (_, f) => String(values[f] ?? ''))
    else if (v && typeof v === 'object' && v.$field) out[k] = values[v.$field] ?? ''
    else if (v && typeof v === 'object' && v.$item) {
      if (!links.has(v.$item.item)) throw new Error('条目已不在卡片里')
      const c = (state.cards || []).find(x => x.id === v.$item.card)
      const it = cardItems(c, {}).find(i => i.url === v.$item.item)
      if (!it) throw new Error('条目已不在卡片里')
      out[k] = v.field === 'from' ? (String(it.from || '').match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0] || it.from || '') : v.field === 'threadId' ? gmailThread(it.url) : v.field === 'title' ? it.title : it.url
    } else out[k] = v
  }
  return out
}
