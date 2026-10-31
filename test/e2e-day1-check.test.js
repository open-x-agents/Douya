// 判定器自己也会坏，所以每条规则都要有一条证明它会红的用例。
// 第一刀只有 status / doc 两段（7 段里剩下的 5 段随后续切片补），这里判的就是这两段。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runChecks, formatResults, checkStatus } from '../scripts/e2e-day1-check.mjs'

const fixtureDir = fileURLToPath(new URL('./fixtures/e2e-day1/', import.meta.url))
const shots = join(fixtureDir, 'shots')
const readJson = (name) => JSON.parse(readFileSync(join(fixtureDir, name), 'utf8'))
const readText = (name) => readFileSync(join(fixtureDir, name), 'utf8')

const completeRun = () => readJson('run-complete.json')
const completeDoc = () => readText('doc-complete.md')

function check(doc, run, shotsDir = shots) {
  const results = runChecks({ doc, run, shotsDir })
  return { results, ...formatResults(results) }
}

function problemsOf(results, name) {
  return results.find((result) => result.name === name).problems.join('\n')
}

test('完整的记录通过 2/2', () => {
  const { results, lines, passed, total } = check(completeDoc(), completeRun())
  assert.equal(total, 2, lines.join('\n'))
  assert.equal(passed, 2, lines.join('\n'))
  assert.equal(lines.at(-1), 'PASS 2/2')
  assert.deepEqual(results.map((result) => result.name), ['status', 'doc'])
})

test('少了 ## 时延四项 这一节 → 红', () => {
  const { results, lines } = check(readText('doc-missing-section.md'), completeRun())
  assert.match(problemsOf(results, 'doc'), /少了 ## 时延四项 这一节/)
  assert.equal(lines.at(-1), 'FAIL 1/2')
})

test('steps 少一步 → 红', () => {
  const run = completeRun()
  run.steps = run.steps.filter((step) => step.name !== 'closure')
  const { results } = check(completeDoc(), run)
  assert.match(problemsOf(results, 'doc'), /run\.steps|少了 closure/)
})

test('deadline_ms 重算差 > 1s → 红', () => {
  const run = completeRun()
  const morning = run.steps.find((step) => step.name === 'morning_report')
  morning.deadline_ms += 60_000
  const { results } = check(completeDoc(), run)
  assert.match(problemsOf(results, 'doc'), /deadline_ms 与重算差/)
  // 反过来：记录对了就不该报这条
  assert.equal(check(completeDoc(), completeRun()).passed, 2)
})

test('面板数字与 refs 对不上 → 红', () => {
  const run = completeRun()
  run.panel.numbers[0].value = '3/3'
  const { results } = check(completeDoc(), run)
  assert.match(problemsOf(results, 'doc'), /提交率的 value 应是 2\/3/)
})

test('五张截图缺一张 → 红', () => {
  const { results } = check(completeDoc(), completeRun(), join(fixtureDir, 'no-shots-here'))
  assert.match(problemsOf(results, 'doc'), /截图缺 morning-report\.png/)
})

test('跑不通 却各段全过 → 红（状态写反了）', () => {
  const run = { ...completeRun(), status: 'fail' }
  const doc = completeDoc()
    .replace('Status: 跑通', 'Status: 跑不通')
    .replace('无。这一天跑通了。', '卡在 #9 与 #14（夹具）。')
  const { results } = check(doc, run)
  assert.match(problemsOf(results, 'doc'), /状态写反了/)
})

test('文档把状态写成别的词 → 红', () => {
  const doc = completeDoc().replace('Status: 跑通', 'Status: 大概跑通')
  const { results } = check(doc, completeRun())
  assert.match(problemsOf(results, 'doc'), /Status: 只能写 跑通 \/ 跑不通/)
})

test('run.status 不是 pass / fail → 红', () => {
  const run = { ...completeRun(), status: 'maybe' }
  assert.match(problemsOf(runChecks({ doc: completeDoc(), run, shotsDir: shots }), 'status'), /status 只能是 pass \/ fail/)
})

test('sha 不是 40 位 → 红', () => {
  const run = completeRun()
  run.run.sha = 'deadbeef'
  assert.match(checkStatus(run).join('\n'), /run\.sha 必须是 40 位十六进制/)
})
