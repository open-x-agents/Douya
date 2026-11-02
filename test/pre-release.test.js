// 发版前的一致性检查：版本、tag、CHANGELOG 三者必须指同一件事；
// 还有干净安装时 files 清单与 tgz 的逐项核对。
// #97 第四刀起还多一件事：发版决定时要跑拒绝类评测的保留池（holdout），不能只跑调优池。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { REFUSAL_EVAL_ARGS, checkPackagedFiles, checkVersionConsistency } from '../scripts/pre-release.mjs';
import { CHANGELOG_HEADER } from '../scripts/release-plan.mjs';
import { selectCases } from '../acceptance-cases/refusals/cases.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const SAMPLE = `${CHANGELOG_HEADER}\n## v0.1.2 — 2026-10-31\n\n- fix: 时区\n`;

test('三者一致时没有问题', () => {
  assert.deepEqual(checkVersionConsistency({ version: '0.1.2', tag: 'v0.1.2', changelog: SAMPLE }), []);
});

test('tag 与 package.json 不一致', () => {
  const problems = checkVersionConsistency({ version: '0.1.2', tag: 'v0.1.3', changelog: SAMPLE });
  assert.deepEqual(problems.map((p) => p.code), ['tag-mismatch']);
});

test('CHANGELOG 顶部没有这个版本', () => {
  const problems = checkVersionConsistency({ version: '0.1.3', tag: 'v0.1.3', changelog: SAMPLE });
  assert.ok(problems.some((p) => p.code === 'changelog-missing-version'));
});

test('同一个版本号被发第二次', () => {
  const problems = checkVersionConsistency({ version: '0.1.2', tag: 'v0.1.2', changelog: SAMPLE, existingTags: ['v0.1.2'] });
  assert.ok(problems.some((p) => p.code === 'version-already-tagged'));
});

test('没有标准头部的 CHANGELOG 会被脚本覆盖，先报出来', () => {
  const problems = checkVersionConsistency({ version: '0.1.2', tag: 'v0.1.2', changelog: '## v0.1.2 — 2026-10-31\n\n- x\n' });
  assert.ok(problems.some((p) => p.code === 'changelog-header'));
});

test('版本号里的点不会被当成正则通配', () => {
  const problems = checkVersionConsistency({ version: '0.1.2', tag: 'v0.1.2', changelog: `${CHANGELOG_HEADER}\n## v0X1X2 — 2026-10-31\n` });
  assert.ok(problems.some((p) => p.code === 'changelog-missing-version'));
});

test('清单里写的目录在 tgz 里一个文件都没有时是红', () => {
  const problems = checkPackagedFiles({
    listed: ['src/'],
    repoFiles: ['src/host/a.js', 'src/host/b.js'],
    tgzFiles: ['package/index.js'],
  });
  const listed = problems.find((p) => p.code === 'listed-not-in-tgz');
  assert.ok(listed, '目录整个没进 tgz 时必须报 listed-not-in-tgz');
  assert.match(listed.message, /src\//);
});

test('清单里写了仓库没有的路径时是红', () => {
  const problems = checkPackagedFiles({
    listed: ['src/host/'],
    repoFiles: ['index.js'],
    tgzFiles: ['package/index.js'],
  });
  assert.deepEqual(problems.map((p) => p.code), ['listed-missing-in-repo']);
});

test('src/host 下的文件没进 tgz 时是红', () => {
  const problems = checkPackagedFiles({
    listed: ['index.js'],
    repoFiles: ['index.js', 'src/host/a.js', 'src/host/b.js'],
    tgzFiles: ['package/index.js'],
  });
  const lost = problems.find((p) => p.code === 'host-file-not-in-tgz');
  assert.ok(lost, 'src/host 的文件没进 tgz 时必须报 host-file-not-in-tgz');
  assert.match(lost.message, /src\/host\/a\.js/);
});

test('清单、tgz、仓库三者一致时没有 problems', () => {
  const problems = checkPackagedFiles({
    listed: ['index.js', 'src/'],
    repoFiles: ['index.js', 'src/host/a.js', 'src/host/b.js'],
    tgzFiles: ['package/package.json', 'package/index.js', 'package/src/host/a.js', 'package/src/host/b.js'],
  });
  assert.deepEqual(problems, []);
});

// A16（#97 第四刀）：发版闸接上拒绝类评测的保留池。
// 三件事一起钉 —— 参数常量、步骤真的被 main() 排进去、以及这组参数真的选出 holdout 全集。
// 只 grep 常量挡不住「常量在、步骤没接」和「接了但跑成调优池」这两种空转。
test('pre-release：发版时跑拒绝类保留池（--partition=holdout --release）', () => {
  assert.deepEqual(REFUSAL_EVAL_ARGS, ['test/e2e/refusal.e2e.mjs', '--partition=holdout', '--release']);

  const source = readFileSync(new URL('../scripts/pre-release.mjs', import.meta.url), 'utf8');
  const body = source.match(/function stepRefusalEval\(\) \{[\s\S]*?\n\}/);
  assert.ok(body, 'scripts/pre-release.mjs 里找不到 stepRefusalEval()');
  assert.match(body[0], /REFUSAL_EVAL_ARGS/, 'stepRefusalEval 必须直接用导出的 REFUSAL_EVAL_ARGS，防止两处漂移');
  assert.match(body[0], /MODEL_API_KEY/, '缺 MODEL_API_KEY 时必须报出来');
  assert.match(body[0], /process\.exitCode = 2/, '缺 MODEL_API_KEY 是环境问题（退出码 2），不是跳过');

  const main = source.match(/function main\(\) \{[\s\S]*?\n\}/);
  assert.ok(main, 'scripts/pre-release.mjs 里找不到 main()');
  assert.match(main[0], /stepRefusalEval\(\)/, 'main() 没把拒绝类评测排进发版步骤');

  // 真的按这组参数选题：脚本 + 池 = holdout 全集，且不碰调优池。
  const listed = spawnSync(process.execPath, [REFUSAL_EVAL_ARGS[0], '--list', '--partition=holdout'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(listed.status, 0, `--list 跑失败：${listed.stderr}`);
  const ids = listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  const holdout = selectCases({ partition: 'holdout' }).map((entry) => entry.id);
  assert.deepEqual([...ids].sort(), [...holdout].sort(), '发版闸选出来的不是保留池全集');
  assert.ok(ids.length > 0, '保留池一道题都没有，这道闸等于没跑');
  for (const id of selectCases({ partition: 'tune' }).map((entry) => entry.id)) {
    assert.ok(!ids.includes(id), `发版闸把调优池的 ${id} 也跑进来了：保留池被污染`);
  }
});

