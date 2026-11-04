// Regression: opening the Today chat sheet pushed the composer (＋ / mic / input) below the fold on ~1024px-wide,
// short windows, and the list didn't land on the newest message. The sticky dock can't rise above #cardList,
// so the sheet must be capped to the measured room left (--dock-fit) and only #todayChatMsgs scrolls.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
const html = fs.readFileSync(new URL('../src/client/index.html', import.meta.url), 'utf8')

test('open sheet is capped by the measured dock fit (desktop + phone)', () => {
  assert.match(html, /\.today-chat\.open:not\(\.in-zoom\) \.today-chat-sheet\{max-height:min\(720px,78vh,var\(--dock-fit,78vh\)\)\}/);
  assert.match(html, /\.today-chat\.open:not\(\.in-zoom\) \.today-chat-sheet\{max-height:min\(86vh,820px,var\(--dock-fit,86vh\)\)\}/);
});
test('message-list floors never exceed the fit (min-height can not push the composer out)', () => {
  assert.match(html, /\.today-chat\.open:not\(\.in-zoom\) \.today-chat-msgs\{min-height:min\(280px,calc\(var\(--dock-fit,100vh\) - 76px\)\)\}/);
  assert.match(html, /\.today-chat\.open:not\(\.in-zoom\) \.today-chat-msgs\{min-height:min\(52vh,calc\(var\(--dock-fit,100vh\) - 64px\)\)\}/);
  assert.match(html, /\.today-chat-sheet\{min-height:0\}/);
  assert.match(html, /\.today-chat-msgs\{flex:1 1 auto;overscroll-behavior:contain\}/);
});
test('the dock-fit block is the last word in the stylesheet', () => {
  const end = html.indexOf('</style>');
  const fit = html.lastIndexOf('var(--dock-fit,78vh)', end);
  assert.ok(fit > 0 && !/today-chat\.open \.today-chat-sheet\{max-height/.test(html.slice(fit, end)));
});
test('fitTodayChat measures room above the composer from the sticky container', () => {
  const fn = html.slice(html.indexOf('function fitTodayChat()'), html.indexOf('let dockFitRaf'));
  assert.match(fn, /in-zoom/);
  assert.match(fn, /display === 'contents'/);
  assert.match(fn, /--dock-fit/);
  assert.match(html, /window\.addEventListener\('resize', queueDockFit/);
  assert.match(html, /new ResizeObserver\(queueDockFit\)/);
});
test('open scrolls to the newest message; new messages follow only while pinned', () => {
  const open = html.slice(html.indexOf('function openTodayChat('), html.indexOf('function closeTodayChat('));
  assert.match(open, /stickTodayChat\(true\)/);
  assert.doesNotMatch(open, /setChatDockWanted\(true\)[\s\S]*if \(!chatDockWanted && !opts\.force\) return;[\s\S]*setChatDockWanted\(true\)/);
  const stick = html.slice(html.indexOf('function stickTodayChat('), html.indexOf('function fitTodayChat('));
  assert.match(stick, /if \(!force && !todayChatPinned\) return;/);
  assert.match(html, /todayChatPinned = todayChatNearBottom\(m\)/);
  assert.match(html, /const DOCK_STICK_PX = 80;/);
  assert.match(html, /new MutationObserver\(\(\) => stickTodayChat\(false\)\)/);
  // no stray forced scroll on the dock list that would yank a user reading history
  assert.doesNotMatch(html, /\$\('todayChatMsgs'\)\.scrollTop = \$\('todayChatMsgs'\)\.scrollHeight/);
});
test('composer keeps ＋ attach and the SVG mic', () => {
  assert.match(html, /id="todayAttachBtn"[^>]*><span class="ct-glyph" aria-hidden="true">＋<\/span>/);
  assert.match(html, /id="todayMicBtn" class="composer-mic"[^>]*><svg/);
});
