import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('../src/client/index.html', import.meta.url), 'utf8')
const from = html.indexOf('  const escMd = ')
const to = html.indexOf('  // ---- 豆芽 mark')
assert.ok(from > 0 && to > from, 'renderMd block found')
const renderMd = new Function(`${html.slice(from, to)}; return renderMd`)()

const DRAFT = `这张卡上有 3 个待审的 PR，我先按最新开的 #2353 起草评论。

发到 [PR #2353](https://github.com/o/r/pull/2353) 的评论如下：

> 这个改动我记一下待审，先问两件想确保没遗漏的：
>
> 1. 字符边界切分这块，是按 UTF-8 code point 切吗？
> 2. 边界落在 code fence 里，下游怎么处理？
>
> 另外，#2352 和这个改动不冲突吧？`

test('blockquote lines render as one quote: no literal ">" and the list inside stays a list', () => {
  const out = renderMd('先看这段：\n\n> 第一行\n>\n> - 甲\n> - 乙\n\n后面')
  assert.match(out, /<blockquote class="md-quote">/)
  assert.doesNotMatch(out.replace(/<[^>]+>/g, ''), /&gt;|>|＞/)
  assert.match(out, /<blockquote class="md-quote"><p>第一行<\/p><ul class="md-list"><li>甲<\/li><li>乙<\/li><\/ul><\/blockquote>/)
  assert.match(out, /<p>后面<\/p>/)
})

test('escaped "&gt;" and full-width "＞" quote markers are quotes too; nested quotes nest', () => {
  assert.match(renderMd('&gt; 引用一句'), /<blockquote class="md-quote"><p>引用一句<\/p><\/blockquote>/)
  assert.match(renderMd('＞ 引用一句'), /<blockquote class="md-quote"><p>引用一句<\/p><\/blockquote>/)
  assert.match(renderMd('> 外层\n> > 里层'), /<blockquote class="md-quote"><p>外层<\/p><blockquote class="md-quote"><p>里层<\/p><\/blockquote><\/blockquote>/)
})

test('an outgoing draft (…评论如下：) becomes a draft block with its target and confirm/edit actions', () => {
  const out = renderMd(DRAFT)
  assert.match(out, /<div class="md-draft" data-kind="github" data-target="PR #2353">/)
  assert.match(out, /确认发送/)
  assert.match(out, /修改/)
  assert.match(out, /确认后才会发送/)
  assert.match(out, /<ol class="md-list"><li>字符边界切分/)
  assert.doesNotMatch(out.replace(/<[^>]+>/g, ''), /&gt;|>/)
  assert.doesNotMatch(out, /md-quote/, 'the draft is not also rendered as a plain quote')
})

test('a quote without a draft intro stays a plain quote; html in quotes is escaped', () => {
  const out = renderMd('他原话是：\n> <b>别急</b>')
  assert.match(out, /md-quote/)
  assert.doesNotMatch(out, /md-draft/)
  assert.match(out, /&lt;b&gt;别急/)
})

test('a quote followed by 「草稿在上面，还没发…确认执行」 is a draft too, target from the outro', () => {
  const out = renderMd('> 这条我记着待审。想确认切分按 UTF-8 还是 UTF-16。\n>\n> 另外边界落在标签中间时怎么处理？\n\n草稿在上面，还没发。你说发，我就生成待确认卡片，你在豆芽点「确认执行」后才会提交到 [PR #2353](https://github.com/ThinkFlowLab/FlyBot/pull/2353)。')
  assert.match(out, /<div class="md-draft" data-kind="github" data-target="PR #2353">/)
  assert.doesNotMatch(out, /md-quote/)
  assert.match(out, /草稿在上面/) // the explanation stays visible under the card
})

test('a reminder quote with no draft wording stays a plain quote', () => {
  const out = renderMd('今天先回 Fledge。\n\n> 先把卡在你这儿的那件事推完。')
  assert.match(out, /md-quote/)
  assert.doesNotMatch(out, /md-draft/)
})
