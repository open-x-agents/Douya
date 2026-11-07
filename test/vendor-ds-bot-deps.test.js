// link:ds-bot needs deep-view under vendor/ds-bot/node_modules (see docs/vendor-ds-bot.md).
// These cases lock the docs + start-dsh ensure so a fresh clone does not silently
// boot a bare DeepSeek Harness shell with "bot (ds-bot): failed to import".

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const START = readFileSync('scripts/start-dsh.mjs', 'utf8')
const DOC = readFileSync('docs/vendor-ds-bot.md', 'utf8')
const PKG = JSON.parse(readFileSync('vendor/ds-bot/package.json', 'utf8'))

test('vendor/ds-bot declares deep-view dependency', () => {
  assert.ok(PKG.dependencies?.['deep-view'], 'vendor/ds-bot/package.json must depend on deep-view')
})

test('docs tell operators to npm install --prefix vendor/ds-bot', () => {
  assert.match(DOC, /npm install --prefix vendor\/ds-bot/)
  assert.match(DOC, /deep-view/)
  assert.match(DOC, /link:/)
})

test('start-dsh ensures vendor/ds-bot deps when deep-view is missing', () => {
  assert.match(START, /ensureVendorDsBotDeps/)
  assert.match(START, /node_modules\/deep-view\/package\.json/)
  assert.match(START, /npm install --prefix vendor\/ds-bot/)
})
