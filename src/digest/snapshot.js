// Per-channel snapshot: the real items a source bot may cite. Bots see short refs (m1, g7 …), never invent URLs.
import { CHANNELS } from './channels.js'
import { classifyEmail } from '../web/email-groups.js'

const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s }
const shTime = iso => { const t = Date.parse(iso || ''); if (!t) return ''; const d = new Date(t + 8 * 3600e3); return `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}` }
const nameOf = from => { const s = String(from || ''); const m = s.match(/^"?([^"<]+?)"?\s*</); return (m ? m[1] : s.replace(/<.*>/, '')).replace(/^From:\s*/i, '').trim() || s }
const repoOf = it => it.metadata?.repository || (String(it.url || '').match(/github\.com\/([^/]+\/[^/]+)/) || [])[1] || (String(it.body || '').match(/in ([\w.-]+\/[\w.-]+)/) || [])[1] || ''
export const LIMITS = { gmail: 120, github: 200, slack: 90 }

function row(channel, it, ref) {
  const md = it.metadata || {}
  if (channel === 'gmail') return { ref, subject: clip(it.title, 90), from: clip(nameOf(md.from || it.body), 40), at: shTime(it.createdAt), labels: (md.labelIds || []).filter(l => /IMPORTANT|UNREAD|CATEGORY_/.test(l)).map(l => l.replace('CATEGORY_', '')), snippet: clip(md.snippet?.body || md.snippet, 110), rule: classifyEmail(it) }
  if (channel === 'github') return { ref, kind: it.type, repo: repoOf(it), title: clip(it.title, 90), state: md.merged_at ? 'merged' : md.state || '', labels: (md.labels || []).slice(0, 3), at: shTime(it.updatedAt || it.createdAt || it.timestamp) }
  if (channel === 'slack') return { ref, channel: md.isDm ? `DM ${md.channelName}` : `#${md.channelName}`, from: clip(md.user, 30), bot: md.isBot || undefined, text: clip(md.text || it.title, 160), replies: md.replyCount || undefined, at: shTime(it.timestamp) }
  return { ref, title: clip(it.title, 100), at: shTime(it.timestamp || it.createdAt) }
}

/**
 * @param {string} channel
 * @param {object[]} items normalized + deduped items of this channel
 * @param {object} itemStatus state.itemStatus (url -> {status})
 * @returns {{channel, rows, byRef: Map, byUrl: Map, items, all, skipped}} items = what the bot sees; all = every live item
 */
export function buildSnapshot(channel, items, itemStatus = {}) {
  const c = CHANNELS[channel]
  const done = url => ['done', 'dismissed'].includes(itemStatus?.[url]?.status)
  const live = [], skipped = []
  for (const it of items) { if (!it?.url) continue; (done(it.url) ? skipped : live).push(it) }
  live.sort((a, b) => String(b.createdAt || b.timestamp || '').localeCompare(String(a.createdAt || a.timestamp || '')))
  const kept = live.slice(0, LIMITS[channel] || 80)
  const byRef = new Map(), byUrl = new Map(), rows = []
  kept.forEach((it, i) => { const ref = `${c?.letter || 'x'}${i + 1}`; byRef.set(ref, it); rows.push(row(channel, it, ref)) })
  // Links are validated against every live item fetched this run (also the ones past the bot's view limit).
  for (const it of live) byUrl.set(it.url, it)
  return { channel, rows, byRef, byUrl, items: kept, all: live, skipped: skipped.length, truncated: live.length - kept.length }
}
