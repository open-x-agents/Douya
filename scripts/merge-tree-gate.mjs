// 撞号闸：L6（合并树）上的一条判据 —— package.json 的 version 不能等于任何已存在的 v* tag。
//
// 为什么非得查 tag：两个 PR 各自把版本号从 0.1.0 改成 0.1.1 时，git 三方合并判定为「同一处改动」，
// 干净合上 —— 冲突检测和单测都看不见，只有对着已有的 tag 才拦得住。
//
// 规则本身不在这里重写：`scripts/pre-release.mjs` 的 checkVersionConsistency 已经在 L7 用了它。
// 这里只留「撞号」一类，CHANGELOG 缺段 / 头部格式属于 L7，不该在 L6 上报（那会让每个 PR 都红）。
//
// 退出码照 scripts/enqueue-guard.mjs：0 合格，1 不合格，2 用法/环境不对（缺参数、读不到 tag）。

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { checkVersionConsistency } from './pre-release.mjs';
import { trimVersion } from './release-plan.mjs';

/**
 * 只在「这个 PR 真的动了版本号」时才判撞号，且拿 head 的版本号去判。
 *
 * 为什么不能写「version ∈ tags 就红」：发版后 main 的版本号天然等于最新 tag，
 * 那样会让所有 PR 变红。为什么不能跟 base 比：PR B 从 0.1.0 切出、改成 0.1.1，
 * PR A 先合并并打了 v0.1.1 之后，B 的 base.sha 版本已经是 0.1.1，按「没动版本号」就放绿了 ——
 * 正是要被拦下的那个形态。所以判据只有一条：merge-base 版本 ≠ head 版本时才查 tag。
 *
 * @param {object} input
 * @param {string} input.mergeBaseVersion  PR 与 base 的分叉点上 package.json 的版本
 * @param {string} input.headVersion       PR head 上 package.json 的版本
 * @param {string[]} [input.tags]          已存在的 v* tag
 * @returns {Array<{code: string, message: string}>}
 */
export function checkVersionTagCollision({ mergeBaseVersion, headVersion, tags = [] }) {
  const base = trimVersion(mergeBaseVersion);
  const head = trimVersion(headVersion);
  // 没动版本号就不查 tag：这个号已经发过是正常的（发版后 main 的号就是最新 tag）。
  if (head === base) return [];
  return checkVersionConsistency({ version: head, changelog: '', existingTags: tags }).filter(
    (problem) => problem.code === 'version-already-tagged',
  );
}

function argValue(argv, name) {
  const hit = argv.find((arg) => arg.startsWith(`--${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 3);
}

// checkout 的 fetch-depth: 0（以及显式 fetch-tags: true）会带上 tag；读不到就当空，
// 由调用方决定是 fail-closed 还是显式传 --tags=。
function gitTags() {
  try {
    return execFileSync('git', ['tag', '--list', 'v*'], { encoding: 'utf8' })
      .split('\n')
      .map((tag) => tag.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function usage() {
  console.error('用法：node scripts/merge-tree-gate.mjs --merge-base-version=<ver> [--head-version=<ver>] [--tags=v0.1.0,...]');
}

function main() {
  const argv = process.argv.slice(2);
  const mergeBaseVersion = argValue(argv, 'merge-base-version');
  const headVersionArg = argValue(argv, 'head-version');
  const tagsArg = argValue(argv, 'tags');

  if (mergeBaseVersion === null || !trimVersion(mergeBaseVersion)) {
    usage();
    console.error('缺 --merge-base-version：没有分叉点的版本号，就没法判断「这个 PR 到底动没动版本号」');
    process.exit(2);
  }

  const headVersion = headVersionArg === null ? JSON.parse(readFileSync('./package.json', 'utf8')).version : headVersionArg;
  const tags = tagsArg === null ? gitTags() : tagsArg.split(',').map((tag) => tag.trim()).filter(Boolean);

  // tag 列表必须打出来：读不到 tag 时撞号判断对任何 PR 恒绿，日志里空着就等于「这道闸其实没判」。
  console.log(`merge-base 版本: ${trimVersion(mergeBaseVersion)}`);
  console.log(`head 版本: ${trimVersion(headVersion)}`);
  console.log(`tags: ${tags.join(' ') || '（空）'}`);

  if (tagsArg === null && tags.length === 0) {
    console.error('读不到任何 v* tag：这样撞号恒为假，这道闸等于没跑。显式传 --tags=，或确认 checkout 真的带了 tag');
    process.exit(2);
  }

  const problems = checkVersionTagCollision({ mergeBaseVersion, headVersion, tags });
  if (problems.length === 0) {
    console.log(`合格：v${trimVersion(headVersion)} 没有撞上已有的 tag（这个 PR 没动版本号，或改的是一个新号）`);
    process.exit(0);
  }
  console.log(`不合格：v${trimVersion(headVersion)} 已经是一个 tag`);
  for (const problem of problems) {
    console.log(`  - ${problem.code}: ${problem.message}`);
    console.log(`::error::${problem.code}: ${problem.message}`);
  }
  process.exit(1);
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('merge-tree-gate.mjs');
if (invokedDirectly) main();
