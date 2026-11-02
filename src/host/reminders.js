// Turning calendar events into reminders. A reminder is a promise about the future — fire a
// few minutes before the meeting — so a meeting that already started, or one whose warning
// would land in the past, produces nothing. Planning is pure: the caller passes the clock.

export const DEFAULT_LEAD_MINUTES = 10
export const DEFAULT_HORIZON_MINUTES = 24 * 60

const MINUTE = 60_000

// A delivered reminder is keyed by the moment it fired, not by the event alone: snoozing
// re-plans the same event at a later fireAt, and that must read as a new delivery rather
// than as one already sent.
export function reminderKey(reminder) {
  return `${reminder.id}@${reminder.fireAt}`
}

export function planFor(events, { now = Date.now(), leadMinutes = DEFAULT_LEAD_MINUTES, horizonMinutes = DEFAULT_HORIZON_MINUTES } = {}) {
  const plan = []
  for (const event of Array.isArray(events) ? events : []) {
    const id = String(event?.id ?? '')
    const start = Date.parse(String(event?.start ?? ''))
    if (id === '' || !Number.isFinite(start)) continue
    // A meeting that already began, or sits past the horizon, is not a future to warn about.
    if (start <= now) continue
    if (start - now > horizonMinutes * MINUTE) continue
    // The warning keeps its planned moment even when the tick reaches it late: the key stays
    // stable, so it is delivered once and never again, and a missed minute still warns before
    // the meeting rather than swallowing the reminder for good.
    const fireAt = start - leadMinutes * MINUTE
    plan.push({
      id,
      title: String(event?.summary ?? '').trim() || '未命名日程',
      startAt: new Date(start).toISOString(),
      // The wall clock the member sees, kept as Feishu wrote it: re-formatting an offset
      // into UTC would tell someone in Shanghai their 09:30 meeting starts at 01:30.
      startLocal: String(event?.start ?? ''),
      fireAt: new Date(fireAt).toISOString(),
      leadMinutes,
      location: String(event?.location ?? ''),
      owner: event?.owner ?? '',
    })
  }
  return plan.sort((a, b) => a.fireAt.localeCompare(b.fireAt))
}

// Which planned reminders are due now and were not delivered yet. `sent` holds the keys of
// what already fired; anything else due is returned oldest first.
//
// `done` holds the ids the member already ticked off. A ticked-off meeting is over: it is not
// due again, not even through a snoozed copy with a later fireAt, because the promise the card
// made was about that meeting and that meeting is finished. Without this, pressing 推迟 and
// then 已完成 sends the same reminder a third time (#95).
export function due(plan, { now = Date.now(), sent = [], done = [] } = {}) {
  const delivered = new Set(sent)
  const finished = new Set(done)
  return plan
    .filter(reminder => !finished.has(reminder.id))
    .filter(reminder => !delivered.has(reminderKey(reminder)) && Date.parse(reminder.fireAt) <= now)
    .sort((a, b) => a.fireAt.localeCompare(b.fireAt))
}

// Snoozing produces one entry with a later fireAt; the tick sends it again because the key
// changed. It never mutates the original reminder.
export function snooze(reminder, { now = Date.now(), minutes = 10 } = {}) {
  return { ...reminder, fireAt: new Date(now + minutes * MINUTE).toISOString(), leadMinutes: 0, snoozed: true }
}
