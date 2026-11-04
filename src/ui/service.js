// UI op service: validates + applies view ops, persists layout, and fans events out to open 豆芽 tabs.
// Transport is a long-poll on the dsh connection (GET ui-events?since=seq): a tab waits up to `waitMs` for the
// next event. Events live in memory only (ring buffer); after a restart the bootId changes and tabs resync from
// /api/today, which carries the persisted layout — so a missed event never loses state.

import { validateUiOp, applyUiOp, uiView, sanitizeViewContext, viewSnapshotText, uiStateFull, LAYOUT_OPS } from './ops.js'

export function createUiService({ store, log = () => {}, now = () => Date.now() }) {
  const bootId = `b${now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  let seq = 0
  const events = [] // { seq, at, ... }
  const waiters = new Set()
  let view = null // what the user is looking at — memory only, never persisted

  const emit = (ev) => {
    const e = { ...ev, seq: ++seq, at: now(), bootId }
    events.push(e)
    while (events.length > 200) events.shift()
    for (const w of [...waiters]) w()
    return e
  }

  async function op(input, { by = 'bot', source = null } = {}) {
    const state = store.get() || {}
    const v = validateUiOp(input, state, { now: now() })
    if (!v.ok) return { success: false, ...v }
    const res = applyUiOp(state, v.op, { by, now: now() })
    // Chief proposing a layout change the user didn't ask for: show 豆芽建议 with 应用 / 忽略, change nothing.
    if (by === 'bot' && (input.requested === false || input.requested === 'false') && (LAYOUT_OPS.has(v.op.op) || v.op.op === 'highlight')) {
      const message = `豆芽建议：${res.message.replace(/^豆芽(按你的要求)?/, '')}`
      const ev = emit({ kind: 'suggest', op: { ...input, requested: undefined }, by, message })
      log(`[ui] suggest ${v.op.op} → ${message} (seq ${ev.seq})`)
      return { success: true, suggested: true, op: v.op.op, message, note: '没有改动面板，只给用户显示了一条建议（应用 / 忽略）。' }
    }
    const persist = LAYOUT_OPS.has(v.op.op) || v.op.op === 'highlight' || v.op.op === 'undo'
    // Open / close / navigate are transient but still logged so Chief can see what it just did.
    await store.save({ ui: persist ? res.ui : state.ui, uiLog: res.log })
    const after = store.get()
    const undoable = !!res.entry.undo
    const ev = emit({ kind: 'op', op: v.op, by, message: res.message, undoId: undoable ? res.entry.id : null, logId: res.entry.id, ui: uiView(after), source })
    log(`[ui] ${by} ${v.op.op} → ${res.message} (seq ${ev.seq})`)
    return {
      success: true, op: v.op.op, message: res.message, undoId: undoable ? res.entry.id : null, skipped: res.skipped,
      delivered: waiters.size > 0 || recentlyPolled(), seq: ev.seq,
    }
  }

  let lastPollAt = 0
  const recentlyPolled = () => now() - lastPollAt < 35_000

  /** Long-poll: events after `since`; resolves early when one arrives. */
  async function poll({ since = 0, boot = null, waitMs = 25_000 } = {}) {
    lastPollAt = now()
    const fresh = boot && boot !== bootId // server restarted: the tab should resync from /api/today
    const pick = () => events.filter(e => e.seq > (fresh ? 0 : Number(since) || 0))
    let out = pick()
    if (!out.length && !fresh && waitMs > 0) {
      await new Promise(resolve => {
        const done = () => { waiters.delete(done); clearTimeout(t); resolve() }
        const t = setTimeout(done, Math.min(waitMs, 30_000))
        waiters.add(done)
      })
      out = pick()
    }
    lastPollAt = now()
    return { bootId, seq, resync: !!fresh, events: out }
  }

  function setView(raw) { const v = sanitizeViewContext(raw); if (v) view = v; return { ok: !!v } }
  function getView() { return view }
  function viewText(raw) {
    const v = raw ? sanitizeViewContext(raw) : view
    if (raw && v) view = v // a chat turn is the freshest report of what the user sees
    return v ? viewSnapshotText(v, store.get() || {}, { now: now() }) : ''
  }
  function state() { return uiStateFull(view, store.get() || {}, { now: now() }) }

  return { op, poll, emit, setView, getView, viewText, state, get bootId() { return bootId }, get seq() { return seq } }
}
