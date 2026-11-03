// 撞号闸（#23 第二刀）的两件事：判据本身，以及 CLI 三态。
//
// 判据写错方向是这道闸唯一的真风险，所以前两条用例专防两种错写法：
// 「version ∈ tags 就红」会让所有 PR 变红；「拿 base 比 merged」会放过 issue 点名的那个形态。
// CLI 走 execFileSync（与 test/ci-test-command.test.js 同一个做法）：本机没有 git，
// 所以一律显式传 --tags=，git 那条分支只能在 CI 上验证。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkVersionTagCollision } from '../scripts/merge-tree-gate.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/merge-tree-gate.mjs', import.meta.url));

function cli(...args) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, stdout };
  } catch (error) {
    return { status: error.status, stdout: String(error.stdout || ''), stderr: String(error.stderr || '') };
  }
}

test('没动版本号时不算撞号，即使这个号已经是 tag', () => {
  // 发版之后 main 的版本号天然等于最新 tag；这里红了就等于每个 PR 都红。
  assert.deepEqual(checkVersionTagCollision({ mergeBaseVersion: '0.1.0', headVersion: '0.1.0', tags: ['v0.1.0'] }), []);
});

test('换了一个还没发过的号是绿的', () => {
  const problems = checkVersionTagCollision({ mergeBaseVersion: '0.1.0', headVersion: '0.1.2', tags: ['v0.1.0', 'v0.1.1'] });
  assert.deepEqual(problems, []);
});

test('换成已经发过的号是红的', () => {
  // issue 点名的形态：PR 从 0.1.0 切出、改成 0.1.1，而 v0.1.1 已经打过了。
  const problems = checkVersionTagCollision({ mergeBaseVersion: '0.1.0', headVersion: '0.1.1', tags: ['v0.1.0', 'v0.1.1'] });
  assert.deepEqual(problems.map((problem) => problem.code), ['version-already-tagged']);
});

test('tag 写不写 v 前缀都能认出来', () => {
  assert.deepEqual(
    checkVersionTagCollision({ mergeBaseVersion: '0.1.0', headVersion: '0.1.1', tags: ['0.1.1'] }).map((p) => p.code),
    ['version-already-tagged'],
  );
  assert.deepEqual(
    checkVersionTagCollision({ mergeBaseVersion: '0.1.0', headVersion: 'v0.1.1', tags: ['v0.1.1'] }).map((p) => p.code),
    ['version-already-tagged'],
  );
});

test('只报撞号，不把 CHANGELOG 缺段也报出来（那是 L7 的事）', () => {
  // 同一条规则在 L7 里也查 CHANGELOG；L6 上带出那一条会让每个 PR 都红，
  // 因为合并时还没人给这个号写 CHANGELOG 段。
  const problems = checkVersionTagCollision({ mergeBaseVersion: '0.1.0', headVersion: '0.1.1', tags: ['v0.1.1'] });
  assert.deepEqual(problems.map((problem) => problem.code), ['version-already-tagged']);
  assert.deepEqual(checkVersionTagCollision({ mergeBaseVersion: '0.1.0', headVersion: '0.1.1', tags: ['v0.1.0'] }), []);
});

test('CLI：撞号 exit 1，不撞 exit 0，缺参数 exit 2', () => {
  const red = cli('--merge-base-version=0.1.0', '--head-version=0.1.1', '--tags=v0.1.0,v0.1.1');
  assert.equal(red.status, 1, `撞号必须 exit 1：${red.stdout}${red.stderr}`);
  assert.match(red.stdout, /version-already-tagged/);

  const green = cli('--merge-base-version=0.1.0', '--head-version=0.1.0', '--tags=v0.1.0');
  assert.equal(green.status, 0, `没动版本号必须 exit 0：${green.stdout}${green.stderr}`);
  // tag 列表要出现在日志里：读不到 tag 时这道闸恒绿，A9 就是看这行是不是真的有东西。
  assert.match(green.stdout, /tags: v0\.1\.0/);

  const missing = cli('--head-version=0.1.1', '--tags=v0.1.0');
  assert.equal(missing.status, 2, `缺 --merge-base-version 必须是用法错误（exit 2）：${missing.stdout}${missing.stderr}`);
});
