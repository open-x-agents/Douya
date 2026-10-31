// pr-guard.yml 的骨架契约：守卫和 tests/merge-tree 由同一个事件同批启动，
// 所以它必须先等这两条 check 都 completed 再判 —— 不能抢跑，也不能用固定等待猜时间。
// 另一个容易漏的点是拒绝理由要落在人看得见的地方（check 的 output summary）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../.github/workflows/pr-guard.yml', import.meta.url), 'utf8');

test('在 pull_request 上触发', () => {
  assert.match(workflow, /^on:\n {2}pull_request:/m);
});

test('守卫从 base 的 sha 取脚本，不在 PR head 上跑', () => {
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
});

test('带超时轮询：等待窗口与轮询间隔是 env，不是猜时间的固定等待', () => {
  assert.match(workflow, /GUARD_CHECK_TIMEOUT_MS/);
  assert.match(workflow, /GUARD_POLL_INTERVAL_MS/);
  assert.doesNotMatch(workflow, /\bsleep\b/i);
});

test('job 的 timeout 比等待窗口长：脚本自己收手时 job 还没被杀', () => {
  const jobTimeout = Number((workflow.match(/timeout-minutes: (\d+)/) || [])[1]);
  const waitWindow = Number((workflow.match(/GUARD_CHECK_TIMEOUT_MS: '(\d+)'/) || [])[1]);
  assert.equal(jobTimeout, 20);
  assert.equal(waitWindow, 15 * 60 * 1000);
  assert.ok(jobTimeout * 60000 > waitWindow, 'job timeout 要大于等待窗口');
});

test('拒绝理由能写进 check 的 output summary：有 checks: write', () => {
  assert.match(workflow, /checks: write/);
});

test('先等齐再评估：等的是这个 PR，跑的仍是那个守卫脚本', () => {
  assert.match(workflow, /node scripts\/enqueue-guard\.mjs --pr \$\{\{ github\.event\.pull_request\.number \}\}/);
});
