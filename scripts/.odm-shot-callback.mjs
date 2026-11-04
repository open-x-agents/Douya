// Verifies the Composio OAuth callback page without touching chat: no messages are sent.
import { chromium } from 'playwright'
import { readFileSync, writeFileSync } from 'node:fs'
const url = readFileSync('.odm-data/dsh-web.url', 'utf8').trim()
const origin = new URL(url).origin
const D = process.env.HOME + '/odm-evidence/'
const out = {}
const b = await chromium.launch({ channel: 'chrome' })
const ctx = await b.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 })
const app = await ctx.newPage()
await app.goto(url); await app.waitForLoadState('networkidle').catch(() => {})
// 1) Opener flow: the app opens the callback as a popup; we expect the postMessage, a refresh, and auto-close.
await app.evaluate(() => { window.__got = []; window.addEventListener('message', e => window.__got.push(e.data)) })
let refreshes = 0
app.on('request', r => { if (r.url().includes('/api/composio/apps/refresh')) refreshes++ })
const [pop] = await Promise.all([
  ctx.waitForEvent('page'),
  app.evaluate((o) => { window.open(o + '/composio-callback?status=success&connected_account_id=ca_G1L9-YnjltS6', 'odm-composio', 'width=600,height=720') }, origin),
])
await pop.waitForLoadState('domcontentloaded')
await pop.waitForEvent('close', { timeout: 5000 }).then(() => { out.popupAutoClosed = true }).catch(() => { out.popupAutoClosed = false })
await app.waitForTimeout(1500)
out.openerReceived = await app.evaluate(() => window.__got)
out.refreshRequestsAfterMessage = refreshes
out.toast = await app.evaluate(() => [...document.querySelectorAll('[class*=toast]')].map(n => n.textContent.trim()).filter(Boolean).slice(-2))
// 2) Screenshots of the page itself (no opener; disable auto-redirect so it can be captured)
for (const [k, q] of [['success', 'status=success&connected_account_id=ca_G1L9-YnjltS6'], ['failed', 'status=failed&error=access_denied']]) {
  const p = await ctx.newPage(); await p.setViewportSize({ width: 560, height: 520 })
  await p.route('**/api/opendigitalmate/app*', r => r.abort())
  await p.addInitScript(() => { const r = location.replace.bind(location); Object.defineProperty(window, '__noRedirect', { value: true }); window.close = () => {}; })
  await p.goto(`${origin}/composio-callback?${q}`, { waitUntil: 'domcontentloaded' })
  await p.waitForTimeout(600)
  await p.screenshot({ path: `${D}cb-${k}.png` })
  out[k] = await p.evaluate(() => ({ h1: document.querySelector('h1')?.textContent, detail: document.querySelector('p, .detail')?.textContent?.slice(0, 160), url: location.pathname }))
  await p.close()
}
// 3) No opener: success page should redirect to the app's 信源 page
const solo = await ctx.newPage()
await solo.goto(`${origin}/composio-callback?status=success&connected_account_id=ca_G1L9-YnjltS6`)
await solo.waitForURL(/opendigitalmate\/app/, { timeout: 6000 }).catch(() => {})
await solo.waitForTimeout(1500)
out.noOpener = { url: solo.url().replace(/token=[^&#]*/, 'token=X'), sourcesActive: await solo.evaluate(() => document.querySelector('.nav.on')?.getAttribute('data-view')).catch(() => null) }
writeFileSync(D + 'cb.json', JSON.stringify(out, null, 2)); console.log(JSON.stringify(out, null, 2))
await b.close()
