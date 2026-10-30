// Aggregating what a person types. In a chat window people send four short lines in a row
// — "在吗" / "有个事" / "周报那个" / "能不能改一下" — and answering the first one alone is
// answering half a question. Fragments that arrive inside a short window from the same
// person in the same chat become one turn.
//
// Timers are injected: the runtime passes setTimeout, a test passes a fake clock, and the
// budgeting rule below is the same for both.

export const DEFAULT_WINDOW_MS = 3_000
// The window slides while the person keeps typing, but only this far: someone who sends
// twenty lines over two minutes is holding a conversation, not typing one thought.
export const MAX_WINDOW_MS = 20_000
export const MAX_MERGED_CHARS = 4_000

// A double-tap that sends the same line twice is one thought, not two.
export function mergeTexts(messages) {
  const lines = []
  for (const message of Array.isArray(messages) ? messages : []) {
    const text = String(message?.text ?? '').trim()
    if (text === '' || lines.at(-1) === text) continue
    lines.push(text)
  }
  return lines.join('\n').slice(0, MAX_MERGED_CHARS)
}

export function bufferKey({ chatId, senderId }) {
  return `${chatId ?? ''}\u0000${senderId ?? ''}`
}

export function createInputBuffer({
  windowMs = DEFAULT_WINDOW_MS,
  maxWindowMs = MAX_WINDOW_MS,
  now = () => Date.now(),
  schedule = setTimeout,
  cancel = clearTimeout,
  onFlush = () => {},
} = {}) {
  const open = new Map()

  function flush(key) {
    const entry = open.get(key)
    if (entry === undefined) return null
    cancel(entry.timer)
    open.delete(key)
    const voice = {
      key,
      chatId: entry.chatId,
      senderId: entry.senderId,
      messages: entry.messages,
      text: mergeTexts(entry.messages),
      merged: entry.messages.length > 1,
      openedAt: entry.openedAt,
      closedAt: now(),
    }
    onFlush(voice)
    return voice
  }

  return {
    push(message) {
      const key = bufferKey(message ?? {})
      const at = now()
      const existing = open.get(key)
      if (existing === undefined) {
        const entry = { key, chatId: message.chatId, senderId: message.senderId, messages: [{ text: message.text, at }], openedAt: at, timer: undefined }
        entry.timer = schedule(() => flush(key), windowMs)
        open.set(key, entry)
        return { accepted: true, reopened: true, pending: 1 }
      }
      existing.messages.push({ text: message.text, at })
      cancel(existing.timer)
      // Past the ceiling everything typed so far goes out now, the newest line included:
      // holding a line back to start a second window would split one thought in two.
      if (at - existing.openedAt >= maxWindowMs) {
        const voice = flush(key)
        return { accepted: true, flushed: voice, pending: 0 }
      }
      existing.timer = schedule(() => flush(key), windowMs)
      return { accepted: true, reopened: false, pending: existing.messages.length }
    },
    flush,
    flushAll() {
      return [...open.keys()].map(key => flush(key)).filter(voice => voice !== null)
    },
    peek(key) {
      const entry = open.get(key)
      return entry === undefined ? null : { messages: entry.messages.length, openedAt: entry.openedAt }
    },
    size() {
      return open.size
    },
    stop() {
      for (const entry of open.values()) cancel(entry.timer)
      open.clear()
    },
  }
}
