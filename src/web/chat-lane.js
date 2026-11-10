// One lane per Chief session for Muse chat turns.
//
// Why: dock and card chat all prompt the same Chief session, and a turn's answer is found by
// "the last assistant text after the turn ended". Two overlapping turns therefore both woke on the
// same idle and both returned the *latest* reply (the one to the second message), and the UI feed's
// session→turn watch let turn #2 steal turn #1's stream. The lane makes turns on a Chief strictly
// one-at-a-time and coalesces messages that arrive close together:
//   - a message arriving within `windowMs` of an idle-lane message (same conversation) joins it → one turn;
//   - a message arriving while a turn is in flight and not answered yet is steered into that turn
//     (same conversation, text only) → that turn's single reply covers both;
//   - otherwise it waits and runs as its own turn after the current one (each reply maps to its messages).
// Superseded requests resolve right away with { status: 'merged', mergedInto } so the page drops their
// typing bubble; the newest request of a batch carries the reply.

export const MERGE_NOTE = '（我连续发了几条消息，请一起看、一次回复）'
export const STEER_NOTE = '（补充一条，请和上一条一起回答，一次回复）'

/** Combine the messages of one batch into a single request (the latest context wins). */
export function combineRequests(reqs) {
  const last = reqs[reqs.length - 1]
  if (reqs.length === 1) return { ...last }
  const texts = reqs.map(r => String(r.message ?? '').trim()).filter(Boolean)
  const message = texts.length > 1 ? `${MERGE_NOTE}\n${texts.map((t, i) => `${i + 1}. ${t}`).join('\n')}` : (texts[0] || '')
  const attachments = reqs.flatMap(r => (Array.isArray(r.attachments) ? r.attachments : []))
  // The prompt is one combined text; the bubbles stay one per message (see chat-display.js).
  const displayItems = reqs.map(r => ({ text: String(r.message ?? '').trim(), attachments: Array.isArray(r.attachments) ? r.attachments : [] }))
  const hiddenBits = [...new Set(reqs.map(r => String(r.hiddenContext ?? '').trim()).filter(Boolean))]
  return { ...last, message, attachments: attachments.length ? attachments : null, mergedCount: reqs.length, displayItems, hiddenContext: hiddenBits.join('\n\n') || last.hiddenContext }
}

export function createChatLane({ run, windowMs = 800, keyOf = r => r.cardId || 'dock', log = () => {} } = {}) {
  const queue = [] // batches not started: { key, items: [{ req, resolve, reject }], createdAt }
  let active = null // { key, items, steer: fn|null, open: bool, primary }
  let timer = null

  const supersede = (item, by) => item.resolve({ ok: true, status: 'merged', text: '', mergedInto: by.req.turn ?? null, merged: true })

  function pump() {
    if (active || !queue.length) return
    const batch = queue[0]
    const wait = batch.createdAt + windowMs - Date.now()
    if (wait > 0) { clearTimeout(timer); timer = setTimeout(pump, wait); return }
    queue.shift()
    const cur = active = { key: batch.key, items: batch.items, steer: null, open: false, onPrimary: null }
    const primary = () => cur.items[cur.items.length - 1]
    const hooks = {
      setSteer(fn) { cur.steer = fn; cur.open = typeof fn === 'function' },
      closeSteer() { cur.open = false },
      onPrimaryChange(fn) { cur.onPrimary = fn },
      primaryTurn: () => primary().req.turn ?? null,
    }
    Promise.resolve()
      .then(() => run(combineRequests(cur.items.map(i => i.req)), hooks))
      .then(result => primary().resolve({ ...result, mergedCount: cur.items.length }), err => primary().reject(err))
      .finally(() => { active = null; pump() })
  }

  function submit(req) {
    return new Promise((resolve, reject) => {
      const item = { req, resolve, reject }
      const key = keyOf(req)
      // 1) Join a batch that has not started yet.
      const waiting = queue.find(b => b.key === key)
      if (waiting) {
        supersede(waiting.items[waiting.items.length - 1], item)
        waiting.items.push(item)
        log(`[chat-lane] coalesced into waiting batch (${waiting.items.length})`)
        return
      }
      // 2) Steer into the in-flight turn of the same conversation while it is still unanswered.
      const hasAttach = Array.isArray(req.attachments) && req.attachments.length > 0
      if (active && active.key === key && active.open && !queue.length && !hasAttach && String(req.message ?? '').trim()) {
        const cur = active
        const prev = cur.items[cur.items.length - 1]
        cur.items.push(item) // claim primary synchronously, so a reply detected meanwhile goes to the newest request
        Promise.resolve()
          .then(() => cur.steer(String(req.message).trim()))
          .then(() => {
            supersede(prev, item)
            try { cur.onPrimary?.(req) } catch {}
            log(`[chat-lane] steered into the in-flight turn (${cur.items.length})`)
          }, (err) => {
            // Could not steer: undo the claim and queue it as its own turn.
            log(`[chat-lane] steer failed (${err?.message || err}); queued`)
            cur.items.splice(cur.items.indexOf(item), 1)
            queue.push({ key, items: [item], createdAt: Date.now() - windowMs })
            pump()
          })
        return
      }
      // 3) Its own batch (waits for the current turn; coalesces with anything arriving in the window).
      queue.push({ key, items: [item], createdAt: Date.now() })
      pump()
    })
  }

  return { submit, get busy() { return !!active }, get pending() { return queue.reduce((n, b) => n + b.items.length, 0) } }
}
