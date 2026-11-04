import { chromium } from 'playwright'
import { readFileSync, writeFileSync } from 'node:fs'
const url = readFileSync('.odm-data/dsh-web.url', 'utf8').trim()
const D = process.env.HOME + '/odm-evidence/'
const tag = process.env.ODM_SHOT || 'polish-before'
const b = await chromium.launch({ channel: 'chrome' })
const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 })
const p = await ctx.newPage()
const errors = []
p.on('pageerror', e => errors.push(String(e.message).slice(0, 160)))
await p.route('**/api/chat', r => r.abort())
await p.addInitScript(() => { try { localStorage.setItem('odm.chatDock.open', '0') } catch (_) {} })
await p.goto(url); await p.waitForSelector('.nx', { timeout: 20000 }); await p.waitForTimeout(1500)
const info = await p.evaluate(() => {
  const tiles = [...document.querySelectorAll('.grid-main > .tile.work')].map(t => ({
    head: t.querySelector('.w-head')?.textContent?.slice(0, 40),
    pills: [...t.querySelectorAll('.w-top .pill')].map(x => x.textContent),
    next: t.querySelector('.w-next-v')?.textContent?.slice(0, 50) || null,
    acts: [...t.querySelectorAll('.w-acts .step')].map(x => x.textContent.trim()),
    face: t.querySelector('.face')?.dataset.layout || null,
    people: !!t.querySelector('.f-people'),
    avs: t.querySelectorAll('.f-av').length,
    waitStrip: null,
  }))
  return {
    greeting: document.querySelector('#daySummary')?.textContent,
    hero: document.querySelector('.nx-title')?.textContent,
    heroBtns: [...document.querySelectorAll('.nx-btns .step')].map(x => x.textContent.trim()),
    dayline: document.querySelector('.dl-sum')?.textContent,
    done: document.querySelector('.done-today h3')?.textContent || null,
    wait: [...document.querySelectorAll('.wait-chip')].map(x => x.textContent),
    tiles,
    empty: document.querySelector('.tile.empty')?.innerText?.slice(0, 80) || null,
  }
})
await p.screenshot({ path: D + tag + '.png' })
writeFileSync(D + tag + '.json', JSON.stringify({ errors, info }, null, 2))
console.log(JSON.stringify({ errors, info }, null, 2))
await b.close()
