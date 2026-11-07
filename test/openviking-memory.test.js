import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  listOpenVikingMemories,
  forgetOpenVikingMemory,
  readOpenVikingRecall,
  resolveOpenVikingConfig,
  CATEGORY_TAGS,
} from '../src/digest/openviking.js'
import { listMemories, forgetMemory } from '../src/digest/runner.js'

test('resolveOpenVikingConfig defaults to local 1933', () => {
  const cfg = resolveOpenVikingConfig({ OPENVIKING_URL: '', OPENVIKING_API_KEY: '' })
  assert.match(cfg.url, /1933|openviking/i)
})

test('CATEGORY_TAGS maps experiences/events to achievement', () => {
  assert.ok(CATEGORY_TAGS.experiences.includes('achievement'))
  assert.ok(CATEGORY_TAGS.events.includes('achievement'))
  assert.ok(CATEGORY_TAGS.preferences.includes('preference'))
})

test('listOpenVikingMemories: unreachable server → available:false', async () => {
  const prev = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED') }
  try {
    const r = await listOpenVikingMemories({
      limit: 10,
      cfg: { url: 'http://127.0.0.1:19999', apiKey: '', account: '', user: '' },
    })
    assert.equal(r.available, false)
    assert.equal(r.backend, 'openviking')
    assert.equal(r.memories.length, 0)
  } finally {
    globalThis.fetch = prev
  }
})

test('listOpenVikingMemories: maps ls files + ranks achievement first', async () => {
  const prev = globalThis.fetch
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.includes('/health')) {
      return new Response(JSON.stringify({ status: 'ok', healthy: true }), { status: 200 })
    }
    if (u.includes('/api/v1/fs/ls')) {
      return new Response(JSON.stringify({
        status: 'ok',
        result: [
          {
            name: 'timezone.md',
            isDir: false,
            uri: 'viking://user/me/memories/preferences/timezone.md',
            modTime: '2026-11-07T01:00:00Z',
            abstract: 'User timezone is Asia/Shanghai',
            tags: ['preference'],
          },
          {
            name: 'shipped-glimpse.md',
            isDir: false,
            uri: 'viking://user/me/memories/experiences/shipped-glimpse.md',
            modTime: '2026-11-07T02:00:00Z',
            abstract: 'Shipped Memory glimpse glass cards',
          },
          {
            name: 'preferences',
            isDir: true,
            uri: 'viking://user/me/memories/preferences/',
          },
        ],
      }), { status: 200 })
    }
    return new Response('nope', { status: 404 })
  }
  try {
    const r = await listOpenVikingMemories({
      limit: 10,
      cfg: { url: 'http://ov.test', apiKey: '', account: '', user: '' },
    })
    assert.equal(r.available, true)
    assert.equal(r.backend, 'openviking')
    assert.equal(r.memories[0].text, 'Shipped Memory glimpse glass cards')
    assert.ok(r.memories[0].tags.includes('achievement'))
    assert.ok(r.memories[0].id.startsWith('viking://'))
    assert.ok(r.memories.find(m => m.text.includes('Asia/Shanghai')))
  } finally {
    globalThis.fetch = prev
  }
})

test('forgetOpenVikingMemory: DELETE /api/v1/fs', async () => {
  const prev = globalThis.fetch
  let deleted = null
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url)
    if (u.includes('/api/v1/fs') && (opts.method || 'GET').toUpperCase() === 'DELETE') {
      deleted = u
      return new Response(JSON.stringify({ status: 'ok', result: { uri: 'viking://~/memories/preferences/x.md' } }), { status: 200 })
    }
    return new Response('nope', { status: 404 })
  }
  try {
    const bad = await forgetOpenVikingMemory(12)
    assert.equal(bad.ok, false)
    const r = await forgetOpenVikingMemory('viking://~/memories/preferences/x.md', {
      url: 'http://ov.test', apiKey: 'k', account: '', user: '',
    })
    assert.equal(r.ok, true)
    assert.equal(r.forgotten, true)
    assert.match(deleted, /uri=viking/)
  } finally {
    globalThis.fetch = prev
  }
})

test('forgetMemory routes viking:// to OpenViking', async () => {
  const prev = globalThis.fetch
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).includes('/api/v1/fs') && (opts.method || '').toUpperCase() === 'DELETE') {
      return new Response(JSON.stringify({ status: 'ok', result: {} }), { status: 200 })
    }
    return new Response('nope', { status: 404 })
  }
  try {
    const r = await forgetMemory('/tmp', 'viking://~/memories/events/a.md')
    assert.equal(r.forgotten, true)
    assert.equal(r.backend, 'openviking')
  } finally {
    globalThis.fetch = prev
  }
})

test('readOpenVikingRecall empty when unhealthy', async () => {
  const prev = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('down') }
  try {
    assert.equal(await readOpenVikingRecall({ cfg: { url: 'http://127.0.0.1:9', apiKey: '', account: '', user: '' } }), '')
  } finally {
    globalThis.fetch = prev
  }
})

test('chrome + docs mention OpenViking memory', () => {
  const html = readFileSync(new URL('../packages/dsh-muse-ui/static/index.html', import.meta.url), 'utf8')
  assert.match(html, /OpenViking/)
  assert.match(html, /body: JSON\.stringify\(\{ id \}\)/)
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  assert.match(readme, /@openviking\/dsh-memory-plugin/)
  assert.match(readme, /ovcli\.conf/)
  assert.doesNotMatch(readme, /Want something more advanced\? Ready-made options/)
  const start = readFileSync(new URL('../scripts/start-dsh.mjs', import.meta.url), 'utf8')
  assert.match(start, /@openviking\/dsh-memory-plugin/)
  const api = readFileSync(new URL('../src/web/api.js', import.meta.url), 'utf8')
  assert.match(api, /listMemoriesStore/)
})

test('listMemories falls back to empty when OV down and no sqlite', async () => {
  const prev = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED') }
  try {
    const r = await listMemories('/tmp/no-such-odm-home', { limit: 5 })
    assert.equal(r.available, false)
    assert.deepEqual(r.memories, [])
  } finally {
    globalThis.fetch = prev
  }
})
