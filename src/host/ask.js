// Asking a question against evidence: the engine may only say what a source says.
//
// The model is a seam, not a provider: the caller passes `model({text, sources})` and a
// `now()` clock, so tests can drive this without a key or a live connection. The default
// template model quotes the best-matching source. Whatever the model returns, every claim
// has to resolve to a ref in this question's evidence, and every anchor it mentions
// (weekday, clock, amount) has to appear word for word in the cited source. A claim that
// fails either check is dropped, and an answer with no surviving claim refuses instead of
// guessing. Nothing here touches the network or writes anything.

import { labelOf } from '../sources/composio/registry.js'
import { overlap, tokens } from './threads.js'

export const DEFAULT_BUDGET_MS = 3_000

// What a missing source is called when the answer has to name what it lacks.
export const SOURCE_LABELS = {
  gcal: '飞书日历',
  feishu_cal: '飞书日历',
  gmail: '邮件',
  feishu_doc: '云文档',
  doc: '云文档',
  feishu_msg: '飞书消息',
  github: 'GitHub',
}

// A source read only to metadata level cannot answer about its body: the limit is named
// in `limits` and said out loud in the bubble.
const LIMIT_BY_SOURCE = {
  gmail: 'gmail:body',
  feishu_doc: 'feishu_doc:body',
  doc: 'doc:body',
  feishu_msg: 'feishu_msg:body',
}

// Anchors are the part of a claim a reader can check against the source word for word.
const ANCHOR_PATTERNS = [
  /(?:周|星期|礼拜)[一二三四五六日天]/g,
  /\b(?:[01]?\d|2[0-3]):[0-5]\d\b/g,
  /(?:\d{1,2}|[一二三四五六七八九十两]{1,3})\s*点/g,
  /\d+(?:\.\d+)?\s*(?:万|元|%|分钟|小时|人|个|件)/g,
]

const trimmed = (value) => String(value ?? '').trim()

export function sourceLabel(source) {
  const raw = trimmed(typeof source === 'string' ? source : source?.source || source?.ref)
  if (raw === '') return ''
  if (raw.startsWith('composio:')) {
    const toolkit = trimmed(raw.split(':')[1])
    // The name comes from the registry row, so adding an app never edits this file; only a
    // toolkit the registry does not know falls back to its own slug.
    return (labelOf(toolkit) ?? SOURCE_LABELS[toolkit] ?? toolkit) || 'Composio'
  }
  return SOURCE_LABELS[raw.split(':')[0]] ?? raw.split(':')[0]
}

export function anchorsOf(text) {
  const haystack = String(text ?? '')
  const found = []
  for (const pattern of ANCHOR_PATTERNS) {
    for (const match of haystack.matchAll(pattern)) {
      const anchor = match[0].replace(/\s+/g, '')
      if (!found.includes(anchor)) found.push(anchor)
    }
  }
  return found
}

// A claim is usable only when it names a ref we actually read, is not empty, and carries no
// anchor the cited source never said. The codes are what a test and the caller both read.
export function supportedClaim(claim, source) {
  const text = trimmed(claim?.text ?? claim)
  if (text === '') return { ok: false, code: 'E_EMPTY_CLAIM' }
  if (!source || trimmed(source.ref) === '') return { ok: false, code: 'E_NO_REF' }
  const evidence = `${trimmed(source.title)} ${trimmed(source.excerpt)}`
  for (const anchor of anchorsOf(text)) {
    if (!evidence.includes(anchor)) return { ok: false, code: 'E_UNSUPPORTED', anchor }
  }
  return { ok: true, code: null }
}

export function boundarySentences(sources = []) {
  const seen = new Set()
  const sentences = []
  for (const source of Array.isArray(sources) ? sources : []) {
    if (source?.read_scope !== 'metadata') continue
    const key = trimmed(source.ref) || sourceLabel(source)
    if (seen.has(key)) continue
    seen.add(key)
    sentences.push(`${sourceLabel(source)}只读了主题与收发关系，没读正文。`)
  }
  return sentences
}

export function limitsOf(sources = []) {
  const limits = []
  for (const source of Array.isArray(sources) ? sources : []) {
    if (source?.read_scope !== 'metadata') continue
    const named = source.limits ?? source.limit
    const values = Array.isArray(named)
      ? named
      : named
        ? [named]
        : [LIMIT_BY_SOURCE[trimmed(source.source)] ?? `${trimmed(source.source) || 'source'}:body`]
    for (const value of values) {
      const limit = trimmed(value)
      if (limit !== '' && !limits.includes(limit)) limits.push(limit)
    }
  }
  return limits
}

const missingLabels = (unread) => {
  const labels = []
  for (const item of Array.isArray(unread) ? unread : []) {
    const label = sourceLabel(typeof item === 'string' ? item : item?.source || item?.ref)
    if (label !== '' && !labels.includes(label)) labels.push(label)
  }
  return labels
}

// Three fixed refusals, in order: name the missing source first, then admit there was no
// evidence at all, and only then blame the claims themselves.
export function refusalText({ sources = [], unread = [] } = {}) {
  const labels = missingLabels(unread)
  if (labels.length > 0) return `这条我答不了：${labels.join('、')} 没连上。`
  if ((Array.isArray(sources) ? sources : []).length === 0) return '这条我答不了：这次没有读到能回答它的信源。'
  return '这条我答不了：回答里的说法在信源里找不到对应的话。'
}

// Only sources that share at least one token with the question are candidates; no overlap
// means no candidate, and no candidate means refusal rather than the least-unrelated source.
export function rankSources(question, sources = [], limit = 6) {
  const wanted = tokens(question)
  const scored = []
  for (const source of Array.isArray(sources) ? sources : []) {
    if (trimmed(source?.ref) === '') continue
    const offered = tokens([source.title, source.excerpt].filter(Boolean).join(' '))
    const score = overlap(wanted, offered)
    if (score <= 0) continue
    scored.push({ source, score })
  }
  scored.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score
    const atOrder = trimmed(left.source.at).localeCompare(trimmed(right.source.at))
    if (atOrder !== 0) return atOrder
    return trimmed(left.source.ref).localeCompare(trimmed(right.source.ref))
  })
  return scored.slice(0, limit).map((entry) => entry.source)
}

const clockOf = (source) => trimmed(source?.clock) || trimmed(source?.at).slice(11, 16)

// The default model: no key, no network. It quotes the excerpt (or the title) of the source
// that matches the question best, and cites that source's ref.
export function templateModel({ text, sources } = {}) {
  const best = rankSources(text, sources, 1)[0]
  if (!best) return { claims: [] }
  return { claims: [{ text: trimmed(best.excerpt) || trimmed(best.title), ref: best.ref }] }
}

const secondsOf = (milliseconds) => (milliseconds / 1000).toFixed(1)

const budgetText = (budgetMs) =>
  budgetMs % 1000 === 0 ? String(budgetMs / 1000) : (budgetMs / 1000).toFixed(1)

/**
 * Answer one question from evidence.
 *
 * @param {object} input
 * @param {string} input.text
 * @param {Array<{ref:string,source:string,title:string,excerpt?:string,at?:string,clock?:string,read_scope?:string,limits?:string[]}>} [input.sources]
 * @param {string[]} [input.unread] sources the question needs but that are not connected
 * @param {(input:{text:string,sources:object[]}) => ({claims?:Array<{text:string,ref:string}>}|Array<{text:string,ref:string}>)} [input.model]
 * @param {() => number} [input.now]
 * @param {number} [input.budgetMs]
 */
export function askQuestion({
  text,
  sources = [],
  unread = [],
  model = templateModel,
  now = Date.now,
  budgetMs = DEFAULT_BUDGET_MS,
} = {}) {
  const question = trimmed(text)
  const evidence = (Array.isArray(sources) ? sources : []).filter((source) => trimmed(source?.ref) !== '')
  const missing = (Array.isArray(unread) ? unread : [])
    .map((item) => trimmed(typeof item === 'string' ? item : item?.source || item?.ref))
    .filter((item) => item !== '')
  const candidates = rankSources(question, evidence)
  const started = now()
  const elapsed = () => Math.max(0, Number(now()) - Number(started))

  // No candidate: never call the model, so a missing source cannot be papered over.
  if (candidates.length === 0) {
    const latency_ms = elapsed()
    return {
      status: 'refused',
      answer: refusalText({ sources: [], unread: missing }),
      citations: [],
      unread_sources: missing,
      limits: [],
      claims: [],
      dropped: [],
      latency_ms,
      slow: latency_ms > budgetMs,
    }
  }

  const reply = model({ text: question, sources: candidates }) ?? {}
  const latency_ms = elapsed()
  const slow = latency_ms > budgetMs
  const rawClaims = Array.isArray(reply) ? reply : Array.isArray(reply.claims) ? reply.claims : []
  const byRef = new Map(candidates.map((source) => [trimmed(source.ref), source]))
  const kept = []
  const dropped = []

  for (const raw of rawClaims) {
    const claim = typeof raw === 'string' ? { text: raw, ref: '' } : raw
    const ref = trimmed(claim?.ref)
    const claimText = trimmed(claim?.text)
    const source = byRef.get(ref)
    if (!source) {
      dropped.push({ code: 'E_NO_REF', ref, text: claimText })
      continue
    }
    const check = supportedClaim({ text: claimText, ref }, source)
    if (!check.ok) {
      dropped.push({ code: check.code, ref, text: claimText })
      continue
    }
    kept.push({ text: claimText, ref, clock: clockOf(source), label: sourceLabel(source) })
  }

  // Nothing survived: refuse, and never echo the dropped wording in the bubble.
  if (kept.length === 0) {
    return {
      status: 'refused',
      answer: refusalText({ sources: candidates, unread: [] }),
      citations: [],
      unread_sources: missing,
      limits: [],
      claims: [],
      dropped,
      latency_ms,
      slow,
    }
  }

  const citedSources = kept.map((claim) => byRef.get(claim.ref)).filter(Boolean)
  const limits = limitsOf(citedSources)
  const citations = []
  for (const claim of kept) {
    if (!citations.some((citation) => citation.ref === claim.ref)) {
      citations.push({ ref: claim.ref, clock: claim.clock, label: claim.label })
    }
  }

  const parts = kept.map((claim) => claim.text)
  parts.push(...boundarySentences(citedSources))
  if (slow) {
    parts.push(`（这条答得慢：先出结论用了 ${secondsOf(latency_ms)} 秒，预算 ${budgetText(budgetMs)} 秒。）`)
  }

  return {
    status: dropped.length === 0 && limits.length === 0 ? 'answered' : 'partial',
    answer: parts.join(' '),
    citations,
    unread_sources: missing,
    limits,
    claims: kept.map((claim) => ({ text: claim.text, ref: claim.ref })),
    dropped,
    latency_ms,
    slow,
  }
}

// The default evidence provider until #9's ledger lands: today's upcoming events become
// calendar sources, with the title as the excerpt. A missing-source list may ride along in
// the state for the caller to pass to askQuestion.
export function evidenceFromState(state = {}) {
  const sources = (Array.isArray(state?.upcoming) ? state.upcoming : [])
    .filter((item) => trimmed(item?.id) !== '')
    .map((item) => {
      const startAt = trimmed(item?.startAt ?? item?.due_at)
      return {
        ref: `gcal:event/${trimmed(item.id)}`,
        source: 'gcal',
        title: trimmed(item.title),
        excerpt: trimmed(item.title),
        at: startAt,
        clock: startAt.slice(11, 16),
        read_scope: 'event',
      }
    })
  const unread = (Array.isArray(state?.unread_sources) ? state.unread_sources : [])
    .map((item) => trimmed(item))
    .filter((item) => item !== '')
  return { sources, unread }
}
