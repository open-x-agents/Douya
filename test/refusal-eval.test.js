// 拒绝类评测的 CLI：18 条验收里属于第三刀的那几条（A14/A15）+ 选题与题面的单元断言。
//
// 这一层不联网、不花钱：`--list` 本来就只读题集；另外两条打的是 usage / 缺 key 分支，
// 都在连模型之前就 exit 2。真跑一轮（`--partition=tune`）要 key，只由人手动做，不在 L0 里。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadCases, modelPrompt, selectCases } from '../acceptance-cases/refusals/cases.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const RUNNER = join(ROOT, 'test', 'e2e', 'refusal.e2e.mjs')

// 测试里不许真花钱：凡是 MODEL_* 一律摘掉（连父进程那份也不留），
// 这样「没有 MODEL_API_KEY」那条测的是真的没有，而不是碰运气。
const CLEAN_ENV = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^MODEL_/i.test(key)))

function runEval(args, env = CLEAN_ENV) {
  return spawnSync(process.execPath, [RUNNER, ...args], { cwd: ROOT, env, encoding: 'utf8' })
}

const ids = (output) => output.split('\n').map((line) => line.trim()).filter(Boolean)

test('refusal.e2e.mjs：--list 按池列出，两池不重叠且并集是全集', () => {
  const tune = runEval(['--list', '--partition=tune'])
  const holdout = runEval(['--list', '--partition=holdout'])
  assert.equal(tune.status, 0, tune.stderr)
  assert.equal(holdout.status, 0, holdout.stderr)

  const tuneIds = ids(tune.stdout)
  const holdoutIds = ids(holdout.stdout)
  assert.ok(tuneIds.length > 0, 'tune 池一道题都没有')
  assert.ok(holdoutIds.length > 0, 'holdout 池一道题都没有')
  assert.deepEqual(
    tuneIds.filter((id) => holdoutIds.includes(id)),
    [],
    '两池有重叠',
  )
  assert.deepEqual(
    [...tuneIds, ...holdoutIds].sort(),
    loadCases().map((entry) => entry.id).sort(),
    '两池的并集不是全集',
  )
  // 默认池就是 tune：不带 --partition 时列出来的必须与 --partition=tune 一致。
  const fallback = runEval(['--list'])
  assert.equal(fallback.status, 0, fallback.stderr)
  assert.deepEqual(ids(fallback.stdout), tuneIds, '默认池不是 tune')
})

test('refusal.e2e.mjs：--partition=holdout 不带 --release 退出 2，且 stderr 提到 --release', () => {
  const result = runEval(['--partition=holdout'])
  assert.equal(result.status, 2, `退出码应为 2，实际 ${result.status}；stderr：${result.stderr}`)
  assert.match(result.stderr, /--release/, `stderr 没提 --release：${result.stderr}`)
  assert.doesNotMatch(result.stderr, /MODEL_API_KEY/, '用法分支不该走到缺 key 那句')
})

test('refusal.e2e.mjs：没有 MODEL_API_KEY 时退出 2，不静默跳过', () => {
  const result = runEval([])
  assert.equal(result.status, 2, `退出码应为 2，实际 ${result.status}；stderr：${result.stderr}`)
  assert.match(result.stderr, /MODEL_API_KEY/, `stderr 没提 MODEL_API_KEY：${result.stderr}`)
  assert.doesNotMatch(result.stderr, /^PASS/m, '缺 key 时不许静默跳过')
})

test('modelPrompt：题面只有 goal/sources/unread', () => {
  const sample = loadCases()[0]
  const prompt = modelPrompt(sample)
  assert.deepEqual(Object.keys(prompt).sort(), ['goal', 'sources', 'unread'])
  assert.equal(prompt.goal, sample.goal)
  assert.deepEqual(prompt.sources, sample.sources)
  assert.deepEqual(prompt.unread, sample.unread ?? [])

  const serialized = JSON.stringify(prompt)
  for (const leak of ['expect', 'checks', 'note', 'partition', 'tuned']) {
    assert.ok(!serialized.includes(leak), `题面泄底：出现了 ${leak}`)
  }
})

test('selectCases：只按池选，非法池直接抛', () => {
  for (const partition of ['tune', 'holdout']) {
    const selected = selectCases({ partition })
    assert.ok(selected.length > 0, `${partition} 池是空的`)
    assert.ok(selected.every((entry) => entry.partition === partition))
  }
  assert.throws(() => selectCases({ partition: 'test' }), /partition/)
})
