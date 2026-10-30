// The panel: one page over the same store the cards are built from. Snapshot building is
// pure, so the numbers the page shows are the numbers a test can assert.

import { readFile } from 'node:fs/promises'
import { PANEL_PAGE_ROUTE, PANEL_ROUTE } from './constants.js'

export function reportKey(memberId, date) {
  return `${memberId}:${date}`
}

export function panelSnapshot({ state, plan = [], today, now = Date.now() } = {}) {
  const members = Object.values(state?.members ?? {}).filter(member => member?.active !== false)
  const submitted = new Set(
    Object.keys(state?.reports ?? {})
      .filter(key => key.endsWith(`:${today}`))
      .map(key => key.slice(0, key.lastIndexOf(':'))),
  )
  const upcoming = plan
    .filter(reminder => Date.parse(reminder.fireAt) >= now)
    .slice(0, 20)
    .map(reminder => ({ id: reminder.id, title: reminder.title, startAt: reminder.startAt, fireAt: reminder.fireAt }))
  const deliveries = (state?.deliveries ?? []).slice(-20).reverse()
  return {
    today,
    members: members.map(member => ({ id: member.id, name: member.name, submitted: submitted.has(member.id) })),
    total: members.length,
    submitted: members.filter(member => submitted.has(member.id)).length,
    missing: members.filter(member => !submitted.has(member.id)).map(member => member.name),
    upcoming,
    deliveries,
  }
}

export function snapshotOf(rt) {
  const state = rt.store.get()
  const today = rt.today()
  return panelSnapshot({ state, plan: state.upcoming ?? [], today, now: rt.now().getTime() })
}

// Two routes on the shared /api channel, registered through the same effect ds-bot uses, so
// unloading the plugin unregisters them.
export function installPanel(ctx, rt) {
  const register = ctx?.connection?.fetch?.register
  if (typeof ctx?.effect !== 'function' || typeof register !== 'function') return false
  ctx.effect(() => register({
    path: PANEL_ROUTE,
    methods: ['GET'],
    fetch: async () => new Response(JSON.stringify(snapshotOf(rt)), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    }),
  }), 'opendigitalmate: panel data')

  ctx.effect(() => register({
    path: PANEL_PAGE_ROUTE,
    methods: ['GET'],
    fetch: async () => {
      const html = await readFile(new URL('../client/panel.html', import.meta.url), 'utf8')
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
    },
  }), 'opendigitalmate: panel page')
  return true
}
