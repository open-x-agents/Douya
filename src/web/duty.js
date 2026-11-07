// The one standing note on 今天: set / done / restore, plus the small view shape /api/today hands out.
// Deliberately not a card and not a UI op: it must survive digests, filters and layout changes.
import { DUTY_MAX, recordCompletion } from '../host/store.js'

const SH = 8 * 3600e3
const shDay = ms => new Date(ms + SH).toISOString().slice(0, 10)

const clean = text => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, DUTY_MAX)
const who = by => (by === 'bot' ? 'bot' : 'user')

export function setDuty(state, { text = '', by = 'user' } = {}) {
  const line = clean(text)
  if (!line) return { ok: false, error: 'empty' }
  state.duty = { text: line, by: who(by), at: new Date().toISOString() }
  return { ok: true, duty: state.duty }
}

/** ✓: clear the line and put it in the same ledger "今天搞定了什么" reads. */
export function doneDuty(state, { by = 'user' } = {}) {
  const cur = state.duty
  if (!cur || !cur.text) return { ok: false, error: 'empty' }
  state.completions = recordCompletion(state.completions || [], { id: 'duty', title: cur.text }, { action: 'done', by: who(by) })
  state.duty = null
  return { ok: true, text: cur.text }
}

/** Undo a ✓: drop that ledger entry and pin the sentence again. */
export function restoreDuty(state, { text = '', by = 'user' } = {}) {
  const prior = (state.completions || []).find(c => c.cardId === 'duty' && c.action === 'done')
  const line = clean(text) || clean(prior?.title)
  if (!line) return { ok: false, error: 'empty' }
  state.completions = (state.completions || []).filter(c => !(c.cardId === 'duty' && c.action === 'done'))
  state.duty = { text: line, by: who(by), at: new Date().toISOString() }
  return { ok: true, duty: state.duty }
}

/** What the Today page draws: the sentence, who pinned it, when, and how many Shanghai days ago. */
export function dutyView(state, { now = Date.now() } = {}) {
  const duty = state?.duty
  if (!duty || !duty.text) return null
  const at = Date.parse(duty.at || '')
  const days = Number.isFinite(at) ? Math.max(0, Math.round((Date.parse(shDay(now)) - Date.parse(shDay(at))) / 86400000)) : 0
  return { text: duty.text, by: duty.by === 'bot' ? 'bot' : 'user', at: duty.at || null, days }
}
