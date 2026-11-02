#!/usr/bin/env node
// 启动校验的 CLI 形态：`assertReadOnlyRegistry()` 不合法时打印 E_WRITE_ACTION 与动作名、退出 1。
//
//   node scripts/composio-check.mjs                                  # 校验仓库里的注册表
//   node scripts/composio-check.mjs --registry <file.json>           # 校验另一份注册表（含坏例）
//
// 不联网、不要 key：它只读本地文件和 `capabilities.js` 的固定快照。

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { assertReadOnlyRegistry, registry } from '../src/sources/composio/registry.js'
import { SNAPSHOT } from '../src/sources/composio/capabilities.js'

const argv = process.argv.slice(2)

function flagValue(name) {
  const index = argv.indexOf(name)
  if (index === -1) return null
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) return null
  return value
}

const file = flagValue('--registry')
let rows = registry
if (file !== null) {
  const parsed = JSON.parse(readFileSync(resolve(file), 'utf8'))
  rows = Array.isArray(parsed) ? parsed : parsed.registry
}

try {
  assertReadOnlyRegistry(rows, SNAPSHOT)
} catch (error) {
  // 只打印结论：不打印 key、不打印账号；动作名是这份注册表里的公开名字。
  console.error(String(error?.message ?? error))
  process.exit(1)
}

console.log(`read-only registry ok: ${rows.length} app(s), snapshot ${SNAPSHOT.at}`)
