// Live draft text for a group member that is speaking: accumulates text-delta
// from agent/assistant-stream, then clears when the reply is posted so the
// final room log / round.replies line is not double-rendered.

export function applyRoomStreamFrame(draft, frame, { botId } = {}) {
  if (frame?.type === 'start') {
    return { botId, text: '', attemptId: frame.attemptId }
  }
  if (draft === undefined || draft === null) return draft
  if (frame?.attemptId !== undefined && draft.attemptId !== undefined && frame.attemptId !== draft.attemptId) {
    return draft
  }
  if (frame?.type === 'chunk' && frame.chunk?.type === 'text-delta') {
    const piece = typeof frame.chunk.text === 'string' ? frame.chunk.text : ''
    if (piece === '') return draft
    return { ...draft, text: `${draft.text ?? ''}${piece}` }
  }
  if (frame?.type === 'end') {
    return { ...draft, ended: true }
  }
  return draft
}

// Drop a live draft once its text has been committed into the round replies /
// room log, so the UI does not keep a streaming row beside the final bubble.
// Empty start seeds (text === '', attemptId set, not ended) MUST be kept:
// room-progress polls call this and write the result back onto entry.draft;
// wiping the seed loses attemptId and later text-deltas hit
// applyRoomStreamFrame(undefined, …) and are ignored.
export function clearDraftIfPosted(draft, replies = []) {
  if (draft === undefined || draft === null) return undefined
  if (draft.botId === undefined) return undefined
  const text = typeof draft.text === 'string' ? draft.text : ''
  if (text === '') return draft.ended ? undefined : draft
  for (let i = replies.length - 1; i >= 0; i -= 1) {
    const reply = replies[i]
    if (reply?.kind !== undefined) continue
    if (reply?.botId !== draft.botId) continue
    const posted = typeof reply.text === 'string' ? reply.text : ''
    if (posted === text || posted.startsWith(text) || text.startsWith(posted)) return undefined
    break
  }
  return draft
}

// Client-side: whether a live draft should render as a temporary streaming row.
// Empty seeds stay in memory for attemptId, but the UI still hides them until
// the first text-delta (draft?.text is checked by GroupMessage callers too).
export function draftForDisplay(draft, replies = []) {
  const kept = clearDraftIfPosted(draft, replies)
  if (kept === undefined || kept === null) return undefined
  const text = typeof kept.text === 'string' ? kept.text : ''
  if (text === '') return undefined
  return kept
}
