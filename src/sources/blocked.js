// 站点以「个人助理 / AI 访问」为由挡住我们时的识别与那句唯一的人话。
// 纯函数：不联网、不读环境变量、不写盘。识别偏保守——宁可漏报，不许把真 403
//（权限 / 限流）说成站点政策。

// 这些状态码才可能是拦截页；配合下面的正文特征一起判。
export const BLOCK_STATUS = [402, 403, 429, 451, 503];

// Cloudflare / WAF 拦截页的固定字样，不区分大小写。拦截页文案会变，集中在这一处。
export const BLOCK_MARKERS = [
  'sorry, you have been blocked',
  'attention required! | cloudflare',
  'cf-error-details',
  'cloudflare ray id',
  'just a moment...',
  'enable javascript and cookies to continue',
  'error code: 1020',
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

export function classifyBlock({ status, headers, body, error } = {}) {
  const mitigated = mitigatedHeader(headers).trim().toLowerCase();
  if (MITIGATED_VALUES.includes(mitigated)) return { blocked: true, reason: 'header' };

  if (BLOCK_STATUS.includes(Number(status))) {
    const text = String(body ?? error ?? '').toLowerCase();
    if (BLOCK_MARKERS.some((marker) => text.includes(marker))) return { blocked: true, reason: 'body' };
  }

  return { blocked: false, reason: null };
}

export function blockedNote(lang = 'zh', { site = '' } = {}) {
  const name = typeof site === 'string' ? site.trim() : '';
  if (lang === 'en') {
    return name
      ? `${name} blocks personal assistants; I won't try to get around it.`
      : `This site blocks personal assistants; I won't try to get around it.`;
  }
  return name
    ? `${name} 不允许个人助理访问，我不会绕过它。`
    : '这个站点不允许个人助理访问，我不会绕过它。';
}
