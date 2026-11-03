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
    snoozeUntil: card.snoozeUntil || null,
    completedAt: card.completedAt || null,
  }
}

export function createCardOps({ baseUrl = DEFAULT_MUSE } = {}) {
  return {
    baseUrl,
    async list({ status = 'active' } = {}) {
      const { cards = [] } = await muse('/api/cards', { baseUrl })
      const filtered = status === 'all' ? cards : cards.filter(c => (c.status || 'active') === status)
      return { count: filtered.length, cards: filtered.map(summarize) }
    },
    async get(id) {
      const { cards = [] } = await muse('/api/cards', { baseUrl })
      const card = cards.find(c => c.id === id)
      if (!card) throw new Error(`卡片不存在: ${id}`)
      return summarize(card)
    },
    async findByTitle(query) {
      const q = String(query || '').trim().toLowerCase()
      const { cards = [] } = await muse('/api/cards', { baseUrl })
      const hits = cards.filter(c => (c.status || 'active') === 'active').filter(c =>
        (c.title || '').toLowerCase().includes(q) || (c.body || '').toLowerCase().includes(q)
      )
      return { count: hits.length, cards: hits.map(summarize) }
    },
    async create(input) {
      const data = await muse('/api/cards', {
        method: 'POST', baseUrl,
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
      const data = await muse('/api/opendigitalmate/card-update', { method: 'POST', baseUrl, body: allowed })
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
      const data = await muse('/api/opendigitalmate/card-delete', { method: 'POST', baseUrl, body: { id } })
      if (data.success === false) throw new Error(data.error || '删除失败')
      return { success: true, deleted: id }
    },
    async refreshDigest() {
      const data = await muse('/api/digest/generate', { method: 'POST', baseUrl, body: {} })
      if (data.success === false) throw new Error(data.error || '刷新失败')
      return { success: true, summary: data.summary || null, cardCount: data.totalCardCount ?? null }
    },
    async listCompletions() {
      return muse('/api/completions', { baseUrl })
    },
  }
}
