// #61 PR1: the group / work-line doc must stay tied to the code it describes.
// Three assertions only (PR2 adds the acceptance-test and mermaid checks):
//   1. the sections already written appear in order 1 → 2 → 3 → 4 → 7;
//   2. every `symbol` — `path:line` reference names its symbol within ±3 lines;
//   3. every key the team file persists is documented.
// The doc is written against dev_nyp @ 6cbb5cc; a moved line number turns this red on
// purpose — fix the anchor, do not loosen the test.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const docPath = join(root, 'docs/group-work-lines.md')
const doc = () => readFileSync(docPath, 'utf8')

const REF = /`([^`]+)`\s*—\s*`?([\w./-]+):(\d+)/g

const headingsOf = (text) => text.split('\n')
  .filter(line => /^#{2,3}\s+/.test(line))
  .map(line => line.replace(/^#{2,3}\s+/, '').trim())

const REQUIRED_SECTIONS = ['目的与原则', '组件与归属', '数据模型', '主要流程', '已知缺口与债']

// The 19 keys of the team file, read from the literal in store.js rather than copied
// here: a new persisted key must be documented before this stays green.
function stateKeys() {
  const source = readFileSync(join(root, 'vendor/ds-bot/src/host/store.js'), 'utf8')
  const start = source.indexOf('const state = {')
  assert.notEqual(start, -1, 'store.js no longer declares the state literal')
  const open = source.indexOf('{', start)
  let depth = 0
  let end = -1
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) {
        end = index
        break
      }
    }
  }
  assert.notEqual(end, -1, 'the state literal in store.js is not closed')
  const body = source.slice(open + 1, end)
  const keys = []
  depth = 0
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]
    if (char === '{' || char === '[') depth += 1
    else if (char === '}' || char === ']') depth -= 1
    else if (char === ':' && depth === 0) {
      let at = index - 1
      while (at >= 0 && /\s/.test(body[at])) at -= 1
      const last = at
      while (at >= 0 && /[\w$]/.test(body[at])) at -= 1
      const key = body.slice(at + 1, last + 1)
      if (/^[A-Za-z_$][\w$]*$/.test(key)) keys.push(key)
    }
  }
  return keys
}

test('the doc has the required sections in order', () => {
  assert.ok(existsSync(docPath), 'docs/group-work-lines.md is missing')
  const headings = headingsOf(doc())
  let at = -1
  for (const section of REQUIRED_SECTIONS) {
    const found = headings.findIndex(heading => heading.includes(section))
    assert.notEqual(found, -1, `the doc has no "${section}" section`)
    assert.ok(found > at, `"${section}" must come after the previous required section`)
    at = found
  }
})

test('every code reference names its symbol on the cited line', () => {
  const text = doc()
  const refs = [...text.matchAll(REF)]
  assert.ok(refs.length >= 20, `expected the doc to cite the code, found ${refs.length} references`)
  const cache = new Map()
  const bad = []
  for (const [, symbol, path, line] of refs) {
    if (path.startsWith('/') || path.includes('..')) {
      bad.push(`${symbol} → ${path}:${line} (path must be repo-relative)`)
      continue
    }
    const file = join(root, path)
    if (!existsSync(file)) {
      bad.push(`${symbol} → ${path}:${line} (no such file)`)
      continue
    }
    if (!cache.has(path)) cache.set(path, readFileSync(file, 'utf8').split('\n'))
    const lines = cache.get(path)
    const number = Number(line)
    if (!Number.isInteger(number) || number < 1 || number > lines.length) {
      bad.push(`${symbol} → ${path}:${line} (line out of range, file has ${lines.length})`)
      continue
    }
    const window = lines.slice(Math.max(0, number - 4), number + 3).join('\n')
    if (!window.includes(symbol)) bad.push(`${symbol} → ${path}:${line} (symbol not within ±3 lines)`)
  }
  assert.deepEqual(bad, [], `dangling references:\n${bad.join('\n')}`)
})

test('every persisted state key is documented', () => {
  const keys = stateKeys()
  assert.equal(keys.length, 19, `store.js state literal should hold 19 keys, parsed ${keys.length}`)
  const text = doc()
  const missing = keys.filter(key => !text.includes('`' + key + '`'))
  assert.deepEqual(missing, [], `undocumented persisted keys: ${missing.join(', ')}`)
})
