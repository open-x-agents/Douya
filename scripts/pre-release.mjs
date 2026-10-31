// pre-release 预检：发版之前必须全绿的五项。
//
// 一个版本可以「测试全绿但装不起来」，也可以「装得起来但版本号、CHANGELOG、tag 三者不自洽」，
// 还可以「什么都对，但模型开始编来源」。这三类都不该发出去。
//
// 退出码：0 全过，1 有一项不过，2 环境缺东西（例如缺 MODEL_API_KEY）。
// 每一项都是独立的 step，失败时只有那一项红，人一眼看得出是哪一类。

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
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

/**
 * `package.json.files` 的每一项都要同时落在仓库和 tgz 里。
 * 只查仓库不够：源码树上永远绿，只有真正打出来的 tgz 才知道用户装到的是哪个包。
 * 纯函数，好让 test/pre-release.test.js 把三种不一致各测一次。
 *
 * @param {object} input
 * @param {string[]} input.filesList    tgz 里 package.json 的 files 清单
 * @param {string[]} input.tgzEntries   `tar -tzf` 的原样输出（条目带 package/ 前缀）
 * @param {string[]} input.repoPaths    仓库里跟 files 清单对应的文件路径（目录已递归展开）
 * @returns {Array<{code: string, message: string}>}
 */
export function checkPackagedFiles({ filesList = [], tgzEntries = [], repoPaths = [] }) {
  const problems = [];
  const packed = tgzEntries.map((entry) => String(entry).replace(/^package\//, ''));
  const repo = repoPaths.map(String);

  for (const entry of filesList) {
    const rel = String(entry).replace(/\/$/, '');
    const isDir = String(entry).endsWith('/');
    const inRepo = isDir ? repo.some((p) => p.startsWith(`${rel}/`)) : repo.includes(rel);
    if (!inRepo) {
      problems.push({ code: 'listed-missing-in-repo', message: `package.json 的 files 里写了仓库没有的路径：${entry}` });
    }
    const inTgz = isDir ? packed.some((p) => p.startsWith(`${rel}/`)) : packed.includes(rel);
    if (!inTgz) {
      problems.push({ code: 'listed-not-in-tgz', message: `package.json 的 files 里写了 ${entry}，但 tgz 里一个文件都没有` });
    }
  }

  // files 清单写了 src/ 不等于 src/host 下的每个文件都进了包：npm 会剔掉它不认识的东西。
  for (const p of repo) {
    if (!p.startsWith('src/host/')) continue;
    if (!packed.includes(p)) {
      problems.push({ code: 'host-file-not-in-tgz', message: `src/host 下的文件 ${p} 没进 tgz` });
    }
  }

  return problems;
}

// files 的目录条目要递归展开成文件清单，否则没法核对 tgz 里到底少了哪个文件。
function expandRepoPaths(filesList) {
  const paths = [];
  const walk = (abs, rel) => {
    for (const item of readdirSync(abs, { withFileTypes: true })) {
      const child = rel ? `${rel}/${item.name}` : item.name;
      if (item.isDirectory()) walk(join(abs, item.name), child);
      else paths.push(child);
    }
  };
  for (const entry of filesList) {
    const rel = String(entry).replace(/\/$/, '');
    if (!rel) continue;
    let info;
    try {
      info = statSync(join(REPO_ROOT, rel));
    } catch {
      continue;
    }
    if (info.isDirectory()) walk(join(REPO_ROOT, rel), rel);
    else paths.push(rel);
  }
  return paths;
}

// 1. 单元测试：跟 tests.yml / release.yml 同一条命令。
function stepUnitTests() {
  const files = readdirSync(join(REPO_ROOT, 'test'))
    .filter((f) => f.endsWith('.test.js'))
    .map((f) => join('test', f))
    .sort();
  try {
    run('node', ['--test', ...files]);
    return report('单元测试', true, `${files.length} 个文件`);
  } catch (error) {
    return report('单元测试', false, String(error.stdout || error.message).trim().split('\n').slice(-3).join(' | '));
  }
}

// 2. 干净安装：打包 → 核对 files 清单 → 装进空目录 → 真的 import 一次。
// 本地直接读源码永远发现不了 `files` 清单少一个目录的问题，所以清单从 tgz 里读、
// 逐项核对仓库和 tgz 两边，而不是只查仓库里有没有那个目录。
// 一次运行只 pack 一次：升级那一步接着用同一个 tgz。
let newTarball = null;

function stepCleanInstall() {
  const tmp = mkdtempSync(join(tmpdir(), 'odm-install-'));
  const packDir = join(tmp, 'new');
  mkdirSync(packDir, { recursive: true });

  try {
    // npm pack 不会自己建目标目录：目录不存在时它是 ENOENT，不是「空目录」。
    run('npm', ['pack', '--pack-destination', packDir, '--silent']);
  } catch (error) {
    return report('干净安装', false, `npm pack 失败：${String(error.stdout || error.message).trim()}`);
  }

  const tarball = readdirSync(packDir).find((f) => f.endsWith('.tgz'));
  if (!tarball) return report('干净安装', false, 'npm pack 没产出 tgz');
  const tarballPath = join(packDir, tarball);
  newTarball = tarballPath;

  let packedFiles;
  try {
    packedFiles = JSON.parse(run('tar', ['-xzf', tarballPath, '-O', 'package/package.json'])).files || [];
  } catch (error) {
    return report('干净安装', false, `从 tgz 读 package.json 失败：${String(error.stderr || error.message).trim()}`);
  }

  const tgzEntries = run('tar', ['-tzf', tarballPath]).split('\n').filter(Boolean);
  const problems = checkPackagedFiles({ filesList: packedFiles, tgzEntries, repoPaths: expandRepoPaths(packedFiles) });
  if (problems.length > 0) {
    for (const problem of problems) console.log(`  - ${problem.code}: ${problem.message}`);
    return report('干净安装', false, `${problems.length} 处 files 清单与仓库/tgz 对不上`);
  }

  // 按清单原顺序打印：清单增删一项，这行跟着变，人一眼看得出装进去了什么。
  const counts = packedFiles.map((entry) => {
    const rel = String(entry).replace(/\/$/, '');
    const n = tgzEntries.filter((p) => (String(entry).endsWith('/') ? p.startsWith(`package/${rel}/`) : p === `package/${rel}`)).length;
    return `${entry}=${n}`;
  });
  console.log(`装进 tgz 的文件：${tgzEntries.length}（${counts.join(', ')}）`);

  const app = join(tmp, 'app');
  mkdirSync(app, { recursive: true });
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

function main() {
  // --install-only：发版前只想单独验证「装得起来」时用，不跑单测/版本一致性/真实模型。
  const installOnly = process.argv.includes('--install-only');
  const results = [];
  if (!installOnly) results.push(stepUnitTests());
  results.push(stepCleanInstall());
  if (!installOnly) {
    // 工作流里版本号还没写（发版脚本才算出来），那一项交给 release.mjs 在写完之后自检。
    if (!process.argv.includes('--skip-version')) results.push(stepVersionConsistency());
    results.push(stepRealModel());
  }
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
