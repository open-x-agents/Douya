// 信源适配器的只读契约。这里只有形状、错误分类和文案，不联网、不写盘。
//
// 一个 Source 恰好暴露五个只读成员；写能力在接口层就不存在，assertSource() 会把
// 后来长出来的写方法当场拒掉。事件 id 与 ref 由本模块给出，raw event 的具体读取
// 留给各信源的适配器（GitHub 在 github.js）。

import { createHash } from 'node:crypto';

export const READ_SCOPES = ['metadata', 'body'];
export const READ_MEMBERS = ['id', 'readScope', 'auth', 'list', 'get'];
export const SOURCE_ERROR_KINDS = ['auth', 'rate_limit', 'partial', 'timeout', 'http'];
export const GITHUB_OBJECTS = ['issue', 'pr'];

// 与 src/core/event.js 的 EXTERNAL_REF 一致：type: 之后的字符集不含 '#'。
export const EXTERNAL_REF = /^[A-Za-z0-9_.@/+~-]+$/;

const HARD_KEY = /^[A-Za-z0-9_.-]+:[A-Za-z0-9_.@/+~-]+$/;
const GITHUB_REF = /^github:(issue|pr)\/([A-Za-z0-9_.@+~-]+)\/([A-Za-z0-9_.@+~-]+)\/([1-9][0-9]*)$/;
const WRITE_MEMBER = /^(create|update|comment|delete|write|post|patch|put|remove|merge|close|label|assign)/i;
const SOURCE_LABELS = { github: 'GitHub' };

export class SourceContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SourceContractError';
    this.code = code;
  }
}

export class SourceError extends Error {
  constructor(kind, message, { reason = null, status = null, retryAfterMs = null, url = null } = {}) {
    if (!SOURCE_ERROR_KINDS.includes(kind)) {
      throw new SourceContractError(
        'E_SOURCE_KIND',
        `unknown source error kind '${String(kind)}': expected one of ${SOURCE_ERROR_KINDS.join(', ')}`,
      );
    }
    super(message || `${kind} error`);
    this.name = 'SourceError';
    this.kind = kind;
    this.reason = reason;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.url = url;
    this.code = `E_SOURCE_${kind.toUpperCase()}`;
  }
}

function badRef(ref, why) {
  const error = new RangeError(`ref '${String(ref)}' is not usable: ${why}`);
  error.code = 'E_BAD_REF';
  return error;
}

export function githubRef({ object, repo, number } = {}) {
  if (!GITHUB_OBJECTS.includes(object)) throw badRef(object, `object must be one of ${GITHUB_OBJECTS.join(', ')}`);
  const parts = typeof repo === 'string' ? repo.split('/') : [];
  if (parts.length !== 2 || !EXTERNAL_REF.test(parts[0]) || !EXTERNAL_REF.test(parts[1])) {
    throw badRef(repo, 'repo must be <owner>/<name>');
  }
  if (!Number.isSafeInteger(number) || number <= 0) throw badRef(number, 'number must be a positive integer');
  return `github:${object}/${repo}/${number}`;
}

export function parseGithubRef(ref) {
  if (typeof ref !== 'string') throw badRef(ref, 'ref must be a string');
  const match = ref.match(GITHUB_REF);
  if (!match) throw badRef(ref, 'expected github:<issue|pr>/<owner>/<name>/<number>');
  const number = Number(match[4]);
  if (!Number.isSafeInteger(number)) throw badRef(ref, 'number is too large');
  return { object: match[1], repo: `${match[2]}/${match[3]}`, number };
}

export function eventIdForRef(ref) {
  if (typeof ref !== 'string' || !HARD_KEY.test(ref)) throw badRef(ref, 'expected a hard key such as github:pr/<owner>/<name>/<number>');
  return `evt_${createHash('sha1').update(ref).digest('hex').slice(0, 10)}`;
}

export function assertSource(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new SourceContractError('E_SOURCE_SHAPE', 'a source must be an object');
  }
  for (const member of READ_MEMBERS) {
    if (!(member in source)) throw new SourceContractError('E_SOURCE_SHAPE', `a source is missing '${member}'`);
  }
  if (typeof source.id !== 'string' || source.id.trim() === '') {
    throw new SourceContractError('E_SOURCE_SHAPE', "a source's id must be a non-empty string");
  }
  if (!READ_SCOPES.includes(source.readScope)) {
    throw new SourceContractError('E_SOURCE_SHAPE', `readScope must be one of ${READ_SCOPES.join(', ')}`);
  }
  for (const method of ['auth', 'list', 'get']) {
    if (typeof source[method] !== 'function') throw new SourceContractError('E_SOURCE_SHAPE', `'${method}' must be a function`);
  }
  for (const [name, value] of Object.entries(source)) {
    if (typeof value === 'function' && WRITE_MEMBER.test(name)) {
      throw new SourceContractError('E_SOURCE_WRITE_METHOD', `'${name}' is a write method: a source is read-only`);
    }
  }
  return source;
}

function sourceLabel(gap) {
  return SOURCE_LABELS[gap.source] || String(gap.source || '信源');
}

export function describeSourceGap(gap) {
  const label = sourceLabel(gap);
  switch (gap.kind) {
    case 'auth':
      if (gap.reason === 'missing') return `${label} 没连上：没有 token`;
      if (gap.reason === 'expired') return `${label} 凭据失效了`;
      if (gap.reason === 'scope') return `${label} 权限不够`;
      return `${label} 凭据有问题`;
    case 'rate_limit': {
      const ms = Number(gap.retryAfterMs);
      if (Number.isFinite(ms) && ms > 0) return `${label} 限流，${Math.ceil(ms / 1000)} 秒后再取`;
      return `${label} 限流，稍后再取`;
    }
    case 'timeout':
      return `${label} 超时，这一份缺了`;
    case 'http':
      return `${label} 报错（HTTP ${gap.status ?? '?'}）`;
    case 'partial':
      return `${label} 有一项没取到：${gap.ref || gap.reason || gap.detail || '未知项'}`;
    default:
      return `${label} 有一项没取到：${gap.reason || String(gap.kind)}`;
  }
}

export function describeSourceGaps(missing) {
  const gaps = Array.isArray(missing) ? missing : [missing];
  return gaps.filter(Boolean).map(describeSourceGap).join('；');
}
