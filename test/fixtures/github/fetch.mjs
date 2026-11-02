// 假的 fetch：按路由表回放 GitHub 的只读响应，并记下每一次请求。
//
// 它不是测试文件（没有 .test.js），只给 test/source-github.test.js 用。
// 路由按顺序匹配：path + query 子集，或 match 正则；都没有就匹配任意 URL。
// 字符串里的 {base} 会换成 API 基址，这样 Link 头里可以写绝对 URL。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BASE = 'https://api.github.com';

function substitute(value, base) {
  if (typeof value === 'string') return value.split('{base}').join(base);
  if (Array.isArray(value)) return value.map((entry) => substitute(entry, base));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, substitute(entry, base)]),
    );
  }
  return value;
}

function matches(route, url) {
  if (route.url) return url.href === route.url;
  if (route.match) return new RegExp(route.match).test(`${url.pathname}${url.search}`);
  if (route.path && url.pathname !== route.path) return false;
  if (route.query) {
    for (const [key, expected] of Object.entries(route.query)) {
      if (url.searchParams.get(key) !== String(expected)) return false;
    }
  }
  return true;
}

export function createFakeFetch(routes, { base = DEFAULT_BASE } = {}) {
  const table = substitute(routes, base);
  const offline = table?.offline === true;
  const list = Array.isArray(table) ? table : (table?.routes ?? []);
  const calls = [];

  async function fetchImpl(input, init = {}) {
    const href = typeof input === 'string' ? input : input.url;
    const url = new URL(href, base);
    calls.push({
      url: url.href,
      method: init.method,
      headers: init.headers ?? {},
      pathname: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
    });

    if (offline) throw new TypeError('fetch failed');

    for (const route of list) {
      if (route.method && route.method !== (init.method ?? 'GET')) continue;
      if (!matches(route, url)) continue;
      const status = route.status ?? 200;
      const body = route.json === undefined ? '' : JSON.stringify(route.json);
      return new Response(body, { status, headers: route.headers ?? {} });
    }

    throw new Error(`unexpected request: ${(init.method ?? 'GET')} ${url.href}`);
  }

  return { fetch: fetchImpl, calls };
}

export function loadFixture(name, options = {}) {
  return JSON.parse(readFileSync(join(HERE, name, 'routes.json'), 'utf8'));
}
