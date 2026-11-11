import assert from 'node:assert/strict'
import { test } from 'node:test'
import { foldGithubNotifsIntoRepos, githubNotifPr, emailLink } from '../src/web/email-groups.js'
import { attachHarvestLinks } from '../src/digest/build.js'
import { cardSnapshotText, cardFull, liveCardItems } from '../src/web/card-snapshot.js'
import { payload, isPatchShaped, fetchPrBrief } from '../src/web/card-brief.js'

const mail = (id, title, from = 'GitHub <notifications@github.com>') => ({
  sourceId: `gmail:${id}`, source: 'gmail', title, url: `https://mail.google.com/mail/u/0/#inbox/${id}`,
  metadata: { from }, createdAt: '2026-11-11T01:00:00Z',
})

test('githubNotifPr reads canonical PR URLs from notification subjects', () => {
  assert.deepEqual(githubNotifPr('[ThinkFlowLab/orbit] Requested review (PR #3084)'), {
    repo: 'ThinkFlowLab/orbit', number: 3084, url: 'https://github.com/ThinkFlowLab/orbit/pull/3084',
  })
  assert.equal(githubNotifPr('[Birfy/agentdescent] PR #733 review requested').url, 'https://github.com/Birfy/agentdescent/pull/733')
  assert.equal(githubNotifPr('[ThinkFlowLab/orbit] bug (Issue #2124)'), null)
  assert.equal(githubNotifPr('Hello from Ann'), null)
})

test('foldGithubNotifsIntoRepos persists the canonical pull URL, not only the Gmail link', () => {
  const repo = {
    id: 'cluster_github_ThinkFlowLab_orbit_1', type: 'project-cluster', source: 'github',
    sourceId: 'github:cluster:ThinkFlowLab/orbit', url: 'https://github.com/ThinkFlowLab/orbit',
    title: 'orbit', items: [], blocks: [{ type: 'link-list', links: [] }], clusterSize: 0, metadata: {},
  }
  const it = mail('m1', '[ThinkFlowLab/orbit] feat: tighten gate (PR #3084)')
  const code = {
    id: 'email_group_code_2026-11-11', type: 'email-group', source: 'gmail', metadata: { group: 'code' },
    items: [it], blocks: [{ type: 'link-list', links: [emailLink(it)] }],
  }
  foldGithubNotifsIntoRepos([repo, code])
  const links = repo.blocks.find(b => b.type === 'link-list').links
  assert.ok(links.some(l => l.url === 'https://github.com/ThinkFlowLab/orbit/pull/3084' && l.type === 'pr'))
  assert.ok(links.some(l => l.url === it.url && l.mergedFrom === 'gmail'))
})

test('attachHarvestLinks adds github:pr:* URLs even when the card only has Gmail links', () => {
  const card = {
    source: 'github', url: 'https://github.com/ThinkFlowLab/orbit',
    blocks: [{ type: 'link-list', links: [{ title: 'notif', url: 'https://mail.google.com/mail/u/0/#inbox/x', type: 'email', mergedFrom: 'gmail' }] }],
  }
  const items = [
    { title: 'feat: tighten gate', url: 'https://github.com/ThinkFlowLab/orbit/pull/3084', type: 'pr-review', sourceId: 'github:pr:3084', metadata: { repository: 'ThinkFlowLab/orbit' } },
    { title: 'docs typo', url: 'https://github.com/ThinkFlowLab/orbit/pull/2972', type: 'pr-review', sourceId: 'github:pr:2972', metadata: { repository: 'ThinkFlowLab/orbit' } },
    { title: 'other repo', url: 'https://github.com/acme/app/pull/1', type: 'pr-review', sourceId: 'github:pr:1', metadata: { repository: 'acme/app' } },
  ]
  assert.equal(attachHarvestLinks(card, items), 2)
  const urls = card.blocks[0].links.map(l => l.url)
  assert.equal(urls[0], 'https://github.com/ThinkFlowLab/orbit/pull/3084')
  assert.ok(urls.includes('https://github.com/ThinkFlowLab/orbit/pull/2972'))
  assert.ok(!urls.includes('https://github.com/acme/app/pull/1'))
  assert.equal(attachHarvestLinks(card, items), 0, 'idempotent')
})

test('attachHarvestLinks caps the link list at 40', () => {
  const existing = Array.from({ length: 38 }, (_, i) => ({ title: `old ${i}`, url: `https://mail.google.com/mail/u/0/#inbox/m${i}` }))
  const card = {
    source: 'github', url: 'https://github.com/ThinkFlowLab/orbit',
    blocks: [{ type: 'link-list', links: existing }],
  }
  const items = Array.from({ length: 5 }, (_, i) => ({
    title: `pr ${i}`, url: `https://github.com/ThinkFlowLab/orbit/pull/${4000 + i}`, type: 'pr-review',
  }))
  assert.equal(attachHarvestLinks(card, items), 5)
  assert.equal(card.blocks[0].links.length, 40)
  assert.equal(card.blocks[0].links[0].url, 'https://github.com/ThinkFlowLab/orbit/pull/4000')
})

test('cardSnapshot prefers still-pending review PRs and labels comment-only items, not a stale GitHub URL first', () => {
  const now = new Date().toISOString()
  const card = {
    id: 'cluster_github_ThinkFlowLab_orbit_1', source: 'github', type: 'project-cluster',
    title: 'orbit reviews', url: 'https://github.com/ThinkFlowLab/orbit/pull/3045',
    nextAction: '先审 #3084',
    blocks: [{ type: 'link-list', links: [
      { title: '[ThinkFlowLab/orbit] already reviewed (PR #3045)', url: 'https://mail.google.com/mail/u/0/#inbox/old', type: 'email', mergedFrom: 'gmail' },
      { title: 'old comment thread', url: 'https://github.com/ThinkFlowLab/orbit/pull/3045', type: 'pr' },
      { title: 'another commented', url: 'https://github.com/ThinkFlowLab/orbit/pull/2116', type: 'pr' },
      { title: 'tighten gate', url: 'https://github.com/ThinkFlowLab/orbit/pull/3084', type: 'pr-review' },
      { title: 'docs typo', url: 'https://github.com/ThinkFlowLab/orbit/pull/2972', type: 'pr-review' },
      { title: 'ci flake', url: 'https://github.com/ThinkFlowLab/orbit/pull/2970', type: 'pr-review' },
    ] }],
  }
  const actions = {
    a1: { id: 'a1', action: 'github_comment', status: 'executed', cardId: card.id, summary: '评论 ThinkFlowLab/orbit#3045', input: { url: 'https://github.com/ThinkFlowLab/orbit/pull/3045', number: 3045, body: 'lgtm-ish' }, createdAt: now, executedAt: now },
    a2: { id: 'a2', action: 'github_comment', status: 'executed', cardId: card.id, summary: '评论 ThinkFlowLab/orbit#2116', input: { number: 2116, body: 'noted' }, createdAt: now, executedAt: now },
  }
  const t = cardSnapshotText(card, {}, { actions })
  assert.match(t, /^链接：https:\/\/github.com\/ThinkFlowLab\/orbit$/m)
  assert.doesNotMatch(t, /链接：https:\/\/github.com\/ThinkFlowLab\/orbit\/pull\/3045/)
  const first = t.split('\n').find(l => /^\d+\. /.test(l))
  assert.match(first, /#3084|tighten gate/)
  assert.match(first, /https:\/\/github.com\/ThinkFlowLab\/orbit\/pull\/3084/)
  assert.match(t, /tighten gate.*待处理.*\/pull\/3084/)
  assert.match(t, /already reviewed \(PR #3045\) — 已评论/)
  assert.match(t, /another commented — 已评论 — https:\/\/github.com\/ThinkFlowLab\/orbit\/pull\/2116/)
  assert.doesNotMatch(t, /already reviewed \(PR #3045\) — 已完成/)
  const pendingPos = t.indexOf('/pull/3084')
  const commentedPos = t.indexOf('/pull/3045')
  assert.ok(pendingPos > 0 && pendingPos < commentedPos, 'pending review PRs are listed before commented non-review items')
  const snapItems = liveCardItems(card, {}, actions)
  const fullItems = cardFull(card, {}, actions).items
  assert.deepEqual(fullItems.map(i => i.url), snapItems.map(i => i.url), 'snapshot and cardFull share item order')
})

test('a github_comment does not complete a still-requested review; a submitted review does', () => {
  const now = new Date().toISOString()
  const card = {
    id: 'cluster_github_ThinkFlowLab_orbit_1', source: 'github', type: 'project-cluster',
    title: 'orbit reviews', url: 'https://github.com/ThinkFlowLab/orbit/pull/3163',
    blocks: [{ type: 'link-list', links: [
      { title: 'requested still', url: 'https://github.com/ThinkFlowLab/orbit/pull/3163', type: 'pr-review' },
      { title: 'already reviewed', url: 'https://github.com/ThinkFlowLab/orbit/pull/3045', type: 'pr-review' },
      { title: 'merged one', url: 'https://github.com/ThinkFlowLab/orbit/pull/2116', type: 'pr' },
    ] }],
  }
  const actions = {
    c: { id: 'c', action: 'github_comment', status: 'executed', cardId: card.id, summary: '评论 #3163', input: { url: 'https://github.com/ThinkFlowLab/orbit/pull/3163', number: 3163 }, createdAt: now, executedAt: now },
    r: { id: 'r', action: 'github_review', status: 'executed', cardId: card.id, summary: '审 #3045', input: { url: 'https://github.com/ThinkFlowLab/orbit/pull/3045', number: 3045 }, createdAt: now, executedAt: now },
    m: { id: 'm', action: 'github_merge', status: 'executed', cardId: card.id, summary: '合并 #2116', input: { number: 2116 }, createdAt: now, executedAt: now },
  }
  const t = cardSnapshotText(card, {}, { actions })
  assert.match(t, /requested still — 已评论 — https:\/\/github.com\/ThinkFlowLab\/orbit\/pull\/3163/)
  assert.doesNotMatch(t, /requested still — 已完成/)
  assert.match(t, /already reviewed — 已完成/)
  assert.match(t, /merged one — 已完成/)
  assert.match(t, /^链接：https:\/\/github.com\/ThinkFlowLab\/orbit\/pull\/3163$/m)
  const first = t.split('\n').find(l => /^\d+\. /.test(l))
  assert.match(first, /requested still/)
  const items = liveCardItems(card, {}, actions)
  assert.equal(items[0].url, 'https://github.com/ThinkFlowLab/orbit/pull/3163')
  assert.equal(items[0].status, 'commented')
  assert.deepEqual(items.filter(i => i.status === 'done').map(i => i.url), [
    'https://github.com/ThinkFlowLab/orbit/pull/3045',
    'https://github.com/ThinkFlowLab/orbit/pull/2116',
  ])
  assert.deepEqual(cardFull(card, {}, actions).items.map(i => [i.url, i.status]), items.map(i => [i.url, i.status]))
})

test('successful Composio GitHub result with patch-shaped details is not a 404', async () => {
  const patch = { files: [{ filename: 'gate.js', additions: 4, deletions: 1, changes: 5 }], patch: 'diff --git a/gate.js b/gate.js' }
  assert.equal(isPatchShaped(patch), true)
  assert.equal(payload({ successful: true, data: { details: patch } }).details, patch, 'do not unwrap a patch as the PR')
  assert.equal(payload({ data: { details: 'patch text' } }).details, 'patch text')

  const client = {
    async executeAction(slug) {
      if (slug === 'GITHUB_GET_AN_ISSUE') return { successful: true, data: { details: patch } }
      if (slug === 'GITHUB_LIST_PULL_REQUESTS_FILES') return { successful: true, data: { files: patch.files } }
      return { successful: true, data: {} }
    },
  }
  const brief = await fetchPrBrief(client, { owner: 'ThinkFlowLab', repo: 'orbit', number: 3084 })
  assert.equal(brief.error, undefined)
  assert.equal(brief.blocked, undefined)
  assert.equal(brief.number, 3084)
  assert.equal(brief.url, 'https://github.com/ThinkFlowLab/orbit/pull/3084')
  assert.ok(!/404|不存在|拿不到/.test(JSON.stringify(brief)))
  assert.equal(brief.title, '')
  assert.equal(brief.notFound, undefined)
})

test('successful empty or unrelated GitHub body is uncertainty, not a readable PR or a 404', async () => {
  const emptyClient = {
    async executeAction() { return { successful: true, data: {} } },
  }
  const empty = await fetchPrBrief(emptyClient, { owner: 'ThinkFlowLab', repo: 'orbit', number: 3084 })
  assert.ok(empty.error)
  assert.equal(empty.number, undefined)
  assert.equal(empty.url, undefined)
  assert.equal(empty.blocked, undefined)
  assert.equal(empty.notFound, undefined)
  assert.doesNotMatch(String(empty.error), /404|不存在|does not exist|Not Found/i)
  assert.match(String(empty.error), /拿不到这个 PR/)

  const unrelatedClient = {
    async executeAction() { return { successful: true, data: { details: { message: 'ok', status: 'success' } } } },
  }
  const unrelated = await fetchPrBrief(unrelatedClient, { owner: 'ThinkFlowLab', repo: 'orbit', number: 3084 })
  assert.ok(unrelated.error)
  assert.equal(unrelated.number, undefined)
  assert.equal(unrelated.notFound, undefined)
  assert.doesNotMatch(String(unrelated.error), /404|不存在|does not exist|Not Found/i)

  const missingClient = {
    async executeAction() { return { successful: false, error: 'GitHub API 404: Not Found' } },
  }
  const missing = await fetchPrBrief(missingClient, { owner: 'ThinkFlowLab', repo: 'orbit', number: 3084 })
  assert.match(String(missing.error), /404/)
  assert.equal(missing.notFound, true)
  assert.equal(missing.number, undefined)
  assert.equal(missing.blocked, undefined)

  const filesOnlyClient = {
    async executeAction(slug) {
      if (slug === 'GITHUB_LIST_PULL_REQUESTS_FILES') {
        return { successful: true, data: { files: [{ filename: 'gate.js', additions: 2, deletions: 0, changes: 2 }] } }
      }
      return { successful: true, data: {} }
    },
  }
  const filesOnly = await fetchPrBrief(filesOnlyClient, { owner: 'ThinkFlowLab', repo: 'orbit', number: 2972 })
  assert.equal(filesOnly.error, undefined)
  assert.equal(filesOnly.number, 2972)
  assert.equal(filesOnly.url, 'https://github.com/ThinkFlowLab/orbit/pull/2972')
  assert.equal(filesOnly.notFound, undefined)
})
