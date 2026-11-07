/**
 * Memory 一瞥: surface achievements & high-signal recalls first;
 * demote routine prefs (timezone, UI language, …).
 */

const HIGH_TAGS = new Set(['achievement', 'milestone', 'win', 'decision', 'project'])
const MID_TAGS = new Set(['person', 'habit', 'fact'])
const ROUTINE_RE = /timezone|time\s*zone|\blocale\b|ui\s*language|interface\s*language|asia\/shanghai|\butc\s*[+-]?\s*\d|\bdark\s*mode\b|\bfont\s*size\b|\bdisplay\s*language\b/i

function tagList(m) {
  if (Array.isArray(m?.tags)) return m.tags.map(t => String(t).toLowerCase()).filter(Boolean)
  return String(m?.tags || '').split(/\s+/).map(t => t.toLowerCase()).filter(Boolean)
}

/** Routine chrome prefs that should not dominate the glimpse. */
export function isRoutinePreference(m) {
  const tags = tagList(m)
  const text = String(m?.text || '')
  if (!ROUTINE_RE.test(text)) return false
  // Tag-less or preference-tagged timezone/UI nits → everyday
  return !tags.length || tags.includes('preference') || tags.every(t => !HIGH_TAGS.has(t) && !MID_TAGS.has(t))
}

/** Higher = more worth showing up top. */
export function memorySignal(m) {
  const tags = tagList(m)
  let score = 0
  const routine = isRoutinePreference(m)
  // Pinned boost is for lasting important facts — not timezone/UI chrome.
  if (m?.pinned && !routine) score += 1000
  else if (m?.pinned) score += 20
  if (tags.some(t => HIGH_TAGS.has(t))) score += 120
  if (tags.some(t => MID_TAGS.has(t))) score += 40
  if (tags.includes('preference')) score += 10
  if (routine) score -= 80
  const updated = Number(m?.updatedAt ?? m?.updated_at ?? 0) || 0
  // Tiny recency nudge so ties break newest-first without drowning tag signal
  score += Math.min(9, Math.floor(updated / 1e12))
  return score
}

/** Highlights: achievements / decisions / pinned non-routine. Everyday: the rest. */
export function isMemoryHighlight(m) {
  if (isRoutinePreference(m)) return false
  const tags = tagList(m)
  if (tags.some(t => HIGH_TAGS.has(t))) return true
  if (m?.pinned) return true
  if (tags.some(t => MID_TAGS.has(t))) return true
  return false
}

/** Stable sort: signal desc, then updatedAt desc, then id desc. */
export function rankMemories(rows) {
  const list = Array.isArray(rows) ? [...rows] : []
  return list.sort((a, b) => {
    const ds = memorySignal(b) - memorySignal(a)
    if (ds) return ds
    const ta = Number(a?.updatedAt ?? a?.updated_at ?? 0) || 0
    const tb = Number(b?.updatedAt ?? b?.updated_at ?? 0) || 0
    if (tb !== ta) return tb - ta
    return (Number(b?.id) || 0) - (Number(a?.id) || 0)
  })
}

export function partitionMemories(rows) {
  const ranked = rankMemories(rows)
  const highlights = []
  const everyday = []
  for (const m of ranked) {
    if (isMemoryHighlight(m)) highlights.push(m)
    else everyday.push(m)
  }
  return { highlights, everyday, ranked }
}
