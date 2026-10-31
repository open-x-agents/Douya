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

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Same leading-name rule as groups.js stripOwnName. The committed bubble may
// still wear `Name：` or `**Name**：` after the draft text has been trimmed.
function stripLeadingName(name, text) {
  if (typeof name !== 'string' || name === '') return text
  return text.replace(new RegExp(`^\\s*\\**${escapeRegExp(name)}\\**\\s*[:：]\\s*`), '').trim()
}

// Committed text covers the draft when it is the draft or begins with the
// whole draft (a longer final, including one whose only difference is
// whitespace). A shorter prefix does not cover an unposted tail.
function postedCoversDraft(posted, text) {
  if (posted === '' || text === '') return false
  const left = posted.trim()
  const right = text.trim()
  if (left === right || left.startsWith(right)) return true
  const leftFlat = left.replace(/\s+/g, '')
  const rightFlat = right.replace(/\s+/g, '')
  return leftFlat !== '' && (leftFlat === rightFlat || leftFlat.startsWith(rightFlat))
}

function replyBodies(reply) {
  const raw = typeof reply?.text === 'string' ? reply.text.trim() : ''
  if (raw === '') return []
  const named = stripLeadingName(reply?.name ?? reply?.who, raw).trim()
  return named === '' || named === raw ? [raw] : [raw, named]
}

// A lone remainder is not coverage. Contiguous same-bot lines are, when
// joining them (as the stream did, or with the step gap) covers the draft.
function sliceCoversDraft(slice, text) {
  const raw = slice.map(reply => (typeof reply?.text === 'string' ? reply.text.trim() : ''))
  const named = slice.map((reply, index) => {
    const body = stripLeadingName(reply?.name ?? reply?.who, raw[index]).trim()
    return body === '' ? raw[index] : body
  })
  for (const parts of [raw, named]) {
    for (const gap of ['', '\n\n']) {
      if (postedCoversDraft(parts.join(gap), text)) return true
    }
  }
  return false
}

// Drop a live draft once its text has been committed into the round replies /
// room log, so the UI does not keep a streaming row beside the final bubble.
// Empty start seeds (text === '', attemptId set, not ended) MUST be kept:
// room-progress polls call this and write the result back onto entry.draft;
// wiping the seed loses attemptId and later text-deltas hit
// applyRoomStreamFrame(undefined, …) and are ignored.
// A shorter already-posted prefix does not wipe a longer same-attempt draft.
// Coverage is an equal line, a line that starts with the full draft, or
// contiguous same-bot lines that join to that. A later line from another
// attempt does not hide an earlier covering line.
export function clearDraftIfPosted(draft, replies = []) {
  if (draft === undefined || draft === null) return undefined
  if (draft.botId === undefined) return undefined
  const text = typeof draft.text === 'string' ? draft.text : ''
  if (text === '') return draft.ended ? undefined : draft
  const candidates = []
  for (const reply of replies) {
    if (reply?.kind !== undefined) continue
    if (reply?.botId !== draft.botId) continue
    if (replyBodies(reply).length === 0) continue
    candidates.push(reply)
  }
  for (let start = 0; start < candidates.length; start += 1) {
    for (let end = start + 1; end <= candidates.length; end += 1) {
      if (sliceCoversDraft(candidates.slice(start, end), text)) return undefined
    }
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
