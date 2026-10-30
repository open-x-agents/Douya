// 探针：这条测试在旧 main（7013f17c）上绿 —— 那时准入守卫只看 `tests`。
// 合到已经要求 `merge-tree` 的 main 上就红：守卫会以 merge-tree-not-green 拒绝。
// 这就是「各自绿、合起来破」，也是 L6 唯一值得存在的理由。
import test from 'node:test';
import assert from 'node:assert/strict';
import { judge } from '../scripts/enqueue-guard.mjs';

const SHA = 'e'.repeat(40);

test('只有 tests 绿的 PR 就可以排队', () => {
  const verdict = judge({
    number: 26,
    body: `Fixes #23\n\nRan: node --test test/*.test.js\ntip ${SHA}`,
    labels: [],
    headSha: SHA,
    files: ['docs/testing.md'],
    checks: [{ name: 'tests', status: 'completed', conclusion: 'success', head_sha: SHA }],
    issueStates: { 23: 'open' },
  });
  assert.equal(verdict.ok, true);
});
