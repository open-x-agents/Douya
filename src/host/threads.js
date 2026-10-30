// Which conversation a message belongs to, when the conversations are spread over days.
// People come back to a topic a week later — "上次说的那个日报，再加一项" — and a Bot that
// treats every message as a fresh subject asks the same questions again. A thread is a
// small record with keywords and a last-heard time; matching is keyword overlap weighted
// by how long ago the thread was last touched.

export const DEFAULT_THRESHOLD = 0.22
export const DEFAULT_HALF_LIFE_HOURS = 72
export const MAX_THREADS = 50
const HOUR = 3_600_000

// Chinese has no spaces, so words are not the unit: single characters are matched as
// pairs (bigrams), Latin runs as words. "周会" over "会" keeps a generic character from
// linking two unrelated topics.
export function tokens(text) {
  const lowered = String(text ?? '').toLowerCase()
  const words = lowered.match(/[a-z0-9_]{2,}/g) ?? []
  const han = lowered.match(/[\u4e00-\u9fa5]/g) ?? []
  const grams = []
  for (let index = 0; index + 1 < han.length; index += 1) grams.push(han[index] + han[index + 1])
  return new Set([...words, ...grams])
}

export function overlap(left, right) {
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const token of left) if (right.has(token)) shared += 1
  return shared / Math.min(left.size, right.size)
}

export function decay(ageHours, halfLifeHours = DEFAULT_HALF_LIFE_HOURS) {
  if (!Number.isFinite(ageHours) || ageHours <= 0) return 1
  return Math.pow(0.5, ageHours / halfLifeHours)
}

export function threadTokens(thread) {
  return tokens([thread?.title, ...(thread?.keywords ?? [])].join(' '))
}

export function scoreThread(text, thread, { now = Date.now(), halfLifeHours = DEFAULT_HALF_LIFE_HOURS } = {}) {
  if (thread?.closed === true) return 0
  const updated = Date.parse(String(thread?.updatedAt ?? ''))
  if (!Number.isFinite(updated)) return 0
  const ageHours = Math.max(0, (now - updated) / HOUR)
  return overlap(tokens(text), threadTokens(thread)) * decay(ageHours, halfLifeHours)
}

// The best thread above the threshold, or nothing: a new topic must be able to start a new
// thread, or every message would drift into whichever thread scored highest.
export function matchThread(text, threads, options = {}) {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD
  let best = null
  for (const thread of Array.isArray(threads) ? threads : []) {
    const score = scoreThread(text, thread, options)
    if (score > threshold && (best === null || score > best.score)) best = { thread, score }
  }
  return best
}

export function titleOf(text) {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim()
  return one.length <= 24 ? one : `${one.slice(0, 24)}…`
}

// Every stored moment is one shape, so two records written by different callers still sort
// and compare.
export function moment(at) {
  const parsed = Date.parse(String(at ?? ''))
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : String(at ?? '')
}

export function openThread({ id, text, at, chatId }) {
  return {
    id,
    title: titleOf(text),
    keywords: [...tokens(text)].slice(0, 12),
    chatId: chatId ?? '',
    openedAt: moment(at),
    updatedAt: moment(at),
    messages: 0,
    closed: false,
  }
}

export function touchThread(thread, { text, at }) {
  const merged = new Set([...(thread.keywords ?? []), ...tokens(text)])
  return {
    ...thread,
    keywords: [...merged].slice(-24),
    updatedAt: moment(at),
    messages: (thread.messages ?? 0) + 1,
  }
}

// Keeps the store from growing without bound: threads nobody touched for the longest sort
// last, and the oldest are dropped first once the cap is reached.
export function pruneThreads(threads, { now = Date.now(), max = MAX_THREADS, forgetHours = 24 * 30 } = {}) {
  const alive = (Array.isArray(threads) ? threads : []).filter(thread => {
    const updated = Date.parse(String(thread?.updatedAt ?? ''))
    return Number.isFinite(updated) && now - updated < forgetHours * HOUR
  })
  alive.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  return alive.slice(0, max)
}
