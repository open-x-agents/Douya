// 启动校验：注册表里混进一个写动作 → 启动失败（同步抛 E_WRITE_ACTION），不是一条告警。
//
// 告警会被日志吞掉，写动作却已经进了白名单；这里要证明的是 createRuntime 在返回 rt 之前
// 就抛，`log` 一次都没被调用。

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRuntime } from '../../index.js'
import { registry } from '../../src/sources/composio/registry.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function withWriteAction(rows) {
  return rows.map(row =>
    row.toolkit === 'gmail' ? { ...row, actions: [...row.actions, 'GMAIL_SEND_EMAIL'] } : row,
  )
}

test('a write action in the registry stops startup instead of logging a warning', () => {
  const logged = []
  const bad = withWriteAction(registry)
  assert.throws(
    () => createRuntime({}, { home: mkdtempSync(join(tmpdir(), 'odm32-startup-')), composioRegistry: bad, log: line => logged.push(line) }),
    /E_WRITE_ACTION/,
  )
  // 不是「记一条告警然后继续跑」。
  assert.deepEqual(logged, [])
})

test('the registry that ships with the repo passes startup', () => {
  const rt = createRuntime({}, { home: mkdtempSync(join(tmpdir(), 'odm32-startup-')) })
  assert.ok(rt.store, 'createRuntime 没有返回 rt')
})

test('the CLI exits 1 and names the write action', () => {
  const cli = spawnSync(
    process.execPath,
    ['scripts/composio-check.mjs', '--registry', 'test/fixtures/composio/registry-with-send.json'],
    { cwd: ROOT, encoding: 'utf8' },
  )
  assert.equal(cli.status, 1, cli.stdout + cli.stderr)
  assert.match(cli.stderr, /E_WRITE_ACTION/)
  assert.match(cli.stderr, /GMAIL_SEND_EMAIL/)
})

test('the CLI exits 0 on the shipped registry', () => {
  const cli = spawnSync(process.execPath, ['scripts/composio-check.mjs'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(cli.status, 0, cli.stdout + cli.stderr)
  assert.match(cli.stdout, /read-only registry ok/)
})
