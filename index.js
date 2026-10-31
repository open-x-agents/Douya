// Open Digital Mate, mounted on ds-bot: Feishu goes in and out, a daily report and the
// next meeting's reminder come back, and one panel reads the same store. This file only
// wires the modules together; every decision lives in src/host/, which runs without DSH.

import { join } from 'node:path'
import { createStore } from './src/host/store.js'
import { buildDailyReport } from './src/host/report.js'
import { due, planFor, reminderKey, snooze } from './src/host/reminders.js'
import { dailyReportCard, readAction, reminderCard } from './src/host/cards.js'
import { installPanel, reportKey } from './src/host/panel.js'
import { createFeishuSender } from './src/host/feishu.js'
import { defaultZone, nextWakeAt, runWithBudget } from './src/host/schedule.js'
import {
  CALENDAR_ATTEMPTS,
  CALENDAR_REFRESH_MS,
  CALENDAR_TIMEOUT_MS,
  PANEL_ROUTE,
  REMINDER_BUDGET_MS,
  SNOOZE_MINUTES,
} from './src/host/constants.js'

export const name = 'opendigitalmate'
// The panel and the card callback answer on the channel ds-bot already exposes; nothing
// else is borrowed from the host.
export const inject = ['connection']

export const CARD_ROUTE = `${PANEL_ROUTE}/card`

export function apply(ctx, config = {}) {
  return createRuntime(ctx, config)
}

export function createRuntime(ctx, config = {}) {
  const home = config.home ?? join(process.env.DSH_HOME ?? '.', 'opendigitalmate')
  const now = config.now ?? (() => new Date())
  const today = config.today ?? (() => now().toISOString().slice(0, 10))
  const store = createStore(join(home, 'state.json'))
  const sender = createFeishuSender({ credentials: config.credentials, log: config.log })
  const sendCard = config.sendCard ?? sender.sendCard
  const calendar = config.calendar ?? (async () => [])
  const log = config.log ?? (() => {})
  // The zone the two report slots are read in, and the two functions the single timer uses.
  // Both are injected, so a test can watch the delay without waiting for it.
  const timeZone = config.timeZone ?? defaultZone()
  const schedule = config.schedule ?? setTimeout
  const cancel = config.cancel ?? clearTimeout
  let timer = null

  const rt = {
    ctx,
    config,
    home,
    store,
    now,
    today,

    // One pass of the clock: plan from the calendar, deliver what is due, keep the rest for
    // the panel. Only a delivered reminder is marked sent, so a Feishu hiccup retries.
    async tick() {
      const state = store.get()
      const moment = now().getTime()
      // A calendar that is down or slow costs the day's meeting lines, not the whole pass: the
      // failures are kept so a late report can say "日历接口 3 次超时" instead of pretending.
      const reading = await runWithBudget(calendar, {
        attempts: CALENDAR_ATTEMPTS,
        timeoutMs: CALENDAR_TIMEOUT_MS,
        source: 'calendar',
      })
      const planned = planFor(reading.ok ? reading.value : [], { now: moment, leadMinutes: config.leadMinutes })
      const plan = [...planned, ...(state.manual ?? [])].sort((a, b) => a.fireAt.localeCompare(b.fireAt))
      const firing = due(plan, { now: moment, sent: Object.keys(state.sent ?? {}) })
      const deliveries = []
      const delivered = new Set()
      for (const reminder of firing) {
        // The arrival time is read again for every reminder: a slow card must not make the next
        // one look punctual.
        const at = now().getTime()
        const record = {
          kind: 'reminder',
          id: reminder.id,
          at: new Date(at).toISOString(),
          latency_ms: at - Date.parse(reminder.fireAt),
          deadline_ms: REMINDER_BUDGET_MS,
        }
        record.over_budget = record.latency_ms > record.deadline_ms
        const target = reminder.owner || config.ownerOpenId
        if (target === undefined || target === '') {
          deliveries.push({ ...record, ok: false, error: 'no-target' })
          continue
        }
        try {
          const messageId = await sendCard({ receiveId: target, card: reminderCard(reminder) })
          delivered.add(reminderKey(reminder))
          deliveries.push({ ...record, ok: true, messageId })
        } catch (error) {
          const reason = String(error?.message ?? error)
          log(`reminder ${reminder.id} not sent: ${reason}`)
          deliveries.push({ ...record, ok: false, error: reason })
        }
      }
      const sent = { ...(state.sent ?? {}) }
      for (const key of delivered) sent[key] = now().toISOString()
      const next = rt.nextWake({ plan, sent: Object.keys(sent), moment })
      await store.save({
        ...state,
        sent,
        manual: (state.manual ?? []).filter(item => Date.parse(item.fireAt) > moment),
        upcoming: plan.slice(0, 20),
        deliveries: [...(state.deliveries ?? []), ...deliveries].slice(-200),
      })
      rt.arm(next)
      return { plan, firing, deliveries, failures: reading.failures, nextWake: next }
    },

    // When to look again. With a plan, the next reminder is the wake. With nothing planned, the
    // calendar is re-read on a five minute cadence, so a meeting added later still shows up.
    nextWake({ plan = [], sent = [], moment = now().getTime() } = {}) {
      return nextWakeAt({
        now: moment,
        plan,
        sent,
        nextPushAt: null,
        calendarAt: plan.length === 0 ? moment + CALENDAR_REFRESH_MS : null,
      })
    },

    // One timer, always for the exact next moment: the delay is the distance to a fireAt, not a
    // number of whole minutes, so a warning lands inside its budget instead of on a grid.
    arm(wake = rt.nextWake()) {
      rt.stop()
      if (!wake || wake.delayMs === null) return null
      timer = schedule(() => {
        timer = null
        void rt.tick().catch(error => log(`tick failed: ${String(error?.message ?? error)}`))
      }, Math.max(0, wake.delayMs))
      if (typeof timer?.unref === 'function') timer.unref()
      return timer
    },

    stop() {
      if (timer === null) return
      cancel(timer)
      timer = null
    },

    // The store is read before the first pass: the timer arms as soon as the plugin mounts,
    // and a pass that ran before the file was read would save the empty state over the
    // members, reports and sent reminders the previous run had left there.
    start() {
      return (async () => {
        await rt.load()
        await rt.tick()
      })()
    },

    // A button press changes one record. `snooze` re-plans the same event at a later fireAt,
    // which is a new key and so a new delivery — the original is never edited.
    async onCardAction(payload) {
      const action = readAction(payload)
      if (!action.ok) return { ok: false, reason: action.reason }
      const state = store.get()
      if (action.op === 'snooze') {
        const found = (state.upcoming ?? []).find(item => item.id === action.id)
        const base = found ?? { id: action.id, title: '日程', startAt: now().toISOString(), fireAt: now().toISOString(), leadMinutes: 0 }
        state.manual = [...(state.manual ?? []), snooze(base, { now: now().getTime(), minutes: SNOOZE_MINUTES })]
      }
      if (action.op === 'done') {
        state.done = { ...(state.done ?? {}), [action.id]: now().toISOString() }
      }
      if (action.op === 'reschedule') {
        state.pendingReschedule = { ...(state.pendingReschedule ?? {}), [action.id]: action.openId }
      }
      await store.save(state)
      return { ok: true, op: action.op, id: action.id, openId: action.openId }
    },

    // The report a member fills in — collected in Feishu, stored here, shown in the panel.
    async recordReport({ memberId, memberName, events = [], done = [], plan = [], notes = '' }) {
      const report = buildDailyReport({ date: today(), memberId, memberName, events, done, plan, notes })
      const state = store.get()
      state.reports[reportKey(memberId, report.date)] = report
      await store.save(state)
      return report
    },

    async sendReportCard({ receiveId, report }) {
      return sendCard({ receiveId, card: dailyReportCard(report) })
    },
  }

  rt.load = () => store.load()
  installPanel(ctx, rt)

  // The button callback: Feishu posts the press, the record changes, and the answer is a
  // toast plus the card the member is looking at.
  const register = ctx?.connection?.fetch?.register
  if (typeof ctx?.effect === 'function' && typeof register === 'function') {
    ctx.effect(() => register({
      path: CARD_ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async request => {
        let body = {}
        try {
          body = await request.json()
        } catch {
          body = {}
        }
        const result = await rt.onCardAction(body)
        return new Response(JSON.stringify({
          toast: result.ok ? { type: 'success', content: TOASTS[result.op] ?? '已记录' } : { type: 'error', content: '这张卡片不认识这次点击' },
        }), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } })
      },
    }), 'opendigitalmate: card callback')

    ctx.effect(() => {
      void rt.start().catch(error => log(`tick failed: ${String(error?.message ?? error)}`))
      return () => rt.stop()
    }, 'opendigitalmate: precise tick')
  }

  return rt
}

const TOASTS = {
  snooze: `已推迟 ${SNOOZE_MINUTES} 分钟`,
  done: '已标记完成',
  reschedule: '好的，发个新时间给我',
  'report.fill': '写两句就行',
  'report.view': '正在看本周',
}
