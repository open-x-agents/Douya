/**
 * Server-side aggregation of chat tool results (Muse / today.ai style).
 * Turns raw email / PR lists into a few prioritized groups so the chat reply
 * summarizes instead of listing items one by one. No user-specific data here.
 */

const gmailThreadUrl = id => (id ? `https://mail.google.com/mail/u/0/#all/${id}` : null);
const repoFromSubject = s => (String(s).match(/\[([\w.-]+\/[\w.-]+)\]/) || [])[1] || null;
const prNumFromSubject = s => (String(s).match(/\(?(?:PR )?#(\d+)\)?/) || [])[1] || null;
const nameOf = from => String(from || '').replace(/<.*>/, '').replace(/"/g, '').trim() || String(from || '');
const isBot = from => /\[bot\]|bot@|noreply|no-reply|notifications?@/i.test(String(from));
const cleanTitle = s => String(s).replace(/^(Re|Fwd?):\s*/i, '').replace(/\[[\w.-]+\/[\w.-]+\]\s*/, '').trim();

function uniqThreads(list, n = 3) {
  const seen = new Set(), out = [];
  for (const m of list) {
    const key = m.threadId || m.subject;
    if (seen.has(key)) continue;
    seen.add(key);
    const url = m.prUrl || gmailThreadUrl(m.threadId);
    if (url) out.push({ title: cleanTitle(m.subject).slice(0, 80), url });
    if (out.length >= n) break;
  }
  return out;
}

/** Normalize Composio GMAIL_FETCH_EMAILS message shapes. */
export function normalizeEmail(msg) {
  return {
    id: msg.messageId || msg.id,
    threadId: msg.threadId,
    subject: msg.subject || '(无主题)',
    from: msg.sender || msg.from || 'unknown',
    snippet: String(msg.preview?.body || msg.preview || msg.snippet || msg.messageText || '').slice(0, 160),
    labels: msg.labelIds || [],
    date: msg.messageTimestamp || msg.internalDate || msg.date,
  };
}

export function groupEmails(emails) {
  const buckets = { ci: [], gh: new Map(), people: [], promo: [], social: [], updates: [] };
  for (const e of emails) {
    const fromGh = /notifications@github\.com/i.test(e.from);
    const repo = repoFromSubject(e.subject);
    if (/(run|build|workflow|check|checks|job)s? (failed|failing)|failed:|CI failed/i.test(e.subject)) buckets.ci.push({ ...e, repo });
    else if (fromGh && repo) {
      if (!buckets.gh.has(repo)) buckets.gh.set(repo, []);
      buckets.gh.get(repo).push(e);
    } else if (e.labels.includes('CATEGORY_PROMOTIONS')) buckets.promo.push(e);
    else if (e.labels.includes('CATEGORY_SOCIAL')) buckets.social.push(e);
    else if (!isBot(e.from) && !e.labels.includes('CATEGORY_UPDATES')) buckets.people.push(e);
    else buckets.updates.push(e);
  }

  const groups = [];
  if (buckets.people.length) {
    const who = [...new Set(buckets.people.map(e => nameOf(e.from)))];
    groups.push({
      key: 'people', label: '需要你回复的人', icon: 'person', waiting: 'you', priority: 1,
      count: buckets.people.length,
      why: `${who.slice(0, 3).join('、')}${who.length > 3 ? ` 等 ${who.length} 人` : ''} 直接写信给你，这是真人在等你。`,
      nextAction: `先回复 ${who[0]}：「${cleanTitle(buckets.people[0].subject).slice(0, 30)}」`,
      links: uniqThreads(buckets.people),
    });
  }
  if (buckets.ci.length) {
    const byRepo = {};
    buckets.ci.forEach(e => { const r = e.repo || '其他'; byRepo[r] = (byRepo[r] || 0) + 1; });
    const repos = Object.entries(byRepo).sort((a, b) => b[1] - a[1]);
    groups.push({
      key: 'ci', label: 'CI 失败', icon: 'alert', waiting: 'you', priority: 2,
      count: buckets.ci.length,
      breakdown: repos.map(([r, n]) => ({ label: r, count: n })),
      why: `${repos.length} 个仓库有流水线失败（${repos.slice(0, 3).map(([r, n]) => `${r.split('/')[1] || r} ×${n}`).join('、')}），不修会挡住合并。`,
      nextAction: `先看 ${repos[0][0]} 最近一次失败的日志`,
      links: uniqThreads(buckets.ci),
    });
  }
  const ghRepos = [...buckets.gh.entries()].sort((a, b) => b[1].length - a[1].length);
  ghRepos.forEach(([repo, list], i) => {
    if (i >= 3) return;
    const threads = new Set(list.map(e => e.threadId || cleanTitle(e.subject)));
    const humans = [...new Set(list.filter(e => !/\[bot\]/i.test(e.from)).map(e => nameOf(e.from)))];
    const bots = list.filter(e => /\[bot\]/i.test(e.from)).length;
    groups.push({
      key: `gh:${repo}`, label: `PR 讨论 · ${repo.split('/')[1] || repo}`, icon: 'pr', repo,
      waiting: humans.length ? 'you' : 'fyi', priority: humans.length ? 3 : 5,
      count: list.length,
      why: `${threads.size} 个 PR 线程有新动态${humans.length ? `，${humans.slice(0, 2).join('、')} 留了评论/review` : ''}${bots ? `；${bots} 条来自合并队列等机器人` : ''}。`,
      nextAction: humans.length ? `回复 ${humans[0]} 在「${cleanTitle(list.find(e => !/\[bot\]/i.test(e.from)).subject).slice(0, 28)}」的评论` : '扫一眼合并队列结果，确认没有被踢出的 PR',
      links: uniqThreads(list),
    });
  });
  if (ghRepos.length > 3) {
    const rest = ghRepos.slice(3);
    const n = rest.reduce((s, [, l]) => s + l.length, 0);
    groups.push({
      key: 'gh:other', label: '其他仓库通知', icon: 'pr', waiting: 'fyi', priority: 6, count: n,
      why: `${rest.map(([r]) => r).slice(0, 3).join('、')} 等 ${rest.length} 个仓库的零散通知。`,
      nextAction: '有空时批量标记已读', links: uniqThreads(rest.flatMap(([, l]) => l)),
    });
  }
  if (buckets.updates.length) groups.push({
    key: 'updates', label: '服务通知 / 订阅', icon: 'bell', waiting: 'fyi', priority: 7, count: buckets.updates.length,
    why: `来自 ${[...new Set(buckets.updates.map(e => nameOf(e.from)))].slice(0, 3).join('、')} 的账户、物流或订阅更新，一般无需回复。`,
    nextAction: '浏览后归档', links: uniqThreads(buckets.updates),
  });
  if (buckets.social.length) groups.push({
    key: 'social', label: '社交通知', icon: 'chat', waiting: 'fyi', priority: 8, count: buckets.social.length,
    why: `${[...new Set(buckets.social.map(e => nameOf(e.from)))].slice(0, 3).join('、')} 的消息提醒。`,
    nextAction: '到对应平台查看消息', links: uniqThreads(buckets.social),
  });
  if (buckets.promo.length) groups.push({
    key: 'promo', label: '营销 / 促销', icon: 'tag', waiting: 'fyi', priority: 9, count: buckets.promo.length,
    why: `${[...new Set(buckets.promo.map(e => nameOf(e.from)))].slice(0, 3).join('、')} 等商家推广，可直接忽略。`,
    nextAction: '一键归档；不想再收可退订', links: uniqThreads(buckets.promo, 2),
  });
  return groups.sort((a, b) => a.priority - b.priority);
}

export function groupPullRequests(prs, { me = '' } = {}) {
  const review = prs.filter(p => p.reviewRequested);
  const byRepo = new Map();
  prs.filter(p => !p.reviewRequested).forEach(p => {
    if (!byRepo.has(p.repo)) byRepo.set(p.repo, []);
    byRepo.get(p.repo).push(p);
  });
  const days = d => Math.max(0, Math.round((Date.now() - new Date(d).getTime()) / 864e5));
  const groups = [];
  if (review.length) groups.push({
    key: 'pr:review', label: '等你 review', icon: 'alert', waiting: 'you', priority: 1, count: review.length,
    why: `${[...new Set(review.map(p => p.author))].slice(0, 3).join('、')} 在等你审，审完才能合并。`,
    nextAction: `先审 ${review[0].repo} #${review[0].number}`,
    links: review.slice(0, 3).map(p => ({ title: `#${p.number} ${p.title}`.slice(0, 80), url: p.url })),
  });
  [...byRepo.entries()].sort((a, b) => b[1].length - a[1].length).forEach(([repo, list]) => {
    const mine = list.filter(p => !me || p.author === me);
    const stale = list.filter(p => days(p.updatedAt) >= 3);
    const oldest = [...list].sort((a, b) => new Date(a.updatedAt) - new Date(b.updatedAt))[0];
    groups.push({
      key: `pr:${repo}`, label: repo, icon: 'pr', repo, waiting: 'others', priority: 3, count: list.length,
      why: `${mine.length || list.length} 个你参与的 PR 在等别人 review/合并${stale.length ? `，其中 ${stale.length} 个超过 3 天没动` : ''}。`,
      nextAction: stale.length ? `催一下 #${oldest.number}（${days(oldest.updatedAt)} 天未更新）` : `推进 #${list[0].number}：${list[0].title.slice(0, 28)}`,
      links: list.slice(0, 3).map(p => ({ title: `#${p.number} ${p.title}`.slice(0, 80), url: p.url })),
    });
  });
  return groups;
}

export function groupIssues(issues) {
  const byRepo = new Map();
  issues.forEach(i => { if (!byRepo.has(i.repo)) byRepo.set(i.repo, []); byRepo.get(i.repo).push(i); });
  return [...byRepo.entries()].sort((a, b) => b[1].length - a[1].length).map(([repo, list]) => ({
    key: `issue:${repo}`, label: `Issue · ${repo}`, icon: 'issue', repo, waiting: 'you', priority: 4, count: list.length,
    why: `${list.length} 个 issue 指派给你${list.some(i => (i.labels || []).some(l => /bug|urgent|p0|p1/i.test(l))) ? '，含 bug / 高优先级标签' : ''}。`,
    nextAction: `先回复 #${list[0].number}：${list[0].title.slice(0, 28)}`,
    links: list.slice(0, 3).map(i => ({ title: `#${i.number} ${i.title}`.slice(0, 80), url: i.url })),
  }));
}

/** Convert groups to chat cards (type "group"). */
export function groupsToCards(groups) {
  return groups.map(g => ({
    type: 'group', key: g.key, title: g.label, label: g.label, icon: g.icon, count: g.count,
    waiting: g.waiting, description: g.why, why: g.why, nextAction: g.nextAction,
    breakdown: g.breakdown, links: (g.links || []).slice(0, 3), url: g.links?.[0]?.url,
  }));
}
