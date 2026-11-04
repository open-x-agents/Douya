// Phase A screenshots. Sends NO chat message; a prepared archive is created then cancelled.
import { chromium } from 'playwright'
import { readFileSync, writeFileSync } from 'node:fs'
const url = readFileSync('.odm-data/dsh-web.url', 'utf8').trim()
const D = process.env.HOME + '/odm-evidence/'
const out = { errors: [] }
const b = await chromium.launch({ channel: 'chrome' })
const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 })
const p = await ctx.newPage()
p.on('pageerror', e => out.errors.push(String(e.message).slice(0, 200)))
await p.route('**/api/chat', r => r.abort()) // guard: never send a chat turn from this script
await p.goto(url); await p.waitForSelector('.nx', { timeout: 20000 }); await p.waitForTimeout(1500)
out.hero = await p.evaluate(() => ({ eyebrow: document.querySelector('.nx-eyebrow')?.textContent, title: document.querySelector('.nx-title')?.textContent, why: document.querySelector('.nx-why')?.textContent, buttons: [...document.querySelectorAll('.nx-btns .step')].map(x => x.textContent.trim()), side: document.querySelector('.nx-up, .nx-count')?.textContent?.replace(/\s+/g, ' ') }))
out.dayline = await p.evaluate(() => document.querySelector('.dl-sum')?.textContent)
out.cards = await p.evaluate(() => [...document.querySelectorAll('.grid2:not(.grid-more) .tile.work')].map(t => ({ head: t.querySelector('.w-head')?.textContent, acts: [...t.querySelectorAll('.w-acts .step')].map(x => x.textContent.trim()) })))
await p.screenshot({ path: D + 'uxA-top.png' })
// prepared archive on a card face → pending card on the face → cancel
const arch = p.locator('.w-acts .step', { hasText: '归档这' }).first()
if (await arch.count()) {
  await arch.scrollIntoViewIfNeeded(); await arch.click(); await p.waitForSelector('.w-slot .act-card', { timeout: 8000 }).catch(() => {})
  await p.waitForTimeout(400)
  const tile = arch.locator('xpath=ancestor::article[1]')
  await tile.screenshot({ path: D + 'uxA-pending.png' }).catch(() => {})
  out.pending = await p.evaluate(() => document.querySelector('.w-slot .act-card')?.innerText.slice(0, 200))
  const cancel = p.locator('.w-slot .act-card [data-op="cancel"]').first()
  if (await cancel.count()) { await cancel.click(); await p.waitForTimeout(800); out.cancelled = await p.evaluate(() => document.querySelector('.w-slot .act-card')?.className) }
}
await p.evaluate(() => window.scrollTo(0, 0)); await p.locator('#v-today').evaluate(e => e.scrollTo(0, 0))
await p.click('#dayMoreToggle'); await p.waitForTimeout(600)
await p.screenshot({ path: D + 'uxA-more.png' })
await p.click('#dayMoreToggle'); await p.waitForTimeout(400)
// open a card: the one chat moves beside it with context + state chips
await p.locator('.grid2:not(.grid-more) .tile.work').first().click(); await p.waitForTimeout(1500)
out.zoom = await p.evaluate(() => ({ chatInZoom: !!document.querySelector('#zChatHost #todayChat'), ctx: document.querySelector('#chatCtx b')?.textContent, chips: [...document.querySelectorAll('#chatChips .chip')].map(x => x.textContent), placeholder: document.querySelector('#todayChatInput')?.placeholder }))
await p.screenshot({ path: D + 'uxA-zoom.png' })
await p.keyboard.press('Escape'); await p.waitForTimeout(500)
out.afterClose = await p.evaluate(() => ({ chatBack: !!document.querySelector('#todayChatSlot #todayChat'), ctxHidden: document.querySelector('#chatCtx')?.hidden }))
writeFileSync(D + 'uxA.json', JSON.stringify(out, null, 2)); console.log(JSON.stringify(out, null, 2))
await b.close()
