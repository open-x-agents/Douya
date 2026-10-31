// Conversation Stop aborts the group Session and leaves its inbox in place.
// Relays whose room-log line is already written are removed, and while that
// abort is unwinding a later relay is logged in place. The flag clears on the
// next real user message.

import { SOURCE_KIND } from './constants.js'

/** A relay the room log already has (a seq) or that only the round recorded (`true`). */
export function isLoggedRelay(message) {
  const source = message?.source
  if (source?.kind === 'user') return false
  if (source?.kind !== SOURCE_KIND) return false
  if (source.form !== 'relay' || source.role !== 'post') return false
  return source.logged !== undefined
}

/**
 * Remove logged relays from both inbox lists. Composer rows (`kind: 'user'`) stay.
 * @param {{ nextStep?: unknown[], nextTurn?: unknown[], remove?: (id: unknown) => unknown } | null | undefined} inbox
 * @returns {number}
 */
export function dropLoggedRelays(inbox) {
  if (inbox == null || typeof inbox.remove !== 'function') return 0
  const pending = [
    ...(Array.isArray(inbox.nextStep) ? inbox.nextStep : []),
    ...(Array.isArray(inbox.nextTurn) ? inbox.nextTurn : []),
  ]
  const seen = new Set()
  let dropped = 0
  for (const message of pending) {
    if (!isLoggedRelay(message)) continue
    const id = message?.id
    if (id == null || seen.has(id)) continue
    seen.add(id)
    if (inbox.remove(id)) dropped += 1
  }
  return dropped
}

/** Durable turn/end cause for the composer's Stop: `{ kind: 'aborted', reason: { kind: 'user' } }`. */
export function isUserAbort(reason) {
  return reason?.kind === 'aborted' && reason?.reason?.kind === 'user'
}

/** @param {boolean} halted @param {boolean} roundRunning @returns {'followup' | 'skip' | 'log'} */
export function haltDelivery(halted, roundRunning) {
  if (halted !== true) return 'followup'
  return roundRunning === true ? 'skip' : 'log'
}

export function createRoomHalt() {
  /** @type {Set<string>} */
  const halted = new Set()
  return {
    /** @param {string} roomId */
    has(roomId) {
      return halted.has(roomId)
    },
    /** @param {string} roomId */
    halt(roomId) {
      if (typeof roomId !== 'string' || roomId === '') return
      halted.add(roomId)
    },
    /** @param {string} roomId */
    clear(roomId) {
      halted.delete(roomId)
    },
    /**
     * @param {string} roomId
     * @param {{ type?: string, data?: { source?: { kind?: string }, reason?: unknown } }} event
     * @returns {'none' | 'clear' | 'drop'}
     */
    observe(roomId, event) {
      if (typeof roomId !== 'string' || roomId === '') return 'none'
      if (event?.type === 'user/message' && event.data?.source?.kind === 'user') {
        halted.delete(roomId)
        return 'clear'
      }
      if (event?.type === 'turn/end' && isUserAbort(event.data?.reason)) return 'drop'
      return 'none'
    },
  }
}
