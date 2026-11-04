// Metrics for comparing a bot digest with the legacy pipeline on the same source data.
const CONTENT = c => !['hero', 'timetable', 'achievements'].includes(c.type) && !/^(hero|timetable|achievements):/.test(c.sourceId || '')
export function digestMetrics(cards, validUrls) {
  const content = cards.filter(CONTENT)
  const links = content.flatMap(c => (c.blocks || []).flatMap(b => (b.links || []).map(l => ({ card: c.sourceId, url: l?.url })))).filter(l => l.url)
  const seen = new Map()
  for (const l of links) seen.set(l.url, (seen.get(l.url) || 0) + 1)
  const dupUrls = [...seen.values()].filter(n => n > 1).length
  const ids = new Map(); for (const c of content) ids.set(c.sourceId, (ids.get(c.sourceId) || 0) + 1)
  return {
    cards: content.length,
    byType: content.reduce((a, c) => (a[c.type] = (a[c.type] || 0) + 1, a), {}),
    needsAction: content.filter(c => c.waiting === 'you' || c.metadata?.needsAction).length,
    singles: content.filter(c => c.type === 'email-action').length,
    links: links.length,
    invalidLinks: links.filter(l => !validUrls.has(l.url)).length,
    invalidSample: links.filter(l => !validUrls.has(l.url)).slice(0, 6),
    contentTypes: [...new Set(cards.map(c => c.type))],
    dupUrlsAcrossCards: dupUrls,
    dupSourceIds: [...ids.values()].filter(n => n > 1).length,
    crossChannelMerged: content.filter(c => (c.metadata?.mergedFrom || []).length).length,
  }
}
