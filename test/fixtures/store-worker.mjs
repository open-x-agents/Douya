// One writer process for the cross-process tests. The parent starts two of these at the same
// instant against one directory; only the store lock keeps their read-modify-writes from
// clobbering each other. It takes one JSON argument so the fixture stays dumb:
//
//   node test/fixtures/store-worker.mjs '{"dir":"/tmp/…","startAt":1700000000000,"events":[ … ]}'
//
// `startAt` (epoch ms) holds the child until both are ready, which is what makes the two
// writes actually overlap. Any error exits non-zero with the stack on stderr, so a lost write
// fails the parent instead of passing quietly.

import { createEventStore } from '../../src/core/store.js'

const usage = 'usage: node test/fixtures/store-worker.mjs \'{"dir": string, "startAt"?: number, "events": Event[]}\''

const config = JSON.parse(process.argv[2] ?? 'null')
if (config === null || typeof config !== 'object' || typeof config.dir !== 'string' || !Array.isArray(config.events)) {
  console.error(usage)
  process.exit(2)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const startAt = Number(config.startAt ?? 0)
while (Date.now() < startAt) await sleep(2)

try {
  const store = createEventStore({ dir: config.dir })
  let created = 0
  let merged = 0
  for (const event of config.events) {
    const result = await store.upsertEvent(event)
    if (result.created) created += 1
    if (result.merged) merged += 1
  }
  process.stdout.write(`${JSON.stringify({ upserted: config.events.length, created, merged })}\n`)
} catch (error) {
  console.error(error.stack ?? String(error))
  process.exit(1)
}
