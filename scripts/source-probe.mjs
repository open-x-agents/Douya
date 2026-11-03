#!/usr/bin/env node
// 信源探针：用 token 跑一次 GitHub 只读摄取，把这次读到了什么打到 stdout。
//
//   node scripts/source-probe.mjs --repo open-x-agents/openDigitalMate
//   node scripts/source-probe.mjs --repo open-x-agents/openDigitalMate --since 24h --json
//   node scripts/source-probe.mjs --fixture test/fixtures/github/ok --since 2026-10-29T00:00:00Z --dir /tmp/probe
//
// 它只做三件事：把参数变成一次 ingestSource()、把结果按人 / 机器两种形状打出来、
// 把「缺源」写成 missing / gap_text。它不写 GitHub 上的任何对象 —— 请求层在
// src/sources/github.js，那里没有 method 参数，只发 GET。
//
// 退出码只有两种：0 = 跑完了（完整、或者缺源但把缺口说清楚了）；1 = 真错误
// （参数看不懂、夹具不存在、写盘失败）。缺一份源不该等于命令失败，那是数据层的
// missing，不是 CLI 崩了。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { EXTERNAL_REF } from '../src/sources/contract.js';
import { createGithubSource } from '../src/sources/github.js';
import { ingestSource } from '../src/sources/ingest.js';

export const USAGE = `用法：node scripts/source-probe.mjs [选项]

  --repo <owner/name>[,<owner/name>...]   只写这几个仓（默认：token 能看见的全部）
  --since <24h|<ISO 时刻>>                从哪儿开始读（默认：水位文件，其次 now-24h）
  --dir <目录>                            数据目录（默认：系统临时目录，不写仓库里的 data/）
  --fixture <夹具目录>                    离线重放 test/fixtures/github/<name>（不发任何真实请求）
  --now <ISO 时刻>                        把「现在」钉住，方便复现
  --json                                  只打一个 JSON 对象到 stdout
  --help                                  这段用法

没有 token 时不发请求：结果里 missing 是 auth/missing，退出码仍是 0。`;

const UNITS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const TOKEN_KEYS = ['DSH_SECRET_GITHUB_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN'];

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

function flagValue(argv, index, flag) {
  const value = argv[index];
  if (value === undefined || value.startsWith('--')) throw new UsageError(`${flag} 缺一个值`);
  return value;
}

export function parseRepos(value) {
  if (value === null || value === undefined) return [];
  const repos = String(value)
    .split(',')
    .map((repo) => repo.trim())
    .filter((repo) => repo !== '');
  for (const repo of repos) {
    const parts = repo.split('/');
    if (parts.length !== 2 || !EXTERNAL_REF.test(parts[0]) || !EXTERNAL_REF.test(parts[1])) {
      throw new UsageError(`--repo 要 <owner>/<name>：${repo}`);
    }
  }
  return repos;
}

export function parseSince(value, now) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  const relative = text.match(/^(\d+)([smhd])$/i);
  if (relative) {
    const amount = Number(relative[1]) * UNITS[relative[2].toLowerCase()];
    if (Number.isFinite(amount) && amount > 0) return new Date(now.getTime() - amount);
  }
  const at = Date.parse(text);
  if (Number.isNaN(at)) throw new UsageError(`--since 要 <数字>h 或 ISO 时刻：${value}`);
  return new Date(at);
}

export function parseArgs(argv) {
  const options = { repos: [], since: null, dir: null, fixture: null, now: null, json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--repo' || arg === '--repos') {
      index += 1;
      options.repos.push(...parseRepos(flagValue(argv, index, arg)));
    } else if (arg === '--since') {
      index += 1;
      options.since = flagValue(argv, index, arg);
    } else if (arg === '--dir') {
      index += 1;
      options.dir = flagValue(argv, index, arg);
    } else if (arg === '--fixture') {
      index += 1;
      options.fixture = flagValue(argv, index, arg);
    } else if (arg === '--now') {
      index += 1;
      options.now = flagValue(argv, index, arg);
    } else throw new UsageError(`看不懂的参数：${arg}`);
  }
  options.repos = [...new Set(options.repos)];
  return options;
}

function tokenFrom(env) {
  for (const key of TOKEN_KEYS) {
    const value = env[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return '';
}

// 只认 allowlist 里的仓：探针的 --repo 收窄的是「写进这次账本的范围」，
// 不是「更省请求」。请求照样发（适配器按三条流各读一页），写盘只写进来的这些。
function scoped(source, repos) {
  if (repos.length === 0) return source;
  const allowed = new Set(repos);
  const keep = (observation) => allowed.has(observation?.repo);
  return {
    ...source,
    list: async (since, cursor = null) => {
      const page = (await source.list(since, cursor)) ?? {};
      return { ...page, events: (page.events ?? []).filter(keep) };
    },
    get: async (ref) => {
      const observation = await source.get(ref);
      return observation && keep(observation) ? observation : null;
    },
  };
}

function countLines(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line !== '').length;
  } catch {
    return 0;
  }
}

export async function probe({ source, dir, since = null, repos = [], now = new Date() }) {
  const result = await ingestSource({ source: scoped(source, repos), dir, since, now: () => now });
  const ledger = path.join(dir, 'ledger.jsonl');
  return {
    source: result.source,
    repos,
    since: result.since,
    until: result.until,
    dir,
    watermark: path.join(dir, 'sources', `${result.source}.json`),
    ledger,
    ledger_lines: countLines(ledger),
    fetched: result.fetched,
    created: result.created,
    merged: result.merged,
    appended: result.appended,
    skipped: result.skipped,
    events: result.events.length,
    refs: result.events.map((event) => event.sources?.[0]?.ref ?? event.id),
    complete: result.complete,
    missing: result.missing,
    gap_text: result.gap_text,
  };
}

// 夹具重放：假 fetch 与路由表都在 test/ 下（不在发布包里），所以只有 --fixture 这条
// 路径会动态 import 它；正常路径不碰 test/。
export async function loadFixtureFetch(target) {
  const resolved = path.resolve(target);
  const file =
    fs.existsSync(resolved) && fs.statSync(resolved).isDirectory() ? path.join(resolved, 'routes.json') : resolved;
  if (!fs.existsSync(file)) throw new Error(`夹具不存在：${file}`);
  const routes = JSON.parse(fs.readFileSync(file, 'utf8'));
  const module = await import('../test/fixtures/github/fetch.mjs');
  return module.createFakeFetch(routes);
}

export function formatText(payload) {
  const scope = payload.repos.length > 0 ? payload.repos.join(', ') : '（token 能看见的全部）';
  const lines = [
    `GitHub 只读探针：${scope}`,
    `since  ${payload.since ?? '（没开始读）'}`,
    `until  ${payload.until}`,
    `dir    ${payload.dir}`,
    `水位   ${payload.watermark}`,
    `账本   ${payload.ledger}（${payload.ledger_lines} 行）`,
    `读到   ${payload.fetched} 条：新 ${payload.created} / 合并 ${payload.merged} / 证据 ${payload.appended} 条 / 跳过 ${payload.skipped}`,
    `完整   ${payload.complete}`,
    `缺口   ${payload.gap_text === '' ? '无' : payload.gap_text}`,
  ];
  return `${lines.join('\n')}\n`;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    process.exit(1);
  }
  if (options.help) {
    console.log(USAGE);
    return;
  }

  const now = options.now === null ? new Date() : new Date(options.now);
  if (Number.isNaN(now.getTime())) {
    console.error(`--now 要一个 ISO 时刻：${options.now}`);
    process.exit(1);
  }

  let since;
  try {
    since = parseSince(options.since, now);
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    process.exit(1);
  }

  const dir = options.dir === null ? fs.mkdtempSync(path.join(os.tmpdir(), 'odm-probe-')) : path.resolve(options.dir);
  fs.mkdirSync(path.join(dir, 'sources'), { recursive: true });

  try {
    const source =
      options.fixture === null
        ? createGithubSource({ token: tokenFrom(process.env), now: () => now.getTime() })
        : await (async () => {
            const fake = await loadFixtureFetch(options.fixture);
            // 夹具模式不需要真 token：auth() 要看的是「有没有」，不是「对不对」。
            return createGithubSource({ token: 'fixture-token', fetch: fake.fetch, now: () => now.getTime() });
          })();

    const payload = await probe({ source, dir, since, repos: options.repos, now });
    process.stdout.write(options.json ? `${JSON.stringify(payload, null, 2)}\n` : formatText(payload));
  } catch (error) {
    console.error(`探针失败：${error.message}`);
    process.exit(1);
  }
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('source-probe.mjs');
if (invokedDirectly) {
  main();
}
