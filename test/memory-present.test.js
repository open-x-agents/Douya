import test from 'node:test'
import assert from 'node:assert/strict'
import {
  presentMemoryText,
  memoryLeadKind,
  isAchievementKind,
  memorySourceKey,
} from '../packages/dsh-muse-ui/memory-present.js'

test('presentMemoryText: markdown heading → title + summary', () => {
  const p = presentMemoryText('# soul.md - Who You Are\n\nYou are becoming someone.\n\n- Helpful\n- Resourceful')
  assert.equal(p.title, 'soul.md - Who You Are')
  assert.match(p.summary, /becoming someone/)
  assert.equal(p.long, false)
})

test('presentMemoryText: short one-liner stays title-only', () => {
  const p = presentMemoryText('Owner Danyang Chen ships lean Douya slices.')
  assert.equal(p.title, 'Owner Danyang Chen ships lean Douya slices.')
  assert.equal(p.summary, '')
  assert.equal(p.long, false)
})

test('presentMemoryText: long paragraph splits on sentence', () => {
  const p = presentMemoryText(
    'Shipped Memory Glimpse ranking for OpenDigitalMate. Achievements now surface before routine timezone prefs on tip 743877b Asia/Shanghai box test with extra verification notes that keep going for a while.',
  )
  assert.ok(p.title.length <= 72)
  assert.match(p.title, /Shipped Memory Glimpse|Achievements|OpenDigitalMate/i)
  assert.ok(p.summary.length > 0)
})

test('presentMemoryText: very long body marks long=true', () => {
  const body = 'Detail line. ' + 'word '.repeat(80)
  const p = presentMemoryText(`# Milestone ship\n\n${body}`)
  assert.equal(p.title, 'Milestone ship')
  assert.equal(p.long, true)
  assert.ok(p.summary.endsWith('…'))
})

test('memoryLeadKind / isAchievementKind', () => {
  assert.equal(memoryLeadKind(['achievement', 'project']), 'achievement')
  assert.equal(isAchievementKind('milestone'), true)
  assert.equal(isAchievementKind('preference'), false)
})

test('memorySourceKey: mcp memory vs local numeric id', () => {
  assert.equal(memorySourceKey({ source: 'mcp-memory' }), 'mcp')
  assert.equal(memorySourceKey({ source: 'mcp', uri: 'ent:x' }), 'mcp')
  assert.equal(memorySourceKey({ id: 12, text: 'x' }), 'local')
  assert.equal(memorySourceKey({ source: 'dsh-memory' }), 'local')
  assert.equal(memorySourceKey({ id: 'abc' }), 'unknown')
})

import { humanizeMemoryText, presentMemory } from '../packages/dsh-muse-ui/memory-present.js'

test('humanizeMemoryText: no URIs, marker tokens, comments, markdown or image links', () => {
  const raw = '---\nkind: x\n---\n<!-- MEMORY_FIELDS {"a":1} -->\n# Shipped Recall\n\nODM_MEMTEST_20261107_SHIPPED: Photos now show **inline** in `Recall`.\n\n![team](https://example.com/recall/x/y.png)'
  const out = humanizeMemoryText(raw)
  assert.doesNotMatch(out, /ODM_MEMTEST|MEMORY_FIELDS|kind: x|\*\*|`|!\[/)
  assert.match(out, /^# Shipped Recall\nPhotos now show inline in Recall\./)
})

test('presentMemory: file-name heading prefix dropped, sub-headings lead sentences, empty fields skipped', () => {
  const p = presentMemory({ text: '# soul.md - Who You Are\n_You are becoming someone._\n## Boundaries\nPrivate things stay private.\n- **Name:** \n- **Vibe:** calm' })
  assert.equal(p.title, 'Who You Are')
  assert.equal(p.body, 'You are becoming someone. Boundaries: Private things stay private. Vibe: calm.')
})

test('presentMemory: one-liner title has no trailing period; Chinese gets 。; empty → file name', () => {
  assert.equal(presentMemory({ text: 'Prefer English UI' }).title, 'Prefer English UI')
  assert.equal(presentMemory({ text: '# 上线回忆照片\n照片会显示在卡片上' }).body, '照片会显示在卡片上。')
  assert.equal(presentMemory({ text: '', uri: 'file:///memories/events/first-demo.md' }).title, 'First demo')
})
