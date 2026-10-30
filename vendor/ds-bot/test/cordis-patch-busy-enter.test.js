import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const patchPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'cordis.patch.yml')

// Product (#3): the main Web composer reads busyEnter from ui-conversation.
// Without this override, DSH defaults to queue and busy Enter opens a new turn.
test('cordis.patch.yml defaults ui-conversation busyEnter to steer', () => {
  const text = readFileSync(patchPath, 'utf8')
  const block = text.match(/(?:^|\n)-\s+id:\s*ui-conversation\n(?:[ \t]+[^\n]*\n)*/)?.[0]
  assert.ok(block, 'expected an id: ui-conversation override entry')
  assert.match(block, /\bbusyEnter:\s*steer\b/)
  assert.doesNotMatch(block, /\bbusyEnter:\s*queue\b/)
})
