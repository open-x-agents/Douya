// 发版前的一致性检查：版本、tag、CHANGELOG 三者必须指同一件事；
// 还有干净安装时 files 清单与 tgz 的逐项核对。
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPackagedFiles, checkVersionConsistency } from '../scripts/pre-release.mjs';
import { CHANGELOG_HEADER } from '../scripts/release-plan.mjs';

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
