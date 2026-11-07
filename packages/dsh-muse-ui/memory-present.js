/**
 * Split a raw memory blob into title / summary / body for Muse Glimpse tiles.
 * Pure, no DOM — kept tiny so the static index.html can mirror the same rules.
 */
export function presentMemoryText(raw, { titleMax = 72, summaryMax = 140 } = {}) {
  const text = String(raw || '').replace(/\r\n/g, '\n').trim()
  if (!text) return { title: '', summary: '', body: '', long: false }

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  let title = ''
  let restLines = lines

  const heading = lines[0] && lines[0].match(/^#{1,3}\s+(.+)$/)
  if (heading) {
    title = cleanTitle(heading[1], titleMax)
    restLines = lines.slice(1)
  } else if (lines[0] && lines[0].length <= titleMax && (lines.length > 1 || lines[0].length <= 48)) {
    title = cleanTitle(lines[0], titleMax)
    restLines = lines.slice(1)
  } else {
    // Single long paragraph: first sentence / clause as title, remainder as summary.
    const cut = firstClause(text, titleMax)
    title = cut.title
    const leftover = cut.rest
    restLines = leftover ? [leftover] : []
  }

  const rest = restLines.join(' ').replace(/\s+/g, ' ').trim()
  const summary = clamp(rest, summaryMax)
  const long = rest.length > summaryMax || text.length > titleMax + summaryMax
  return { title, summary, body: rest, long }
}

function cleanTitle(s, max) {
  return clamp(String(s || '').replace(/^[-*•]\s+/, '').replace(/\s+/g, ' ').trim(), max)
}

function clamp(s, max) {
  const t = String(s || '')
  if (t.length <= max) return t
  const slice = t.slice(0, max - 1)
  const soft = slice.replace(/\s+\S*$/, '')
  const base = soft.length >= Math.floor(max * 0.55) ? soft : slice
  return base.replace(/[,\s;:.\-—–]+$/, '') + '…'
}

function firstClause(text, max) {
  const t = String(text || '').replace(/\s+/g, ' ').trim()
  if (t.length <= max) return { title: t, rest: '' }
  const window = t.slice(0, max + 24)
  const m = window.match(/^(.+?[.!?。！？；;])\s+(.+)$/)
  if (m && m[1].length >= 12 && m[1].length <= max) {
    return { title: m[1].replace(/[.!?。！？；;]+$/, ''), rest: m[2] }
  }
  const soft = t.slice(0, max).replace(/\s+\S*$/, '')
  const title = (soft.length >= Math.floor(max * 0.55) ? soft : t.slice(0, max)).replace(/[,\s;:.\-—–]+$/, '')
  const rest = t.slice(title.length).trim()
  return { title: title + (rest ? '…' : ''), rest }
}

/** Kind used for accent / achievement wash. */
export function memoryLeadKind(tags) {
  const list = Array.isArray(tags) ? tags : String(tags || '').split(/\s+/).filter(Boolean)
  const t0 = String(list[0] || '').toLowerCase()
  return t0 || 'default'
}

export function isAchievementKind(kind) {
  const k = String(kind || '').toLowerCase()
  return k === 'achievement' || k === 'milestone' || k === 'win'
}

/** Source cue label key fragment: openviking | local | unknown */
export function memorySourceKey(m) {
  const src = String(m?.source || '').toLowerCase()
  if (src === 'openviking' || String(m?.uri || m?.id || '').startsWith('viking://')) return 'openviking'
  if (src === 'dsh-memory' || src === 'sqlite' || src === 'local') return 'local'
  if (typeof m?.id === 'number' || /^\d+$/.test(String(m?.id || ''))) return 'local'
  return 'unknown'
}
