// 这台机器没有 git：github.com:443 不通，只有 api.github.com。所以提交走 REST API：
// blobs → tree（带 base_tree）→ commit（单父）→ 移动 ref。
//
// 只用 fast-forward（force: false）：别人在这期间推了，这一步会 422，而不是把对方抹掉。
// 这个脚本给「workflow 里没有 git 的机器」用，也让本地提交不用再手搓一遍 API。

import { readFileSync } from 'node:fs';
import { api } from './gh-api.mjs';

const USAGE = '用法：node scripts/commit-api.mjs --message-file <path> [--branch main] [--parent <sha>] [--dry-run] <本地文件>=<仓库路径> ...';

export function parseArgs(argv) {
  const options = { branch: 'main', dryRun: false, messageFile: null, parent: null, files: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--branch') options.branch = argv[++i];
    else if (arg === '--message-file') options.messageFile = argv[++i];
    else if (arg === '--parent') options.parent = argv[++i];
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg.includes('=')) {
      const [local, repoPath] = arg.split('=');
      options.files.push({ local, path: repoPath });
    } else throw new Error(`看不懂的参数：${arg}\n${USAGE}`);
  }
  if (!options.messageFile) throw new Error(`缺 --message-file\n${USAGE}`);
  if (options.files.length === 0) throw new Error(`至少给一个 <本地文件>=<仓库路径>\n${USAGE}`);
  return options;
}

// 一条 commit 只改它该改的文件：重复路径、绝对路径、带 .. 的路径都拒掉，
// 因为 tree 里多一个路径就等于这次提交多动了东西，而没人会回头看。
export function treeEntries(entries) {
  const seen = new Set();
  return entries.map((entry) => {
    const path = String(entry.path || '');
    if (!path) throw new Error('tree entry 缺 path');
    if (path.startsWith('/') || path.includes('..')) throw new Error(`路径必须是仓库相对路径：${path}`);
    if (seen.has(path)) throw new Error(`同一个路径给了两次：${path}`);
    seen.add(path);
    return { path, mode: '100644', type: 'blob', sha: entry.sha };
  });
}

// 提交信息的形状会进 squash 后的 commit message，所以行尾空白和多余空行一次清掉。
export function cleanMessage(text) {
  return `${String(text)
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()}\n`;
}

export async function commitFiles({ message, files, branch = 'main', parent = null, dryRun = false, repo }) {
  const options = { repo };
  const ref = parent ? { object: { sha: parent } } : await api('GET', `/git/ref/heads/${branch}`, undefined, options);
  const baseSha = ref.object.sha;
  const base = await api('GET', `/git/commits/${baseSha}`, undefined, options);

  const entries = [];
  for (const file of files) {
    const content = readFileSync(file.local);
    if (dryRun) {
      entries.push({ path: file.path, sha: `dry-${content.length}` });
      continue;
    }
    const blob = await api('POST', '/git/blobs', { content: content.toString('base64'), encoding: 'base64' }, options);
    entries.push({ path: file.path, sha: blob.sha });
  }
  if (dryRun) {
    const tree = { base_tree: base.tree.sha, tree: treeEntries(entries) };
    return { dryRun: true, parent: baseSha, message: cleanMessage(message), tree };
  }

  const tree = await api('POST', '/git/trees', { base_tree: base.tree.sha, tree: treeEntries(entries) }, options);
  const commit = await api('POST', '/git/commits', { message: cleanMessage(message), tree: tree.sha, parents: [baseSha] }, options);
  await api('PATCH', `/git/refs/heads/${branch}`, { sha: commit.sha, force: false }, options);
  return { parent: baseSha, commit: commit.sha, tree: tree.sha };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const message = readFileSync(options.messageFile, 'utf8');
  const result = await commitFiles({ ...options, message });
  if (result.dryRun) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`${result.parent.slice(0, 8)} → ${result.commit.slice(0, 8)} (${options.branch})`);
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('commit-api.mjs');
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`提交失败：${error.message}`);
    process.exit(1);
  });
}
