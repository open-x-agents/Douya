import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  READ_MEMBERS,
  SourceContractError,
  SourceError,
  assertSource,
  describeSourceGaps,
  eventIdForRef,
  githubRef,
  parseGithubRef,
} from '../src/sources/contract.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = join(HERE, '..', 'src', 'sources');

function javascriptFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return javascriptFiles(path);
    return entry.name.endsWith('.js') ? [path] : [];
  });
}

function readOnlySource(overrides = {}) {
  return {
    id: 'github',
    readScope: 'metadata',
    auth() {
      return { ok: true };
    },
    list() {
      return { events: [] };
    },
    get() {
      return null;
    },
    ...overrides,
  };
}

test('every source exposes only the read members', () => {
  const source = readOnlySource();
  assertSource(source);
  assert.deepEqual(Object.keys(source).sort(), [...READ_MEMBERS].sort());
});

test('a source that grows a write method is refused', () => {
  const source = readOnlySource({ comment() {} });
  assert.throws(
    () => assertSource(source),
    (error) =>
      error instanceof SourceContractError &&
      error.code === 'E_SOURCE_WRITE_METHOD' &&
      /comment/.test(error.message),
  );
});

test('an error kind the contract does not name is refused', () => {
  assert.throws(
    () => new SourceError('banana', 'not a kind'),
    (error) => error instanceof SourceContractError && error.code === 'E_SOURCE_KIND',
  );

  const rateLimit = new SourceError('rate_limit', 'slow down', { retryAfterMs: 30_000, status: 429 });
  assert.equal(rateLimit.code, 'E_SOURCE_RATE_LIMIT');
  assert.equal(rateLimit.kind, 'rate_limit');
  assert.equal(rateLimit.status, 429);
  assert.equal(rateLimit.retryAfterMs, 30_000);
});

test('a missing token is an auth gap, not a crash', () => {
  const source = readOnlySource({
    auth() {
      return { ok: false, reason: 'missing' };
    },
  });

  const auth = source.auth();
  const gap = { source: source.id, kind: 'auth', reason: auth.reason };
  assert.doesNotThrow(() => describeSourceGaps([gap]));
  assert.equal(describeSourceGaps([gap]), 'GitHub 没连上：没有 token');
});

test('the source layer contains no request that is not a GET', () => {
  // src/sources/ 下现在还有别的信源族：Composio 的传输层（#32）按设计向 Composio 的
  // /tools/execute 发 POST，它的写面由注册表白名单单独把关。本契约的只读扫描只管
  // 与 contract 同级的适配器（contract.js、github.js …）。
  const files = javascriptFiles(SOURCE_DIR).filter((file) => dirname(file) === SOURCE_DIR);
  assert.ok(files.length >= 1, 'the source layer has at least the contract module');

  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /'(POST|PATCH|PUT|DELETE)'/, `${file} must not carry a write verb`);
    assert.doesNotMatch(text, /"(POST|PATCH|PUT|DELETE)"/, `${file} must not carry a write verb`);
    for (const match of text.matchAll(/method\s*:\s*['"]([A-Za-z]+)['"]/g)) {
      assert.equal(match[1].toUpperCase(), 'GET', `${file} must only issue GET requests`);
    }
  }
});

test("the github ref names the repo, so two repos' number 10 never collide", () => {
  const mine = githubRef({ object: 'issue', repo: 'open-x-agents/Douya', number: 10 });
  const other = githubRef({ object: 'issue', repo: 'ThinkFlowLab/FlyBot', number: 10 });

  assert.notEqual(mine, other);
  assert.equal(parseGithubRef(mine).repo, 'open-x-agents/Douya');
  assert.equal(parseGithubRef(other).repo, 'ThinkFlowLab/FlyBot');
});

test('a ref round-trips through parse and back, and a malformed ref is refused', () => {
  const ref = githubRef({ object: 'pr', repo: 'open-x-agents/Douya', number: 10 });
  const parsed = parseGithubRef(ref);

  assert.deepEqual(parsed, { object: 'pr', repo: 'open-x-agents/Douya', number: 10 });
  assert.equal(githubRef(parsed), ref);
  assert.equal(eventIdForRef(ref), eventIdForRef(githubRef(parsed)));
  assert.match(eventIdForRef(ref), /^evt_[A-Za-z0-9_-]{1,64}$/);

  for (const malformed of [
    'github:pr/41',
    'github:pr/open-x-agents/Douya/10#',
    'github:merge/open-x-agents/Douya/10',
    'github:pr/open-x-agents/Douya/0',
    'not-a-ref',
    '',
  ]) {
    assert.throws(
      () => parseGithubRef(malformed),
      (error) => error instanceof RangeError && error.code === 'E_BAD_REF',
      malformed,
    );
  }
});

test('a failed run still says, in words, which source is missing and why', () => {
  const missing = (kind, extra = {}) => describeSourceGaps([{ source: 'github', kind, ...extra }]);

  assert.equal(missing('auth', { reason: 'missing' }), 'GitHub 没连上：没有 token');
  assert.equal(missing('auth', { reason: 'expired' }), 'GitHub 凭据失效了');
  assert.equal(missing('auth', { reason: 'scope' }), 'GitHub 权限不够');
  assert.equal(missing('rate_limit', { retryAfterMs: 30_000 }), 'GitHub 限流，30 秒后再取');
  assert.equal(missing('timeout'), 'GitHub 超时，这一份缺了');
  assert.equal(missing('http', { status: 500 }), 'GitHub 报错（HTTP 500）');
  assert.equal(missing('partial', { ref: 'github:pr/open-x-agents/Douya/10' }), 'GitHub 有一项没取到：github:pr/open-x-agents/Douya/10');
});
