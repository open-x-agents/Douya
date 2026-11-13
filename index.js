// Open Digital Mate, mounted on ds-bot: Feishu goes in and out, a daily report and the
// next meeting's reminder come back, and one panel reads the same store. This file only
// wires the modules together; every decision lives in src/host/, which runs without DSH.

import { join } from 'node:path'
import { createStore } from './src/host/store.js'
import { createConfigStore } from './src/web/config-store.js'
import { buildDailyReport } from './src/host/report.js'
import { due, planFor, reminderKey, snooze } from './src/host/reminders.js'
import { dailyReportCard, readAction, reminderCard } from './src/host/cards.js'
import { installPanel, reportKey } from './src/host/panel.js'
import { createFeishuSender } from './src/host/feishu.js'
import { localDay } from './src/host/normalize.js'
import { defaultZone, nextWakeAt, runWithBudget } from './src/host/schedule.js'
import { assertReadOnlyRegistry, registry as composioRegistryDefault } from './src/sources/composio/registry.js'
import { SNAPSHOT as COMPOSIO_SNAPSHOT } from './src/sources/composio/capabilities.js'
import {
  CALENDAR_ATTEMPTS,
  CALENDAR_REFRESH_MS,
  CALENDAR_TIMEOUT_MS,
  PANEL_ROUTE,
  REMINDER_BUDGET_MS,
  SNOOZE_MINUTES,
} from './src/host/constants.js'
import { createComposioClient, scheduleDailyDigest, generateDailyDigest, pushDailyDigest } from './src/web/composio.js'
import { createApiRouter } from './src/web/api.js'
import { registerMuseHostRoutes } from './src/web/dsh-host-routes.js'

export const name = 'opendigitalmate'
// The panel and the card callback answer on the channel ds-bot already exposes; nothing
// else is borrowed from the host.
export const inject = ['connection', 'tools', 'sessionController', 'systemPrompt', 'webServer']

export const CARD_ROUTE = `${PANEL_ROUTE}/card`

export function apply(ctx, config = {}) {
  return createRuntime(ctx, config)
}

export function createRuntime(ctx, config = {}) {
  // Composio 的注册表在启动时校验：白名单里混进一个写动作就同步抛 E_WRITE_ACTION。
  // 这是「启动失败」，不是一条告警 —— 告警会被日志吞掉，写动作却已经进了白名单。
  const composioRegistry = config.composioRegistry ?? composioRegistryDefault
  assertReadOnlyRegistry(composioRegistry, COMPOSIO_SNAPSHOT)
  const home = config.home ?? process.env.ODM_DATA_DIR ?? join(process.env.DSH_HOME ?? '.', 'opendigitalmate')
  const now = config.now ?? (() => new Date())
  // The zone the two report slots are read in, and the two functions the single timer uses.
  // Both are injected, so a test can watch the delay without waiting for it.
  const timeZone = config.timeZone ?? defaultZone()
  // Reports and the panel are keyed on the day the person lives in, never the UTC day: a
  // morning report at 00:30 in Shanghai belongs to that day, not to the one before it.
  const today = config.today ?? (() => localDay(now().toISOString(), timeZone))
  const store = createStore(join(home, 'state.json'))
  const configStore = createConfigStore(join(home, 'config.json'))
  const sender = createFeishuSender({ credentials: config.credentials, log: config.log })
  const sendCard = config.sendCard ?? sender.sendCard
  const calendar = config.calendar ?? (async () => [])
  const log = config.log ?? (() => {})
  const schedule = config.schedule ?? setTimeout
  const cancel = config.cancel ?? clearTimeout
  let timer = null

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
    timeZone,

    // One pass of the clock: plan from the calendar, deliver what is due, keep the rest for
    // the panel. Only a delivered reminder is marked sent, so a Feishu hiccup retries.
    async tick() {
      const state = store.get()
      const moment = now().getTime()
      // A calendar that is down or slow costs the day's meeting lines, not the whole pass: the
      // failures are kept so a late report can say "日历接口 3 次超时" instead of pretending.
      const readAt = now().toISOString()
      const reading = await runWithBudget(calendar, {
        attempts: CALENDAR_ATTEMPTS,
        timeoutMs: CALENDAR_TIMEOUT_MS,
        source: 'calendar',
      })
      // What this pass did with the calendar is part of the state the panel reads: a source that
      // returned null, threw, or handed back something that is not a list is "not connected",
      // not "no meetings". The page must be able to say which sentence has no evidence left.
      const connected = reading.ok && Array.isArray(reading.value)
      const failure = reading.failures[0]
      const calendarSource = {
        connected,
        last_read_at: connected ? readAt : null,
        detail: connected ? `读到 ${reading.value.length} 个日程` : (failure?.message ?? '日历没有返回数据'),
        error: connected ? null : (failure?.reason ?? null),
      }
      const planned = planFor(reading.ok ? reading.value : [], { now: moment, leadMinutes: config.leadMinutes })
      const plan = [...planned, ...(state.manual ?? [])].sort((a, b) => a.fireAt.localeCompare(b.fireAt))
      // `state.done` is what the 已完成 button writes. It has to reach the planner, or a meeting
      // the member ticked off still fires through its snoozed copy (#95).
      //
      // The filtered plan is used twice on purpose. `due()` alone is not enough: `nextWake()`
      // looks at `plan` for the next moment to wake up, and a ticked-off meeting that has already
      // passed its fireAt keeps asking for `delayMs: 0` — `arm(0)` then ticks again immediately,
      // forever, until the meeting starts (PR #96's Verdict: INC caught exactly that).
      const finished = Object.keys(state.done ?? {})
      const open = plan.filter(item => state.done?.[item.id] === undefined)
      const firing = due(open, {
        now: moment,
        sent: Object.keys(state.sent ?? {}),
        done: finished,
      })
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
      const next = rt.nextWake({ plan: open, sent: Object.keys(sent), moment })
      await store.save({
        ...state,
        sources: { ...(state.sources ?? {}), feishu_cal: calendarSource },
        sent,
        manual: (state.manual ?? []).filter(item => Date.parse(item.fireAt) > moment),
        upcoming: plan.slice(0, 20),
        deliveries: [...(state.deliveries ?? []), ...deliveries].slice(-200),
      })
      rt.arm(next)
      return { plan, firing, deliveries, failures: reading.failures, sources: { feishu_cal: calendarSource }, nextWake: next }
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
      // A finished meeting cannot be pushed further down the day: the card that offers 推迟 is
      // the one already ticked off, and re-planning it would resurrect a reminder the member
      // just closed (#95).
      if (action.op === 'snooze' && state.done?.[action.id] !== undefined) {
        return { ok: false, reason: 'already-done' }
      }
      if (action.op === 'snooze') {
        const found = (state.upcoming ?? []).find(item => item.id === action.id)
        const base = found ?? { id: action.id, title: '日程', startAt: now().toISOString(), fireAt: now().toISOString(), leadMinutes: 0 }
        state.manual = [...(state.manual ?? []), snooze(base, { now: now().getTime(), minutes: SNOOZE_MINUTES })]
      }
      if (action.op === 'done') {
        // The first tick keeps its moment; pressing twice must not move it.
        state.done = { ...(state.done ?? {}), [action.id]: state.done?.[action.id] ?? now().toISOString() }
        // Snoozed copies of a finished meeting are dead weight; the plan never sees them again.
        state.manual = (state.manual ?? []).filter(item => item.id !== action.id)
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
    // Register Feishu card callback
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
          toast: result.ok
            ? { type: 'success', content: TOASTS[result.op] ?? '已记录' }
            : { type: 'error', content: REASONS[result.reason] ?? '这张卡片不认识这次点击' },
        }), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } })
      },
    }), 'opendigitalmate: card callback')

    // API surface on this dsh process (Muse UI is the dsh-muse-ui plugin).
    const dshHome = process.env.DSH_HOME || join(process.env.HOME || '', '.dsh')
    registerMuseHostRoutes(ctx, {
      router: rt.apiRouter,
      dshHome,
      log: (m) => log(m),
    })

    // Reminder tick timer
    ctx.effect(() => {
      void rt.start().catch(error => log(`tick failed: ${String(error?.message ?? error)}`))
      return () => rt.stop()
    }, 'opendigitalmate: precise tick')
  }


  // Bot digest: source bots per channel + a Chief digest session (src/digest). Needs the dsh sessionController.
  let knownTools = []
  if (ctx?.sessionController?.create && rt.apiRouter?.setBotDigest) {
    const dshHomeDir = process.env.DSH_HOME || join(process.env.HOME || '', '.dsh')
    Promise.all([import('./src/digest/runner.js'), import('./src/web/aggregation.js')]).then(([{ createBotDigest, createDigestStore, readChiefMemory }, agg]) => {
      const runner = createBotDigest({
        ctx, store, home, aggregation: agg,
        client: () => rt.apiRouter.composio(),
        commit: (cards, meta) => rt.apiRouter.commitDigestCards(cards, meta),
        emit: (progress) => { try { rt.apiRouter.uiServiceRef()?.pulse({ kind: 'digest', progress }) } catch {} },
        digestStore: createDigestStore(home),
        chiefMemory: () => readChiefMemory(dshHomeDir),
        knownTools: () => knownTools,
        profileContext: () => { try { return rt.apiRouter.profileContext?.() || {} } catch { return {} } },
        log: (m) => { log(m); console.log(`[odm] ${m}`) },
      })
      rt.apiRouter.setBotDigest(runner)
      log('bot digest ready (sources: gmail, github, slack)')
    }).catch(err => log(`bot digest unavailable: ${err.message}`))
  }

  // Register Composio / identity / cite tools on the live ds-bot tool registry.
  if (typeof ctx?.effect === 'function' && ctx?.tools?.register) {
    ctx.effect(() => {
      let dispose = () => {}
      import('./src/web/dsbot-tools.js').then(({ registerBotTools }) =>
        registerBotTools(ctx, {
          composioClient,
          getComposioClient: () => {
            if (composioClient) return composioClient
            const cfg = configStore.get() || {}
            const apiKey = cfg.composioApiKey || config.composioApiKey || process.env.COMPOSIO_API_KEY
            if (!apiKey) return null
            try {
              composioClient = createComposioClient({ composioApiKey: apiKey, composioEntityId: cfg.composioEntityId || config.composioEntityId || process.env.COMPOSIO_ENTITY_ID || 'default' })
            } catch (err) { log(`Composio late init failed: ${err.message}`) }
            return composioClient
          },
          getCards: () => store.get()?.cards || [],
          home,
          museUrl: process.env.ODM_MUSE_URL || 'http://127.0.0.1:7777',
          router: rt.apiRouter,
          log: (m) => log(m),
          onRegistered: (names) => { knownTools = names },
        }).then(d => { dispose = d })
      ).catch(err => log(`dsbot-tools failed: ${err.message}`))
      return () => { try { dispose() } catch {} }
    }, 'opendigitalmate: ds-bot tools')
  }

  return rt
}

// 拒绝的理由说人话：点了已完成的日程再点推迟，不该是「不认识这次点击」。
const REASONS = {
  'already-done': '这件事已经标成完成了，不能再推迟',
}

const TOASTS = {
  snooze: `已推迟 ${SNOOZE_MINUTES} 分钟`,
  done: '已标记完成',
  reschedule: '好的，发个新时间给我',
  'report.fill': '写两句就行',
  'report.view': '正在看本周',
}
