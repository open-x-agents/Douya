import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyRoomStreamFrame, clearDraftIfPosted, draftForDisplay } from '../src/shared/room-draft.js'

test('text-delta accumulates into a live draft after start', () => {
  let draft = applyRoomStreamFrame(undefined, { type: 'start', attemptId: 'a1' }, { botId: 'b1' })
  assert.deepEqual(draft, { botId: 'b1', text: '', attemptId: 'a1' })
  draft = applyRoomStreamFrame(draft, { type: 'chunk', attemptId: 'a1', chunk: { type: 'text-delta', text: '秋' } }, { botId: 'b1' })
  draft = applyRoomStreamFrame(draft, { type: 'chunk', attemptId: 'a1', chunk: { type: 'text-delta', text: '天' } }, { botId: 'b1' })
  assert.equal(draft.text, '秋天')
  draft = applyRoomStreamFrame(draft, { type: 'end', attemptId: 'a1' }, { botId: 'b1' })
  assert.equal(draft.ended, true)
  assert.equal(draft.text, '秋天')
})

test('chunks from another attempt do not rewrite the current draft', () => {
  let draft = applyRoomStreamFrame(undefined, { type: 'start', attemptId: 'a1' }, { botId: 'b1' })
  draft = applyRoomStreamFrame(draft, { type: 'chunk', attemptId: 'a1', chunk: { type: 'text-delta', text: 'one' } }, { botId: 'b1' })
  const kept = applyRoomStreamFrame(draft, { type: 'chunk', attemptId: 'other', chunk: { type: 'text-delta', text: 'nope' } }, { botId: 'b1' })
  assert.equal(kept.text, 'one')
})

test('clearDraftIfPosted drops the draft once the same reply is committed', () => {
  const draft = { botId: 'b1', text: '秋天来了', attemptId: 'a1', ended: true }
  assert.equal(clearDraftIfPosted(draft, [{ botId: 'b1', text: '秋天来了' }]), undefined)
  assert.equal(clearDraftIfPosted(draft, [{ botId: 'b1', text: '秋天来了。全文。' }]), undefined)
  assert.deepEqual(clearDraftIfPosted(draft, [{ botId: 'b2', text: '秋天来了' }]), draft)
  assert.deepEqual(clearDraftIfPosted(draft, [{ kind: 'user', text: 'hi' }]), draft)
})

test('clearDraftIfPosted keeps empty start seed until posted or ended (room-progress race)', () => {
  // Repro: room-progress polls clearDraftIfPosted on the empty start seed and
  // used to write undefined back onto entry.draft, wiping attemptId before the
  // first text-delta. Keep the seed while still speaking / not ended.
  const seed = applyRoomStreamFrame(undefined, { type: 'start', attemptId: 'a1' }, { botId: 'b1' })
  assert.deepEqual(seed, { botId: 'b1', text: '', attemptId: 'a1' })
  assert.equal(clearDraftIfPosted(seed, []), seed)
  assert.equal(clearDraftIfPosted(seed, [{ kind: 'user', text: 'hi' }]), seed)
  assert.equal(clearDraftIfPosted(seed, [{ botId: 'b2', text: 'other' }]), seed)

  // Simulates channel.js write-back: only assign when clear returns a different value.
  let entry = { draft: seed, replies: [] }
  let draft = clearDraftIfPosted(entry.draft, entry.replies)
  if (draft !== entry.draft) entry.draft = draft
  assert.equal(entry.draft, seed)
  assert.equal(entry.draft.attemptId, 'a1')

  // Later text-deltas still accumulate on the preserved seed.
  entry.draft = applyRoomStreamFrame(entry.draft, { type: 'chunk', attemptId: 'a1', chunk: { type: 'text-delta', text: '秋' } }, { botId: 'b1' })
  entry.draft = applyRoomStreamFrame(entry.draft, { type: 'chunk', attemptId: 'a1', chunk: { type: 'text-delta', text: '天' } }, { botId: 'b1' })
  assert.equal(entry.draft.text, '秋天')
  draft = clearDraftIfPosted(entry.draft, entry.replies)
  if (draft !== entry.draft) entry.draft = draft
  assert.equal(entry.draft.text, '秋天')

  // After end with no matching reply yet, keep the draft with text.
  entry.draft = applyRoomStreamFrame(entry.draft, { type: 'end', attemptId: 'a1' }, { botId: 'b1' })
  assert.equal(clearDraftIfPosted(entry.draft, entry.replies)?.text, '秋天')

  // Empty ended seed (no tokens) may be cleared.
  const emptyEnded = { botId: 'b1', text: '', attemptId: 'a1', ended: true }
  assert.equal(clearDraftIfPosted(emptyEnded, []), undefined)

  // Once the reply is posted, drop as before.
  assert.equal(clearDraftIfPosted(entry.draft, [{ botId: 'b1', text: '秋天' }]), undefined)
})

test('draftForDisplay hides empty seed and posted drafts', () => {
  const seed = { botId: 'b1', text: '', attemptId: 'a1' }
  assert.equal(draftForDisplay(seed, []), undefined)
  const draft = { botId: 'b1', text: 'hello' }
  assert.equal(draftForDisplay(draft, [{ botId: 'b1', text: 'hello' }]), undefined)
  assert.deepEqual(draftForDisplay(draft, []), draft)
})
