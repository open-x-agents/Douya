// 合并队列准入守卫：一个 PR 凭什么有资格排队。
//
// judge() 是纯函数，喂它一份 PR 快照就出结论；CLI 只负责把 GitHub 上的快照取回来。
// 规则必须机器可查 —— 「我记得这个 PR 跑过测试」不是资格。
//
// 退出码：0 合格，1 拒绝，2 用法错误。拒绝时每个理由一行，理由是固定的 code，
// 中文解释跟在后面，方便测试断言 code，也方便人读懂。

import { api } from './gh-api.mjs';

// 一个 PR 要在两个地方绿：自己的 head（`tests.yml`），和「合到 main 之后」
// （`merge-tree.yml`）。只有前者绿过、合起来破掉的 PR，正是这一层要拦的东西。
export const REQUIRED_CHECKS = ['tests', 'merge-tree'];
export const REQUIRED_CHECK = REQUIRED_CHECKS[0];

const ISSUE_REF = /\b(?:fixes|closes|resolves)\s+#(\d+)\b/i;
const RAN_LINE = /^\s*Ran\s*:/im;
const TIP_SHA = /\b([0-9a-f]{40})\b/;

function hasRanLine(body) {
  const m = body.match(RAN_LINE);
  if (!m) return false;
  const rest = body.slice(m.index + m[0].length);
  // 一行 `Ran:` 后面要真有东西：空着等于没写。
  const line = rest.split('\n')[0].trim();
  if (line.length > 0) return true;
  // 允许 `Ran:` 之下跟一个代码块 / 列表
  return /^\s*$/m.test(rest.split('\n')[0]) && /(\$\s|\bnode\b|\bnpm\b|\bpnpm\b|\bgit\b)/m.test(rest);
}

function issuesReferenced(body) {
  const out = [];
  for (const m of body.matchAll(new RegExp(ISSUE_REF.source, 'gi'))) out.push(Number(m[1]));
  return out;
}

/**
 * @param {object} pr
 * @param {number} pr.number
 * @param {string} pr.body
 * @param {string[]} pr.labels
 * @param {string} pr.headSha
 * @param {Array<{name:string, conclusion:string|null, head_sha:string, status?:string}>} pr.checks
 * @param {string[]} pr.files           改动文件路径
 * @param {Record<number, 'open'|'closed'>} [pr.issueStates]  body 里引用到的 issue 的当前状态
 * @returns {{ok: boolean, reasons: Array<{code: string, message: string}>}}
 */
export function judge(pr) {
  const reasons = [];
  const body = String(pr.body || '');
  const labels = pr.labels || [];
  const files = pr.files || [];
  const checks = pr.checks || [];

  const refs = issuesReferenced(body);
  if (refs.length === 0) {
    reasons.push({ code: 'missing-issue-ref', message: 'body 里没有 `Fixes #N` / `Closes #N`：一次改动要对上一个 issue' });
  } else {
    const states = pr.issueStates || {};
    const closed = refs.filter((n) => states[n] === 'closed');
    if (closed.length > 0) {
      reasons.push({ code: 'issue-not-open', message: `引用的 issue 已关闭：${closed.map((n) => '#' + n).join(', ')}` });
    }
  }

  if (!hasRanLine(body)) {
    reasons.push({ code: 'missing-ran', message: 'body 里没有 `Ran:` 行：说清楚在这个 tip 上到底跑了什么' });
  }

  const sha = (body.match(TIP_SHA) || [])[1];
  if (!sha) {
    reasons.push({ code: 'missing-tip-sha', message: 'body 里没有 40 位 tip sha' });
  } else if (pr.headSha && sha !== pr.headSha) {
    reasons.push({ code: 'tip-sha-mismatch', message: `body 写的 ${sha.slice(0, 8)} 不是当前 head ${String(pr.headSha).slice(0, 8)}` });
  }

  const atHead = checks.filter((c) => !pr.headSha || !c.head_sha || c.head_sha === pr.headSha);
  for (const name of REQUIRED_CHECKS) {
    const runs = atHead.filter((c) => c.name === name);
    if (runs.length === 0) {
      // 把看到的 check 名字带上：check 的上下文是 job 名，不是 workflow 名，这条坑过一次。
      const seen = atHead.map((c) => c.name).join(', ') || '（一个都没有）';
      const why = name === 'merge-tree' ? '：它证明的是合到 main 上还绿' : '';
      reasons.push({ code: `${name}-not-green`, message: `head 上没有 \`${name}\` 的 check${why}；看到的 check：${seen}` });
      continue;
    }
    const green = runs.some((c) => c.conclusion === 'success');
    if (!green) {
      const detail = runs.map((c) => `${c.status || 'unknown'}/${c.conclusion || 'pending'}`).join(', ');
      reasons.push({ code: `${name}-not-green`, message: `head 上 \`${name}\` 不是绿：${detail}` });
    }
  }

  // 绿是有时效的：main 在这个绿之后又动过，这个绿说的就不是现在的 main。
  // 不需要新提交 —— 重跑（Re-run）就会产生一个更新的 check run。
  const mainAt = pr.mainPushedAt ? Date.parse(pr.mainPushedAt) : NaN;
  if (Number.isFinite(mainAt)) {
    for (const name of REQUIRED_CHECKS) {
      const greens = atHead.filter((c) => c.name === name && c.conclusion === 'success' && c.completed_at);
      if (greens.length === 0) continue; // 没绿的话上面已经拒绝过，这里不重复说一遍
      const newest = Math.max(...greens.map((c) => Date.parse(c.completed_at)));
      if (Number.isFinite(newest) && newest < mainAt) {
        reasons.push({
          code: `${name}-stale`,
          message: `\`${name}\` 的绿比 main 现在的 tip 早（main ${pr.mainPushedAt}）：重跑这个 check 再排队，不用新提交`,
        });
      }
    }
  }

  if (labels.includes('hold')) {
    reasons.push({ code: 'held', message: 'PR 带 `hold` 标签：只有人能摘，automation 不排队' });
  }

  if (files.length === 0) {
    reasons.push({ code: 'no-files', message: '改动文件清单是空的' });
  }

  const touchesOwned = files.some((f) => f === 'index.js' || f.startsWith('src/host/'));
  if (touchesOwned) {
    const docsUpdated = files.some((f) => f === 'docs/architecture.md');
    const waiver = /^\s*Docs-not-needed\s*:\s*\S+/im.test(body);
    if (!docsUpdated && !waiver) {
      reasons.push({
        code: 'docs-not-needed-missing',
        message: '改了 `index.js` 或 `src/host/**`，但既没更新 `docs/architecture.md`，也没写 `Docs-not-needed: <理由>`',
      });
    }
  }

  return { ok: reasons.length === 0, reasons };
}

function printVerdict(number, verdict) {
  if (verdict.ok) {
    console.log(`合格：#${number} 可以进队列。`);
    return;
  }
  console.log(`拒绝：#${number}`);
  for (const reason of verdict.reasons) console.log(`  - ${reason.code}: ${reason.message}`);
}

async function snapshot(number) {
  const pull = await api('GET', `/pulls/${number}`);
  const files = [];
  for (let page = 1; page <= 3; page += 1) {
    const chunk = await api('GET', `/pulls/${number}/files?per_page=100&page=${page}`);
    files.push(...chunk.map((f) => f.filename));
    if (chunk.length < 100) break;
  }
  const headSha = pull.head.sha;
  const checkRuns = await api('GET', `/commits/${headSha}/check-runs?per_page=100`);
  // main 的状态不算快照的必需项：取不到就当没有，不让一次 API 抖动变成一次放行。
  let mainPushedAt = null;
  try {
    const mainTip = await api('GET', '/commits/main');
    mainPushedAt = mainTip?.commit?.committer?.date || null;
  } catch {
    mainPushedAt = null;
  }
  const refs = issuesReferenced(String(pull.body || ''));
  const issueStates = {};
  for (const n of refs) {
    try {
      const issue = await api('GET', `/issues/${n}`);
      issueStates[n] = issue.state;
    } catch {
      issueStates[n] = 'closed';
    }
  }
  return {
    number,
    body: String(pull.body || ''),
    labels: (pull.labels || []).map((l) => l.name),
    headSha,
    mainPushedAt,
    files,
    checks: checkRuns.check_runs.map((c) => ({
      name: c.name,
      status: c.status,
      conclusion: c.conclusion,
      head_sha: headSha,
      completed_at: c.completed_at,
    })),
    issueStates,
  };
}

async function main() {
  const i = process.argv.indexOf('--pr');
  if (i === -1 || !process.argv[i + 1]) {
    console.error('用法：node scripts/enqueue-guard.mjs --pr <number>');
    process.exit(2);
  }
  const number = Number(process.argv[i + 1]);
  if (!Number.isInteger(number) || number <= 0) {
    console.error('用法：node scripts/enqueue-guard.mjs --pr <number>');
    process.exit(2);
  }
  const verdict = judge(await snapshot(number));
  printVerdict(number, verdict);
  process.exit(verdict.ok ? 0 : 1);
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('enqueue-guard.mjs');
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`守卫自己失败了（不是 PR 不合格）：${error.message}`);
    process.exit(2);
  });
}
