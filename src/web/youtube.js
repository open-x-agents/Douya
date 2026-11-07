import { t } from '../i18n/index.js'

// Verified against https://docs.composio.dev/toolkits/youtube (20261101_00).
// One subscriptions page + at most 10 activity pages, 3 at a time; no quota-heavy search.
export async function fetchYouTube(client, source, { now = Date.now(), timeoutMs = 8000 } = {}) {
  const pin = source.id ? { connectedAccountId: source.id } : {}
  const read = async (slug, args) => {
    let timer
    try {
      const r = await Promise.race([
        client.executeAction(slug, args, pin),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('YouTube read timed out')), timeoutMs) }),
      ])
      const data = r?.data?.data ?? r?.data
      if (!r || r.successful === false || r.error || !Array.isArray(data?.items)) throw new Error('YouTube read failed')
      return data
    } finally { clearTimeout(timer) }
  }
  const subs = await read('YOUTUBE_LIST_USER_SUBSCRIPTIONS', { part: 'snippet', maxResults: 10 })
  const channels = [...new Map(subs.items.map(s => [s.snippet?.resourceId?.channelId, s])).values()].filter(s => s.snippet?.resourceId?.channelId).slice(0, 10)
  const since = now - 48 * 60 * 60 * 1000
  const videos = new Map()
  let truncated = !!subs.nextPageToken
  for (let i = 0; i < channels.length; i += 3) {
    await Promise.all(channels.slice(i, i + 3).map(async sub => {
      const data = await read('YOUTUBE_GET_CHANNEL_ACTIVITIES', {
        channelId: sub.snippet.resourceId.channelId, part: 'snippet,contentDetails', maxResults: 20,
        publishedAfter: new Date(since).toISOString(), publishedBefore: new Date(now).toISOString(),
      })
      truncated ||= !!data.nextPageToken
      for (const v of data.items.slice(0, 20)) {
        const id = v.contentDetails?.upload?.videoId
        const at = Date.parse(v.snippet?.publishedAt)
        if (!id || !/^[\w-]+$/.test(id) || !Number.isFinite(at) || at < since || at > now) continue
        videos.set(id, { id, title: v.snippet.title || id, channel: v.snippet.channelTitle || sub.snippet.title || '', publishedAt: new Date(at).toISOString() })
      }
    }))
  }
  return { videos: [...videos.values()].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)), truncated, channels: channels.length }
}

export function youtubeItems(data) {
  return (data?.videos || []).map(v => ({ source: 'youtube', type: 'youtube-video', sourceId: `youtube:video:${v.id}`,
    title: v.title, channel: v.channel, url: `https://www.youtube.com/watch?v=${v.id}`, publishedAt: v.publishedAt,
    createdAt: v.publishedAt, metadata: { channel: v.channel }, body: v.channel }))
}

export function youtubeCluster(items, lang = 'en') {
  if (!items.length) return null
  const title = t('youtube.new_videos', lang, { n: items.length })
  return { id: 'youtube_subscriptions', source: 'youtube', sourceId: `youtube:subscriptions:${new Date().toISOString().slice(0, 10)}`,
    type: 'youtube-cluster', title, body: title, subtitle: 'YouTube', priority: 'low', status: 'active', waiting: 'fyi',
    url: items[0].url, clusterSize: items.length, items, topItems: items.slice(0, 5), metadata: {},
    blocks: [{ type: 'link-list', links: items.slice(0, 5).map(v => ({ title: v.title, url: v.url, from: v.channel, at: v.publishedAt })) }],
    actions: [{ label: t('youtube.watch', lang), value: items[0].url, primary: true }], createdAt: new Date().toISOString() }
}
