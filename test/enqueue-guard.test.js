// 准入守卫的样例集：每条规则一个坏样例，外加一个全绿样例。
// 这些样例是守卫的规格说明 —— 规则改了先改这里，再改实现。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkStates,
  checksReady,
  judge,
  publishSummary,
  renderSummary,
  timeoutVerdict,
  waitForChecks,
} from '../scripts/enqueue-guard.mjs';

const SHA = 'a'.repeat(40);

function pull(overrides = {}) {
  return {
    number: 7,
    body: `Fixes #12\n\nRan: node --test test/*.test.js\ntip ${SHA}`,
    labels: [],
    headSha: SHA,
    files: ['src/client/panel.html'],
    checks: [
      { name: 'tests', status: 'completed', conclusion: 'success', head_sha: SHA },
      { name: 'merge-tree', status: 'completed', conclusion: 'success', head_sha: SHA },
    ],
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

// 规则 1 的两半：`Fixes/Closes/Resolves` 会关单，指向的 issue 必须 open；`Refs` 只是指针，
// 指向已关闭的父单也算数 —— 同一 issue 的后续刀就靠它（#90）。口径写在 docs/testing.md 的 L5 规则 1。
test('Refs #N 指向已关闭的父单：后续刀可以进队', () => {
  const verdict = judge(pull({ body: `Refs #23\n\nRan: node --test test/*.test.js\ntip ${SHA}`, issueStates: { 23: 'closed' } }));
  assert.deepEqual(verdict.reasons, []);
  assert.equal(verdict.ok, true);
});

test('只写 Refs #N（父单还开着）：不再算没对上 issue', () => {
  const verdict = judge(pull({ body: `Refs #12\n\nRan: node --test test/*.test.js\ntip ${SHA}` }));
  assert.ok(!codes(verdict).includes('missing-issue-ref'));
  assert.equal(verdict.ok, true);
});

test('Fixes #N 与 Refs #N 同时出现：关的是 open 单就合格（#89 的形态）', () => {
  const verdict = judge(
    pull({
      body: `Fixes #12\nRefs #23\n\nRan: node --test test/*.test.js\ntip ${SHA}`,
      issueStates: { 12: 'open', 23: 'closed' },
    }),
  );
  assert.deepEqual(codes(verdict), []);
  assert.equal(verdict.ok, true);
});

test('Fixes 命中已关闭的单：Refs 再指一个也救不了', () => {
  const verdict = judge(
    pull({
      body: `Fixes #12\nRefs #23\n\nRan: node --test test/*.test.js\ntip ${SHA}`,
      issueStates: { 12: 'closed', 23: 'closed' },
    }),
  );
  assert.deepEqual(codes(verdict), ['issue-not-open']);
});

test('Refs 后面没有 #N 不算引用：仍然 missing-issue-ref', () => {
  const verdict = judge(pull({ body: `Refs 父单\n\nRan: node --test test/*.test.js\ntip ${SHA}` }));
  assert.deepEqual(codes(verdict), ['missing-issue-ref']);
});

// 有意为之的弱化（#90 R1）：守卫不为 `Refs` 查状态，所以编号写错也放行。
// 这条用例把它钉住 —— 以后谁想加 issue-not-found，必须先改掉这个期望，不能悄悄改。
test('Refs 指向拿不到状态的编号：仍然合格（Refs 不查状态）', () => {
  const verdict = judge(pull({ body: `Refs #999\n\nRan: node --test test/*.test.js\ntip ${SHA}`, issueStates: {} }));
  assert.deepEqual(codes(verdict), []);
  assert.equal(verdict.ok, true);
});

test('没有 Ran: 行', () => {
  const verdict = judge(pull({ body: `Fixes #12\n\ntip ${SHA}` }));
  assert.ok(codes(verdict).includes('missing-ran'));
});

test('Ran: 后面空着也算没写', () => {
  const verdict = judge(pull({ body: `Fixes #12\n\nRan:\ntip ${SHA}` }));
  assert.ok(codes(verdict).includes('missing-ran'));
});

// 规则 2 的判据：`Ran:` 后面必须是**行首命令**（行首 `$ ` 或行首命令词），
// 散文里提到命令词不算，块边界之后也不往回找。口径写在 docs/testing.md 的 L5 规则 2。
test('Ran: 后面只有散文，不算跑了命令', () => {
  const verdict = judge(pull({ body: `Fixes #12\n\nRan: 看过了\ntip ${SHA}` }));
  assert.ok(codes(verdict).includes('missing-ran'));
});

test('Ran: none 不算跑了命令', () => {
  const verdict = judge(pull({ body: `Fixes #12\n\nRan: none\ntip ${SHA}` }));
  assert.ok(codes(verdict).includes('missing-ran'));
});

test('Ran: 行里散文提到 git 不算命令', () => {
  const verdict = judge(pull({ body: `Fixes #12\n\nRan: 我用 git 看过了\ntip ${SHA}` }));
  assert.ok(codes(verdict).includes('missing-ran'));
});

test('Ran: 下一行代码块里的命令算数', () => {
  const verdict = judge(pull({ body: `Fixes #12\n\nRan:\n\`\`\`sh\n$ node --test test/*.test.js\n\`\`\`\ntip ${SHA}` }));
  assert.ok(!codes(verdict).includes('missing-ran'));
  assert.equal(verdict.ok, true);
});

test('Ran: 到下一个空行就停，不往下找命令', () => {
  const verdict = judge(pull({ body: `Fixes #12\n\nRan: 看过了\n\n$ node --test test/*.test.js\ntip ${SHA}` }));
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

const GREEN_MERGE_TREE = { name: 'merge-tree', status: 'completed', conclusion: 'success', head_sha: SHA };

test('head 上的 tests 是红的', () => {
  const verdict = judge(pull({ checks: [{ name: 'tests', status: 'completed', conclusion: 'failure', head_sha: SHA }, GREEN_MERGE_TREE] }));
  assert.ok(codes(verdict).includes('tests-not-green'));
  assert.equal(verdict.ok, false);
});

test('head 上根本没有 tests 这个 check', () => {
  const verdict = judge(pull({ checks: [] }));
  assert.ok(codes(verdict).includes('tests-not-green'));
});

test('tests 还是 pending 不算绿', () => {
  const verdict = judge(pull({ checks: [{ name: 'tests', status: 'in_progress', conclusion: null, head_sha: SHA }, GREEN_MERGE_TREE] }));
  assert.ok(codes(verdict).includes('tests-not-green'));
});

test('自己绿、但 head 上没有 merge-tree：只证明了「这个提交自己绿」', () => {
  const verdict = judge(pull({ checks: [{ name: 'tests', status: 'completed', conclusion: 'success', head_sha: SHA }] }));
  assert.ok(codes(verdict).includes('merge-tree-not-green'));
  assert.equal(verdict.ok, false);
});

test('tests 绿、merge-tree 红：合到 main 上破了', () => {
  const verdict = judge(
    pull({
      checks: [
        { name: 'tests', status: 'completed', conclusion: 'success', head_sha: SHA },
        { name: 'merge-tree', status: 'completed', conclusion: 'failure', head_sha: SHA },
      ],
    }),
  );
  assert.deepEqual(codes(verdict), ['merge-tree-not-green']);
});

test('merge-tree 还在跑不算绿', () => {
  const verdict = judge(
    pull({
      checks: [
        { name: 'tests', status: 'completed', conclusion: 'success', head_sha: SHA },
        { name: 'merge-tree', status: 'in_progress', conclusion: null, head_sha: SHA },
      ],
    }),
  );
  assert.ok(codes(verdict).includes('merge-tree-not-green'));
});

test('merge-tree 是别的 tip 上的绿，不算', () => {
  const verdict = judge(
    pull({
      checks: [
        { name: 'tests', status: 'completed', conclusion: 'success', head_sha: SHA },
        { name: 'merge-tree', status: 'completed', conclusion: 'success', head_sha: 'c'.repeat(40) },
      ],
    }),
  );
  assert.ok(codes(verdict).includes('merge-tree-not-green'));
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

test('tests 的绿比 main 的 tip 早不算陈旧：main 前进不改变 head 那棵树', () => {
  const verdict = judge(
    pull({
      mainPushedAt: '2026-10-30T12:00:00Z',
      checks: [
        { name: 'tests', status: 'completed', conclusion: 'success', head_sha: SHA, completed_at: '2026-10-30T11:00:00Z' },
        { name: 'merge-tree', status: 'completed', conclusion: 'success', head_sha: SHA, completed_at: '2026-10-30T12:30:00Z' },
      ],
    }),
  );
  assert.deepEqual(codes(verdict), []);
  assert.equal(verdict.ok, true);
});

test('merge-tree 的绿比 main 的 tip 早：这个绿说的不是现在的 main', () => {
  const verdict = judge(
    pull({
      mainPushedAt: '2026-10-30T12:00:00Z',
      checks: [
        { name: 'tests', status: 'completed', conclusion: 'success', head_sha: SHA, completed_at: '2026-10-30T12:30:00Z' },
        { name: 'merge-tree', status: 'completed', conclusion: 'success', head_sha: SHA, completed_at: '2026-10-30T11:00:00Z' },
      ],
    }),
  );
  assert.deepEqual(codes(verdict), ['merge-tree-stale']);
});

test('重跑过之后绿就新鲜了：合格', () => {
  const verdict = judge(
    pull({
      mainPushedAt: '2026-10-30T12:00:00Z',
      checks: [
        { name: 'tests', status: 'completed', conclusion: 'success', head_sha: SHA, completed_at: '2026-10-30T12:05:00Z' },
        { name: 'merge-tree', status: 'completed', conclusion: 'success', head_sha: SHA, completed_at: '2026-10-30T12:06:00Z' },
      ],
    }),
  );
  assert.equal(verdict.ok, true);
});

test('不知道 main 的 tip（没取到）：不因此拒绝', () => {
  const verdict = judge(pull({ mainPushedAt: null }));
  assert.equal(verdict.ok, true);
});

// 下面是「同批启动时不能抢跑」那一半：守卫先等 tests/merge-tree 都 completed，再交给 judge。

const PENDING_TESTS = { name: 'tests', status: 'in_progress', conclusion: null, head_sha: SHA };

function green(name, extra = {}) {
  return { name, status: 'completed', conclusion: 'success', head_sha: SHA, ...extra };
}

test('checkStates（wait）：一条 pending、一条 missing 都还没跑齐', () => {
  assert.deepEqual(checkStates([PENDING_TESTS], SHA), { tests: 'pending', 'merge-tree': 'missing' });
  assert.equal(checksReady([PENDING_TESTS], SHA), false);
});

test('checksReady：两条 completed 才算齐；红也算「跑完了」，由 judge 说理由', () => {
  const checks = [green('tests'), { name: 'merge-tree', status: 'completed', conclusion: 'failure', head_sha: SHA }];
  assert.deepEqual(checkStates(checks, SHA), { tests: 'completed', 'merge-tree': 'completed' });
  assert.equal(checksReady(checks, SHA), true);
});

test('checksReady：别的 tip 上的绿不算', () => {
  const other = 'b'.repeat(40);
  const checks = [green('tests', { head_sha: other }), green('merge-tree', { head_sha: other })];
  assert.equal(checksReady(checks, SHA), false);
});

test('checksReady：Rerun 还在跑时，旧的那条绿不能盖住它', () => {
  const checks = [
    green('tests', { completed_at: '2026-10-30T11:00:00Z' }),
    { name: 'tests', status: 'in_progress', conclusion: null, head_sha: SHA, started_at: '2026-10-30T12:00:00Z' },
    green('merge-tree'),
  ];
  assert.deepEqual(checkStates(checks, SHA), { tests: 'pending', 'merge-tree': 'completed' });
});

test('waitForChecks：已经齐了就不再等', async () => {
  let slept = 0;
  const wait = await waitForChecks({
    headSha: SHA,
    fetchChecks: async () => [green('tests'), green('merge-tree')],
    now: () => 0,
    sleep: async (ms) => {
      slept += ms;
    },
    timeoutMs: 60000,
    pollMs: 15000,
  });
  assert.equal(wait.ready, true);
  assert.equal(wait.polls, 1);
  assert.equal(slept, 0);
});

test('waitForChecks：tests 还没跑完时轮询，直到它 completed 才返回', async () => {
  let now = 0;
  let slept = 0;
  const snapshots = [
    [PENDING_TESTS],
    [green('tests', { completed_at: '2026-10-30T12:00:00Z' }), green('merge-tree')],
  ];
  let i = 0;
  const wait = await waitForChecks({
    headSha: SHA,
    fetchChecks: async () => snapshots[Math.min(i++, snapshots.length - 1)],
    now: () => now,
    sleep: async (ms) => {
      slept += ms;
      now += ms;
    },
    timeoutMs: 60000,
    pollMs: 15000,
  });
  assert.equal(wait.ready, true);
  assert.equal(wait.polls, 2);
  assert.deepEqual(wait.states, { tests: 'completed', 'merge-tree': 'completed' });
  assert.equal(slept, 15000);
});

test('waitForChecks：一直不 completed 就到点收手，不无限等', async () => {
  let now = 0;
  const sleepCalls = [];
  const wait = await waitForChecks({
    headSha: SHA,
    fetchChecks: async () => [PENDING_TESTS],
    now: () => now,
    sleep: async (ms) => {
      sleepCalls.push(ms);
      now += ms;
    },
    timeoutMs: 30000,
    pollMs: 10000,
  });
  assert.equal(wait.ready, false);
  assert.equal(wait.polls, 4);
  assert.deepEqual(sleepCalls, [10000, 10000, 10000]);
});

test('timeoutVerdict：报「没结论」，不是把 in_progress 判成红', () => {
  const verdict = timeoutVerdict({ number: 7, states: { tests: 'pending', 'merge-tree': 'missing' }, waitedMs: 30000 });
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.reasons.map((r) => r.code), ['checks-timeout']);
  assert.match(verdict.reasons[0].message, /`tests`=pending/);
  assert.match(verdict.reasons[0].message, /`merge-tree`=missing/);
  assert.match(verdict.reasons[0].message, /30 秒/);
});

test('renderSummary：拒绝时每条理由都带 code 和说明', () => {
  const verdict = { ok: false, reasons: [{ code: 'tests-not-green', message: 'head 上 `tests` 不是绿' }] };
  const text = renderSummary(7, verdict);
  assert.match(text, /拒绝：#7/);
  assert.match(text, /tests-not-green/);
  assert.match(text, /head 上 `tests` 不是绿/);
  assert.match(renderSummary(7, { ok: true, reasons: [] }), /准入通过：#7/);
});

test('publishSummary：把理由写进 step summary 和守卫那条 check 的 output summary', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-summary-'));
  const file = join(dir, 'step-summary.md');
  writeFileSync(file, '');
  const patches = [];
  const apiFn = async (method, path, body) => {
    if (method === 'GET') return { check_runs: [{ id: 99, name: 'guard', status: 'in_progress' }] };
    patches.push({ path, body });
    return {};
  };
  const verdict = { ok: false, reasons: [{ code: 'merge-tree-stale', message: 'merge-tree 的绿比 main 早' }] };
  const result = await publishSummary({ number: 7, verdict, headSha: SHA, env: { GITHUB_STEP_SUMMARY: file }, apiFn });
  assert.deepEqual(result, { stepSummary: true, checkRun: true });
  assert.deepEqual(patches, [
    { path: '/check-runs/99', body: { output: { title: '准入拒绝：#7（1 条理由）', summary: readFileSync(file, 'utf8') } } },
  ]);
  assert.match(readFileSync(file, 'utf8'), /merge-tree-stale/);
});

test('publishSummary：不改上一轮已经 completed 的守卫 check', async () => {
  const patches = [];
  const apiFn = async (method, path, body) => {
    if (method === 'GET') return { check_runs: [{ id: 1, name: 'guard', status: 'completed' }] };
    patches.push({ path, body });
    return {};
  };
  const result = await publishSummary({ number: 7, verdict: { ok: true, reasons: [] }, headSha: SHA, env: {}, apiFn });
  assert.deepEqual(result, { stepSummary: false, checkRun: false });
  assert.deepEqual(patches, []);
});
