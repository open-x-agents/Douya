// Precise time for the two daily pushes and the meeting reminder. Everything here is pure:
// the caller passes the clock, the zone and the store, so the same inputs always give the same
// wake-up and a test can run a whole day without waiting. Instants are UTC; a wall-clock time
// is turned into an instant exactly once, here, and never formatted again on the way out.

import {
  CALENDAR_ATTEMPTS,
  CALENDAR_TIMEOUT_MS,
  DEFAULT_TIME_ZONE,
  MAX_PUSHES_PER_DAY,
  REPORT_SLOTS,
  REPORT_WINDOW_MS,
} from './constants.js'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

// TZ is the honest source of "local" for a host process: it is what the member's machine says.
// An empty or whitespace-only value is not a zone, so it falls back to UTC instead of throwing.
export function defaultZone({ env = process.env } = {}) {
  const tz = String(env?.TZ ?? '').trim()
  return tz === '' ? DEFAULT_TIME_ZONE : tz
}

export function localParts(instant, timeZone = DEFAULT_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(instant))
  const field = type => parts.find(part => part.type === type)?.value ?? ''
  return {
    date: `${field('year')}-${field('month')}-${field('day')}`,
    hour: Number(field('hour')),
    minute: Number(field('minute')),
  }
}

function offsetAt(instant, timeZone) {
  const local = localParts(instant, timeZone)
  const asUtc = Date.UTC(
    Number(local.date.slice(0, 4)),
    Number(local.date.slice(5, 7)) - 1,
    Number(local.date.slice(8, 10)),
    local.hour,
    local.minute,
  )
  return asUtc - instant
}

// A wall-clock time in a zone is an instant only after the zone's offset at that instant is
// known, and the offset depends on the instant — so the first guess is corrected twice. That is
// enough for every zone with a one-step offset and for a DST change an hour away.
export function zonedTimeToUtc(date, hour, minute, timeZone = DEFAULT_TIME_ZONE) {
  const [year, month, day] = String(date).split('-').map(Number)
  const guess = Date.UTC(year, month - 1, day, hour, minute)
  let instant = guess
  for (let round = 0; round < 2; round += 1) {
    instant = guess - offsetAt(instant, timeZone)
  }
  return instant
}

export function slotDueAt(slot, date, timeZone = DEFAULT_TIME_ZONE) {
  return new Date(zonedTimeToUtc(date, slot.hour, slot.minute, timeZone)).toISOString()
}

// The slots a local day carries. A degraded day keeps only the morning one: the evening report
// is the thing that goes, because a missed morning is the thing the member notices.
export function slotsForDay(date, timeZone = DEFAULT_TIME_ZONE, { degraded = false } = {}) {
  const slots = degraded ? REPORT_SLOTS.slice(0, MAX_PUSHES_PER_DAY - 1) : REPORT_SLOTS
  return slots.map(slot => ({ ...slot, dueAt: slotDueAt(slot, date, timeZone) }))
}

export function pushKey(date, slotId) {
  return `${date}:${slotId}`
}

export function todayIn(timeZone = DEFAULT_TIME_ZONE, now = Date.now()) {
  return localParts(now, timeZone).date
}

export function tomorrowIn(timeZone = DEFAULT_TIME_ZONE, now = Date.now()) {
  return localParts(now + DAY, timeZone).date
}

// One state per slot of the local day, and a slot that already has a record is not offered
// again. `missed` is final: the window closed, so the report is never sent late, and the day's
// two pushes stay two.
export function pendingPushes({ now = Date.now(), timeZone = DEFAULT_TIME_ZONE, pushes = {}, degraded = false, date } = {}) {
  const today = date ?? todayIn(timeZone, now)
  const pending = []
  for (const slot of slotsForDay(today, timeZone, { degraded })) {
    const key = pushKey(today, slot.id)
    if (pushes?.[key]) continue
    const due = Date.parse(slot.dueAt)
    const state = now >= due + REPORT_WINDOW_MS ? 'missed' : now >= due ? 'due' : 'not-yet'
    pending.push({ ...slot, key, state })
  }
  return pending
}

// When to wake next. A reminder that is already due wakes immediately (0 ms), so a clock that
// slept through the moment still fires rather than skipping; nothing to do means no wake at all.
export function nextWakeAt({ now = Date.now(), plan = [], sent = [], nextPushAt = null, calendarAt = null } = {}) {
  const delivered = new Set(sent)
  const candidates = []
  for (const reminder of Array.isArray(plan) ? plan : []) {
    if (delivered.has(`${reminder.id}@${reminder.fireAt}`)) continue
    const fireAt = Date.parse(String(reminder.fireAt ?? ''))
    if (!Number.isFinite(fireAt)) continue
    candidates.push({ at: fireAt, why: 'reminder', id: reminder.id })
  }
  if (Number.isFinite(nextPushAt)) candidates.push({ at: nextPushAt, why: 'push' })
  if (Number.isFinite(calendarAt)) candidates.push({ at: calendarAt, why: 'calendar' })
  if (candidates.length === 0) return { at: null, delayMs: null, why: 'idle' }
  candidates.sort((a, b) => a.at - b.at)
  const first = candidates[0]
  return { at: new Date(first.at).toISOString(), delayMs: Math.max(0, first.at - now), why: first.why, id: first.id }
}

// A source call with a budget. Every failed attempt leaves one record, because "the calendar
// timed out three times" is the sentence the member reads when a report arrives late, and it is
// not derivable from one error. Never rejects: the caller decides what a missing source means.
export async function runWithBudget(fn, {
  attempts = CALENDAR_ATTEMPTS,
  timeoutMs = CALENDAR_TIMEOUT_MS,
  schedule = setTimeout,
  cancel = clearTimeout,
  source = '',
} = {}) {
  const failures = []
  const total = Math.max(1, Number(attempts) || 1)
  for (let attempt = 1; attempt <= total; attempt += 1) {
    try {
      const value = await withTimeout(fn, { timeoutMs, schedule, cancel })
      return { ok: true, value, failures }
    } catch (error) {
      failures.push({
        source,
        reason: error?.code === 'TIMEOUT' ? 'timeout' : 'error',
        attempt,
        message: String(error?.message ?? error),
      })
    }
  }
  return { ok: false, value: undefined, failures }
}

function withTimeout(fn, { timeoutMs, schedule, cancel }) {
  const work = Promise.resolve().then(() => fn())
  if (!(Number(timeoutMs) > 0)) return work
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = schedule(() => {
      if (settled) return
      settled = true
      const error = new Error(`timed out after ${timeoutMs}ms`)
      error.code = 'TIMEOUT'
      reject(error)
    }, Number(timeoutMs))
    if (typeof timer?.unref === 'function') timer.unref()
    work.then(
      value => {
        if (settled) return
        settled = true
        if (timer !== undefined) cancel(timer)
        resolve(value)
      },
      error => {
        if (settled) return
        settled = true
        if (timer !== undefined) cancel(timer)
        reject(error)
      },
    )
  })
}
