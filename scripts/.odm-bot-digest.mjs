// Live bot-digest check: click 立即汇聚 (bot mode), screenshot the progress strip, wait for the result, then
// compare with the legacy pipeline (dry run, same source data). Writes nothing beyond the normal digest merge.
import { chromium } from 'playwright'
import { readFileSync, writeFileSync } from 'node:fs'
const url = readFileSync('.odm-data/dsh-web.url', 'utf8').trim()
const step = process.argv[2] || 'run'
const b = await chromium.launch({ channel: 'chrome' })
const p = await b.newPage({ viewport: { width: 1440, height: 1100 } })
const errs = []; p.on('pageerror', e => errs.push(e.message))
await p.goto(url, { waitUntil: 'domcontentloaded' })
await p.waitForURL(/\/api\/opendigitalmate\/app/, { timeout: 30000 }).catch(() => {})
await p.waitForSelector('.tile.work[data-id]', { timeout: 30000 }); await p.waitForTimeout(1500)
const api = (path, body, method) => p.evaluate(async ([path, body, method]) => (await fetch(path, { method: method || (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json(), [path, body, method])
const snapState = () => { const s = JSON.parse(readFileSync('.odm-data/state.json', 'utf8')); return { cards: s.cards.length, active: s.cards.filter(c => c.status === 'active').length, done: s.cards.filter(c => c.status === 'done').map(c => c.id).sort(), dismissed: s.cards.filter(c => c.status === 'dismissed').length, itemDone: Object.values(s.itemStatus || {}).filter(v => v.status === 'done').length, pinned: (s.ui?.pins || s.uiLayout?.pins || []).length, botTest: s.cards.filter(c => /bot-test|bot_test/i.test(c.id + (c.title || ''))).length } }
const out = { errs }
if (step === 'run') {
  out.before = snapState()
  out.statusBefore = await api('/api/opendigitalmate/digest-status')
  const t0 = Date.now()
  await p.click('#generateDigestBtn')
  const shots = []
  for (let i = 0; i < 120; i++) {
    await p.waitForTimeout(3000)
    const st = await p.evaluate(() => ({ prog: document.getElementById('digestProgress')?.offsetParent === null ? '' : document.getElementById('digestProgress')?.innerText, status: document.getElementById('digestStatus')?.innerText, busy: document.getElementById('generateDigestBtn')?.disabled }))
    if (st.prog) { shots.push([Math.round((Date.now() - t0) / 1000), st.prog]); if (shots.length === 3) await p.screenshot({ path: '.shots/odm-bot-digest-progress.png' }) }
    if (!st.busy) { out.final = st; break }
  }
  out.progress = shots
  out.wallMs = Date.now() - t0
  await p.waitForTimeout(2500)
  await p.evaluate(() => window.scrollTo(0, 0))
  out.stripVisibleAtEnd = await p.evaluate(() => document.getElementById('digestProgress')?.offsetParent !== null)
  await p.screenshot({ path: '.shots/odm-bot-digest.png' })
  out.after = snapState()
  out.status = await api('/api/opendigitalmate/digest-status')
  out.tiles = await p.evaluate(() => [...document.querySelectorAll('.tile.work[data-id]')].slice(0, 14).map(t => (t.querySelector('h3,.t-title,.title')?.textContent || t.innerText.split('\n')[0]).slice(0, 50)))
}
if (step === 'compare') out.compare = await api('/api/opendigitalmate/digest-compare', {})
if (step === 'status') out.status = await api('/api/opendigitalmate/digest-status')
writeFileSync(`/tmp/odm-bot-digest-${step}.json`, JSON.stringify(out, null, 1))
console.log('ok', step)
await b.close()
