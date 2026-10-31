// 仓库里那份 docs/e2e-day1.md 与记录的一致性：run.json 不在时，它必须是「跑不通 + 卡在哪」，
// 不许写成跑通；卡在哪 要写清今天卡住的六个 issue。真跑之后 run.json 进来，这份用例就该改，
// 判定器（scripts/e2e-day1-check.mjs）会接过去按记录判红绿。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SECTIONS, KNOWN_BLOCKERS, statusText } from '../scripts/e2e-day1-check.mjs'

const docPath = fileURLToPath(new URL('../docs/e2e-day1.md', import.meta.url))
const runPath = fileURLToPath(new URL('../docs/e2e-day1/run.json', import.meta.url))
const doc = readFileSync(docPath, 'utf8')

const sectionText = (title) => {
  const start = doc.indexOf(`\n${title}\n`)
  if (start < 0) return null
  const rest = doc.slice(start + title.length + 2)
  const next = rest.indexOf('\n## ')
  return next < 0 ? rest : rest.slice(0, next)
}

test('run.json 不在时文档必须是跑不通', () => {
  assert.equal(
    existsSync(runPath),
    false,
    'docs/e2e-day1/run.json 已经存在：这一天要按记录判红绿，所以这条用例该改成「记录与文档一致」',
  )
  assert.equal(statusText(doc), '跑不通')
  assert.ok(doc.includes('\n## 卡在哪\n'), '跑不通 时必须有 ## 卡在哪')
})

test('卡在哪 列出今天卡住的六个 issue', () => {
  const body = sectionText('## 卡在哪') ?? ''
  for (const issue of KNOWN_BLOCKERS) assert.ok(body.includes(`#${issue}`), `卡在哪 少了 #${issue}`)
})

test('十个记录小节齐全且顺序固定', () => {
  const lines = doc.split('\n').map((line) => line.trimEnd())
  const positions = SECTIONS.map((title) => ({ title, at: lines.indexOf(title) }))
  for (const { title, at } of positions) assert.notEqual(at, -1, `少了 ${title}`)
  for (let i = 1; i < positions.length; i += 1) {
    assert.ok(positions[i].at > positions[i - 1].at, `${positions[i].title} 要排在 ${positions[i - 1].title} 之后`)
  }
})
