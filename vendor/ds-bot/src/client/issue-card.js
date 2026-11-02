// Native Issue card. It hangs beside a reply the way a display-only view does,
// and it only rearranges fields already on the card. Nothing here sends a message.
// `h` comes from a module that already imports React, so this file adds no new one.
import {
  canShowIssueCard,
  commentLabel,
  compareAction,
  discussionLine,
  headerLine,
  issueCardForTurn,
  issueShown,
  latestIssueCard,
  normalizeWidget,
  planAction,
} from '../shared/issue-card.js'

const ISSUE_FIELDS = [
  ['topic', '主题'],
  ['short', '短述'],
  ['priority', '优先级'],
  ['proposal', '方案'],
  ['decision', '未决'],
  ['step', '步骤'],
  ['accept', '验收'],
]

/**
 * @param {string} pane
 * @returns {'detail' | 'sources' | 'compare' | 'plan'}
 */
function knownPane(pane) {
  switch (pane) {
    case 'detail':
    case 'sources':
    case 'compare':
    case 'plan':
      return pane
    default:
      return 'detail'
  }
}

/**
 * @param {Function} h
 */
export function createIssueViews(h) {
  const focusedIssue = (card, widget) => card.issues.find(issue => issue.id === widget.focusId) ?? card.issues[0]

  const saveIssuePane = (actions, card, widget, patch) => {
    const save = actions?.saveIssueWidget
    if (typeof save !== 'function') return
    const next = normalizeWidget({ ...widget, ...patch }, card.issues)
    void Promise.resolve(save(card.callId, next)).catch(error => {
      actions.reportError?.(error, 'issue-card')
    })
  }

  const fieldLine = (issue, key, label) => {
    const value = issue?.[key]
    return h('p', { className: 'bt-issue-field', key },
      h('span', { className: 'bt-issue-k' }, label),
      h('span', { className: value ? 'bt-issue-v' : 'bt-issue-empty' }, issueShown(value)))
  }

  const conclusionLine = (card) => h('p', { className: 'bt-issue-field' },
    h('span', { className: 'bt-issue-k' }, '结论'),
    h('span', { className: card.conclusion ? 'bt-issue-v' : 'bt-issue-empty' }, issueShown(card.conclusion)))

  const detailPane = (card, widget) => {
    const issue = focusedIssue(card, widget)
    if (issue === undefined) return null
    return h('div', { className: 'bt-issue-pane' },
      conclusionLine(card),
      h('p', { className: 'bt-issue-k' }, `#${issue.number} ${issue.title}`),
      ISSUE_FIELDS.map(([key, label]) => fieldLine(issue, key, label)))
  }

  const sourcesPane = (card, widget) => {
    const issue = focusedIssue(card, widget)
    if (issue === undefined) return null
    return h('div', { className: 'bt-issue-pane' },
      h('p', { className: 'bt-issue-k' }, '原文摘录'),
      issue.body ? h('p', { className: 'bt-issue-excerpt' }, issue.body) : null,
      h('p', { className: 'bt-issue-meta' }, commentLabel(issue)),
      (issue.excerpts ?? []).map((excerpt, index) => h('p', { key: index, className: 'bt-issue-excerpt' }, excerpt)),
      issue.labels?.length > 0 ? h('p', { className: 'bt-issue-meta' }, issue.labels.join(' ')) : null)
  }

  const comparePane = (card, widget) => {
    const picked = card.issues.filter(issue => widget.selectedIds.includes(issue.id))
    return h('div', { className: 'bt-issue-pane' }, picked.map(issue => h('div', { key: issue.id, className: 'bt-issue-block' },
      h('p', { className: 'bt-issue-k' }, `#${issue.number} ${issue.title}`),
      ISSUE_FIELDS.map(([key, label]) => fieldLine(issue, key, label)))))
  }

  const planPane = (card, widget) => {
    const picked = card.issues.filter(issue => widget.selectedIds.includes(issue.id))
    return h('div', { className: 'bt-issue-pane' },
      conclusionLine(card),
      picked.map(issue => h('div', { key: issue.id, className: 'bt-issue-block' },
        h('p', { className: 'bt-issue-k' }, `#${issue.number} ${issue.title}`),
        fieldLine(issue, 'step', '步骤'),
        fieldLine(issue, 'accept', '验收'))))
  }

  /**
   * @param {'detail' | 'sources' | 'compare' | 'plan'} pane
   */
  const renderPane = (pane, card, widget) => {
    switch (pane) {
      case 'detail': return detailPane(card, widget)
      case 'sources': return sourcesPane(card, widget)
      case 'compare': return comparePane(card, widget)
      case 'plan': return planPane(card, widget)
      default: {
        /** @type {never} */
        const unexpected = pane
        throw new Error(`Unknown issue pane ${String(unexpected)}`)
      }
    }
  }

  const paneButton = (label, action, current, onPane) => {
    const disabled = action.type === 'disabled'
    const on = action.type === 'pane' && action.pane === current
    return h('button', {
      type: 'button',
      className: 'bt-issue-btn',
      disabled,
      'data-on': on || undefined,
      onClick: () => {
        if (action.type === 'pane') onPane(action.pane)
      },
    }, label)
  }

  function IssueCard({ callId, card: given, sessionId, roster, actions }) {
    const card = given ?? roster?.issueCards?.[callId]
    if (card == null) return null
    const where = sessionId ?? card.sessionId
    if (!canShowIssueCard(roster, where) || card.sessionId !== where) return null
    const widget = normalizeWidget(roster?.issueWidgets?.[card.callId], card.issues)
    const pane = knownPane(widget.pane)
    const onPane = (next) => saveIssuePane(actions, card, widget, { pane: next })
    return h('section', { className: 'bt-issue', role: 'region', 'aria-label': 'Issue 卡片', 'data-call-id': card.callId },
      h('p', { className: 'bt-issue-head' }, headerLine(card)),
      h('ul', { className: 'bt-issue-list' }, card.issues.map((issue) => {
        const selected = widget.selectedIds.includes(issue.id)
        return h('li', { key: issue.id, className: 'bt-issue-row' },
          h('input', {
            type: 'checkbox',
            checked: selected,
            'aria-label': `选择 #${issue.number}`,
            onClick: (event) => {
              event.preventDefault()
              event.stopPropagation()
              const selectedIds = selected
                ? widget.selectedIds.filter(id => id !== issue.id)
                : [...widget.selectedIds, issue.id]
              saveIssuePane(actions, card, widget, { selectedIds })
            },
          }),
          h('button', {
            type: 'button',
            className: 'bt-issue-title',
            'data-focus': issue.id === widget.focusId || undefined,
            onClick: () => saveIssuePane(actions, card, widget, { focusId: issue.id, pane: 'detail' }),
          }, `#${issue.number} ${issue.title}`),
          h('span', { className: 'bt-issue-meta' }, commentLabel(issue)))
      })),
      h('div', { className: 'bt-issue-actions' },
        paneButton('详情', { type: 'pane', pane: 'detail' }, pane, onPane),
        paneButton('原文', { type: 'pane', pane: 'sources' }, pane, onPane),
        paneButton('对比', compareAction(widget), pane, onPane),
        paneButton('方案', planAction(widget), pane, onPane)),
      renderPane(pane, card, widget))
  }

  function IssueTurnTail({ turn, sessionId, useRoster, actions }) {
    const roster = useRoster(value => value)
    const number = turn?.turn
    const card = typeof number === 'number' ? issueCardForTurn(roster?.issueCards, sessionId, number) : undefined
    if (card === undefined) return null
    return h(IssueCard, { card, sessionId, roster, actions })
  }

  function IssueScopeDock({ sessionId, useRoster }) {
    const roster = useRoster(value => value)
    if (!canShowIssueCard(roster, sessionId)) return null
    const card = latestIssueCard(roster?.issueCards, sessionId)
    if (card === undefined) return null
    const widget = normalizeWidget(roster?.issueWidgets?.[card.callId], card.issues)
    const line = discussionLine(card, widget)
    if (line === '当前讨论：') return null
    return h('p', { className: 'bt-issue-scope' }, line)
  }

  return { IssueCard, IssueTurnTail, IssueScopeDock }
}

export const ISSUE_CSS = `
.bt-issue{display:flex;flex-direction:column;gap:8px;margin:8px 0;padding:12px;background:var(--bt-card);box-shadow:inset 0 0 0 1px var(--bt-line)}
.bt-issue-head,.bt-issue-meta{color:var(--bt-ink-3);font-size:12px;line-height:18px}
.bt-issue-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
.bt-issue-row{display:flex;align-items:flex-start;gap:8px}
.bt-issue-title{flex:1;min-width:0;padding:0;border:0;background:transparent;color:var(--bt-ink);font:inherit;text-align:start;cursor:pointer}
.bt-issue-title[data-focus]{font-weight:600}
.bt-issue-actions{display:flex;flex-wrap:wrap;gap:8px}
.bt-issue-btn{border:0;background:var(--bt-hover);color:var(--bt-ink);font:inherit;font-size:13px;line-height:18px;padding:4px 8px;cursor:pointer}
.bt-issue-btn:disabled{opacity:.45;cursor:default}
.bt-issue-btn[data-on]{font-weight:600}
.bt-issue-pane,.bt-issue-block{display:flex;flex-direction:column;gap:6px}
.bt-issue-field{display:flex;gap:8px;margin:0}
.bt-issue-k{flex:none;color:var(--bt-ink-3);font-size:12px;line-height:18px}
.bt-issue-v,.bt-issue-excerpt{color:var(--bt-ink);white-space:pre-wrap}
.bt-issue-excerpt{margin:0}
.bt-issue-empty{color:var(--bt-ink-3)}
.bt-issue-scope{margin:0;padding:4px 0;font-size:13px;line-height:18px;color:var(--bt-ink-2)}
`
