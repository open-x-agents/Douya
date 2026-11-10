// Open Today chat is a full-viewport panel; only #todayChatMsgs scrolls (extends the #185 scrollport fix).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
const html = fs.readFileSync(new URL('../packages/dsh-muse-ui/static/index.html', import.meta.url), 'utf8')

test('open Today chat (not in-zoom) is a fixed full-viewport warm-glass panel', () => {
  const block = html.slice(html.lastIndexOf('full-viewport warm-glass'), html.indexOf('</style>'));
  assert.match(block, /\.today-chat\.open:not\(\.in-zoom\)\{[^}]*position:fixed/);
  assert.match(block, /\.today-chat\.open:not\(\.in-zoom\)\{[^}]*inset:0/);
  assert.match(block, /background:rgba\(248,247,244,\.86\);backdrop-filter:blur\(22px\)/);
  assert.match(block, /html\.chat-full,html\.chat-full body,html\.chat-full \.views,html\.chat-full #v-today\{overflow:hidden\}/);
});
test('sheet fills the panel; message list is the only scrollport', () => {
  const block = html.slice(html.lastIndexOf('full-viewport warm-glass'), html.indexOf('</style>'));
  assert.match(block, /\.today-chat\.open:not\(\.in-zoom\) \.today-chat-sheet\{[^}]*flex:1 1 auto;min-height:0;max-height:none/);
  assert.match(block, /\.today-chat\.open:not\(\.in-zoom\) \.today-chat-msgs\{[^}]*flex:1 1 auto;min-height:0;max-height:none;overflow-y:auto;overscroll-behavior:contain/);
  assert.match(block, /\.today-chat-sheet\{min-height:0\}/);
  assert.match(block, /\.today-chat-msgs\{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain\}/);
  assert.match(block, /\.today-chat\.in-zoom \.today-chat-msgs\{min-height:0;overflow-y:auto;overscroll-behavior:contain\}/);
  assert.match(html, /id="todayChatMsgs" tabindex="0"/);
  assert.doesNotMatch(block, /var\(--dock-fit/);
});
test('desktop content is a centered readable column; chips and composer stay in the panel', () => {
  const block = html.slice(html.lastIndexOf('full-viewport warm-glass'), html.indexOf('</style>'));
  assert.match(block, /max-width:820px;width:100%;margin-left:auto;margin-right:auto/);
  assert.match(block, /\.today-chat\.open:not\(\.in-zoom\) \.chat-chips,/);
  assert.match(block, /\.today-chat\.open:not\(\.in-zoom\) \.chat-ctx,/);
  assert.match(block, /\.today-chat\.open:not\(\.in-zoom\) \.today-chat-input \.input-wrap\{/);
  assert.match(html, /id="todayAttachBtn"[^>]*><span class="ct-glyph" aria-hidden="true">＋<\/span>/);
  assert.match(html, /id="todayMicBtn" class="composer-mic"[^>]*><svg/);
  assert.match(html, /id="chatCtx"[^>]*><span data-i18n="chat.ctx_label">Talking about<\/span>/);
});
test('the fullscreen block is the last word in the stylesheet', () => {
  const end = html.indexOf('</style>');
  const fit = html.lastIndexOf('full-viewport warm-glass', end);
  assert.ok(fit > 0);
  const rest = html.slice(fit, end);
  assert.doesNotMatch(rest, /today-chat\.open:not\(\.in-zoom\) \.today-chat-sheet\{max-height:min/);
  assert.match(rest, /max-height:none/);
});
test('open and close toggle html.chat-full; fitTodayChat does not cap the fullscreen list', () => {
  assert.match(html, /function syncChatFullClass\(\)/);
  assert.match(html, /document\.documentElement\.classList\.toggle\('chat-full', full\)/);
  const fn = html.slice(html.indexOf('function fitTodayChat()'), html.indexOf('function syncChatFullClass()'));
  assert.match(fn, /removeProperty\('--dock-fit'\)/);
  assert.doesNotMatch(fn, /setProperty\('--dock-fit'/);
  assert.match(html, /window\.addEventListener\('resize', queueDockFit/);
  assert.match(html, /new ResizeObserver\(queueDockFit\)/);
});
test('open scrolls to the newest message; new messages follow only while pinned', () => {
  const open = html.slice(html.indexOf('function openTodayChat('), html.indexOf('function closeTodayChat('));
  assert.match(open, /stickTodayChat\(true\)/);
  assert.match(open, /syncChatFullClass\(\)/);
  assert.doesNotMatch(open, /setChatDockWanted\(true\)[\s\S]*if \(!chatDockWanted && !opts\.force\) return;[\s\S]*setChatDockWanted\(true\)/);
  const stick = html.slice(html.indexOf('function stickTodayChat('), html.indexOf('function fitTodayChat('));
  assert.match(stick, /if \(!force && !todayChatPinned\) return;/);
  assert.match(html, /todayChatPinned = todayChatNearBottom\(m\)/);
  assert.match(html, /const DOCK_STICK_PX = 80;/);
  assert.match(html, /new MutationObserver\(\(\) => stickTodayChat\(false\)\)/);
  assert.doesNotMatch(html, /\$\('todayChatMsgs'\)\.scrollTop = \$\('todayChatMsgs'\)\.scrollHeight/);
});
test('Escape closes the full-viewport Today chat', () => {
  assert.match(html, /if \(chat && chat\.classList\.contains\('open'\) && !chatInZoom\(\)\) \{ closeTodayChat\(\); return; \}/);
  assert.match(html, /id="todayChatClose"/);
});
test('composer keeps ＋ attach and the SVG mic', () => {
  assert.match(html, /id="todayAttachBtn"[^>]*><span class="ct-glyph" aria-hidden="true">＋<\/span>/);
  assert.match(html, /id="todayMicBtn" class="composer-mic"[^>]*><svg/);
});
test('draft To label follows the pending action target when they disagree', () => {
  assert.match(html, /function actionToLabel\(a\)/);
  assert.match(html, /function syncDraftTargetFromAction\(container, action\)/);
  assert.match(html, /a\.preview\.to/);
  assert.match(html, /syncDraftTargetFromAction\(container, a\)/);
  const tgt = html.slice(html.indexOf('function mdDraftTarget('), html.indexOf('function renderMdBlocks('));
  assert.ok(tgt.includes('issues|pull'));
  assert.ok(tgt.includes('[\\w.-]+\\/[\\w.-]+#\\d+'));
});
