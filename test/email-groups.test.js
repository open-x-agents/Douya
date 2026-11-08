import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyEmail, buildEmailClusters, migrateEmailCards } from '../src/web/email-groups.js'

const mail = (id, title, from, labelIds = [], snippet = '') => ({
  source: 'gmail', type: 'email-recent', sourceId: `gmail:${id}`, title,
  url: `https://mail.google.com/mail/u/0/#inbox/${id}`, body: `From: ${from}`,
  createdAt: `2026-11-03T0${id.length % 9}:00:00Z`, metadata: { from, labelIds, snippet },
})

test('classifies by labels, sender and subject — not by a fixed list of brands', () => {
  assert.equal(classifyEmail(mail('a', 'Fall Styles Up to 30% Off*', 'Shop <news@e.shop.example>', ['CATEGORY_PROMOTIONS'])), 'promo')
  assert.equal(classifyEmail(mail('b', '🚨 Ends Today: Extra 30% off', 'Brand <deals@brand.example>')), 'promo')
  assert.equal(classifyEmail(mail('c', 'You have a new message', 'Messenger <notification@facebookmail.com>')), 'social')
  assert.equal(classifyEmail(mail('d', 'New sign-in on Mac', 'Acct <no-reply@accounts.example>')), 'security')
  assert.equal(classifyEmail(mail('e', '[o/r] Run failed: tests - main', 'GitHub <notifications@github.com>')), 'code')
  assert.equal(classifyEmail(mail('f', 'Can you review my draft by Friday?', 'Ann Lee <ann@uni.edu>')), 'action')
  assert.equal(classifyEmail(mail('g', 'Your order has shipped', 'Store <orders@store.example>', ['CATEGORY_UPDATES'])), 'updates')
})

test('one tile per category, ≤4 actionable singles, never a bare Open next step', () => {
  const items = [
    ...Array.from({ length: 12 }, (_, i) => mail(`p${i}`, `Sale ${i}: 20% off`, `Brand${i % 4} <news@b${i % 4}.example>`, ['CATEGORY_PROMOTIONS'])),
    ...Array.from({ length: 6 }, (_, i) => mail(`h${i}`, `Could you confirm the plan ${i}?`, `Person ${i} <p${i}@corp.example>`)),
    mail('s1', 'Security alert', 'G <no-reply@accounts.example>'),
  ]
  const out = buildEmailClusters(items, { today: '2026-11-03', now: 0 })
  const singles = out.filter(c => c.type === 'email-action')
  const groups = out.filter(c => c.type === 'email-group')
  assert.equal(singles.length, 4)
  assert.deepEqual(groups.map(g => g.metadata.group), ['action', 'security', 'promo'])
  const promo = groups.find(g => g.metadata.group === 'promo')
  assert.equal(promo.blocks.find(b => b.type === 'link-list').links.length, 12)
  assert.match(promo.nextAction, /促销 12 封，无需处理/)
  assert.equal(promo.blocks.find(b => b.type === 'tags').tags.length, 3)
  for (const c of out) assert.ok(c.nextAction && !/^open$/i.test(c.nextAction))
  // every mail appears exactly once
  const urls = out.flatMap(c => c.blocks.find(b => b.type === 'link-list').links.map(l => l.url))
  assert.equal(urls.length, new Set(urls).size)
  assert.equal(urls.length, items.length)
})

test('legacy single-mail tiles merge into groups without losing completions', () => {
  const groups = buildEmailClusters([mail('n1', '50% off today', 'X <news@x.example>', ['CATEGORY_PROMOTIONS'])], { today: '2026-11-04', now: 0 })
  const legacy = [
    { id: 'old1', source: 'gmail', type: 'single-item', status: 'active', title: 'Extra 20% Off clearance', body: 'From: Y <deals@y.example>', url: 'https://mail.google.com/mail/u/0/#inbox/old1' },
    { id: 'old2', source: 'gmail', type: 'single-item', status: 'done', completedAt: '2026-11-02T00:00:00Z', title: 'Hi', body: 'From: Z <z@z.example>', url: 'https://mail.google.com/mail/u/0/#inbox/old2' },
    { id: 'old3', source: 'gmail', type: 'email-cluster', status: 'active', title: 'Weee 的邮件' },
    { id: 'gh', source: 'github', type: 'project-cluster', status: 'active' },
  ]
  const { cards, itemStatus, merged } = migrateEmailCards(legacy, groups, {})
  assert.equal(merged, 2)
  const promo = cards.find(c => c.type === 'email-group')
  assert.ok(promo.blocks.find(b => b.type === 'link-list').links.some(l => l.url.endsWith('old1')))
  assert.match(promo.nextAction, /促销 2 封/)
  assert.equal(cards.find(c => c.id === 'old1').status, 'merged')
  assert.equal(cards.find(c => c.id === 'old3').status, 'merged')
  assert.equal(cards.find(c => c.id === 'old2'), undefined) // terminal: untouched (not re-saved)
  assert.equal(itemStatus['https://mail.google.com/mail/u/0/#inbox/old2'].status, 'done')
  assert.equal(cards.find(c => c.id === 'gh'), undefined)
})

test('same-day re-digest keeps mail already in the group', () => {
  const first = buildEmailClusters([mail('a1', '30% off', 'A <news@a.example>', ['CATEGORY_PROMOTIONS'])], { today: '2026-11-05', now: 0 })
  first[0].blocks.find(b => b.type === 'link-list').links.push({ title: 'old', url: 'https://mail.google.com/mail/u/0/#inbox/legacy', from: 'L' })
  const again = buildEmailClusters([mail('b2', '40% off', 'B <news@b.example>', ['CATEGORY_PROMOTIONS'])], { today: '2026-11-05', now: 0 })
  const { cards } = migrateEmailCards(first, again, {})
  const g = cards.find(c => c.type === 'email-group')
  assert.equal(g.blocks.find(b => b.type === 'link-list').links.length, 3)
  assert.match(g.nextAction, /促销 3 封/)
})

import { foldGithubNotifsIntoRepos, githubNotifRepo, repoKeyOfCard, emailLink } from '../src/web/email-groups.js'

test('foldGithubNotifsIntoRepos moves [owner/repo] mail into the matching project card and drops it from CI与代码通知', () => {
  assert.equal(githubNotifRepo('[open-x-agents/openDigitalMate] Run failed: release - main', 'GitHub <notifications@github.com>'), 'open-x-agents/openDigitalMate')
  assert.equal(githubNotifRepo('Hello', 'ann@x.com'), null)
  const repo = {
    id: 'cluster_github_open-x-agents_openDigitalMate_1', type: 'project-cluster', source: 'github',
    sourceId: 'github:cluster:open-x-agents/openDigitalMate', url: 'https://github.com/open-x-agents/openDigitalMate',
    title: 'openDigitalMate', items: [], blocks: [{ type: 'link-list', links: [{ title: 'PR #160', url: 'https://github.com/open-x-agents/openDigitalMate/pull/160' }] }],
    clusterSize: 1, metadata: {},
  }
  assert.equal(repoKeyOfCard(repo), 'open-x-agents/openDigitalMate')
  const items = [
    mail('1', '[open-x-agents/openDigitalMate] Run failed: release - main (e7daf11)', 'GitHub <notifications@github.com>'),
    mail('2', '[other/repo] PR run failed', 'GitHub <notifications@github.com>'),
    mail('3', 'CircleCI build failed', 'builds <noreply@circleci.com>'),
  ]
  const code = {
    id: 'email_group_code_2026-11-08', type: 'email-group', source: 'gmail', sourceId: 'gmail:group:code:2026-11-08',
    title: 'CI与代码通知', metadata: { group: 'code', count: 3 },
    items, topItems: items.slice(0, 3),
    blocks: [
      { type: 'stat', value: 3, label: '封邮件' },
      { type: 'tags', tags: [{ text: 'GitHub', color: 'gray' }] },
      { type: 'link-list', links: items.map(emailLink) },
    ],
  }
  const cards = [repo, code]
  const r = foldGithubNotifsIntoRepos(cards)
  assert.equal(r.folded, 1)
  assert.ok(repo.blocks.find(b => b.type === 'link-list').links.some(l => /e7daf11/.test(l.title) && l.mergedFrom === 'gmail'))
  assert.equal(code.items.length, 2)
  assert.ok(code.items.every(i => !/openDigitalMate/.test(i.title)))
  assert.equal(code.metadata.count, 2)
})
