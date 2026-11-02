// Issue card mount. After a turn already produced Issue rows, the host may hang a
// native card beside that reply. The card is presentation: it tries to read public
// issue bodies for excerpts, and it never answers, never registers a tool, and
// never writes back to GitHub. A failed public read still stores the card from the
// rows already in the turn, with those bodies left empty.
import { matchesIssueScene, projectIssueScene } from '../shared/issue-scene.js'
import {
  BODY_LIMIT,
  COMMENT_LIMIT,
  COMMENT_MAX,
  attachScope,
  clipChars,
  defaultWidget,
  issueCallId,
  latestIssueCard,
  normalizeWidget,
  parseCitations,
  repoOfRows,
} from '../shared/issue-card.js'
import { textOf } from './text.js'

const ROW_CAP = 30
const SYNTHETIC = ['topic', 'short', 'priority', 'proposal', 'decision', 'step', 'accept']

const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })

/**
 * @param {string} url
 * @param {{ owner: string, repo: string }} repo
 * @param {number} number
 */
function sameRepo(url, repo, number) {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/(\d+)\/?$/.exec(url ?? '')
  return match !== null && match[1] === repo.owner && match[2] === repo.repo && match[3] === String(number)
}

/**
 * @param {number} count
 * @param {number} kept
 * @returns {'none' | 'read' | 'partial'}
 */
function commentStateOf(count, kept) {
  if (count === 0) return 'none'
  if (kept >= count) return 'read'
  return 'partial'
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function labelNames(value) {
  if (!Array.isArray(value)) return []
  const names = []
  for (const label of value) {
    const name = typeof label === 'string' ? label : (typeof label?.name === 'string' ? label.name : '')
    const text = name.trim()
    if (text === '') continue
    names.push(text.length > 80 ? text.slice(0, 80) : text)
  }
  return names
}

/**
 * Public issue JSON. No credential header is set, and a non-200 is a failed read.
 * @param {any} rt
 * @param {string} url
 */
async function readJson(rt, url) {
  const fetchImpl = rt.config.issueFetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new Error('issue read failed')
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'openDigitalMate',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  })
  if (response?.ok !== true) throw new Error('issue read failed')
  return response.json()
}

/**
 * @param {unknown[]} values
 * @returns {number | undefined}
 */
function knownCount(values) {
  for (const value of values) {
    if (Number.isInteger(value) && value >= 0) return value
  }
  return undefined
}

/**
 * @param {{ comments?: number }} row
 */
function sessionEvidence(row) {
  const count = knownCount([row.comments])
  return {
    publicRead: false,
    commentsRead: false,
    body: '',
    excerpts: [],
    labels: [],
    commentCount: count ?? 0,
    commentState: count === 0 ? 'none' : 'unread',
  }
}

/**
 * Best-effort public excerpt. A 404 or any other read failure keeps the row.
 * @param {any} rt
 * @param {{ owner: string, repo: string }} repo
 * @param {{ number: number, comments?: number }} row
 */
async function publicEvidence(rt, repo, row) {
  const root = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/issues/${row.number}`
  let issueJson
  try {
    issueJson = await readJson(rt, root)
  } catch (error) {
    rt.warn('ds-bot: issue public read failed: %s', error)
    return sessionEvidence(row)
  }
  if (issueJson == null || typeof issueJson !== 'object' || Array.isArray(issueJson)) {
    rt.warn('ds-bot: issue public read failed: %s', 'issue read failed')
    return sessionEvidence(row)
  }
  let commentsJson = []
  let commentsRead = false
  try {
    commentsJson = await readJson(rt, `${root}/comments?per_page=${COMMENT_MAX}`)
    if (!Array.isArray(commentsJson)) throw new Error('issue read failed')
    commentsRead = true
  } catch (error) {
    rt.warn('ds-bot: issue public read failed: %s', error)
    commentsJson = []
  }
  const count = knownCount([issueJson.comments, row.comments, commentsRead ? commentsJson.length : undefined])
  const excerpts = !commentsRead || count === 0
    ? []
    : commentsJson.slice(0, COMMENT_MAX).map(comment => clipChars(comment?.body, COMMENT_LIMIT)).filter(excerpt => excerpt !== '')
  const commentCount = count ?? 0
  const commentState = commentsRead
    ? commentStateOf(commentCount, excerpts.length)
    : (count === 0 ? 'none' : 'unread')
  return {
    publicRead: true,
    commentsRead,
    body: clipChars(issueJson.body, BODY_LIMIT),
    excerpts,
    labels: labelNames(issueJson.labels),
    commentCount,
    commentState,
  }
}

/**
 * @param {number} total
 * @param {number} issueReads
 * @param {number} fullReads
 * @returns {'public' | 'partial' | 'session'}
 */
function evidenceOf(total, issueReads, fullReads) {
  if (total === 0 || issueReads === 0) return 'session'
  if (fullReads === total) return 'public'
  return 'partial'
}

/**
 * @param {any} rt
 * @param {string} sessionId
 */
function surfaceMatches(rt, sessionId) {
  const mainBotId = rt.state.mainBotIds?.[0]
  return matchesIssueScene({
    sessionId,
    ownerSessionId: typeof mainBotId === 'string' ? rt.chatOf(mainBotId) : undefined,
    mainBotId,
    chatOwner: rt.chatOwners.get(sessionId),
    isGroup: rt.groupOwners.has(sessionId),
  })
}

/**
 * @param {any} rt
 * @param {string} sessionId
 * @param {number} turn
 * @param {string} text
 */
async function settle(rt, sessionId, turn, text) {
  await rt.load()
  const mainBotId = rt.state.mainBotIds?.[0]
  const scene = projectIssueScene({
    sessionId,
    ownerSessionId: typeof mainBotId === 'string' ? rt.chatOf(mainBotId) : undefined,
    mainBotId,
    chatOwner: rt.chatOwners.get(sessionId),
    isGroup: rt.groupOwners.has(sessionId),
    isHidden: (rt.state.exchangeTurns?.[sessionId] ?? []).includes(turn),
    text,
  })
  if (!scene.match) return
  const callId = issueCallId(sessionId, turn)
  if (callId === null) return
  const { state } = rt
  if (rt.own(state.issueCards, callId) !== undefined) return
  const repo = repoOfRows(scene.issues)
  if (repo === undefined) return
  const rows = scene.issues.filter(issue => sameRepo(issue.url, repo, issue.number)).slice(0, ROW_CAP)
  if (rows.length === 0) return
  const notes = parseCitations(text, rows.map(row => String(row.number)))
  const issues = []
  let issueReads = 0
  let fullReads = 0
  for (const row of rows) {
    const evidence = await publicEvidence(rt, repo, row)
    if (evidence.publicRead) issueReads += 1
    if (evidence.publicRead && evidence.commentsRead) fullReads += 1
    const cited = notes.issues[String(row.number)] ?? {}
    /** @type {Record<string, string>} */
    const fields = {}
    for (const key of SYNTHETIC) fields[key] = typeof cited[key] === 'string' ? cited[key] : ''
    issues.push({
      id: String(row.number),
      number: row.number,
      title: row.title,
      url: row.url,
      commentCount: evidence.commentCount,
      commentState: evidence.commentState,
      body: evidence.body,
      excerpts: evidence.excerpts,
      labels: evidence.labels,
      ...fields,
    })
  }
  state.issueCards[callId] = {
    callId,
    sessionId,
    turn,
    owner: repo.owner,
    repo: repo.repo,
    fetchedAt: new Date().toISOString(),
    createdAt: Date.now(),
    evidence: evidenceOf(issues.length, issueReads, fullReads),
    conclusion: notes.conclusion,
    issues,
  }
  if (rt.own(state.issueWidgets, callId) === undefined) state.issueWidgets[callId] = defaultWidget(issues)
  await rt.save()
}

/**
 * @param {any} rt
 * @param {any} request
 */
async function scopeRequest(rt, request) {
  if (request == null || typeof request !== 'object' || typeof request.sessionId !== 'string' || !Array.isArray(request.content)) return request
  await rt.load()
  const card = surfaceMatches(rt, request.sessionId) ? latestIssueCard(rt.state.issueCards, request.sessionId) : undefined
  const widget = card === undefined ? undefined : normalizeWidget(rt.own(rt.state.issueWidgets, card.callId), card.issues)
  const spec = { eligible: card !== undefined, card, widget }
  let attached = false
  let changed = false
  const content = request.content.map((block) => {
    if (block?.type !== 'text' || typeof block.text !== 'string') return block
    const allow = spec.eligible && attached === false
    attached = true
    const text = attachScope(block.text, allow ? spec : { eligible: false })
    if (text === block.text) return block
    changed = true
    return { ...block, text }
  })
  return changed ? { ...request, content } : request
}

/**
 * @param {any} rt
 * @param {unknown} callId
 * @param {unknown} widget
 */
async function saveIssueWidget(rt, callId, widget) {
  if (typeof callId !== 'string' || callId === '' || callId === '__proto__' || callId === 'constructor' || callId === 'prototype') {
    throw invalid('Unknown issue card')
  }
  await rt.load()
  const card = rt.own(rt.state.issueCards, callId)
  if (card === undefined) throw invalid('Unknown issue card')
  const next = normalizeWidget(widget, card.issues)
  rt.state.issueWidgets[callId] = next
  await rt.save()
  return next
}

/**
 * @param {any} event
 */
function eventText(event) {
  return textOf(event?.data?.message?.content)
}

export function install(rt) {
  const { ctx } = rt
  /** @type {Map<string, { turn: number, chunks: string[] }>} */
  const buffers = new Map()
  let mounted = Promise.resolve()
  rt.whenIssueMounted = () => mounted
  rt.saveIssueWidget = (callId, widget) => saveIssueWidget(rt, callId, widget)

  const controller = ctx.sessionController
  if (controller !== undefined && typeof controller.prompt === 'function' && controller.prompt.issueScoped !== true) {
    const inner = controller.prompt.bind(controller)
    const wrapped = async function issueScopedPrompt(request, ...rest) {
      let next = request
      try {
        next = await scopeRequest(rt, request)
      } catch (error) {
        rt.warn('ds-bot: issue scope skipped: %s', error)
      }
      return inner(next, ...rest)
    }
    wrapped.issueScoped = true
    controller.prompt = wrapped
  }

  // Own buffer: the turn log clears its copy of the texts before later listeners run.
  ctx.on('session/event', (session, event) => {
    const id = session?.id
    if (typeof id !== 'string' || id === '') return
    switch (event?.type) {
      case 'turn/start': {
        const turn = event.data?.turn
        if (!Number.isInteger(turn)) {
          buffers.delete(id)
          return
        }
        buffers.set(id, { turn, chunks: [] })
        return
      }
      case 'tool/result':
      case 'assistant/message': {
        const buffer = buffers.get(id)
        if (buffer === undefined) return
        const text = eventText(event)
        if (text !== '') buffer.chunks.push(text)
        return
      }
      case 'turn/end': {
        const buffer = buffers.get(id)
        buffers.delete(id)
        if (buffer === undefined) return
        const turn = Number.isInteger(event.data?.turn) ? event.data.turn : buffer.turn
        const text = buffer.chunks.join('\n')
        const job = settle(rt, id, turn, text).catch(error => rt.warn('ds-bot: issue card skipped: %s', error))
        mounted = mounted.then(() => job, () => job)
        return
      }
      default:
        return
    }
  })
}
