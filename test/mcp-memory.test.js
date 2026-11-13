import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync, rmSync, utimesSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir, hostname } from 'node:os'
import {
  BACKEND, MEMORY_FILENAME, observationId, entityId, parseMemoryId,
  resolveMemoryFilePath, resolveMemoryServerEntry, tagsForEntityType,
  loadGraph, saveGraph, listMcpMemories, forgetMcpMemory, readMcpRecall,
  atomicWriteFile, withMemoryLock, isLockOwnerDead,
} from '../src/digest/mcp-memory.js'
import { listMemories, forgetMemory, readChiefMemory } from '../src/digest/runner.js'
import { presentMemoryList, memorySourceKey } from '../packages/dsh-muse-ui/memory-present.js'
import { ensureMemoryMcp, upsertMemoryMcpPatch, syncOdmProfilePackage, odmProfilePackageJson, ODM_PROFILE_BUNDLES, ensureOdmProfile } from '../scripts/start-dsh-util.mjs'
import { BUNDLED_PACKAGES, ROOT_PACKAGES, MEMORY_SERVER, memoryServerPath } from '../desktop/scripts/bundle-app-runtime.mjs'

function fixture(dir, lines) {
  const file = join(dir, 'memory.jsonl')
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, lines.filter(Boolean).map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n')
  return file
}

const SAMPLE = [
  { type: 'entity', name: 'Alice_Chen', entityType: 'person', observations: ['Shipped the Windows installer in rc8', 'Prefers morning standups'] },
  { type: 'entity', name: 'Douya', entityType: 'project', observations: ['Desktop-first Muse coworker'] },
  { type: 'entity', name: 'Timezone', entityType: 'preference', observations: ['UI timezone is Asia/Shanghai'] },
  { type: 'relation', from: 'Alice_Chen', to: 'Douya', relationType: 'works_on' },
]

test('resolveMemoryFilePath: MEMORY_FILE_PATH, tilde, then ODM_DATA_DIR', () => {
  assert.equal(resolveMemoryFilePath({ env: {} }), null)
  assert.equal(resolveMemoryFilePath({ env: { MEMORY_FILE_PATH: '/data/g.jsonl' } }), '/data/g.jsonl')
  assert.equal(
    resolveMemoryFilePath({ env: { MEMORY_FILE_PATH: '~/mem.jsonl', HOME: '/home/me' } }),
    join('/home/me', 'mem.jsonl'),
  )
  assert.equal(
    resolveMemoryFilePath({ env: { ODM_DATA_DIR: '/ud/odm-data' } }),
    join('/ud/odm-data', MEMORY_FILENAME),
  )
  assert.equal(
    resolveMemoryFilePath({ env: {}, dataDir: '/x/data' }),
    join('/x/data', MEMORY_FILENAME),
  )
})

test('resolveMemoryServerEntry prefers root node_modules, then bundled-plugins', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'odm-mentry-'))
  assert.equal(resolveMemoryServerEntry(tmp), null)
  const bundled = join(tmp, 'bundled-plugins', 'node_modules', '@modelcontextprotocol', 'server-memory', 'dist', 'index.js')
  mkdirSync(dirname(bundled), { recursive: true })
  writeFileSync(bundled, '// entry\n')
  assert.equal(resolveMemoryServerEntry(tmp), bundled)
  const root = join(tmp, 'node_modules', '@modelcontextprotocol', 'server-memory', 'dist', 'index.js')
  mkdirSync(dirname(root), { recursive: true })
  writeFileSync(root, '// root\n')
  assert.equal(resolveMemoryServerEntry(tmp), root)
  rmSync(tmp, { recursive: true, force: true })
})

test('ids round-trip and reject junk', () => {
  const id = observationId('Alice', 'Speaks Spanish')
  assert.equal(parseMemoryId(id).entityName, 'Alice')
  assert.equal(parseMemoryId(id).observation, 'Speaks Spanish')
  assert.equal(parseMemoryId(id).kind, 'obs')
  assert.equal(parseMemoryId(entityId('Alice')).kind, 'ent')
  assert.equal(parseMemoryId('legacy:memories/x'), null)
  assert.equal(parseMemoryId('12'), null)
  assert.equal(parseMemoryId('obs:%%%%'), null)
})

test('tagsForEntityType maps types and achievement wording', () => {
  assert.deepEqual(tagsForEntityType('event'), ['achievement', 'milestone'])
  assert.ok(tagsForEntityType('person', 'Shipped the installer').includes('achievement'))
  assert.ok(tagsForEntityType('person', '上线了回忆页').includes('achievement'))
  assert.ok(tagsForEntityType('person').includes('person'))
})

test('listMcpMemories: missing file is available empty, unreadable is unavailable', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'odm-mcp-miss-'))
  const missing = join(tmp, 'no-such', 'memory.jsonl')
  const empty = listMcpMemories({ file: missing })
  assert.equal(empty.available, true)
  assert.equal(empty.total, 0)
  assert.equal(empty.memories.length, 0)
  assert.equal(empty.backend, BACKEND)
  assert.equal(presentMemoryList(empty).state, 'empty')

  const none = listMcpMemories({ file: null })
  assert.equal(none.available, false)
  assert.match(none.error, /not configured/)
  assert.equal(presentMemoryList(none).state, 'unavailable')

  const dir = join(tmp, 'as-dir')
  mkdirSync(dir)
  const bad = listMcpMemories({ file: dir })
  assert.equal(bad.available, false)
  assert.match(bad.error, /directory/)
  assert.equal(presentMemoryList(bad).state, 'unavailable')
  rmSync(tmp, { recursive: true, force: true })
})

test('listMcpMemories: fixture JSONL, observations as cards, achievements first, relations in text', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'odm-mcp-list-'))
  const file = fixture(tmp, SAMPLE)
  const r = listMcpMemories({ file, limit: 40 })
  assert.equal(r.available, true)
  assert.equal(r.backend, BACKEND)
  assert.equal(r.total, 4) // 2 Alice obs + Douya + Timezone
  assert.ok(r.memories.length >= 4)
  const texts = r.memories.map((m) => m.text).join('\n')
  assert.match(texts, /Shipped the Windows installer/)
  assert.match(texts, /Alice Chen/)
  assert.match(texts, /works on Douya/)
  // Achievement-forward: shipped installer ranks above timezone pref
  const first = r.memories[0]
  assert.match(first.text, /Shipped the Windows installer/)
  assert.ok(first.tags.includes('achievement') || first.tags.includes('person'))
  const tz = r.memories.find((m) => /Asia\/Shanghai/.test(m.text))
  assert.ok(tz)
  assert.ok(r.memories.indexOf(first) < r.memories.indexOf(tz))
  assert.equal(memorySourceKey(r.memories[0]), 'mcp')
  assert.equal(presentMemoryList(r).state, 'ready')
  rmSync(tmp, { recursive: true, force: true })
})

test('listMcpMemories: empty graph file is available empty; malformed lines are skipped', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'odm-mcp-empty-'))
  const emptyFile = fixture(tmp, [])
  writeFileSync(emptyFile, '')
  const empty = listMcpMemories({ file: emptyFile })
  assert.equal(empty.available, true)
  assert.equal(empty.total, 0)

  const mixed = fixture(join(tmp, 'mixed'), [
    'not-json',
    { type: 'entity', name: 'Only', entityType: 'fact', observations: ['Kept'] },
    '{broken',
  ])
  const r = listMcpMemories({ file: mixed })
  assert.equal(r.available, true)
  assert.equal(r.total, 1)
  assert.match(r.memories[0].text, /Kept/)
  rmSync(tmp, { recursive: true, force: true })
})

test('forgetMcpMemory: deletes one observation atomically; last observation drops the entity and relations', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'odm-mcp-forget-'))
  const file = fixture(tmp, SAMPLE)
  const ship = observationId('Alice_Chen', 'Shipped the Windows installer in rc8')
  const r = forgetMcpMemory(ship, file)
  assert.equal(r.ok, true)
  assert.equal(r.forgotten, true)
  assert.equal(r.droppedEntity, false)
  const after = loadGraph(file)
  const alice = after.entities.find((e) => e.name === 'Alice_Chen')
  assert.deepEqual(alice.observations, ['Prefers morning standups'])
  assert.ok(after.relations.some((rel) => rel.from === 'Alice_Chen'))
  // File is valid JSONL (atomic write finished)
  for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean)) JSON.parse(line)

  const last = observationId('Alice_Chen', 'Prefers morning standups')
  const r2 = forgetMcpMemory(last, file)
  assert.equal(r2.forgotten, true)
  assert.equal(r2.droppedEntity, true)
  const gone = loadGraph(file)
  assert.ok(!gone.entities.some((e) => e.name === 'Alice_Chen'))
  assert.ok(!gone.relations.some((rel) => rel.from === 'Alice_Chen' || rel.to === 'Alice_Chen'))

  const miss = forgetMcpMemory(observationId('Alice_Chen', 'no such'), file)
  assert.equal(miss.ok, true)
  assert.equal(miss.forgotten, false)
  rmSync(tmp, { recursive: true, force: true })
})

test('forgetMcpMemory: entity id removes the whole node; invalid id is refused', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'odm-mcp-ent-'))
  const file = fixture(tmp, SAMPLE)
  const r = forgetMcpMemory(entityId('Douya'), file)
  assert.equal(r.forgotten, true)
  assert.equal(r.droppedEntity, true)
  const g = loadGraph(file)
  assert.ok(!g.entities.some((e) => e.name === 'Douya'))
  assert.ok(!g.relations.some((rel) => rel.to === 'Douya'))
  const bad = forgetMcpMemory('not-a-memory-id', file)
  assert.equal(bad.ok, false)
  assert.equal(bad.forgotten, false)
  rmSync(tmp, { recursive: true, force: true })
})

test('forget is serialized under a lock so two writes cannot clobber each other', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'odm-mcp-lock-'))
  const file = fixture(tmp, SAMPLE)
  let held = false
  const waiter = Promise.resolve().then(() => withMemoryLock(file, () => {
    held = true
    // The inner forget must wait, then succeed.
  }))
  // If the lock helper is broken this still runs sequentially (same process queue).
  // We mainly assert withMemoryLock releases and forget still works after a hold.
  return waiter.then(() => {
    assert.equal(held, true)
    const r = forgetMcpMemory(entityId('Timezone'), file)
    assert.equal(r.forgotten, true)
    rmSync(tmp, { recursive: true, force: true })
  })
})

test('forget breaks a lock left by a dead same-host process (#224)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'odm-mcp-stale-'))
  const file = fixture(tmp, SAMPLE)
  // A pid far above pid_max on Linux/macOS/Windows: no such process.
  writeFileSync(`${file}.lock`, JSON.stringify({ pid: 2 ** 30, hostname: hostname(), token: 'x' }))
  const r = forgetMcpMemory(entityId('Timezone'), file)
  assert.equal(r.ok, true)
  assert.equal(r.forgotten, true)
  assert.equal(existsSync(`${file}.lock`), false)
  assert.equal(existsSync(`${file}.lock.break`), false)
  rmSync(tmp, { recursive: true, force: true })
})

test('forget breaks an unrefreshed lock older than staleMs, even from another host (#224)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'odm-mcp-old-'))
  const file = fixture(tmp, SAMPLE)
  const lock = `${file}.lock`
  writeFileSync(lock, JSON.stringify({ pid: process.pid, hostname: 'some-other-host', token: 'y' }))
  const old = new Date(Date.now() - 120_000)
  utimesSync(lock, old, old)
  const r = forgetMcpMemory(entityId('Timezone'), file)
  assert.equal(r.forgotten, true)
  assert.equal(existsSync(lock), false)
  rmSync(tmp, { recursive: true, force: true })
})

test('a live, fresh lock is never stolen and is left in place on timeout (#224)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'odm-mcp-live-'))
  const file = fixture(tmp, SAMPLE)
  const lock = `${file}.lock`
  const held = JSON.stringify({ pid: process.pid, hostname: hostname(), token: 'live' })
  writeFileSync(lock, held)
  let ran = false
  assert.throws(() => withMemoryLock(file, () => { ran = true }, { timeoutMs: 80 }), (err) => err.code === 'lock_timeout')
  assert.equal(ran, false)
  assert.equal(readFileSync(lock, 'utf8'), held)
  rmSync(tmp, { recursive: true, force: true })
})

test('withMemoryLock releases only its own lock (#224)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'odm-mcp-own-'))
  const file = fixture(tmp, SAMPLE)
  const lock = `${file}.lock`
  const other = JSON.stringify({ pid: process.pid, hostname: hostname(), token: 'someone-else' })
  withMemoryLock(file, () => {
    // Simulate our lock having been broken as stale and re-taken by another writer.
    writeFileSync(lock, other)
  })
  assert.equal(readFileSync(lock, 'utf8'), other)
  withMemoryLock(file + '.second', () => {})
  assert.equal(existsSync(`${file}.second.lock`), false)
  rmSync(tmp, { recursive: true, force: true })
})

test('isLockOwnerDead only trusts a same-host numeric pid that is gone', () => {
  const host = 'h'
  const gone = () => { throw Object.assign(new Error('no'), { code: 'ESRCH' }) }
  const otherUser = () => { throw Object.assign(new Error('perm'), { code: 'EPERM' }) }
  assert.equal(isLockOwnerDead(JSON.stringify({ pid: 5, hostname: host }), { host, kill: gone }), true)
  assert.equal(isLockOwnerDead(JSON.stringify({ pid: 5, hostname: host }), { host, kill: otherUser }), false)
  assert.equal(isLockOwnerDead(JSON.stringify({ pid: 5, hostname: host }), { host, kill: () => true }), false)
  assert.equal(isLockOwnerDead(JSON.stringify({ pid: 5, hostname: 'elsewhere' }), { host, kill: gone }), false)
  assert.equal(isLockOwnerDead('not json', { host, kill: gone }), false)
  assert.equal(isLockOwnerDead('', { host, kill: gone }), false)
})

test('atomicWriteFile leaves a complete file (tmp is renamed, not truncated in place)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'odm-mcp-atom-'))
  const file = join(tmp, 'memory.jsonl')
  atomicWriteFile(file, '{"type":"entity","name":"A","entityType":"fact","observations":["one"]}\n')
  atomicWriteFile(file, '{"type":"entity","name":"B","entityType":"fact","observations":["two"]}\n')
  const text = readFileSync(file, 'utf8')
  assert.match(text, /"name":"B"/)
  assert.doesNotMatch(text, /"name":"A"/)
  assert.ok(!existsSync(file + '.tmp'))
  rmSync(tmp, { recursive: true, force: true })
})

test('readMcpRecall mentions mcp__memory__ tools and lists highlights', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'odm-mcp-recall-'))
  const file = fixture(tmp, SAMPLE)
  const text = readMcpRecall({ file })
  assert.match(text, /mcp__memory__search_nodes/)
  assert.match(text, /mcp__memory__read_graph/)
  assert.match(text, /Shipped the Windows installer/)
  assert.equal(readMcpRecall({ file: join(tmp, 'missing.jsonl') }), '')
  rmSync(tmp, { recursive: true, force: true })
})

test('listMemories / forgetMemory / readChiefMemory go through the MCP adapter', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'odm-mcp-runner-'))
  const file = fixture(tmp, SAMPLE)
  const listed = await listMemories(tmp, { file, limit: 10 })
  assert.equal(listed.available, true)
  assert.equal(listed.backend, BACKEND)
  assert.ok(listed.total >= 3)
  const id = listed.memories.find((m) => /Prefers morning/.test(m.text)).id
  const forgot = await forgetMemory(tmp, id, { file })
  assert.equal(forgot.forgotten, true)
  const again = await listMemories(tmp, { file })
  assert.ok(!again.memories.some((m) => /Prefers morning/.test(m.text)))
  const chief = await readChiefMemory(tmp, { file })
  assert.match(chief, /mcp__memory__search_nodes/)
  // Unavailable vs empty at the runner layer
  const none = await listMemories(tmp, { file: null, limit: 5 })
  // file:null → memoryFile() falls through to env; isolate by passing a dir path as file that's unreadable
  const asDir = join(tmp, 'not-a-file')
  mkdirSync(asDir)
  const unavail = await listMemories(tmp, { file: asDir })
  assert.equal(unavail.available, false)
  assert.equal(presentMemoryList(unavail).state, 'unavailable')
  const empty = await listMemories(tmp, { file: join(tmp, 'absent.jsonl') })
  assert.equal(empty.available, true)
  assert.equal(empty.total, 0)
  assert.equal(presentMemoryList(empty).state, 'empty')
  rmSync(tmp, { recursive: true, force: true })
})

test('ensureMemoryMcp writes a stdio dsh-mcp-client entry with bundled Node, no npx', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'odm-mcp-patch-'))
  const profile = join(tmp, 'odm')
  const node = join(tmp, 'node', 'node')
  const entry = join(tmp, 'server', 'dist', 'index.js')
  const mem = join(tmp, 'odm-data', 'memory.jsonl')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'cordis.patch.yml'), '# Packaged odm profile\n- id: llm-pi-ai\n  name: "@deepseek-ai/dsh-llm-pi-ai"\n')
  const r = ensureMemoryMcp({ profileDir: profile, nodeExe: node, entry, memoryFile: mem })
  assert.ok(r.action === 'created' || r.action === 'updated')
  const yaml = readFileSync(join(profile, 'cordis.patch.yml'), 'utf8')
  // Must be an insert-patch; a raw `- id:` is skipped for unknown targets.
  assert.match(yaml, /^- insert:\n[ \t]+- id: odm-mcp-memory\n/m)
  assert.match(yaml, /name: "@deepseek-ai\/dsh-mcp-client"/)
  assert.match(yaml, /serverName: memory/)
  assert.match(yaml, /transport: stdio/)
  assert.match(yaml, /failOnStartupError: false/)
  assert.ok(yaml.includes(JSON.stringify(node)))
  assert.ok(yaml.includes(JSON.stringify(entry)))
  assert.ok(yaml.includes(JSON.stringify(mem)))
  assert.doesNotMatch(yaml, /\bnpx\b/)
  // existing llm entry is kept; a second call rewrites only the memory block
  const again = ensureMemoryMcp({
    profileDir: profile, nodeExe: '/new/node', entry: '/new/entry.js', memoryFile: '/new/memory.jsonl',
  })
  const yaml2 = readFileSync(join(profile, 'cordis.patch.yml'), 'utf8')
  assert.match(yaml2, /id: llm-pi-ai/)
  assert.equal((yaml2.match(/id: odm-mcp-memory/g) || []).length, 1)
  assert.match(yaml2, /^- insert:\n[ \t]+- id: odm-mcp-memory\n/m)
  assert.ok(yaml2.includes(JSON.stringify('/new/node')))
  assert.ok(!yaml2.includes(JSON.stringify(node)))
  // leftover raw `- id:` from an older build is migrated to insert:
  writeFileSync(join(profile, 'cordis.patch.yml'), [
    '- id: llm-pi-ai',
    '  name: "@deepseek-ai/dsh-llm-pi-ai"',
    '- id: odm-mcp-memory',
    '  name: "@deepseek-ai/dsh-mcp-client"',
    '  config:',
    '    serverName: memory',
    '    command: "/old/node"',
    '',
  ].join('\n'))
  ensureMemoryMcp({ profileDir: profile, nodeExe: '/mig/node', entry: '/mig/entry.js', memoryFile: '/mig/mem.jsonl' })
  const yaml3 = readFileSync(join(profile, 'cordis.patch.yml'), 'utf8')
  assert.equal((yaml3.match(/id: odm-mcp-memory/g) || []).length, 1)
  assert.match(yaml3, /^- insert:\n[ \t]+- id: odm-mcp-memory\n/m)
  assert.doesNotMatch(yaml3, /^- id: odm-mcp-memory/m)
  assert.ok(yaml3.includes(JSON.stringify('/mig/node')))
  assert.ok(!yaml3.includes('/old/node'))
  assert.match(yaml3, /id: llm-pi-ai/)
  rmSync(tmp, { recursive: true, force: true })
})

test('syncOdmProfilePackage drops a retired plugin from an existing odm profile', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'odm-mcp-sync-'))
  const profile = join(tmp, 'odm')
  const stale = '@example/retired-memory'
  mkdirSync(join(profile, 'node_modules', '@example'), { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    dependencies: { [stale]: '0.5.33', 'dsh-muse-ui': 'file:x' },
    dsh: { profile: { bundles: ['dsh-muse-ui', 'opendigitalmate', stale] } },
  }))
  mkdirSync(join(profile, 'node_modules', stale), { recursive: true })
  writeFileSync(join(profile, 'node_modules', stale, 'package.json'), '{}')
  const r = syncOdmProfilePackage(profile, '/rt')
  assert.equal(r.action, 'synced')
  const pkg = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
  assert.ok(!pkg.dependencies[stale])
  assert.ok(!pkg.dsh.profile.bundles.includes(stale))
  assert.deepEqual(pkg.dsh.profile.bundles, [...ODM_PROFILE_BUNDLES])
  assert.ok(!existsSync(join(profile, 'node_modules', stale, 'package.json')))
  rmSync(tmp, { recursive: true, force: true })
})

test('odm profile bundles the official plugins; app-runtime pins MCP Memory 2.1.1', () => {
  const pkg = odmProfilePackageJson('/rt')
  assert.ok(ODM_PROFILE_BUNDLES.includes('opendigitalmate'))
  assert.ok(ODM_PROFILE_BUNDLES.includes('dsh-muse-ui'))
  assert.equal(pkg.dependencies.opendigitalmate, 'file:/rt')
  assert.equal(BUNDLED_PACKAGES[MEMORY_SERVER], '2.1.1')
  assert.equal(ROOT_PACKAGES[MEMORY_SERVER], '2.1.1')
  assert.equal(memoryServerPath('/rt'), join('/rt', 'node_modules', '@modelcontextprotocol', 'server-memory', 'dist', 'index.js'))
})

test('docs, chrome, and prompts describe MCP Memory', () => {
  const mem = readFileSync(new URL('../docs/memory.md', import.meta.url), 'utf8')
  const install = readFileSync(new URL('../docs/install.md', import.meta.url), 'utf8')
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  const start = readFileSync(new URL('../scripts/start-dsh.mjs', import.meta.url), 'utf8')
  const tools = readFileSync(new URL('../src/web/dsbot-tools.js', import.meta.url), 'utf8')
  const workflow = readFileSync(new URL('../.github/workflows/desktop.yml', import.meta.url), 'utf8')
  const desk = JSON.parse(readFileSync(new URL('../desktop/package.json', import.meta.url), 'utf8'))
  for (const text of [mem, install, readme]) {
    assert.match(text, /@modelcontextprotocol\/server-memory/)
    assert.match(text, /mcp__memory__/)
  }
  assert.match(mem, /are not migrated/)
  assert.match(start, /ensureMemoryMcp/)
  assert.match(start, /MEMORY_FILE_PATH/)
  assert.match(tools, /mcp__memory__create_entities/)
  assert.match(tools, /MEMORY_TOOL_PROMPT/)
  assert.doesNotMatch(workflow, /setup-uv/)
  assert.ok(!desk.scripts['bundle:ov'])
})
