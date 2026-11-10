import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createActionService, githubTarget } from '../src/web/actions.js'

function fakes(labels = ['INBOX', 'UNREAD']) {
  let state = { completions: [], pendingActions: {} }
  const calls = []
  const store = { get: () => state, save: async s => { state = { ...s } } }
  const client = {
    async executeAction(slug, args) {
      calls.push([slug, args])
      if (slug === 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID') return { successful: true, data: { labelIds: labels } }
      if (slug === 'GMAIL_CREATE_EMAIL_DRAFT') return { successful: true, data: { id: 'r-123' } }
      return { successful: true, data: {} }
    },
  }
  return { svc: createActionService({ store, getClient: () => client }), calls, state: () => state }
}

test('outgoing actions only become pending; nothing is sent until the user confirms', async () => {
  const f = fakes()
  const r = await f.svc.request('gmail_send_email', { recipient_email: 'a@b.c', subject: 'Hi', body: 'x' })
  assert.equal(r.pending, true)
  assert.equal(f.calls.length, 0)
  const dry = await f.svc.userOp({ op: 'confirm', id: r.actionId, dryRun: true })
  assert.equal(dry.slug, 'GMAIL_SEND_EMAIL')
  assert.equal(f.calls.length, 0)
  const c = await f.svc.userOp({ op: 'cancel', id: r.actionId })
  assert.equal(c.action.status, 'cancelled')
  const again = await f.svc.userOp({ op: 'confirm', id: r.actionId })
  assert.equal(again.success, false)
  assert.equal(f.calls.length, 0)
})

test('confirm executes exactly once and is logged', async () => {
  const f = fakes()
  const r = await f.svc.request('github_comment', { url: 'https://github.com/o/r/issues/7', body: 'LGTM' })
  const c = await f.svc.userOp({ op: 'confirm', id: r.actionId })
  assert.equal(c.action.status, 'executed')
  assert.deepEqual(f.calls[0], ['GITHUB_CREATE_AN_ISSUE_COMMENT', { owner: 'o', repo: 'r', issue_number: 7, body: 'LGTM' }])
  assert.equal((await f.svc.userOp({ op: 'confirm', id: r.actionId })).success, false)
  assert.equal(f.calls.length, 1)
  assert.ok(f.state().completions.some(x => x.kind === 'action' && x.actionId === r.actionId))
})

test('reversible label change records only the real diff, and undo restores it', async () => {
  const f = fakes(['INBOX']) // already read
  const r = await f.svc.request('gmail_mark_read', { url: 'https://mail.google.com/mail/u/0/#inbox/abc' })
  assert.equal(r.executed, true)
  assert.equal(f.calls.filter(c => c[0] === 'GMAIL_ADD_LABEL_TO_EMAIL').length, 0) // noop: nothing to change
  const a = await f.svc.request('gmail_archive', { url: 'https://mail.google.com/mail/u/0/#inbox/abc' })
  const mod = f.calls.find(c => c[0] === 'GMAIL_ADD_LABEL_TO_EMAIL')
  assert.deepEqual(mod[1].remove_label_ids, ['INBOX'])
  const u = await f.svc.userOp({ op: 'undo', id: a.actionId })
  assert.equal(u.action.status, 'undone')
  const back = f.calls.filter(c => c[0] === 'GMAIL_ADD_LABEL_TO_EMAIL').at(-1)[1]
  assert.deepEqual(back.add_label_ids, ['INBOX'])
  assert.deepEqual(back.remove_label_ids, [])
})

test('draft undo deletes the created draft', async () => {
  const f = fakes()
  const r = await f.svc.request('gmail_create_draft', { recipient_email: 'me@x.y', subject: 's', body: 'b' })
  await f.svc.userOp({ op: 'undo', id: r.actionId })
  assert.deepEqual(f.calls.at(-1), ['GMAIL_DELETE_DRAFT', { user_id: 'me', draft_id: 'r-123' }])
})

test('githubTarget prefers an explicit number over a conflicting url (focused card vs named issue)', () => {
  const t = githubTarget({ url: 'https://github.com/Birfy/jitagent/issues/16', number: 19, body: 'hi' })
  assert.deepEqual({ owner: t.owner, repo: t.repo, number: t.number }, { owner: 'Birfy', repo: 'jitagent', number: 19 })
})

test('githubTarget uses the url number when no explicit number is given', () => {
  const t = githubTarget({ url: 'https://github.com/Birfy/jitagent/pull/16' })
  assert.equal(t.number, 16)
  assert.equal(t.kind, 'pr')
})

test('github_comment summary and preview use the same resolved target as the execute args', async () => {
  const f = fakes()
  const r = await f.svc.request('github_comment', { url: 'https://github.com/Birfy/jitagent/issues/16', number: 19, body: '请看这一步' })
  assert.equal(r.pending, true)
  assert.equal(r.summary, '评论 Birfy/jitagent#19')
  assert.deepEqual(r.preview.to, ['Birfy/jitagent#19'])
  const c = await f.svc.userOp({ op: 'confirm', id: r.actionId })
  assert.equal(c.action.status, 'executed')
  assert.deepEqual(f.calls[0], ['GITHUB_CREATE_AN_ISSUE_COMMENT', { owner: 'Birfy', repo: 'jitagent', issue_number: 19, body: '请看这一步' }])
})
