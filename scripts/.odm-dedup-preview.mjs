// Read-only: what the load-time cleanup does to the current state (nothing is written).
import { readFileSync } from 'node:fs'
import { normalizeState } from '../src/host/store.js'
import { stableKey, duplicateCount } from '../src/host/reconcile.js'
const raw = JSON.parse(readFileSync(process.argv[2] || '.odm-data/state.json', 'utf8'))
const before = new Map(raw.cards.map(c => [c.id, c.status]))
const st = normalizeState(raw)
const act = cs => cs.filter(c => c.status === 'active' || !c.status)
console.log(JSON.stringify({ activeBefore: act(raw.cards).length, dupBefore: duplicateCount(raw.cards), activeAfter: act(st.cards).length, dupAfter: duplicateCount(st.cards),
  changed: st.cards.filter(c => before.get(c.id) !== c.status).map(c => ({ id: c.id, key: stableKey(c), title: String(c.title || '').slice(0, 30), from: before.get(c.id), to: c.status, into: c.mergedInto })) }, null, 1))
