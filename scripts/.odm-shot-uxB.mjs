// Phase B screenshots: card faces. Sends NO chat and ticks nothing.
import { chromium } from 'playwright'
import { readFileSync, writeFileSync } from 'node:fs'
const url = readFileSync('.odm-data/dsh-web.url', 'utf8').trim()
const D = process.env.HOME + '/odm-evidence/'
const out = { errors: [] }
const b = await chromium.launch({ channel: 'chrome' })
const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 })
const p = await ctx.newPage()
p.on('pageerror', e => out.errors.push(String(e.message).slice(0, 200)))
await p.route('**/api/chat', r => r.abort())
await p.route('**/card-interact**', r => r.abort())
await p.goto(url); await p.waitForSelector('.nx', { timeout: 20000 }); await p.waitForTimeout(1500)
out.faces = await p.evaluate(() => [...document.querySelectorAll('.tile.work')].map(t => ({ head: t.querySelector('.w-head')?.textContent?.slice(0, 40), layout: t.querySelector('.face')?.dataset.layout || null, by: t.querySelector('.face')?.dataset.by || null, parts: [...(t.querySelector('.face')?.children || [])].map(c => c.className.split(' ')[0]) })))
const grid = p.locator('.grid2').first()
await grid.scrollIntoViewIfNeeded(); await p.waitForTimeout(400)
await p.screenshot({ path: D + 'uxB-grid.png' })
const seen = new Set(); let i = 0
for (const t of await p.locator('.tile.work:has(.face)').all()) {
  const l = await t.locator('.face').getAttribute('data-layout'); if (seen.has(l) || i >= 4) continue
  seen.add(l); await t.scrollIntoViewIfNeeded(); await t.screenshot({ path: D + `uxB-tile${i++}.png` }).catch(() => {})
}
out.tiles = i
writeFileSync(D + 'uxB.json', JSON.stringify(out, null, 2)); console.log(JSON.stringify(out, null, 2))
await b.close()
