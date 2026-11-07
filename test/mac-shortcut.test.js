// Regression: on macOS the only way in was typing `open "$(cat .odm-data/dsh-web.url)"` in a
// terminal. The doc that puts that behind a system-wide Shortcut must keep the seven steps in
// order, the one copy-paste command with absolute binaries (a Shortcut's shell has no repo cwd
// and a narrow PATH), no real token value or local path, and a README pointer inside Quick start.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'

const doc = fs.readFileSync(new URL('../docs/mac-shortcut.md', import.meta.url), 'utf8')
const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8')

const HEADINGS = [
  '## 前提',
  '## 1. 做一个 Shortcut',
  '## 2. 钉到菜单栏',
  '## 3. 在终端里直接用',
  '## 4. 第一次会遇到什么',
  '## 5. 排错',
  '## 6. 这一版不做的',
]

const COMMAND = '/usr/bin/open "$(/bin/cat <仓库绝对路径>/.odm-data/dsh-web.url)"'

test('the doc has the seven headings in order', () => {
  const lines = doc.split('\n').map((line) => line.trimEnd())
  let from = 0
  for (const heading of HEADINGS) {
    const at = lines.indexOf(heading, from)
    assert.notEqual(at, -1, `missing heading in order: ${heading}`)
    from = at + 1
  }
  assert.deepEqual(lines.filter((line) => line.startsWith('## ')), HEADINGS)
})

test('the doc gives one copy-paste command with absolute paths', () => {
  const lines = doc.split('\n').map((line) => line.trimEnd())
  assert.ok(lines.includes(COMMAND), `missing the command line: ${COMMAND}`)
  assert.ok(doc.includes('Run Shell Script'), 'missing the Run Shell Script step')
  assert.ok(doc.includes('Pin in Menu Bar'), 'missing the Pin in Menu Bar step')
  assert.ok(doc.includes('<仓库绝对路径>'), 'missing the repository path placeholder')
})

test('the doc carries no token value and no local absolute path', () => {
  assert.doesNotMatch(doc, /token=[A-Za-z0-9_-]{6,}/)
  assert.ok(!doc.includes('/Users/'), 'the doc must not carry a /Users/ path')
})

test('README links the doc inside the quick start section', () => {
  const lines = readme.split('\n')
  const linkAt = lines.findIndex((line) => line.includes('docs/mac-shortcut.md'))
  const warnedAt = lines.findIndex((line) => line.includes('Do not commit or paste the token URL'))
  const sectionAt = lines.findIndex((line) => line.trim() === '### Configure AI + Composio')
  assert.notEqual(linkAt, -1, 'README does not link docs/mac-shortcut.md')
  assert.notEqual(warnedAt, -1, 'README lost the token-URL warning')
  assert.notEqual(sectionAt, -1, 'README lost the Configure AI + Composio section')
  assert.ok(
    linkAt > warnedAt && linkAt < sectionAt,
    `README link at line ${linkAt + 1}, expected between line ${warnedAt + 1} and line ${sectionAt + 1}`,
  )
})
