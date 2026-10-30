// 发布决策的分支表：五种正常路径 + 两种拒绝。这些分支以前只靠「真发一次看看」。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bumpPatch,
  compareVersions,
  decideRelease,
  parseSubjects,
  prependChangelog,
  changelogSection,
  CHANGELOG_HEADER,
} from '../scripts/release-plan.mjs';

test('版本号比较按段比，不按字符串比', () => {
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0);
  assert.ok(compareVersions('v0.2.1', '0.2.1') === 0);
  assert.ok(compareVersions('1.0.0', '0.9.9') > 0);
  assert.throws(() => compareVersions('0.1', '0.1.0'));
});

test('补丁号只进最后一位', () => {
  assert.equal(bumpPatch('0.1.0'), '0.1.1');
  assert.equal(bumpPatch('v1.9.9'), '1.9.10');
  assert.equal(bumpPatch('2.0.0'), '2.0.1');
});

test('提交标题里剔掉空行和版本提交本身', () => {
  const text = ['feat: 面板首屏', '', 'release: v0.1.1', 'fix: 时区', '  '].join('\n');
  assert.deepEqual(parseSubjects(text), ['feat: 面板首屏', 'fix: 时区']);
});

test('首版用 package.json 的版本，不凭空加一', () => {
  const d = decideRelease({ current: '0.1.0', lastTag: null, subjects: ['init'] });
  assert.deepEqual([d.action, d.version], ['release', '0.1.0']);
});

test('有 tag 之后按补丁递增', () => {
  const d = decideRelease({ current: '0.1.0', lastTag: 'v0.1.0', subjects: ['fix: x'] });
  assert.deepEqual([d.action, d.version], ['release', '0.1.1']);
});

test('有人手动改了更大的版本号，就尊重它', () => {
  const d = decideRelease({ current: '0.3.0', lastTag: 'v0.2.4', subjects: ['feat: y'] });
  assert.deepEqual([d.action, d.version], ['release', '0.3.0']);
});

test('tag 之后没有新提交就跳过：空版本不是进展', () => {
  const d = decideRelease({ current: '0.1.0', lastTag: 'v0.1.0', subjects: [] });
  assert.deepEqual([d.action, d.reason], ['skip', 'no-commits']);
  assert.equal(d.version, undefined);
});

test('同名 tag 已存在时拒绝撞号', () => {
  const d = decideRelease({ current: '0.1.0', lastTag: 'v0.1.0', subjects: ['fix'], existingTags: ['v0.1.0', 'v0.1.1'] });
  assert.deepEqual([d.action, d.reason, d.version], ['skip', 'tag-exists', '0.1.1']);
});

test('tag 推出去了但 release 没发：只补发，不升版本', () => {
  const d = decideRelease({ current: '0.1.1', lastTag: 'v0.1.1', subjects: ['fix'], tagReleased: false });
  assert.deepEqual([d.action, d.version, d.reason], ['repair', '0.1.1', 'release-missing']);
});

test('CHANGELOG 只保留一个头部，最新的在最上面', () => {
  const first = prependChangelog('', changelogSection('0.1.0', '2026-10-30', ['init']));
  const second = prependChangelog(first, changelogSection('0.1.1', '2026-10-31', ['fix: a']));

  assert.equal(second.split('# CHANGELOG').length - 1, 1, '头部只出现一次');
  assert.ok(second.indexOf('v0.1.1') < second.indexOf('v0.1.0'), '新的在上面');
  assert.ok(second.includes('- fix: a') && second.includes('- init'), '旧条目没被吃掉');
  assert.ok(second.startsWith(CHANGELOG_HEADER.trim()));
});

test('空故事集写成「首个版本」，不留一个空段落', () => {
  const section = changelogSection('0.1.0', '2026-10-30', []);
  assert.ok(section.includes('无（首个版本）'));
});
