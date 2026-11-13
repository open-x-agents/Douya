// 每天一个版本。这里只做 IO：读 tag、写文件、提交、打 tag、发 release。
// 「发不发、发哪个号」全部在 scripts/release-plan.mjs 里，那一半有测试。
//
// 每一次拒绝都是一次正常退出，原因写进日志和 step summary —— 定时任务失败时
// 人在 Actions 页面上要能直接看到为什么没发，而不是去读一份堆栈。
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  changelogSection,
  decideRelease,
  parseSubjects,
  prependChangelog,
  trimVersion,
} from '../../scripts/release-plan.mjs';
import { checkVersionConsistency } from '../../scripts/pre-release.mjs';

const REPO = process.env.GITHUB_REPOSITORY || '';
const SUMMARY = process.env.GITHUB_STEP_SUMMARY;
// 发布说明写在仓库外：它是工作流的中间产物，不该被 git 卷进版本提交。
const NOTES_FILE = join(process.env.RUNNER_TEMP || tmpdir(), 'douya-release-notes.md');

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}

function tryRun(cmd, args) {
  try {
    return { ok: true, out: run(cmd, args) };
  } catch (error) {
    return { ok: false, out: String(error.stdout || '').trim(), code: error.status };
  }
}

function summary(lines) {
  console.log(lines.join('\n'));
  if (SUMMARY) appendFileSync(SUMMARY, `${lines.join('\n')}\n`);
}

// 发布日按 Asia/Shanghai 算：一个「今天」只有一个，别让 UTC 把凌晨那次发布记到前一天。
function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function releaseExists(tag) {
  return tryRun('gh', ['release', 'view', tag, '--repo', REPO, '--json', 'tagName']).ok;
}

function createRelease(tag, notesFile) {
  run('gh', ['release', 'create', tag, '--repo', REPO, '--title', tag, '--notes-file', notesFile]);
}

function main() {
  if (process.env.GITHUB_REF_NAME && process.env.GITHUB_REF_NAME !== 'main') {
    summary([`跳过：只在 main 上发版本，当前是 ${process.env.GITHUB_REF_NAME}。`]);
    return;
  }

  run('git', ['config', 'user.name', 'douya-bot']);
  run('git', ['config', 'user.email', 'douya-bot@users.noreply.github.com']);

  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const current = trimVersion(pkg.version);

  const described = tryRun('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*']);
  const lastTag = described.ok ? described.out : null;
  const existingTags = (tryRun('git', ['tag', '--list', 'v*']).out || '').split('\n').filter(Boolean);
  const subjects = parseSubjects(
    (lastTag ? tryRun('git', ['log', `${lastTag}..HEAD`, '--no-merges', '--pretty=%s']) : tryRun('git', ['log', '--no-merges', '--pretty=%s'])).out,
  );

  const decision = decideRelease({
    current,
    lastTag,
    existingTags,
    subjects,
    tagReleased: lastTag ? releaseExists(lastTag) : true,
  });

  if (decision.action === 'skip') {
    const why =
      {
        'no-commits': `${lastTag} 之后没有新提交。空版本不是进展，今天不发。`,
        'tag-exists': `tag v${decision.version} 已经存在，同一个号不发两次。`,
      }[decision.reason] || decision.reason;
    summary([`跳过：${why}`]);
    return;
  }

  if (decision.action === 'repair') {
    const tag = `v${decision.version}`;
    writeFileSync(NOTES_FILE, `## ${tag}\n\n补发：上一轮 tag 已存在，但 release 没发出来。\n`);
    createRelease(tag, NOTES_FILE);
    summary([`补发 release ${tag}（tag 早已存在）。`]);
    return;
  }

  const next = decision.version;
  const date = today();
  const section = changelogSection(next, date, subjects);
  const changelogPath = 'CHANGELOG.md';
  const existingChangelog = existsSync(changelogPath) ? readFileSync(changelogPath, 'utf8') : '';

  writeFileSync(changelogPath, prependChangelog(existingChangelog, section));
  writeFileSync('package.json', readFileSync('package.json', 'utf8').replace(/"version":\s*"[^"]+"/, `"version": "${next}"`));

  // 写完之后先自检：版本、要打的 tag、CHANGELOG 顶部三者不一致就停在这里，不留一个半成品提交。
  const problems = checkVersionConsistency({
    version: next,
    tag: `v${next}`,
    changelog: readFileSync(changelogPath, 'utf8'),
    existingTags,
  });
  if (problems.length > 0) {
    summary(['拒绝：版本一致性自检不过，停在提交之前。', ...problems.map((p) => `  - ${p.code}: ${p.message}`)]);
    process.exit(1);
  }

  writeFileSync(
    NOTES_FILE,
    `${section}
自动发布 by \`.github/workflows/release.yml\`：先跑 \`scripts/pre-release.mjs\`（单元测试、干净安装、真实模型 e2e），再升版本、写 CHANGELOG、打 tag、发这一页。
`,
  );

  run('git', ['add', 'CHANGELOG.md', 'package.json']);
  run('git', ['commit', '-m', `release: v${next}`]);
  run('git', ['tag', '-a', `v${next}`, '-m', `v${next}`]);
  run('git', ['push', 'origin', 'HEAD:main']);
  run('git', ['push', 'origin', `v${next}`]);
  createRelease(`v${next}`, NOTES_FILE);

  summary([`已发布 v${next}（${date}），改动 ${subjects.length} 条。`]);
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('release.mjs');
if (invokedDirectly) main();
