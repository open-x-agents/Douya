// GitHub 的只读信源适配器。
//
// 这一层只做三件事：拼只读请求、把响应收成 RawEvent、把失败分类成 SourceError。
// 它不写事件、不写账本、不读环境变量；token 只从调用方传入。

import { SourceError, githubRef, parseGithubRef } from './contract.js';

const API_BASE = 'https://api.github.com';
const PAGE_SIZE = 100;
const RETRY_DELAY_MS = 250;
const RETRY_ATTEMPTS = 3;
const FAILURE_CONCLUSIONS = new Set(['failure', 'cancelled', 'timed_out', 'action_required']);
const STREAMS = ['assigned', 'review_requested', 'authored'];

function clip(value, limit) {
  const text = String(value ?? '');
  return text.length > limit ? text.slice(0, limit) : text;
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value !== ''))];
}

function repoFromUrl(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/\/repos\/([^/]+\/[^/]+)$/);
  return match ? match[1] : null;
}

function peopleOf(item) {
  return uniqueStrings([
    item.user?.login,
    ...(Array.isArray(item.assignees) ? item.assignees.map((person) => person?.login) : []),
  ]).sort();
}

function parseNextLink(header) {
  if (!header) return null;
  for (const part of String(header).split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="?next"?/);
    if (match) return match[1];
  }
  return null;
}

// 同一套规则给 list 和 get：任一 check 未完成 → pending；失败压过通过；
// 全 success 才算 success；一条 check 都没有 → none。
function summarizeChecks(runs, headSha) {
  const checks = (Array.isArray(runs) ? runs : []).filter(
    (run) => !headSha || run.head_sha === headSha,
  );
  if (checks.length === 0) return { state: 'none', name: null, at: null };

  const rank = (run) => {
    if (run.status !== 'completed') return 2;
    return FAILURE_CONCLUSIONS.has(run.conclusion) ? 3 : 1;
  };
  const worst = [...checks].sort(
    (left, right) => rank(right) - rank(left) || String(left.name).localeCompare(String(right.name)),
  )[0];

  let state;
  if (checks.some((run) => run.status !== 'completed')) state = 'pending';
  else if (checks.some((run) => FAILURE_CONCLUSIONS.has(run.conclusion))) state = 'failure';
  else if (checks.every((run) => run.conclusion === 'success')) state = 'success';
  else state = 'pending';

  return { state, name: worst.name ?? null, at: worst.completed_at ?? worst.started_at ?? null };
}

function newestComment(comments) {
  const comment = Array.isArray(comments) ? comments[0] : null;
  if (!comment) return null;
  return {
    id: comment.id,
    author: comment.user?.login ?? null,
    at: comment.created_at,
    body: clip(comment.body, 200),
  };
}

function excerptFor(observation) {
  const parts = [observation.title, observation.state];
  if (observation.ci) parts.push(`CI ${observation.ci.state}`);
  if (observation.latest_comment) parts.push(clip(observation.latest_comment.body, 60));
  return clip(parts.filter((part) => part !== null && part !== undefined && part !== '').join(' · '), 300);
}

export function createGithubSource({
  token = '',
  fetch: fetchImpl = globalThis.fetch,
  apiBase = API_BASE,
  maxPages = 5,
  maxObjects = 60,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
} = {}) {
  let login = null;

  const hasToken = () => typeof token === 'string' && token.trim() !== '';

  function headers() {
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'opendigitalmate',
    };
  }

  function retryAfterFrom(response, resetAt) {
    const header = response.headers?.get?.('retry-after');
    if (header) {
      const seconds = Number(header);
      if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
      const at = Date.parse(header);
      if (Number.isFinite(at)) return Math.max(0, at - now());
    }
    if (Number.isFinite(resetAt)) return Math.max(0, resetAt * 1000 - now());
    return null;
  }

  // 只读请求层：method 写死 GET，不接受调用方传入。网络错误 / 5xx 重试 3 次，
  // 退避 250ms → 500ms → 1000ms；四类可分类的失败不重试。
  async function request(path) {
    const target = path.startsWith('http') ? path : `${apiBase}${path}`;
    let lastError = null;

    for (let attempt = 0; attempt <= RETRY_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await sleep(RETRY_DELAY_MS * 2 ** (attempt - 1));
      try {
        const response = await fetchImpl(target, { method: 'GET', headers: headers() });
        const status = response.status;

        if (status === 401) {
          throw new SourceError('auth', 'GitHub rejected the token', {
            reason: 'expired',
            status,
            url: target,
          });
        }

        const remaining = response.headers?.get?.('x-ratelimit-remaining');
        const resetAt = Number(response.headers?.get?.('x-ratelimit-reset'));
        if (status === 403 && remaining === '0') {
          throw new SourceError('rate_limit', 'GitHub rate limit exhausted', {
            status,
            retryAfterMs: Number.isFinite(resetAt) ? Math.max(0, resetAt * 1000 - now()) : null,
            url: target,
          });
        }
        if (status === 403) {
          throw new SourceError('auth', 'GitHub refused the request', {
            reason: 'scope',
            status,
            url: target,
          });
        }
        if (status === 429) {
          throw new SourceError('rate_limit', 'GitHub asked us to slow down', {
            status,
            retryAfterMs: retryAfterFrom(response, resetAt),
            url: target,
          });
        }
        if (status >= 500) {
          lastError = new Error(`GitHub returned ${status}`);
          continue;
        }
        if (!response.ok) {
          throw new SourceError('http', `GitHub returned ${status}`, { status, url: target });
        }

        const text = await response.text();
        const json = text ? JSON.parse(text) : null;
        return { json, headers: response.headers, status };
      } catch (error) {
        if (error instanceof SourceError) throw error;
        lastError = error;
      }
    }

    throw new SourceError('timeout', `GitHub did not answer after ${RETRY_ATTEMPTS} retries`, {
      url: target,
      status: lastError?.status ?? null,
    });
  }

  async function ensureLogin() {
    if (login) return login;
    const { json } = await request('/user');
    login = json?.login;
    if (typeof login !== 'string' || login === '') {
      throw new SourceError('auth', 'GitHub did not say who the token belongs to', {
        reason: 'expired',
        url: `${apiBase}/user`,
      });
    }
    return login;
  }

  function streamUrl(stream, since) {
    const day = since.toISOString().slice(0, 10);
    if (stream === 'assigned') {
      const query = new URLSearchParams({
        filter: 'assigned',
        state: 'all',
        since: since.toISOString(),
        per_page: String(PAGE_SIZE),
      });
      return `/issues?${query.toString()}`;
    }
    const who = stream === 'review_requested' ? `review-requested:${login}` : `author:${login}`;
    const query = new URLSearchParams({
      q: `${who} is:pr is:open updated:>=${day}`,
      per_page: String(PAGE_SIZE),
    });
    return `/search/issues?${query.toString()}`;
  }

  function streamOf(url) {
    const parsed = new URL(url, apiBase);
    if (parsed.pathname === '/issues') return 'assigned';
    const query = parsed.searchParams.get('q') ?? '';
    if (query.startsWith('review-requested:')) return 'review_requested';
    if (query.startsWith('author:')) return 'authored';
    return STREAMS[0];
  }

  async function subread(read, ref, partial) {
    try {
      return await read();
    } catch (error) {
      if (error instanceof SourceError && (error.kind === 'auth' || error.kind === 'rate_limit')) {
        throw error;
      }
      partial.push({ kind: 'partial', reason: error?.kind ?? 'http', source: 'github', ref });
      return null;
    }
  }

  async function observe(item, why, partial, context = {}) {
    const repo =
      context.repo ||
      item.repository?.full_name ||
      item.base?.repo?.full_name ||
      repoFromUrl(item.repository_url);
    const number = context.number ?? item.number;
    const object = context.object ?? (item.pull_request || item.pull_request_url ? 'pr' : 'issue');
    if (!repo || !Number.isSafeInteger(number)) return null;

    const ref = githubRef({ object, repo, number });
    const observation = {
      source: 'github',
      object,
      repo,
      number,
      external_id: `${repo}/${number}`,
      ref,
      title: clip(String(item.title ?? '').trim(), 300),
      project: repo.split('/')[1] ?? null,
      people: peopleOf(item),
      at: item.updated_at ?? null,
      due_at: null,
      due_kind: null,
      amount: null,
      state: item.state ?? null,
      read_scope: 'metadata',
      excerpt: '',
      html_url:
        item.html_url ??
        `https://github.com/${repo}/${object === 'pr' ? 'pull' : 'issues'}/${number}`,
      why: uniqueStrings(why).sort(),
      ci: null,
      latest_comment: null,
      // 事件 source 用 created_at + 身份串；会变的标题 / 状态 / CI / 评论只进账本。
      created_at: item.created_at ?? null,
      closed_at: item.closed_at ?? null,
    };

    if (object === 'pr') {
      const pull =
        context.pull ??
        (await subread(() => request(`/repos/${repo}/pulls/${number}`), ref, partial));
      const headSha = pull?.json?.head?.sha ?? item.head?.sha ?? null;
      if (headSha) {
        const runs = await subread(
          () => request(`/repos/${repo}/commits/${headSha}/check-runs?per_page=${PAGE_SIZE}`),
          ref,
          partial,
        );
        if (runs) observation.ci = summarizeChecks(runs.json?.check_runs, headSha);
      }
    }

    const comments = await subread(
      () =>
        request(
          `/repos/${repo}/issues/${number}/comments?per_page=${PAGE_SIZE}&sort=created&direction=desc`,
        ),
      ref,
      partial,
    );
    if (comments) observation.latest_comment = newestComment(comments.json);

    observation.excerpt = excerptFor(observation);
    return observation;
  }

  async function list(since, cursor = null) {
    if (!hasToken()) {
      throw new SourceError('auth', 'no GitHub token', { reason: 'missing', url: `${apiBase}/user` });
    }
    const sinceDate = since instanceof Date ? new Date(since.getTime()) : new Date(since);
    if (Number.isNaN(sinceDate.getTime())) throw new RangeError('since must be a valid date');

    await ensureLogin();

    const observations = new Map();
    const partial = [];
    let next = null;
    let streamIndex = cursor ? STREAMS.indexOf(streamOf(cursor)) : 0;
    if (streamIndex < 0) streamIndex = 0;
    let url = cursor || streamUrl(STREAMS[streamIndex], sinceDate);
    let page = 0;

    while (true) {
      const { json, headers: responseHeaders } = await request(url);
      page += 1;
      const items = Array.isArray(json) ? json : Array.isArray(json?.items) ? json.items : [];
      let capped = false;

      for (const item of items) {
        if (observations.size >= maxObjects) {
          partial.push({ kind: 'partial', reason: 'object-cap', source: 'github' });
          capped = true;
          break;
        }
        const observation = await observe(item, [STREAMS[streamIndex]], partial);
        if (!observation) continue;
        const existing = observations.get(observation.ref);
        if (existing) {
          existing.why = uniqueStrings([...existing.why, ...observation.why]).sort();
        } else {
          observations.set(observation.ref, observation);
        }
      }

      if (capped) {
        next = null;
        break;
      }

      const linkNext = parseNextLink(responseHeaders?.get?.('link'));
      if (linkNext) {
        if (page >= maxPages) {
          partial.push({ kind: 'partial', reason: 'page-cap', source: 'github' });
          next = linkNext;
          break;
        }
        url = linkNext;
        continue;
      }

      streamIndex += 1;
      page = 0;
      if (streamIndex >= STREAMS.length) {
        next = null;
        break;
      }
      if (observations.size >= maxObjects) {
        partial.push({ kind: 'partial', reason: 'object-cap', source: 'github' });
        next = null;
        break;
      }
      url = streamUrl(STREAMS[streamIndex], sinceDate);
    }

    const events = [...observations.values()].sort((left, right) => left.ref.localeCompare(right.ref));
    const result = { events, next };
    if (partial.length > 0) result.partial = partial;
    return result;
  }

  async function get(ref) {
    const { object, repo, number } = parseGithubRef(ref);
    const partial = [];
    let item;
    try {
      item = await request(`/repos/${repo}/${object === 'pr' ? 'pulls' : 'issues'}/${number}`);
    } catch (error) {
      if (error instanceof SourceError && error.status === 404) return null;
      throw error;
    }
    return observe(item.json, ['direct'], partial, {
      repo,
      object,
      number,
      pull: object === 'pr' ? item : null,
    });
  }

  return {
    id: 'github',
    readScope: 'metadata',
    auth() {
      return hasToken() ? { ok: true } : { ok: false, reason: 'missing' };
    },
    list,
    get,
  };
}
