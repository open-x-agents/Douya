// Card / digest mutations. Under dsh, path params are not allowed on connection.fetch,
// so updates go through /api/opendigitalmate/card-* . Standalone server mirrors those.

const DEFAULT_MUSE = process.env.ODM_MUSE_URL || process.env.MUSE_URL || 'http://127.0.0.1:7777'

async function muse(path, { method = 'GET', body, baseUrl = DEFAULT_MUSE } = {}) {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(String(data?.error || data?.message || `HTTP ${res.status}`))
  return data
}

function summarize(card) {
  if (!card) return null
  return {
    id: card.id,
    title: card.title,
    body: (card.body || '').slice(0, 400),
    source: card.source,
    type: card.type,
    priority: card.priority,
    status: card.status,
    url: card.url || null,
    nextAction: card.nextAction || null,
    links: card.links || null,
    items: [...((card.blocks || []).find(b => b?.type === 'link-list')?.links || [])].filter(l => l?.url).slice(0, 12).map(l => ({ title: l.title, url: l.url, status: card.itemStatus?.[l.url]?.status || 'open', ...(l.from ? { from: l.from } : {}), ...(l.at ? { at: l.at } : {}), ...(l.text ? { text: String(l.text).slice(0, 300) } : {}), ...(l.replies ? { replies: l.replies } : {}), ...(l.needsYou ? { needsYou: true } : {}) })),
    snoozeUntil: card.snoozeUntil || null,
    completedAt: card.completedAt || null,
  }
}

// In-process transport: same dsh process as the bot, so call the api router directly
// (HTTP to our own port hits dsh's owner-auth fence and returns 401).
function routerTransport(router) {
  return async (path, { method = 'GET', body } = {}) => {
    let data
    if (path === '/api/cards' && method === 'GET') data = await router.listCards()
    else if (path === '/api/cards') data = await router.createCard(body)
    else if (path === '/api/opendigitalmate/card-update') data = await router.updateCard(body.id, body)
    else if (path === '/api/opendigitalmate/card-delete') data = await router.deleteCard(body.id)
    else if (path === '/api/digest/generate') data = await router.generateDigestNow()
    else if (path === '/api/completions') data = await router.listCompletions()
    else if (path === '/api/opendigitalmate/card-interact') data = await router.trackCardInteraction(body.id, body.action, body.itemUrl || null, body.itemTitle || '', 'bot')
    else throw new Error(`no in-process route for ${method} ${path}`)
    return data ?? {}
  }
}

export function createCardOps({ baseUrl = DEFAULT_MUSE, router = null } = {}) {
  const call = router ? routerTransport(router) : (path, o = {}) => muse(path, { ...o, baseUrl })
  return {
    baseUrl,
    async list({ status = 'active' } = {}) {
      const { cards = [] } = await call('/api/cards')
      const filtered = status === 'all' ? cards : cards.filter(c => (c.status || 'active') === status)
      return { count: filtered.length, cards: filtered.map(summarize) }
    },
    async get(id) {
      const { cards = [] } = await call('/api/cards')
      const card = cards.find(c => c.id === id)
      if (!card) throw new Error(`卡片不存在: ${id}`)
      return summarize(card)
    },
    async findByTitle(query) {
      const q = String(query || '').trim().toLowerCase()
      const { cards = [] } = await call('/api/cards')
      const hits = cards.filter(c => (c.status || 'active') === 'active').filter(c =>
        (c.title || '').toLowerCase().includes(q) || (c.body || '').toLowerCase().includes(q)
      )
      return { count: hits.length, cards: hits.map(summarize) }
    },
    async create(input) {
      const data = await call('/api/cards', {
        method: 'POST',
        body: {
          title: input.title,
          body: input.body || '',
          type: input.type || 'task',
          priority: input.priority || 'medium',
          url: input.url || null,
          source: input.source || 'bot',
          status: 'active',
          nextAction: input.nextAction || null,
        },
      })
      if (data.success === false) throw new Error(data.error || '创建失败')
      return { success: true, card: summarize(data.card) }
    },
    async update(id, updates) {
      const allowed = { id }
      for (const key of ['title', 'body', 'priority', 'status', 'url', 'type', 'nextAction', 'links', 'snoozeUntil', 'completedBy', 'dismissedBy']) {
        if (updates[key] !== undefined) allowed[key] = updates[key]
      }
      const data = await call('/api/opendigitalmate/card-update', { method: 'POST', body: allowed })
      if (data.success === false) throw new Error(data.error || '更新失败')
      return { success: true, card: summarize(data.card) }
    },
    async complete(id, { by = 'bot' } = {}) {
      return this.update(id, { status: 'done', completedBy: by })
    },
    async dismiss(id, { by = 'bot' } = {}) {
      return this.update(id, { status: 'dismissed', dismissedBy: by })
    },
    async snooze(id, { until, hours } = {}) {
      let snoozeUntil = until
      if (!snoozeUntil) {
        const h = Number(hours) > 0 ? Number(hours) : 24
        snoozeUntil = new Date(Date.now() + h * 3600_000).toISOString()
      }
      return this.update(id, { status: 'snoozed', snoozeUntil })
    },
    async remove(id) {
      const data = await call('/api/opendigitalmate/card-delete', { method: 'POST', body: { id } })
      if (data.success === false) throw new Error(data.error || '删除失败')
      return { success: true, deleted: id }
    },
    async refreshDigest() {
      const data = await call('/api/digest/generate', { method: 'POST', body: {} })
      if (data.success === false) throw new Error(data.error || '刷新失败')
      return { success: true, summary: data.summary || null, cardCount: data.totalCardCount ?? null }
    },
    async item(id, url, action = 'done', title = '') {
      const data = await call('/api/opendigitalmate/card-interact', { method: 'POST', body: { id, action, itemUrl: url, itemTitle: title } })
      if (data.success === false) throw new Error(data.error || '条目操作失败')
      return { success: true, item: data.item || null }
    },
    async listCompletions() {
      return call('/api/completions')
    },
  }
}
