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
import { CALENDAR_ATTEMPTS, CALENDAR_REFRESH_MS, CALENDAR_TIMEOUT_MS, PANEL_ROUTE, REMINDER_BUDGET_MS, SNOOZE_MINUTES } from './src/host/constants.js'
import { defaultZone, nextWakeAt, runWithBudget } from './src/host/schedule.js'

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
  // The zone the daily report slots are read in (#14 steps 3-5). A reminder keeps the wall
  // clock the calendar wrote, so nothing here re-formats a meeting time.
  const timeZone = config.timeZone ?? defaultZone()
  const store = createStore(join(home, 'state.json'))
  const sender = createFeishuSender({ credentials: config.credentials, log: config.log })
  const sendCard = config.sendCard ?? sender.sendCard
  const calendar = config.calendar ?? (async () => [])
  const log = config.log ?? (() => {})
  // The only timer the runtime owns. A test hands in its own pair, so nothing here waits.
  const schedule = config.schedule ?? setTimeout
  const cancel = config.cancel ?? clearTimeout

  // A calendar read that fails is a recorded failure, not a dead runtime: three attempts of
  // eight seconds, and the tick carries on with whatever came back.
  async function readCalendar() {
    const result = await runWithBudget(calendar, {
      attempts: CALENDAR_ATTEMPTS,
      timeoutMs: CALENDAR_TIMEOUT_MS,
      schedule,
      cancel,
      source: 'calendar',
    })
    return { events: Array.isArray(result.value) ? result.value : [], failures: result.failures }
  }

  const rt = {
    ctx,
    config,
    home,
    store,
    now,
    today,
    timeZone,
    lastPlan: [],
    pending: null,

    // One pass of the clock: plan from the calendar, deliver what is due, keep the rest for
    // the panel. Only a delivered reminder is marked sent, so a Feishu hiccup retries.
    async tick() {
      const state = store.get()
      const moment = now().getTime()
      const read = await readCalendar()
      const planned = planFor(read.events, { now: moment, leadMinutes: config.leadMinutes })
      const plan = [...planned, ...(state.manual ?? [])].sort((a, b) => a.fireAt.localeCompare(b.fireAt))
      rt.lastPlan = plan
      const firing = due(plan, { now: moment, sent: Object.keys(state.sent ?? {}) })
      const deliveries = []
      const delivered = new Set()
      for (const reminder of firing) {
        // The clock is re-read for every reminder: a lost minute spent sending one is not a
        // minute the next reminder may inherit.
        const at = now().getTime()
        const latency = at - Date.parse(reminder.fireAt)
        const budget = { latency_ms: latency, deadline_ms: REMINDER_BUDGET_MS, over_budget: latency > REMINDER_BUDGET_MS }
        const target = reminder.owner || config.ownerOpenId
        if (target === undefined || target === '') {
          deliveries.push({ kind: 'reminder', id: reminder.id, at: new Date(at).toISOString(), ok: false, error: 'no-target', ...budget })
          continue
        }
        try {
          const messageId = await sendCard({ receiveId: target, card: reminderCard(reminder) })
          delivered.add(reminderKey(reminder))
          deliveries.push({ kind: 'reminder', id: reminder.id, at: new Date(at).toISOString(), ok: true, messageId, ...budget })
        } catch (error) {
          const reason = String(error?.message ?? error)
          log(`reminder ${reminder.id} not sent: ${reason}`)
          deliveries.push({ kind: 'reminder', id: reminder.id, at: new Date(at).toISOString(), ok: false, error: reason, ...budget })
        }
      }
      const sent = { ...(state.sent ?? {}) }
      for (const key of delivered) sent[key] = new Date(now().getTime()).toISOString()
      await store.save({
        ...state,
        sent,
        manual: (state.manual ?? []).filter(item => Date.parse(item.fireAt) > moment),
        upcoming: plan.slice(0, 20),
        deliveries: [...(state.deliveries ?? []), ...deliveries].slice(-200),
      })
      return { plan, firing, deliveries, failures: read.failures }
    },

    // The wake the timer should hold. A pending reminder decides it on its own fireAt; with
    // nothing planned the calendar refresh floor keeps the day moving.
    nextWake() {
      const moment = now().getTime()
      return nextWakeAt({
        now: moment,
        plan: rt.lastPlan,
        sent: Object.keys(store.get().sent ?? {}),
        calendarAt: moment + CALENDAR_REFRESH_MS,
      })
    },

    // Arm exactly one timer. Arming replaces whatever was pending, so a wake can never stack
    // two ticks on the clock.
    arm() {
      if (rt.pending !== null) cancel(rt.pending)
      rt.pending = null
      const wake = rt.nextWake()
      if (wake.at === null) return null
      const delay = Math.max(0, wake.at - now().getTime())
      const handle = schedule(() => {
        rt.pending = null
        void rt.run()
      }, delay)
      rt.pending = handle
      if (typeof handle?.unref === 'function') handle.unref()
      return delay
    },

    // A wake does the pass and then arms the next one. A failing pass still arms: the timer is
    // the only thing that keeps the day moving.
    async run() {
      try {
        await rt.tick()
      } catch (error) {
        log(`tick failed: ${String(error?.message ?? error)}`)
      } finally {
        rt.arm()
      }
    },

    // The store is read before the first pass: a wake at load time must not save this empty
    // state back over the file it never read. The effect that owns the timer ignores the
    // promise; a test awaits it.
    start() {
      return (async () => {
        await rt.load()
        await rt.run()
      })()
    },

    stop() {
      if (rt.pending !== null) cancel(rt.pending)
      rt.pending = null
      return rt
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

    // The wake is armed for the next reminder's fireAt, not on a one-minute grid: a warning
    // that lands a minute late is exactly the moment this plugin cannot afford.
    ctx.effect(() => {
      rt.start()
      return () => rt.stop()
    }, 'opendigitalmate: reminder timer')
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
