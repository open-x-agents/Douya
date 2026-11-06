import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { readDshMemoryRecall, readChiefMemory } from '../src/digest/runner.js'

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '',
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS memories_recent ON memories (updated_at DESC, id DESC);
  CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
    USING fts5(text, tags, content='memories', content_rowid='id');
  CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts (rowid, text, tags) VALUES (new.id, new.text, new.tags);
  END;
`

function seed(home, rows) {
  const dir = join(home, 'memory')
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(join(dir, 'memory.db'))
  db.exec(SCHEMA)
  const now = Date.now()
  const ins = db.prepare('INSERT INTO memories (text, tags, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
  for (const r of rows) ins.run(r.text, r.tags || '', r.pinned ? 1 : 0, now, now + (r.skew || 0))
  db.close()
}

test('readDshMemoryRecall: empty / missing db → empty string', () => {
  const home = mkdtempSync(join(tmpdir(), 'odm-mem-empty-'))
  assert.equal(readDshMemoryRecall(home), '')
  assert.equal(readDshMemoryRecall(join(home, 'nope')), '')
  rmSync(home, { recursive: true, force: true })
})

test('readDshMemoryRecall: pinned first, then recent; survives reopen', () => {
  const home = mkdtempSync(join(tmpdir(), 'odm-mem-'))
  seed(home, [
    { text: 'User prefers English UI', tags: 'preference', pinned: true },
    { text: 'Ship lean slices only', tags: 'decision', pinned: false, skew: 2 },
    { text: 'Older note', tags: '', pinned: false, skew: 1 },
  ])
  const a = readDshMemoryRecall(home)
  assert.match(a, /Memories you previously stored/)
  assert.match(a, /#\d+, pinned.*User prefers English UI/)
  assert.match(a, /Ship lean slices only/)
  const idxPin = a.indexOf('User prefers English UI')
  const idxLean = a.indexOf('Ship lean slices only')
  assert.ok(idxPin >= 0 && idxLean > idxPin)
  // reopen path (durability)
  const b = readDshMemoryRecall(home)
  assert.equal(a, b)
  rmSync(home, { recursive: true, force: true })
})

test('readChiefMemory includes dsh-memory recall when present', async () => {
  const home = mkdtempSync(join(tmpdir(), 'odm-mem-chief-'))
  seed(home, [{ text: 'Timezone is Asia/Shanghai', tags: 'preference', pinned: true }])
  const text = await readChiefMemory(home)
  assert.match(text, /Asia\/Shanghai/)
  rmSync(home, { recursive: true, force: true })
})
