import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BLOCK_MARKERS, blockedNote, classifyBlock } from '../src/sources/blocked.js';
import { SourceError, describeSourceGaps } from '../src/sources/contract.js';

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
