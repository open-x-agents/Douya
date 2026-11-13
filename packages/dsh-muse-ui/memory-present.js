/**
 * Recall presentation helpers for Muse memory tiles. Pure, no DOM, browser-safe:
 * the Muse plugin serves this same file to the page (MUSE_MEMORY_PRESENT_PATH), so there is one copy.
 */

/**
 * Turn a stored memory (markdown, machine markers, URIs) into plain sentences a person reads.
 * Keeps a leading `# heading` line so presentMemoryText can use it as the title.
 */
export function humanizeMemoryText(raw) {
  let s = String(raw || '').replace(/\r\n/g, '\n')
  s = s.replace(/^---\n[\s\S]*?\n---\n?/, '') // YAML front matter
  s = s.replace(/<!--[\s\S]*?-->/g, '') // MEMORY_FIELDS and other machine comments
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, '') // image links (shown as pictures, not text)
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // [label](url) → label
  s = s.replace(/\bviking:\/\/\S+/g, '') // raw OpenViking URIs
  s = s.replace(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){2,}\b:?\s*/g, '') // MARKER_TOKENS_LIKE_THIS:
  const out = []
  let first = true
  let lead = '' // a sub-heading leads into the next sentence: "Boundaries: Private things stay private."
  for (let line of s.split('\n')) {
    line = line.trim()
    if (!line || /^(-{3,}|\*{3,}|_{3,})$/.test(line)) continue
    const h = line.match(/^#{1,6}\s+(.+)$/)
    if (h) {
      // "soul.md - Who You Are" → "Who You Are"
      const head = plain(h[1]).replace(/^[\w.-]+\.md\s*[-–—:]\s*/i, '').trim()
      if (head && first) out.push(`# ${head}`)
      else if (head) { if (lead) out.push(sentence(lead)); lead = head.replace(/[:：]$/, '') }
      first = false
      continue
    }
    first = false
    line = line.replace(/^([-*•+]|\d+[.)])\s+/, '')
    line = plain(line)
    if (/^[^:：]{1,24}[:：]\s*$/.test(line)) continue // "Name:" with nothing after it
    if (line) { out.push(sentence(lead ? `${lead}: ${line}` : line)); lead = '' }
  }
  if (lead) out.push(sentence(lead))
  return out.join('\n').trim()
}

function plain(s) {
  return String(s || '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/__([^_]*)__/g, '$1')
    .replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|$|[.,;:!?。！？])/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim()
}

function sentence(s) {
  const t = String(s || '').trim()
  if (!t) return ''
  return /[.!?。！？…:：]$/.test(t) ? t : (/[\u4e00-\u9fff]$/.test(t) ? t + '。' : t + '.')
}

/** Short, plain-sentence title / summary / full body for one memory row. */
export function presentMemory(m, opts) {
  const p = presentMemoryText(humanizeMemoryText(m && m.text), opts)
  p.title = p.title.replace(/(?<![.。])[.。]$/, '')
  if (!p.title) {
    const name = String((m && (m.uri || m.id)) || '').split('/').pop().replace(/\.md$/i, '').replace(/[-_]+/g, ' ').trim()
    p.title = name ? name[0].toUpperCase() + name.slice(1) : '…'
  }
  return p
}

/**
 * Split a raw memory blob into title / summary / body for Muse Glimpse tiles.
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

/** Source cue label key fragment: mcp | local | unknown */
export function memorySourceKey(m) {
  const src = String(m?.source || '').toLowerCase()
  if (src === 'mcp-memory' || src === 'mcp' || src === 'memory') return 'mcp'
  if (src === 'openviking' || String(m?.uri || m?.id || '').startsWith('viking://')) return 'mcp'
  if (src === 'dsh-memory' || src === 'sqlite' || src === 'local') return 'local'
  if (typeof m?.id === 'number' || /^\d+$/.test(String(m?.id || ''))) return 'local'
  return 'unknown'
}

/**
 * Decide what Recall should show for a listMemories payload.
 * An unreachable service (available:false, no fallback rows) is not an empty library.
 * Fallback rows (e.g. SQLite if the MCP Memory file is unreadable) still render as a ready list.
 */
export function presentMemoryList(data) {
  const memories = Array.isArray(data?.memories) ? data.memories : []
  const hasTotal = data != null && data.total != null
  const total = hasTotal ? Number(data.total) || 0 : memories.length
  const error = String(data?.error || data?.openviking?.error || '')
  const available = data?.available

  if (memories.length) {
    return {
      state: 'ready',
      memories,
      total: hasTotal ? total : memories.length,
      error: available === false ? error : '',
    }
  }
  if (available === false) {
    return { state: 'unavailable', memories: [], total: 0, error }
  }
  return { state: 'empty', memories: [], total, error: '' }
}
