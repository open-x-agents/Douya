// Fixed numbers shared by the modules: how long a snooze is, when the two reports are due, and
// what "on time" means. One place, so a test and the runtime cannot drift apart.

export const SNOOZE_MINUTES = 10
export const PANEL_ROUTE = '/api/opendigitalmate'
export const PANEL_PAGE_ROUTE = '/api/opendigitalmate/page'

// A wall-clock time is local to the member, so it needs a zone. UTC is the fallback for a host
// that has no TZ set — the same zone the timestamps are stored in.
export const DEFAULT_TIME_ZONE = 'UTC'

// The two moments a day carries. Nothing else pushes: a morning report and an evening one, and a
// day with three meetings still gets two.
export const REPORT_SLOTS = [
  { id: 'morning', label: '早报', hour: 8, minute: 45 },
  { id: 'evening', label: '晚报', hour: 18, minute: 30 },
]
export const MAX_PUSHES_PER_DAY = 2

// Budgets, in milliseconds. A reminder is allowed half a minute of lateness and a report a
// minute; anything later is recorded as a defect rather than passing as on time.
export const REMINDER_BUDGET_MS = 30_000
export const REPORT_BUDGET_MS = 60_000

// A report missed by more than this is not sent at all: a 12:00 "morning" report is noise, and
// one missed day must not become three pushes on the next one.
export const REPORT_WINDOW_MS = 60 * 60_000

// Lateness is admitted in the message itself, but only once it is worth admitting.
export const LATE_WARN_MS = 5 * 60_000

// How stale a calendar read may get while nothing else is planned, and how hard one read is
// tried before the day is rendered without it.
export const CALENDAR_REFRESH_MS = 5 * 60_000
export const CALENDAR_ATTEMPTS = 3
export const CALENDAR_TIMEOUT_MS = 8_000

// A desktop notification is one conclusion, two lines at most, and never a second item.
export const NOTIFY_TITLE_MAX = 20
export const NOTIFY_BODY_MAX = 40
export const NOTIFY_LINES = 2
export const NOTIFY_WAIT_MS = 8_000
