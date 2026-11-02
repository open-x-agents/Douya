import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { TEAM_TOOLS } from '../src/host/constants.js'
import { install } from '../src/host/prompt.js'
import { extractIssueRows, matchesIssueScene, projectIssueScene } from '../src/shared/issue-scene.js'
import { fakeContext } from './fake-ctx.js'

const OPEN_ISSUES = [
  [98, '卡片回调没有来源校验，可伪造「已完成/推迟」'],
  [11, '接入 Composio（日历 + 邮件元数据）'],
  [10, '信源适配器契约 + GitHub 只读'],
  [12, '飞书只读适配器（日历 + 云文档）'],
  [32, 'Composio 多 app 支持'],
  [19, '测试分层 v1'],
  [97, '拒绝类评测用例'],
  [2, '设计 v0.8'],
  [17, '阶段一设计 v1'],
  [48, 'Agent UI 调研 RFC'],
  [61, '群组/工作线实现文档'],
  [30, '工作线编排总控'],
]

const MAIN = {
  sessionId: 'chief',
  ownerSessionId: 'chief',
  mainBotId: 'chief',
  chatOwner: 'chief',
}

function ghJson(rows) {
  return JSON.stringify(rows.map(([number, title]) => ({
    number,
    title,
    url: `https://github.com/open-x-agents/openDigitalMate/issues/${number}`,
    author: { login: 'niuypei' },
    comments: number === 97 ? [{ id: 1 }, { id: 2 }] : [],
  })))
}

const GH_OUTPUT = `exit code: 0\n${ghJson(OPEN_ISSUES)}\n`
const REPLY = OPEN_ISSUES.map(([number, title]) => `- #${number} ${title}`).join('\n')

test('S22 a gh issue list already in the transcript projects twelve rows and leaves the reply alone', () => {
  const input = { ...MAIN, text: `${GH_OUTPUT}\n${REPLY}` }
  const before = input.text
  const scene = projectIssueScene(input)
  assert.equal(input.text, before)
  assert.equal(scene.match, true)
  assert.deepEqual(scene.issues.map(issue => issue.number), OPEN_ISSUES.map(([number]) => number))
  assert.equal(scene.issues[0].title, OPEN_ISSUES[0][1])
  assert.equal(scene.issues[0].url, 'https://github.com/open-x-agents/openDigitalMate/issues/98')
  assert.equal(scene.issues.find(issue => issue.number === 97)?.comments, 2)
  assert.equal(scene.issues.find(issue => issue.number === 10)?.comments, 0)
  assert.equal(Object.hasOwn(scene, 'reply'), false)
  assert.equal(JSON.stringify(scene).includes('没读到'), false)
})

test('S22 the identity prompt and team tools stay free of an issue answer strategy', (t) => {
  const ctx = fakeContext()
  install({
    ctx,
    selfOf: id => id === 'chief-group' ? 'chief' : id,
    botOf: id => id === 'chief' ? { name: 'Chief', role: 'Chief of Staff' } : undefined,
    roomOf: () => undefined,
    isMain: id => id === 'chief',
  })
  t.after(() => ctx.dispose())
  const prompt = id => ctx.sections.get('bot-identity').text({ agent: { id } })
  assert.equal(prompt('chief'), prompt('chief-group'))
  assert.doesNotMatch(prompt('chief'), /read_public_issues|show_issue_brief|ISSUE_RULES|没读到这份 Issue 列表/)
  assert.equal(TEAM_TOOLS.includes('read_public_issues'), false)
  assert.equal(TEAM_TOOLS.includes('show_issue_brief'), false)
  const source = readFileSync(new URL('../src/shared/issue-scene.js', import.meta.url), 'utf8')
  assert.equal(source.includes('没读到'), false)
  assert.equal(source.includes('fetch('), false)
  assert.equal(source.includes('defineTool'), false)
  assert.equal(source.includes('GITHUB_TOKEN'), false)
})

test('S23 the card scene is only the Main Bot current private chat with at least one row', () => {
  assert.equal(matchesIssueScene(MAIN), true)
  assert.equal(projectIssueScene({ ...MAIN, text: GH_OUTPUT }).match, true)
  const blocked = [
    { ...MAIN, isGroup: true },
    { ...MAIN, isSide: true },
    { ...MAIN, isBtw: true },
    { ...MAIN, isHidden: true },
    { ...MAIN, isGroup: true, chatOwner: 'chief' },
    { ...MAIN, chatOwner: 'writer', ownerSessionId: 'writer-now', sessionId: 'writer-now' },
    { ...MAIN, sessionId: 'chief-old', ownerSessionId: 'chief' },
    { ...MAIN, mainBotId: '' },
  ]
  for (const input of blocked) {
    assert.equal(matchesIssueScene(input), false)
    assert.deepEqual(projectIssueScene({ ...input, text: GH_OUTPUT }), { match: false, issues: [] })
  }
  assert.equal(extractIssueRows(GH_OUTPUT).length, 12)
  assert.deepEqual(projectIssueScene({ ...MAIN, text: '' }), { match: false, issues: [] })
  assert.deepEqual(projectIssueScene({ ...MAIN, text: '没读到这份 Issue 列表' }), { match: false, issues: [] })
  assert.deepEqual(projectIssueScene({ ...MAIN, text: '404\n{"message":"Not Found"}\n' }), { match: false, issues: [] })
  assert.deepEqual(projectIssueScene(null), { match: false, issues: [] })
})

test('tool tables, compact lines, and markdown replies yield rows; a pull request does not', () => {
  const table = '98\tOPEN\t卡片回调没有来源校验\tbug\t2026-11-01'
  assert.deepEqual(extractIssueRows(table), [{ number: 98, title: '卡片回调没有来源校验', url: '' }])
  const compact = '10\t信源适配器契约\tniuypei\tbug\t4条评论\t更新:2026-11-01'
  assert.deepEqual(extractIssueRows(compact), [{ number: 10, title: '信源适配器契约', url: '', comments: 4 }])
  assert.deepEqual(extractIssueRows('2\t设计 v0.8\tniuypei\t\t0条评论\t更新:2026-11-01'), [{ number: 2, title: '设计 v0.8', url: '', comments: 0 }])
  assert.deepEqual(extractIssueRows(REPLY).map(issue => issue.number), OPEN_ISSUES.map(([number]) => number))
  const mixed = JSON.stringify([
    { number: 72, title: 'a pull request', pull_request: { url: 'https://api.github.com/pulls/72' } },
    { number: 10, title: '信源适配器契约', html_url: 'https://github.com/open-x-agents/openDigitalMate/issues/10', comments: 1 },
  ])
  assert.deepEqual(extractIssueRows(mixed), [{
    number: 10,
    title: '信源适配器契约',
    url: 'https://github.com/open-x-agents/openDigitalMate/issues/10',
    comments: 1,
  }])
  assert.deepEqual(extractIssueRows('{"message":"Not Found"}'), [])
  assert.deepEqual(extractIssueRows(undefined), [])
})
