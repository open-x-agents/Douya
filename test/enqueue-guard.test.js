// 准入守卫的样例集：每条规则一个坏样例，外加一个全绿样例。
// 这些样例是守卫的规格说明 —— 规则改了先改这里，再改实现。
import test from 'node:test';
import assert from 'node:assert/strict';
import { judge } from '../scripts/enqueue-guard.mjs';

const SHA = 'a'.repeat(40);

function pull(overrides = {}) {
  return {
    number: 7,
    body: `Fixes #12\n\nRan: node --test test/*.test.js\ntip ${SHA}`,
    labels: [],
    headSha: SHA,
    files: ['src/client/panel.html'],
    checks: [{ name: 'tests', status: 'completed', conclusion: 'success', head_sha: SHA }],
    issueStates: { 12: 'open' },
    ...overrides,
  };
}

function codes(verdict) {
  return verdict.reasons.map((r) => r.code);
}

test('合格样例：无理由拒绝', () => {
  const verdict = judge(pull());
  assert.deepEqual(verdict.reasons, []);
  assert.equal(verdict.ok, true);
});

test('没有 Fixes #N：不知道该关哪个 issue', () => {
  const verdict = judge(pull({ body: 'Ran: node --test test/*.test.js' }));
  assert.ok(codes(verdict).includes('missing-issue-ref'));
  assert.equal(verdict.ok, false);
});

test('引用的 issue 已关闭', () => {
  const verdict = judge(pull({ issueStates: { 12: 'closed' } }));
  assert.ok(codes(verdict).includes('issue-not-open'));
});

test('没有 Ran: 行', () => {
  const verdict = judge(pull({ body: `Fixes #12\n\ntip ${SHA}` }));
  assert.ok(codes(verdict).includes('missing-ran'));
});

test('Ran: 后面空着也算没写', () => {
  const verdict = judge(pull({ body: `Fixes #12\n\nRan:\ntip ${SHA}` }));
  assert.ok(codes(verdict).includes('missing-ran'));
});

test('没有写 tip sha', () => {
  const verdict = judge(pull({ body: 'Fixes #12\n\nRan: node --test test/*.test.js' }));
  assert.ok(codes(verdict).includes('missing-tip-sha'));
});

test('写的 sha 不是当前 head', () => {
  const verdict = judge(pull({ body: `Fixes #12\n\nRan: node --test\ntip ${'b'.repeat(40)}` }));
  assert.ok(codes(verdict).includes('tip-sha-mismatch'));
});

test('head 上的 tests 是红的', () => {
  const verdict = judge(pull({ checks: [{ name: 'tests', status: 'completed', conclusion: 'failure', head_sha: SHA }] }));
  assert.ok(codes(verdict).includes('tests-not-green'));
});

test('head 上根本没有 tests 这个 check', () => {
  const verdict = judge(pull({ checks: [] }));
  assert.ok(codes(verdict).includes('tests-not-green'));
});

test('tests 还是 pending 不算绿', () => {
  const verdict = judge(pull({ checks: [{ name: 'tests', status: 'in_progress', conclusion: null, head_sha: SHA }] }));
  assert.ok(codes(verdict).includes('tests-not-green'));
});

test('带 hold 标签', () => {
  const verdict = judge(pull({ labels: ['hold'] }));
  assert.ok(codes(verdict).includes('held'));
});

test('改动文件清单是空的', () => {
  const verdict = judge(pull({ files: [] }));
  assert.ok(codes(verdict).includes('no-files'));
});

test('改了 src/host 却没更新架构文档、也没写豁免', () => {
  const verdict = judge(pull({ files: ['src/host/report.js'] }));
  assert.ok(codes(verdict).includes('docs-not-needed-missing'));
});

test('改了 src/host 但同 PR 改了架构文档：合格', () => {
  const verdict = judge(pull({ files: ['src/host/report.js', 'docs/architecture.md'] }));
  assert.equal(verdict.ok, true);
});

test('改了 src/host 并写了 Docs-not-needed: 理由：合格', () => {
  const verdict = judge(
    pull({ files: ['src/host/report.js'], body: `Fixes #12\n\nRan: node --test test/*.test.js\ntip ${SHA}\nDocs-not-needed: 只改了内部排序，架构没变` }),
  );
  assert.equal(verdict.ok, true);
});

test('空的 Docs-not-needed: 不算豁免', () => {
  const verdict = judge(
    pull({ files: ['index.js'], body: `Fixes #12\n\nRan: node --test test/*.test.js\ntip ${SHA}\nDocs-not-needed:` }),
  );
  assert.ok(codes(verdict).includes('docs-not-needed-missing'));
});
