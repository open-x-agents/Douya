// 谷歌日历适配器（#32 S4）：只读事件的时间、标题、参与人，不建、不改、不删事件。
//
// 真跑路径：`/calendar/v3/calendars/primary/events`（GET，`singleEvents=true`），
// 单条用 `/calendar/v3/calendars/primary/events/<id>`。两者都是 GET —— 写端点一个都没有。
//
// 日历的时间是「硬时间」（`due_kind: 'hard'`）：同一个会议被邮件也报一次时，
// 采信哪条时间由 S5 的 `conflictsOf()` 按这个字段裁决，适配器只负责把事实带上。

import { authOf } from './accounts.js'
import { accountIdOf, assertAdapter, observationOf, refFor, transportOf } from './adapter.js'

export const id = 'composio:googlecalendar'
export const readScope = 'metadata'
export const MAX_ITEMS = 25
export const OBJECT = 'event'

const LIST_PATH = '/calendar/v3/calendars/primary/events'

export function eventEndpoint(eventId) {
  return `${LIST_PATH}/${encodeURIComponent(eventId)}`
}

function timeOf(value) {
  // 事件开始时间要么是 `dateTime`（带时刻），要么是全天的 `date`（只有日子）。
  if (typeof value?.dateTime === 'string' && value.dateTime.length > 0) return value.dateTime
  if (typeof value?.date === 'string' && value.date.length > 0) return `${value.date}T00:00:00`
  return null
}

function isoOf(value) {
  const at = Date.parse(String(value ?? ''))
  return Number.isFinite(at) ? new Date(at).toISOString() : null
}

function peopleOf(event) {
  return (Array.isArray(event?.attendees) ? event.attendees : [])
    .map(person => person?.displayName || person?.email)
    .filter(value => typeof value === 'string' && value.length > 0)
}

// 一个事件 → 一条观察。全天事件没有时刻，`due_at` 记当天零点。
export function observationOfEvent(event) {
  const eventId = String(event?.id ?? '')
  if (eventId === '') throw new Error('E_CALENDAR_SHAPE: 事件没有 id')

  const start = timeOf(event?.start)
  const people = peopleOf(event)
  const summary = String(event?.summary ?? '').trim() || '(无标题)'
  const excerpt = [start, people.join('、')].filter(value => typeof value === 'string' && value.length > 0).join('；')

  return observationOf({
    source: id,
    ref: refFor('googlecalendar', OBJECT, eventId),
    external_id: eventId,
    title: summary,
    excerpt,
    at: isoOf(start),
    due_at: start,
    due_kind: 'hard',
    people,
    state: event?.status === 'cancelled' ? 'done' : 'open',
  })
}

export function createGoogleCalendarAdapter({ account, transport } = {}) {
  const auth = authOf(account)
  const proxy = transportOf(transport, 'googlecalendar adapter')

  const adapter = {
    id,
    readScope,

    auth() {
      return { ...auth }
    },

    async list(since, cursor) {
      const accountId = accountIdOf(account, 'googlecalendar adapter')
      const params = ['singleEvents=true', `maxResults=${MAX_ITEMS}`]
      const sinceMs = Date.parse(String(since ?? ''))
      if (Number.isFinite(sinceMs)) params.push(`timeMin=${encodeURIComponent(new Date(sinceMs).toISOString())}`)
      if (typeof cursor === 'string' && cursor.length > 0) {
        params.push(`pageToken=${encodeURIComponent(cursor)}`)
      }

      const page = await proxy.proxyGet({
        connectedAccountId: accountId,
        endpoint: `${LIST_PATH}?${params.join('&')}`,
      })
      const items = Array.isArray(page?.items) ? page.items : []

      return {
        observations: items.slice(0, MAX_ITEMS).map(observationOfEvent),
        cursor: page?.nextPageToken ?? null,
      }
    },

    async get(ref) {
      const prefix = refFor('googlecalendar', OBJECT, '')
      const text = String(ref ?? '')
      if (!text.startsWith(prefix)) return null
      const eventId = text.slice(prefix.length)
      if (eventId === '') return null
      const accountId = accountIdOf(account, 'googlecalendar adapter')
      const event = await proxy.proxyGet({
        connectedAccountId: accountId,
        endpoint: eventEndpoint(eventId),
      })
      return observationOfEvent({ ...event, id: event?.id ?? eventId })
    },
  }

  assertAdapter(adapter, 'googlecalendar adapter')
  return adapter
}

export { assertAdapter }

// 注册表 / `brief.js` 的默认加载只认 `create`：加一个 app 只加一行 + 一个文件。
export const create = createGoogleCalendarAdapter
