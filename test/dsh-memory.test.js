import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { readDshMemoryRecall, readChiefMemory, listDshMemories, forgetDshMemory } from '../src/digest/runner.js'

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
  CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts (memories_fts, rowid, text, tags) VALUES ('delete', old.id, old.text, old.tags);
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

test('listDshMemories: pinned first, tags split, total counted', () => {
  const home = mkdtempSync(join(tmpdir(), 'odm-mem-list-'))
  seed(home, [
    { text: 'Pinned preference', tags: 'preference habit', pinned: true },
    { text: 'Recent decision', tags: 'decision', pinned: false, skew: 3 },
    { text: 'Older', tags: '', pinned: false, skew: 1 },
  ])
  const empty = listDshMemories(join(home, 'missing'))
  assert.deepEqual(empty.memories, [])
  assert.equal(empty.total, 0)

  const { memories, total } = listDshMemories(home)
  assert.equal(total, 3)
  assert.equal(memories.length, 3)
  assert.equal(memories[0].text, 'Pinned preference')
  assert.equal(memories[0].pinned, true)
  assert.deepEqual(memories[0].tags, ['preference', 'habit'])
  assert.ok(memories[0].id >= 1)
  assert.ok(memories[0].updatedAt)
  assert.equal(memories[1].text, 'Recent decision')
  rmSync(home, { recursive: true, force: true })
})

test('listDshMemories: achievements outrank pinned timezone prefs', () => {
  const home = mkdtempSync(join(tmpdir(), 'odm-mem-rank-'))
  seed(home, [
    { text: 'User timezone is Asia/Shanghai', tags: 'preference', pinned: true },
    { text: 'Shipped Memory glimpse glass cards', tags: 'achievement', pinned: false, skew: 2 },
    { text: 'Prefer English UI', tags: 'preference', pinned: false, skew: 1 },
  ])
  const { memories } = listDshMemories(home)
  assert.equal(memories[0].text, 'Shipped Memory glimpse glass cards')
  assert.ok(memories.find(m => m.text.includes('Asia/Shanghai')))
  rmSync(home, { recursive: true, force: true })
})

test('forgetDshMemory: deletes one row; invalid id rejected', () => {
  const home = mkdtempSync(join(tmpdir(), 'odm-mem-forget-'))
  seed(home, [
    { text: 'Keep me', tags: 'preference', pinned: true },
    { text: 'Forget me', tags: 'decision', pinned: false, skew: 1 },
  ])
  const listed = listDshMemories(home)
  const victim = listed.memories.find(m => m.text === 'Forget me')
  assert.ok(victim)
  assert.equal(forgetDshMemory(home, 'nope').ok, false)
  assert.equal(forgetDshMemory(home, 0).ok, false)
  const r = forgetDshMemory(home, victim.id)
  assert.equal(r.ok, true)
  assert.equal(r.forgotten, true)
  const after = listDshMemories(home)
  assert.equal(after.total, 1)
  assert.equal(after.memories[0].text, 'Keep me')
  assert.equal(forgetDshMemory(home, victim.id).forgotten, false)
  rmSync(home, { recursive: true, force: true })
})

test('Memory 一瞥 chrome: nav + view + i18n + sources-only apps', () => {
  const html = readFileSync(new URL('../packages/dsh-muse-ui/static/index.html', import.meta.url), 'utf8')
  assert.match(html, /data-view="memory"/)
  assert.match(html, /id="v-memory"/)
  assert.match(html, /Memory 一瞥/)
  assert.match(html, /loadMemories/)
  assert.match(html, /appsMovedCard/)
  assert.match(html, /settings\.apps_moved/)
  // Settings no longer paints the full apps connection grid
  assert.doesNotMatch(html, /grid\.innerHTML = \(appsData\.apps/)
  const msgs = readFileSync(new URL('../src/i18n/messages.js', import.meta.url), 'utf8')
  assert.match(msgs, /'nav\.memory': 'Memories'/)
  assert.match(msgs, /'nav\.memory': '回忆'/)
  assert.match(msgs, /'memory\.empty_cta'/)
  assert.match(msgs, /'memory\.section_highlights'/)
  assert.match(msgs, /'memory\.tag_achievement'/)
  assert.match(html, /memIsHighlight/)
  assert.match(html, /mem-sections/)
  assert.match(html, /mem-title/)
  assert.match(html, /mem-summary/)
  assert.match(html, /is-achievement/)
  assert.match(html, /memory-present\.js/)
  assert.match(html, /memDetail/)
  assert.match(html, /mem-photo/)
  assert.match(html, /data-mem-add-photo/)
  assert.match(msgs, /'memory\.add_photo'/)
  assert.match(html, /mem-source/)
  assert.match(msgs, /'memory\.more'/)
  assert.match(msgs, /'memory\.source_openviking'/)
  const ops = readFileSync(new URL('../src/ui/ops.js', import.meta.url), 'utf8')
  assert.match(ops, /memory: '回忆'/)
  const api = readFileSync(new URL('../src/web/api.js', import.meta.url), 'utf8')
  assert.match(api, /\/api\/opendigitalmate\/memories/)
  assert.match(api, /listMemories/)
})
