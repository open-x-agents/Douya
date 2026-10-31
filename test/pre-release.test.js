// 发版前的一致性检查：版本、tag、CHANGELOG 三者必须指同一件事；
// 干净安装则要证明 files 清单真的把该进包的东西打进了 tgz。
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

// files 清单只查仓库不够：用户拿到的是 tgz，不是源码树。
test('清单里写的目录在 tgz 里一个文件都没有时是红', () => {
  const problems = checkPackagedFiles({
    filesList: ['index.js', 'src/'],
    tgzEntries: ['package/index.js'],
    repoPaths: ['index.js', 'src/host/store.js'],
  });
  assert.ok(problems.some((p) => p.code === 'listed-not-in-tgz'));
  assert.ok(problems.some((p) => p.code === 'host-file-not-in-tgz'));
});

test('清单里写了仓库没有的路径时是红', () => {
  const problems = checkPackagedFiles({
    filesList: ['index.js', 'vendor/ds-bot/'],
    tgzEntries: ['package/index.js', 'package/vendor/ds-bot/index.js'],
    repoPaths: ['index.js'],
  });
  assert.ok(problems.some((p) => p.code === 'listed-missing-in-repo'));
});

test('src/host 下的文件没进 tgz 时是红', () => {
  const problems = checkPackagedFiles({
    filesList: ['src/'],
    tgzEntries: ['package/src/host/other.js'],
    repoPaths: ['src/host/panel.js', 'src/host/other.js'],
  });
  assert.ok(problems.some((p) => p.code === 'host-file-not-in-tgz' && p.message.includes('src/host/panel.js')));
});

test('清单、tgz、仓库三者一致时没有 problems', () => {
  assert.deepEqual(
    checkPackagedFiles({
      filesList: ['index.js', 'src/'],
      tgzEntries: ['package/package.json', 'package/index.js', 'package/src/host/store.js'],
      repoPaths: ['index.js', 'src/host/store.js'],
    }),
    [],
  );
});
