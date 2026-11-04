// Zoom close must leave the bottom dock collapsed when preference is closed.
// Simulates: closed dock → open card → focus/type/send path in zoom (without live chat) → close X → dock stays closed.
import { chromium } from 'playwright'
import { readFileSync, writeFileSync } from 'node:fs'
const url = readFileSync('.odm-data/dsh-web.url', 'utf8').trim()
const D = process.env.HOME + '/odm-evidence/'
const out = { errors: [] }
const b = await chromium.launch({ channel: 'chrome' })
const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 })
const p = await ctx.newPage()
p.on('pageerror', e => out.errors.push(String(e.message).slice(0, 200)))
await p.route('**/api/chat', r => r.abort()) // never send into live dock
await p.route('**/card-prep', r => r.abort())

await p.addInitScript(() => { try { localStorage.setItem('odm.chatDock.open', '0') } catch (_) {} })
await p.goto(url); await p.waitForSelector('.nx', { timeout: 20000 }); await p.waitForTimeout(1200)

out.start = await p.evaluate(() => ({
  dockOpen: document.querySelector('#todayChat')?.classList.contains('open'),
  pref: localStorage.getItem('odm.chatDock.open'),
}))

// Open a card zoom
const tile = p.locator('.grid-main > .tile.work').first()
await tile.click(); await p.waitForTimeout(900)
out.inZoom = await p.evaluate(() => ({
  zoom: !!document.querySelector('#tileZoomOverlay.open'),
  inZoom: document.querySelector('#todayChat')?.classList.contains('in-zoom'),
  chatOpen: document.querySelector('#todayChat')?.classList.contains('open'),
  pref: localStorage.getItem('odm.chatDock.open'),
}))

// Simulate the bug path: user focuses/types in the borrowed zoom input (used to set pref=1 via byUser)
await p.click('#todayChatInput'); await p.waitForTimeout(200)
await p.keyboard.type('测试一下关闭后dock会不会出来', { delay: 10 })
out.afterType = await p.evaluate(() => ({
  pref: localStorage.getItem('odm.chatDock.open'),
  inZoom: document.querySelector('#todayChat')?.classList.contains('in-zoom'),
  // simulate what send() used to do — call openTodayChat({byUser:true}) while in zoom
}))
// Directly invoke the same call send() makes while in zoom
await p.evaluate(() => {
  // openTodayChat is scoped inside the page script; trigger via the same path send uses:
  // dispatch a fake "send" that only hits openTodayChat by focusing+the send button disabled path.
  // Instead call through the exposed test hook if any; else simulate pointerdown+the internal function
  // by clicking send with empty after we set value — send aborts if empty. So poke preference the old way
  // is not possible; we rely on the type/focus path above. Also force the polluted state then close,
  // to prove close restores snapshot even if something flipped pref during zoom:
  const before = window.__odmDockProbe
})
// Force-pollute preference during zoom (what old send() did), then close — close must restore snapshot
await p.evaluate(() => { localStorage.setItem('odm.chatDock.open', '1') })
// Also call the page's setChatDockWanted if we can reach it — pollute via localStorage alone won't update the in-memory var.
// Click send with text would hit live chat (aborted). Better: evaluate into page to flip in-memory if exposed.
// Expose nothing — instead close and check. The snapshot was taken at open (pref 0), so close restores 0
// even if localStorage was polluted... wait, close does setChatDockWanted(dockWantedBeforeZoom) which writes 0.
await p.keyboard.press('Escape'); await p.waitForTimeout(600)

out.afterClose = await p.evaluate(() => ({
  zoom: !!document.querySelector('#tileZoomOverlay.open'),
  inZoom: document.querySelector('#todayChat')?.classList.contains('in-zoom'),
  dockOpen: document.querySelector('#todayChat')?.classList.contains('open'),
  pref: localStorage.getItem('odm.chatDock.open'),
  sheetMax: getComputedStyle(document.querySelector('#todayChatSheet') || document.body).maxHeight,
  chipsDisplay: getComputedStyle(document.querySelector('#chatChips') || document.body).display,
}))

// Second scenario: open zoom, "send" path via evaluate of the real openTodayChat by injecting
// a temporary bridge — actually re-open and use page.evaluate to run code that mimics send's byUser call.
await tile.click(); await p.waitForTimeout(700)
// Inject: find and call openTodayChat from the closure by clicking send with a message that gets aborted
await p.fill('#todayChatInput', 'zoom-send-probe')
// Intercepted chat abort — send still runs openTodayChat({byUser:true}) at the start before fetch
await p.click('#todayChatSend'); await p.waitForTimeout(500)
out.afterSendInZoom = await p.evaluate(() => ({
  pref: localStorage.getItem('odm.chatDock.open'),
  inZoom: document.querySelector('#todayChat')?.classList.contains('in-zoom'),
  dockOpenClass: document.querySelector('#todayChat')?.classList.contains('open'),
}))
await p.keyboard.press('Escape'); await p.waitForTimeout(600)
out.afterClosePostSend = await p.evaluate(() => ({
  zoom: !!document.querySelector('#tileZoomOverlay.open'),
  dockOpen: document.querySelector('#todayChat')?.classList.contains('open'),
  pref: localStorage.getItem('odm.chatDock.open'),
  inZoom: document.querySelector('#todayChat')?.classList.contains('in-zoom'),
}))

await p.screenshot({ path: D + 'zoom-close.png' })
writeFileSync(D + 'zoom-close.json', JSON.stringify(out, null, 2))
console.log(JSON.stringify(out, null, 2))
await b.close()
