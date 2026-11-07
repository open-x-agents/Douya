import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SourceError, eventIdForRef } from '../src/sources/contract.js';
import { ingestSource } from '../src/sources/ingest.js';
import { createEventStore } from '../src/core/store.js';
import { explain } from '../src/core/ledger.js';

const REF = 'github:pr/open-x-agents/openDigitalMate/10';
const EVENT_ID = eventIdForRef(REF);
const SINCE = '2026-10-29T09:00:00Z';
const UNTIL = '2026-10-30T09:00:00Z';

// 一页观察，形状与 src/sources/github.js 的 RawEvent 逐字段一致。
function pullRequest(overrides = {}) {
  return {
    source: 'github',
    object: 'pr',
    repo: 'open-x-agents/openDigitalMate',
    number: 10,
    external_id: 'open-x-agents/openDigitalMate/10',
    ref: REF,
    title: '阶段一 · 信源适配器契约',
    project: 'openDigitalMate',
    people: ['Birfy'],
    at: '2026-10-30T12:51:12Z',
    due_at: null,
    due_kind: null,
    amount: null,
    state: 'open',
    read_scope: 'metadata',
    excerpt: '阶段一 · 信源适配器契约 · open · CI success',
    html_url: 'https://github.com/open-x-agents/openDigitalMate/pull/10',
    why: ['assigned'],
    ci: { state: 'success', name: 'tests', at: '2026-10-30T12:51:27Z' },
    latest_comment: { id: 9001, author: 'Birfy', at: '2026-10-30T14:21:12Z', body: '这一页先这样' },
    created_at: '2026-10-30T09:00:00Z',
    closed_at: null,
    ...overrides,
  };
}

// 假信源：只有契约允许的成员，list() 按 cursor 索引翻页，调用记录留在这里。
function fakeSource({ pages = [], auth = { ok: true }, fail = null } = {}) {
  const calls = [];
  return {
    id: 'github',
    readScope: 'metadata',
    calls,
    auth() {
      return auth;
    },
    async list(since, cursor = null) {
      calls.push({ since: since instanceof Date ? since.toISOString() : since, cursor });
      if (fail) throw fail;
      const page = pages[cursor === null ? 0 : Number(cursor)] ?? { events: [] };
      return { events: page.events ?? [], next: page.next ?? null, ...(page.partial ? { partial: page.partial } : {}) };
    },
    async get() {
      return null;
    },
  };
}

async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ingest-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// 账本行的整份记录（explain() 只给出断言用得到的列，没有 event_id）。
async function ledgerLines(dir) {
  const text = await readFile(join(dir, 'ledger.jsonl'), 'utf8');
  return text
    .trimEnd()
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line));
}

const at = () => new Date();

test('one observation becomes one event and four evidence rows', async (t) => {
  const dir = await workspace(t);
  const source = fakeSource({ pages: [{ events: [pullRequest()] }] });

  const result = await ingestSource({ source, dir, since: SINCE, now: () => new Date(UNTIL) });

  assert.equal(result.complete, true);
  assert.equal(result.fetched, 1);
  assert.equal(result.created, 1);
  assert.equal(result.merged, 0);
  assert.equal(result.appended, 4);
  assert.equal(result.skipped, 0);
  assert.equal(result.events.length, 1);
  assert.equal(result.since, '2026-10-29T09:00:00.000Z');
  assert.equal(result.until, '2026-10-30T09:00:00.000Z');
  assert.equal(result.cursor, null);
  assert.equal(result.gap_text, '');

  const store = createEventStore({ dir });
  const events = await store.listEvents();
  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(event.id, EVENT_ID);
  assert.equal(event.kind, 'pr');
  assert.equal(event.state, 'open');
  assert.equal(event.title, '阶段一 · 信源适配器契约');
  assert.equal(event.sources.length, 1);
  const [quote] = event.sources;
  assert.equal(quote.type, 'github');
  assert.equal(quote.ref, REF);
  // 事件 source 是不可变的：created_at 与身份串，不写标题 / 状态 / CI。
  assert.equal(quote.at, '2026-10-30T09:00:00.000Z');
  assert.equal(quote.excerpt, 'open-x-agents/openDigitalMate pr #10');
  assert.equal(quote.read_scope, 'metadata');

  const rows = await ledgerLines(dir);
  assert.deepEqual(rows.map((row) => row.field), ['title', 'state', 'ci', 'comment']);
  // explain() 读回同一件事的同样四列。
  const explained = await explain({ dir, eventId: EVENT_ID });
  assert.deepEqual(
    explained.map((row) => [row.field, row.source_ref, row.at, row.excerpt_hash]),
    rows.map((row) => [row.field, row.source_ref, row.at, row.excerpt_hash]),
  );
  for (const row of rows) {
    assert.equal(row.event_id, EVENT_ID);
    assert.equal(row.source_ref, REF);
    assert.equal(row.at, '2026-10-30T12:51:12.000Z');
    assert.match(row.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  }
  const text = await readFile(join(dir, 'ledger.jsonl'), 'utf8');
  assert.equal(text.trimEnd().split('\n').length, 4);

  const watermark = JSON.parse(await readFile(join(dir, 'sources', 'github.json'), 'utf8'));
  assert.deepEqual(Object.keys(watermark).sort(), ['at', 'complete', 'cursor', 'id', 'since', 'until']);
  assert.equal(watermark.id, 'github');
  assert.equal(watermark.since, '2026-10-30T08:00:00.000Z');
  assert.equal(watermark.until, '2026-10-30T09:00:00.000Z');
  assert.equal(watermark.cursor, null);
  assert.equal(watermark.complete, true);
  assert.equal(watermark.at, '2026-10-30T09:00:00.000Z');
});

test('running the same window twice adds no event and no duplicate evidence', async (t) => {
  const dir = await workspace(t);
  const source = fakeSource({ pages: [{ events: [pullRequest()] }] });
  const run = () => ingestSource({ source, dir, since: SINCE, now: () => new Date(UNTIL) });

  await run();
  const first = await readFile(join(dir, 'ledger.jsonl'), 'utf8');
  const second = await run();
  const after = await readFile(join(dir, 'ledger.jsonl'), 'utf8');

  assert.equal(second.created, 0);
  assert.equal(second.merged, 1);
  assert.equal(second.appended, 0);
  assert.equal(second.skipped, 4);
  assert.equal(after, first);
  assert.equal((await createEventStore({ dir }).listEvents()).length, 1);
  assert.equal((await ledgerLines(dir)).length, 4);
});

test('an observation that changed adds a ledger row instead of rewriting one', async (t) => {
  const dir = await workspace(t);
  const first = fakeSource({ pages: [{ events: [pullRequest()] }] });
  await ingestSource({ source: first, dir, since: SINCE, now: () => new Date(UNTIL) });
  const before = await readFile(join(dir, 'ledger.jsonl'), 'utf8');

  const changed = pullRequest({ title: '改了标题', at: '2026-10-31T10:00:00Z' });
  const second = fakeSource({ pages: [{ events: [changed] }] });
  const result = await ingestSource({ source: second, dir, since: SINCE, now: () => new Date(UNTIL) });

  assert.equal(result.created, 0);
  assert.equal(result.merged, 1);
  assert.equal(result.appended, 1);
  assert.equal(result.skipped, 3);
  const after = await readFile(join(dir, 'ledger.jsonl'), 'utf8');
  assert.ok(after.startsWith(before), 'the four rows already on disk are untouched');

  const rows = await ledgerLines(dir);
  assert.equal(rows.length, 5);
  assert.equal(rows[4].field, 'title');
  assert.notEqual(rows[4].excerpt_hash, rows[0].excerpt_hash);
  // 事件标量是首次观察的快照；变化只进账本（状态迁移的渲染是 #13/#15 的事）。
  const [event] = await createEventStore({ dir }).listEvents();
  assert.equal(event.title, '阶段一 · 信源适配器契约');
});

test('a closed pull request is stored closed, with the evidence that closed it', async (t) => {
  const dir = await workspace(t);
  const closed = pullRequest({
    state: 'closed',
    at: '2026-10-30T15:00:00Z',
    closed_at: '2026-10-30T14:59:00Z',
    ci: null,
    latest_comment: null,
  });
  const source = fakeSource({ pages: [{ events: [closed] }] });

  const result = await ingestSource({ source, dir, since: SINCE, now: () => new Date(UNTIL) });

  assert.equal(result.created, 1);
  assert.equal(result.appended, 2);
  const [event] = await createEventStore({ dir }).listEvents();
  assert.equal(event.state, 'closed');
  assert.equal(event.closure.by, 'github');
  assert.equal(event.closure.at, '2026-10-30T14:59:00.000Z');
  assert.equal(event.closure.evidence_ref, REF);

  const rows = await ledgerLines(dir);
  assert.deepEqual(rows.map((row) => row.field), ['title', 'state']);
  assert.equal(rows[1].excerpt_hash, (await import('../src/core/event.js')).excerptHash('state: closed'));
});

test('a rate limit leaves the watermark alone, so the next run retries the same window', async (t) => {
  const dir = await workspace(t);
  const ok = fakeSource({ pages: [{ events: [pullRequest()] }] });
  await ingestSource({ source: ok, dir, since: SINCE, now: () => new Date(UNTIL) });
  const before = await readFile(join(dir, 'sources', 'github.json'), 'utf8');

  const limited = fakeSource({
    fail: new SourceError('rate_limit', 'too many', { status: 429, retryAfterMs: 30_000 }),
  });
  const result = await ingestSource({ source: limited, dir, now: () => new Date('2026-10-30T10:00:00Z') });

  assert.equal(result.complete, false);
  assert.equal(result.missing.length, 1);
  assert.equal(result.missing[0].kind, 'rate_limit');
  assert.equal(result.gap_text, 'GitHub 限流，30 秒后再取');
  assert.equal(result.since, '2026-10-30T08:00:00.000Z', 'the failed run still reads the watermark');
  assert.equal(result.fetched, 0);
  assert.equal(await readFile(join(dir, 'sources', 'github.json'), 'utf8'), before, 'the watermark did not move');
});

test('a blocked source says the sentence and leaves the watermark alone', async (t) => {
  const dir = await workspace(t);
  const source = fakeSource({
    fail: new SourceError('blocked', 'GitHub served a block page', { reason: 'header', status: 403 }),
  });

  const result = await ingestSource({ source, dir, since: SINCE, now: () => new Date(UNTIL) });

  assert.equal(result.complete, false);
  assert.equal(result.source, 'github');
  assert.equal(result.missing.length, 1);
  assert.equal(result.missing[0].kind, 'blocked');
  assert.equal(result.gap_text, 'GitHub 挡住了这次访问，我不会绕过它。');
  await assert.rejects(readFile(join(dir, 'sources', 'github.json'), 'utf8'), { code: 'ENOENT' });
});

test('after a finished window the watermark moves to the run time minus the overlap', async (t) => {
  const dir = await workspace(t);
  const source = fakeSource({ pages: [{ events: [] }] });

  const result = await ingestSource({ source, dir, since: SINCE, now: () => new Date(UNTIL) });

  assert.equal(result.complete, true);
  assert.equal(result.fetched, 0);
  const watermark = JSON.parse(await readFile(join(dir, 'sources', 'github.json'), 'utf8'));
  assert.equal(watermark.since, '2026-10-30T08:00:00.000Z');
  assert.equal(watermark.until, '2026-10-30T09:00:00.000Z');
  assert.equal(watermark.complete, true);
  assert.equal(watermark.cursor, null);
});

test('a 401 does not throw and does not go blank: the result names the missing source', async (t) => {
  const dir = await workspace(t);
  const source = fakeSource({ fail: new SourceError('auth', 'bad credentials', { reason: 'expired', status: 401 }) });

  const result = await ingestSource({ source, dir, since: SINCE, now: () => new Date(UNTIL) });

  assert.equal(result.complete, false);
  assert.equal(result.source, 'github');
  assert.equal(result.missing.length, 1);
  assert.equal(result.missing[0].source, 'github');
  assert.equal(result.missing[0].kind, 'auth');
  assert.equal(result.missing[0].reason, 'expired');
  assert.equal(result.gap_text, 'GitHub 凭据失效了');
  assert.equal(result.fetched, 0);
  assert.deepEqual(result.events, []);
  await assert.rejects(readFile(join(dir, 'sources', 'github.json'), 'utf8'), { code: 'ENOENT' });
});

test('offline is reported the same way, and the result still names the gap', async (t) => {
  const dir = await workspace(t);
  const source = fakeSource({ fail: new SourceError('timeout', 'no answer after 3 retries') });

  const result = await ingestSource({ source, dir, since: SINCE, now: () => new Date(UNTIL) });

  assert.equal(result.complete, false);
  assert.equal(result.missing[0].kind, 'timeout');
  assert.equal(result.gap_text, 'GitHub 超时，这一份缺了');
  assert.equal(result.events.length, 0);
  await assert.rejects(readFile(join(dir, 'sources', 'github.json'), 'utf8'), { code: 'ENOENT' });
});

test('partial data is written and the gap is named on the result', async (t) => {
  const dir = await workspace(t);
  const source = fakeSource({
    pages: [
      {
        events: [pullRequest()],
        next: 'page-2',
        partial: [{ kind: 'partial', reason: 'page-cap', source: 'github' }],
      },
    ],
  });

  const result = await ingestSource({ source, dir, since: SINCE, now: () => new Date(UNTIL) });

  assert.equal(result.complete, false);
  assert.equal(result.cursor, 'page-2');
  assert.equal(result.missing[0].kind, 'partial');
  assert.equal(result.missing[0].reason, 'page-cap');
  assert.equal(result.gap_text, 'GitHub 有一项没取到：page-cap');
  // 已经读到的照写，缺的那部分只标注，不把这一天变成空的。
  assert.equal(result.created, 1);
  assert.equal(result.appended, 4);
  assert.equal((await createEventStore({ dir }).listEvents()).length, 1);
  await assert.rejects(readFile(join(dir, 'sources', 'github.json'), 'utf8'), { code: 'ENOENT' });
});

test('a missing token is a gap the run reports without asking the network', async (t) => {
  const dir = await workspace(t);
  const source = fakeSource({ auth: { ok: false, reason: 'missing' } });

  const result = await ingestSource({ source, dir });

  assert.equal(source.calls.length, 0);
  assert.equal(result.complete, false);
  assert.equal(result.gap_text, 'GitHub 没连上：没有 token');
  assert.equal(result.missing[0].reason, 'missing');
});

test('a programming error is not swallowed as a missing source', async (t) => {
  const dir = await workspace(t);
  const source = fakeSource();
  source.list = async () => {
    throw new TypeError('adapter bug');
  };

  await assert.rejects(ingestSource({ source, dir, since: SINCE, now: at }), { name: 'TypeError' });
});

test('two pages of one window are written once each', async (t) => {
  const dir = await workspace(t);
  const other = pullRequest({
    object: 'issue',
    number: 11,
    ref: 'github:issue/open-x-agents/openDigitalMate/11',
    external_id: 'open-x-agents/openDigitalMate/11',
    title: '一个问题',
    ci: null,
    latest_comment: null,
    created_at: '2026-10-30T10:00:00Z',
  });
  const source = fakeSource({
    pages: [{ events: [pullRequest()], next: '1' }, { events: [other] }],
  });

  const result = await ingestSource({ source, dir, since: SINCE, now: () => new Date(UNTIL) });

  assert.equal(result.fetched, 2);
  assert.equal(result.created, 2);
  assert.equal(result.complete, true);
  assert.equal((await createEventStore({ dir }).listEvents()).length, 2);
  assert.equal(source.calls.length, 2);
  assert.equal(source.calls[1].cursor, '1');
});
