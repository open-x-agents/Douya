// 这次抓取被站点（WAF）挡住时的识别与那一句人话。纯函数：不联网、不读环境变量、不写盘。
//
// 识别偏保守：`cf-mitigated` 只证明这一次请求被挡，拦不出站点有什么政策；所以宁可漏报，
// 也不把真的 403（权限 / 限流）说成站点拦截。

// 这些状态码才可能是拦截页；配合下面的正文特征一起判（见 classifyBlock 的 body 规则）。
export const BLOCK_STATUS = [402, 403, 429, 451, 503];

// Cloudflare / WAF 拦截页的固定字样，已小写；命中判定是 includes()，不用正则。
// 拦截页文案会变，集中在这一处，改一处即可。
export const BLOCK_MARKERS = [
  'sorry, you have been blocked', // Cloudflare 默认拦截页的正文
  'attention required! | cloudflare', // 同一页的 <title>
  'cf-error-details', // Cloudflare 错误页的容器 class
  'cloudflare ray id', // 同一页底部的 Ray ID 行
  'just a moment...', // 挑战页的 <title>
  'enable javascript and cookies to continue', // 挑战页正文
  'error code: 1020', // Cloudflare 1020：站点规则挡住了访问
];

const MITIGATED_VALUES = ['block', 'challenge', 'managed'];

function mitigatedHeader(headers) {
  if (!headers) return '';
  if (typeof headers.get === 'function') {
    const value = headers.get('cf-mitigated');
    return value == null ? '' : String(value);
  }
  if (typeof headers !== 'object') return '';
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'cf-mitigated') return value == null ? '' : String(value);
  }
  return '';
}

function hasMarker(text) {
  const value = String(text ?? '').toLowerCase();
  return BLOCK_MARKERS.some((marker) => value.includes(marker));
}

export function classifyBlock({ status, headers, body, error } = {}) {
  const mitigated = mitigatedHeader(headers).trim().toLowerCase();
  if (MITIGATED_VALUES.includes(mitigated)) return { blocked: true, reason: 'header' };

  if (BLOCK_STATUS.includes(Number(status)) && hasMarker(body)) return { blocked: true, reason: 'body' };

  // 抛出 error 说明这次请求已经失败，所以这里没有状态码门槛；调用方往往只剩一句 message。
  if (error != null && hasMarker(error?.message ?? error)) return { blocked: true, reason: 'message' };

  return { blocked: false, reason: null };
}

export function blockedNote(lang = 'zh', { site = '' } = {}) {
  const name = typeof site === 'string' ? site.trim() : '';
  if (lang === 'en') {
    return name
      ? `${name} blocked this request; I won't try to get around it.`
      : `This site blocked this request; I won't try to get around it.`;
  }
  return name
    ? `${name} 挡住了这次访问，我不会绕过它。`
    : '这个站点挡住了这次访问，我不会绕过它。';
}
