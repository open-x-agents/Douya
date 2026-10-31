// When the runtime should wake, and how long one read of a source may take before that attempt
// counts as failed. Both pieces are pure: the clock, the timer and the environment come in as
// arguments, so a test drives a whole day without waiting for it.

import { DEFAULT_TIME_ZONE } from './constants.js'
import { reminderKey } from './reminders.js'

// The zone comes from the host, not from whatever formatting this machine happens to do: a
// test sets TZ and gets the same answer the host would. A blank TZ is no zone at all.
export function defaultZone({ env = process.env } = {}) {
  const zone = String(env?.TZ ?? '').trim()
  return zone === '' ? DEFAULT_TIME_ZONE : zone
}

function soonest(candidates) {
  return candidates
    .filter(candidate => Number.isFinite(candidate.at))
    .sort((a, b) => a.at - b.at)[0]
}

// The one wake to arm. A pending reminder decides it on its own `fireAt`: that is what puts the
// warning inside its thirty seconds instead of on a one-minute grid. Nothing planned falls
// back to the calendar refresh floor, so a day with no meetings still re-reads the calendar
// instead of sleeping until the process restarts.
//
// `at` is an absolute epoch, and 0 means a reminder is already due and unsent, so the runtime
// wakes now rather than waiting for the next one.
export function nextWakeAt({ now = Date.now(), plan = [], sent = [], nextPushAt = null, calendarAt = null } = {}) {
  const delivered = new Set(Array.isArray(sent) ? sent : [])
  const reminders = (Array.isArray(plan) ? plan : [])
    .filter(reminder => !delivered.has(reminderKey(reminder)))
    .map(reminder => ({ at: Date.parse(String(reminder?.fireAt ?? '')), why: 'reminder' }))
  const dueNow = soonest(reminders.filter(candidate => candidate.at <= now))
  if (dueNow) return { at: 0, why: 'reminder' }
  const pending = soonest(reminders)
  if (pending) return pending
  const fallback = soonest([
    { at: nextPushAt, why: 'push' },
    { at: calendarAt, why: 'calendar' },
  ])
  return fallback ?? { at: null, why: 'none' }
}

// Run one source read under a budget: each attempt gets its own deadline, every failed attempt
// leaves one record `{source, reason: 'timeout'|'error', attempt}`, and the caller never sees a
// rejection. Three timeouts are three failures, not one.
export async function runWithBudget(
  fn,
  { attempts = 1, timeoutMs = 0, schedule = setTimeout, cancel = clearTimeout, source = 'source' } = {},
) {
  const failures = []
  const tries = Math.max(1, Number(attempts) || 1)
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    let timer
    const run = () => Promise.resolve().then(() => fn({ attempt }))
    try {
      const value = Number(timeoutMs) > 0
        ? await new Promise((resolve, reject) => {
          timer = schedule(() => {
            const error = new Error(`${source} timed out after ${timeoutMs}ms`)
            error.reason = 'timeout'
            reject(error)
          }, timeoutMs)
          run().then(resolve, reject)
        })
        : await run()
      return { ok: true, value, failures }
    } catch (error) {
      failures.push({ source, reason: error?.reason === 'timeout' ? 'timeout' : 'error', attempt })
    } finally {
      // A fast attempt has to take its own deadline off the clock; otherwise a wake would
      // inherit a timer nobody asked for.
      if (timer !== undefined) cancel(timer)
    }
  }
  return { ok: false, value: undefined, failures }
}
