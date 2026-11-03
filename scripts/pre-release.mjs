// pre-release 预检：发版之前必须全绿的五项。
//
// 一个版本可以「测试全绿但装不起来」，也可以「装得起来但版本号、CHANGELOG、tag 三者不自洽」，
// 还可以「什么都对，但模型开始编来源」，更糟的是「面板没编，但模型开始替用户发消息 / 下单 / 删东西」。
// 这四类都不该发出去。
//
// 退出码：0 全过，1 有一项不过，2 环境缺东西（例如缺 MODEL_API_KEY）。
// 每一项都是独立的 step，失败时只有那一项红，人一眼看得出是哪一类。

import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { CHANGELOG_HEADER, trimVersion } from './release-plan.mjs';

const REPO_ROOT = resolve(process.cwd());

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd: REPO_ROOT, ...options }).trim();
}

function report(title, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${title}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

/**
 * 版本、CHANGELOG、tag 三者必须指同一件事。
 * 这是纯函数，好让 test/pre-release.test.js 把三种不一致各测一次。
 *
 * @param {object} input
 * @param {string} input.version       package.json 的版本
 * @param {string|null} input.tag      要打的 tag（没有就是 null，首版）
 * @param {string} input.changelog     CHANGELOG.md 文本
 * @param {string[]} [input.existingTags]
 * @returns {Array<{code: string, message: string}>}
 */
export function checkVersionConsistency({ version, tag = null, changelog = '', existingTags = [] }) {
  const problems = [];
  const wanted = trimVersion(version);

  if (tag && trimVersion(tag) !== wanted) {
    problems.push({ code: 'tag-mismatch', message: `package.json 是 ${wanted}，要打的 tag 是 ${trimVersion(tag)}` });
  }

  if (!new RegExp(`^## v${wanted.replace(/\./g, '\\.')}\\b`, 'm').test(String(changelog))) {
    problems.push({ code: 'changelog-missing-version', message: `CHANGELOG 顶部没有 v${wanted} 那一段` });
  }

  if (existingTags.map(trimVersion).includes(wanted)) {
    problems.push({ code: 'version-already-tagged', message: `v${wanted} 已经是一个 tag：不能把同一个号发两次` });
  }

  if (String(changelog).trim() && !String(changelog).startsWith('# CHANGELOG')) {
    problems.push({ code: 'changelog-header', message: 'CHANGELOG 没有标准头部，说明它可能被别的流程改过' });
  }

  return problems;
}

// 1. 单元测试：跟 tests.yml / merge-tree.yml 同一条命令。
// 这一串是给 node 的 argv（不是 shell 命令），所以元素里不能带引号：
// 带引号的 'test/**/*.test.js' 会被 node 当成字面路径，跑 0 条还 exit 0。
// 导出它，是为了让 test/ci-test-command.test.js 能断言发版闸与 CI 是同一条命令。
export const UNIT_TEST_ARGS = ['--test', 'test/**/*.test.js', 'acceptance-cases/**/*.test.js'];

function stepUnitTests() {
  const args = UNIT_TEST_ARGS;
  try {
    run('node', args);
    return report('单元测试', true, args.slice(1).join(' '));
  } catch (error) {
    return report('单元测试', false, String(error.stdout || error.message).trim().split('\n').slice(-3).join(' | '));
  }
}

// 拒绝类评测（#97 第四刀）：发版决定时只跑保留池（holdout），而且必须显式带 --release ——
// 与 CLI 的用法分支同一条规矩，别让发版闸自己把保留池当成调优池随手跑。
// 导出它，是为了让 test/pre-release.test.js 能断言「发版跑的就是 holdout 那 4 题」，
// 而不是只 grep 一句注释。
export const REFUSAL_EVAL_ARGS = ['test/e2e/refusal.e2e.mjs', '--partition=holdout', '--release'];

// 把一个 files 条目展开成仓库里的文件路径：文件条目就是它自己，目录条目递归展开。
function entryFiles(entry, repoFiles) {
  const base = String(entry).replace(/^\.\//, '').replace(/\/+$/, '');
  return repoFiles.filter((path) => path === base || path.startsWith(`${base}/`));
}

/**
 * files 清单里的每一项都得真的在仓库里、并且真的进了 tgz；src/host 下的每个文件也必须进 tgz。
 * 这是纯函数，好让 test/pre-release.test.js 把三种缺失各测一次。
 *
 * @param {object} input
 * @param {string[]} [input.listed]      tgz 里 package.json 的 files 清单（tgz 自己的，不是仓库的）
 * @param {string[]} [input.repoFiles]   仓库里的文件路径（相对仓库根）
 * @param {string[]} [input.tgzFiles]    tgz 里的文件路径（带或带 package/ 前缀都可）
 * @returns {Array<{code: string, message: string}>}
 */
export function checkPackagedFiles({ listed = [], repoFiles = [], tgzFiles = [] } = {}) {
  const problems = [];
  const packed = new Set(tgzFiles.map((path) => String(path).replace(/^package\//, '')));

  for (const entry of listed) {
    const files = entryFiles(entry, repoFiles);
    if (files.length === 0) {
      problems.push({ code: 'listed-missing-in-repo', message: `files 清单里的 ${entry} 在仓库里一个文件都没有` });
      continue;
    }
    if (!files.some((path) => packed.has(path))) {
      problems.push({ code: 'listed-not-in-tgz', message: `files 清单里的 ${entry} 没进 tgz（仓库里有 ${files.length} 个文件）` });
    }
  }

  // 清单写漏 src/ 时上面按条目的检查看不出来，但入口会 import 到 src/host，所以逐个文件查。
  const lostHost = repoFiles.filter((path) => path.startsWith('src/host/') && !packed.has(path));
  if (lostHost.length > 0) {
    problems.push({ code: 'host-file-not-in-tgz', message: `src/host 下的文件没进 tgz：${lostHost.join(', ')}` });
  }

  return problems;
}

function listRepoFiles(dir = REPO_ROOT, prefix = '') {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...listRepoFiles(join(dir, entry.name), path));
    else files.push(path);
  }
  return files;
}

// 干净安装产出的 tgz 留给升级路径那一步接着用，所以记在模块里而不只是函数里。
let packedTarball = null;

// 2. 干净安装：打包 → 从 tgz 自己读 files 清单 → 逐项核对仓库与 tgz → 装进空目录 → 真的 import 一次。
// 本地直接读源码永远发现不了 `files` 清单写漏或写错的问题。
function stepCleanInstall() {
  const tmp = mkdtempSync(join(tmpdir(), 'odm-install-'));

  try {
    run('npm', ['pack', '--pack-destination', tmp, '--silent']);
  } catch (error) {
    return report('干净安装', false, `npm pack 失败：${String(error.stdout || error.message).trim()}`);
  }

  const tarball = readdirSync(tmp).find((f) => f.endsWith('.tgz'));
  if (!tarball) return report('干净安装', false, 'npm pack 没产出 tgz');
  const tarballPath = join(tmp, tarball);

  let listed;
  let tgzFiles;
  try {
    listed = JSON.parse(run('tar', ['-xzOf', tarballPath, 'package/package.json'])).files || [];
    tgzFiles = run('tar', ['-tzf', tarballPath])
      .split('\n')
      .map((path) => path.trim().replace(/^package\//, ''))
      .filter((path) => path && !path.endsWith('/'));
  } catch (error) {
    return report('干净安装', false, `读不了 tgz 里的 package.json：${String(error.stderr || error.message).trim()}`);
  }
  packedTarball = tarballPath;

  const repoFiles = listRepoFiles();
  const problems = checkPackagedFiles({ listed, repoFiles, tgzFiles });

  // 先把 tgz 里真实装了什么按清单顺序报出来：出了问题也看得见是哪一项没进。
  const packed = new Set(tgzFiles);
  const seen = new Set();
  const counts = [];
  for (const entry of listed) {
    const files = entryFiles(entry, repoFiles).filter((path) => packed.has(path) && !seen.has(path));
    for (const path of files) seen.add(path);
    counts.push(`${entry} ${files.length}`);
  }
  const other = tgzFiles.filter((path) => !seen.has(path)).length;
  if (other > 0) counts.push(`其它 ${other}`);
  const breakdown = counts.length > 0 ? `（${counts.join('，')}）` : '（package.json 里没有 files 清单）';
  console.log(`装进 tgz 的文件：${tgzFiles.length}${breakdown}`);

  if (problems.length > 0) {
    for (const problem of problems) console.log(`  - ${problem.code}: ${problem.message}`);
    return report('干净安装', false, `${problems.length} 处与 files 清单对不上`);
  }

  const app = join(tmp, 'app');
  run('mkdir', ['-p', app]);
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'probe', private: true, type: 'module' }));

  try {
    run('npm', ['i', tarballPath, '--omit=optional', '--no-audit', '--no-fund', '--silent'], { cwd: app });
  } catch (error) {
    return report('干净安装', false, `装进空目录失败：${String(error.stdout || error.message).trim().split('\n').slice(-2).join(' | ')}`);
  }

  try {
    const out = run('node', ['-e', "import('opendigitalmate').then((m) => console.log(typeof m.apply, m.name))"], { cwd: app });
    if (!out.includes('function')) return report('干净安装', false, `import 成功但没有 apply 导出：${out}`);
    return report('干净安装', true, `装进去能加载：${out.trim()}`);
  } catch (error) {
    return report('干净安装', false, `import 失败：${String(error.stderr || error.message).trim().split('\n').slice(-2).join(' | ')}`);
  }
}

// 3. 版本 / tag / CHANGELOG 三者一致。
function stepVersionConsistency() {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  const changelogPath = join(REPO_ROOT, 'CHANGELOG.md');
  const changelog = existsSync(changelogPath) ? readFileSync(changelogPath, 'utf8') : '';
  if (!changelog.startsWith(CHANGELOG_HEADER.trim())) {
    // 头部被改动不一定是错，但发版脚本的重写会覆盖它；这里只提示，不算失败。
    console.log('注意：CHANGELOG 头部与脚本生成的不一致，发版后会被脚本的头部覆盖。');
  }

  const tagArg = process.argv.find((a) => a.startsWith('--tag='));
  const tag = tagArg ? tagArg.slice('--tag='.length) : null;
  const tagsArg = process.argv.find((a) => a.startsWith('--tags='));
  const existingTags = tagsArg ? tagsArg.slice('--tags='.length).split(',').map((t) => t.trim()).filter(Boolean) : [];

  const problems = checkVersionConsistency({ version: pkg.version, tag, changelog, existingTags });
  if (problems.length === 0) return report('版本一致性', true, `v${trimVersion(pkg.version)}`);
  for (const p of problems) console.log(`  - ${p.code}: ${p.message}`);
  return report('版本一致性', false, `${problems.length} 处不一致`);
}

// 4. 真实模型的端到端：结论必须能追到来源，缺一个信源就必须说「还没读到」。
// 缺 key 是环境问题（退出码 2），不是「跳过」：这道闸没有 key 就等于没有。
function stepRealModel() {
  if (process.argv.includes('--skip-model')) {
    return report('真实模型 e2e', false, '被 --skip-model 显式跳过：这一版不能发');
  }
  if (!process.env.MODEL_API_KEY) {
    console.log('缺 MODEL_API_KEY：pre-release 的真实模型 e2e 跑不了。');
    console.log('要发版本，先在仓库 secrets 里加 MODEL_API_KEY（以及可选的 MODEL_BASE_URL / MODEL_NAME）。');
    process.exitCode = 2;
    return false;
  }
  try {
    run('node', [join('test', 'e2e', 'real-model.e2e.mjs')]);
    return report('真实模型 e2e', true, '结论可追源、缺源不编');
  } catch (error) {
    const detail = String(error.stdout || '').trim().split('\n').slice(-4).join(' | ') || String(error.message);
    return report('真实模型 e2e', false, detail);
  }
}

// 5. 拒绝类评测的保留池（#97）：模型会不会替用户把事做了 —— 面板 e2e 只问「编不编来源」，
// 问不到「该不该做」。holdout 只在发版决定时跑，调提示词时看 tune 池。
// 缺 key 与上面一样是环境问题（退出码 2），不是「跳过」：这道闸没有 key 就等于没有。
function stepRefusalEval() {
  if (process.argv.includes('--skip-model')) {
    return report('拒绝类评测（保留池）', false, '被 --skip-model 显式跳过：这一版不能发');
  }
  if (!process.env.MODEL_API_KEY) {
    console.log('缺 MODEL_API_KEY：pre-release 的拒绝类评测（保留池）跑不了。');
    process.exitCode = 2;
    return false;
  }
  try {
    run('node', REFUSAL_EVAL_ARGS);
    return report('拒绝类评测（保留池）', true, `${REFUSAL_EVAL_ARGS.join(' ')} —— 该拒的都拒了`);
  } catch (error) {
    const detail = String(error.stdout || '').trim().split('\n').slice(-4).join(' | ') || String(error.message);
    return report('拒绝类评测（保留池）', false, detail);
  }
}

function main() {
  // --install-only 只验「装得起来」这一道闸，不跑单测、版本一致性和真实模型。
  if (process.argv.includes('--install-only')) {
    const ok = stepCleanInstall();
    console.log(ok ? '\n干净安装全过。' : '\n干净安装不过。');
    process.exit(ok ? 0 : 1);
  }

  // 工作流里版本号还没写（发版脚本才算出来），那一项交给 release.mjs 在写完之后自检。
  const steps = [stepUnitTests(), stepCleanInstall()];
  if (!process.argv.includes('--skip-version')) steps.push(stepVersionConsistency());
  steps.push(stepRealModel());
  // 拒绝类评测放在真实模型 e2e 之后：它同样要 key，但只跑 4 道保留题，失败时语义是「模型开始替用户做事」。
  steps.push(stepRefusalEval());
  const results = steps;
  const failed = results.filter((r) => !r).length;
  if (process.exitCode === 2) {
    // 缺的是环境（例如 MODEL_API_KEY），跟「测出来有问题」分开说：一个要人配，一个要人改代码。
    console.log('\npre-release 缺环境（见上），今天不发版本。');
    process.exit(2);
  }
  console.log(failed === 0 ? '\npre-release 全过，可以发版本。' : `\npre-release 有 ${failed} 项不过，今天不发版本。`);
  process.exit(failed === 0 ? 0 : 1);
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('pre-release.mjs');
if (invokedDirectly) main();
