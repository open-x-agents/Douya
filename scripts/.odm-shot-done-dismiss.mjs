// Done-dismiss + dock-stay-closed. No live chat sends; chat/card-prep aborted; today may be mocked for motion.
import { chromium } from 'playwright'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
const url = readFileSync('.odm-data/dsh-web.url', 'utf8').trim()
const D = process.env.HOME + '/odm-evidence/'; mkdirSync(D, { recursive: true })
const out = { errors: [] }
const b = await chromium.launch({ channel: 'chrome' })
const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 })
const p = await ctx.newPage()
p.on('pageerror', e => out.errors.push(String(e.message).slice(0, 200)))
await p.route('**/api/chat', r => r.abort())
await p.route('**/card-prep', r => r.abort())

// ---- A) After restart, sweep should have dismissed fully-done cards; capture Today + 今天搞定了什么 ----
await p.goto(url); await p.waitForSelector('.nx', { timeout: 20000 }); await p.waitForTimeout(1800)
out.afterSweep = await p.evaluate(() => ({
  greeting: document.querySelector('#daySummary')?.textContent,
  doneToday: document.querySelector('.done-today')?.innerText?.slice(0, 300) || null,
  alldoneFaces: [...document.querySelectorAll('.f-alldone')].map(el => el.closest('.tile.work')?.querySelector('.w-head')?.textContent),
  waitStrip: [...document.querySelectorAll('.wait-chip')].map(x => x.textContent),
  workTiles: document.querySelectorAll('.grid-main > .tile.work').length,
  dockOpen: document.querySelector('#todayChat')?.classList.contains('open'),
}))
await p.screenshot({ path: D + 'done-dismiss-after.png' })

// ---- B) Simulate last-item tick → cardDone leave animation into 今天搞定了什么 ----
let phase = 'live'
await p.route('**/api/today**', async r => {
  const res = await r.fetch(); const data = await res.json()
  if (phase === 'afterDone') {
    // Drop the first work card (simulating server marked it done); put it into doneToday
    const work = data.cards.filter(c => c.type !== 'hero' && c.type !== 'timetable' && c.source !== 'system' && !c.waitingOnly)
    const gone = work[0]
    if (gone) {
      data.cards = data.cards.filter(c => c.id !== gone.id)
      data.doneIds = [...(data.doneIds || []), gone.id]
      const d = data.doneToday || { count: 0, cards: 0, items: 0, actions: 0, line: '', highlights: [], cardIds: [] }
      d.count = (d.count || 0) + 1; d.cards = (d.cards || 0) + 1
      d.line = [d.line, `收掉 ${d.cards} 张卡`].filter(Boolean).join(' · ')
      d.highlights = [{ kind: 'card', text: gone.title, url: null, at: new Date().toISOString() }, ...(d.highlights || [])].slice(0, 5)
      d.cardIds = [...(d.cardIds || []), gone.id]
      data.doneToday = d
      // Force after-hours-ish visibility: show done card even before 17:00 for the shot
      data.afterHours = true
    }
  }
  await r.fulfill({ response: res, json: data })
})
await p.route('**/card-interact**', async r => {
  const body = r.request().postDataJSON() || {}
  // Pretend this tick finished the card
  await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, cardDone: true, cardId: body.id, item: { status: 'done' } }) })
})
// Reload with route in place
phase = 'live'
await p.reload(); await p.waitForSelector('.nx', { timeout: 20000 }); await p.waitForTimeout(1200)
const box = p.locator('.grid-main > .tile.work:has(.f-box)').first()
const hasBox = await box.count()
out.hasTickable = !!hasBox
if (hasBox) {
  await box.scrollIntoViewIfNeeded()
  await p.screenshot({ path: D + 'done-dismiss-before.png' })
  phase = 'afterDone'
  await box.locator('.f-box').first().click()
  await p.waitForTimeout(400)
  out.leaving = await p.evaluate(() => document.querySelectorAll('.leaving-done').length)
  await p.screenshot({ path: D + 'done-dismiss-leaving.png' })
  await p.waitForTimeout(1400)
  out.afterTick = await p.evaluate(() => ({
    doneToday: document.querySelector('.done-today')?.innerText?.slice(0, 280) || null,
    leaving: document.querySelectorAll('.leaving-done').length,
    workTiles: document.querySelectorAll('.grid-main > .tile.work').length,
  }))
  await p.screenshot({ path: D + 'done-dismiss-after-tick.png' })
}

// ---- C) Dock stay closed: open, close, force loadToday, must stay collapsed ----
await p.evaluate(() => { localStorage.setItem('odm.chatDock.open', '0') })
await p.reload(); await p.waitForSelector('.nx', { timeout: 20000 }); await p.waitForTimeout(1000)
// Open by focusing input (byUser)
await p.click('#todayChatInput'); await p.waitForTimeout(400)
out.dockAfterOpen = await p.evaluate(() => document.querySelector('#todayChat')?.classList.contains('open'))
// Close via X
await p.click('#todayChatClose'); await p.waitForTimeout(300)
out.dockAfterClose = await p.evaluate(() => ({
  open: document.querySelector('#todayChat')?.classList.contains('open'),
  pref: localStorage.getItem('odm.chatDock.open'),
}))
// Programmatic loadToday + focus attempt (what used to re-expand)
await p.evaluate(async () => {
  await window.__odmLoadToday()
  document.getElementById('todayChatInput')?.focus({ preventScroll: true })
})
await p.waitForTimeout(800)
out.dockAfterRefresh = await p.evaluate(() => ({
  open: document.querySelector('#todayChat')?.classList.contains('open'),
  pref: localStorage.getItem('odm.chatDock.open'),
}))
// Open a card zoom then close — dock must stay collapsed
const tile = p.locator('.grid-main > .tile.work').first()
if (await tile.count()) {
  await tile.click(); await p.waitForTimeout(800)
  out.zoomOpen = await p.evaluate(() => !!document.querySelector('#tileZoomOverlay.open'))
  await p.keyboard.press('Escape'); await p.waitForTimeout(500)
  out.dockAfterZoom = await p.evaluate(() => ({
    open: document.querySelector('#todayChat')?.classList.contains('open'),
    inZoom: document.querySelector('#todayChat')?.classList.contains('in-zoom'),
    pref: localStorage.getItem('odm.chatDock.open'),
  }))
}
await p.screenshot({ path: D + 'panel-closed.png' })

writeFileSync(D + 'done-dismiss.json', JSON.stringify(out, null, 2))
console.log(JSON.stringify(out, null, 2))
await b.close()
