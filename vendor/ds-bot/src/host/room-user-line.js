// User lines that are already in a room's log must not wait in the group Session's
// inbox and must not be written a second time. After a stop, a replay, or a route the
// same message is otherwise in two places at once: the room log everyone reads, and
// the Session's next-step, which DSH draws as a pending bubble and can post again.
//
// Only the inbox id matches a line to its row. A fallback on text or order would drop
// one of two identical sentences the user really sent twice, and an older session
// whose lines carry no id is left alone rather than guessed at.

const isUsableId = id => typeof id === 'string' && id !== ''

// A room-log line for one inbox row. The id rides along so the other write sites and
// a later stop can tell which row this line already is; `extra` stays free for files.
export function userLineFor(id, text, extra = {}) {
  return { who: 'User', text, ...extra, ...(isUsableId(id) ? { inboxId: id } : {}) }
}

// The inbox rows whose sentence is already a line of that room's log. Bot lines,
// notice rows (`kind` set) and lines written before ids existed are not counted.
const isLoggedUserLine = row => row != null
  && row.who === 'User'
  && row.kind == null
  && typeof row.text === 'string'
  && row.text !== ''
  && isUsableId(row.inboxId)

export function loggedUserIds(log) {
  const ids = new Set()
  for (const row of Array.isArray(log) ? log : []) if (isLoggedUserLine(row)) ids.add(row.inboxId)
  return ids
}

export function isUserLineLogged(log, id) {
  if (!isUsableId(id)) return false
  return loggedUserIds(log).has(id)
}

// User rows waiting in a Session's inbox that the room log already has, in inbox
// order: next-step first, then next-turn.
export function userRowsToDrop(inbox, log) {
  const logged = loggedUserIds(log)
  if (logged.size === 0) return []
  const rows = ['nextStep', 'nextTurn'].flatMap(list => (Array.isArray(inbox?.[list]) ? inbox[list] : []))
  return rows
    .filter(row => row?.source?.kind === 'user' && isUsableId(row.id) && logged.has(row.id))
    .map(row => row.id)
}

// Removes those rows and says how many really left. A line DSH already claimed is
// gone already: `remove` returns false and nothing changes.
export function dropUserRows(inbox, ids) {
  if (typeof inbox?.remove !== 'function' || !Array.isArray(ids)) return 0
  let dropped = 0
  for (const id of ids) if (inbox.remove(id)) dropped += 1
  return dropped
}

// The user's own stop: DSH cancels the turn with `{ kind: 'aborted', reason: { kind: 'user' } }`.
export function isUserAbort(reason) {
  return reason?.kind === 'aborted' && reason?.reason?.kind === 'user'
}
