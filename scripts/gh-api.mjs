// 一个最小的 GitHub REST 客户端：只有 api.github.com 可用的机器上也能跑。
// 重试是常态而不是例外：这台机器连 api.github.com 会偶发 ECONNRESET。

export const REPO = process.env.GITHUB_REPOSITORY || 'open-x-agents/openDigitalMate';

function token() {
  const value = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.DSH_SECRET_GITHUB_TOKEN;
  if (!value) throw new Error('没有 GitHub token：需要 GITHUB_TOKEN / GH_TOKEN / DSH_SECRET_GITHUB_TOKEN');
  return value;
}

export async function api(method, path, body, { tries = 5, repo = REPO } = {}) {
  const url = path.startsWith('http') ? path : `https://api.github.com/repos/${repo}${path}`;
  let lastError;
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      const response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token()}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'opendigitalmate',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await response.text();
      const json = text ? JSON.parse(text) : null;
      if (!response.ok) {
        const error = new Error(`${method} ${path} → ${response.status} ${json?.message || text.slice(0, 200)}`);
        error.status = response.status;
        if (response.status >= 500 || response.status === 403) {
          lastError = error;
          continue;
        }
        throw error;
      }
      return json;
    } catch (error) {
      if (error.status && error.status < 500 && error.status !== 403) throw error;
      lastError = error;
      if (attempt === tries) break;
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
  throw lastError;
}
