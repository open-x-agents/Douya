import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BLOCK_MARKERS, blockedNote, classifyBlock } from '../src/sources/blocked.js';
import { SourceError, describeSourceGaps } from '../src/sources/contract.js';
import { fetchPrBrief } from '../src/web/card-brief.js';
import { createApiRouter } from '../src/web/api.js';
import { CARD_WORK_PROMPT } from '../src/web/dsbot-tools.js';

const CLOUDFLARE_PAGE = '<title>Attention Required! | Cloudflare</title>';

test('a Cloudflare intercept is one plain sentence', () => {
  const verdict = classifyBlock({
    status: 403,
    headers: { 'cf-mitigated': 'block' },
    body: CLOUDFLARE_PAGE,
  });

  assert.equal(verdict.blocked, true);
  assert.equal(verdict.reason, 'header');
  // fetch 的 Headers 也认，大小写不敏感。
  assert.equal(classifyBlock({ headers: new Headers({ 'CF-Mitigated': 'Challenge' }) }).blocked, true);
  assert.equal(classifyBlock({ headers: { 'Cf-Mitigated': ' managed ' } }).reason, 'header');
  // 只在状态码集合内、且正文命中特征时才算 body 命中。
  assert.deepEqual(classifyBlock({ status: 403, body: CLOUDFLARE_PAGE }), { blocked: true, reason: 'body' });
  assert.equal(classifyBlock({ status: 503, body: 'Just a moment...' }).blocked, true);
  assert.ok(BLOCK_MARKERS.length >= 7);
});

test('a bare 403 is not a site block', () => {
  assert.deepEqual(classifyBlock({ status: 403, body: '{"message":"Forbidden"}' }), { blocked: false, reason: null });

  // 只剩一句 message 的失败也判得出来，而且不需要状态码。
  const failure = 'Composio 403: Sorry, you have been blocked <title>Attention Required! | Cloudflare</title>';
  assert.deepEqual(classifyBlock({ error: failure }), { blocked: true, reason: 'message' });
  assert.deepEqual(classifyBlock({ error: new Error('Just a moment...') }), { blocked: true, reason: 'message' });
  // 没有 marker 的普通失败不算拦截。
  assert.deepEqual(classifyBlock({ error: new Error('Composio 500: upstream error') }), { blocked: false, reason: null });

  const error = new SourceError('http', 'GitHub 报错', { status: 403 });
  assert.equal(error.kind, 'http');
  assert.equal(describeSourceGaps([{ source: 'github', kind: error.kind, status: error.status }]), 'GitHub 报错（HTTP 403）');
});

test('a 200 page is not a block even when it mentions Cloudflare', () => {
  assert.deepEqual(classifyBlock({ status: 200, body: CLOUDFLARE_PAGE }), { blocked: false, reason: null });
  assert.deepEqual(classifyBlock({ status: 200, headers: { 'cf-mitigated': 'none' }, body: 'cf-error-details' }), {
    blocked: false,
    reason: null,
  });
});

test('the note is one sentence in both languages', () => {
  const zh = blockedNote('zh');
  const zhSite = blockedNote('zh', { site: 'GitHub' });
  const en = blockedNote('en');
  const enSite = blockedNote('en', { site: 'GitHub' });

  assert.equal(zh, '这个站点挡住了这次访问，我不会绕过它。');
  assert.equal(zhSite, 'GitHub 挡住了这次访问，我不会绕过它。');
  assert.equal(en, "This site blocked this request; I won't try to get around it.");
  assert.equal(enSite, "GitHub blocked this request; I won't try to get around it.");
  assert.equal(blockedNote('fr'), zh);

  for (const note of [zh, zhSite, en, enSite]) {
    assert.doesNotMatch(note, /[\r\n]/, note);
    assert.match(note, /[。.]$/, note);
    assert.doesNotMatch(note, /</, note);
  }
  assert.ok([...zh].length <= 40, `zh note is ${[...zh].length} chars`);
  assert.match(zh, /不会绕过/);
  // 只证明这一次请求被挡；站点政策不是我们能核实的事实。
  assert.doesNotMatch(zh + en, /个人助理|personal assistant/i);
});

test('a blocked source gap says the sentence', () => {
  assert.equal(
    describeSourceGaps([{ source: 'github', kind: 'blocked' }]),
    'GitHub 挡住了这次访问，我不会绕过它。',
  );
  assert.doesNotThrow(() => new SourceError('blocked', 'GitHub served a block page', { status: 403 }));
  // 别的来源没有专名时仍是一句完整的话。
  assert.equal(describeSourceGaps([{ source: 'blog', kind: 'blocked' }]), 'blog 挡住了这次访问，我不会绕过它。');
});

test('a blocked PR fetch becomes the one sentence', async () => {
  const target = { owner: 'open-x-agents', repo: 'openDigitalMate', number: 117 };
  const blockedClient = {
    executeAction: async () => {
      throw new Error(`Composio 403: Sorry, you have been blocked ${CLOUDFLARE_PAGE}`);
    },
  };

  // 卡片链路只剩一句 message：它也必须认出来，并换成那句导出的常量。
  const brief = await fetchPrBrief(blockedClient, target);
  assert.equal(brief.blocked, true);
  assert.equal(brief.error, blockedNote('zh', { site: 'GitHub' }));

  // 普通失败照旧，不冒充站点拦截。
  const plainClient = { executeAction: async () => { throw new Error('Composio 500: upstream error'); } };
  const plain = await fetchPrBrief(plainClient, target);
  assert.equal(plain.error, 'Composio 500: upstream error');
  assert.equal(plain.blocked, undefined);

  // 端点把 blocked 一起透传，UI 的 blocked 分支才看得到。
  const home = mkdtempSync(join(tmpdir(), 'odm-blocked-'));
  const card = {
    id: 'c1',
    source: 'github',
    blocks: [{ type: 'link-list', links: [{ url: 'https://github.com/open-x-agents/openDigitalMate/pull/117', type: 'pr' }] }],
  };
  const state = { cards: [card], itemStatus: {} };
  const router = createApiRouter({
    store: { get: () => state, save: async (s) => Object.assign(state, s) },
    config: { home, dataDir: home },
    configStore: { get: () => ({}), set() {} },
    composioClient: blockedClient,
  });
  const answer = await router.cardBrief({ cardId: card.id });
  assert.deepEqual(answer, { success: false, blocked: true, error: blockedNote('zh', { site: 'GitHub' }) });
});

test('the chat prompt carries the sentence and forbids getting around the block', () => {
  assert.ok(CARD_WORK_PROMPT.includes(blockedNote('zh')), 'the prompt does not carry the exported sentence');

  const start = CARD_WORK_PROMPT.indexOf('## 信源工具出错时');
  assert.ok(start >= 0, 'no source-error section');
  const section = CARD_WORK_PROMPT.slice(start, CARD_WORK_PROMPT.indexOf('## 规矩', start));
  assert.match(section, /第一行就写/, 'the blocked sentence is not the first line');
  assert.match(section, /不复述拦截页 HTML/);
  assert.match(section, /不猜正文/);
  for (const [label, pattern] of [
    ['a different domain', /不换域名/],
    ['a mirror', /不换镜像/],
    ['a different User-Agent', /不换 User-Agent/],
    ['a bash + curl retry', /bash \+ curl/],
  ]) {
    assert.match(section, pattern, `the prompt does not forbid ${label}`);
  }
  assert.match(section, /打开链接/, 'the prompt does not ask the user to open the link');

  // 那句话只定义一次：提示里插值导出的常量，不许手抄。
  const source = readFileSync(new URL('../src/web/dsbot-tools.js', import.meta.url), 'utf8');
  assert.match(source, /import \{ blockedNote \} from '\.\.\/sources\/blocked\.js'/);
  assert.doesNotMatch(source, /挡住了这次访问/, 'the sentence is hand-copied into the prompt');
});

test('the card face paints the blocked sentence before the empty-brief return', () => {
  const html = readFileSync(new URL('../packages/dsh-muse-ui/static/index.html', import.meta.url), 'utf8');
  const branch = html.match(/if \(m\.r && m\.r\.blocked\)[\s\S]{0,400}?return;/);
  assert.ok(branch, 'no blocked branch');
  assert.ok(branch[0].includes('brief-note'), 'the branch does not paint .brief-note');
  assert.ok(branch[0].includes('m.r.error'), 'the branch does not paint the server sentence');
  assert.ok(html.indexOf(branch[0]) < html.indexOf('if (!b ||'), 'the blocked branch sits after the empty-brief return, so it never runs');
  assert.ok(/\.brief-note\{/.test(html), 'no .brief-note style');
});
