import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { presentMemoryList } from '../packages/dsh-muse-ui/memory-present.js'
import { t } from '../src/i18n/index.js'

/** Chrome the Recall painter shows for a listMemories payload, using the shared presentment helper. */
function paintRecall(data, lang) {
  const view = presentMemoryList(data)
  const count = view.state === 'unavailable'
    ? t('memory.unavailable_count', lang)
    : view.total === 1
      ? t('memory.count_one', lang)
      : t('memory.count', lang, { n: view.total })
  const title = view.state === 'unavailable'
    ? t('memory.unavailable_title', lang)
    : view.state === 'empty'
      ? t('memory.empty_title', lang)
      : ''
  const body = view.state === 'unavailable'
    ? t('memory.unavailable_body', lang)
    : view.state === 'empty'
      ? t('memory.empty_body', lang)
      : ''
  const cta = view.state === 'unavailable'
    ? t('memory.unavailable_cta', lang)
    : view.state === 'empty'
      ? t('memory.empty_cta', lang)
      : ''
  return { view, count, title, body, cta }
}

test('presentMemoryList: available:false with no rows is unavailable, not empty', () => {
  const down = presentMemoryList({ available: false, total: 0, memories: [], error: 'fetch failed' })
  assert.equal(down.state, 'unavailable')
  assert.equal(down.total, 0)
  assert.deepEqual(down.memories, [])
  assert.match(down.error, /fetch failed/)
})

test('presentMemoryList: available:true total:0 is a truly empty library', () => {
  const empty = presentMemoryList({ available: true, total: 0, memories: [] })
  assert.equal(empty.state, 'empty')
  assert.equal(empty.total, 0)
  assert.deepEqual(empty.memories, [])
  assert.equal(empty.error, '')
})

test('presentMemoryList: fallback rows still show even when the MCP file is unreadable', () => {
  const rows = [{ id: 1, text: 'Prefer English UI' }]
  const view = presentMemoryList({
    available: false,
    total: 1,
    memories: rows,
    backend: 'dsh-memory',
    error: 'fetch failed',
  })
  assert.equal(view.state, 'ready')
  assert.equal(view.total, 1)
  assert.equal(view.memories, rows)
})

test('presentMemoryList: a loaded library is ready', () => {
  const rows = [{ id: 'ent:Shipped_Recall', text: 'Shipped Recall' }]
  const view = presentMemoryList({ available: true, total: 3, memories: rows })
  assert.equal(view.state, 'ready')
  assert.equal(view.total, 3)
  assert.equal(view.memories, rows)
})

test('unavailable chrome is not a zero-count empty library (ZH and EN)', () => {
  for (const lang of ['zh', 'en']) {
    const r = paintRecall({ available: false, total: 0, memories: [], error: 'fetch failed' }, lang)
    assert.equal(r.view.state, 'unavailable')
    assert.notEqual(r.count, t('memory.count', lang, { n: 0 }))
    assert.notEqual(r.count, t('memory.count_one', lang))
    assert.notEqual(r.title, t('memory.empty_title', lang))
    assert.notEqual(r.body, t('memory.empty_body', lang))
    assert.notEqual(r.cta, t('memory.empty_cta', lang))
  }
  const zh = paintRecall({ available: false, total: 0, memories: [], error: 'fetch failed' }, 'zh')
  assert.equal(zh.count, '暂时读不到')
  assert.equal(zh.title, '暂时读不到回忆')
  assert.match(zh.body, /不是空的回忆库/)
  assert.notEqual(zh.count, '记得 0 件')
  assert.notEqual(zh.title, '还没有回忆')

  const en = paintRecall({ available: false, total: 0, memories: [], error: 'fetch failed' }, 'en')
  assert.equal(en.count, "Couldn't load")
  assert.match(en.title, /unavailable/i)
  assert.match(en.body, /isn.t an empty library|not an empty library/i)
  assert.notEqual(en.count, '0 remembered')
  assert.notEqual(en.title, 'Nothing remembered yet')
})

test('truly empty library still shows a zero count and the empty-state copy', () => {
  const zh = paintRecall({ available: true, total: 0, memories: [] }, 'zh')
  assert.equal(zh.view.state, 'empty')
  assert.equal(zh.count, '记得 0 件')
  assert.equal(zh.title, '还没有回忆')
  assert.equal(zh.cta, '跟豆芽说一件要记住的')

  const en = paintRecall({ available: true, total: 0, memories: [] }, 'en')
  assert.equal(en.view.state, 'empty')
  assert.equal(en.count, '0 remembered')
  assert.equal(en.title, 'Nothing remembered yet')
  assert.equal(en.cta, 'Tell Douya something to keep')
})

test('paintMemories consults presentMemoryList and paints unavailable before the empty library', () => {
  const html = readFileSync(new URL('../packages/dsh-muse-ui/static/index.html', import.meta.url), 'utf8')
  const start = html.indexOf('function paintMemories')
  const end = html.indexOf('let memSeq', start)
  assert.ok(start > 0 && end > start, 'paintMemories is in the Muse page')
  const fn = html.slice(html.indexOf('function memListView'), end)

  assert.match(fn, /presentMemoryList/)
  assert.match(fn, /data\.available === false/)
  assert.match(fn, /view\.state === 'unavailable'/)
  assert.match(fn, /memory\.unavailable_count/)
  assert.match(fn, /memory\.unavailable_title/)
  assert.match(fn, /memory\.unavailable_body/)
  assert.match(fn, /memory\.unavailable_cta/)
  assert.match(fn, /mem-empty is-unavailable/)

  // Empty-library chrome stays for a true empty list, after the unavailable branch returns.
  const unavailableAt = fn.indexOf("view.state === 'unavailable'")
  const emptyTitleAt = fn.indexOf("memory.empty_title")
  const emptyCountAt = fn.indexOf("memory.count")
  assert.ok(unavailableAt > 0 && emptyTitleAt > unavailableAt, 'empty title is not used for the unavailable branch')
  assert.ok(emptyCountAt > 0)

  const catchStart = html.indexOf('async function loadMemories')
  const catchFn = html.slice(catchStart, html.indexOf('window.loadMemories', catchStart))
  assert.match(catchFn, /paintMemories\(\{ available: false/)
})
