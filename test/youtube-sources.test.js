import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchFromSources, normalizeItems, clusterByProjectTheme, generateClusterCards } from '../src/web/aggregation.js'
import { fetchYouTube } from '../src/web/youtube.js'
import { fetchRecipe, SOURCE_RECIPES, sourceCluster } from '../src/web/source-recipes.js'
import { auxSources } from '../src/digest/runner.js'
import { digestRoleForToolkit } from '../src/digest/channels.js'
import { t } from '../src/i18n/index.js'
const account = slug => ({ id: `ca_${slug}`, status: 'ACTIVE', toolkit: { slug } })
const recent = new Date().toISOString()

test('YouTube subscriptions → recent uploads → one compact linked card; pins connected account', async () => {
  const calls = []
  const client = { async executeAction(action, args, pin) {
    calls.push({ action, args, pin })
    if (action === 'YOUTUBE_LIST_USER_SUBSCRIPTIONS') return { data: { items: [{ snippet: { title: 'Channel', resourceId: { channelId: 'UC_test' } } }] } }
    return { successful: true, data: { items: [
      { snippet: { title: 'New video', channelTitle: 'Channel', publishedAt: recent }, contentDetails: { upload: { videoId: 'video_12345' } } },
      { snippet: { title: 'Duplicate', publishedAt: recent }, contentDetails: { upload: { videoId: 'video_12345' } } },
      { snippet: { title: 'Old', publishedAt: '2000-01-01T00:00:00Z' }, contentDetails: { upload: { videoId: 'old' } } },
      { snippet: { title: 'Not an upload', publishedAt: recent }, contentDetails: { playlistItem: {} } },
    ] } }
  } }
  const data = await fetchFromSources(client, [account('youtube')])
  assert.equal(data.youtube.videos.length, 1)
  assert.equal(calls.length, 2)
  assert.ok(calls.every(c => c.pin.connectedAccountId === 'ca_youtube'))
  const items = normalizeItems(data)
  assert.equal(items[0].sourceId, 'youtube:video:video_12345')
  assert.equal(items[0].publishedAt, recent)
  const clusters = clusterByProjectTheme(items)
  assert.equal(clusters.length, 1)
  const [card] = generateClusterCards({ urgent: [], action: [], fyi: clusters })
  assert.match(card.title, /1 new videos/)
  assert.equal(card.blocks[0].links[0].url, 'https://www.youtube.com/watch?v=video_12345')
  assert.match(clusterByProjectTheme(items, { lang: 'zh' })[0].title, /1 个新视频/)
})

test('YouTube caps subscriptions, request fanout, and surfaces limited coverage', async () => {
  let calls = 0
  const data = await fetchYouTube({ async executeAction(a) {
    calls++
    return { data: a === 'YOUTUBE_LIST_USER_SUBSCRIPTIONS' ? { nextPageToken: 'more', items: Array.from({ length: 30 }, (_, n) => ({ snippet: { resourceId: { channelId: `UC_${n}` } } })) } : { items: [] } }
  } }, account('youtube'))
  assert.equal(calls, 11)
  assert.equal(data.truncated, true)
})

test('failed and timed-out YouTube reads are not empty success', async () => {
  await assert.rejects(fetchYouTube({ executeAction: async () => ({ successful: false, error: 'expired' }) }, account('youtube')), /read failed/)
  await assert.rejects(fetchYouTube({ executeAction: () => new Promise(() => {}) }, account('youtube'), { timeoutMs: 5 }), /timed out/)
  const data = await fetchFromSources({ executeAction: async () => ({ successful: false }) }, [account('youtube')])
  assert.ok(data.errors.youtube)
  assert.equal(data.youtube, undefined)
})

test('generic Notion recipe filters old/invalid links, produces bilingual compact card', async () => {
  const calls = []
  const client = { async executeAction(...args) { calls.push(args); return { data: { results: [
    { id: 'page1', properties: { Name: { type: 'title', title: [{ plain_text: 'Notes' }] } }, url: 'https://notion.so/page1', last_edited_time: recent },
    { id: 'bad', title: 'Unsafe', url: 'javascript:alert(1)', last_edited_time: recent },
    { id: 'old', title: 'Old', url: 'https://notion.so/old', last_edited_time: '2000-01-01T00:00:00Z' },
  ] } } } }
  const data = await fetchFromSources(client, [account('notion')])
  const items = normalizeItems(data)
  assert.equal(items.length, 1)
  assert.equal(calls[0][0], 'NOTION_SEARCH_NOTION_PAGE')
  assert.equal(calls[0][2].connectedAccountId, 'ca_notion')
  assert.equal(sourceCluster(items, 'zh').title, 'notion · 1 条最近动态')
  assert.equal(clusterByProjectTheme(items).length, 1)
})

test('every generic recipe is bounded and dedicated sources retain routing', async () => {
  for (const [slug, r] of Object.entries(SOURCE_RECIPES)) {
    assert.match(r.action, /^[A-Z_]+$/)
    assert.deepEqual(digestRoleForToolkit(slug), { role: 'aux-fetch', channel: slug })
    await assert.rejects(fetchRecipe({ executeAction: () => new Promise(() => {}) }, account(slug), { timeoutMs: 1 }), /timed out/)
  }
  assert.equal(digestRoleForToolkit('gmail').role, 'source-bot')
})

test('all connected toolkits get a status row, unsupported never fetch, broken supported fail visibly', () => {
  const rows = auxSources([account('youtube'), account('notion'), account('unknown_toolkit'), { ...account('outlook'), status: 'EXPIRED' }])
  assert.equal(rows.youtube.status, 'queued')
  assert.equal(rows.notion.status, 'queued')
  assert.equal(rows.unknown_toolkit.status, 'not-scanned')
  assert.equal(rows.unknown_toolkit.account, undefined)
  assert.equal(rows.outlook.status, 'failed')
  assert.equal(t('sources.not_scanned', 'zh'), '已连接 · 暂不扫描')
  assert.equal(t('sources.not_scanned', 'en'), 'Connected · not scanned yet')
  assert.deepEqual(auxSources([account('notion'), account('youtube')], { only: ['youtube'] }), { youtube: rows.youtube })
})

test('aux-only run commits YouTube and generic cards, skips Chief, preserves unsupported status rows', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createBotDigest, createDigestStore } = await import('../src/digest/runner.js')
  const { createStore } = await import('../src/host/store.js')
  const home = await mkdtemp(join(tmpdir(), 'odm-generic-test-'))
  let committed
  try {
    const runner = createBotDigest({ ctx: {}, home, store: createStore(join(home, 'state.json')), digestStore: createDigestStore(home),
      aggregation: { ...await import('../src/web/aggregation.js'), fetchFromSources: async (_, [a]) => a.toolkit.slug === 'youtube'
        ? { youtube: { videos: [{ id: 'video_12345', title: 'Video', channel: 'Channel', publishedAt: recent }] } }
        : { notion: { items: [{ source: 'notion', sourceId: 'notion:item:a', title: 'Page', url: 'https://notion.so/a', publishedAt: recent }] } } },
      client: () => ({ getConnectedAccounts: async () => ({ items: [account('youtube'), account('notion'), account('custom')] }) }),
      commit: async (cards, meta) => { committed = { cards, meta }; return { success: true } },
    })
    const r = await runner.run()
    assert.equal(r.status, 'done', r.error)
    assert.equal(r.aux.youtube.status, 'done')
    assert.equal(r.aux.notion.status, 'done')
    assert.equal(r.aux.custom.status, 'not-scanned')
    assert.equal(r.chief.status, 'skipped')
    assert.ok(committed.cards.some(c => c.source === 'youtube'))
    assert.ok(committed.cards.some(c => c.source === 'notion'))
    assert.ok(committed.meta.channels.has('youtube'))
    assert.ok(runner.lastRun().cards.some(c => c.source === 'notion'))
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('YouTube read failures say why (quota vs access)', async () => {
  const { fetchYouTube } = await import('../src/web/youtube.js')
  const quota = { successful: false, error: '{"error":{"code":403,"errors":[{"domain":"youtube.quota","reason":"quotaExceeded"}]}}', data: { status_code: 403 } }
  await assert.rejects(fetchYouTube({ executeAction: async () => quota }, { id: 'ca_1' }), /quota exceeded/)
  await assert.rejects(fetchYouTube({ executeAction: async () => ({ successful: false, error: 'token expired', data: { status_code: 401 } }) }, { id: 'ca_1' }), /reconnect YouTube/)
})
