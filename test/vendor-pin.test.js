// vendor/ds-bot 的 pin 有四处手写副本：VENDOR_FROM、docs/vendor-ds-bot.md、
// vendor/ds-bot/package.json 的版本、根 package.json 的 peer 下限。
// 一起改才一致，单改一处今天没有任何东西会红——这四条用例就是那个「红」。
// 只读文件，不 import 任何 src/ 代码，所以它也能在合并树上直接跑。

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const VENDOR_FROM = readFileSync('vendor/ds-bot/VENDOR_FROM', 'utf8')
const VENDOR_DOC = readFileSync('docs/vendor-ds-bot.md', 'utf8')
const VENDOR_PKG = JSON.parse(readFileSync('vendor/ds-bot/package.json', 'utf8'))
const ROOT_PKG = JSON.parse(readFileSync('package.json', 'utf8'))

function line(text, pattern) {
  const found = text.split('\n').find((one) => pattern.test(one))
  assert.ok(found, `找不到匹配 ${pattern} 的行：\n${text}`)
  return found
}

// 两处记「来源树」的写法今天不是同一个串（VENDOR_FROM 带 "(clone of …)"，docs 用反引号），
// 所以比的是从各自行里抽出来的绝对路径，而不是整行。
function sourceTreePath(text) {
  const match = line(text, /(\/[^\s`()]+)/).match(/(\/[^\s`()]+)/)
  return match[1]
}

// peer 串有 >= / ^ / 空格几种写法，比较前统一成裸版本号。
function bareVersion(spec) {
  const match = String(spec).match(/(\d+\.\d+\.\d+)/)
  assert.ok(match, `认不出版本号：${spec}`)
  return match[1]
}

test('VENDOR_FROM 记的提交就是 docs 记的提交', () => {
  const fromVendor = line(VENDOR_FROM, /^commit:/).match(/([0-9a-f]{40})/)[1]
  const fromDocs = line(VENDOR_DOC, /^- Commit:/).match(/([0-9a-f]{40})/)[1]
  assert.equal(fromDocs, fromVendor)
})

test('VENDOR_FROM 记的来源树就是 docs 记的来源树', () => {
  assert.equal(sourceTreePath(line(VENDOR_DOC, /^- Source tree:/)), sourceTreePath(VENDOR_FROM))
})

test('根 package.json 的 peer 下限等于 vendored ds-bot 的版本', () => {
  assert.equal(bareVersion(ROOT_PKG.peerDependencies['ds-bot']), VENDOR_PKG.version)
})

test('docs 里写的 peer 依赖与根 package.json 一致', () => {
  const documented = line(VENDOR_DOC, /`ds-bot\s*[>^=]*\s*\d+\.\d+\.\d+`/).match(/`(ds-bot\s*[>^=]*\s*\d+\.\d+\.\d+)`/)[1]
  assert.equal(bareVersion(documented), bareVersion(ROOT_PKG.peerDependencies['ds-bot']))
})
