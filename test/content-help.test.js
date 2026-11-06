// Content that helps: grounded #numbers, concrete next steps, 等你 vs 等别人, real PR briefs, and the 「没用」 loop.
// Regression (real data 2026-11-04): system1-agents card said "#132 / #188 / #189" while its items were #111 / #109 / #108 —
// the GitHub snapshot carried no numbers, so the bot guessed them.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import { buildSnapshot } from '../src/digest/snapshot.js'
import { validateCandidates, validatePlan, buildCards, allowedNums, ungroundedNums, isVagueNext } from '../src/digest/build.js'
import { buildPrBrief, briefTarget, payload } from '../src/web/card-brief.js'
import { notUsefulPref } from '../src/web/api.js'

const R = 'ThinkFlowLab/system1-agents'
const gh = (n, title, type = 'pr-review', kind = 'pull') => ({ source: 'github', type, sourceId: `github:${kind}:${n}`, title, url: `https://github.com/${R}/${kind === 'pull' ? 'pull' : 'issues'}/${n}`, body: `#${n} in ${R}`, metadata: { state: 'open', repository: R }, updatedAt: new Date().toISOString() })
const items = () => [gh(111, '[Feat] Score browser decision backends', 'pr-mine'), gh(109, '[Eval] Mind2Web/WebLINX', 'issue-activity', 'issue'), gh(108, '[Eval] Qualify Kev', 'issue-activity', 'issue')]

test('github snapshot rows carry the real number (bots copy it, never guess)', () => {
  const snap = buildSnapshot('github', items(), {})
  assert.deepEqual(snap.rows.map(r => r.num).sort(), ['#108', '#109', '#111'])
})
test('invented numbers are rejected with a fix-it error and never shipped', () => {
  const snap = buildSnapshot('github', items(), {})
  const refs = snap.rows.map(r => r.ref)
  const v = validateCandidates('github', JSON.stringify([{ title: 'system1-agents：评测 PR 与两个 eval issue', category: R, needsAction: false, priority: 'low',
    summary: '我的 PR #132 仍在等 review，还开着 #188 和 #189 两个 eval issue。', nextStep: '看一眼 #132 的 review 状态', items: refs.map(r => ({ ref: r, status: 'waiting' })) }]), snap)
  assert.equal(v.candidates.length, 1)
  assert.ok(v.errors.some(e => /#132/.test(e) && /#111/.test(e) && /num/.test(e)), v.errors.join('\n'))
  assert.equal(v.candidates[0].summary, ''); assert.equal(v.candidates[0].nextStep, '')
  assert.deepEqual(v.candidates[0].nums.sort(), ['108', '109', '111'])
  // grounded text passes untouched
  const ok = validateCandidates('github', JSON.stringify([{ title: 'system1-agents 评测', category: R, summary: '我的 PR #111 在等 review；#109、#108 两个评测 issue 待排期。', nextStep: '催 reviewer 看 #111：分步打分后端', items: refs }]), snap)
  assert.equal(ok.errors.length, 0, ok.errors.join('\n')); assert.match(ok.candidates[0].summary, /#111/)
})
test('numbers written in an item title (e.g. mail subject "PR #733") count as grounded', () => {
  const a = allowedNums([{ url: 'https://mail.google.com/mail/u/0/#inbox/x', title: '[Birfy/agentdescent] PR #733 review requested' }])
  assert.deepEqual(ungroundedNums('先审 #733，再看 #734', a), ['734'])
})
test('vague next steps are flagged; concrete verb+object passes', () => {
  for (const s of ['查看详情', '处理一下', '看一眼', '忽略或归档', '跟进', '']) assert.equal(isVagueNext(s), true, s)
  for (const s of ['回复 Fledge：#15 继续修还是关闭', '先审 #733：看 quota 改动', '归档这 17 封通知']) assert.equal(isVagueNext(s), false, s)
  const snap = buildSnapshot('github', items(), {})
  const v = validateCandidates('github', JSON.stringify([{ title: 'x', category: R, nextStep: '处理一下', items: [snap.rows[0].ref] }]), snap)
  assert.ok(v.errors.some(e => /太空泛/.test(e)))
})
test('Chief edits cannot introduce numbers the card does not have', () => {
  const p = validatePlan(JSON.stringify({ cards: [{ id: 'github:0', nextStep: '先审 #999', title: '#111 等 review' }] }), [{ id: 'github:0', channel: 'github', nums: ['111'], items: [] }])
  assert.equal(p.edits.get('github:0').nextStep, undefined); assert.equal(p.edits.get('github:0').title, '#111 等 review')
  assert.ok(p.errors.some(e => /#999/.test(e)))
})
test('waiting-on-others items make the card 等别人, not FYI', () => {
  const snap = buildSnapshot('github', items(), {})
  const v = validateCandidates('github', JSON.stringify([{ title: 'system1-agents', category: R, needsAction: false, summary: '#111 等 review', nextStep: '催 reviewer 看 #111', items: snap.rows.map(r => ({ ref: r.ref, status: 'waiting' })) }]), snap)
  const { cards } = buildCards({ github: snap }, { github: v.candidates }, validatePlan('{}', v.candidates))
  assert.equal(cards[0].waiting, 'others')
})
test('source + chief prompts demand why-now, verb+object, copied numbers, waiting status', () => {
  const src = fs.readFileSync(new URL('../src/digest/runner.js', import.meta.url), 'utf8')
  assert.match(src, /编号只能抄快照里的 num 字段/); assert.match(src, /禁止「查看详情」「处理一下」/); assert.match(src, /status 填 "waiting"/); assert.match(src, /有人卡在等你 \/ 有截止 \/ CI 挂了/)
})

// ---- PR brief (real GitHub data, no model) ----
const files = [
  { filename: 'agentdescent/tenancy/quota.py', additions: 400, deletions: 10, changes: 410 },
  { filename: 'agentdescent/tenancy/roles.py', additions: 300, deletions: 3, changes: 303 },
  { filename: 'migrations/0042_quota.sql', additions: 60, deletions: 0, changes: 60 },
  { filename: 'tests/test_quota.py', additions: 67, deletions: 0, changes: 67 },
]
test('brief: size, areas, CI, review state, risk, one concrete next move', () => {
  const b = buildPrBrief({ number: 740, title: 'feat(tenant): quota', state: 'open', html_url: 'https://github.com/o/r/pull/740', body: '## Summary\n\nAdds per-workspace quota and an audit log.', requested_reviewers: [{ login: 'alice' }] }, files, [{ name: 'core', status: 'completed', conclusion: 'success' }])
  const m = Object.fromEntries(b.lines.map(l => [l.k, l.v]))
  assert.match(m['改动'], /^\+827 −13 · 4 个文件，主要在 agentdescent\/tenancy/)
  assert.match(m['状态'], /CI 全部通过/); assert.match(m['状态'], /等 alice review/)
  assert.match(m['留意'], /数据库迁移/); assert.match(m['留意'], /改动量大/)
  assert.equal(m['作者说'], 'Adds per-workspace quota and an audit log.')
  assert.match(b.next, /^先看 agentdescent\/tenancy，重点看「动了数据库迁移/); assert.equal(b.resolved, false)
})
test('brief: failing CI on my PR → fix CI first; draft review → wait; merged → resolved', () => {
  const fail = buildPrBrief({ number: 7, state: 'open' }, files, [{ name: 'unit (3.11)', status: 'completed', conclusion: 'failure' }], { mine: true })
  assert.match(fail.lines.find(l => l.k === '状态').v, /CI 1 项失败：unit \(3\.11\)/); assert.equal(fail.next, '先修 CI：unit (3.11)'); assert.equal(fail.ciFailed, true)
  const draft = buildPrBrief({ number: 8, state: 'open', draft: true }, files, [])
  assert.match(draft.next, /草稿/); assert.equal(draft.resolved, false)
  const merged = buildPrBrief({ number: 9, state: 'closed', merged_at: '2026-11-04T00:00:00Z' }, files, [])
  assert.equal(merged.resolved, true); assert.match(merged.next, /已合并/)
  const changes = buildPrBrief({ number: 10, state: 'open', changesRequested: ['bob'] }, files, [], { mine: true })
  assert.equal(changes.next, '先改 bob 提的意见')
})
test('brief target: PR to review before my own PR; handled items skipped; composio payload unwrap', () => {
  const card = { id: 'c', blocks: [{ type: 'link-list', links: [{ url: 'https://github.com/o/r/pull/1', type: 'pr-mine' }, { url: 'https://github.com/o/r/pull/2', type: 'pr-assigned' }] }] }
  assert.equal(briefTarget(card).number, 2); assert.equal(briefTarget(card).mine, false)
  assert.equal(briefTarget(card, { 'https://github.com/o/r/pull/2': { status: 'done' } }).number, 1)
  assert.equal(payload({ data: { response_data: { number: 3 } } }).number, 3)
  assert.equal(payload({ data: { details: 'patch text' } }).details, 'patch text') // a string is never mistaken for the PR
})
test('brief endpoint + UI: hero and card zoom mount it; merged source ticks the item', () => {
  const api = fs.readFileSync(new URL('../src/web/api.js', import.meta.url), 'utf8')
  const routes = fs.readFileSync(new URL('../src/web/dsh-host-routes.js', import.meta.url), 'utf8')
  const html = fs.readFileSync(new URL('../src/client/index.html', import.meta.url), 'utf8')
  assert.match(routes, /path: '\/api\/opendigitalmate\/card-brief'/)
  assert.match(api, /brief\.resolved && live && !\(st\.itemStatus \|\| \{\}\)\[target\.url\]/)
  assert.match(html, /mountBrief\(nxEl\.querySelector\('\.nx-slot'\)/); assert.match(html, /mountBrief\(slot, card, \{ live \}\)/)
  assert.match(html, /先一句话结论/)
})

// ---- 「没用」 feedback loop ----
test('没用 writes a digest preference naming the kind of thing', () => {
  assert.deepEqual(notUsefulPref({ title: '社交通知', type: 'email-group', source: 'gmail', metadata: { group: 'social' } }).channel, 'gmail')
  assert.match(notUsefulPref({ title: '社交通知', type: 'email-group', source: 'gmail', metadata: { group: 'social' } }).text, /社交通知邮件以后 priority 放 low、不单独出卡，除非有人点名/)
  assert.match(notUsefulPref({ title: '竞品频道新增 Scrapling', source: 'slack' }).text, /Slack 频道消息/)
  const api = fs.readFileSync(new URL('../src/web/api.js', import.meta.url), 'utf8')
  assert.match(api, /if \(action === 'not-useful'\)[\s\S]{0,700}botDigest\.store\.addPref\(fb\.text/)
  assert.match(api, /if \(action === 'undo-not-useful'\)[\s\S]{0,300}removePref/)
  const html = fs.readFileSync(new URL('../src/client/index.html', import.meta.url), 'utf8')
  assert.match(html, /data-qa="useless"[^>]*>\$\{t\('qa\.useless'\)\}<\/button>/); assert.match(html, /if \(qa === 'useless'\) return runQuickUseless\(card\)/)
})

test('a single actionable mail (email-action) offers a reply draft, not just 明天再看', async () => {
  const { prepareCardActions } = await import('../src/web/card-prep.js')
  const card = { id: 'e1', type: 'email-action', source: 'gmail', title: 'Fledge 等你回答 jitagent 的工单走向', waiting: 'you', status: 'active',
    blocks: [{ type: 'link-list', links: [{ title: '[Fledge] 团队需要你回答：Birfy/jitagent', url: 'https://mail.google.com/mail/u/0/#inbox/1a1a3f2144f1d300', type: 'email', from: 'fledge@hugoxk.online' }] }] }
  const p = prepareCardActions(card, { max: 3, lang: 'zh' })
  assert.equal(p[0].id, 'reply-first'); assert.match(p[0].label, /^起草回复/); assert.match(p[0].prompt, /等我确认再发/)
})
