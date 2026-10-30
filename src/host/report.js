// The daily report: one member's day, assembled from calendar events and the lines they
// typed, never from a model call — the same inputs always produce the same report, so the
// card and the panel can be tested without a network.

const MINUTE = 60_000

// Feishu hands out ISO strings that already carry the member's offset, so the day is the
// string's own first ten characters; parsing and re-formatting would move a 23:30 meeting
// into tomorrow for everyone east of UTC.
export function dayOf(event) {
  return String(event?.start ?? '').slice(0, 10)
}

export function clockOf(iso) {
  const match = /T(\d{2}):(\d{2})/.exec(String(iso ?? ''))
  return match === null ? '全天' : `${match[1]}:${match[2]}`
}

export function minutesOf(event) {
  const start = Date.parse(String(event?.start ?? ''))
  const end = Date.parse(String(event?.end ?? ''))
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0
  return Math.round((end - start) / MINUTE)
}

export function eventLine(event) {
  const place = event?.location ? `·${event.location}` : ''
  const title = String(event?.summary ?? '').trim() || '未命名日程'
  return `${clockOf(event?.start)} ${title}${place}`
}

const clean = list => (Array.isArray(list) ? list : []).map(line => String(line ?? '').trim()).filter(line => line !== '')

export function buildDailyReport({ date, memberId, memberName, events = [], done = [], plan = [], notes = '' } = {}) {
  const day = date ?? dayOf(events[0])
  const today = events.filter(event => day === '' || dayOf(event) === day)
  const finished = clean(done)
  const planned = clean(plan)
  return {
    date: day,
    memberId,
    memberName,
    schedule: today.map(eventLine),
    done: finished,
    plan: planned,
    notes: String(notes ?? '').trim(),
    stats: {
      meetings: today.length,
      meetingMinutes: today.reduce((sum, event) => sum + minutesOf(event), 0),
      done: finished.length,
      planned: planned.length,
    },
  }
}

export function isEmptyReport(report) {
  return !report || (report.schedule.length === 0 && report.done.length === 0 && report.plan.length === 0 && report.notes === '')
}
