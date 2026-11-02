// 把一次信源观察写进 #9 的事件库与证据账本。
//
// 这一层只做口径，不做合并规则：#9 的 upsertEvent()/appendEvidence() 决定同一条事件怎么
// 合、同一条证据怎么去重，这里决定「从哪里开始读、什么进事件、什么进账本、这次算不算
// 读完」。两件会变的东西（标题 / 状态 / CI / 评论）只进只追加的账本，事件里的 source 用
// 不可变的 created_at + 身份串，否则 mergeEvent() 第二天会因为 E_SOURCE_CONFLICT 写不进去。
//
// 失败不抛：四类 SourceError 变成 complete:false + missing + gap_text，早报据此标出缺源
// 而不是变成空白。非 SourceError 的编程错误照常抛。

import path from 'node:path';

import { atomicWriteJson, readTextOrNull, withDataLock } from '../core/atomic.js';
import { toUtcInstant } from '../core/event.js';
import { appendEvidence } from '../core/ledger.js';
import { createEventStore } from '../core/store.js';
import { SourceError, describeSourceGaps, eventIdForRef } from './contract.js';

const SOURCES_DIR = 'sources';
const DEFAULT_OVERLAP_MS = 3_600_000;
const DEFAULT_WINDOW_MS = 86_400_000;
const TITLE_MAX = 300;
const EVIDENCE_MAX = 200;

function clip(text, limit) {
  const value = String(text ?? '');
  return value.length > limit ? value.slice(0, limit) : value;
}

// 一条观察上的时刻已经是 GitHub 的 `…Z`；归一成事件模型的规范形式，坏时刻在这一层就暴露。
function canonical(value) {
  return value === null || value === undefined ? null : toUtcInstant(value);
}

function identityOf(observation) {
  return `${observation.repo} ${observation.object} #${observation.number}`;
}

function watermarkFile(dir, id) {
  return path.join(dir, SOURCES_DIR, `${id}.json`);
}

// 水位文件是这次跑到哪的记号，不是事件的第二份真相：读不出来就当作没跑过，
// 回落到默认窗口重跑一遍 —— 幂等保证重跑不会翻倍。
async function readWatermark(file) {
  const text = await readTextOrNull(file);
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (typeof parsed.since !== 'string' || Number.isNaN(new Date(parsed.since).getTime())) return null;
    return parsed;
  } catch {
    return null;
  }
}

function gapOf(sourceId, error) {
  return {
    source: sourceId,
    kind: error.kind,
    reason: error.reason ?? null,
    status: error.status ?? null,
    retryAfterMs: error.retryAfterMs ?? null,
  };
}

function stateOf(observation) {
  if (observation.state === 'open' || observation.state === 'closed') return observation.state;
  return observation.state === 'waiting_other' ? 'waiting_other' : 'unknown';
}

// 事件：首次观察的快照。source 只放不会随评论 / CI / 状态变化的东西 ——
// at 是 created_at，excerpt 是身份串，这样同一对象每天重跑都能合进同一条。
function eventOf(observation, fallbackAt) {
  const ref = observation.ref;
  const type = ref.slice(0, ref.indexOf(':'));
  const state = stateOf(observation);
  const at = canonical(observation.created_at) ?? canonical(observation.at) ?? fallbackAt;
  const title = clip(String(observation.title ?? '').trim(), TITLE_MAX) || identityOf(observation);
  const event = {
    id: eventIdForRef(ref),
    kind: observation.object === 'pr' ? 'pr' : 'issue',
    title,
    state,
    due_at: null,
    sources: [
      {
        type,
        ref,
        at,
        read_scope: observation.read_scope === 'body' ? 'body' : 'metadata',
        excerpt: identityOf(observation),
      },
    ],
    closure: null,
  };
  if (state === 'closed') {
    event.closure = {
      by: 'github',
      at: canonical(observation.closed_at) ?? canonical(observation.at) ?? fallbackAt,
      evidence_ref: ref,
    };
  }
  return event;
}

// 证据：会变的东西逐条追加，最多四条。跳过键是 (event_id, field, source_ref, excerpt_hash)，
// 所以同一窗口重跑 appended 为 0。
function evidenceOf(observation, fallbackAt) {
  const at = canonical(observation.at) ?? canonical(observation.created_at) ?? fallbackAt;
  const ref = observation.ref;
  const type = ref.slice(0, ref.indexOf(':'));
  const base = { type, ref, at, read_scope: 'metadata' };
  const rows = [
    { field: 'title', excerpt: clip(String(observation.title ?? '').trim(), EVIDENCE_MAX) || identityOf(observation) },
    { field: 'state', excerpt: `state: ${stateOf(observation)}` },
  ];
  if (observation.object === 'pr' && observation.ci && observation.ci.state && observation.ci.state !== 'none') {
    rows.push({ field: 'ci', excerpt: clip(`CI ${observation.ci.name ?? 'checks'}: ${observation.ci.state}`, EVIDENCE_MAX) });
  }
  if (observation.latest_comment) {
    const author = observation.latest_comment.author ?? 'unknown';
    rows.push({
      field: 'comment',
      excerpt: clip(`最新意见 @${author}: ${clip(observation.latest_comment.body ?? '', EVIDENCE_MAX)}`, EVIDENCE_MAX),
    });
  }
  return rows.map((row) => ({ field: row.field, source: { ...base, excerpt: row.excerpt } }));
}

// 观察 -> 事件 + 证据。水位只在「读完了」时前进；四类错误和 partial 一律不动水位，
// 下一次重跑同一窗口由幂等兜住。
export async function ingestSource({
  source,
  dir,
  since = null,
  now = () => new Date(),
  overlapMs = DEFAULT_OVERLAP_MS,
  windowMs = DEFAULT_WINDOW_MS,
  store = null,
} = {}) {
  if (!source || typeof source !== 'object') throw new TypeError('ingestSource needs a source');
  if (typeof dir !== 'string' || dir === '') throw new TypeError('ingestSource needs a data directory');

  const startedAt = new Date(now());
  if (Number.isNaN(startedAt.getTime())) throw new RangeError('now() is not a valid instant');
  const until = startedAt.toISOString();
  const id = typeof source.id === 'string' && source.id !== '' ? source.id : 'github';
  const file = watermarkFile(dir, id);
  const result = {
    source: id,
    complete: false,
    missing: [],
    gap_text: '',
    since: null,
    until,
    cursor: null,
    fetched: 0,
    created: 0,
    merged: 0,
    appended: 0,
    skipped: 0,
    events: [],
  };

  // auth() 不联网；没有 token 在这里就有话说，不发请求。
  let auth;
  try {
    auth = source.auth() ?? { ok: true };
  } catch (error) {
    if (!(error instanceof SourceError)) throw error;
    result.missing = [gapOf(id, error)];
    result.gap_text = describeSourceGaps(result.missing);
    return result;
  }
  if (!auth.ok) {
    result.missing = [{ source: id, kind: 'auth', reason: auth.reason ?? 'missing' }];
    result.gap_text = describeSourceGaps(result.missing);
    return result;
  }

  const watermark = await readWatermark(file);
  const requested = since ?? watermark?.since ?? null;
  const start = requested === null ? new Date(startedAt.getTime() - windowMs) : new Date(requested);
  if (Number.isNaN(start.getTime())) throw new RangeError(`since is not a valid instant: ${String(requested)}`);
  result.since = start.toISOString();

  const observations = [];
  const gaps = [];
  let cursor = null;
  try {
    for (;;) {
      const page = (await source.list(start, cursor)) ?? {};
      if (Array.isArray(page.events)) observations.push(...page.events);
      if (Array.isArray(page.partial)) gaps.push(...page.partial);
      cursor = page.next ?? null;
      if (!cursor) break;
      // 撞页数上限时适配器已经把 next 递回来了；再跟下去只会一直撞同一道墙。
      if (gaps.some((gap) => gap.reason === 'page-cap')) break;
    }
  } catch (error) {
    if (!(error instanceof SourceError)) throw error;
    result.missing = [gapOf(id, error)];
    result.gap_text = describeSourceGaps(result.missing);
    return result;
  }

  result.fetched = observations.length;
  const eventStore = store ?? createEventStore({ dir, now });

  for (const observation of observations) {
    const eventId = eventIdForRef(observation.ref);
    const { event, created, merged } = await eventStore.upsertEvent(eventOf(observation, until));
    if (created) result.created += 1;
    if (merged) result.merged += 1;
    result.events.push(event);

    for (const row of evidenceOf(observation, until)) {
      const { appended, skipped } = await appendEvidence({
        dir,
        eventId,
        field: row.field,
        sources: [row.source],
        now: startedAt,
      });
      result.appended += appended;
      result.skipped += skipped;
    }
  }

  if (cursor === null && gaps.length === 0) {
    const nextSince = new Date(new Date(until).getTime() - overlapMs).toISOString();
    await withDataLock(dir, () =>
      atomicWriteJson(file, { id, since: nextSince, until, cursor: null, complete: true, at: until }),
    );
    result.complete = true;
    result.cursor = null;
  } else {
    result.complete = false;
    result.missing = gaps.map((gap) => ({ ...gap, source: gap.source ?? id }));
    result.gap_text = describeSourceGaps(result.missing);
    result.cursor = cursor;
  }

  return result;
}
