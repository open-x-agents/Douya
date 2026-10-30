// 每天一个版本：读上一个 tag，拒绝空跑，升补丁号，把这段时间的提交标题写进
// CHANGELOG.md，打 tag，发 release。
//
// 每一次拒绝都是一次正常退出，原因写进日志和 step summary —— 定时任务失败时
// 人在 Actions 页面上要能直接看到为什么没发，而不是去读一份堆栈。
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO = process.env.GITHUB_REPOSITORY || '';
const ACTOR = process.env.RELEASE_ACTOR || 'release';
const SUMMARY = process.env.GITHUB_STEP_SUMMARY;
// 发布说明写在仓库外：它是工作流的中间产物，不该被 git add 卷进版本提交。
const NOTES_FILE = join(process.env.RUNNER_TEMP || tmpdir(), 'opendigitalmate-release-notes.md');

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}

function tryRun(cmd, args) {
  try {
    return { ok: true, out: run(cmd, args) };
  } catch (error) {
    return { ok: false, out: (error.stdout || '').toString().trim(), code: error.status };
  }
}

function summary(lines) {
  console.log(lines.join('\n'));
  if (SUMMARY) appendFileSync(SUMMARY, lines.join('\n') + '\n');
}

function trimVersion(value) {
  return String(value || '').replace(/^v/, '');
}

function compareVersions(a, b) {
  const pa = trimVersion(a).split('.').map(Number);
  const pb = trimVersion(b).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

function bumpPatch(version) {
  const [major, minor, patch] = trimVersion(version).split('.').map(Number);
  return `${major}.${minor}.${(patch || 0) + 1}`;
}

function today() {
  // 发布日按 Asia/Shanghai 算：一个“今天”只有一个，别让 UTC 把凌晨那次发布记到前一天。
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function releaseExists(tag) {
  return tryRun('gh', ['release', 'view', tag, '--repo', REPO, '--json', 'tagName']).ok;
}

function createRelease(tag, notesFile) {
  run('gh', ['release', 'create', tag, '--repo', REPO, '--title', tag, '--notes-file', notesFile]);
}

function changelogSection(version, date, subjects) {
  const items = subjects.length ? subjects.map((s) => `- ${s}`) : ['- 无（首个版本）'];
  return `## v${version} — ${date}\n\n${items.join('\n')}\n`;
}

function changelogHeading(tag) {
  return `## ${tag}`;
}

// 新的一段插在头部说明之后、旧段之前：CHANGELOG 从上往下读，最新的在最上面。
function prependChangelog(section) {
  const header = '# CHANGELOG\n\n每天一个补丁版本，由 `.github/workflows/release.yml` 发布；条目取自当天的提交标题。\n';
  const path = 'CHANGELOG.md';
  let body = '';
  if (existsSync(path)) {
    const text = readFileSync(path, 'utf8');
    const start = text.indexOf('\n## v');
    body = start === -1 ? '' : text.slice(start + 1);
  }
  writeFileSync(path, `${header}\n${section}\n${body}`.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n');
}

function main() {
  if (process.env.GITHUB_REF_NAME && process.env.GITHUB_REF_NAME !== 'main') {
    summary([`跳过：只在 main 上发版本，当前是 ${process.env.GITHUB_REF_NAME}。`]);
    return;
  }

  run('git', ['config', 'user.name', 'opendigitalmate-bot']);
  run('git', ['config', 'user.email', 'opendigitalmate-bot@users.noreply.github.com']);

  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const current = trimVersion(pkg.version);

  const described = tryRun('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*']);
  const lastTag = described.ok ? described.out : null;

  // 上一轮把 tag 推出去了、gh release 没成：这一轮只补 release，不再升版本。
  if (lastTag && compareVersions(lastTag, current) === 0 && !releaseExists(lastTag)) {
    const notesFile = NOTES_FILE;
    writeFileSync(notesFile, changelogHeading(lastTag) + '\n补发：上一轮 tag 已存在但 release 没有发出来。\n');
    createRelease(lastTag, notesFile);
    summary([`补发 release ${lastTag}（tag 早已存在）。`]);
    return;
  }

  const subjects = (lastTag
    ? tryRun('git', ['log', `${lastTag}..HEAD`, '--no-merges', '--pretty=%s'])
    : tryRun('git', ['log', '--no-merges', '--pretty=%s'])
  ).out
    .split('\n')
    .map((line) => line.trim())
    // 版本提交本身不算一个改动，别让它把下一天的 CHANGELOG 又撑出一条。
    .filter((line) => line && !/^release: v\d/.test(line));

  if (lastTag && subjects.length === 0) {
    summary([`跳过：${lastTag} 之后没有新提交。空版本不是进展，今天不发。`]);
    return;
  }

  let next;
  if (!lastTag) {
    next = current; // 第一次发布就用 package.json 里的版本，不凭空加一。
  } else if (compareVersions(current, lastTag) > 0) {
    next = current; // 有人手动改过版本号，尊重它，不越过它再跳一次。
  } else {
    next = bumpPatch(trimVersion(lastTag));
  }

  if (tryRun('git', ['rev-parse', '-q', '--verify', `refs/tags/v${next}`]).ok) {
    summary([`跳过：tag v${next} 已经存在，同一天不发两次。`]);
    return;
  }

  const date = today();
  const section = changelogSection(next, date, subjects);
  prependChangelog(section);
  writeFileSync('package.json', readFileSync('package.json', 'utf8').replace(/"version":\s*"[^"]+"/, `"version": "${next}"`));

  const notesFile = NOTES_FILE;
  writeFileSync(notesFile, `${section}
自动发布 by \`.github/workflows/release.yml\`：先把 \`node --test test/*.test.js\` 跑绿，再升版本、写 CHANGELOG、打 tag、发这一页。
`);

  run('git', ['add', 'CHANGELOG.md', 'package.json']);
  run('git', ['commit', '-m', `release: v${next}`]);
  run('git', ['tag', '-a', `v${next}`, '-m', `v${next}`]);
  run('git', ['push', 'origin', 'HEAD:main']);
  run('git', ['push', 'origin', `v${next}`]);
  createRelease(`v${next}`, notesFile);

  summary([`已发布 v${next}（${date}），改动 ${subjects.length} 条。`]);
}

main();
