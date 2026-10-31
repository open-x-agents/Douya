// 合并队列准入守卫：一个 PR 凭什么有资格排队。
//
// judge() 是纯函数，喂它一份 PR 快照就出结论；CLI 只负责把 GitHub 上的快照取回来。
// 规则必须机器可查 —— 「我记得这个 PR 跑过测试」不是资格。
//
// 守卫和 `tests`/`merge-tree` 由同一个 pull_request 事件同批启动，所以它不能一上来就评估：
// 那两条 check 还在 in_progress，看到的就是「不是绿」。waitForChecks() 按同一 sha 的真实
// check 状态轮询到两者都 completed（带超时，不靠 sleep 猜时间）再交给 judge()。
//
// 退出码：0 合格，1 拒绝，2 用法错误。拒绝理由既打到日志，也写进 check 的 output summary
// 和 step summary —— 人看 PR 页面就该知道为什么，不用去 Actions 里翻日志。

import { appendFileSync } from 'node:fs';
import { api } from './gh-api.mjs';

// 一个 PR 要在两个地方绿：自己的 head（`tests.yml`），和「合到 main 之后」
// （`merge-tree.yml`）。只有前者绿过、合起来破掉的 PR，正是这一层要拦的东西。
export const REQUIRED_CHECKS = ['tests', 'merge-tree'];
export const REQUIRED_CHECK = REQUIRED_CHECKS[0];

// 只有 merge-tree 的绿会过期：它证明的是「合到**当前** main 上还绿」，main 一动它就旧了。
// tests 测的是 head 那棵树，main 前进不改变它的结论，所以没有 tests-stale 这回事。
export const STALENESS_CHECK = 'merge-tree';

// 等待窗口与轮询间隔：job 的 timeout 是兜底，这里才是「等多久就不再等」。
export const DEFAULT_CHECK_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_POLL_INTERVAL_MS = 15 * 1000;

const ISSUE_REF = /\b(?:fixes|closes|resolves)\s+#(\d+)\b/i;
const RAN_LINE = /^\s*Ran\s*:/im;
const TIP_SHA = /\b([0-9a-f]{40})\b/;

// 「真命令」的口径：行首 `$ `，或行首是已知命令词（词后必须是词边界）。
// 命令词出现在句子中间不算 —— `Ran: 我用 git 看过了` 说的是「看过」，不是跑过。
// 口径与 docs/testing.md 的 L5 规则 2 是同一句话，改一边就要改另一边。
export const COMMAND_HINT = ['node', 'npm', 'npx', 'pnpm', 'yarn', 'git', 'gh', 'python', 'python3'];
const COMMAND_LINE = /^\s*(?:\$\s|(?:node|npm|npx|pnpm|yarn|git|gh|python3?)\b)/;
// `Ran:` 之下最多看这么多行，再往下就是别的话了。
const RAN_BLOCK_LINES = 10;

function isCommandLine(line) {
  return COMMAND_LINE.test(line);
}

function hasRanLine(body) {
  const m = body.match(RAN_LINE);
  if (!m) return false;
  const rest = body.slice(m.index + m[0].length);
  const lines = rest.split('\n');
  // `Ran:` 这一行内：冒号后面就是命令。
  if (isCommandLine(lines[0])) return true;
  // `Ran:` 之下同一块内也算（裸 `Ran:` + 下一行 `$ …`）。
  // 到块边界就停：空行、下一个 `Ran:`，或超过 RAN_BLOCK_LINES 行 —— 不全文搜索。
  for (const line of lines.slice(1, 1 + RAN_BLOCK_LINES)) {
    if (/^\s*$/.test(line)) break;
    if (RAN_LINE.test(line)) break;
    if (isCommandLine(line)) return true;
  }
  return false;
}

function issuesReferenced(body) {
  const out = [];
  for (const m of body.matchAll(new RegExp(ISSUE_REF.source, 'gi'))) out.push(Number(m[1]));
  return out;
}

function runsAtHead(checks, name, headSha) {
  return (checks || []).filter((c) => c.name === name && (!headSha || !c.head_sha || c.head_sha === headSha));
}

function timeOf(check) {
  return Date.parse(check.completed_at || check.started_at || check.created_at || '') || 0;
}

// 同一个名字可能有多条 check run（Rerun 会产生新的），**以最新的一条为准**：
// 旧的绿不能盖住新的红，也不能盖住还在跑的这一次。
function newestOf(runs) {
  return runs.reduce((latest, run) => (timeOf(run) >= timeOf(latest) ? run : latest), runs[0]);
}

/**
 * 每个必需的 check 现在处于什么状态：missing（还没有这条 check）/ pending（有但不 completed）/
 * completed（跑完了，绿不绿交给 judge）。
 * @returns {Record<string, 'missing'|'pending'|'completed'>}
 */
export function checkStates(checks, headSha, required = REQUIRED_CHECKS) {
  const states = {};
  for (const name of required) {
    const runs = runsAtHead(checks, name, headSha);
    if (runs.length === 0) {
      states[name] = 'missing';
      continue;
    }
    const latest = newestOf(runs);
    // 真 API 的 check run 一定有 status；快照里偶尔只有 conclusion，视为已跑完，不让它把守卫卡死。
    const completed = latest.status === 'completed' || (latest.status == null && latest.conclusion != null);
    states[name] = completed ? 'completed' : 'pending';
  }
  return states;
}

// 「都跑完了」不等于「都绿了」：红也是 completed，交给 judge 说理由。
export function checksReady(checks, headSha, required = REQUIRED_CHECKS) {
  return Object.values(checkStates(checks, headSha, required)).every((state) => state === 'completed');
}

function waitDescription(states) {
  return Object.entries(states)
    .map(([name, state]) => `\`${name}\`=${state}`)
    .join('、');
}

/**
 * 等同一 sha 上的必需 check 都 completed。拿不到时间点就不猜：每 pollMs 读一次真实状态，
 * 到 deadline 还没齐就返回 ready:false（调用方据此拒绝，而不是把 in_progress 当红）。
 *
 * fetchChecks / sleep / now 都可注入，单测不需要网络也不需要真等。
 */
export async function waitForChecks({
  headSha,
  fetchChecks,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  timeoutMs = DEFAULT_CHECK_TIMEOUT_MS,
  pollMs = DEFAULT_POLL_INTERVAL_MS,
  required = REQUIRED_CHECKS,
}) {
  const startedAt = now();
  const interval = Math.max(1, Number(pollMs) || DEFAULT_POLL_INTERVAL_MS);
  const deadline = startedAt + Math.max(0, Number(timeoutMs) || 0);
  let polls = 0;
  for (;;) {
    polls += 1;
    const checks = await fetchChecks();
    const states = checkStates(checks, headSha, required);
    if (checksReady(checks, headSha, required)) {
      return { ready: true, checks, states, polls, waitedMs: now() - startedAt };
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      return { ready: false, checks, states, polls, waitedMs: now() - startedAt };
    }
    await sleep(Math.min(interval, remaining));
  }
}

// 超时不是「这两个 check 红」：它们是还没出结果，所以理由单独一个 code，
// 别让人误以为测试挂了。
export function timeoutVerdict({ number, states, waitedMs }) {
  const seconds = Math.max(1, Math.round((Number(waitedMs) || 0) / 1000));
  return {
    ok: false,
    reasons: [
      {
        code: 'checks-timeout',
        message: `等了 ${seconds} 秒还是没等到 ${waitDescription(states)} 都 completed：没有结论就不评估，重跑守卫或先让这两条 check 跑完`,
      },
    ],
  };
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
    const runs = runsAtHead(atHead, name, pr.headSha);
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

  // 绿是有时效的，但只有 merge-tree 有时效：它说的是「合到现在的 main」。
  // tests 测的是 head 那棵树，main 前进不改变它的结论 —— 别再把它算陈旧。
  // 不需要新提交 —— 用 workflow_dispatch 对当前 main 重跑 merge-tree，再重跑守卫。
  const mainAt = pr.mainPushedAt ? Date.parse(pr.mainPushedAt) : NaN;
  if (Number.isFinite(mainAt)) {
    const greens = atHead.filter((c) => c.name === STALENESS_CHECK && c.conclusion === 'success' && c.completed_at);
    if (greens.length > 0) {
      const newest = Math.max(...greens.map((c) => Date.parse(c.completed_at)));
      if (Number.isFinite(newest) && newest < mainAt) {
        reasons.push({
          code: `${STALENESS_CHECK}-stale`,
          message: `\`${STALENESS_CHECK}\` 的绿比 main 现在的 tip 早（main ${pr.mainPushedAt}）：用 workflow_dispatch 带 pr 对当前 main 重跑一次，再重跑守卫，不用新提交`,
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

// 拒绝理由要出现在 PR 的 check 上：markdown 一份给 check output，一份给 step summary。
export function renderSummary(number, verdict) {
  if (verdict.ok) return `✅ 准入通过：#${number} 可以进队列。\n`;
  const lines = [`❌ 拒绝：#${number}`, ''];
  for (const reason of verdict.reasons) lines.push(`- \`${reason.code}\`：${reason.message}`);
  return `${lines.join('\n')}\n`;
}

export function summaryOutput(number, verdict) {
  const title = verdict.ok ? `准入通过：#${number}` : `准入拒绝：#${number}（${verdict.reasons.length} 条理由）`;
  return { title, summary: renderSummary(number, verdict) };
}

/**
 * 把结论写到人看得见的地方：
 * 1. `$GITHUB_STEP_SUMMARY`（Actions run 的 Summary）；
 * 2. 本 job 自己那条 `guard` check run 的 output summary（PR 页面上直接可读）。
 * 第 2 步是 best effort：fork PR 的 token 只读，PATCH 会 403，理由至少还在 step summary 和日志里。
 */
export async function publishSummary({ number, verdict, headSha, env = process.env, apiFn = api }) {
  const summary = renderSummary(number, verdict);
  const result = { stepSummary: false, checkRun: false };
  const file = env.GITHUB_STEP_SUMMARY;
  if (file) {
    try {
      appendFileSync(file, summary);
      result.stepSummary = true;
    } catch (error) {
      console.log(`（没能写 step summary：${error.message}）`);
    }
  }
  if (!headSha) return result;
  try {
    const runs = await apiFn('GET', `/commits/${headSha}/check-runs?check_name=guard&filter=latest&per_page=10`);
    // 只改还在跑的那一条 —— 本 job 的 check run；已经 completed 的是上一轮守卫，不能替它改结论。
    const own = (runs.check_runs || []).find((c) => c.name === 'guard' && c.status !== 'completed');
    if (own) {
      await apiFn('PATCH', `/check-runs/${own.id}`, { output: summaryOutput(number, verdict) });
      result.checkRun = true;
    }
  } catch (error) {
    console.log(`（没能把理由写进 check summary：${error.message}；理由在 step summary 与日志里）`);
  }
  return result;
}

function printVerdict(number, verdict) {
  if (verdict.ok) {
    console.log(`合格：#${number} 可以进队列。`);
    return;
  }
  console.log(`拒绝：#${number}`);
  for (const reason of verdict.reasons) {
    console.log(`  - ${reason.code}: ${reason.message}`);
    // 注解同样贴在 check 上：连 output summary 都写不进去时，这几行还在。
    console.log(`::error::${reason.code}: ${reason.message}`);
  }
}

export async function headChecks(headSha, apiFn = api) {
  const checkRuns = await apiFn('GET', `/commits/${headSha}/check-runs?per_page=100&filter=latest`);
  return (checkRuns.check_runs || []).map((c) => ({
    name: c.name,
    status: c.status,
    conclusion: c.conclusion,
    head_sha: headSha,
    started_at: c.started_at,
    completed_at: c.completed_at,
  }));
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
    issueStates,
  };
}

function numberEnv(env, name, fallback) {
  const value = Number(env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
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
  const pull = await snapshot(number);
  const timeoutMs = numberEnv(process.env, 'GUARD_CHECK_TIMEOUT_MS', DEFAULT_CHECK_TIMEOUT_MS);
  const pollMs = numberEnv(process.env, 'GUARD_POLL_INTERVAL_MS', DEFAULT_POLL_INTERVAL_MS);
  const wait = await waitForChecks({
    headSha: pull.headSha,
    fetchChecks: () => headChecks(pull.headSha),
    timeoutMs,
    pollMs,
  });

  // 等齐了才评估；没等齐就明说没结论，而不是把 in_progress 判成红。
  const verdict = wait.ready
    ? judge({ ...pull, checks: wait.checks })
    : timeoutVerdict({ number, states: wait.states, waitedMs: wait.waitedMs });
  printVerdict(number, verdict);
  await publishSummary({ number, verdict, headSha: pull.headSha });
  process.exit(verdict.ok ? 0 : 1);
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('enqueue-guard.mjs');
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`守卫自己失败了（不是 PR 不合格）：${error.message}`);
    process.exit(2);
  });
}
