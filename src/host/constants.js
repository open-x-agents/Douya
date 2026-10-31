// Fixed numbers shared by the modules: how long a snooze is, the reminder's latency budget,
// where the panel answers and how hard the calendar is tried. One place, so a test and the
// runtime cannot drift apart.

export const SNOOZE_MINUTES = 10
export const PANEL_ROUTE = '/api/opendigitalmate'
export const PANEL_PAGE_ROUTE = '/api/opendigitalmate/page'
export const REPORT_HOUR = 18

// A reminder that lands more than thirty seconds after its planned moment is a defect, not a
// nudge (issue #14). This number is both the deadline a delivery records and the line a test
// draws, so the ledger and the budget cannot disagree.
export const REMINDER_BUDGET_MS = 30_000

// The calendar is re-read at this floor when no reminder is pending, so a quiet or failing day
// does not put the timer to sleep for good.
export const CALENDAR_REFRESH_MS = 300_000

// Three attempts of eight seconds: a source that is down is a recorded failure on this wake,
// never a tick that rejects and loses the whole pass.
export const CALENDAR_ATTEMPTS = 3
export const CALENDAR_TIMEOUT_MS = 8_000

// Stored as UTC and formatted to a local clock once on the way out; a host with no TZ of its
// own gets UTC.
export const DEFAULT_TIME_ZONE = 'UTC'
