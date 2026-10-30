// 没有 git 的机器上，提交就是一次 API 组包。这里钉的是「这次提交到底动了什么」：
// 路径必须仓库相对、不许重复，提交信息形状固定（它会进 squash 后的 commit message）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, treeEntries, cleanMessage } from '../scripts/commit-api.mjs';

test('默认提交到 main', () => {
  const options = parseArgs(['--message-file', '/tmp/m.txt', '/tmp/a=scripts/a.mjs']);
  assert.equal(options.branch, 'main');
  assert.equal(options.dryRun, false);
  assert.deepEqual(options.files, [{ local: '/tmp/a', path: 'scripts/a.mjs' }]);
});

test('不给 message-file 就拒绝', () => {
  assert.throws(() => parseArgs(['/tmp/a=scripts/a.mjs']), /message-file/);
});

test('一个文件都不给就拒绝', () => {
  assert.throws(() => parseArgs(['--message-file', '/tmp/m.txt']), /至少给一个/);
});

test('看不懂的参数不被静默忽略', () => {
  assert.throws(() => parseArgs(['--message-file', '/tmp/m.txt', '--frobnicate']), /看不懂的参数/);
});

test('tree entry 是 blob + 100644', () => {
  assert.deepEqual(treeEntries([{ path: 'docs/a.md', sha: 'abc' }]), [
    { path: 'docs/a.md', mode: '100644', type: 'blob', sha: 'abc' },
  ]);
});

test('同一个路径给两次：拒绝（那会让这次提交多动一个东西）', () => {
  assert.throws(() => treeEntries([{ path: 'a', sha: '1' }, { path: 'a', sha: '2' }]), /两次/);
});

test('绝对路径和 .. 都拒绝', () => {
  assert.throws(() => treeEntries([{ path: '/etc/passwd', sha: '1' }]), /相对路径/);
  assert.throws(() => treeEntries([{ path: '../outside', sha: '1' }]), /相对路径/);
});

test('提交信息清掉行尾空白、压掉多余空行、以单个换行结尾', () => {
  assert.equal(cleanMessage('subject   \n\n\n\nbody  \n'), 'subject\n\nbody\n');
});
