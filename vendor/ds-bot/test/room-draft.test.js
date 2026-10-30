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

test('draftForDisplay hides a temporary row after dedupe', () => {
  const draft = { botId: 'b1', text: 'hello' }
  assert.equal(draftForDisplay(draft, [{ botId: 'b1', text: 'hello' }]), undefined)
  assert.deepEqual(draftForDisplay(draft, []), draft)
})
