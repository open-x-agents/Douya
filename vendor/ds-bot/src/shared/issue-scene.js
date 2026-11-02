// Projection of Issue rows the Bot already wrote or already received from a tool.
// No network, no new tool, no prompt. Nothing here replaces the reply.
// A gh table or a `#N` line often has no issue URL. When the same text names one
// repository, the projection fills `https://github.com/<owner>/<repo>/issues/<n>`
// so the card can mount. The reply text is unchanged.
import { repoOfRows } from './issue-card.js'

/**
 * @typedef {{ number: number, title: string, url: string, comments?: number }} IssueRow
 * @typedef {{
 *   sessionId?: string,
 *   ownerSessionId?: string,
 *   mainBotId?: string,
 *   chatOwner?: string,
 *   isGroup?: boolean,
 *   isSide?: boolean,
 *   isBtw?: boolean,
 *   isHidden?: boolean,
 *   text?: string,
 * }} IssueSceneInput
 * @typedef {{ match: boolean, issues: IssueRow[] }} IssueScene
 */

const TEXT_LIMIT = 200_000
const TITLE_LIMIT = 300

/**
 * @param {string} raw
 * @returns {number | null}
 */
function asNumber(raw) {
  if (!/^[1-9]\d{0,9}$/.test(raw)) return null
  const number = Number(raw)
  return Number.isInteger(number) ? number : null
}

/**
 * @param {string} raw
 * @returns {number | null}
 */
function asCount(raw) {
  if (!/^(?:0|[1-9]\d{0,9})$/.test(raw)) return null
  const number = Number(raw)
  return Number.isInteger(number) ? number : null
}

/**
 * @param {string} title
 * @returns {string}
 */
function cleanTitle(title) {
  const text = title.replace(/\s+/g, ' ').trim()
  if (text === '') return ''
  return text.length > TITLE_LIMIT ? text.slice(0, TITLE_LIMIT) : text
}

/**
 * @param {string} url
 * @param {number} number
 * @returns {boolean}
 */
function isIssueUrl(url, number) {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && parsed.hostname === 'github.com' && parsed.pathname.endsWith(`/issues/${number}`)
  } catch {
    return false
  }
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function commentCount(value) {
  if (Number.isInteger(value) && value >= 0) return value
  if (Array.isArray(value)) return value.length
  return undefined
}

/**
 * @param {number} number
 * @param {string} title
 * @param {string} url
 * @param {number | undefined} comments
 * @returns {IssueRow}
 */
function row(number, title, url, comments) {
  return comments === undefined ? { number, title, url } : { number, title, url, comments }
}

/**
 * @param {unknown} item
 * @returns {IssueRow | null}
 */
function rowFromObject(item) {
  if (item == null || typeof item !== 'object' || Array.isArray(item)) return null
  if (Object.hasOwn(item, 'pull_request')) return null
  const number = asNumber(typeof item.number === 'number' || typeof item.number === 'string' ? String(item.number) : '')
  if (number === null) return null
  if (typeof item.title !== 'string') return null
  const title = cleanTitle(item.title)
  if (title === '') return null
  const html = typeof item.html_url === 'string' ? item.html_url : ''
  const url = typeof item.url === 'string' ? item.url : ''
  const link = isIssueUrl(html, number) ? html : (isIssueUrl(url, number) ? url : '')
  return row(number, title, link, commentCount(item.comments))
}

/**
 * @param {string} text
 * @param {number} start
 * @param {number} limit
 * @returns {number}
 */
function bracketEnd(text, start, limit) {
  let depth = 0
  let inString = false
  let escape = false
  for (let index = start; index < limit; index += 1) {
    const char = text[index]
    if (inString) {
      if (escape) escape = false
      else if (char === '\\') escape = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '[') depth += 1
    else if (char === ']') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/**
 * @param {string} text
 * @returns {IssueRow[]}
 */
function rowsFromJson(text) {
  const rows = []
  const limit = Math.min(text.length, TEXT_LIMIT)
  for (let index = 0; index < limit; index += 1) {
    if (text[index] !== '[') continue
    const end = bracketEnd(text, index, limit)
    if (end < 0) continue
    let value
    try {
      value = JSON.parse(text.slice(index, end + 1))
    } catch {
      value = undefined
    }
    if (Array.isArray(value)) {
      let found = 0
      for (const item of value) {
        const issue = rowFromObject(item)
        if (issue === null) continue
        rows.push(issue)
        found += 1
      }
      if (found > 0) index = end
    }
  }
  return rows
}

/**
 * @param {string} line
 * @returns {IssueRow | null}
 */
function rowFromLine(line) {
  const table = /^(\d+)\t(?:OPEN|CLOSED)\t([^\t]+)/i.exec(line)
  if (table) {
    const number = asNumber(table[1])
    const title = number === null ? '' : cleanTitle(table[2])
    return number === null || title === '' ? null : row(number, title, '', undefined)
  }
  const compact = /^(\d+)\t([^\t]+)\t[^\t]*\t[^\t]*\t(\d+)条评论/.exec(line)
  if (compact) {
    const number = asNumber(compact[1])
    const title = number === null ? '' : cleanTitle(compact[2])
    const comments = asCount(compact[3])
    if (number === null || title === '' || comments === null) return null
    return row(number, title, '', comments)
  }
  const titled = /^(\d+)\t([^\t]+)$/.exec(line)
  if (titled) {
    const number = asNumber(titled[1])
    const title = number === null ? '' : cleanTitle(titled[2])
    if (number === null || title === '' || /^(?:open|closed)$/i.test(title)) return null
    if (/^\d{4}-\d{2}-\d{2}/.test(title) || !/[A-Za-z\u4e00-\u9fff]/.test(title)) return null
    return row(number, title, '', undefined)
  }
  const markdown = /^(?:[-*+]\s+)?(?:\*\*)?#(\d+)(?:\*\*)?\s+(\S.*)$/.exec(line.trim())
  if (markdown) {
    const number = asNumber(markdown[1])
    const title = number === null ? '' : cleanTitle(markdown[2].replace(/\*\*$/, ''))
    return number === null || title === '' ? null : row(number, title, '', undefined)
  }
  return null
}

const OWNER = '[A-Za-z0-9][A-Za-z0-9_.-]{0,99}'
const REPO = '[A-Za-z0-9][A-Za-z0-9_.-]{0,99}'
const PAIR = `(${OWNER})\\/(${REPO})`
const FILE_REPO = /\.(?:js|mjs|cjs|ts|tsx|jsx|json|md|css|html|png|svg|yml|yaml|txt)$/i

/**
 * @param {RegExpExecArray | null} match
 * @returns {{ owner: string, repo: string } | undefined}
 */
function repoPair(match) {
  if (match === null) return undefined
  const owner = match[1]
  const repo = match[2]
  if (owner === '.' || owner === '..' || repo === '.' || repo === '..') return undefined
  return { owner, repo }
}

/**
 * Repository named in the turn when the rows themselves have no issue URL.
 * First hit wins, in this order: a github.com owner/repo URL, an
 * api.github.com/repos/owner/repo URL, a gh `--repo` or `-R` flag, a
 * backtick-wrapped owner/repo, then a bare owner/repo token whose name
 * contains a hyphen, underscore, or digit. File paths (`vendor/ds-bot/src/...`,
 * `issue-mount.js`) are not a repository.
 * @param {unknown} text
 * @returns {{ owner: string, repo: string } | undefined}
 */
export function inferIssueRepo(text) {
  const source = typeof text === 'string' ? text : ''
  const web = repoPair(new RegExp(`(?<![A-Za-z0-9.])github\\.com/${PAIR}(?![A-Za-z0-9_.-])`, 'i').exec(source))
  if (web !== undefined) return web
  const api = repoPair(new RegExp(`api\\.github\\.com/repos/${PAIR}(?![A-Za-z0-9_.-])`, 'i').exec(source))
  if (api !== undefined) return api
  const flagged = repoPair(new RegExp(`(?:^|\\s)(?:--repo(?:=|\\s+)|-R\\s*)${PAIR}(?![A-Za-z0-9_.-])`).exec(source))
  if (flagged !== undefined) return flagged
  const quoted = repoPair(new RegExp(`\`(${OWNER})\\/(${REPO})\``).exec(source))
  if (quoted !== undefined && !FILE_REPO.test(quoted.repo)) return quoted
  const bare = new RegExp(`(?:^|[^A-Za-z0-9_.\\-/])${PAIR}(?![A-Za-z0-9_.\\-/])`, 'g')
  for (const match of source.matchAll(bare)) {
    const found = repoPair(match)
    if (found === undefined || FILE_REPO.test(found.repo)) continue
    if (!/[-_\d]/.test(found.owner) && !/[-_\d]/.test(found.repo)) continue
    return found
  }
  return undefined
}

/**
 * @param {IssueRow[]} issues
 * @param {unknown} text
 * @returns {IssueRow[]}
 */
function issuesWithRepo(issues, text) {
  const repo = repoOfRows(issues) ?? inferIssueRepo(text)
  if (repo === undefined) return issues
  return issues.map(issue => issue.url !== '' ? issue : {
    ...issue,
    url: `https://github.com/${repo.owner}/${repo.repo}/issues/${issue.number}`,
  })
}

/**
 * Issue rows already present in tool output or reply text.
 * No rows is an empty list.
 * @param {unknown} text
 * @returns {IssueRow[]}
 */
export function extractIssueRows(text) {
  const source = typeof text === 'string' ? text : ''
  /** @type {Map<number, IssueRow>} */
  const byNumber = new Map()
  const add = (issue) => {
    if (issue === null || byNumber.has(issue.number)) return
    byNumber.set(issue.number, issue)
  }
  for (const issue of rowsFromJson(source)) add(issue)
  for (const line of source.split('\n')) add(rowFromLine(line.replace(/\r$/, '')))
  return [...byNumber.values()]
}

/**
 * The only surface that may gain an Issue view: the Main Bot's current private chat.
 * Group, side, btw, hidden, and any other Bot stay on their existing transcript.
 * @param {IssueSceneInput | null | undefined} input
 * @returns {boolean}
 */
export function matchesIssueScene(input) {
  if (input == null) return false
  if (input.isGroup === true || input.isSide === true || input.isBtw === true || input.isHidden === true) return false
  if (typeof input.mainBotId !== 'string' || input.mainBotId === '') return false
  if (input.chatOwner !== input.mainBotId) return false
  if (typeof input.sessionId !== 'string' || input.sessionId === '') return false
  if (input.sessionId !== input.ownerSessionId) return false
  return true
}

/**
 * @param {IssueSceneInput | null | undefined} input
 * @returns {IssueScene}
 */
export function projectIssueScene(input) {
  const issues = extractIssueRows(input?.text)
  if (!matchesIssueScene(input) || issues.length === 0) return { match: false, issues: [] }
  return { match: true, issues: issuesWithRepo(issues, input?.text) }
}
