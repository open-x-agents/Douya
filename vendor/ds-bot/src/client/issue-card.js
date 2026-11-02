// Native Issue brief. Layout follows the issue-triage prototype: heading, theme
// chips, a list beside a tabbed work area, a scope bar, and a local follow-up
// strip. It only rearranges fields already on the card. The strip does not send.
// `h` and `useState` come from a module that already imports React.
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

const TABS = [
  ['detail', '提炼与详情'],
  ['sources', '讨论依据'],
  ['compare', '对比所选'],
  ['plan', '实施计划'],
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
 * @param {Function} useState
 */
export function createIssueViews(h, useState) {
  const focusedIssue = (card, widget) => card.issues.find(issue => issue.id === widget.focusId) ?? card.issues[0]

  const themesOf = (issues) => {
    const counts = new Map()
    for (const issue of issues) {
      const topic = typeof issue.topic === 'string' ? issue.topic.trim() : ''
      if (topic === '') continue
      counts.set(topic, (counts.get(topic) ?? 0) + 1)
    }
    return [...counts.entries()]
  }

  const saveIssuePane = (actions, card, widget, patch) => {
    const save = actions?.saveIssueWidget
    if (typeof save !== 'function') return
    const next = normalizeWidget({ ...widget, ...patch }, card.issues)
    void Promise.resolve(save(card.callId, next)).catch(error => {
      actions.reportError?.(error, 'issue-card')
    })
  }

  const section = (title, body, extra) => h('div', { className: 'it-section' },
    h('h4', null, title),
    h('p', null, body),
    extra ?? null)

  const detailPane = (card, widget, onPane) => {
    const issue = focusedIssue(card, widget)
    if (issue === undefined) return null
    return h('div', null,
      h('span', { className: 'it-small' }, `#${issue.number} · ${commentLabel(issue)}`),
      h('h3', null, issue.title),
      h('div', { className: 'it-note' },
        h('span', { className: 'it-small' }, '一句话提炼'),
        h('p', null, issueShown(issue.short))),
      issue.body ? section('问题背景', issue.body) : null,
      section(h('span', null, '建议方案 ', h('span', { className: 'it-small' }, '· 模型引用')), issueShown(issue.proposal)),
      section('还需要决定', issueShown(issue.decision)),
      issue.priority ? h('p', { className: 'it-small' }, `优先级 ${issue.priority}`) : null,
      h('button', { type: 'button', className: 'it-ghost', onClick: () => onPane('sources') }, '查看原始讨论 →'))
  }

  const sourcesPane = (card, widget) => {
    const issue = focusedIssue(card, widget)
    if (issue === undefined) return null
    const excerpts = issue.excerpts ?? []
    return h('div', null,
      h('span', { className: 'it-small' }, `#${issue.number} · ${commentLabel(issue)}`),
      h('h3', null, '结论从哪里来'),
      issue.body ? h('div', { className: 'it-section' },
        h('h4', null, 'Issue 正文'),
        h('p', null, issue.body)) : null,
      excerpts.length > 0 ? h('div', { className: 'it-section' },
        h('h4', null, '评论摘录'),
        excerpts.map((excerpt, index) => h('div', { key: index, className: 'it-quote' }, excerpt))) : null,
      issue.labels?.length > 0 ? h('p', { className: 'it-small' }, issue.labels.join(' ')) : null,
      h('div', { className: 'it-note' },
        h('h4', null, '提炼边界'),
        h('p', null, '正文和评论只显示已经读到的摘录。结论、方案、步骤和验收只显示模型在这一回合里写明的引用。')))
  }

  const comparePane = (card, widget) => {
    const picked = card.issues.filter(issue => widget.selectedIds.includes(issue.id))
    if (picked.length < 2) {
      return h('div', null,
        h('h3', null, '把关键差异放在一起'),
        h('p', { className: 'it-empty' }, '请从左侧勾选至少两条记录。'))
    }
    return h('div', null,
      h('span', { className: 'it-small' }, `${picked.length} 条所选记录`),
      h('h3', null, '已有字段对照'),
      h('table', null,
        h('thead', null, h('tr', null,
          h('th', null, '事项'),
          h('th', null, '优先级'),
          h('th', null, '方案'))),
        h('tbody', null, picked.map(issue => h('tr', { key: issue.id },
          h('td', null, h('h4', null, `#${issue.number} ${issue.title}`), issueShown(issue.short)),
          h('td', null, issueShown(issue.priority)),
          h('td', null, issueShown(issue.proposal)))))),
      h('div', { className: 'it-note' },
        h('h4', null, '如何看这张表'),
        h('p', null, '表里只有卡片上已经有的字段。没有的格子是「还没有提炼」，这里不新开一轮。')))
  }

  const planPane = (card, widget) => {
    const picked = card.issues.filter(issue => widget.selectedIds.includes(issue.id))
    if (picked.length === 0) {
      return h('div', null,
        h('h3', null, '从选择开始制定计划'),
        h('p', { className: 'it-empty' }, '先勾选要推进的事项，再看实施计划。'))
    }
    return h('div', null,
      h('span', { className: 'it-small' }, `基于所选 ${picked.length} 条 · 本地草稿`),
      h('h3', null, '把选择变成下一步'),
      picked.map((issue, index) => h('div', { key: issue.id, className: 'it-step' },
        h('span', { className: 'it-num' }, String(index + 1)),
        h('div', null,
          h('h4', null, issueShown(issue.step)),
          h('span', { className: 'it-small' }, `关联 #${issue.number}`),
          h('p', null, issueShown(issue.proposal)),
          h('span', { className: 'it-small' }, `验收：${issueShown(issue.accept)}`)))),
      h('div', { className: 'it-note' },
        h('span', { className: 'it-small' }, '未发布'),
        h('p', null, '这是本地排列，没有写回 GitHub，也不估算工期。')))
  }

  /**
   * @param {'detail' | 'sources' | 'compare' | 'plan'} pane
   */
  const renderPane = (pane, card, widget, onPane) => {
    switch (pane) {
      case 'detail': return detailPane(card, widget, onPane)
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

  function IssueCard({ callId, card: given, sessionId, roster, actions }) {
    const [box, setBox] = useState({ id: '', draft: '', text: '' })
    const card = given ?? roster?.issueCards?.[callId]
    if (card == null) return null
    const where = sessionId ?? card.sessionId
    if (!canShowIssueCard(roster, where) || card.sessionId !== where) return null
    const widget = normalizeWidget(roster?.issueWidgets?.[card.callId], card.issues)
    const pane = knownPane(widget.pane)
    const view = box.id === card.callId ? box : { id: card.callId, draft: '', text: '' }
    const setView = (patch) => setBox((current) => {
      const base = current.id === card.callId ? current : { id: card.callId, draft: '', text: '' }
      return { ...base, ...patch, id: card.callId }
    })
    const onPane = (next) => saveIssuePane(actions, card, widget, { pane: next })
    const themes = themesOf(card.issues)
    const shown = card.issues.filter(issue => widget.filter === 'all' || issue.topic?.trim() === widget.filter)
    const hiddenSelected = widget.selectedIds.filter(id => !shown.some(issue => issue.id === id)).length
    const onFilter = (filter) => {
      const visible = card.issues.filter(issue => filter === 'all' || issue.topic?.trim() === filter)
      const patch = { filter }
      if (visible.length > 0 && !visible.some(issue => issue.id === widget.focusId)) patch.focusId = visible[0].id
      saveIssuePane(actions, card, widget, patch)
    }
    const ask = (question) => {
      const picked = widget.selectedIds.length > 0
        ? card.issues.filter(issue => widget.selectedIds.includes(issue.id))
        : [focusedIssue(card, widget)].filter(Boolean)
      if (/计划|先做|安排/.test(question)) {
        const selectedIds = widget.selectedIds.length > 0 ? widget.selectedIds : (widget.focusId ? [widget.focusId] : [])
        saveIssuePane(actions, card, widget, { selectedIds, pane: 'plan' })
        setView({ draft: '', text: '已按当前选择打开实施计划。计划只排列已有字段，没有调用模型。' })
        return
      }
      const lines = /验收|测试/.test(question)
        ? picked.map(issue => `#${issue.number}：${issueShown(issue.accept)}`)
        : (/为什么|优先/.test(question)
          ? picked.map(issue => `#${issue.number}：${issueShown(issue.priority)}。${issueShown(issue.proposal)}`)
          : [`这次追问绑定到 ${picked.map(issue => `#${issue.number}`).join('、') || '当前记录'}。界面不调用模型；主输入框发送时会带上这个范围。`])
      setView({ draft: '', text: lines.join('\n') })
    }
    const selection = widget.selectedIds.length > 0
      ? `已选 ${widget.selectedIds.length} 条 · ${widget.selectedIds.map(id => `#${card.issues.find(issue => issue.id === id)?.number ?? id}`).join('、')}`
      : '尚未勾选 Issue'
    const compare = compareAction(widget)
    const plan = planAction(widget)
    return h('section', { className: 'bt-issue it-app', role: 'region', 'aria-label': 'Issue 简报', 'data-call-id': card.callId },
      h('header', { className: 'it-top' },
        h('span', { className: 'it-brand' }, 'DigitalMate'),
        h('span', { className: 'it-small' }, 'Issue 简报'),
        h('span', { className: 'it-small' }, '只读')),
      h('section', { className: 'it-heading' },
        h('div', { className: 'it-request' }, headerLine(card)),
        h('h2', null, card.conclusion?.trim() ? card.conclusion : 'Issue 简报'),
        h('p', null,
          themes.length > 0 ? `${card.issues.length} 条记录，聚合为 ${themes.length} 个主题。` : `${card.issues.length} 条记录。`,
          ' ',
          h('span', { className: 'it-small' }, '只读 · 未写回')),
        h('div', { className: 'it-chips', 'aria-label': '按主题查看' },
          h('button', {
            type: 'button',
            'aria-pressed': widget.filter === 'all',
            onClick: () => onFilter('all'),
          }, `全部 ${card.issues.length}`),
          themes.map(([topic, count]) => h('button', {
            key: topic,
            type: 'button',
            'aria-pressed': widget.filter === topic,
            onClick: () => onFilter(topic),
          }, `${topic} ${count}`)))),
      h('div', { className: 'it-layout' },
        h('aside', { className: 'it-list', 'aria-label': 'Issue 列表' },
          h('div', { className: 'it-list-head' },
            h('span', { className: 'it-small' }, `${shown.length} 条记录`),
            h('span', { className: 'it-small' }, '勾选比较 · 点击阅读')),
          shown.map((issue) => {
            const selected = widget.selectedIds.includes(issue.id)
            const priority = typeof issue.priority === 'string' ? issue.priority.trim() : ''
            const short = typeof issue.short === 'string' ? issue.short.trim() : ''
            return h('div', { key: issue.id, className: 'it-item', 'data-active': issue.id === widget.focusId },
              h('label', { className: 'it-select' },
                h('input', {
                  type: 'checkbox',
                  checked: selected,
                  'aria-label': `选择 #${issue.number}：${issue.title}`,
                  onClick: (event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    const selectedIds = selected
                      ? widget.selectedIds.filter(id => id !== issue.id)
                      : [...widget.selectedIds, issue.id]
                    saveIssuePane(actions, card, widget, { selectedIds })
                  },
                })),
              h('button', {
                type: 'button',
                className: 'it-open',
                'aria-pressed': issue.id === widget.focusId,
                onClick: () => saveIssuePane(actions, card, widget, { focusId: issue.id, pane: 'detail' }),
              },
              h('span', { className: 'it-small' }, `#${issue.number}`,
                priority !== '' ? h('span', { className: 'it-priority' }, priority) : null),
              h('span', { className: 'it-name' }, issue.title),
              short !== '' ? h('span', { className: 'it-description' }, short) : null))
          })),
        h('section', { className: 'it-work', 'aria-label': 'Issue 工作区' },
          h('div', { className: 'it-tabs', 'aria-label': '工作区视图' }, TABS.map(([id, label]) => h('button', {
            key: id,
            type: 'button',
            'aria-pressed': pane === id,
            onClick: () => onPane(id),
          }, label))),
          renderPane(pane, card, widget, onPane))),
      h('div', { className: 'it-scope' },
        h('div', null,
          h('span', null, selection),
          h('div', { className: 'it-small' }, hiddenSelected > 0
            ? `${hiddenSelected} 条位于其他主题，仍保留在选择中`
            : '选择将同步到比较、计划与后续对话')),
        h('div', { className: 'it-actions' },
          h('button', {
            type: 'button',
            disabled: compare.type === 'disabled',
            onClick: () => { if (compare.type === 'pane') onPane(compare.pane) },
          }, '比较所选'),
          h('button', {
            type: 'button',
            className: 'it-primary',
            disabled: plan.type === 'disabled',
            onClick: () => { if (plan.type === 'pane') onPane(plan.pane) },
          }, '生成实施计划'))),
      h('section', { className: 'it-conversation', 'aria-label': '继续对话' },
        h('div', { className: 'it-small' }, discussionLine(card, widget)),
        h('div', { className: 'it-actions' },
          h('button', { type: 'button', className: 'it-ghost', onClick: () => ask('为什么优先做？') }, '为什么优先做？'),
          h('button', { type: 'button', className: 'it-ghost', onClick: () => ask('拆成验收清单') }, '拆成验收清单')),
        h('form', {
          className: 'it-composer',
          onSubmit: (event) => {
            event.preventDefault()
            const question = view.draft.trim()
            if (question === '') return
            ask(question)
          },
        },
        h('input', {
          'aria-label': '继续讨论所选 Issue',
          placeholder: '勾选两条后，说“先做这两个”',
          autoComplete: 'off',
          value: view.draft,
          onChange: (event) => setView({ draft: event.target.value }),
        }),
        h('button', { className: 'it-primary', type: 'submit' }, '发送')),
        view.text !== '' ? h('div', { className: 'it-response', 'aria-live': 'polite' }, view.text) : null))
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
.bt-issue{margin:8px 0;color:var(--bt-ink);font:14px/1.65 var(--bt-font)}
.bt-issue *{box-sizing:border-box}
.bt-issue.it-app{background:var(--bt-main);border:1px solid var(--bt-line);border-radius:16px;overflow:hidden;container-type:inline-size}
.bt-issue .it-top{padding:17px 24px;background:var(--bt-card);border-bottom:1px solid var(--bt-line);display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.bt-issue .it-brand{font-size:17px;font-weight:500;letter-spacing:-.4px}
.bt-issue .it-small{font-size:12px;color:var(--bt-ink-3)}
.bt-issue .it-heading{padding:24px 28px 20px}
.bt-issue .it-request{color:var(--bt-ink-3);font-size:13px;margin-bottom:10px}
.bt-issue h2{font:500 26px/1.45 var(--bt-font);margin:0 0 10px;letter-spacing:-.6px;color:var(--bt-ink)}
.bt-issue h3{font:500 19px/1.5 var(--bt-font);margin:6px 0 12px;color:var(--bt-ink)}
.bt-issue h4{font:500 14px/1.65 var(--bt-font);margin:0 0 5px;color:var(--bt-ink)}
.bt-issue p{margin:6px 0 14px}
.bt-issue button,.bt-issue input,.bt-issue textarea{font:inherit;color:var(--bt-ink)}
.bt-issue button{background:var(--bt-card);border:1px solid var(--bt-line);border-radius:8px;padding:7px 12px;min-height:36px;cursor:pointer}
.bt-issue button:disabled{opacity:.45;cursor:default}
.bt-issue button[aria-pressed="true"]{background:color-mix(in srgb,var(--bt-green) 18%,var(--bt-card));border-color:var(--bt-green)}
.bt-issue .it-primary{background:var(--bt-green);color:var(--bt-card);border-color:var(--bt-green)}
.bt-issue .it-ghost{background:transparent;border-color:transparent}
.bt-issue .it-chips,.bt-issue .it-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.bt-issue .it-chips{margin-top:16px}
.bt-issue .it-layout{display:grid;grid-template-columns:minmax(285px,.94fr) minmax(0,1.35fr);border-top:1px solid var(--bt-line)}
.bt-issue .it-list{border-right:1px solid var(--bt-line);padding:18px 16px 14px;min-width:0}
.bt-issue .it-list-head{display:flex;justify-content:space-between;gap:8px;padding:0 8px 10px}
.bt-issue .it-item{display:flex;align-items:flex-start;gap:10px;border-radius:8px;padding:12px 10px;margin:3px 0;border:1px solid transparent}
.bt-issue .it-item[data-active="true"]{background:var(--bt-card);border-color:var(--bt-line)}
.bt-issue .it-select{display:flex;align-items:center;justify-content:center;min-height:32px;min-width:24px}
.bt-issue input[type="checkbox"]{width:16px;height:16px;margin:0;accent-color:var(--bt-green)}
.bt-issue .it-open{display:block;text-align:left;padding:0;border:0;background:transparent;flex:1;min-width:0;min-height:0}
.bt-issue .it-open[aria-pressed="true"]{background:transparent;border-color:transparent}
.bt-issue .it-name{display:block;font-weight:500;margin:3px 0}
.bt-issue .it-description{display:block;font-size:12px;color:var(--bt-ink-3)}
.bt-issue .it-priority{color:var(--bt-star);margin-left:6px}
.bt-issue .it-work{padding:22px 26px 24px;background:var(--bt-card);min-width:0}
.bt-issue .it-tabs{display:flex;gap:5px;flex-wrap:wrap;padding-bottom:14px;border-bottom:1px solid var(--bt-line);margin-bottom:17px}
.bt-issue .it-tabs button{font-size:13px}
.bt-issue .it-section{padding:14px 0;border-bottom:1px solid var(--bt-line)}
.bt-issue .it-section:last-child{border:0}
.bt-issue .it-section p:last-child{margin-bottom:0}
.bt-issue .it-note{padding:13px 15px;background:color-mix(in srgb,var(--bt-green) 16%,var(--bt-card));border-radius:8px;margin:16px 0}
.bt-issue .it-note p:last-child{margin-bottom:0}
.bt-issue .it-quote{border-left:3px solid var(--bt-line);padding:0 0 0 14px;margin:12px 0;color:var(--bt-ink-3);white-space:pre-wrap}
.bt-issue .it-scope{display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap;padding:13px 24px;background:color-mix(in srgb,var(--bt-green) 16%,var(--bt-card));border-top:1px solid var(--bt-line)}
.bt-issue .it-conversation{padding:18px 24px 22px;background:var(--bt-card);border-top:1px solid var(--bt-line)}
.bt-issue .it-composer{display:flex;gap:10px;margin-top:10px;align-items:center}
.bt-issue .it-composer input{width:100%;min-width:0;border:1px solid var(--bt-line);border-radius:8px;padding:11px 13px;background:var(--bt-main)}
.bt-issue .it-response{padding:12px 15px;background:var(--bt-main);border-radius:8px;margin-top:13px;white-space:pre-line}
.bt-issue .it-step{display:flex;gap:12px;padding:15px 0;border-bottom:1px solid var(--bt-line)}
.bt-issue .it-num{background:color-mix(in srgb,var(--bt-green) 16%,var(--bt-card));color:var(--bt-green);border-radius:50%;width:27px;height:27px;flex:0 0 27px;display:flex;align-items:center;justify-content:center}
.bt-issue table{border-collapse:collapse;width:100%;font-size:13px;table-layout:fixed}
.bt-issue th,.bt-issue td{padding:11px 7px;border-bottom:1px solid var(--bt-line);vertical-align:top;text-align:left;overflow-wrap:anywhere;font-weight:400}
.bt-issue th{color:var(--bt-ink-3);font-size:12px}
.bt-issue .it-empty{padding:45px 5px;color:var(--bt-ink-3)}
.bt-issue-scope{margin:0;padding:4px 0;font-size:13px;line-height:18px;color:var(--bt-ink-2)}
@container(max-width:680px){
.bt-issue .it-layout{grid-template-columns:1fr}
.bt-issue .it-list{border-right:0;border-bottom:1px solid var(--bt-line)}
.bt-issue .it-heading,.bt-issue .it-work{padding:20px 18px}
.bt-issue .it-top,.bt-issue .it-scope,.bt-issue .it-conversation{padding:16px}
.bt-issue h2{font-size:23px}
.bt-issue button{min-height:44px}
.bt-issue .it-select{min-height:44px;min-width:30px}
.bt-issue .it-composer input{font-size:16px}
}
@media(max-width:680px){
.bt-issue .it-layout{grid-template-columns:1fr}
.bt-issue .it-list{border-right:0;border-bottom:1px solid var(--bt-line)}
.bt-issue .it-heading,.bt-issue .it-work{padding:20px 18px}
.bt-issue .it-top{padding:16px 18px}
.bt-issue h2{font-size:23px}
.bt-issue .it-scope,.bt-issue .it-conversation{padding:16px}
.bt-issue button{min-height:44px}
.bt-issue .it-select{min-height:44px;min-width:30px}
.bt-issue .it-composer input{font-size:16px}
}
`
