// Open Digital Mate, mounted on ds-bot: Feishu goes in and out, a daily report and the
// next meeting's reminder come back, and one panel reads the same store. This file only
// wires the modules together; every decision lives in src/host/, which runs without DSH.

import { join } from 'node:path'
import { createStore } from './src/host/store.js'
import { createConfigStore } from './src/host/config-store.js'
import { buildDailyReport } from './src/host/report.js'
import { due, planFor, reminderKey, snooze } from './src/host/reminders.js'
import { dailyReportCard, readAction, reminderCard } from './src/host/cards.js'
import { installPanel, reportKey } from './src/host/panel.js'
import { createFeishuSender } from './src/host/feishu.js'
import { PANEL_ROUTE, SNOOZE_MINUTES, TICK_SECONDS } from './src/host/constants.js'
import { createComposioClient, scheduleDailyDigest, generateDailyDigest, pushDailyDigest } from './src/host/composio.js'
import { createApiRouter } from './src/host/api.js'

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
  const configStore = createConfigStore(join(home, 'config.json'))
  const sender = createFeishuSender({ credentials: config.credentials, log: config.log })
  const sendCard = config.sendCard ?? sender.sendCard
  const calendar = config.calendar ?? (async () => [])
  const log = config.log ?? (() => {})

  // Load config store
  configStore.load().catch(err => log(`Config store load failed: ${err.message}`))

  // Composio integration - try config store first, then env vars
  let composioClient = null
  try {
    const apiKey = configStore.get()?.composioApiKey || config.composioApiKey || process.env.COMPOSIO_API_KEY
    const entityId = configStore.get()?.composioEntityId || config.composioEntityId || process.env.COMPOSIO_ENTITY_ID || 'default'
    
    if (apiKey) {
      composioClient = createComposioClient({
        composioApiKey: apiKey,
        composioEntityId: entityId,
      })
      log('Composio client initialized')
    }
  } catch (err) {
    log(`Composio initialization failed: ${err.message}`)
  }

  // Create API router function (actual router created later with LLM context)
  const createApiRouterFn = (options) => createApiRouter({ 
    store, 
    composioClient, 
    config,
    sendCard,
    configStore,
    ctx,
    ...options,
  })

  // Create initial API router
  const apiRouter = createApiRouterFn({ llmCtx: ctx })

  const rt = {
    ctx,
    config,
    home,
    store,
    now,
    today,
    composioClient,
    configStore,
    apiRouter,
    createApiRouter: createApiRouterFn,

    // One pass of the clock: plan from the calendar, deliver what is due, keep the rest for
    // the panel. Only a delivered reminder is marked sent, so a Feishu hiccup retries.
    async tick() {
      const state = store.get()
      const moment = now().getTime()
      const planned = planFor(await calendar(), { now: moment, leadMinutes: config.leadMinutes })
      const plan = [...planned, ...(state.manual ?? [])].sort((a, b) => a.fireAt.localeCompare(b.fireAt))
      const firing = due(plan, { now: moment, sent: Object.keys(state.sent ?? {}) })
      const deliveries = []
      const delivered = new Set()
      for (const reminder of firing) {
        const target = reminder.owner || config.ownerOpenId
        if (target === undefined || target === '') {
          deliveries.push({ kind: 'reminder', id: reminder.id, at: now().toISOString(), ok: false, error: 'no-target' })
          continue
        }
        try {
          const messageId = await sendCard({ receiveId: target, card: reminderCard(reminder) })
          delivered.add(reminderKey(reminder))
          deliveries.push({ kind: 'reminder', id: reminder.id, at: now().toISOString(), ok: true, messageId })
        } catch (error) {
          const reason = String(error?.message ?? error)
          log(`reminder ${reminder.id} not sent: ${reason}`)
          deliveries.push({ kind: 'reminder', id: reminder.id, at: now().toISOString(), ok: false, error: reason })
        }
      }
      const sent = { ...(state.sent ?? {}) }
      for (const key of delivered) sent[key] = now().toISOString()
      await store.save({
        ...state,
        sent,
        manual: (state.manual ?? []).filter(item => Date.parse(item.fireAt) > moment),
        upcoming: plan.slice(0, 20),
        deliveries: [...(state.deliveries ?? []), ...deliveries].slice(-200),
      })
      return { plan, firing, deliveries }
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

  // Schedule daily digest if Composio is configured
  if (composioClient && config.enableDigest !== false) {
    const digestSchedule = config.digestSchedule || process.env.DIGEST_SCHEDULE || '08:00'
    log(`Scheduling daily digest at ${digestSchedule}`)
    scheduleDailyDigest(
      { digestSchedule, runImmediately: false },
      async () => {
        log('Running scheduled daily digest...')
        try {
          const digest = await generateDailyDigest(composioClient)
          const results = await pushDailyDigest({
            digest,
            store,
            config,
            sendCard,
          })
          log(`Digest pushed: ${results.length} deliveries, ${results.filter(r => r.success).length} successful`)
        } catch (err) {
          log(`Digest push failed: ${err.message}`)
        }
      }
    )
  }

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
      const timer = setInterval(() => {
        void rt.tick().catch(error => log(`tick failed: ${String(error?.message ?? error)}`))
      }, (config.tickSeconds ?? TICK_SECONDS) * 1000)
      if (typeof timer.unref === 'function') timer.unref()
      return () => clearInterval(timer)
    }, 'opendigitalmate: reminder tick')
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
