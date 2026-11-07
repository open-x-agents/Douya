import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assertSource, SourceError } from '../src/sources/contract.js';
import { createGithubSource } from '../src/sources/github.js';
import { createFakeFetch, loadFixture } from './fixtures/github/fetch.mjs';

const SINCE = new Date('2026-10-29T00:00:00Z');
const NOW = Date.parse('2026-10-30T09:00:00Z');
const SHA = '1111111111111111111111111111111111111111';
const REPO = 'open-x-agents/openDigitalMate';

function makeSource(routes, options = {}) {
  const fake = createFakeFetch(routes);
  const source = createGithubSource({
    token: 'test-token',
    fetch: fake.fetch,
    sleep: async () => {},
    now: () => NOW,
    ...options,
  });
  return { source, fake };
}

function listFailing({ status, headers = {}, json = {} }) {
  return [
    { path: '/user', json: { login: 'Birfy' } },
    { path: '/issues', status, headers, json },
  ];
}

function pullListing({ number = 41, checks = [], comments = [], checkStatus = 200 } = {}) {
  return [
    { path: '/user', json: { login: 'Birfy' } },
    {
      path: '/issues',
      query: { filter: 'assigned', state: 'all' },
      json: [
        {
          number,
          title: 'Wire the morning brief',
          state: 'open',
          html_url: `https://github.com/${REPO}/pull/${number}`,
          repository: { full_name: REPO },
          user: { login: 'Birfy' },
          assignees: [{ login: 'Birfy' }],
          created_at: '2026-10-29T10:00:00Z',
          updated_at: '2026-10-30T09:15:00Z',
          pull_request: { url: `https://api.github.com/repos/${REPO}/pulls/${number}` },
        },
      ],
    },
    {
      path: `/repos/${REPO}/pulls/${number}`,
      json: {
        number,
        title: 'Wire the morning brief',
        state: 'open',
        html_url: `https://github.com/${REPO}/pull/${number}`,
        user: { login: 'Birfy' },
        assignees: [{ login: 'Birfy' }],
        head: { sha: SHA },
        base: { repo: { full_name: REPO } },
        created_at: '2026-10-29T10:00:00Z',
        updated_at: '2026-10-30T09:15:00Z',
      },
    },
    {
      path: `/repos/${REPO}/commits/${SHA}/check-runs`,
      status: checkStatus,
      json: { total_count: checks.length, check_runs: checks },
    },
    { path: `/repos/${REPO}/issues/${number}/comments`, json: comments },
    { match: '^/search/issues\\?q=review-requested', json: { total_count: 0, items: [] } },
    { match: '^/search/issues\\?q=author', json: { total_count: 0, items: [] } },
  ];
}

test('every request this adapter makes is a GET', async () => {
  const { source, fake } = makeSource(loadFixture('ok'));
  await source.list(SINCE);

  assert.ok(fake.calls.length >= 6);
  for (const call of fake.calls) {
    assert.ok(call.method === 'GET' || call.method === undefined, `${call.url} used ${call.method}`);
  }
});

test('the adapter exposes only the read members and says whether it has a token', () => {
  const { source } = makeSource([]);
  assertSource(source);
  assert.deepEqual(Object.keys(source).sort(), ['auth', 'get', 'id', 'list', 'readScope']);
  assert.deepEqual(source.auth(), { ok: true });
});

test('a missing token is reported without sending a request', async () => {
  const fake = createFakeFetch([]);
  const source = createGithubSource({ token: '', fetch: fake.fetch, sleep: async () => {} });

  assert.deepEqual(source.auth(), { ok: false, reason: 'missing' });
  await assert.rejects(
    () => source.list(SINCE),
    (error) => error instanceof SourceError && error.code === 'E_SOURCE_AUTH' && error.reason === 'missing',
  );
  assert.equal(fake.calls.length, 0);
});

test('a 401 is an auth error with reason expired and is not retried', async () => {
  const { source, fake } = makeSource(listFailing({ status: 401 }));

  await assert.rejects(
    () => source.list(SINCE),
    (error) =>
      error instanceof SourceError &&
      error.kind === 'auth' &&
      error.reason === 'expired' &&
      error.status === 401,
  );
  assert.equal(fake.calls.length, 2, 'one /user call, one 401, no retry');
});

test('a 403 with an exhausted rate limit is a rate limit, not an auth failure', async () => {
  const { source, fake } = makeSource(
    listFailing({
      status: 403,
      headers: {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(NOW / 1000 + 30),
      },
    }),
  );

  await assert.rejects(
    () => source.list(SINCE),
    (error) =>
      error instanceof SourceError &&
      error.kind === 'rate_limit' &&
      error.retryAfterMs === 30_000 &&
      error.status === 403,
  );
  assert.equal(fake.calls.length, 2, 'rate limits are not retried');
});

test('a 403 without a rate-limit header is an auth failure with reason scope', async () => {
  const { source } = makeSource(listFailing({ status: 403 }));

  await assert.rejects(
    () => source.list(SINCE),
    (error) =>
      error instanceof SourceError &&
      error.kind === 'auth' &&
      error.reason === 'scope' &&
      error.status === 403,
  );
});

test('a cf-mitigated page is a block, not a missing permission', async () => {
  const { source, fake } = makeSource(
    listFailing({ status: 403, headers: { 'cf-mitigated': 'block', 'content-type': 'text/html' } }),
  );

  await assert.rejects(
    () => source.list(SINCE),
    (error) =>
      error instanceof SourceError &&
      error.kind === 'blocked' &&
      error.reason === 'header' &&
      error.status === 403 &&
      error.code === 'E_SOURCE_BLOCKED',
  );
  assert.equal(fake.calls.length, 2, 'a block page is not retried');
});

test('a 429 is a rate limit that says when to come back', async () => {
  const { source, fake } = makeSource(
    listFailing({ status: 429, headers: { 'retry-after': '30' } }),
  );

  await assert.rejects(
    () => source.list(SINCE),
    (error) =>
      error instanceof SourceError &&
      error.kind === 'rate_limit' &&
      error.retryAfterMs === 30_000 &&
      error.status === 429,
  );
  assert.equal(fake.calls.length, 2);
});

test('offline turns into a timeout after the retries run out', async () => {
  const sleeps = [];
  const fake = createFakeFetch(loadFixture('offline'));
  const source = createGithubSource({
    token: 'test-token',
    fetch: fake.fetch,
    sleep: async (ms) => sleeps.push(ms),
    now: () => NOW,
  });

  await assert.rejects(
    () => source.list(SINCE),
    (error) => error instanceof SourceError && error.kind === 'timeout',
  );
  assert.equal(fake.calls.length, 4, 'one try plus three retries');
  assert.deepEqual(sleeps.slice(0, 2), [250, 500]);
});

test('a broken subread keeps the pull request and names the gap', async () => {
  const { source } = makeSource(pullListing({ checkStatus: 404 }));
  const result = await source.list(SINCE);

  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].ref, 'github:pr/open-x-agents/openDigitalMate/41');
  assert.equal(result.events[0].ci, null);
  assert.ok(
    result.partial.some(
      (gap) =>
        gap.kind === 'partial' &&
        gap.ref === 'github:pr/open-x-agents/openDigitalMate/41',
    ),
  );
});

test('the first page hands back a cursor and the second page finishes it', async () => {
  const { source } = makeSource(loadFixture('pages'), { maxPages: 1 });
  const first = await source.list(SINCE);

  assert.equal(first.events.length, 2);
  assert.match(first.next, /page=2/);
  assert.equal(first.partial[0].reason, 'page-cap');

  const second = await source.list(SINCE, first.next);
  assert.equal(second.next, null);
  assert.equal(second.partial, undefined);
  assert.equal(second.events.length, 2);

  const refs = [...first.events, ...second.events].map((event) => event.ref);
  assert.equal(new Set(refs).size, 4, 'each ref appears on exactly one page');
});

test('a page cap is reported as a gap, not as an empty day', async () => {
  const { source } = makeSource(loadFixture('pages'), { maxPages: 1 });
  const result = await source.list(SINCE);

  assert.ok(result.events.length > 0);
  assert.ok(result.partial.some((gap) => gap.kind === 'partial' && gap.reason === 'page-cap'));
});

test('an object cap is reported as a gap, so a short run never looks complete', async () => {
  const routes = pullListing({ number: 41 });
  routes[1].json.push({
    ...routes[1].json[0],
    number: 42,
    title: 'Second pull request',
    html_url: `https://github.com/${REPO}/pull/42`,
  });
  const { source } = makeSource(routes, { maxObjects: 1 });
  const result = await source.list(SINCE);

  assert.equal(result.events.length, 1);
  assert.ok(result.partial.some((gap) => gap.reason === 'object-cap'));
});

test('an assigned pull request becomes one observation with a stable ref', async () => {
  const { source } = makeSource(loadFixture('ok'));
  const result = await source.list(SINCE);

  assert.equal(result.events.length, 1);
  const [event] = result.events;
  assert.equal(event.ref, 'github:pr/open-x-agents/openDigitalMate/41');
  assert.equal(event.external_id, 'open-x-agents/openDigitalMate/41');
  assert.equal(event.object, 'pr');
  assert.equal(event.repo, REPO);
  assert.equal(event.number, 41);
  assert.equal(event.title, 'Wire the morning brief');
  assert.equal(event.project, 'openDigitalMate');
  assert.deepEqual(event.people, ['Birfy']);
  assert.deepEqual(event.why, ['assigned']);
  assert.equal(event.at, '2026-10-30T09:15:00Z');
  assert.equal(event.created_at, '2026-10-29T10:00:00Z');
  assert.equal(event.state, 'open');
  assert.equal(event.read_scope, 'metadata');
  assert.equal(event.html_url, `https://github.com/${REPO}/pull/41`);
});

test('an issue and a pull request with the same number stay two observations', async () => {
  const other = 'ThinkFlowLab/FlyBot';
  const otherSha = '2222222222222222222222222222222222222222';
  const item = (repo, number, pull) => ({
    number,
    title: `${repo} number ${number}`,
    state: 'open',
    html_url: `https://github.com/${repo}/issues/${number}`,
    repository: { full_name: repo },
    user: { login: 'Birfy' },
    assignees: [{ login: 'Birfy' }],
    created_at: '2026-10-29T10:00:00Z',
    updated_at: '2026-10-30T09:15:00Z',
    ...(pull ? { pull_request: { url: `https://api.github.com/repos/${repo}/pulls/${number}` } } : {}),
  });
  const routes = [
    { path: '/user', json: { login: 'Birfy' } },
    {
      path: '/issues',
      query: { filter: 'assigned', state: 'all' },
      json: [item(REPO, 10, false), item(other, 10, true)],
    },
    { path: `/repos/${REPO}/issues/10/comments`, json: [] },
    {
      path: `/repos/${other}/pulls/10`,
      json: {
        number: 10,
        title: 'FlyBot number 10',
        state: 'open',
        html_url: `https://github.com/${other}/pull/10`,
        user: { login: 'Birfy' },
        assignees: [{ login: 'Birfy' }],
        head: { sha: otherSha },
        base: { repo: { full_name: other } },
        created_at: '2026-10-29T10:00:00Z',
        updated_at: '2026-10-30T09:15:00Z',
      },
    },
    {
      path: `/repos/${other}/commits/${otherSha}/check-runs`,
      json: { total_count: 0, check_runs: [] },
    },
    { path: `/repos/${other}/issues/10/comments`, json: [] },
    { match: '^/search/issues\\?q=review-requested', json: { total_count: 0, items: [] } },
    { match: '^/search/issues\\?q=author', json: { total_count: 0, items: [] } },
  ];
  const { source } = makeSource(routes);
  const result = await source.list(SINCE);

  assert.equal(result.events.length, 2);
  assert.deepEqual(
    result.events.map((event) => event.ref).sort(),
    [
      'github:issue/open-x-agents/openDigitalMate/10',
      'github:pr/ThinkFlowLab/FlyBot/10',
    ],
  );
});

test('a review request and an authored pull request are one observation with both reasons', async () => {
  const searchItem = {
    number: 41,
    title: 'Wire the morning brief',
    state: 'open',
    html_url: `https://github.com/${REPO}/pull/41`,
    repository_url: `https://api.github.com/repos/${REPO}`,
    user: { login: 'Birfy' },
    assignees: [{ login: 'Birfy' }],
    created_at: '2026-10-29T10:00:00Z',
    updated_at: '2026-10-30T09:15:00Z',
    pull_request: { url: `https://api.github.com/repos/${REPO}/pulls/41` },
  };
  const routes = [
    { path: '/user', json: { login: 'Birfy' } },
    { path: '/issues', query: { filter: 'assigned', state: 'all' }, json: [] },
    { match: '^/search/issues\\?q=review-requested', json: { total_count: 1, items: [searchItem] } },
    { match: '^/search/issues\\?q=author', json: { total_count: 1, items: [searchItem] } },
    {
      path: `/repos/${REPO}/pulls/41`,
      json: {
        number: 41,
        title: 'Wire the morning brief',
        state: 'open',
        html_url: `https://github.com/${REPO}/pull/41`,
        user: { login: 'Birfy' },
        assignees: [{ login: 'Birfy' }],
        head: { sha: SHA },
        base: { repo: { full_name: REPO } },
        created_at: '2026-10-29T10:00:00Z',
        updated_at: '2026-10-30T09:15:00Z',
      },
    },
    {
      path: `/repos/${REPO}/commits/${SHA}/check-runs`,
      json: { total_count: 0, check_runs: [] },
    },
    { path: `/repos/${REPO}/issues/41/comments`, json: [] },
  ];
  const { source } = makeSource(routes);
  const result = await source.list(SINCE);

  assert.equal(result.events.length, 1);
  assert.deepEqual(result.events[0].why, ['authored', 'review_requested']);
});

test('two runs over one window return the same observations in the same order', async () => {
  const { source } = makeSource(loadFixture('ok'));
  const first = await source.list(SINCE);
  const second = await source.list(SINCE);

  assert.deepEqual(second.events, first.events);
  assert.deepEqual(
    second.events.map((event) => event.ref),
    [...second.events.map((event) => event.ref)].sort(),
  );
});

test("the CI state comes from the tip's check runs, never from the combined status", async () => {
  const { source, fake } = makeSource(loadFixture('ok'));
  const result = await source.list(SINCE);

  assert.equal(result.events[0].ci.state, 'success');
  assert.ok(fake.calls.some((call) => call.pathname.endsWith('/check-runs')));
  assert.equal(
    fake.calls.filter((call) => /\/commits\/[^/]+\/status$/.test(call.pathname)).length,
    0,
  );
});

test('a failed check run outvotes a passing one', async () => {
  const { source } = makeSource(
    pullListing({
      checks: [
        {
          name: 'tests',
          status: 'completed',
          conclusion: 'success',
          head_sha: SHA,
          completed_at: '2026-10-30T09:20:00Z',
        },
        {
          name: 'e2e',
          status: 'completed',
          conclusion: 'failure',
          head_sha: SHA,
          completed_at: '2026-10-30T09:21:00Z',
        },
      ],
    }),
  );
  const result = await source.list(SINCE);

  assert.equal(result.events[0].ci.state, 'failure');
  assert.equal(result.events[0].ci.name, 'e2e');
});

test('the newest opinion on a pull request is kept, clipped and attributed', async () => {
  const fixture = loadFixture('ok');
  const commentRoute = fixture.routes.find((route) => route.path.endsWith('/issues/41/comments'));
  const newest = commentRoute.json[0];
  const { source } = makeSource(fixture);
  const result = await source.list(SINCE);
  const [event] = result.events;

  assert.equal(event.latest_comment.id, 9001);
  assert.equal(event.latest_comment.author, 'Reviewer');
  assert.equal(event.latest_comment.at, '2026-10-30T09:30:00Z');
  assert.equal(event.latest_comment.body.length, 200);
  assert.equal(event.latest_comment.body, newest.body.slice(0, 200));
  assert.equal(
    event.excerpt,
    `Wire the morning brief · open · CI success · ${newest.body.slice(0, 60)}`,
  );
  assert.ok(event.excerpt.length <= 300);
});

test('get returns the observation for a ref, and the same excerpt it listed', async () => {
  const { source } = makeSource(loadFixture('ok'));
  const { events } = await source.list(SINCE);
  const listed = events[0];

  const fetched = await source.get(listed.ref);
  assert.equal(fetched.ref, listed.ref);
  assert.equal(fetched.excerpt, listed.excerpt);
  assert.deepEqual(fetched.why, ['direct']);
  assert.equal(fetched.ci.state, 'success');
});

test('get returns null for an object that is gone, and refuses a malformed ref', async () => {
  const { source } = makeSource([
    {
      path: `/repos/${REPO}/pulls/99`,
      status: 404,
      json: { message: 'Not Found' },
    },
  ]);

  assert.equal(await source.get('github:pr/open-x-agents/openDigitalMate/99'), null);
  await assert.rejects(
    () => source.get('github:pr/41'),
    (error) => error instanceof RangeError && error.code === 'E_BAD_REF',
  );
});
