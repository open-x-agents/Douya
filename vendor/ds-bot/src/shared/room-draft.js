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
export function clearDraftIfPosted(draft, replies = []) {
  if (draft === undefined || draft === null) return undefined
  if (draft.botId === undefined) return undefined
  const text = typeof draft.text === 'string' ? draft.text : ''
  if (text === '') return undefined
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
export function draftForDisplay(draft, replies = []) {
  return clearDraftIfPosted(draft, replies)
}
