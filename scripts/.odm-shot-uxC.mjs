// Phase C screenshots + motion frames. Sends NO chat and writes nothing: /api/today is mocked in the browser for the
// motion demo, ui-op / card-interact / chat are aborted.
import { chromium } from 'playwright'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
const url = readFileSync('.odm-data/dsh-web.url', 'utf8').trim()
const D = process.env.HOME + '/odm-evidence/'; mkdirSync(D + 'frames', { recursive: true })
const out = { errors: [] }
const b = await chromium.launch({ channel: 'chrome' })
const guard = async p => { for (const r of ['**/api/chat', '**/ui-op', '**/card-interact**', '**/card-prep']) await p.route(r, x => x.abort()) }
// 1) day view (now)
{
  const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 }); const p = await ctx.newPage(); await guard(p)
  p.on('pageerror', e => out.errors.push(String(e.message).slice(0, 200)))
  await p.goto(url); await p.waitForSelector('.nx', { timeout: 20000 }); await p.waitForTimeout(1500)
  out.day = await p.evaluate(() => ({ greeting: document.querySelector('#daySummary')?.textContent, urgent: document.querySelectorAll('.tile.is-urgent').length, draggable: document.querySelectorAll('.grid-main > .tile.work[draggable="true"]').length, done: document.querySelector('.done-today h3')?.textContent || null }))
  const t = p.locator('.grid-main > .tile.work').nth(1); await t.hover(); await p.waitForTimeout(400)
  await p.screenshot({ path: D + 'uxC-day.png' })
  await ctx.close()
}
// 2) after hours (hour override, never stored)
{
  const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 }); const p = await ctx.newPage(); await guard(p)
  await p.addInitScript(() => { window.__odmTodHour = 21; try { localStorage.removeItem('odm.offhours.open') } catch (_) {} })
  p.on('pageerror', e => out.errors.push(String(e.message).slice(0, 200)))
  await p.goto(url); await p.waitForSelector('.nx', { timeout: 20000 }); await p.waitForTimeout(1500)
  out.night = await p.evaluate(() => ({ greeting: document.querySelector('#daySummary')?.textContent, off: document.querySelector('#offToggle')?.textContent, mainTiles: document.querySelectorAll('.grid-main > .tile.work').length, done: document.querySelector('.done-today')?.innerText?.slice(0, 200) || null }))
  await p.screenshot({ path: D + 'uxC-night.png' })
  await ctx.close()
}
// 3) motion: real first load, then a mocked refresh (one card done, one new, one urgent) → frames
{
  const ctx = await b.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 }); const p = await ctx.newPage(); await guard(p)
  let mutate = false
  await p.route('**/api/today**', async r => {
    const res = await r.fetch(); const data = await res.json()
    if (mutate) {
      const work = data.cards.filter(c => c.faceView && c.type !== 'view')
      const gone = work[0], urgent = work[2]
      data.cards = data.cards.filter(c => c !== gone)
      data.doneIds = [...(data.doneIds || []), gone.id]
      if (urgent) urgent.priority = 'urgent'
      const neo = { ...work[1], id: work[1].id + '_demo', sourceId: (work[1].sourceId || '') + ':demo', title: work[1].title }
      data.cards.splice(data.cards.indexOf(work[1]) + 1, 0, neo)
    }
    await r.fulfill({ response: res, json: data })
  })
  await p.goto(url); await p.waitForSelector('.nx', { timeout: 20000 }); await p.waitForTimeout(1200)
  await p.evaluate(() => { const g = document.querySelector('.grid-main'); g.scrollIntoView({ block: 'start' }) })
  await p.waitForTimeout(300)
  let n = 0
  for (let i = 0; i < 4; i++) { await p.screenshot({ path: D + `frames/f${String(n++).padStart(3, '0')}.png` }); await p.waitForTimeout(80) }
  mutate = true
  await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  const t0 = Date.now()
  while (Date.now() - t0 < 3200) { await p.screenshot({ path: D + `frames/f${String(n++).padStart(3, '0')}.png` }); await p.waitForTimeout(40) }
  out.frames = n
  out.motion = await p.evaluate(() => ({ urgent: document.querySelectorAll('.tile.is-urgent').length, leaving: document.querySelectorAll('.leaving-done').length }))
  await ctx.close()
}
writeFileSync(D + 'uxC.json', JSON.stringify(out, null, 2)); console.log(JSON.stringify(out, null, 2))
await b.close()
