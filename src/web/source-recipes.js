import { t } from '../i18n/index.js'

// Read-only recipes verified against https://docs.composio.dev/toolkits/<slug>.md.
// One bounded page per source, no retries or implicit pagination. Dates are also checked locally.
const recipe = (action, params, paths, map = v => v) => ({ action, params, paths, map })
const sinceIso = now => new Date(now - 48 * 3600000).toISOString()
const iso = v => typeof v === 'number' || /^\d+$/.test(String(v)) ? new Date(Number(v) * (Number(v) < 1e11 ? 1000 : 1)).toISOString() : v
export const SOURCE_RECIPES = {
  asana: { ...recipe('ASANA_SEARCH_TASKS_IN_WORKSPACE', (now, id) => ({ workspace_gid: id, assignee_any: ['me'], limit: 20, opt_fields: ['name', 'modified_at', 'permalink_url'] }), ['data', 'tasks']), discovery: { action: 'ASANA_GET_MULTIPLE_WORKSPACES', params: { limit: 1 }, paths: ['data', 'workspaces'], id: 'gid' } },
  clickup: { ...recipe('CLICKUP_GET_FILTERED_TEAM_TASKS', (now, id) => ({ team_Id: id, page: 0, order_by: 'updated', date_updated_gt: now - 48 * 3600000 }), ['tasks']), discovery: { action: 'CLICKUP_AUTHORIZATION_GET_WORK_SPACE_LIST', params: {}, paths: ['teams'], id: 'id' } },
  calendly: { ...recipe('CALENDLY_LIST_EVENTS', (now, id) => ({ user: id, count: 20, min_start_time: sinceIso(now), max_start_time: new Date(now).toISOString() }), ['collection'], v => ({ ...v, id: v.uri, title: v.name, updatedAt: v.updated_at || v.start_time, url: v.uri })), discovery: { action: 'CALENDLY_GET_USER', params: { uuid: 'me' }, paths: ['resource'], id: 'uri', single: true } },
  notion: recipe('NOTION_SEARCH_NOTION_PAGE', () => ({ page_size: 20, timestamp: 'last_edited_time', direction: 'descending' }), ['results'], v => ({ ...v, title: Object.values(v.properties || {}).find(p => p.type === 'title')?.title?.map(x => x.plain_text || x.text?.content || '').join('') })),
  linear: recipe('LINEAR_LIST_LINEAR_ISSUES', () => ({ first: 20, assignee_id: 'me' }), ['issues.nodes', 'issues', 'nodes']),
  jira: recipe('JIRA_SEARCH_FOR_ISSUES_USING_JQL_GET', () => ({ jql: 'updated >= -2d AND assignee = currentUser() ORDER BY updated DESC', max_results: 20, fields: ['summary', 'updated'] }), ['issues'], v => ({ ...v, title: v.fields?.summary, updatedAt: v.fields?.updated, url: v.self?.replace(/\/rest\/api\/.*$/, `/browse/${v.key}`) })),
  gitlab: recipe('GITLAB_LIST_ISSUES', now => ({ scope: 'assigned_to_me', per_page: 20, updated_after: sinceIso(now), order_by: 'updated_at' }), ['']),
  googledrive: recipe('GOOGLEDRIVE_LIST_FILES', now => ({ q: `trashed = false and modifiedTime > '${sinceIso(now)}'`, pageSize: 20, orderBy: 'modifiedTime desc', fields: 'id,name,webViewLink,modifiedTime' }), ['files']),
  googledocs: recipe('GOOGLEDOCS_SEARCH_DOCUMENTS', now => ({ max_results: 20, modified_after: sinceIso(now), order_by: 'modifiedTime desc' }), ['files', 'documents']),
  googlesheets: recipe('GOOGLESHEETS_SEARCH_SPREADSHEETS', now => ({ max_results: 20, modified_after: sinceIso(now), order_by: 'modifiedTime desc' }), ['files', 'spreadsheets']),
  outlook: recipe('OUTLOOK_LIST_MESSAGES', now => ({ top: 20, folder: 'inbox', received_date_time_ge: sinceIso(now), select: ['id', 'subject', 'webLink', 'receivedDateTime'] }), ['value', 'messages']),
  microsoft_teams: recipe('MICROSOFT_TEAMS_LIST_CHAT', () => ({ top: 20, expand: ['lastMessagePreview'], orderby: 'lastMessagePreview/createdDateTime desc' }), ['value', 'chats'], v => ({ ...v, title: v.topic || v.lastMessagePreview?.body?.content, updatedAt: v.lastMessagePreview?.createdDateTime })),
  reddit: recipe('REDDIT_LIST_INBOX_MESSAGES', () => ({ limit: 20, inbox_view: 'inbox' }), ['data.children', 'children'], v => { const x = v.data || v; return { ...x, url: x.context ? `https://www.reddit.com${x.context}` : x.permalink ? `https://www.reddit.com${x.permalink}` : null } }),
  twitter: recipe('TWITTER_USER_HOME_TIMELINE_BY_USER_ID', now => ({ max_results: 20, start_time: sinceIso(now).replace(/\.\d{3}Z$/, 'Z'), tweet_fields: ['created_at', 'text'] }), ['data', 'tweets'], v => ({ ...v, title: v.text, url: `https://x.com/i/status/${v.id}` })),
  strava: recipe('STRAVA_LIST_ATHLETE_ACTIVITIES', now => ({ per_page: 20, after: Math.floor((now - 48 * 3600000) / 1000) }), ['activities', ''], v => ({ ...v, updatedAt: v.start_date, url: `https://www.strava.com/activities/${v.id}` })),
  spotify: recipe('SPOTIFY_GET_RECENTLY_PLAYED_TRACKS', now => ({ limit: 20, after: now - 48 * 3600000 }), ['items'], v => ({ id: `${v.track?.id}:${v.played_at}`, title: v.track?.name, url: v.track?.external_urls?.spotify, updatedAt: v.played_at })),
  one_drive: recipe('ONE_DRIVE_GET_RECENT_ITEMS', () => ({ top: 20 }), ['value', 'items']),
  coda: recipe('CODA_LIST_AVAILABLE_DOCS', () => ({ limit: 20 }), ['items']),
  box: recipe('BOX_LIST_RECENTLY_ACCESSED_ITEMS', () => ({ limit: 20 }), ['entries'], v => ({ ...v.item, updatedAt: v.interacted_at, url: v.item?.id ? `https://app.box.com/${v.item.type === 'folder' ? 'folder' : 'file'}/${v.item.id}` : null })),
  onenote: recipe('ONENOTE_GET_RECENT_NOTEBOOKS', () => ({ top: 20, include_personal_notebooks: true }), ['value'], v => ({ ...v, title: v.displayName, url: v.links?.oneNoteWebUrl?.href })),
  zoom: recipe('ZOOM_LIST_MEETINGS', now => ({ user_id: 'me', page_size: 20, type: 'previous_meetings', from: sinceIso(now).slice(0, 10), to: new Date(now).toISOString().slice(0, 10) }), ['meetings'], v => ({ ...v, title: v.topic, updatedAt: v.start_time, url: v.join_url })),
  confluence: recipe('CONFLUENCE_SEARCH_CONTENT', () => ({ query: 'type=page AND lastmodified >= now("-2d") ORDER BY lastmodified DESC', limit: 20, expand: 'version' }), ['results'], v => ({ ...v, updatedAt: v.version?.when || v.lastModified, url: v._links?.webui ? `${v._links.base || ''}${v._links.webui}` : v.url })),
  todoist: recipe('TODOIST_LIST_ACTIVITIES', now => ({ limit: 20, date_from: sinceIso(now), date_to: new Date(now).toISOString() }), ['results', 'events'], v => ({ ...v, title: v.extra_data?.content, updatedAt: v.event_date, url: v.object_type === 'item' ? `https://app.todoist.com/app/task/${v.object_id}` : null })),
  trello: recipe('TRELLO_GET_SEARCH', () => ({ query: 'edited:day', modelTypes: 'cards', cards_limit: '20', card_fields: 'name,url,dateLastActivity' }), ['cards']),
  miro: recipe('MIRO_GET_BOARDS', () => ({ limit: 20, sort: 'last_modified' }), ['data', 'boards'], v => ({ ...v, url: v.viewLink })),
  instagram: recipe('INSTAGRAM_GET_USER_MEDIA', () => ({ limit: 20 }), ['data', 'media']),
  googletasks: recipe('GOOGLETASKS_LIST_ALL_TASKS', now => ({ max_tasks_total: 20, updatedMin: sinceIso(now), showDeleted: false }), ['items', 'tasks']),
}

// No safe account-wide recent-content read: identifiers/scopes or webhook input are required.
// Keeping these explicit prevents a directory listing being passed off as a content scan.
export const UNSCANNED_REASONS = {
  discord: 'OAuth toolkit has no message-history read action',
  telegram: 'Chat ID required; polling bot updates could interfere with webhook delivery',
  whatsapp: 'Inbound messages require webhook delivery',
  linkedin: 'No account-wide recent feed action',
  figma: 'Team or file ID required',
  airtable: 'Base, table and timestamp-field configuration required',
  dropbox: 'Folder scope and real shared links required',
  hubspot: 'Portal-specific record deep links required',
  monday: 'Board scope required',
  basecamp: 'Account scope required',
  hackernews: 'Search query required; not a personal subscription feed',
}
export const hasSourceRecipe = slug => slug === 'youtube' || !!SOURCE_RECIPES[slug]
const get = (o, path) => path ? path.split('.').reduce((v, k) => v?.[k], o) : o
export async function fetchRecipe(client, source, { now = Date.now(), timeoutMs = 10000 } = {}) {
  const slug = source.toolkit.slug, r = SOURCE_RECIPES[slug]
  if (!r) return null
  let timer
  try {
    const pin = source.id ? { connectedAccountId: source.id } : {}
    let expired = false
    const work = async () => {
      let context
      if (r.discovery) {
        const d = r.discovery
        const res = await client.executeAction(d.action, d.params, pin)
        if (expired) throw new Error(`${slug} read timed out`)
        if (!res || res.successful === false || res.error) throw new Error(`${slug} discovery failed`)
        const data = res.data?.data ?? res.data
        const found = d.paths.map(p => get(data, p)).find(v => d.single ? v && typeof v === 'object' : Array.isArray(v))
        const first = d.single ? found : found?.[0]
        context = first?.[d.id]
        if (!context) throw new Error(`${slug} has no readable scope`)
      }
      return client.executeAction(r.action, r.params(now, context), pin)
    }
    const result = await Promise.race([
      work(),
      new Promise((_, reject) => { timer = setTimeout(() => { expired = true; reject(new Error(`${slug} read timed out`)) }, timeoutMs) }),
    ])
    if (!result || result.successful === false || result.error) throw new Error(`${slug} read failed`)
    const data = result.data?.data && !Array.isArray(result.data.data) && typeof result.data.data === 'object' ? result.data.data : result.data
    const rows = r.paths.map(p => get(data, p)).find(Array.isArray)
    if (!rows) throw new Error(`${slug} returned an unexpected list shape`)
    const items = new Map()
    for (const raw of rows.slice(0, 20)) {
      const v = r.map(raw)
      const at = iso(v.updatedAt || v.updated_at || v.modifiedTime || v.modifiedAt || v.lastModifiedDateTime || v.last_edited_time || v.receivedDateTime || v.timestamp || v.dateLastActivity || v.modified_at || v.date_updated || v.updated || v.created_at || v.createdAt || v.created_utc)
      const ms = Date.parse(at)
      const url = v.url || v.webViewLink || v.webLink || v.web_url || v.permalink || v.htmlLink || v.browserLink || v.permalink_url
      const id = v.id || v.gid || v.key
      const title = v.title || v.subject || v.name || v.content
      if (!id || !title || !/^https?:\/\//i.test(url || '') || !Number.isFinite(ms) || ms < now - 48 * 3600000 || ms > now) continue
      items.set(String(id), { source: slug, type: 'source-item', sourceId: `${slug}:item:${id}`, title: String(title).slice(0, 160), url, publishedAt: new Date(ms).toISOString(), createdAt: new Date(ms).toISOString(), metadata: {} })
    }
    return { items: [...items.values()], scanned: rows.length, truncated: rows.length >= 20 || !!(data.nextPageToken || data.next_cursor || data.has_more || data['@odata.nextLink']) }
  } finally { clearTimeout(timer) }
}
export function recipeItems(sourceData) { return Object.keys(SOURCE_RECIPES).flatMap(slug => sourceData[slug]?.items || []) }
export function sourceCluster(items, lang = 'en') {
  if (!items.length) return null
  const source = items[0].source, title = t('sources.recent_items', lang, { source, n: items.length })
  return { id: `source_${source}`, source, sourceId: `${source}:recent:${new Date().toISOString().slice(0, 10)}`, type: 'source-cluster',
    title, body: title, subtitle: source, priority: 'low', status: 'active', waiting: 'fyi', url: items[0].url, clusterSize: items.length,
    items, topItems: items.slice(0, 5), metadata: {}, blocks: [{ type: 'link-list', links: items.slice(0, 5).map(v => ({ title: v.title, url: v.url, at: v.publishedAt })) }],
    actions: [{ label: t('sources.open_latest', lang), value: items[0].url, primary: true }], createdAt: new Date().toISOString() }
}
