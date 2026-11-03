// 这道闸只钉一件事：CI（tests.yml / merge-tree.yml）和发版预检（pre-release.mjs）一定跑到
// test/ 与 acceptance-cases/ 每一层子目录里的 *.test.js。
//
// 背景（#77）：命令写成 test/*.test.js 时只有顶层文件会被跑到，子目录里的测试在闸门里零覆盖；
// 而且 glob 写错时 node 会跑 0 条并 exit 0，绿得没有内容。所以这里既比对命令串，
// 也真的拿「磁盘上遍历出来的文件集合」和「glob 匹配出来的集合」求差 —— 只 grep 命令串挡不住 0 条。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { glob, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { UNIT_TEST_ARGS } from '../scripts/pre-release.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const GLOBS = ['test/**/*.test.js', 'acceptance-cases/**/*.test.js'];
const E2E = ['test/e2e/real-model.e2e.mjs', 'test/e2e/real-model-checks.mjs', 'test/e2e/stub-model.mjs'];

// 去掉引号再比：CI 里写 `'test/**/*.test.js'` 是给 shell 的引号；
// pre-release 传给 node 的是 argv，引号会变成路径的一部分。两边语义相同，去掉引号才是同一条命令。
function normalize(command) {
  return String(command).replace(/['"]/g, '').replace(/\s+/g, ' ').trim();
}

function workflowRunLine(workflowPath) {
  const text = readFileSync(new URL(`../${workflowPath}`, import.meta.url), 'utf8');
  const match = text.match(/run:\s*(node --test[^\n]*)/);
  assert.ok(match, `${workflowPath} 里找不到 node --test 命令`);
  return match[1];
}

async function matchedFiles() {
  const hit = new Set();
  for (const pattern of GLOBS) {
    for await (const file of glob(pattern, { cwd: ROOT })) hit.add(file);
  }
  return hit;
}

const canonical = normalize(['node', ...UNIT_TEST_ARGS].join(' '));

test('the four places run one and the same node --test command', () => {
  const places = [
    ['.github/workflows/tests.yml', () => workflowRunLine('.github/workflows/tests.yml')],
    ['.github/workflows/merge-tree.yml', () => workflowRunLine('.github/workflows/merge-tree.yml')],
    ['package.json', () => JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts.test],
    ['scripts/pre-release.mjs', () => ['node', ...UNIT_TEST_ARGS].join(' ')],
  ];

  for (const [where, read] of places) {
    const actual = normalize(read());
    assert.equal(actual, canonical, `${where} 的 node --test 命令和 CI 不是同一条：${actual}`);
    assert.ok(actual.includes('test/**/*.test.js'), `${where} 没有递归 glob test/**/*.test.js：${actual}`);
    assert.ok(!actual.includes('test/*.test.js'), `${where} 退回扁平 glob test/*.test.js，子目录测试会漏：${actual}`);
  }
});

test('the command globs recursively, not just the top level of test/', () => {
  assert.equal(UNIT_TEST_ARGS[1], 'test/**/*.test.js');
  assert.equal(UNIT_TEST_ARGS[2], 'acceptance-cases/**/*.test.js');
  assert.ok(!UNIT_TEST_ARGS.includes('test/*.test.js'), 'UNIT_TEST_ARGS 里出现了扁平 glob test/*.test.js');
});

test('scripts/pre-release.mjs hands node the same args as CI', () => {
  assert.deepEqual(UNIT_TEST_ARGS, ['--test', 'test/**/*.test.js', 'acceptance-cases/**/*.test.js']);
  for (const arg of UNIT_TEST_ARGS) {
    assert.ok(!/['"]/.test(arg), `argv 元素里不能带引号（会被 node 当成字面路径，跑 0 条还 exit 0）：${arg}`);
  }

  const source = readFileSync(new URL('../scripts/pre-release.mjs', import.meta.url), 'utf8');
  const body = source.match(/function stepUnitTests\(\) \{[\s\S]*?\n\}/);
  assert.ok(body, 'scripts/pre-release.mjs 里找不到 stepUnitTests()');
  assert.match(body[0], /UNIT_TEST_ARGS/, 'stepUnitTests 必须直接用导出的 UNIT_TEST_ARGS，防止两处漂移');
  assert.ok(!body[0].includes("'test/*.test.js'"), 'stepUnitTests 里又出现了扁平 glob test/*.test.js');
});

test('every *.test.js under test/ is matched by the CI glob, subdirectories included', async () => {
  const onDisk = [];
  for (const dir of ['test', 'acceptance-cases']) {
    for (const file of await readdir(new URL(`../${dir}`, import.meta.url), { recursive: true })) {
      if (String(file).endsWith('.test.js')) onDisk.push(`${dir}/${file}`);
    }
  }

  const hit = await matchedFiles();
  assert.ok(onDisk.length > 0, '磁盘上一个 *.test.js 都没找到，这条断言没有意义');
  assert.ok(hit.size > 0, 'CI glob 一个文件都没匹配到（glob 写错时 node 会跑 0 条还 exit 0）');

  const missed = onDisk.filter((file) => !hit.has(file)).sort();
  assert.deepEqual(missed, [], `这些测试不会被 CI 跑到：${missed.join(', ')}`);
  assert.equal(hit.size, onDisk.length, 'glob 匹配到的文件数必须等于磁盘上的测试文件数');
});

test('the CI glob never picks up the e2e files under test/e2e', async () => {
  const hit = await matchedFiles();
  for (const file of E2E) {
    assert.ok(!hit.has(file), `${file} 被 CI glob 带进来了（它要 MODEL_API_KEY，故意不进 L0）`);
  }

  const mjs = [...hit].filter((file) => file.endsWith('.mjs')).sort();
  assert.deepEqual(mjs, [], `CI glob 只该匹配 *.test.js，却匹配到了 .mjs：${mjs.join(', ')}`);
});
