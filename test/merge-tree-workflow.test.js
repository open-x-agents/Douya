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

// 「红了」还不够：只 exit 1 的 run，人还得自己翻出是哪个文件合不上。
// 这一行被删掉时上面那条测试照样绿 —— 所以单独钉一次（#23 A7）。
test('合不上时把冲突文件名字打出来', () => {
  const line = "git diff --name-only --diff-filter=U | sed 's/^/冲突文件: /'";
  assert.ok(workflow.includes(line), '冲突分支里少了打冲突文件名的那一行：红的时候得指得出是哪个文件');

  // 必须落在「合不上」这个分支内部、且在建 exit 1 之前：写在 else 里就是死代码。
  const start = workflow.indexOf('if ! git merge');
  const exitAt = workflow.indexOf('exit 1', start);
  const conflict = workflow.slice(start, exitAt + 'exit 1'.length);
  assert.ok(conflict.includes(line), '那一行不在「合不上」分支里');
  assert.ok(conflict.indexOf(line) < conflict.indexOf('exit 1'), '那一行必须在 exit 1 之前跑，否则永远不会执行');
});

// 两个 PR 各自把版本号改成同一个号时 git 判为「同一处改动」，干净合上：
// 冲突检测与单测都看不见，只有对着已存在的 tag 才拦得住。这条钉的是闸接在了合并树上（#23 A6）。
test('合并结果里的版本号要对着现有 tag 查撞号', () => {
  // 没有 tag 列表，撞号判断对任何 PR 恒绿 —— 所以 checkout 必须带上 tag。
  assert.match(workflow, /fetch-tags: true/);

  // 两头版本在 merge step 内部、git merge 之前取：合完之后 HEAD 已经是合并结果。
  const mergeStep = workflow.slice(workflow.indexOf('- name: 把 PR head 合到 main 上'), workflow.indexOf('版本号不能撞已有的 tag'));
  assert.match(mergeStep, /git merge-base HEAD refs\/remotes\/pr-head/);
  assert.match(mergeStep, /merge_base_version=/);
  assert.match(mergeStep, /head_version=/);
  assert.ok(mergeStep.indexOf('git merge-base') < mergeStep.indexOf('git merge --no-ff'), '版本号必须在合并之前取');
  assert.ok(mergeStep.indexOf('merge_base_version=') < mergeStep.indexOf('git merge --no-ff'), 'merge_base_version 必须在合并之前写进 $GITHUB_OUTPUT');

  // 闸在合并之后、L0 之前，读的是 merge step 的输出。
  const gateAt = workflow.indexOf('- name: 版本号不能撞已有的 tag');
  const unitAt = workflow.indexOf('- name: 在合并结果上跑单元测试');
  assert.ok(gateAt !== -1 && unitAt !== -1 && gateAt < unitAt, '撞号 step 必须排在合并之后、单测之前');
  const gate = workflow.slice(gateAt, unitAt);
  assert.match(gate, /node scripts\/merge-tree-gate\.mjs --merge-base-version=/);
  assert.match(gate, /steps\.merge\.outputs\.merge_base_version/);
  assert.match(gate, /steps\.merge\.outputs\.head_version/);
  // 写成 `run: node --test` 会顶掉 ci-test-command 认定的那条命令（它取文件里第一个 node --test 行）。
  assert.doesNotMatch(gate, /node --test/, '闸这一行不能以 node --test 开头');
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
