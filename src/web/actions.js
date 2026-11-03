/**
 * Composio WRITE actions for Chief.
 *
 *  - risk 'direct'  : reversible (archive, read/unread, labels, draft, Slack reaction). Executed
 *                     immediately; the exact change is recorded so 撤销 restores the prior state.
 *  - risk 'confirm' : outgoing / irreversible (send, reply, post, comment, review, close, merge,
 *                     trash). The tool only creates a PENDING action; it runs only when the user
 *                     clicks 确认执行 in 豆芽 (owner-authenticated HTTP route). No bot tool confirms.
 *
 * Every executed action is appended to completions (kind 'action'). Slugs verified against the
 * Composio v3 tool list.
 */
import { randomUUID } from 'node:crypto'

const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s }

// ---- target parsing (Chief usually has item urls from odm_card_list) -------------------
export function gmailIdFromUrl(u) { return (String(u || '').match(/mail\.google\.com\/mail\/u\/\d+\/#[a-z]+\/([A-Za-z0-9]+)/) || [])[1] || null }
export function slackFromUrl(u) {
  const m = String(u || '').match(/slack\.com\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/)
  if (!m) return null
  const thread = (String(u).match(/[?&]thread_ts=([\d.]+)/) || [])[1] || null
  return { channel: m[1], ts: `${m[2]}.${m[3]}`, thread_ts: thread }
}
export function githubFromUrl(u) {
  const m = String(u || '').match(/github\.com\/([\w.-]+)\/([\w.-]+)\/(issues|pull)\/(\d+)/)
  return m ? { owner: m[1], repo: m[2], number: Number(m[4]), kind: m[3] === 'pull' ? 'pr' : 'issue' } : null
}

const S = { type: 'string' }
const gmailTarget = { url: { ...S, description: 'Gmail 条目链接（odm_card_list items[].url）' }, message_id: { ...S, description: '或直接给 message id' } }
const msgId = a => a.message_id || gmailIdFromUrl(a.url)
const ghT = a => { const g = githubFromUrl(a.url) || {}; return { owner: a.owner || g.owner, repo: a.repo || g.repo, number: Number(a.number || g.number) || null } }
const slT = a => { const s = slackFromUrl(a.url) || {}; return { channel: a.channel || s.channel, ts: a.timestamp || a.ts || s.ts, thread_ts: a.thread_ts || s.thread_ts || s.ts } }
const need = (cond, msg) => { if (!cond) throw new Error(msg) }

export const ACTIONS = {
  // ------------------------------ direct (reversible) ------------------------------
  gmail_archive: {
    risk: 'direct', desc: '归档一封邮件（移出收件箱，可撤销）', params: gmailTarget,
    label: a => `归档邮件 ${a.title ? `「${clip(a.title, 40)}」` : msgId(a)}`,
    labels: a => ({ message_id: msgId(a), add: [], remove: ['INBOX'] }),
  },
  gmail_mark_read: {
    risk: 'direct', desc: '把一封邮件标为已读（可撤销）', params: gmailTarget,
    label: a => `标为已读 ${a.title ? `「${clip(a.title, 40)}」` : msgId(a)}`,
    labels: a => ({ message_id: msgId(a), add: [], remove: ['UNREAD'] }),
  },
  gmail_mark_unread: {
    risk: 'direct', desc: '把一封邮件标为未读（可撤销）', params: gmailTarget,
    label: a => `标为未读 ${a.title ? `「${clip(a.title, 40)}」` : msgId(a)}`,
    labels: a => ({ message_id: msgId(a), add: ['UNREAD'], remove: [] }),
  },
  gmail_label: {
    risk: 'direct', desc: '给邮件加/去标签（label id，如 STARRED、IMPORTANT 或自定义 Label_x）', params: { ...gmailTarget, add_label_ids: { type: 'array', items: S }, remove_label_ids: { type: 'array', items: S } },
    label: a => `改标签 ${msgId(a)}：+${(a.add_label_ids || []).join(',') || '-'} −${(a.remove_label_ids || []).join(',') || '-'}`,
    labels: a => ({ message_id: msgId(a), add: a.add_label_ids || [], remove: a.remove_label_ids || [] }),
  },
  gmail_create_draft: {
    risk: 'direct', desc: '在 Gmail 里创建草稿（不发送；可撤销=删除草稿）', params: { recipient_email: { ...S, required: true }, subject: { ...S, required: true }, body: { ...S, required: true }, thread_id: S, cc: { type: 'array', items: S } },
    label: a => `创建草稿给 ${a.recipient_email}：「${clip(a.subject, 40)}」`,
    slug: 'GMAIL_CREATE_EMAIL_DRAFT',
    args: a => ({ user_id: 'me', recipient_email: a.recipient_email, subject: a.subject, body: a.body, ...(a.thread_id ? { thread_id: a.thread_id } : {}), ...(a.cc ? { cc: a.cc } : {}) }),
    undo: (a, res) => { const id = res?.data?.id || res?.data?.draft_id || res?.data?.response_data?.id; return id ? { slug: 'GMAIL_DELETE_DRAFT', args: { user_id: 'me', draft_id: id } } : null },
  },
  slack_add_reaction: {
    risk: 'direct', desc: '给 Slack 消息加表情回应（可撤销）', params: { url: { ...S, description: 'Slack 消息 permalink' }, channel: S, timestamp: S, name: { ...S, required: true, description: 'emoji 名，如 eyes、white_check_mark' } },
    label: a => `给 Slack 消息加 :${a.name}:`,
    slug: 'SLACK_ADD_REACTION_TO_AN_ITEM',
    args: a => { const t = slT(a); need(t.channel && t.ts, '缺 Slack 消息链接/channel+timestamp'); return { channel: t.channel, timestamp: t.ts, name: String(a.name || '').replace(/:/g, '') } },
    undo: (a, _r, args) => ({ slug: 'SLACK_REMOVE_REACTION_FROM_ITEM', args: { channel: args.channel, timestamp: args.timestamp, name: args.name } }),
  },

  // ------------------------------ confirm (outgoing / irreversible) ------------------------------
  gmail_send_email: {
    risk: 'confirm', desc: '发送一封新邮件（需用户在豆芽点确认）', params: { recipient_email: { ...S, required: true }, subject: { ...S, required: true }, body: { ...S, required: true }, cc: { type: 'array', items: S } },
    label: a => `发送邮件给 ${a.recipient_email}：「${clip(a.subject, 40)}」`,
    preview: a => ({ to: [a.recipient_email, ...(a.cc || [])], subject: a.subject, body: a.body }),
    slug: 'GMAIL_SEND_EMAIL',
    args: a => ({ user_id: 'me', recipient_email: a.recipient_email, subject: a.subject, body: a.body, ...(a.cc ? { cc: a.cc } : {}) }),
  },
  gmail_reply: {
    risk: 'confirm', desc: '回复一个邮件线程（需确认）', params: { thread_id: { ...S, required: true }, recipient_email: { ...S, required: true }, body: { ...S, required: true }, subject: S },
    label: a => `回复邮件给 ${a.recipient_email}${a.subject ? `：「${clip(a.subject, 40)}」` : ''}`,
    preview: a => ({ to: [a.recipient_email], subject: a.subject || '(回复线程)', body: a.body }),
    slug: 'GMAIL_REPLY_TO_THREAD',
    args: a => ({ user_id: 'me', thread_id: a.thread_id, recipient_email: a.recipient_email, message_body: a.body }),
  },
  gmail_trash: {
    risk: 'confirm', desc: '把邮件移到垃圾箱（需确认）', params: gmailTarget,
    label: a => `把邮件移到垃圾箱 ${a.title ? `「${clip(a.title, 40)}」` : msgId(a)}`,
    preview: a => ({ body: `移到垃圾箱：${a.title || msgId(a)}` }),
    slug: 'GMAIL_MOVE_TO_TRASH',
    args: a => { need(msgId(a), '缺邮件 id'); return { user_id: 'me', message_id: msgId(a) } },
  },
  slack_reply: {
    risk: 'confirm', desc: '在 Slack 里回复（线程内）或发消息（需确认）', params: { url: { ...S, description: '要回复的消息 permalink' }, channel: S, thread_ts: S, text: { ...S, required: true } },
    label: a => `在 Slack ${slT(a).channel || ''} 回复`,
    preview: a => ({ to: [`#${slT(a).channel}`], body: a.text }),
    slug: 'SLACK_CHAT_POST_MESSAGE',
    args: a => { const t = slT(a); need(t.channel, '缺 Slack channel'); return { channel: t.channel, text: a.text, ...(t.thread_ts ? { thread_ts: t.thread_ts } : {}) } },
  },
  github_comment: {
    risk: 'confirm', desc: '在 GitHub issue/PR 下评论（需确认）', params: { url: { ...S, description: 'issue/PR 链接' }, owner: S, repo: S, number: { type: 'number' }, body: { ...S, required: true } },
    label: a => { const g = ghT(a); return `评论 ${g.owner}/${g.repo}#${g.number}` },
    preview: a => { const g = ghT(a); return { to: [`${g.owner}/${g.repo}#${g.number}`], body: a.body } },
    slug: 'GITHUB_CREATE_AN_ISSUE_COMMENT',
    args: a => { const g = ghT(a); need(g.owner && g.repo && g.number, '缺 owner/repo/number'); return { owner: g.owner, repo: g.repo, issue_number: g.number, body: a.body } },
  },
  github_close_issue: {
    risk: 'confirm', desc: '关闭 GitHub issue（需确认）', params: { url: S, owner: S, repo: S, number: { type: 'number' }, reason: { ...S, description: 'completed | not_planned' } },
    label: a => { const g = ghT(a); return `关闭 ${g.owner}/${g.repo}#${g.number}` },
    preview: a => { const g = ghT(a); return { to: [`${g.owner}/${g.repo}#${g.number}`], body: `state → closed（${a.reason || 'completed'}）` } },
    slug: 'GITHUB_UPDATE_AN_ISSUE',
    args: a => { const g = ghT(a); need(g.owner && g.repo && g.number, '缺 owner/repo/number'); return { owner: g.owner, repo: g.repo, issue_number: g.number, state: 'closed', state_reason: a.reason || 'completed' } },
  },
  github_reopen_issue: {
    risk: 'confirm', desc: '重新打开 GitHub issue（需确认）', params: { url: S, owner: S, repo: S, number: { type: 'number' } },
    label: a => { const g = ghT(a); return `重新打开 ${g.owner}/${g.repo}#${g.number}` },
    preview: a => { const g = ghT(a); return { to: [`${g.owner}/${g.repo}#${g.number}`], body: 'state → open' } },
    slug: 'GITHUB_UPDATE_AN_ISSUE',
    args: a => { const g = ghT(a); need(g.owner && g.repo && g.number, '缺 owner/repo/number'); return { owner: g.owner, repo: g.repo, issue_number: g.number, state: 'open' } },
  },
  github_review: {
    risk: 'confirm', desc: '提交 PR review：APPROVE / REQUEST_CHANGES / COMMENT（需确认）', params: { url: S, owner: S, repo: S, number: { type: 'number' }, event: { ...S, required: true, enum: ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'] }, body: S },
    label: a => { const g = ghT(a); return `${{ APPROVE: '批准', REQUEST_CHANGES: '要求修改', COMMENT: '评审评论' }[a.event] || a.event} ${g.owner}/${g.repo}#${g.number}` },
    preview: a => { const g = ghT(a); return { to: [`${g.owner}/${g.repo}#${g.number}`], body: `${a.event}${a.body ? `\n\n${a.body}` : ''}` } },
    slug: 'GITHUB_CREATE_A_REVIEW_FOR_A_PULL_REQUEST',
    args: a => { const g = ghT(a); need(g.owner && g.repo && g.number, '缺 owner/repo/number'); return { owner: g.owner, repo: g.repo, pull_number: g.number, event: a.event, ...(a.body ? { body: a.body } : {}) } },
  },
  github_merge: {
    risk: 'confirm', desc: '合并 PR（需确认）', params: { url: S, owner: S, repo: S, number: { type: 'number' }, merge_method: { ...S, enum: ['merge', 'squash', 'rebase'] } },
    label: a => { const g = ghT(a); return `合并 ${g.owner}/${g.repo}#${g.number}（${a.merge_method || 'merge'}）` },
    preview: a => { const g = ghT(a); return { to: [`${g.owner}/${g.repo}#${g.number}`], body: `merge_method: ${a.merge_method || 'merge'}` } },
    slug: 'GITHUB_MERGE_A_PULL_REQUEST',
    args: a => { const g = ghT(a); need(g.owner && g.repo && g.number, '缺 owner/repo/number'); return { owner: g.owner, repo: g.repo, pull_number: g.number, ...(a.merge_method ? { merge_method: a.merge_method } : {}) } },
  },
}

function ok(res) {
  if (res && (res.successful === false || res.error)) throw new Error(typeof res.error === 'string' ? res.error : JSON.stringify(res.error || res).slice(0, 300))
  return res
}

/** Gmail label change that only touches labels that actually change, so undo is exact. */
async function runLabels(client, spec) {
  need(spec.message_id, '缺邮件 id（给 url 或 message_id）')
  let current = null
  try {
    const m = await client.executeAction('GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID', { user_id: 'me', message_id: spec.message_id, format: 'minimal' })
    current = m?.data?.labelIds || m?.data?.label_ids || m?.data?.response_data?.labelIds || null
  } catch { /* fall back to the requested diff */ }
  const has = l => (current ? current.includes(l) : null)
  const add = spec.add.filter(l => has(l) !== true)
  const remove = spec.remove.filter(l => has(l) !== false)
  if (!add.length && !remove.length) return { args: null, res: { noop: true }, undo: null, note: '状态本来就是这样，没有改动' }
  const args = { user_id: 'me', message_id: spec.message_id, add_label_ids: add, remove_label_ids: remove }
  const res = ok(await client.executeAction('GMAIL_ADD_LABEL_TO_EMAIL', args))
  return { args, res, undo: { slug: 'GMAIL_ADD_LABEL_TO_EMAIL', args: { user_id: 'me', message_id: spec.message_id, add_label_ids: remove, remove_label_ids: add } } }
}

/**
 * @param {{ store, getClient: () => any, log?: Function }} deps
 */
export function createActionService({ store, getClient, log = () => {} }) {
  const save = async mutate => { const state = store.get(); mutate(state); await store.save(state); return state }
  const pub = a => a && ({ id: a.id, action: a.action, risk: a.risk, status: a.status, summary: a.summary, preview: a.preview || null, cardId: a.cardId || null, createdAt: a.createdAt, executedAt: a.executedAt || null, undoneAt: a.undoneAt || null, error: a.error || null, note: a.note || null, canUndo: !!a.undo && a.status === 'executed' })
  const ledger = (state, a, verb) => {
    state.completions = [...(state.completions || []), { id: `cmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, kind: 'action', action: verb, actionName: a.action, actionId: a.id, title: a.summary, cardId: a.cardId || null, by: a.confirmedBy || 'bot', at: new Date().toISOString() }].slice(-500)
  }

  async function execute(a) {
    const def = ACTIONS[a.action]
    const client = getClient()
    if (!client) throw new Error('Composio 未配置：请到豆芽「配置」页填写 API Key，并在「信源状态」页连接信源')
    if (def.labels) return runLabels(client, def.labels(a.input))
    const args = def.args(a.input)
    const res = ok(await client.executeAction(def.slug, args))
    return { args, res, undo: def.undo ? def.undo(a.input, res, args) : null }
  }

  return {
    /** Called by bot tools. direct → runs now; confirm → pending only. */
    async request(action, input = {}, { cardId = null } = {}) {
      const def = ACTIONS[action]
      if (!def) return { success: false, error: `unknown action ${action}` }
      let summary
      try { summary = def.label(input) } catch (e) { return { success: false, error: e.message } }
      const a = { id: `act_${randomUUID().slice(0, 12)}`, action, risk: def.risk, input, summary, cardId: input.cardId || cardId, createdAt: new Date().toISOString(), status: 'pending' }
      if (def.risk === 'confirm') {
        try { def.args(input) } catch (e) { return { success: false, error: e.message } }
        a.preview = def.preview ? def.preview(input) : null
        await save(s => { s.pendingActions = { ...(s.pendingActions || {}), [a.id]: a } })
        log(`[actions] pending ${a.id} ${action}`)
        return { success: true, pending: true, actionId: a.id, summary, preview: a.preview, note: '已生成待确认操作。只有用户在豆芽聊天里点「确认执行」才会真正执行；你不能替用户确认。请告诉用户去点确认。' }
      }
      try {
        const r = await execute(a)
        Object.assign(a, { status: 'executed', executedAt: new Date().toISOString(), args: r.args, undo: r.undo, note: r.note || null, result: clip(JSON.stringify(r.res?.data ?? r.res ?? {}), 600) })
      } catch (e) {
        Object.assign(a, { status: 'failed', error: clip(e.message, 300) })
      }
      await save(s => { s.pendingActions = { ...(s.pendingActions || {}), [a.id]: a }; if (a.status === 'executed') ledger(s, a, 'executed') })
      log(`[actions] ${a.status} ${a.id} ${action}`)
      return a.status === 'executed' ? { success: true, executed: true, actionId: a.id, summary, note: a.note || '已执行，用户可在豆芽里撤销' } : { success: false, actionId: a.id, error: a.error }
    },

    /** User-only ops (HTTP route behind dsh owner auth). */
    async userOp({ op = 'list', id, dryRun = false, since = null } = {}) {
      const state = store.get()
      const all = state.pendingActions || {}
      if (op === 'list') {
        const list = Object.values(all).filter(a => !since || String(a.createdAt) >= String(since)).sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt))).slice(0, 30)
        return { success: true, actions: list.map(pub) }
      }
      const a = all[id]
      if (!a) return { success: false, error: '没有这个操作' }
      if (op === 'cancel') {
        if (a.status !== 'pending') return { success: false, error: `状态是 ${a.status}，不能取消`, action: pub(a) }
        await save(s => { s.pendingActions[id] = { ...a, status: 'cancelled', cancelledAt: new Date().toISOString() } })
        return { success: true, action: pub(store.get().pendingActions[id]) }
      }
      if (op === 'confirm') {
        if (a.status !== 'pending') return { success: false, error: `状态是 ${a.status}，不能再执行`, action: pub(a) }
        const def = ACTIONS[a.action]
        if (dryRun) return { success: true, dryRun: true, slug: def.slug, args: def.args(a.input), action: pub(a) }
        const next = { ...a, status: 'running', confirmedBy: 'user', confirmedAt: new Date().toISOString() }
        await save(s => { s.pendingActions[id] = next })
        try {
          const r = await execute(next)
          Object.assign(next, { status: 'executed', executedAt: new Date().toISOString(), args: r.args, undo: r.undo, result: clip(JSON.stringify(r.res?.data ?? r.res ?? {}), 600) })
        } catch (e) { Object.assign(next, { status: 'failed', error: clip(e.message, 300) }) }
        await save(s => { s.pendingActions[id] = next; if (next.status === 'executed') ledger(s, next, 'executed') })
        return { success: next.status === 'executed', action: pub(next), error: next.error || undefined }
      }
      if (op === 'undo') {
        if (a.status !== 'executed' || !a.undo) return { success: false, error: '这个操作不能撤销', action: pub(a) }
        const client = getClient()
        try { ok(await client.executeAction(a.undo.slug, a.undo.args)) } catch (e) { return { success: false, error: clip(e.message, 300), action: pub(a) } }
        const next = { ...a, status: 'undone', undoneAt: new Date().toISOString() }
        await save(s => { s.pendingActions[id] = next; ledger(s, { ...next, confirmedBy: 'user' }, 'undone') })
        return { success: true, action: pub(next) }
      }
      return { success: false, error: `unknown op ${op}` }
    },
  }
}
