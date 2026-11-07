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

import {
  splitMemoryImages,
  decodeMemoryImageRef,
  memoryImageSrc,
  recallSlug,
  attachMemoryImage,
  downloadMemoryImage,
} from '../src/digest/openviking.js'

test('splitMemoryImages: image lines become same-origin srcs; text keeps no viking:// image link', () => {
  const r = splitMemoryImages('# Demo day\n\nWe shipped it.\n\n![Demo day](viking://resources/recall/events--demo/abc/team.png)\n')
  assert.equal(r.text, '# Demo day\n\nWe shipped it.')
  assert.equal(r.images.length, 1)
  assert.equal(r.images[0].caption, 'Demo day')
  assert.match(r.images[0].src, /^\/api\/opendigitalmate\/memories\/image\?ref=[A-Za-z0-9_-]+$/)
  assert.equal(decodeMemoryImageRef(r.images[0].src.split('ref=')[1]), 'viking://resources/recall/events--demo/abc/team.png')
})

test('decodeMemoryImageRef: only viking://resources/recall/… is served', () => {
  const ref = (u) => memoryImageSrc(u).split('ref=')[1]
  assert.equal(decodeMemoryImageRef(ref('viking://user/default/memories/soul.md')), '')
  assert.equal(decodeMemoryImageRef(ref('viking://resources/recall/../secret')), '')
  assert.equal(decodeMemoryImageRef('%%%'), '')
})

test('recallSlug: memory path → one folder per memory', () => {
  assert.equal(recallSlug('viking://user/default/memories/experiences/odm-ship.md'), 'experiences--odm-ship')
  assert.equal(recallSlug('viking://~/memories/soul.md'), 'soul')
})

test('attachMemoryImage: rejects non-memory ids, non-images and >5 MB without calling OpenViking', async () => {
  const prev = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new Error('should not fetch') }
  try {
    const cfg = { url: 'http://127.0.0.1:19999', apiKey: '', account: '', user: '' }
    assert.equal((await attachMemoryImage({ id: 'viking://resources/x', data: 'AAAA', type: 'image/png' }, cfg)).ok, false)
    assert.equal((await attachMemoryImage({ id: 'viking://~/memories/a.md', data: 'AAAA', type: 'text/html' }, cfg)).ok, false)
    const big = Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64')
    assert.match((await attachMemoryImage({ id: 'viking://~/memories/a.md', data: big, type: 'image/png' }, cfg)).error, /5 MB/)
    assert.equal(calls, 0)
  } finally {
    globalThis.fetch = prev
  }
})

test('attachMemoryImage: upload → add_resource under recall/<memory>/ → append image line to the memory', async () => {
  const prev = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url))
    seen.push({ path: u.pathname, method: init.method || 'GET', body: typeof init.body === 'string' ? JSON.parse(init.body) : null, query: Object.fromEntries(u.searchParams) })
    const ok = (result) => new Response(JSON.stringify({ status: 'ok', result }), { status: 200 })
    if (u.pathname === '/api/v1/resources/temp_upload') return ok({ temp_file_id: 'upload_1.png' })
    if (u.pathname === '/api/v1/resources') return ok({ status: 'success' })
    if (u.pathname === '/api/v1/fs/ls') return ok([{ isDir: false, uri: u.searchParams.get('uri') + 'team.png' }])
    if (u.pathname === '/api/v1/content/write') return ok({ mode: 'append' })
    throw new Error('unexpected ' + u.pathname)
  }
  try {
    const cfg = { url: 'http://ov.test', apiKey: '', account: '', user: '' }
    const r = await attachMemoryImage({ id: 'viking://user/default/memories/events/demo.md', data: 'data:image/png;base64,iVBORw0KGgo=', name: 'Team Photo.PNG', caption: 'Demo [day]' }, cfg)
    assert.equal(r.ok, true)
    const add = seen.find(s => s.path === '/api/v1/resources')
    assert.match(add.body.to, /^viking:\/\/resources\/recall\/events--demo\/[a-z0-9]+\/$/)
    assert.equal(add.body.wait, false)
    const write = seen.find(s => s.path === '/api/v1/content/write')
    assert.equal(write.body.mode, 'append')
    assert.equal(write.body.uri, 'viking://user/default/memories/events/demo.md')
    assert.match(write.body.content, /^\n\n!\[Demo day\]\(viking:\/\/resources\/recall\/events--demo\/[a-z0-9]+\/team\.png\)\n$/)
    assert.equal(decodeMemoryImageRef(r.image.src.split('ref=')[1]), r.image.uri)
  } finally {
    globalThis.fetch = prev
  }
})

test('downloadMemoryImage: bad ref is 400 and never fetches', async () => {
  const prev = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('should not fetch') }
  try {
    const r = await downloadMemoryImage('bad', { url: 'http://ov.test' })
    assert.equal(r.ok, false)
    assert.equal(r.status, 400)
  } finally {
    globalThis.fetch = prev
  }
})
