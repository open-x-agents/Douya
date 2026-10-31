// merge-tree.yml 的逻辑住在 YAML 里，没法当纯函数测，所以把它的骨架钉成契约：
// 起点要是 base 而不是 head、真做一次合并、合不上就红、在合并结果上跑同一条测试命令。
// 少任何一条，这一层就会退化成「又一个自己绿」—— 那正是它存在的理由的反面。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { judge, REQUIRED_CHECKS } from '../scripts/enqueue-guard.mjs';

const workflow = readFileSync(new URL('../.github/workflows/merge-tree.yml', import.meta.url), 'utf8');
const sha = 'd'.repeat(40);

test('在 pull_request 上触发', () => {
  assert.match(workflow, /^on:\n {2}pull_request:/m);
});

test('起点是 base 的 sha；手动入口固定当前 main', () => {
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.base\.sha/);
  assert.match(workflow, /\|\| 'main' \}\}/);
});

test('有 workflow_dispatch(pr) 入口：能对当前 main 重跑', () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /inputs:\n\s+pr:/);
  assert.match(workflow, /github\.event\.inputs\.pr/);
});

test('手动入口把结论写成 PR head 上的 merge-tree check（守卫才看得见）', () => {
  assert.match(workflow, /checks\.create/);
  assert.match(workflow, /name: 'merge-tree'/);
  assert.match(workflow, /head_sha: process\.env\.HEAD_SHA/);
  assert.match(workflow, /if: always\(\)/);
  assert.match(workflow, /checks: write/);
});

test('手动入口的结论按合并与测试两步的真实结果给', () => {
  assert.match(workflow, /steps\.merge\.outcome/);
  assert.match(workflow, /steps\.unit\.outcome/);
});

test('用 refs/pull/<n>/head 取 head：fork 的 PR 也能取到', () => {
  assert.match(workflow, /refs\/pull\/\$PR\/head/);
});

test('真的做一次合并，而不是只跑一遍 head', () => {
  assert.match(workflow, /git merge --no-ff/);
});

test('合不上就红：冲突直接 exit 1，没有 continue-on-error', () => {
  assert.match(workflow, /exit 1/);
  assert.doesNotMatch(workflow, /continue-on-error/);
  assert.doesNotMatch(workflow, /\|\| true\n\s*run:/);
});

test('在合并结果上跑和 tests.yml 同一条命令', () => {
  assert.match(workflow, /test\/\*\*\/\*\.test\.js/);
});

test('准入守卫把 merge-tree 当成资格的一部分', () => {
  assert.ok(REQUIRED_CHECKS.includes('tests'));
  assert.ok(REQUIRED_CHECKS.includes('merge-tree'));
  const verdict = judge({
    number: 1,
    body: `Fixes #23\n\nRan: node --test test/*.test.js\ntip ${sha}`,
    labels: [],
    headSha: sha,
    files: ['docs/testing.md'],
    checks: [{ name: 'tests', status: 'completed', conclusion: 'success', head_sha: sha }],
    issueStates: { 23: 'open' },
  });
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.reasons.map((r) => r.code), ['merge-tree-not-green']);
});
