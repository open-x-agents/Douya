// 探针的测试：参数、输出形状、失败路径。
//
// 一条真请求都不发：拿得倒假 fetch（test/fixtures/github 的路由表）和临时目录，
// CLI 那几条用 --fixture 走同一条离线路径。没有 token 的那条更是刻意把三个环境变量
// 都摘掉 —— 它要证明「没 token」是一个有名字的缺口，不是一次崩溃。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGithubSource } from '../src/sources/github.js';
import { UsageError, parseArgs, parseRepos, parseSince, probe } from '../scripts/source-probe.mjs';
import { createFakeFetch, loadFixture } from './fixtures/github/fetch.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PROBE = join(ROOT, 'scripts', 'source-probe.mjs');
const NOW = new Date('2026-10-30T09:00:00Z');
const SINCE = new Date('2026-10-29T00:00:00Z');
const CANONICAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// 测试里不许有真 token 可用：凡是 `*TOKEN` 的环境变量一律摘掉（连父进程那份也不留），
// 这样「没有 token」那条用例测的是真的没有，而不是碰运气。
const CLEAN_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !/TOKEN$/i.test(key)),
);

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'odm-probe-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fixtureSource(name, { now = NOW } = {}) {
  const fake = createFakeFetch(loadFixture(name));
  const source = createGithubSource({
    token: 'fixture-token',
    fetch: fake.fetch,
    sleep: async () => {},
    now: () => now.getTime(),
  });
  return { source, fake };
}

function runProbe(args, env = CLEAN_ENV) {
  return spawnSync(process.execPath, [PROBE, ...args], { cwd: ROOT, env, encoding: 'utf8' });
}

test('the argument parser keeps the repo allowlist and the window it was given', () => {
  const options = parseArgs(['--repo', 'open-x-agents/Douya', '--since', '24h', '--json']);
  assert.deepEqual(options.repos, ['open-x-agents/Douya']);
  assert.equal(options.since, '24h');
  assert.equal(options.json, true);
  assert.equal(options.fixture, null);
  assert.equal(options.dir, null);
});

test('a repeated repo is counted once, and two repos add up', () => {
  assert.deepEqual(parseArgs(['--repo', 'a/b,a/b', '--repos', 'c/d']).repos, ['a/b', 'c/d']);
  assert.deepEqual(parseRepos(null), []);
});

test('an unknown flag is a refusal, not a silent default', () => {
  assert.throws(() => parseArgs(['--nope']), UsageError);
  assert.throws(() => parseArgs(['--since']), UsageError);
});

test('a malformed repo or an unreadable --since is refused before any request', () => {
  assert.throws(() => parseRepos('Douya'), UsageError);
  assert.throws(() => parseRepos('open-x-agents/'), UsageError);
  assert.throws(() => parseSince('yesterday', NOW), UsageError);
});

test('--since 24h means the day before now, and an ISO instant is kept as it is', () => {
  assert.equal(parseSince('24h', NOW).toISOString(), '2026-10-29T09:00:00.000Z');
  assert.equal(parseSince('1d', NOW).toISOString(), '2026-10-29T09:00:00.000Z');
  assert.equal(parseSince('2026-10-29T00:00:00Z', NOW).toISOString(), '2026-10-29T00:00:00.000Z');
  assert.equal(parseSince(null, NOW), null);
});

test('the probe reports the window, the counts and the watermark path', async (t) => {
  const dir = tempDir(t);
  const { source, fake } = fixtureSource('ok');
  const payload = await probe({ source, dir, since: SINCE, repos: ['open-x-agents/Douya'], now: NOW });

  assert.equal(payload.source, 'github');
  assert.match(payload.since, CANONICAL);
  assert.match(payload.until, CANONICAL);
  assert.equal(payload.since, '2026-10-29T00:00:00.000Z');
  assert.equal(payload.until, '2026-10-30T09:00:00.000Z');
  assert.equal(payload.fetched, 1);
  assert.equal(payload.created, 1);
  assert.equal(payload.appended, 4);
  assert.equal(payload.events, 1);
  assert.deepEqual(payload.refs, ['github:pr/open-x-agents/Douya/41']);
  assert.equal(payload.complete, true);
  assert.deepEqual(payload.missing, []);
  assert.equal(payload.gap_text, '');
  assert.equal(payload.watermark, join(dir, 'sources', 'github.json'));
  assert.equal(payload.ledger_lines, 4);
  assert.ok(existsSync(payload.watermark));
  assert.ok(fake.calls.length > 0);
  for (const call of fake.calls) assert.ok(call.method === 'GET' || call.method === undefined);
});

test('a repo outside the allowlist is not written', async (t) => {
  const dir = tempDir(t);
  const { source } = fixtureSource('ok');
  const payload = await probe({ source, dir, since: SINCE, repos: ['someone/else'], now: NOW });

  assert.equal(payload.fetched, 0);
  assert.equal(payload.created, 0);
  assert.deepEqual(payload.refs, []);
  assert.equal(payload.ledger_lines, 0);
  assert.equal(payload.complete, true);
});

test('the probe replays a fixture offline and prints the event count', (t) => {
  const dir = tempDir(t);
  const run = runProbe([
    '--fixture',
    'test/fixtures/github/ok',
    '--since',
    '2026-10-29T00:00:00Z',
    '--dir',
    dir,
    '--json',
  ]);

  assert.equal(run.status, 0, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.ok(payload.events >= 1);
  assert.equal(payload.fetched, 1);
  assert.equal(payload.ledger_lines, 4);
  assert.equal(payload.watermark, join(dir, 'sources', 'github.json'));
});

test('the probe names the missing source when the read fails', (t) => {
  const dir = tempDir(t);
  const run = runProbe(['--fixture', 'test/fixtures/github/offline', '--dir', dir, '--json']);

  // 缺源不是 CLI 崩溃：退出 0，缺口写在结果里。
  assert.equal(run.status, 0, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.complete, false);
  assert.equal(payload.fetched, 0);
  assert.equal(payload.gap_text, 'GitHub 超时，这一份缺了');
  assert.equal(payload.missing[0].kind, 'timeout');
});

test('a missing token is a named gap, not a crash', (t) => {
  const dir = tempDir(t);
  const run = runProbe(['--repo', 'open-x-agents/Douya', '--dir', dir, '--json']);

  assert.equal(run.status, 0, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.complete, false);
  assert.equal(payload.since, null);
  assert.equal(payload.gap_text, 'GitHub 没连上：没有 token');
  assert.deepEqual(payload.missing[0], { source: 'github', kind: 'auth', reason: 'missing' });
});

test('the text output carries the window, the counts and the watermark path', (t) => {
  const dir = tempDir(t);
  const run = runProbe(['--fixture', 'test/fixtures/github/ok', '--dir', dir, '--repo', 'open-x-agents/Douya']);

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /since\s+2026-/);
  assert.match(run.stdout, /until\s+2026-/);
  assert.match(run.stdout, /读到\s+1 条：新 1/);
  assert.match(run.stdout, new RegExp(`水位\\s+${join(dir, 'sources', 'github.json')}`));
  assert.match(run.stdout, /完整\s+true/);
  assert.match(run.stdout, /缺口\s+无/);
});

test('a real error is the only thing that exits non-zero', (t) => {
  const dir = tempDir(t);
  const bad = runProbe(['--nope']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /看不懂的参数：--nope/);

  const missingFixture = runProbe(['--fixture', join(dir, 'no-such-fixture'), '--dir', dir]);
  assert.equal(missingFixture.status, 1);
  assert.match(missingFixture.stderr, /夹具不存在/);

  const badNow = runProbe(['--now', 'not-a-time', '--dir', dir]);
  assert.equal(badNow.status, 1);
  assert.match(badNow.stderr, /--now/);
});

test('a hand-written fixture is replayed through the same adapter, in a temp dir', (t) => {
  const dir = tempDir(t);
  const routes = join(dir, 'routes.json');
  const fixture = {
    routes: [
      { path: '/user', json: { login: 'Birfy' } },
      {
        path: '/issues',
        query: { filter: 'assigned', state: 'all' },
        json: [
          {
            number: 7,
            title: 'A hand-written fixture issue',
            state: 'open',
            html_url: 'https://github.com/acme/widgets/issues/7',
            repository: { full_name: 'acme/widgets' },
            user: { login: 'octo' },
            created_at: '2026-10-28T10:00:00Z',
            updated_at: '2026-10-30T08:00:00Z',
          },
        ],
      },
      { path: '/repos/acme/widgets/issues/7/comments', json: [] },
      { path: '/search/issues', json: { total_count: 0, items: [] } },
    ],
  };
  writeFileSync(routes, JSON.stringify(fixture));

  const run = runProbe(['--fixture', routes, '--dir', join(dir, 'data'), '--repo', 'acme/widgets', '--json']);
  assert.equal(run.status, 0, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.fetched, 1);
  assert.deepEqual(payload.refs, ['github:issue/acme/widgets/7']);
  assert.equal(payload.complete, true);
  // issue 没有 check run、也没有评论：证据只有 title 与 state 两行。
  assert.equal(payload.ledger_lines, 2);
  assert.equal(readFileSync(payload.ledger, 'utf8').trim().split('\n').length, 2);
});
