// 发布的决策全在这里，而且全是纯函数：不读文件、不调 git、不看时钟。
// 只有这样才能在本地把「首版 / 补丁递增 / 空日跳过 / tag 已存在 / tag 有了但 release 没发」
// 五种分支一次跑完 —— 真发一次版本才有资格验证，等于没有验证。

export const CHANGELOG_HEADER =
  '# CHANGELOG\n\n每天一个补丁版本，由 `.github/workflows/release.yml` 发布；条目取自当天的提交标题。\n';

export function trimVersion(value) {
  return String(value == null ? '' : value).trim().replace(/^v/, '');
}

export function parseVersion(value) {
  const text = trimVersion(value);
  const parts = text.split('.');
  if (parts.length !== 3) return null;
  const nums = parts.map((p) => (/^\d+$/.test(p) ? Number.parseInt(p, 10) : Number.NaN));
  if (nums.some((n) => !Number.isInteger(n) || n < 0)) return null;
  return nums;
}

export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa) throw new Error(`not a version: ${a}`);
  if (!pb) throw new Error(`not a version: ${b}`);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

export function bumpPatch(version) {
  const parts = parseVersion(version);
  if (!parts) throw new Error(`not a version: ${version}`);
  return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
}

// `git log --pretty=%s` 的输出。版本提交本身不是一个改动：它每次都出现，
// 留在 CHANGELOG 里会让下一天看起来也「有进展」。
export function parseSubjects(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^release: v\d/.test(line));
}

export function changelogSection(version, date, subjects) {
  const items = subjects.length ? subjects.map((s) => `- ${s}`) : ['- 无（首个版本）'];
  return `## v${trimVersion(version)} — ${date}\n\n${items.join('\n')}\n`;
}

// 新的一段放在头部说明之后、旧段之前：CHANGELOG 从上往下读，最新的在最上面。
// 同一个版本重复插入不会出现两个 `## v` 头。
export function prependChangelog(existing, section) {
  const text = String(existing || '');
  let body = '';
  if (text.trim()) {
    const start = text.indexOf('\n## v');
    if (start !== -1) body = text.slice(start + 1);
    else if (!text.startsWith('# CHANGELOG')) body = `${text.trim()}\n`;
  }
  return `${CHANGELOG_HEADER}\n${section}\n${body}`.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/**
 * 决定这一轮要不要发版本。
 *
 * @param {object} input
 * @param {string} input.current       package.json 里的版本
 * @param {string|null} input.lastTag  最新的 v* tag，没有就是 null
 * @param {string[]} [input.existingTags] 全部 tag（防止撞号）
 * @param {string[]} [input.subjects]  上个 tag 之后的提交标题
 * @param {boolean} [input.tagReleased] 最新 tag 对应的 release 是否存在
 * @returns {{action: 'release'|'skip'|'repair', version?: string, reason: string}}
 */
export function decideRelease({ current, lastTag = null, existingTags = [], subjects = [], tagReleased = true }) {
  const wanted = trimVersion(current);

  // tag 推出去了、release 没发出来：只补 release，不再升一次版本。
  if (lastTag && compareVersions(lastTag, wanted) === 0 && !tagReleased) {
    return { action: 'repair', version: trimVersion(lastTag), reason: 'release-missing' };
  }

  if (lastTag && subjects.length === 0) {
    return { action: 'skip', reason: 'no-commits' };
  }

  let next;
  if (!lastTag) {
    next = wanted; // 首版用 package.json 的版本，不凭空加一。
  } else if (compareVersions(wanted, lastTag) > 0) {
    next = wanted; // 有人手动改过版本号，尊重它，不越过它再跳一次。
  } else {
    next = bumpPatch(lastTag);
  }

  if (existingTags.map(trimVersion).includes(next)) {
    return { action: 'skip', version: next, reason: 'tag-exists' };
  }

  return { action: 'release', version: next, reason: lastTag ? 'changes-since-tag' : 'first-release' };
}
