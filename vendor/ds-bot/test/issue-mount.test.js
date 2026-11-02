import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { TEAM_TOOLS } from '../src/host/constants.js'
import {
  attachScope,
  canShowIssueCard,
  commentLabel,
  compareAction,
  parseCitations,
  planAction,
  repoOfRows,
  defaultWidget,
  headerLine,
  issueShown,
  normalizeWidget,
  visibleUserText,
} from '../src/shared/issue-card.js'
import { fakeContext } from './fake-ctx.js'

const TOKEN = 'super-secret-token'
const BODY = '正'.repeat(900)
const COMMENT = '评'.repeat(500)

function ghList() {
  return JSON.stringify([
    { number: 98, title: '卡片回调没有来源校验，可伪造「已完成/推迟」', url: 'https://github.com/open-x-agents/openDigitalMate/issues/98', comments: 0 },
    { number: 97, title: '拒绝类评测用例', url: 'https://github.com/open-x-agents/openDigitalMate/issues/97', comments: 2 },
  ])
}

const CITED = [
  '先看这两条。优先级：P9 这句话不算提炼。',
  '[Issue note #999]',
  'priority: NOPE',
  '[Issue conclusion]',
  'conclusion: 先做来源校验',
  '[Issue note #98]',
  'priority: P0',
  'step: 校验回调签名',
  'madeup: drop-me',
  '[Issue note #97]',
  'topic: 评测',
].join('\n')

const CARD = {
  callId: 'issue:chief:3',
  owner: 'open-x-agents',
  repo: 'openDigitalMate',
  issues: [
    { id: '98', number: 98, title: '来源校验', url: 'https://github.com/open-x-agents/openDigitalMate/issues/98', commentState: 'none' },
    { id: '97', number: 97, title: '评测', url: 'https://github.com/open-x-agents/openDigitalMate/issues/97', commentState: 'partial', excerpts: ['评'], commentCount: 2 },
  ],
}
const FOCUS = { focusId: '98', selectedIds: [], pane: 'detail' }

function team() {
  return {
    version: 1,
    mainBotIds: ['chief'],
    whaleStored: true,
    revision: 1,
    bots: {
      chief: { id: 'chief', sessionId: 'chief', name: 'Chief', role: 'Chief of Staff', capabilities: [], color: 'deepseek', createdAt: 1 },
      writer: { id: 'writer', sessionId: 'writer-now', name: 'Writer', role: 'Writer', capabilities: [], color: 'gray', createdAt: 2 },
    },
    rooms: {
      r1: {
        id: 'r1', named: true, name: 'Room', members: ['chief', 'writer'], admin: 'chief', mode: 'everyone', notice: '',
        sessions: { chief: 'chief-group', writer: 'writer-group' },
      },
    },
    agents: {},
    capabilities: { items: {} },
    exchanges: [],
    exchangeTurns: {},
    works: {},
    questions: {},
    views: {},
    prefs: {},
  }
}

function jsonResponse(value, status = 200) {
  return { ok: status === 200, status, json: async () => value }
}

async function emit(ctx, sessionId, event) {
  for (const listener of ctx.listeners.get('session/event') ?? []) {
    if (listener.length >= 2) await listener({ id: sessionId }, event)
  }
}

async function play(ctx, rt, sessionId, turn, events) {
  await emit(ctx, sessionId, { type: 'turn/start', data: { turn } })
  for (const event of events) await emit(ctx, sessionId, event)
  await emit(ctx, sessionId, { type: 'turn/end', data: { turn, reason: { kind: 'stop' } } })
  await rt.whenIssueMounted()
}

const toolResult = text => ({ type: 'tool/result', data: { message: { content: [{ type: 'text', text }] } } })
const assistant = text => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })

async function setup({ issueFetch } = {}) {
  const previous = process.env.GITHUB_TOKEN
  process.env.GITHUB_TOKEN = TOKEN
  const home = mkdtempSync(join(tmpdir(), 'dsb-issue-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(team()))
  const calls = []
  const sent = []
  const routes = []
  const ctx = fakeContext()
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    routes.push(options)
    return register(options)
  }
  ctx.llm = {
    listProviders: () => [],
    listModels: async () => [],
    resolveModelInfo: async () => ({ reasoning: { efforts: [] } }),
    async* stream() {
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  ctx.sessionController = {
    resolveAgent: async sessionId => ({ agent: { id: sessionId, session: { id: sessionId, seq: 1 }, status: 'idle', followup() {}, cancel() {} } }),
    list: async () => ({ items: [] }),
    projections: async () => null,
    page: async () => ({ records: [], hasMore: false }),
    selectModel: async () => {},
    prompt: async (request) => {
      sent.push(request)
      return { accepted: true }
    },
  }
  ctx.sessions = { flush: async () => {}, messageProjections: [] }
  ctx.workspaceRegistry = { archiveSession: async () => {}, get: () => undefined, resolveByPath: async () => undefined, create: async () => ({ id: 'w', path: home }) }
  ctx.sessionTitle = { rename: async () => {} }
  const rt = createRuntime(ctx, {
    home,
    github: false,
    diagnosticsFile: false,
    issueFetch: issueFetch ?? (async (url, init) => {
      calls.push({ url, init })
      assert.equal(init.headers.Authorization, undefined)
      assert.equal(init.headers.authorization, undefined)
      assert.equal(JSON.stringify(init.headers).includes(TOKEN), false)
      assert.equal(init.headers.Accept, 'application/vnd.github+json')
      assert.equal(init.headers['User-Agent'], 'openDigitalMate')
      assert.equal(init.headers['X-GitHub-Api-Version'], '2022-11-28')
      const number = Number(/issues\/(\d+)/.exec(url)?.[1])
      if (url.endsWith('/comments') || url.includes('/comments?')) {
        return number === 97 ? jsonResponse([{ id: 1, body: COMMENT }]) : jsonResponse([])
      }
      return jsonResponse({
        number,
        title: 'REST TITLE SHOULD NOT WIN',
        body: BODY,
        comments: number === 97 ? 2 : 0,
        labels: number === 98 ? [{ name: 'bug' }, { name: '  ' }, 'good first'] : [],
      })
    }),
  })
  await rt.load()
  const call = async (endpoint, payload) => {
    const route = routes.find(item => item.path === '/api/bot')
    const response = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  const stop = async () => {
    if (previous === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = previous
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { home, ctx, rt, calls, sent, call, stop }
}

test('scope, citations, and pane actions stay on the card', () => {
  assert.equal(issueShown(''), '还没有提炼')
  assert.equal(issueShown('P0'), 'P0')
  assert.equal(commentLabel({}), '评论未读到')
  assert.equal(commentLabel({ commentState: 'none' }), '无评论')
  assert.equal(repoOfRows([{ url: '' }, { title: 'no link' }]), undefined)
  const notes = parseCitations(CITED, ['98', '97'])
  assert.equal(notes.issues['999'], undefined)
  assert.equal(notes.issues['98'].priority, 'P0')
  assert.equal(notes.issues['98'].madeup, undefined)
  assert.equal(notes.issues['97'].topic, '评测')
  assert.equal(notes.conclusion, '先做来源校验')
  assert.deepEqual(parseCitations('优先级：P9\n#98 应该先做', ['98']), { conclusion: '', issues: {} })
  assert.deepEqual(compareAction({ selectedIds: ['98'] }), { type: 'disabled' })
  assert.deepEqual(compareAction({ selectedIds: ['98', '97'] }), { type: 'pane', pane: 'compare' })
  assert.deepEqual(planAction({ selectedIds: [] }), { type: 'disabled' })
  assert.deepEqual(planAction({ selectedIds: ['98'] }), { type: 'pane', pane: 'plan' })
  assert.equal(JSON.stringify(planAction({ selectedIds: ['98'] })).includes('send'), false)
  assert.deepEqual(defaultWidget([{ id: '98' }]), { focusId: '98', selectedIds: [], pane: 'detail', filter: 'all' })
  assert.equal(normalizeWidget({ filter: '评测', pane: 'plan', focusId: '98', selectedIds: ['98'] }, [{ id: '98', topic: '评测' }]).filter, '评测')
  assert.equal(normalizeWidget({ filter: 'gone' }, [{ id: '98', topic: '评测' }]).filter, 'all')
  const once = attachScope('  hello\n', { eligible: true, card: CARD, widget: FOCUS })
  assert.equal(once.includes('  hello\n'), true)
  assert.match(once, /当前讨论：#98 · 来源校验/)
  assert.match(once, /\[Issue brief scope\]/)
  assert.equal(attachScope(once, { eligible: true, card: CARD, widget: FOCUS }), once)
  assert.equal(attachScope(once, { eligible: false }), '  hello\n')
  assert.equal(attachScope('  hello\n', { eligible: false }), '  hello\n')
  assert.equal(visibleUserText('  hello\n'), '  hello\n')
  assert.equal(visibleUserText(once).includes('[Issue brief scope]'), false)
  assert.equal(visibleUserText(once).includes('  hello\n'), true)
  const picked = attachScope('hello', { eligible: true, card: CARD, widget: { focusId: '98', selectedIds: ['98', '97'], pane: 'plan' } })
  assert.match(picked, /当前讨论：#98 来源校验、#97 评测/)
  assert.match(picked, /scope: selection/)
  assert.match(picked, /pane: plan/)
  const roster = {
    mainBotId: 'chief',
    roomsById: { r1: {} },
    byId: {
      chief: { id: 'chief', sessionId: 'chief' },
      'writer-now': { id: 'writer', sessionId: 'writer-now' },
      'chief-old': { id: 'chief', sessionId: 'chief' },
    },
  }
  assert.equal(canShowIssueCard(roster, 'chief'), true)
  assert.equal(canShowIssueCard(roster, 'writer-now'), false)
  assert.equal(canShowIssueCard(roster, 'r1'), false)
  assert.equal(canShowIssueCard(roster, 'chief-old'), false)
  assert.equal(canShowIssueCard(roster, 'missing'), false)
})

test('the mount does not add an issue tool or change the private and group prompt', async (t) => {
  const env = await setup({ issueFetch: async () => { throw new Error('no read') } })
  t.after(() => env.stop())
  const prompt = id => env.ctx.sections.get('bot-identity').text({ agent: { id } })
  assert.equal(prompt('chief'), prompt('chief-group'))
  assert.doesNotMatch(prompt('chief'), /read_public_issues|show_issue_brief|ISSUE_RULES|没读到这份 Issue 列表/)
  assert.equal(TEAM_TOOLS.includes('read_public_issues'), false)
  assert.equal(TEAM_TOOLS.includes('show_issue_brief'), false)
  assert.equal(env.ctx.registeredTools.has('read_public_issues'), false)
  assert.equal(env.ctx.registeredTools.has('show_issue_brief'), false)
  for (const file of ['src/host/prompt.js', 'src/host/tools.js', 'src/host/constants.js', 'src/host/issue-mount.js', 'src/shared/issue-card.js', 'src/client/issue-card.js']) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    assert.equal(/read_public_issues|show_issue_brief|ISSUE_RULES|GITHUB_TOKEN|没读到/.test(source), false, file)
  }
  const mount = readFileSync(new URL('../src/host/issue-mount.js', import.meta.url), 'utf8')
  assert.equal(mount.includes('defineTool'), false)
  assert.equal(mount.includes('Authorization'), false)
  const client = readFileSync(new URL('../src/client/issue-card.js', import.meta.url), 'utf8')
  assert.equal(client.includes('actions.send'), false)
  assert.equal(client.includes('iframe'), false)
  assert.equal(client.includes('show_view'), false)
  assert.match(client, /it-layout/)
  assert.match(client, /it-chips/)
  assert.match(client, /it-scope/)
  assert.match(client, /it-conversation/)
  assert.match(client, /提炼与详情/)
  assert.match(client, /讨论依据/)
  assert.match(client, /对比所选/)
  assert.match(client, /实施计划/)
})

test('a matching private turn mounts one card and keeps the reply text', async (t) => {
  const env = await setup()
  t.after(() => env.stop())
  await play(env.ctx, env.rt, 'chief', 3, [toolResult(ghList()), assistant(CITED)])
  assert.equal(env.calls.length, 4)
  const callId = 'issue:chief:3'
  const card = env.rt.state.issueCards[callId]
  assert.equal(card.owner, 'open-x-agents')
  assert.equal(card.repo, 'openDigitalMate')
  assert.equal(card.sessionId, 'chief')
  assert.equal(card.turn, 3)
  assert.equal(card.evidence, 'public')
  assert.match(headerLine(card), /公开 API · 只读/)
  assert.equal(headerLine(card).includes('会话列表'), false)
  assert.equal(card.conclusion, '先做来源校验')
  assert.equal(JSON.stringify(card).includes('还没有提炼'), false)
  assert.equal(JSON.stringify(card).includes('REST TITLE'), false)
  assert.equal(JSON.stringify(card).includes('NOPE'), false)
  assert.equal(JSON.stringify(card).includes('drop-me'), false)
  assert.equal(JSON.stringify(card).includes('P9'), false)
  const first = card.issues[0]
  const second = card.issues[1]
  assert.equal(first.id, '98')
  assert.equal(first.title, '卡片回调没有来源校验，可伪造「已完成/推迟」')
  assert.equal(first.priority, 'P0')
  assert.equal(first.step, '校验回调签名')
  assert.equal(first.topic, '')
  assert.equal(first.commentState, 'none')
  assert.deepEqual(first.excerpts, [])
  assert.deepEqual(first.labels, ['bug', 'good first'])
  assert.equal(first.body.length, 800)
  assert.equal(BODY.includes(first.body), true)
  assert.equal(first.body.includes('…'), false)
  assert.equal(second.topic, '评测')
  assert.equal(second.commentState, 'partial')
  assert.equal(second.commentCount, 2)
  assert.equal(second.excerpts.length, 1)
  assert.equal(second.excerpts[0].length, 400)
  assert.equal(COMMENT.includes(second.excerpts[0]), true)
  assert.deepEqual(env.rt.state.issueWidgets[callId], { focusId: '98', selectedIds: [], pane: 'detail', filter: 'all' })
  const before = env.calls.length
  await play(env.ctx, env.rt, 'chief', 3, [toolResult(ghList()), assistant(CITED)])
  assert.equal(env.calls.length, before)
  const page = [
    { type: 'turn/start', data: { turn: 3 }, time: 10 },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: CITED }] } }, time: 11 },
  ]
  const items = env.rt.displayItems('chief', page)
  assert.equal(items.filter(item => item.kind === 'issue').length, 1)
  assert.equal(items.at(-1).callId, callId)
  assert.equal(env.rt.displayItems('chief', [page[1]]).some(item => item.kind === 'issue'), false)
  const request = { requestId: 'r1', sessionId: 'chief', mode: 'queue', content: [{ type: 'text', text: '  hello\n' }] }
  await env.ctx.sessionController.prompt(request)
  const sent = env.sent.at(-1).content[0].text
  assert.equal(sent.includes('  hello\n'), true)
  assert.match(sent, /当前讨论：#98 · /)
  assert.match(sent, /\[Issue brief scope\]/)
  assert.match(sent, /repo: open-x-agents\/openDigitalMate/)
  await env.ctx.sessionController.prompt({ ...request, requestId: 'r2', content: [{ type: 'text', text: sent }] })
  assert.equal(env.sent.at(-1).content[0].text, sent)
  const group = { requestId: 'g', sessionId: 'chief-group', mode: 'queue', content: [{ type: 'text', text: '  hello\n' }] }
  await env.ctx.sessionController.prompt(group)
  assert.equal(env.sent.at(-1), group)
  const rows = env.rt.displayItems('chief', [{
    type: 'user/message',
    time: 12,
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: sent }] },
  }])
  assert.equal(rows[0].kind, 'user')
  assert.equal(rows[0].text.includes('[Issue brief scope]'), false)
  assert.equal(rows[0].text.includes('hello'), true)
  const saved = await env.call('save-issue-widget', { callId, widget: { focusId: '97', selectedIds: ['98', '97', '999'], pane: 'plan' } })
  assert.equal(saved.ok, true)
  assert.deepEqual(saved.value, { focusId: '97', selectedIds: ['98', '97'], pane: 'plan', filter: 'all' })
  const bad = await env.call('save-issue-widget', { callId: '__proto__', widget: { pane: 'plan' } })
  assert.equal(bad.ok, false)
  assert.equal(bad.error.code, 'bot/invalid')
  const missing = await env.call('save-issue-widget', { callId: 'issue:chief:9', widget: { pane: 'compare' } })
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'bot/invalid')
  const disk = JSON.parse(readFileSync(join(env.home, 'state.json'), 'utf8'))
  assert.equal(disk.issueWidgets[callId].pane, 'plan')
  assert.equal(disk.issueCards[callId].issues[0].title, first.title)
  env.rt.state.views.chief = { id: 'view-1' }
  await emit(env.ctx, 'chief', { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'next' }] } })
  assert.equal(env.rt.state.views.chief, undefined)
  assert.equal(env.rt.state.issueWidgets[callId].pane, 'plan')
  assert.equal(env.rt.state.issueCards[callId].conclusion, '先做来源校验')
})

test('a group, another bot, a hidden turn, or a list without urls never mounts a card', async (t) => {
  let fetches = 0
  const env = await setup({
    issueFetch: async () => {
      fetches += 1
      return jsonResponse({ message: 'Not Found' }, 404)
    },
  })
  t.after(() => env.stop())
  await play(env.ctx, env.rt, 'chief-group', 3, [toolResult(ghList()), assistant(CITED)])
  await play(env.ctx, env.rt, 'writer-now', 3, [toolResult(ghList()), assistant(CITED)])
  env.rt.state.exchangeTurns.chief = [4]
  await play(env.ctx, env.rt, 'chief', 4, [toolResult(ghList()), assistant(CITED)])
  await play(env.ctx, env.rt, 'chief', 5, [assistant('- #98 卡片回调没有来源校验')])
  await play(env.ctx, env.rt, 'chief', 6, [assistant('没读到这份 Issue 列表')])
  assert.equal(fetches, 0)
  assert.deepEqual(env.rt.state.issueCards, {})
  const missed = [
    { type: 'turn/start', data: { turn: 3 }, time: 1 },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: CITED }] } }, time: 2 },
  ]
  assert.equal(env.rt.displayItems('chief-group', missed).some(item => item.kind === 'issue'), false)
  assert.equal(env.rt.displayItems('writer-now', missed).some(item => item.kind === 'issue'), false)
  const plain = { requestId: 'p', sessionId: 'chief', mode: 'queue', content: [{ type: 'text', text: '  hello\n' }] }
  await env.ctx.sessionController.prompt(plain)
  assert.equal(env.sent.at(-1), plain)
  await play(env.ctx, env.rt, 'chief', 7, [toolResult(ghList()), assistant(CITED)])
  assert.equal(fetches > 0, true)
  const card = env.rt.state.issueCards['issue:chief:7']
  assert.equal(card.evidence, 'session')
  assert.match(headerLine(card), /会话列表 · 只读/)
  assert.equal(headerLine(card).includes('公开 API'), false)
  assert.equal(card.conclusion, '先做来源校验')
  assert.equal(card.issues.length, 2)
  assert.equal(card.issues[0].title, '卡片回调没有来源校验，可伪造「已完成/推迟」')
  assert.equal(card.issues[0].url, 'https://github.com/open-x-agents/openDigitalMate/issues/98')
  assert.equal(card.issues[0].body, '')
  assert.deepEqual(card.issues[0].labels, [])
  assert.deepEqual(card.issues[0].excerpts, [])
  assert.equal(card.issues[0].commentState, 'none')
  assert.equal(card.issues[0].commentCount, 0)
  assert.equal(card.issues[0].priority, 'P0')
  assert.equal(card.issues[0].step, '校验回调签名')
  assert.equal(card.issues[1].body, '')
  assert.equal(card.issues[1].commentState, 'unread')
  assert.equal(card.issues[1].commentCount, 2)
  assert.equal(card.issues[1].topic, '评测')
  assert.equal(JSON.stringify(card).includes('还没有提炼'), false)
  assert.equal(JSON.stringify(card).includes('REST TITLE'), false)
  assert.equal(JSON.stringify(env.rt.state).includes('没读到'), false)
  const listed = [
    { type: 'turn/start', data: { turn: 7 }, time: 3 },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: CITED }] } }, time: 4 },
  ]
  const shown = env.rt.displayItems('chief', listed)
  assert.equal(shown.filter(item => item.kind === 'issue').length, 1)
  assert.equal(shown.at(-1).callId, 'issue:chief:7')
  await env.ctx.sessionController.prompt(plain)
  const attached = env.sent.at(-1).content[0].text
  assert.match(attached, /\[Issue brief scope\]/)
  assert.match(attached, /当前讨论：#98 · /)
  assert.equal(attached.includes('  hello\n'), true)
})

test('one failed public read keeps the other issue body on the same card', async (t) => {
  const env = await setup({
    issueFetch: async (url) => {
      const number = Number(/issues\/(\d+)/.exec(url)?.[1])
      if (number === 97) return jsonResponse({ message: 'Not Found' }, 404)
      if (url.includes('/comments')) return jsonResponse([])
      return jsonResponse({ body: '正文', comments: 0, labels: [{ name: 'bug' }] })
    },
  })
  t.after(() => env.stop())
  await play(env.ctx, env.rt, 'chief', 3, [toolResult(ghList()), assistant('列表')])
  const card = env.rt.state.issueCards['issue:chief:3']
  assert.equal(card.evidence, 'partial')
  assert.match(headerLine(card), /公开 API · 部分未读到/)
  assert.equal(card.issues[0].body, '正文')
  assert.deepEqual(card.issues[0].labels, ['bug'])
  assert.equal(card.issues[0].commentState, 'none')
  assert.equal(card.issues[1].title, '拒绝类评测用例')
  assert.equal(card.issues[1].body, '')
  assert.deepEqual(card.issues[1].excerpts, [])
  assert.equal(card.issues[1].commentState, 'unread')
  assert.equal(card.issues[1].commentCount, 2)
  assert.equal(card.issues[1].topic, '')
  assert.equal(JSON.stringify(card).includes('还没有提炼'), false)
  const items = env.rt.displayItems('chief', [
    { type: 'turn/start', data: { turn: 3 }, time: 1 },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '列表' }] } }, time: 2 },
  ])
  assert.equal(items.filter(item => item.kind === 'issue').length, 1)
})
