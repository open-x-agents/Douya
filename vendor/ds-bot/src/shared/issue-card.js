// Presentation for Issue rows the host already projected. No network and no reply text.

export const UNREFINED = '还没有提炼'
const FIELD_KEEP = 240
const LONG_KEEP = 400
const BODY_KEEP = 800
const COMMENT_KEEP = 400
const COMMENT_CAP = 5
const PANES = new Set(['detail', 'sources', 'compare', 'plan'])
const FIELDS = ['topic', 'short', 'priority', 'proposal', 'decision', 'step', 'accept']
const machinePattern = () => /\[Issue brief scope\][\s\S]*?\[\/Issue brief scope\]\n?/g

/**
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
export function clipChars(value, max) {
  const text = String(value ?? '').replace(/\r\n/g, '\n').trim()
  return text.length > max ? text.slice(0, max) : text
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function issueShown(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : UNREFINED
}

/**
 * @param {'none' | 'read' | 'partial' | 'unread'} state
 * @param {{ excerpts?: string[], commentCount?: number }} issue
 * @returns {string}
 */
function labelForState(state, issue) {
  switch (state) {
    case 'none': return '无评论'
    case 'read': return '评论已读'
    case 'partial': return `部分评论已读 ${issue.excerpts?.length ?? 0}/${issue.commentCount}`
    case 'unread': return '评论未读到'
    default: {
      /** @type {never} */
      const unexpected = state
      throw new Error(`Unknown comment state ${String(unexpected)}`)
    }
  }
}

/**
 * A missing or unknown state is unread. It must not look like a successful read.
 * @param {{ commentState?: string, excerpts?: string[], commentCount?: number }} issue
 * @returns {string}
 */
export function commentLabel(issue) {
  const state = issue?.commentState
  if (state !== 'none' && state !== 'read' && state !== 'partial' && state !== 'unread') return '评论未读到'
  return labelForState(state, issue)
}

/**
 * @param {{ url?: string }[]} rows
 * @returns {{ owner: string, repo: string } | undefined}
 */
export function repoOfRows(rows) {
  for (const row of rows ?? []) {
    const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/\d+\/?$/.exec(row?.url ?? '')
    if (match === null || match[1] === '.' || match[1] === '..' || match[2] === '.' || match[2] === '..') continue
    return { owner: match[1], repo: match[2] }
  }
  return undefined
}

/**
 * @param {string} sessionId
 * @param {number} turn
 * @returns {string | null}
 */
export function issueCallId(sessionId, turn) {
  if (typeof sessionId !== 'string' || sessionId === '' || sessionId === '__proto__' || sessionId === 'constructor' || sessionId === 'prototype') return null
  if (!Number.isInteger(turn) || turn < 0) return null
  return `issue:${sessionId}:${turn}`
}

/**
 * Notes the model already wrote that cite a snapshot id. Anything else is left empty.
 * @param {unknown} text
 * @param {string[]} ids
 * @returns {{ conclusion: string, issues: Record<string, Record<string, string>> }}
 */
export function parseCitations(text, ids) {
  const allowed = new Set(ids.map(id => String(id)))
  /** @type {Record<string, Record<string, string>>} */
  const issues = {}
  let conclusion = ''
  /** @type {string | null} */
  let current = null
  for (const line of String(text ?? '').split('\n')) {
    const note = /^\[Issue note #(\d+)\]\s*$/.exec(line.trim())
    if (note) {
      current = allowed.has(note[1]) ? note[1] : null
      if (current !== null && issues[current] === undefined) issues[current] = {}
      continue
    }
    if (line.trim() === '[Issue conclusion]') {
      current = 'conclusion'
      continue
    }
    if (current === null) continue
    const field = /^([A-Za-z]+):\s*(.*)$/.exec(line.trim())
    if (field === null) continue
    if (current === 'conclusion') {
      if (field[1] === 'conclusion') conclusion = clipChars(field[2], LONG_KEEP)
      continue
    }
    if (!FIELDS.includes(field[1])) continue
    const keep = field[1] === 'proposal' || field[1] === 'step' ? LONG_KEEP : FIELD_KEEP
    issues[current][field[1]] = clipChars(field[2], keep)
  }
  return { conclusion, issues }
}

/**
 * @param {{ id: string }[]} issues
 * @returns {{ focusId: string | null, selectedIds: string[], pane: string }}
 */
export function defaultWidget(issues) {
  return { focusId: issues[0]?.id ?? null, selectedIds: [], pane: 'detail', filter: 'all' }
}

/**
 * @param {unknown} widget
 * @param {{ id: string }[]} issues
 */
export function normalizeWidget(widget, issues) {
  const list = Array.isArray(issues) ? issues : []
  const ids = new Set(list.map(issue => issue.id))
  const selectedIds = (Array.isArray(widget?.selectedIds) ? widget.selectedIds : []).filter(id => typeof id === 'string' && ids.has(id))
  const focusId = typeof widget?.focusId === 'string' && ids.has(widget.focusId) ? widget.focusId : (list[0]?.id ?? null)
  const pane = PANES.has(widget?.pane) ? widget.pane : 'detail'
  const topics = new Set(list.map(issue => (typeof issue.topic === 'string' ? issue.topic.trim() : '')).filter(topic => topic !== ''))
  const filter = widget?.filter === 'all' || topics.has(widget?.filter) ? widget.filter : 'all'
  return { focusId, selectedIds, pane, filter }
}

/**
 * @param {{ issues?: { id: string, number: number, title: string }[] }} card
 * @param {{ selectedIds?: string[], focusId?: string | null }} widget
 */
export function discussionLine(card, widget) {
  const byId = new Map((card?.issues ?? []).map(issue => [issue.id, issue]))
  const selected = (widget?.selectedIds ?? []).map(id => byId.get(id)).filter(Boolean)
  if (selected.length > 0) return `当前讨论：${selected.map(issue => `#${issue.number} ${issue.title}`).join('、')}`
  const focus = byId.get(widget?.focusId) ?? card?.issues?.[0]
  if (!focus) return '当前讨论：'
  return `当前讨论：#${focus.number} · ${focus.title}`
}

/**
 * @param {{ callId: string, owner: string, repo: string, issues: { id: string, number: number, title: string, url: string, commentState: string, excerpts?: string[], commentCount?: number }[] }} card
 * @param {{ selectedIds: string[], focusId: string | null, pane: string }} widget
 */
export function scopeMachine(card, widget) {
  const scope = widget.selectedIds.length > 0 ? 'selection' : 'focus'
  const ids = scope === 'selection' ? widget.selectedIds : [widget.focusId ?? card.issues[0]?.id]
  const byId = new Map(card.issues.map(issue => [issue.id, issue]))
  const lines = ids.map((id) => {
    const issue = byId.get(id)
    if (!issue) return null
    return `- #${issue.number} ${issue.title} | ${issue.url} | ${commentLabel(issue)}`
  }).filter(Boolean)
  return [
    '[Issue brief scope]',
    `repo: ${card.owner}/${card.repo}`,
    `callId: ${card.callId}`,
    `scope: ${scope}`,
    `pane: ${widget.pane}`,
    ...lines,
    '[/Issue brief scope]',
  ].join('\n')
}

/**
 * Drop a scope this host attached, restoring the text that was sent.
 * A string with no machine block is returned unchanged.
 * @param {string} raw
 * @returns {string}
 */
function peelScope(raw) {
  if (!raw.includes('[Issue brief scope]')) return raw
  const text = raw.replace(machinePattern(), '')
  if (!text.startsWith('当前讨论：')) return text
  const nl = text.indexOf('\n')
  let rest = nl < 0 ? '' : text.slice(nl + 1)
  if (rest.startsWith('\n')) rest = rest.slice(1)
  if (rest.endsWith('\n\n')) rest = rest.slice(0, -2)
  return rest
}

/**
 * Hide the machine block in a bubble. A message without one is returned unchanged.
 * @param {unknown} text
 */
export function visibleUserText(text) {
  const raw = String(text ?? '')
  if (!raw.includes('[Issue brief scope]')) return raw
  return raw.replace(machinePattern(), '').replace(/\n{3,}/g, '\n\n')
}

/**
 * Attach the latest card's scope to a send in the matching chat.
 * A message with no card and no machine block is returned unchanged.
 * @param {unknown} text
 * @param {{ eligible?: boolean, card?: any, widget?: { selectedIds: string[], focusId: string | null, pane: string } }} spec
 */
export function attachScope(text, spec) {
  const raw = String(text ?? '')
  const had = raw.includes('[Issue brief scope]')
  const eligible = spec?.eligible === true && spec.card !== undefined && spec.widget !== undefined
  if (!eligible) return had ? peelScope(raw) : raw
  const body = had ? peelScope(raw) : raw
  const line = discussionLine(spec.card, spec.widget)
  if (line === '当前讨论：') return body
  const machine = scopeMachine(spec.card, spec.widget)
  if (body === '') return `${line}\n\n${machine}`
  return `${line}\n\n${body}\n\n${machine}`
}

/**
 * @param {{ selectedIds?: string[] }} widget
 * @returns {{ type: 'disabled' } | { type: 'pane', pane: 'compare' }}
 */
export function compareAction(widget) {
  if ((widget?.selectedIds ?? []).length < 2) return { type: 'disabled' }
  return { type: 'pane', pane: 'compare' }
}

/**
 * Plan stays on the card. A missing step is not a new model turn.
 * @param {{ selectedIds?: string[] }} widget
 * @returns {{ type: 'disabled' } | { type: 'pane', pane: 'plan' }}
 */
export function planAction(widget) {
  if ((widget?.selectedIds ?? []).length === 0) return { type: 'disabled' }
  return { type: 'pane', pane: 'plan' }
}

/**
 * @param {Record<string, any> | undefined} cards
 * @param {string} sessionId
 * @param {number} turn
 */
export function issueCardForTurn(cards, sessionId, turn) {
  for (const card of Object.values(cards ?? {})) {
    if (card?.sessionId === sessionId && card?.turn === turn) return card
  }
  return undefined
}

/**
 * @param {Record<string, any> | undefined} cards
 * @param {string} sessionId
 */
export function latestIssueCard(cards, sessionId) {
  let best
  for (const card of Object.values(cards ?? {})) {
    if (card?.sessionId !== sessionId) continue
    if (best === undefined || (card.createdAt ?? 0) >= (best.createdAt ?? 0)) best = card
  }
  return best
}

/**
 * @param {{ mainBotId?: string, roomsById?: Record<string, unknown>, byId?: Record<string, { id?: string, sessionId?: string }> }} roster
 * @param {string} sessionId
 */
export function canShowIssueCard(roster, sessionId) {
  if (roster == null || roster.roomsById?.[sessionId] !== undefined) return false
  const mainBotId = roster.mainBotId
  if (typeof mainBotId !== 'string' || mainBotId === '') return false
  const bot = roster.byId?.[sessionId]
  return bot?.id === mainBotId && bot?.sessionId === sessionId
}

export function headerLine(card) {
  const evidence = card?.evidence
  const via = evidence === 'session' ? '会话列表' : (evidence === 'partial' ? '公开 API · 部分未读到' : '公开 API')
  return `读于 ${card.fetchedAt} · ${card.owner}/${card.repo} · ${via} · 只读`
}

export const BODY_LIMIT = BODY_KEEP
export const COMMENT_LIMIT = COMMENT_KEEP
export const COMMENT_MAX = COMMENT_CAP
export const FIELD_LIMIT = FIELD_KEEP
